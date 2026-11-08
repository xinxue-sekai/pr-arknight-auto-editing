'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const instances = [];
let id = 0;
const window = { ArknightPreviewBridge: {
    create(path, options) {
        const instance = { path, options, seeks: [], closed: false,
            seek(frame) { const requestId = ++id; this.seeks.push({ frame, requestId }); return requestId; },
            close() { this.closed = true; } };
        instances.push(instance); return instance;
    }
} };
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../cep-extension/js/preview.js'), 'utf8'), { window });
function element() {
    return { events: {}, hidden: false, src: '', currentTime: 0,
        addEventListener(k, fn) { this.events[k] = fn; },
        getAttribute(k) { return this[k] || null; },
        removeAttribute(k) { delete this[k]; }, pause() {}, load() {}, play() { return Promise.resolve(); } };
}
const el = { main: element(), before: element(), after: element(), video: element(), status: element() };
const positions = [];
const p = new window.ArknightPreview(el, f => positions.push(f));
const html = fs.readFileSync(path.join(__dirname, '../cep-extension/index.html'), 'utf8');
for (const k of ['main', 'before', 'after']) {
    assert.ok(new RegExp('<img id="preview-' + k + '"[^>]* hidden').test(html));
    assert.equal(el[k].hidden, true);
}
p.pause(); assert.equal(el.main.hidden, true);
function reply(instance, index, name) {
    const request = instance.seeks[index];
    instance.options.onFrame(Object.assign({ path: 'C:/frames/' + name + '.jpg', width: 100, height: 50 }, request));
}
p.open('C:/A #1.mp4');
const firstRequest = instances[0].seeks[0];
instances[0].options.onFrame(Object.assign({ path: 'C:/first.jpg', width: 96, height: 64,
    totalFrames: 12, fps: 10, metadataStatus: 'estimate', fpsStatus: 'estimate' }, firstRequest));
assert.equal(p.total, 12); assert.equal(p.fps, 10); assert.equal(p.metadataStatus, 'estimate');
p.seek(p.frame + 1); assert.equal(p.frame, 1, 'step before analysis without video metadata');
p.seek(100); assert.equal(p.frame, 11);
p.configure(30, 100, [[0, 10], [20, 30]]);
const sessionRequest = instances[0].seeks[instances[0].seeks.length - 1];
instances[0].options.onFrame(Object.assign({ path: 'C:/session.jpg', width: 96, height: 64,
    totalFrames: 12, fps: 10 }, sessionRequest));
assert.equal(p.total, 100); assert.equal(p.fps, 30); assert.equal(p.metadataStatus, 'session');
assert.ok(el.video.src.includes('%23'));
assert.deepEqual(instances.map(i => i.options.channel), ['main', 'before', 'after']);
const main = instances[0];
p.seek(10); const a = main.seeks.length - 1;
p.seek(20); const b = main.seeks.length - 1;
p.seek(10); const c = main.seeks.length - 1;
reply(main, c, 'latest'); reply(main, b, 'stale'); reply(main, a, 'older-same-frame');
assert.ok(el.main.src.includes('latest'));
assert.equal(el.main.hidden, true, 'wait for decoded image before showing');
el.main.events.load(); assert.equal(el.main.hidden, false);
el.main.events.error(); assert.equal(el.main.hidden, true);
p.pause(); assert.equal(el.main.hidden, true);
assert.equal(el.main.src, undefined);
p.compare({ start: 10, end: 20 });
assert.equal(instances[1].seeks[0].frame, 9);
assert.equal(instances[2].seeks[0].frame, 21);
reply(instances[1], 0, 'before'); el.before.events.load(); assert.equal(el.before.hidden, false);
p.compare(null); reply(instances[1], 0, 'cleared'); assert.equal(el.before.src, undefined);
assert.equal(el.before.hidden, true); assert.equal(el.after.hidden, true);
p.seek(10); p.play(true); assert.equal(el.video.currentTime, 20 / 30);
p.seek(9); p.play(true); assert.equal(el.video.currentTime, 9 / 30);
el.video.currentTime = 10 / 30; el.video.events.timeupdate();
assert.equal(el.video.currentTime, 20 / 30);
el.video.currentTime = 30 / 30; el.video.events.timeupdate(); assert.equal(p.playing, false);
assert.equal(p.frame, 29);
p.seek(30); p.play(true); assert.equal(el.video.currentTime, 0);
p.pause();
p.open('C:/B.mp4'); reply(main, c, 'old-media'); assert.equal(el.main.src, undefined);
assert.ok(instances.slice(0, 3).every(i => i.closed));
assert.equal(p.total, 0); assert.equal(p.metadataStatus, 'unknown');
assert.equal(p.positionInfo().fps, null);
const newMain = instances[3];
newMain.options.onFrame(Object.assign({ path: 'C:/unknown-fps.jpg', width: 96, height: 64,
    totalFrames: 6, fps: null, fpsStatus: 'unknown' }, newMain.seeks[0]));
assert.equal(p.positionInfo().fps, null);
p.seek(1); assert.equal(p.frame, 1, 'unknown fps still permits indexed still review');
p.play(false); assert.equal(p.playing, false);
el.video.events.error(); assert.ok(el.status.textContent.includes('没有可用播放代理'));
console.log('PASS preview channel independence, request order, epoch isolation, comparison, cut playback and unsupported codec');

(async () => {
    let resolve, released = 0;
    window.ArknightPreviewBridge.preparePlayback = () => {
        const lease = new Promise(r => { resolve = r; });
        lease.cleanup = async () => { released++; };
        return lease;
    };
    window.ArknightPreviewBridge.cancelPlayback = () => { throw new Error('must not cancel other consumers'); };
    p.open('C:/fallback.mp4');
    const done = p.playbackFallback();
    resolve({ path: 'C:/proxy.mp4' }); await done;
    assert.ok(el.video.src.includes('proxy.mp4'));
    p.open('C:/stale.mp4');
    const stale = p.playbackFallback();
    p.open('C:/new.mp4');
    resolve({ path: 'C:/obsolete.mp4' }); await stale;
    assert.ok(el.video.src.includes('new.mp4'));
    assert.equal(released, 2);
    el.overlay = { style: {} };
    p.dimensions = { width: 1280, height: 720, sourceWidth: 1920, sourceHeight: 1080 };
    p.setContentRect({ x: 192, y: 108, width: 960, height: 540 });
    assert.equal(el.overlay.style.left, '10%');
    assert.equal(el.overlay.style.top, '10%');
    assert.equal(el.overlay.style.width, '50%');
    assert.equal(el.overlay.style.height, '50%');
    console.log('PASS playback proxy fallback and stale result isolation');
})().catch(error => { console.error(error); process.exitCode = 1; });
