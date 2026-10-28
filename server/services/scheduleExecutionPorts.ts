import { execMaaCommand, execDynamicTask } from './maaExecutionService.ts';
import { captureScreen, getGameClientState, testAdbConnection } from './maaDeviceService.ts';
import { createMaaLogCheckpoint, readMaaLogSince } from './maaLogFileService.ts';
import { replaceActivityCode } from './maaActivityService.ts';
import { resolveConnection } from './connectionService.js';
import {
  sendTaskCompletionNotification,
  isStageOpenToday,
  shouldCaptureNotificationScreenshot
} from './notificationService.ts';
import { recordDrops } from './dropRecordService.ts';
import { withMaaExecutionLease } from './executionCoordinatorService.ts';
import { updateSmartTrainingStages } from './scheduleSmartTrainingService.ts';
import type { ScheduleExecutionPorts } from './scheduleFlowExecution.ts';

/**
 * 流程执行端口：设备命令、日志检查点、通知与存储适配集中在组装处接线。
 * 执行模块只调用端口，不直接依赖设备、用户配置或通知实现；测试可传入假端口
 * 验证步骤结果，不需要 MAA CLI、ADB 或真实数据目录。
 *
 * 端口按执行器实际读取的字段收窄；例如关卡代号替换只接收字符串并返回字符串，
 * 底层实现保留对任意输入的兼容。
 */
export function createScheduleExecutionPorts(
  overrides: Partial<ScheduleExecutionPorts> = {}
): ScheduleExecutionPorts {
  return {
    executeCommand: execMaaCommand,
    executeDynamicTask: execDynamicTask,
    createLogCheckpoint: createMaaLogCheckpoint,
    readLogSince: readMaaLogSince,
    // 连接服务返回 profile 视图；执行器只使用其中的 ADB 路径与地址。
    resolveConnection: async () => {
      const connection = await resolveConnection();
      return { adbPath: String(connection.adbPath), address: String(connection.address) };
    },
    testConnection: testAdbConnection,
    getGameClientState,
    captureScreen,
    // 执行器只传入字符串关卡；实现会对非字符串原样返回，字符串输入保持原值。
    replaceActivityCode: async (stage, clientType) => String(await replaceActivityCode(stage, clientType)),
    isStageOpenToday,
    shouldCaptureNotificationScreenshot,
    sendCompletionNotification: sendTaskCompletionNotification,
    recordDrops,
    // 仓库解析按需加载，保持既有的惰性导入与运行数据写入时机。
    parseDepotData: async () => {
      const { parseDepotData } = await import('./dataParserService.ts');
      return parseDepotData();
    },
    refreshSmartTrainingStages: updateSmartTrainingStages,
    withExecutionLease: withMaaExecutionLease,
    ...overrides
  };
}
