#!/usr/bin/env node
/**
 * make-zxp.js —— 把 package.js 的暂存产物签名为 .zxp 分发包
 *
 * 运行：node tools/make-zxp.js（须先跑 node tools/package.js，缺暂存目录会自动补跑）
 *
 * .zxp 是什么：Adobe 的签名扩展包（本质是符合 CEP 签名规范的 zip）。
 * 用户用 ZXP 安装器（如 Anastasiy's Extension Manager、ZXP Installer）双击安装，
 * 不需要手动开 PlayerDebugMode。zip 与 zxp 的取舍见 README「分发方式」。
 *
 * 证书策略 —— **每次签名临时生成自签名证书，用完即删**：
 *   · 私钥与密码不进仓库、不进 CI secrets，也就不存在泄露面
 *   · 代价是每次发布的证书都不同，用户会看到「发布者不受信任」的提示，
 *     这是自签名的固有代价；zip 仍是主推的分发方式
 *
 * 工具来源：Adobe 官方 ZXPSignCmd（github.com/Adobe-CEP/CEP-Resources 分发二进制）。
 * 解析顺序：
 *   1. 命令行 --zxp-tool <path> 或环境变量 ARKNIGHT_ZXPSIGNCMD
 *   2. 缓存目录 ~/.arknight-pr/bin/ 里已有的二进制
 *   3. 从候选 URL 下载并缓存（GitHub 网络不通时会失败，此时用前两种方式手动提供）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

// 扩展 Id / 版本以 manifest 为唯一来源（与 package.js 保持同一套解析）
const manifestXml = fs.readFileSync(path.join(ROOT, 'cep-extension', 'CSXS', 'manifest.xml'), 'utf8');
const { bundleId: EXT_ID, version: VERSION } = require('./manifest').parseManifest(manifestXml);

const STAGE = path.join(DIST, EXT_ID);
const ZXP_NAME = `${EXT_ID}-v${VERSION}.zxp`;
const ZXP_PATH = path.join(DIST, ZXP_NAME);

function argValue(flag) {
    const i = process.argv.indexOf(flag);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

// ------------------------------------------------------------------
//  1. 确保 package.js 的暂存目录存在
// ------------------------------------------------------------------

if (!fs.existsSync(path.join(STAGE, 'CSXS', 'manifest.xml'))) {
    console.log('暂存目录不存在或缺 manifest，先运行 package.js …\n');
    execFileSync(process.execPath, [path.join(__dirname, 'package.js')], { stdio: 'inherit' });
    console.log('');
}
if (!fs.existsSync(path.join(STAGE, 'CSXS', 'manifest.xml'))) {
    console.error(`打包暂存目录不可用：${STAGE}`);
    process.exit(1);
}

// Never sign a stale staging manifest left over from an earlier package.
const stagedXml = fs.readFileSync(path.join(STAGE, 'CSXS', 'manifest.xml'), 'utf8');
require('./manifest').parseManifest(stagedXml);
if (stagedXml !== manifestXml) {
    console.error('暂存 manifest 与源码不一致，请重新运行 node tools/package.js');
    process.exit(1);
}

// ------------------------------------------------------------------
//  2. 定位 ZXPSignCmd
// ------------------------------------------------------------------

const CACHE_BIN_DIR = path.join(os.homedir(), '.arknight-pr', 'bin');

/** 各平台的候选下载（官方 Adobe-CEP/CEP-Resources 仓库的版本化直链，
 *  路径已于 2026-11-07 实地核实：ZXPSignCMD/<版本>/<平台>/ZXPSignCmd.exe；
 *  URL 变了可用 --zxp-tool 手动指定，或用 git 稀疏克隆该仓库取二进制） */
function downloadCandidates() {
    const base = 'https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/ZXPSignCMD';
    if (process.platform === 'win32') {
        return [
            { url: `${base}/4.1.103/win64/ZXPSignCmd.exe`, file: 'ZXPSignCmd.exe' },
            { url: `${base}/4.1.103/win32/ZXPSignCmd.exe`, file: 'ZXPSignCmd-win32.exe' }
        ];
    }
    if (process.platform === 'darwin') {
        return [{ url: `${base}/4.1.3/macOS/ZXPSignCmd`, file: 'ZXPSignCmd' }];
    }
    // Linux：Adobe 不提供 ZXPSignCmd 二进制。CI 上的签名用 Windows runner
    // （release.yml 的 runs-on）；本地 Linux 想签 zxp 需 WINE，明确失败而不是瞎猜。
    return [];
}

