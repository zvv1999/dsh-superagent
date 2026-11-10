import { describe, expect, it, vi } from 'vitest'
import type { SourceContext } from '../src/sources/host.ts'
import type { Deployment } from '../src/deployment.ts'
import type { Ticket } from '../src/core/index.ts'
import { agentMergeRequest, claimMergeRequest, mrEndNotices, mrOf, observeMergeRequest } from '../src/sources/gitlab-pull.ts'
import { mergeRequestTrigger, noteTrigger, type MergeRequest } from '../src/sources/gitlab-trigger.ts'
import { testDeployment } from './fixtures/deployment.ts'

const deployment = (): Deployment => testDeployment({ repository: 'example/widgets', gitlab: {
  cli: 'glab-agent', hostname: 'gitlab.com', login: 'agent-user', noreply: '7-agent-user@noreply.gitlab.com', projectId: 2834,
} })
const mr = (overrides: Partial<MergeRequest> = {}): MergeRequest => ({
  iid: 7, title: 'Fix', description: '', state: 'opened', web_url: 'https://gitlab.com/example/widgets/-/merge_requests/7',
  created_at: '2026-11-08T00:00:00Z', updated_at: '2026-11-08T00:00:00Z', author: { username: 'agent-user' },
  project_id: 2834, source_project_id: 2834, target_project_id: 2834,
  source_project: { id: 2834, path_with_namespace: 'example/widgets' },
  target_project: { id: 2834, path_with_namespace: 'example/widgets' }, source_branch: 'agent/fix-build', target_branch: 'main', sha: 'abc123', ...overrides,
})
const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: 't1', title: 'Fix', decisionId: 'd1', mandate: {} as Ticket['mandate'], channels: [], assignments: [], inputs: [], undelivered: [],
  createdAt: '2026-11-08T00:00:00Z', updatedAt: '2026-11-08T00:00:00Z', origin: { triggerId: 'origin', triggerIds: ['origin'] },
  execution: { name: 'fix-build', directory: '/tmp/fix-build', assignment: '' }, ...overrides,
})

