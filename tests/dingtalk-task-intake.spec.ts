import { afterEach, beforeEach, expect, it, vi, type MockInstance } from 'vitest'
import type { DingTalkUser } from '../src/app/dingtalk-user.ts'
import { settingsPolicy } from '../src/policy.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host
const chatId = 'cid_alarm'
const message = (messageId: string) => ({ messageId, conversationId: chatId, senderId: 'alarm-robot', sender: 'Alarm bot',
  text: 'A previously working request now fails. Investigate this regression, verify the existing behavior and report evidence silently.',
  createTime: '2026-11-11 00:00:00' })
const page = (...ids: string[]) => ({ items: ids.map(message), pagination_known: true, has_more: false, next_resource: null })
let read: MockInstance<DingTalkUser['read']>
beforeEach(async () => {
  h = await startRuntime()
  vi.spyOn(h.runtime.dingtalkUser, 'current').mockResolvedValue({ status: 'connected', configured: true,
    cli: { installed: true, version: '1.0.67' }, user: { id: 'owner', corpId: 'corp', name: 'Owner' } })
  vi.spyOn(h.runtime.dingtalkUser, 'owns').mockImplementation(account => account.id === 'owner' && account.corpId === 'corp')
  vi.spyOn(h.runtime.dingtalkUser, 'readKey').mockResolvedValue('current-grant')
  read = vi.spyOn(h.runtime.dingtalkUser, 'read').mockResolvedValue(page('baseline'))
  const policy = h.runtime.store.settings().policy
  await h.runtime.settings.save('policy', { ...policy, rules: [{ id: 'alerts', name: 'Diagnose regressions', enabled: true,
    instruction: 'Silently investigate reported regressions in this selected project; reproduce and report evidence without chat replies.' }] },
  h.runtime.store.blockRevision('policy'), 'panel')
})
afterEach(async () => { await h.stop() })

async function subscribe(mode: 'context' | 'tasks' = 'tasks') {
  const created = await h.api('POST', 'connections/dingtalk-user/subscriptions', { chatId, name: 'Selected alarm group' })
  expect(created.status).toBe(200)
  const id = String(created.body.id)
  if (mode === 'tasks') expect(await h.api('POST', `connections/dingtalk-user/subscriptions/${id}/mode`, { mode })).toMatchObject({ status: 200 })
  return id
}
const decide = (triggerId: string, matched = true) => h.runTool(h.runtime.masterId, 'orchestrator_eval_decide', {
  trigger_id: triggerId, decision: matched ? 'accept' : 'ignore', title: 'Diagnose reported regression', worktree_name: 'diagnose-alert',
  scope: 'Read evidence and reproduce the existing behavior', reason: matched ? 'Selected project regression' : 'Outside the enabled rule',
  intent_evidence: 'Owner-configured rule delegates diagnosis of reported regressions; the message reports a previously working request failing.',
  rule_assessments: [{ rule_id: 'alerts', matched, reason: matched ? 'Reported regression within the selected rule' : 'Unrelated notification' }],
  direction: { implementation_requested: matched, target_basis: 'existing-standard', requires_design_decision: false,
    evidence: 'Restore the previously working behavior; do not invent a new product behavior.' },
})
async function latest(id: string) {
  read.mockResolvedValue(page('alarm', 'baseline'))
  const result = await h.api('POST', `connections/dingtalk-user/subscriptions/${id}/assess-latest`, {})
  expect(result).toMatchObject({ status: 200, body: { result: 'stored' } })
  await h.runtime.idle()
  return String(result.body.triggerId)
}
const outboxCount = () => h.runtime.store.db.prepare('SELECT COUNT(*) AS n FROM outbox').get()?.n

it('keeps ordinary personal subscriptions as context without creating Triggers or waking Router', async () => {
  await subscribe('context')
  h.deliveries.mockClear()
  read.mockResolvedValue(page('alarm', 'baseline'))
  await h.runtime.dingtalkSubscriptions.check()
  await h.runtime.idle()
  expect(h.candidates()).toEqual([])
  expect(h.runtime.store.tickets.list()).toEqual([])
  expect(h.runtime.store.db.prepare('SELECT COUNT(*) AS n FROM trigger').get()?.n).toBe(0)
  expect(h.deliveries.mock.calls.some(([input]) => input.mode === 'steer')).toBe(false)
  expect(outboxCount()).toBe(0)
})

it('wakes Router for an observed robot alert and records would-accept without starting a worker in observe mode', async () => {
  await h.runtime.settings.save('eval', { ...h.runtime.store.settings().eval, mode: 'observe' }, h.runtime.store.blockRevision('eval'), 'panel')
  const id = await subscribe(), triggerId = await latest(id)
  expect(h.candidates()).toContain(triggerId)
  expect(h.runtime.store.triggers.get(triggerId)).toMatchObject({ human: false, actor: { source: 'dingtalk-user', id: '' } })
  const context = await h.runTool(h.runtime.masterId, 'orchestrator_eval', { trigger_id: triggerId })
  expect(context).toMatchObject({ strength: 'inferred', thread: { complete: true, loaded_messages: 1 } })
  expect(await decide(triggerId)).toMatchObject({ decision: 'ignore', reason: expect.stringContaining('Observe mode') })
  expect(h.runtime.store.tickets.list()).toEqual([])
  expect(outboxCount()).toBe(0)
})

