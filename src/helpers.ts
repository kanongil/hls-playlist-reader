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
    constructor(message: string) {

        super(message, 'AbortError');
    }
}

export class TimeoutError extends DOMException {
    constructor(message: string) {

        super(message, 'TimeoutError');
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

export type FetchResult<T extends object = any> = {
    meta: Meta;
    stream?: T;    // ReadableStream<Uint8Array> | Readable;
};

export type FetchOptions = {
    byterange?: Byterange;
    probe?: boolean;
    timeout?: number;
    retries?: number;
    blocking?: string | symbol;
    fresh?: boolean;
    signal?: AbortSignal;
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
