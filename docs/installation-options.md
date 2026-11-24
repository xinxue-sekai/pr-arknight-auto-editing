# Windows 安装与发行包

Windows x64 提供在线与离线两种统一 setup；安装位置、健康检查、升级与回滚行为相同，按网络情况选择：

- **在线 setup** `arknight-pr-setup-v<版本>-windows-x64.zip`：体积小，首次安装需访问 python.org 与 files.pythonhosted.org。
- **离线 setup** `arknight-pr-setup-offline-v<版本>-windows-x64.zip`：额外携带锁定运行时归档，安装不联网。

当前版本 **v0.2.1** 同时提供在线与离线 setup；历史 **v0.2.0 只有在线包**，没有离线附件，其下载超时可用下文的[手工缓存办法](#v020-下载超时的手工缓存办法)。具体发行文件名与验证范围见 [v0.2.1 发布说明](releases/v0.2.1.md)；历史 v0.2.0 发行文件见 [GitHub Releases v0.2.0](https://github.com/xinxue-sekai/pr-arknight-auto-editing/releases/tag/v0.2.0)。

## 在线 setup（网络正常）

下载 Release 的 `arknight-pr-setup-v<版本>-windows-x64.zip`，完整解压到任意目录，关闭 Premiere，再双击 `setup.bat`。无需管理员权限或预装 Python；首次安装需要连接 python.org 与 files.pythonhosted.org。安装器不会重启 Premiere，完成后由用户重新打开。

## 离线 setup（网络慢、被阻断或下载超时）

下载 Release 的 `arknight-pr-setup-offline-v<版本>-windows-x64.zip`，完整解压到任意目录，关闭 Premiere，再双击 `setup.bat`。包根目录与在线版相同，多出一个与 `setup.bat` 同级的 `runtime-deps/`，其中是 `runtime-lock.json` 列出的 CPython、NumPy 与 OpenCV 原始归档。安装器只使用包内归档或已校验的本地缓存，并禁止联网；缺件、损坏或 SHA256 不符时报告具体文件名后停止，不会回退在线下载。请完整解压整个包，不要只把 `runtime-deps/` 拷到在线包旁边。

两种 setup 都包含面板、仓库内固定 backend 快照及四类模板/源截图、LICENSE、来源记录与运行时锁文件。仅需更新面板、且已自行配置 Python 与后端的高级用户，可使用源码仓库中的 `cep-extension/install/install.bat`。Release 的 `com.arknight.autoediting-v<版本>.zip` 仅含面板，需要手工复制到 CEP 扩展目录；其中不含 `install` 脚本。setup ZIP 内也没有这个旧入口。面板 ZIP 与 ZXP 都不含完整运行环境。

统一 setup 仅安装用户级 CEP 副本；若 Premiere 安装目录中已有同 ID 的旧扩展，需自行移除旧副本或使用简单安装器的 `-PremiereDir` 流程处理。不要让多个版本遮蔽用户级扩展。

## v0.2.0 下载超时的手工缓存办法

v0.2.0 没有离线包。若 CPython、NumPy 或 OpenCV 在安装器 15 分钟总限时内未下载完：

1. 按解压目录 `runtime-lock.json` 中 `python` 与 `wheels` 的 `filename`、`url` 手工下载三个文件。
2. 对每个文件运行 `Get-FileHash -Algorithm SHA256 <文件>`，与同一份 `runtime-lock.json` 的 `sha256` 逐项比对；不一致就不要使用。
3. 将三个文件放入同一个空目录，双击 `setup.bat -DownloadCache "<该目录>"`；也可以放进 `%LOCALAPPDATA%\ArknightPR\cache` 后正常双击 `setup.bat`。

安装器仍会按锁定 SHA256 校验，不会信任未校验文件；缓存有效时后续安装可离线复用。保留该缓存，不要删除。

## 固定运行时与许可

Windows x64 使用 CPython **3.13.2 embeddable**、NumPy **2.2.3**、opencv-python-headless **4.11.0.86**。只使用 OpenCV 视频解码和模板分析，无 Tkinter、Pillow、imageio、pip 或独立 FFmpeg。外部 FFmpeg 解码模式和不兼容视频的浏览器预览代理仍需用户自行安装并配置 FFmpeg；setup 不携带该组件，不应将 FFmpeg 路径设为默认必需后端。默认 OpenCV 分析可用，FFmpeg 路径的性能收益不代表仅安装此 setup 就能获得。

[运行时清单](../cep-extension/install/runtime-lock.json)记录精确 URL、wheel ABI 和 SHA256。CPython 哈希于 2026-11-08 从 python.org HTTPS 实际下载计算；wheel 哈希来自对应版本 PyPI JSON API。在线 setup 把每个文件下载到独立空目录；离线 setup 从 `runtime-deps/` 读取同一组文件。两者都先核对 SHA256，再解压。不会追踪浮动 latest/main。下载目录与脚本分开；执行 Python 使用 `-I`，`python313._pth` 仅允许标准库、独立 site-packages 和本版本 backend，不启用用户 site 或 cwd 搜索。

CPython 的 LICENSE、wheel 的 dist-info 及其 LICENSE/第三方声明随完整解压保留。setup 与面板 ZIP 均包含项目 LICENSE，backend 保留其 LICENSE 和 SOURCE_VERSION.json。游戏截图模板的来源与使用条件以 backend 来源记录为准；MIT 代码许可不代表另行授予游戏图像权利。

## 安装位置、升级与恢复

- 运行时与 backend：`%LOCALAPPDATA%\ArknightPR\versions\<版本>-<唯一标识>\`。解压 setup 所在目录可在安装完成后删除。
- 面板：`%APPDATA%\Adobe\CEP\extensions\com.arknight.autoediting`。
- 配置：`%USERPROFILE%\.arknight-pr\config.json`，同时写入 `pythonPath` 和 `cliDir`，保留其他字段。

启动即显示中文阶段和当前组件，先检查互斥安装锁、配置，再逐组件校验文件 SHA256、真实导入版本，并运行 `python.exe -I pr_cli.py health` 检查 CLI NDJSON 结果与四类模板。健康的专用运行时直接复用，重复运行无需网络且不创建新版本目录；不会检查或修改系统 Python。面板和后端按文件内容 SHA256 比较，即使版本号相同也能识别源码变化，只更新变化的对应目录。依赖损坏时事务性准备新运行时，复制健康组件，仅从缓存修复损坏组件；缺失或损坏缓存才重新下载。

组件完整性依据锁定 SHA256 的原始归档核对，不信任可被修改或不完整的本地清单。旧环境也按相同规则检查；有有效归档缓存时无需联网。缓存缺失时需重新获取对应归档用于核对，这不等于重新安装健康组件。无归档且断网时明确停止，不凭一次 import 成功认定所有文件完整。请保留安装器的下载缓存。

下载缓存持久保存在 `%LOCALAPPDATA%\ArknightPR\cache`，每次使用前验证锁定 SHA256。下载显示百分比、已收字节和速度；服务器未提供总长度时显示已收字节。等待响应头每秒提示，连接/响应头和读取超时各为 30 秒，总下载限时 15 分钟，失败显示组件名及原因。不会显示 PowerShell 原生蓝色 Web 请求进度框。

每个成功版本保留 `health.json` 与 `health.stderr.log` 供排查。通过后才备份并切换变化的文件；面板备份移到 CEP 扩展扫描目录之外，避免旧副本被再次加载，后端保留独立备份；仅运行时路径改变时用同目录临时文件及 `File.Replace` 原子替换配置并留 `config.backup-<标识>.json`。安装器在切换前检查配置是否被其他进程修改；安装期间仍请关闭面板，避免并发编辑。

安装失败会恢复旧面板、配置及本次更改的 PlayerDebugMode，并移除失败的新运行时。成功后保留旧运行时和备份，确认新版正常后可手动清理。要手动恢复，关闭 Premiere，将相应面板备份目录恢复原名，并把对应配置备份恢复为 `config.json`；配置引用的旧运行时仍在原路径。进程被强杀或断电不属于自动异常回滚范围，可按这些备份手动恢复。

会为当前用户开启 CSXS.10/11/12 的 PlayerDebugMode，以加载未签名面板。无需修改系统 PATH，也不写系统 Python。Windows 的系统 DLL/媒体组件仍需满足 CPython/OpenCV 要求；导入失败会停止切换，不会自动安装系统组件。

新 backend 会在 session JSON 中记录版本化 `arrays_file`；安装器不扫描或依赖同名 NPZ，也不迁移用户分析会话。

## 开发和验证

```bash
node tools/package-setup.js             # 生成面板 ZIP 与在线 setup ZIP，互不删除
node tools/package.js --offline         # 生成离线 setup ZIP（同时保留现有产物）
node tools/verify-package.js            # 校验当前版本面板包
node tools/verify-package.js --setup    # 校验当前版本在线 setup 包
node tools/verify-package.js --offline  # 校验离线 setup 及 runtime-deps 锁定哈希
node tools/test-setup.js                # Windows 隔离目录内真实安装/升级/失败回滚
node tools/test-all.js                  # 全部 JS、后端测试与双包校验
```

`test-all` 的后端测试需要测试用 Python 已安装上述 NumPy/OpenCV，预览代理测试另需 PATH 中有 FFmpeg/ffprobe；可用 `PYTHON` 环境变量指定后端测试解释器。CI 安装 FFmpeg 仅用于测试，不将其加入 setup。Windows 安装测试下载真实运行时，在临时目录测试中文/空格路径、已有配置保留、两个切换点的回滚、升级保留旧环境及哈希拒绝；不改真实用户目录或注册表。非 Windows 仅验证运行时清单，明确跳过 Windows 安装测试。

可在 PowerShell 中手工指定 `setup.ps1 -SandboxRoot <隔离目录>`；该模式所有安装目标都位于指定目录且不修改注册表。`-DownloadCache <目录>` 可复用与锁文件同名的下载文件，仍强制校验 SHA256。`-TestFailure AfterPanel|AfterConfig` 和 `-TestNoNetwork`（禁止安装器网络请求）仅允许搭配隔离模式。自动测试覆盖离线重复执行、无新增版本目录、同版本面板/后端独立更新、单依赖修复、坏缓存恢复、下载失败与事务回滚，还用本地 HTTP 服务验证延迟响应头、已知/未知总长的真实分块下载进度及超时。

CI 在 Ubuntu/Windows 跑同一个全测试入口；Release 检出明确的目标 tag，在全测试成功后生成面板、在线/离线 setup 与 zxp，并校验预期附件及离线 `runtime-deps/` 的锁定 SHA256 后才创建 Release。当前尚未在无 Python 的干净 Windows 虚拟机完成端到端验收，离线包部署体验也在待验收项中，不能把开发机隔离测试等同于干净机证明。正式验收仍应覆盖无 Python/无开发工具环境、系统 DLL 条件、Premiere 加载、短视频分析、重算、EDL 和取消。
