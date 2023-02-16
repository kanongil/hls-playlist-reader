import type { Boom } from '@hapi/boom';

import { HlsPlaylistFetcher as BasePlaylistFetcher } from './fetcher.js';
import { platformInit } from './helpers.node.js';

platformInit();

export * from './fetcher.js';

export class HlsPlaylistFetcher<TContentStream extends object> extends BasePlaylistFetcher<TContentStream> {

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
}
