'use strict';

// Run the real panel controller with DOM, CEP, bridge and timer mocks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../cep-extension/js/main.js'), 'utf8');
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function deferred() {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
}
function result(mode = 'auto', end = 80) {
    return { sessionPath: '/session.json', session: {
        fps: 30, total_frames: 100, params: {},
        pause_segments: [{ id: 1, start: 10, end: 20, mode }],
        speed_segments: [], clip_segments: [], keep_ranges: [[0, end]],
        stats: { kept_frames: end, ratio: 0.8 }, markers: []
    } };
}
const html = fs.readFileSync(path.join(__dirname, '../cep-extension/index.html'), 'utf8');
const domIds = new Set(Array.from(html.matchAll(/\bid="([^"]+)"/g), m => m[1]));
async function harness({ delayHost = false, initError = false, noNode = false, saveOK = false } = {}) {
    const elements = new Map(), timers = new Map(), calls = [], requests = [];
    let timerId = 0, timeline, previewPosition;
    function element(id) {
        if (!elements.has(id)) elements.set(id, {
            value: '', textContent: '', innerHTML: '', style: {}, disabled: false,
            listeners: {}, children: [],
            addEventListener(type, fn) { this.listeners[type] = fn; },
            appendChild(child) { this.children.push(child); }
        });
        return elements.get(id);
    }
    const request = (kind, args) => {
        const d = deferred();
        requests.push(Object.assign(d, { kind, args }));
        return d.promise;
    };
    class Timeline {
        constructor() { timeline = this; this.selectedPauseId = null; }
        setData(d) {
            this.pauseSegments = d.pauseSegments;
            this.clipSegments = d.clipSegments;
            this.speedSegments = d.speedSegments;
        }
        getPauseById(id) { return this.pauseSegments.find(s => s.id === id); }
        resize() {}
        ensureVisible() {}
    }
    const bridge = {
        CODE: { CANCELLED: 'CANCELLED' }, init() { if (initError) throw new Error('init denied'); }, getConfig: () => ({}),
        saveConfig: () => saveOK, paths: { CONFIG_PATH: '/denied/config.json' },
        getState: () => ({}), detectPython: async () => null,
        fileExists: () => true, defaultEdlPath: p => p + '.edl',
        analyze: (...args) => request('analyze', args),
        suggestContentRect: (...args) => request('suggest', args),
        recompute: (...args) => request('recompute', args),
        exportEdl: (...args) => request('edl', args),
        cancel() { calls.push({ kind: 'cancel' }); return true; },
        writePayload(name, payload) { calls.push({ kind: 'payload', payload }); return '/apply.json'; }
    };
    class CSInterface {
        getSystemPath() { return '/extension'; }
        async evalJSON(call) {
            calls.push({ kind: 'jsx', call });
            if (call.includes('getHostInfo')) return { candidates: [{ mediaPath: 'B.mp4', name: 'B' }] };
            if (delayHost && /Arknight\.(applyEdit|importEdl)\(/.test(call)) return request('host', [call]);
            return { checks: {}, newSequenceIds: [], subclipsCreated: 1, markersAdded: 0 };
        }
    }
    const navigator = { userAgent: 'Chrome/74', platform: 'Win32' };
    vm.runInNewContext(source, {
        CSInterface, navigator,
        window: { ArknightBridge: noNode ? undefined : bridge, ArknightTimeline: Timeline, navigator,
            ArknightPreview: class {
                constructor(elements, onPosition) { previewPosition = onPosition; }
                open(path) { calls.push({ kind: 'preview-open', path }); }
                configure(fps, total, ranges) { calls.push({ kind: 'preview-configure', fps, total, ranges }); }
                compare() {} pause() {} setContentRect() {}
            },
            location: { pathname: '/extension/index.html' }, addEventListener() {} },
        document: { readyState: 'complete', getElementById: id => domIds.has(id) ? element(id) : null,
            querySelectorAll: () => [], createElement: () => element('candidate') },
        setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
        clearTimeout(id) { timers.delete(id); }
    }, { filename: 'main.js' });
    await flush();
    const fire = (id, type = 'click') => element(id).listeners[type]({ target: element(id) });
    const pick = p => { element('video-path').value = p; fire('video-path', 'input'); };
    const tick = async () => {
        const work = [...timers.values()]; timers.clear(); work.forEach(fn => fn()); await flush();
    };
    const edit = (mode, kind = 'mode') => { timeline.pauseSegments[0].mode = mode; timeline.onChange(kind); };
    const ready = async () => {
        pick('A.mp4'); fire('btn-analyze'); requests[requests.length - 1].resolve(result()); await flush();
        assert.equal(element('btn-apply').disabled, false);
    };
    const blocked = async () => {
        assert.equal(element('btn-apply').disabled, true);
        assert.equal(element('btn-edl').disabled, true);
        const before = calls.filter(c => c.kind === 'payload').length;
        const edls = requests.filter(r => r.kind === 'edl').length;
        await fire('btn-apply'); await fire('btn-edl');
        assert.equal(calls.filter(c => c.kind === 'payload').length, before);
        assert.equal(requests.filter(r => r.kind === 'edl').length, edls);
    };
    return { element, calls, requests, fire, pick, tick, edit, ready, blocked,
        previewPosition: (frame, info) => previewPosition(frame, info), timeline: () => timeline };
}

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
test('strict static defaults off, restores saved value and is passed to recompute', async () => {
    const h = await harness(); h.pick('A.mp4'); h.fire('btn-analyze');
    assert.equal(h.requests[0].args[1].compare.strict_static_enabled, false);
    const saved = result(); saved.session.params.compare = { strict_static_enabled: true };
    h.requests[0].resolve(saved); await flush();
    assert.equal(h.element('p-strict-static').checked, true);
    h.fire('btn-recompute');
    assert.equal(h.requests[1].args[2].compare.strict_static_enabled, true);
    h.requests[1].resolve(saved); await flush();
    h.element('p-strict-static').checked = false; h.fire('btn-recompute');
    assert.equal(h.requests[2].args[2].compare.strict_static_enabled, false);
    h.requests[2].resolve(result()); await flush();
    h.element('p-strict-static').checked = true; h.fire('btn-analyze');
    h.requests[3].resolve(result()); await flush();
    assert.equal(h.element('p-strict-static').checked, false);
});
test('switching or clearing media invalidates a completed session', async () => {
    const h = await harness(); await h.ready(); h.pick('B.mp4'); await h.blocked();
    assert.equal(h.timeline().pauseSegments.length, 0);
    h.pick('A.mp4'); await h.blocked();
    await h.ready(); h.pick(''); await h.blocked();
});
test('Premiere candidate selection also invalidates the old session', async () => {
    const h = await harness(); await h.ready(); await h.fire('btn-pick'); await h.blocked();
    assert.equal(h.element('video-path').value, 'B.mp4');
});
test('late analysis success cannot restore A after A to B to A', async () => {
    const h = await harness(); h.pick('A.mp4'); h.fire('btn-analyze');
    h.pick('B.mp4'); h.pick('A.mp4');
    assert.equal(h.element('btn-analyze').disabled, true);
    await h.fire('btn-analyze'); assert.equal(h.requests.length, 1);
    h.requests[0].resolve(result()); await flush(); await h.blocked();
    assert.equal(h.timeline().pauseSegments.length, 0);
    assert.equal(h.element('btn-analyze').disabled, false);
});
test('failed replacement analysis cannot reuse previous success', async () => {
    const h = await harness(); await h.ready(); h.fire('btn-analyze');
    h.requests[1].reject(new Error('analysis failed')); await flush(); await h.blocked();
});
test('debounce and active drag block output immediately', async () => {
    const h = await harness(); await h.ready(); h.edit('keep', 'handle');
    await h.blocked(); await h.tick(); assert.equal(h.requests.length, 1);
    h.edit('keep', 'handle-end'); await h.blocked(); await h.tick();
    assert.equal(h.requests.length, 2);
    h.requests[1].resolve(result('keep', 90)); await flush();
    assert.equal(h.element('btn-apply').disabled, false);
    await h.fire('btn-apply');
    const payload = h.calls.find(c => c.kind === 'payload').payload;
    assert.equal(payload.mediaPath, 'A.mp4'); assert.equal(payload.ranges[0][1], 90);
});
test('in-flight edits survive stale response and queue latest masks recompute', async () => {
    const h = await harness(); await h.ready(); h.fire('btn-recompute');
    const old = h.requests[1]; h.edit('keep'); await h.tick();
    assert.equal(old.args[1].pause_segments[0].mode, 'auto');
    assert.equal(h.requests.length, 2);
    old.resolve(result('auto')); await flush();
    assert.equal(h.timeline().pauseSegments[0].mode, 'keep');
    assert.equal(h.requests.length, 3);
    assert.equal(h.requests[2].args[1].pause_segments[0].mode, 'keep');
    assert.equal(h.requests[2].args[1].recompute_masks, true);
    await h.blocked(); h.requests[2].resolve(result('keep', 95)); await flush();
    h.fire('btn-edl'); assert.equal(h.requests[3].args[3][0][1], 95);
    h.requests[3].resolve({ edl_path: 'A.edl' }); await flush();
});
test('stale completion during debounce waits and preserves edits', async () => {
    const h = await harness(); await h.ready(); h.fire('btn-recompute'); h.edit('all');
    h.requests[1].resolve(result()); await flush(); await h.blocked();
    assert.equal(h.requests.length, 2); assert.equal(h.timeline().pauseSegments[0].mode, 'all');
    await h.tick(); assert.equal(h.requests.length, 3);
});
test('failed recompute remains blocked and supports explicit retry', async () => {
    const h = await harness(); await h.ready(); h.edit('keep'); await h.tick();
    h.requests[1].reject(new Error('recompute failed')); await flush(); await h.blocked();
    h.fire('btn-recompute'); h.requests[2].resolve(result('keep')); await flush();
    assert.equal(h.element('btn-apply').disabled, false);
});
test('cancel holds busy until promise settles, discards late success and queued edits', async () => {
    const h = await harness(); await h.ready(); h.fire('btn-recompute');
    h.edit('keep'); await h.tick(); h.fire('btn-cancel');
    assert.equal(h.element('btn-analyze').disabled, true);
    await h.fire('btn-analyze'); await h.fire('btn-import-edl');
    assert.equal(h.requests.length, 2); await h.blocked();
    h.requests[1].resolve(result()); await flush();
    assert.equal(h.requests.length, 2); assert.equal(h.element('btn-analyze').disabled, false);
    await h.blocked();
});
test('cancelled analysis rejection is not reported as a failure', async () => {
    const h = await harness(); h.pick('A.mp4'); h.fire('btn-analyze'); h.fire('btn-cancel');
    assert.equal(h.element('btn-analyze').disabled, true);
    h.requests[0].reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
    await flush();
    assert.equal(h.element('status-text').textContent, '已取消，清理完成');
    await h.blocked();
    assert.equal(h.element('log').textContent.includes('分析失败'), false);
    assert.equal(h.element('btn-analyze').disabled, false);
});
test('switch during recompute ignores late failure and clears scheduled work', async () => {
    const h = await harness(); await h.ready(); h.fire('btn-recompute'); h.edit('keep');
    h.pick('B.mp4'); h.requests[1].reject(new Error('obsolete failure'));
    await flush(); await h.tick(); await h.blocked();
    assert.equal(h.requests.length, 2);
    assert.equal(h.element('log').textContent.includes('obsolete failure'), false);
});
for (const button of ['btn-apply', 'btn-import-edl']) {
    for (const outcome of ['success', 'failure']) {
        const settle = request => outcome === 'success'
            ? request.resolve({ newSequenceIds: [], subclipsCreated: 1, markersAdded: 0 })
            : request.reject(new Error('host failed'));
        test(`${button} delayed ${outcome} resumes expired recompute and preserves latest version`, async () => {
            const h = await harness({ delayHost: true }); await h.ready();
            const hostDone = h.fire(button), host = h.requests[1];
            assert.equal(host.kind, 'host');
            assert.ok(host.args[0].includes(button === 'btn-apply' ? 'applyEdit' : 'importEdl'));
            assert.equal(h.element('btn-cancel').disabled, true);
            h.edit('keep'); await h.tick(); await h.blocked();
            assert.equal(h.requests.length, 2);
            settle(host); await hostDone;
            assert.equal(h.requests.length, 3);
            const recompute = h.requests[2];
            assert.equal(recompute.kind, 'recompute');
            assert.equal(recompute.args[0], '/session.json');
            assert.equal(recompute.args[1].pause_segments[0].mode, 'keep');
            await h.blocked();
            h.edit('all'); await h.tick();
            recompute.resolve(result('keep', 90)); await flush();
            assert.equal(h.timeline().pauseSegments[0].mode, 'all');
            assert.equal(h.requests.length, 4);
            assert.equal(h.requests[3].args[1].pause_segments[0].mode, 'all');
            await h.blocked();
            h.requests[3].resolve(result('all', 95)); await flush();
            assert.equal(h.element('btn-apply').disabled, false);
            assert.equal(h.element('btn-edl').disabled, false);
            h.fire('btn-edl');
            assert.equal(h.requests[4].args[3][0][1], 95);
            h.requests[4].resolve({ edl_path: 'A.edl' }); await flush();
        });
        test(`${button} delayed ${outcome} cannot revive edits after media switch`, async () => {
            const h = await harness({ delayHost: true }); await h.ready();
            const hostDone = h.fire(button), host = h.requests[1];
            h.edit('keep'); await h.tick(); h.pick('B.mp4'); h.pick('A.mp4');
            settle(host); await hostDone; await h.tick();
            assert.equal(h.requests.length, 2);
            assert.equal(h.timeline().pauseSegments.length, 0);
            assert.equal(h.element('btn-analyze').disabled, false);
            await h.blocked();
        });
    }
    for (const kind of ['mode', 'handle']) {
        test(`${button} completion respects pending ${kind === 'mode' ? 'debounce' : 'drag'}`, async () => {
            const h = await harness({ delayHost: true }); await h.ready();
            const hostDone = h.fire(button);
            h.edit('keep', kind);
            h.requests[1].resolve({ newSequenceIds: [], subclipsCreated: 1, markersAdded: 0 });
            await hostDone; await h.blocked();
            assert.equal(h.requests.length, 2);
            if (kind === 'handle') {
                await h.tick(); assert.equal(h.requests.length, 2);
                h.edit('keep', 'handle-end');
            }
            await h.tick(); assert.equal(h.requests.length, 3);
            h.requests[2].resolve(result('keep')); await flush();
            assert.equal(h.element('btn-apply').disabled, false);
        });
    }
}
test('undo and redo restore detached snapshots and invalidate output', async () => {
    const h = await harness(); await h.ready();
    h.timeline().onEditStart(); h.edit('keep');
    await h.fire('btn-undo');
    assert.equal(h.timeline().pauseSegments[0].mode, 'auto');
    await h.blocked();
    await h.fire('btn-redo');
    assert.equal(h.timeline().pauseSegments[0].mode, 'keep');
    await h.tick();
    assert.equal(h.requests[1].args[1].pause_segments[0].mode, 'keep');
});
test('content rectangle edits immediately block old output and require analysis', async () => {
    const h = await harness(); await h.ready();
    h.element('roi-enabled').checked = true;
    h.element('roi-width').value = '800'; h.element('roi-height').value = '600';
    await h.fire('roi-width', 'input'); await h.blocked();
    h.fire('btn-analyze');
    assert.equal(h.requests[1].args[1].content_rect.width, 800);
    const r = result(); r.session.params.content_rect = { x: 0, y: 0, width: 800, height: 600 };
    h.requests[1].resolve(r); await flush();
    assert.equal(h.element('btn-apply').disabled, false);
});
test('disabled ROI fields do not invalidate analysis; toggling back restores output', async () => {
    const h = await harness(); await h.ready();
    h.element('roi-width').value = '800'; h.element('roi-height').value = '600';
    h.fire('roi-width', 'input'); assert.equal(h.element('btn-apply').disabled, false);
    h.element('roi-enabled').checked = true; h.fire('roi-enabled', 'change'); await h.blocked();
    h.element('roi-enabled').checked = false; h.fire('roi-enabled', 'change');
    assert.equal(h.element('btn-apply').disabled, false);
});
test('ROI comparison uses analyzed rectangle and permits return to same coordinates', async () => {
    const h = await harness(); h.pick('A.mp4');
    h.element('roi-enabled').checked = true;
    h.element('roi-width').value = '800'; h.element('roi-height').value = '600';
    h.fire('btn-analyze');
    const r = result(); r.session.params.content_rect = { x: 0, y: 0, width: 800, height: 600 };
    h.element('roi-width').value = '900'; h.fire('roi-width', 'input');
    h.requests[0].resolve(r); await flush(); await h.blocked();
    h.element('roi-width').value = '800'; h.fire('roi-width', 'input');
    assert.equal(h.element('btn-apply').disabled, false);
    h.element('roi-enabled').checked = false; h.fire('roi-enabled', 'change'); await h.blocked();
    h.element('roi-enabled').checked = true; h.fire('roi-enabled', 'change');
    assert.equal(h.element('btn-apply').disabled, false);
});
for (const [code, hint] of [['CLIP_EDITS_RESET_REQUIRED', '当前编辑已保留'], ['BOUNDARY_READ_REQUIRED', '按原解码方式补读边界']]) {
    test('recompute explains ' + code + ' without clearing edits', async () => {
        const h = await harness(); await h.ready(); h.edit('keep'); await h.tick();
        h.requests[1].reject(Object.assign(new Error(code), { backendCode: code })); await flush();
        assert.ok(h.element('status-text').textContent.includes(hint));
        assert.equal(h.timeline().pauseSegments[0].mode, 'keep');
    });
}
test('ROI suggestions preview only, block task overlap and require explicit adoption', async () => {
    const h = await harness(); await h.ready();
    const done = h.fire('btn-detect-roi');
    assert.equal(h.element('btn-analyze').disabled, true);
    await h.fire('btn-analyze'); await h.fire('btn-detect-roi');
    assert.equal(h.requests.length, 2);
    h.requests[1].resolve({ applied: false, requires_confirmation: true,
        candidates: [{ kind: 'game', content_rect: { x: 4, y: 78, width: 800, height: 600 },
            confidence: 0.9, evidence: ['edges'], warning: 'check visually' }],
        sampled_indices: [0, 50], source_size: [1920, 1200], limitations: ['heuristic'] });
    await done;
    assert.equal(h.element('btn-apply').disabled, false);
    assert.ok(!h.element('roi-enabled').checked);
    assert.ok(h.element('roi-suggestion-info').textContent.includes('尚未采用'));
    assert.ok(h.element('roi-suggestion-info').textContent.includes('heuristic'));
    h.fire('btn-adopt-roi');
    assert.equal(h.element('roi-enabled').checked, true);
    assert.equal(h.element('roi-x').value, 4);
    await h.blocked();
});
test('ROI suggestions ignore stale media completion and recover from errors', async () => {
    const h = await harness(); await h.ready();
    const done = h.fire('btn-detect-roi'); h.pick('B.mp4');
    h.requests[1].resolve({ candidates: [{ content_rect: { x: 0, y: 0, width: 10, height: 10 } }] });
    await done;
    assert.equal(h.element('btn-adopt-roi').disabled, true);
    assert.equal(h.element('btn-detect-roi').disabled, false);
    const failed = h.fire('btn-detect-roi'); h.requests[2].reject(new Error('detect failed')); await failed;
    assert.equal(h.element('btn-analyze').disabled, false);
    assert.equal(h.element('roi-suggestion-info').textContent, 'detect failed');
});
test('cancel ROI detection waits for cleanup and preserves completed analysis', async () => {
    const h = await harness(); await h.ready();
    const done = h.fire('btn-detect-roi');
    assert.equal(h.element('btn-cancel').disabled, false);
    h.fire('btn-cancel');
    assert.equal(h.element('btn-analyze').disabled, true);
    h.requests[1].resolve({ candidates: [{ kind: 'late', content_rect: { x: 0, y: 0, width: 10, height: 10 } }] });
    await done;
    assert.equal(h.element('status-text').textContent, '已取消，清理完成');
    assert.equal(h.element('btn-adopt-roi').disabled, true);
    assert.equal(h.element('btn-apply').disabled, false);
    assert.equal(h.element('btn-cancel').disabled, true);
});
test('analysis progress shows frame throughput and stage progress without ETA', async () => {
    const h = await harness(); h.pick('A.mp4'); h.fire('btn-analyze');
    h.requests[0].args[2].onProgress({ stage: 'decode', ratio: 0.25,
        processed_frames: 100, total_frames: 400, processing_fps: 12.34, stage_ratio: 0.5 });
    const text = h.element('progress-text').textContent;
    assert.ok(text.includes('100/400 帧'));
    assert.ok(text.includes('12.3 帧/秒'));
    assert.ok(text.includes('当前阶段 50%'));
    assert.ok(!text.includes('ETA'));
    h.requests[0].resolve(result()); await flush();
});
test('partial source verification shows warning summary instead of green success', async () => {
    const h = await harness({ delayHost: true }); await h.ready();
    const done = h.fire('btn-apply');
    h.requests[1].resolve({ sequenceName: 'review', clipsInSequence: 1, subclipsCreated: 1,
        markersAdded: 0, verification: { ok: true, status: 'partial', sourcePointsVerified: false,
            warnings: ['源点坐标未确认'] }, warnings: ['音频完整性未确认'] });
    await done;
    assert.equal(h.element('dot').className, 'dot dot-warn');
    assert.ok(h.element('status-text').textContent.includes('源帧精度未完整验证'));
    assert.ok(h.element('status-text').textContent.includes('音频完整性未确认'));
    assert.ok(h.element('status-text').textContent.includes('源点坐标未确认'));
    assert.ok(h.element('log').textContent.includes('sourcePointsVerified'));
});
test('save project is explicit and calls the dedicated host API', async () => {
    const h = await harness(); await h.fire('btn-save-project');
    assert.ok(h.calls.some(c => c.call === 'Arknight.saveProject()'));
});
test('60fps EDL import is disabled and guarded', async () => {
    const h = await harness(); h.pick('A.mp4'); h.fire('btn-analyze');
    const r = result(); r.session.fps = 60; h.requests[0].resolve(r); await flush();
    assert.equal(h.element('btn-import-edl').disabled, true);
    await h.fire('btn-import-edl');
    assert.ok(!h.calls.some(c => c.call && c.call.includes('importEdl')));
});
test('actual HTML script dependencies load before controller and missing Node is visible', async () => {
    const scripts = Array.from(html.matchAll(/<script src="([^"]+)"/g), m => m[1]);
    for (const dependency of ['csinterface', 'bridge', 'preview-bridge', 'preview', 'timeline']) {
        assert.ok(scripts.indexOf('js/' + dependency + '.js') < scripts.indexOf('js/main.js'));
    }
    const h = await harness({ noNode: true });
    assert.equal(h.element('status-text').textContent, 'Node.js 不可用');
    assert.equal(h.requests.length, 0);
});
test('initialization exceptions become visible instead of unhandled rejection', async () => {
    const h = await harness({ initError: true });
    assert.equal(h.element('status-text').textContent, '面板初始化失败');
    assert.ok(h.element('log').textContent.includes('init denied'));
});
test('pre-analysis frame label uses preview metadata and distinguishes estimate from session', async () => {
    const h = await harness(); h.pick('A.mp4');
    h.previewPosition(1, { totalFrames: 12, metadataStatus: 'estimate' });
    assert.equal(h.element('frame-label').textContent, '源帧 1 / 11（预览估计，待分析确认）');
    h.previewPosition(1, { totalFrames: 100, metadataStatus: 'session' });
    assert.equal(h.element('frame-label').textContent, '源帧 1 / 99');
    h.previewPosition(0, { totalFrames: 0, metadataStatus: 'unknown' });
    assert.equal(h.element('frame-label').textContent, '源帧 0 / 未知');
});
test('saved runtime configuration reopens same media preview and restores session ranges', async () => {
    const h = await harness({ saveOK: true }); await h.ready();
    const before = h.calls.filter(c => c.kind === 'preview-open').length;
    h.fire('btn-save-cfg'); await flush();
    const opens = h.calls.filter(c => c.kind === 'preview-open');
    assert.equal(opens.length, before + 1);
    assert.equal(opens[opens.length - 1].path, 'A.mp4');
    const config = h.calls.filter(c => c.kind === 'preview-configure').pop();
    assert.equal(config.fps, 30); assert.equal(config.total, 100);
    assert.equal(config.ranges[0][1], 80);
    assert.equal(h.element('btn-apply').disabled, false);
});
test('failed settings save is visible and never announces success', async () => {
    const h = await harness(); h.fire('btn-save-cfg');
    assert.ok(h.element('status-text').textContent.includes('保存设置失败'));
    assert.ok(!h.element('log').textContent.includes('设置已保存'));
});
(async () => {
    for (const t of tests) {
        const timeout = setTimeout(() => {
            console.error('FAIL timed out: ' + t.name);
            process.exit(1);
        }, 5000);
        try { await t.fn(); console.log('PASS ' + t.name); }
        finally { clearTimeout(timeout); }
    }
    console.log(`${tests.length} main.js regression tests passed`);
})().catch(e => { console.error(e); process.exitCode = 1; });
