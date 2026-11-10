/** GitLab Source kind, explicit-command polling loops, MR pipeline observation, and Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { key, type Thread } from '../core/index.ts'
import { GitlabAccountsSchema } from '../deployment.ts'
import type { Tally } from '../infra/commands.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import { cursorAt, pause, pollThreads as pollEach } from './poll.ts'
import { gitlabLink, sendGitlab } from './gitlab-channel.ts'
import { IssueSchema, MergeRequestSchema, NoteSchema, PipelineSchema, explicitCommand, hasSystemMarker,
  gitlabThread, issueTrigger, mergeRequestTrigger, noteTrigger, pipelineTrigger, SOURCE, type GitlabEntity, type GitlabIssue, type MergeRequest,
  type GitlabPipeline } from './gitlab-trigger.ts'
import { gitlabThreadContext } from './gitlab-read.ts'
import { mergeRequestsOf, observeMergeRequest, readMergeRequest } from './gitlab-pull.ts'

export { claimMergeRequest, mergeRequestOf, mrOf, readMergeRequest, mrEndNotices } from './gitlab-pull.ts'
export { readGitlab, readGitlabRepositoryPath } from './gitlab-read.ts'
export { explicitCommand, type MergeRequest } from './gitlab-trigger.ts'

const GitlabConfigSchema = GitlabAccountsSchema.extend({
  pollSeconds: z.number().int().min(30).max(3600).default(60),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  /** Pipeline changes are polled for bound MRs and admitted when this observation row is enabled. */
  observePipelines: z.boolean().default(false),
}).strict()
export type GitlabConfig = z.infer<typeof GitlabConfigSchema>

type Scope = 'issues' | 'mrs' | 'comments' | 'pipelines'
const scopeOf = (meta: Record<string, unknown>): Scope | undefined => {
  if (meta.kind === 'pipeline') return 'pipelines'
  if (meta.kind === 'issue') return 'issues'
  if (meta.kind === 'mr') return 'mrs'
  if (meta.kind === 'comment') return 'comments'
  return undefined
}
const scopeRow = (meta: Record<string, unknown>): Scope | undefined => scopeOf(meta)
const configuredProject = (ctx: SourceContext, _config: GitlabConfig): boolean => !!ctx.deployment.gitlab

