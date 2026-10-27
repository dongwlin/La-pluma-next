import { readdir } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { deleteJsonFile, readJsonFile, writeJsonFile, ensureDir } from '../utils/fileHelper.ts';
import { agentError, successResponse, errorResponse } from '../utils/apiHelper.ts';
import { createLogger } from '../utils/logger.ts';

const logger = createLogger('ConfigStorage');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 配置存储目录
const DEFAULT_CONFIG_STORAGE_DIR = path.join(__dirname, '../data/user-configs');
let configStorageDir = DEFAULT_CONFIG_STORAGE_DIR;
const ALLOWED_CONFIG_TYPES = new Set([
  'activity-cache',
  'auto-update',
  'automation-tasks',
  'combat-tasks',
  'notification',
  'roguelike-tasks',
  'training-queue'
]);

// 仅测试使用：把配置写入重定向到临时目录；生产代码不得调用。
export function setConfigStorageDirForTests(dir) {
  configStorageDir = dir ? path.resolve(dir) : DEFAULT_CONFIG_STORAGE_DIR;
}

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

// 获取配置文件路径
function getConfigPath(configType) {
  const normalizedType = validateConfigType(configType);
  const configPath = path.resolve(configStorageDir, `${normalizedType}.json`);
  if (path.dirname(configPath) !== path.resolve(configStorageDir)) {
    throw new Error('配置路径不合法');
  }
  return configPath;
}

// 保存用户配置
export async function saveUserConfig(configType, data) {
  try {
    validateConfigPayload(data);
    await ensureDir(configStorageDir);
    const configPath = getConfigPath(configType);
    await writeJsonFile(configPath, data);
    // 移除 DEBUG 日志，保存配置太频繁
    return successResponse(null, '配置保存成功');
  } catch (error) {
    logger.error('保存配置失败', { configType, error: error.message });
    return errorResponse(error, '保存配置失败');
  }
}

// 读取用户配置
export async function loadUserConfig(configType) {
  try {
    const configPath = getConfigPath(configType);
    const data = await readJsonFile(configPath, null);
    return successResponse(data);
  } catch (error) {
    logger.error('读取配置失败', { configType, error: error.message });
    return errorResponse(error, '读取配置失败');
  }
}

// 获取所有配置
export async function getAllUserConfigs() {
  try {
    await ensureDir(configStorageDir);
    const files = await readdir(configStorageDir);
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
export async function deleteUserConfig(configType) {
  try {
    const configPath = getConfigPath(configType);
    const deleted = await deleteJsonFile(configPath);

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
