/// <reference lib="dom" />

import { AbortablePromise, AbortError, FetchOptions, FetchResult, TimeoutError } from './helpers.js';

export * from './helpers.js';


export const webProtocols = new Set(['http:', 'https:', 'data:']);
export const httpHardFail = new Set([301, 400, 401, 410, 501]);

export const performFetch = function (uri: URL, options: FetchOptions = {}): AbortablePromise<FetchResult<ReadableStream<Uint8Array>>> {

    const { signal, timeout } = options;

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
        promise.finally(() => signal.removeEventListener('abort', onSignalAbort));
    }

    if (typeof timeout === 'number') {
        const timer = setTimeout(() => {

            const err = new TimeoutError('Fetch timed out');

            // Manually try to assign a reason, for support on AbortControllers that don't support reason

            try {
                (ac.signal as any).reason = err;
            }
            catch {}

            ac.abort(err);
        }, timeout);
        promise.finally(() => clearTimeout(timer));
    }

    return promise;
};

const _performFetch = async function (uri: URL, options: Omit<FetchOptions, 'timeout'> & { signal: AbortSignal }): Promise<FetchResult<ReadableStream<Uint8Array>>> {

    const { byterange, probe = false, retries = 1, /*blocking,*/ signal } = options;

    const headers: { [key: string]: string } = {};

    if (byterange) {
        const start = byterange.offset;
        const end = byterange.length !== undefined ? byterange.offset + byterange.length - 1 : undefined;
        headers.range = 'bytes=' + start + '-' + (end! >= 0 ? end : '');
    }

    let res;
    try {
        res = await fetch(uri, {
            cache: 'no-store',
            method: probe ? 'HEAD' : 'GET',
            headers,
            redirect: 'follow',                // TODO: use manual mode?!?!
            credentials: 'omit',
            mode: 'cors',
            signal
        });
    }
    catch (err) {
        throw signal.reason ?? err;
    }

    if (res.status >= 300) {
        if (retries && !httpHardFail.has(res.status)) {
            await res.arrayBuffer();    // Empty buffer to allow res to be deallocated
            return _performFetch(uri, { ...options, retries: retries - 1 });
        }

        if (res.status >= 400) {
            throw Object.assign(
                new Error('Fetch failed'), {
                    httpStatus: res.status,
                    cause: res.statusText
                }
            );
        }
    }

    let contentLength = -1;
    if (res.headers.has('content-length')) {
        const contentEncoding = res.headers.get('content-encoding');
        if (contentEncoding === 'identity' || !contentEncoding) {
            contentLength = parseInt(res.headers.get('content-length')!, 10);
        }
    }

    const typeparts = /^(.+?\/.+?)(?:;\w*.*)?$/.exec(res.headers.get('content-type')!) || [null, 'application/octet-stream'];

    return {
        meta: {
            url: res.url,
            mime: typeparts[1]!.toLowerCase(),
            size: contentLength,
            modified: res.headers.has('last-modified') ? new Date(res.headers.get('last-modified')!) : null,
            etag: res.headers.get('etag') ?? undefined
        },
        stream: !probe ? res.body ?? undefined : undefined
    };
};

// TODO: rename to readFetchText??
export const readFetchData = async function ({ stream }: FetchResult<ReadableStream<Uint8Array>>): Promise<string> {

    if (!stream) {
        return '';       // No streams means content-length: 0
    }

    const chunks = [];

    const reader = stream.getReader();
    for (; ;) {
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
