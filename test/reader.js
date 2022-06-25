'use strict';

const Events = require('events');
const Fs = require('fs');
const Os = require('os');
const Path = require('path');
const Url = require('url');

const Boom = require('@hapi/boom');
const Code = require('@hapi/code');
const Hoek = require('@hapi/hoek');
const Lab = require('@hapi/lab');
const M3U8Parse = require('m3u8parse');

const Shared = require('./_shared');
const { createReader, HlsPlaylistReader } = require('..');
const { AttrList } = require('m3u8parse/lib/attrlist');


// Declare internals

const internals = {};


// Test shortcuts

const lab = exports.lab = Lab.script();
const { after, before, describe, it } = lab;
const { expect } = Code;


describe('HlsPlaylistReader()', () => {

    const readPlaylists = Shared.readSegments.bind(null, HlsPlaylistReader);
    let server;

    before(async () => {

        server = await Shared.provisionServer();
        return server.start();
    });

    after(() => {

        return server.stop();
    });

    describe('constructor', () => {

        it('creates a valid object', async () => {

            const r = new HlsPlaylistReader('http://localhost:' + server.info.port + '/simple/500.m3u8', {
                extensions: null,
                maxStallTime: null
            });
            const closed = Events.once(r, 'close');

            expect(r).to.be.instanceOf(HlsPlaylistReader);

            await Hoek.wait(10);

            r.destroy();

            await closed;
        });

        it('supports URL objects', () => {

            const url = 'http://localhost:' + server.info.port + '/simple/500.m3u8';
            expect(new HlsPlaylistReader(new URL(url)).destroy()).to.be.instanceOf(HlsPlaylistReader);
        });

        it('throws on missing uri option', () => {

            const createObject = () => {

                return new HlsPlaylistReader();
            };

            expect(createObject).to.throw();
        });

        it('throws on invalid uri option', () => {

            const createObject = () => {

                return new HlsPlaylistReader('asdf://test');
            };

            expect(createObject).to.throw();
        });
    });

    it('can be created through helper', () => {

        const url = 'http://localhost:' + server.info.port + '/simple/500.m3u8';
        expect(createReader(url).destroy()).to.be.instanceOf(HlsPlaylistReader);
        expect(createReader(new URL(url)).destroy()).to.be.instanceOf(HlsPlaylistReader);
    });

    it('emits error on missing remote host', async () => {

        const promise = readPlaylists('http://does.not.exist/simple/500.m3u8');
        await expect(promise).to.reject(Error, /getaddrinfo ENOTFOUND does\.not\.exist/);
    });

    it('emits error for missing data', async () => {

        const promise = readPlaylists(`http://localhost:${server.info.port}/notfound`);
        await expect(promise).to.reject(Error, /Not Found/);
    });

    it('emits error for http error responses', async () => {

        const promise = readPlaylists(`http://localhost:${server.info.port}/error`);
        await expect(promise).to.reject(Error, /Internal Server Error/);
    });

    it('emits error on non-index responses', async () => {

        const promise = readPlaylists(`http://localhost:${server.info.port}/simple/500.mp4`);
        await expect(promise).to.reject(Error, /Invalid MIME type/);
    });

    it('emits error on malformed index files', async () => {

        const promise = readPlaylists(`http://localhost:${server.info.port}/simple/malformed.m3u8`);
        await expect(promise).to.reject(M3U8Parse.ParserError);
    });

    describe('canUpdate()', () => {

        it('returns true before index is received', () => {

            const reader = new HlsPlaylistReader('http://localhost:' + server.info.port + '/simple/500.m3u8');
            expect(reader.index).to.not.exist();
            expect(reader.canUpdate()).to.be.true();
            reader.destroy();
        });

        it('returns false when destroyed', () => {

            const reader = new HlsPlaylistReader('http://localhost:' + server.info.port + '/simple/500.m3u8');
            reader.destroy();
            expect(reader.index).to.not.exist();
            expect(reader.canUpdate()).to.be.false();
        });
    });

    describe('master index', () => {

        it('stops after reading index', async () => {

            const playlists = await readPlaylists(`http://localhost:${server.info.port}/simple/index.m3u8`);
            expect(playlists).to.have.length(1);
            expect(playlists[0]).to.contain(['index', 'playlist', 'meta']);
            expect(playlists[0].playlist).to.not.exist();

            const { index } = playlists[0];
            expect(index).to.exist();
            expect(index.master).to.be.true();
            expect(index.variants[0].uri).to.exist();
        });

        it('supports a data: url', async () => {

            const buf = await Fs.promises.readFile(Path.join(__dirname, 'fixtures', 'index.m3u8'));
            const playlists = await readPlaylists('data:application/vnd.apple.mpegurl;base64,' + buf.toString('base64'));
            expect(playlists).to.have.length(1);
            expect(playlists[0]).to.contain(['index', 'playlist', 'meta']);
            expect(playlists[0].playlist).to.not.exist();

            const { index } = playlists[0];
            expect(index).to.exist();
            expect(index.master).to.be.true();
            expect(index.variants[0].uri).to.exist();
        });
    });

    describe('on-demand index', () => {

        it('stops after reading index', async () => {

            const playlists = await readPlaylists(`http://localhost:${server.info.port}/simple/500.m3u8`);
            expect(playlists).to.have.length(1);
            expect(playlists[0]).to.contain(['index', 'playlist', 'meta']);

            const { index } = playlists[0];
            expect(index).to.exist();
            expect(index.master).to.be.false();
            expect(index.segments[0].uri).to.exist();
        });

        it('supports a data: url', async () => {

            const buf = await Fs.promises.readFile(Path.join(__dirname, 'fixtures', '500.m3u8'));
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

            const r = new HlsPlaylistReader('file://' + Path.join(__dirname, 'fixtures', '500.m3u8'), { extensions });
            const playlists = [];

            for await (const obj of r) {
                playlists.push(obj);
            }

            expect(playlists).to.have.length(1);

            const { index } = playlists[0];
            expect(index).to.exist();
            expect(index.vendor[0]).to.equal(['#EXT-MY-HEADER', 'hello']);
            expect(index.segments[1].vendor[0]).to.equal(['#EXT-MY-SEGMENT-OK', null]);
        });

        it('can be destroyed', async () => {

            const r = new HlsPlaylistReader('file://' + Path.join(__dirname, 'fixtures', '500.m3u8'));
            const playlists = [];

            for await (const obj of r) {
                playlists.push(obj);
                r.destroy();
            }

            expect(playlists).to.have.length(1);
        });

        it('can be destroyed before read()', async () => {

            const r = new HlsPlaylistReader('file://' + Path.join(__dirname, 'fixtures', '500.m3u8'));
            const playlists = [];

            while (!r.playlist) {
                await Hoek.wait(1);
            }

            r.destroy(new Error('aborted'));

            await expect((async () => {

                for await (const obj of r) {
                    playlists.push(obj);
                }
            })()).to.reject('aborted');

            expect(playlists).to.have.length(0);
        });

        // handles all kinds of segment reference url
        // handles .m3u files
    });

    describe('live index', { parallel: false }, () => {

        const serverState = { state: {} };
        let liveServer;

        const prepareLiveReader = function (readerOptions = {}, state = {}) {

            const reader = new HlsPlaylistReader(`http://localhost:${liveServer.info.port}/live/live.m3u8`, { ...readerOptions });
            reader._intervals = [];
            reader.getUpdateInterval = function (updated) {

                this._intervals.push(HlsPlaylistReader.prototype.getUpdateInterval.call(this, updated));
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

        it('handles a basic stream (http)', async () => {

            const { reader, state } = prepareLiveReader();
            const playlists = [];

            for await (const obj of reader) {
                const lastMsn = obj.playlist.index.lastMsn();
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

        it('handles a basic stream (file)', async () => {

            const state = serverState.state = { firstMsn: 0, segmentCount: 10, targetDuration: 10 };

            const tmpDir = await Fs.promises.mkdtemp(await Fs.promises.realpath(Os.tmpdir()) + Path.sep);
            try {
                const tmpUrl = new URL('next.m3u8', Url.pathToFileURL(tmpDir + Path.sep));
                const indexUrl = new URL('index.m3u8', Url.pathToFileURL(tmpDir + Path.sep));
                await Fs.promises.writeFile(indexUrl, Shared.genIndex(state).toString(), 'utf-8');

                const reader = new HlsPlaylistReader(indexUrl.href);
                const playlists = [];

                (async () => {

                    while (!state.ended) {
                        await Hoek.wait(50);

                        state.firstMsn++;
                        if (state.firstMsn === 5) {
                            state.ended = true;
                        }

                        // Atomic write

                        await Fs.promises.writeFile(tmpUrl, Shared.genIndex(state).toString(), 'utf-8');
                        await Fs.promises.rename(tmpUrl, indexUrl);
                    }
                })();

                for await (const obj of reader) {
                    expect(obj.playlist.index.media_sequence).to.equal(playlists.length);
                    playlists.push(obj);
                }

                expect(playlists).to.have.length(6);
            }
            finally {
                await Fs.promises.rm(tmpDir, { recursive: true });
            }
        });

        it('emits "error" on a data: url', async () => {

            const state = serverState.state = { firstMsn: 0, segmentCount: 10, targetDuration: 10 };
            const buf = Buffer.from(Shared.genIndex(state).toString(), 'utf-8');
            const reader = new HlsPlaylistReader('data:application/vnd.apple.mpegurl;base64,' + buf.toString('base64'));

            const playlists = [];
            await expect((async () => {

                for await (const obj of reader) {
                    playlists.push(obj);
                }
            })()).to.reject('data: uri cannot be updated');

            expect(playlists).to.have.length(1);
        });

        it('does not internally buffer (highWaterMark=0)', async () => {

            const { reader, state } = prepareLiveReader();

            for await (const obj of reader) {
                expect(obj).to.exist();
                await Hoek.wait(20);
                expect(reader.readableBuffer).to.have.length(0);

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
                expect(obj.playlist.index.lastMsn() + obj.playlist.index.ended).to.equal(playlists.length - 1);
                playlists.push(obj);
            }

            expect(playlists).to.have.length(7);
        });

        it('emits "close" event when destroyed without consuming', async () => {

            const { reader } = prepareLiveReader();

            const closeEvent = Events.once(reader, 'close');

            while (!reader.playlist) {
                await Hoek.wait(1);
            }

            reader.destroy();
            await closeEvent;
        });

        it('handles a temporary server outage', async () => {

            const { reader, state } = prepareLiveReader({}, {
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

            const errors = [];
            reader.on('problem', errors.push.bind(errors));

            const playlists = [];
            for await (const obj of reader) {
                playlists.push(obj);
            }

            expect(playlists).to.have.length(15);
            expect(errors.length).to.be.greaterThan(0);
            expect(errors[0]).to.be.an.error('Internal Server Error');
        });

        it('handles temporarily going back in time', async () => {

            const { reader, state } = prepareLiveReader({}, {
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
            const problems = [];

            reader.on('problem', (err) => problems.push(err));

            for await (const obj of reader) {
                playlists.push(obj);
            }

            expect(playlists).to.have.length(6);
            expect(problems).to.have.length(1);
            expect(problems[0]).to.be.an.error('Rejected update from the past');
        });

        it('eventually goes back in time', async () => {

            const { reader, state } = prepareLiveReader({}, {
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
            const problems = [];

            reader.on('problem', (err) => problems.push(err));

            for await (const obj of reader) {
                playlists.push(obj);
            }

            expect(playlists).to.have.length(8);
            expect(problems).to.have.length(2);
            expect(problems[1]).to.be.an.error('Rejected update from the past');
        });

        it('respects the maxStallTime option', async () => {

            const { reader } = prepareLiveReader({ maxStallTime: 50 }, { segmentCount: 1 });

            await expect((async () => {

                for await (const obj of reader) {

                    expect(obj).to.exist();
                }
            })()).to.reject(Error, /Index update stalled/);
        });

        it('errors thrown during "problem" event handler are escalated', async () => {

            const { reader, state } = prepareLiveReader({}, {
                index() {

                    if (state.firstMsn === 5) {
                        throw Boom.internal();
                    }

                    const index = Shared.genIndex(state);

                    ++state.firstMsn;

                    return index;
                }
            });

            const problems = [];
            reader.on('problem', (err) => {

                problems.push(err);
                throw err;
            });

            const playlists = [];
            const err = await expect((async () => {

                for await (const obj of reader) {
                    playlists.push(obj);
                }
            })()).to.reject('Internal Server Error');

            expect(playlists).to.have.length(5);
            expect(problems).to.have.length(1);
            expect(problems[0]).to.shallow.equal(err);
        });

        describe('destroy()', () => {

            it('works when called while waiting for an update', async () => {

                const { reader, state } = prepareLiveReader({ fullStream: false }, {
                    async index() {

                        if (state.firstMsn > 0) {
                            await Hoek.wait(100);
                        }

                        return Shared.genIndex(state);
                    }
                });

                setTimeout(() => reader.destroy(new Error('aborted')), 50);

                const playlists = [];
                await expect((async () => {

                    for await (const obj of reader) {
                        playlists.push(obj);

                        state.firstMsn++;
                    }
                })()).to.reject('aborted');

                expect(playlists).to.have.length(1);
            });

            it('emits passed error', async () => {

                const { reader, state } = prepareLiveReader({ fullStream: false }, {
                    async index() {

                        if (state.firstMsn > 0) {
                            await Hoek.wait(10);
                        }

                        return Shared.genIndex(state);
                    }
                });

                setTimeout(() => reader.destroy(new Error('destroyed')), 50);

                await expect((async () => {

                    for await (const {} of reader) {
                        state.firstMsn++;
                    }
                })()).to.reject('destroyed');
            });
        });

        // TODO: move
        describe('isRecoverableUpdateError()', () => {

            it('is called on index update errors', async () => {

                const { reader, state } = prepareLiveReader({}, {
                    index() {

                        const { error } = state;
                        if (error) {
                            state.error++;
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

                const errors = [];
                reader.isRecoverableUpdateError = function (err) {

                    errors.push(err);
                    return HlsPlaylistReader.prototype.isRecoverableUpdateError.call(reader, err);
                };

                const playlists = [];
                const err = await expect((async () => {

                    for await (const obj of reader) {
                        playlists.push(obj);
                    }
                })()).to.reject('Unauthorized');

                expect(playlists).to.have.length(5);
                expect(errors).to.have.length(4);
                expect(errors[0]).to.have.error(M3U8Parse.ParserError, 'Missing required #EXTM3U header');
                expect(errors[1]).to.have.error(Boom.Boom, 'Not Found');
                expect(errors[2]).to.have.error(Boom.Boom, 'Service Unavailable');
                expect(errors[3]).to.shallow.equal(err);
            });
        });

        describe('with LL-HLS', () => {

            const prepareLlReader = function (readerOptions = {}, state = {}, indexGen) {

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

            it('handles a basic stream', async () => {

                const { reader, state } = prepareLlReader({}, { partIndex: 4, end: { msn: 20, part: 3 } }, (query) => genLlIndex(query, state));

                const playlists = [];
                const expected = { msn: 10, parts: state.partIndex };
                for await (const obj of reader) {
                    const index = obj.playlist.index;
                    expect(index.lastMsn(true)).to.equal(expected.msn);
                    expect(index.getSegment(index.lastMsn(true)).parts.length).to.equal(expected.parts);

                    ++expected.parts;
                    if (expected.parts > state.partCount) {
                        ++expected.msn;
                        expected.parts = 1;
                    }

                    if (!index.ended) {
                        expect(reader.hints.part).to.exist();
                    }

                    playlists.push(obj);
                }

                expect(playlists).to.have.length(50);
                expect(reader.hints.part).to.not.exist();
            });

            it('ignores LL parts when lowLatency=false', async () => {

                const { reader, state } = prepareLlReader({ lowLatency: false }, { partIndex: 4, end: { msn: 20, part: 3 } }, (query) => genLlIndex(query, state));

                const playlists = [];
                for await (const obj of reader) {
                    expect(reader.hints.part).to.not.exist();
                    playlists.push(obj);
                }

                expect(playlists.length).to.equal(13);
            });

            it('handles weird hint changes (or no change)', async () => {

                const hints = new Set();
                const { reader, state } = prepareLlReader({}, { partIndex: 4, end: { msn: 15, part: 3 } }, (query) => {

                    const index = genLlIndex(query, state);

                    let hint;

                    if (state.partIndex === 1 || state.partIndex === 2) {
                        hint = new AttrList({ type: 'PART', uri: '"a"' });
                    }
                    else if (state.partIndex === 3) {
                        hint = new AttrList({ type: 'PART', uri: '"a"', 'byterange-start': '0' });
                    }
                    else if (state.partIndex === 4) {
                        hint = new AttrList({ type: 'PART', uri: '"a"', 'byterange-start': '0', 'byterange-length': '10' });
                    }

                    index.meta.preload_hints = hint ? [hint] : undefined;

                    return index;
                });

                const playlists = [];
                for await (const obj of reader) {
                    playlists.push(obj);
                    hints.add(reader.hints);
                }

                expect(playlists).to.have.length(25);
                expect(hints.size).to.equal(19);
            });
        });

        // TODO: resilience??
    });
});
