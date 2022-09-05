import type { HlsPlaylistFetcherOptions } from './fetcher.js';
import type { HlsPlaylistReaderOptions } from './playlist-reader.js';

import { HlsPlaylistReadable } from './playlist-reader.js';

const isNodeRuntime = typeof process === 'object' && !!process.version;
const HlsPlaylistFetcher = (isNodeRuntime ? await import('./fetcher.node.js') : await import('./fetcher.node.js')).HlsPlaylistFetcher;

const createReader = function (uri: URL | string, options?: HlsPlaylistFetcherOptions & HlsPlaylistReaderOptions): HlsPlaylistReadable {

    return new HlsPlaylistReadable(new HlsPlaylistFetcher(uri, options), options);
};

export { createReader, HlsPlaylistReadable };
export type { HlsPlaylistFetcherOptions, HlsPlaylistReaderOptions };
export type { HlsIndexMeta } from './fetcher.js';

export default createReader;
