'use strict';
// PS 5.1 boundary regressions; no registry or real profile writes.
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawnSync } = require('child_process');
if (process.platform !== 'win32') { console.log('SKIP: Windows PowerShell boundaries'); process.exit(0); }
// PS7 parents export a PSModulePath that can hide PS5.1's built-in modules.
// Use only Windows PowerShell system modules, never inherited/user modules.
const powershellEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
powershellEnv.PSModulePath = [
    path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/Modules'),
    path.join(process.env.ProgramFiles, 'WindowsPowerShell/Modules')
].join(path.delimiter);
const install = path.resolve(__dirname, '../cep-extension/install');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ark-install-boundaries-'));
const quote = value => "'" + value.replace(/'/g, "''") + "'";
const run = code => spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', code], { env: powershellEnv, encoding: 'utf8', timeout: 30000 });
try {
    // Resolve and execute the real PS5.1 cmdlet even under a polluted parent env.
    const hashFile = path.join(temp, 'hash-probe.txt');
    fs.writeFileSync(hashFile, 'PS5.1 module discovery');
    const hash = run(`$ErrorActionPreference='Stop';if($PSVersionTable.PSVersion -notlike '5.1.*'){throw 'Expected PS5.1'};(Get-FileHash -LiteralPath ${quote(hashFile)} -Algorithm SHA256).Hash`);
    assert.equal(hash.status, 0, hash.stdout + hash.stderr);
    assert.equal(hash.stdout.trim().toLowerCase(), require('crypto').createHash('sha256').update(fs.readFileSync(hashFile)).digest('hex'));
    for (const name of ['install.ps1', 'setup.ps1']) {
        const bytes = fs.readFileSync(path.join(install, name));
        assert(bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191])));
        assert(!bytes.subarray(3, 6).equals(Buffer.from([239, 187, 191])), 'Duplicate BOM breaks param parsing');
        assert(!/(?<!\r)\n/.test(bytes.toString()));
        assert(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(bytes.toString()), 'No accidental control escapes in PowerShell source');
        const result = run(`$e=$null;$t=$null;[void][Management.Automation.Language.Parser]::ParseFile(${quote(path.join(install, name))},[ref]$t,[ref]$e);if($e.Count){$e;exit 1}`);
        assert.equal(result.status, 0, result.stdout + result.stderr);
    }
    const cfg = path.join(temp, '.arknight-pr/config.json');
    fs.mkdirSync(path.dirname(cfg));
    for (const text of ['{broken', 'null', '[{}]', '42']) {
        fs.writeFileSync(cfg, text);
        // Install must reject before its first registry write; isolate all file targets.
        const result = run(`$env:USERPROFILE=${quote(temp)};$env:APPDATA=${quote(temp)};& ${quote(path.join(install, 'install.ps1'))}`);
        assert.notEqual(result.status, 0);
        assert.match(result.stdout + result.stderr, /配置文件损坏/);
        assert.equal(fs.readFileSync(cfg, 'utf8'), text);
        assert(!fs.existsSync(path.join(temp, 'Adobe')));
    }
    // Relative SandboxRoot is relative to PowerShell's location, not .NET's process cwd.
    const relativeRoot = path.join(temp, '相对 [sandbox]');
    const relativeCfg = path.join(relativeRoot, 'profile/.arknight-pr/config.json');
    fs.mkdirSync(path.dirname(relativeCfg), { recursive: true }); fs.writeFileSync(relativeCfg, '{broken');
    const relative = run(`Set-Location -LiteralPath ${quote(temp)};& ${quote(path.join(install, 'setup.ps1'))} -SandboxRoot '相对 [sandbox]' -TestNoNetwork`);
    assert.notEqual(relative.status, 0);
    assert.match(relative.stdout + relative.stderr, /配置文件损坏/);
    assert.equal(fs.readFileSync(relativeCfg, 'utf8'), '{broken');
    const relativeLock = path.join(relativeRoot, 'local/ArknightPR/setup.lock');
    const unlocked = run(`$f=[IO.File]::Open(${quote(relativeLock)},'Open','ReadWrite','None');$f.Dispose()`);
    assert.equal(unlocked.status, 0, unlocked.stdout + unlocked.stderr);
    // Use the AST to execute only candidate discovery: never reach registry installation.
    const analyzer = path.join(temp, '分析器 [old]');
    fs.mkdirSync(analyzer);
    for (const name of ['pr_cli.py', 'analyzer.py', 'frame_types.py']) fs.writeFileSync(path.join(analyzer, name), '');
    fs.writeFileSync(cfg, JSON.stringify({ cliDir: analyzer, pythonPath: null }));
    const discovered = run(`$env:USERPROFILE=${quote(temp)};$env:APPDATA=${quote(temp)};$env:ARKNIGHT_ANALYZER_DIR='';$e=$null;$t=$null;$ast=[Management.Automation.Language.Parser]::ParseFile(${quote(path.join(install, 'install.ps1'))},[ref]$t,[ref]$e);$InstallDir=${quote(install)};$ExtSrc=Split-Path -Parent $InstallDir;$CfgDir=Join-Path $env:USERPROFILE '.arknight-pr';$CfgFile=Join-Path $CfgDir 'config.json';$text=[IO.File]::ReadAllText(${quote(path.join(install, 'install.ps1'))});$start=$text.IndexOf('$AnalyzerDir = $null');$end=$text.IndexOf('# 找不到分析器');Invoke-Expression $text.Substring($start,$end-$start);if($AnalyzerDir -ne ${quote(analyzer)}){throw 'Analyzer path was not discovered'}`);
    assert.equal(discovered.status, 0, discovered.stdout + discovered.stderr);
    const source = path.join(temp, "源's [src]");
    const dest = path.join(temp, 'CEP/extensions/com.arknight.autoediting');
    fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'new.txt'), 'new');
    fs.mkdirSync(dest, { recursive: true }); fs.writeFileSync(path.join(dest, 'old.txt'), 'old');
    const script = `$ErrorActionPreference='Stop';$e=$null;$t=$null;$ast=[Management.Automation.Language.Parser]::ParseFile(${quote(path.join(install, 'install.ps1'))},[ref]$t,[ref]$e);$fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Install-ExtensionCopy'},$true);Invoke-Expression $fn.Extent.Text;$ExtSrc=${quote(source)};Install-ExtensionCopy ${quote(dest)}`;
    const installed = run(script);
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    assert.equal(fs.readFileSync(path.join(dest, 'new.txt'), 'utf8'), 'new');
    assert.deepEqual(fs.readdirSync(path.dirname(dest)), ['com.arknight.autoediting']);
    const backups = path.join(temp, 'CEP/arknight-install-backups');
    assert.equal(fs.readFileSync(path.join(backups, fs.readdirSync(backups)[0], 'old.txt'), 'utf8'), 'old');
    // Exclusive source handle: copy failure must preserve existing destination.
    const locked = run(`$h=[IO.File]::Open(${quote(path.join(source, 'new.txt'))},'Open','Read','None');try {${script}} finally {$h.Dispose()}`);
    assert.notEqual(locked.status, 0);
    assert.equal(fs.readFileSync(path.join(dest, 'new.txt'), 'utf8'), 'new');
    assert.deepEqual(fs.readdirSync(path.dirname(dest)), ['com.arknight.autoediting']);
    console.log('PASS: PS5.1 parse/BOM, corrupt legacy config preservation, literal source paths, backups outside CEP scan root, locked-copy preservation.');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
