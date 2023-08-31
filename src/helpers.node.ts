import type { Meta } from 'uristream/lib/uri-reader.js';
import { Readable } from 'stream';

import { watch } from 'fs';
import { basename, dirname } from 'path';
import { fileURLToPath } from 'url';

import AgentKeepalive from 'agentkeepalive';
import Uristream from 'uristream';

import { AbortablePromise, AbortError, assert, ChangeWatcher, Deferred, FetchOptions, IFetchResult, IChangeWatcher, IContentFetcher, IURL } from './helpers.js';

export * from './helpers.js';


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


export type TFetcherStream = Readable;

class NodeFetchResult implements IFetchResult<TFetcherStream> {

    readonly meta: IFetchResult['meta'];
    readonly completed: IFetchResult['completed'];
    stream?: TFetcherStream;

    constructor(meta: IFetchResult['meta'], stream: TFetcherStream | undefined, completed: IFetchResult['completed']) {

        this.meta = meta;
        this.stream = stream;
        this.completed = completed;
    }

    cancel(reason?: Error): void {

        this.stream?.destroy(reason);
        this.stream = undefined;
    }

    async consumeUtf8(): Promise<string> {

        let content = '';

        const stream = this.stream;
        if (stream) {
            this.stream = undefined;

            stream.setEncoding('utf-8');
            for await (const chunk of stream) {
                content += chunk;
            }
        }

        return content;
    }
}

class NodeFetcher implements IContentFetcher<TFetcherStream> {

    static StreamProto: TFetcherStream = Readable.prototype;

    readonly type = 'node';

    perform(uri: IURL, { byterange, probe = false, timeout, retries = 1, blocking, signal, tracker }: FetchOptions = {}): AbortablePromise<IFetchResult<TFetcherStream>> {

        signal?.throwIfAborted();

        let _token: unknown;
        try {
            _token = tracker?.start(uri, { byterange, blocking: !!blocking });
        }
        catch (err) {
            return Object.assign(Promise.reject(err), {
                // eslint-disable-next-line @typescript-eslint/no-empty-function
                abort() {}
            });
        }

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

        // Track both ready (has meta) and completed (stream fully fetched / errored)

        const completed = new Promise<void>((resolve, reject) => {

            stream.on('error', reject);
            stream.on('close', resolve);

            if (!probe) {
                // Intercept embedded push to immediately know when any underlying stream is completed.
                // This way it doesn't need to be consumed for it to trigger.

                const origPush = stream.push;
                stream.push = (chunk: any, ...rest: any[]): boolean => {

                    if (chunk === null) {
                        stream.removeListener('error', reject);
                        stream.removeListener('close', resolve);
                        process.nextTick(resolve);
                    }

                    return origPush.call(stream, chunk, ...rest);
                };
            }
        });

        finish ? completed.then(finish, finish) : completed.catch(() => undefined);

        if (advance) {
            stream.on('data', (chunk) => advance(chunk.byteLength));
        }

        stream.pause();

        const ready = Object.assign(new Promise<IFetchResult<TFetcherStream>>((resolve, reject) => {

            const doFinish = (err: Error | null, meta?: Meta) => {

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

                resolve(new NodeFetchResult(meta, probe ? undefined : stream, completed));
            };

            const onMeta = (meta: Meta) => {

                meta = Object.assign({}, meta);

                if (!probe) {
                    advance?.(0);
                }

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

                finish?.();

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
        }), {
            abort(reason?: Error) {

                if (!stream.destroyed) {
                    stream.destroy(reason ?? new AbortError('Fetch was aborted'));
                }
            }
        });

        // Handle abort signal

        if (signal) {
            const onSignalAbort = () => ready.abort(signal.reason);
            const cleanup = () => signal.removeEventListener('abort', onSignalAbort);

            signal.addEventListener('abort', onSignalAbort);
            completed.then(cleanup, cleanup);
        }

        return ready;
    }
}

export const ContentFetcher = NodeFetcher;


type FSWatcherEvents = 'rename' | 'change' | 'timeout';

export class FsWatcher implements IChangeWatcher {

    private _watcher: ReturnType<typeof watch>;
    private _last?: FSWatcherEvents;
    private _error?: Error;
    private _deferred?: Deferred<FSWatcherEvents>;
    private _delayed?: FSWatcherEvents;
    private _timer?: NodeJS.Timeout;

    constructor(uri: IURL | string) {

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

ChangeWatcher.register('file:', (uri: IURL) => new FsWatcher(uri));
