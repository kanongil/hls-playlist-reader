import type { Meta } from 'uristream/lib/uri-reader.js';

// Ponyfill Array.at() (ES2022 feature)

/* $lab:coverage:off$ */ /* c8 ignore start */
export const arrayAt = Array.prototype.at ? function <T = unknown>(array: readonly T[], n: number): T | undefined {

    return Array.prototype.at.call(array, n);
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


// Enable DOMException on old node.js

/* $lab:coverage:off$ */ /* c8 ignore start */
let DOMException = globalThis.DOMException;
if (!DOMException && typeof process !== 'undefined') {
    try {
        const { MessageChannel } = await import('worker' + '_threads');    // Don't use full name to avoid pre-compile from tools

        const port = new MessageChannel().port1;
        const ab = new ArrayBuffer(0);
        port.postMessage(ab, [ab, ab]);
    }
    catch (err: any) {
        err.constructor.name === 'DOMException' && (
            (DOMException as any) = err.constructor
        );
    }
}
/* $lab:coverage:on$ */ /* c8 ignore stop */


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

export let AbortController = globalThis.AbortController;     // Allow a ponyfill to replace the implementation

export const setAbortControllerImpl = function (impl: typeof AbortController) {

    AbortController = impl;
};

export type AbortablePromise<T> = Promise<T> & { abort: (reason?: Error) => void };

export type Byterange = {
    offset: number;
    length?: number;
};

export type FetchResult<T extends object | unknown = unknown> = {
    meta: Meta;
    stream?: T;    // ReadableStream<Uint8Array> | Readable;

    /** Resolved once the stream data has been fetched, or rejects with any transfer errors */
    completed: Promise<void>;
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
    start(url: URL, blocking?: boolean): Token;

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


// eslint-disable-next-line func-style
export function assert(condition: unknown, ...args: any[]): asserts condition {

    if (!condition) {
        const err = new Error(args.join());
        err.name = 'AssertError';
        throw err;
    }
}


export class Deferred<T> {

    promise: Promise<T>;
    resolve: (arg?: T | PromiseLike<T>) => void = undefined as any;
    reject: (err: Error) => void = undefined as any;

    constructor(independent = false) {

        this.promise = new Promise<T>((resolve, reject) => {

            this.resolve = resolve as any;
            this.reject = reject;
        });

        if (independent) {
            this.promise.catch(() => undefined);
        }
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
    static #registry = new Map<string,(uri: URL) => IChangeWatcher>();

    static create(uri: URL): IChangeWatcher | undefined {

        const factory = this.#registry.get(uri.protocol);
        return factory ? factory(uri) : undefined;
    }

    static register(proto: string, factory: (uri: URL) => IChangeWatcher) {

        this.#registry.set(proto, factory);
    }
}
