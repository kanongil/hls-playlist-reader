import type { HlsPlaylistFetcher, PlaylistObject } from './fetcher.js';

import { HlsPlaylistSource } from './playlist-source.js';


export type HlsPlaylistReaderOptions = {
    maxStallTime?: number;
};

export class HlsPlaylistReadable extends ReadableStream<PlaylistObject> {

    fetch: HlsPlaylistFetcher<any>;

    constructor(fetcher: HlsPlaylistFetcher<any>, options: HlsPlaylistReaderOptions = {}) {

        const source = new HlsPlaylistSource<HlsPlaylistFetcher<any>>(fetcher, { stallAfterMs: options.maxStallTime ?? Infinity });

        super(source, new CountQueuingStrategy({ highWaterMark: 0 }));

        this.fetch = source.fetch!;
    }

    /** @forbidden Method has been disabled. */
    tee(): any {

        throw new Error('tee() is not supported');
    }
}
