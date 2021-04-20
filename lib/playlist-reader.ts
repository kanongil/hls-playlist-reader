import type { ReadableOptions } from 'readable-stream';
import type { FetchResult } from './helpers';

import { Stream } from 'stream';
import { URL } from 'url';

import { Boom, internal } from '@hapi/boom';
import { wait } from '@hapi/hoek';
import M3U8Parse, { AttrList, MediaPlaylist, MediaSegment, MasterPlaylist, ParserError } from 'm3u8parse';

import { assert, Byterange, FsWatcher, performFetch, FetchOptions } from './helpers';
import { BaseEvents, TypedEmitter, TypedReadable } from './raw/typed-readable';


type Hint = {
    uri: string;
    byterange?: {
        offset: number;
        length?: number;
    };
};


const internals = {
    emptyHints: Object.freeze({ part: undefined, map: undefined }),

    isSameHint(h1?: Hint, h2?: Hint): boolean {

        if (h1 === undefined || h2 === undefined) {
            return h1 === h2;
        }

        if (h1.uri !== h2.uri) {
            return false;
        }

        if (h1.byterange && h2.byterange) {
            if (h1.byterange.offset !== h2.byterange.offset ||
                h1.byterange.length !== h2.byterange.length) {
                return false;
            }
        }
        else if (h1.byterange !== h2.byterange) {
            return false;
        }

        return true;
    }
};


