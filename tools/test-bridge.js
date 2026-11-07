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
 *     把一个「由 Node 执行的假 CLI」（命名 pr_cli.js —— Node 20.6+ 拒绝
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
//  假 CLI：被 node 当脚本执行的 pr_cli.js（后缀必须是 Node 认识的）
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
        process.stdout.write(JSON.stringify({ type: 'error', message: '模板加载失败', detail: 'stack here' }) + '\\n');
        process.exit(1);
    } else if (mode === 'noresult') {
        process.stderr.write('Traceback (most recent call last):\\n  boom\\n');
        process.exit(3);
    } else if (mode === 'hang') {
        setInterval(() => {}, 1000); // 永不退出，等测试杀掉
    }
})().catch(() => process.exit(9));
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
    for (const c of ['NO_PYTHON', 'NO_CLI', 'SPAWN_FAILED', 'CANCELLED', 'TIMEOUT', 'CLI_ERROR', 'NO_RESULT']) {
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
    assert.strictEqual(
        bridge.defaultEdlPath('D:\\v\\rec.mp4'),
        path.join('D:\\v', 'rec_autoedit.edl'));
    assert.strictEqual(
        bridge.defaultEdlPath('D:\\v\\no_ext'),
        path.join('D:\\v', 'no_ext_autoedit.edl'));
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
        e => e.code === 'CLI_ERROR' && /模板加载失败/.test(e.message) && e.detail === 'stack here');
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

// ------------------------------------------------------------------
//  前置校验（放在最后，因为要改 state）
// ------------------------------------------------------------------

test('无 Python → NO_PYTHON', async () => {
    bridge.getState().python = null;
    await assert.rejects(bridge.runCli(['ok']), e => e.code === 'NO_PYTHON');
});

test('找不到 pr_cli.py → NO_CLI', async () => {
    bridge.getState().python = { exe: process.execPath, preArgs: [], version: 'test' };
    bridge.getState().cliPath = path.join(TMP, 'missing', 'pr_cli.js');
    bridge.getState().cliDir = path.join(TMP, 'missing');
    await assert.rejects(bridge.runCli(['ok']), e => e.code === 'NO_CLI');
});

// ------------------------------------------------------------------
//  装配与执行
// ------------------------------------------------------------------

function setup() {
    fs.writeFileSync(path.join(TMP, 'pr_cli.js'), FAKE_CLI, 'utf8');
    bridge.getState().python = { exe: process.execPath, preArgs: [], version: 'test' };
    bridge.getState().cliPath = path.join(TMP, 'pr_cli.js');
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
