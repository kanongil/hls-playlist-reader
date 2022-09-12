/// <reference lib="dom" />

import type { HlsPlaylistFetcher, PlaylistObject } from './fetcher.js';

import { HlsPlaylistSource } from './playlist-source.js';


export type HlsPlaylistReaderOptions = {
    maxStallTime?: number;
};

export class HlsPlaylistReadable extends ReadableStream<PlaylistObject> {

    fetch: HlsPlaylistFetcher;

    constructor(fetcher: HlsPlaylistFetcher, options: HlsPlaylistReaderOptions = {}) {

        const source = new HlsPlaylistSource<HlsPlaylistFetcher>(fetcher, { stallAfterMs: options.maxStallTime ?? Infinity });

        super(source, new CountQueuingStrategy({ highWaterMark: 0 }));

        this.fetch = source.fetch!;
    }

    /** @forbidden Method has been disabled. */
    tee(): any {

        throw new Error('tee() is not supported');
    }
}
