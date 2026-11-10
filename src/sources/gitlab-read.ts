/** Read-only GitLab project, Issue, merge request, discussion, diff, and pipeline context. */
import { z } from 'zod'
import { CliError, validItems, type Commands } from '../infra/commands.ts'
import type { ContextPart, ContextMessage, ThreadContext } from './kind.ts'
import { hasSystemMarker, isHumanUser, JobSchema, MergeRequestSchema, NoteSchema, IssueSchema, PipelineSchema, type GitlabEntity,
  type GitlabNote, type GitlabUser } from './gitlab-trigger.ts'

const ChangesSchema = z.looseObject({
  changes: z.array(z.unknown()).optional(), diffs: z.array(z.unknown()).optional(),
})
const ApprovalsSchema = z.looseObject({ approved: z.boolean().optional(), approvals_left: z.number().optional(), approvals_required: z.number().optional(),
  approved_by: z.array(z.unknown()).optional(), rules: z.array(z.unknown()).optional() })

type ReadResult = ContextPart & { body: Record<string, unknown> }
const username = (user: GitlabUser): string => user.username ?? 'ghost'
const authorMessage = (user: GitlabUser, id: string, at: string, text: string, url?: string): ContextMessage => ({
  id, from: username(user), at, text, ...(!isHumanUser(user) ? { bot: true as const } : {}), ...(url ? { url } : {}),
})
const noteMessage = (note: GitlabNote): ContextMessage | undefined => {
  const text = note.body ?? ''
  if (note.system || hasSystemMarker(text)) return undefined
  return { ...authorMessage(note.author, String(note.id), note.updated_at ?? note.created_at ?? new Date().toISOString(), text, note.web_url ?? undefined),
    ...(note.in_reply_to_id !== null && note.in_reply_to_id !== undefined ? { reply_to: String(note.in_reply_to_id) } : {}) }
}
const titleBody = (title: string, body: string | null | undefined): string => [title, body ?? ''].filter(Boolean).join('\n\n')
const entityPath = (kind: GitlabEntity, iid: number): string => `${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}`
const entityMessage = (entity: z.infer<typeof IssueSchema> | z.infer<typeof MergeRequestSchema>): ContextMessage =>
  authorMessage(entity.author, entity.web_url, entity.created_at, titleBody(entity.title, entity.description), entity.web_url)
const bodyOf = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const PAGE_SIZE = 100
const positiveId = (value: string): number => {
  const parsed = Number(value)
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(parsed)) throw new Error('GitLab page or ID must be a positive safe integer')
  return parsed
}
const notesPageNumber = (query?: string): number => {
  if (!query) return 1
  const parameters = new URLSearchParams(query)
  if ([...parameters.keys()].some(key => key !== 'page') || parameters.getAll('page').length !== 1) {
    throw new Error('GitLab notes accept only a page query parameter')
  }
  return positiveId(parameters.get('page') ?? '')
}
const notesCursor = (kind: GitlabEntity, iid: number, page: number): string => `gitlab:${kind}:${iid}:notes:${page}`
const cursorPage = (cursor: string | undefined, kind: GitlabEntity, iid: number): number => {
  if (cursor === undefined) return 1
  const match = /^gitlab:(issue|mr):([1-9]\d*):notes:([1-9]\d*)$/.exec(cursor)
  if (!match || match[1] !== kind || match[2] !== String(iid)) throw new Error('GitLab context cursor belongs to a different thread or is invalid')
  return positiveId(match[3]!)
}

