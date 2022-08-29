/// <reference lib="dom" />

import { HlsPlaylistFetcher, HlsPlaylistFetcherOptions } from './fetcher.js';

export type HlsPlaylistReaderOptions = Omit<HlsPlaylistFetcherOptions, 'onProblem'> & {
    maxStallTime?: number;
};

class HlsPlaylistSource {

    stallAfterMs: number;

    fetch?: HlsPlaylistFetcher;

    constructor(fetcher: HlsPlaylistFetcher, options: { stallAfterMs: number }) {

        this.fetch = fetcher;
        this.stallAfterMs = options.stallAfterMs;
    }

    async start(controller: ReadableStreamDefaultController) {

        const res = await this.fetch!.index();
        controller.enqueue(res);

        if (!this.fetch!.canUpdate()) {
            controller.close();
        }
    }

    async pull(controller: ReadableStreamDefaultController) {

        const res = await this.fetch!.update();
        controller.enqueue(res);

        if (!this.fetch!.canUpdate()) {
            controller.close();
        }
    }

    cancel(/*reason: any*/) {

        this.fetch?.cancel();
        this.fetch = undefined;      // Unlink reference
    }
}


export class HlsPlaylistReadable extends ReadableStream {

    fetch: HlsPlaylistFetcher;

    constructor(uri: URL | string, options: HlsPlaylistReaderOptions = {}) {

        const source = new HlsPlaylistSource(
            new HlsPlaylistFetcher(uri, options), { stallAfterMs: options.maxStallTime ?? Infinity }
        );

        super(source, new CountQueuingStrategy({ highWaterMark: 0 }));

        this.fetch = source.fetch!;
    }
}
