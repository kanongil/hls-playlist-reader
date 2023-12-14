import Fs from 'fs';
import Os from 'os';
import Path from 'path';
import Url, { URL } from 'url';

import { expect } from '@hapi/code';

import { HlsPlaylistFetcher as HlsPlaylistFetcherNode } from '../lib/fetcher.node.js';
import { ContentFetcher as ContentFetcherNode, wait } from '../lib/helpers.node.js';
import { ServerState, genIndex } from './_shared.js';


describe('HlsPlaylistFetcher (node+file)', () => {

    it('handles a basic livestream', async () => {

        const state: ServerState = { firstMsn: 0, segmentCount: 10, targetDuration: 10 };

        const tmpDir = await Fs.promises.mkdtemp(await Fs.promises.realpath(Os.tmpdir()) + Path.sep);
        try {
            const tmpUrl = new URL('next.m3u8', Url.pathToFileURL(tmpDir + Path.sep));
            const indexUrl = new URL('index.m3u8', Url.pathToFileURL(tmpDir + Path.sep));
            await Fs.promises.writeFile(indexUrl, genIndex(state).toString(), 'utf-8');

            const fetcher = new HlsPlaylistFetcherNode(indexUrl.href, new ContentFetcherNode());
            const playlists: unknown[] = [];

            const start = await fetcher.index();
            expect(start.index.master).to.be.false();
            expect(start.playlist!.index.media_sequence).to.equal(0);
            playlists.push(start);

            const writer = (async () => {

                while (!state.ended) {
                    state.firstMsn++;
                    if (state.firstMsn === 5) {
                        state.ended = true;
                    }

                    // Atomic write

                    await Fs.promises.writeFile(tmpUrl, genIndex(state).toString(), 'utf-8');
                    await Fs.promises.rename(tmpUrl, indexUrl);

                    await wait(50);
                }
            })();

            const reader = (async () => {

                await wait(10);

                while (fetcher.canUpdate()) {
                    const obj = await fetcher.update();
                    expect(obj.playlist!.index.media_sequence).to.equal(playlists.length);
                    playlists.push(obj);
                }
            })();

            await Promise.all([writer, reader]);

            expect(playlists).to.have.length(6);
        }
        finally {
            await Fs.promises.rm(tmpDir, { recursive: true });
        }
    });
});
