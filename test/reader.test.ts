

/* eslint-disable @typescript-eslint/no-loop-func */

import type { ContentFetcher as ContentFetcherNode } from '../lib/helpers.node.js';
import type { ContentFetcher as ContentFetcherWeb } from '../lib/helpers.web.js';

import Fs from 'fs';

import Boom from '@hapi/boom';
import { expect } from '@hapi/code';
import Hoek from '@hapi/hoek';
import { M3U8Playlist, MainPlaylist, MediaPlaylist, ParserError } from 'm3u8parse';

import * as Shared from './_shared.js';
import { createReader, HlsPlaylistReadable, HlsPlaylistReaderOptions } from '../lib/index.js';
import { HlsPlaylistFetcher, HlsPlaylistFetcherOptions, PlaylistObject } from '../lib/fetcher.node.js';


const expectCause = (err: any, match: string | RegExp): void => {

    expect(err).to.be.an.error();
    if (err.cause) {
        if (typeof match === 'string') {
            expect(err.cause).to.equal(match);
        }
        else {
            expect(err.cause).to.match(match);
        }
    }
    else {
        if (typeof match === 'string') {
            expect(err.message).to.equal(match);
        }
        else {
            expect(err.message).to.match(match);
        }
    }
};


type StreamTypes = typeof ContentFetcherNode['StreamProto'] | typeof ContentFetcherWeb['StreamProto'];

const testMatrix = new Map(Object.entries({
    'node': { helpers: '../lib/helpers.node.js' },
    'web': { helpers: '../lib/helpers.web.js', skip: !Shared.hasFetch }
}));


