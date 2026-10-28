import { DEFAULT_CLIENT_TYPE } from '../config/connectionDefaults.js';

// 流程计划与命令构建：只处理任务流程数据，不读取设备连接、用户配置或通知状态。
// 连接默认值由调用方解析后传入，调度入口与确认接口共用同一份构建规则。
const commaSeparatedArrayKeys = new Set(['buy_first', 'blacklist', 'first_tags', 'preserve_tags']);

export function parseDropTargetEntries(value) {
  if (value === undefined || value === null || value === '') return [];

  const rawEntries = typeof value === 'object' && !Array.isArray(value)
    ? Object.entries(value).map(([itemId, count]) => `${itemId}=${count}`)
    : String(value).split(',').map(entry => entry.trim()).filter(Boolean);

  const normalizedEntries = [];
  for (const entry of rawEntries) {
    const match = entry.match(/^([A-Za-z0-9_-]+)\s*=\s*(\d+)$/);
    if (!match || Number(match[2]) <= 0) return null;
    normalizedEntries.push(`${match[1]}=${Number(match[2])}`);
  }
  return normalizedEntries;
}

// 构建 MAA 命令
export function buildScheduledTaskCommand(task, connectionDefaults = {}) {
  if (task.taskType) {
    // MaaCore 内置任务类型
    const params = { ...(task.params || {}) };
    if (task.taskType === 'Recruit') {
      if (params.preserve_tags === undefined && params.skip_robot === true) {
        params.preserve_tags = ['支援机械'];
      }
      if (params.recruitment_time && typeof params.recruitment_time === 'object') {
        params.recruitment_time = Object.fromEntries(
          Object.entries(params.recruitment_time).map(([level, minutes]) => [level, Number(minutes)])
        );
      }
      delete params.skip_robot;
    }
    if (task.taskType === 'Infrast' && Number(params.mode) === 10000 && !String(params.filename || '').trim()) {
      throw new Error('自定义换班需要填写排班文件路径');
    }
    if (task.taskType === 'Infrast' && Number(params.mode) === 10000 && params.plan_index === undefined) {
      params.plan_index = 0;
    }
    const taskConfig = {
      name: task.name,
      type: task.taskType,
      params: {}
    };

    Object.keys(params).forEach(key => {
      const value = params[key];
      if (value === undefined || value === '' || value === null) return;

      if (typeof value === 'boolean') {
        taskConfig.params[key] = value;
      } else if (Array.isArray(value)) {
        if (value.length > 0) {
          taskConfig.params[key] = value;
        }
      } else if (typeof value === 'string' && value.trim().startsWith('[') && value.trim().endsWith(']')) {
        taskConfig.params[key] = value.trim();
      } else if (typeof value === 'string' && (commaSeparatedArrayKeys.has(key) || (value.includes(',') && !value.includes('[')))) {
        taskConfig.params[key] = value.split(',').map(v => v.trim()).filter(v => v);
      } else if (typeof value === 'number') {
        taskConfig.params[key] = value;
      } else if (typeof value === 'string' && !isNaN(Number(value)) && value.trim() !== '') {
        taskConfig.params[key] = Number(value);
      } else if (value) {
        taskConfig.params[key] = value;
      }
    });

    return {
      command: 'run',
      params: task.commandId || task.id,
      taskConfig: JSON.stringify(taskConfig)
    };
  }

  // 预定义命令
  const commandId = task.commandId || task.id.split('-')[0];
  let params = '';
  let extraArgs = [];

  if (commandId === 'startup' || commandId === 'closedown') {
    params = task.params.clientType || DEFAULT_CLIENT_TYPE;
    const address = connectionDefaults.address;
    if (address) {
      extraArgs.push(`-a ${address}`);
    }
    // 添加账号切换参数
    if (commandId === 'startup' && task.params.accountName) {
      extraArgs.push(`--account-name ${task.params.accountName}`);
    }
  } else if (commandId === 'fight') {
    // 支持多个关卡（stages 数组，每个元素是 {stage, times}）或单个关卡（stage 字符串）
    let stages = task.params.stages || [{ stage: task.params.stage || '', times: task.params.times || '' }];

    // 标准化格式：将所有元素转换为 {stage, times} 对象
    stages = stages.map(s => {
      if (typeof s === 'string') {
        // 字符串格式，转换为对象
        return { stage: s, times: '' };
      } else if (typeof s === 'object' && s.stage) {
        // 已经是对象格式
        return s;
      } else {
        // 无效格式，返回空对象
        return { stage: '', times: '' };
      }
    });

    // 构建关卡列表，格式：stage1:times1,stage2:times2
    const stageList = stages
      .filter(s => s.stage && s.stage.trim())
      .map(s => {
        const stage = s.stage.trim();
        const times = s.times ? `:${s.times}` : '';
        return `${stage}${times}`;
      })
      .join(',');

    params = stageList;

    if (task.params.medicine !== undefined && task.params.medicine !== '' && task.params.medicine !== null) {
      params += ` -m ${task.params.medicine}`;
    }
    if (task.params.expiringMedicine !== undefined && task.params.expiringMedicine !== '' && task.params.expiringMedicine !== null) {
      params += ` --expiring-medicine ${task.params.expiringMedicine}`;
    }
    if (task.params.stone !== undefined && task.params.stone !== '' && task.params.stone !== null) {
      params += ` --stone ${task.params.stone}`;
    }
    if (task.params.series !== undefined && task.params.series !== '' && task.params.series !== '1') {
      params += ` --series ${task.params.series}`;
    }
    const dropTargets = parseDropTargetEntries(task.params.drops);
    if (dropTargets === null) {
      throw new Error('掉落目标格式应为物品 ID=数量，多个目标用逗号分隔');
    }
    dropTargets.forEach(target => {
      params += ` -D${target}`;
    });
    if (task.params.clientType) {
      params += ` --client-type ${task.params.clientType}`;
    }
    if (task.params.DrGrandet) {
      params += ' --dr-grandet';
    }
    if (task.params.report_to_penguin) {
      params += ' --report-to-penguin';
      if (String(task.params.penguin_id || '').trim()) {
        params += ` --penguin-id ${String(task.params.penguin_id).trim()}`;
      }
    }
    if (task.params.report_to_yituliu) {
      params += ' --report-to-yituliu';
      if (String(task.params.yituliu_id || '').trim()) {
        params += ` --yituliu-id ${String(task.params.yituliu_id).trim()}`;
      }
    }
  }

  if (extraArgs.length > 0) {
    params = `${extraArgs.join(' ')} ${params}`;
  }

  return { command: commandId, params };
}

