import { expect } from '@hapi/code';
import { HlsPlaylistFetcher as HlsPlaylistFetcherBase } from '../lib/fetcher.js';

import { provisionServer, UnprotectedPlaylistFetcher, hasFetch } from './_shared.js';


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


const server = await provisionServer();
await server.start();

const testMatrix = new Map([
    ['node+file', { module: '../lib/fetcher.node.js', baseUrl: new URL('fixtures', import.meta.url).href }],
    ['node+http', { module: '../lib/fetcher.node.js', baseUrl: new URL('simple', server.info.uri).href }],
    ['web+http', { module: '../lib/fetcher.web.js', baseUrl: new URL('simple', server.info.uri).href, skip: !hasFetch }]
]);

for (const [label, { module, baseUrl, skip }] of testMatrix) {

    // eslint-disable-next-line @typescript-eslint/no-loop-func
    describe(`HlsPlaylistFetcher (${label})`, () => {

        let HlsPlaylistFetcher: typeof HlsPlaylistFetcherBase;

        before(async function () {

            if (skip) {
                return this.skip();
            }

            HlsPlaylistFetcher = (await import(module)).HlsPlaylistFetcher;
        });

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

after(() => server.stop());