export const gitlabKind: SourceKind<GitlabConfig> = {
  kind: SOURCE,
  title: { zh: 'GitLab', en: 'GitLab' },
  description: { zh: '智能体的 GitLab 账号；轮询 Issue、合并请求、评论和流水线，只接收正文开头的 /superagent 命令。',
    en: 'The agent\'s GitLab account; polls Issues, merge requests, notes and pipelines, accepting only /superagent at the start of a body.' },
  schema: GitlabConfigSchema,
  fields: [
    { key: 'repository', type: 'text', pattern: '(?:[A-Za-z0-9_.\\-]+/)+[A-Za-z0-9_.\\-]+', label: { zh: '监听的仓库', en: 'Repository' },
      hint: { zh: '写作 group/project，例如 example/widgets。', en: 'Write group/project, for example example/widgets.' } },
    { key: 'hostname', type: 'text', label: { zh: 'GitLab 地址', en: 'GitLab host' } },
    { key: 'cli', type: 'text', label: { zh: '智能体的 GitLab CLI', en: 'Agent GitLab CLI' },
      hint: { zh: '命令名或绝对路径，通常是登录智能体账号的 glab 包装脚本。', en: 'A command name or absolute path, usually a glab wrapper signed in to the agent account.' } },
    { key: 'pollSeconds', type: 'number', advanced: true, min: 30, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' } },
    { key: 'observePipelines', type: 'switch', label: { zh: '接收 MR 流水线变化', en: 'Receive MR pipeline changes' },
      hint: { zh: '流水线状态变化会进入已绑定 MR 的线程；打开后交给策略接收表。', en: 'Pipeline changes enter bound MR threads and are admitted through the Policy table when enabled.' } },
  ],
  facts: (deployment): Record<string, Localized | string> => {
    if (!deployment?.gitlab) return {}
    return { cli: { zh: `当前账号 @${deployment.gitlab.login}`, en: `Current account @${deployment.gitlab.login}` },
      hostname: deployment.gitlab.hostname, projectId: String(deployment.gitlab.projectId) }
  },
  scope: ({ meta }, config) => {
    const row = scopeRow(meta)
    return { listened: true, observed: row === 'pipelines' && config.observePipelines, ...row ? { row } : {} }
  },
  health: ['gitlab'],
  channel: { send: sendGitlab, link: gitlabLink },
  threadContext: gitlabThreadContext,
  find: query => {
    const text = query.trim()
    const explicit = /^!([1-9]\d*)$/.exec(text)
    if (explicit && Number.isSafeInteger(Number(explicit[1]))) return { threads: [gitlabThread('mr', Number(explicit[1]))], terms: [] }
    const issue = /^#([1-9]\d*)$/.exec(text)
    if (issue && Number.isSafeInteger(Number(issue[1]))) return { threads: [gitlabThread('issue', Number(issue[1]))], terms: [] }
    // The find contract has no deployment/configuration, so URLs stay with the registry's retained-URL search.
    return { threads: [], terms: [] }
  },
  policy: {
    schema: z.object({ allowed: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+$/), name: z.string().optional() }).strict()).default([]),
      bots: z.array(z.object({ id: z.string().regex(/^[A-Za-z0-9_.-]+(?:\[bot\])?$/), name: z.string().optional() }).strict()).optional() }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 GitLab 账号', en: 'GitLab accounts that may originate work' },
      columns: [{ key: 'id', type: 'text', label: { zh: '账号', en: 'Account' }, pattern: '[A-Za-z0-9_.\\-]+' }] }],
    explicit: { zh: '名单里的账号在 Issue、MR 或评论正文开头使用 /superagent。', en: 'An account on the list starts an Issue, MR, or note body with /superagent.' },
    rows(config) {
      const parsed = GitlabConfigSchema.partial().parse(config)
      const row = (id: Scope, label: Localized) => ({ id, label, note: { zh: id === 'pipelines' && parsed.observePipelines ? '接收' : '仅 /superagent', en: id === 'pipelines' && parsed.observePipelines ? 'Received' : '/superagent only' },
        cells: { listedUnaddressed: id === 'pipelines' && !!parsed.observePipelines, unlistedAddressed: true, unlistedUnaddressed: id === 'pipelines' && !!parsed.observePipelines } })
      return [row('issues', { zh: 'Issue', en: 'Issues' }), row('mrs', { zh: '合并请求', en: 'Merge requests' }), row('comments', { zh: '评论', en: 'Comments' }),
        row('pipelines', { zh: 'MR 流水线', en: 'MR pipelines' })]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_GITLAB_HOST', description: { zh: 'GitLab 地址；所有 GitLab 操作用这个地址', en: 'GitLab host; use this host for every GitLab operation' } },
      { key: 'DSH_SUPERAGENT_GITLAB_PROJECT_ID', description: { zh: 'GitLab 项目 ID', en: 'GitLab project ID' } },
      { key: 'DSH_SUPERAGENT_GITLAB_REPOSITORY', description: { zh: 'GitLab 仓库路径，group/project', en: 'GitLab repository path, group/project' } },
      { key: 'DSH_SUPERAGENT_GITLAB_ACCOUNT', description: { zh: '智能体的 GitLab 账号；所有 GitLab 操作用它登录的 CLI', en: 'The agent GitLab account; use its signed-in CLI for every GitLab operation' } },
      { key: 'DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL', description: { zh: '智能体账号的提交邮箱', en: 'Commit email of the GitLab agent account' } },
      { key: 'DSH_SUPERAGENT_GITLAB_NUMBER', description: { zh: '接下工单的 GitLab Issue 或 MR IID', en: 'The GitLab Issue or MR IID that started the ticket' } },
      { key: 'DSH_SUPERAGENT_GITLAB_MR_HEAD', description: { zh: '接下工单的 MR head 引用 refs/merge-requests/<IID>/head', en: 'The source ref refs/merge-requests/<IID>/head of the originating MR' } },
    ],
    values: ({ deployment, config, trigger }) => {
      const gitlab = deployment.gitlab
      const iid = trigger?.threads[0]?.source === SOURCE ? Number(trigger.meta.iid) || 0 : 0
      const mr = iid && (trigger?.meta.kind === 'mr' || trigger?.meta.entity === 'mr' || trigger?.meta.isMr === true)
      return { DSH_SUPERAGENT_GITLAB_HOST: gitlab?.hostname ?? config.hostname, DSH_SUPERAGENT_GITLAB_PROJECT_ID: String(gitlab?.projectId ?? ''),
        DSH_SUPERAGENT_GITLAB_REPOSITORY: deployment.repository || config.repository, DSH_SUPERAGENT_GITLAB_ACCOUNT: gitlab?.login ?? '',
        DSH_SUPERAGENT_GITLAB_COMMIT_EMAIL: gitlab?.noreply ?? '', DSH_SUPERAGENT_GITLAB_NUMBER: iid ? String(iid) : '',
        DSH_SUPERAGENT_GITLAB_MR_HEAD: mr ? `refs/merge-requests/${iid}/head` : '' }
    },
  },
}

