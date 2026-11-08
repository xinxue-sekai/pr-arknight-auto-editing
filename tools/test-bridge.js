#!/usr/bin/env node
/**
 * test-bridge.js —— bridge.js 的行为测试（零依赖）
 *
 * 运行：node tools/test-bridge.js
 *
 * 测试策略：不改 bridge.js 一行生产代码。
 *   · bridge.js 是 IIFE，加载时挂 window.ArknightBridge —— 测试在 require
 *     之前注入 global.window，模拟 CEP 的 mixed-context 环境。
 *   · runCli spawn 的是 state.python.exe，且把 state.cliPath 作为脚本参数。
 *     把一个「由 Node 执行的假 CLI」（命名 pr_cli.cjs —— Node 20.6+ 拒绝
 *     执行 .py 后缀的主脚本）放进隔离的临时 HOME，就能用真实子进程流重现
 *     NDJSON 的全部边界：
 *     末行无换行、单行跨 chunk、UTF-8 多字节被拆开、超大 JSON 跨 chunk、
 *     stderr 噪声、取消 / 超时 / 错误码。
 *   · os.homedir() 在 require 之前被重定向到临时目录，测试不碰真实
 *     ~/.arknight-pr。
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

// ------------------------------------------------------------------
//  环境隔离：必须在 require bridge.js 之前完成
// ------------------------------------------------------------------

let TMP;
try {
    TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'arknight-bridge-test-'));
} catch (e) {
    // 沙箱可能禁写系统临时目录，退到仓库内（已在 .gitignore）
    const root = path.resolve(__dirname, '..');
    TMP = fs.mkdtempSync(path.join(root, '_tmp_test', 'bridge-'));
}
// os.homedir() 在 win32 读 USERPROFILE，POSIX 读 HOME —— 两个都改
process.env.USERPROFILE = TMP;
process.env.HOME = TMP;

if (typeof global.window === 'undefined') {
    global.window = {}; // 模拟 CEP mixed-context 的 window
}
const B = require('../cep-extension/js/bridge.js');
const bridge = global.window.ArknightBridge;

// ------------------------------------------------------------------
//  假 CLI：被 node 当脚本执行的 pr_cli.cjs（后缀必须是 Node 认识的）
// ------------------------------------------------------------------

const FAKE_CLI = `'use strict';
const mode = process.argv[2];
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
    if (mode === 'ok') {
        process.stdout.write('NOTJSON plain text\\n'); // stdout 非 JSON 行 —— 应被忽略
        process.stderr.write('libpng warning: iostream error\\n'); // stderr → onLog
        process.stdout.write(JSON.stringify({ type: 'progress', msg: '10%' }) + '\\n');
        process.stdout.write(JSON.stringify({ type: 'result', ok: true, value: 42 }) + '\\n');
        process.stdout.write('   '); // 末尾空白、无换行的非 JSON —— 应被忽略
    } else if (mode === 'noeol') {
        process.stdout.write(JSON.stringify({ type: 'progress', msg: 'a' }) + '\\n');
        process.stdout.write(JSON.stringify({ type: 'result', ok: true, last: true })); // 无换行
    } else if (mode === 'split') {
        const line = JSON.stringify({ type: 'result', ok: true, split: true });
        const parts = [line.slice(0, 10), line.slice(10, 25), line.slice(25)];
        for (const p of parts) { process.stdout.write(p); await sleep(40); }
    } else if (mode === 'utf8split') {
        const line = JSON.stringify({ type: 'result', ok: true, note: '明日方舟自动剪辑\\u2702' });
        const buf = Buffer.from(line, 'utf8');
        const cut = buf.length - 4; // 落在 ✂(U+2702, 3 字节 UTF-8) 的第 2 字节上
        process.stdout.write(buf.slice(0, cut));
        await sleep(40);
        process.stdout.write(buf.slice(cut));
    } else if (mode === 'huge') {
        const line = JSON.stringify({ type: 'result', ok: true, mask: 'x'.repeat(2 * 1024 * 1024) });
        const buf = Buffer.from(line, 'utf8');
        const CHUNK = 64 * 1024; // 管道缓冲通常 64KB，强制跨 chunk
        for (let i = 0; i < buf.length; i += CHUNK) {
            process.stdout.write(buf.slice(i, i + CHUNK));
            await sleep(1);
        }
    } else if (mode === 'stderr') {
        process.stderr.write('WARNING: some diagnostic\\n');
        process.stdout.write(JSON.stringify({ type: 'progress', msg: 'p' }) + '\\n');
        process.stderr.write('more noise\\n');
        process.stdout.write(JSON.stringify({ type: 'result', ok: true, noise: true }) + '\\n');
    } else if (mode === 'clierr') {
        process.stdout.write(JSON.stringify({ type: 'error', code: 'MISSING_TEMPLATE', message: '模板加载失败', detail: 'stack here' }) + '\\n');
        process.exit(1);
    } else if (mode === 'noresult') {
        process.stderr.write('Traceback (most recent call last):\\n  boom\\n');
        process.exit(3);
    } else if (mode === 'suggest-content-rect') {
        process.stdout.write(JSON.stringify({ type: 'progress', args: process.argv.slice(2) }) + '\\n');
        await sleep(100);
        process.stdout.write(JSON.stringify({ type: 'result', suggestion: { rect: [10, 20, 300, 200], confidence: 0.9 } }) + '\\n');
    } else if (mode === 'tree') {
        const child = require('child_process').spawn(process.execPath,
            ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'],
            { stdio: 'inherit' });
        process.on('SIGTERM', () => {});
        process.stdout.write(JSON.stringify({ type: 'progress', pid: child.pid }) + '\\n');
        setInterval(() => {}, 1000);
    } else if (['analyze', 'ranges', 'export-edl'].includes(mode)) {
        const files = {};
        for (const flag of ['--params', '--session-params', '--overrides']) {
            const i = process.argv.indexOf(flag);
            if (i >= 0) files[flag] = process.argv[i + 1];
        }
        process.stdout.write(JSON.stringify({ type: 'progress', files }) + '\\n');
        await sleep(100);
        const values = {};
        for (const flag in files) values[flag] = JSON.parse(require('fs').readFileSync(files[flag], 'utf8'));
        process.stdout.write(JSON.stringify({ type: 'result', files, values }) + '\\n');
    } else if (mode === 'hang') {
        setInterval(() => {}, 1000); // 永不退出，等测试杀掉
    }
})().catch(e => { console.error(e); process.exit(9); });
`;

// ------------------------------------------------------------------
//  测试骨架
// ------------------------------------------------------------------

const sleep = ms => new Promise(r => setTimeout(r, ms));
let passed = 0, failed = 0;
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

async function runMode(mode, opts) {
    const logs = [];
    const progress = [];
    const result = await bridge.runCli([mode], Object.assign({
        onLog: s => logs.push(s),
        onProgress: m => progress.push(m)
    }, opts || {}));
    return { result, logs, progress };
}

// ------------------------------------------------------------------
//  纯函数与配置
// ------------------------------------------------------------------

test('CODE 常量完整导出', async () => {
    for (const c of ['NO_PYTHON', 'NO_CLI', 'SPAWN_FAILED', 'BUSY', 'CANCELLED', 'TIMEOUT', 'CLI_ERROR', 'NO_RESULT']) {
        assert.strictEqual(bridge.CODE[c], c, '缺少错误码 ' + c);
    }
});

test('sessionPathFor：稳定且清洗文件名', async () => {
    const a = bridge.sessionPathFor('D:\\录屏\\game 01.mp4');
    const b = bridge.sessionPathFor('D:\\录屏\\game 01.mp4');
    assert.strictEqual(a, b, '同一输入应得到同一路径');
    const base = path.basename(a);
    assert.ok(base.endsWith('.json'), '应以 .json 结尾');
    assert.ok(!/[\\/:*?"<>| ]/.test(base.replace(/\.json$/, '')), '基名不应含非法字符或空格: ' + base);
    const c = bridge.sessionPathFor('D:\\录屏\\game 02.mp4');
    assert.notStrictEqual(a, c, '不同输入应得到不同路径');
});

test('defaultEdlPath：与源视频同目录加后缀', async () => {
    // 用平台分隔符构造路径 —— 测的是「同目录 + 加后缀」这个语义，
    // 不是特定平台的字符串形式（path.dirname 在 Linux 上不认 \，
    // 写死 Windows 字符串会让 CI 在 ubuntu 上必败，2026-11-07 踩过）
    const video = ['D:', 'v', 'rec.mp4'].join(path.sep);
    assert.strictEqual(
        bridge.defaultEdlPath(video),
        path.join(path.dirname(video), 'rec_autoedit.edl'));
    const noext = ['D:', 'v', 'no_ext'].join(path.sep);
    assert.strictEqual(
        bridge.defaultEdlPath(noext),
        path.join(path.dirname(noext), 'no_ext_autoedit.edl'));
});

test('writePayload / readJsonFile 往返', async () => {
    const p = bridge.writePayload('test.json', { arr: [1, 2, 3], 中文: '值' });
    assert.ok(bridge.fileExists(p), '载荷文件应存在');
    assert.deepStrictEqual(bridge.readJsonFile(p), { arr: [1, 2, 3], 中文: '值' });
    assert.ok(p.startsWith(TMP), '载荷应写在隔离的家目录里');
});

test('saveConfig / getConfig 持久化', async () => {
    assert.strictEqual(bridge.saveConfig({ cliDir: 'X:\\analyzer' }), true);
    assert.strictEqual(bridge.getConfig().cliDir, 'X:\\analyzer');
    assert.ok(bridge.fileExists(bridge.paths.CONFIG_PATH), 'config.json 应已写出');
    assert.ok(bridge.paths.CONFIG_PATH.startsWith(TMP), 'config 应写在隔离的家目录里');
});

test('saveConfig failure preserves persisted config and cached Python', async () => {
    const previous = bridge.getConfig(), python = { exe: 'cached' };
    bridge.getState().python = python;
    const write = fs.writeFileSync;
    fs.writeFileSync = function (file) {
        if (file === bridge.paths.CONFIG_PATH) throw new Error('disk full');
        return write.apply(this, arguments);
    };
    try {
        assert.strictEqual(bridge.saveConfig({ pythonPath: 'not-saved' }), false);
        assert.strictEqual(bridge.getConfig(), previous);
        assert.strictEqual(bridge.getState().python, python);
    } finally { fs.writeFileSync = write; }
});

test('loadConfig 兼容带 BOM 的 config.json（PS 5.1 的 install.ps1 会写出）', async () => {
    fs.writeFileSync(bridge.paths.CONFIG_PATH,
        '\ufeff{"cliDir":"X:\\\\from-bom","pythonPath":null}', 'utf8');
    bridge.init('some-ext-dir');   // init 内部走 loadConfig
    assert.strictEqual(bridge.getConfig().cliDir, 'X:\\from-bom',
        '带 BOM 的配置不应被静默忽略');
    // init 会按新 config 重算并清空 cliPath/python 派生字段，
    // 必须恢复现场，否则后续 runCli 系列测试全部 NO_CLI
    setup();
});

test('fileExists：存在与不存在', async () => {
    assert.strictEqual(bridge.fileExists(TMP), true);
    assert.strictEqual(bridge.fileExists(path.join(TMP, 'no_such_file')), false);
    assert.strictEqual(bridge.fileExists(''), false);
    assert.strictEqual(bridge.fileExists(null), false);
});

// ------------------------------------------------------------------
//  runCli：NDJSON 流的边界（真实子进程）
// ------------------------------------------------------------------

test('正常流：progress 回调、非 JSON 行被忽略、result 返回', async () => {
    const { result, progress, logs } = await runMode('ok');
    assert.deepStrictEqual(result, { type: 'result', ok: true, value: 42 });
    assert.deepStrictEqual(progress, [{ type: 'progress', msg: '10%' }]);
    assert.ok(logs.join('').includes('libpng'), 'stderr 应进入 onLog');
});

test('末行无换行符仍被解析', async () => {
    const { result } = await runMode('noeol');
    assert.deepStrictEqual(result, { type: 'result', ok: true, last: true });
});

test('单行跨多次写入仍只解析一次', async () => {
    const { result } = await runMode('split');
    assert.deepStrictEqual(result, { type: 'result', ok: true, split: true });
});

test('UTF-8 多字节字符被拆到两个 chunk 仍完整', async () => {
    // ✂(U+2702) 的 3 个 UTF-8 字节被切开，靠 StringDecoder 重组
    const { result } = await runMode('utf8split');
    assert.strictEqual(result.note, '明日方舟自动剪辑\u2702');
});

test('2MB 超大 JSON 跨 chunk 不损坏', async () => {
    const { result } = await runMode('huge');
    assert.strictEqual(result.mask.length, 2 * 1024 * 1024);
    assert.ok(result.mask[0] === 'x' && result.mask[result.mask.length - 1] === 'x');
});

test('stderr 噪声不影响结果且逐段转发 onLog', async () => {
    const { result, logs } = await runMode('stderr');
    assert.deepStrictEqual(result, { type: 'result', ok: true, noise: true });
    const all = logs.join('');
    assert.ok(all.includes('WARNING: some diagnostic'), '第一段 stderr 应转发');
    assert.ok(all.includes('more noise'), '第二段 stderr 应转发');
});

test('{"type":"error"} → CLI_ERROR，带 detail', async () => {
    await assert.rejects(
        bridge.runCli(['clierr']),
        e => e.code === 'CLI_ERROR' && e.backendCode === 'MISSING_TEMPLATE' && /模板加载失败/.test(e.message) && e.detail === 'stack here');
});

test('退出但无 result → NO_RESULT，带 stderr 尾部', async () => {
    await assert.rejects(
        bridge.runCli(['noresult']),
        e => e.code === 'NO_RESULT' && e.stderrTail.includes('Traceback'));
});

test('取消运行中的分析 → CANCELLED', async () => {
    const p = bridge.runCli(['hang']);
    for (let i = 0; i < 30 && !bridge.getState().child; i++) { await sleep(50); }
    assert.ok(bridge.getState().child, '子进程应已在运行');
    assert.strictEqual(bridge.cancel(), true);
    await assert.rejects(p, e => e.code === 'CANCELLED');
    assert.strictEqual(bridge.getState().child, null, '取消后应释放进程句柄');
    assert.strictEqual(bridge.cancel(), false, '无运行中进程时 cancel 返回 false');
});

test('超时 → TIMEOUT，且随后仍可正常调用', async () => {
    const t0 = Date.now();
    await assert.rejects(
        bridge.runCli(['hang'], { timeoutMs: 400 }),
        e => e.code === 'TIMEOUT' && /超时/.test(e.message));
    assert.ok(Date.now() - t0 < 6000, '超时应大致在 timeoutMs 附近触发');
    const { result } = await runMode('ok');
    assert.strictEqual(result.value, 42, '超时后的新调用应正常');
});

test('取消后立即启动被 BUSY 拒绝，旧任务结束后可再启动', async () => {
    const first = bridge.runCli(['hang']);
    const rejected = assert.rejects(first, e => e.code === 'CANCELLED');
    const child = bridge.getState().child;
    bridge.cancel();
    await assert.rejects(bridge.runCli(['ok']), e => e.code === 'BUSY');
    assert.strictEqual(bridge.getState().child, child);
    await rejected;
    assert.strictEqual((await runMode('ok')).result.value, 42);
});

test('suggestContentRect：参数/回调透传、提取 suggestion、独占 BUSY 和取消', async () => {
    const progress = [];
    const video = path.join(TMP, '中文 素材.mp4');
    const pending = bridge.suggestContentRect(video, { onProgress: msg => progress.push(msg) });
    await assert.rejects(bridge.runCli(['ok']), e => e.code === 'BUSY');
    await assert.rejects(bridge.suggestContentRect(video), e => e.code === 'BUSY');
    assert.deepStrictEqual(await pending, { rect: [10, 20, 300, 200], confidence: 0.9 });
    assert.deepStrictEqual(progress[0].args, ['suggest-content-rect', '--video', video]);
    const cancelled = bridge.suggestContentRect(video);
    bridge.cancel();
    await assert.rejects(cancelled, e => e.code === 'CANCELLED');
    await assert.rejects(bridge.suggestContentRect(video, { timeoutMs: 1 }), e => e.code === 'TIMEOUT');
});

test('所有业务入口拒绝并发，参数独立且成功/取消/失败后清理', async () => {
    const sentinel = bridge.writePayload('params.json', { host: true });
    const first = bridge.analyze('movie.mp4', { own: 1 });
    for (const call of [() => bridge.probe('other'),
        () => bridge.suggestContentRect('other'),
        () => bridge.analyze('other', { own: 2 }),
        () => bridge.recompute('session', { other: true }, {}),
        () => bridge.exportEdl('session', 'out', '', [])]) {
        await assert.rejects(call(), e => e.code === 'BUSY');
    }
    const a = await first;
    assert.deepStrictEqual(a.values['--params'], { own: 1 });
    assert.deepStrictEqual(bridge.readJsonFile(sentinel), { host: true });
    const b = await bridge.recompute('session', { keep: [1] }, { own: 2 });
    const c = await bridge.exportEdl('session', 'out', 'clip', [[1, 2]]);
    assert.deepStrictEqual(b.values['--session-params'], { own: 2 });
    assert.deepStrictEqual(c.values['--overrides'], { keep_ranges: [[1, 2]] });
    assert.notStrictEqual(path.dirname(a.files['--params']), path.dirname(b.files['--overrides']));
    for (const result of [a, b, c]) {
        for (const file of Object.values(result.files)) assert.ok(!fs.existsSync(path.dirname(file)));
    }
    const cancelled = bridge.analyze('movie.mp4', {});
    bridge.cancel();
    await assert.rejects(cancelled, e => e.code === 'CANCELLED');
    const circular = {}; circular.self = circular;
    await assert.rejects(bridge.recompute('session', {}, circular), /circular/i);
    assert.deepStrictEqual(fs.readdirSync(bridge.paths.PAYLOAD_DIR).filter(n => n.startsWith('task-')), []);
});

for (const reason of ['cancel', 'timeout']) {
    test('真实进程树终止：' + reason, async () => {
        let descendant;
        let ready;
        const started = new Promise(resolve => { ready = resolve; });
        const p = bridge.runCli(['tree'], {
            timeoutMs: reason === 'timeout' ? 1500 : 0,
            onProgress: msg => { descendant = msg.pid; ready(); }
        });
        const outcome = p.then(value => ({ value }), error => ({ error }));
        await Promise.race([started, outcome]);
        assert.ok(descendant, 'CLI 应先报告后代 PID');
        if (reason === 'cancel') bridge.cancel();
        const stopped = await outcome;
        assert.strictEqual(stopped.error && stopped.error.code, reason === 'cancel' ? 'CANCELLED' : 'TIMEOUT');
        let alive = true;
        for (let i = 0; i < 40; i++) {
            try {
                process.kill(descendant, 0);
                // Linux 容器的 PID 1 可能延迟回收已死亡的孤儿。
                if (process.platform === 'linux' && /\) Z /.test(fs.readFileSync('/proc/' + descendant + '/stat', 'utf8'))) alive = false;
            } catch (e) { alive = false; }
            if (!alive) break;
            await sleep(50);
        }
        assert.strictEqual(alive, false, '后代进程必须终止');
    });
}

test('模拟双平台：无 close 有限结束，迟到事件不会清空新任务或污染原因', async () => {
    const vm = require('vm');
    const { EventEmitter } = require('events');
    const { PassThrough } = require('stream');
    const source = fs.readFileSync(path.join(__dirname, '../cep-extension/js/bridge.js'), 'utf8');
    for (const platform of ['win32', 'linux']) {
        const children = [], kills = [], execs = [];
        const context = {
            window: {}, Buffer,
            process: { platform, env: {}, kill: (pid, signal) => kills.push([pid, signal]) },
            setTimeout: (fn, ms) => setTimeout(fn, ms >= 2000 ? 30 : ms), clearTimeout,
            require: name => {
                if (name !== 'child_process') return require(name);
                return {
                    spawn: (exe, args, opts) => {
                        const child = new EventEmitter();
                        child.pid = 100 + children.length;
                        child.stdout = new PassThrough(); child.stderr = new PassThrough();
                        child.stdin = new PassThrough(); child.unref = () => {};
                        child.kill = signal => kills.push([child.pid, signal]);
                        child.options = opts;
                        children.push(child); return child;
                    },
                    execFile: (exe, args, opts, callback) => {
                        execs.push({ exe, args, opts });
                        callback(new Error('taskkill unavailable'));
                    }
                };
            }
        };
        vm.runInNewContext(source, context);
        const b = context.window.ArknightBridge;
        Object.assign(b.getState(), { python: { exe: 'test', preArgs: [] }, cliPath: __filename, cliDir: __dirname });
        let callbacks = 0;
        const first = b.runCli([], { onProgress: () => callbacks++, onLog: () => callbacks++ });
        b.cancel();
        await assert.rejects(b.runCli([]), e => e.code === 'BUSY');
        await assert.rejects(first, e => e.code === 'CANCELLED');
        const next = b.runCli([], { timeoutMs: 10 });
        const nextChild = b.getState().child;
        children[0].emit('close', 0);
        children[0].emit('error', new Error('late'));
        children[0].stdout.emit('data', Buffer.from('{"type":"progress"}\n'));
        children[0].stderr.emit('data', Buffer.from('late'));
        assert.strictEqual(b.getState().child, nextChild);
        assert.strictEqual(callbacks, 0);
        await assert.rejects(next, e => e.code === 'TIMEOUT');
        assert.strictEqual(b.getState().child, null);
        assert.strictEqual(children[0].options.detached, platform !== 'win32');
        if (platform === 'win32') {
            assert.deepStrictEqual(Array.from(execs[0].args), ['/PID', '100', '/T', '/F']);
            assert.ok(kills.some(k => k[0] === 100 && k[1] === 'SIGKILL'));
        } else {
            assert.deepStrictEqual(kills[0], [-100, 'SIGKILL']);
        }
    }
});

// ------------------------------------------------------------------
//  前置校验（放在最后，因为要改 state）
// ------------------------------------------------------------------

test('无 Python → NO_PYTHON', async () => {
    bridge.getState().python = null;
    await assert.rejects(bridge.runCli(['ok']), e => e.code === 'NO_PYTHON');
});

test('找不到 pr_cli.py → NO_CLI', async () => {
    bridge.getState().python = { exe: process.execPath, preArgs: [], version: 'test' };
    bridge.getState().cliPath = path.join(TMP, 'missing', 'pr_cli.cjs');
    bridge.getState().cliDir = path.join(TMP, 'missing');
    await assert.rejects(bridge.runCli(['ok']), e => e.code === 'NO_CLI');
});

// ------------------------------------------------------------------
//  装配与执行
// ------------------------------------------------------------------

function setup() {
    fs.writeFileSync(path.join(TMP, 'pr_cli.cjs'), FAKE_CLI, 'utf8');
    bridge.getState().python = { exe: process.execPath, preArgs: [], version: 'test' };
    bridge.getState().cliPath = path.join(TMP, 'pr_cli.cjs');
    bridge.getState().cliDir = TMP;
}

async function main() {
    console.log('\nbridge.js 行为测试\n');
    console.log('  隔离 HOME: ' + TMP + '\n');
    setup();

    for (const t of tests) {
        try {
            await t.fn();
            passed++;
            console.log('  \u2713 ' + t.name);
        } catch (e) {
            failed++;
            console.log('  \u2717 ' + t.name);
            console.log('      ' + String(e && e.message).split('\n').join('\n      '));
        }
    }

    console.log('\n通过 ' + passed + ' 项，失败 ' + failed + ' 项\n');

    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 保留现场 */ }

    if (failed > 0) { process.exit(1); }
}

main().catch(e => { console.error(e); process.exit(1); });
