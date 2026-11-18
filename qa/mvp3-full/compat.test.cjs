'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const vm = require('node:vm');

const shim = fs.readFileSync(path.join(__dirname,
    '../../android-mvp3/app/src/main/assets/www/runtime/webview-compat.js'), 'utf8');

test('The stock-WebView compatibility shim leaves modern native methods intact', () => {
    const context = vm.createContext({});
    vm.runInContext('const nativeHasOwn = Object.hasOwn; const nativeAt = Array.prototype.at;', context);
    vm.runInContext(shim, context);
    assert.equal(vm.runInContext('Object.hasOwn === nativeHasOwn && Array.prototype.at === nativeAt', context), true);
});

test('Legacy JS handles own keys, negative indexes, empty and out-of-range arrays', () => {
    const context = vm.createContext({});
    vm.runInContext('delete Object.hasOwn; delete Array.prototype.at;', context);
    vm.runInContext(shim, context);
    assert.equal(vm.runInContext(
        'Object.hasOwn({a: null}, "a") && !Object.hasOwn(Object.create({a: 1}), "a")', context), true);
    assert.equal(vm.runInContext('Object.hasOwn(Object.assign(Object.create(null), {x: 1}), "x")', context), true);
    assert.equal(vm.runInContext('["a", "b", "c"].at(-1)', context), 'c');
    assert.equal(vm.runInContext('["a", "b", "c"].at(-2.8)', context), 'b');
    assert.equal(vm.runInContext('["a", "b", "c"].at(NaN)', context), 'a');
    assert.equal(vm.runInContext('[].at(0)', context), undefined);
    assert.equal(vm.runInContext('["a"].at(Infinity)', context), undefined);
    assert.equal(vm.runInContext('Array.prototype.at.call({0: "x", length: 1}, -1)', context), 'x');
    assert.equal(vm.runInContext('Object.keys(Object).includes("hasOwn") || Object.keys(Array.prototype).includes("at")', context), false);
});
