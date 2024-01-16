/// <reference lib="dom" />

import { AbortablePromise, AbortError, assert, FetchOptions, IFetchResult, IContentFetcher, TimeoutError, IURL, Deferred } from './helpers.js';

export * from './helpers.js';

export type TFetcherStream = ReadableStream<Uint8Array>;

class WebFetchResult implements IFetchResult<TFetcherStream> {

    readonly meta: IFetchResult['meta'];
    readonly completed: IFetchResult['completed'];
    stream?: TFetcherStream;

    constructor(meta: IFetchResult['meta'], stream: TFetcherStream | undefined, completed: IFetchResult['completed']) {

        this.meta = meta;
        this.stream = stream;
        this.completed = completed;
    }

    cancel(reason?: Error): void {

        this.stream?.cancel(reason).catch(() => undefined);
        this.stream = undefined;
    }

    async consumeUtf8(): Promise<string> {

        if (!this.stream) {
            return '';       // No streams means content-length: 0
        }

        const chunks = [];

        const reader = this.stream.getReader();
        this.stream = undefined;

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
    }
}

class WebFetcher implements IContentFetcher<TFetcherStream> {

    static StreamProto: TFetcherStream = ReadableStream.prototype;

    readonly type = 'web';

    protocols = new Set(['http:', 'https:', 'data:']);
    httpHardFail = new Set([301, 400, 401, 410, 501]);

    perform(uri: IURL, options: FetchOptions = {}): AbortablePromise<IFetchResult<TFetcherStream>> {

        const { signal, timeout } = options;

        // FIXME: The retries option does not work once the response has been received, since the raw body stream is returned

        signal?.throwIfAborted();

        if (!this.protocols.has(uri.protocol)) {
            throw TypeError(`Unsuported protocol: ${uri.protocol}`);
        }

        const ac = new AbortController();

        const promise = Object.assign(this.#performFetch(uri, { ...options, signal: ac.signal }), {
            abort: (reason?: Error) => ac.abort(reason ?? new AbortError('Fetch was aborted'))
        });

        if (signal) {
            const onSignalAbort = () => promise.abort(signal!.reason);
            signal.addEventListener('abort', onSignalAbort);
            promise
                .then((res) => res.completed)
                .catch(() => undefined).then(() => signal.removeEventListener('abort', onSignalAbort), () => undefined);
        }

        if (typeof timeout === 'number') {
            const timer = setTimeout(() => ac.abort(new TimeoutError('Fetch timed out')), timeout);
            promise.catch(() => undefined).then(() => clearTimeout(timer), () => undefined);
        }

        return promise;
    }

    async #performFetch(uri: URL, options: Omit<FetchOptions, 'timeout'> & { signal: AbortSignal }): Promise<IFetchResult<TFetcherStream>> {

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

            if (retries && !this.httpHardFail.has(res.status)) {
                try {
                    await res.arrayBuffer();    // Empty buffer to allow res to be deallocated
                }
                finally {
                    signal.throwIfAborted();
                }

                return this.#performFetch(uri, { ...options, tracker, retries: retries - 1 });
            }

            throw Object.assign(new Error('Fetch failed', { cause: res.statusText }), {
                httpStatus: res.status
            });
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
            const source = new InternalBufferSource(stream, { advance, finish }, { signal });
            stream = new ReadableStream(source, { highWaterMark: 0 });

            completed = source.completed;
        }
        else {
            completed = Promise.resolve();
            finish?.();
        }

        return new WebFetchResult(
            {
                url: res.url,
                mime: typeparts[1]!.toLowerCase(),
                size: contentLength,
                modified: res.headers.has('last-modified') ? new Date(res.headers.get('last-modified')!) : null,
                etag: res.headers.get('etag') ?? undefined
            },
            stream,
            completed);
    }
}

interface StreamTracker {
    advance?: (bytes: number) => void;
    finish?: (err?: Error) => void;
}

class InternalBufferSource implements UnderlyingByteSource {

    readonly type = 'bytes';

    readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
    readonly #tracker: StreamTracker;
    readonly #signal: AbortSignal;

    // State

    readonly #chunks: Uint8Array[] = [];
    #waiting?: Deferred<void>;
    #completed = false;

    /**
     * Buffers all incoming chunks of the source, reporting them to tracker.
     *
     * Source errors are immediately reported through `completed` but not through the
     * controller until all the buffered data has been consumed.
     *
     * @param source Source stream to consume from.
     * @param tracker Tracker that is notified of state of source stream.
     */
    constructor(source: ReadableStream<Uint8Array>, tracker: StreamTracker, { signal }: { signal: AbortSignal }) {

        this.#reader = source.getReader(/*{ mode: 'byob' }*/);    // TODO: use BYOB
        this.#tracker = tracker;
        this.#signal = signal;
    }

    /**
     * Feeds chunks from source reader into internal buffer until the reader closes or errors.
     *
     * Also updates internal state and notifies listeners after each chunk is received.
     */
    async #feeder(controller: ReadableByteStreamController) {

        try {
            const reader = this.#reader;
            const { advance, finish } = this.#tracker;
            const chunks = this.#chunks;

            for (;;) {
                try {
                    // TODO: limit internal buffer size

                    let result: Awaited<ReturnType<typeof reader.read>> | undefined;
                    try {
                        result = await reader.read();
                        this.#signal.throwIfAborted();      // Even though reader aborts on signal, it might return some buffers before erroring
                    }
                    catch (err) {
                        assert(err instanceof Error);
                        finish?.(err);
                        break;     // completed (with error)
                    }

                    const { done, value } = result!;
                    if (done) {
                        finish?.();
                        break;     // completed
                    }

                    chunks.push(value);
                    advance?.(value.byteLength);
                }
                finally {
                    if (this.#waiting) {
                        this.#waiting.resolve();
                        this.#waiting = undefined;
                    }
                }
            }

            this.#completed = true;
        }
        catch (err) {
            controller.error(new Error('Internal buffer processing error', { cause: err }));
        }
    }

    start(controller: ReadableByteStreamController): void {

        void this.#feeder(controller);      // Start async feeder from reader
    }

    pull(controller: ReadableByteStreamController): Promise<void> | void {

        // Consumer needs a chunk

        if (this.#signal.aborted) {
            this.#chunks.splice(0, this.#chunks.length);
            return controller.error(this.#signal.reason);
        }

        const chunk = this.#chunks.shift();
        if (!chunk) {
            if (this.#completed) {
                return this.#reader.closed.then(() => controller.close(), (err) => controller.error(err));
            }

            this.#waiting = new Deferred(false);
            return this.#waiting.promise.then(() => this.pull(controller));
        }

        return controller.enqueue(chunk);
    }

    cancel(reason: unknown): Promise<void> | void {

        // Consumer dropped the stream

        this.#chunks.splice(0, this.#chunks.length);

        if (!this.#completed) {
            return this.#reader.cancel(reason);
        }
    }

    get completed() {

        return this.#reader.closed;
    }
}

export const ContentFetcher = WebFetcher;
