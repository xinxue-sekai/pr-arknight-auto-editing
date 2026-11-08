# 明日方舟自动剪辑 · Premiere Pro 插件

把「明日方舟」录屏里的**暂停等待、重复跑图、倍速播放**自动识别出来并剪掉，
直接在 Premiere Pro 里生成一条剪好的序列 —— 不用导出中间文件，也不用手动对齐时码。

识别结果会画成一条可交互的时间轴色带：

- **右键**某段色块 → 在「保留 / 删除」之间切换
- **拖动**青色手柄 → 微调该段的保留边界
- **滚轮**缩放，**Shift+左键 / 中键**平移

改动后会自动重算，实时看到「保留多少秒、压缩到百分之几」。

---

## 项目状态

请先读这一节再决定要不要用。

当前版本 **0.2.0** 新增内置后端、统一 Windows 安装器及视频预览，仍处于 0.x。
完整变更见 [发布说明](docs/releases/v0.2.0.md)。

**已记录的验证（2026-11-08）**

- 自动测试覆盖桥接、后端会话、预览、主控、时间轴、宿主模拟 API 与安装事务。
- Premiere Pro **25.3.0** 已记录环境检测、分析、时间轴、EDL 导出与旧轮885段序列生成；后续已确认旧项目重开、新面板加载、源帧0→1预览及保存按钮成功。
- Windows 正式用户级 setup 安装及保留可信缓存后的重复复用已有记录；干净 Windows 虚拟机尚未验收。
- 这些结果不代表新版全链路、逐段源点/音频精度、长期音画同步或识别准确率通过。0.2x 仍有过场假阳性，需人工复核；严格静止规则为默认关闭的实验选项。

验证范围、性能证据与已知限制见 [验证状态与已知限制](docs/verification-status.md)。

**仍需收集的兼容性反馈**

当前已记录的 Premiere 版本为 **25.3.0**，清单声明的其他版本不等于已逐一验证。
反馈问题时，请附面板「环境设置」中的 `checkCapabilities` 输出与面板日志。

---

## 组成

本仓库包含 CEP 面板、Python 后端及统一安装工具：

| 目录 | 内容 |
|---|---|
| [cep-extension/](cep-extension) | 面板 UI + Node 桥接 + ExtendScript 宿主脚本 + 安装脚本 |
| [backend/](backend) | 固定来源的分析器、会话存储、预览服务和模板 |
| [docs/](docs) | 架构说明：单位约定、通信协议、错误码、运行时约束 |

面板通过 Node 子进程调用仓库内的 Python 后端，负责解析、模板匹配、分段与区间计算：

```
面板（用户操作）
   │  ① Node 桥接：spawn 子进程，NDJSON 流式读进度
   ▼
内置 Python 后端    ──→  读视频、模板匹配、算出保留区间与变速标记
   │  ② 结果落成会话文件
   ▼
面板（canvas 时间轴微调）
   │  ③ ExtendScript：createSubClip → 拼装新序列 + 写标记
   ▼
Premiere Pro 时间轴
```

> backend 源自 `arknight-auto-editing`（liemark，MIT），本仓库包含并随 setup 分发固定快照及本地改进。来源见 [SOURCE_VERSION.json](backend/SOURCE_VERSION.json)，许可见 [backend/LICENSE](backend/LICENSE)。面板 ZIP/ZXP 不包含完整后端运行环境。

---

## 环境要求

| 组件 | 要求 | 说明 |
|---|---|---|
| Premiere Pro | 2021 (15.0) 及以上 | 开发目标版本为 **25.3.0**。走 CEP 而非 UXP，正是为了兼容 25.6 以下的版本 |
| Python | **3.10+** | 分析器用了 dataclass、f-string 与类型标注 |
| `numpy`、`opencv-python` | 必需 | 分析器的模板匹配与帧差计算依赖 |
| Python 后端 | 仓库内 `backend/` | 推荐 setup 自动配置；源码开发可手动指定 |
| FFmpeg | 可选，自行安装 | FFmpeg 解码与不兼容视频播放代理使用；默认 OpenCV 分析不需要 |

安装分析器依赖：

```bash
pip install numpy opencv-python
```

### 准备分析器

插件启动时要定位到分析器目录，该目录里必须**同时**存在这三个文件：

```
pr_cli.py       ← 插件调用的唯一入口
analyzer.py     ← 模板匹配 / 分段算法
frame_types.py  ← 帧类型常量
```

