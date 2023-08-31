import Fs from 'fs';
import Os from 'os';
import Path from 'path';
import { pathToFileURL, URL } from 'url';

import assert from '@hapi/hoek/assert';
import { expect } from '@hapi/code';
import wait from '@hapi/hoek/wait';

import { ChangeWatcher } from '../lib/helpers.node.js';


describe('FsWatcher', () => {

    let tmpDir: URL;

    const createWatcher = async function (uri: URL) {

        if (Os.platform() === 'darwin') {
            await wait(20); // macOS needs time to settle before starting the watcher...
        }

        const watcher = ChangeWatcher.create(uri);
        assert(watcher);
        if (Os.platform() === 'darwin') {
            await wait(20); // macOS needs time to setup the watcher...
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
                await wait(40);
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
            const watcher = ChangeWatcher.create(fileUrl)!;
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
            const watcher = ChangeWatcher.create(fileUrl)!;
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
            const watcher = ChangeWatcher.create(fileUrl)!;
            const promise = watcher.next();

            watcher.close();

            await expect(promise as Promise<any>).to.reject('closed');
            expect(() => watcher.next()).to.throw('closed');
        });

        it('does nothing if already closed', () => {

            const fileUrl = new URL('file1', tmpDir);
            const watcher = ChangeWatcher.create(fileUrl)!;

            watcher.close();
            watcher.close();

            expect(() => watcher.next()).to.throw('closed');
        });
    });
});
