# 浏览器交互性能基线

从仓库根目录运行：

```sh
node client/scripts/performance-docker.ts
# dist 刚由同一源码构建时，可以复用构建产物：
PERFORMANCE_SKIP_BUILD=1 node client/scripts/performance-docker.ts
```

入口使用已安装的 `@playwright/test` 对应的官方 `-noble` 镜像，以 `--pull=never` 运行；缺依赖或镜像即失败，不安装、不升级。需要 Docker socket 访问权限。默认先执行现有 client build；复用 dist 时，调用方应确认产物来源，避免并行覆盖。端口为 4317，与视觉基线的 4300 分离；避免与其他浏览器测试、构建或高负载任务同时采样。Playwright 临时结果放在容器的 `/tmp/la-pluma-performance-results`，不复用视觉基线产物目录。

20 个用例串行执行：4 类场景各 5 次，每次使用新的 browser context。固定 Chromium、1440×900、DPR 1、深色主题、中文区域、上海时区、2026-10-24 04:00 的 Date、减弱动态效果、固定图片与 API 数据。场景复用视觉基线环境；新增交互响应的人工延时固定为 25ms。计时器和 `performance.now()` 使用真实时间。

| 场景 | 固定输入与操作 | 完成条件 |
|---|---|---|
| automation-drag | 3 项流程，将第一项「启动游戏」从手柄拖过第三项中心，12 个 pointer move 步骤后释放 | 确认真实 pointerdown/up、项目不丢失并记录结果枚举；本次实测为 lostpointercapture 后取消，成功排序待补测 |
| copilot-search | 普通作业页，输入 `1-7` 后按 Enter；响应为固定 5 条作业，无 recommended | 第 5 条结果可见，搜索按钮恢复可用 |
| log-append | 实时日志从 180 条变为 200 条，最后 20 条内容唯一 | 真实的下一次 1250ms HTTP 轮询返回后，200 行和最后一条追加日志可见 |
| training-reorder | 2 项队列，点击「下移艾雅法拉」 | PUT order 后 GET 返回更新队列；顺序为塞雷娅、艾雅法拉；按钮恢复可用 |

页面导航后显式补入 CSS 动画冻结，再等待页面、字体并稳定 400ms，在测量前完成滚动和拖拽起点定位。共享视觉环境的 init script 在文档根尚不存在时会抛出 `Cannot read properties of null (reading 'appendChild')`，仅允许该明确 setup 异常并逐样本记录；测量窗口要求无异常，详见 [前测说明](../../../docs/evidence/frontend-baseline/performance.md)。测量从安装 DOM/longtask observer 后开始，包含 Playwright 输入、异步操作和状态断言；完成后再等待两次 `requestAnimationFrame`。导航/初始化请求单独按端点计数，不计入交互请求列表。请求窗口比浏览器窗口略宽，包含 CDP observer 的安装与读取开销。原始逐样本证据输出到 `docs/evidence/frontend-baseline/performance.json`；失败或不足 20 个样本时不覆盖既有完整文件。

测量字段：

- `browser.durationMs`：浏览器真实时钟上的操作到可见完成耗时，含自动化调度与断言等待；日志项还含自然轮询等待，不是纯渲染耗时。
- `browser.*Mutations`、`mutationCallbacks`、`addedNodes`、`removedNodes`：`document.body` 整棵 DOM 子树的 MutationObserver 记录。增删节点只计每条 record 的直接节点数；节点移动也可表现为删除后添加。它们不是 React render/commit 次数。
- `browser.longTasks`：测量窗口内浏览器报告的 longtask duration，单位 ms；空数组只说明该窗口没有报告超过 50ms 的长任务。
- `cdp.*DurationMs`：Chromium `Performance.getMetrics` 在窗口前后的累计差值。`TaskDuration` 包含 `ScriptDuration` 等工作，不能相加；layout/style 次数是浏览器计数，不是 React 次数。observer 与 CDP 调用也有成本。
- `requests`：真实浏览器发出的 API method、含 query 的路径、状态、相对开始时刻和响应完成耗时。请求体保存 SHA-256 与业务摘要，不重复存储整个流程配置。这里的响应是 fixture，耗时包含拦截及固定 25ms 人工延时，不能代表后端/公网延迟。
- `setupRequests`：测量开始前的初始化请求计数，可用于发现后续重构引入的重复读取。

JSON 同时记录源码 commit、生产文件是否有未提交改动、dist、fixture、运行脚本与 harness 的 SHA-256、浏览器版本、镜像 ID、CPU/架构与采样时间。当前普通 production React 构建没有启用 profiling，未采集 React Profiler render count / actualDuration；后续性能收口如要补这些指标，应对重构前后的对应 commit 使用相同 profiling 构建选项并双侧重测，不与此处的 DOM 或 CDP 指标混称。

入口自检：

```sh
pnpm --filter la-pluma-next-client type-check
pnpm --filter la-pluma-next-client exec eslint tests/performance scripts/performance-docker.ts
node --check client/scripts/performance-docker.ts
```

本目录和性能运行脚本纳入现有 `tsconfig.node.json`，由常规 type-check / verify 覆盖；`.pw.ts` 不进入 Vitest 的普通单测收集。基线没有硬编码速度阈值，5 次样本用于重测对照，不能当作统计显著的容量结论。