describe('GitLab merge request ownership', () => {
  it('requires the configured project and agent account for agent-owned MRs', () => {
    expect(agentMergeRequest(mr(), deployment())).toBe(true)
    expect(agentMergeRequest(mr({ source_project_id: 999, source_project: { id: 999, path_with_namespace: 'fork/widgets' } }), deployment())).toBe(false)
    expect(agentMergeRequest(mr({ author: { username: 'alice' } }), deployment())).toBe(false)
  })

  it('rejects wrong branches and cross-project MRs, then binds the exact ticket branch', () => {
    const current = ticket()
    const bound = vi.fn()
    const context = {
      deployment: deployment(),
      tickets: { get: vi.fn(() => current), open: vi.fn(() => [current]), bindThread: bound },
      triggers: { get: vi.fn(() => undefined) },
      atomic: <T>(work: () => T) => work(),
      threads: { patch: vi.fn(), describe: vi.fn() },
    } as unknown as SourceContext
    expect(claimMergeRequest(context, current.id, mr({ source_branch: 'agent/other' }))).toContain('does not belong')
    expect(claimMergeRequest(context, current.id, mr({ source_project_id: 99, source_project: { id: 99, path_with_namespace: 'fork/widgets' } }))).toContain('configured GitLab project')
    expect(claimMergeRequest(context, current.id, mr())).toBeUndefined()
    expect(bound).toHaveBeenCalledWith('t1', { source: 'gitlab', id: 'mr:7' }, true)
  })

  it.each(['description', 'comment'] as const)('adopts the originating MR from a %s without requiring agent ownership', origin => {
    const current = ticket()
    const request = mr({ author: { username: 'alice' }, source_branch: 'alice/fix' })
    const source = origin === 'description' ? mergeRequestTrigger(request) : noteTrigger({ id: 12, body: '/superagent fix',
      author: { username: 'alice' } }, { kind: 'mr', iid: request.iid })
    const bound = vi.fn()
    const get = vi.fn(() => source)
    const context = { deployment: deployment(), tickets: { get: () => current, open: () => [current], bindThread: bound },
      triggers: { get }, threads: { patch: vi.fn() }, atomic: <T>(work: () => T) => work() } as unknown as SourceContext
    expect(claimMergeRequest(context, current.id, request)).toBeUndefined()
    expect(bound).toHaveBeenCalledWith(current.id, { source: 'gitlab', id: 'mr:7' }, false)
    bound.mockClear()
    get.mockReturnValue({ ...source, meta: { kind: 'comment', entity: 'issue', iid: 7 } })
    expect(claimMergeRequest(context, current.id, request)).toContain('does not belong to this ticket')
    expect(bound).not.toHaveBeenCalled()
    get.mockReturnValue({ ...source, meta: { kind: 'comment', entity: 'mr', iid: 8 } })
    expect(claimMergeRequest(context, current.id, request)).toContain('does not belong to this ticket')
    get.mockReturnValue(source)
    expect(claimMergeRequest(context, current.id, mr({ ...request, target_project_id: 99 }))).toContain('configured GitLab project')
  })

  it.each(['locked', 'opened', 'unknown'])('does not close a followed MR in state %s', state => {
    const current = ticket({ follows: [{ thread: 'gitlab:mr:7', own: true }] })
    const closed = vi.fn()
    const context = { deployment: deployment(), tickets: { open: () => [current], threadClosed: closed },
      threads: { patch: vi.fn(), describe: vi.fn() } } as unknown as SourceContext
    // Another author prevents auto-claiming; this case isolates observation of an existing follow.
    return expect(observeMergeRequest(context, mr({ state, author: { username: 'alice' } }))).resolves.toBe(false)
      .then(() => expect(closed).not.toHaveBeenCalled())
  })

  it('reports a merged state as merged when the collection omits merged_at', async () => {
    const current = ticket({ follows: [{ thread: 'gitlab:mr:7', own: true }] })
    const closed = vi.fn()
    const context = { deployment: deployment(), tickets: { open: () => [current], threadClosed: closed },
      threads: { patch: vi.fn(), describe: vi.fn() } } as unknown as SourceContext
    await expect(observeMergeRequest(context, mr({ state: 'merged', merged_at: null, closed_at: null }))).resolves.toBe(true)
    expect(closed).toHaveBeenCalledWith({ source: 'gitlab', id: 'mr:7' }, 'merged', '2026-11-08T00:00:00Z')
  })

  it('keeps a newly claimed locked MR followed until its terminal state is observed', () => {
    const current = ticket()
    const bound = vi.fn()
    const context = { deployment: deployment(), tickets: { get: () => current, open: () => [current], bindThread: bound },
      triggers: { get: () => undefined }, threads: { patch: vi.fn() }, atomic: <T>(work: () => T) => work() } as unknown as SourceContext
    expect(claimMergeRequest(context, current.id, mr({ state: 'locked' }))).toBeUndefined()
    expect(bound).toHaveBeenCalledWith(current.id, { source: 'gitlab', id: 'mr:7' }, true)
  })

  it('marks an ended MR through the core and selects the latest open MR for cards', async () => {
    const current = ticket({ follows: [{ thread: 'gitlab:mr:7', own: true }] })
    const closed = vi.fn()
    const context = { deployment: deployment(), tickets: { open: vi.fn(() => [current]), threadClosed: closed },
      threads: { patch: vi.fn(), describe: vi.fn() } } as unknown as SourceContext
    await observeMergeRequest(context, mr({ state: 'closed', closed_at: '2026-11-08T01:00:00Z' }))
    expect(closed).toHaveBeenCalledWith({ source: 'gitlab', id: 'mr:7' }, 'closed', '2026-11-08T01:00:00Z')
    expect(mrOf({ follows: [{ thread: 'gitlab:mr:6', own: true, closed: { at: '2026-11-08T00:00:00Z', outcome: 'closed' } },
      { thread: 'gitlab:mr:7', own: true }] })).toBe(7)
  })
})

describe('GitLab MR end notices', () => {
  it('notifies only non-GitLab channels and is idempotent by MR and channel', () => {
    const current = ticket({ ended: { at: '2026-11-08T01:00:00Z', by: 'executor', outcome: 'merged' },
      follows: [{ thread: 'gitlab:mr:7', own: true, closed: { at: '2026-11-08T01:00:00Z', outcome: 'merged' } }],
      channels: [{ source: 'feishu', thread: 'oc_team:root', address: { chat: 'oc_team' } }, { source: 'gitlab', thread: 'gitlab:mr:7', address: { kind: 'mr', iid: '7' } }] })
    const notices = mrEndNotices(current, '请修复并合并', deployment())
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ channel: { source: 'feishu' }, text: expect.stringContaining('MR !7'), kind: 'notice', ticketId: 't1' })
    expect(notices[0]!.id).toBe(mrEndNotices(current, '请修复并合并', deployment())[0]!.id)
  })
})
