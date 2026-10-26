# 前端迁移最终性能证据

2026-10-26 21:22–21:24（Asia/Shanghai）完成普通生产后测及两侧相同 React profiling 构建的采样。三轮各 25/25 通过，共 75 个有效新 context；每轮均为四类代表交互 × 5 次，加成功键盘排序补充对照 × 5 次。所有 setup 与测量的 pageerror、console.error 为零，测量窗口内 API 全部结束、HTTP 200、无失败。未报告 longtask。

**没有证据支持“全面加速”。** 同一 profiling 协议下，搜索子树渲染时间略降；日志和队列的渲染时间增加，成功键盘排序增加一次提交。自动化页减少了旧执行状态读取，正确的指针排序也能完成保存。小规模采样的结果与限制如下，不能用结构缩减代替实测。

## 数据集与可比性

| 数据 | 用途 | 原始记录 |
| --- | --- | --- |
| 2026-10-25 原始普通生产前测 | 保留历史事实；20 个样本、旧 harness、旧时钟与完成断言 | [原说明](../frontend-baseline/performance.md)、[原 JSON](../frontend-baseline/performance.json) |
| 本轮普通生产后测 | 最终正常部署构建的浏览器与请求基线；没有 React profiling | [production.json](production.json) |
| 本轮 profiling before | 从 `af3634d302c2132ea7a701821829ee7511aca613` 导出源码，施加相同测试覆盖层 | [profile-before.json](profile-before.json) |
| 本轮 profiling after | 从 `47c032f629858956f20e93a1342748dbf580eea0` 导出源码，施加相同测试覆盖层 | [profile-after.json](profile-after.json) |
| 汇总与门禁 | 每类中位数/范围、请求序列、证据摘要与命令退出码 | [summary.json](summary.json)、[verification.json](verification.json) |

原始前测的 Markdown 和 JSON 字节未变，SHA-256 分别为 `86b00e593f9789911aeeb5a9bca65bc49ddf2bee81dd1e428cddf2d15a5ee2f2`、`f66988bf31450b1f29b24ac5c35de9e07a42f825ba4de3e125fdac0ccfeac9d3`。旧生产源码本身没有后加的 harness，不能只 checkout 该源码就复现原采样。

本轮使用同一套新 harness/fixture 重新跑两个源码状态，不把原普通生产数据和补充 profiling 混算。原前测允许指针取消、一个明确 setup 异常，也没有完整保存断言；本轮 after 必须成功保存，setup 不允许任何异常。指针两侧结果不同，专列为语义差异。

另一个协议变化是时钟：原前测调用 Playwright `setFixedTime`。核对本机 Playwright 1.64.1 实现发现，它会安装按真实时间推进的 clock facade，`performance.now()` 经整毫秒取整，并替换计时 API；原说明将其描述为原生计时并不准确。本轮三个数据集都只固定 Date，保留原生 performance.now、计时器和 requestAnimationFrame，逐样本断言原生函数身份与固定/显式 Date 的行为。默认视觉环境继续使用原时钟方式。**历史与本轮普通生产耗时不是严格成对对照。**

## 环境、构建与来源

| 项目 | 三轮共同环境 |
| --- | --- |
| 运行时 | Node 24.22.1、pnpm 12.6.0、React / ReactDOM 19.3.1、Vite 8.3.5 |
| 浏览器 | Playwright 1.64.1、Chromium 156.0.8078.4 headless；既有官方 noble 镜像，`--pull=never` |
| 宿主 | Linux x64、AMD Ryzen 7 5800H、16 个逻辑 CPU；不设 CPU / 网络限速 |
| 视口 | 1440×900、DPR 1、dark、zh-CN、Asia/Shanghai、reducedMotion=reduce |
| 数据与时钟 | 相同 API/图片 fixture；Date 固定 2026-10-24 04:00 +08:00；原生真实计时 |
| 请求 | 交互 fixture 延时 25ms；既有视觉 fixture 即时应答，无真实服务端/公网延迟 |
| 隔离 | 一个 worker、零重试、每次新 context；门禁结束后按普通后测 → profiling before → profiling after 串行，期间无构建或其他高负载验证 |

普通后测直接复用通过 verify、视觉与集成检查的 `client/dist`。profiling 两侧从明确 git commit 导出到新的临时目录，复用相同已安装 node_modules，不安装、升级或拉取。两侧 Vite 配置相同；源码的依赖声明不同：迁移后新增了 TanStack Query。旧源码 lock SHA 为 `ba4848c27fe5968e6c6fb20950472b093a03c6b9eef3a8247f53f86a664370df`，当前源码及实际复用工作区 lock SHA 为 `88d3d05ea3e79dfcdb0c32019e3746bb050352a7ae6b2f354075b305a75a8eb8`。这是**共享当前依赖环境的源码对照**，不是逐一安装两个历史 lock 的独立重建；核心 React/ReactDOM/Vite 版本一致，新增 Query 只被迁移后源码使用。JSON 同时保留两种 lock 摘要。

