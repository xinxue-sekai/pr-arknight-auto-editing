'use strict';

// Run the actual JSX in an isolated mock host; no Premiere or media writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../cep-extension/hostscript.jsx'), 'utf8');
const TPS = 254016000000;
let passed = 0;

function run(options = {}, legacy = false) {
    const payload = {
        mediaPath: 'D:/media/source.mp4', fps: 30,
        ranges: [[0, 30], [60, 120], [150, 180]],
        markers: [{ record_start: 30, record_end: 90, name: 'second clip' }],
        sourceOffsetTicks: '100', sequenceName: 'test',
        ...options.payload
    };
    const calls = { subclips: [], sequences: 0, fallback: 0, markers: [], opened: [], moved: [], overwrite: [] };
    const targetBin = { type: 'BIN', name: 'ArknightAutoEditing' };
    const src = {
        name: 'source',
        getAudioChannelMapping() {
            if (options.audioUnknown || options.subclipAudio !== undefined) throw new Error('unavailable');
            return { audioClipsNumber: options.silent ? 0 : 1 };
        },
        createSubClip(name, start, end, hard, video, audio) {
            const index = calls.subclips.length;
            calls.subclips.push({ name, start, end, hard, video, audio });
            if (options.fail === 'all' || options.fail === index) {
                if (options.throws) throw new Error('host subclip failure');
                return null;
            }
            return {
                name, index, nodeId: 'sub-' + index,
                getAudioChannelMapping() {
                    if (options.subclipAudio === undefined) throw new Error('unavailable');
                    return { audioClipsNumber: options.subclipAudio ? 1 : 0 };
                },
                getInPoint() { return { ticks: start }; },
                getOutPoint() { return { ticks: end }; },
                moveBin(bin) {
                    assert.equal(bin, targetBin);
                    if (options.moveThrows) throw new Error('move failure');
                    calls.moved.push(index);
                }
            };
        }
    };
    const seq = {
        name: 'test', sequenceID: 'new-sequence', end: String(TPS * 4), timebase: String(TPS / 30),
        videoTracks: [{ clips: { numItems: 3 }, overwriteClip(item, tick) { calls.overwrite.push([item.index, tick]); } }],
        markers: { createMarker(seconds) {
            const marker = { seconds, end: {}, setColorByIndex() {} };
            calls.markers.push(marker);
            return marker;
        } }
    };
    const time = ticks => ({ ticks: String(Math.round(ticks)) });
    let cursor = 0;
    const clips = payload.ranges.map((range, index) => {
        const duration = (range[1] - range[0]) * TPS / payload.fps;
        const clip = { projectItem: { nodeId: 'sub-' + index },
            inPoint: time(range[0] * TPS / payload.fps + Number(payload.sourceOffsetTicks)),
            outPoint: time(range[1] * TPS / payload.fps + Number(payload.sourceOffsetTicks)),
            duration: time(duration), start: time(cursor), end: time(cursor + duration) };
        cursor += duration;
        return clip;
    });
    clips.numItems = clips.length;
    seq.videoTracks[0].clips = clips;
    seq.videoTracks.numTracks = 1;
    const audio = clips.map(clip => JSON.parse(JSON.stringify(clip)));
    audio.numItems = audio.length;
    seq.audioTracks = [{ clips: audio }];
    seq.audioTracks.numTracks = 1;
    for (const clip of [...clips, ...audio]) clip.projectItem.getMediaPath = () => payload.mediaPath;
    if (options.silent) seq.audioTracks.numTracks = 0;
    seq.end = String(Math.round(cursor));
    seq.timebase = String(TPS / (options.actualFps || payload.fps));
    if (options.mutate) options.mutate(seq);
    const project = {
        path: options.unnamed ? '' : 'D:/projects/existing.prproj',
        save() {
            calls.saves = (calls.saves || 0) + 1;
            if (options.saveThrows) throw new Error('disk full');
            return Object.prototype.hasOwnProperty.call(options, 'saveResult') ? options.saveResult : 0;
        },
        rootItem: {
            children: { 0: targetBin, numItems: 1 },
            findItemsMatchingMediaPath() { return [src]; }
        },
        createNewSequenceFromClips(name, clips, bin) {
            calls.sequences++;
            assert.equal(bin, targetBin);
            calls.assembled = Array.from(clips, clip => clip.index);
            if (options.sequenceThrows) throw new Error('sequence failure');
            return seq;
        },
        createNewSequence() { calls.fallback++; return options.fallbackFails ? null : seq; },
        sequences: { numSequences: 0 },
        importFiles() { return true; },
        openSequence(id) { calls.opened.push(id); }
    };
    // Unexpected deletion or source edits have no mock implementation and fail the test.
    const context = vm.createContext({
        app: { project, setSDKEventMessage() {} },
        File: function () {
            this.exists = !options.missingPayload;
            this.open = () => true;
            this.read = () => JSON.stringify(payload);
            this.close = () => {};
        }
    });
    if (legacy) {
        vm.runInContext('JSON = undefined; Array.prototype.forEach = undefined; Array.prototype.map = undefined; Array.prototype.filter = undefined; Object.keys = undefined;', context);
    }
    vm.runInContext(source, context, { filename: 'hostscript.jsx' });
    if (options.noProject) context.app.project = null;
    if (options.noSave) delete project.save;
    const result = JSON.parse(vm.runInContext(options.operation || 'Arknight.applyEdit("payload.json")', context));
    return { result, calls };
}

