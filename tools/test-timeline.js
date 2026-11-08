'use strict';

// Zero-dependency DOM/canvas simulation; no Premiere or browser required.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../cep-extension/js/timeline.js'), 'utf8');

function setup(raf = true) {
    const queue = [], canvasEvents = {}, windowEvents = {}, fills = [];
    let paints = 0;
    const ctx = {
        setTransform() {}, clearRect() { paints++; },
        fillRect(...args) { fills.push({ color: this.fillStyle, args }); },
        fillText() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}
    };
    const canvas = {
        clientWidth: 1000, getContext: () => ctx,
        getBoundingClientRect: () => ({ left: 17, top: 23 }),
        addEventListener(name, fn) { canvasEvents[name] = fn; }
    };
    const window = {
        devicePixelRatio: 2,
        addEventListener(name, fn) { windowEvents[name] = fn; }
    };
    if (raf) window.requestAnimationFrame = fn => { queue.push(fn); return 0; };
    vm.runInNewContext(source, { window }, { filename: 'timeline.js' });
    const timeline = new window.ArknightTimeline(canvas);
    return {
        timeline, fills, queue, get paints() { return paints; },
        flush() { const callbacks = queue.splice(0); callbacks.forEach(fn => fn()); },
        event(name, x, y = 40, extra = {}) {
            const e = Object.assign({ clientX: x + 17, clientY: y + 23,
                button: 0, preventDefault() {} }, extra);
            (canvasEvents[name] || windowEvents[name])(e);
        }
    };
}

let passed = 0;
function test(name, run) {
    run();
    passed++;
    console.log('PASS ' + name);
}
function clip(start, end) { return { start, end, keep_in: start, keep_out: end }; }
function drag(h, seg, side, destination, offset = 0) {
    const t = h.timeline;
    const x = t.f2x(side === 'keep_in' ? seg.keep_in : seg.keep_out + 1) + offset;
    h.event('mousedown', x);
    assert.equal(t._drag.side, side);
    h.event('mousemove', destination === null ? x : destination);
    h.event('mouseup', destination === null ? x : destination);
}

test('100-frame right boundary keeps inclusive frame 99; callback API unchanged', () => {
    const h = setup(), s = clip(0, 99), changes = [];
    h.timeline.setData({ totalFrames: 100, clipSegments: [s] });
    h.timeline.onChange = kind => changes.push(kind);
    drag(h, s, 'keep_out', null);
    assert.equal(s.keep_out, 99);
    s.keep_out = 80;
    drag(h, s, 'keep_out', 1000);
    assert.equal(s.keep_out, 99);
    assert.deepEqual(changes, ['handle', 'handle-end', 'handle', 'handle-end']);
});

test('same x, vertical movement and grab tolerance never change either handle', () => {
    const h = setup(), s = clip(20, 79);
    h.timeline.setData({ totalFrames: 1000, clipSegments: [s] });
    for (const side of ['keep_in', 'keep_out']) {
        for (const offset of [-4, 0, 4]) {
            const before = s[side];
            const x = h.timeline.f2x(side === 'keep_in' ? s.keep_in : s.keep_out + 1) + offset;
            h.event('mousedown', x);
            h.event('mousemove', x, 65);
            h.event('mouseup', x, 65);
            assert.equal(s[side], before);
        }
    }
});

test('both handles stay inside their own segment, preserving empty interval sentinel', () => {
    const h = setup(), left = clip(0, 19), s = clip(20, 59), right = clip(60, 99);
    h.timeline.setData({ totalFrames: 100, clipSegments: [left, s, right] });
    s.keep_in = 25;
    drag(h, s, 'keep_in', -1000);
    assert.equal(s.keep_in, 20);
    // Avoid coincident neighbouring handles when selecting the target.
    s.keep_in = 25;
    drag(h, s, 'keep_in', 2000);
    assert.equal(s.keep_in, 59);
    s.keep_out = 45;
    drag(h, s, 'keep_out', 2000);
    assert.equal(s.keep_out, 59);
    s.keep_out = 45;
    drag(h, s, 'keep_out', -1000);
    assert.equal(s.keep_out, 19);
    assert.deepEqual(left, clip(0, 19));
    assert.deepEqual(right, clip(60, 99));
});

test('zoomed/scrolled drag uses frame displacement, including a one-frame clip', () => {
    const h = setup(), s = clip(50, 50), t = h.timeline;
    t.setData({ totalFrames: 100, clipSegments: [s] });
    t.zoom = 4;
    t.scrollFrame = 40;
    drag(h, s, 'keep_out', t.f2x(50));
    assert.equal(s.keep_out, 49);
    s.keep_out = 50;
    drag(h, s, 'keep_out', t.f2x(90));
    assert.equal(s.keep_out, 50);
    drag(h, s, 'keep_in', t.f2x(0));
    assert.equal(s.keep_in, 50);
});

