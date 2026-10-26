import { describe, expect, it } from 'vitest'
import { buildDashboardFlowView, type DashboardFlowViewInput } from './flowView'

const base: DashboardFlowViewInput = {
  automationAvailable: true,
  connectionTitle: '正在检查服务',
  connectionDescription: '正在确认自动化服务状态',
  quickStartLoading: false,
  activityPreflightLoading: false,
  deviceBusy: false,
  phase: 'idle',
  runLabel: null,
  runDetail: null,
  currentTask: null,
  scheduleMessage: null,
  observationError: null,
}

const view = (overrides: Partial<DashboardFlowViewInput> = {}) => buildDashboardFlowView({ ...base, ...overrides })

describe('buildDashboardFlowView', () => {
  it('shows the ready state and enables both entries while idle', () => {
    expect(view()).toMatchObject({
      isRunning: false,
      controlsDisabled: false,
      statusLabel: '运行状态',
      commandTitle: '准备就绪',
      commandDescription: '设备待命，可以开始今天的自动化任务',
      primaryActionLabel: '开始今日流程',
      primaryActionStatusKey: 'ready',
      activityActionStatusKey: 'ready',
    })
  })

  it('uses the schedule message as the idle description and leaves the title generic', () => {
    const result = view({ scheduleMessage: '上次执行成功' })
    expect(result.commandTitle).toBe('准备就绪')
    expect(result.commandDescription).toBe('上次执行成功')
  })

  it('projects a running run from the execution snapshot', () => {
    const result = view({ phase: 'running', runLabel: '正在执行: 收取信用', runDetail: '第 2 步' })
    expect(result).toMatchObject({
      isRunning: true,
      statusLabel: '当前任务',
      commandTitle: '正在执行: 收取信用',
      commandDescription: '第 2 步',
      primaryActionLabel: '正在运行',
      primaryActionStatusKey: 'running',
    })
  })

  it('falls back through current task, schedule message and default while running', () => {
    expect(view({ phase: 'running', currentTask: '基建换班' }).commandTitle).toBe('基建换班')
    expect(view({ phase: 'running' }).commandTitle).toBe('流程执行中')
    expect(view({ phase: 'running', scheduleMessage: '计划推进中' }).commandDescription).toBe('计划推进中')
    expect(view({ phase: 'running' }).commandDescription).toBe('自动化任务正在按计划推进')
  })

  it('keeps the waiting state as a running phase with its own copy', () => {
    const result = view({ phase: 'waiting' })
    expect(result).toMatchObject({
      isRunning: true,
      commandTitle: '等待继续',
      commandDescription: '作业集等待下一关，请回到发起页面继续或停止',
      primaryActionLabel: '等待继续',
      primaryActionStatusKey: 'running',
    })
  })

  it('reports unmanaged occupancy and unknown observation separately', () => {
    expect(view({ phase: 'occupied' })).toMatchObject({
      commandTitle: '设备被其他任务占用',
      commandDescription: '设备被未纳管的执行占用，等待结束后再开始',
    })
    expect(view({ phase: 'unknown', observationError: '网络中断' })).toMatchObject({
      commandTitle: '执行状态未知',
      commandDescription: '网络中断',
    })
    expect(view({ phase: 'unknown' }).commandDescription)
      .toBe('暂时无法确认执行状态，恢复连接后会自动刷新')
  })

  it('prioritizes loading feedback over the execution phase', () => {
    const preflight = view({ activityPreflightLoading: true, phase: 'running' })
    expect(preflight).toMatchObject({
      controlsDisabled: true,
      // 原页面先判断“有活动 run”，加载中仍显示当前任务。
      statusLabel: '当前任务',
      commandTitle: '正在检查当前活动',
      commandDescription: '正在确认当前活动与可用作业',
      activityActionStatusKey: 'running',
    })

    const quickStart = view({ quickStartLoading: true, phase: 'waiting' })
    expect(quickStart).toMatchObject({
      controlsDisabled: true,
      statusLabel: '当前任务',
      commandTitle: '正在启动今日流程',
      commandDescription: '正在读取任务配置并提交执行',
      primaryActionStatusKey: 'starting',
    })

    expect(view({ activityPreflightLoading: true }).statusLabel).toBe('当前操作')
    expect(view({ quickStartLoading: true }).statusLabel).toBe('当前操作')
  })

  it('shows the connection copy and disables the entries when automation is unavailable', () => {
    const result = view({
      automationAvailable: false,
      connectionTitle: '当前网络离线',
      connectionDescription: '恢复网络连接后会自动重新检查服务',
      phase: 'running',
    })
    expect(result).toMatchObject({
      isRunning: true,
      controlsDisabled: true,
      commandTitle: '当前网络离线',
      commandDescription: '恢复网络连接后会自动重新检查服务',
    })
  })

  it('disables the entries while the device is busy', () => {
    expect(view({ deviceBusy: true })).toMatchObject({
      controlsDisabled: true,
      commandTitle: '准备就绪',
    })
  })
})
