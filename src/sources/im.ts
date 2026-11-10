/** IM Source plugin: DingTalk and personal WeChat reuse the Engine, Policy, Tickets, and Outbox. Feishu keeps its existing Source. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, threadKey, type OutboundMessage, type Trigger } from '../core/index.ts'
import { family } from '../kv.ts'
import { checkedImText } from '../infra/text.ts'
import type { ContextMessage, SourceKind } from './kind.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import { pause } from './poll.ts'
import { ImError, privateFile } from './im-http.ts'
import { dingtalkTransport } from './im-dingtalk.ts'
import { wechatTransport } from './im-wechat.ts'

export type ImPlatform = 'dingtalk' | 'wechat'
const id = z.string().min(1).max(512)
export const ImConfigSchema = z.object({
  accountId: z.string().max(512).default(''), credentialsFile: privateFile,
  directMessages: z.boolean().default(true),
  chats: z.array(z.object({ chatId: id, name: z.string().max(100).optional(), listen: z.enum(['mentions', 'all']) }).strict())
    .refine(rows => new Set(rows.map(row => row.chatId)).size === rows.length, 'Duplicate chat IDs').default([]),
}).strict()
export type ImConfig = z.infer<typeof ImConfigSchema>
export interface ImEvent {
  id: string; conversationId: string; senderId: string; at: string; text: string
  direct: boolean; mentioned: boolean; replyTo?: string; name?: string
}
export interface ImConnection {
  /** Returns only after disconnect or abort; receive must settle before acknowledging a provider event. */
  listen(receive: (event: ImEvent) => Promise<void>, ready: () => void, signal: AbortSignal): Promise<void>
  /** Preparation can refresh credentials/tokens; commit makes the one external delivery attempt. */
  prepare(message: OutboundMessage, signal: AbortSignal): Promise<() => Promise<string | undefined>>
}
export interface ImTransport {
  connect(config: ImConfig, host: SourceContext, signal: AbortSignal): Promise<ImConnection>
}
const titles = { dingtalk: { zh: '钉钉', en: 'DingTalk' }, wechat: { zh: '个人微信', en: 'Personal WeChat' } }
const active = family<string>('im-active:')
const messages = family<ContextMessage[]>('im-context:')
const anchors = family<{ root: string; conversationId: string }>('im-anchor:')
const receipts = family<'pending' | 'sent'>('im-receipt:')
const started = family<string>('im-started:')
export const imTriggerId = (platform: ImPlatform, account: string, message: string): string => key(platform, account, message)
const sameConfig = (left: ImConfig | undefined, right: ImConfig): boolean => !!left && left.accountId === right.accountId && left.credentialsFile === right.credentialsFile

