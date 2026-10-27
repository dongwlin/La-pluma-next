import assert from 'node:assert/strict'
import http from 'node:http'
import { afterEach, describe, it } from 'node:test'
import {
  getNotificationConfig,
  sendToChannel,
  setNotificationConfig
} from '../notificationService.js'
import { createOutboundHttpClient } from '../outboundRequestService.ts'

// 1x1 透明 PNG，远小于 Telegram 的 10MB 限制
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const TELEGRAM_CONFIG = {
  enabled: true,
  channels: {
    telegram: { enabled: true, botToken: 'fixture-token', chatId: 'fixture-chat' }
  }
}

/** 出站端口经 text() 消费响应体；stub 返回 Telegram JSON，零网络访问、不真实发送通知。 */
function telegramResponse(body) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    text: async () => JSON.stringify(body)
  }
}

let fetchCalls
const originalFetch = globalThis.fetch
const savedConfig = getNotificationConfig()

function stubTelegramFetch(handler) {
  fetchCalls = []
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init })
    return handler(String(url), init)
  }
}

afterEach(() => {
  globalThis.fetch = originalFetch
  setNotificationConfig(savedConfig)
})

describe('Telegram notification outbound send', () => {
  it('posts text notifications as JSON through the outbound port', async () => {
    setNotificationConfig(TELEGRAM_CONFIG)
    stubTelegramFetch(url => {
      assert.match(url, /^https:\/\/api\.telegram\.org\/botfixture-token\/sendMessage$/)
      return telegramResponse({ ok: true, result: { message_id: 11 } })
    })

    const result = await sendToChannel('telegram', { title: '构建完成', content: '任务已结束', level: 'success' })

    // 渠道返回完整 Telegram 载荷（ok/result 包装），与原实现一致
    assert.equal(result.ok, true)
    assert.equal(result.result.message_id, 11)
    assert.equal(fetchCalls.length, 1)
    const { init } = fetchCalls[0]
    assert.equal(init.method, 'POST')
    assert.equal(init.headers['Content-Type'], 'application/json')
    assert.ok(init.signal instanceof AbortSignal)
    const payload = JSON.parse(init.body)
    assert.equal(payload.chat_id, 'fixture-chat')
    assert.equal(payload.parse_mode, 'Markdown')
    assert.ok(payload.text.includes('构建完成'))
    assert.ok(payload.text.includes('任务已结束'))
  })

  it('posts photo notifications as native FormData through the outbound port', async () => {
    setNotificationConfig(TELEGRAM_CONFIG)
    stubTelegramFetch(url => {
      assert.match(url, /^https:\/\/api\.telegram\.org\/botfixture-token\/sendPhoto$/)
      return telegramResponse({ ok: true, result: { message_id: 12 } })
    })

    const result = await sendToChannel('telegram', {
      title: '截图通知',
      content: '包含截图',
      level: 'info',
      image: TINY_PNG_BASE64
    })

    assert.equal(result.ok, true)
    assert.equal(result.result.message_id, 12)
    assert.equal(fetchCalls.length, 1)
    const { init } = fetchCalls[0]
    assert.equal(init.method, 'POST')
    // 端口不强制 Content-Type；multipart boundary 由原生 fetch 运行时补齐
    assert.deepEqual(init.headers, {})
    assert.ok(init.signal instanceof AbortSignal)
    // 原生 FormData 承载字段、文件名与图片字节内容
    assert.ok(init.body instanceof FormData)
    assert.equal(init.body.get('chat_id'), 'fixture-chat')
    assert.equal(init.body.get('parse_mode'), 'Markdown')
    assert.match(init.body.get('caption'), /截图通知/)
    const photo = init.body.get('photo')
    assert.equal(photo.name, 'screenshot.png')
    assert.equal(photo.type, 'image/png')
    assert.deepEqual(Buffer.from(await photo.arrayBuffer()), Buffer.from(TINY_PNG_BASE64, 'base64'))
  })

  it('keeps the upstream failure description in the send error', async () => {
    setNotificationConfig(TELEGRAM_CONFIG)
    stubTelegramFetch(() => telegramResponse({ ok: false, description: 'chat not found' }))

    await assert.rejects(
      sendToChannel('telegram', { title: 'T', content: 'C' }),
      /Telegram 发送失败: chat not found/
    )
    assert.equal(fetchCalls.length, 1)
  })
})

describe('multipart wire format through the outbound port', () => {
  // sendPhoto 与端口 requestMultipart 的组合用原生 fetch 发送；
  // 本用例经真实本地回环服务器验证线上 multipart 内容与文件名，不发外部请求。
  it('serializes native FormData fields, file name and bytes correctly', async () => {
    const received = await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        const chunks = []
        req.on('data', chunk => chunks.push(chunk))
        req.on('end', () => {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true }))
          resolve({ contentType: req.headers['content-type'], body: Buffer.concat(chunks) })
        })
      })
      server.on('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address()
        const formData = new FormData()
        formData.append('chat_id', 'fixture-chat')
        formData.append('photo', new Blob([Buffer.from('png-bytes')], { type: 'image/png' }), 'screenshot.png')
        formData.append('caption', '标题')
        createOutboundHttpClient()
          .requestMultipart(`http://127.0.0.1:${port}/sendPhoto`, { formData, timeoutMs: 5000 })
          .then(() => server.close())
          .catch(error => {
            server.close()
            reject(error)
          })
      })
    })

    assert.match(received.contentType, /^multipart\/form-data; boundary=/)
    const boundary = received.contentType.match(/boundary=(.+)$/)[1]
    const text = received.body.toString('latin1')
    const parts = text.split(`--${boundary}`).filter(part => part.trim() && !part.startsWith('--'))
    assert.equal(parts.length, 3)
    const photoPart = parts.find(part => part.includes('name="photo"'))
    assert.match(photoPart, /filename="screenshot\.png"/)
    assert.match(photoPart, /Content-Type: image\/png/i)
    const photoBytes = photoPart.split('\r\n\r\n').slice(1).join('\r\n\r\n')
    assert.equal(Buffer.from(photoBytes, 'latin1').subarray(0, 9).toString(), 'png-bytes')
    assert.match(parts.find(part => part.includes('name="chat_id"')), /fixture-chat/)
    const captionPart = parts.find(part => part.includes('name="caption"'))
    // 字段值按 UTF-8 编码，经 latin1 结构解析后需还原为 UTF-8 再断言
    const captionText = Buffer.from(captionPart.split('\r\n\r\n')[1] ?? '', 'latin1').toString('utf8')
    assert.equal(captionText, '标题\r\n')
  })
})
