import { readJsonFile, updateJsonFile } from '../utils/fileHelper.ts';

export interface CopilotProgressStoreOptions {
  /** 进度文件的绝对路径；运行时必须是非空字符串。 */
  progressPath?: string;
}

export interface CopilotProgressStore {
  path: string;
  load(): Promise<unknown>;
  update<T>(updateFn: (current: unknown) => T | Promise<T>): Promise<T>;
}

export function createCopilotProgressStore({ progressPath }: CopilotProgressStoreOptions): CopilotProgressStore {
  if (typeof progressPath !== 'string' || !progressPath) {
    throw new TypeError('progressPath 必须是非空字符串');
  }
  const resolvedPath = progressPath;

  return {
    path: resolvedPath,
    // 缺失文件按空进度处理；损坏文件抛出“读取 JSON 文件失败”的可识别错误，
    // 不再静默降级为空对象，避免后续写入把已有进度清零。
    load: () => readJsonFile(resolvedPath, {}),
    // 读改写整体在同一排队单元内执行：并发更新不同键互不丢失，
    // 写回为临时文件加原子替换，失败时保留原文件内容。
    update: updateFn => updateJsonFile(resolvedPath, updateFn, {})
  };
}
