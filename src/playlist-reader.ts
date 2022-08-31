import type { ReadableOptions } from 'stream';
import type { MediaPlaylist, MasterPlaylist } from 'm3u8parse';

import { BaseEvents, TypedEmitter, TypedReadable } from '../lib/raw/typed-readable.js';
import { HlsPlaylistFetcher, HlsPlaylistFetcherOptions, PlaylistObject } from './fetcher.js';


const HlsPlaylistReaderEvents = <IHlsPlaylistReaderEvents & BaseEvents>(null as any);
interface IHlsPlaylistReaderEvents {
    problem(err: Readonly<Error>): void;
}

export type HlsPlaylistReaderOptions = Omit<HlsPlaylistFetcherOptions, 'onProblem'> & {
    maxStallTime?: number;
    fetcher?: typeof HlsPlaylistFetcher;
};

/**
 * Reads an HLS media playlist, and emits updates.
 * Live & Event playlists are refreshed as needed, and expired segments are dropped when backpressure is applied.
 */
export class HlsPlaylistReader extends TypedEmitter(HlsPlaylistReaderEvents, TypedReadable<Readonly<PlaylistObject>>()) {

    stallAfterMs: number;
    fetch?: HlsPlaylistFetcher;

    index?: Readonly<MasterPlaylist | MediaPlaylist>;

    constructor(uri: URL | string, options: HlsPlaylistReaderOptions = {}) {

        super({ objectMode: true, highWaterMark: 0, autoDestroy: true, emitClose: true } as ReadableOptions);

        this.fetch = new (options.fetcher || HlsPlaylistFetcher)(uri, { ...options, onProblem: (err) => this.emit('problem', err) });
        this.stallAfterMs = options.maxStallTime ?? Infinity;

        // Pre-fetch the initial index

        this.fetch.index().catch(this.destroy.bind(this));
    }

    // Overrides

    _read(): void {

        const fetcher = this.index ? this.fetch!.update({ timeout: this.stallAfterMs }) : this.fetch!.index();

        fetcher.then((res) => {

            this.index = res.index;
            this.push(res);

            if (!this.fetch!.canUpdate()) {
                this.push(null);
            }
        }, this.destroy.bind(this));
    }

    _destroy(err: Error | null, cb: unknown): void {

        this.fetch!.cancel(err || undefined);
        this.fetch = undefined;      // Unlink reference

        return super._destroy(err, cb as any);
    }
}