/** Owns IM-only thread context and transport lifecycle; durable work and replies remain in the existing Engine and Outbox. */
export class ImSource {
  readonly kind: SourceKind<ImConfig>
  private host!: SourceContext
  private connection?: { config: ImConfig; value: ImConnection; signal: AbortSignal }
  constructor(readonly platform: ImPlatform, private readonly transport: ImTransport) {
    this.kind = {
      kind: platform, title: titles[platform], health: [platform], schema: ImConfigSchema,
      description: { zh: platform === 'wechat' ? '通过微信 iLink 接收个人微信私聊文本，沿已有工单处理并回复。' : '通过钉钉 Stream 接收机器人私聊和指定群消息，沿已有工单处理并回复。',
        en: platform === 'wechat' ? 'Personal WeChat text DMs through iLink, routed through existing Tickets.' : 'DingTalk robot text DMs and selected groups through Stream, routed through existing Tickets.' },
      fields: [
        { key: 'accountId', type: 'text', label: { zh: '机器人账号 ID', en: 'Bot account ID' }, hint: { zh: '钉钉填应用 Client ID；个人微信填 iLink bot ID。更换账号不会接管旧会话。', en: 'DingTalk Client ID or WeChat iLink bot ID. Changing accounts cannot take over old conversations.' } },
        { key: 'credentialsFile', type: 'text', label: { zh: '私有凭证文件路径', en: 'Private credentials file' }, hint: { zh: '填绝对路径，不填密钥；文件仅当前用户可读，格式见 docs/im.md。', en: 'Absolute path, never a secret. Owner-only JSON file; see docs/im.md.' } },
        { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Direct messages' } },
        ...(platform === 'dingtalk' ? [{ key: 'chats', type: 'rows' as const, label: { zh: '接收的群', en: 'Groups' },
          hint: { zh: '群名来自本人的钉钉授权，不代表机器人已入群。请先将机器人加入目标群，再选择并保存接收范围。', en: 'Names come from your personal DingTalk connection, not robot membership. Add the robot to the target group before saving its receive scope.' },
          emptyHint: { zh: '暂无可选群。连接上方「本人消息读取」后，点击「获取我所在的群」。', en: 'No group candidates. Connect personal message reading above, then choose Get my groups.' }, columns: [
          { key: 'chatId', type: 'text' as const, label: { zh: '群', en: 'Group' }, choose: { zh: '选择我所在的群', en: 'Choose one of my groups' },
            refresh: { zh: '获取我所在的群', en: 'Get my groups' } },
          { key: 'listen', type: 'select' as const, label: { zh: '接收', en: 'Receive' }, options: [{ value: 'mentions', label: { zh: '仅 @ 或命令', en: 'Mentions or commands' } }, { value: 'all', label: { zh: '收到的全部消息', en: 'All delivered messages' } }] },
        ] }] : []),
      ],
      scope: ({ meta }, config) => {
        if (!config.accountId || meta.accountId !== config.accountId) return { listened: false, reason: 'im_account_changed' }
        if (meta.direct === true) return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
        const chat = platform === 'dingtalk' && config.chats.find(row => row.chatId === meta.conversationId)
        return chat ? { listened: true, observed: chat.listen === 'all', row: chat.chatId } : { listened: false, reason: 'chat_not_allowed' }
      },
      channel: {
        allowed: (address, config) => this.kind.scope!({ meta: { ...address, direct: address.direct === 'true' } }, config).listened,
        send: (_host, message) => this.send(message),
        link: () => ({ url: '', label: titles[platform] }),
      },
      threadContext: {
        messageId: trigger => String(trigger.meta.messageId),
        read: async (_commands, trigger, part, cursor) => {
          const list = this.host.state.get(messages(threadKey(trigger.threads[0]!))) ?? []
          const offset = cursor === undefined ? 0 : Number(cursor)
          if (!Number.isSafeInteger(offset) || offset < 0) throw new ImError('Invalid IM context cursor')
          const selected = part === 'thread' ? list.slice(offset, offset + 20) : list.filter(row => row.id === (part === 'parent' ? trigger.meta.parentId : trigger.meta.rootId))
          return { messages: selected, ...(part === 'thread' && offset + 20 < list.length ? { next: String(offset + 20) } : {}), body: { retained: list.length, limit: 100 } }
        },
      },
      repliesTo: trigger => typeof trigger.meta.parentId === 'string' ? imTriggerId(platform, String(trigger.meta.accountId), trigger.meta.parentId) : undefined,
      policy: {
        schema: z.object({ allowed: z.array(z.object({ id, name: z.string().max(100).optional() }).strict())
          .refine(rows => new Set(rows.map(row => row.id)).size === rows.length, 'Duplicate sender IDs').default([]) }).strict(),
        fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的用户', en: 'Users who may originate work' }, columns: [
          { key: 'id', type: 'text', label: { zh: '用户 ID', en: 'Sender ID' } }, { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
        ] }],
        explicit: { zh: '名单内用户的私聊、@ 或 /superagent 命令可以发起工作；/superagent 开始新请求，其余消息跟进该用户最近的线程。', en: 'Allowed users may request work in a DM, mention or /superagent command. /superagent starts a new request; other messages follow that sender’s latest thread.' },
        rows: config => [{ id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: titles[platform], cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages === true, unlistedUnaddressed: false } },
          ...ImConfigSchema.parse(config).chats.map(chat => ({ id: chat.chatId, label: chat.name ?? chat.chatId, note: titles[platform],
            cells: { listedUnaddressed: chat.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: chat.listen === 'all' } }))],
      },
    }
  }
  attach(host: SourceContext): void { this.host = host }
  /** Await durable intake before a transport acknowledges or advances its cursor. */
  async receive(event: ImEvent, config: ImConfig): Promise<void> {
    const current = this.host.config<ImConfig>(this.platform)
    if (!sameConfig(current, config)) throw new ImError('IM Source configuration changed before intake')
    const triggerId = imTriggerId(this.platform, config.accountId, event.id)
    const previous = this.host.triggers.get(triggerId)
    const since = this.host.state.get(started(key(this.platform, config.accountId)))
    if (!previous && since && event.at < since) return
    const messageKey = key(this.platform, config.accountId, event.id)
    if (previous && this.host.state.get(anchors(messageKey))) return
    const conversationKey = key(this.platform, config.accountId, event.conversationId, event.senderId)
    const parent = event.replyTo ? this.host.state.get(anchors(key(this.platform, config.accountId, event.replyTo))) : undefined
    const root = typeof previous?.meta.rootId === 'string' ? previous.meta.rootId : /^\s*\/superagent(?:\s|$)/i.test(event.text) ? event.id
      : parent?.conversationId === event.conversationId ? parent.root : this.host.state.get(active(conversationKey)) ?? event.id
    const ref = { source: this.platform, id: key(config.accountId, event.conversationId, root) }
    const addressed = event.direct ? 'direct' : event.mentioned || /^\s*\/superagent(?:\s|$)/i.test(event.text) ? 'mention' : undefined
    const meta = { accountId: config.accountId, conversationId: event.conversationId, messageId: event.id, senderId: event.senderId,
      direct: event.direct, rootId: root, ...(event.replyTo ? { parentId: event.replyTo } : {}), ...(event.name ? { senderName: event.name } : {}) }
    const trigger: Trigger = { id: triggerId, source: this.platform, threads: [ref], actor: { source: this.platform, id: event.senderId }, human: true,
      ...(addressed ? { addressed } : {}), at: event.at, text: event.text, meta,
      channel: { source: this.platform, thread: threadKey(ref), address: { accountId: config.accountId, conversationId: event.conversationId, senderId: event.senderId,
        messageId: event.id, rootId: root, direct: String(event.direct) } } }
    const disposition = await this.host.receive(trigger)
    if (disposition === 'filtered' || (disposition === 'duplicate' && !this.host.threads.get(threadKey(ref)))) return
    this.host.atomic(() => {
      const currentRoot = this.host.state.get(active(conversationKey))
      const currentTrigger = currentRoot ? this.host.triggers.get(imTriggerId(this.platform, config.accountId, currentRoot)) : undefined
      if (!previous || !currentTrigger || currentTrigger.at <= previous.at) this.host.state.set(active(conversationKey), root)
      this.host.state.set(anchors(messageKey), { root, conversationId: event.conversationId })
      const context = this.host.state.get(messages(threadKey(ref))) ?? []
      if (!context.some(row => row.id === event.id)) this.host.state.set(messages(threadKey(ref)), [...context, { id: event.id, from: event.senderId,
        at: previous?.at ?? event.at, text: previous?.text ?? event.text, ...(event.replyTo ? { reply_to: event.replyTo } : {}) }].slice(-100))
    })
    this.host.threads.describe(threadKey(ref), { label: `${event.name ?? event.senderId}: ${event.text.slice(0, 80)}` })
  }
  async send(message: OutboundMessage): Promise<'sent' | 'gone'> {
    const config = this.host.config<ImConfig>(this.platform)
    if (!config || !this.kind.channel!.allowed!(message.channel.address, config)) return 'gone'
    const receipt = receipts(key(this.platform, config.accountId, message.id))
    const status = this.host.state.get(receipt)
    if (status === 'sent') return 'sent'
    if (status === 'pending') throw new ImError('IM delivery outcome is unknown; verify the original conversation before explicitly retrying this receipt')
    const connection = this.connection
    if (!connection || !sameConfig(config, connection.config) || connection.signal.aborted) throw new ImError('IM Source is not connected')
    if (!message.text.trim() || Buffer.byteLength(message.text, 'utf8') > 18000) throw new ImError('IM reply must contain 1–18000 UTF-8 bytes')
    checkedImText(message.text)
    const commit = await connection.value.prepare(message, connection.signal)
    // Another outbox attempt may have completed while credentials were refreshed.
    const latest = this.host.state.get(receipt)
    if (latest === 'sent') return 'sent'
    if (latest === 'pending') throw new ImError('IM delivery is pending verification')
    const current = this.host.config<ImConfig>(this.platform)
    if (!sameConfig(current, config) || !this.kind.channel!.allowed!(message.channel.address, current!) || connection.signal.aborted) throw new ImError('IM Source changed before delivery')
    this.host.state.set(receipt, 'pending')
    try {
      const serverId = await commit()
      this.host.atomic(() => {
        this.host.state.set(receipt, 'sent')
        if (serverId) this.host.state.set(anchors(key(this.platform, config.accountId, serverId)), { root: message.channel.address.rootId!, conversationId: message.channel.address.conversationId! })
      })
      return 'sent'
    } catch (error) {
      if (error instanceof ImError && error.rejected) this.host.state.set(receipt, undefined)
      throw error instanceof ImError ? error : new ImError('IM delivery failed; verify the original conversation before retrying')
    }
  }
  async run(signal: AbortSignal): Promise<void> {
    await this.host.ready
    while (!signal.aborted) {
      const config = this.host.config<ImConfig>(this.platform)
      if (!this.host.configured() || !config || !config.accountId || !config.credentialsFile) {
        this.host.report(this.platform, !this.host.configured() ? health('starting', 'setupPending') : !config ? health('paused', 'sourceOff') : { state: 'starting', detail: 'Configure accountId and credentialsFile; see docs/im.md' })
        await pause(1000, signal); continue
      }
      const startKey = started(key(this.platform, config.accountId))
      if (!this.host.state.get(startKey)) this.host.state.set(startKey, new Date().toISOString())
      const controller = new AbortController()
      const connectionSignal = AbortSignal.any([signal, controller.signal])
      const changed = setInterval(() => { if (!sameConfig(this.host.config<ImConfig>(this.platform), config)) controller.abort() }, 500)
      try {
        const connection = await this.transport.connect(config, this.host, connectionSignal)
        this.connection = { config, value: connection, signal: connectionSignal }
        await connection.listen(event => this.receive(event, config), () => this.host.report(this.platform, { state: 'ready', detail: 'Connected; receiving text messages', at: new Date().toISOString() }), connectionSignal)
        if (!connectionSignal.aborted) throw new ImError('IM connection closed; reconnecting')
      } catch (error) {
        if (!connectionSignal.aborted) this.host.report(this.platform, { state: 'error', detail: error instanceof ImError ? error.message : 'IM connection failed; check credentials and network' })
      } finally { controller.abort(); clearInterval(changed); this.connection = undefined }
      await pause(3000, signal)
    }
  }
}
export const name = 'dsh-superagent-im'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  for (const [platform, transport] of [['dingtalk', dingtalkTransport], ['wechat', wechatTransport]] as const) {
    const source = new ImSource(platform, transport)
    ctx.effect(() => ctx.orchestrator.sources.register(source.kind), `${platform}: source kind`)
    ctx.effect(() => {
      const host = sourceContext(ctx.orchestrator, source.kind)
      source.attach(host)
      const controller = new AbortController()
      const running = source.run(controller.signal).catch(() => {
        if (!controller.signal.aborted) host.report(platform, { state: 'error', detail: 'IM Source stopped; check local state and restart this Source' })
      })
      return async () => { controller.abort(); await running }
    })
  }
}
