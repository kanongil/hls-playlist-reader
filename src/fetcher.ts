import M3U8Parse, { MediaPlaylist, ParserError, M3U8Playlist } from 'm3u8parse';

import { AbortController, AbortError, AbortablePromise, assert, ChangeWatcher, FetchOptions, FetchResult, IChangeWatcher, wait } from './helpers.js';
import { ParsedPlaylist } from './playlist.js';


export type HlsPlaylistFetcherOptions = {
    /** True to handle LL-HLS streams */
    lowLatency?: boolean;

    extensions?: { [K: string]: boolean };

    onProblem?: (err: Error) => void;
};

type FetchUrlResult = {
    content: string;
    meta: {
        url: string;
        mime: string;
        modified?: Date | null;
    };
};

export type HlsIndexMeta = {
    url: string;
    updated: Date;
    modified?: Date;
};

export interface PlaylistObject<T extends M3U8Playlist = M3U8Playlist> {
    index: Readonly<T>;
    playlist: T extends MediaPlaylist ? ParsedPlaylist : undefined;
    meta: Readonly<HlsIndexMeta>;
}

export class HlsPlaylistFetcher {

    static readonly indexMimeTypes = new Set([
        'application/vnd.apple.mpegurl',
        'application/x-mpegurl',
        'audio/mpegurl'
    ]);

    static readonly recoverableCodes = new Set<number>([
        404, // Not Found
        408, // Request Timeout
        425, // Too Early
        429 // Too Many Requests
    ]);

    url: URL;

    lowLatency: boolean;
    readonly extensions: HlsPlaylistFetcherOptions['extensions'];

    readonly baseUrl: string;
    readonly modified?: Date;
    readonly updated?: Date;
    readonly updates = 0;

    #rejected = 0;
    #index?: M3U8Playlist;
    #playlist?: ParsedPlaylist;
    #fetch?: AbortablePromise<FetchResult>;
    #watcher?: IChangeWatcher;
    #stallTimer?: NodeJS.Timeout;
    #latest?: Promise<PlaylistObject>;
    #pending?: Promise<PlaylistObject>;
    //#waiting?: Deferred<void>;
    #ac = new AbortController();

    constructor(uri: URL | string, options: HlsPlaylistFetcherOptions = {}) {

        this.url = new URL(uri as any);
        this.baseUrl = this.url.href;

        this.lowLatency = !!options.lowLatency;
        this.extensions = options.extensions ?? {};

        if (options.onProblem) {
            this.onProblem = options.onProblem;
        }
    }

    get playlist(): ParsedPlaylist | undefined {

        return this.#playlist;
    }

    // Primary API methods

    /** Fetch the current index. */
    index(): Promise<PlaylistObject> {

        if (!this.#latest) {
            this.#watcher = ChangeWatcher.create(this.url);
            this.#latest = this._updateIndex(this._fetchIndexFrom(this.url));
        }

        return this.#latest;
    }

