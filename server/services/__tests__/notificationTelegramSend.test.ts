import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createNotificationService } from '../notificationService.ts'
import type { NotificationConfig } from '../notificationService.ts'
import type {
  OutboundHttpClient,
  OutboundJsonResult,
  OutboundMultipartRequestOptions,
  OutboundRequestOptions
} from '../outboundRequestService.ts'
import { loggerManager } from '../../utils/logger.ts'

// 1x1 透明 PNG，远小于 Telegram 的 10MB 限制
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const TELEGRAM_CONFIG: NotificationConfig = {
  enabled: true,
  channels: {
    telegram: { enabled: true, botToken: 'fixture-token', chatId: 'fixture-chat' }
  }
}

// 发送用例会触发通知日志；控制台输出关闭，避免门禁输出被诊断行淹没。
loggerManager.getLogger('Notification').enableConsole = false

type CapturedCall =
  | { kind: 'json'; url: string; options: OutboundRequestOptions }
  | { kind: 'multipart'; url: string; options: OutboundMultipartRequestOptions }

interface FakeOutbound {
  client: OutboundHttpClient
  calls: CapturedCall[]
}

/**
 * 注入式出站发送端口：记录调用并返回固定的 Telegram JSON 载荷。
 * 测试不再改写全局 fetch，也不产生任何外部网络访问。
 */
function createFakeOutbound(handler: (call: CapturedCall) => OutboundJsonResult): FakeOutbound {
  const calls: CapturedCall[] = []
  const client: OutboundHttpClient = {
    requestJson: async (url, options = {}) => {
      const call: CapturedCall = { kind: 'json', url, options }
      calls.push(call)
      return handler(call)
    },
    requestText: async () => {
      throw new Error('notification channels never use the text port')
    },
    requestMultipart: async (url, options) => {
      const call: CapturedCall = { kind: 'multipart', url, options }
      calls.push(call)
      return handler(call)
    }
  }
  return { client, calls }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function telegramResponse(body: Record<string, unknown>): OutboundJsonResult {
  return { status: 200, data: body }
}

describe('Telegram notification outbound send', () => {
  it('posts text notifications as JSON through the injected port', async () => {
    const outbound = createFakeOutbound(() => telegramResponse({ ok: true, result: { message_id: 11 } }))
    const service = createNotificationService({
      config: TELEGRAM_CONFIG,
      outboundHttp: outbound.client
    })

    const result = await service.sendToChannel('telegram', { title: '构建完成', content: '任务已结束', level: 'success' })

    // 渠道返回完整 Telegram 载荷（ok/result 包装），与原实现一致
    if (!isRecord(result)) assert.fail('expected a Telegram result object')
    assert.equal(result.ok, true)
    const messageResult = result.result
    if (!isRecord(messageResult)) assert.fail('expected a Telegram message result')
    assert.equal(messageResult.message_id, 11)

    assert.equal(outbound.calls.length, 1)
    const call = outbound.calls[0]
    if (call.kind !== 'json') assert.fail('expected a JSON send')
    assert.match(call.url, /^https:\/\/api\.telegram\.org\/botfixture-token\/sendMessage$/)
    assert.equal(call.options.method, 'POST')
    assert.equal(call.options.headers, undefined)
    const payload = call.options.body
    if (!isRecord(payload)) assert.fail('expected a JSON body')
    assert.equal(payload.chat_id, 'fixture-chat')
    assert.equal(payload.parse_mode, 'Markdown')
    assert.ok(String(payload.text).includes('构建完成'))
    assert.ok(String(payload.text).includes('任务已结束'))
  })

  it('posts photo notifications as native FormData through the injected port', async () => {
    const outbound = createFakeOutbound(() => telegramResponse({ ok: true, result: { message_id: 12 } }))
    const service = createNotificationService({
      config: TELEGRAM_CONFIG,
      outboundHttp: outbound.client
    })

    const result = await service.sendToChannel('telegram', {
      title: '截图通知',
      content: '包含截图',
      level: 'info',
      image: TINY_PNG_BASE64
    })

    if (!isRecord(result)) assert.fail('expected a Telegram result object')
    assert.equal(result.ok, true)
    const messageResult = result.result
    if (!isRecord(messageResult)) assert.fail('expected a Telegram message result')
    assert.equal(messageResult.message_id, 12)

    assert.equal(outbound.calls.length, 1)
    const call = outbound.calls[0]
    if (call.kind !== 'multipart') assert.fail('expected a multipart send')
    assert.match(call.url, /^https:\/\/api\.telegram\.org\/botfixture-token\/sendPhoto$/)
    // sendPhoto 保持 30 秒显式时限
    assert.equal(call.options.timeoutMs, 30000)
    // 原生 FormData 承载字段、文件名与图片字节内容
    const formData = call.options.formData
    if (!(formData instanceof FormData)) assert.fail('expected native FormData')
    assert.equal(formData.get('chat_id'), 'fixture-chat')
    assert.equal(formData.get('parse_mode'), 'Markdown')
    assert.match(String(formData.get('caption')), /截图通知/)
    const photo = formData.get('photo')
    if (!(photo instanceof File)) assert.fail('expected a photo upload')
    assert.equal(photo.name, 'screenshot.png')
    assert.equal(photo.type, 'image/png')
    assert.deepEqual(Buffer.from(await photo.arrayBuffer()), Buffer.from(TINY_PNG_BASE64, 'base64'))
  })

  it('keeps the upstream failure description in the send error', async () => {
    const outbound = createFakeOutbound(() => telegramResponse({ ok: false, description: 'chat not found' }))
    const service = createNotificationService({
      config: TELEGRAM_CONFIG,
      outboundHttp: outbound.client
    })

    await assert.rejects(
      service.sendToChannel('telegram', { title: 'T', content: 'C' }),
      /Telegram 发送失败: chat not found/
    )
    assert.equal(outbound.calls.length, 1)
  })

  it('reports a failing channel as a dispatch failure without throwing', async () => {
    const outbound = createFakeOutbound(() => telegramResponse({ ok: false, description: 'bad request' }))
    const service = createNotificationService({
      config: TELEGRAM_CONFIG,
      outboundHttp: outbound.client
    })

    const result = await service.sendNotification({ title: '完成', content: '结束' })

    // 通知失败只反映在发送结果里，调用方据此记录；这里不会抛出或伪装成成功。
    assert.equal(result.success, false)
    assert.deepEqual(result.results, [])
    assert.deepEqual(result.errors, [{ channel: 'telegram', error: 'Telegram 发送失败: bad request' }])
    assert.equal(result.message, '部分渠道发送失败: telegram')
    assert.equal(outbound.calls.length, 1)
  })

  it('keeps channel secrets out of dispatch results and logs', async () => {
    const notificationLogger = loggerManager.getLogger('Notification')
    notificationLogger.clear()
    const outbound = createFakeOutbound(() => telegramResponse({ ok: true, result: { message_id: 13 } }))
    const service = createNotificationService({
      config: {
        enabled: true,
        channels: {
          telegram: { enabled: true, botToken: 'fixture-secret-token', chatId: 'fixture-chat' }
        }
      },
      outboundHttp: outbound.client
    })

    const result = await service.sendNotification({ title: '完成', content: '结束' })
    assert.equal(result.success, true)
    // 公开发送结果与日志只保留渠道名与文案，不携带持久配置或凭据。
    const serialized = JSON.stringify({ result, logs: notificationLogger.getAllLogs() })
    assert.ok(!serialized.includes('fixture-secret-token'))
  })
})