test('mask reads only visible frames, including fractional edges and correct run colors', () => {
    const h = setup(), t = h.timeline, reads = [];
    const mask = new Proxy({ length: 1000000 }, {
        get(target, key) {
            if (/^\d+$/.test(String(key))) {
                const i = Number(key); reads.push(i); return i < 500050 ? 0 : 1;
            }
            return target[key];
        }
    });
    t.setData({ totalFrames: 1000000, pauseSegments: [
        { start: 0, end: 999999, local_del_mask: mask }
    ] });
    t.zoom = 10000;
    t.scrollFrame = 500000.25;
    h.flush();
    assert.equal(reads.length, 101);
    assert.equal(Math.min(...reads), 500000);
    assert.equal(Math.max(...reads), 500100);
    const bands = h.fills.filter(f => f.args[1] === 15);
    assert.deepEqual(bands, [
        { color: 'rgb(100,200,50)', args: [0, 15, 498, 48] },
        { color: 'rgb(68,51,0)', args: [498, 15, 502, 48] }
    ]);
    reads.length = 0;
    t.pauseSegments[0].start = 600000;
    t.pauseSegments[0].end = 1600000;
    t.draw();
    assert.equal(reads.length, 0);
});

test('visible scan respects segment end and does not cache stale mask values', () => {
    const h = setup(), t = h.timeline, mask = [0, 1, 1, 1];
    t.setData({ totalFrames: 100, pauseSegments: [
        { id: 1, start: 20, end: 21, local_del_mask: mask }
    ] });
    h.flush();
    const bands = () => h.fills.filter(f => f.args[1] === 15);
    assert.equal(bands().length, 2);
    assert.deepEqual(bands()[1].args, [210, 15, 10, 48]);
    h.fills.length = 0;
    mask[1] = 0;
    t.draw();
    assert.equal(bands().length, 1);
    assert.deepEqual(bands()[0].args, [200, 15, 20, 48]);
});

test('RAF coalesces updates and draws latest state; public draw remains synchronous', () => {
    const h = setup(), t = h.timeline;
    t.setData({ totalFrames: 100 });
    t.setPlayhead(20);
    t.ensureVisible(30);
    t.resize();
    assert.equal(h.queue.length, 1);
    assert.equal(h.paints, 0);
    h.flush();
    assert.equal(h.paints, 1);
    assert.equal(t.currentFrame, 30);
    t.setPlayhead(40);
    t.draw();
    assert.equal(h.paints, 2);
    t.setPlayhead(50);
    h.flush();
    assert.equal(h.paints, 3);
    assert.equal(t.currentFrame, 50);
});

test('missing RAF falls back to synchronous draw without changing public methods', () => {
    const h = setup(false), t = h.timeline;
    assert.equal(h.paints, 1);
    t.setData({ totalFrames: 100 });
    t.setPlayhead(99);
    assert.equal(h.paints, 3);
    assert.equal(t.currentFrame, 99);
    assert.equal(typeof t.setPauseMode, 'function');
    assert.equal(typeof t.getPauseById, 'function');
});

test('playhead drag and inclusive handle preview', () => {
    const h = setup(), t = h.timeline, seeks = [], s = clip(20, 79);
    t.setData({ totalFrames: 100, clipSegments: [s] });
    t.onSeek = f => seeks.push(f);
    h.event('mousedown', 250, 5); h.event('mousemove', 2000, 5); h.event('mouseup', 2000, 5);
    assert.deepEqual(seeks, [25, 99]);
    drag(h, s, 'keep_out', null);
    assert.equal(seeks[seeks.length - 1], 79);
});
test('auto all renders final mask including manual keep; explicit all deletes whole segment', () => {
    const h = setup(), t = h.timeline;
    const seg = { id: 1, start: 0, end: 2, mode: 'auto', auto_mode: 'all', local_del_mask: [1, 3, 1] };
    t.setData({ totalFrames: 3, pauseSegments: [seg] }); h.flush();
    assert.deepEqual(h.fills.filter(f => f.args[1] === 15).map(f => f.color),
        ['rgb(68,51,0)', 'rgb(100,200,50)', 'rgb(68,51,0)']);
    h.fills.length = 0; seg.mode = 'all'; t.draw();
    assert.deepEqual(h.fills.filter(f => f.args[1] === 15).map(f => f.color), ['rgb(68,51,0)']);
});
test('restore auto clears manual values and requests mask recompute', () => {
    const h = setup(), t = h.timeline, changes = [];
    t.setData({ totalFrames: 4, pauseSegments: [{ id: 1, mode: 'keep', local_del_mask: [0, 1, 2, 3] }] });
    t.onChange = k => changes.push(k); t.setPauseMode(1, 'auto');
    assert.deepEqual(Array.from(t.pauseSegments[0].local_del_mask), [0, 1, 0, 1]);
    assert.deepEqual(changes, ['auto']);
});
test('last half of a frame selects and toggles that frame, not its neighbour', () => {
    const h = setup(), t = h.timeline;
    const seg = { id: 1, start: 0, end: 1, mode: 'auto', local_del_mask: [0, 1] };
    t.setData({ totalFrames: 100, pauseSegments: [seg] });
    h.event('contextmenu', 7.5, 20);
    assert.deepEqual(seg.local_del_mask, [2, 1]);
    h.event('mousedown', 17.5, 20);
    assert.equal(t.selectedPauseId, 1);
    assert.equal(t.currentFrame, 1);
});
console.log('\n' + passed + ' timeline regression tests passed.');
