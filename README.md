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

**已完成并验证的部分**

- Node 桥接层（进程管理、NDJSON 流式解析、取消与超时、错误码）—— 有行为测试覆盖
- ExtendScript 宿主层与面板主控的全部语法校验、manifest 与 `.debug` 的 XML 校验
- 安装脚本的语法与中文输出（已在真实的 Windows PowerShell 5.1 上验证；
  扩展复制与配置写入在开发机上因目录权限未完整跑完）

**尚未验证的部分**

- **ExtendScript 宿主层**（`createSubClip` → `createNewSequenceFromClips` → 写标记）
  没有在真实的 Premiere Pro 里跑过。这条链路上的 API 行为是本项目最大的未知数，
  不同 PR 版本的表现可能有差异。
- 面板与分析器的**真实录像联调**：UI 目前只用合成视频调过。

如果你在真实环境试跑，请把面板「环境设置」区里 `checkCapabilities` 的输出反馈回来，
这是判断版本兼容性的第一手信息。

---

## 组成

本仓库**只包含 CEP 插件本体**：

| 目录 | 内容 |
|---|---|
| [cep-extension/](cep-extension) | 面板 UI + Node 桥接 + ExtendScript 宿主脚本 + 安装脚本 |
| [docs/](docs) | 架构说明：单位约定、通信协议、错误码、运行时约束 |

插件本身**不做任何视频分析**。解析、模板匹配、分段、区间计算全部交给一个**外部的
Python 分析器**，两者职责划分如下：

```
面板（用户操作）
   │  ① Node 桥接：spawn 子进程，NDJSON 流式读进度
   ▼
外部 Python 分析器  ──→  读视频、模板匹配、算出保留区间与变速标记
   │  ② 结果落成会话文件
   ▼
面板（canvas 时间轴微调）
   │  ③ ExtendScript：createSubClip → 拼装新序列 + 写标记
   ▼
Premiere Pro 时间轴
```

> **分析器不在本仓库内。** 它是第三方项目 `arknight-auto-editing`（作者 liemark，
> MIT 协议）。本插件只通过子进程接口调用它，不包含、也不分发其任何代码，
> 使用者需要自行获取。插件的时间轴是用 canvas 自己重写的，没有复用分析器
> 附带的 Tkinter 桌面界面。

---

## 环境要求

| 组件 | 要求 | 说明 |
|---|---|---|
| Premiere Pro | 2021 (15.0) 及以上 | 开发目标版本为 **25.3.0**。走 CEP 而非 UXP，正是为了兼容 25.6 以下的版本 |
| Python | **3.10+** | 分析器用了 dataclass、f-string 与类型标注 |
| `numpy`、`opencv-python` | 必需 | 分析器的模板匹配与帧差计算依赖 |
| **外部 Python 分析器** | 需自行获取 | **不在本仓库内**，见下 |

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

指定方式有三种，按优先级：

1. 面板「环境设置」里填写目录 —— 最直观
2. `~/.arknight-pr/config.json` 的 `cliDir` 字段（安装脚本会自动写入它探测到的结果）
3. 环境变量 `ARKNIGHT_ANALYZER_DIR`

安装脚本还会顺手探测几个常见位置（扩展目录的上一级、`analyzer/` 子目录等），
但它**不包含**分析器本身，只会报告探测结果。

> 分析器的 `pyproject.toml` 里还列了 `pillow` 与 `imageio`，那是它自带 Tkinter 界面
> 与视频导出功能的依赖。插件不导出视频，所以不装也能正常工作 —— 面板只会把它们
> 标为「可选依赖未装」。
>
> 另外注意：Windows 上如果装了多个 Python，`py -3` 挑到的那个未必装了 numpy。

---

## 安装

在 `cep-extension\install\` 目录下**双击 `install.bat`**，或在终端里执行：

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

> **不要**把 `.\install.bat` 连同行尾的 `# 注释` 一起复制粘贴进 PowerShell。
> PowerShell 不支持行内 `#` 注释，整个字符串会被当成参数，必然报错。

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

**兜底路径：EDL**（慢一点，但几乎不会失败）

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

1. **Premiere 不止从一个位置读 CEP 扩展**，你装的那个未必就是它在读的那个：

   | 位置 | 说明 |
   |---|---|
   | `%APPDATA%\Adobe\CEP\extensions` | 用户级。`install.bat` 装到这里 |
   | `C:\Program Files (x86)\Common Files\Adobe\CEP\extensions` | 系统级，一般是 Adobe 官方扩展（ccx.start、frame.io 等） |
   | `<Premiere 安装目录>\CEP\extensions` | **最容易被忽略的一条**。PR 优先读它，因此**别处残留的旧版本扩展**（以前装过的、别人的）会被它先加载，表现为「菜单里只有我以前那个扩展」 |

