# Unified per-user Windows x64 setup. PowerShell 5.1 compatible.
param(
    [string]$SandboxRoot,
    [string]$DownloadCache,
    [ValidateSet('', 'AfterPanel', 'AfterConfig')][string]$TestFailure = '',
    [switch]$TestNoNetwork
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Write-Host '[1/6] 启动安装器：检查配置、安装锁及组件状态'
Set-StrictMode -Version 2
if (-not [Environment]::Is64BitOperatingSystem) { throw 'Windows x64 is required.' }
if (($TestFailure -or $TestNoNetwork) -and -not $SandboxRoot) { throw 'Test options require SandboxRoot.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$utf8 = New-Object System.Text.UTF8Encoding($false)
$source = Split-Path -Parent $PSScriptRoot
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'panel')) {
    $panel = Join-Path $PSScriptRoot 'panel'
    $backend = Join-Path $PSScriptRoot 'backend'
} else {
    $panel = $source
    $backend = Join-Path (Split-Path -Parent $source) 'backend'
}
[xml]$manifest = Get-Content -LiteralPath (Join-Path $panel 'CSXS\manifest.xml') -Raw
$id = $manifest.ExtensionManifest.ExtensionBundleId
$version = $manifest.ExtensionManifest.ExtensionBundleVersion
if ($id -ne 'com.arknight.autoediting') { throw 'Unexpected extension ID.' }
if ($SandboxRoot) {
    $base = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($SandboxRoot)
    $data = Join-Path $base 'local\ArknightPR'
    $cfgDir = Join-Path $base 'profile\.arknight-pr'
    $ext = Join-Path $base "roaming\Adobe\CEP\extensions\$id"
} else {
    $data = Join-Path $env:LOCALAPPDATA 'ArknightPR'
    $cfgDir = Join-Path $env:USERPROFILE '.arknight-pr'
    $ext = Join-Path $env:APPDATA "Adobe\CEP\extensions\$id"
}
New-Item -ItemType Directory -Force $data | Out-Null
try { $guard = [IO.File]::Open((Join-Path $data 'setup.lock'), 'OpenOrCreate', 'ReadWrite', 'None') }
catch { throw '另一个安装器正在运行或安装锁不可访问，请等待其结束。' }
$token = [Guid]::NewGuid().ToString('N')
$release = Join-Path $data "versions\$version-$token"
$work = Join-Path $data "work-$token"
$stage = Join-Path $data "panel-stage-$token"
$backup = Join-Path $data "panel-backup-$token"
$cfg = Join-Path $cfgDir 'config.json'
$cfgBackup = Join-Path $cfgDir "config.backup-$token.json"
$cfgTemp = Join-Path $cfgDir "config.new-$token.json"
$cache = Join-Path $data 'cache'
$panelMoved = $false; $panelInstalled = $false; $configInstalled = $false
$backendMoved = $false; $backendInstalled = $false; $newRuntime = $false
$registry = @()
$committed = $false
# Config values are untrusted candidates, not commands or paths relative to setup's cwd.
function Config-AbsolutePath($value) {
    if ($value -isnot [string] -or [string]::IsNullOrWhiteSpace($value)) { return $null }
    # Require a drive-rooted or UNC path. Reject quotes, wildcards and device paths.
    if ($value -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)' -or
        $value -match '["<>|?*\x00-\x1f]' -or $value -match '^\\\\[?.]\\' -or
        $value.Substring(2).Contains(':')) { return $null }
    try { return [IO.Path]::GetFullPath($value) } catch { return $null }
}
function Hash($file) { return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
function Tree($dir) {
    $map = @{}
    if (Test-Path -LiteralPath $dir) {
        foreach ($f in Get-ChildItem -LiteralPath $dir -File -Recurse) {
            $rel = $f.FullName.Substring($dir.Length + 1)
            if ($rel -match '(^|\\)(__pycache__)(\\|$)' -or $rel -match '\.pyc$') { continue }
            $map[$rel] = Hash $f.FullName
        }
    }
    return $map
}
function Same($a, $b) {
    if ($a.Count -ne $b.Count) { return $false }
    foreach ($key in $a.Keys) { if ($a[$key] -ne $b[$key]) { return $false } }
    return $true
}
function Valid($file, $item) { return ((Test-Path -LiteralPath $file -PathType Leaf) -and (Hash $file) -eq $item.sha256) }
function Fetch-Verified($item) {
    Write-Host "开始：校验缓存 $($item.filename)"
    $stored = Join-Path $cache $item.filename
    if (Valid $stored $item) { Write-Host "完成：缓存校验通过 $($item.filename)"; return $stored }
    if (Test-Path -LiteralPath $stored) { Write-Host '缓存损坏，重新获取。'; Remove-Item -LiteralPath $stored -Force }
    # Each download has a new empty directory, separate from scripts and extraction.
    $dir = Join-Path $work ([Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory $dir | Out-Null
    $file = Join-Path $dir $item.filename
    $seed = if ($DownloadCache) { Join-Path $DownloadCache $item.filename } else { '' }
    if ($seed -and (Valid $seed $item)) {
        Write-Host "开始：复制已校验离线缓存 $($item.filename)"
        Copy-Item -LiteralPath $seed -Destination $file
    } else {
        if ($TestNoNetwork) { throw "Network disabled: $($item.filename) (缓存缺失或损坏)" }
        Write-Host "开始：下载 $($item.filename)，连接超时 30 秒、读取超时 30 秒、总限时 15 分钟"
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        $response = $null; $inputStream = $null; $outputStream = $null; $pending = $null; $readPending = $null; $request = $null
        try {
            $request = [Net.HttpWebRequest]::Create($item.url)
            $request.Timeout = 30000; $request.ReadWriteTimeout = 30000
            $pending = $request.BeginGetResponse($null, $null)
            $connecting = [Diagnostics.Stopwatch]::StartNew()
            while (-not $pending.AsyncWaitHandle.WaitOne(1000)) {
                Write-Host ('等待服务器响应：{0}，已等待 {1:F0} 秒' -f $item.filename, $connecting.Elapsed.TotalSeconds)
                if ($connecting.Elapsed.TotalSeconds -ge 30) { $request.Abort(); throw '连接/响应头超时（30 秒）' }
            }
            try { $response = $request.EndGetResponse($pending) } finally { $pending.AsyncWaitHandle.Close(); $pending = $null }
            $inputStream = $response.GetResponseStream()
            $outputStream = [IO.File]::Create($file)
            $buffer = New-Object byte[] 65536
            $received = 0L; $last = -1.0
            $timer = [Diagnostics.Stopwatch]::StartNew()
            $totalText = if ($response.ContentLength -ge 0) { "$($response.ContentLength) bytes" } else { '总大小未知' }
            Write-Host "下载进度：0 bytes / $totalText"
            while ($true) {
                $readPending = $inputStream.BeginRead($buffer, 0, $buffer.Length, $null, $null)
                $readTimer = [Diagnostics.Stopwatch]::StartNew()
                while (-not $readPending.AsyncWaitHandle.WaitOne(1000)) {
                    Write-Host ('等待下载数据：{0} | {1} bytes | 当前 0 KiB/s' -f $item.filename, $received)
                    if ($readTimer.Elapsed.TotalSeconds -ge 30 -or $timer.Elapsed.TotalSeconds -ge 900) { $request.Abort(); throw '读取/总下载超时' }
                }
                try { $count = $inputStream.EndRead($readPending) } finally { $readPending.AsyncWaitHandle.Close(); $readPending = $null }
                if ($count -le 0) { break }
                $outputStream.Write($buffer, 0, $count); $received += $count
                if ($timer.Elapsed.TotalSeconds -gt 900) { throw '下载总超时（15 分钟）' }
                if ($timer.Elapsed.TotalSeconds - $last -ge 1) {
                    $percent = if ($response.ContentLength -gt 0) { '{0:F1}%' -f (100.0 * $received / $response.ContentLength) } else { '总大小未知' }
                    Write-Host ('下载 {0}: {1} | {2} bytes | {3:F0} KiB/s' -f $item.filename, $percent, $received, ($received / 1024 / [Math]::Max(0.001, $timer.Elapsed.TotalSeconds)))
                    $last = $timer.Elapsed.TotalSeconds
                }
            }
            if ($response.ContentLength -ge 0 -and $received -ne $response.ContentLength) { throw '下载不完整' }
            $done = if ($response.ContentLength -gt 0) { '100.0%' } else { '总大小未知，传输结束' }
            Write-Host ('完成：下载 {0} | {1} | {2} bytes | {3:F0} KiB/s' -f $item.filename, $done, $received, ($received / 1024 / [Math]::Max(0.001, $timer.Elapsed.TotalSeconds)))
        } catch { throw "下载失败 $($item.filename)：$($_.Exception.Message)" }
        finally {
            if ($request) { $request.Abort() }
            if ($pending) { $pending.AsyncWaitHandle.Close() }
            if ($readPending) { $readPending.AsyncWaitHandle.Close() }
            if ($outputStream) { $outputStream.Dispose() }; if ($inputStream) { $inputStream.Dispose() }; if ($response) { $response.Dispose() }
        }
    }
    if (-not (Valid $file $item)) { throw "SHA256 mismatch: $($item.filename)" }
    Move-Item -LiteralPath $file -Destination $stored -Force
    Write-Host "完成：SHA256 验证并保存缓存 $($item.filename)"
    return $stored
}
function Probe($python, $code) {
    $saved = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        & $python -I -c $code 1> (Join-Path $work 'probe.stdout') 2> (Join-Path $work 'probe.stderr')
        return ($LASTEXITCODE -eq 0)
    } catch { return $false } finally { $ErrorActionPreference = $saved }
}
function Health($python, $cli) {
    Write-Host '开始：真实导入 Python / NumPy / OpenCV 及后端 health / 四类模板检查'
    if (-not (Probe $python 'import sys,numpy,cv2; assert sys.version_info[:3] == (3,13,2); assert tuple(map(int,numpy.__version__.split(chr(46)))) == (2,2,3); assert tuple(map(int,cv2.__version__.split(chr(46)))) == (4,11,0)')) { throw 'Runtime import/version check failed.' }
    $saved = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = & $python -I -c "import sys,runpy,os; target=sys.argv[1]; sys.path.insert(0,target); sys.argv=[os.path.join(target,'pr_cli.py'),'health']; runpy.run_path(sys.argv[0],run_name='__main__')" $cli 2> (Join-Path $work 'health.stderr.log')
        $healthExit = $LASTEXITCODE
    } finally { $ErrorActionPreference = $saved }
    if ($healthExit -ne 0) { throw "CLI health failed: $output $(Get-Content -LiteralPath (Join-Path $work 'health.stderr.log') -Raw -ErrorAction SilentlyContinue)" }
    $events = @($output | ForEach-Object { $_ | ConvertFrom-Json })
    $result = @($events | Where-Object { $_.type -eq 'result' })
    if ($result.Count -ne 1 -or -not $result[0].health.ok -or $result[0].health.templates_loaded -lt 4) { throw 'CLI health/template check failed.' }
    foreach ($kind in @('pause', 'speed_1x', 'speed_2x', 'speed_0_2x')) {
        if ($result[0].health.template_counts.$kind -lt 1) { throw "Missing template class: $kind" }
    }
    [IO.File]::WriteAllText((Join-Path $work 'health.json'), ($result[0] | ConvertTo-Json -Depth 20), $utf8)
    Write-Host '完成：运行时导入、版本、health 和模板检查通过'
}
try {
    $config = [PSCustomObject]@{}
    if (Test-Path -LiteralPath $cfg) {
        try {
            $configText = Get-Content -LiteralPath $cfg -Raw -Encoding UTF8
            $config = ConvertFrom-Json -InputObject $configText
            # PS 5.1 unwraps singleton JSON arrays; check the root token as well.
            if ($configText -notmatch '^\s*\{' -or $config -isnot [PSCustomObject]) { throw 'Config must be a JSON object.' }
        } catch { throw "配置文件损坏，必须是有效 JSON 对象（$cfg）：$($_.Exception.Message)" }
    }
    $configHash = if (Test-Path -LiteralPath $cfg) { Hash $cfg } else { '' }
    New-Item -ItemType Directory -Force $work, $cache, $cfgDir, (Split-Path -Parent $ext) | Out-Null
    $lock = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'runtime-lock.json') -Raw | ConvertFrom-Json
    $items = @($lock.python) + @($lock.wheels)
    $oldRelease = ''; $oldPython = ''; $oldCli = ''
    if ($config.PSObject.Properties['pythonPath'] -and $config.PSObject.Properties['cliDir']) {
        $candidate = Config-AbsolutePath $config.pythonPath
        $candidateCli = Config-AbsolutePath $config.cliDir
        $versions = [IO.Path]::GetFullPath((Join-Path $data 'versions')) + '\'
        if ($candidate -and $candidateCli -and $candidate.StartsWith($versions, [StringComparison]::OrdinalIgnoreCase) -and $candidate.EndsWith('\python\python.exe')) {
            $oldRelease = Split-Path -Parent (Split-Path -Parent $candidate)
            if ($candidateCli -eq (Join-Path $oldRelease 'backend') -and
                (Split-Path -Parent $oldRelease) -eq $versions.TrimEnd([char]92)) {
                # Junctions/symlinks cannot turn a configured private runtime into
                # an external environment. Inspect before hashing or invoking it.
                $linked = $false
                foreach ($p in @($data, $versions.TrimEnd([char]92), $oldRelease)) {
                    if ((Test-Path -LiteralPath $p) -and ((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { $linked = $true }
                }
                if (-not $linked -and (Test-Path -LiteralPath $oldRelease)) {
                    $linked = @(Get-ChildItem -LiteralPath $oldRelease -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count -gt 0
                }
                if (-not $linked) { $oldPython = $candidate; $oldCli = $candidateCli }
            }
        }
    }
    if (-not $oldPython) { Write-Host '未识别到可复用的专用环境；首次准备专用环境，不修改未知外部环境。' }
    Write-Host '[2/6] 检测专用运行时：逐组件内容校验和真实导入'
    # Installed manifests are hints, never an integrity authority. Reconstruct the
    # exact component inventory from the pinned archive before executing old Python.
    $expected = @{}
    foreach ($item in $items) {
        $archive = Fetch-Verified $item
        $extract = Join-Path $work ([Guid]::NewGuid().ToString('N'))
        [IO.Compression.ZipFile]::ExtractToDirectory($archive, $extract)
        $prefix = if ($item.filename -eq $lock.python.filename) { 'python' } else { 'python\Lib\site-packages' }
        if ($prefix -eq 'python') { [IO.File]::WriteAllText((Join-Path $extract 'python313._pth'), "python313.zip`n.`nLib\site-packages`n..\backend`n", $utf8) }
        $files = @{}
        foreach ($f in (Tree $extract).GetEnumerator()) { $files[(Join-Path $prefix $f.Key)] = $f.Value }
        $expected[$item.filename] = $files
    }
    $good = @{}; $records = @{}
    foreach ($item in $items) {
        $good[$item.filename] = $false
        if ($oldPython) {
            $files = $expected[$item.filename]
            $ok = $true
            foreach ($f in $files.GetEnumerator()) {
                if (-not (Valid (Join-Path $oldRelease $f.Key) ([PSCustomObject]@{sha256=$f.Value}))) { $ok = $false; break }
            }
            $good[$item.filename] = $ok
            $records[$item.filename] = [PSCustomObject]@{sha256=$item.sha256; files=[PSCustomObject]$files}
        }
        Write-Host "完成：$($item.filename) 文件检测，复用=$($good[$item.filename])"
    }
    if ($oldPython) {
        $allowed = @{}
        foreach ($item in $items) { foreach ($name in $expected[$item.filename].Keys) { $allowed[$name] = $true } }
        foreach ($name in (Tree (Join-Path $oldRelease 'python')).Keys) {
            if (-not $allowed.ContainsKey((Join-Path 'python' $name))) {
                Write-Host "运行时含未登记文件，重建专用环境：$name"
                foreach ($item in $items) { $good[$item.filename] = $false }
                break
            }
        }
    }
    if ($good[$lock.python.filename]) {
        $good[$lock.python.filename] = Probe $oldPython 'import sys; assert sys.version_info[:3] == (3,13,2)'
        foreach ($wheel in $lock.wheels) {
            $code = if ($wheel.filename.StartsWith('numpy-')) { 'import numpy; assert tuple(map(int,numpy.__version__.split(chr(46)))) == (2,2,3)' } else { 'import cv2; assert tuple(map(int,cv2.__version__.split(chr(46)))) == (4,11,0)' }
            # OpenCV imports numpy; a broken numpy must not invalidate intact OpenCV files.
            if ($good[$wheel.filename] -and ($wheel.filename.StartsWith('numpy-') -or $good[$lock.wheels[0].filename])) { $good[$wheel.filename] = Probe $oldPython $code }
        }
    }
    $newRuntime = @($items | Where-Object { -not $good[$_.filename] }).Count -gt 0
    Write-Host '[3/6] 准备组件：健康组件复用，损坏组件修复'
    if ($newRuntime) {
        New-Item -ItemType Directory -Force $release | Out-Null
        foreach ($item in $items) {
            if ($good[$item.filename]) {
                Write-Host "开始：复制健康组件 $($item.filename)"
                foreach ($f in $records[$item.filename].files.PSObject.Properties) {
                    $target = Join-Path $release $f.Name
                    New-Item -ItemType Directory -Force (Split-Path -Parent $target) | Out-Null
                    Copy-Item -LiteralPath (Join-Path $oldRelease $f.Name) -Destination $target
                }
                [IO.File]::WriteAllText((Join-Path $release ($item.filename + '.files.json')), ($records[$item.filename] | ConvertTo-Json -Depth 5), $utf8)
            } else {
                $archive = Fetch-Verified $item
                $extract = Join-Path $work ([Guid]::NewGuid().ToString('N'))
                Write-Host "开始：解压 $($item.filename)"
                [IO.Compression.ZipFile]::ExtractToDirectory($archive, $extract)
                $prefix = if ($item.filename -eq $lock.python.filename) { 'python' } else { 'python\Lib\site-packages' }
                if ($prefix -eq 'python') { [IO.File]::WriteAllText((Join-Path $extract 'python313._pth'), "python313.zip`n.`nLib\site-packages`n..\backend`n", $utf8) }
                $files = @{}
                foreach ($f in (Tree $extract).GetEnumerator()) {
                    $rel = Join-Path $prefix $f.Key; $files[$rel] = $f.Value
                    $target = Join-Path $release $rel
                    New-Item -ItemType Directory -Force (Split-Path -Parent $target) | Out-Null
                    Copy-Item -LiteralPath (Join-Path $extract $f.Key) -Destination $target
                }
                [IO.File]::WriteAllText((Join-Path $release ($item.filename + '.files.json')), (@{sha256=$item.sha256; files=$files} | ConvertTo-Json -Depth 5), $utf8)
            }
            Write-Host "完成：组件准备 $($item.filename)"
        }
        $python = Join-Path $release 'python\python.exe'; $cli = Join-Path $release 'backend'
        Copy-Item -LiteralPath $backend -Destination $cli -Recurse
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'runtime-lock.json') $release
    } else { $release = $oldRelease; $python = $oldPython; $cli = $oldCli; Write-Host '完成：复用已有专用运行时，不创建新版本目录' }
    Write-Host '[4/6] 比较面板与后端内容 SHA256'
    Write-Host '开始：准备面板并计算内容哈希'
    Copy-Item -LiteralPath $panel -Destination $stage -Recurse
    if (-not (Test-Path -LiteralPath (Join-Path $stage 'LICENSE'))) { Copy-Item -LiteralPath (Join-Path (Split-Path -Parent $panel) 'LICENSE') -Destination (Join-Path $stage 'LICENSE') }
    foreach ($unwanted in @('install', '.debug')) {
        $p = Join-Path $stage $unwanted
        if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
    }
    $panelChanged = -not (Same (Tree $stage) (Tree $ext))
    $backendChanged = -not (Same (Tree $backend) (Tree $cli))
    Write-Host "完成：内容比较，面板更新=$panelChanged，后端更新=$backendChanged"
    $cliBackup = "$cli.backup-$token"; $cliStage = "$cli.new-$token"
    if ($backendChanged) {
        Write-Host '开始：准备并检查新后端'
        Copy-Item -LiteralPath $backend -Destination $cliStage -Recurse
        Health $python $cliStage
        Move-Item -LiteralPath $cli -Destination $cliBackup; $backendMoved = $true
        Move-Item -LiteralPath $cliStage -Destination $cli; $backendInstalled = $true
        Write-Host '完成：后端文件切换'
    }
    Push-Location -LiteralPath $PSScriptRoot
    try { Health $python $cli } finally { Pop-Location }
    Write-Host '[5/6] 事务切换面板和配置'
    $currentHash = if (Test-Path -LiteralPath $cfg) { Hash $cfg } else { '' }
    if ($currentHash -ne $configHash) { throw '配置在安装期间被修改，停止切换，请重试。' }
    if ($panelChanged) {
        if (Test-Path -LiteralPath $ext) { Move-Item -LiteralPath $ext -Destination $backup; $panelMoved = $true }
        Move-Item -LiteralPath $stage -Destination $ext; $panelInstalled = $true
    }
    if ($TestFailure -eq 'AfterPanel') { throw 'Injected failure after panel replacement.' }
    if ($newRuntime) {
        $config | Add-Member -NotePropertyName pythonPath -NotePropertyValue $python -Force
        $config | Add-Member -NotePropertyName cliDir -NotePropertyValue $cli -Force
        [IO.File]::WriteAllText($cfgTemp, ($config | ConvertTo-Json -Depth 50), $utf8)
        if (Test-Path -LiteralPath $cfg) { [IO.File]::Replace($cfgTemp, $cfg, $cfgBackup) } else { [IO.File]::Move($cfgTemp, $cfg) }
        $configInstalled = $true
    }
    if ($TestFailure -eq 'AfterConfig') { throw 'Injected failure after config replacement.' }
    if (-not $SandboxRoot) {
        foreach ($v in 'CSXS.10', 'CSXS.11', 'CSXS.12') {
            $key = "HKCU:\Software\Adobe\$v"
            $existing = Get-ItemProperty -Path $key -Name PlayerDebugMode -ErrorAction SilentlyContinue
            $old = if ($existing) { $existing.PlayerDebugMode } else { $null }
            $registry += [PSCustomObject]@{ key = $key; old = $old }
            New-Item -Path $key -Force | Out-Null
            New-ItemProperty -Path $key -Name PlayerDebugMode -Value '1' -PropertyType String -Force | Out-Null
        }
    }
    Copy-Item -LiteralPath (Join-Path $work 'health.json') $release -Force
    Copy-Item -LiteralPath (Join-Path $work 'health.stderr.log') $release -Force
    $committed = $true
    Write-Host '完成：面板、后端、配置事务检查与切换'
    Write-Host "[6/6] 安装完成。配置：$cfg"
    Write-Host "运行时：$release；缓存：$cache。请自行关闭并重新打开 Premiere。"
} catch {
    $problem = $_
    Write-Host "安装失败：$($problem.Exception.Message)；开始回滚本次变更"
    throw $problem
} finally {
    # Finally also runs on cooperative Ctrl+C. Each rollback is independent:
    # a locked config must not prevent restoring the panel or releasing the guard.
    try {
        if (-not $committed) {
            $rollbackErrors = @()
            foreach ($entry in $registry) {
                try {
                    if ($null -eq $entry.old) { Remove-ItemProperty $entry.key PlayerDebugMode -ErrorAction SilentlyContinue }
                    else { Set-ItemProperty $entry.key PlayerDebugMode $entry.old }
                } catch { $rollbackErrors += $_.Exception.Message }
            }
            $configRestored = -not $configInstalled
            try {
                if ($configInstalled) {
                    if (Test-Path -LiteralPath $cfgBackup) { [IO.File]::Replace($cfgBackup, $cfg, $cfgTemp) } else { Remove-Item -LiteralPath $cfg -Force }
                }
                $configRestored = $true
            } catch { $rollbackErrors += "配置恢复失败（保留运行时及备份 $cfgBackup）：$($_.Exception.Message)" }
            try {
                if ($panelInstalled) { Remove-Item -LiteralPath $ext -Recurse -Force }
                if ($panelMoved) { Move-Item -LiteralPath $backup -Destination $ext }
            } catch { $rollbackErrors += "面板恢复失败（备份 $backup）：$($_.Exception.Message)" }
            try {
                if ($backendInstalled) { Remove-Item -LiteralPath $cli -Recurse -Force }
                if ($backendMoved) { Move-Item -LiteralPath $cliBackup -Destination $cli }
            } catch { $rollbackErrors += "后端恢复失败（保留备份）：$($_.Exception.Message)" }
            if ($newRuntime -and $configRestored -and (Test-Path -LiteralPath $release)) {
                try { Remove-Item -LiteralPath $release -Recurse -Force } catch { $rollbackErrors += $_.Exception.Message }
            }
            if ($rollbackErrors.Count) { Write-Warning ("回滚未完全完成，请保留备份并关闭占用程序后重试：" + ($rollbackErrors -join '; ')) }
            else { Write-Host '完成：回滚；已验证下载缓存保留，可再次运行安装器' }
        }
    foreach ($p in @($work, $stage, $cfgTemp)) {
        if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue }
    }
    if (Get-Variable cliStage -ErrorAction SilentlyContinue) { if (Test-Path -LiteralPath $cliStage) { Remove-Item -LiteralPath $cliStage -Recurse -Force -ErrorAction SilentlyContinue } }
    } finally { $guard.Dispose() }
}
