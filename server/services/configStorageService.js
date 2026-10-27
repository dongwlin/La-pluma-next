import { readdir } from 'fs/promises';
import path from 'path';
import {
  deleteJsonFile,
  ensureDir,
  readJsonFile,
  updateJsonFile,
  writeJsonFile
} from '../utils/fileHelper.ts';
import { agentError, successResponse, errorResponse } from '../utils/apiHelper.ts';
import { createLogger } from '../utils/logger.ts';
import { resolveAppPaths } from '../config/runtimeConfig.ts';

const logger = createLogger('ConfigStorage');

const ALLOWED_CONFIG_TYPES = new Set([
  'activity-cache',
  'auto-update',
  'automation-tasks',
  'combat-tasks',
  'notification',
  'roguelike-tasks',
  'training-queue'
]);

// 默认目录经运行配置入口解析（server/data/user-configs），不依赖进程 cwd。
const defaultUserConfigsDir = resolveAppPaths().userConfigsDir;

/**
 * 文件存储端口：用户配置存储所需的全部 IO 能力，可整体注入替换。
 * 其中 `updateJsonFile` 必须把读取、更新、写回作为同一排队单元执行
 * （fileHelper 按解析路径排队变更），不能只串行最后一次写入，
 * 否则并发读改写会互相覆盖；`writeJsonFile` 为原子整份替换。
 */
const defaultConfigIo = {
  ensureDir,
  readJsonFile,
  writeJsonFile,
  updateJsonFile,
  deleteJsonFile,
  listDir: dirPath => readdir(dirPath)
};

export function validateConfigType(configType) {
  if (typeof configType !== 'string' || !ALLOWED_CONFIG_TYPES.has(configType)) {
    throw agentError('AGENT_CONFIG_TYPE_INVALID', '配置类型不合法', {
      statusCode: 400,
      details: { configType }
    });
  }
  return configType;
}

/**
 * 顶层载荷校验：只要求 JSON 对象，不限制字段，
 * 保留旧结构 payload 与扩展字段，同时挡住字符串、数组、null 等错误输入。
 */
function validateConfigPayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw agentError('AGENT_CONFIG_DATA_INVALID', '配置数据必须是 JSON 对象', {
      statusCode: 400,
      details: {
        receivedType: Array.isArray(data) ? 'array' : data === null ? 'null' : typeof data
      },
      retryable: false
    });
  }
}

/**
 * 创建独立的用户配置存储实例。路径与文件 IO 均可注入：
 * - `configDir`：配置存储目录，缺省使用运行配置入口的 userConfigsDir；
 * - `io`：文件存储端口，缺省使用 fileHelper 与目录列表实现。
 * 每个实例持有自己的目录与端口，实例之间不共享可变状态或目录。
 *
 * 读写策略：
 * - `saveUserConfig` 是整份保存：完整替换该配置文件，不与已有内容合并，
 *   适合调用方持有配置全部内容的场景；
 * - `updateUserConfig` 是读改写：读取、更新、写回整体在同一路径的排队操作内
 *   串行完成，并发的部分更新不会互相覆盖；缺失文件时 updateFn 收到 null
 *   （与 loadUserConfig 的缺失默认值一致）；
 * - 跨多次调用的“先 load 再 save”不构成原子读改写，多写者对同一配置的
 *   部分更新必须走 `updateUserConfig`。
 */
export function createUserConfigStorage({ configDir = defaultUserConfigsDir, io = defaultConfigIo } = {}) {
  let activeConfigDir = path.resolve(configDir);

  // 获取配置文件路径
  function getConfigPath(configType) {
    const normalizedType = validateConfigType(configType);
    const configPath = path.resolve(activeConfigDir, `${normalizedType}.json`);
    if (path.dirname(configPath) !== activeConfigDir) {
      throw new Error('配置路径不合法');
    }
    return configPath;
  }

  // 保存用户配置（整份覆盖）
  async function saveUserConfig(configType, data) {
    try {
      validateConfigPayload(data);
      await io.ensureDir(activeConfigDir);
      const configPath = getConfigPath(configType);
      await io.writeJsonFile(configPath, data);
      // 移除 DEBUG 日志，保存配置太频繁
      return successResponse(null, '配置保存成功');
    } catch (error) {
      logger.error('保存配置失败', { configType, error: error.message });
      return errorResponse(error, '保存配置失败');
    }
  }

  // 读取用户配置
  async function loadUserConfig(configType) {
    try {
      const configPath = getConfigPath(configType);
      const data = await io.readJsonFile(configPath, null);
      return successResponse(data);
    } catch (error) {
      logger.error('读取配置失败', { configType, error: error.message });
      return errorResponse(error, '读取配置失败');
    }
  }

  // 读改写用户配置（整体排队，策略见 createUserConfigStorage 说明）
  async function updateUserConfig(configType, updateFn) {
    try {
      const configPath = getConfigPath(configType);
      const updated = await io.updateJsonFile(configPath, updateFn, null);
      return successResponse(updated);
    } catch (error) {
      logger.error('更新配置失败', { configType, error: error.message });
      return errorResponse(error, '更新配置失败');
    }
  }

  // 获取所有配置
  async function getAllUserConfigs() {
    try {
      await io.ensureDir(activeConfigDir);
      const files = await io.listDir(activeConfigDir);
      const configs = {};

      for (const file of files) {
        if (file.endsWith('.json')) {
          const configType = file.replace('.json', '');
          if (!ALLOWED_CONFIG_TYPES.has(configType)) continue;
          const result = await loadUserConfig(configType);
          if (result.success && result.data) {
            configs[configType] = result.data;
          }
        }
      }

      return successResponse(configs);
    } catch (error) {
      logger.error('获取所有配置失败', { error: error.message });
      return errorResponse(error, '获取所有配置失败');
    }
  }

  // 删除配置
  async function deleteUserConfig(configType) {
    try {
      const configPath = getConfigPath(configType);
      const deleted = await io.deleteJsonFile(configPath);

      if (!deleted) {
        return successResponse(null, '配置不存在');
      }

      logger.info('配置删除成功', { configType });
      return successResponse(null, '配置删除成功');
    } catch (error) {
      logger.error('删除配置失败', { configType, error: error.message });
      return errorResponse(error, '删除配置失败');
    }
  }

  return {
    saveUserConfig,
    loadUserConfig,
    updateUserConfig,
    getAllUserConfigs,
    deleteUserConfig,
    // 仅测试使用：重定向本实例的存储目录；传入空值恢复默认目录。
    setConfigDirForTests(dir) {
      activeConfigDir = path.resolve(dir || defaultUserConfigsDir);
    }
  };
}

const defaultStorage = createUserConfigStorage();

// 仅测试使用：把默认存储实例重定向到临时目录；生产代码不得调用。
// 通过工厂创建的实例不受影响，仍使用各自的目录与端口。
export function setConfigStorageDirForTests(dir) {
  defaultStorage.setConfigDirForTests(dir);
}

export const saveUserConfig = defaultStorage.saveUserConfig;
export const loadUserConfig = defaultStorage.loadUserConfig;
export const updateUserConfig = defaultStorage.updateUserConfig;
export const getAllUserConfigs = defaultStorage.getAllUserConfigs;
export const deleteUserConfig = defaultStorage.deleteUserConfig;
