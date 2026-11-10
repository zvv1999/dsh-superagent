/** DingTalk Stream robot transport and proactive text replies, using the official JSON protocol. */
import { z } from 'zod'
import WebSocket from 'ws'
import type { ImConfig, ImEvent, ImTransport } from './im.ts'
import { credentials, imJson, ImError, postJson } from './im-http.ts'

const API = 'https://api.dingtalk.com/v1.0'
export const DINGTALK_TOPIC = '/v1.0/im/bot/messages/get'
const SecretSchema = z.object({ clientId: z.string().min(1), clientSecret: z.string().min(1), robotCode: z.string().min(1).optional() })
const EventSchema = z.object({
  msgId: z.string().min(1).max(512), conversationId: z.string().min(1).max(512), conversationType: z.enum(['1', '2']),
  senderId: z.string().min(1).max(512), senderStaffId: z.string().max(512).optional(), senderNick: z.string().max(100).optional(),
  chatbotUserId: z.string().optional(), robotCode: z.string().optional(), isInAtList: z.boolean().optional(), isRobot: z.boolean().optional(),
  createAt: z.number().int().nonnegative().max(8640000000000000), msgtype: z.string(), text: z.object({ content: z.string().max(32000) }).optional(),
})
export function dingtalkEvent(input: unknown, accountId: string, robotCode = accountId): ImEvent | undefined {
  const parsed = EventSchema.safeParse(input)
  if (!parsed.success) throw new ImError('DingTalk returned an invalid robot event')
  const event = parsed.data
  if (event.robotCode && event.robotCode !== robotCode) throw new ImError('DingTalk event belongs to another robot')
  if (event.isRobot || event.senderId === event.chatbotUserId || event.senderStaffId === accountId || event.msgtype !== 'text' || !event.text?.content.trim()) return
  const direct = event.conversationType === '1'
  if (direct && !event.senderStaffId) throw new ImError('DingTalk direct message lacks senderStaffId needed for replies')
  return { id: event.msgId, conversationId: event.conversationId, senderId: event.senderStaffId || event.senderId,
    name: event.senderNick, at: new Date(event.createAt).toISOString(), text: event.text.content, direct, mentioned: event.isInAtList === true }
}
const FrameSchema = z.object({ type: z.string(), headers: z.object({ topic: z.string(), messageId: z.string().optional() }).passthrough(), data: z.string().optional() })
type StreamEvent = { type?: string; data?: unknown }
type StreamEventName = 'open' | 'error' | 'close' | 'message'
export interface StreamSocket {
  readonly readyState: number
  addEventListener(type: StreamEventName, listener: (event: StreamEvent) => void): void
  removeEventListener(type: StreamEventName, listener: (event: StreamEvent) => void): void
  on(type: 'pong', listener: () => void): unknown
  off(type: 'pong', listener: () => void): unknown
  ping(): void
  terminate(): void
  send(data: string): void
  close(): void
}
/** Acknowledge callbacks only after receive settles; serialize intake and cap pending frames. */
export async function listenDingtalk(socket: StreamSocket, config: ImConfig, robotCode: string, receive: (event: ImEvent) => Promise<void>, ready: () => void, signal: AbortSignal): Promise<void> {
  let queue = Promise.resolve(); let pending = 0; let stopped = false
  let finish: (error?: ImError) => void = () => {}
  const handlers = new Map<StreamEventName, (event: StreamEvent) => void>()
  const closed = new Promise<void>((resolve, reject) => {
    finish = error => { if (stopped) return; stopped = true; error ? reject(error) : resolve() }
  })
  const listen = (type: StreamEventName, handler: (event: StreamEvent) => void) => { handlers.set(type, handler); socket.addEventListener(type, handler) }
  const send = (value: unknown) => { if (!stopped && socket.readyState === 1) socket.send(JSON.stringify(value)) }
  const stop = () => finish()
  listen('open', () => ready())
  listen('error', () => finish(new ImError('DingTalk Stream connection failed')))
  listen('close', () => finish(signal.aborted ? undefined : new ImError('DingTalk Stream disconnected; reconnecting')))
  listen('message', event => {
    if (stopped) return
    if (typeof event.data !== 'string' || event.data.length > 2 * 1024 * 1024 || ++pending > 64) { finish(new ImError('DingTalk Stream frame or queue limit exceeded')); return }
    queue = queue.then(async () => {
      if (stopped || signal.aborted) return
      const parsed = FrameSchema.safeParse(JSON.parse(event.data as string))
      if (!parsed.success) throw new ImError('DingTalk Stream returned an invalid frame')
      const frame = parsed.data
      if (frame.type === 'SYSTEM') {
        if (frame.headers.topic === 'ping' || frame.headers.topic === 'disconnect') send({ code: 200, headers: frame.headers, message: 'OK', data: frame.data ?? '' })
        if (frame.headers.topic === 'disconnect') finish(new ImError('DingTalk requested reconnection'))
        return
      }
      if (frame.type !== 'CALLBACK' || frame.headers.topic !== DINGTALK_TOPIC || !frame.headers.messageId) return
      const message = dingtalkEvent(JSON.parse(frame.data ?? '{}'), config.accountId, robotCode)
      if (message) await receive(message)
      send({ code: 200, headers: { contentType: 'application/json', messageId: frame.headers.messageId }, message: 'OK', data: JSON.stringify({ response: {} }) })
    }).catch(error => finish(error instanceof ImError ? error : new ImError('DingTalk event intake failed; waiting for redelivery'))).finally(() => { pending -= 1 })
  })
  signal.addEventListener('abort', stop, { once: true })
  // Control-frame pongs prove connectivity even when no application messages arrive.
  let pongTimeout: ReturnType<typeof setTimeout> | undefined
  const pong = () => { clearTimeout(pongTimeout); pongTimeout = undefined }
  socket.on('pong', pong)
  const heartbeat = setInterval(() => {
    if (stopped || socket.readyState !== WebSocket.OPEN || pongTimeout !== undefined) return
    pongTimeout = setTimeout(() => finish(new ImError('DingTalk Stream heartbeat timed out')), 10_000)
    try { socket.ping() } catch { finish(new ImError('DingTalk Stream connection failed')) }
  }, 20_000)
  if (signal.aborted) finish()
  try { await closed }
  finally {
    stopped = true; clearInterval(heartbeat); clearTimeout(pongTimeout); socket.off('pong', pong); signal.removeEventListener('abort', stop)
    for (const [type, handler] of handlers) socket.removeEventListener(type, handler)
    try { socket.terminate() } catch { /* The gateway may already have closed this socket. */ }
    await queue
  }
}
export const dingtalkTransport: ImTransport = {
  async connect(config, _host, signal) {
    const secret = await credentials(config.credentialsFile, SecretSchema)
    if (secret.clientId !== config.accountId) throw new ImError('DingTalk credential Client ID does not match accountId')
    const robotCode = secret.robotCode ?? secret.clientId
    let token: { value: string; expires: number } | undefined
    return {
      async listen(receive, ready, lifetime) {
        const data = await imJson(`${API}/gateway/connections/open`, postJson({ clientId: secret.clientId, clientSecret: secret.clientSecret,
          ua: 'dsh-superagent/0.1.0', subscriptions: [{ type: 'CALLBACK', topic: DINGTALK_TOPIC }] }, { Accept: 'application/json' }), lifetime)
        const result = z.object({ endpoint: z.string(), ticket: z.string().min(1) }).safeParse(data)
        if (!result.success) throw new ImError('DingTalk returned no Stream endpoint')
        const url = new URL(result.data.endpoint)
        if (url.protocol !== 'wss:' || !/^(?:[a-z0-9-]+\.)*dingtalk\.com$/i.test(url.hostname) || url.username || url.password || (url.port && url.port !== '443')) throw new ImError('DingTalk returned an untrusted Stream endpoint')
        url.searchParams.set('ticket', result.data.ticket)
        const socket = new WebSocket(url, { handshakeTimeout: 15_000, maxPayload: 2 * 1024 * 1024,
          followRedirects: false, perMessageDeflate: false })
        // A cancelled handshake can emit its error after the listener has disposed.
        socket.on('error', () => {})
        await listenDingtalk(socket, config, robotCode, receive, ready, lifetime)
      },
      async prepare(message, lifetime) {
        if (!token || token.expires <= Date.now()) {
          const data = await imJson(`${API}/oauth2/accessToken`, postJson({ appKey: secret.clientId, appSecret: secret.clientSecret }), lifetime)
          const parsed = z.object({ accessToken: z.string().min(1), expireIn: z.number().positive() }).safeParse(data)
          if (!parsed.success) throw new ImError('DingTalk returned no access token')
          token = { value: parsed.data.accessToken, expires: Date.now() + Math.max(1, parsed.data.expireIn - 60) * 1000 }
        }
        const target = message.channel.address
        const direct = target.direct === 'true'
        if (!target.conversationId || (direct && !target.senderId)) throw new ImError('DingTalk reply has no original conversation')
        const body = { robotCode, msgKey: 'sampleText', msgParam: JSON.stringify({ content: message.text }),
          ...(direct ? { userIds: [target.senderId] } : { openConversationId: target.conversationId }) }
        const current = token.value
        return async () => {
          try {
            const result = await imJson(`${API}/robot/${direct ? 'oToMessages/batchSend' : 'groupMessages/send'}`, postJson(body, { 'x-acs-dingtalk-access-token': current }), lifetime)
            if (direct && ['invalidUserIdList', 'flowControlledStaffIdList'].some(field => Array.isArray(result[field]) && result[field].includes(target.senderId))) throw new ImError('DingTalk rejected this recipient', true)
            if (typeof result.processQueryKey !== 'string' || !result.processQueryKey) throw new ImError('DingTalk did not confirm delivery; verify the original conversation')
            return undefined
          }
          catch (error) { if (error instanceof ImError && error.rejected) token = undefined; throw error }
        }
      },
    }
  },
}
