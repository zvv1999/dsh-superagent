import { describe, expect, it, vi } from 'vitest'
import type { SourceContext } from '../src/sources/host.ts'
import { KV } from '../src/kv.ts'
import { gitlabKind, pollRound, type GitlabConfig } from '../src/sources/gitlab.ts'
import { Commands } from '../src/infra/commands.ts'
import { NoteSchema, PipelineSchema } from '../src/sources/gitlab-trigger.ts'
import { testDeployment } from './fixtures/deployment.ts'

const config = (): GitlabConfig => gitlabKind.schema.parse({ repository: 'example/widgets', hostname: 'gitlab.com',
  cli: 'glab-agent', observePipelines: true })
const deployment = { repository: 'example/widgets', gitlab: {
  cli: 'glab-agent', hostname: 'gitlab.com', login: 'agent-user', noreply: 'agent-user@noreply.gitlab.com', projectId: 2834,
} }

it('accepts hyphenated names with browser Unicode-v input validation', () => {
  const repository = gitlabKind.fields.find(field => field.key === 'repository')!
  expect(repository.type).toBe('text')
  if (repository.type !== 'text') throw new Error('Repository field must be text')
  const pattern = new RegExp(`^(?:${repository.pattern})$`, 'v')
  expect(pattern.test('example/sub-group/widgets')).toBe(true)
  expect(pattern.test('group/bad repo')).toBe(false)
  const allowed = gitlabKind.policy!.fields!.find(field => field.key === 'allowed')!
  if (allowed.type !== 'rows') throw new Error('Allowed accounts must use rows')
  const id = allowed.columns.find(column => column.key === 'id')!
  if (id.type !== 'text') throw new Error('Account ID must be text')
  expect(new RegExp(`^(?:${id.pattern})$`, 'v').test('user-name')).toBe(true)
})

it('recognises GitLab scopes and exposes the agreed worker environment', () => {
  const value = config()
  expect(gitlabKind.scope?.({ meta: { kind: 'comment' } }, value)).toMatchObject({ listened: true, observed: false, row: 'comments' })
  expect(gitlabKind.scope?.({ meta: { kind: 'pipeline' } }, value)).toMatchObject({ listened: true, observed: true, row: 'pipelines' })
  const variables = gitlabKind.environment!.values({ deployment: deployment as never, config: value,
    trigger: { threads: [{ source: 'gitlab', id: 'mr:7' }], meta: { kind: 'mr', iid: 7 } } as never })
  expect(variables).toMatchObject({ DSH_SUPERAGENT_GITLAB_HOST: 'gitlab.com', DSH_SUPERAGENT_GITLAB_PROJECT_ID: '2834',
    DSH_SUPERAGENT_GITLAB_REPOSITORY: 'example/widgets', DSH_SUPERAGENT_GITLAB_NUMBER: '7',
    DSH_SUPERAGENT_GITLAB_MR_HEAD: 'refs/merge-requests/7/head' })
})

it.each([false, true])('preserves bot=%s for explicit own-account commands and ignores ordinary text', async bot => {
  const configValue = config()
  const state = new Map<string, unknown>()
  const at = new Date(Date.now() + 60_000).toISOString()
  const pages = vi.fn()
    .mockResolvedValueOnce([{ iid: 7, title: 'Explicit', description: '/superagent fix', state: 'opened', project_id: 2834,
      web_url: 'https://gitlab.com/example/widgets/-/issues/7', created_at: at, updated_at: at, author: { username: 'agent-user', bot } },
      { iid: 8, title: 'Ordinary', description: 'follow up', state: 'opened', project_id: 2834,
        web_url: 'https://gitlab.com/example/widgets/-/issues/8', created_at: at, updated_at: at, author: { username: 'agent-user' } }])
    .mockResolvedValueOnce([{ id: 1, body: '/superagent from a note', author: { username: 'agent-user', bot }, created_at: at, updated_at: at },
      { id: 2, body: 'ordinary note', author: { username: 'agent-user', bot }, created_at: at, updated_at: at },
      { id: 3, body: '/superagent\n<!-- dsh-superagent:reply -->', author: { username: 'agent-user', bot }, created_at: at, updated_at: at }])
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([])
  const receive = vi.fn()
  const commands = { withSignal: vi.fn(() => commands), gitlabPages: pages } as never
  const context = {
    deployment, commands, receive, config: vi.fn(() => configValue), state: { get: (name: string) => state.get(name), set: (name: string, value: unknown) => state.set(name, value) },
    tickets: { open: () => [] }, threads: { subscribed: () => [], patch: vi.fn(), describe: vi.fn() }, report: vi.fn(),
  } as unknown as SourceContext
  await pollRound(context)
  expect(receive).toHaveBeenCalledTimes(2)
  expect(receive.mock.calls.map(call => call[0].human)).toEqual([!bot, !bot])
  expect(receive.mock.calls.map(call => call[0].text)).toEqual(expect.arrayContaining(['Explicit\n\n/superagent fix', '/superagent from a note']))
})