for (const [label, { helpers, skip }] of testMatrix) {
    describe(`HlsPlaylistReadable (${label})`, () => {

        let ContentFetcher: typeof ContentFetcherNode | typeof ContentFetcherWeb;

        before(async function () {

            if (skip) {
                return this.skip();
            }

            ContentFetcher = (await import(helpers)).ContentFetcher;
        });

        const readPlaylists = function<T extends M3U8Playlist = MediaPlaylist> (url: string, options?: HlsPlaylistFetcherOptions & HlsPlaylistReaderOptions): Promise<PlaylistObject<T>[]> {

            const fetcher = new HlsPlaylistFetcher<StreamTypes>(url, new ContentFetcher(), options);
            const r = new HlsPlaylistReadable(fetcher, options);
            const reader = r.getReader();
            const indexes: PlaylistObject<T>[] = [];

            return (async () => {

                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) {
                        return indexes;
                    }

                    indexes.push(value as any);
                }
            })();
        };

        const baseUrl = new URL('fixtures/', import.meta.url).href;

        let server: Awaited<ReturnType<typeof Shared.provisionServer>>;

        before(async () => {

            server = await Shared.provisionServer();
            return server.start();
        });

        after(() => {

            return server?.stop();
        });

        describe('constructor', () => {

            it('creates a valid object', async () => {

                const r = new HlsPlaylistReadable(new HlsPlaylistFetcher<StreamTypes>(server.info.uri + '/simple/500.m3u8', new ContentFetcher(), {
                    extensions: undefined
                }), {
                    maxStallTime: undefined
                });

                expect(r).to.be.instanceOf(HlsPlaylistReadable);

                await Hoek.wait(10);

                await r.cancel();
            });
        });

        it('can be created through helper', () => {

            const url = server.info.uri + '/simple/500.m3u8';
            expect(createReader(url)).to.be.instanceOf(HlsPlaylistReadable);
            expect(createReader(new URL(url))).to.be.instanceOf(HlsPlaylistReadable);
        });

        it('emits error on missing remote host', async () => {

            const promise = readPlaylists('http://does.not.exist/simple/500.m3u8');
            const err = await expect(promise).to.reject(Error);
            expectCause(err, /getaddrinfo ENOTFOUND does\.not\.exist/);
        });

        it('emits error for missing data', async () => {

            const promise = readPlaylists(`${server.info.uri}/notfound`);
            const err = await expect(promise).to.reject(Error);
            expectCause(err, /Not Found/);
        });

        it('emits error for http error responses', async () => {

            const promise = readPlaylists(`${server.info.uri}/error`);
            const err = await expect(promise).to.reject(Error);
            expectCause(err, /Internal Server Error/);
        });

        it('emits error on non-index responses', async () => {

            const promise = readPlaylists(`${server.info.uri}/simple/500.mp4`);
            const err = await expect(promise).to.reject(Error);
            expectCause(err, /Invalid MIME type/);
        });

        it('emits error on malformed index files', async () => {

            const promise = readPlaylists(`${server.info.uri}/simple/malformed.m3u8`);
            await expect(promise).to.reject(ParserError);
        });

        describe('master index', () => {

            it('stops after reading index', async () => {

                const playlists = await readPlaylists<MainPlaylist>(`${server.info.uri}/simple/index.m3u8`);
                expect(playlists).to.have.length(1);
                expect(playlists[0]).to.contain(['index', 'meta']);
                expect(playlists[0].playlist).to.be.undefined();

                const { index } = playlists[0];
                expect(index).to.exist();
                expect(index.master).to.be.true();
                expect(index.variants[0].uri).to.exist();
            });

            it('supports a data: url', async () => {

                const buf = await Fs.promises.readFile(new URL('index.m3u8', baseUrl));
                const playlists = await readPlaylists<MainPlaylist>('data:application/vnd.apple.mpegurl;base64,' + buf.toString('base64'));
                expect(playlists).to.have.length(1);
                expect(playlists[0]).to.contain(['index', 'meta']);
                expect(playlists[0].playlist).to.be.undefined();

                const { index } = playlists[0];
                expect(index).to.exist();
                expect(index.master).to.be.true();
                expect(index.variants[0].uri).to.exist();
            });
        });

        describe('on-demand index', () => {

            it('stops after reading index', async () => {

                const playlists = await readPlaylists(`${server.info.uri}/simple/500.m3u8`);
                expect(playlists).to.have.length(1);
                expect(playlists[0]).to.contain(['index', 'playlist', 'meta']);

                const { index, playlist } = playlists[0];
                expect(playlist).to.exist();
                expect(index).to.exist();
                expect(index.master).to.be.false();
                expect(index.segments[0].uri).to.exist();
            });

            it('supports a data: url', async () => {

                const buf = await Fs.promises.readFile(new URL('500.m3u8', baseUrl));
                const playlists = await readPlaylists('data:application/vnd.apple.mpegurl;base64,' + buf.toString('base64'));
                expect(playlists).to.have.length(1);
                expect(playlists[0]).to.contain(['index', 'playlist', 'meta']);

                const { index } = playlists[0];
                expect(index).to.exist();
                expect(index.master).to.be.false();
                expect(index.segments[0].uri).to.exist();
            });

            it('applies the extensions option', async () => {

                const extensions = {
                    '#EXT-MY-HEADER': false,
                    '#EXT-MY-SEGMENT-OK': true
                };

                const r = new HlsPlaylistReadable(new HlsPlaylistFetcher<StreamTypes>(`${server.info.uri}/simple/500.m3u8`, new ContentFetcher(), { extensions }));
                const playlists = [];

                for await (const obj of r) {
                    playlists.push(obj);
                }

                expect(playlists).to.have.length(1);

                const { index } = playlists[0];
                expect(index).to.exist();
                expect([...index.vendor!][0]).to.equal(['#EXT-MY-HEADER', 'hello']);
                expect([...(index as MediaPlaylist).segments[1].vendor!][0]).to.equal(['#EXT-MY-SEGMENT-OK', null]);
            });

            // handles all kinds of segment reference url
            // handles .m3u files
        });

        describe('live index', () => {

            const serverState = {} as { state: Shared.ServerState };
            let liveServer: Awaited<ReturnType<typeof Shared.provisionServer>>;

            const prepareLiveReader = function (readerOptions: HlsPlaylistFetcherOptions & HlsPlaylistReaderOptions = {}, state: Partial<Shared.ServerState> = {}): {
                reader: HlsPlaylistReadable;
                state: Shared.ServerState & {
                    error?: number;
                    jumped?: boolean;
                };
            } {

                const clonedOptions = { ...readerOptions };
                const fetcher = new HlsPlaylistFetcher<StreamTypes>(`${liveServer.info.uri}/live/live.m3u8`, new ContentFetcher(), clonedOptions);
                const reader = new HlsPlaylistReadable(fetcher, clonedOptions);
                const fetch = reader.fetch as any as Shared.UnprotectedPlaylistFetcher;
                const superFn = fetch.getUpdateInterval;
                fetch._intervals = [];
                fetch.getUpdateInterval = function (...args) {

                    this._intervals.push(superFn.call(this, ...args));
                    return undefined;
                };

                serverState.state = { firstMsn: 0, segmentCount: 10, targetDuration: 2, ...state };

                return { reader, state: serverState.state };
            };

            before(() => {

                liveServer = Shared.provisionLiveServer(serverState);
                return liveServer.start();
            });

            after(() => {

                return liveServer.stop();
            });

            it('handles a basic stream', async () => {

                const { reader, state } = prepareLiveReader();
                const playlists = [];

                for await (const obj of reader) {
                    const lastMsn = obj.playlist!.index.lastMsn();
                    expect(lastMsn).to.equal(playlists.length + 9);
                    playlists.push(obj);

                    state.firstMsn++;
                    if (state.firstMsn >= 5) {
                        state.firstMsn = 5;
                        state.ended = true;
                    }
                }

                expect(playlists).to.have.length(6);
            });

            it('rejects on a data: url', async () => {

                const state = serverState.state = { firstMsn: 0, segmentCount: 10, targetDuration: 10 };
                const buf = Buffer.from(Shared.genIndex(state).toString(), 'utf-8');
                const reader = new HlsPlaylistReadable(new HlsPlaylistFetcher<StreamTypes>('data:application/vnd.apple.mpegurl;base64,' + buf.toString('base64'), new ContentFetcher()));

                const playlists: PlaylistObject[] = [];
                await expect((async () => {

                    for await (const obj of reader) {
                        playlists.push(obj);
                    }
                })()).to.reject('data: uri cannot be updated');

                expect(playlists).to.have.length(1);
            });

            it('does not internally buffer (highWaterMark=0)', async () => {

                const { reader, state } = prepareLiveReader();

                let reads = 0;
                for await (const obj of reader) {
                    ++reads;
                    expect(obj).to.exist();
                    expect(1 + reader.fetch.updates - reads).to.equal(0);
                    await Hoek.wait(20);
                    expect(1 + reader.fetch.updates - reads).to.equal(0);

                    state.firstMsn++;
                    if (state.firstMsn >= 5) {
                        state.firstMsn = 5;
                        state.ended = true;
                    }
                }
            });

            it('can handle playlist starting with 0 segments', async () => {

                const { reader, state } = prepareLiveReader({}, { segmentCount: 0, index() {

                    const index = Shared.genIndex(state);
                    index.type = 'EVENT';

                    if (state.segmentCount === 5) {
                        state.ended = true;
                    }
                    else {
                        state.segmentCount++;
                    }

                    return index;
                } });

                const playlists = [];
                for await (const obj of reader) {
                    expect(obj.playlist!.index.lastMsn() + +obj.playlist!.index.ended).to.equal(playlists.length - 1);
                    playlists.push(obj);
                }

                expect(playlists).to.have.length(7);
            });

            it('handles a temporary server outage', async () => {

                const problems: Error[] = [];
                const { reader, state } = prepareLiveReader({ onProblem: problems.push.bind(problems) }, {
                    index() {

                        if (state.error === undefined && state.firstMsn === 5) {
                            state.error = 6;
                        }

                        if (state.error) {
                            --state.error;
                            ++state.firstMsn;
                            throw new Error('fail');
                        }

                        if (state.firstMsn === 20) {
                            state.ended = true;
                        }

                        const index = Shared.genIndex(state);

                        ++state.firstMsn;

                        return index;
                    }
                });

                const playlists = [];
                for await (const obj of reader) {
                    playlists.push(obj);
                }

                expect(playlists).to.have.length(15);
                expect(problems.length).to.be.greaterThan(0);
                expectCause(problems[0], 'Internal Server Error');
            });

            it('handles temporarily going back in time', async () => {

                const problems: Error[] = [];
                const { reader, state } = prepareLiveReader({ onProblem: problems.push.bind(problems) }, {
                    index() {

                        if (state.firstMsn >= 5) {
                            state.firstMsn = 5;
                            state.ended = true;
                        }

                        if (state.firstMsn === 2 && !state.jumped) {
                            state.jumped = true;
                            state.firstMsn = 0;
                        }

                        const index = Shared.genIndex(state);

                        ++state.firstMsn;

                        return index;
                    }
                });
                const playlists = [];

                for await (const obj of reader) {
                    playlists.push(obj);
                }

                expect(playlists).to.have.length(6);
                expect(problems).to.have.length(1);
                expectCause(problems[0], 'Rejected update from the past');
            });

            it('eventually goes back in time', async () => {

                const problems: Error[] = [];
                const { reader, state } = prepareLiveReader({ onProblem: problems.push.bind(problems) }, {
                    index() {

                        if (state.firstMsn >= 5) {
                            state.firstMsn = 5;
                            state.ended = true;
                        }

                        if (state.firstMsn === 4 && !state.jumped) {
                            state.jumped = true;
                            state.firstMsn = 0;
                        }

                        const index = Shared.genIndex(state);

                        ++state.firstMsn;

                        return index;
                    }
                });
                const playlists = [];

                for await (const obj of reader) {
                    playlists.push(obj);
                }

                expect(playlists).to.have.length(8);
                expect(problems).to.have.length(2);
                expectCause(problems[1], 'Rejected update from the past');
            });

            it('respects the maxStallTime option', async () => {

                const { reader } = prepareLiveReader({ maxStallTime: 50 }, { segmentCount: 1 });

                await expect((async () => {

                    for await (const obj of reader) {
                        expect(obj).to.exist();
                    }
                })()).to.reject(Error, /Index update stalled/);
            });

            it('errors thrown during "onProblem" handling are escalated', async () => {

                const problems: Error[] = [];
                const { reader, state } = prepareLiveReader({
                    onProblem(err) {

                        problems.push(err);
                        throw err;
                    }
                }, {
                    index() {

                        if (state.firstMsn === 5) {
                            throw Boom.internal();
                        }

                        const index = Shared.genIndex(state);

                        ++state.firstMsn;

                        return index;
                    }
                });

                const playlists: any[] = [];
                const err = await expect((async () => {

                    for await (const obj of reader) {
                        playlists.push(obj);
                    }
                })()).to.reject(Error);
                expectCause(err, 'Internal Server Error');

                expect(playlists).to.have.length(5);
                expect(problems).to.have.length(1);
                expect(problems[0]).to.shallow.equal(err);
            });

            // TODO: move
            describe('isRecoverableUpdateError()', () => {

                it('is called on index update errors', async () => {

                    const { reader, state } = prepareLiveReader({}, {
                        index() {

                            const { error } = state;
                            if (error) {
                                state.error!++;
                                switch (error) {
                                    case 1:
                                    case 2:
                                    case 3:
                                        throw Boom.notFound();
                                    case 4:
                                        throw Boom.serverUnavailable();
                                    case 5:
                                        throw Boom.unauthorized();
                                }
                            }
                            else if (state.firstMsn === 5) {
                                state.error = 1;
                                return '';
                            }

                            const index = Shared.genIndex(state);

                            ++state.firstMsn;

                            return index;
                        }
                    });

                    const errors: Error[] = [];
                    const orig = reader.fetch.isRecoverableUpdateError;
                    reader.fetch.isRecoverableUpdateError = function (err: Error) {

                        errors.push(err);
                        return orig.call(reader, err);
                    };

                    const playlists: any[] = [];
                    const err = await expect((async () => {

                        for await (const obj of reader) {
                            playlists.push(obj);
                        }
                    })()).to.reject(Error);
                    expectCause(err, 'Unauthorized');

                    expect(playlists).to.have.length(5);
                    expect(errors).to.have.length(4);            // Web stream fails due to missing fetch internal retries on 404
                    expectCause(errors[0], 'No line data');
                    expectCause(errors[1], 'Not Found');
                    expectCause(errors[2], 'Service Unavailable');
                    expect(errors[3]).to.shallow.equal(err);
                });
            });

            describe('with LL-HLS', () => {

                const prepareLlReader = function (readerOptions: HlsPlaylistFetcherOptions & HlsPlaylistReaderOptions = {}, state: Partial<Shared.LlIndexState>, indexGen: Shared.ServerState['index']) {

                    return prepareLiveReader({
                        lowLatency: true,
                        ...readerOptions
                    }, {
                        partIndex: 0,
                        partCount: 5,
                        index: indexGen,
                        ...state
                    });
                };

                const { genLlIndex } = Shared;

                it('handles a basic ll stream', async () => {

                    const { reader, state } = prepareLlReader({}, { partIndex: 4, end: { msn: 20, part: 3 } }, (query) => genLlIndex(query, state));

                    const playlists = [];
                    const expected = { msn: 10, parts: state.partIndex! };
                    for await (const obj of reader) {
                        const index = obj.playlist!.index;
                        expect(index.lastMsn(true)).to.equal(expected.msn);
                        expect(index.getSegment(index.lastMsn(true))!.parts!.length).to.equal(expected.parts);

                        ++expected.parts;
                        if (expected.parts > state.partCount!) {
                            ++expected.msn;
                            expected.parts = 1;
                        }

                        if (!index.ended) {
                            expect(reader.fetch.playlist!.preloadHints.part).to.exist();
                        }

                        playlists.push(obj);
                    }

                    expect(playlists).to.have.length(50);
                });

                it('ignores LL parts when lowLatency=false', async () => {

                    const { reader, state } = prepareLlReader({ lowLatency: false }, { partIndex: 4, end: { msn: 20, part: 3 } }, (query) => genLlIndex(query, state));

                    const playlists = [];
                    for await (const obj of reader) {
                        expect(reader.fetch.playlist!.preloadHints.part).to.not.exist();
                        playlists.push(obj);
                    }

                    expect(playlists.length).to.equal(13);
                });
            });

            // TODO: resilience??
        });
    });
}
