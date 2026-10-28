import { createLogger } from '../utils/logger.ts';
import { DEFAULT_CLIENT_TYPE } from '../config/connectionDefaults.js';
import { getFallbackActivity } from './activityFallbackService.js';
import { loadUserConfig, saveUserConfig } from './configStorageService.ts';
import { execMaaCommand } from './maaExecutionService.js';

/**
 * 当前活动查询与关卡代号替换。
 *
 * - 活动信息先读内存缓存，再读用户配置中的 `activity-cache`，最后查
 *   `maa activity`，失败时回落备用数据源；TTL 与活动结束时间取较早者。
 * - 持久化沿用 configStorageService 的受控类型，不在这里另写文件。
 * - MAA 活动查询是非设备变更命令，不持有执行租约；本模块不保存任务状态。
 */

const logger = createLogger('MaaService');

const ACTIVITY_CACHE_TTL = 24 * 60 * 60 * 1000;
const activityCache = new Map();

function cacheActivity(clientType, activity) {
  const cached = {
    ...activity,
    timestamp: Date.now(),
    ttl: ACTIVITY_CACHE_TTL
  };
  activityCache.set(clientType, cached);
  void saveUserConfig('activity-cache', { [clientType]: cached });
  return { ...activity };
}

function getValidCachedActivity(clientType, cachedActivity, now = Date.now()) {
  if (!cachedActivity?.code || !cachedActivity.timestamp) return null;
  const ttlExpiresAt = cachedActivity.timestamp + (cachedActivity.ttl || ACTIVITY_CACHE_TTL);
  const expiresAt = cachedActivity.endTime
    ? Math.min(ttlExpiresAt, cachedActivity.endTime)
    : ttlExpiresAt;
  if (now >= expiresAt) return null;
  return {
    code: cachedActivity.code,
    name: cachedActivity.name,
    source: cachedActivity.source,
    startTime: cachedActivity.startTime,
    endTime: cachedActivity.endTime,
    stages: cachedActivity.stages
  };
}

/**
 * 获取当前活动代号和名称
 */
export async function getCurrentActivity(clientType = DEFAULT_CLIENT_TYPE) {
  const now = Date.now();
  const cachedActivity = activityCache.get(clientType);
  const cached = getValidCachedActivity(clientType, cachedActivity, now);
  if (cached) {
      logger.debug('使用缓存的活动信息', {
        clientType, code: cached.code, name: cached.name, source: cached.source
      });
    return cached;
  }
  if (cachedActivity) {
    activityCache.delete(clientType);
  }

  const persistedResult = await loadUserConfig('activity-cache');
  const persisted = getValidCachedActivity(clientType, persistedResult.success ? persistedResult.data?.[clientType] : null, now);
  if (persisted) {
    activityCache.set(clientType, { ...persisted, timestamp: persistedResult.data[clientType].timestamp, ttl: persistedResult.data[clientType].ttl || ACTIVITY_CACHE_TTL });
    logger.debug('使用持久化活动缓存', { clientType, code: persisted.code, name: persisted.name, source: persisted.source });
    return persisted;
  }

  try {
    // 获取活动信息
    const result = await execMaaCommand('activity', [clientType], null, null, false, true);
    const output = result.stdout;

    logger.debug('maa activity 原始输出', { output });

    let activityName = null;
    let activityCode = null;

    // 提取活动名称（从「」中提取）
    const nameMatch = output.match(/「([^」]+)」/);
    if (nameMatch && nameMatch[1]) {
      activityName = nameMatch[1];
    }

    // 尝试多种解析方式提取代号
    // 方式1: 匹配 (XX-数字) 格式
    let match = output.match(/\(([A-Z]{2,3})-\d+/i);

    // 方式2: 匹配 XX-数字 格式（不在括号内）
    if (!match) {
      match = output.match(/([A-Z]{2,3})-\d+/i);
    }

    // 方式3: 匹配 SideStory 后面的内容
    if (!match) {
      match = output.match(/SideStory[:\s]+.*?([A-Z]{2,3})-\d+/i);
    }

    // 方式4: 匹配任何 2-3 个大写字母后跟 -数字 的模式
    if (!match) {
      const allMatches = output.match(/\b([A-Z]{2,3})-\d+\b/gi);
      if (allMatches && allMatches.length > 0) {
        // 取第一个匹配
        const firstMatch = allMatches[0];
        match = [firstMatch, firstMatch.split('-')[0]];
      }
    }

    if (match && match[1]) {
      activityCode = match[1].toUpperCase();
      logger.debug('获取到活动信息', { code: activityCode, name: activityName });
      return cacheActivity(clientType, {
        code: activityCode,
        name: activityName,
        source: 'maa',
        startTime: null,
        endTime: null,
        stages: []
      });
    }

    logger.debug('MAA 活动表未返回当前活动，尝试备用数据源');
  } catch (error) {
    logger.warn('获取 MAA 活动信息失败，尝试备用数据源', { error: error.message });
  }

  try {
    const fallbackActivity = await getFallbackActivity(clientType);
    if (fallbackActivity?.code) {
      logger.info('从备用数据源获取到活动信息', fallbackActivity);
      return cacheActivity(clientType, fallbackActivity);
    }
  } catch (error) {
    logger.warn('备用活动数据源不可用', { error: error.message });
  }

  return { code: null, name: null, source: null, startTime: null, endTime: null, stages: [] };
}

/**
 * 替换关卡代号中的 hd 为实际活动代号
 */
export async function replaceActivityCode(stage, clientType = DEFAULT_CLIENT_TYPE) {
  if (!stage || typeof stage !== 'string') {
    return stage;
  }

  // 检查是否是 hd-数字 格式（不区分大小写）
  const hdMatch = stage.match(/^hd-(\d+)$/i);
  if (!hdMatch) {
    return stage;
  }

  const stageNumber = hdMatch[1];
  const activityInfo = await getCurrentActivity(clientType);

  if (activityInfo.code) {
    const realStage = `${activityInfo.code}-${stageNumber}`;
    logger.debug('关卡代号替换', { original: stage, replaced: realStage });
    return realStage;
  }

  logger.warn('无法获取活动代号，保持原关卡代号', { stage });
  return stage;
}
