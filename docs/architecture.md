# 架构说明

这份文档记录**只靠读代码很难看出来、但踩过就会花很久**的约定：
通信协议、单位陷阱、路径约定、落地策略与运行时约束。
改动本项目前请先通读一遍，尤其是「单位约定」一节。

---

## 1. 为什么是 CEP，不是 UXP

Adobe 主推的现代扩展方案是 UXP，但 **UXP 要求 Premiere Pro 25.6+**。
本项目要兼容 25.3.0 及更低版本，所以只能走 CEP。

代价是必须接受两套历史包袱：

| | CEP 11（PR 2021 起） | CEP 12（PR 25.0 起） |
|---|---|---|
| 内嵌 Node | 12 | 17.7.1 |
| 内嵌 Chromium | **74** | 88 |

因此代码里有两条硬约束：

- **面板 JS 必须能被 Chromium 74 解析**。可选链 `?.`、空值合并 `??` 需要 Chrome 80+，
  在 CEP 11 上会直接让整个 `main.js` 解析失败、面板白屏。
- **Node 侧只用 Node 12 与 17 都稳定支持的 API**。刻意避开
  `fs.promises.rm`（14.14+）、`AbortController`（15+）等。

好消息是 `ProjectItem.createSubClip()` 是 **ExtendScript 独有**的能力，UXP 里没有 ——
CEP 路线在功能上并没有吃亏。

---

## 2. 三层结构

```
┌─────────────────────────────────────────────────────────┐
│  CEP 面板（Chromium，index.html + js/main.js）           │
│  用户交互 · canvas 时间轴 · 日志                          │
└───────────┬─────────────────────────────┬───────────────┘
            │                             │
   ① window.ArknightBridge         ② CSInterface.evalScript
     （Node child_process）           （evalJSON → JSON 字符串）
            │                             │
┌───────────▼──────────────┐   ┌──────────▼────────────────┐
│  Node 桥接层 bridge.js    │   │  ExtendScript hostscript.jsx│
│  spawn Python · NDJSON 解析│   │  Premiere DOM 操作          │
└───────────┬──────────────┘   └──────────┬────────────────┘
            │                             │
┌───────────▼──────────────┐   ┌──────────▼────────────────┐
│  Python 分析器 pr_cli.py  │   │  Premiere Pro 项目 / 时间轴 │
│  analyzer.py 模板匹配      │   └───────────────────────────┘
└──────────────────────────┘
```

三条链路各司其职，**面板不直接调用 Python，Python 也不直接操作 PR**：

- 面板 ↔ Node 桥接：同一进程内的全局对象，直接函数调用
- 面板 ↔ ExtendScript：异步 `evalScript`，有长度与转义限制（见 §4）
- Node ↔ Python：子进程 + stdout 管道

### 为什么桥接层用 `child_process` 而不是常驻 HTTP 服务

- 不占端口、不触发 Windows 防火墙弹窗
- 进程生命周期跟随一次分析，崩溃不会留下僵尸服务
- 不需要处理并发请求与会话隔离

---

## 3. 一次完整分析的时序

```
用户点「开始分析」
  → main.js: collectParams() 收集表单参数
  → bridge.analyze(video, params)
      → 参数写入 ~/.arknight-pr/payload/params.json   （避开 32KB 命令行上限）
      → spawn: python pr_cli.py analyze --video ... --session-out ... --params ...
  → pr_cli.py: 逐帧模板匹配，期间持续 emit progress
  → 分析完成，写 session（.json + .npz），emit result
  → main.js: applySession() → timeline.setData() 画色带
用户拖动时间轴手柄 / 右键切换保留态
  → timeline 回调 onChange → main.js: recompute()
  → bridge.recompute(session, overrides, params)
      → overrides 写入 payload/overrides.json     （含逐段掩码，可达数百 KB）
      → spawn: python pr_cli.py ranges --session ... --overrides ...
  → 只读 .npz 里的 states/diffs 重算，不重新解码视频
用户点「落地到 Premiere」
  → payload 写入 payload/apply.json
  → jsx('applyEdit', 文件路径)
  → hostscript.jsx: createSubClip × N → createNewSequenceFromClips → 写标记
  → 读回序列真实 clip 数与时长 ticks，回报给面板做校验
```

