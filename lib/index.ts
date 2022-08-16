import type { URL } from 'url';
import type { HlsPlaylistReaderOptions } from './playlist-reader';

import { HlsPlaylistReader } from './playlist-reader';

const createReader = function (uri: URL | string, options?: HlsPlaylistReaderOptions): HlsPlaylistReader {

    return new HlsPlaylistReader(uri, options);
};

export { createReader, HlsPlaylistReader };
export { HlsPlaylistFetcher } from './fetcher';
export type { HlsPlaylistReaderOptions };
export type { HlsIndexMeta, HlsPlaylistFetcherOptions } from './fetcher';

export default createReader;
