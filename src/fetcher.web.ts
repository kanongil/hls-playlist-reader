import { HlsPlaylistFetcher as BasePlaylistFetcher } from './fetcher.js';
import { performFetch, readFetchData, FetchOptions } from './helpers.web.js';

export * from './fetcher.js';

export class HlsPlaylistFetcher extends BasePlaylistFetcher {

    isRecoverableUpdateError(err: unknown): boolean {

        let httpStatus: number | undefined;

        if (typeof (err as any).statusCode === 'number') {
            httpStatus = (err as any).statusCode;
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