推荐 setup 自动写入 `~/.arknight-pr/config.json` 的 `pythonPath` 和 `cliDir`。
源码开发可在面板「环境设置」指定本仓库 `backend/` 与装好依赖的 Python。
桥接优先使用配置，然后探测扩展旁/内部的 `backend` 和兼容旧目录，最后检查
`ARKNIGHT_ANALYZER_DIR`。`install.bat` 只安装面板，完整环境请用 `setup.bat`。

Windows 多 Python 环境请将依赖安装到面板实际选择的解释器；`py -3` 未必指向它。

---

## 安装

### 完整安装：双击 setup.bat（推荐）

1. 关闭 Premiere，将最新 `arknight-pr-setup-v<版本>-windows-x64.zip` 完整解压到一个新目录，避免误开之前解压的旧安装器。
2. 打开其中的 `arknight-pr-setup` 文件夹，双击 **`setup.bat`**。
3. 窗口会显示检测、复用、下载、验证和安装各阶段；出现“安装完成”后再启动 Premiere。

已有 Python 的用户也使用此入口。安装器检测插件专用环境：健康组件复用，缺失或损坏组件才准备；完整性必须依据锁定 SHA256 的可信原始归档核对，不信任本地清单或仅 import 成功。缓存缺失时仍须下载归档用于核对；无可信归档且断网时停止。仅面板或 backend 内容更新不重新下载运行时。首次缺少缓存时需要联网，此包不是离线包。

安装器准备独立 Python、NumPy/OpenCV、内置 backend 和模板，不修改系统 Python 或 PATH；健康检查通过后更新 `pythonPath`/`cliDir`，升级失败恢复旧配置与文件。位置、许可、备份恢复及验证范围见 [Windows 安装说明](docs/installation-options.md)。

### 高级：仅安装面板

仅当你已自行准备兼容分析器、Python 及依赖时，才使用源码目录 `cep-extension\install\` 下的 `install.bat`。它不是上述完整安装包的入口：

```powershell
.\install.bat
```

脚本会做这几件事：

1. 定位 Python 分析器目录（多级回退探测，也可用 `ARKNIGHT_ANALYZER_DIR` 事先指定）
2. 开启 `PlayerDebugMode`（写入 `HKCU\Software\Adobe\CSXS.10 / .11 / .12`）—— 让 PR 加载未签名扩展
3. 把扩展复制到 `%APPDATA%\Adobe\CEP\extensions\com.arknight.autoediting`
4. 若检测到 Premiere 安装目录，同时复制到 `<安装目录>\CEP\extensions\`（该位置通常需要管理员权限）
5. 把分析器绝对路径写进 `~/.arknight-pr/config.json`

复制采用「先整份复制到暂存的 `xxx.new`、成功后再替换」的方式：写入失败时**旧版本不会被破坏**。

> **面板分发形态**：除统一 setup 外，Release 还提供面板 `.zip` 与 `.zxp`。面板 zip 按上文手动放置
> （需要开 `PlayerDebugMode`）；zxp 用任意 ZXP 安装器（ZXP Installer、
> Anastasiy Extension Manager 等）双击安装，不用开调试模式，但因为是
> **每次发布临时生成的自签名证书**，安装时会提示「发布者不受信任」。
> 没有顺手的 ZXP 安装器就用 zip，两者内容一致。

> **不要**把 `.\install.bat` 连同行尾的 `# 注释` 一起复制粘贴进 PowerShell。
> 复制时只选命令本身，避免混入文档标记；PowerShell 本身支持行内 `#` 注释。

安装完成后**必须重启 Premiere Pro**（扩展列表只在启动时加载一次）。

找不到菜单项时，按版本不同位置可能是：

- `窗口 → 扩展 → Arknight Auto Editing`
- `窗口 → UXP Plugins → Arknight Auto Editing`（较新的 2025/2026）

---

## 使用

1. 打开面板后，点「重新检测环境」，确认 Python、依赖、分析器目录、Premiere 能力四项都正常。
2. 点「从 PR 获取」自动抓取项目面板/时间轴里选中的素材，
   或直接手动填写视频路径。
3. 点「开始分析」。分析是流式的，进度条会显示阶段与百分比，随时可以取消。
4. 在时间轴上微调（见开头的交互说明）。
5. 落地，二选一：
   - **落地到 Premiere**：新建一条序列，按保留区间顺序拼装
   - **导出 EDL** → **导入 EDL**：兼容性更好的兜底路径

---

## 预览的范围