/** Reads exactly one HTTP page; only the numeric next page is trusted, never a server-supplied URL. */
async function notesPage(commands: Commands, kind: GitlabEntity, iid: number, page: number) {
  const output = await commands.gitlabApi(`${entityPath(kind, iid)}/notes?sort=asc&order_by=created_at&per_page=${PAGE_SIZE}&page=${page}`, '--include')
  const separator = /\r?\n\r?\n/.exec(output)
  if (!separator) throw new Error('GitLab returned no pagination headers; history is incomplete')
  const headers = output.slice(0, separator.index)
  const listed = z.array(z.unknown()).parse(JSON.parse(output.slice(separator.index + separator[0].length)))
  const tally = { skipped: 0 }
  const notes = validItems(NoteSchema, listed, tally)
  const messages = notes.flatMap(note => { const message = noteMessage(note); return message ? [message] : [] })
  const header = /^x-next-page:[ \t]*([^\r\n]*)/im.exec(headers)
  const nextText = header ? header[1]!.trim() : listed.length === PAGE_SIZE ? String(page + 1) : ''
  const nextPage = nextText ? positiveId(nextText) : undefined
  if (nextPage !== undefined && nextPage !== page + 1) throw new Error('GitLab pagination did not advance to the next page; history is incomplete')
  return { messages, nextPage, skipped: tally.skipped }
}

/** Reads a non-hidden file or directory listing from the GitLab project's default branch. */
export async function readGitlabRepositoryPath(commands: Commands, path: string, kind: 'file' | 'directory'): Promise<string> {
  if (path.includes('\\')) throw new Error('Only non-hidden repository source paths are available')
  const parts = path.split('/').filter(part => part && part !== '.')
  if ((kind === 'file' && !parts.length) || parts.some(part => part === '..' || part.startsWith('.') || part === 'node_modules')) {
    throw new Error('Only non-hidden repository source paths are available')
  }
  if (kind === 'file') {
    const encoded = parts.map(encodeURIComponent).join('%2F')
    return commands.gitlabApi(`repository/files/${encoded}/raw?ref=HEAD`)
  }
  const entries = await commands.gitlabPages(z.looseObject({ name: z.string(), type: z.string().optional() }),
    `repository/tree?${parts.length ? `path=${encodeURIComponent(parts.join('/'))}&` : ''}ref=HEAD&per_page=100`)
  return entries.map(entry => entry.name).filter(name => !name.startsWith('.') && name !== 'node_modules').sort().join('\n')
}