export const name = 'dsh-superagent-gitlab'
export const inject = ['orchestrator']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(gitlabKind), 'gitlab: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, gitlabKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal).catch((error: unknown) => { source.report('gitlab', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}

/** Returns an error health once `failures` consecutive polls fail. */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let interval = 60
  let failures = 0
  await ctx.ready
  if (!ctx.configured()) { ctx.report('gitlab', health('paused', 'setupPending')); return }
  if (!ctx.deployment.gitlab) { ctx.report('gitlab', health('paused', 'sourceOff')); return }
  while (!signal.aborted) {
    const config = ctx.config<GitlabConfig>(SOURCE)
    try {
      if (config) interval = await pollRound(ctx, signal)
      else ctx.report('gitlab', health('paused', 'sourceOff'))
      failures = 0
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('gitlab', failed)
    }
    await pause(Math.max(interval, ctx.config<GitlabConfig>(SOURCE)?.pollSeconds ?? 60) * 1000, signal)
  }
}

interface Round {
  started: string; signal?: AbortSignal; failures: string[]; dropped: string[]; read: Set<string>; events: number; tally: Tally
  mrs: Map<number, Promise<MergeRequest>>
}
const newRound = (signal?: AbortSignal): Round => ({ started: new Date().toISOString(), signal, failures: [], dropped: [], read: new Set(), events: 0, tally: { skipped: 0 }, mrs: new Map() })
const stopped = (ctx: SourceContext, round: Round): boolean => !!round.signal?.aborted || !ctx.config(SOURCE)
const entityPath = (kind: GitlabEntity, iid: number): string => `${kind === 'mr' ? 'merge_requests' : 'issues'}/${iid}`
const notePath = (kind: GitlabEntity, iid: number): string => `${entityPath(kind, iid)}/notes`
const fresh = (at: string | null | undefined, since: string): boolean => Number.isFinite(Date.parse(at ?? '')) && Date.parse(at!) >= Date.parse(since)
const projectOk = (ctx: SourceContext, projectId: number | undefined): boolean => {
  const id = ctx.deployment.gitlab?.projectId ?? 0
  return !id || projectId === undefined || id === projectId
}
const recordFailure = (ctx: SourceContext, round: Round, thread: string, error: unknown): void => {
  ctx.threads.patch(thread, { pollError: String(error) })
  round.failures.push(`${thread}: ${String(error)}`)
}
const threadName = (ctx: SourceContext, kind: GitlabEntity, iid: number, title: string, url: string): void => {
  const thread = gitlabThread(kind, iid)
  ctx.threads.patch(thread, { iid, title, url, isMr: kind === 'mr' })
  ctx.threads.describe(thread, { label: `${kind === 'mr' ? '!' : '#'}${iid} ${title}`, facts: { number: { value: `${kind === 'mr' ? '!' : '#'}${iid}` } } })
}

async function intakeNotes(ctx: SourceContext, round: Round, kind: GitlabEntity, iid: number, url: string, since: string): Promise<void> {
  const notes = await ctx.commands.withSignal(round.signal).gitlabPages(NoteSchema, `${notePath(kind, iid)}?sort=asc&order_by=updated_at&created_after=${encodeURIComponent(since)}&per_page=100`, round.tally)
  for (const note of notes) {
    if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
    if (!fresh(note.updated_at ?? note.created_at, since) || note.system || hasSystemMarker(note.body ?? '') || !explicitCommand(note.body ?? '')) continue
    await ctx.receive(noteTrigger(note, { kind, iid, url }))
    round.events += 1
  }
}

