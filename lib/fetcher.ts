import { URL } from 'url';

import { Boom, internal } from '@hapi/boom';
import { wait } from '@hapi/hoek';
import M3U8Parse, { AttrList, MediaPlaylist, MediaSegment, MasterPlaylist, ParserError } from 'm3u8parse';

import { AbortError, assert, Byterange, ChangeWatcher, FsWatcher, performFetch, readFetchData, FetchOptions } from './helpers';


export type HlsPlaylistFetcherOptions = {
    /** True to handle LL-HLS streams */
    lowLatency?: boolean;

    extensions?: { [K: string]: boolean };

    onProblem?: (err: Error) => void;
};

export type PartData = {
    uri: string;
    byterange?: Byterange;
};

export type PreloadHints = {
    part?: PartData;
    map?: PartData;
};


export class ParsedPlaylist {

    private _index: Readonly<MediaPlaylist>;
    private _noLowLatency: boolean;

    constructor(index: Readonly<MediaPlaylist>, options: { noLowLatency?: boolean } = {}) {

        this._noLowLatency = !!options.noLowLatency;

        if (this._noLowLatency) {
            const stripped = index = new MediaPlaylist(index);

            delete stripped.part_info;
            delete stripped.meta.preload_hints;
            delete stripped.meta.rendition_reports;

            stripped.server_control?.delete('part-hold-back');

            if (stripped.segments.length && stripped.segments[stripped.segments.length - 1].isPartial()) {
                stripped.segments.pop();
            }

            for (const segment of stripped.segments) {
                delete segment.parts;
            }
        }

        this._index = index;
    }

    isSameHead(index: Readonly<MediaPlaylist>): boolean {

        const includePartial = !this._noLowLatency && !this._index.i_frames_only;

        const sameMsn = this._index.lastMsn(includePartial) === index.lastMsn(includePartial);
        if (!sameMsn || !includePartial) {
            return sameMsn;
        }

        // Same + partial check

        return ((this.segments[this.segments.length - 1].parts || []).length ===
            (index.segments[index.segments.length - 1].parts || []).length);
    }

    nextHead(): { msn: number; part?: number } {

        if (this.partTarget && !this._index.i_frames_only) {
            const lastSegment = this.segments.length ? this.segments[this.segments.length - 1] : { uri: undefined, parts: undefined };
            const hasPartialSegment = !lastSegment.uri;
            const parts = lastSegment.parts || [];

            return {
                msn: this._index.lastMsn(true) + +!hasPartialSegment,
                part: hasPartialSegment ? parts.length : 0
            };
        }

        return { msn: this._index.lastMsn(false) + 1 };
    }

    get index(): Readonly<MediaPlaylist> {

        return this._index;
    }

    get segments(): readonly Readonly<MediaSegment>[] {

        return this._index.segments;
    }

    get partTarget(): number | undefined {

        const info = this._index.part_info;
        return info ? info.get('part-target', AttrList.Types.Float) || undefined : undefined;
    }

    get serverControl(): { canBlockReload: boolean; partHoldBack?: number } {

        const control = this._index.server_control;
        return {
            canBlockReload: control ? control.get('can-block-reload') === 'YES' : false,
            partHoldBack: control ? control.get('part-hold-back', AttrList.Types.Float) || undefined : undefined
        };
    }

    get preloadHints(): PreloadHints {

        const hints: PreloadHints = {};

        const list = this._index.meta.preload_hints;
        for (const attrs of list || []) {
            const type = attrs.get('type')?.toLowerCase();
            if (attrs.has('uri') && type === 'part' || type === 'map') {
                hints[type] = {
                    uri: attrs.get('uri', AttrList.Types.String) || '',
                    byterange: attrs.has('byterange-start') ? {
                        offset: attrs.get('byterange-start', AttrList.Types.Int),
                        length: (attrs.has('byterange-length') ? attrs.get('byterange-length', AttrList.Types.Int) : undefined)
                    } : undefined
                };
            }
        }

        return hints;
    }
}


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

export interface PlaylistObject {
    index: Readonly<MasterPlaylist | MediaPlaylist>;
    playlist?: ParsedPlaylist;
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

    #rejected = 0;
    #index?: MediaPlaylist | MasterPlaylist;
    #playlist?: ParsedPlaylist;
    #fetch?: ReturnType<typeof performFetch>;
    #watcher?: ChangeWatcher;
    #stallTimer?: NodeJS.Timeout;
    #latest?: Promise<PlaylistObject>;
    #pending?: Promise<PlaylistObject>;
    #cancelled?: Error;

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
            if (this.url.protocol === 'file:') {
                this.#watcher = new FsWatcher(this.url);
            }