it('maps local shorthand, leaving URLs to retained-URL search without aliasing foreign IIDs', () => {
  expect(gitlabKind.find?.('!7')).toEqual({ threads: ['gitlab:mr:7'], terms: [] })
  expect(gitlabKind.find?.('#7')).toEqual({ threads: ['gitlab:issue:7'], terms: [] })
  for (const query of ['https://gitlab.com/other/project/-/merge_requests/7', 'https://another.example/example/widgets/-/issues/7',
    'https://gitlab.com/example/widgets/-/merge_requests/7', '!0', '#0', '!9007199254740992']) {
    expect(gitlabKind.find?.(query)?.threads).toEqual([])
  }
})

it('inherits account field validation from setup', () => {
  for (const hostname of ['https://gitlab.com', 'bad..host', '-bad.example', 'a'.repeat(64) + '.example']) {
    expect(gitlabKind.schema.safeParse({ hostname }).success).toBe(false)
  }
  expect(gitlabKind.schema.safeParse({ hostname: 'gitlab.com', repository: 'group/subgroup/project', cli: '/opt/homebrew/bin/glab' }).success).toBe(true)
})

it('does not advance an Issue/MR stream cursor when the GitLab API fails', async () => {
  const configValue = config()
  const state = new Map<string, unknown>()
  const pages = vi.fn(async () => { throw new Error('GitLab unavailable') })
  const commands = { withSignal: vi.fn(() => commands), gitlabPages: pages } as never
  const context = {
    deployment, commands, config: vi.fn(() => configValue), state: { get: (name: string) => state.get(name), set: (name: string, value: unknown) => state.set(name, value) },
    tickets: { open: () => [] }, threads: { subscribed: () => [], patch: vi.fn(), describe: vi.fn() }, report: vi.fn(),
  } as unknown as SourceContext
  await expect(pollRound(context)).rejects.toThrow('GitLab reads failed')
  expect(state.get(KV.gitlab.stream('issue'))).toBeUndefined()
  expect(state.get(KV.gitlab.stream('mr'))).toBeUndefined()
  expect(pages).toHaveBeenCalledTimes(2)
})

it('parses the observed glab per-item NDJSON shape across notes pages and MR pipelines', async () => {
  const commands = new Commands(() => testDeployment({ ...deployment, github: undefined }), {}, new AbortController().signal)
  const run = vi.spyOn(commands, 'run').mockResolvedValueOnce([
    { id: 1, body: 'first', author: { username: 'alice' }, system: false, noteable_type: 'MergeRequest' },
    { id: 2, body: 'second', author: { username: 'alice' }, system: false, noteable_type: 'MergeRequest' },
  ].map(value => JSON.stringify(value)).join('\n'))
  const notes = await commands.gitlabPages(NoteSchema, 'merge_requests/7/notes?per_page=1')
  expect(notes.map(note => note.id)).toEqual([1, 2])
  expect(run).toHaveBeenCalledWith('glab-agent', ['api', '--hostname', 'gitlab.com', 'projects/2834/merge_requests/7/notes?per_page=1', '--paginate', '--output', 'ndjson'])
  // Same field set as the GET /merge_requests/436/pipelines sample; no business content is retained.
  run.mockResolvedValueOnce(JSON.stringify({ id: 99545, iid: 1, project_id: 2834, sha: 'a'.repeat(40), ref: 'refs/merge-requests/7/head',
    status: 'failed', source: 'merge_request_event', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:01:00Z',
    web_url: 'https://gitlab.com/example/widgets/-/pipelines/99545' }) + '\n')
  await expect(commands.gitlabPages(PipelineSchema, 'merge_requests/7/pipelines?per_page=1')).resolves.toMatchObject([{ id: 99545, status: 'failed' }])
})

