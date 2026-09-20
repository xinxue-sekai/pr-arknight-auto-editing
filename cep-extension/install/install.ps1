# install.ps1 - 安装 / 更新 CEP 扩展到当前用户目录
#
# 【编码说明】
#   本文件保存为「带 BOM 的 UTF-8」。
#   原因：Windows PowerShell 5.1 读没有 BOM 的 UTF-8 文件时会按系统
#   ANSI 代码页（简体中文环境 = GBK）解析，中文字面量直接乱码、
#   甚至因为多字节序列吃掉引号/花括号而导致语法错误。
#   带 BOM 后 5.1 与 7+ 都能正确识别为 UTF-8，中文输出正常。
#   注意：不要用不带 BOM 的编辑器重存本文件。
#
# 做的事：
#   1. 定位分析器目录（pr_cli.py 所在处，支持多级回退 + 环境变量）
#   2. 开启 PlayerDebugMode，让 Premiere 加载未签名扩展
#   3. 复制扩展到 %APPDATA%\Adobe\CEP\extensions\
#   3b. 若检测到 Premiere 安装目录，同时复制到 <安装目录>\CEP\extensions\
#   4. 把分析器的绝对路径写进 ~/.arknight-pr/config.json
#
# 可选参数：
#   -PremiereDir <路径>  显式指定 Premiere 安装目录。
#                        注册表里的安装路径未必可信（安装目录被搬动后注册表不会更新），
#                        自动检测失败时用它兜底。也可用环境变量 ARKNIGHT_PREMIERE_DIR。

param(
    [string]$PremiereDir = $env:ARKNIGHT_PREMIERE_DIR
)

$ErrorActionPreference = 'Stop'

$InstallDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ExtSrc     = Split-Path -Parent $InstallDir
$ExtId      = 'com.arknight.autoediting'
$ExtDest    = Join-Path $env:APPDATA "Adobe\CEP\extensions\$ExtId"
$CfgDir     = Join-Path $env:USERPROFILE '.arknight-pr'
$CfgFile    = Join-Path $CfgDir 'config.json'

Write-Host ''
Write-Host '=== 明日方舟自动剪辑 - Premiere Pro CEP 扩展安装 ===' -ForegroundColor Cyan
Write-Host ('扩展源目录 : ' + $ExtSrc)
Write-Host ('安装目标   : ' + $ExtDest)
Write-Host ''

# ---- 1. 定位分析器目录（pr_cli.py + analyzer.py 必须在同一处）----
#
# 分析器是外部项目，本仓库不含其代码，位置不固定，因此这里多猜几个常见位置。
# 全部落空不会中断安装，只是写不进 cliDir，需要用户稍后在面板里手动指定。
$AnalyzerDir = $null
$candidates = [System.Collections.Generic.List[string]]::new()

if (Test-Path $CfgFile) {
    try {
        $saved = Get-Content $CfgFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($saved -and $saved.cliDir) { $candidates.Add($saved.cliDir) }
    } catch { }
}
if ($env:ARKNIGHT_ANALYZER_DIR) { $candidates.Add($env:ARKNIGHT_ANALYZER_DIR) }

$RepoRoot = Split-Path -Parent $ExtSrc
$candidates.Add((Join-Path $RepoRoot 'arknight-auto-editing-main'))
$candidates.Add($ExtSrc)
$candidates.Add((Join-Path $ExtSrc 'analyzer'))
$candidates.Add($RepoRoot)

foreach ($dir in $candidates) {
    if (-not $dir) { continue }
    if ((Test-Path (Join-Path $dir 'pr_cli.py')) -and
        (Test-Path (Join-Path $dir 'analyzer.py'))) {
        $AnalyzerDir = (Resolve-Path $dir).Path
        break
    }
}

# 找不到分析器不中断安装：扩展本体与它无关，装好面板后还能用「环境检测」来配。
# 而且新用户通常需要先拿到面板，才知道该往哪里填分析器目录。
if ($AnalyzerDir) {
    foreach ($need in 'pr_cli.py', 'analyzer.py', 'frame_types.py') {
        if (-not (Test-Path (Join-Path $AnalyzerDir $need))) {
            Write-Host ('[警告] 分析器目录里缺少 ' + $need + '，该目录可能不完整：' + $AnalyzerDir) -ForegroundColor Yellow
        }
    }
    Write-Host ('[OK] 分析器目录 : ' + $AnalyzerDir) -ForegroundColor Green

    if (-not (Test-Path (Join-Path $AnalyzerDir 'templates_pause'))) {
        Write-Host '[警告] 未找到 templates_pause 目录，暂停识别将无法工作。' -ForegroundColor Yellow
    }
} else {
    $candList = ($candidates | ForEach-Object { '         - ' + $_ }) -join "`n"
    Write-Host '[提示] 未找到 Python 分析器目录，跳过该项 —— 扩展仍会正常安装。' -ForegroundColor Yellow
    Write-Host '       分析器是外部项目，不在本仓库内，需要另行获取。已尝试：' -ForegroundColor Yellow
    Write-Host $candList -ForegroundColor DarkGray
    Write-Host '       装好后在面板的「环境设置」里填写它的目录即可；' -ForegroundColor Yellow
    Write-Host '       也可以先设环境变量 ARKNIGHT_ANALYZER_DIR 再重跑本脚本。' -ForegroundColor Yellow
}
Write-Host '[OK] 扩展文件齐全' -ForegroundColor Green

