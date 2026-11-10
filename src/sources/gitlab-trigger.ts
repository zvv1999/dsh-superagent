/** Normalizes GitLab Issues, merge requests, notes, and pipeline transitions into domain Triggers. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'
import { escapeRegExp, sameName } from '../infra/text.ts'

export const SOURCE = 'gitlab'
export type GitlabEntity = 'issue' | 'mr'

/** Hidden marker appended to every outbound message; any message carrying it is never re-ingested. */
export const SYSTEM_MARKER = '<!-- dsh-superagent:'

/** GitLab API user, normalised to the username used by Policy and ActorRef. */
export const UserSchema = z.looseObject({
  username: z.string().nullish(), name: z.string().nullish(), bot: z.boolean().optional(), state: z.string().optional(),
}).nullish().transform(user => user ?? { username: 'ghost' })
export type GitlabUser = z.infer<typeof UserSchema>

/** A GitLab issue as returned by both the collection and detail endpoints. */
export const IssueSchema = z.looseObject({
  iid: z.number(), title: z.string(), description: z.string().nullish(), state: z.string(),
  web_url: z.string(), created_at: z.string(), updated_at: z.string(), author: UserSchema,
  project_id: z.number().optional(), user_notes_count: z.number().optional(),
})
export type GitlabIssue = z.infer<typeof IssueSchema>

/** A GitLab merge request, including source/target project and branch fields used for ticket ownership. */
export const MergeRequestSchema = IssueSchema.extend({
  source_branch: z.string().nullish().optional(), target_branch: z.string().nullish().optional(), sha: z.string().nullish().optional(),
  merge_commit_sha: z.string().nullish().optional(), merged_at: z.string().nullish().optional(), closed_at: z.string().nullish().optional(),
  merged_by: UserSchema.optional(), source_project_id: z.number().nullish().optional(), target_project_id: z.number().nullish().optional(),
  source_project: z.looseObject({ id: z.number().optional(), path_with_namespace: z.string().optional(), web_url: z.string().optional() }).nullish().optional(),
  target_project: z.looseObject({ id: z.number().optional(), path_with_namespace: z.string().optional(), web_url: z.string().optional() }).nullish().optional(),
  detailed_merge_status: z.string().nullish().optional(), merge_status: z.string().nullish().optional(),
  draft: z.boolean().optional(), pipeline: z.unknown().nullish().optional(),
})
export type MergeRequest = z.infer<typeof MergeRequestSchema>

/** A discussion note. System notes are retained for context reads but never become Triggers. */
export const NoteSchema = z.looseObject({
  id: z.number(), body: z.string().nullish(), author: UserSchema,
  created_at: z.string().nullish(), updated_at: z.string().nullish(),
  system: z.boolean().optional(), noteable_type: z.string().nullish(),
  resolvable: z.boolean().optional(), resolved: z.boolean().optional(),
  web_url: z.string().nullish(), in_reply_to_id: z.number().nullish(),
})
export type GitlabNote = z.infer<typeof NoteSchema>

/** A GitLab pipeline summary. Jobs are read separately when a context resource asks for them. */
export const PipelineSchema = z.looseObject({
  id: z.number(), status: z.string(), ref: z.string().nullish(), sha: z.string().nullish(),
  web_url: z.string().nullish(), created_at: z.string().nullish(), updated_at: z.string().nullish(),
  source: z.string().nullish(), name: z.string().nullish(),
})
export type GitlabPipeline = z.infer<typeof PipelineSchema>

export const JobSchema = z.looseObject({
  id: z.number(), name: z.string(), status: z.string(), stage: z.string().nullish(),
  ref: z.string().nullish(), web_url: z.string().nullish(), started_at: z.string().nullish(),
  finished_at: z.string().nullish(), failure_reason: z.string().nullish(),
})
export type GitlabJob = z.infer<typeof JobSchema>

export const gitlabThread = (kind: GitlabEntity, iid: number): string => `${SOURCE}:${kind}:${iid}`
export const gitlabChannel = (kind: GitlabEntity, iid: number, url?: string): ChannelRef => ({
  source: SOURCE, thread: gitlabThread(kind, iid), address: { kind, iid: String(iid), ...(url ? { url } : {}) },
})

/** Builds a GitLab web URL for the configured host and repository path. */
export const gitlabPage = (hostname: string, repository: string, kind: GitlabEntity, iid: number): string => {
  const host = hostname.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  return `https://${host}/${repository.replace(/^\/+|\/+$/g, '')}/-/${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}`
}

/** Parses a GitLab web URL for one configured project and returns its Issue/MR identity and optional note ID. */
export function gitlabAddress(url: string, hostname: string, repository: string):
  { kind: GitlabEntity; iid: number; noteId?: number } | undefined {
  const host = hostname.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  const path = repository.replace(/^\/+|\/+$/g, '')
  const address = new RegExp(`^https://${escapeRegExp(host)}/${escapeRegExp(path)}/-/(issues|merge_requests)/(\\d+)(?:#note_(\\d+))?/?$`, 'i')
  const match = address.exec(url)
  if (!match) return undefined
  return { kind: match[1]!.toLowerCase() === 'issues' ? 'issue' : 'mr', iid: Number(match[2]), ...match[3] ? { noteId: Number(match[3]) } : {} }
}

