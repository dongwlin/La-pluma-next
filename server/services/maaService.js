/**
 * MAA 能力的兼容转接层。
 *
 * 实现已按所有权拆分到同域模块，本文件只保留原有导出名，供尚未迁移的调用方
 * （主要是测试与外部脚本）继续按 `services/maaService.js` 导入；新调用方应直接
 * 从所有者模块导入。所有导出都是同一个函数引用，不复制状态，也不产生第二个
 * 可写执行状态。调用方全部迁移完成后可删除本文件。
 *
 * 所有权：
 * - maaProcessService：CLI 子进程执行、taskStatus、实时日志缓冲、停止与输出诊断；
 * - maaExecutionService：设备租约门禁、CLI 命令入口、版本查询与动态任务；
 * - maaConfigService：MAA profile 目录解析、读取与原子写入；
 * - maaDeviceService：ADB 探测、连接测试、前台游戏状态与截图；
 * - maaLogFileService：日志文件列表、读取边界、清理与执行日志检查点；
 * - maaActivityService：当前活动查询、缓存与关卡代号替换。
 *
 * 子进程状态（maaProcessService）、设备租约（executionCoordinatorService）与
 * Run 终态（agentRunService）仍是彼此独立的对象，转接层不合并它们。
 */

export {
  MAX_REALTIME_LOG_LINES,
  getTaskStatus,
  getRealtimeLogs,
  clearRealtimeLogs,
  getMaaExecutionDiagnostics,
  setTaskStatus,
  stopCurrentTask
} from './maaProcessService.js';

export {
  requiresMaaExecutionLease,
  execMaaCommand,
  getMaaVersion,
  execDynamicTask
} from './maaExecutionService.js';

export {
  getMaaConfigDir,
  validateMaaProfileName,
  parseMaaProfile,
  mergeMaaProfileConnection,
  getConfig,
  saveConfig
} from './maaConfigService.js';

export {
  getAdbDeviceState,
  discoverAdbDevices,
  getGameClientState,
  parseForegroundPackage,
  testAdbConnection,
  captureScreen
} from './maaDeviceService.js';

export {
  MAX_LOG_FILE_LINES,
  createMaaLogCheckpoint,
  readMaaLogSince,
  getLogFiles,
  cleanupLogs,
  isPathOutsideDir,
  readLogFile,
  getDebugScreenshots
} from './maaLogFileService.js';

export {
  getCurrentActivity,
  replaceActivityCode
} from './maaActivityService.js';