it('creates one inferred Ticket and worker from a matched auto-mode alert, with no chat reply or personal browsing tools', async () => {
  const id = await subscribe(), triggerId = await latest(id)
  await expect(h.route({ kind: 'accept', trigger_id: triggerId, title: 'Bypass', worktree_name: 'bypass-policy', acknowledgement: 'Bypass' }))
    .rejects.toThrow('explicit requests from allowed senders')
  await h.runTool(h.runtime.masterId, 'orchestrator_eval', { trigger_id: triggerId })
  const result = await decide(triggerId)
  expect(result).toMatchObject({ decision: 'accept' })
  await h.runtime.idle()
  const ticketId = String((result.ticket as { ticket_id: string }).ticket_id), ticket = h.runtime.store.tickets.get(ticketId)!
  expect(ticket.mandate).toMatchObject({ strength: 'inferred', actor: { source: 'dingtalk-user', id: '' },
    basis: { via: 'admission', rules: ['alerts'] } })
  expect(h.agents.has(`worker-${ticketId}`)).toBe(true)
  expect(outboxCount()).toBe(0)
  expect(await h.api('POST', `connections/dingtalk-user/subscriptions/${id}/assess-latest`, {}))
    .toMatchObject({ status: 200, body: { result: 'duplicate', triggerId } })
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
  await expect(h.runTool(`worker-${ticketId}`, 'orchestrator_read', { resource: 'dingtalk-user/chats' })).rejects.toThrow('main Session')
  expect(settingsPolicy(h.runtime.store.settings(), h.runtime.sources).revalidate(ticket.mandate)).toBe(true)
  await h.api('POST', `connections/dingtalk-user/subscriptions/${id}/mode`, { mode: 'context' })
  expect(settingsPolicy(h.runtime.store.settings(), h.runtime.sources).revalidate(ticket.mandate)).toBe(false)
  expect(h.runtime.store.tickets.get(ticketId)?.inputs).toContainEqual(expect.objectContaining({ kind: 'policy-changed', effect: expect.objectContaining({ requesterAllowed: false }) }))
})

it('records but never dispatches a task observation when global processing is off', async () => {
  await h.runtime.settings.save('eval', { ...h.runtime.store.settings().eval, mode: 'off' }, h.runtime.store.blockRevision('eval'), 'panel')
  const triggerId = await latest(await subscribe())
  expect(h.runtime.store.triggers.get(triggerId)).toBeDefined()
  expect(h.candidates()).not.toContain(triggerId)
  expect(h.runtime.store.tickets.list()).toEqual([])
  expect(outboxCount()).toBe(0)
})

it('carries a polled robot alert through blocked diagnosis, an owner retry and a visible completed report without chat delivery', async () => {
  const id = await subscribe()
  read.mockResolvedValue(page('alarm', 'baseline'))
  expect(await h.api('POST', `connections/dingtalk-user/subscriptions/${id}/check`, {})).toMatchObject({ status: 200 })
  await h.runtime.idle()
  expect(h.candidates()).toHaveLength(1)
  const triggerId = String(h.candidates()[0])
  await h.runTool(h.runtime.masterId, 'orchestrator_eval', { trigger_id: triggerId })
  const result = await decide(triggerId)
  await h.runtime.idle()
  const ticketId = String((result.ticket as { ticket_id: string }).ticket_id), worker = `worker-${ticketId}`
  const blocker = 'Issue details returned HTTP 401.\n\nThe message reached the worker; raw Trace is unavailable and the defect is unverified.'
  await h.runTool(worker, 'orchestrator_report', { state: 'blocked', summary: blocker })
  await h.runtime.idle()
  expect(await h.api('GET', `tickets/${ticketId}`)).toMatchObject({ status: 200, body: {
    state: 'open', stage: 'person', action: 'blocked', actions: { retry: true }, summary: blocker,
    assignments: [{ report: { state: 'blocked', summary: blocker } }],
  } })
  expect(await h.api('POST', `tickets/${ticketId}/retry`)).toMatchObject({ status: 200 })
  await h.runtime.idle()
  const conclusion = 'Diagnosis complete with the supplied test evidence.\n\nThis verifies the harness lifecycle, not production recovery.'
  await h.runTool(worker, 'orchestrator_report', { state: 'ready', summary: conclusion })
  await h.runtime.idle()
  expect(await h.api('GET', `tickets/${ticketId}`)).toMatchObject({ status: 200, body: {
    state: 'ended', ended: { outcome: 'completed' }, summary: conclusion,
    assignments: [{ report: { state: 'blocked', summary: blocker } }, { report: { state: 'ready', summary: conclusion } }],
  } })
  expect(await h.api('POST', `connections/dingtalk-user/subscriptions/${id}/assess-latest`, {}))
    .toMatchObject({ status: 200, body: { result: 'duplicate', triggerId } })
  expect((await h.runtime.dingtalkSubscriptions.list())[0]).toMatchObject({ received: 1, triggered: 1, lastTriggerId: triggerId })
  expect(h.runtime.store.tickets.list()).toHaveLength(1)
  expect(outboxCount()).toBe(0)
})

it('does not dispatch alerts outside the enabled rule, or ingest while the task Source is disabled', async () => {
  const id = await subscribe(), triggerId = await latest(id)
  await h.runTool(h.runtime.masterId, 'orchestrator_eval', { trigger_id: triggerId })
  expect(await decide(triggerId, false)).toMatchObject({ decision: 'ignore' })
  expect(h.runtime.store.tickets.list()).toEqual([])
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, 'dingtalk-user': { enabled: false, config: {} } } })
  read.mockResolvedValue(page('another-alarm', 'alarm', 'baseline'))
  expect(await h.api('POST', `connections/dingtalk-user/subscriptions/${id}/assess-latest`, {}))
    .toMatchObject({ status: 400, body: { connectionError: 'task_intake_rejected' } })
  expect(h.runtime.store.tickets.list()).toEqual([])
  expect(outboxCount()).toBe(0)
})
