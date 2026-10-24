# 开发文档

> [← 返回 README](../README.md)

项目使用 React + TypeScript + Node.js 技术栈，代码结构围绕“前端页面、Agent API、后端服务”展开。

## 主要技术点

- **前端**: React Hooks 与原生语义组件实现页面壳层和响应式 chrome，Tailwind CSS v4（`@tailwindcss/vite`）/语义 token 负责业务布局，Framer Motion 负责物理动效，Zustand 管理跨页面状态
- **API**: 前端通过 `client/src/shared/api/` 的传输层底座（`API_BASE_URL`、`fetchWithAuth`、`parseJsonResponse`、`getErrorMessage`）访问 `/api/agent/*`；业务端点按语义归各 `features/<domain>/api/`，跨域共用的命令执行与用户配置端点在 `features/task-execution/`、`features/user-config/` 两个微域
- **后端**: `server/server.js` 挂载 Agent API，并用 Socket.IO 推送运行状态
- **MAA 集成**: 通过 Node.js 子进程调用 `maa` CLI 命令
- **定时任务**: 使用 node-cron 实现任务调度
- **通知服务**: Telegram Bot API + 任务完成通知

前端 UI 的具体规则见根目录 [设计规范](../DESIGN.md)，组件 API 见 [通用组件库](component-library.md)。

## 样式治理

### 全局样式冻结

`client/src/styles/index.css` 与 `client/src/styles/ios-theme.css` 不再新增页面级选择器；新样式随组件目录走（组件同名 CSS / 按域样式文件），最终由样式轨道 S4 的 `@layer page` 分层方案归位。完整规则见 [设计规范](../DESIGN.md) 的「配置即规范」一节。

### stylelint 预算制（ratchet）

存量违规数冻结在 `client/stylelint-baseline.json`（按文件粒度记录，文件移动/改名时比单一总数更稳）。存量违规一律 warning，不阻塞本地开发；拦净新增靠脚本：

```bash
pnpm --filter la-pluma-next-client stylelint           # 本地查看违规（全部 warning）
pnpm --filter la-pluma-next-client stylelint:ratchet   # 预算校验（CI 同款，超出基线即失败）
pnpm --filter la-pluma-next-client stylelint:baseline  # 违规数下降或有意的迁移/重构后重新生成基线
```

CI 中 `stylelint:ratchet` 随 `pnpm verify` 一起执行（见 `.github/workflows/ci.yml`）。

### 视觉基线（8 tab × 深/浅主题 × 桌面/移动 = 32 张）

视觉基线是样式轨道 S2/S3/S4 每一步“保留视觉”的验收手段，harness 在 `client/tests/visual/`，基线截图入库于 `client/tests/visual/__screenshots__/`。

- **环境钉死**：截图生成与比对统一跑在 `mcr.microsoft.com/playwright` 官方镜像内（tag 自动取 client 实际安装的 `@playwright/test` 版本，如 `v1.64.1-noble`），字体与浏览器由此与 CI 完全一致。基线截图是 **Linux/Chromium 专属**：更换镜像、Playwright 版本或操作系统后，必须用 `pnpm visual:update` 重新生成并逐项评审 diff，不要试图跨环境复用。
- **确定性**：`/api` 请求全部由 `client/tests/visual/fixtures.ts` 的固定数据应答（不依赖真实后端与 MAA 运行状态）；`page.clock` 固定到 2026-10-24 04:00（UTC+8）并统一推进 6 秒，日期敏感内容（今日开放关卡、资源更新时间等）不随运行当天变化；`reducedMotion: 'reduce'` 加文档级样式禁用 CSS 动画/过渡；主题通过 zustand persist 的 `ui-storage` localStorage 预置，首帧即目标主题。
- **桌面 1440×900、移动 390×844**，deviceScaleFactor 1，整页截图。

```bash
pnpm visual          # 比对模式：与入库基线比对，diff 非零即失败（CI 同款）
pnpm visual:update   # 有意的视觉改动后重新生成基线截图
pnpm visual -- --grep "dashboard"   # 透传 playwright 过滤参数，只跑部分用例
```

### Tailwind v4（S2 升级）

样式轨道 S2 把 Tailwind CSS 从 v3 升级到 v4，构建链路与入口约定如下：

- **构建链路**：依赖为 `tailwindcss@^4` + `@tailwindcss/vite`，由 Vite 插件处理样式；`autoprefixer`、`postcss` 与 `client/postcss.config.js` 已退役。PostCSS 链路不再参与前端构建。
- **入口**：`client/src/styles/index.css` 首行必须是 `@import "tailwindcss";`（Tailwind 只解析字符串形式；stylelint 的 `import-notation` 在该行就地豁免）。随后用 `@config "../../tailwind.config.js";` 兼容挂载现有 JS 配置，并用 `@custom-variant dark (&:is(.dark *));` 保持 class 深色模式。S3 会把配置迁入 `@theme` 并删除 `tailwind.config.js`。
- **压缩映射保持不变**：`@config` 兼容层完整保留 `rounded-*`、`gap-*`、`space-*` 映射，实测 `gap-3/4/5/6`、`space-4/5/6`、`rounded`–`rounded-3xl` 均仍指向 `--app-radius-*` / `--app-space-*`；不要按通用 v4 指南改写这些类名（例如 `rounded-sm→rounded-xs`）。
- **v3 视觉基线**：升级按断代点迁移类名（`shadow-sm→shadow-xs`、`backdrop-blur-sm→backdrop-blur-xs`、`outline-none→outline-hidden`、`!` 前缀改后缀、`flex-shrink-0→shrink-0`）。注意 **`shadow-md` 及以上档位在 v4 中数值与 v3 相同，不要按 "shadow-lg→shadow-md" 的通用口诀改名**——那会改变阴影。`ring`、裸 `border`/`divide` 已全量审计并显式给色；`space-x/y` 选择器语义改为 `:not(:last-child)` 的 end margin，已逐元素审计，并对 combat 搜索行中 `sr-only` label 参与 `space-x` 计数的场景显式补回 v3 左间距，32 张基线比对通过。
- **cascade layer**：v4 的 utilities 位于 layer 内，未分层页面 CSS 会压过 `dark:*` 等 utilities；升级中对依赖该覆盖的深色预览标题改用组件侧 `dark:text-white!` 保留 v3 颜色，S3 统一分层时再评估。
- **默认色板**：v4 默认色板以 OKLCH 重新校准（灰度 ΔE < 1.5，`emerald-500` 约 ΔE 4.3）；语义 token 不受影响，精确对齐 v3 色值留待 S3。
- **preflight 对齐**：v4 移除了按钮 `cursor: pointer` 与 `:disabled` 的 default cursor，并把 placeholder 改为 currentColor/50%、默认 border-color 改为 currentColor。`index.css` 的 base 层保留了 v3 等价规则（按钮 pointer、disabled default、placeholder gray-400、border gray-200），避免 cursor 这类截图捕获不到的行为回归。
- **浏览器下限**：Tailwind v4 依赖原生 cascade layers、`color-mix()`、OKLCH 与 `@property`，前端最低支持 **Safari 16.4+ / Chrome 111+ / Firefox 128+**。低于该下限的浏览器不再保证样式正确。

## 常用检查

```bash
# 前端类型检查和构建
pnpm --filter la-pluma-next-client build

# 后端语法检查
pnpm --filter la-pluma-next-server check

# 全仓 lint + 类型 + 测试 + 构建（CI 主链路）
pnpm verify

# 样式预算与视觉基线（配合 pnpm verify 使用）
pnpm --filter la-pluma-next-client stylelint:ratchet
pnpm visual
```
