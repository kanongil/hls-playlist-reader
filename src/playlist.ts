import type { ImmutableMediaPlaylist, ImmutableMediaSegment } from 'm3u8parse/playlist';

import { arrayAt, Byterange } from './helpers.js';

import { MediaPlaylist } from 'm3u8parse';


export type PartData = {
    uri: string;
    byterange?: Byterange;
};

export type PreloadHints = {
    part?: PartData;
    map?: PartData;
};

export class ParsedPlaylist {

    private _index: ImmutableMediaPlaylist;
    private _stripLowLatency: boolean;

    constructor(index: MediaPlaylist | ImmutableMediaPlaylist, options?: { noLowLatency?: boolean });
    constructor(index: ImmutableMediaPlaylist, options: { noLowLatency?: boolean } = {}) {

        this._stripLowLatency = !!options.noLowLatency;

        if (this._stripLowLatency) {
            const stripped = new MediaPlaylist(index);

            delete stripped.part_info;
            delete stripped.meta.preload_hints;
            delete stripped.meta.rendition_reports;

            stripped.server_control?.delete('part-hold-back');

            if (arrayAt(stripped.segments, -1)?.isPartial()) {
                stripped.segments.pop();
            }

            for (const segment of stripped.segments) {
                delete segment.parts;
            }

            index = stripped as ImmutableMediaPlaylist;
        }

        this._index = index;
    }

    isSameHead(index: Readonly<MediaPlaylist> | ImmutableMediaPlaylist): boolean {

        const includePartial = !(this._stripLowLatency || this._index.i_frames_only);

        const sameMsn = this._index.lastMsn(includePartial) === index.lastMsn(includePartial);
        if (!sameMsn || !includePartial) {
            return sameMsn;
        }

        // Same + partial check

        return (arrayAt(this.segments, -1)!.parts?.length ===
            arrayAt(index.segments, -1)!.parts?.length);
    }

    nextHead(): { msn: number; part?: number } {

        if (this.partTarget && !this._index.i_frames_only) {
            const lastSegment = arrayAt(this.segments, -1)!;

            const next = {
                msn: this._index.lastMsn(true),
                part: lastSegment.parts?.length ?? 0
            };

            if (lastSegment.uri) {

                // Part is complete - rollover to next msn

                ++next.msn;
                next.part = 0;
            }

            return next;
        }

        if (this.segments.length === 0) {

            // An index with no segments can occur when initial parts have been stripped

            return { msn: this._index.media_sequence };
        }

        return { msn: this._index.lastMsn(false) + 1 };
    }

    get index(): ImmutableMediaPlaylist {

        return this._index;
    }

    get segments(): readonly ImmutableMediaSegment[] {

        return this._index.segments;
    }

    get partTarget(): number | undefined {

        const info = this._index.part_info;
        return info?.get('part-target', 'float');
    }

    get serverControl(): { canBlockReload: boolean; partHoldBack?: number } {

        const control = this._index.server_control;
        return {
            canBlockReload: control?.get('can-block-reload') === 'YES',
            partHoldBack: control?.get('part-hold-back', 'float')
        };
    }

    get preloadHints(): PreloadHints {

        const hints: PreloadHints = {};

        const list = this._index.meta.preload_hints;
        for (const attrs of list || []) {
            const type = attrs.get('type')?.toLowerCase();
            if (attrs.has('uri') && type === 'part' || type === 'map') {
                hints[type] = {
                    uri: attrs.get('uri', 'string')!,
                    byterange: attrs.has('byterange-start') ? {
                        offset: attrs.get('byterange-start', 'int')!,
                        length: (attrs.has('byterange-length') ? attrs.get('byterange-length', 'int')! : undefined)
                    } : undefined
                };
            }
        }

        return hints;
    }

    /** Program time of initial segment */
    get startDate(): Date | undefined {

        return this.index.getSegment(this.index.media_sequence, false)?.program_time ?? undefined;
    }

    /** Program time when final segment ends */
    get endDate(): Date | undefined {

        const lastSegment = this.index.getSegment(this.index.lastMsn(true), true);
        if (lastSegment?.program_time) {
            const segmentDuration = lastSegment.duration ?? lastSegment.parts?.reduce(((dur, part) => dur + part.get('duration', 'float')!), 0) ?? 0;
            return new Date(+lastSegment.program_time + segmentDuration * 1000);
        }
    }
}
