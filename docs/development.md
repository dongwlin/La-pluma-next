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

## 常用检查

```bash
# 前端类型检查和构建
pnpm --filter la-pluma-next-client build

# 后端语法检查
pnpm --filter la-pluma-next-server check
```
