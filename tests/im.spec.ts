import { describe, expect, it, vi } from 'vitest'
import { ImSource, ImConfigSchema, imTriggerId, type ImConfig, type ImEvent, type ImTransport } from '../src/sources/im.ts'
import { dingtalkEvent } from '../src/sources/im-dingtalk.ts'
import { wechatEvent } from '../src/sources/im-wechat.ts'
import { ImError } from '../src/sources/im-http.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { SettingsSchema } from '../src/policy.ts'
import type { SourceContext } from '../src/sources/host.ts'
import type { OutboundMessage, Trigger } from '../src/core/index.ts'
import type { Commands } from '../src/infra/commands.ts'
import { deferred } from './fixtures/async.ts'

const config = ImConfigSchema.parse({ accountId: 'bot', credentialsFile: '/private/bot.json', chats: [{ chatId: 'team', listen: 'mentions' }] })
const message = (id = 'm1', text = '/superagent fix #12', change: Partial<ImEvent> = {}): ImEvent => ({ id, text, senderId: 'alice', conversationId: 'team', direct: false, mentioned: true, at: new Date(Date.now() + 1000).toISOString(), ...change })
function fixture() {
  const state = new Map<string, unknown>(), triggers = new Map<string, Trigger>()
  let current: ImConfig | undefined = config
  const connected = deferred(), sends: OutboundMessage[] = []
  let fail: Error | undefined
  const commit = vi.fn(async (out: OutboundMessage) => { if (fail) throw fail; sends.push(out); return `server-${out.id}` })
  const prepare = vi.fn(async (out: OutboundMessage) => () => commit(out))
  const transport: ImTransport = { connect: async () => ({ prepare, listen: async (_receive, ready, signal) => {
    ready(); connected.resolve(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  } }) }
  const source = new ImSource('dingtalk', transport)
  const receive = vi.fn((trigger: Trigger) => { if (triggers.has(trigger.id)) return 'duplicate'; triggers.set(trigger.id, trigger); return 'stored' })
  const host = { ready: Promise.resolve(), configured: () => true, config: () => current, atomic: <T>(work: () => T) => work(), receive,
    triggers: { get: (id: string) => triggers.get(id) }, threads: { describe: vi.fn(), get: (thread: string) => [...triggers.values()].some(trigger => trigger.threads.some(ref => `${ref.source}:${ref.id}` === thread)) ? { key: thread } : undefined },
    state: { get: (name: string) => state.get(name), set: (name: string, value: unknown) => { value === undefined ? state.delete(name) : state.set(name, value) } }, report: vi.fn(),
  } as unknown as SourceContext
  source.attach(host)
  const controller = new AbortController()
  return { source, host, state, triggers, receive, commit, prepare, sends, controller, connected,
    setConfig: (value?: ImConfig) => { current = value }, fail: (value?: Error) => { fail = value } }
}

describe('IM source contracts', () => {
  it('deduplicates message intake, namespaces accounts, follows one sender and starts a fresh thread for a command', async () => {
    const f = fixture()
    await f.source.receive(message(), config)
    await f.source.receive(message(), config)
    const original = f.triggers.get(imTriggerId('dingtalk', 'bot', 'm1'))!
    await f.source.receive(message('m2', 'also add a test'), config)
    await f.source.receive(message('m3', 'my separate task', { senderId: 'bob' }), config)
    await f.source.receive(message('m4', '/superagent another task'), config)
    const get = (id: string) => f.triggers.get(imTriggerId('dingtalk', 'bot', id))!
    expect(f.triggers.size).toBe(4)
    expect(get('m2').threads).toEqual(original.threads)
    expect(get('m3').threads).not.toEqual(original.threads)
    expect(get('m4').threads).not.toEqual(original.threads)
    await f.source.receive(message(), config)
    await f.source.receive(message('m5', 'follow the newest request'), config)
    expect(get('m5').threads).toEqual(get('m4').threads)
    expect(imTriggerId('wechat', 'bot', 'm1')).not.toBe(original.id)
    expect(imTriggerId('dingtalk', 'other', 'm1')).not.toBe(original.id)
    const context = await f.source.kind.threadContext!.read({} as Commands, original, 'thread', undefined, config)
    expect(context.messages.map(row => row.id)).toEqual(['m1', 'm2'])
  })
  it('restores thread context after intake succeeded but the source metadata transaction failed', async () => {
    const f = fixture()
    const atomic = vi.spyOn(f.host, 'atomic').mockImplementationOnce(() => { throw new Error('disk busy') })
    await expect(f.source.receive(message(), config)).rejects.toThrow('disk busy')
    expect(f.triggers.size).toBe(1)
    await f.source.receive(message(), config)
    await f.source.receive(message('m2', 'follow-up'), config)
    expect(new Set([...f.triggers.values()].map(trigger => trigger.threads[0]!.id)).size).toBe(1)
    expect(atomic).toHaveBeenCalledTimes(3)
  })
  it('does not create thread context when a previously filtered message is redelivered', async () => {
    const f = fixture()
    await f.source.receive(message(), config)
    f.state.clear()
    vi.spyOn(f.host.threads, 'get').mockReturnValue(undefined)
    await f.source.receive(message(), config)
    expect(f.state.size).toBe(0)
  })
  it('routes quoted messages back to their own thread, refusing a quote from another conversation', async () => {
    const f = fixture()
    await f.source.receive(message(), config)
    await f.source.receive(message('m2', '/superagent separate'), config)
    await f.source.receive(message('m3', 'answer', { replyTo: 'm1', senderId: 'bob' }), config)
    await f.source.receive(message('m4', 'foreign quote', { replyTo: 'm1', conversationId: 'elsewhere', senderId: 'bob' }), config)
    const get = (id: string) => f.triggers.get(imTriggerId('dingtalk', 'bot', id))!
    expect(get('m3').threads).toEqual(get('m1').threads)
    expect(get('m4').threads).not.toEqual(get('m1').threads)
    expect(f.source.kind.repliesTo!(get('m3'))).toBe(get('m1').id)
  })
  it('bounds local context, pages it, and does not advance state when intake fails or filters', async () => {
    const f = fixture()
    f.receive.mockImplementationOnce(() => { throw new Error('storage failed') })
    await expect(f.source.receive(message(), config)).rejects.toThrow('storage failed')
    expect(f.state.size).toBe(0)
    for (let n = 1; n <= 105; n++) await f.source.receive(message(`m${n}`, n === 1 ? '/superagent task' : 'follow up'), config)
    const trigger = [...f.triggers.values()].at(-1)!
    const first = await f.source.kind.threadContext!.read({} as Commands, trigger, 'thread', undefined, config)
    expect(first.messages).toHaveLength(20)
    expect(first.messages[0]!.id).toBe('m6')
    expect(first.next).toBe('20')
    expect(first.body.retained).toBe(100)
    await expect(f.source.kind.threadContext!.read({} as Commands, trigger, 'thread', '-1', config)).rejects.toThrow('cursor')
  })
  it('uses the same account and chat scope for inbound and outbound, with an empty allowed list by default', () => {
    const f = fixture()
    const registry = new SourceRegistry(() => SettingsSchema.parse({ sources: { dingtalk: { enabled: true, config } } }))
    registry.register(f.source.kind)
    expect(registry.policyPart('dingtalk')!.allowed).toEqual([])
    const channel = { source: 'dingtalk', address: { accountId: 'bot', conversationId: 'team', direct: 'false' } }
    expect(registry.channelAllowed(channel)).toBe(true)
    expect(registry.channelAllowed({ ...channel, address: { ...channel.address, accountId: 'other' } })).toBe(false)
    expect(registry.channelAllowed({ ...channel, address: { ...channel.address, conversationId: 'unknown' } })).toBe(false)
    expect(f.source.kind.policy!.schema.safeParse({ allowed: [{ id: 'alice' }, { id: 'alice' }] }).success).toBe(false)
    expect(ImConfigSchema.safeParse({ credentialsFile: 'relative.json' }).success).toBe(false)
  })
  it('persists successful delivery receipts, and never silently retries an ambiguous external write', async () => {
    const f = fixture(), running = f.source.run(f.controller.signal)
    await f.connected.promise
    try {
      await f.source.receive(message(), config)
      const trigger = [...f.triggers.values()][0]!
      const reply: OutboundMessage = { id: 'out1', text: 'Done', channel: trigger.channel!, kind: 'reply' }
      expect(await f.source.send(reply)).toBe('sent')
      expect(await f.source.send(reply)).toBe('sent')
      expect(f.sends).toHaveLength(1)
      f.fail(new ImError('network outcome unknown'))
      await expect(f.source.send({ ...reply, id: 'out2' })).rejects.toThrow('unknown')
      f.fail()
      await expect(f.source.send({ ...reply, id: 'out2' })).rejects.toThrow('unknown')
      expect(f.commit).toHaveBeenCalledTimes(2)
      // A provider explicitly rejected this request, so retrying it cannot duplicate a successful delivery.
      f.fail(new ImError('rate limited', true))
      await expect(f.source.send({ ...reply, id: 'out3' })).rejects.toThrow('rate limited')
      f.fail()
      expect(await f.source.send({ ...reply, id: 'out3' })).toBe('sent')
      // Quoting the outbound server ID follows the request that the reply answered.
      await f.source.receive(message('new', '/superagent other'), config)
      await f.source.receive(message('quote', 'follow up', { replyTo: 'server-out1' }), config)
      expect(f.triggers.get(imTriggerId('dingtalk', 'bot', 'quote'))!.threads).toEqual(trigger.threads)
      f.setConfig({ ...config, accountId: 'other' })
      expect(await f.source.send(reply)).toBe('gone')
    } finally { f.controller.abort(); await running }
  })
  it('does not send after the operator disables a conversation during credential refresh', async () => {
    const f = fixture(), running = f.source.run(f.controller.signal)
    await f.connected.promise
    try {
      await f.source.receive(message(), config)
      const trigger = [...f.triggers.values()][0]!
      f.prepare.mockImplementationOnce(async out => { f.setConfig({ ...config, chats: [] }); return () => f.commit(out) })
      await expect(f.source.send({ id: 'out', text: 'done', channel: trigger.channel!, kind: 'reply' })).rejects.toThrow('changed')
      expect(f.commit).not.toHaveBeenCalled()
    } finally { f.controller.abort(); await running }
  })
  it('stops connections when disabled and ignores pre-activation history', async () => {
    const f = fixture(), running = f.source.run(f.controller.signal)
    await f.connected.promise
    try {
      await f.source.receive(message('old', 'old request', { at: '2000-01-01T00:00:00.000Z' }), config)
      expect(f.triggers.size).toBe(0)
      f.setConfig(undefined)
      await expect(f.source.receive(message(), config)).rejects.toThrow('changed')
    } finally { f.controller.abort(); await running }
  })
})

const ding = { msgId: 'id', conversationId: 'team', conversationType: '2', senderId: 'opaque', senderStaffId: 'alice', senderNick: 'Alice',
  chatbotUserId: 'robot', robotCode: 'bot', isInAtList: true, createAt: 1794096000000, msgtype: 'text', text: { content: 'fix #12' }, sessionWebhook: 'SECRET' }
const wx = { message_id: '18446744073709551615', from_user_id: 'alice', to_user_id: 'bot', create_time_ms: 1794096000000,
  message_type: 1, message_state: 2, item_list: [{ type: 1, text_item: { text: 'fix #12' } }], context_token: 'SECRET' }
it('normalizes platform identities and text without passing credentials or callback URLs into Triggers', () => {
  const event = dingtalkEvent(ding, 'bot')!
  expect(event).toMatchObject({ senderId: 'alice', direct: false, mentioned: true, text: 'fix #12' })
  expect(JSON.stringify(event)).not.toContain('SECRET')
  const wechat = wechatEvent(wx, 'bot')!
  expect(wechat.event).toMatchObject({ id: wx.message_id, direct: true, senderId: 'alice' })
  expect(JSON.stringify(wechat.event)).not.toContain('SECRET')
  expect(wechat.contextToken).toBe('SECRET')
})
it('ignores bot echoes, unsupported media and WeChat groups, and rejects a mismatched recipient', () => {
  expect(dingtalkEvent({ ...ding, senderId: 'robot' }, 'bot')).toBeUndefined()
  expect(dingtalkEvent({ ...ding, isRobot: true }, 'bot')).toBeUndefined()
  expect(dingtalkEvent({ ...ding, msgtype: 'picture' }, 'bot')).toBeUndefined()
  expect(() => dingtalkEvent({ ...ding, robotCode: 'foreign' }, 'bot')).toThrow('another robot')
  expect(wechatEvent({ ...wx, message_type: 2 }, 'bot')).toBeUndefined()
  expect(wechatEvent({ ...wx, group_id: 'group' }, 'bot')).toBeUndefined()
  expect(wechatEvent({ ...wx, item_list: [{ type: 2 }] }, 'bot')).toBeUndefined()
  expect(() => wechatEvent({ ...wx, to_user_id: 'other' }, 'bot')).toThrow('another bot')
})