/** Reads one bounded GitLab resource. Paths are relative to the configured project and always begin with `gitlab/`. */
export async function readGitlab(commands: Commands, resource: string): Promise<unknown> {
  const [rawPath = '', query] = resource.split('?', 2)
  const parts = rawPath.split('/').filter(Boolean)
  if (parts[0] !== 'gitlab' || parts.some(part => part === '.' || part === '..' || !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new Error('Unsupported GitLab resource path')
  }
  const pageSuffix = query ? `?${query}` : ''
  if (parts[1] === 'issues' || parts[1] === 'merge_requests') {
    const kind: GitlabEntity = parts[1] === 'issues' ? 'issue' : 'mr'
    const iid = Number(parts[2])
    if (!Number.isInteger(iid) || iid <= 0) throw new Error('GitLab resource needs a positive IID')
    const base = entityPath(kind, iid)
    const tail = parts.slice(3)
    if (!tail.length) {
      const entity = kind === 'issue' ? await commands.gitlabApi(IssueSchema, `${base}${pageSuffix}`) : await commands.gitlabApi(MergeRequestSchema, `${base}${pageSuffix}`)
      return { messages: [entityMessage(entity)], body: { status: kind, entity }, status: kind } satisfies ReadResult
    }
    if (tail[0] === 'notes' && tail.length === 1) {
      const { messages, nextPage, skipped } = await notesPage(commands, kind, iid, notesPageNumber(query))
      const body = { status: `${kind}_notes`, messages, ...(skipped ? { skipped } : {}),
        ...(nextPage === undefined ? {} : { next_resource: `gitlab/${base}/notes?page=${nextPage}` }) }
      return { messages, body, status: body.status } satisfies ReadResult
    }
    if (kind === 'mr' && tail.length === 1 && tail[0] === 'diffs') {
      const changes = await commands.gitlabApi(ChangesSchema, `${base}/changes${pageSuffix}`)
      return { messages: [], body: { status: 'diffs', ...bodyOf(changes) }, status: 'diffs' } satisfies ReadResult
    }
    if (kind === 'mr' && tail.length === 1 && tail[0] === 'pipelines') {
      const pipelines = await commands.gitlabPages(PipelineSchema, `${base}/pipelines${pageSuffix}`)
      return { messages: [], body: { status: 'pipelines', pipelines }, status: 'pipelines' } satisfies ReadResult
    }
    if (kind === 'mr' && tail.length === 1 && tail[0] === 'approvals') {
      const approvals = await commands.gitlabApi(ApprovalsSchema, `${base}/approvals${pageSuffix}`)
      return { messages: [], body: { status: 'approvals', ...bodyOf(approvals) }, status: 'approvals' } satisfies ReadResult
    }
    if (tail[0] === 'notes' && tail.length === 2) {
      const noteId = Number(tail[1])
      if (!Number.isInteger(noteId) || noteId <= 0) throw new Error('GitLab note resource needs a positive ID')
      const note = await commands.gitlabApi(NoteSchema, `${base}/notes/${noteId}${pageSuffix}`)
      const message = noteMessage(note)
      return { messages: message ? [message] : [], body: { status: `${kind}_note`, note }, status: `${kind}_note` } satisfies ReadResult
    }
    throw new Error('Unsupported GitLab Issue or merge request resource')
  }
  if (parts[1] === 'pipelines' && parts[2] && parts[3] === 'jobs' && parts.length === 4) {
    const pipelineId = Number(parts[2])
    if (!Number.isInteger(pipelineId) || pipelineId <= 0) throw new Error('GitLab pipeline resource needs a positive ID')
    const jobs = await commands.gitlabPages(JobSchema, `pipelines/${pipelineId}/jobs${pageSuffix}`)
    return { messages: [], body: { status: 'pipeline_jobs', pipelineId, jobs }, status: 'pipeline_jobs' } satisfies ReadResult
  }
  throw new Error('Unsupported GitLab resource path')
}

/** Thread context adapter; each thread read loads one notes page, with its description first on page one. */
export const gitlabThreadContext: ThreadContext<Record<string, unknown>> = {
  messageId: trigger => trigger.meta.noteId !== undefined ? String(trigger.meta.noteId) : trigger.url ?? '',
  read: async (commands, trigger, part, cursor) => {
    const entity: GitlabEntity = trigger.meta.entity === 'mr' || trigger.meta.kind === 'mr' || trigger.meta.isMr === true ? 'mr' : 'issue'
    const iid = Number(trigger.meta.iid)
    if (trigger.source !== 'gitlab' || !Number.isSafeInteger(iid) || iid <= 0) throw new Error('GitLab Trigger has no Issue or merge request IID')
    if (part !== 'thread' && cursor !== undefined) throw new Error('GitLab root and parent context do not accept a cursor')
    const page = cursorPage(cursor, entity, iid)
    const base = `gitlab/${entityPath(entity, iid)}`
    try {
      if (part === 'root') return await readGitlab(commands, base) as ReadResult
      if (part === 'parent') {
        const parent = Number(trigger.meta.replyTo)
        if (!Number.isSafeInteger(parent) || parent <= 0) return { messages: [], body: { status: 'parent_missing' }, status: 'parent_missing' }
        return await readGitlab(commands, `${base}/notes/${parent}`) as ReadResult
      }
      const root = page === 1 ? await readGitlab(commands, base) as ReadResult : undefined
      const notes = await notesPage(commands, entity, iid, page)
      const messages = [...root?.messages ?? [], ...notes.messages]
      const next = notes.nextPage === undefined ? undefined : notesCursor(entity, iid, notes.nextPage)
      return { messages, next, status: `${entity}_thread`, body: { status: `${entity}_thread`, messages,
        ...(notes.skipped ? { skipped: notes.skipped } : {}) } }
    } catch (error) {
      if (error instanceof CliError && [403, 404, 410].includes(error.code ?? 0)) {
        const reason = error.code === 410 ? 'deleted' : 'unavailable or inaccessible'
        throw new Error(`GitLab ${part} context is ${reason} (HTTP ${error.code}); history is incomplete and retained trigger text is still readable`)
      }
      throw error
    }
  },
}
