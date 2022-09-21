import type { Meta } from 'uristream/lib/uri-reader.js';

import { EventEmitter } from 'events';
import { watch } from 'fs';
import { basename, dirname } from 'path';
import { finished, Readable } from 'stream';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

import AgentKeepalive from 'agentkeepalive';
import Uristream from 'uristream';

import { AbortablePromise, AbortError, assert, ChangeWatcher, Deferred, FetchOptions, FetchResult, IChangeWatcher, setAbortControllerImpl } from './helpers.js';

export * from './helpers.js';


const streamFinished = promisify(finished);


/** Simplified AbortSignal for internal usage only */
class AbortSignalInternal extends EventEmitter {
    aborted = false;
    reason?: Error;

    addEventListener(event: 'abort', listener: () => void) {

        super.addListener(event, listener);
    }

    removeEventListener(event: 'abort', listener: () => void) {

        super.removeListener(event, listener);
    }

    throwIfAborted() {

        if (this.aborted) {
            throw this.reason!;
        }
    }
}

/** Simplified AbortController for internal usage only */
class AbortControllerInternal {
    signal = new AbortSignalInternal();
    abort(reason?: Error) {

        Object.assign(this.signal, { aborted: true, reason });
        this.signal.emit('abort');
    }
}

/** Ponyfill AbortController when needed */
export const platformInit = function () {

    const useInternalAbort = true; (!globalThis.AbortController || !globalThis.AbortSignal || !globalThis.AbortSignal.prototype.throwIfAborted) as boolean;

    if (useInternalAbort) {
        setAbortControllerImpl(AbortControllerInternal as any as typeof AbortController);
    }
};


const internals = {
    fetchBuffer: 10 * 1000 * 1000,

    agents: new Map < string | symbol, { http: AgentKeepalive; https: AgentKeepalive.HttpsAgent }>(),
    blockingConfig(id?: string | symbol): { agent: { http: AgentKeepalive; https: AgentKeepalive.HttpsAgent } } | undefined {

        if (id === undefined) {
            return;
        }

        // Create a keepalive agent with 1 socket for each blocking id

        let agents = internals.agents.get(id);
        if (!agents) {
            const config = {
                maxSockets: 1,
                maxFreeSockets: 1,
                timeout: 0, // disable socket inactivity timeout
                freeSocketTimeout: 20_000 // free unused sockets after 20 seconds
            };

            agents = {
                http: new AgentKeepalive(config),
                https: new AgentKeepalive.HttpsAgent(config)
            };

            internals.agents.set(id, agents);
        }

        return { agent: agents };
    }
};


export const performFetch = function (uri: URL, { byterange, probe = false, timeout, retries = 1, blocking, signal }: FetchOptions = {}): AbortablePromise<FetchResult<Readable>> {

    signal?.throwIfAborted();

    const streamOptions = Object.assign({
        probe,
        highWaterMark: internals.fetchBuffer,
        timeout,
        retries
    }, internals.blockingConfig(blocking), byterange ? {
        start: byterange.offset,
        end: byterange.length !== undefined ? byterange.offset + byterange.length - 1 : undefined
    } : undefined);

    const stream = Uristream(uri.toString(), streamOptions);

    const onSignalAbort = () => promise.abort(signal!.reason);

    const promise = new Promise<FetchResult>((resolve, reject) => {

        const doFinish = (err: Error | null, meta?: Meta) => {

            signal?.removeEventListener('abort', onSignalAbort);
            stream.removeListener('meta', onMeta);
            stream.removeListener('end', onFail);
            stream.removeListener('error', onFail);

            if (err) {
                return reject(err);
            }

            assert(meta);

            if (probe) {
                stream.resume();     // Ensure that we actually end
            }

            const completed = streamFinished(stream, { signal });
            completed.catch(() => undefined);

            process.nextTick(() => resolve({ meta, stream: probe ? undefined : stream, completed }));
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

            /* $lab:coverage:off$ */ /* c8 ignore start */

            if (!err) {
                err = new Error('No metadata');
            }
            /* $lab:coverage:on$ */ /* c8 ignore stop */

            return doFinish(err);
        };

        stream.on('meta', onMeta);
        stream.on('end', onFail);
        stream.on('error', onFail);
    }) as any;

    promise.abort = (reason?: Error) => !stream.destroyed && stream.destroy(reason ?? new AbortError('Fetch was aborted'));
    signal?.addEventListener('abort', onSignalAbort);

    return promise;
};


export const readFetchData = async function ({ stream }: FetchResult<Readable>): Promise<string> {

    assert(stream, 'Must have a stream');

    let content = '';

    stream.setEncoding('utf-8');
    for await (const chunk of stream) {
        content += chunk;
    }

    return content;
};


export const cancelFetch = function (fetch: FetchResult<Readable> | undefined, reason?: Error): void {

    if (fetch?.stream) {
        fetch.stream.destroy(reason);
        fetch.stream = undefined;
    }
};


type FSWatcherEvents = 'rename' | 'change' | 'timeout';

export class FsWatcher implements IChangeWatcher {

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
                    setImmediate(() => {

                        if (!this._deferred) {
                            return;                 // Can happen if error is triggered
                        }

                        this._deferred!.resolve(eventType);
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
            this._timer = setTimeout(() => {

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

ChangeWatcher.register('file:', (uri: URL) => new FsWatcher(uri));
