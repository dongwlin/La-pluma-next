# 跨页一致性验收

浏览器集成入口使用构建产物和真实 Chromium，按 API 契约提供可变场景数据，验证应用组合、Activity 保活与领域所有者在同一浏览器中的协作。它不连接设备，也不运行 MAA；设备停止、Run 保留与 HTTP 契约由服务端回归单独验证。

## 复现

在仓库根目录执行：

```sh
pnpm --filter la-pluma-next-client test:integration
pnpm verify
pnpm --filter la-pluma-next-client stylelint:ratchet
pnpm visual
```

集成和视觉测试复用已安装 `@playwright/test` 对应版本的 `mcr.microsoft.com/playwright:v<version>-noble` 镜像。集成入口要求本机已有镜像，不自动拉取。默认先构建客户端；已经构建时可用 `INTEGRATION_SKIP_BUILD=1` 跳过。Docker 需要本机 daemon 权限。集成端口默认 4318，视觉端口独立；集成顺序运行，避免共享场景竞态。

失败截图与 trace 保存在忽略入库的 `client/integration-artifacts/`。`tests/integration/harness.ts` 记录每次 API 的方法、路径、正文以及提交、停止、配置保存、定时注册和应用次数。未登记 API 与浏览器 `pageerror` 都使测试失败。视觉测试也从文档加载前记录脚本异常，防止仅截图通过掩盖初始化错误。

## 场景及可观测结果

| 场景 | 数据与操作 | 必须成立 |
| --- | --- | --- |
| 停止中切页、刷新恢复 | 日常页提交 `run-cross-page-current`，停止进入 `stopping`；切总览、返回、刷新，最后推进为 `stopped` | 始终只有一次提交和一次目标停止；两个页面共享运行阶段；刷新只恢复观察，终态才恢复启动入口 |
| 离线、读取失败与重连 | 停止中用浏览器 offline，再恢复网络并暂时中断 current 快照；随后恢复读取 | 保留最后 Run 身份；离线与读取失败展示未知并禁用启动；重连先按原 ID 对账，不能推断完成或重提 |
| 旧身份停止与新 Run | 持久化旧 ID `run-cross-page-stale-terminal`；当前快照已有新活动 Run，但旧 ID 查询被 gate 挂起 | 旧身份未确认时停止请求只携带旧 ID；`alreadyTerminal` 响应解除旧控制权；迟到旧查询不能覆盖新活动 Run；新 Run 保持运行且无新提交 |
| 同步活动预检 | 挂起活动执行响应，切日常再返回总览；另开没有发起方 loading/message 的浏览器页面观察快照；最后返回 `executed:false` 与导航阻断原因 | 响应前全局可观察预检 Run 并禁止重复入口；其他页面不冒充拥有它；阻断原因原样反馈，不伪造成执行成功 |
| 配置半失败显式重试 | 增加第三个定时时间，配置 POST 成功而 schedule 返回失败；切页后点“重新同步” | 保留三项草稿与页内错误，恢复页面不自动重发；显式重试完整提交同一草稿，成功才清 pending，无设备执行 |
| 识别到计划应用 | 先挂载总览/日常/养成再隐藏；数据页识别完成后权威队列从两项变一项，预览 `CE-6 ×3` 并应用 | 识别只提交一次；隐藏养成恢复后读新队列；应用只写一次，日常重读服务端配置显示智能关卡；总览完整刷新显示一个目标，日常不把旧配置反写覆盖计划 |

测试文件为 `client/tests/integration/execution.pw.ts` 与 `resources.pw.ts`。服务端目标停止保护的关键回归在 `server/routes/__tests__/agentRoutes.test.js`；Run 状态、持久化、快照与契约分别由 `agentRunService.test.js`、`agentRunPersistence.test.js`、`runSnapshotService.test.js`、`agentContract.test.js` 覆盖。

## 状态归属核对

| 信息 | 唯一所有者 | 跨页消费方式 |
| --- | --- | --- |
| 执行身份、提交与快照 | `task-execution` 应用级控制器 | 页面领域读取只读投影；全局 `runtime-status` 只派生展示；停止始终携带持有的 runId |
| 自动化配置草稿与 pending | `user-config` 按 key 复用的协调通道、`automation` 适配器 | 完整保存包含配置与 schedule；页面切换不创建第二条保存队列 |
| 识别命令与解析 | `statistics` 命令所有者 | 解析成功写共享 `game-data` Query 并发布明确资源失效 |
| 队列、计划与设置 | `training` Query 及领域命令所有者 | 计划版本前提及配置写入屏障阻止旧计划/旧保存覆盖新值 |
| 总览业务数据 | `dashboard` 完整快照协调器的只读投影 | 消费领域 Query；五路成功才原子提交，隐藏恢复消费失效，不成为资源写入入口 |

页面只经功能域根入口组合。`pnpm verify` 中的 guardrails 检查 app → pages → features → shared 的方向、功能域公开面与页面职责；本次场景不新增页面写入状态或页面间轮询。

## 基线与兼容

72 张存量视觉截图只做比较，不更新基线。视觉 harness 等待文档根可用后再插入冻结动效样式，修复文档初始化时 `documentElement` 尚不存在的脚本异常；不改变产品样式。自动化旧断点的回归固定 `Date.now` 到 Run fixture 同一日期，避免真实日期超过 24 小时保留期后让有效迁移场景变成过期场景。

生产变化仅为离线运行投影显示未知；保留原 Run 身份、幂等语义、API、存储键与配置格式。回滚投影修正不会影响服务端已接受的执行；回滚测试与文档不产生运行数据迁移。

## 2026-10-26 验收结果

环境为 Node 24.22.1、pnpm 12.6.0、Playwright 1.64.1 的 Noble 镜像。浏览器集成为 1440×900 Chromium，中文 locale、Asia/Shanghai 时区、禁用 Service Worker；视觉沿用既有桌面/平板/手机与深浅主题配置。

| 检查 | 实际结果 |
| --- | --- |
| 浏览器集成 | 4/4 通过；覆盖表中六类场景；同步活动预检的独立观察页面也通过 |
| 完整 `pnpm verify` | 客户端 149 文件、1520 测试通过；服务端 50 文件、346 测试通过，失败/跳过/取消均为 0；类型、lint、构建、预缓存校验通过 |
| 依赖与职责护栏 | 435 源文件、816 条源码 import、15 功能域，0 依赖环；页面组合边界通过 |
| Run / 契约重点回归 | `agentRoutes`、`agentContract`、`agentRunService`、`agentRunPersistence`、`runSnapshotService` 五文件通过，包含旧终态停止不发送设备停止及不影响新 Run |
| stylelint ratchet | 通过；既有 11 文件共 825 条违规未增加 |
| 视觉 | 72/72 通过：48 页面、6 启动壳、18 弹层；各存量截图均无变更，未运行基线更新命令 |

首次在受限执行环境运行完整 verify 时，临时 loopback 监听被 `EPERM` 拒绝，HTTP/WebRTC 及依赖本地进程的测试未通过；允许测试所需的本机能力后完整重跑通过。构建仍有既有的 500 kB chunk 提示；本次未扩大打包范围或调整阈值。