            this.#latest = this._updateIndex(this._fetchIndexFrom(this.url));
        }

        return this.#latest;
    }

    /** Wait an appropriate delay and fetch a newly updated index. Only one update can be pending. */
    update({ timeout }: { timeout?: number } = {}): Promise<PlaylistObject> {

        assert(!this.#pending, 'An update is already being fetched');
        assert(this.#index, 'An initial index() must have been sucessfully fetched');
        assert(this.#index?.isLive(), 'Playlist type cannot be updated');

        this.#cancelled = undefined;

        this._updateStallTimer(timeout);
        this.#pending = this._next()
            .finally(() => {

                this.#latest = this.#pending;
                this.#pending = undefined;
                this._updateStallTimer();
            });

        return this.#pending;
    }

    /** Check if current index can be updated. */
    canUpdate(): boolean {

        return !this.#cancelled && !!this.#index?.isLive();
    }

    /** Cancel pending index fetch or update wait. They will (eventually) fail with reason or an AbortError. */
    cancel(reason?: Error): void {

        if (this.#cancelled) {
            return;             // Ignore cancels when already cancelled
        }

        this.#cancelled = reason ?? new AbortError('Index update was aborted');
        this.#fetch?.abort(reason);
        this.#watcher?.close();
        this.#watcher = undefined;

        this._updateStallTimer();
        // TODO: cancel update wait
    }

    /**
     * Returns whether another attempt might fix the update error.
     *
     * The test is quite lenient since this will only be called for resources that have previously
     * been accessed without an error.
     */
    isRecoverableUpdateError(err: unknown): boolean {

        const { recoverableCodes } = HlsPlaylistFetcher;

        if (err instanceof Boom) {
            const boom: Boom & { isBlocking?: boolean } = err;
            if (boom.isServer ||
                boom.isBlocking ||
                recoverableCodes.has(boom.output.statusCode)) {

                return true;
            }
        }

        if (err instanceof ParserError) {
            return true;
        }

        if ((err as any).syscall) {      // Any syscall error
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

    protected preprocessIndex<T extends MediaPlaylist | MasterPlaylist>(index: T): T | undefined {

        // Reject "old" index updates (eg. from CDN cached response & hitting multiple endpoints)

        if (this.#index) {
            assert(this.#index instanceof MediaPlaylist);

            // TODO: only test when fetched without blocking request

            if (MediaPlaylist.cast(index).lastMsn(true) < this.#index.lastMsn(true)) {
                if (this.#rejected < 2) {
                    this.#rejected++;
                    throw internal('Rejected update from the past');
                }
            }

            // TODO: reject other strange updates??
        }

        this.#rejected = 0;

        return index;
    }

    protected getUpdateInterval({ index, partTarget }: ParsedPlaylist, updated = false): number {

        let updateInterval = index.target_duration!;
        if (partTarget! > 0 && !index.i_frames_only) {
            updateInterval = partTarget!;
        }

        if (!updated || !index.segments.length) {
            updateInterval /= 2;
        }

        return updateInterval;
    }

    protected performFetch(url: URL, options?: FetchOptions) {

        return performFetch(url, options);
    }

    protected readFetchContent(fetch: Awaited<ReturnType<typeof performFetch>>) {

        return readFetchData(fetch);
    }

    // Private methods

    /**
     * Should be called after every non-cancellable await to throw the cancel() reason.
     */
    private _cancelCheck(): void {

        if (this.#cancelled) {
            throw this.#cancelled;
        }
    }

     * Cancels reader after timeout ms.
     */
    private _updateStallTimer(timeout?: number): void | never {

        clearTimeout(this.#stallTimer!);
        if (timeout !== undefined && timeout !== Infinity) {
            this.#stallTimer = setTimeout(() => this.cancel(new Error('Index update stalled')), timeout);
        }
    }

    private _fetchIndexFrom(url: URL, options?: FetchOptions): Promise<FetchUrlResult> {

        let meta: FetchUrlResult['meta'];
        assert(!this.#fetch, 'Already fetching');

        const fetch = this.#fetch = this.performFetch(url, Object.assign({ timeout: 30 * 1000 }, options));
        return this.#fetch
            .then((result) => {

                meta = result.meta;
                this.validateIndexMeta(meta);

                return this.readFetchContent(result).catch((err) => {

                    fetch.abort(err);
                    throw err;
                });
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

        for (; ;) {

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
                this._cancelCheck();

                if (!(err instanceof Error) ||
                    !this.isRecoverableUpdateError(err)) {

                    throw err;
                }

                try {
                    this.onProblem(err);
                }
                catch (err) {
                    throw err;
                }

                wasError = true;
            }
        }
    }

    private async _updateIndex(fetchPromise: Promise<FetchUrlResult>): Promise<PlaylistObject> {

        try {
            // eslint-disable-next-line no-var
            var { meta, content } = await fetchPromise;
            const updatedAt = new Date();

            const rawIndex = M3U8Parse(content, { extensions: this.extensions });

            (this as any).updated = updatedAt;
            (this as any).baseUrl = meta.url;
            // eslint-disable-next-line no-eq-null, eqeqeq
            (this as any).modified = meta.modified != null ? new Date(meta.modified) : undefined;
            this.#index = this.preprocessIndex(rawIndex);
            this.#playlist = this.#index && !this.#index.master ? new ParsedPlaylist(this.#index, { noLowLatency: !this.lowLatency }) : undefined;
            assert(this.#index, 'Missing index');
        }
        catch (err) {
            this._cancelCheck();

            throw err;
        }

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

        let delayMs = this.getUpdateInterval(fromPlaylist, wasUpdated && !wasError) * 1000;
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
                    /* $lab:coverage:off$ */
                    this.#watcher = undefined;

                    if (!this.#cancelled) {
                        assert(err instanceof Error);
                        this.onProblem(err);
                    }
                    /* $lab:coverage:on$ */
                }
            }
            else {
                await wait(delayMs);
            }

            this._cancelCheck();
        }

        try {
            return await this._updateIndex(this._fetchIndexFrom(url, { blocking }));
        }
        catch (err) {
            if (err instanceof Boom) {
                Object.assign(err, { isBlocking: !!blocking });
            }

            throw err;
        }
    }
}
