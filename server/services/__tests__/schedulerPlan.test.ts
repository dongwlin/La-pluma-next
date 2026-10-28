import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { buildScheduledTaskFlowPlan, validateScheduledTaskFlow } from '../schedulerService.ts'
import type { ScheduledTaskFlowPlanResult } from '../scheduleFlowPlan.ts'

function plannedResult(result: ScheduledTaskFlowPlanResult) {
  if (!result.success) throw new Error(result.message)
  return result
}

function failureMessage(result: ScheduledTaskFlowPlanResult): string {
  if (result.success) throw new Error('expected a rejected plan')
  return result.message
}

describe('scheduled task flow planning', () => {
  it('uses the same dynamic task config as execution for MaaCore task types', () => {
    const result = buildScheduledTaskFlowPlan([{
      id: 'recruit-1',
      commandId: 'recruit',
      name: '自动公招',
      enabled: true,
      taskType: 'Recruit',
      params: {
        refresh: true,
        times: '4',
        recruitment_time: { 3: '540', 4: 540 }
      }
    }])

    assert.deepEqual(plannedResult(result).steps[0], {
      index: 1,
      id: 'recruit-1',
      name: '自动公招',
      command: 'run',
      args: ['recruit'],
      dynamicTask: true,
      taskConfig: {
        name: '自动公招',
        type: 'Recruit',
        params: {
          refresh: true,
          times: 4,
          recruitment_time: { 3: 540, 4: 540 }
        }
      }
    })
  })

  it('includes every advanced fight argument in the confirmation plan', () => {
    const result = buildScheduledTaskFlowPlan([{
      id: 'fight-1',
      commandId: 'fight',
      name: '理智作战',
      enabled: true,
      params: {
        stages: [{ stage: '1-7', times: 3 }, { stage: 'CE-6', times: '' }],
        medicine: 2,
        expiringMedicine: 1,
        stone: 0,
        series: 2,
        drops: '30011=10,30062=5',
        clientType: 'Bilibili',
        DrGrandet: true,
        report_to_penguin: true,
        penguin_id: 'penguin-user',
        report_to_yituliu: true,
        yituliu_id: 'yituliu-user'
      }
    }])

    assert.deepEqual(plannedResult(result).steps[0].args, [
      '1-7:3,CE-6', '-m', '2', '--expiring-medicine', '1', '--stone', '0', '--series', '2',
      '-D30011=10', '-D30062=5', '--client-type', 'Bilibili', '--dr-grandet',
      '--report-to-penguin', '--penguin-id', 'penguin-user',
      '--report-to-yituliu', '--yituliu-id', 'yituliu-user'
    ])
  })

  it('includes the resolved connection and visible pre-actions', () => {
    const result = buildScheduledTaskFlowPlan([{
      id: 'startup-1',
      commandId: 'startup',
      name: '启动游戏',
      enabled: true,
      params: { clientType: 'Official', accountName: '4567' }
    }, {
      id: 'closedown-1',
      commandId: 'closedown',
      name: '关闭游戏',
      enabled: true,
      params: { clientType: 'Official', recognizeDepotBeforeClose: true }
    }], { address: '127.0.0.1:16384' })

    const { steps } = plannedResult(result)
    assert.deepEqual(steps[0].args, ['-a', '127.0.0.1:16384', '--account-name', '4567', 'Official'])
    assert.deepEqual(steps[1].preActions, [{ action: 'depot-recognition' }])
  })

  it('runs the scheduler validation during dry-run planning', () => {
    const invalidInfrast = [{
      id: 'infrast-1',
      enabled: true,
      taskType: 'Infrast',
      params: { mode: 10000, filename: '' }
    }]
    const invalidDrops = [{
      id: 'fight-1',
      commandId: 'fight',
      enabled: true,
      params: { stage: '1-7', drops: 'invalid-target' }
    }]

    assert.equal(validateScheduledTaskFlow(invalidInfrast).success, false)
    assert.match(failureMessage(buildScheduledTaskFlowPlan(invalidInfrast)), /排班文件/)
    assert.match(failureMessage(buildScheduledTaskFlowPlan(invalidDrops)), /掉落目标格式/)
  })

  it('rejects malformed task entries without throwing', () => {
    assert.deepEqual(validateScheduledTaskFlow([null]), {
      success: false,
      message: '任务流程中的每一项都必须是对象',
      details: { index: 0 }
    })
    assert.equal(buildScheduledTaskFlowPlan([[]]).success, false)
  })
})
