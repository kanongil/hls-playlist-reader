/// <reference lib="dom" />

import { AbortablePromise, AbortError, assert, FetchOptions, FetchResult, TimeoutError } from './helpers.js';

export * from './helpers.js';


export const webProtocols = new Set(['http:', 'https:', 'data:']);
export const httpHardFail = new Set([301, 400, 401, 410, 501]);

export const performFetch = function (uri: URL, options: FetchOptions = {}): AbortablePromise<FetchResult<ReadableStream<Uint8Array>>> {

    const { signal, timeout } = options;

    // FIXME: The retries option does not work once the response has been received, since the raw body stream is returned

    signal?.throwIfAborted();

    if (!webProtocols.has(uri.protocol)) {
        throw TypeError(`Unsuported protocol: ${uri.protocol}`);
    }

    const ac = new AbortController();       // Don't use ponyfill, since it is passed to native fetch()

    const promise = Object.assign(
        _performFetch(uri, { ...options, signal: ac.signal }), {
            abort: (reason?: Error) => ac.abort(reason ?? new AbortError('Fetch was aborted'))
        }
    );

    if (signal) {
        const onSignalAbort = () => promise.abort(signal!.reason);
        signal.addEventListener('abort', onSignalAbort);
        promise
            .then((res) => res.completed)
            .catch(() => undefined).then(() => signal.removeEventListener('abort', onSignalAbort));
    }

    if (typeof timeout === 'number') {
        const timer = setTimeout(() => ac.abort(new TimeoutError('Fetch timed out')), timeout);
        promise.catch(() => undefined).then(() => clearTimeout(timer));
    }

    return promise;
};

const _performFetch = async function (uri: URL, options: Omit<FetchOptions, 'timeout'> & { signal: AbortSignal }): Promise<FetchResult<ReadableStream<Uint8Array>>> {

    const { byterange, probe = false, retries = 1, blocking, signal } = options;
    let { tracker } = options;

    const headers: { [key: string]: string } = {};

    if (byterange) {
        const start = byterange.offset;
        const end = byterange.length !== undefined ? byterange.offset + byterange.length - 1 : undefined;
        headers.range = 'bytes=' + start + '-' + (end! >= 0 ? end : '');
    }

    let completed: Promise<void> | undefined;

    const _token = tracker?.start(uri, { byterange, blocking: !!blocking });
    const trackerMethod = function (method: 'advance' | 'finish') {

        return tracker?.[method] ? (arg?: any) => {

            try {
                tracker?.[method]!(_token, arg);
            }
            catch (err) {
                // Ignore this error and cancel tracking
                tracker = undefined;
            }
        } : undefined;
    };

    const advance = trackerMethod('advance');
    const finish = trackerMethod('finish');
    try {
        let res;
        try {
            res = await fetch(uri, {
                cache: options.fresh ? 'no-store' : 'default',
                method: probe ? 'HEAD' : 'GET',
                headers,
                redirect: 'follow',                // TODO: use manual mode?!?!
                credentials: 'omit',
                mode: 'cors',
                signal
            });
        }
        catch (err) {
            assert(err instanceof Error);
            finish?.(err);
            throw err;
        }
        finally {
            signal.throwIfAborted();
        }

        if (res.status >= 300) {
            finish?.();

            if (retries && !httpHardFail.has(res.status)) {
                try {
                    await res.arrayBuffer();    // Empty buffer to allow res to be deallocated
                }
                finally {
                    signal.throwIfAborted();
                }

                return _performFetch(uri, { ...options, tracker, retries: retries - 1 });
            }

            throw Object.assign(
                new Error('Fetch failed', { cause: res.statusText }), {
                    httpStatus: res.status
                }
            );
        }

        if (!probe) {
            advance?.(0);
        }

        let contentLength = -1;
        if (res.headers.has('content-length')) {
            const contentEncoding = res.headers.get('content-encoding');
            if (contentEncoding === 'identity' || !contentEncoding) {
                contentLength = parseInt(res.headers.get('content-length')!, 10);
            }
        }

        const typeparts = /^(.+?\/.+?)(?:;\w*.*)?$/.exec(res.headers.get('content-type')!) || [null, 'application/octet-stream'];

        let stream = !probe ? res.body ?? undefined : undefined;
        if (stream) {
            const [orig, monitor] = stream.tee();

            // This has the side-effect of loading all data into the stream without considering pressure
            // This is a desirable feature for our use-cases

            // TODO: add a bytelimit?

            completed = new Promise<void>((resolve, reject) => {

                // Hook a specific signal that is always aborted, to workaround Safari memory leak

                const ac = new AbortController();
                const onSignalAbort = () => ac.abort(signal!.reason);
                signal.addEventListener('abort', onSignalAbort);

                monitor.pipeTo(new WritableStream({
                    write: advance ? (chunk) => advance(chunk.byteLength) : () => undefined,
                    abort: (reason) => reject(reason || new AbortError('Fetch aborted during stream download')),    // TODO: test!!
                    close: () => resolve()
                }), { signal: ac.signal }).catch(() => undefined).then(() => {

                    signal.removeEventListener('abort', onSignalAbort);
                    ac.abort();    // Late abort that ensures signal abort handler is triggered in order to free its scope
                });

                stream = orig;
            });
        }
        else {
            completed = Promise.resolve();
        }

        return {
            meta: {
                url: res.url,
                mime: typeparts[1]!.toLowerCase(),
                size: contentLength,
                modified: res.headers.has('last-modified') ? new Date(res.headers.get('last-modified')!) : null,
                etag: res.headers.get('etag') ?? undefined
            },
            stream,
            completed
        };
    }
    finally {
        if (completed) {
            finish ? completed.then(finish, finish) : completed.catch(() => undefined);
        }
    }
};


/**
 * Read stream content from FetchResult as an UTF-8 string.
 */
export const readFetchUtf8 = async function ({ stream }: FetchResult<ReadableStream<Uint8Array>>): Promise<string> {

    if (!stream) {
        return '';       // No streams means content-length: 0
    }

    const chunks = [];

    const reader = stream.getReader();
    for (;;) {
        const { value, done } = await reader.read();
        if (done) {
            break;
        }

        chunks.push(value);
    }

    const merged = new Uint8Array(chunks.reduce((v, e) => v + e.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
    }

    return new TextDecoder('utf-8').decode(merged);
};


/**
 * Cancel delivery of stream from FetchResult.
 *
 * Must be called when not otherwise consumed.
 */
export const cancelFetch = function (fetch: FetchResult<ReadableStream<Uint8Array>> | undefined, reason?: Error): void {

    if (fetch?.stream) {
        fetch.stream.cancel(reason).catch(() => undefined);
        fetch.stream = undefined;
    }
};