预览支持源帧查看、内容区域校准及剪后跳切试听。分析前总帧数是估计值，分析完成后以结果为准。浏览器不支持的编码可生成 H.264/AAC 播放代理，需自行配置 FFmpeg；setup 不包含 FFmpeg。逐帧预览与浏览器连续播放是不同路径，跳切试听不保证帧精确剪接或长期音画同步，最终输出仍需在 Premiere 检查。

## 关于「变速」，有一句话必须说清楚

Premiere 的插件 API —— **ExtendScript 与 UXP 都一样** —— 没有修改片段速度的接口，
连 QE DOM 也没有。

所以本项目**不会**、也无法替你自动设置倍速。它做的是：

1. 把识别出的变速区间换算成时间轴上的**橙色标记**
2. 在标记名与注释里写清建议值（例如「变速 2x → 100%」）
3. 你在时间轴上选中对应片段，右键 →「速度/持续时间」，按建议值手动设置

这是能力上限，不是偷懒。如果哪天 Adobe 补上这个 API，这里会立刻跟进。

---

## 两条落地路径

**主路径：子剪辑拼装**（快，一次性完成）

对每个保留区间调 `ProjectItem.createSubClip()` 生成一个子剪辑，
再用 `Project.createNewSequenceFromClips()` 一次性按顺序拼成新序列。
好处是无须手算 record 位置、不需要先铺满再删除，序列的帧率与尺寸自动匹配源素材。

**兜底路径：EDL**（仍需验证当前素材的导入与时间码）

导出 CMX3600 EDL，再让 Premiere 导入。EDL 是行业标准交换格式，
不依赖任何「可能不存在」的 API。当面板提示「createSubClip 支持不佳」时改走这条。

---

## 常见问题

**面板一片空白，或提示「Node.js 不可用」**

三个可能原因，按顺序排查：

1. `CSXS/manifest.xml` 里的 `CEFCommandLine` 缺少 `--enable-nodejs` 或 `--mixed-context`
2. 你是在浏览器里直接打开了 `index.html` —— 必须通过 Premiere 的「窗口 → 扩展」打开
3. 改过 manifest 但没重启 Premiere

**菜单里找不到扩展**

按顺序排查：

0. **「扩展」菜单是灰的？先打开或新建一个项目再看。** Premiere 停在主页（未打开任何项目）时，
   「窗口」菜单下所有面板类条目——包括「扩展」——一律禁用。这是 PR 的正常行为，
   不是安装失败。本项目的开发期就曾被它误导了两轮排查。
1. **Premiere 不止从一个位置读 CEP 扩展**，你装的那个未必就是它在读的那个：

   | 位置 | 说明 |
   |---|---|
   | `%APPDATA%\Adobe\CEP\extensions` | 用户级。`install.bat` 装到这里 |
   | `C:\Program Files (x86)\Common Files\Adobe\CEP\extensions` | 系统级，一般是 Adobe 官方扩展（ccx.start、frame.io 等） |
   | `<Premiere 安装目录>\CEP\extensions` | **最容易被忽略的一条**。PR 优先读它，因此**别处残留的旧版本扩展**（以前装过的、别人的）会被它先加载，表现为「菜单里只有我以前那个扩展」 |

2. 确认 `PlayerDebugMode` 已写入 `HKCU\Software\Adobe\CSXS.10 / .11 / .12`（值字符串 `1`）
3. **完全退出** Premiere 再启动。注意任务管理器里要确认没有 `Adobe Premiere Pro.exe`
   与 `CEPHtmlEngine` 残留进程，只关窗口不够
4. 仍不显示时打开日志：在 `HKCU\Software\Adobe\CSXS.12` 下新建字符串值 `LogType`，
   设为 `all`，重启 PR 后查看 `%APPDATA%\Adobe\CEP\logs\CEPHtmlEngine.log`。
   （注意值是字符串 `all`，不是数字 —— 设成 `0` 不会生成日志。）

> `install.bat` 会**同时尝试**用户级目录和 Premiere 安装目录。安装目录多在程序目录下、
> 写入通常需要管理员权限，失败时脚本只告警、不影响用户级安装。
>
> 自动检测的顺序是：`-PremiereDir` 参数 → 注册表（App Paths、卸载信息）→
> 按目录名浅扫磁盘。**注册表未必可信** —— 安装目录被搬动过之后注册表不会更新。
> 自动检测失败时，用显式参数指定（把路径换成你自己的 Premiere 安装目录）：
>
> ```powershell
> .\install.bat -PremiereDir "D:\你的路径\Adobe Premiere Pro 2025"
> ```

**「环境存在问题」，提示 Python 缺失**

