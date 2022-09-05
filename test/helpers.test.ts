/* eslint-disable @typescript-eslint/no-loop-func */

import { Readable, Stream } from 'stream';

import { expect } from '@hapi/code';
import { ignore, wait } from '@hapi/hoek';

import { AbortController, Deferred, wait as waitI } from '../lib/helpers.js';
import { performFetch as performFetchNode } from '../lib/helpers.node.js';
const performFetchWeb = (typeof fetch === 'function') ? (await import('../lib/helpers.web.js')).performFetch : performFetchNode;   // Only load when fetch() is available

import { provisionServer } from './_shared.js';

declare global {
    // Add AsyncIterator which is implemented by node.js
    interface ReadableStream<R = any> {
        [Symbol.asyncIterator](): AsyncIterator<R>;
    }
}

const server = await provisionServer();
await server.start();

const testMatrix = new Map(Object.entries({
    'node+file': { performFetch: performFetchNode, Class: Readable, baseUrl: new URL('fixtures/', import.meta.url).href },
    'node+http': { performFetch: performFetchNode, Class: Readable, baseUrl: new URL('simple/', server.info.uri).href },
    'web+http': { performFetch: performFetchWeb, Class: ReadableStream, baseUrl: new URL('simple/', server.info.uri).href }
}));

if (typeof fetch !== 'function') {
    testMatrix.delete('web+http');
}

for (const [label, { performFetch, Class, baseUrl }] of testMatrix) {

    const destroy = (stream?: InstanceType<typeof Class>): void => {

        stream instanceof Stream ? stream.destroy() : stream?.cancel();
    };

    describe(`performFetch (${label})`, () => {

        it('fetches a file with metadata and stream', async () => {

            const url = new URL('500.m3u8', baseUrl);
            const { stream, meta } = await performFetch(url);

            destroy(stream);

            //expect(stream).to.be.instanceof(Class);
            expect(meta).to.contain({
                mime: 'application/vnd.apple.mpegurl',
                size: 416,
                url: url.href
            } as any);
            expect(meta.modified).to.be.instanceof(Date);
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
            const { stream, meta } = await performFetch(url, { byterange: { offset: 10, length: 2000 } });
            destroy(stream);

            expect(meta).to.contain({
                mime: 'application/vnd.apple.mpegurl',
                size: 406,
                url: url.href
            } as any);
            expect(meta.modified).to.be.instanceof(Date);
        });

        it('supports "byterange" option without "length"', async () => {

            const url = new URL('500.m3u8', baseUrl);
            const { stream, meta } = await performFetch(url, { byterange: { offset: 400 } });
            destroy(stream);

            expect(meta).to.contain({
                mime: 'application/vnd.apple.mpegurl',
                size: 16,
                url: url.href
            } as any);
            expect(meta.modified).to.be.instanceof(Date);
        });

        if (label.includes('http')) {
            it('supports "timeout" option', async () => {

                const url = new URL('../slow/500.m3u8', baseUrl);
                const err = await expect(performFetch(url, { timeout: 1, probe: true })).to.reject(Error);
                expect(err.name).to.equal('TimeoutError');
            });

            label.includes('node') &&
            it('supports https "blocking" option', async () => {

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
        }
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
