import { execMaaCommand, execDynamicTask } from './maaExecutionService.ts';
import { captureScreen, getGameClientState, testAdbConnection } from './maaDeviceService.ts';
import { createMaaLogCheckpoint, readMaaLogSince } from './maaLogFileService.ts';
import { isResourceCollectionOpen, replaceActivityCode } from './maaActivityService.ts';
import { resolveConnection } from './connectionService.ts';
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
 * 端口按执行器实际读取的字段收窄：如关卡代号替换只接收字符串并返回字符串，
 * 底层实现保留对任意输入的兼容。
 */
export function createScheduleExecutionPorts(
  overrides: Partial<ScheduleExecutionPorts> = {}
): ScheduleExecutionPorts {
  return {
    executeCommand: execMaaCommand,
    executeDynamicTask: (taskId, taskConfig, taskName, taskType, waitForCompletion, clientType) =>
      execDynamicTask(taskId, taskConfig, taskName, taskType, waitForCompletion, false, { clientType }),
    createLogCheckpoint: createMaaLogCheckpoint,
    readLogSince: readMaaLogSince,
    resolveConnection: async () => {
      const connection = await resolveConnection();
      return {
        adbPath: String(connection.adbPath),
        address: String(connection.address),
        clientType: String(connection.clientType)
      };
    },
    testConnection: testAdbConnection,
    getGameClientState,
    captureScreen,
    replaceActivityCode: async (stage, clientType) => String(await replaceActivityCode(stage, clientType)),
    // 关卡开放按客户端游戏日判定；资源收集全开放期间同一客户端服务区全开。
    isStageOpenToday: async (stage, clientType) => isStageOpenToday(stage, {
      clientType,
      allResourceStagesOpen: await isResourceCollectionOpen(clientType)
    }),
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
