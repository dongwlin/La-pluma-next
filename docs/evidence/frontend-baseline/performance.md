# 浏览器交互性能前测

2026-10-25 17:03（Asia/Shanghai）完成 4 类交互 × 5 次独立 context，共 20 个样本，Playwright **20/20 通过，21.9s**。原始逐样本记录为 [performance.json](performance.json)，复测入口与指标定义见 [性能 harness 说明](../../../client/tests/performance/README.md)。没有修改生产逻辑或更新截图。

## 环境与追溯

| 项目 | 本次取值 |
|---|---|
| 生产源码 | `af3634d302c2132ea7a701821829ee7511aca613`；采样时 `client/src`、Vite 配置与锁文件无未提交改动 |
| 生产构建 | 复用本轮已通过根 `pnpm verify` 的 `client/dist`，采样期间未覆盖 |
| Playwright / Chromium | `1.64.1` / `156.0.8078.4`，headless |
| 容器 | 本机既有 `mcr.microsoft.com/playwright:v1.64.1-noble`，`--pull=never`；完整镜像 ID 在 JSON 中 |
| 宿主 | Linux x64，AMD Ryzen 7 5800H，16 个逻辑 CPU；未设 CPU / 网络限速 |
| 视口 | 1440×900、DPR 1、深色主题、`zh-CN`、上海时区、减弱动态效果 |
| 时间与数据 | Date 固定为 2026-10-24 04:00 +08:00；计时器和 `performance.now()` 使用真实时间；API 与外部图片完全固定 |
| 请求延时 | 新增交互 fixture 人工延时 25ms；既有视觉 fixture 即时返回；请求耗时不代表真实后端 |
| 并发 | 一个 worker 串行；在根 verify 和 72 张视觉检查结束后采样 |

`distSha256` 为 `f262a61c89020532bf092ce6a29b6c3d434533e2882e8e72e1ba64206a11db5b`。JSON 另存 fixture 与运行脚本、配置、测试、共享 harness 的组合 SHA-256；运行脚本按排序后的仓库相对路径、NUL 分隔符及文件内容计算。生产源码 commit 尚不包含本次新建 harness，因此复测时也必须保留相同 harness/fixture，不能只核对源码 commit。

## 操作与结果

每次先加载 production 静态页面、等固定数据与字体就绪，稳定 400ms；测量前完成滚动与起点定位。浏览器测量包含实际输入、异步响应、完成断言和末尾两个 animation frame。下表为各组 5 次样本的中位数，单位 ms；各指标分别取中位数，不能相加。

| 场景与固定数据量 | 操作到完成：中位数（范围） | CDP Script | CDP Task | CDP Layout | CDP Style |
|---|---:|---:|---:|---:|---:|
| 3 项自动化流程，真实手柄拖拽 12 步 | 261（256–263） | 27.771 | 75.623 | 4.196 | 13.976 |
| 输入 `1-7` 后 Enter，返回 5 条作业 | 116（104–138） | 12.812 | 73.698 | 3.532 | 4.697 |
| 180 条实时日志追加 20 条，下一次轮询返回 200 条快照 | 814（807–819） | 4.484 | 32.275 | 1.694 | 0.737 |
| 2 项养成队列，下移艾雅法拉 | 151（148–152） | 8.316 | 37.138 | 1.670 | 4.561 |

日志的 814ms 包含等待真实 1250ms 轮询周期的剩余时间，不能解释为渲染花费 814ms。搜索只覆盖搜索列表响应，不含 `recommended` 自动预览链路。

DOM 子树观测的中位数如下，覆盖整个 `document.body`，包含交互引起的页面和全局入口更新。增删只统计 mutation record 的直接节点，节点移动也会表现为增删。

| 场景 | observer 回调 | childList 记录 | attributes 记录 | characterData 记录 | 新增 / 移除节点 |
|---|---:|---:|---:|---:|---:|
| 拖拽尝试后取消 | 4 | 9 | 201 | 4 | 5 / 4 |
| 作业搜索 | 3 | 8 | 89 | 5 | 4 / 4 |
| 日志追加 | 1 | 20 | 9 | 1 | 20 / 0 |
| 队列编辑 | 2 | 18 | 53 | 12 | 8 / 10 |

