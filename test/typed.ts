import { EventEmitter } from 'events';

import { expect } from '@hapi/code';
import { ignore } from '@hapi/hoek';
import * as Lab from '@hapi/lab';

import { Constructor, TypedDuplex, TypedEmitter, TypedReadable, TypedTransform, TypedWritable } from '../lib/raw/typed-readable';
import { Duplex, Readable, Transform, Writable } from 'readable-stream';


// Test shortcuts

export const lab = Lab.script();
const { describe, it } = lab;


// eslint-disable-next-line @typescript-eslint/ban-types
const test = function (method: Function, Base: Constructor, first = [null], more?: Function) {

    describe(`Typed${method.name}`, () => {

        it(`inherits from ${Base.name}`, () => {

            expect(new (class extends method() {})()).to.be.instanceof(Base);
        });

        it('allows custom base class', () => {

            const MyClass = class {};
            expect(new (class extends method(...[...first, MyClass]) {})()).to.be.instanceof(MyClass);
        });

        more && more();
    });
};


// eslint-disable-next-line @typescript-eslint/ban-types
const testR = function (method: Function, Base: Constructor, first = [null]) {

    test(method, Base, first, () => {

        it('destroys only once', () => {

            const r = new (method())() as Readable;
            r.once('error', ignore);
            expect(r.destroyed).to.be.false();
            r.destroy(new Error('fail'));
            expect(r.destroyed).to.be.true();
            r.destroy(new Error('fail'));
            expect(r.destroyed).to.be.true();
        });
    });
};


test(TypedEmitter, EventEmitter);
testR(TypedReadable, Readable);
testR(TypedWritable, Writable);
testR(TypedDuplex, Duplex, [null, null]);
testR(TypedTransform, Transform, [null, null]);
