# 更新日志

本项目所有显著变更都会记录在这个文件里。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循语义化版本，判据与发布流程见 [docs/versioning.md](docs/versioning.md)。

## [Unreleased]

待后续变更。

## [0.2.0] - 2026-11-08

### Added

- 内置 Python backend、固定来源/许可与四类模板；内容区域校准、评分缓存、会话版本化存储、冲突检测、撤销与人工覆盖隔离。
- 统一 Windows 在线 setup：独立 CPython/NumPy/OpenCV、可信归档缓存核验、健康组件复用、下载进度、内容更新及失败回滚。
- 常驻源帧预览、内容区域叠框、剪后跳切试听与可选 FFmpeg 播放代理。

### Fixed

- 安装空路径与特殊字符处理、本地清单不可作为完整性信任依据、CEP 扫描目录内备份冲突。
- 预览总帧数传递、空态破图、配置保存失败状态及 Premiere 保存返回 true 被误报失败。
- CEP manifest schema/面板 ID 结构校验与发布包逐字节校验。

### Changed

- bundle 与 panel 版本同步为 0.2.0；历史 v0.1.1 不重写。
- 早期状态同步曾据使用者确认关闭真机待办；现按后续证据细分范围，不再以该确认宣称新版全链路通过。
- 0.2x 标注疑似并提示人工复核；严格静止规则默认关闭。
- 性能仅有单素材与受控短片证据，不构成固定提速或准确率保证。安装与预览限制、完整数据入口见 [v0.2.0 发布说明](docs/releases/v0.2.0.md)。

## [0.1.1] - 2026-11-07

### Added

- `tools/make-zxp.js`：把打包产物签名为 .zxp（Adobe ZXPSignCmd，按平台
  从官方 Adobe-CEP/CEP-Resources 仓库下载并缓存、可手动注入路径）；
  每次签名临时生成自签名证书、用完即删，私钥与密码不进仓库也不进
  CI secrets。签名与校验语法已在本机（ZXPSignCmd 4.1.103 win64）端到端验证
- Release workflow 换用 Windows runner 并增加签名步骤，`.zxp` 作为
  第二个 Release asset
- `tools/test-bridge.js`：bridge.js 行为测试，用真实子进程流覆盖 NDJSON 的
  全部边界（末行无换行、单行跨 chunk、UTF-8 多字节被拆开、超大 JSON、
  stderr 噪声、取消/超时/错误码）
- CI 增加 bridge.js 行为测试步骤
- 文档：CHANGELOG.md、CONTRIBUTING.md、docs/versioning.md

### Changed

- bridge.js 导出 `runCli`（此前 `probe` / `analyze` 等封装内部才可用）

### Fixed

- 面板在真实 Premiere 25.3.0 上首跑暴露的三个问题（2026-11-07 真机验证修复）：
  - `evalScript` 走错宿主 API（`invokeAsync`）导致环境检测 Promise 永久卡死，
    改为官方实现直接调 `host.evalScript`
  - 路径常量写成大写 `EXTENSION`，原生层只认小写 `extension`，
    导致扩展目录解析返回 Invalid Input Params
  - `install.ps1` 在 PS 5.1 下写出的 `config.json` 带 UTF-8 BOM，
    面板端 `JSON.parse` 失败被吞、用户配置被静默忽略
- hostscript.jsx：ExtendScript 引擎是 ES3、没有内置 JSON，所有 JSX 调用
  必然 ReferenceError（表现为 EvalScript error）。内置零依赖 JSON 兼容层，
  仅在宿主缺原生 JSON 时安装，语义与原生对拍验证一致
- CI 在 ubuntu-latest 上 bridge 测试必败（期望值写死 Windows 路径语义，
  path.dirname 在 Linux 不认 `\`），改为平台无关断言
- CI 在 ubuntu-latest 上依赖不预装的 `unzip` 导致的失败
  （改为零依赖的 Node 包校验脚本）

## [0.1.0] - 2026-09-21

### Added

- CEP 扩展本体：
  - 面板 UI（`index.html` + `js/main.js`）与 canvas 时间轴（`js/timeline.js`，
    移植自上游分析器的 `timeline_widget.py`）
  - Node 桥接层（`js/bridge.js`）：spawn Python、NDJSON 流式解析、
    取消与超时、统一错误码
  - ExtendScript 宿主层（`hostscript.jsx`）：能力探测、子剪辑拼装、
    overwrite 兜底、Marker 写入、EDL 导入
  - CSInterface 精简实现（仓库自包含）
- 与外部 Python 分析器的协作接口约定（`pr_cli.py` 的
  `probe` / `analyze` / `ranges` / `export-edl` 子命令，stdout NDJSON）
- 安装脚本（`install.bat` / `install.ps1` / `enable-debug-mode.reg`）：
  用户级与 PR 安装目录双位置安装、PlayerDebugMode、Premiere 安装目录
  三级探测（参数 → 注册表 → 磁盘浅扫）、先暂存后替换的失败安全更新
- 打包工具（`tools/package.js`）：内置零依赖 zip 写入器，条目路径固定
  正斜杠，全平台产物一致；`tools/verify-package.js` 独立解析校验包结构
- 静态校验（`tools/check.js`）：语法、manifest 一致性、编码、Chromium 74 兼容
- 文档链接检查（`tools/check-links.js`）
- CI：静态校验 + 文档链接 + 试打包 + 包结构校验
- tag 触发的 Release workflow（tag 与 manifest 版本一致性强制校验）
- 文档：README（安装/使用/FAQ）、`docs/architecture.md`（架构与单位约定）

### Fixed

- 面板在真实 Premiere 25.3 上首跑暴露的三个问题（2026-11-07 真机验证修复）：
  - `evalScript` 走错宿主 API（`invokeAsync`）导致环境检测 Promise 永久卡死，
    改为官方实现直接调 `host.evalScript`
  - 路径常量写成大写 `EXTENSION`，原生层只认小写 `extension`，
    导致扩展目录解析返回 Invalid Input Params
  - `install.ps1` 在 PS 5.1 下写出的 `config.json` 带 UTF-8 BOM，
    面板端 `JSON.parse` 失败被吞、用户配置被静默忽略
- CI 在 ubuntu-latest 上依赖不预装的 `unzip` 导致的失败
  （改为零依赖的 Node 包校验脚本）
- Windows 上的打包缺陷：GNU tar `-a` 对 `.zip` 后缀不报错、静默产出纯 tar；
  `Compress-Archive` / `python -m zipfile` 用反斜杠做条目路径分隔符，
  非 Windows 的 unzip 会解出带字面反斜杠的散文件

### Security

- 清理了开发机本机绝对路径被写入仓库与提交历史的问题
  （历史重建为干净的单提交后发布）
