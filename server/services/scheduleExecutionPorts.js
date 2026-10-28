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
import { recordDrops } from './dropRecordService.js';
import { withMaaExecutionLease } from './executionCoordinatorService.ts';
import { updateSmartTrainingStages } from './scheduleSmartTrainingService.js';

/**
 * 流程执行端口：设备命令、日志检查点、通知与存储适配集中在组装处接线。
 * 执行模块只调用端口，不直接依赖设备、用户配置或通知实现；测试可传入假端口
 * 验证步骤结果，不需要 MAA CLI、ADB 或真实数据目录。
 */
export function createScheduleExecutionPorts(overrides = {}) {
  return {
    executeCommand: execMaaCommand,
    executeDynamicTask: execDynamicTask,
    createLogCheckpoint: createMaaLogCheckpoint,
    readLogSince: readMaaLogSince,
    resolveConnection,
    testConnection: testAdbConnection,
    getGameClientState,
    captureScreen,
    replaceActivityCode,
    isStageOpenToday,
    shouldCaptureNotificationScreenshot,
    sendCompletionNotification: sendTaskCompletionNotification,
    recordDrops,
    // 仓库解析按需加载，保持既有的惰性导入与运行数据写入时机。
    parseDepotData: async () => {
      const { parseDepotData } = await import('./dataParserService.js');
      return parseDepotData();
    },
    refreshSmartTrainingStages: updateSmartTrainingStages,
    withExecutionLease: withMaaExecutionLease,
    ...overrides
  };
}