async function pollRepository(ctx: SourceContext, round: Round): Promise<void> {
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (!config || !configuredProject(ctx, config)) return
  const streams: { kind: GitlabEntity; path: string }[] = [{ kind: 'issue', path: 'issues' }, { kind: 'mr', path: 'merge_requests' }]
  for (const stream of streams) {
    if (stopped(ctx, round)) return
    const stored = ctx.state.get(KV.gitlab.stream(stream.kind))
    const since = stored?.since ?? round.started
    const path = `${stream.path}?state=all&order_by=updated_at&sort=asc&updated_after=${encodeURIComponent(since)}&per_page=100`
    let items: (GitlabIssue | MergeRequest)[]
    try {
      items = stream.kind === 'issue' ? await ctx.commands.withSignal(round.signal).gitlabPages(IssueSchema, path, round.tally)
        : await ctx.commands.withSignal(round.signal).gitlabPages(MergeRequestSchema, path, round.tally)
    } catch (error) {
      if (!stopped(ctx, round)) round.failures.push(`${stream.kind}s: ${String(error)}`)
      continue
    }
    let failed = false
    let newest = Date.parse(since)
    for (const item of items) {
      if (stopped(ctx, round)) throw new Error('The GitLab Source stopped during the poll')
      if (!projectOk(ctx, item.project_id) || !fresh(item.updated_at, since)) continue
      try {
        const kind = stream.kind
        if (kind === 'issue') {
          if (explicitCommand(item.description ?? '')) { await ctx.receive(issueTrigger(item)); round.events += 1 }
          threadName(ctx, kind, item.iid, item.title, item.web_url)
          await intakeNotes(ctx, round, kind, item.iid, item.web_url, since)
        } else {
          const mr = await getMr(ctx, round, item.iid, item)
          await observeMergeRequest(ctx, mr)
          if (explicitCommand(mr.description ?? '')) { await ctx.receive(mergeRequestTrigger(mr)); round.events += 1 }
          threadName(ctx, kind, mr.iid, mr.title, mr.web_url)
          await intakeNotes(ctx, round, kind, mr.iid, mr.web_url, since)
        }
        round.read.add(`${kind}:${item.iid}`)
        newest = Math.max(newest, Date.parse(item.updated_at))
        ctx.state.set(KV.gitlab.cursor(kind, item.iid), cursorAt(round.started))
      } catch (error) {
        failed = true
        recordFailure(ctx, round, gitlabThread(stream.kind, item.iid), error)
      }
    }
    if (!failed) {
      const next = Number.isFinite(newest) && newest > Date.parse(since) ? cursorAt(new Date(newest).toISOString()) : since
      ctx.state.set(KV.gitlab.stream(stream.kind), { since: next, started: stored?.started ?? round.started })
    }
  }
}

async function getMr(ctx: SourceContext, round: Round, iid: number, fallback?: MergeRequest): Promise<MergeRequest> {
  let read = round.mrs.get(iid)
  if (!read) {
    read = (fallback ? Promise.resolve(fallback) : readMergeRequest(ctx, iid, round.signal)).then(value => ({ ...value, iid }))
    round.mrs.set(iid, read)
  }
  return read
}

const pipelineSummary = (pipeline: GitlabPipeline, mr: MergeRequest): string => {
  const state = pipeline.status.replaceAll('_', ' ')
  return `Pipeline ${state} for MR !${mr.iid} at ${(pipeline.sha ?? mr.sha ?? '').slice(0, 8)}\nRead gitlab/merge_requests/${mr.iid}/pipelines for pipeline details.`
}
const pipelineFact = (pipeline: GitlabPipeline): { label: Localized; value: string; problem?: true } => {
  const failed = ['failed', 'canceled', 'skipped'].includes(pipeline.status)
  return { label: { zh: '流水线', en: 'Pipeline' }, value: pipeline.status, ...(failed ? { problem: true as const } : {}) }
}

