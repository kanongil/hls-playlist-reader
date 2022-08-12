import type { ReadableOptions } from 'stream';
import type { MediaPlaylist, MasterPlaylist } from 'm3u8parse';

import { URL } from 'url';

import { BaseEvents, TypedEmitter, TypedReadable } from './raw/typed-readable';
import { HlsPlaylistFetcher, HlsPlaylistFetcherOptions, PlaylistObject } from './fetcher';


const HlsPlaylistReaderEvents = <IHlsPlaylistReaderEvents & BaseEvents>(null as any);
interface IHlsPlaylistReaderEvents {
    problem(err: Readonly<Error>): void;
}

/**
 * Reads an HLS media playlist, and emits updates.
 * Live & Event playlists are refreshed as needed, and expired segments are dropped when backpressure is applied.
 */
export class HlsPlaylistReader extends TypedEmitter(HlsPlaylistReaderEvents, TypedReadable<Readonly<PlaylistObject>>()) {

    fetch?: HlsPlaylistFetcher;

    index?: Readonly<MasterPlaylist | MediaPlaylist>;

    constructor(uri: URL | string, options: Omit<HlsPlaylistFetcherOptions, 'onProblem'> = {}) {

        super({ objectMode: true, highWaterMark: 0, autoDestroy: true, emitClose: true } as ReadableOptions);

        this.fetch = new HlsPlaylistFetcher(uri, { ...options, onProblem: (err) => this.emit('problem', err) });

        // Pre-fetch the initial index

        this.fetch.index().catch(this.destroy.bind(this));
    }

    // Overrides

    _read(): void {

        const fetcher = this.index ? this.fetch!.update() : this.fetch!.index();

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
