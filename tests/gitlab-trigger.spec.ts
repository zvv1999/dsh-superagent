import { describe, expect, it } from 'vitest'
import { gitlabAddress, explicitCommand, hasSystemMarker, issueTrigger, mergeRequestTrigger, noteTrigger, type GitlabIssue,
  type GitlabNote, type MergeRequest } from '../src/sources/gitlab-trigger.ts'

describe('GitLab explicit command triggers', () => {
  it('accepts only /superagent at the beginning of the first line', () => {
    expect(explicitCommand('/superagent fix the build')).toBe(true)
    expect(explicitCommand('  \t/superagent\nfix the build')).toBe(true)
    expect(explicitCommand('/superagent')).toBe(true)
    expect(explicitCommand('Please /superagent fix the build')).toBe(false)
    expect(explicitCommand('> /superagent fix the build')).toBe(false)
    expect(explicitCommand('```\n/superagent fix the build')).toBe(false)
    expect(explicitCommand('/superagent-fake')).toBe(false)
  })

  it('rejects every system-marked message, including one with an explicit-looking prefix', () => {
    const body = '/superagent retry\n<!-- dsh-superagent:reply-1 -->'
    expect(hasSystemMarker(body)).toBe(true)
    expect(explicitCommand(body)).toBe(false)
  })

  it('keeps an explicit command by the configured account as a human addressed trigger', () => {
    const issue: GitlabIssue = { iid: 7, title: 'Build', description: '/superagent fix it', state: 'opened',
      web_url: 'https://gitlab.com/example/widgets/-/issues/7', created_at: '2026-11-08T00:00:00Z',
      updated_at: '2026-11-08T00:00:00Z', author: { username: 'agent-user' }, project_id: 2834 }
    expect(issueTrigger(issue)).toMatchObject({ source: 'gitlab', human: true, addressed: 'mention', meta: { kind: 'issue', iid: 7 } })
  })

  it('does not address a non-command description or note when builders are called directly', () => {
    const issue: GitlabIssue = { iid: 8, title: 'No command', description: 'ordinary text', state: 'opened',
      web_url: 'https://gitlab.com/example/widgets/-/issues/8', created_at: '2026-11-08T00:00:00Z',
      updated_at: '2026-11-08T00:00:00Z', author: { username: 'alice' } }
    const mr: MergeRequest = { ...issue, iid: 9, title: 'MR', web_url: 'https://gitlab.com/example/widgets/-/merge_requests/9' }
    const note: GitlabNote = { id: 12, body: 'ordinary text', author: { username: 'alice' }, created_at: '2026-11-08T00:00:00Z' }
    expect(issueTrigger(issue)).not.toHaveProperty('addressed')
    expect(mergeRequestTrigger(mr)).not.toHaveProperty('addressed')
    expect(noteTrigger(note, { kind: 'mr', iid: 9 })).not.toHaveProperty('addressed')
  })
})

describe('GitLab addresses', () => {
  it('keeps issue and MR IIDs separate and rejects another repository', () => {
    expect(gitlabAddress('https://gitlab.com/example/widgets/-/issues/7', 'gitlab.com', 'example/widgets'))
      .toEqual({ kind: 'issue', iid: 7 })
    expect(gitlabAddress('https://gitlab.com/example/widgets/-/merge_requests/7#note_12', 'gitlab.com', 'example/widgets'))
      .toEqual({ kind: 'mr', iid: 7, noteId: 12 })
    expect(gitlabAddress('https://gitlab.com/other/project/-/issues/7', 'gitlab.com', 'example/widgets')).toBeUndefined()
  })
})