export function validateScheduledTaskFlow(taskFlow) {
  if (!Array.isArray(taskFlow)) {
    return { success: false, message: '任务流程格式无效' };
  }

  const invalidTaskIndex = taskFlow.findIndex(task => !task || typeof task !== 'object' || Array.isArray(task));
  if (invalidTaskIndex >= 0) {
    return {
      success: false,
      message: '任务流程中的每一项都必须是对象',
      details: { index: invalidTaskIndex }
    };
  }

  const invalidCustomInfrast = taskFlow.find(task =>
    task.enabled !== false &&
    task.taskType === 'Infrast' &&
    Number(task.params?.mode) === 10000 &&
    !String(task.params?.filename || '').trim()
  );
  if (invalidCustomInfrast) {
    return { success: false, message: '自定义换班需要填写排班文件路径' };
  }

  const invalidFightDrops = taskFlow.find(task => {
    const commandId = task.commandId || String(task.id || '').split('-')[0];
    return task.enabled !== false && commandId === 'fight' && parseDropTargetEntries(task.params?.drops) === null;
  });
  if (invalidFightDrops) {
    return { success: false, message: '掉落目标格式应为物品 ID=数量，多个目标用逗号分隔' };
  }

  return { success: true };
}

export function buildScheduledTaskFlowPlan(taskFlow, connectionDefaults = {}) {
  const validation = validateScheduledTaskFlow(taskFlow);
  if (!validation.success) return validation;

  try {
    const steps = taskFlow
      .filter(task => task.enabled)
      .map((task, index) => {
        const { command, params, taskConfig } = buildScheduledTaskCommand(task, connectionDefaults);
        const args = params ? params.split(' ').filter(Boolean) : [];
        return {
          index: index + 1,
          id: task.id,
          name: task.name || task.commandId || task.id,
          command,
          args,
          dynamicTask: Boolean(taskConfig),
          ...(taskConfig ? { taskConfig: JSON.parse(taskConfig) } : {}),
          ...(command === 'closedown' && task.params?.recognizeDepotBeforeClose === true
            ? { preActions: [{ action: 'depot-recognition' }] }
            : {})
        };
      });

    return { success: true, totalSteps: steps.length, steps };
  } catch (error) {
    return { success: false, message: error.message };
  }
}