/** True only when the first line begins with `/superagent`, allowing leading horizontal whitespace. */
export function explicitCommand(text: string): boolean {
  if (hasSystemMarker(text)) return false
  const first = text.split(/\r?\n/, 1)[0] ?? ''
  return /^[ \t]*\/superagent(?:[ \t]|$)/.test(first)
}

/** Returns true for the hidden marker used by outbound replies and old marker variants. */
export function hasSystemMarker(text: string): boolean {
  return /<!--[ \t]*dsh-superagent(?:[:\-]|\s|>)/i.test(text)
}

/** GitLab's bot flag is absent on some service accounts, so the username suffix is also checked. */
export function isHumanUser(user: GitlabUser): boolean {
  const username = user.username ?? ''
  return user.bot !== true && !/\[bot\]$/i.test(username)
}

const identity = (user: GitlabUser) => ({ actor: { source: SOURCE, id: user.username ?? 'ghost' }, human: isHumanUser(user) })
const bodyText = (title: string, body: string | null | undefined): string => [title, body ?? ''].filter(Boolean).join('\n\n')
const atOf = (value: { updated_at?: string | null; created_at?: string | null }): string =>
  value.updated_at ?? value.created_at ?? new Date().toISOString()

/** Trigger for a newly opened or edited Issue description; callers should apply explicitCommand before receiving it. */
export function issueTrigger(issue: GitlabIssue): Trigger {
  const body = issue.description ?? ''
  return { id: key('gitlab-issue', String(issue.iid), issue.updated_at), source: SOURCE,
    threads: [{ source: SOURCE, id: `issue:${issue.iid}` }], ...identity(issue.author), at: issue.created_at,
    text: bodyText(issue.title, body), ...(explicitCommand(body) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel('issue', issue.iid, issue.web_url), url: issue.web_url,
    meta: { kind: 'issue', iid: issue.iid, ...(issue.project_id !== undefined ? { projectId: issue.project_id } : {}) } }
}

/** Trigger for a newly opened or edited merge request description; callers should apply explicitCommand before receiving it. */
export function mergeRequestTrigger(mr: MergeRequest): Trigger {
  const body = mr.description ?? ''
  return { id: key('gitlab-mr', String(mr.iid), mr.updated_at), source: SOURCE,
    threads: [{ source: SOURCE, id: `mr:${mr.iid}` }], ...identity(mr.author), at: mr.created_at,
    text: bodyText(mr.title, body), ...(explicitCommand(body) ? { addressed: 'mention' as const } : {}),
    channel: gitlabChannel('mr', mr.iid, mr.web_url), url: mr.web_url,
    meta: { kind: 'mr', iid: mr.iid, isMr: true, ...(mr.project_id !== undefined ? { projectId: mr.project_id } : {}),
      ...(mr.author.username ? { mrAuthor: mr.author.username } : {}) } }
}

/** Trigger for an explicit `/superagent` Note on an Issue or merge request. */
export function noteTrigger(note: GitlabNote, ref: { kind: GitlabEntity; iid: number; url?: string }): Trigger {
  const at = atOf(note)
  return { id: key('gitlab-note', ref.kind, String(ref.iid), String(note.id), note.updated_at ?? ''), source: SOURCE,
    threads: [{ source: SOURCE, id: `${ref.kind}:${ref.iid}` }], ...identity(note.author), at, text: note.body ?? '',
    ...(explicitCommand(note.body ?? '') ? { addressed: 'mention' as const } : {}), channel: gitlabChannel(ref.kind, ref.iid, note.web_url ?? ref.url),
    ...(note.web_url ?? ref.url ? { url: note.web_url ?? ref.url } : {}),
    meta: { kind: 'comment', entity: ref.kind, iid: ref.iid, noteId: note.id,
      ...(note.in_reply_to_id !== undefined ? { replyTo: note.in_reply_to_id } : {}) } }
}

/** Trigger for a changed MR pipeline; it is machine-authored and is admitted only when pipeline observation is enabled. */
export function pipelineTrigger(pipeline: GitlabPipeline, mr: MergeRequest | undefined, revision: number, summary: string): Trigger {
  const iid = mr?.iid
  const thread = iid === undefined ? { source: SOURCE, id: `pipeline:${pipeline.id}` } : { source: SOURCE, id: `mr:${iid}` }
  return { id: key('gitlab-pipeline', String(iid ?? pipeline.id), String(revision)), source: SOURCE, threads: [thread],
    actor: { source: SOURCE, id: '' }, human: false, at: atOf(pipeline), text: summary,
    ...(mr ? { channel: gitlabChannel('mr', mr.iid, mr.web_url), url: mr.web_url } : {}),
    meta: { kind: 'pipeline', pipelineId: pipeline.id, revision, status: pipeline.status,
      ...(iid === undefined ? {} : { iid, entity: 'mr', isMr: true }), ...(pipeline.sha ? { sha: pipeline.sha } : {}) } }
}

export type GitlabPullRef = { iid: number; kind: GitlabEntity; url?: string }

/** Returns a stable trigger ID for a note parent when a source can derive one without another network read. */
export function noteTriggerId(note: Pick<GitlabNote, 'id' | 'updated_at'>, ref: GitlabPullRef): string {
  return key('gitlab-note', ref.kind, String(ref.iid), String(note.id), note.updated_at ?? '')
}

/** Case-insensitive comparison for GitLab usernames and project paths. */
export { sameName }