export type HlsPlaylistReaderOptions = {
    /** True to handle LL-HLS streams */
    lowLatency?: boolean;

    maxStallTime?: number;

    extensions?: { [K: string]: boolean };
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


export type HlsIndexMeta = {
    url: string;
    updated: Date;
    modified?: Date;
};

export interface PlaylistReaderObject {
    index: Readonly<MasterPlaylist | MediaPlaylist>;
    playlist?: ParsedPlaylist;
    meta: Readonly<HlsIndexMeta>;
}

const HlsPlaylistReaderEvents = <IHlsPlaylistReaderEvents & BaseEvents>(null as any);
interface IHlsPlaylistReaderEvents {
    problem(err: Readonly<Error>): void;
}


/**
 * Reads an HLS media playlist, and emits updates.
 * Live & Event playlists are refreshed as needed, and expired segments are dropped when backpressure is applied.
 */
export class HlsPlaylistReader extends TypedEmitter(HlsPlaylistReaderEvents, TypedReadable<Readonly<PlaylistReaderObject>>()) {

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

    readonly url: URL;
    lowLatency: boolean;
    readonly extensions: HlsPlaylistReaderOptions['extensions'];
    stallAfterMs: number;

    readonly baseUrl: string;
    readonly modified?: Date;
    readonly updated?: Date;
    processing = false;

    #rejected = 0;
    #index?: MediaPlaylist | MasterPlaylist;
    #playlist?: ParsedPlaylist;
    #currentHints: ParsedPlaylist['preloadHints'] = internals.emptyHints;
    #fetch?: ReturnType<typeof performFetch>;
    #watcher?: FsWatcher;
    #stallTimer?: NodeJS.Timeout;

    constructor(uri: URL | string, options: HlsPlaylistReaderOptions = {}) {

        super({ objectMode: true, highWaterMark: 0, autoDestroy: true, emitClose: true } as ReadableOptions);

        this.url = new URL(uri as string);
        this.baseUrl = this.url.href;

        this.lowLatency = !!options.lowLatency;

        this.stallAfterMs = options.maxStallTime ?? Infinity;

        this.extensions = options.extensions ?? {};

        this._start();
    }

    get index(): Readonly<MediaPlaylist | MasterPlaylist> | undefined {

        return this.#index;
    }

    get playlist(): ParsedPlaylist | undefined {

        return this.#playlist;
    }

    get hints(): ParsedPlaylist['preloadHints'] {

        return this.#currentHints;
    }

    validateIndexMeta(meta: FetchResult['meta']): void | never {

        // Check for valid mime type

        if (!HlsPlaylistReader.indexMimeTypes.has(meta.mime.toLowerCase()) &&
            meta.url.indexOf('.m3u8', meta.url.length - 5) === -1 &&
            meta.url.indexOf('.m3u', meta.url.length - 4) === -1) {

            throw new Error('Invalid MIME type: ' + meta.mime);
        }
    }

    /**
     * Returns whether another attempt might fix the update error.
     *
     * The test is quite lenient since this will only be called for resources that have previously
     * been accessed without an error.
     */
    isRecoverableUpdateError(err: Error): boolean {

        const { recoverableCodes } = HlsPlaylistReader;

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

    canUpdate(): boolean {

        return !this.destroyed && (!this.index || this.index.isLive());
    }

    protected preprocessIndex<T extends MediaPlaylist | MasterPlaylist>(index: T): T | undefined {

        // Reject "old" index updates (eg. from CDN cached response & hitting multiple endpoints)

        if (this.index) {
            assert(this.index instanceof MediaPlaylist);

            // TODO: only test when fetched without blocking request

            if (MediaPlaylist.cast(index).lastMsn(true) < this.index.lastMsn(true)) {
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

    // Overrides

    _read(): void {

        if (!this.processing && this.canUpdate()) {
            this._startUpdate();
        }
    }

    _destroy(err: Error | null, cb: unknown): void {

        if (this.#fetch) {
            this.#fetch.abort();
        }

        if (this.#watcher) {
            this.#watcher.close();
            this.#watcher = undefined;
        }

        clearTimeout(this.#stallTimer!);

        return super._destroy(err, cb as any);
    }

    // Private methods

    /**
     * Destroys reader if method has not been called with updated === true for options.stallAfterMs
     */
    private _stallCheck(updated = false): void | never {

        if (updated) {
            clearTimeout(this.#stallTimer!);
            if (this.stallAfterMs !== Infinity) {
                this.#stallTimer = setTimeout(() => {

                    this.destroy(new Error('Index update stalled'));
                }, this.stallAfterMs);
            }
        }
    }

    private _updateHints(playlist: ParsedPlaylist): boolean {

        const hints = this.lowLatency ? playlist.preloadHints : internals.emptyHints;

        if (internals.isSameHint(hints.part, this.#currentHints.part)) {
            return false;
        }

        this.#currentHints = hints;
        return true;
    }

    private _pushUpdate(meta: HlsIndexMeta): boolean {

        assert(!this._readableState.ended);
        assert(this.index, 'Missing index');

        this.push({ index: this.index, playlist: this.#playlist, meta });

        return false; // Always stall
    }

    private _updateErrorHandler(err: Error): void {

        if (!this.destroyed) {
            if (!this.isRecoverableUpdateError(err)) {
                this.destroy(err);
                return;
            }

            try {
                this.emit<'problem'>('problem', err);
            }
            catch (err) {
                this.destroy(err);
            }
        }
    }

    private _createFetch(url: URL, options?: FetchOptions): ReturnType<typeof performFetch> {

        assert(!this.#fetch, 'Already fetching');

        return (this.#fetch = performFetch(url, Object.assign({ timeout: 30 * 1000 }, options)));
    }

    private _start() {

        // Prepare watcher in case it is needed

        if (this.url.protocol === 'file:') {
            this.#watcher = new FsWatcher(this.url);
        }

        this.processing = true;
        this._performUpdate(this._createFetch(this.url)).catch(this.destroy.bind(this));
    }

    private _startUpdate(wasUpdated = true, wasError = false) {

        assert(this.#playlist, 'Missing playlist');
        assert(!this.destroyed, 'destroyed');

        this.processing = true;
        this._delayedUpdate(this.#playlist, wasUpdated, wasError).catch(this._updateErrorHandler.bind(this));
    }

    /**
     * Runs in a loop until there are no more updates, or stream is destroyed
     */
    private async _performUpdate(fetchPromise: ReturnType<typeof performFetch>, fromIndex?: Readonly<MediaPlaylist>): Promise<void> {

        let updated = !fromIndex;
        let errored = false;
        let more = true;
        try {
            // eslint-disable-next-line no-var
            var { meta, stream } = await fetchPromise;
            const updatedAt = new Date();

            this.validateIndexMeta(meta);

            const rawIndex = await M3U8Parse(stream as Stream, { extensions: this.extensions });

            (this as any).updated = updatedAt;
            (this as any).baseUrl = meta.url;
            (this as any).modified = meta.modified !== null ? new Date(meta.modified) : undefined;
            this.#index = this.preprocessIndex(rawIndex);

            assert(this.index, 'Missing index');

            updated ||= !this.canUpdate();      // If there are no more updates, then we always need to push the index

            this.#playlist = !this.index.master ? new ParsedPlaylist(this.index, { noLowLatency: !this.lowLatency }) : undefined;
            if (this.#playlist) {
                if (fromIndex && this.canUpdate()) {
                    updated ||= !this.#playlist.isSameHead(fromIndex);
                }

                updated = this._updateHints(this.#playlist) || updated; // No ||= since the update has a side-effect, and will not be called if updated is already set
            }

            more = !updated || this._pushUpdate({ url: meta.url, modified: this.modified, updated: this.updated! });

            if (!this.canUpdate()) {
                this.push(null);
                return;
            }
        }
        catch (err) {
            if (stream) {
                stream.destroy();
            }

            errored = true;

            if (!this.destroyed) {
                throw err;
            }
        }
        finally {
            this.#fetch = undefined;
            this.processing = false;

            this._stallCheck(updated);

            if (more && this.index?.isLive()) {
                this._startUpdate(updated, errored);
            }
        }
    }

    /**
     * Calls _performUpdate() with corrected url, after an approriate delay
     */
    private async _delayedUpdate(fromPlaylist: ParsedPlaylist, wasUpdated = true, wasError = false): ReturnType<HlsPlaylistReader['_performUpdate']> {

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

        if (!wasError && fromPlaylist.serverControl.canBlockReload) {
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
                    if (!this.destroyed) {
                        this.emit<'problem'>('problem', err);
                    }

                    this.#watcher = undefined;
                    /* $lab:coverage:on$ */
                }
            }
            else {
                await wait(delayMs);
            }

            assert(!this.destroyed, 'destroyed');
        }

        try {
            return await this._performUpdate(this._createFetch(url, { blocking }), fromPlaylist.index);
        }
        catch (err) {
            if (err instanceof Boom) {
                throw Object.assign(err, { isBlocking: !!blocking });
            }

            throw err;
        }
    }
}
