import type { URL } from 'url';
import type { HlsPlaylistFetcherOptions } from './fetcher';

import { HlsPlaylistReader } from './playlist-reader';

const createReader = function (uri: URL | string, options?: HlsPlaylistFetcherOptions): HlsPlaylistReader {

    return new HlsPlaylistReader(uri, options);
};

export { createReader, HlsPlaylistReader };
export type { HlsPlaylistFetcherOptions };
export type { HlsIndexMeta } from './fetcher';

export default createReader;
