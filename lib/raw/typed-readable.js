'use strict';

const { EventEmitter } = require('events');
const { Duplex, Readable, Transform, Writable } = require('stream');


exports.TypedEmitter = function TypedEmitter(_, Base = EventEmitter) {

    return Base;
};

exports.TypedReadable = function TypedReadable(_, Base = Readable) {

    return Base;
};

exports.TypedWritable = function TypedWritable(_, Base = Writable) {

    return Base;
};

exports.TypedDuplex = function TypedDuplex(W, R, Base = Duplex) {

    return Base;
};

exports.TypedTransform = function TypedTransform(W, R, Base = Transform) {

    return Base;
};
