import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import TOML from '@iarna/toml';
import { createLogger } from '../utils/logger.ts';
import { updateTextFile } from '../utils/fileHelper.ts';
import { DEFAULT_ADB_ADDRESS, DEFAULT_ADB_PATH } from '../config/connectionDefaults.js';
import { execMaaCommandUnlocked } from './maaProcessService.js';

/**
 * MAA profile 配置的读取与写入。
 *
 * - 目录与 profile 路径都由 `maa dir config` 解析，名称经同一白名单校验，
 *   拒绝路径穿越。
 * - 同一 profile 的读取、合并与写入在同一排队单元内完成；TOML 内容按文本
 *   原子替换，解析或写入失败时不写回，已有配置保持原样（与既有原子写契约
 *   一致）。
 * - 这里只执行非设备变更的 `dir` 查询，不申请执行租约；进程执行与状态归
 *   maaProcessService。
 */

const logger = createLogger('MaaService');

/**
 * 获取 MAA 配置目录
 */
export async function getMaaConfigDir() {
  const result = await execMaaCommandUnlocked('dir', ['config']);
  return result.stdout;
}

/**
 * 获取配置文件路径
 */
export function validateMaaProfileName(profileName = 'default') {
  if (typeof profileName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profileName)) {
    throw new Error('连接配置名称不合法');
  }
  return profileName;
}

async function getConfigPath(profileName = 'default') {
  const normalizedProfileName = validateMaaProfileName(profileName);
  const configDir = await getMaaConfigDir();
  const profilesDir = resolve(configDir.trim(), 'profiles');
  const configPath = resolve(profilesDir, `${normalizedProfileName}.toml`);
  if (dirname(configPath) !== profilesDir) {
    throw new Error('连接配置路径不合法');
  }
  return configPath;
}

export function parseMaaProfile(content) {
  return TOML.parse(String(content || ''));
}

export function mergeMaaProfileConnection(profileDocument = {}, config = {}) {
  if (!profileDocument || typeof profileDocument !== 'object' || Array.isArray(profileDocument)) {
    throw new TypeError('MAA profile 文档格式不合法');
  }

  const connectionUpdates = Object.prototype.hasOwnProperty.call(config, 'connection')
    ? config.connection
    : config;
  if (!connectionUpdates || typeof connectionUpdates !== 'object' || Array.isArray(connectionUpdates)) {
    throw new TypeError('connection 配置格式不合法');
  }

  const existingConnection = profileDocument.connection;
  if (existingConnection != null && (typeof existingConnection !== 'object' || Array.isArray(existingConnection))) {
    throw new TypeError('现有 connection section 格式不合法');
  }

  const normalizedUpdates = Object.fromEntries(
    Object.entries(connectionUpdates).filter(([, value]) => value !== undefined)
  );
  return {
    ...profileDocument,
    connection: {
      ...(existingConnection || {}),
      ...normalizedUpdates
    }
  };
}

/**
 * 读取配置文件
 */
export async function getConfig(profileName = 'default') {
  const normalizedProfileName = validateMaaProfileName(profileName);
  try {
    const configPath = await getConfigPath(normalizedProfileName);
    const content = await readFile(configPath, 'utf-8');
    const profile = parseMaaProfile(content);
    return profile.connection || profile;
  } catch {
    logger.debug('配置文件不存在，返回环境默认配置');
    return {
      adb_path: DEFAULT_ADB_PATH,
      address: DEFAULT_ADB_ADDRESS,
      config: 'CompatMac',
    };
  }
}

/**
 * 保存配置文件
 */
export async function saveConfig(profileName = 'default', config) {
  try {
    const normalizedProfileName = validateMaaProfileName(profileName);
    const configPath = await getConfigPath(normalizedProfileName);

    // 同一 profile 的读取、合并与写入在同一排队单元内完成：并发保存不会互相覆盖未知 section，
    // 异名 profile 路径不同、互不阻塞。TOML 内容按文本原子替换；解析或写入失败时不写回，
    // 已有配置保持原样。
    await updateTextFile(configPath, currentContent => {
      const existingProfile = currentContent === null ? {} : parseMaaProfile(currentContent);
      const mergedProfile = mergeMaaProfileConnection(existingProfile, config);
      return TOML.stringify(mergedProfile);
    });
    logger.debug('配置已保存', { configPath });
  } catch (error) {
    throw new Error(`保存配置失败: ${error.message}`);
  }
}
