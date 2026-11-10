import { afterEach, describe, expect, it, vi } from 'vitest'
import { CliError, type Commands } from '../src/infra/commands.ts'
import { admissionContext } from '../src/sources/admission-context.ts'
import type { TriggerContext } from '../src/sources/kind.ts'
import { gitlabThreadContext, readGitlab, readGitlabRepositoryPath } from '../src/sources/gitlab-read.ts'
import { mergeRequestTrigger, noteTrigger } from '../src/sources/gitlab-trigger.ts'

const fakeCommands = () => {
  const api = vi.fn()
  const pages = vi.fn()
  return { commands: { gitlabApi: api, gitlabPages: pages } as unknown as Commands, api, pages }
}

const response = (items: unknown[], next = '') => `HTTP/1.1 200 OK\r\nX-Next-Page: ${next}\r\n\r\n${JSON.stringify(items)}`
const root = { iid: 7, title: 'Fix', description: '/superagent fix', state: 'opened',
  web_url: 'https://gitlab.com/example/widgets/-/merge_requests/7', created_at: '2026-11-08T00:00:00Z',
  updated_at: '2026-11-08T00:00:00Z', author: { username: 'alice' } }
const note = (id: number) => ({ id, body: `/superagent note ${id}`, author: { username: 'alice' }, created_at: '2026-11-08T00:01:00Z' })
const trigger = mergeRequestTrigger(root)
const contextFor = (source = trigger): TriggerContext => ({
  messageId: gitlabThreadContext.messageId(source),
  read: (commands, part, cursor) => gitlabThreadContext.read(commands, source, part, cursor, {}),
  images: () => [], image: async () => undefined,
})

afterEach(() => vi.restoreAllMocks())

describe('GitLab repository resources', () => {
  it('reads a raw file and a filtered tree through the configured project API', async () => {
    const { commands, api, pages } = fakeCommands()
    api.mockResolvedValueOnce('source')
    expect(await readGitlabRepositoryPath(commands, 'src/main.ts', 'file')).toBe('source')
    expect(api).toHaveBeenCalledWith('repository/files/src%2Fmain.ts/raw?ref=HEAD')
    pages.mockResolvedValueOnce([{ name: 'src', type: 'tree' }, { name: '.gitignore', type: 'blob' }, { name: 'node_modules', type: 'tree' }])
    expect(await readGitlabRepositoryPath(commands, 'src', 'directory')).toBe('src')
    expect(pages).toHaveBeenCalledWith(expect.anything(), 'repository/tree?path=src&ref=HEAD&per_page=100')
  })

  it('rejects hidden, traversal, node_modules, and Windows paths before making a request', async () => {
    const { commands, api, pages } = fakeCommands()
    for (const path of ['../secret', '.env', 'src/../secret', 'node_modules/pkg', 'src\\main.ts']) {
      await expect(readGitlabRepositoryPath(commands, path, 'file')).rejects.toThrow('Only non-hidden')
    }
    expect(api).not.toHaveBeenCalled()
    expect(pages).not.toHaveBeenCalled()
  })
})

