import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Commands } from '../src/infra/commands.ts'
import { gitlabKind } from '../src/sources/gitlab.ts'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'

let host: Host
beforeEach(async () => {
  host = await startRuntime()
  const original = host.runtime.deployment
  host.runtime.sources.register(gitlabKind)
  const settings = host.runtime.store.settings()
  host.runtime.store.saveSettings({ ...settings, sources: { ...settings.sources,
    github: { ...settings.sources.github!, enabled: false },
    gitlab: { enabled: true, config: { hostname: 'gitlab.example.com', repository: 'acme/widgets', cli: '/glab-agent' } },
  } })
  vi.spyOn(host.runtime.setup, 'deployment', 'get').mockReturnValue({ ...original, github: undefined,
    gitlab: { cli: '/glab-agent', hostname: 'gitlab.example.com', login: 'agent-bot', noreply: 'bot@example.com', projectId: 2834 } })
})
afterEach(async () => { await host.stop() })

const mergeRequest = (branch: string) => ({ id: 700, iid: 7, project_id: 2834, title: 'Fix regression', state: 'opened',
  web_url: 'https://gitlab.example.com/acme/widgets/-/merge_requests/7', author: { id: 42, username: 'agent-bot', name: 'Agent' },
  description: 'Fix regression', source_branch: branch, target_branch: 'main', source_project_id: 2834, target_project_id: 2834,
  sha: 'a'.repeat(40), created_at: '2026-09-09T01:00:00Z', updated_at: '2026-09-09T01:00:00Z', merged_at: null, closed_at: null })

it('binds a GitLab MR report through the GitLab account and exposes its IID in the ticket card', async () => {
  const { ticket, sessionId } = await host.acceptedTicket(feishu('1', '@bot 修复回归'))
  expect(host.tools.get(sessionId)?.has('orchestrator_report'), JSON.stringify(host.runtime.store.tickets.get(ticket.id))).toBe(true)
  const api = vi.spyOn(Commands.prototype, 'gitlabApi').mockResolvedValue(mergeRequest(`fix/${ticket.execution!.name}`) as never)
  const github = vi.spyOn(Commands.prototype, 'api')
  expect(await host.runTool(sessionId, 'orchestrator_report', { state: 'progress', summary: 'MR created', pr_number: 7 }))
    .toMatchObject({ reported: true })
  expect(api).toHaveBeenCalled()
  expect(github).not.toHaveBeenCalled()
  expect(host.runtime.store.tickets.get(ticket.id)?.follows).toContainEqual({ thread: 'gitlab:mr:7', own: true })
  expect(await host.runTool(host.runtime.masterId, 'orchestrator_read', { resource: `ticket/${ticket.id}` }))
    .toMatchObject({ pr_number: 7 })
})

it('rejects a foreign-project MR before recording a ready report', async () => {
  const { ticket, sessionId } = await host.acceptedTicket(feishu('2', '@bot 修复回归'))
  expect(host.tools.get(sessionId)?.has('orchestrator_report'), JSON.stringify(host.runtime.store.tickets.get(ticket.id))).toBe(true)
  vi.spyOn(Commands.prototype, 'gitlabApi').mockResolvedValue({ ...mergeRequest(`fix/${ticket.execution!.name}`),
    source_project_id: 999, target_project_id: 999, project_id: 999 } as never)
  await expect(host.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: 'Done', pr_number: 7 })).rejects.toThrow()
  const current = host.runtime.store.tickets.get(ticket.id)!
  expect(current.follows ?? []).toEqual([])
  expect(current.assignments.at(-1)?.report?.state).not.toBe('ready')
})