describe('MR pipeline transitions', () => {
  const head = 'a'.repeat(40)
  const setup = () => {
    const state = new Map<string, unknown>()
    const mr = { iid: 7, title: 'MR', description: '', state: 'opened', author: { username: 'alice' }, sha: head,
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', web_url: 'https://gitlab.com/example/widgets/-/merge_requests/7' }
    let listed: unknown[] = []
    const pages = vi.fn(async (_schema: unknown, path: string) => path.includes('/pipelines?') ? listed : [])
    const commands = { withSignal: () => commands, gitlabPages: pages, gitlabApi: vi.fn(async () => mr) }
    const receive = vi.fn()
    const describe = vi.fn()
    const context = { deployment, commands, receive, config: () => config(), report: vi.fn(),
      state: { get: (name: string) => state.get(name), set: (name: string, value: unknown) => state.set(name, value) },
      tickets: { open: () => [{ id: 't1', follows: [{ thread: 'gitlab:mr:7', own: true }] }] },
      threads: { subscribed: () => [], patch: vi.fn(), describe },
    } as unknown as SourceContext
    return { context, receive, describe, state, pipelines: (value: unknown[]) => { listed = value } }
  }

  it('selects the newest current-head pipeline, deduplicates timestamp-only changes and emits real status transitions', async () => {
    const { context, receive, describe, state, pipelines } = setup()
    const current = { id: 10, status: 'running', sha: head, updated_at: '2026-01-01T00:00:00Z' }
    const previous = { id: 9, status: 'failed', sha: head, updated_at: '2026-01-02T00:00:00Z' }
    const foreign = { id: 11, status: 'failed', sha: 'b'.repeat(40), updated_at: '2026-01-03T00:00:00Z' }
    pipelines([previous, foreign, current])
    await pollRound(context)
    expect(receive).not.toHaveBeenCalled()
    expect(describe).toHaveBeenLastCalledWith('gitlab:mr:7', { facts: { ci: { label: expect.anything(), value: 'running' } } })
    pipelines([{ ...current, updated_at: '2026-01-04T00:00:00Z' }])
    await pollRound(context)
    expect(receive).not.toHaveBeenCalled()
    expect(state.get(KV.gitlab.pipeline(7))).toMatchObject({ revision: 0 })
    pipelines([{ ...current, status: 'failed' }])
    await pollRound(context)
    expect(receive).toHaveBeenCalledTimes(1)
    expect(receive.mock.calls[0]?.[0]).toMatchObject({ human: false, threads: [{ source: 'gitlab', id: 'mr:7' }],
      meta: { kind: 'pipeline', entity: 'mr', iid: 7, isMr: true, status: 'failed', revision: 1 } })
    await pollRound(context)
    expect(receive).toHaveBeenCalledTimes(1)
    pipelines([{ ...current, status: 'success' }])
    await pollRound(context)
    expect(receive).toHaveBeenCalledTimes(2)
    expect(state.get(KV.gitlab.pipeline(7))).toMatchObject({ revision: 2 })
  })

  it('retries a failed transition with the same event ID and keeps the committed baseline', async () => {
    const { context, receive, state, pipelines } = setup()
    pipelines([{ id: 10, status: 'running', sha: head }])
    await pollRound(context)
    const before = state.get(KV.gitlab.pipeline(7))
    pipelines([{ id: 10, status: 'failed', sha: head }])
    receive.mockRejectedValueOnce(new Error('storage unavailable'))
    await expect(pollRound(context)).rejects.toThrow('GitLab reads failed')
    expect(state.get(KV.gitlab.pipeline(7))).toEqual(before)
    await pollRound(context)
    expect(receive.mock.calls[0]?.[0].id).toBe(receive.mock.calls[1]?.[0].id)
    expect(state.get(KV.gitlab.pipeline(7))).toMatchObject({ revision: 1 })
  })
})
