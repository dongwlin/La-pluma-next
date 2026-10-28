/**
 * 共享作业进度的 JSON 读改写存储
 *
 * copilot-progress.json 与 activity-copilot-progress.json 都是"单文件多键"的
 * 共享状态：不同键（作业集 / 活动代号）的并发更新必须互不覆盖，损坏文件必须
 * 可识别而不是静默清零。原子替换、同路径排队串行与完整读改写全部由 fileHelper
 * 承担，本模块只绑定存储路径并提供注入点。
 */

import { readJsonFile, updateJsonFile } from '../utils/fileHelper.ts';

/**
 * 创建绑定单一 JSON 进度文件的存储实例。路径可注入：服务默认位置保持
 * `server/data/<名称>.json`，测试通过独立实例指向临时目录，运行环境可通过
 * `LA_PLUMA_*` 覆盖变量重定向（见各服务的默认路径绑定）。
 *
 * @param {object} options
 * @param {string} options.progressPath 进度文件的绝对路径。
 * @returns {{
 *   path: string,
 *   load: () => Promise<object>,
 *   update: (updateFn: (current: object) => object | Promise<object>) => Promise<object>
 * }}
 */
export function createCopilotProgressStore({ progressPath }) {
  if (typeof progressPath !== 'string' || !progressPath) {
    throw new TypeError('progressPath 必须是非空字符串');
  }

  return {
    path: progressPath,
    // 缺失文件按空进度处理；损坏文件抛出“读取 JSON 文件失败”的可识别错误，
    // 不再静默降级为空对象，避免后续写入把已有进度清零。
    load: () => readJsonFile(progressPath, {}),
    // 读改写整体在同一排队单元内执行：并发更新不同键互不丢失，
    // 写回为临时文件加原子替换，失败时保留原文件内容。
    update: updateFn => updateJsonFile(progressPath, updateFn, {})
  };
}
