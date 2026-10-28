import express from 'express';
import agentExecutionRoutes from './agentExecution.ts';
import agentStatusRoutes from './agentStatusRoutes.ts';
import agentLogRoutes from './agentLogRoutes.ts';
import agentDataRoutes from './agentDataRoutes.ts';
import agentTrainingRoutes from './agentTrainingRoutes.ts';
import agentPreviewRoutes from './agentPreviewRoutes.ts';
import agentNotificationRoutes from './agentNotificationRoutes.ts';
import agentMaintenanceRoutes from './agentMaintenanceRoutes.ts';
import { sendSuccess } from '../utils/apiHelper.ts';
import type { ApiResponseWriter } from '../utils/apiHelper.ts';
import { DEFAULT_ADB_ADDRESS, DEFAULT_ADB_PATH, DEFAULT_CLIENT_TYPE } from '../config/connectionDefaults.ts';
import { buildAgentManifest, buildOpenApiSpec } from './agentContract.ts';
import type { ReadRequest } from './readDto.ts';

/**
 * Agent API 聚合入口。
 *
 * 这里只声明契约文档与领域 router 的挂载清单：不缓存运行状态，不直接
 * 发起网络、文件或进程操作，业务副作用由各领域 router 与其服务所有者
 * 承担。新增入口先归入对应领域 router，再在此挂载。
 */
const router = express.Router();

router.get('/manifest', (req: ReadRequest, res: ApiResponseWriter) => {
  return sendSuccess(res, req, buildAgentManifest({
    adbPath: DEFAULT_ADB_PATH,
    adbAddress: DEFAULT_ADB_ADDRESS,
    clientType: DEFAULT_CLIENT_TYPE
  }));
});

router.get('/openapi.json', (_req: ReadRequest, res: ApiResponseWriter) => {
  res.json(buildOpenApiSpec({
    adbPath: DEFAULT_ADB_PATH,
    adbAddress: DEFAULT_ADB_ADDRESS,
    clientType: DEFAULT_CLIENT_TYPE
  }));
});

// 状态汇总与 Run 查询由独立 router 承担；状态探测保留在状态边界内，
// 不与执行编排或纯数据读取混在一起。
router.use(agentStatusRoutes);

// 截图、WebRTC 启停与状态、方向设置和设备采样由独立预览 router 承担；
// 进程、viewer 计时器与资源所有权仍在 webrtcService，router 只做 HTTP 适配。
router.use(agentPreviewRoutes);

// 日志读取与清理由独立 router 承担；清空/清理仍属运行数据维护，
// 不能因迁出 agent.ts 而当作无副作用接口。
router.use(agentLogRoutes);

// 执行路由与 Run 生命周期适配由独立 router 承担。
router.use(agentExecutionRoutes);

// 今日关卡、掉落与本地游戏数据读取由独立 router 承担；识别动作仍留在
// 动作入口，读取路由不解析 MAA 日志或更新缓存。
router.use(agentDataRoutes);

// 养成队列、设置、候选与计划路由由独立 router 承担；队列 revision、
// 写后串行化与流程/定时同步结果仍由 operatorTrainingService 提供。
router.use(agentTrainingRoutes);

// 通知配置读写与渠道测试/发送由独立 router 承担；配置持久化仍在
// configStorageService，运行时配置与渠道发送仍由 notificationService 持有。
router.use(agentNotificationRoutes);

// 连接/profile、资源更新、定时配置与维护动作由独立 router 承担；
// 注册配置与实际执行分开，维护动作的副作用复用既有服务。
router.use(agentMaintenanceRoutes);

export default router;
