import { HlsPlaylistReader, HlsPlaylistReaderOptions } from './playlist-reader';

const createReader = function (uri: string, options: HlsPlaylistReaderOptions = {}): HlsPlaylistReader {

    return new HlsPlaylistReader(uri, options);
};

export { createReader, HlsPlaylistReader };
export type { HlsPlaylistReaderOptions };
export type { HlsIndexMeta } from './playlist-reader';

export default createReader;
