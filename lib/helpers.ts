import type { Readable } from 'stream';
import type { Meta } from 'uristream/lib/uri-reader';

import { watch } from 'fs';
import { basename, dirname } from 'path';
import { URL, fileURLToPath } from 'url';

import { assert as hoekAssert, ignore } from '@hapi/hoek';
import Uristream = require('uristream');


// eslint-disable-next-line func-style
export function assert(condition: unknown, ...args: any[]): asserts condition {

    hoekAssert(condition, ...args);
}


export type Byterange = {
    offset: number;
    length?: number;
};

export type FetchResult = {
    meta: Meta;
    stream?: Readable;
};


const internals = {
    fetchBuffer: 10 * 1000 * 1000
};


export class Deferred<T> {

    promise: Promise<T>;
    resolve: (arg?: T) => void = undefined as any;
    reject: (err: Error) => void = undefined as any;

    constructor(independent = false) {

        this.promise = new Promise<T>((resolve, reject) => {

            this.resolve = resolve;
            this.reject = reject;
        });

        if (independent) {
            this.promise.catch(ignore);
        }
    }
}


type AbortablePromise<T> = Promise<T> & { abort: () => void };

type FetchOptions = {
    byterange?: Byterange;
    probe?: boolean;
    timeout?: number;
    retries?: number;
};


export const performFetch = function (uri: URL | string, { byterange, probe = false, timeout, retries = 1 }: FetchOptions = {}): AbortablePromise<FetchResult> {

    const streamOptions = Object.assign({
        probe,
        highWaterMark: internals.fetchBuffer,
        timeout: probe ? 30 * 1000 : timeout,
        retries
    }, byterange ? {
        start: byterange.offset,
        end: byterange.length !== undefined ? byterange.offset + byterange.length - 1 : undefined
    } : undefined);

    const stream = Uristream(uri.toString(), streamOptions);

    const promise = new Promise<FetchResult>((resolve, reject) => {

        const doFinish = (err: Error | null, meta?: Meta) => {

            stream.removeListener('meta', onMeta);
            stream.removeListener('end', onFail);
            stream.removeListener('error', onFail);

            if (err) {
                return reject(err);
            }

            assert(meta);

            const result = { meta, stream: probe ? undefined : stream };
            if (!result.stream) {
                stream.destroy();
            }

            return resolve(result);
        };

        const onMeta = (meta: Meta) => {

            meta = Object.assign({}, meta);

            // Change filesize to stream length

            if (meta.size >= 0 && byterange) {
                meta.size = meta.size - byterange.offset;
                if (byterange.length !== undefined) {
                    meta.size = Math.min(meta.size, byterange.length);
                }
            }

            return doFinish(null, meta);
        };

        const onFail = (err?: Error) => {

            // Guard against broken uristream

            /* $lab:coverage:off$ */
            if (!err) {
                err = new Error('No metadata');
            }
            /* $lab:coverage:on$ */

            return doFinish(err);
        };

        stream.on('meta', onMeta);
        stream.on('end', onFail);
        stream.on('error', onFail);
    }) as any;

    promise.abort = () => !stream.destroyed && stream.destroy(new Error('Aborted'));

    return promise;
};


type FSWatcherEvents = 'rename' | 'change'| 'timeout';

export class FsWatcher {

    private _watcher: ReturnType<typeof watch>;
    private _last?: FSWatcherEvents;
    private _error?: Error;
    private _deferred?: Deferred<FSWatcherEvents>;
    private _delayed?: FSWatcherEvents;
    private _timer?: NodeJS.Timeout;

    constructor(uri: URL | string) {

        const change = (eventType: FSWatcherEvents, name: string) => {

            if (name !== fileName) {
                return;
            }

            if (this._deferred) {
                if (!this._delayed) {

                    // Slightly delay resolve to handle multiple simultaneous firings

                    this._delayed = eventType;
                    clearTimeout(this._timer!);
                    setImmediate((deferred) => {

                        this._deferred!.resolve(this._delayed);
                        this._deferred = this._delayed = undefined;
                    });
                }

                return;
            }

            this._last = eventType;
        };

        const error = (err: Error) => {

            if (this._deferred) {
                this._deferred.reject(err);
                this._deferred = undefined;
                clearTimeout(this._timer!);
            }

            this._error = err;
        };

        const path = fileURLToPath(uri);
        const fileName = basename(path);
        const dirName = dirname(path);

        // Watch parent dir, since an atomic replace will have a new inode, and stop the watch for the path

        const watcher = this._watcher = watch(dirName, { persistent: false });

        watcher.on('change', change);
        watcher.on('error', error);
        watcher.once('close', () => {

            watcher.removeListener('change', change);
            watcher.removeListener('error', error);
            this._last = undefined;
        });
    }

    // Returns latest event since last call, or waits for next

    next(timeoutMs?: number): PromiseLike<FSWatcherEvents> | FSWatcherEvents {

        if (this._error) {
            throw this._error;
        }

        const last = this._last;
        if (last !== undefined) {
            this._last = undefined;
            return last;
        }

        this._deferred = new Deferred();

        if (timeoutMs !== undefined) {
            this._timer = setTimeout((deferred: Deferred<FSWatcherEvents>) => {

                this._deferred!.resolve('timeout');
                this._deferred = undefined;
            }, timeoutMs);
        }

        return this._deferred.promise;
    }

    close(): void {

        if (!this._error) {
            this._error = new Error('closed');
            this._watcher.close();

            if (this._deferred) {
                this._deferred.reject(this._error);
                this._deferred = undefined;
                clearTimeout(this._timer!);
            }
        }
    }
}
