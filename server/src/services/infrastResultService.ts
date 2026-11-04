import {
  getCallbackStringField,
  getStartedTaskNames,
  parseMaaCallbackEvents
} from './maaCallbackService.ts';

export type FacilityKey = 'Mfg' | 'Trade' | 'Power' | 'Control' | 'Reception' | 'Office' | 'Dorm' | 'Processing' | 'Training';

export interface InfrastTaskParams {
  facility?: unknown;
  [extension: string]: unknown;
}

/**
 * 基建结果：设施列表总会返回；布尔与计数只在观察到回调事件时提供，未选择设施或旧日志
 * 回退时保持既有响应形状（不补字段）。
 */
export interface InfrastExecutionAction {
  task: string;
  action: 'infrast';
  status: 'success' | 'failed' | 'skipped';
  message: string;
  configuredFacilities: string[];
  observedFacilities: FacilityKey[];
  rewardCollected?: boolean;
  rotationApplied?: boolean;
  droneUsed?: boolean;
  cluesReceived?: number;
  cluesSent?: number;
  clueExchange?: boolean;
  trainingContinued?: boolean;
  trainingCompleted?: boolean;
  trainingProcessing?: boolean;
}

const FACILITY_LABELS: Record<FacilityKey, string> = {
  Mfg: '制造站',
  Trade: '贸易站',
  Power: '发电站',
  Control: '控制中枢',
  Reception: '会客室',
  Office: '办公室',
  Dorm: '宿舍',
  Processing: '加工站',
  Training: '训练室'
};

const FACILITY_CLASSES: Record<string, FacilityKey> = {
  InfrastMfgTask: 'Mfg',
  InfrastTradeTask: 'Trade',
  InfrastPowerTask: 'Power',
  InfrastControlTask: 'Control',
  InfrastReceptionTask: 'Reception',
  InfrastOfficeTask: 'Office',
  InfrastDormTask: 'Dorm',
  InfrastProcessingTask: 'Processing',
  InfrastTrainingTask: 'Training'
};

function uniqueStrings(values: readonly unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value !== ''))];
}

function uniqueFacilityKeys(values: readonly FacilityKey[]): FacilityKey[] {
  return [...new Set(values)];
}

export function parseInfrastExecutionAction(
  taskName: string,
  params: InfrastTaskParams = {},
  logOutput: string | null | undefined = ''
): InfrastExecutionAction {
  const configuredFacilities = Array.isArray(params.facility)
    ? uniqueStrings(params.facility.map(String))
    : [];
  const events = parseMaaCallbackEvents(logOutput, 'Infrast');

  if (configuredFacilities.length === 0) {
    return {
      task: taskName,
      action: 'infrast',
      status: 'skipped',
      configuredFacilities: [],
      observedFacilities: [],
      message: '未选择任何基建设施，已跳过'
    };
  }

  if (events.length === 0) {
    return {
      task: taskName,
      action: 'infrast',
      status: 'success',
      configuredFacilities,
      observedFacilities: [],
      message: `基建流程已完成，按配置处理 ${configuredFacilities.length} 类设施`
    };
  }

  const startEvents = events.filter(event => event.callback === 'SubTaskStart');
  const taskNames = getStartedTaskNames(events);
  const observedFacilities: FacilityKey[] = [];
  for (const event of startEvents) {
    const className = getCallbackStringField(event, 'class') || '';
    const matchedClass = Object.keys(FACILITY_CLASSES).find(name => className.includes(name));
    if (matchedClass) observedFacilities.push(FACILITY_CLASSES[matchedClass]);
  }
  const failed = events.some(event => event.callback === 'TaskChainError');
  const entered = taskNames.includes('InfrastEnteredFlag')
    || taskNames.includes('InfrastNotification')
    || observedFacilities.length > 0;
  const rewardCollected = taskNames.includes('InfrastReward');
  const rotationApplied = taskNames.some(task => [
    'InfrastRotationClick',
    'InfrastConfirmButton',
    'InfrastDormConfirmButton'
  ].includes(task));
  const droneUsed = taskNames.includes('DroneConfirm');
  const cluesReceived = taskNames.filter(task => [
    'GetSelfClue',
    'GetFriendClue',
    'InfrastReceptionMessageBoard-Received'
  ].includes(task)).length;
  const cluesSent = taskNames.filter(task => /^ClueGiveTo\d+(?:st|nd|rd|th)Confirm$/.test(task)).length;
  const clueExchange = taskNames.some(task => [
    'InfrastClueQuickInsertConfirm',
    'UnlockClues',
    'EndOfClueExchange'
  ].includes(task));
  const trainingContinued = taskNames.some(task => /^InfrastTrainingContinue\d+$/.test(task));
  const trainingCompleted = taskNames.includes('InfrastTrainingCompleted');
  const trainingProcessing = taskNames.includes('InfrastTrainingProcessing');
  const baseAction: Omit<InfrastExecutionAction, 'status' | 'message'> = {
    task: taskName,
    action: 'infrast',
    configuredFacilities,
    observedFacilities: uniqueFacilityKeys(observedFacilities),
    rewardCollected,
    rotationApplied,
    droneUsed,
    cluesReceived,
    cluesSent,
    clueExchange,
    trainingContinued,
    trainingCompleted,
    trainingProcessing
  };

  if (failed) {
    return {
      ...baseAction,
      status: 'failed',
      message: entered ? '基建处理过程中失败' : '未能进入或识别基建界面'
    };
  }

  const details: string[] = [];
  if (rewardCollected) details.push('已收取产物');
  if (rotationApplied) details.push('已执行换班');
  if (droneUsed) details.push('已使用无人机');
  if (cluesReceived > 0) details.push(`收取 ${cluesReceived} 次线索`);
  if (cluesSent > 0) details.push(`赠送 ${cluesSent} 次线索`);
  if (clueExchange) details.push('已处理线索交流');
  if (trainingContinued) details.push('已继续专精训练');
  else if (trainingCompleted) details.push('专精训练已完成');
  else if (trainingProcessing) details.push('专精训练进行中');
  if (baseAction.observedFacilities.length > 0) {
    details.push(`已处理：${baseAction.observedFacilities.map(facility => FACILITY_LABELS[facility] || facility).join('、')}`);
  }

  return {
    ...baseAction,
    status: 'success',
    message: details.length > 0
      ? `基建流程完成：${details.join('；')}`
      : `基建流程已完成，按配置处理 ${configuredFacilities.length} 类设施`
  };
}