function resolveTool() {
    const explicit = argValue('--zxp-tool') || process.env.ARKNIGHT_ZXPSIGNCMD;
    if (explicit) {
        if (fs.existsSync(explicit)) { return explicit; }
        console.error(`指定的 ZXPSignCmd 不存在：${explicit}`);
        process.exit(1);
    }

    // 缓存目录：取该目录下名字带 ZXPSignCmd 的第一个可执行文件
    try {
        const cached = fs.readdirSync(CACHE_BIN_DIR)
            .filter(f => /ZXPSignCmd/i.test(f))
            .sort()
            .reverse()[0];
        if (cached) { return path.join(CACHE_BIN_DIR, cached); }
    } catch (e) { /* 缓存目录不存在，继续走下载 */ }

    // 下载
    for (const c of downloadCandidates()) {
        const dest = path.join(CACHE_BIN_DIR, c.file);
        try {
            fs.mkdirSync(CACHE_BIN_DIR, { recursive: true });
            console.log(`下载 ZXPSignCmd：${c.url}`);
            execFileSync('curl', ['-sSL', '--retry', '2', '-o', dest, c.url], { stdio: 'pipe' });
            if (fs.existsSync(dest) && fs.statSync(dest).size > 100000) {
                if (process.platform !== 'win32') { fs.chmodSync(dest, 0o755); }
                return dest;
            }
            console.error('下载产物异常（过小），删除重试下一个候选');
            fs.rmSync(dest, { force: true });
        } catch (e) {
            console.error(`下载失败：${e.message && e.message.split('\n')[0]}`);
        }
    }
    console.error(
        '\n无法获得 ZXPSignCmd。可手动解决：\n' +
        '  1. 从 https://github.com/Adobe-CEP/CEP-Resources/tree/master/ZXPSignCMD 下载对应平台的二进制\n' +
        '  2. 放到 ' + CACHE_BIN_DIR + '（或任意位置），然后：\n' +
        '     node tools/make-zxp.js --zxp-tool <路径>');
    process.exit(1);
}

const tool = resolveTool();
console.log(`签名工具：${tool}\n`);

// ------------------------------------------------------------------
//  3. 临时自签名证书 + 签名 + 校验
// ------------------------------------------------------------------

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arknight-zxp-'));
const certPath = path.join(workDir, 'ephemeral.p12');
const certPass = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);

function run(args, what) {
    try {
        execFileSync(tool, args, { stdio: 'pipe' });
    } catch (e) {
        const msg = (e.stderr || e.stdout || e.message || '').toString().trim().split('\n').slice(0, 12).join('\n');
        console.error(`\n${what} 失败：\n${msg}`);
        process.exit(1);
    }
}

console.log('生成临时自签名证书（用完即删，不进仓库）…');
run(['-selfSignedCert', 'CN', 'Local', 'Arknight Auto Editing', EXT_ID, certPass, certPath],
    '生成自签名证书');

console.log(`签名 → dist/${ZXP_NAME} …`);
// 用法是位置参数：-sign <目录> <输出.zxp> <p12> <密码>（不是 -cert 旗标）
run(['-sign', STAGE, ZXP_PATH, certPath, certPass], '签名');

// 签完立刻删私钥；校验用的是 zxp 内嵌的证书，不需要外部 p12
try { fs.rmSync(certPath, { force: true }); } catch (e) { }
try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { }

console.log('校验签名 …');
// -skipOnlineRevocationChecks：CI 上不该依赖吊销检查服务器可达
run(['-verify', ZXP_PATH, '-certInfo', '-skipOnlineRevocationChecks'], '校验 zxp');

if (!fs.existsSync(ZXP_PATH) || fs.statSync(ZXP_PATH).size === 0) {
    console.error('签名后未产出 zxp');
    process.exit(1);
}

console.log(`\n产物：dist/${ZXP_NAME}（${(fs.statSync(ZXP_PATH).size / 1024).toFixed(1)} KB）`);
console.log('安装方式：ZXP 安装器（ZXP Installer / Anastasiy Extension Manager）双击安装，');
console.log('          无需手动开 PlayerDebugMode；自签名证书会提示「发布者不受信任」。');
console.log('');