import { describe, expect, it } from 'vitest'
import { detectStatusMessageType, getStatusVisualConfig } from './statusMessage'

describe('detectStatusMessageType', () => {
  it('does not classify an existing schedule time as success', () => {
    expect(detectStatusMessageType('该执行时间已经存在')).toBe('error')
  })

  it('treats stopped and disabled states as warnings', () => {
    expect(detectStatusMessageType('服务已停止')).toBe('warning')
    expect(detectStatusMessageType('自动更新已禁用')).toBe('warning')
  })

  it('keeps explicit completion phrases successful', () => {
    expect(detectStatusMessageType('任务流程执行完成')).toBe('success')
    expect(detectStatusMessageType('配置已保存')).toBe('success')
  })
})

describe('getStatusVisualConfig', () => {
  it('gives each severity its own dot treatment', () => {
    const severities = ['success', 'error', 'warning', 'info'] as const
    const dotColors = severities.map(type => getStatusVisualConfig(type).dotColor)

    expect(new Set(dotColors).size).toBe(severities.length)
    expect(getStatusVisualConfig('default').dotColor).not.toBe(getStatusVisualConfig('info').dotColor)
  })
})
