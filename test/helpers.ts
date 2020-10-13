import * as Fs from 'fs';
import * as Os from 'os';
import * as Path from 'path';
import { URL, pathToFileURL } from 'url';

import { expect } from '@hapi/code';
import { wait } from '@hapi/hoek';
import * as Lab from '@hapi/lab';

import { FsWatcher } from '../lib/helpers';


// Test shortcuts

export const lab = Lab.script();
const { describe, it, before, after } = lab;


describe('FsWatcher', () => {

    let tmpDir: URL;

    before(async () => {

        const path = await Fs.promises.mkdtemp(await Fs.promises.realpath(Os.tmpdir()) + Path.sep) + Path.sep;
        tmpDir = pathToFileURL(path);
    });

    after(async () => {

        await Fs.promises.rmdir(tmpDir, { recursive: true });
    });

    describe('next()', () => {

        it('waits for file change', async () => {

            const fileUrl = new URL('file1', tmpDir);
            try {
                await Fs.promises.writeFile(fileUrl, '<run>1</run>', 'utf-8');

                const watcher = new FsWatcher(fileUrl);
                const promise = watcher.next();
                expect(await Promise.race([promise, wait(1, 'waiting')])).to.equal('waiting');

                await Fs.promises.writeFile(fileUrl, '<run>2</run>', 'utf-8');

                expect(await promise).to.equal('change');
            }
            finally {
                await Fs.promises.unlink(fileUrl);
            }
        });

        it('immediately returns if changed before calling', async () => {

            const fileUrl = new URL('file1', tmpDir);
            try {
                await Fs.promises.writeFile(fileUrl, '<run>1</run>', 'utf-8');

                const watcher = new FsWatcher(fileUrl);
                try {
                    await Fs.promises.writeFile(fileUrl, '<run>2</run>', 'utf-8');

                    const result = watcher.next();
                    expect(result).to.equal('change');
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
            const watcher = new FsWatcher(fileUrl);
            try {
                const promise = watcher.next();

                expect(await Promise.race([promise, wait(1, 'waiting')])).to.equal('waiting');
                await Fs.promises.writeFile(fileUrl, '<run>1</run>', 'utf-8');
                expect(await promise).to.equal('rename');
                expect(await watcher.next()).to.equal('change');
            }
            finally {
                watcher.close();
                await Fs.promises.unlink(fileUrl);
            }
        });

        it('works more than once', async () => {

            const fileUrl = new URL('file2', tmpDir);
            const watcher = new FsWatcher(fileUrl);
            try {
                await Fs.promises.writeFile(fileUrl, '<run>1</run>', 'utf-8');
                expect(await watcher.next()).to.equal('change');
                await Fs.promises.writeFile(fileUrl, '<run>2</run>', 'utf-8');
                expect(await watcher.next()).to.equal('change');
                await Fs.promises.writeFile(fileUrl, '<run>3</run>', 'utf-8');
                expect(await watcher.next()).to.equal('change');
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

                const watcher = new FsWatcher(fileUrl);
                try {
                    await Fs.promises.unlink(fileUrl);

                    expect(await watcher.next()).to.equal('rename');

                    await Fs.promises.writeFile(fileUrl, '<run>2</run>', 'utf-8');

                    expect(await watcher.next()).to.equal('change');
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

                const watcher = new FsWatcher(fileUrl);
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

        it('does not trigger for adjecent file changes', async () => {

            const fileUrl = new URL('file1', tmpDir);
            const adjUrl = new URL('file2', tmpDir);
            try {
                await Fs.promises.writeFile(fileUrl, '<run>1</run>', 'utf-8');
                await Fs.promises.writeFile(adjUrl, '<run>1</run>', 'utf-8');

                const watcher = new FsWatcher(fileUrl);
                const promise = watcher.next();
                try {
                    expect(await Promise.race([promise, wait(1, 'waiting')])).to.equal('waiting');
                    await Fs.promises.writeFile(adjUrl, '<run>2</run>', 'utf-8');
                    expect(await Promise.race([promise, wait(1, 'waiting')])).to.equal('waiting');
                }
                finally {
                    watcher.close();
                }

                await expect(promise).to.reject('closed');
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

                await expect(promise).to.reject('fail');
                expect(() => watcher.next()).to.throw('fail');
            }
            finally {
                watcher.close();
            }
        });

        it('throws on errors when not called', () => {

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

            await expect(promise).to.reject('closed');
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
