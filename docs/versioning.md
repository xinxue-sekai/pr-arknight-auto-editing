# 版本管理与发布流程

本文定义这个仓库的版本号规则、迭代节奏与发布步骤。

## 版本号规则

遵循[语义化版本 2.0.0](https://semver.org/lang/zh-CN/)（`MAJOR.MINOR.PATCH`），
结合本项目特点明确「什么算 breaking」：

| 版本位 | 语义 | 本项目的判据 |
|---|---|---|
| **MAJOR** | 不兼容 | 需要用户重配环境；manifest 的 `Host` 范围收缩；`config.json` 格式不兼容；与外部分析器的 NDJSON 接口破坏性变更 |
| **MINOR** | 兼容新增 | 新增面板功能；新增落地方式；支持新的 Premiere 版本；新增 CLI 子命令 |
| **PATCH** | 兼容修复 | 修 bug；改文案；调默认参数；打包/CI/文档改进 |

0.x 阶段的语义按 SemVer 惯例放宽：`0.MINOR.PATCH` 中 MINOR 位允许包含
不兼容变更（当前正处于这个阶段）。

## 唯一的版本源

**`cep-extension/CSXS/manifest.xml` 的 `ExtensionBundle@Version`。**

其他任何地方（文档、Release 说明、zip 文件名）引用版本号都必须指向它，
不允许手抄第二份。`.github/workflows/release.yml` 会强制校验
**tag 名（去掉 `v` 前缀）与 manifest 版本一致**，不一致直接失败——
这是为了杜绝「下载的包自称 0.1.0、Release 却写着 v0.2.0」这种情况。

## Git tag 约定

- 格式：`v<版本号>`，例如 `v0.1.0`（带 `v` 前缀）
- 类型：annotated tag（`git tag -a`），带说明信息
- 时机：只有发布时才打 tag；日常开发提交不打

## 当前版本策略

当前处于 **0.x 阶段**：功能在长、接口可能变。

**发 `1.0.0` 的门槛（缺一不可）：**

1. ExtendScript 落地链路（`createSubClip` → `createNewSequenceFromClips`
   → 写标记）在真实 Premiere Pro 上验证通过
2. `checkCapabilities` 在目标版本范围（至少 25.x 与一个更低版本）上表现正常
3. 至少一份真实录像完成过「分析 → 时间轴微调 → 落地」全流程

**当前进展（2026-11-08）**：使用者已确认完成真机验证，原先的核心链路与真实
素材验证待办已关闭；本次未附逐项测试记录，不据此扩大版本或素材覆盖范围。
当前已记录的宿主版本为 25.3.0，更低版本的兼容性验证尚未记录。

本次状态同步不自动升级到 1.0.0，也不改动既有发布 tag。上述发布门槛继续用于
评估稳定版；补齐跨版本验证与测试记录后，再决定是否发布 1.0.0。

## 发布流程

```
1. 确认 main 分支 CI 为绿
2. 更新 manifest 的 ExtensionBundle@Version
3. 把 CHANGELOG.md 的 [Unreleased] 段封版为 [x.y.z] - 日期，另起新的 [Unreleased]
4. 本地跑全套检查（见 CONTRIBUTING.md）
5. git commit -m "release: vX.Y.Z"（或描述性中文信息）
6. git tag -a vX.Y.Z -m "..." && git push origin main --follow-tags
7. release workflow 自动：跑检查 → 校验 tag/manifest 一致 → 打包 → 建 Release 上传 zip
8. 到 GitHub Releases 页确认 zip asset 已上传、说明内容正确
```

**注意**：`--follow-tags` 只推送 annotated tag；忘了推 tag Release 就不会触发，
事后单独 `git push origin vX.Y.Z` 即可补发。

## 迭代节奏

**按需发布，不定固定周期。** 这个项目的真实节奏取决于：

- 上游分析器（外部项目）是否有接口变更
- 不同 Premiere 版本的兼容性反馈

一条纪律：**任何改了 manifest 的 `Host` 范围或 `config.json` 格式的提交，
必须走一次完整发布流程**——这两处直接影响用户环境，不能只躺在 main 里。
