'use strict';
// Real short synthetic video only; never invokes analyze.
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-test-中文 空格-'));
const originalHome = os.homedir, originalTmpdir = os.tmpdir;
os.homedir = () => tmp;
// Force the actual worker JPEG and proxy cache roots through Unicode paths too.
os.tmpdir = () => tmp;
global.window = {};
require('../cep-extension/js/bridge.js');
require('../cep-extension/js/preview-bridge.js');
const bridge = window.ArknightBridge;
bridge.init(path.resolve(__dirname, '../cep-extension'));
const video = path.join(tmp, '短片 帧号测试.avi');
const instances = [];
let spawned = 0;
const workerSpawns = [];
const backend = path.resolve(__dirname, '../backend');
const spawn = cp.spawn;
cp.spawn = function (exe, args) {
    spawned++;
    if (args.includes(path.join(backend, 'preview_server.py'))) workerSpawns.push({ exe, args });
    return spawn.apply(this, arguments);
};
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn) {
    const end = Date.now() + 15000;
    while (!fn()) { if (Date.now() > end) throw new Error('Timed out'); await delay(15); }
}
function create(opts) {
    const frames = [], errors = [];
    const api = window.ArknightPreviewBridge.create(video, Object.assign({
        onFrame: msg => frames.push(msg), onError: e => errors.push(e)
    }, opts));
    instances.push(api);
    return { api, frames, errors };
}
async function seek(client, frame) {
    const id = client.api.seek(frame);
    await until(() => client.frames.some(f => f.requestId === id) || client.errors.some(e => e.requestId === id));
    const result = client.frames.find(f => f.requestId === id);
    assert.ok(result, JSON.stringify(client.errors));
    assert.strictEqual(result.frame, frame);
    return result;
}
(async () => {
    const exact = cp.execFileSync(process.env.PYTHON || 'python',
        ['-I', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).trim();
    assert.ok(path.isAbsolute(exact), 'Python must resolve to an absolute executable');
    assert.ok(bridge.paths.CONFIG_PATH.startsWith(tmp + path.sep), 'config must use isolated HOME');
    assert.strictEqual(bridge.saveConfig({ pythonPath: exact, cliDir: backend }), true);
    const py = await bridge.detectPython();
    assert.strictEqual(py.exe, exact, 'bridge must use the dependency interpreter, not a launcher default');
    assert.deepStrictEqual(py.preArgs, []);
    assert.strictEqual(bridge.getRuntimeConfig().cliDir, backend);
    const made = cp.spawnSync(py.exe, py.preArgs.concat(['-I', '-c',
        'import cv2,numpy as np,sys\nw=cv2.VideoWriter(sys.argv[1],cv2.VideoWriter_fourcc(*"MJPG"),10,(96,64))\nassert w.isOpened()\nfor i in range(12): w.write(np.full((64,96,3),i*20,dtype=np.uint8))\nw.release()', video]), { encoding: 'utf8' });
    assert.strictEqual(made.status, 0, made.stderr);
    const a = create(), b = create(), c = create({ channel: 'main' });
    a.api.seek(0); a.api.seek(9); const latest = a.api.seek(0);
    const bf = await seek(b, 5), cf = await seek(c, 11);
    await until(() => a.frames.length);
    assert.strictEqual(a.frames.length, 1); assert.strictEqual(a.frames[0].requestId, latest);
    assert.strictEqual(spawned, 1, 'same video must share one persistent worker');
    assert.strictEqual(bridge.getState().child, null, 'preview must not occupy analysis BUSY');
    assert.strictEqual(bf.totalFrames, 12);
    assert.strictEqual(bf.fps, 10);
    assert.strictEqual(bf.metadataStatus, 'estimate');
    assert.strictEqual(bf.fpsStatus, 'estimate');
    assert.strictEqual(bf.sourceWidth, 96);
    assert.strictEqual(bf.sourceHeight, 64);
    const dir = path.dirname(bf.path);
    for (const f of [a.frames[0], bf, cf]) {
        const checked = cp.spawnSync(py.exe, py.preArgs.concat(['-I', '-c',
            'import cv2,numpy as np,sys\nfrom pathlib import Path\na=cv2.imdecode(np.frombuffer(Path(sys.argv[1]).read_bytes(),dtype=np.uint8),cv2.IMREAD_COLOR); assert a.shape[:2]==(64,96); assert abs(float(a.mean())-int(sys.argv[2])*20)<4', f.path, String(f.frame)]), { encoding: 'utf8' });
        assert.strictEqual(checked.status, 0, checked.stderr);
    }
    for (let i = 0; i < 10; i++) await seek(a, i);
    assert.ok(fs.existsSync(bf.path) && fs.existsSync(cf.path), 'channels must not evict each other');
    assert.ok(fs.readdirSync(dir).length <= 8, 'six JPEGs per channel maximum');
    for (const frame of [-1, 1.5, 12, 99]) {
        const id = a.api.seek(frame);
        await until(() => a.errors.some(e => e.requestId === id));
        assert.ok(!a.frames.some(f => f.requestId === id));
    }
    await b.api.close(); assert.ok(!fs.existsSync(bf.path), 'channel close cleans its cache');
    const oldCount = c.frames.length;
    c.api.seek(2);
    const replacement = create({ channel: 'main' });
    await seek(replacement, 3);
    assert.strictEqual(c.frames.length, oldCount, 'replaced channel suppresses stale images');
    assert.strictEqual(spawned, 1);
    await Promise.all(instances.map(i => i.close()));
    assert.ok(!fs.existsSync(dir), 'last close cleans directory');
    const largeVideo = path.join(tmp, 'large.avi');
    const largeMade = cp.spawnSync(py.exe, py.preArgs.concat(['-I', '-c',
        'import cv2,numpy as np,sys\nw=cv2.VideoWriter(sys.argv[1],cv2.VideoWriter_fourcc(*"MJPG"),10,(1920,1080))\nassert w.isOpened()\nw.write(np.zeros((1080,1920,3),dtype=np.uint8))\nw.release()', largeVideo]), { encoding: 'utf8' });
    assert.strictEqual(largeMade.status, 0, largeMade.stderr);
    const largeFrames = [];
    const large = window.ArknightPreviewBridge.create(largeVideo, { onFrame: f => largeFrames.push(f), onError: e => { throw e; } });
    instances.push(large); large.seek(0); await until(() => largeFrames.length);
    assert.strictEqual(largeFrames[0].width, 1280);
    assert.strictEqual(largeFrames[0].height, 720);
    assert.strictEqual(largeFrames[0].sourceWidth, 1920);
    assert.strictEqual(largeFrames[0].sourceHeight, 1080);
    await large.close();
    assert.strictEqual(workerSpawns.length, 2, 'both videos must launch the repository preview worker');
    for (const worker of workerSpawns) {
        assert.strictEqual(worker.exe, exact, 'preview worker must use the dependency interpreter');
        assert.deepStrictEqual(worker.args.slice(0, 2), ['-u', path.join(backend, 'preview_server.py')]);
    }
    bridge.saveConfig({ pythonPath: path.join(tmp, 'missing-python') });
    assert.strictEqual((await bridge.detectPython()).exe, null, 'explicit invalid Python must not fall back');
    console.log('PASS: exact pixels/frame numbers, A-B-A latest, shared worker, channel isolation, bounds/EOF, close/replacement cleanup, explicit Python failure');
    const preview = window.ArknightPreviewBridge;
    const av = path.join(tmp, 'audio-video.mkv');
    const generated = cp.spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24:duration=2',
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2',
        '-c:v', 'ffv1', '-c:a', 'pcm_s16le', av], { encoding: 'utf8' });
    assert.strictEqual(generated.status, 0, generated.stderr);
    const p1 = preview.ensureProxy(av), p2 = preview.preparePlayback(av);
    const startCount = spawned;
    const results = await Promise.all([p1, p2]);
    assert.strictEqual(results[0].path, results[1].path);
    assert.strictEqual(spawned - startCount, 1, 'concurrent proxies share one FFmpeg');
    assert.strictEqual(bridge.getState().child, null);
    const probe = cp.spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', results[0].path], { encoding: 'utf8' });
    assert.strictEqual(probe.status, 0, probe.stderr);
    const info = JSON.parse(probe.stdout);
    const vs = info.streams.find(s => s.codec_type === 'video'), as = info.streams.find(s => s.codec_type === 'audio');
    assert.strictEqual(vs.codec_name, 'h264'); assert.strictEqual(vs.pix_fmt, 'yuv420p');
    assert.strictEqual(vs.avg_frame_rate, '24/1'); assert.strictEqual(as.codec_name, 'aac');
    for (const seconds of [vs.duration, as.duration, info.format.duration]) assert.ok(Math.abs(Number(seconds) - 2) < 0.1);
    await results[0].cleanup(); assert.ok(fs.existsSync(results[1].path), 'another lease retains cache');
    const again = await preview.ensureProxy(av); assert.strictEqual(again.cached, true);
    await preview.cancelPlayback(av); assert.ok(!fs.existsSync(again.path));
    const cancelled = preview.ensureProxy(av);
    const rejection = assert.rejects(cancelled, e => e.code === 'CANCELLED');
    await cancelled.cancel(); await rejection;
    const beforeRunning = spawned;
    const running = preview.ensureProxy(av);
    const runningResult = running.then(value => ({ value }), failure => ({ failure }));
    await until(() => spawned > beforeRunning);
    await running.cancel();
    const stopped = await runningResult;
    if (stopped.failure) assert.strictEqual(stopped.failure.code, 'CANCELLED');
    else assert.ok(!fs.existsSync(stopped.value.path));
    await assert.rejects(preview.ensureProxy(av, { ffmpegPath: path.join(tmp, 'missing-ffmpeg') }), e => e.code === 'NO_FFMPEG');
    const silent = await preview.ensureProxy(video);
    const silentProbe = cp.spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', silent.path], { encoding: 'utf8' });
    assert.strictEqual(JSON.parse(silentProbe.stdout).streams.filter(s => s.codec_type === 'audio').length, 0);
    await silent.cleanup();
    console.log('PASS: H264/AAC proxy, 24fps, video/audio/container durations 2s, lease cache, cancellation, missing FFmpeg, silent source');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
    await Promise.all(instances.map(i => i.close()));
    cp.spawn = spawn; os.homedir = originalHome; os.tmpdir = originalTmpdir;
    fs.rmSync(tmp, { recursive: true, force: true });
});