async function pollMergeRequestPipeline(ctx: SourceContext, round: Round, mr: MergeRequest): Promise<void> {
  const pipelines = await ctx.commands.withSignal(round.signal).gitlabPages(PipelineSchema, `merge_requests/${mr.iid}/pipelines?per_page=100`, round.tally)
  const pipeline = pipelines.filter(item => !mr.sha || item.sha === mr.sha).sort((a, b) => b.id - a.id)[0]
  if (!pipeline) return
  const fingerprint = key(JSON.stringify({ id: pipeline.id, status: pipeline.status, sha: pipeline.sha }))
  const previous = ctx.state.get(KV.gitlab.pipeline(mr.iid))
  const changed = !!previous && previous.fingerprint !== fingerprint
  const revision = (previous?.revision ?? 0) + (changed ? 1 : 0)
  if (changed) {
    await ctx.receive(pipelineTrigger(pipeline, mr, revision, pipelineSummary(pipeline, mr)))
    round.events += 1
  }
  ctx.state.set(KV.gitlab.pipeline(mr.iid), { fingerprint, revision })
  ctx.threads.describe(gitlabThread('mr', mr.iid), { facts: { ci: pipelineFact(pipeline) } })
}

async function pollTicketMergeRequests(ctx: SourceContext, round: Round): Promise<void> {
  const iids = [...new Set(ctx.tickets.open().flatMap(ticket => mergeRequestsOf(ticket, true)))]
  for (const iid of iids) {
    if (stopped(ctx, round)) return
    try {
      const mr = await getMr(ctx, round, iid)
      const ended = await observeMergeRequest(ctx, mr)
      if (!ended) await pollMergeRequestPipeline(ctx, round, mr)
    } catch (error) { if (!stopped(ctx, round)) recordFailure(ctx, round, gitlabThread('mr', iid), error) }
  }
}

async function pollThread(ctx: SourceContext, round: Round, thread: Thread): Promise<void> {
  const match = /^(issue|mr):(\d+)$/.exec(thread.ref.id)
  if (!match) return
  const kind = match[1] as GitlabEntity
  const iid = Number(match[2])
  const sinceKey = KV.gitlab.cursor(kind, iid)
  const since = ctx.state.get(sinceKey) ?? ctx.state.get(KV.gitlab.stream(kind))?.started ?? round.started
  const entity = kind === 'issue' ? await ctx.commands.withSignal(round.signal).gitlabApi(IssueSchema, entityPath(kind, iid))
    : await getMr(ctx, round, iid)
  if (!projectOk(ctx, entity.project_id)) return
  if (kind === 'mr') await observeMergeRequest(ctx, entity as MergeRequest)
  threadName(ctx, kind, iid, entity.title, entity.web_url)
  await intakeNotes(ctx, round, kind, iid, entity.web_url, since)
  ctx.state.set(sinceKey, cursorAt(round.started))
}

/** Polls subscribed GitLab Issue/MR threads not already read by the repository stream. */
export async function pollThreads(ctx: SourceContext, signal?: AbortSignal, round = newRound(signal)): Promise<void> {
  await pollEach(ctx, SOURCE, () => stopped(ctx, round), async thread => {
    try { await pollThread(ctx, round, thread) }
    catch (error) { if (!stopped(ctx, round)) recordFailure(ctx, round, thread.key, error); throw error }
  }, thread => round.read.has(thread.ref.id))
}

/** One GitLab polling round: repository Issue/MR updates, bound MR state/pipelines, then subscribed threads. */
export async function pollRound(ctx: SourceContext, signal?: AbortSignal): Promise<number> {
  const round = newRound(signal)
  await pollRepository(ctx, round)
  await pollTicketMergeRequests(ctx, round)
  await pollThreads(ctx, signal, round)
  if (signal?.aborted) return ctx.config<GitlabConfig>(SOURCE)?.pollSeconds ?? 60
  const config = ctx.config<GitlabConfig>(SOURCE)
  if (round.failures.length) throw new Error(`${round.failures.length} GitLab reads failed: ${round.failures.slice(0, 3).join('; ')}`)
  const dropped = round.dropped.length ? `; deleted: ${[...new Set(round.dropped)].join(', ')}` : ''
  const skipped = round.tally.skipped ? `; ${round.tally.skipped} unreadable items skipped` : ''
  const interval = config?.pollSeconds ?? 60
  ctx.report('gitlab', { state: 'ready', detail: `${round.events} events; next poll ≥ ${interval}s${dropped}${skipped}`, at: round.started })
  return interval
}
