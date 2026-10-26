# 前端最终质量基线

2026-10-26 完成页面职责与状态归属迁移的收口复测。生产源码为 `47c032f`；本次交付增加测试工具、性能证据与维护文档，没有改动生产组件、样式、API 或依赖。源码、构建方式与机器身份由[最终性能证据](evidence/frontend-final/performance.md)及其原始 JSON 追溯。

维护当前代码时，以[前端架构与所有权](frontend-architecture.md)和[迁移与兼容审计](frontend-migration.md)为集中入口。原始[职责清单](frontend-baseline.md)包含迁移期间追加的进展，不应据其中历史执行描述重新引入页内状态机。2026-10-25 的普通生产[性能前测](evidence/frontend-baseline/performance.md)与 JSON 保持原样。

## 质量门禁

| 命令 | 最终结果与范围 |
| --- | --- |
| `pnpm verify` | 客户端护栏、lint、TypeScript、149 个 Vitest 文件 / 1520 条测试、生产构建全部通过；服务端语法与 50 个测试文件全部通过 |
| `pnpm --filter la-pluma-next-client stylelint:ratchet` | 通过；11 个文件、825 条存量违规，未增加预算 |
| `VISUAL_SKIP_BUILD=1 pnpm visual` | 72/72 通过，未更新任何截图；复用 verify 的普通生产构建 |
| `INTEGRATION_SKIP_BUILD=1 pnpm --filter la-pluma-next-client test:integration` | 4/4 通过；复用相同普通生产构建，验证停止/切页/断线/刷新、预检身份、配置半失败重试及跨页资源失效 |
| 最终性能工具的 TypeScript 与 ESLint | 通过；覆盖 profiling 构建、采样、overlay 与静态服务器 |
| `git diff --check`、文档本地链接 | 通过；原始性能说明及 JSON 与原版本 SHA-256 一致 |

服务端与 Docker 浏览器检查使用必要的宿主权限，以支持回环监听和本机 Docker socket；没有安装依赖、升级版本或拉取镜像。机器可读结果及日志摘要见 [verification.json](evidence/frontend-final/verification.json)。现有入口 chunk 超过 500 kB 的构建提示仍在；构建完成且 5 个 JS 产物全部进入 SW precache。这一体积提示不代表交互性能结论。

72 张视觉仍覆盖八页 × 三视口 × 深浅主题、三类弹层与启动壳。默认态截图不等同于运行中、断线、停止、保存半失败的行为验证；这些范围由单元、服务端和独立的四个浏览器集成场景补充，详见[跨页集成用例](../client/tests/integration/)。静态依赖护栏也不能单独证明运行时所有权。

## 最终职责与行为

| 边界 | 当前约定 |
| --- | --- |
| `app → pages → features → shared` | App 组装全局观察、Provider 与路由；八页只组合工作区；领域拥有规则、会话、命令和资源；shared 不感知业务域 |
| 设备任务 | 服务端 Run 为身份真相，前端控制器提交、观察与按 `runId` 停止；页面隐藏、刷新和网络中断不会重放任务 |
| 配置 | 按 key 的协调器串行提交；本地草稿、revision 与 pending 共同裁决；配置保存和 schedule 更新均成功才确认同步 |
| 服务端资源 | 领域 Query 负责请求、缓存和取消；跨域通过精确作用域失效；Dashboard 仅原子发布完整快照 |
| 日志 | 实时与历史会话各自拥有请求和缓冲；Activity、文档可见性与手动暂停分别处理 |
| 展示订阅 | 工作区和面板按领域职责订阅；设备采样、搜索与局部交互不要求整个页面再拥有一份业务状态 |
| 拖拽 | document pointer 生命周期保持排序，lostpointercapture 不再取消；成功排序验证服务端提交、本地顺序与 pending 清除 |
| 兼容 | 消费者或明确支持期限不满足删除条件时保留；本轮没有删除旧 API、旧模式别名、旧断点适配或外部占用识别 |

## 性能与解释边界

最终证据包括四类代表交互（指针拖拽、作业搜索、180→200 日志快照、两项队列排序），以及成功键盘排序补充对照。普通生产后测与两侧相同 App Profiler 构建各有每类 5 个有效样本。各轮均独占串行、固定浏览器/机器/fixture/25ms 交互响应延时，全部 setup 和测量的 pageerror、console.error 为零，窗口内请求完成且成功。

原始及重采的旧指针排序均取消，后测则成功保存，不能把两者的耗时差称作成功排序加速。成功键盘排序提供相同操作语义的补充比较。React 指标来自同一 Profiler 边界的实际提交回调，不能与 DOM mutation、CDP 或普通生产耗时混算。日志总耗时包含自然 1250ms 轮询的剩余等待。具体数值、请求变化与收益或回退均见[最终性能结论](evidence/frontend-final/performance.md)。

5 次固定 fixture 采样只能描述该机器、该构建与小规模场景，不能证明统计显著、设备容量或真实服务端延迟。大规模流程、养成队列、慢设备及公网延迟需要另建场景，不能根据文件行数、产物体积或默认态截图推出其性能。

## 保留限制

旧断点接受上限为 24 小时，Run 最多保留 24 小时且 500 条终态，数量淘汰可能使窗口内断点也无法恢复。迁移只能关联已有身份，不重新提交；无法匹配或冲突时清理并提示明确重新开始。`tasks/status` 健康探针、Dashboard 的 `schedules/execution`、公开 `stopTask`、同步执行默认值、`app/cli` 别名和 Telegram 外部占用仍有消费者或兼容承诺，均没有已结束的日历支持窗口，详见[兼容审计](frontend-migration.md)。

配置两步提交不是跨端点事务，半失败必须保持 pending；跨客户端同时写入仍为最后写入生效。Telegram 等内部入口尚未统一包装成 HTTP Run，必须继续承认未纳管设备占用。这些边界不由本次性能采样关闭。
