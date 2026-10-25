import { apiFixtures } from '../visual/fixtures'

// Keep the standard page fixture unchanged; only these interaction responses differ.
export const SEARCH_RESULT = {
  success: true,
  data: {
    stage: '1-7',
    copilots: Array.from({ length: 5 }, (_, index) => ({
      id: String(20001 + index),
      uri: `maa://${20001 + index}`,
      title: `性能基线作业 ${index + 1}`,
      views: 100 - index,
      hotScore: 10 - index,
    })),
  },
}

export const INITIAL_LOGS = Array.from({ length: 180 }, (_, index) => ({
  time: '2026-10-24T04:00:00+08:00',
  level: 'INFO',
  message: `基线日志 ${String(index + 1).padStart(3, '0')}：关卡 1-7 任务状态已同步`,
}))

export const APPENDED_LOGS = [
  ...INITIAL_LOGS,
  ...Array.from({ length: 20 }, (_, index) => ({
    time: '2026-10-24T04:00:01+08:00',
    level: 'INFO',
    message: `追加日志 ${String(index + 1).padStart(3, '0')}：关卡 1-7 任务状态已同步`,
  })),
]

export const TRAINING_QUEUE = structuredClone(
  apiFixtures.find(fixture => fixture.path === '/agent/training/queue')!.payload,
) as { success: true; data: { queue: { operatorId: string }[]; revision: string; flowSync: boolean } }