在面板的「环境设置」里手动填写解释器路径，或安装 Python 3.10+。
注意 Windows 上如果有多个 Python，`py -3` 挑到的那个未必装了 numpy。

**「环境存在问题」，提示找不到分析器目录**

说明没定位到 `pr_cli.py`。使用 setup 修复环境，或指定仓库内 `backend/`，见上文
[准备分析器](#准备分析器) —— 先按那三种方式之一把目录指定好。
面板在没有分析器时仍能打开、能看日志，但「开始分析」无法工作。

**提示必需依赖缺失**

在分析器目录执行 `pip install numpy opencv-python`。

**落地时报「无法创建目标序列」**

`createSubClip` / `createNewSequenceFromClips` 在当前 PR 版本上不可用。
改用「导出 EDL」→「导入 EDL」，面板日志里也会这么提示。

**落地后日志说「时长校验偏差」**

通常是源素材的起始时间码不为 0。排查方向见 `hostscript.jsx` 里的 `sourceOffsetTicks`。

**安装脚本报「无法删除旧版本」**

旧的安装目录被正在运行的 Premiere 占用。关掉 PR 再跑一次。

**`install.ps1` 的中文输出乱码**

该文件必须保存为**带 BOM 的 UTF-8**。Windows PowerShell 5.1 读没有 BOM 的 UTF-8 会按
系统 ANSI（简中环境即 GBK）解析，中文字面量会乱码，甚至因多字节序列吃掉引号而导致语法错误。
若你用无 BOM 的编辑器重存过该文件，请把 BOM 加回去。

---

## 调试

CEP 的 `.debug` 文件已开启远程调试端口 8088。扩展加载后，用 Chrome 访问：
```
http://localhost:8088/
```

即可打开 DevTools 查看面板的 console 与网络请求。

Python 侧的诊断信息全部走 stderr，面板只在**出错时**回显最后若干行，
避免 OpenCV 的逐帧告警刷屏。需要完整输出时，直接手动执行：

```bash
python backend/pr_cli.py analyze --video "<你的录像.mp4>" --session-out "%TEMP%\s.json"
```

（从仓库根目录运行；其他目录请传 `backend/pr_cli.py` 的绝对路径。后端不改变调用者工作目录。）

---

## 为这个仓库做贡献

动手前请先读 [CONTRIBUTING.md](CONTRIBUTING.md) —— 里面有检查清单、
代码约束（ES3 / Chromium 74 / BOM）和提交规范。

**没有构建步骤。** CEP 扩展是「源码即产物」—— 改完源码直接重跑安装脚本、重启 Premiere 就能看到效果，
不存在编译、打包或转译。所以贡献者 clone 下来就能立刻开始改。

### 提交前请跑一遍检查

```bash
node tools/check.js           # 语法 / manifest 结构与回归 / 编码 / 浏览器兼容
node tools/test-bridge.js     # bridge.js 行为测试（真实子进程流）
node tools/test-main.js       # 素材绑定、编辑版本与异步任务队列
node tools/test-timeline.js   # 帧边界、可见范围绘制与重绘合并
node tools/test-hostscript.js # 宿主拼装与部分失败保护（模拟 API）
node tools/check-links.js     # 文档里的相对链接是否有效
node tools/package.js         # 打包到 dist/（发布时才需要）
node tools/verify-package.js  # 校验打出来的包（须先跑上一条）
```

上述检查均已接入 CI（[.github/workflows/ci.yml](.github/workflows/ci.yml)），
在 Ubuntu 与 Windows 上运行。宿主测试使用模拟 API，不替代 Premiere 真机回归。检查项都是针对本项目踩过的坑：

| 检查 | 为什么必须要 |
|---|---|
| `node --check` 全部 JS 与 JSX | ExtendScript 的语法错误在 Premiere 里极难定位 |
| 面板代码不使用 `?.` / `??` | CEP 11（PR 2021）内嵌 **Chromium 74**，用了会让整个面板白屏 |
| `install.ps1` 必须以 UTF-8 **BOM** 开头 | 缺 BOM 时 PowerShell 5.1 按 GBK 解析，中文乱码且可能直接语法报错 |
| `install.bat` 必须是纯 ASCII | cmd.exe 对批处理源文件的非 ASCII 字节解码不可靠 |
| manifest 的 `ExtensionBundleId` 与 `install.ps1` 的 `$ExtId` 一致 | 不一致会把扩展装进 CEP 不认的目录，菜单里看不到 |
| `manifest.xml` CEP 结构与标签配平（含 `test-manifest.js` 回归） | 必须使用 `ExtensionManifest Version="7.0"` 与匹配的 `ExtensionList` / `DispatchInfoList`；仅标签配平无法拦截 CEP 12 的 `Unsupported Manifest version ''` |
| bridge.js 行为测试 | 覆盖跨 chunk、多字节拆分、取消/超时、并发隔离、配置失败与区域检测等行为；数量以测试输出为准 |
| 文档相对链接有效 | 目录结构一动就容易留下死链 |

### 编辑器的注意事项

- **不要**用会在保存时去掉 BOM 的编辑器改 `install.ps1`。检查脚本会拦住这种情况，
  `install.bat` 运行时也会自动补 BOM，但最好从源头避免。
- 仓库通过 [.gitattributes](.gitattributes) 把 `.bat` / `.ps1` / `.reg` 的换行符固定为 CRLF。
  如果你的 Git 报了换行符相关的 warning，执行 `git add --renormalize .` 归一化一次。

### 改动 ExtendScript 层时特别注意

[cep-extension/hostscript.jsx](cep-extension/hostscript.jsx) 运行在 **ES3** 引擎里，
不支持 `let` / `const`、箭头函数、模板字符串、`Array.prototype.forEach` 等。
`node --check` 能查语法，但查不出「用了 ES5+ 的方法」这类问题 —— 需要人工留意。

---

## 目录结构

```
.
├── .gitattributes               # 固定 Windows 脚本的换行符为 CRLF
├── .github/workflows/ci.yml     # CI：静态校验 + 行为测试 + 文档链接检查
├── CHANGELOG.md                 # 更新日志（Keep a Changelog 格式）
├── CONTRIBUTING.md              # 贡献指南
├── LICENSE                      # MIT（含 Third-party notices 一节）
├── README.md
├── backend/                     # 内置分析器、模板、会话与预览服务
├── docs/
│   ├── architecture.md          # 架构、单位约定、协议、错误码
│   └── versioning.md            # 版本号规则与发布流程
├── tools/
│   ├── check.js                 # 静态校验（与 CI 同一份，可本地跑）
│   ├── test-bridge.js           # bridge.js 行为测试
│   ├── check-links.js           # 文档相对链接检查
│   ├── package.js               # 打包成可分发的 zip
│   ├── verify-package.js        # 校验打出来的包结构
│   └── make-zxp.js              # 签名为 .zxp（可选分发形态）
└── cep-extension/
    ├── CSXS/manifest.xml        # 扩展清单：PPRO [15.0,99.9]、CSXS 11.0
    ├── index.html               # 面板
    ├── hostscript.jsx           # ExtendScript 宿主层（严格 ES3）
    ├── .debug                   # CEP 远程调试端口（8088）
    ├── css/style.css
    ├── js/
    │   ├── csinterface.js       # CSInterface 精简实现（仓库自包含）
    │   ├── bridge.js            # Node 桥接：spawn Python + NDJSON 解析
    │   ├── timeline.js          # canvas 时间轴（移植自上游 timeline_widget.py）
    │   └── main.js              # 面板主控
    └── install/
        ├── install.bat          # 双击入口（纯 ASCII，转发参数给 ps1）
        ├── install.ps1          # 真正的安装逻辑（UTF-8 **带 BOM**）
        └── enable-debug-mode.reg
```

内置后端位于 `backend/`；setup 分发并配置它，面板 ZIP/ZXP 用户需另行配置运行环境。

架构细节、单位约定（ticks / 秒）、通信协议与错误码见 [docs/architecture.md](docs/architecture.md)。

---

## 许可与致谢

本仓库的代码以 **MIT License** 分发，完整协议见 [LICENSE](LICENSE)。

有两点需要特别说明：

1. 本仓库包含并分发上游 `arknight-auto-editing`（liemark，MIT）的后端快照及本地改进。
   来源和快照信息见 [backend/SOURCE_VERSION.json](backend/SOURCE_VERSION.json)，上游许可保留在
   [backend/LICENSE](backend/LICENSE)。游戏截图模板的权利不因 MIT 代码许可而另行授予。

2. [cep-extension/js/timeline.js](cep-extension/js/timeline.js) 是从该项目的
   `timeline_widget.py` **移植**而来（保持了色带语义与配色的一一对应，
   属于衍生作品）。按 MIT 条款，上游的版权声明已保留在
   [LICENSE](LICENSE) 的 Third-party notices 一节。

如果你是上游作者，对这里的署名或引用方式有意见，欢迎开 issue 讨论。
