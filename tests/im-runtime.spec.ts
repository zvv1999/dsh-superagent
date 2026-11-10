/** Existing Runtime integration: IM admission → Ticket → DSH worker → original conversation. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ImSource, ImConfigSchema, imTriggerId, type ImEvent, type ImPlatform, type ImTransport } from '../src/sources/im.ts'
import { sourceContext } from '../src/sources/host.ts'
import { gitlabKind } from '../src/sources/gitlab.ts'
import { issueTrigger } from '../src/sources/gitlab-trigger.ts'
import { startRuntime, type Host } from './fixtures/host.ts'
import { deferred } from './fixtures/async.ts'
import type { OutboundMessage } from '../src/core/index.ts'

let h: Host
const stops: (() => Promise<void>)[] = []
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { for (const stop of stops.splice(0)) await stop(); await h.stop() })
const message = (id: string, text: string, senderId = 'alice'): ImEvent => ({ id, text, senderId, conversationId: senderId, direct: true, mentioned: false, at: new Date(Date.now() + 1000).toISOString() })
async function install(platform: ImPlatform) {
  const connected = deferred(), sent: OutboundMessage[] = []
  let ingest!: (event: ImEvent) => Promise<void>
  const transport: ImTransport = { connect: async () => ({
    prepare: async message => async () => { sent.push(message); return `reply-${message.id}` },
    listen: async (receive, ready, signal) => { ingest = receive; ready(); connected.resolve(); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })) },
  }) }
  const source = new ImSource(platform, transport)
  h.runtime.sources.register(source.kind)
  const settings = h.runtime.store.settings()
  const config = ImConfigSchema.parse({ accountId: 'bot', credentialsFile: '/not-read/test.json' })
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, [platform]: { enabled: true, config } },
    policy: { ...settings.policy, sources: { ...settings.policy.sources, [platform]: { allowed: [{ id: 'alice' }] } } } })
  source.attach(sourceContext(h.runtime, source.kind))
  const controller = new AbortController(), running = source.run(controller.signal)
  stops.push(async () => { controller.abort(); await running })
  await connected.promise
  return { sent, source, ingest }
}
it.each(['dingtalk', 'wechat'] as const)('%s routes accepted work to a real Runtime worker and returns results exactly once to the originating conversation', async platform => {
  const f = await install(platform)
  await f.ingest(message('1', '/superagent fix #12'))
  await h.runtime.idle()
  const triggerId = imTriggerId(platform, 'bot', '1')
  expect(h.candidates()).toContain(triggerId)
  const accepted = await h.route({ kind: 'accept', trigger_id: triggerId, title: 'Fix #12', worktree_name: 'im-regression', acknowledgement: '收到，处理 #12。' })
  const ticketId = (accepted.ticket as { ticket_id: string }).ticket_id
  await h.runtime.idle()
  const worker = `worker-${ticketId}`
  expect(h.tools.get(worker)?.has('orchestrator_report')).toBe(true)
  expect(f.sent).toHaveLength(1)
  expect(f.sent[0]!.channel.address).toMatchObject({ conversationId: 'alice', accountId: 'bot', direct: 'true' })
  await f.ingest(message('1', '/superagent fix #12'))
  await h.runtime.idle()
  expect(h.runtime.store.tickets.open()).toHaveLength(1)
  expect(f.sent).toHaveLength(1)
  await h.runTool(worker, 'orchestrator_report', { state: 'ready', summary: 'Fixed and tested' })
  const reply = { ticket_id: ticketId, purpose: 'result', text: '修复完成，测试通过。' }
  await h.runTool(h.runtime.masterId, 'orchestrator_reply', reply)
  await h.runTool(h.runtime.masterId, 'orchestrator_reply', reply)
  await h.runtime.idle()
  expect(f.sent).toHaveLength(2)
  expect(f.sent[1]!.channel).toEqual(f.sent[0]!.channel)
  expect(f.sent[1]!.text).toBe(reply.text)
})
it('keeps unlisted senders from explicit work and honors processing pause without losing incoming messages', async () => {
  const f = await install('wechat')
  await f.ingest(message('guest', '/superagent do work', 'guest'))
  await h.runtime.idle()
  expect(h.candidates()).not.toContain(imTriggerId('wechat', 'bot', 'guest'))
  await h.runtime.settings.pause(true, 'panel')
  await f.ingest(message('allowed', '/superagent fix'))
  await h.runtime.idle()
  expect(h.runtime.store.triggers.get(imTriggerId('wechat', 'bot', 'allowed'))).toBeDefined()
  expect(h.candidates()).not.toContain(imTriggerId('wechat', 'bot', 'allowed'))
  expect(f.sent).toHaveLength(0)
  await h.runtime.settings.pause(false, 'panel')
  await h.runtime.idle()
  expect(h.candidates()).toContain(imTriggerId('wechat', 'bot', 'allowed'))
})
it('finds existing GitLab Issue work from IM shorthand and scoped URLs, and attaches the conversation to that Ticket', async () => {
  h.runtime.sources.register(gitlabKind)
  const deployment = h.runtime.deployment
  vi.spyOn(h.runtime.setup, 'deployment', 'get').mockReturnValue({ ...deployment, github: undefined,
    gitlab: { hostname: 'gitlab.example.com', cli: '/glab-agent', login: 'agent', noreply: 'agent@example.com', projectId: 1 } } as typeof deployment)
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, github: { ...settings.sources.github!, enabled: false },
    gitlab: { enabled: true, config: { hostname: 'gitlab.example.com', repository: 'acme/widgets', cli: '/glab-agent' } } },
    policy: { ...settings.policy, sources: { ...settings.policy.sources, gitlab: { allowed: [{ id: 'alice' }] } } } })
  const issue = issueTrigger({ iid: 12, project_id: 1, title: 'Fix regression', description: '/superagent fix', state: 'opened', author: { username: 'alice' },
    web_url: 'https://gitlab.example.com/acme/widgets/-/issues/12', created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
  const { ticket } = await h.acceptedTicket(issue)
  const f = await install('dingtalk')
  for (const [id, reference] of [['short', '#12'], ['url', 'https://gitlab.example.com/acme/widgets/-/issues/12'], ['foreign', 'https://gitlab.example.com/foreign/project/-/issues/12'], ['fragment', 'https://evil.example/issue#12']] as const) {
    await f.ingest(message(id, `/superagent follow ${reference}`))
    await h.runtime.idle()
    const card = h.relays(h.runtime.masterId).find(row => row.trigger_id === imTriggerId('dingtalk', 'bot', id))!
    expect(card, id).toBeDefined()
    if (id === 'short' || id === 'url') expect(card.referenced_tickets).toEqual([expect.objectContaining({ ticket_id: ticket.id })])
    else expect(card.referenced_tickets).toBeUndefined()
  }
  const triggerId = imTriggerId('dingtalk', 'bot', 'url')
  await h.route({ kind: 'attach', trigger_id: triggerId, ticket_id: ticket.id, note: 'Same Issue' })
  await h.runtime.idle()
  expect(h.runtime.store.tickets.get(ticket.id)?.inputs).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'trigger', triggerId })]))
  expect(h.runtime.store.tickets.open()).toHaveLength(1)
  await h.runTool(`worker-${ticket.id}`, 'orchestrator_ack', { trigger_id: triggerId, text: '收到，继续处理这个 Issue。' })
  await h.runTool(`worker-${ticket.id}`, 'orchestrator_report', { state: 'ready', summary: 'The requested Issue update', reply_to_trigger_id: triggerId })
  await h.runTool(h.runtime.masterId, 'orchestrator_reply', { ticket_id: ticket.id, trigger_id: triggerId, purpose: 'answer', text: '该 Issue 已定位，正在修复。' })
  await h.runtime.idle()
  expect(f.sent.at(-1)?.channel.address.conversationId).toBe('alice')
  expect(f.sent.at(-1)?.text).toBe('该 Issue 已定位，正在修复。')
})
