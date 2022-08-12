import { URL } from 'url';

import { HlsPlaylistReader, HlsPlaylistFetcherOptions } from './playlist-reader';

const createReader = function (uri: URL | string, options?: HlsPlaylistFetcherOptions): HlsPlaylistReader {

    return new HlsPlaylistReader(uri, options);
};

export { createReader, HlsPlaylistReader };
export type { HlsPlaylistFetcherOptions };
export type { HlsIndexMeta } from './playlist-reader';

export default createReader;
