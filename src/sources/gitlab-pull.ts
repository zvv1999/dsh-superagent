/** Merge request binding, lifecycle observation, and terminal notices for GitLab-backed tickets. */
import { key, liveTicket, type Follow, type OutboundMessage, type ThreadFact, type Ticket } from '../core/index.ts'
import type { Deployment } from '../deployment.ts'
import { sameName } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import { gitlabPage, gitlabThread, MergeRequestSchema, SOURCE, type MergeRequest } from './gitlab-trigger.ts'

export type { MergeRequest } from './gitlab-trigger.ts'
export { MergeRequestSchema } from './gitlab-trigger.ts'

const AUTO_MERGE_ON: ThreadFact = { label: { zh: '自动合并', en: 'Auto-merge' }, value: { zh: '已开启', en: 'on' } }

/** Reads one MR from the configured GitLab project. */
export const readMergeRequest = async (ctx: SourceContext, iid: number, signal?: AbortSignal): Promise<MergeRequest> =>
  ({ ...await ctx.commands.withSignal(signal).gitlabApi(MergeRequestSchema, `merge_requests/${iid}`), iid })

const threadIid = (thread: string): number | undefined => thread.startsWith(`${SOURCE}:mr:`) ? Number(thread.slice(`${SOURCE}:mr:`.length)) : undefined
export const mergeRequestsOf = (ticket: Pick<Ticket, 'follows'>, open = false): number[] =>
  (ticket.follows ?? []).filter(item => !open || !item.closed).flatMap(item => threadIid(item.thread) ?? [])
export const mergeRequestOf = (ticket: Pick<Ticket, 'follows'>): number | undefined => mergeRequestsOf(ticket, true).at(-1) ?? mergeRequestsOf(ticket).at(-1)
/** Card/runtime alias matching GitHub's pullOf helper. */
export const mrOf = mergeRequestOf

/** True only for an MR opened by the configured agent from the configured project on this ticket's branch. */
export function agentMergeRequest(mr: MergeRequest, deployment: Pick<Deployment, 'repository' | 'gitlab'>): boolean {
  const gitlab = deployment.gitlab
  if (!gitlab || !sameName(mr.author.username ?? '', gitlab.login)) return false
  const sourceProject = mr.source_project?.path_with_namespace ?? ''
  const sourceProjectId = mr.source_project_id ?? mr.source_project?.id
  const targetProjectId = mr.target_project_id ?? mr.project_id
  return (sourceProject ? sameName(sourceProject, deployment.repository) : sourceProjectId === gitlab.projectId)
    && sourceProjectId === gitlab.projectId && targetProjectId === gitlab.projectId
}

/** True when an MR source branch's final segment is the ticket's short execution name. */
export const ticketBranch = (ticket: Pick<Ticket, 'execution'>, ref: string | null | undefined): boolean =>
  !!ticket.execution?.name && !!ref && ref.split('/').at(-1) === ticket.execution.name

const belongsToConfiguredProject = (ctx: SourceContext, mr: MergeRequest): boolean => {
  const gitlab = ctx.deployment.gitlab
  if (!gitlab) return false
  const target = mr.target_project_id ?? mr.project_id
  const source = mr.source_project_id ?? mr.source_project?.id
  const path = mr.target_project?.path_with_namespace ?? ctx.deployment.repository
  return target === gitlab.projectId && source === gitlab.projectId && sameName(path, ctx.deployment.repository)
}
const originMr = (ctx: SourceContext, ticketId: string, mr: MergeRequest): boolean => {
  const ticket = ctx.tickets.get(ticketId)
  const trigger = ticket && ctx.triggers.get(ticket.origin.triggerId)
  const onMr = trigger?.meta.kind === 'mr' || (trigger?.meta.kind === 'comment' && trigger.meta.entity === 'mr')
  return !!trigger && trigger.source === SOURCE && onMr && trigger.meta.iid === mr.iid && belongsToConfiguredProject(ctx, mr)
}
const merged = (mr: MergeRequest): boolean => mr.state === 'merged' || !!mr.merged_at
const ended = (mr: MergeRequest): boolean => mr.state === 'closed' || merged(mr)

/** Validates and binds an MR to a ticket, rejecting cross-project and wrong-branch MRs. */
export function claimMergeRequest(ctx: SourceContext, ticketId: string, mr: MergeRequest): string | undefined {
  const ticket = ctx.tickets.get(ticketId)
  if (!ticket || !liveTicket(ticket)) return 'Ticket ended because its MR was closed'
  if (!belongsToConfiguredProject(ctx, mr)) return 'MR does not belong to the configured GitLab project'
  const started = originMr(ctx, ticketId, mr)
  const opened = agentMergeRequest(mr, ctx.deployment) && ticketBranch(ticket, mr.source_branch)
  if (!started && !opened) {
    const account = ctx.deployment.gitlab?.login ?? 'the configured GitLab account'
    return `MR does not belong to this ticket: use the source MR or an MR by ${account} from a branch whose last path segment is DSH_SUPERAGENT_NAME`
  }
  const owner = ctx.tickets.open().find(item => mergeRequestsOf(item, true).includes(mr.iid))
  if (owner && owner.id !== ticketId) return 'MR already belongs to another active ticket'
  const follow = ticket.follows?.find(item => item.thread === gitlabThread('mr', mr.iid))
  if (!ended(mr) && (mr.state === 'opened' || mr.state === 'locked') && (!follow || follow.closed || (opened && !follow.own))) bind(ctx, ticketId, mr, opened)
  return undefined
}