2. 确认 `PlayerDebugMode` 已写入 `HKCU\Software\Adobe\CSXS.10 / .11 / .12`（值字符串 `1`）
3. **完全退出** Premiere 再启动。注意任务管理器里要确认没有 `Adobe Premiere Pro.exe`
   与 `CEPHtmlEngine` 残留进程，只关窗口不够
4. 仍不显示时打开日志：在 `HKCU\Software\Adobe\CSXS.12` 下新建字符串值 `LogType`，设为 `0`，
   重启 PR 后查看 `%APPDATA%\Adobe\CEP\logs\CEPHtmlEngine.log`

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

说明没定位到 `pr_cli.py`。这个分析器是**外部项目、不在本仓库内**，见上文
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
python pr_cli.py analyze --video "<你的录像.mp4>" --session-out "%TEMP%\s.json"
```

（`pr_cli.py` 启动时会把工作目录切到自己所在处，所以在任意目录执行都可以。）

---

## 为这个仓库做贡献

**没有构建步骤。** CEP 扩展是「源码即产物」—— 改完源码直接重跑安装脚本、重启 Premiere 就能看到效果，
不存在编译、打包或转译。所以贡献者 clone 下来就能立刻开始改。

### 提交前请跑一遍检查

```bash
node tools/check.js          # 语法 / manifest 一致性 / 编码 / 浏览器兼容
node tools/check-links.js    # 文档里的相对链接是否有效
node tools/package.js        # 打包到 dist/（发布时才需要）
node tools/verify-package.js # 校验打出来的包（须先跑上一条）
```

前两条与 CI（[.github/workflows/ci.yml](.github/workflows/ci.yml)）跑的是同一份代码，
本地过了 CI 基本就会过。检查项都是针对本项目踩过的坑：

| 检查 | 为什么必须要 |
|---|---|
| `node --check` 全部 JS 与 JSX | ExtendScript 的语法错误在 Premiere 里极难定位 |
| 面板代码不使用 `?.` / `??` | CEP 11（PR 2021）内嵌 **Chromium 74**，用了会让整个面板白屏 |
| `install.ps1` 必须以 UTF-8 **BOM** 开头 | 缺 BOM 时 PowerShell 5.1 按 GBK 解析，中文乱码且可能直接语法报错 |
| `install.bat` 必须是纯 ASCII | cmd.exe 对批处理源文件的非 ASCII 字节解码不可靠 |
| manifest 的 `Id` 与 `install.ps1` 的 `$ExtId` 一致 | 不一致会把扩展装进 CEP 不认的目录，菜单里看不到 |
| `manifest.xml` 标签配平 | 清单解析失败时扩展静默不加载，没有任何提示 |
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
├── .github/workflows/ci.yml     # CI：静态校验 + 文档链接检查
├── LICENSE                      # MIT（含 Third-party notices 一节）
├── README.md
├── docs/
│   └── architecture.md          # 架构、单位约定、协议、错误码
├── tools/
│   ├── check.js                 # 静态校验（与 CI 同一份，可本地跑）
│   ├── check-links.js           # 文档相对链接检查
│   ├── package.js               # 打包成可分发的 zip
│   └── verify-package.js        # 校验打出来的包结构
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

外部分析器不在本仓库内 —— 把它放在任意位置，然后在面板里指定该目录即可
（见上文「准备分析器」）。

架构细节、单位约定（ticks / 秒）、通信协议与错误码见 [docs/architecture.md](docs/architecture.md)。

---

## 许可与致谢

本仓库的代码以 **MIT License** 分发，完整协议见 [LICENSE](LICENSE)。

有两点需要特别说明：

1. **本插件依赖、但不包含**第三方项目 `arknight-auto-editing`（作者 liemark，MIT 协议）。
   该项目的代码不在本仓库内，也不由本仓库分发，使用前需自行获取。
   本插件只通过 `pr_cli.py` 定义的那个子进程接口与之协作 ——
   输入是命令行参数，输出是 stdout 上的 NDJSON。

2. [cep-extension/js/timeline.js](cep-extension/js/timeline.js) 是从该项目的
   `timeline_widget.py` **移植**而来（保持了色带语义与配色的一一对应，
   属于衍生作品）。按 MIT 条款，上游的版权声明已保留在
   [LICENSE](LICENSE) 的 Third-party notices 一节。

如果你是上游作者，对这里的署名或引用方式有意见，欢迎开 issue 讨论。
