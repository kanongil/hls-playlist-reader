import * as Fs from 'fs';
import * as Os from 'os';
import * as Path from 'path';
import { Stream } from 'stream';
import { URL, pathToFileURL } from 'url';

import { expect } from '@hapi/code';
import { ignore, wait } from '@hapi/hoek';
import * as Lab from '@hapi/lab';

import { Deferred, FsWatcher, performFetch } from '../lib/helpers';


// Test shortcuts

export const lab = Lab.script();
const { describe, it, before, after } = lab;


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

    it('can create unhandledRejection when independent=false', (flags: any) => {

        const unhandled = new Promise((resolve, reject) => {

            flags.onUnhandledRejection = reject;
        });

        return (async () => {

            const deferred = new Deferred(false);

            deferred.reject(new Error('fail'));
            await wait(1);
            await expect(deferred.promise).to.reject('fail');
            await expect(unhandled).to.reject('fail');
        })();
    });

    it('does not create unhandledRejection when independent=true', (flags: any) => {

        const unhandled = new Promise((resolve, reject) => {

            flags.onUnhandledRejection = reject;
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

describe('performFetch()', () => {

    it('fetches a file with metadata and stream', async () => {

        const url = pathToFileURL(Path.join(__dirname, 'fixtures', '500.m3u8')).href;
        const { stream, meta } = await performFetch(url);

        stream?.destroy();

        expect(stream).to.be.instanceof(Stream);
        expect(meta).to.contain({
            mime: 'application/vnd.apple.mpegurl',
            size: 416,
            url
        } as any);
        expect(meta.modified).to.be.instanceof(Date);
    });

    it('stream contains file data', async () => {

        const url = pathToFileURL(Path.join(__dirname, 'fixtures', '500.m3u8')).href;
        const { stream, meta } = await performFetch(url);

        let transferred = 0;
        for await (const chunk of stream!) {
            transferred += (chunk as Buffer).length;
        }

        expect(transferred).to.equal(meta.size);
    });

    it('can be aborted early', async () => {

        const url = pathToFileURL(Path.join(__dirname, 'fixtures', '500.m3u8')).href;
        const fetch = performFetch(url);

        fetch.abort();
        fetch.abort();   // Do another to verify it is handled

        await expect(fetch).to.reject('Fetch was aborted');
    });

    it('can be aborted late', async () => {

        const url = pathToFileURL(Path.join(__dirname, 'fixtures', '500.m3u8')).href;
        const fetch = performFetch(url);

        const { stream } = await fetch;

        const receive = async () => {

            for await (const {} of stream!) {}
        };

        const promise = receive();

        fetch.abort();

        await expect(promise).to.reject('Fetch was aborted');
    });

    it('supports "probe" option', async () => {

        const url = pathToFileURL(Path.join(__dirname, 'fixtures', '500.m3u8')).href;
        const { stream, meta } = await performFetch(url, { probe: true });

        expect(stream).to.not.exist();
        expect(meta).to.contain({
            mime: 'application/vnd.apple.mpegurl',
            size: 416,
            url
        } as any);
        expect(meta.modified).to.be.instanceof(Date);
    });

    it('supports late abort with "probe" option', async () => {

        const url = pathToFileURL(Path.join(__dirname, 'fixtures', '500.m3u8')).href;
        const fetch = performFetch(url, { probe: true });

        await fetch;

        fetch.abort();
    });

    it('supports "byterange" option', async () => {

        const url = pathToFileURL(Path.join(__dirname, 'fixtures', '500.m3u8')).href;
        const { stream, meta } = await performFetch(url, { byterange: { offset: 10, length: 2000 } });
        stream?.destroy();

        expect(stream).to.be.instanceof(Stream);
        expect(meta).to.contain({
            mime: 'application/vnd.apple.mpegurl',
            size: 406,
            url
        } as any);
        expect(meta.modified).to.be.instanceof(Date);
    });

    it('supports "byterange" option without "length"', async () => {

        const url = pathToFileURL(Path.join(__dirname, 'fixtures', '500.m3u8')).href;
        const { stream, meta } = await performFetch(url, { byterange: { offset: 400 } });
        stream?.destroy();

        expect(stream).to.be.instanceof(Stream);
        expect(meta).to.contain({
            mime: 'application/vnd.apple.mpegurl',
            size: 16,
            url
        } as any);
        expect(meta.modified).to.be.instanceof(Date);
    });

    it('supports https "blocking" option', async () => {

        const blocking = 'test';

        const fetches = [];
        try {
            for (let i = 0; i < 5; ++i) {
                fetches.push((async () => {

                    const { stream } = await performFetch('https://www.google.com', { blocking });

                    const ready = process.hrtime.bigint();
                    // eslint-disable-next-line @typescript-eslint/no-unused-vars
                    for await (const _ of stream!) {}
                    const completed = process.hrtime.bigint();

                    return { ready, completed };
                })());
            }

            await performFetch('https://www.google.com', { probe: true });
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
});

describe('FsWatcher', () => {

    let tmpDir: URL;

    const createWatcher = async function (uri: URL | string) {

        if (Os.platform() === 'darwin') {
            await wait(10); // macOS needs time to settle before starting the watcher...
        }

        const watcher = new FsWatcher(uri);
        if (Os.platform() === 'darwin') {
            await wait(10); // macOS needs time to setup the watcher...
        }

        return watcher;
    };

    before(async () => {

        const path = await Fs.promises.mkdtemp(await Fs.promises.realpath(Os.tmpdir()) + Path.sep) + Path.sep;
        tmpDir = pathToFileURL(path);
    });

    after(async () => {

        await Fs.promises.rm(tmpDir, { recursive: true });
    });

    describe('next()', () => {

        it('waits for file change', async () => {

            const fileUrl = new URL('file1', tmpDir);
            try {
                await Fs.promises.writeFile(fileUrl, '<run>1</run>', 'utf-8');

                const watcher = await createWatcher(fileUrl);
                const promise = watcher.next();
                expect(await Promise.race([promise, wait(1, 'waiting')])).to.equal('waiting');

                await Fs.promises.writeFile(fileUrl, '<run>2</run>', 'utf-8');

                expect(await promise).to.match(/change|rename/);
            }
            finally {
                await Fs.promises.unlink(fileUrl);
            }
        });

        it('immediately returns if changed before calling', async () => {

            const fileUrl = new URL('file1', tmpDir);
            try {
                await Fs.promises.writeFile(fileUrl, '<run>1</run>', 'utf-8');

                const watcher = await createWatcher(fileUrl);
                try {
                    await Fs.promises.writeFile(fileUrl, '<run>2</run>', 'utf-8');

                    const result = await watcher.next();
                    expect(result).to.match(/change|rename/);
                }
                finally {
                    watcher.close();
                }
            }
            finally {
                await Fs.promises.unlink(fileUrl);
            }
        });

        it('works without a file', async () => {

            const fileUrl = new URL('file1', tmpDir);
            const watcher = await createWatcher(fileUrl);
            try {
                const promise = watcher.next();

                expect(await Promise.race([promise, wait(1, 'waiting')])).to.equal('waiting');
                await Fs.promises.writeFile(fileUrl, '<run>1</run>', 'utf-8');
                expect(await promise).to.equal('rename');
                if (Os.platform() === 'linux') {
                    expect(await watcher.next()).to.equal('change');
                }
            }
            finally {
                watcher.close();
                await Fs.promises.unlink(fileUrl);
            }
        });

        it('works more than once', async () => {

            const fileUrl = new URL('file2', tmpDir);
            const watcher = await createWatcher(fileUrl);
            try {
                await Fs.promises.writeFile(fileUrl, '<run>1</run>', 'utf-8');
                expect(await watcher.next()).to.match(/change|rename/);
                await Fs.promises.writeFile(fileUrl, '<run>2</run>', 'utf-8');
                expect(await watcher.next()).to.match(/change|rename/);
                await Fs.promises.writeFile(fileUrl, '<run>3</run>', 'utf-8');
                expect(await watcher.next()).to.match(/change|rename/);
            }
            finally {
                watcher.close();
                await Fs.promises.unlink(fileUrl);
            }
        });

        it('works with deleted file', async () => {

            const fileUrl = new URL('file1', tmpDir);
            try {
                await Fs.promises.writeFile(fileUrl, '<run>1</run>', 'utf-8');

                const watcher = await createWatcher(fileUrl);
                try {
                    await Fs.promises.unlink(fileUrl);

                    expect(await watcher.next()).to.equal('rename');

                    await Fs.promises.writeFile(fileUrl, '<run>2</run>', 'utf-8');

                    expect(await watcher.next()).to.match(/change|rename/);
                }
                finally {
                    watcher.close();
                }
            }
            finally {
                await Fs.promises.unlink(fileUrl);
            }
        });

        it('waits for atomic file change', async () => {

            const fileUrl = new URL('file1', tmpDir);
            const tmpUrl = new URL('tmp', tmpDir);
            try {
                await Fs.promises.writeFile(fileUrl, '<run>1</run>', 'utf-8');

                const watcher = await createWatcher(fileUrl);
                try {
                    const promise = watcher.next();

                    await Fs.promises.writeFile(tmpUrl, '<run>2</run>', 'utf-8');

                    expect(await Promise.race([promise, wait(1, 'waiting')])).to.equal('waiting');

                    await Fs.promises.rename(tmpUrl, fileUrl);

                    expect(await promise).to.equal('rename');
                }
                finally {
                    watcher.close();
                }
            }
            finally {
                await Fs.promises.unlink(fileUrl);
            }
        });

        it('supports timeout', async () => {

            const fileUrl = new URL('file1', tmpDir);
            const watcher = await createWatcher(fileUrl);
            try {
                const promise = watcher.next(20);

                expect(await Promise.race([promise, wait(1, 'waiting')])).to.equal('waiting');
                await wait(25);
                expect(await Promise.race([promise, wait(1, 'waiting')])).to.equal('timeout');
            }
            finally {
                watcher.close();
            }
        });

        it('does not trigger for adjecent file changes', async () => {

            const fileUrl = new URL('file1', tmpDir);
            const adjUrl = new URL('file2', tmpDir);
            try {
                await Fs.promises.writeFile(fileUrl, '<run>1</run>', 'utf-8');
                await Fs.promises.writeFile(adjUrl, '<run>1</run>', 'utf-8');

                const watcher = await createWatcher(fileUrl);
                const promise = watcher.next();
                try {
                    expect(await Promise.race([promise, wait(1, 'waiting')])).to.equal('waiting');
                    await Fs.promises.writeFile(adjUrl, '<run>2</run>', 'utf-8');
                    expect(await Promise.race([promise, wait(1, 'waiting')])).to.equal('waiting');
                }
                finally {
                    watcher.close();
                }

                await expect(promise as Promise<any>).to.reject('closed');
            }
            finally {
                await Fs.promises.unlink(fileUrl);
                await Fs.promises.unlink(adjUrl);
            }
        });

        it('throws on errors', async () => {

            const fileUrl = new URL('file1', tmpDir);
            const watcher = new FsWatcher(fileUrl);
            try {
                const promise = watcher.next();

                // Fabricate an error

                (watcher as any)._watcher.emit('error', new Error('fail'));

                await expect(promise as Promise<any>).to.reject('fail');
                expect(() => watcher.next()).to.throw('fail');
            }
            finally {
                watcher.close();
            }
        });

        it('throws on errors while not called', () => {

            const fileUrl = new URL('file1', tmpDir);
            const watcher = new FsWatcher(fileUrl);
            try {
                // Fabricate an error

                (watcher as any)._watcher.emit('error', new Error('fail'));

                expect(() => watcher.next()).to.throw('fail');
            }
            finally {
                watcher.close();
            }
        });
    });

    describe('close()', () => {

        it('makes next() throw an error', async () => {

            const fileUrl = new URL('file1', tmpDir);
            const watcher = new FsWatcher(fileUrl);
            const promise = watcher.next();

            watcher.close();

            await expect(promise as Promise<any>).to.reject('closed');
            expect(() => watcher.next()).to.throw('closed');
        });

        it('does nothing if already closed', () => {

            const fileUrl = new URL('file1', tmpDir);
            const watcher = new FsWatcher(fileUrl);

            watcher.close();
            watcher.close();

            expect(() => watcher.next()).to.throw('closed');
        });
    });
});