profiling 构建精确 alias `react-dom/client` 到 `react-dom/profiling`，同一覆盖层在 `StrictMode > Profiler(id=App) > App` 处收集更新，生产源码和普通构建不加入 instrumentation。React 官方说明 profiling 增加开销且默认生产构建不启用，回调的 actualDuration 表示已提交子树更新的渲染时间；见 [Profiler](https://react.dev/reference/react/Profiler)和[profiling build](https://react.dev/reference/dev-tools/react-performance-tracks)。

| 身份 | SHA-256（完整值也在各 JSON） |
| --- | --- |
| 两侧覆盖层 | `cc7d958e04f400ca83eebda8a1667e160ec07cab9d01167df9be3a35b27f5cca` |
| 三轮 harness | `4424bcc0a25375282a467c947c9d7ba3ecbedea7c3534714e27dde98944a54c3` |
| 三轮 fixture | `0ce08920b48bcf9c47b5c9ca66225248c3cfda3fe2ef5170d5adf1e76fcdd2a7` |
| 普通 after dist | `4800ed0f9733f47cab5c5031fb97871b8b664069bb1fd0b5bf7544db56f04bf0` |
| profiling before dist | `e7aa9a5fc4ccb33d2efd1cd3079c1e59b732e15a0ab73913516c3b723fd153c2` |
| profiling after dist | `fb0a2f995de4426dc93324460cf1a5b4f9a21f721f07902cf9bff17fe7a49db4` |

构建 sidecar 保存源码 archive、lock、overlay 和 dist 摘要；runner 重算 dist 并拒绝不匹配的 provenance。两侧 `sourceFilesDirty=false`，普通后测的生产源码/Vite/lock 也干净；`evidenceHarnessDirty=true` 如实记录采样工具与文档在本次提交前采集证据。最终提交中的工具内容可用 harness SHA 核对。dist 摘要按 dist 根相对路径计算；历史摘要使用仓库相对路径，两种摘要不能直接比较。

## 两侧 React 与操作完成时间

每格为 5 次中位数，括号为最小–最大值；时间单位 ms。React 列是窗口内所有 App Profiler 回调的 actualDuration 之和，各次原值（含 phase、baseDuration、startTime、commitTime）在 JSON 中。提交数不是每个组件函数的调用数，也不包含被丢弃的渲染；actualDuration 不代表 commit 阶段或 paint 耗时。

| 场景 | React 渲染 before → after | App 提交数 before → after | 操作完成 before → after |
| --- | --- | --- | --- |
| 指针尝试取消 → 成功保存（不同结果） | 9.3（9–9.8）→ 14.0（11.2–14.8） | 5 → 8 | 249.2（240.4–269）→ 366.5（358.3–374.9） |
| 作业搜索 5 条 | 3.6（3.4–3.9）→ 2.9（2.6–3.1） | 4 → 4 | 118.3（114.8–137.2）→ 114.4（114.3–114.9） |
| 日志 180→200 行快照 | 2.0（1.8–2.2）→ 3.9（3.8–4.2） | 1 → 1 | 820.3（814.9–823.4）→ 824.2（813–830.8） |
| 2 项队列排序 | 2.6（2.2–3.4）→ 4.6（4.2–5.5） | 2 → 3 | 148.1（147.3–148.3）→ 147.5（146.8–164.5） |
| 成功键盘排序（补充） | 7.6（5.6–9.9）→ 8.1（7.8–10.5） | 2 → 3 | 164.5（146.8–164.6）→ 164.7（164.2–165） |

搜索的子树渲染时间中位数下降 0.7ms，提交数相同；这不足以宣称所有搜索或设备都更快。日志增加约 1.9ms，队列增加约 2.0ms，键盘排序增加约 0.5ms，后两者各多一次提交；这些成本明确保留为迁移后的观察结果。App 边界不能定位增加的时间属于哪个具体组件，本轮不凭提交数猜测原因。CDP Script 中位数也未全面下降：搜索 13.307→14.114ms、日志 5.406→8.061ms、队列 9.768→14.671ms、键盘 17.372→18.946ms；React 子树时间不能替代完整浏览器工作。

指针 before 的 5/5 样本均 lostpointercapture 后恢复原序、无写入、无 pending；after 的 5/5 均按请求顺序保存，配置 payload、本地顺序、schedule 响应和 pending 清除全部确认。后者执行了真实保存，不能把 249.2→366.5ms 解释成相同成功操作的性能回退或提升。补充键盘场景在两侧都成功保存同一移动操作，提供可比的排序完成语义。

日志完成时间包含自然 1250ms 轮询的剩余等待，并非纯渲染。所有场景先稳定 400ms；不手动触发日志刷新、不预热搜索、不加入 recommended 自动预览。API 请求窗口从 measure 前开始，含 CDP 会话建立；browser/React 窗口在浏览器 observer 安装时开始。CDP 累计指标还包含 observer 安装和停止/读取，窗口更宽；三种相对时刻不可直接合并。

## 请求与初始化证据

下表每组 5 次序列一致。路径相对 `/api/agent`，所有响应均为 fixture，实际相对时刻、完成时长、body SHA 与业务摘要在 JSON。

| 场景 | profiling before | profiling after / 普通 after |
| --- | --- | --- |
| 指针排序 | 2 × GET `/schedules/execution`；无写入 | POST `/config/user/automation-tasks` → POST `/schedules`，各 1 次 |
| 搜索 | GET `/copilot/search?stage=1-7`，1 次 | 相同；恰好 5 条结果，零详情/作业集预览请求 |
| 日志 | GET `/logs/recent?lines=200`，1 次 | 相同 |
| 队列 | PUT `/training/queue/order` → GET `/training/queue` | 相同；PUT 精确为 `[char_202_demkni,char_180_amgoat]`，显示权威新序且按钮恢复 |
| 成功键盘排序 | GET `/schedules/execution` → POST 配置 → POST `/schedules` | 只保留两个 POST；两侧配置 taskIds 与本地持久化顺序都正确 |

初始化单列，不计入交互请求。自动化 before 有 2 次 execution 与 2 次 tasks/status，after 变成 0 次 execution、1 次 tasks/status，并新增 1 次 runs/current；自动化初始化 API 总数从 10 到 8。作业页 tasks/status 从 2 到 1，但新增 runs/current，总数仍为 6。日志与队列新增应用级 runs/current 各 1 次，总数分别从 5→6、9→10。训练初始 trainable 查询仍有 2 次，**没有解决全部重复读取**。新身份观察属于正确性成本，不能只统计被删掉的请求来宣称总请求全面减少。

## 普通生产最终基线

普通 production 没有 Profiler，以下仅登记最终浏览器基线，不与 profiling 或历史前测拼成速度差。

| 场景 | 操作完成：中位数（范围） | CDP Script 中位数 |
| --- | --- | ---: |
| 成功指针排序 | 349.9（341.6–361.9） | 23.604 |
| 搜索 | 128.0（114.3–130.1） | 9.562 |
| 日志 | 827.3（820.4–1313.1） | 3.914 |
| 队列排序 | 147.5（145.3–148.1） | 9.035 |
| 成功键盘排序 | 164.0（147.9–164.8） | 14.015 |

日志 1313.1ms 样本保留，没有剔除或重跑以缩小范围；它仍符合一次自然轮询返回后的完成条件。无 longtask 只说明这些窗口没有报告超过 50ms 的长任务，不能推导所有设备均流畅。

## 复现与验收边界

完整操作、输出保护和构建命令见[采样工具说明](../../../client/tests/performance/README.md)。本轮 before/after 使用该工具中的两个 commit；普通后测先执行根 verify、样式预算、视觉 72 张和集成 4 个用例，然后使用 `PERFORMANCE_SKIP_BUILD=1`。profiling 命令分别设置 `PERFORMANCE_DIST`、构建 sidecar、独立输出文件；before 另设 `PERFORMANCE_EXPECT_DRAG=cancelled-after-lost-pointer-capture`，after 默认 `completed`。全部 25 个有效样本、每类恰好 5 个才原子写出 JSON，不会用 partial smoke 覆盖完整证据。

最终检查退出码、149 文件 / 1520 条客户端测试、50 文件 / 346 条服务端测试、样式预算与浏览器结果见 [verification.json](verification.json)。性能 harness 在最后时钟修正后通过 scoped TypeScript/ESLint，并重跑默认视觉与集成以确认共享默认行为。

这些结果覆盖固定小数据集的真实浏览器输入、React 提交和请求，不覆盖大规模队列/流程、慢设备、真实后端、互联网或长期运行。没有性能阈值或统计显著性结论；目前可确认的收益主要是局部搜索渲染与自动化冗余读取减少，成本和未覆盖范围均保留。当前架构、兼容入口与最终质量基线分别见[架构](../../frontend-architecture.md)、[迁移审计](../../frontend-migration.md)和[最终基线](../../frontend-final-baseline.md)。
