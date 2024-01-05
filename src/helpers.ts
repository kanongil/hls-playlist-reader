/// <reference lib="dom" />

// Ponyfill Array.at() (ES2022 feature, required for Safari < 15.4)

/* $lab:coverage:off$ */ /* c8 ignore start */
export const arrayAt = (<any> Array.prototype).at ? function <T = unknown>(array: readonly T[], n: number): T | undefined {

    return (<any> Array.prototype).at.call(array, n);
} : function <T = unknown>(array: readonly T[], n: number): T | undefined {

    n = Math.trunc(n) || 0;

    if (n < 0) {
        n += array.length;
    }

    if (n < 0 || n >= array.length) {
        return undefined;
    }

    return array[n];
};
/* $lab:coverage:on$ */ /* c8 ignore stop */


// Create URL interface to support both node URL and DOM URL objects

export type IURL = Omit<URL, 'searchParams'> & { searchParams: any };


export class AbortError extends DOMException {
    constructor(message: string, options?: { cause: unknown }) {

        super(message, 'AbortError');
        this.cause = options?.cause;
    }
}

export class TimeoutError extends DOMException {
    constructor(message: string, options?: { cause: unknown }) {

        super(message, 'TimeoutError');
        this.cause = options?.cause;
    }
}


export type AbortablePromise<T> = Promise<T> & { abort: (reason?: Error) => void };

export type Byterange = {
    offset: number;
    length?: number;
};

/**
 * Interface that can be implemented to track a fetch.
 */
export interface IDownloadTracker<Token = unknown> {

    /**
     * Called right as the download is being requested.
     *
     * @param url - The requested uri.
     * @param blocking - Whether this is a blocking request, where the server can defer the response.
     *
     * @return An unique opaque Token that is passed to the advance() and finish() callbacks.
     */
    start(url: IURL, config: { byterange?: Byterange; blocking?: boolean }): Token;

    /**
     * Called whenever a chunk of payload data has been received.
     *
     * The first call to this can have a `0` bytes value, to signal that a response has been received.
     * This is not called, if the response has a >= 300 status code.
     *
     * Note: If an Error is thrown, it will be ignored, and no further callbacks will be triggered.
     *
     * @param token - The Token returned from start().
     * @param bytes - The byte size of the data chunk.
     */
    advance?(token: Token, bytes: number): void;

    /**
     * Called when no more chunks will be received for the Token.
     *
     * Note: If an Error is thrown, it will be ignored.
     *
     * @param token - The Token returned from start().
     * @param err - Set with Error on connection issue or abort.
     */
    finish?(token: Token, err?: Error | null | void): void;
}

export type FetchOptions = {
    byterange?: Byterange;
    probe?: boolean;
    timeout?: number;
    retries?: number;
    blocking?: string | symbol;
    fresh?: boolean;
    signal?: AbortSignal;
    tracker?: IDownloadTracker;
};

export type FetchMeta = {
    url: string;
    mime: string;
    size: number;
    modified: Date | null;
    etag?: string;
};

export interface IFetchResult<T extends object | unknown = unknown> {
    readonly meta: FetchMeta;

    /**
     * Resolved once the stream data has been fetched, or rejects with any transfer errors.
     */
    readonly completed: Promise<void>;

    /**
     * Content stream of type T. Must be fully consumed or cancelled / aborted.
     */
    readonly stream?: T;    // ReadableStream<Uint8Array> | Readable;

    /**
     * Cancel delivery of stream from FetchResult.
     *
     * Must be called when stream is not otherwise consumed.
     */
    cancel(reason?: Error): void;

    /**
     * Fully consume content stream from FetchResult as an UTF-8 string.
     */
    consumeUtf8(): Promise<string>;
}

export type TFetcherStream = unknown;

export interface IContentFetcher<TContentStream extends object> {

    readonly type: 'node' | 'web';

    /**
     * Fetch metadata for uri and prepare a content stream for reading.
     */
    perform(uri: IURL, options: FetchOptions): AbortablePromise<IFetchResult<TContentStream>>;
}


// eslint-disable-next-line func-style
export function assert(condition: unknown, ...args: any[]): asserts condition {

    if (!condition) {
        const err = new Error(args.join());
        err.name = 'AssertError';
        throw err;
    }
}


const NOOP = () => undefined;

export class Deferred<T> {

    promise: Promise<T>;
    resolve: (arg?: T | PromiseLike<T>) => void = undefined as any;
    reject: (err: Error) => void = undefined as any;

    /**
     * Create a deferred Promise that can be resolved externally.
     *
     * @param independent Set to implicitly catch errors (ie. no unresolved promise warnings if no one listens).
     */
    constructor(independent = false) {

        this.promise = new Promise<T>((resolve, reject) => {

            this.resolve = resolve as any;

            if (independent) {
                this.reject = function (err) {

                    this.promise.catch(NOOP);
                    return reject(err);
                };
            }
            else {
                this.reject = reject;
            }
        });
    }
}

export const wait = function (timeout: number, { signal }: { signal?: AbortSignal } = {}): Promise<void> {

    let timer: any;
    let reportError: (err: Error) => any;
    const onSignalAbort = () => {

        clearTimeout(timer);
        const reason = signal!.reason ?? new AbortError('Wait was aborted');
        return reportError ? reportError(reason) : Promise.reject(reason);
    };

    if (signal?.aborted) {
        return onSignalAbort();
    }

    return new Promise<void>((resolve, reject) => {

        reportError = reject as any;
        timer = setTimeout(resolve, timeout);
        signal?.addEventListener('abort', onSignalAbort);
    }).finally(() => {

        signal?.removeEventListener('abort', onSignalAbort);
    });
};


export interface IChangeWatcher {
    next(timeoutMs?: number): PromiseLike<string> | string;
    close(): void;
}

export class ChangeWatcher {
    static #registry = new Map<string,(uri: IURL) => IChangeWatcher | undefined>();

    static create(uri: IURL): IChangeWatcher | undefined {

        const factory = this.#registry.get(uri.protocol);
        return factory ? factory(uri) : undefined;
    }

    static register(proto: string, factory: (uri: IURL) => IChangeWatcher | undefined) {

        this.#registry.set(proto, factory);
    }
}
