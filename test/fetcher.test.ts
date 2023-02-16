import type { ContentFetcher as ContentFetcherNode } from '../lib/helpers.node.js';
import type { ContentFetcher as ContentFetcherWeb } from '../lib/helpers.web.js';

import { expect } from '@hapi/code';
import { HlsPlaylistFetcher as HlsPlaylistFetcherBase } from '../lib/fetcher.js';

import { provisionServer, hasFetch } from './_shared.js';


const server = await provisionServer();
await server.start();

type StreamTypes = typeof ContentFetcherNode['streamType'] | typeof ContentFetcherWeb['streamType'];

const testMatrix = new Map([
    ['node+file', { module: '../lib/fetcher.node.js', helpers: '../lib/helpers.node.js', baseUrl: new URL('fixtures', import.meta.url).href }],
    ['node+http', { module: '../lib/fetcher.node.js', helpers: '../lib/helpers.node.js', baseUrl: new URL('simple', server.info.uri).href }],
    ['web+http', { module: '../lib/fetcher.js', helpers: '../lib/helpers.web.js', baseUrl: new URL('simple', server.info.uri).href, skip: !hasFetch }]
]);

for (const [label, { module, helpers: helpers, baseUrl, skip }] of testMatrix) {

    // eslint-disable-next-line @typescript-eslint/no-loop-func
    describe(`HlsPlaylistFetcher (${label})`, () => {

        let HlsPlaylistFetcher: typeof HlsPlaylistFetcherBase<StreamTypes>;
        let ContentFetcher: typeof ContentFetcherNode | typeof ContentFetcherWeb;

        before(async function () {

            if (skip) {
                return this.skip();
            }

            HlsPlaylistFetcher = (await import(module)).HlsPlaylistFetcher;
            ContentFetcher = (await import(helpers)).ContentFetcher;
        });

        describe('constructor', () => {

            it('supports URL objects', () => {

                const url = server.info.uri + '/simple/500.m3u8';
                expect(new HlsPlaylistFetcher(new URL(url), new ContentFetcher())).to.be.instanceOf(HlsPlaylistFetcher);
            });

            it('throws on missing contentFetcher argument', () => {

                const url = server.info.uri + '/simple/500.m3u8';
                const createObject = () => {

                    return new (HlsPlaylistFetcher as any)(new URL(url));
                };

                expect(createObject).to.be.throw('Invalid or missing "fetcher" argument');
            });

            it('throws on bad contentFetcher argument', () => {

                const url = server.info.uri + '/simple/500.m3u8';
                const createObject = () => {

                    return new (HlsPlaylistFetcher as any)(new URL(url), ContentFetcher);
                };

                expect(createObject).to.be.throw('Invalid or missing "fetcher" argument');
            });

            it('throws on missing uri argument', () => {

                const createObject = () => {

                    return new (HlsPlaylistFetcher as any)();
                };

                expect(createObject).to.throw();
            });

            it('throws on invalid uri argument', () => {

                const createObject = () => {

                    return new HlsPlaylistFetcher('asdf://test', new ContentFetcher())
                        .index();    // Trigger initial fetch
                };

                expect(createObject).to.throw();
            });
        });

        describe('update()', () => {

            it('throws if called before index()', () => {

                const fetcher = new HlsPlaylistFetcher(`${baseUrl}/live.m3u8`, new ContentFetcher());
                expect(() => fetcher.update()).to.throw('An initial index() must have been sucessfully fetched');
            });

            it('throws if called before index() returns', async () => {

                const fetcher = new HlsPlaylistFetcher(`${baseUrl}/live.m3u8`, new ContentFetcher());
                const promise = fetcher.index();

                expect(() => fetcher.update()).to.throw('An initial index() must have been sucessfully fetched');

                await promise;
            });

            it('throws if called during an update()', async () => {

                const fetcher = new HlsPlaylistFetcher(`${baseUrl}/live.m3u8`, new ContentFetcher());
                await fetcher.index();

                const promise = fetcher.update();
                expect(() => fetcher.update()).to.throw('An update is already being fetched');
                fetcher.cancel();
                await expect(promise).to.reject();
            });
        });

        describe('canUpdate()', () => {

            it('returns false before index() is received', async () => {

                const fetcher = new HlsPlaylistFetcher(`${baseUrl}/500.m3u8`, new ContentFetcher());
                expect(fetcher.playlist).to.not.exist();
                expect(fetcher.canUpdate()).to.be.false();
                const promise = fetcher.index();
                expect(fetcher.canUpdate()).to.be.false();
                await promise;
            });

            it('returns false once a main index has been fetched', async () => {

                const fetcher = new HlsPlaylistFetcher(`${baseUrl}/index.m3u8`, new ContentFetcher());
                await fetcher.index();
                expect(fetcher.canUpdate()).to.be.false();
            });

            it('returns false once a non-live media index has been fetched', async () => {

                const fetcher = new HlsPlaylistFetcher(`${baseUrl}/500.m3u8`, new ContentFetcher());
                await fetcher.index();
                expect(fetcher.canUpdate()).to.be.false();
            });

            it('returns true once a live media index has been fetched', async () => {

                const fetcher = new HlsPlaylistFetcher(`${baseUrl}/live.m3u8`, new ContentFetcher());
                await fetcher.index();
                expect(fetcher.canUpdate()).to.be.true();
            });

            it('returns false when a live media update has been cancelled', async () => {

                const fetcher = new HlsPlaylistFetcher(`${baseUrl}/live.m3u8`, new ContentFetcher());
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

                const fetcher = new HlsPlaylistFetcher(`${baseUrl}/live.m3u8`, new ContentFetcher());

                fetcher.cancel();
                fetcher.cancel();
            });
        });

        describe('currentPlayoutDelay', () => {

            it('works', async () => {

                const fetcher = new HlsPlaylistFetcher(`${baseUrl}/500.m3u8`, new ContentFetcher());
                expect(fetcher.currentPlayoutDelay).to.be.undefined();

                const start = Date.now();
                const { playlist } = await fetcher.index();
                expect(playlist?.startDate).to.equal(new Date('2000-01-07T06:03:05.000Z'));
                expect(playlist?.endDate).to.equal(new Date('2000-01-07T06:03:12.760Z'));
                const delay = start - +playlist!.endDate!;
                expect(fetcher.currentPlayoutDelay).to.exist();
                expect(fetcher.currentPlayoutDelay! - delay).be.min(0).and.below(200);
            });
        });
    });
}

after(() => server.stop());
