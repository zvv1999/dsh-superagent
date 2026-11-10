/** Personal WeChat iLink text transport; account/context tokens stay in owner-only files outside domain records. */
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { key } from '../core/index.ts'
import type { ImEvent, ImTransport } from './im.ts'
import { credentials, imJson, ImError, postJson, readPrivateJson, writePrivateJson } from './im-http.ts'
import { pause } from './poll.ts'

export const WECHAT_API = 'https://ilinkai.weixin.qq.com'
const SecretSchema = z.object({ token: z.string().min(1), botId: z.string().optional(), baseUrl: z.string().default(WECHAT_API) })
const StateSchema = z.object({ cursor: z.string().default(''), contexts: z.record(z.string(), z.object({ token: z.string(), at: z.number() })).default({}) })
const MessageSchema = z.object({
  message_id: z.union([z.string().min(1), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)]),
  from_user_id: z.string().min(1).max(512), to_user_id: z.string().optional(),
  message_type: z.number(), message_state: z.number().optional(), group_id: z.string().optional(),
  create_time_ms: z.number().int().nonnegative().max(8640000000000000),
  context_token: z.string().optional(),
  item_list: z.array(z.object({ type: z.number(), text_item: z.object({ text: z.string().max(32000).optional() }).optional(),
    ref_msg: z.object({ svr_id: z.string().optional() }).optional() })).default([]),
})
export function wechatBaseUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new ImError('Invalid WeChat API origin') }
  if (url.protocol !== 'https:' || !/^(?:[a-z0-9-]+\.)?ilinkai\.weixin\.qq\.com$/i.test(url.hostname)
    || url.username || url.password || (url.port && url.port !== '443') || !['', '/'].includes(url.pathname) || url.search || url.hash) throw new ImError('Untrusted WeChat API origin')
  return url.origin
}
export function wechatEvent(input: unknown, account: string): { event: ImEvent; contextToken?: string } | undefined {
  const envelope = z.object({ message_type: z.number(), group_id: z.string().optional() }).safeParse(input)
  if (envelope.success && (envelope.data.message_type !== 1 || envelope.data.group_id)) return
  const parsed = MessageSchema.safeParse(input)
  if (!parsed.success) throw new ImError('WeChat returned an invalid message')
  const message = parsed.data
  // This Source deliberately admits only person-to-bot DMs, not official accounts, WeCom, group messages, or bot echoes.
  if (message.message_type !== 1 || message.from_user_id === account || message.group_id || (message.message_state !== undefined && message.message_state !== 2)) return
  if (message.to_user_id && message.to_user_id !== account) throw new ImError('WeChat message belongs to another bot')
  const text = message.item_list.filter(item => item.type === 1).map(item => item.text_item?.text ?? '').join('\n')
  if (!text.trim()) return
  const replyTo = message.item_list.find(item => item.ref_msg?.svr_id)?.ref_msg?.svr_id
  return { event: { id: String(message.message_id), conversationId: message.from_user_id, senderId: message.from_user_id,
    at: new Date(message.create_time_ms).toISOString(), text, direct: true, mentioned: false, ...(replyTo ? { replyTo } : {}) },
    ...(message.context_token ? { contextToken: message.context_token } : {}) }
}
export const wechatHeaders = (token?: string): Record<string, string> => ({
  AuthorizationType: 'ilink_bot_token', 'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),
  'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': '256', ...(token ? { Authorization: `Bearer ${token}` } : {}),
})
const info = { channel_version: '0.1.0', bot_agent: 'DshSuperagent/0.1.0' }
export const wechatTransport: ImTransport = {
  async connect(config, host) {
    const secret = await credentials(config.credentialsFile, SecretSchema)
    if (secret.botId && secret.botId !== config.accountId) throw new ImError('WeChat credential bot ID does not match accountId')
    const base = wechatBaseUrl(secret.baseUrl)
    const file = join(host.deployment.stateDir, 'im-private', `wechat-${key(config.accountId)}.json`)
    const parsed = StateSchema.safeParse(await readPrivateJson(file, true) ?? {})
    if (!parsed.success) throw new ImError('Invalid private WeChat cursor/context state')
    const state = parsed.data
    const save = () => writePrivateJson(file, state)
    return {
      async listen(receive, ready, signal) {
        let announced = false
        while (!signal.aborted) {
          const data = await imJson(`${base}/ilink/bot/getupdates`, postJson({ get_updates_buf: state.cursor, base_info: info }, wechatHeaders(secret.token)), signal, 40000)
          const page = z.object({ msgs: z.array(z.unknown()).default([]), get_updates_buf: z.string().optional() }).safeParse(data)
          if (!page.success) throw new ImError('WeChat returned an invalid updates page')
          if (!announced) { ready(); announced = true }
          for (const raw of page.data.msgs) {
            if (signal.aborted) return
            const result = wechatEvent(raw, config.accountId)
            if (!result) continue
            if (result.contextToken) {
              state.contexts = { ...state.contexts, [result.event.senderId]: { token: result.contextToken, at: Date.now() } }
              const retained = Object.entries(state.contexts).sort((a, b) => b[1].at - a[1].at).slice(0, 1000)
              state.contexts = Object.fromEntries(retained)
              await save()
            }
            await receive(result.event)
          }
          // Persist the provider cursor only after every accepted message reached durable intake.
          if (page.data.get_updates_buf !== undefined) { state.cursor = page.data.get_updates_buf; await save() }
          if (!page.data.msgs.length) await pause(500, signal)
        }
      },
      async prepare(message, signal) {
        const address = message.channel.address
        if (address.direct !== 'true' || !address.conversationId || address.conversationId !== address.senderId) throw new ImError('WeChat replies require the original direct conversation')
        const context = Object.hasOwn(state.contexts, address.conversationId) ? state.contexts[address.conversationId] : undefined
        if (!context) throw new ImError('WeChat reply context is missing; ask the user to message this bot again')
        const body = { msg: { from_user_id: '', to_user_id: address.conversationId, client_id: `dsh-${message.id}`,
          message_type: 2, message_state: 2, context_token: context.token, item_list: [{ type: 1, text_item: { text: message.text } }] }, base_info: info }
        return async () => {
          const response = await imJson(`${base}/ilink/bot/sendmessage`, postJson(body, wechatHeaders(secret.token)), signal)
          return typeof response.message_id === 'string' ? response.message_id : undefined
        }
      },
    }
  },
}