---

## 4. 通信协议

### 4.1 面板 ← Python：NDJSON

Python 的 **stdout 是纯协议通道**，每行一个独立 JSON：

```json
{"type":"progress","stage":"analyze","ratio":0.42,"message":"模板匹配 42%"}
{"type":"result","session":{...}}
{"type":"error","message":"无法打开视频","detail":"<traceback>"}
```

**所有诊断信息一律走 stderr**，二者绝不混流。面板只在出错时回显 stderr 末尾若干行，
避免 OpenCV 的逐帧告警刷屏（`bridge.js` 里对累积量做了 4000 字符上限，防止内存无限增长）。

Node 侧用 `StringDecoder('utf8')` 做行解析 —— 不能直接 `toString()`，
因为一个 UTF-8 字符可能被 TCP 分片切断。另外**最后一行可能不带换行符**，
进程 `close` 时需要再冲一次缓冲区。

### 4.2 面板 ← ExtendScript：JSON 字符串

ExtendScript 的 `evalScript` 只能传字符串、只能返回字符串。约定是：

- 面板 → JSX：`Arknight.<fn>(<JSON.stringify 后的字面量>)`
- JSX → 面板：一律 `return JSON.stringify({...})`，即便出错也是
  `{ok:false, stage:"...", error:"..."}`，绝不 `throw` 到外层
- 面板侧 `evalJSON()` 负责 `JSON.parse`，并在 `ok === false` 时抛错

### 4.3 大负载一律走临时文件

这是被两个限制逼出来的设计：

| 限制 | 影响 |
|---|---|
| Windows 命令行长度上限约 32KB | 真实录像的 `overrides` 含每段 `local_del_mask`，序列化后可达数百 KB，内联传参会被**静默截断** |
| `evalScript` 的长度与转义限制 | 同样传不了大 JSON |

所以：

- `pr_cli.py` 的 `--params` / `--overrides` / `--session-params` **同时接受文件路径与内联 JSON**
- `hostscript.jsx` 的入口函数（如 `applyEdit`）**接收的是一个文件路径**，
  内部用 `File` 读回再 `JSON.parse`

`Arknight._readJson()` 会剥掉 UTF-8 BOM —— Node 写出的是无 BOM UTF-8，
但第三方工具写出的文件可能带 BOM，`JSON.parse` 遇到 BOM 会直接失败。

---

## 5. 单位约定（最容易出错的地方）

Premiere 的 API 在时间单位上**不统一**，混用会得到 1~2 帧的精度漂移，
而且在小片段上表现为「剪出来的长度就是不对」。

```
TICKS_PER_SECOND = 254016000000
```

| API | 单位 | 传法 |
|---|---|---|
| `ProjectItem.createSubClip(name, startTime, endTime, ...)` | ticks | **字符串** |
| `Track.overwriteClip(clip, ticks)` | ticks | **字符串** |
| `Track.insertClip` | ticks | **字符串** |
| `TrackItem.getInPoint(mediaType)` / `getOutPoint(mediaType)` | ticks | 读 `.ticks` |
| `SequenceMarkerCollection.createMarker(pos)` | **秒** | 浮点数 |
| `Marker.end` 赋值 | **秒** | `t.seconds = x; mk.end = t` |

> 表格里的 API 都是同一类上下文，但本项目**实际只用到**
> `createSubClip` / `overwriteClip` / `getInPoint` / `getOutPoint` / `createMarker`。
> `insertClip` 列在这里是因为它和 `overwriteClip` 单位相同，容易被顺手误用。

**ticks 一律以字符串传递**，有两个原因：

1. 部分 API（如 `setInPoint`）会**按参数类型决定解析方式** —— 传字符串按 ticks 解析，
   传数字按**秒**解析。传错类型不会报错，只会静默得到完全不同的结果。
