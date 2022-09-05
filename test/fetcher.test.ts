import Fs from 'fs';
import Os from 'os';
import Path from 'path';
import Url from 'url';

import { expect } from '@hapi/code';
import { HlsPlaylistFetcher as HlsPlaylistFetcherBase } from '../lib/fetcher.js';
import { HlsPlaylistFetcher as HlsPlaylistFetcherNode } from '../lib/fetcher.node.js';
import { HlsPlaylistFetcher as HlsPlaylistFetcherWeb } from '../lib/fetcher.web.js';

import { provisionServer, ServerState, genIndex, UnprotectedPlaylistFetcher } from './_shared.js';
import { wait } from '@hapi/hoek';

const server = await provisionServer();
await server.start();

describe(`HlsPlaylistFetcher (base)`, () => {

    it('performFetch() throws when called', () => {

        const fetcher = new HlsPlaylistFetcherBase('data:') as HlsPlaylistFetcherBase & UnprotectedPlaylistFetcher;
        expect(() => {

            fetcher.performFetch();
        }).to.throw();
    });

    it('readFetchContent() throws when called', () => {

        const fetcher = new HlsPlaylistFetcherBase('data:') as HlsPlaylistFetcherBase & UnprotectedPlaylistFetcher;
        expect(() => {

            fetcher.readFetchContent();
        }).to.throw();
    });
});

const testMatrix = new Map(Object.entries({
    'node+file': { HlsPlaylistFetcher: HlsPlaylistFetcherNode, baseUrl: new URL('fixtures', import.meta.url).href },
    'node+http': { HlsPlaylistFetcher: HlsPlaylistFetcherNode, baseUrl: new URL('simple', server.info.uri).href },
    'web+http': { HlsPlaylistFetcher: HlsPlaylistFetcherWeb, baseUrl: new URL('simple', server.info.uri).href }
}));

if (typeof fetch !== 'function') {
    testMatrix.delete('web+http');
}

for (const [label, { HlsPlaylistFetcher, baseUrl }] of testMatrix) {
    // eslint-disable-next-line @typescript-eslint/no-loop-func
    describe(`HlsPlaylistFetcher (${label})`, () => {

        describe('constructor', () => {

            it('supports URL objects', () => {

                const url = server.info.uri + '/simple/500.m3u8';
                expect(new HlsPlaylistFetcher(new URL(url))).to.be.instanceOf(HlsPlaylistFetcher);
            });

            it('throws on missing uri option', () => {

                const createObject = () => {

                    return new (HlsPlaylistFetcher as any)();
                };

                expect(createObject).to.throw();
            });

            it('throws on invalid uri option', () => {

                const createObject = () => {

                    return new HlsPlaylistFetcher('asdf://test')
                        .index();    // Trigger initial fetch
                };

                expect(createObject).to.throw();
            });
        });

        describe('update()', () => {

            it('throws if called before index()', () => {

                const fetcher = new HlsPlaylistFetcher(`${baseUrl}/live.m3u8`);
                expect(() => fetcher.update()).to.throw('An initial index() must have been sucessfully fetched');
            });

            it('throws if called before index() returns', async () => {

                const fetcher = new HlsPlaylistFetcher(`${baseUrl}/live.m3u8`);
                const promise = fetcher.index();

                expect(() => fetcher.update()).to.throw('An initial index() must have been sucessfully fetched');

                await promise;
            });

            it('throws if called during an update()', async () => {

                const fetcher = new HlsPlaylistFetcher(`${baseUrl}/live.m3u8`);
                await fetcher.index();

                const promise = fetcher.update();
                expect(() => fetcher.update()).to.throw('An update is already being fetched');
                fetcher.cancel();
                await expect(promise).to.reject();
            });
        });

        describe('canUpdate()', () => {

            it('returns false before index() is received', async () => {

                const fetcher = new HlsPlaylistFetcher(`${baseUrl}/500.m3u8`);
                expect(fetcher.playlist).to.not.exist();
                expect(fetcher.canUpdate()).to.be.false();
                const promise = fetcher.index();
                expect(fetcher.canUpdate()).to.be.false();
                await promise;
            });

            it('returns false once a main index has been fetched', async () => {

                const fetcher = new HlsPlaylistFetcher(`${baseUrl}/index.m3u8`);
                await fetcher.index();
                expect(fetcher.canUpdate()).to.be.false();
            });

            it('returns false once a non-live media index has been fetched', async () => {

                const fetcher = new HlsPlaylistFetcher(`${baseUrl}/500.m3u8`);
                await fetcher.index();
                expect(fetcher.canUpdate()).to.be.false();
            });

            it('returns true once a live media index has been fetched', async () => {

                const fetcher = new HlsPlaylistFetcher(`${baseUrl}/live.m3u8`);
                await fetcher.index();
                expect(fetcher.canUpdate()).to.be.true();
            });

            it('returns false when a live media update has been cancelled', async () => {

                const fetcher = new HlsPlaylistFetcher(`${baseUrl}/live.m3u8`);
                await fetcher.index();

                expect(fetcher.canUpdate()).to.be.true();
                const promise = fetcher.update();
                expect(fetcher.canUpdate()).to.be.true();
                fetcher.cancel();
                expect(fetcher.canUpdate()).to.be.false();

                await expect(promise).to.reject('Index update was aborted');

                expect(fetcher.canUpdate()).to.be.false();
            });
        });

        describe('cancel()', () => {

            it('can be called more than once', () => {

                const fetcher = new HlsPlaylistFetcher(`${baseUrl}/live.m3u8`);

                fetcher.cancel();
                fetcher.cancel();
            });
        });
    });
}

describe(`HlsPlaylistFetcher (node+file)`, () => {

    it('handles a basic livestream', async () => {

        const state: ServerState = { firstMsn: 0, segmentCount: 10, targetDuration: 10 };

        const tmpDir = await Fs.promises.mkdtemp(await Fs.promises.realpath(Os.tmpdir()) + Path.sep);
        try {
            const tmpUrl = new URL('next.m3u8', Url.pathToFileURL(tmpDir + Path.sep));
            const indexUrl = new URL('index.m3u8', Url.pathToFileURL(tmpDir + Path.sep));
            await Fs.promises.writeFile(indexUrl, genIndex(state).toString(), 'utf-8');

            const fetcher = new HlsPlaylistFetcherNode(indexUrl.href);
            const playlists = [];

            const start = await fetcher.index();
            expect(start.index.master).to.be.false();
            expect(start.playlist!.index.media_sequence).to.equal(0);
            playlists.push(start);

            (async () => {

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

            await wait(10);

            while (fetcher.canUpdate()) {
                const obj = await fetcher.update();
                expect(obj.playlist!.index.media_sequence).to.equal(playlists.length);
                playlists.push(obj);
            }

            expect(playlists).to.have.length(6);
        }
        finally {
            await Fs.promises.rm(tmpDir, { recursive: true });
        }
    });
});

after(() => server.stop());
