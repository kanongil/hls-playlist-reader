/* eslint-disable @typescript-eslint/no-loop-func */

import type { performFetch as performFetchNode } from '../lib/helpers.node.js';
import type { performFetch as performFetchWeb } from '../lib/helpers.web.js';

import { Readable } from 'stream';

import { expect } from '@hapi/code';
import { ignore, wait } from '@hapi/hoek';

import { AbortController, Deferred, FetchResult, IDownloadTracker, wait as waitI } from '../lib/helpers.js';

import { hasFetch, provisionServer, usesWebstreamPolyfill } from './_shared.js';

declare global {
    // Add AsyncIterator which is implemented by node.js
    interface ReadableStream<R = any> {
        [Symbol.asyncIterator](): AsyncIterator<R>;
    }
}

const server = await provisionServer();
await server.start();

const testMatrix = new Map(Object.entries({
    'node+file': { module: '../lib/helpers.node.js', Class: Readable, baseUrl: new URL('fixtures/', import.meta.url).href },
    'node+http': { module: '../lib/helpers.node.js', Class: Readable, baseUrl: new URL('simple/', server.info.uri).href },
    'web+http': { module: '../lib/helpers.web.js', Class: ReadableStream, baseUrl: new URL('simple/', server.info.uri).href, skip: usesWebstreamPolyfill || !hasFetch }
}));