2. 精度。`ticksPerFrame = TICKS_PER_SECOND / fps`，在 29.97 这类非整数帧率下本身
   就是无限小数；帧号 × ticksPerFrame 的浮点乘法在长素材上会累积误差。虽然
   2.54e11 × 数小时仍在双精度整数的精确范围（2^53 ≈ 9.0e15）内，但中间任何一次
   浮点往返都可能把结果推到相邻帧，表现为 1~2 帧的偏移。

JSX 侧统一用 `Arknight._ticks(n)` 转换：`String(Math.round(Number(n)))`。

`mediaType` 参数也不直观 —— `1 = 视频`、`2 = 音频`、`4 = 全部`（**不是 3**）。
本项目只处理视频轨，所以一律传 `1`。

帧号 ↔ ticks 换算：

```js
ticksPerFrame = TICKS_PER_SECOND / fps
ticks = frame * ticksPerFrame + sourceOffsetTicks
```

`sourceOffsetTicks` 默认为 `0`，用于源素材起始时间码不为 0 的情况。
落地后面板会把序列的实际 `end` 与 Python 算出的保留帧数换算值比对，
偏差超过 1% 就在日志里告警。

---

## 6. 路径约定

所有可变数据都放在**用户主目录**而不是扩展目录 —— 扩展可能被装进
`Program Files` 这类只读位置，而主目录一定可写。

```
~/.arknight-pr/
├── config.json      # 用户配置
├── sessions/        # 会话文件：<视频名>_<路径哈希>.json / .npz
└── payload/         # 临时载荷：params.json / overrides.json / apply.json
```

Windows 上即 `C:\Users\<你>\.arknight-pr\`。

### config.json 字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `pythonPath` | string \| null | 手动指定的 Python 解释器绝对路径。为空时依次尝试 `py -3`、`python`、`python3` |
| `cliDir` | string \| null | 分析器目录（`pr_cli.py` 与 `analyzer.py` 所在处）。安装脚本会自动写入 |
| `timeoutMs` | number | 单次分析的超时上限（毫秒）。`0` 或不填表示不限时 |

### 分析器目录的定位顺序

分析器是**外部项目**（见 README「准备分析器」），位置完全不固定，
因此 `bridge.js` 的 `resolveCliDir()` 按优先级依次探测，取第一个同时含
`pr_cli.py` 与 `analyzer.py` 的目录：

1. 配置里的 `cliDir`（面板「环境设置」写入的就是它）
2. `<扩展目录>/../arknight-auto-editing-main` —— 两者平级存放时的常见布局
3. `<扩展目录>/../analyzer`
4. 扩展目录自身
5. `<扩展目录>/analyzer`
6. 环境变量 `ARKNIGHT_ANALYZER_DIR`

安装脚本 `install.ps1` 用一套等价的候选列表。

> 这套多级回退是为了「分析器位置不可预知」这件事付的代价。
> 如果你固定把分析器放在某个位置，直接用面板里的「环境设置」写死即可，
> 前面几条探测就都不会走到。

---

## 7. 会话文件

一次 `analyze` 产出两个文件：

| 文件 | 内容 | 用途 |
|---|---|---|
| `<name>.json` | 段落结构、参数、统计 | 体积小，面板读取回显 |
| `<name>.npz` | `states` / `diffs` 数组 | 体积大，仅 Python 侧使用 |

分开存的意义：**面板调参重算时不需要重新解码视频**。
`ranges` 子命令只读 `.npz` 里的数组就能重算掩码与保留区间，
这是把原 Tkinter 版「内存里常驻 diffs」的设计搬到了磁盘上。

会话文件名由视频路径派生（`basename` 净化 + 32 位路径哈希），
因此**同一素材重复分析会覆盖同一份会话**，不会无限堆积。

### session 主要字段

| 字段 | 说明 |
|---|---|
| `video_path` | 源素材绝对路径 |
| `fps` / `total_frames` | 源帧率与总帧数 |
| `proc_res` | 分析时使用的降采样分辨率（默认 `[400, 225]`） |
| `context_complete` | 边界差分是否走了二次扫片回退路径（false 时面板会提示） |
| `params` | 本次生效的完整参数（回填表单用） |
| `pause_segments` | 暂停段数组 |
| `speed_segments` | 变速段数组 |
| `clip_segments` | 需要用户裁剪的片段 |
| `keep_ranges` | **最终保留区间**，`[[start, end), ...]` **右开区间** |
| `markers` | 要写到序列上的标记 |
| `stats` | `kept_frames` / `removed_frames` / `kept_seconds` / `removed_seconds` / `ratio` / `segment_count` |

### 段落字段

- **pause**：`id`、`start`、`end`、`mode`、`boundary_diff`、`local_del_mask`
  - `mode` 取值 `auto`（按设置裁剪）/ `keep`（整段保留）/ `all`（整段删除）
  - `local_del_mask`：逐帧的 0/1/2/3 状态，时间轴色带就是它画出来的
    - `0` 自动保留（亮绿）、`1` 自动删除（暗棕）、`2` 手动删除（红棕）、`3` 手动保留（亮绿）
- **clip**：`start`、`end`、`keep_in`、`keep_out`（用户可拖拽的两个手柄）
- **speed**：`start`、`end`、`type`（帧类型常量）

### 帧类型常量

见 `frame_types.py`，面板侧 `main.js` 与 `timeline.js` 各有一份必须保持一致的副本：

```
0 = NORMAL   1 = PAUSE   2 = X1（游戏 1 倍速）   3 = X2（2 倍速）   4 = X0.2（0.2 倍速）
```

### markers 字段

`record_start` / `record_end`（**record 时间**，即时间轴时间，因为标记挂在序列上）、
`source_start` / `source_end`（源帧号）、`frame_type`、`label`、`percent`、
`name`、`comment`。

若某变速区间的起始帧恰好被删掉了，标记会落到该区间内**第一个被保留的帧**上。

---

## 8. 落地策略与兜底链

主策略是「**每个保留区间生成一个子剪辑 → 一次性按顺序拼装成新序列**」：

```
对每个 [start, end)：
    srcItem.createSubClip(唯一名字, startTicks, endTicks, 0, 1, 1)
        ↑ hasHardBoundaries=0  takeVideo=1  takeAudio=1
    → sc.moveBin(targetBin)

