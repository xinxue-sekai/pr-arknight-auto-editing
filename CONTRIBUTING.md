# 贡献指南

感谢考虑为这个项目做贡献。这里只写动手前必须知道的事；
安装、使用与背景介绍见 [README](README.md)，架构细节见
[docs/architecture.md](docs/architecture.md)，版本与发布规则见
[docs/versioning.md](docs/versioning.md)。

## 开发环境

- **Node.js 20+**（跑检查与测试；扩展本身不依赖你的 Node，CEP 自带运行时）
- **Python 3.10+ 与 `numpy`/`opencv-python`**（只有调分析链路时才需要）
- Windows 为主开发目标（安装脚本、CEP 注册表都是 Windows 语境），
  但工具链脚本在 Linux/macOS 上同样可跑（CI 使用 Ubuntu 24.04 与 Windows；固定 Ubuntu 版本以匹配 Python 3.13.2 的可用构建）

**没有构建步骤。** CEP 扩展是「源码即产物」——改完源码重跑安装脚本、
重启 Premiere 就能看到效果。

## 提交前请跑一遍检查

```bash
node tools/check.js           # 语法 / manifest 结构与回归 / 编码 / 浏览器兼容
node tools/test-bridge.js     # bridge.js 行为测试（真实子进程流）
node tools/test-main.js       # 素材绑定、编辑版本与异步任务队列
node tools/test-timeline.js   # 帧边界、可见范围绘制与重绘合并
node tools/test-hostscript.js # 宿主拼装与部分失败保护（模拟 API）
node tools/check-links.js     # 文档里的相对链接是否有效
node tools/package.js         # 打包到 dist/（发布时才需要）
node tools/verify-package.js  # 校验打出来的包（须先跑上一条）
node tools/package-setup.js   # 面板 + 统一 Windows 在线安装 ZIP
node tools/verify-package.js --setup
node tools/test-setup.js      # Windows 临时目录真实安装/升级/回滚；不碰真实用户环境
node tools/test-all.js        # CI/Release 全测试入口，自动发现 tools/test-*.js 与 backend/test_*.py
```

这些与 CI（[.github/workflows/ci.yml](.github/workflows/ci.yml)）跑的是同一份代码，
本地通过不保证其他平台或依赖环境也通过。各项检查存在的理由（都是真实踩过的坑）：

| 检查 | 为什么必须要 |
|---|---|
| `node --check` 全部 JS 与 JSX | ExtendScript 的语法错误在 Premiere 里极难定位 |
| 面板代码不使用 `?.` / `??` | CEP 11（PR 2021）内嵌 **Chromium 74**，用了会让整个面板白屏 |
| `install.ps1` 必须以 UTF-8 **BOM** 开头 | 缺 BOM 时 PowerShell 5.1 按 GBK 解析，中文乱码且可能直接语法报错 |
| `install.bat` 必须是纯 ASCII | cmd.exe 对批处理源文件的非 ASCII 字节解码不可靠 |
| manifest 的 `ExtensionBundleId` 与 `install.ps1` 的 `$ExtId` 一致 | 不一致会把扩展装进 CEP 不认的目录，菜单里看不到 |
| `manifest.xml` CEP 结构与标签配平（含 `test-manifest.js` 回归） | 必须使用 `ExtensionManifest Version="7.0"` 与匹配的 `ExtensionList` / `DispatchInfoList`；仅标签配平无法拦截 CEP 12 的 `Unsupported Manifest version ''` |
| bridge.js 行为测试 | 覆盖 NDJSON 跨 chunk、多字节拆分、取消/超时、并发隔离、配置失败与区域检测等行为；数量以测试输出为准 |
| 文档相对链接有效 | 目录结构一动就容易留下死链 |

## 代码约束（违反任何一条都会在真实环境炸出来）

1. **`hostscript.jsx` 是严格 ES3**：不写 `let`/`const`、箭头函数、模板字符串、
   `Array.prototype.forEach` 等 ES5+ 特性。`node --check` 查不出「用了 ES5+
   的方法」这类问题，需要人工留意。
2. **面板 JS（`js/*.js` 与 `index.html` 内联脚本）面向 Chromium 74**：
   不用 `?.`、`??`、`flatMap`、`globalThis` 等新语法。`check.js` 会拦。
3. **`install.ps1` 必须保留 UTF-8 BOM**：不要用会去掉 BOM 的编辑器重存。
   检查脚本会拦住，`install.bat` 运行时也会自动补，但最好从源头避免。
4. **换行符**：`.bat` / `.ps1` / `.reg` 由 [.gitattributes](.gitattributes)
   固定为 CRLF，不要改。其他文本入库为 LF。
5. **`js/bridge.js` 只用 Node 12 与 Node 17 都支持的 API**（CEP 11 自带
   Node 12，CEP 12 自带 Node 17.7.1）。避开 `fs.promises.rm`（14.14+）、
   `AbortController`（15+）等。

## 提交信息

中文、一行主题、必要时空一行补正文说清「为什么」。参考现有历史：

```
新增 bridge.js 行为测试：真实子进程流覆盖 NDJSON 全部边界
修复打包：改用内置零依赖 zip 写入器，产物全平台一致
版本回退至 0.1.0：ExtendScript 落地链路尚未在真实 Premiere 上验证
```

## Pull Request 流程

1. 从 `main` 拉分支（命名随意，如 `feat/xxx`、`fix/xxx`）
2. 改完跑完上面那套检查
3. 开 PR，等 CI 绿；改动行为时请在描述里写清复现路径
4. 涉及 manifest 版本号的改动按 [docs/versioning.md](docs/versioning.md) 的流程走

## 报 bug 时请附上

- Premiere Pro 的具体版本号
- 面板「环境设置」区里 `checkCapabilities` 的完整输出
- 面板日志区的内容（必要时含 stderr 尾部）

Premiere 真机验证已记录部分功能，当前测试版本为 25.3.0；具体范围见
[全面自检](docs/self-check-2026-11-08.md)。模拟 API 测试不能替代完整真机验收。涉及落地行为或版本兼容性的改动，请记录实际测试的
Premiere 版本、素材条件、`checkCapabilities` 输出与面板日志；其他版本
仍需分别验证。