for (const [label, { module, Class, baseUrl, skip }] of testMatrix) {

    describe(`performFetch (${label})`, () => {

        let performFetch: typeof performFetchNode | typeof performFetchWeb;
        let cancelFetch: (fetch: FetchResult<ReadableStream<Uint8Array> | Readable>, reason?: Error) => void;

        before(async function () {

            if (skip) {
                return this.skip();
            }

            performFetch = (await import(module)).performFetch;
            cancelFetch = (await import(module)).cancelFetch;
        });

        it('fetches a file with metadata and stream', async () => {

            const url = new URL('500.m3u8', baseUrl);
            const fetch = await performFetch(url);
            expect(fetch.stream).to.be.instanceof(Class);

            cancelFetch(fetch);

            expect(fetch.meta).to.contain({
                mime: 'application/vnd.apple.mpegurl',
                size: 416,
                url: url.href
            } as any);
            expect(fetch.meta.modified).to.be.instanceof(Date);
        });

        it('stream contains file data', async () => {

            const url = new URL('500.m3u8', baseUrl);
            const { stream, meta } = await performFetch(url);

            let transferred = 0;
            for await (const chunk of stream!) {
                transferred += (chunk as Buffer).length;
            }

            expect(transferred).to.equal(meta.size);
        });

        it('can be aborted early', async () => {

            const url = new URL('500.m3u8', baseUrl);
            const fetch = performFetch(url);

            fetch.abort();
            fetch.abort();   // Do another to verify it is handled

            await expect(fetch).to.reject(/was aborted/);
        });

        it('can be aborted late', async () => {

            const url = new URL('500.m3u8', baseUrl);
            const fetch = performFetch(url);

            const { stream } = await fetch;

            const receive = async () => {

                for await (const { } of stream!) { }
            };

            const promise = receive();

            fetch.abort();

            await expect(promise).to.reject(/was aborted/);
        });

        it('supports "probe" option', async () => {

            const url = new URL('500.m3u8', baseUrl);
            const { stream, meta } = await performFetch(url, { probe: true });

            expect(stream).to.not.exist();
            expect(meta).to.contain({
                mime: 'application/vnd.apple.mpegurl',
                size: 416,
                url: url.href
            } as any);
            expect(meta.modified).to.be.instanceof(Date);
        });

        it('supports late abort with "probe" option', async () => {

            const url = new URL('500.m3u8', baseUrl);
            const fetch = performFetch(url, { probe: true });

            await fetch;

            fetch.abort();
        });

        it('supports "byterange" option', async () => {

            const url = new URL('500.m3u8', baseUrl);
            const fetch = await performFetch(url, { byterange: { offset: 10, length: 2000 } });
            cancelFetch(fetch);

            expect(fetch.meta).to.contain({
                mime: 'application/vnd.apple.mpegurl',
                size: 406,
                url: url.href
            } as any);
            expect(fetch.meta.modified).to.be.instanceof(Date);
        });

        it('supports "byterange" option without "length"', async () => {

            const url = new URL('500.m3u8', baseUrl);
            const fetch = await performFetch(url, { byterange: { offset: 400 } });
            cancelFetch(fetch);

            expect(fetch.meta).to.contain({
                mime: 'application/vnd.apple.mpegurl',
                size: 16,
                url: url.href
            } as any);
            expect(fetch.meta.modified).to.be.instanceof(Date);
        });

        it('supports "timeout" option', async function () {

            if (!label.includes('http')) {
                return this.skip();
            }

            const url = new URL('../slow/500.m3u8', baseUrl);
            const err = await expect(performFetch(url, { timeout: 1, probe: true })).to.reject(Error);
            expect(err.name).to.equal('TimeoutError');
        });

        it('supports https "blocking" option', async function () {

            if (label !== 'node+http') {
                return this.skip();
            }

            const blocking = 'test';

            const fetches = [];
            try {
                for (let i = 0; i < 5; ++i) {
                    fetches.push((async () => {

                        const { stream } = await performFetch(new URL('https://www.google.com'), { blocking });

                        const ready = process.hrtime.bigint();
                        // eslint-disable-next-line @typescript-eslint/no-unused-vars
                        for await (const _ of stream!) { }
                        const completed = process.hrtime.bigint();

                        return { ready, completed };
                    })());
                }

                await performFetch(new URL('https://www.google.com'), { probe: true });
                const independentReady = process.hrtime.bigint();

                expect(fetches).to.have.length(5);
                const results = await Promise.all(fetches);

                let last = { completed: BigInt(0) };
                for (let i = 0; i < 5; ++i) {
                    expect(results[i].ready).to.be.greaterThan(last.completed);
                    expect(results[i].completed).to.be.greaterThan(results[i].ready);
                    last = results[i];
                }

                expect(independentReady).to.be.lessThan(results[4].completed);
            }
            finally {
                await Promise.all(fetches); // Don't leave unhandled promise rejections behind
            }
        });

        describe('supports "tracker" option', () => {

            const setupTracker = function () {

                const maybeFail = (part: string) => {

                    if (state.fail) {
                        delete state.fail;
                        throw new Error(`${part} failed`);
                    }
                };

                const state: { total?: number; started?: true; ended?: boolean; fail?: boolean } = {};
                const tracker: IDownloadTracker<typeof state> = {
                    start(uri, blocking) {

                        state.started = true;
                        delete state.ended;
                        state.total = undefined;

                        maybeFail('start');
                        return state;
                    },
                    advance(token, bytes) {

                        maybeFail('advance');
                        token.total = (token.total ?? 0) + bytes;
                    },
                    finish(token, err) {

                        token.ended = false;
                        maybeFail('finish');
                        token.ended = true;
                    }
                };

                return { state, tracker };
            };

            before(function () {

                if (label !== 'web+http') {
                    return this.skip();
                }
            });

            it('for regular requests', async () => {

                const { state, tracker } = setupTracker();

                const url = new URL('500.m3u8', baseUrl);
                const promise = performFetch(url, { tracker });
                expect(state).to.equal({ total: undefined, started: true });
                const { stream } = await promise;

                expect(state).to.equal({ total: 0, started: true });

                let transferred = 0;
                for await (const chunk of stream!) {
                    transferred += (chunk as Buffer).length;
                    expect(state).to.equal({ total: transferred, started: true });
                }

                await wait(0);
                expect(state).to.equal({ total: transferred, started: true, ended: true });
            });

            it('with "probe" option', async () => {

                const { state, tracker } = setupTracker();

                const url = new URL('500.m3u8', baseUrl);
                const promise = performFetch(url, { tracker, probe: true });
                expect(state).to.equal({ total: undefined, started: true });
                const { stream } = await promise;
                expect(stream).to.not.exist();

                await wait(0);
                expect(state).to.equal({ total: undefined, started: true, ended: true });
            });

            it('on request errors', async () => {

                const { state, tracker } = setupTracker();

                // 404
                {
                    const url = new URL('notFound.m3u8', baseUrl);
                    const promise = performFetch(url, { tracker });
                    expect(state).to.equal({ total: undefined, started: true });
                    await expect(promise).to.reject(Error, 'Fetch failed');
                    expect(state).to.equal({ total: undefined, started: true, ended: true });
                }

                // hard error
                if (label.includes('http')) {
                    const url = new URL('http://does.not.exist');
                    const promise = performFetch(url, { tracker });
                    expect(state).to.equal({ total: undefined, started: true });
                    await expect(promise).to.reject(Error);
                    expect(state).to.equal({ total: undefined, started: true, ended: true });
                }
            });

            it('on stream abort/disconnect', async () => {

                const { state, tracker } = setupTracker();

                const url = new URL('500.m3u8', baseUrl);
                const fetch = performFetch(url, { tracker });
                const { stream } = await fetch;

                expect(state).to.equal({ total: 0, started: true });
                fetch.abort();

                let transferred = 0;
                const err = await expect((async () => {

                    for await (const chunk of stream!) {
                        transferred += (chunk as Buffer).length;
                        expect(state).to.equal({ total: transferred, started: true, ended: true });
                    }
                })()).to.reject(Error);
                expect(err.name).to.equal('AbortError');
                expect(state).to.equal({ total: transferred, started: true, ended: true });
            });

            it('when it throws', async () => {

                const { state, tracker } = setupTracker();

                const url = new URL('500.m3u8', baseUrl);

                // Fail in start()
                state.fail = true;
                await expect(performFetch(url, { tracker })).to.reject(Error, 'start failed');

                // Fail in initial advance()
                {
                    const promise = performFetch(url, { tracker });
                    state.fail = true;
                    await expect(promise).to.not.reject();

                    let transferred = 0;
                    for await (const chunk of (await promise).stream!) {
                        transferred += (chunk as Buffer).length;
                    }

                    expect(transferred).to.equal(416);
                    await wait(0);
                    expect(state.ended).to.be.undefined();
                }

                // Fail in advance()
                {
                    const { stream } = await performFetch(url, { tracker });

                    state.fail = true;

                    let transferred = 0;
                    for await (const chunk of stream!) {
                        transferred += (chunk as Buffer).length;
                    }

                    expect(transferred).to.equal(416);
                    await wait(0);
                    expect(state.ended).to.be.undefined();
                }

                // Fail in finish()
                {
                    const { stream } = await performFetch(url, { tracker });

                    let transferred = 0;
                    for await (const chunk of stream!) {
                        transferred += (chunk as Buffer).length;
                    }

                    state.fail = true;

                    expect(transferred).to.equal(416);
                    expect(state.ended).to.be.undefined();
                    await wait(0);
                    expect(state.ended).to.be.false();
                }

                // Fail in finish() on request error
                if (label.includes('http')) {
                    const promise = performFetch(new URL('http://does.not.exist'), { tracker });
                    state.fail = true;
                    await expect(promise).to.reject(Error);
                    expect(state.ended).to.be.false();
                }

                // Fail in finish() on 404
                {
                    const promise = performFetch(new URL('notFound.m3u8', baseUrl), { tracker });
                    state.fail = true;
                    await expect(promise).to.reject(Error, 'Fetch failed');
                    expect(state.ended).to.be.false();
                }
            });
        });
    });
}

