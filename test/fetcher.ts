import * as Path from 'path';

import { expect } from '@hapi/code';
import * as Lab from '@hapi/lab';

import { HlsPlaylistFetcher } from '../lib/fetcher';


const internals = {
    fixtures: Path.join(__dirname, 'fixtures')
};

// Test shortcuts

export const lab = Lab.script();
const { describe, it } = lab;


describe('HlsPlaylistFetcher', () => {

    describe('update()', () => {

        it('throws if called before index()', () => {

            const fetcher = new HlsPlaylistFetcher(`file://${internals.fixtures}/live.m3u8`);
            expect(() => fetcher.update()).to.throw('An initial index() must have been sucessfully fetched');
        });

        it('throws if called before index() returns', async () => {

            const fetcher = new HlsPlaylistFetcher(`file://${internals.fixtures}/live.m3u8`);
            const promise = fetcher.index();

            expect(() => fetcher.update()).to.throw('An initial index() must have been sucessfully fetched');

            await promise;
        });

        it('throws if called during an update()', async () => {

            const fetcher = new HlsPlaylistFetcher(`file://${internals.fixtures}/live.m3u8`);
            await fetcher.index();

            const promise = fetcher.update();
            expect(() => fetcher.update()).to.throw('An update is already being fetched');
            fetcher.cancel();
            await expect(promise).to.reject();
        });
    });

    describe('canUpdate()', () => {

        it('returns false before index() is received', async () => {

            const fetcher = new HlsPlaylistFetcher(`file://${internals.fixtures}/500.m3u8`);
            expect(fetcher.playlist).to.not.exist();
            expect(fetcher.canUpdate()).to.be.false();
            const promise = fetcher.index();
            expect(fetcher.canUpdate()).to.be.false();
            await promise;
        });

        it('returns false once a main index has been fetched', async () => {

            const fetcher = new HlsPlaylistFetcher(`file://${internals.fixtures}/index.m3u8`);
            await fetcher.index();
            expect(fetcher.canUpdate()).to.be.false();
        });

        it('returns false once a non-live media index has been fetched', async () => {

            const fetcher = new HlsPlaylistFetcher(`file://${internals.fixtures}/500.m3u8`);
            await fetcher.index();
            expect(fetcher.canUpdate()).to.be.false();
        });

        it('returns true once a live media index has been fetched', async () => {

            const fetcher = new HlsPlaylistFetcher(`file://${internals.fixtures}/live.m3u8`);
            await fetcher.index();
            expect(fetcher.canUpdate()).to.be.true();
        });

        it('returns false when a live media update has been cancelled', async () => {

            const fetcher = new HlsPlaylistFetcher(`file://${internals.fixtures}/live.m3u8`);
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
});