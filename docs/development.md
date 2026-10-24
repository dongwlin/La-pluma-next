# 开发文档

> [← 返回 README](../README.md)

项目使用 React + TypeScript + Node.js 技术栈，代码结构围绕“前端页面、Agent API、后端服务”展开。

## 主要技术点

- **前端**: React Hooks 与原生语义组件实现页面壳层和响应式 chrome，Tailwind CSS/语义 token 负责业务布局，Framer Motion 负责物理动效，Zustand 管理跨页面状态
- **API**: 前端通过 `client/src/services/api.ts` 访问 `/api/agent/*`
- **后端**: `server/server.js` 挂载 Agent API，并用 Socket.IO 推送运行状态
- **MAA 集成**: 通过 Node.js 子进程调用 `maa` CLI 命令
- **定时任务**: 使用 node-cron 实现任务调度
- **通知服务**: Telegram Bot API + 任务完成通知

前端 UI 的具体规则见根目录 [设计规范](../DESIGN.md)，组件 API 见 [通用组件库](component-library.md)。

## 样式治理（S1 护栏）

### 全局样式冻结

`client/src/index.css` 与 `client/src/ios-theme.css` 不再新增页面级选择器；新样式随组件目录走（组件同名 CSS / 按域样式文件），最终由样式轨道 S4 的 `@layer page` 分层方案归位。完整规则见 [设计规范](../DESIGN.md) 的「配置即规范」一节。

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
