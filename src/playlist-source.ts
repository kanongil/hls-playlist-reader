import type { HlsPlaylistFetcher } from './fetcher.js';

export class HlsPlaylistSource<Fetcher extends HlsPlaylistFetcher<any>> {

    stallAfterMs: number;

    fetch?: Fetcher;

    constructor(fetcher: Fetcher, options: { stallAfterMs: number }) {

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

        const res = await this.fetch!.update({ timeout: this.stallAfterMs });
        controller.enqueue(res);

        if (!this.fetch!.canUpdate()) {
            controller.close();
        }
    }

    cancel(reason: any) {

        this.fetch?.cancel();
        this.fetch = undefined;      // Unlink reference
    }
}