/** Reconciles an MR's open/merged/closed state and auto-binds a unique matching agent branch. */
export async function observeMergeRequest(ctx: SourceContext, mr: MergeRequest): Promise<boolean> {
  const terminal = ended(mr)
  if (terminal) closeMergeRequest(ctx, mr)
  else {
    const candidates = agentMergeRequest(mr, ctx.deployment) ? ctx.tickets.open().filter(ticket => ticketBranch(ticket, mr.source_branch)) : []
    const ticket = candidates.length === 1 ? candidates[0]! : undefined
    const reopened = ticket?.follows?.some(item => item.thread === gitlabThread('mr', mr.iid) && item.closed)
    if (ticket && (reopened || mergeRequestsOf(ticket, true).every(iid => iid === mr.iid))) claimMergeRequest(ctx, ticket.id, mr)
  }
  const thread = gitlabThread('mr', mr.iid)
  ctx.threads.patch(thread, { iid: mr.iid, isMr: true, url: mr.web_url, title: mr.title,
    mrAuthor: mr.author.username ?? '', sourceBranch: mr.source_branch ?? '', targetBranch: mr.target_branch ?? '',
    projectId: mr.project_id ?? mr.target_project_id ?? null })
  ctx.threads.describe(thread, { facts: { autoMerge: !terminal && mr.detailed_merge_status === 'merge_when_pipeline_succeeds' ? AUTO_MERGE_ON : null } })
  return terminal
}

function bind(ctx: SourceContext, ticketId: string, mr: MergeRequest, own: boolean): void {
  ctx.atomic(() => {
    ctx.tickets.bindThread(ticketId, { source: SOURCE, id: `mr:${mr.iid}` }, own)
    ctx.threads.patch(gitlabThread('mr', mr.iid), { iid: mr.iid, isMr: true, url: mr.web_url, title: mr.title,
      mrAuthor: mr.author.username ?? '', sourceBranch: mr.source_branch ?? '', targetBranch: mr.target_branch ?? '',
      projectId: mr.project_id ?? mr.target_project_id ?? null })
  })
}

/** Reports a merged or closed MR once; the core decides when the ticket ends after all own MRs close. */
function closeMergeRequest(ctx: SourceContext, mr: MergeRequest): void {
  if (!ctx.tickets.open().some(ticket => mergeRequestsOf(ticket, true).includes(mr.iid))) return
  const at = mr.merged_at ?? mr.closed_at ?? mr.updated_at
  ctx.tickets.threadClosed({ source: SOURCE, id: `mr:${mr.iid}` }, merged(mr) ? 'merged' : 'closed', at)
}

/** Builds idempotent notices for non-GitLab channels when a ticket ends with its GitLab MR. */
export function mrEndNotices(ticket: Ticket, request: string, deployment: Pick<Deployment, 'repository' | 'gitlab'>): OutboundMessage[] {
  const gitlab = deployment.gitlab
  const outcome = ticket.ended?.outcome
  if (!gitlab || (outcome !== 'merged' && outcome !== 'closed')) return []
  const follows = (ticket.follows ?? []).filter(item => item.closed && threadIid(item.thread) !== undefined)
  const latest = (items: Follow[]) => items.slice().sort((a, b) => b.closed!.at.localeCompare(a.closed!.at))[0]
  const follow = latest(follows.filter(item => item.own)) ?? latest(follows)
  if (!follow) return []
  const iid = threadIid(follow.thread)!
  const url = gitlabPage(gitlab.hostname, deployment.repository, 'mr', iid)
  const chinese = /\p{Script=Han}/u.test(request) && !/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(request)
  const text = chinese
    ? outcome === 'merged' ? `[MR !${iid}](${url}) 已合并。` : `[MR !${iid}](${url}) 已关闭，未合并。`
    : outcome === 'merged' ? `[MR !${iid}](${url}) has merged.` : `[MR !${iid}](${url}) was closed without merging.`
  return ticket.channels.filter(channel => channel.source !== SOURCE).map(channel => ({
    id: key('mr-terminal', String(iid), channel.source, JSON.stringify(channel.address), outcome), channel, text, kind: 'notice', ticketId: ticket.id,
  }))
}