    /** Wait an appropriate delay and fetch a newly updated index. Only one update can be pending. */
    update({ timeout }: { timeout?: number } = {}): Promise<PlaylistObject> {

        assert(!this.#pending, 'An update is already being fetched');
        assert(this.#index, 'An initial index() must have been sucessfully fetched');
        assert(this.canUpdate(), 'Playlist cannot be updated');

        this._updateStallTimer(timeout);
        this.#pending = this._next()
            .finally(() => {

                ++(<{ updates: number }> this).updates;
                this.#latest = this.#pending;
                this.#pending = undefined;
                this._updateStallTimer();

                if (!this.canUpdate()) {
                    this.cleanup();
                }
            });

        /*if (this.#waiting) {
            this.#waiting.resolve();
            this.#waiting = undefined;
        }*/

        return this.#pending;
    }

    /** Wait until the playlist has been updated, but don't trigger an update. */
    /*async next(): Promise<PlaylistObject> {

        assert(this.canUpdate(), 'Playlist cannot be updated');

        if (!this.#pending) {
            if (!this.#waiting) {
                this.#waiting = new Deferred();
            }

            await this.#waiting.promise;
        }

        return this.#pending!;
    }*/

    /** Check if current index can be updated. */
    canUpdate(): boolean {

        return !this.#ac.signal.aborted && !!this.#index?.isLive();
    }

    /** Cancel any pending index fetch or update wait. They will fail with reason or an AbortError. */
    cancel(reason?: Error): void {

        if (this.#ac.signal.aborted) {
            return;             // Ignore cancels when already cancelled
        }

        this.#ac.abort(reason ?? new AbortError('Index update was aborted'));
        this.cleanup();
    }

    /**
     * Returns whether another attempt might fix the update error.
     *
     * The test is quite lenient since this will only be called for resources that have previously
     * been accessed without an error.
     */
    isRecoverableUpdateError(err: unknown, httpStatus?: number): boolean {

        const { recoverableCodes } = HlsPlaylistFetcher;

        if ((err as any).isBlocking === true) {
            return true;
        }

        if (!httpStatus && typeof (err as any).httpStatus === 'number') {
            httpStatus = (err as any).httpStatus;
        }

        if (httpStatus) {
            const isServer = httpStatus >= 500 && httpStatus <= 599;
            return isServer || recoverableCodes.has(httpStatus);
        }

        if (err instanceof ParserError) {
            return true;
        }

        return false;
    }

    // Overrideable methods for customized handling

    protected onProblem(err: Error) {

        err;      // Ignore by default
    }

    protected validateIndexMeta(meta: FetchUrlResult['meta']): void | never {

        // Check for valid mime type

        if (!HlsPlaylistFetcher.indexMimeTypes.has(meta.mime.toLowerCase()) &&
            meta.url.indexOf('.m3u8', meta.url.length - 5) === -1 &&
            meta.url.indexOf('.m3u', meta.url.length - 4) === -1) {

            throw new Error('Invalid MIME type: ' + meta.mime);
        }
    }

    protected preprocessIndex<T extends M3U8Playlist>(index: T): T | undefined {

        // Reject "old" index updates (eg. from CDN cached response & hitting multiple endpoints)

        if (this.#index) {
            assert(this.#index instanceof MediaPlaylist);

            // TODO: only test when fetched without blocking request

            if (MediaPlaylist.cast(index).lastMsn(true) < this.#index.lastMsn(true)) {
                // TODO: signal onProblem???
                // TODO: why only throw when rejected is low???
                // TODO: don't use httpStatus to signal content error
                if (this.#rejected < 2) {
                    this.#rejected++;
                    const err = new Error('Rejected update from the past');
                    (err as any).httpStatus = 500;
                    throw err;
                }
            }

            // TODO: reject other strange updates??
        }

        this.#rejected = 0;

        return index;
    }

    protected getUpdateInterval({ index, partTarget }: ParsedPlaylist, updated = false): number | undefined {

        let updateInterval = index.target_duration!;
        if (partTarget! > 0 && !index.i_frames_only) {
            updateInterval = partTarget!;
        }

        if (!updated || !index.segments.length) {
            updateInterval /= 2;
        }

        return updateInterval;
    }

    protected performFetch(url: URL, options?: FetchOptions): AbortablePromise<FetchResult> {

        throw new Error('No fetcher');
    }

    protected readFetchContent(fetch: FetchResult): Promise<string> {

        throw new Error('No fetcher');
    }

    protected cleanup() {

        this.#watcher?.close();
        this.#watcher = undefined;
    }

    // Private methods

    /**
     * Cancels reader after timeout ms.
     */
    private _updateStallTimer(timeout?: number): void | never {

        clearTimeout(this.#stallTimer!);
        if (timeout !== undefined && timeout !== Infinity) {
            this.#stallTimer = setTimeout(() => this.cancel(new Error('Index update stalled')), timeout);
        }
    }

    private _fetchIndexFrom(url: URL, options?: Omit<FetchOptions, 'signal'>): Promise<FetchUrlResult> {

        let meta: FetchUrlResult['meta'];
        assert(!this.#fetch, 'Already fetching');

        this.#fetch = this.performFetch(url, Object.assign({ timeout: 30 * 1000, signal: this.#ac.signal }, options));
        return this.#fetch
            .then((result) => {

                meta = result.meta;
                this.validateIndexMeta(meta);

                return this.readFetchContent(result);
            })
            .then((content) => ({ meta, content }))
            .finally(() => {

                this.#fetch = undefined;
            });
    }

    private async _next(): Promise<PlaylistObject> {

        const playlist = this.#playlist;
        let wasUpdated = true;
        let wasError = false;

        assert(playlist, 'Missing playlist');

        for (;;) {

            // Keep retrying until success or an unrecoverable error

            try {
                const res = await this._delayedUpdate(playlist, wasUpdated, wasError);
                assert(!res.index.master, 'Update must return a media playlist');
                if (!this.canUpdate() || !playlist.isSameHead(res.index)) {
                    return res;
                }

                wasUpdated = false;
            }
            catch (err) {
                if (!(err instanceof Error) ||
                    !this.isRecoverableUpdateError(err)) {

                    throw err;
                }

                this.onProblem(err);

                wasError = true;
            }

            await wait(100);     // Always wait at least 100ms before retrying
        }
    }

    private async _updateIndex(fetchPromise: Promise<FetchUrlResult>): Promise<PlaylistObject> {

        const { meta, content } = await fetchPromise;
        const updatedAt = new Date();

        const rawIndex = M3U8Parse(content, { extensions: this.extensions });

        (this as any).updated = updatedAt;
        (this as any).baseUrl = meta.url;
        // eslint-disable-next-line no-eq-null, eqeqeq
        (this as any).modified = meta.modified != null ? new Date(meta.modified) : undefined;
        this.#index = this.preprocessIndex(rawIndex);
        this.#playlist = this.#index && !this.#index.master ? new ParsedPlaylist(this.#index, { noLowLatency: !this.lowLatency }) : undefined;
        assert(this.#index, 'Missing index');

        return { index: this.#index!, playlist: this.#playlist, meta: { url: meta.url, modified: this.modified, updated: this.updated! } };
    }

    /**
     * Calls _performUpdate() with corrected url, after an approriate delay
     */
    private async _delayedUpdate(fromPlaylist: ParsedPlaylist, wasUpdated = true, wasError = false): Promise<PlaylistObject> {

        const url = new URL(this.url as any);
        if (url.protocol === 'data:') {
            throw new Error('data: uri cannot be updated');
        }

        let delayMs = this.getUpdateInterval(fromPlaylist, wasUpdated && !wasError)! * 1000;
        let blocking;

        if (wasUpdated) {
            delayMs -= Date.now() - +this.updated!;
        }

        // Apply SERVER-CONTROL, if available

        if (wasUpdated && fromPlaylist.serverControl.canBlockReload) {
            const head = fromPlaylist.nextHead();

            // TODO: detect when playlist is behind server, and guess future part instead / CDN tunein

            // Params should appear in UTF-8 order

            url.searchParams.set('_HLS_msn', `${head.msn}`);
            if (head.part !== undefined) {
                url.searchParams.set('_HLS_part', `${head.part}`);
            }

            blocking = this.url.href;
            delayMs = 0;
        }

        if (delayMs > 0) {
            if (this.#watcher) {
                try {
                    await this.#watcher.next(delayMs);
                }
                catch (err) {
                    this.#watcher = undefined;

                    this.#ac.signal.throwIfAborted();

                    /* $lab:coverage:off$ */ /* c8 ignore start */
                    assert(err instanceof Error);
                    this.onProblem(err);
                    /* $lab:coverage:on$ */ /* c8 ignore stop */
                }
            }
            else {
                await wait(delayMs, { signal: this.#ac.signal });
            }
        }

        try {
            return await this._updateIndex(this._fetchIndexFrom(url, { blocking }));
        }
        catch (err: any) {
            if (err.isBoom || typeof err.httpStatus === 'number' || typeof err.statusCode === 'number') {
                Object.assign(err, { isBlocking: !!blocking });
            }

            throw err;
        }
    }
}