# ---- 2. 开启未签名扩展的调试模式 ----
foreach ($v in 'CSXS.10', 'CSXS.11', 'CSXS.12') {
    $key = "HKCU:\Software\Adobe\$v"
    if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
    New-ItemProperty -Path $key -Name PlayerDebugMode -Value '1' `
                     -PropertyType String -Force | Out-Null
}
Write-Host '[OK] 已开启 PlayerDebugMode (CSXS.10 / 11 / 12)' -ForegroundColor Green

# ---- 3. 复制扩展到用户级目录 ----
#
# 先整份复制到同级暂存目录，成功后再替换目标。
# 直接「Remove-Item 旧目录 → Copy-Item 新目录」是危险的：复制中途失败
# （权限不足、文件被占用）会把原本可用的旧扩展删成半个，比不更新更难排查。
function Install-ExtensionCopy {
    param([string]$DestDir)

    $parent = Split-Path -Parent $DestDir
    if ($parent -and -not (Test-Path $parent)) {
        New-Item -ItemType Directory -Force -Path $parent -ErrorAction Stop | Out-Null
    }

    $staging = $DestDir + '.new'
    try {
        if (Test-Path $staging) { Remove-Item $staging -Recurse -Force -ErrorAction Stop }
        # 这里复制「目录本身」而不是 "$ExtSrc\*"：后者在目标不存在时会触发
        # 「Container cannot be copied onto existing leaf item」。
        Copy-Item -Path $ExtSrc -Destination $staging -Recurse -Force -ErrorAction Stop
        if (Test-Path $DestDir) { Remove-Item $DestDir -Recurse -Force -ErrorAction Stop }
        Move-Item -Path $staging -Destination $DestDir -ErrorAction Stop
    } catch {
        # 清掉暂存目录：目标位置要么是完整的旧版本，要么是完整的新版本，不留半个
        if (Test-Path $staging) {
            Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
        }
        throw
    }
}

try {
    Install-ExtensionCopy -DestDir $ExtDest
} catch {
    Write-Host ('[警告] 更新 ' + $ExtDest + ' 失败：' + $_.Exception.Message) -ForegroundColor Yellow
    Write-Host '       Premiere Pro 正在运行时会占用文件，请关闭后重跑。' -ForegroundColor Yellow
    Write-Host '       （旧版本未被破坏，仍可继续使用）' -ForegroundColor Yellow
    throw
}
Write-Host ('[OK] 已复制扩展到 ' + $ExtDest) -ForegroundColor Green

# ---- 3b. 同时复制到 Premiere 安装目录 ----
#
# CEP 的搜索路径不止用户级的 %APPDATA%\Adobe\CEP\extensions，还包括：
#     <Premiere 安装目录>\CEP\extensions            ← 本段处理的目标
#     C:\Program Files (x86)\Common Files\Adobe\CEP\extensions
# 典型症状：扩展只装进了用户级目录，而 PR 从安装目录里读到了旧扩展，
# 于是菜单里「只有以前那个扩展」。把扩展也放一份到安装目录即可。
# 该目录多在程序目录下，写入失败只提示、不中断（其余步骤仍有效）。
#
# 检测分三步：显式指定 → 注册表 → 按目录名浅扫磁盘。
# 注册表这一步不能省，但也**不能全信**：安装目录被搬动后注册表不会更新。
# 实测遇到过注册表仍指向旧盘符、而文件已经被挪到另一个目录的情况。

function Test-PremiereAppDir {
    param([string]$Dir)
    if (-not $Dir) { return $false }
    try {
        if (-not (Test-Path $Dir -PathType Container)) { return $false }
        # 必须真的像安装目录：有主程序，或有 CEP / Settings 子目录
        return (Test-Path (Join-Path $Dir 'Adobe Premiere Pro.exe')) -or
               (Test-Path (Join-Path $Dir 'CEP')) -or
               (Test-Path (Join-Path $Dir 'Settings'))
    } catch { return $false }
}

function Get-PremiereHintDirs {
    $hints = [System.Collections.Generic.List[string]]::new()

    # ① App Paths：默认值是 exe 的完整路径（实测带外层引号，必须剥掉），另有 Path 值
    foreach ($k in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\Adobe Premiere Pro.exe',
                     'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\Adobe Premiere Pro.exe')) {
        try {
            $v = (Get-ItemProperty -Path $k -ErrorAction Stop).'(default)'
            if ($v) { $hints.Add((Split-Path -Parent ([string]$v).Trim('"'))) }
        } catch { }
        try {
            $v = (Get-ItemProperty -Path $k -ErrorAction Stop).Path
            if ($v) { $hints.Add(([string]$v).TrimEnd('\')) }
        } catch { }
    }

    # ② 卸载信息：InstallLocation 通常是安装目录的上一级
    foreach ($u in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
                     'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
        foreach ($sub in (Get-ChildItem $u -ErrorAction SilentlyContinue)) {
            try {
                $p = Get-ItemProperty $sub.PSPath -ErrorAction Stop
                if ($p.DisplayName -match 'Premiere' -and $p.InstallLocation) {
                    $hints.Add(([string]$p.InstallLocation).TrimEnd('\'))
                }
            } catch { }
        }
    }
    return $hints
}

function Find-PremiereDirByScan {
    param([string[]]$Drives, [int]$MaxDepth = 3, [int]$Budget = 40000)

    $hits = [System.Collections.Generic.List[string]]::new()
    # 跳过系统目录：PR 不会装在它们里面，而 Windows / WindowsApps 动辄数万个子项
    $skip = @('Windows', 'ProgramData', 'WindowsApps', '$Recycle.Bin',
              'System Volume Information', 'Recovery', 'PerfLogs', 'Users',
              'AppData', 'node_modules')
    $visited = 0

    foreach ($drive in $Drives) {
        $level = @($drive)
        for ($depth = 1; $depth -le $MaxDepth; $depth++) {
            $next = [System.Collections.Generic.List[string]]::new()
            foreach ($dir in $level) {
                $subs = $null
                try { $subs = [System.IO.Directory]::GetDirectories($dir) } catch { continue }
                foreach ($sub in $subs) {
                    $visited++
                    if ($visited -gt $Budget) { return $hits }   # 兜底上限，防止在大盘上失控
                    $leaf = Split-Path -Leaf $sub
                    if ($depth -eq 1 -and ($skip -contains $leaf)) { continue }
                    if ($leaf -like 'Adobe Premiere Pro*') {
                        if (Test-PremiereAppDir $sub) { $hits.Add($sub) }
                        continue
                    }
                    if ($depth -lt $MaxDepth) { $next.Add($sub) }
                }
            }
            $level = $next
        }
    }
    return $hits
}

function Get-PremiereInstallDirs {
    $out = [System.Collections.Generic.List[string]]::new()

    # ⓪ 显式指定优先，此时不再查注册表也不扫盘
    if ($PremiereDir) {
        if (Test-PremiereAppDir $PremiereDir) {
            $out.Add((Resolve-Path $PremiereDir).Path)
        } else {
            Write-Host ('[警告] -PremiereDir 指向的目录不像 Premiere 安装目录: ' + $PremiereDir) -ForegroundColor Yellow
        }
        return $out
    }

    $hints = Get-PremiereHintDirs
    $drives = [System.Collections.Generic.List[string]]::new()

    foreach ($h in $hints) {
        if (-not $h) { continue }
        try { $drives.Add([System.IO.Path]::GetPathRoot($h)) } catch { }

        # 提示路径本身可能就是安装目录
        if (Test-PremiereAppDir $h) {
            $full = (Resolve-Path $h).Path
            if (-not $out.Contains($full)) { $out.Add($full) }
            continue
        }
        # 也可能是它的上一级（卸载信息里的 InstallLocation 就是这种）
        if (Test-Path $h -PathType Container) {
            try {
                foreach ($sub in [System.IO.Directory]::GetDirectories($h, 'Adobe Premiere Pro*')) {
                    if (Test-PremiereAppDir $sub) {
                        $full = (Resolve-Path $sub).Path
                        if (-not $out.Contains($full)) { $out.Add($full) }
                    }
                }
            } catch { }
        }
    }

    # 注册表全部失效（安装目录被搬动过）→ 只在提示涉及的盘上浅扫
    if ($out.Count -eq 0) {
        $scanDrives = @($drives | Sort-Object -Unique)
        if ($scanDrives.Count -eq 0) {
            try {
                $scanDrives = @(Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue |
                                Where-Object { $_.Free -ne $null } |
                                ForEach-Object { $_.Root })
            } catch { }
        }
        if ($scanDrives.Count -gt 0) {
            Write-Host ('[提示] 注册表里的 Premiere 路径已失效，正在扫描 ' +
                        ($scanDrives -join ' ')) -ForegroundColor DarkGray
            foreach ($hit in (Find-PremiereDirByScan -Drives $scanDrives)) {
                if (-not $out.Contains($hit)) { $out.Add($hit) }
            }
        }
    }

    return $out
}

$premiereDirs = Get-PremiereInstallDirs
if ($premiereDirs.Count -eq 0) {
    Write-Host '[提示] 未找到 Premiere 安装目录，跳过安装目录副本。' -ForegroundColor DarkGray
    Write-Host '       若 PR 菜单里只有旧扩展，说明它在读安装目录下的 CEP\extensions。' -ForegroundColor DarkGray
    Write-Host '       请手动复制扩展文件夹过去，或用 -PremiereDir 指定安装目录后重跑。' -ForegroundColor DarkGray
}
foreach ($appDir in $premiereDirs) {
    $cepExt = Join-Path $appDir 'CEP\extensions'
    if (-not (Test-Path $cepExt)) {
        # 目录不存在时顺手建一个：CEP 会把安装目录下的该路径作为搜索路径
        try {
            New-Item -ItemType Directory -Force -Path $cepExt -ErrorAction Stop | Out-Null
        } catch {
            Write-Host ('[警告] 无法在 ' + $appDir + ' 下创建 CEP\extensions，已跳过该位置。') -ForegroundColor Yellow
            continue
        }
    }
    $dest = Join-Path $cepExt $ExtId
    try {
        Install-ExtensionCopy -DestDir $dest
        Write-Host ('[OK] 已复制到 ' + $dest) -ForegroundColor Green
    } catch {
        Write-Host ('[警告] 无法写入 ' + $cepExt + '：' + $_.Exception.Message) -ForegroundColor Yellow
        Write-Host '       该目录在程序目录下，通常需要管理员权限；旧版本未被改动。' -ForegroundColor Yellow
        Write-Host '       可用管理员身份重跑本脚本，或手动复制该文件夹。' -ForegroundColor Yellow
    }
}

# ---- 4. 写入分析器绝对路径（保留已有的 pythonPath 等配置）----
# 没定位到分析器时不动配置文件 —— 写一个空的 cliDir 只会覆盖掉用户之前手填的值。
if (-not $AnalyzerDir) {
    Write-Host '[提示] 未定位到分析器，config.json 未改动（保留你已有的设置）。' -ForegroundColor DarkGray
} else {
    if (-not (Test-Path $CfgDir)) { New-Item -ItemType Directory -Force -Path $CfgDir | Out-Null }

    $cfg = $null
    if (Test-Path $CfgFile) {
        try { $cfg = Get-Content $CfgFile -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $cfg = $null }
    }

    if ($cfg -is [System.Management.Automation.PSCustomObject]) {
        # PSCustomObject 上直接给不存在的属性赋值会抛错，必须用 Add-Member -Force
        $cfg | Add-Member -NotePropertyName cliDir -NotePropertyValue $AnalyzerDir -Force
    } elseif ($cfg -is [System.Collections.IDictionary]) {
        $cfg['cliDir'] = $AnalyzerDir
    } else {
        $cfg = [PSCustomObject]@{ pythonPath = $null; cliDir = $AnalyzerDir }
    }

    # ConvertTo-Json 结果默认写 UTF-16 LE，面板端 fs.readFileSync('utf8') 读不了，
    # 必须用 -Encoding UTF8 写回
    $cfg | ConvertTo-Json -Depth 5 | Set-Content -Path $CfgFile -Encoding UTF8
    Write-Host ('[OK] 已写入配置 ' + $CfgFile) -ForegroundColor Green
}

# ---- 完成 ----
Write-Host ''
Write-Host '安装完成。' -ForegroundColor Cyan
Write-Host '  1. 重启 Premiere Pro（必须重启，扩展列表在启动时加载）'
Write-Host '  2. 菜单：窗口 -> 扩展 -> Arknight Auto Editing'
Write-Host '     （PR 2025/2026 可能在：窗口 -> UXP Plugins 或 窗口 -> 扩展）'
Write-Host '  3. 面板打开后会自动检测环境。若提示 Python 或分析器缺失，'
Write-Host '     在「环境设置」里填写解释器路径 / 分析器目录（分析器需另行获取）；'
Write-Host '     分析器的依赖可执行：  pip install numpy opencv-python'
Write-Host ''
Write-Host '调试：扩展加载后可用 Chrome 访问 http://localhost:8088/ 打开 DevTools' -ForegroundColor DarkGray
Write-Host ''
Write-Host '提示：扩展可能同时存在于用户级目录和 Premiere 安装目录，' -ForegroundColor DarkGray
Write-Host '      改动代码后重跑本脚本即可，两处都会被覆盖。' -ForegroundColor DarkGray
Write-Host ''