describe('Deferred()', () => {

    const savedEmit = process.emitWarning;

    before(() => {

        process.emitWarning = ignore;
    });

    after(() => {

        process.emitWarning = savedEmit;
    });

    it('resolves with deferred value (early)', async () => {

        const deferred = new Deferred();
        const val = {};

        deferred.resolve(val);
        expect(await deferred.promise).to.equal(val);
    });

    it('resolves with deferred value (late)', async () => {

        const deferred = new Deferred();
        const val = {};

        process.nextTick(() => deferred.resolve(val));
        expect(await deferred.promise).to.equal(val);
    });

    it('rejects with rejected value', async () => {

        const deferred = new Deferred();

        deferred.reject(new Error('fail'));
        await expect(deferred.promise).to.reject('fail');
    });

    it('can create unhandledRejection when independent=false', () => {

        const unhandled = new Promise((_resolve, reject) => {

            process.once('unhandledRejection', reject);
        });

        unhandled.catch(ignore);     // Don't trigger another unhandled rejection

        return (async () => {

            const deferred = new Deferred(false);

            deferred.reject(new Error('fail'));
            // Wait to allow unhandledRejection to trigger
            await wait(1);

            await expect(deferred.promise).to.reject('fail');
            await expect(unhandled).to.reject('fail');
        })();
    });

    it('does not create unhandledRejection when independent=true', () => {

        const unhandled = new Promise((_resolve, reject) => {

            process.once('unhandledRejection', reject);
        });

        return (async () => {

            const deferred = new Deferred(true);

            deferred.reject(new Error('fail'));
            await wait(1);
            await expect(deferred.promise).to.reject('fail');
            await Promise.race([unhandled, wait(1)]);
        })();
    });
});

describe('wait()', () => {

    it('can be cancelled', async () => {

        const ac = new AbortController();
        const promise = waitI(5000, { signal: ac.signal });
        ac.abort();
        await expect(promise).to.reject(/was aborted/);
    });

    it('can be cancelled early', async () => {

        const ac = new AbortController();
        ac.abort();
        await expect(waitI(5000, { signal: ac.signal })).to.reject(/was aborted/);
    });
});

after(() => server.stop());
