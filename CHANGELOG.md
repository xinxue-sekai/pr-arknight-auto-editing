# 更新日志

本项目所有显著变更都会记录在这个文件里。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循语义化版本，判据与发布流程见 [docs/versioning.md](docs/versioning.md)。

## [Unreleased]

### Added

- `tools/test-bridge.js`：bridge.js 行为测试，用真实子进程流覆盖 NDJSON 的
  全部边界（末行无换行、单行跨 chunk、UTF-8 多字节被拆开、超大 JSON、
  stderr 噪声、取消/超时/错误码）
- CI 增加 bridge.js 行为测试步骤

### Changed

- bridge.js 导出 `runCli`（此前 `probe` / `analyze` 等封装内部才可用）

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

- CI 在 ubuntu-latest 上依赖不预装的 `unzip` 导致的失败
  （改为零依赖的 Node 包校验脚本）
- Windows 上的打包缺陷：GNU tar `-a` 对 `.zip` 后缀不报错、静默产出纯 tar；
  `Compress-Archive` / `python -m zipfile` 用反斜杠做条目路径分隔符，
  非 Windows 的 unzip 会解出带字面反斜杠的散文件

### Security

- 清理了开发机本机绝对路径被写入仓库与提交历史的问题
  （历史重建为干净的单提交后发布）