describe('GitLab context resources', () => {
  it('uses the root URL for an Issue/MR description and the note ID for a comment', () => {
    const url = 'https://gitlab.com/example/widgets/-/merge_requests/7'
    expect(gitlabThreadContext.messageId(mergeRequestTrigger({ iid: 7, title: 'Fix', description: '/superagent', state: 'opened', web_url: url,
      created_at: '2026-11-08T00:00:00Z', updated_at: '2026-11-08T00:00:00Z', author: { username: 'alice' } }))).toBe(url)
  })

  it('reads an MR and filters system/hidden reply notes from context messages', async () => {
    const { commands, api, pages } = fakeCommands()
    api.mockResolvedValueOnce({ iid: 7, title: 'Fix', description: '/superagent fix', state: 'opened',
      web_url: 'https://gitlab.com/example/widgets/-/merge_requests/7', created_at: '2026-11-08T00:00:00Z',
      updated_at: '2026-11-08T00:00:00Z', author: { username: 'alice' } })
    const notes = [{ id: 1, body: 'hello', author: { username: 'alice' }, created_at: '2026-11-08T00:01:00Z' },
      { id: 2, body: '<!-- dsh-superagent:reply -->', author: { username: 'agent-user' }, created_at: '2026-11-08T00:02:00Z' },
      { id: 3, body: 'system', system: true, author: { username: 'gitlab' }, created_at: '2026-11-08T00:03:00Z' }]
    api.mockResolvedValueOnce(response(notes))
    const root = await readGitlab(commands, 'gitlab/merge_requests/7') as { messages: { id: string }[] }
    expect(root.messages).toHaveLength(1)
    const discussion = await readGitlab(commands, 'gitlab/merge_requests/7/notes') as { messages: { id: string }[] }
    expect(discussion.messages.map(message => message.id)).toEqual(['1'])
    expect(pages).not.toHaveBeenCalled()
    expect(api).toHaveBeenLastCalledWith('merge_requests/7/notes?sort=asc&order_by=created_at&per_page=100&page=1', '--include')
  })

  it('bounds admission to a notes page and includes the root so a description is found', async () => {
    const { commands, api, pages } = fakeCommands()
    api.mockResolvedValueOnce(root).mockResolvedValueOnce(response([note(1)], '2'))
    const result = await admissionContext(contextFor(), commands, 1)
    expect(result).toMatchObject({ complete: false, next: 'gitlab:mr:7:notes:2', window: { source_found: true, loaded_messages: 2 } })
    expect(result.messages.map(message => message.id)).toEqual([root.web_url, '1'])
    expect(api).toHaveBeenCalledTimes(2)
    expect(pages).not.toHaveBeenCalled()
  })

  it('continues through a page of filtered notes and finds a later command without rereading the root', async () => {
    const { commands, api, pages } = fakeCommands()
    const hidden = Array.from({ length: 100 }, (_, id) => ({ ...note(id + 1), system: true }))
    api.mockResolvedValueOnce(root).mockResolvedValueOnce(response(hidden, '2')).mockResolvedValueOnce(response([note(101)]))
    const source = noteTrigger(note(101), { kind: 'mr', iid: 7, url: root.web_url })
    const result = await admissionContext(contextFor(source), commands, 2)
    expect(result).toMatchObject({ complete: true, next: null, window: { source_found: true, loaded_messages: 2 } })
    expect(result.messages.map(message => message.id)).toEqual([root.web_url, '101'])
    expect(api).toHaveBeenCalledTimes(3)
    expect(api).toHaveBeenLastCalledWith('merge_requests/7/notes?sort=asc&order_by=created_at&per_page=100&page=2', '--include')
    expect(pages).not.toHaveBeenCalled()
  })

  it.each(['gitlab:issue:7:notes:2', 'gitlab:mr:8:notes:2', 'gitlab:mr:7:notes:0', 'gitlab:mr:7:notes:9007199254740992',
    'https://another.example/notes', 'gitlab:mr:7:notes:2?project_id=99', '2'])('rejects a forged or foreign-thread cursor %s before any read', async cursor => {
    const { commands, api } = fakeCommands()
    await expect(gitlabThreadContext.read(commands, trigger, 'thread', cursor, {})).rejects.toThrow(/cursor|safe integer/)
    expect(api).not.toHaveBeenCalled()
  })

  it.each(['0', '1', '3', 'https://another.example/api/v4/projects/99/notes'])('rejects a malformed or nonsequential next-page header %s', async next => {
    const { commands, api } = fakeCommands()
    api.mockResolvedValueOnce(root).mockResolvedValueOnce(response([], next))
    await expect(admissionContext(contextFor(), commands, 2)).rejects.toThrow(/pagination|safe integer/)
    expect(api).toHaveBeenCalledTimes(2)
  })

  it('uses raw page length when pagination headers are unavailable, even if all notes were filtered', async () => {
    const { commands, api } = fakeCommands()
    api.mockResolvedValueOnce(root).mockResolvedValueOnce(`HTTP/1.1 200 OK\n\n${JSON.stringify(Array.from({ length: 100 }, (_, id) => ({ ...note(id + 1), system: true })))}`)
    const result = await admissionContext(contextFor(), commands, 1)
    expect(result).toMatchObject({ complete: false, next: 'gitlab:mr:7:notes:2', window: { loaded_messages: 1 } })
  })

  it.each([403, 404, 410])('reports unavailable/deleted thread context for HTTP %s without claiming empty history', async code => {
    const { commands, api } = fakeCommands()
    api.mockRejectedValueOnce(new CliError('unavailable', code))
    await expect(admissionContext(contextFor(), commands, 1)).rejects.toThrow(`HTTP ${code}`)
    expect(api).toHaveBeenCalledTimes(1)
  })

  it('reports a missing parent note and never substitutes another thread', async () => {
    const { commands, api } = fakeCommands()
    const source = noteTrigger({ ...note(20), in_reply_to_id: 10 }, { kind: 'mr', iid: 7, url: root.web_url })
    api.mockRejectedValueOnce(new CliError('Not Found', 404))
    await expect(gitlabThreadContext.read(commands, source, 'parent', undefined, {})).rejects.toThrow(/parent context.*HTTP 404/)
    expect(api).toHaveBeenCalledWith(expect.anything(), 'merge_requests/7/notes/10')
  })

  it('retains reply relationships and bot classification for notes and rejects root/parent cursors', async () => {
    const { commands, api } = fakeCommands()
    api.mockResolvedValueOnce({ ...note(20), in_reply_to_id: 10, author: { username: 'build[bot]' } })
    const result = await readGitlab(commands, 'gitlab/merge_requests/7/notes/20') as { messages: unknown[] }
    expect(result.messages[0]).toMatchObject({ id: '20', reply_to: '10', bot: true })
    api.mockClear()
    for (const part of ['root', 'parent'] as const) {
      await expect(gitlabThreadContext.read(commands, trigger, part, 'gitlab:mr:7:notes:2', {})).rejects.toThrow('do not accept a cursor')
    }
    expect(api).not.toHaveBeenCalled()
  })

  it('allows only a bounded notes page parameter in resource reads', async () => {
    const { commands, api, pages } = fakeCommands()
    for (const query of ['page=0', 'page=1&page=2', 'page=2&per_page=10000', 'page=https://another.example']) {
      await expect(readGitlab(commands, `gitlab/merge_requests/7/notes?${query}`)).rejects.toThrow()
    }
    expect(api).not.toHaveBeenCalled()
    api.mockResolvedValueOnce(response([note(101)], '3'))
    await expect(readGitlab(commands, 'gitlab/merge_requests/7/notes?page=2')).resolves.toMatchObject({
      body: { next_resource: 'gitlab/merge_requests/7/notes?page=3' }, messages: [expect.objectContaining({ id: '101' })],
    })
    expect(pages).not.toHaveBeenCalled()
  })

  it('rejects unknown resources and path traversal', async () => {
    const { commands, api, pages } = fakeCommands()
    await expect(readGitlab(commands, 'github/issues/1')).rejects.toThrow('Unsupported GitLab')
    await expect(readGitlab(commands, 'gitlab/merge_requests/1/unknown')).rejects.toThrow('Unsupported GitLab')
    await expect(readGitlab(commands, 'gitlab/merge_requests/../1')).rejects.toThrow('Unsupported GitLab')
    expect(api).not.toHaveBeenCalled()
    expect(pages).not.toHaveBeenCalled()
  })
})
