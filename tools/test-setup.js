'use strict';
// Real downloads and real embedded Python, but only isolated temporary installation paths.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const install = path.join(root, 'cep-extension/install');
const lock = JSON.parse(fs.readFileSync(path.join(install, 'runtime-lock.json')));
const ps = fs.readFileSync(path.join(install, 'setup.ps1'));
assert(ps.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'PowerShell 5.1 requires UTF-8 BOM');
assert(!/(?<!\r)\n/.test(ps.toString('utf8')), 'setup.ps1 must preserve CRLF');
assert(!fs.readFileSync(path.join(install, 'setup.bat')).some(b => b > 127), 'Batch entry must be ASCII');
assert.equal(lock.pythonVersion, '3.13.2');
for (const item of [lock.python, ...lock.wheels]) {
    assert.match(item.sha256, /^[a-f0-9]{64}$/);
    assert(['www.python.org', 'files.pythonhosted.org'].includes(new URL(item.url).hostname));
}
if (process.platform !== 'win32') { console.log('Runtime lock valid; Windows integration test skipped on this OS.'); process.exit(0); }
// PS7 parents export a PSModulePath that can hide PS5.1's built-in modules.
// Use only Windows PowerShell system modules, never inherited/user modules.
const powershellEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
powershellEnv.PSModulePath = [
    path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules'),
    path.join(process.env.ProgramFiles, 'WindowsPowerShell/Modules')
].join(path.delimiter);
(async () => {
    // Do not package into shared dist: parallel test/release jobs must not collide.
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-setup-test-'));
    const packageDir = path.join(temp, "安装 脚本's [test]");
    fs.mkdirSync(packageDir);
    for (const name of ['setup.ps1', 'runtime-lock.json']) fs.copyFileSync(path.join(install, name), path.join(packageDir, name));
    fs.cpSync(path.join(root, 'cep-extension'), path.join(packageDir, 'panel'), { recursive: true });
    fs.cpSync(path.join(root, 'backend'), path.join(packageDir, 'backend'), { recursive: true });
    fs.copyFileSync(path.join(root, 'LICENSE'), path.join(packageDir, 'panel/LICENSE'));
    const setupScript = path.join(packageDir, 'setup.ps1');
    console.log('Isolated setup test: ' + temp);
    const cache = path.join(temp, 'cache'); fs.mkdirSync(cache);
    for (const item of [lock.python, ...lock.wheels]) {
        const dir = fs.mkdtempSync(path.join(temp, 'download-'));
        const cached = process.env.ARKNIGHT_TEST_DOWNLOAD_CACHE && path.join(process.env.ARKNIGHT_TEST_DOWNLOAD_CACHE, item.filename);
        let bytes;
        if (cached && fs.existsSync(cached)) bytes = fs.readFileSync(cached);
        else {
            const response = await fetch(item.url, { signal: AbortSignal.timeout(900000) }); assert(response.ok, item.url);
            bytes = Buffer.from(await response.arrayBuffer());
        }
        fs.writeFileSync(path.join(dir, item.filename), bytes);
        assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), item.sha256);
        fs.copyFileSync(path.join(dir, item.filename), path.join(cache, item.filename));
    }
    const sandbox = path.join(temp, '用户 sandbox');
    const cfgPath = path.join(sandbox, 'profile/.arknight-pr/config.json');
    const panel = path.join(sandbox, 'roaming/Adobe/CEP/extensions/com.arknight.autoediting');
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    // Exact configuration reported by the user; never access this external directory.
    const reportedConfig = { pythonPath: null, cliDir: 'C:\\external\\arknight-auto-editing-main' };
    fs.writeFileSync(cfgPath, JSON.stringify(reportedConfig));
    fs.mkdirSync(panel, { recursive: true }); fs.writeFileSync(path.join(panel, 'old.txt'), 'old-panel');
    let noNetwork = true;
    const run = (failure, expectSuccess) => {
        const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', setupScript, '-SandboxRoot', sandbox, '-DownloadCache', cache];
        if (failure) args.push('-TestFailure', failure);
        if (noNetwork) args.push('-TestNoNetwork');
        const result = spawnSync('powershell.exe', args, { cwd: root, env: powershellEnv, encoding: 'utf8', timeout: 240000 });
        if ((result.status === 0) !== expectSuccess) throw new Error(result.stdout + '\n' + result.stderr);
        if (failure && !/Injected failure/.test(result.stdout + result.stderr)) throw new Error('Did not reach rollback point:\n' + result.stdout + result.stderr);
        if (expectSuccess) {
            for (let n = 1; n <= 6; n++) assert(result.stdout.includes(`[${n}/6]`), 'Visible phase ' + n);
            assert.match(result.stdout, /开始：.*health/);
            assert.match(result.stdout, /完成：.*检查通过/);
        }
        console.log(failure || 'Install', expectSuccess ? 'passed' : 'failed as expected');
        return result.stdout + result.stderr;
    };
    const original = fs.readFileSync(cfgPath);
    const psVersion = spawnSync('powershell.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { env: powershellEnv, encoding: 'utf8' });
    assert.equal(psVersion.status, 0);
    assert.match(psVersion.stdout, /^5\.1\./);
    console.log('PowerShell ' + psVersion.stdout.trim());
    for (const broken of ['{invalid', '', 'null', '[]', '[{}]', '42', '"text"']) {
        fs.writeFileSync(cfgPath, broken);
        assert.match(run('', false), /配置文件损坏.*有效 JSON 对象/);
        assert.equal(fs.readFileSync(cfgPath, 'utf8'), broken);
        assert(!fs.existsSync(path.join(sandbox, 'local/ArknightPR/versions')));
    }
    // Stop at the first missing archive: every candidate must reach fresh preparation,
    // leave the input unchanged, and never execute or modify an external environment.
    fs.renameSync(cache, cache + '-matrix');
    const external = path.join(temp, 'external environment');
    fs.mkdirSync(external);
    const sentinel = path.join(external, 'python.exe');
    fs.writeFileSync(sentinel, 'external environment must remain untouched');
    const privateRelease = path.join(sandbox, 'local/ArknightPR/versions/candidate');
    const invalidPaths = [null, '', ' \t ', 42, false, {}, [], ['python'], 'python', 'python.exe',
        '.\\python\\python.exe', 'C:python', '\\python', 'C:\\bad\u0000path', 'C:\\bad|path',
        'C:\\bad*path', 'C:\\bad:stream', '"C:\\Python\\python.exe"', "'C:\\Python\\python.exe'"];
    const candidates = [{}, { pythonPath: null }, { cliDir: null }, reportedConfig,
        { pythonPath: sentinel, cliDir: external }];
    for (const value of invalidPaths) {
        candidates.push({ pythonPath: value, cliDir: path.join(privateRelease, 'backend') });
        candidates.push({ pythonPath: path.join(privateRelease, 'python/python.exe'), cliDir: value });
    }
    for (const candidate of candidates) {
        const bytes = JSON.stringify({ custom: { retained: true }, ...candidate });
        fs.writeFileSync(cfgPath, bytes);
        const output = run('', false);
        assert.match(output, /首次准备专用环境，不修改未知外部环境/);
        assert.match(output, /Network disabled/);
        assert.doesNotMatch(output, /GetFullPath|旧版运行时接管/);
        assert.equal(fs.readFileSync(cfgPath, 'utf8'), bytes);
        assert.equal(fs.readFileSync(sentinel, 'utf8'), 'external environment must remain untouched');
        assert.equal(fs.readFileSync(path.join(panel, 'old.txt'), 'utf8'), 'old-panel');
    }
    console.log('Config candidate matrix passed: ' + candidates.length + ' cases');
    fs.renameSync(cache + '-matrix', cache);
    fs.writeFileSync(cfgPath, original);
    const lockFile = path.join(sandbox, 'local/ArknightPR/setup.lock');
    const holder = require('child_process').spawn('powershell.exe', ['-NoProfile', '-Command', `$f=[IO.File]::Open('${lockFile.replace(/'/g, "''")}','OpenOrCreate','ReadWrite','None'); Write-Output 'LOCKED'; [Console]::ReadLine() | Out-Null; $f.Dispose()`], { env: powershellEnv });
    try {
        await new Promise((resolve, reject) => {
            holder.stdout.once('data', resolve); holder.once('error', reject);
            holder.once('exit', code => { if (code) reject(new Error('Lock holder exited ' + code)); });
        });
        assert.match(run('', false), /另一个安装器正在运行/);
        assert.deepEqual(fs.readFileSync(cfgPath), original);
    } finally { holder.stdin.end('\n'); }
    await new Promise(resolve => holder.exitCode !== null ? resolve() : holder.once('exit', resolve));
    for (const point of ['AfterPanel', 'AfterConfig']) {
        run(point, false);
        assert.deepEqual(fs.readFileSync(cfgPath), original);
        assert.equal(fs.readFileSync(path.join(panel, 'old.txt'), 'utf8'), 'old-panel');
    }
    assert.match(run('', true), /首次准备专用环境/);
    console.log('Exact reported null pythonPath configuration installed successfully');
    const first = fs.readFileSync(cfgPath);
    const config = JSON.parse(first);
    assert(fs.existsSync(config.pythonPath));
    assert(fs.existsSync(path.join(config.cliDir, 'pr_cli.py')));
    run('AfterConfig', false);
    assert.deepEqual(fs.readFileSync(cfgPath), first);
    assert(fs.existsSync(config.pythonPath));
    const data = path.join(sandbox, 'local/ArknightPR');
    const versions = () => fs.readdirSync(path.join(data, 'versions'));
    const initialVersions = versions();
    const activeRelease = path.dirname(config.cliDir);
    // A forged inventory must never authorize copying outside the release.
    const forgedRecord = path.join(activeRelease, lock.python.filename + '.files.json');
    const outside = path.join(data, 'outside-sentinel');
    fs.writeFileSync(outside, 'do not modify');
    fs.writeFileSync(forgedRecord, JSON.stringify({ sha256: lock.python.sha256, files: {
        '..\\..\\outside-sentinel': crypto.createHash('sha256').update('do not modify').digest('hex')
    } }));
    run('', true);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'do not modify');
    assert.deepEqual(versions(), initialVersions);
    // Backups must not contain duplicate manifests in the CEP extension search root.
    assert.deepEqual(fs.readdirSync(path.dirname(panel)), ['com.arknight.autoediting']);
    const removeRecords = () => {
        for (const item of [lock.python, ...lock.wheels]) fs.rmSync(path.join(activeRelease, item.filename + '.files.json'));
    };
    removeRecords();
    assert.match(run('', true), /复用已有专用运行时/);
    assert.deepEqual(versions(), initialVersions);
    fs.renameSync(path.join(data, 'cache'), path.join(data, 'cache-hidden'));
    fs.renameSync(cache, cache + '-legacy-hidden');
    assert.match(run('', false), /Network disabled/);
    assert.deepEqual(versions(), initialVersions);
    assert.deepEqual(fs.readFileSync(cfgPath), first);
    fs.rmSync(path.join(data, 'cache'), { recursive: true });
    fs.renameSync(path.join(data, 'cache-hidden'), path.join(data, 'cache'));
    fs.renameSync(cache + '-legacy-hidden', cache);
    // No seed cache and a hard network refusal: healthy repeat must still succeed.
    fs.renameSync(cache, cache + '-offline');
    const repeated = run('', true);
    assert(!repeated.includes('开始：下载'));
    assert.deepEqual(fs.readFileSync(cfgPath), first);
    assert.deepEqual(versions(), initialVersions);
    const panelSource = path.join(packageDir, 'panel/index.html');
    fs.appendFileSync(panelSource, '\n<!-- same-version panel update -->');
    run('', true);
    assert(fs.readFileSync(path.join(panel, 'index.html'), 'utf8').includes('same-version panel update'));
    assert.deepEqual(versions(), initialVersions);
    const backendSource = path.join(packageDir, 'backend/pr_cli.py');
    const oldBackend = fs.readFileSync(path.join(config.cliDir, 'pr_cli.py'));
    fs.appendFileSync(backendSource, '\n# same-version backend update\n');
    run('AfterConfig', false);
    assert.deepEqual(fs.readFileSync(path.join(config.cliDir, 'pr_cli.py')), oldBackend);
    run('', true);
    assert(fs.readFileSync(path.join(config.cliDir, 'pr_cli.py'), 'utf8').includes('same-version backend update'));
    assert.deepEqual(versions(), initialVersions);
    assert.deepEqual(fs.readFileSync(cfgPath), first);
    fs.appendFileSync(path.join(config.cliDir, 'session_store.py'), '\nraise RuntimeError("old backend must not be imported by staged health")\n');
    run('', true);
    assert.deepEqual(fs.readFileSync(path.join(config.cliDir, 'session_store.py')), fs.readFileSync(path.join(packageDir, 'backend/session_store.py')));
    assert.deepEqual(versions(), initialVersions);
    // Only numpy is broken: copy the healthy Python/OpenCV files, fetch only numpy.
    fs.appendFileSync(path.join(path.dirname(config.pythonPath), 'Lib/site-packages/numpy/__init__.py'), '\nraise RuntimeError("broken")\n');
    const repair = run('', true);
    assert(repair.includes('缓存校验通过 ' + lock.wheels[0].filename));
    assert(repair.includes('复制健康组件 ' + lock.python.filename));
    assert.equal(versions().length, initialVersions.length + 1);
    const repaired = JSON.parse(fs.readFileSync(cfgPath));
    const working = fs.readFileSync(cfgPath);
    fs.appendFileSync(path.join(path.dirname(repaired.pythonPath), 'Lib/site-packages/numpy/__init__.py'), '\n# corrupt\n');
    fs.appendFileSync(path.join(data, 'cache', lock.wheels[0].filename), 'tampered');
    const rejected = run('', false);
    assert.match(rejected, /Network disabled/);
    assert.deepEqual(fs.readFileSync(cfgPath), working);
    fs.renameSync(cache + '-offline', cache);
    run('', true); // bad persistent cache repaired from verified seed
    const stableVersions = versions();
    run('', true);
    assert.deepEqual(versions(), stableVersions);
    // Download failure and waiting diagnostics against a local isolated HTTP server.
    const lockPath = path.join(packageDir, 'runtime-lock.json');
    const originalLock = fs.readFileSync(lockPath);
    const changed = JSON.parse(originalLock);
    changed.wheels[0].sha256 = 'a'.repeat(64);
    changed.wheels[0].url = 'http://127.0.0.1:1/unavailable';
    fs.writeFileSync(lockPath, JSON.stringify(changed));
    noNetwork = false;
    const beforeFailure = fs.readFileSync(cfgPath);
    assert.match(run('', false), /下载失败/);
    assert.deepEqual(fs.readFileSync(cfgPath), beforeFailure);
    assert.deepEqual(versions(), stableVersions);
    // Exercise the actual streaming downloader, including delayed headers and unknown length.
    const http = require('http');
    const { spawn } = require('child_process');
    const server = http.createServer((req, res) => {
        if (req.url === '/timeout') return;
        const delayed = setTimeout(() => {
            if (res.destroyed) return;
            if (req.url === '/known') res.setHeader('Content-Length', '196608');
            res.write(Buffer.alloc(65536));
            const second = setTimeout(() => { if (!res.destroyed) res.write(Buffer.alloc(65536)); }, 1200);
            const third = setTimeout(() => { if (!res.destroyed) res.end(Buffer.alloc(65536)); }, 2400);
            res.on('close', () => { clearTimeout(second); clearTimeout(third); });
        }, 2200);
        res.on('close', () => clearTimeout(delayed));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
        for (const mode of ['known', 'unknown', 'timeout']) {
            changed.wheels[0].url = `http://127.0.0.1:${server.address().port}/${mode}`;
            fs.writeFileSync(lockPath, JSON.stringify(changed));
            const output = await new Promise((resolve, reject) => {
                const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', setupScript, '-SandboxRoot', sandbox], { cwd: root, env: powershellEnv });
                let text = '';
                child.stdout.on('data', b => { text += b.toString('utf8'); });
                child.stderr.on('data', b => { text += b.toString('utf8'); });
                const deadline = setTimeout(() => { child.kill(); reject(new Error('Downloader exceeded test deadline')); }, 90000);
                child.on('error', reject);
                child.on('exit', code => { clearTimeout(deadline); try { assert.notEqual(code, 0); resolve(text); } catch (e) { reject(e); } });
            });
            assert.match(output, /等待服务器响应/);
            if (mode === 'timeout') assert.match(output, /响应头超时/);
            else {
                assert.match(output, /KiB\/s/);
                assert.match(output, /196608 bytes/);
                assert.match(output, mode === 'known' ? /[0-9]+\.[0-9]+%/ : /总大小未知/);
                assert.match(output, /SHA256 mismatch/);
            }
            assert.deepEqual(fs.readFileSync(cfgPath), beforeFailure);
            assert.deepEqual(versions(), stableVersions);
            console.log('Streaming download ' + mode + ' passed');
        }
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    fs.writeFileSync(lockPath, originalLock);
    fs.rmSync(temp, { recursive: true, force: true });
    console.log('PASS: real imports/health, Unicode paths, phase logs, offline repeat without new runtime, same-version panel/backend updates, single-component repair, corrupt cache recovery, download failure, rollback and config preservation.');
})().catch(e => { console.error(e); process.exitCode = 1; });
