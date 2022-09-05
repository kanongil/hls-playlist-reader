import { expect } from '@hapi/code';
import { AttrList, MediaPlaylist, MediaSegment } from 'm3u8parse';

import { ParsedPlaylist } from '../lib/playlist.js';


describe('ParsedPlaylist()', () => {

    const singlePartPlaylist = new MediaPlaylist({
        media_sequence: 20,
        target_duration: 1,
        part_info: new AttrList({ 'part-target': '0.5' }),
        segments: [
            new MediaSegment(undefined, { parts: [new AttrList()] } as MediaSegment)
        ]
    } as MediaPlaylist);

    it('handles index with a single part', () => {

        const playlist = new ParsedPlaylist(singlePartPlaylist);

        expect(playlist.segments).to.have.length(1);
        expect(playlist.nextHead()).to.equal({ msn: 20, part: 1 });
    });

    it('works with stripped segment list', () => {

        const playlist = new ParsedPlaylist(singlePartPlaylist, { noLowLatency: true });

        expect(playlist.segments).to.have.length(0);
        expect(playlist.nextHead()).to.equal({ msn: 20 });
    });

    it('handles preload hints', () => {

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
});
