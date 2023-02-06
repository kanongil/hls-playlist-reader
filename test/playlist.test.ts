import { expect } from '@hapi/code';
import { AttrList, MediaPlaylist, MediaSegment } from 'm3u8parse';

import { ParsedPlaylist } from '../lib/playlist.js';


describe('ParsedPlaylist()', () => {

    const _startDate = new Date();

    const singlePartPlaylist = new MediaPlaylist({
        media_sequence: 20,
        target_duration: 1,
        part_info: new AttrList({ 'part-target': '0.5' }),
        segments: [
            new MediaSegment(undefined, { parts: [new AttrList({ duration: '0.5', uri: 'part0' })] })
        ]
    });

    const livePlaylist = new MediaPlaylist({
        media_sequence: 20,
        target_duration: 1,
        part_info: new AttrList({ 'part-target': '0.5' }),
        segments: [
            new MediaSegment('segment20', {
                program_time: new Date(+_startDate + 20_000),
                duration: 1
            }),
            new MediaSegment('segment21', {
                program_time: new Date(+_startDate + 21_000),
                duration: 1,
                parts: [
                    new AttrList({ duration: '0.5', uri: 'part21.0' }),
                    new AttrList({ duration: '0.5', uri: 'part21.1' })
                ]
            }),
            new MediaSegment('segment22', {
                program_time: new Date(+_startDate + 22_000),
                duration: 1,
                parts: [
                    new AttrList({ duration: '0.5', uri: 'part22.0' }),
                    new AttrList({ duration: '0.5', uri: 'part22.1' })
                ]
            }),
            new MediaSegment('segment23', {
                program_time: new Date(+_startDate + 23_000),
                duration: 1,
                parts: [
                    new AttrList({ duration: '0.5', uri: 'part23.0' }),
                    new AttrList({ duration: '0.5', uri: 'part23.1' })
                ]
            }),
            new MediaSegment(undefined, {
                program_time: new Date(+_startDate + 24_000),
                parts: [
                    new AttrList({ duration: '0.5', uri: 'part24.0' })
                ]
            })
        ]
    });

    it('handles index with a single part', () => {

        const playlist = new ParsedPlaylist(singlePartPlaylist);

        expect(playlist.segments).to.have.length(1);
        expect(playlist.nextHead()).to.equal({ msn: 20, part: 1 });
    });

    it('works with stripped single part segment list', () => {

        const playlist = new ParsedPlaylist(singlePartPlaylist, { noLowLatency: true });

        expect(playlist.segments).to.have.length(0);
        expect(playlist.nextHead()).to.equal({ msn: 20 });
    });

    it('works with stripped segment list', () => {

        const playlist = new ParsedPlaylist(livePlaylist, { noLowLatency: true });

        expect(playlist.segments).to.have.length(4);
        expect(playlist.nextHead()).to.equal({ msn: 24 });
    });

    it('nextHead() works when last segment is full', () => {

        const index = new MediaPlaylist(livePlaylist);
        index.segments.splice(index.segments.length - 1, 1);

        const playlist = new ParsedPlaylist(index);

        expect(playlist.nextHead()).to.equal({ msn: 24, part: 0 });
    });

    it('nextHead() works when last segment is fully partial', () => {

        const index = new MediaPlaylist(livePlaylist);
        index.segments[index.segments.length - 1].parts = undefined;

        const playlist = new ParsedPlaylist(index);

        expect(playlist.nextHead()).to.equal({ msn: 24, part: 0 });
    });

    it('exposes preloadHints', () => {

        const index = new MediaPlaylist(singlePartPlaylist);
        index.meta.preload_hints = [
            new AttrList('TYPE=MAP,URI="map:",BYTERANGE-START=0,BYTERANGE-LENGTH=123'),
            new AttrList('TYPE=PART,URI="part:",BYTERANGE-START=123')
        ];

        const playlist = new ParsedPlaylist(index);
        expect(playlist.preloadHints).to.equal({
            map: { uri: 'map:', byterange: { offset: 0, length: 123 } },
            part: { uri: 'part:', byterange: { offset: 123, length: undefined } }
        });
    });

    describe('date computation', () => {

        describe('startDate', () => {

            it('returns correct date when present', () => {

                const playlist = new ParsedPlaylist(livePlaylist);

                expect(playlist.startDate).to.be.instanceOf(Date).and.to.equal(new Date(+_startDate + 20_000));
            });

            it('returns "undefined" when missing', () => {

                const playlist = new ParsedPlaylist(singlePartPlaylist);

                expect(playlist.startDate).to.be.be.undefined();
            });
        });

        describe('endDate', () => {

            it('returns correct computed date', () => {

                const playlist = new ParsedPlaylist(livePlaylist);

                expect(playlist.endDate).to.be.instanceOf(Date).and.to.equal(new Date(+_startDate + 24_500));
            });

            it('returns correct computed date when segment date is inferred', () => {

                const index = new MediaPlaylist(livePlaylist);
                for (let i = 1; i < index.segments.length; ++i) {
                    index.segments[i].program_time = null;
                }

                const playlist = new ParsedPlaylist(index);

                expect(playlist.segments[playlist.segments.length - 1]).to.include({ program_time: null });
                expect(playlist.endDate).to.be.instanceOf(Date).and.to.equal(new Date(+_startDate + 24_500));
            });

            it('returns correct computed date when last segment is full', () => {

                const index = new MediaPlaylist(livePlaylist);
                index.segments.splice(index.segments.length - 1, 1);

                const playlist = new ParsedPlaylist(index);

                expect(playlist.segments[playlist.segments.length - 1]).to.include({ uri: 'segment23' });
                expect(playlist.endDate).to.be.instanceOf(Date).and.to.equal(new Date(+_startDate + 24_000));
            });

            it('returns correct computed date when last segment is fully partial', () => {

                const index = new MediaPlaylist(livePlaylist);
                index.segments[index.segments.length - 1].parts = undefined;

                const playlist = new ParsedPlaylist(index);

                expect(playlist.segments[playlist.segments.length - 1]).to.include({ parts: undefined });
                expect(playlist.endDate).to.be.instanceOf(Date).and.to.equal(new Date(+_startDate + 24_000));
            });

            it('returns "undefined" when no date info is available', () => {

                const playlist = new ParsedPlaylist(singlePartPlaylist);

                expect(playlist.endDate).to.be.be.undefined();
            });
        });
    });
});
