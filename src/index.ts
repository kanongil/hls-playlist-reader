import type { HlsPlaylistReaderOptions } from './playlist-reader.js';

import { HlsPlaylistReader } from './playlist-reader.js';

const createReader = function (uri: URL | string, options?: HlsPlaylistReaderOptions): HlsPlaylistReader {

    return new HlsPlaylistReader(uri, options);
};

export { createReader, HlsPlaylistReader };
export { HlsPlaylistFetcher } from './fetcher.js';
export type { HlsPlaylistReaderOptions };
export type { HlsIndexMeta, HlsPlaylistFetcherOptions } from './fetcher.js';

export default createReader;
