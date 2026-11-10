import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OutboundMessage } from '../src/core/index.ts'
import type { SourceContext } from '../src/sources/host.ts'
import { CliError } from '../src/infra/commands.ts'
import { sendGitlab } from '../src/sources/gitlab-channel.ts'

const deployment = { repository: 'example/widgets', gitlab: {
  cli: 'glab-agent', hostname: 'gitlab.com', login: 'agent-user', noreply: 'agent-user@noreply.gitlab.com', projectId: 2834,
} }
const message: OutboundMessage = { id: 'reply-1', channel: { source: 'gitlab', thread: 'gitlab:mr:7', address: {
  kind: 'mr', iid: '7', url: 'https://gitlab.com/example/widgets/-/merge_requests/7',
} }, text: '收到。', kind: 'reply' }
const host = (pages: ReturnType<typeof vi.fn>, api: ReturnType<typeof vi.fn>) => ({ commands: {
  deployment, gitlabPages: pages, gitlabApi: api,
} }) as unknown as Pick<SourceContext, 'commands'>

afterEach(() => vi.restoreAllMocks())

describe('GitLab idempotent replies', () => {
  it('reuses a previously posted hidden marker under the agent account', async () => {
    const pages = vi.fn().mockResolvedValue([{ id: 22, body: '收到。\n\n<!-- dsh-superagent:reply-1 -->', author: { username: 'agent-user' } }])
    const api = vi.fn()
    expect(await sendGitlab(host(pages, api), message)).toBe('sent')
    expect(api).not.toHaveBeenCalled()
    expect(pages).toHaveBeenCalledWith(expect.anything(), 'merge_requests/7/notes')
  })

  it('posts a marker when no matching note exists and maps a deleted MR to gone', async () => {
    const pages = vi.fn().mockResolvedValue([])
    const api = vi.fn().mockResolvedValue({})
    expect(await sendGitlab(host(pages, api), message)).toBe('sent')
    expect(api).toHaveBeenCalledWith(expect.anything(), 'merge_requests/7/notes', '--method', 'POST', '-f', expect.stringContaining('dsh-superagent:reply-1'))
    api.mockRejectedValueOnce(new CliError('Not Found', 404))
    await expect(sendGitlab(host(pages, api), message)).resolves.toBe('gone')
  })
})