20 个测量窗口都没有报告 longtask，且测量期间的 `pageerror` 均为空。这里只说明该窗口没有报告超过 50ms 的长任务，不能推导所有设备均无卡顿。普通 production React 构建没有开启 profiling，**本次没有 React render/commit count 或 actualDuration**；DOM mutation 与 CDP layout/style 计数都不能替代它们。未保留大型 trace，保留逐样本指标、输入事件和网络记录供重测。

## 请求证据与已知边界

每组 5 次交互的请求序列一致；所有记录到的交互请求均为 HTTP 200，无失败请求。

| 场景 | 测量窗口内实际 API 请求 |
|---|---|
| 拖拽尝试 | 2 次 `GET /agent/schedules/execution`；没有配置或排程写入 |
| 作业搜索 | 1 次 `GET /agent/copilot/search?stage=1-7` |
| 日志追加 | 1 次 `GET /agent/logs/recent?lines=200` |
| 队列编辑 | 1 次 `PUT /agent/training/queue/order`，随后 1 次 `GET /agent/training/queue`；提交顺序为 `char_202_demkni`、`char_180_amgoat` |

JSON 的请求路径保留 `/api` 前缀和 query；PUT body 保留 SHA-256 与业务摘要。初始化请求另列 `setupRequests`，不并入交互写入数量。现有重复读取也如实保留，例如自动化初始化有 2 次 execution 和 2 次 tasks/status，训练初始化有 2 次相同 trainable 候选查询；它们是基线事实，后续归属调整可减少重复读取。

**拖拽当前有取消缺陷。** 5 次均从正确手柄收到 pointerdown，途中重排后发生 `lostpointercapture`，现有取消处理将顺序恢复为启动游戏、理智作战、领取奖励；最终 pointerup 没有触发保存。JSON 保留 `requestedOrder`、`finalOrder`、`dragOutcome` 与实际 pointer 事件。harness 只校验真实输入发生、项目没有丢失、结果属于可识别枚举，允许后续修复后的成功结果，不把取消认定为兼容要求。

因此 261ms 只能作为“拖拽尝试并取消”的前测，**不能与未来成功排序耗时直接比较**。在后续自动化流程面板迁移中修复并确认 pointer 生命周期时，应补充成功拖拽的固定场景；性能收口再以相同成功场景复测。该补测归后续任务，本次没有实施修复。

**共享视觉 harness 存在早期初始化异常。** 其 init script 可能在 `document.documentElement` 尚不存在时执行 `appendChild`；本轮 20 次 setup 都记录到 `Cannot read properties of null (reading 'appendChild')`。现有视觉检查未监听该类早期异常。性能 harness 在导航后、测量前显式补入相同 CSS 动画冻结，逐样本分开保存 setup 异常与测量异常；只允许这一条明确 setup 消息，测量窗口仍要求无异常。共享 harness 的修正与视觉异常监测留给后续综合验收。

React Profiler 的补测应在性能收口时对要比较的两个源码状态使用相同 profiling 构建选项，双侧重测；不能将后补的 Profiler 数据与这里的 DOM/CDP 数据混称。真实服务端、网络延迟和公网资源吞吐也不在 fixture 基线内，需要时另建同环境端到端测量。

## 本次验证

```sh
PERFORMANCE_SKIP_BUILD=1 node client/scripts/performance-docker.ts --max-failures=1
# 20 passed (21.9s)

pnpm --filter la-pluma-next-client type-check
pnpm --filter la-pluma-next-client exec eslint tests/performance scripts/performance-docker.ts
node --check client/scripts/performance-docker.ts
# 均通过
```

首轮启动因 4310 被本机已有服务占用、视觉结果目录不可写而失败；最终使用独立 4317 和容器 `/tmp` 临时目录，没有停止已有服务或修改目录权限。调通阶段的拖拽等待与 setup 异常失败没有被计入样本，也没有生成不完整基线。最终完整 JSON 对应上述 20/20 轮次。
