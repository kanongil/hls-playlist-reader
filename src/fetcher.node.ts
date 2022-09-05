import type { Boom } from '@hapi/boom';

import { HlsPlaylistFetcher as BasePlaylistFetcher } from './fetcher.js';
import { performFetch, readFetchData, FetchOptions, platformInit } from './helpers.node.js';

platformInit();

export * from './fetcher.js';

export class HlsPlaylistFetcher extends BasePlaylistFetcher {

    isRecoverableUpdateError(err: unknown): boolean {

        if ((err as any).syscall) {      // Any syscall error
            return true;
        }

        let httpStatus: number | undefined;
        if ((err as Boom).isBoom) {
            httpStatus = (err as Boom).output.statusCode;
        }

        return super.isRecoverableUpdateError(err, httpStatus);
    }

    protected performFetch(url: URL, options?: FetchOptions): ReturnType<typeof performFetch> {

        return performFetch(url, options);
    }

    protected readFetchContent(fetch: Awaited<ReturnType<typeof performFetch>>): Promise<string> {

        return readFetchData(fetch);
    }
}
