import type { HlsPlaylistFetcherOptions } from './fetcher.js';
import type { HlsPlaylistReaderOptions } from './playlist-reader.js';

import { HlsPlaylistReadable } from './playlist-reader.js';

const isNodeRuntime = typeof process === 'object' && !!process.version;
const HlsPlaylistFetcher = (isNodeRuntime ? await import('./fetcher.node.js') : await import('./fetcher.js')).HlsPlaylistFetcher;
const ContentFetcher = (isNodeRuntime ? await import('./helpers.node.js') : await import('./helpers.web.js')).ContentFetcher;

const createReader = function (uri: URL | string, options?: HlsPlaylistFetcherOptions & HlsPlaylistReaderOptions): HlsPlaylistReadable {

    return new HlsPlaylistReadable(new HlsPlaylistFetcher<typeof ContentFetcher['streamType']>(uri, new ContentFetcher(), options), options);
};

export { createReader, HlsPlaylistReadable };
export type { HlsPlaylistFetcherOptions, HlsPlaylistReaderOptions };
export type { HlsIndexMeta } from './fetcher.js';

export default createReader;
