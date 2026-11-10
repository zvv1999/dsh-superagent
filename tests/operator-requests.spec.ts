import { afterEach, beforeEach, expect, it } from 'vitest'
import { OPERATOR_ID, OPERATOR_SOURCE, OperatorRequests } from '../src/sources/operator.ts'
import { allowedSender, settingsPolicy, SettingsSchema } from '../src/policy.ts'
import { startRuntime, type Host } from './fixtures/host.ts'

let h: Host
beforeEach(async () => { h = await startRuntime() })
afterEach(async () => { await h.stop() })
const request = { id: 'owner-investigation-1', text: 'Investigate the reported scheduling defect; return evidence only, no commits or external messages.' }

it('routes an explicit local request to a tracked worker without borrowing personal-message identity or sending replies', async () => {
  const received = await h.api('POST', 'requests', request)
  expect(received).toMatchObject({ status: 200, body: { result: 'stored' } })
  const triggerId = String(received.body.triggerId)
  await h.runtime.idle()
  const trigger = h.runtime.store.triggers.get(triggerId)!
  expect(trigger).toMatchObject({ source: OPERATOR_SOURCE, actor: { source: OPERATOR_SOURCE, id: OPERATOR_ID }, human: true,
    addressed: 'direct', text: request.text, meta: { origin: 'local-management' } })
  expect(trigger.channel).toBeUndefined()
  expect(h.candidates()).toContain(triggerId)
  const routed = await h.route({ kind: 'accept', trigger_id: triggerId, title: 'Verify scheduling defect',
    worktree_name: 'verify-scheduling', acknowledgement: 'Verify the scheduling defect and report evidence.' })
  await h.runtime.idle()
  const id = (routed.ticket as { ticket_id: string }).ticket_id
  const ticket = h.runtime.store.tickets.get(id)!
  expect(ticket.mandate).toMatchObject({ strength: 'explicit', actor: { source: OPERATOR_SOURCE, id: OPERATOR_ID } })
  expect(h.agents.has(`worker-${id}`)).toBe(true)
  expect(settingsPolicy(h.runtime.store.settings(), h.runtime.sources).revalidate(ticket.mandate)).toBe(true)
  expect(h.runtime.store.db.prepare('SELECT COUNT(*) AS total FROM outbox').get()?.total).toBe(0)
})

it('deduplicates a repeated owner request and refuses changed content under the same request ID', async () => {
  const first = await h.api('POST', 'requests', request)
  expect(await h.api('POST', 'requests', request)).toMatchObject({ status: 200,
    body: { triggerId: first.body.triggerId, result: 'duplicate' } })
  expect(await h.api('POST', 'requests', { ...request, text: 'Different work' })).toMatchObject({ status: 409 })
  expect(h.runtime.store.triggers.get(String(first.body.triggerId))?.text).toBe(request.text)
})

it('does not promote the local owner identity to a remote Source or another operator actor', () => {
  const settings = SettingsSchema.parse({})
  expect(allowedSender(settings, { source: OPERATOR_SOURCE, id: OPERATOR_ID })).toBeDefined()
  expect(allowedSender(settings, { source: 'dingtalk', id: OPERATOR_ID })).toBeUndefined()
  expect(allowedSender(settings, { source: OPERATOR_SOURCE, id: 'another-person' })).toBeUndefined()
})

it('respects a disabled local Source and never supplies a reply channel from caller data', async () => {
  const settings = h.runtime.store.settings()
  h.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources, operator: { enabled: false, config: {} } } })
  expect(await h.api('POST', 'requests', request)).toMatchObject({ status: 200, body: { result: 'filtered' } })
  await h.runtime.idle()
  expect(h.candidates()).toEqual([])
  expect(h.runtime.store.tickets.list()).toEqual([])
  expect(h.runtime.sources.scope({ source: OPERATOR_SOURCE, meta: { origin: 'external-message' } })).toEqual({ listened: false, reason: 'source_disabled' })
})

it('filters non-management input on the local Source', () => {
  expect(h.runtime.sources.scope({ source: OPERATOR_SOURCE, meta: { origin: 'external-message' } })).toEqual({ listened: false, reason: 'not_local_request' })
  const submitted = new OperatorRequests({ get: () => undefined, receive: trigger => h.runtime.receive({ ...trigger,
    meta: { origin: 'external-message' } }) }).submit(request)
  expect(submitted.result).toBe('filtered')
})