proj.createNewSequenceFromClips(序列名, subclips, targetBin)
```

相比「先铺满再删除」，这样做的好处：

- 不需要手算每段的 record 位置
- 序列的帧率、尺寸自动匹配源素材
- 不需要删除任何东西，失败时项目里不留垃圾

**子剪辑名必须全局唯一** —— `createSubClip` 遇到重名可能失败或产生歧义项。
命名规则是 `素材名_时间戳_随机4位_序号`，随机后缀是必需的：
时间戳只精确到秒，同一秒内跑两次就会撞名。

### 兜底链

```
1. createSubClip + createNewSequenceFromClips     ← 主路径
2. createNewSequence(name, preset) + overwriteClip 逐段写入   ← _assembleByOverwrite
3. 导出 EDL → Premiere 导入                        ← 面板上的独立按钮
```

第 2 级有个坑：`createNewSequence(name, presetPath)` 的第二个参数
**必须是真实存在的 `.sqpreset` 路径**。早期版本这里传的是拼出来的时间戳字符串，
导致这条兜底路径从未真正生效过。现在先试空串（多数版本会退回默认预设），
失败再去安装目录的 `Presets/Sequence Presets` 里找一个可用的预设。

三级全失败时，错误信息会明确指向 EDL 路径。

### 落地后的自校验

`createSubClip` 成功 ≠ 拼装成功。所以 `applyEdit` 返回的是**读回的真实数据**：

- `subclipsCreated`：成功创建的子剪辑数
- `clipsInSequence`：`seq.videoTracks[0].clips.numItems` 读出的真实数量（`-1` 表示读不到）
- `clipsFailed` / `failedDetail`：创建失败的区间
- `sequenceEndTicks`：序列实际时长，用于与预期值比对

面板会把 `clipsInSequence` 与 `subclipsCreated` 比对，不一致就告警 ——
只报「尝试数」会掩盖拼装半途失败的情况。

---

## 9. 错误码

`bridge.js` 里抛出的 Error 都带 `code` 字段，面板据此给出**不同的修复建议**
（环境问题与数据问题的处理方式完全不同）：

| code | 含义 | 面板提示方向 |
|---|---|---|
| `NO_PYTHON` | 没有可用的 Python 解释器 | 去设置里指定解释器路径 |
| `NO_CLI` | 找不到 `pr_cli.py` | 去设置里指定分析器目录 |
| `SPAWN_FAILED` | 子进程起不来 | 核对解释器路径是否有效 |
| `CANCELLED` | 用户主动取消 | 不算错误，静默处理 |
| `TIMEOUT` | 超过 `timeoutMs` 被终止 | 调大 `timeoutMs` 或换更短的素材 |
| `CLI_ERROR` | Python 返回 `{"type":"error"}` | 看 `detail` 里的 traceback |
| `NO_RESULT` | 进程退出但没给结果 | 把 stderr 末尾内容反馈给开发者 |

进程被杀的原因记录在模块级 `killReason` 上。**这是必需的**：
被 kill 时进程既没有 `result` 也没有 `error`，`close` 回调若只看退出码，
会把用户主动取消误报成「Python 异常退出」。

---

## 10. 运行时语言约束

### ExtendScript 层（`hostscript.jsx`）

**严格 ES3**，以下语法一律不可用：

- `let` / `const` → 用 `var`
- 箭头函数 → 用 `function`
- 模板字符串 → 用字符串拼接
- `Array.prototype.forEach` / `map` / `filter` → 用 `for` 循环
- `Object.keys` / `Object.assign` / `Array.isArray`
- `JSON` 对象是可用的（CC 版本内置）

另外 `catch (e)` 里的 `e` 必须实际用到或省略命名，不同引擎的容忍度不同，
所以本项目大量使用 `catch (e2) { }` 这种带序号的写法。

### 面板 JS 层

必须能被 **Chromium 74** 解析（见 §1）。`class`、`async/await`、模板字符串、
`String.padStart`、`Array.prototype.find` 都可以用；`?.` 和 `??` 不行。

### Node 层（`bridge.js`）

只用 Node 12 与 17 都稳定支持的 API。已刻意避开的：

- `fs.promises.rm`（14.14+）、`fs.rmSync`（14.14+）—— 本扩展不需要删除文件，故也不存在替代实现
- `AbortController`（15+）→ 取消进程用 `child.kill()`
- `fs.mkdirSync` 的 `recursive: true` 选项是 10.12+，可用

---

## 11. 为什么关闭了抽帧

上游独立版有个 `_speedup_mask` 能力：把倍速区间「抽帧」成单帧序列，
让视频在播放时自动变快。

这个能力在**时间轴场景下是灾难**：抽帧会把一个连续区间打散成成百上千个单帧区间，
落到 Premiere 时间轴上就是同样数量的碎片 clip —— 渲染卡顿，而且完全没法手动编辑。

因此 `pr_cli.py` 的默认参数里：

```python
'speedup_1x': False,
'speedup_02': False,
```

变速改由 **Marker 提示 + 用户手动设置片段速度** 的方式实现（原因见 README：
PR 的插件 API 没有修改片段速度的接口）。

---

## 12. 已知限制

| 限制 | 原因 | 可能的出路 |
|---|---|---|
| 无法自动设置片段速度 | ExtendScript 与 UXP 都没有该 API，QE DOM 也没有 | 只能等 Adobe 补 API；目前靠橙色标记提示手动设置 |
| 已识别的最高版本为 25.3.0 | 开发环境 | 欢迎反馈其他版本的 `checkCapabilities` 输出 |
| `clipsInSequence` 可能读到 `-1` | `TrackItemCollection` 在不同版本上暴露 `numItems` 或 `length`，都没有时读不到 | 已做兼容，读不到时面板改用 `subclipsCreated` 显示 |
| 面板 UI 未用真实录像联调 | 测试用的是合成视频 | 需要在真实素材上验证模板匹配阈值与性能 |