function noAssembly(calls) {
    assert.equal(calls.sequences, 0);
    assert.equal(calls.fallback, 0);
    assert.deepEqual(calls.markers, []);
    assert.deepEqual(calls.opened, []);
    assert.deepEqual(calls.overwrite, []);
}

function test(name, fn) {
    fn();
    passed++;
    console.log('PASS ' + name);
}

for (const legacy of [false, true]) {
    const suffix = legacy ? ' (ES3 JSON polyfill)' : ' (native JSON)';
    test('complete assembly preserves order, ticks and marker position' + suffix, () => {
        const { result, calls } = run({}, legacy);
        assert.equal(result.ok, true);
        assert.equal(result.subclipsCreated, 3);
        assert.equal(result.clipsInSequence, 3);
        assert.equal(result.clipsFailed, 0);
        assert.equal(result.markersAdded, 1);
        assert.deepEqual(calls.assembled, [0, 1, 2]);
        assert.equal(calls.sequences, 1);
        assert.equal(calls.fallback, 0);
        assert.equal(calls.subclips[1].start, String(TPS * 2 + 100));
        assert.equal(calls.subclips[1].end, String(TPS * 4 + 100));
        assert.equal(calls.markers[0].seconds, 1);
        assert.equal(calls.markers[0].end.seconds, 3);
        assert.deepEqual(calls.opened, ['new-sequence']);
    });
    for (const fail of [0, 1, 2]) {
        for (const throws of [false, true]) {
            test('subclip ' + fail + ' ' + (throws ? 'throws' : 'returns null') + suffix, () => {
                const { result, calls } = run({ fail, throws }, legacy);
                assert.equal(result.ok, false);
                assert.equal(result.stage, 'applyEdit');
                assert.match(result.error, /已停止拼装/);
                assert.equal(result.subclipsCreated, 2);
                assert.equal(result.clipsFailed, 1);
                assert.equal(result.failedDetail[0].index, fail);
                assert.equal(result.markersAdded, 0);
                noAssembly(calls);
            });
        }
    }
    test('all subclips fail without unconditional EDL guidance' + suffix, () => {
        const { result, calls } = run({ fail: 'all' }, legacy);
        assert.equal(result.ok, false);
        assert.match(result.error, /所有子剪辑创建均失败/);
        assert.doesNotMatch(result.error, /EDL/);
        noAssembly(calls);
    });
    test('invalid interval blocks assembly' + suffix, () => {
        const { result, calls } = run({ payload: { ranges: [[0, 0], [60, 120]] } }, legacy);
        assert.equal(result.ok, false);
        assert.equal(result.failedDetail[0].index, 0);
        noAssembly(calls);
    });
    test('bin move failure remains nonfatal' + suffix, () => {
        assert.equal(run({ moveThrows: true }, legacy).result.ok, true);
    });
    test('complete clips still use overwrite fallback' + suffix, () => {
        const { result, calls } = run({ sequenceThrows: true }, legacy);
        assert.equal(result.ok, true);
        assert.equal(calls.fallback, 1);
        assert.deepEqual(calls.overwrite, [[0, '0'], [1, String(TPS)], [2, String(TPS * 3)]]);
    });
    test('both assembly paths fail retains failure response' + suffix, () => {
        const { result, calls } = run({ sequenceThrows: true, fallbackFails: true }, legacy);
        assert.equal(result.ok, false);
        assert.match(result.error, /无法创建目标序列/);
        assert.deepEqual(calls.markers, []);
    });
    for (const fps of [60, 60000 / 1001]) {
        test('single-frame edits and nonzero markers at ' + fps + suffix, () => {
            const { result, calls } = run({ payload: { fps, ranges: [[120, 121], [240, 241]],
                markers: [{ record_start: 1, record_end: 2 }] } }, legacy);
            assert.equal(result.ok, true);
            assert.equal(result.verification.status, 'partial');
            assert.equal(result.verification.frameAccurate, false);
            assert.equal(result.verification.videoClipCount, 2);
            assert.equal(result.verification.audioClipCount, 2);
            assert.equal(calls.markers[0].seconds, 1 / fps);
            assert.equal(calls.markers[0].end.seconds, 2 / fps);
        });
    }
    for (const [name, options] of [
        ['wrong fps', { actualFps: 25 }],
        ['wrong media path', { mutate(seq) { seq.videoTracks[0].clips[1].projectItem.getMediaPath = () => 'D:/wrong.mp4'; } }],
        ['one frame duration', { mutate(seq) { seq.audioTracks[0].clips[0].duration.ticks = String(TPS + TPS / 30); } }],
        ['wrong order', { mutate(seq) { const c = seq.videoTracks[0].clips; [c[0], c[1]] = [c[1], c[0]]; } }],
        ['missing audio', { mutate(seq) { seq.audioTracks.numTracks = 0; } }],
        ['missing video clip', { mutate(seq) { seq.videoTracks[0].clips.numItems = 2; } }],
        ['unreadable media path', { mutate(seq) { delete seq.audioTracks[0].clips[0].projectItem.getMediaPath; } }],
        ['wrong end', { mutate(seq) { seq.end = String(TPS * 10); } }],
        ['fallback wrong fps', { sequenceThrows: true, actualFps: 24 }]
    ]) {
        test(name + ' cannot report success' + suffix, () => {
            const { result, calls } = run(options, legacy);
            assert.equal(result.ok, false);
            assert.equal(result.stage, 'verification');
            assert.equal(result.verification.status, 'failed');
            assert.ok(result.verification.failures.length);
            assert.equal(result.markersAdded, 0);
            assert.deepEqual(calls.markers, []);
        });
    }
    for (const options of [
        { silent: true }, { silent: true, sequenceThrows: true },
        { silent: true, subclipAudio: false }, { silent: true, audioUnknown: true },
        { audioUnknown: true }
    ]) {
        test('silent/unknown audio supports output ' + JSON.stringify(options) + suffix, () => {
            const { result, calls } = run(options, legacy);
            assert.equal(result.ok, true);
            assert.equal(result.verification.status, 'partial');
            assert.equal(result.verification.expectedAudio, options.audioUnknown ? null : false);
            assert.equal(result.verification.audioClipCount, options.silent ? 0 : 3);
            assert.equal(result.verification.sourcePointsVerified, false);
            assert.equal(result.verification.frameAccurate, false);
            assert.equal(calls.markers.length, 1);
            assert.ok(result.warnings.length);
        });
    }
    test('subclip audio evidence detects missing audio' + suffix, () => {
        const { result } = run({ silent: true, subclipAudio: true }, legacy);
        assert.equal(result.ok, false);
        assert.equal(result.verification.expectedAudio, true);
        assert.equal(result.verification.audioEvidence, 'subclip-channel-mapping');
    });
    for (const mode of ['original-media', 'subclip-relative', 'missing', 'shifted']) {
        test('source coordinate mode is not guessed: ' + mode + suffix, () => {
            const { result } = run({ mutate(seq) {
                for (const tracks of [seq.videoTracks, seq.audioTracks]) {
                    for (const clip of tracks[0].clips) {
                        if (mode === 'subclip-relative') {
                            clip.inPoint.ticks = '0'; clip.outPoint.ticks = clip.duration.ticks;
                        } else if (mode === 'missing') { delete clip.inPoint; delete clip.outPoint; }
                        else if (mode === 'shifted') {
                            clip.inPoint.ticks = String(Number(clip.inPoint.ticks) + TPS / 30);
                        }
                    }
                }
            } }, legacy);
            assert.equal(result.ok, true);
            assert.equal(result.verification.sourcePointMode, 'source-coordinates-unverified');
            assert.equal(result.verification.frameAccurate, false);
            assert.equal(result.verification.status, 'partial');
            assert.ok(result.warnings.length);
        });
    }
    for (const fps of [0, -1, 'invalid']) {
        test('invalid payload fps ' + fps + suffix, () => {
            const { result, calls } = run({ payload: { fps } }, legacy);
            assert.equal(result.ok, false);
            noAssembly(calls);
            assert.equal(calls.subclips.length, 0);
        });
    }
    test('save existing project explicitly' + suffix, () => {
        const { result, calls } = run({ operation: 'Arknight.saveProject()' }, legacy);
        assert.equal(result.ok, true);
        assert.equal(result.saved, true);
        assert.equal(result.path, 'D:/projects/existing.prproj');
        assert.equal(calls.saves, 1);
    });
    test('Premiere 25.3 boolean true save result is successful and diagnostic' + suffix, () => {
        const { result } = run({ operation: 'Arknight.saveProject()', saveResult: true }, legacy);
        assert.equal(result.ok, true); assert.equal(result.saved, true);
        assert.equal(result.saveResult, true);
    });
    for (const options of [{ saveResult: 1 }, { saveResult: false }, { saveResult: undefined },
        { saveThrows: true }, { unnamed: true }, { noProject: true }, { noSave: true }]) {
        test('save failure ' + JSON.stringify(options) + suffix, () => {
            const { result, calls } = run({ ...options, operation: 'Arknight.saveProject()' }, legacy);
            assert.equal(result.ok, false);
            assert.equal(result.saved, false);
            assert.equal(result.stage, 'saveProject');
            assert.ok(result.error);
            if (options.unnamed || options.noProject || options.noSave) assert.equal(calls.saves, undefined);
        });
    }
    test('EDL accepted is explicitly unverified including 60/59.94' + suffix, () => {
        const { result } = run({ operation: 'Arknight.importEdl("test.edl")' }, legacy);
        assert.equal(result.ok, true);
        assert.equal(result.reliable, false);
        assert.equal(result.verification.status, 'unverified');
        assert.match(result.warnings[0], /60\/59.94/);
    });
    test('empty ranges and unreadable payload retain failure handling' + suffix, () => {
        const empty = run({ payload: { ranges: [] } }, legacy);
        assert.equal(empty.result.stage, 'validate');
        noAssembly(empty.calls);
        const missing = run({ missingPayload: true }, legacy);
        assert.equal(missing.result.stage, '读取载荷');
        noAssembly(missing.calls);
    });
}
test('numeric ProjectItemType bins recurse and existing target bin is reused', () => {
    const context = vm.createContext({});
    vm.runInContext(source, context);
    const a = context.Arknight;
    const media = { type: 1, name: 'source', getMediaPath: () => 'D:/source.mp4', isSequence: () => false };
    const bin = { type: 2, name: 'ArknightAutoEditing', children: { 0: media, numItems: 1 } };
    const root = { type: 3, children: { 0: bin, numItems: 1 }, createBin() { throw new Error('duplicate bin'); } };
    assert.equal(a._findByPath(root, 'D:/source.mp4', 0), media);
    assert.equal(a._firstMediaItem(root, 0).mediaPath, 'D:/source.mp4');
    assert.equal(a._anyMediaItem(root, 0), media);
    assert.equal(a._ensureBin({ rootItem: root }, bin.name), bin);
});
console.log(passed + ' hostscript tests passed.');
