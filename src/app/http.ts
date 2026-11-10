/** Loopback-only management HTTP routes with same-origin enforcement for the web panel. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { z } from 'zod'
import { THREAD_FILTERS, TICKET_FILTERS, type Api, type ApiResponse, type RouteParams } from './api.ts'
import { sourceSkills } from './context.ts'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import { PromptConflict, SKILL_NAME, SKILL_PREFIX, TEAM_SECTIONS, builtInBase, builtInParts, defaultPrompts, savePrompts, type Prompts }
  from './prompts.ts'
import { policyVersion } from '../policy.ts'
import { SettingsConflict, type Settings } from './settings.ts'
import { WechatLoginError, WechatLoginRequestSchema, type WechatLogin } from './wechat-login.ts'
import { CliConnectRequestSchema, CliConfirmSchema, CliCredentialsSchema, CliPlatformSchema, CliRevisionsSchema, type CliConnect } from './cli-connect.ts'
import { CliFailure } from './cli-connect-types.ts'
import { FEISHU_USER_CALLBACK, FEISHU_USER_DONE, FeishuUserBegin, FeishuUserError, type FeishuUser } from './feishu-user.ts'
import { DingTalkUserConnect, DingTalkUserError, type DingTalkUser } from './dingtalk-user.ts'
import { DingTalkSubscribe, DingTalkSubscriptionMode, type DingTalkSubscriptions } from './dingtalk-subscriptions.ts'
import { OperatorRequestSchema, OperatorRequestConflict, type OperatorRequests } from '../sources/operator.ts'
import { SetupError, type SetupProblem } from '../setup.ts'
import { UserError, type EngineForPeople, type Ticket } from '../core/index.ts'
import type { Deployment, Machine } from '../deployment.ts'
import type { DshExecutor } from '../executor/dsh.ts'
import type { Health } from '../sources/host.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { Sessions } from './sessions.ts'
import type { Store } from './store.ts'
import type { TextCache } from './cache.ts'
import type { LinkTarget, ViewHost } from './views/records.ts'
import type { Variable } from './execution-environment.ts'
import { policyHistory } from './settings-history.ts'
import { overview } from './views/overview.ts'
import { settingsView } from './views/settings.ts'
import { sourcesStatus, type SetupState } from './views/sources.ts'
import { decisionList, search, threadDetail, threadList } from './views/threads.ts'
import { executorLoad, ticketDetail, ticketList } from './views/tickets.ts'

export interface HttpHost {
  readonly store: Store
  /** Feishu message links resolved since startup, used by search to match AppLink URLs. */
  readonly sourceLinks: Pick<TextCache, 'entries'>
  readonly sources: SourceRegistry
  readonly prompts: Pick<Prompts, 'current' | 'version' | 'history' | 'preview' | 'save' | 'defaultChanged'>
  readonly sessions: Pick<Sessions, 'status' | 'notify' | 'delivery'>
  readonly settings: Pick<Settings, 'view' | 'save' | 'pause' | 'sync' | 'refreshLabels'>
  readonly wechatLogin: Pick<WechatLogin, 'current' | 'begin' | 'get' | 'cancel' | 'verify'>
  readonly cliConnect: Pick<CliConnect, 'current' | 'begin' | 'select' | 'credentials' | 'check' | 'confirm' | 'cancel' | 'pair' | 'cancelPair'>
  readonly feishuUser: Pick<FeishuUser, 'current' | 'begin' | 'cancel' | 'disconnect' | 'callback' | 'read' | 'renew'>
  readonly dingtalkUser: Pick<DingTalkUser, 'current' | 'begin' | 'cancel' | 'disconnect' | 'read' | 'groupList' | 'refreshGroups'>
  readonly dingtalkSubscriptions: Pick<DingTalkSubscriptions, 'list' | 'subscribe' | 'unsubscribe' | 'check' | 'setMode' | 'assessLatest'>
  readonly operatorRequests: Pick<OperatorRequests, 'submit'>
  readonly engine: EngineForPeople
  readonly executor: Pick<DshExecutor, 'activeCount'>
  readonly health: Record<string, Health>
  readonly machine: Machine
  readonly masterId: string
  /** Resolves once startup finishes or setup determines what is still missing. */
  readonly ready: Promise<void>
  /** Resolved deployment; throws if read while waiting for setup (`!configured()`). */
  readonly deployment: Deployment
  readonly setupProblem?: SetupProblem | undefined
  readonly feishuProblem?: SetupProblem | undefined
  configured(): boolean
  links(): LinkTarget
  ticketEnvironment(ticket: Ticket): Variable[]
  checkSetup(): void
  requestPass(): void
  models(): Promise<ModelCatalog>
}
/**
 * Represents a client-facing 400 or 404 error raised during management route parsing or lookup.
 * Route handlers throw it when request bodies are malformed or target records are missing, and registerHttp serializes its status and message in the HTTP response.
 */
class RouteError extends Error { constructor(readonly status: 400 | 404, message: string) { super(message) } }
async function readBody(req: IncomingMessage, maxBytes = 128 * 1024): Promise<unknown> {
  let size = 0; const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk); size += bytes.length
    if (size > maxBytes) throw new RouteError(400, `Request exceeds ${maxBytes} bytes`)
    chunks.push(bytes)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { throw new RouteError(400, 'The request body is not JSON') }
}
function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value))
}
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = req.headers.host
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false
  return req.headers['x-orchestrator-request'] === '1' && (req.headers.origin === undefined || req.headers.origin === `http://${host}`)
}
/** Maps errors to HTTP status codes and structured payloads that the panel localizes in the interface language. */
function failure(error: unknown): [number, Record<string, unknown>] {
  if (error instanceof DingTalkUserError) return [400, { error: error.message, connectionError: error.code }]
  if (error instanceof FeishuUserError) return [error.code === 'invalid_state' ? 403 : 400,
    { error: error.message, connectionError: error.code, upstreamCode: error.upstreamCode }]
  if (error instanceof z.ZodError) {
    const issues = error.issues.map(issue => ({ path: issue.path.join('.'), message: issue.message }))
    return [400, { error: `Invalid settings: ${issues.map(issue => issue.path).join(', ')}`, issues }]
  }
  if (error instanceof CliFailure) return [['settings_conflict', 'not_ready'].includes(error.code) ? 409 : 400,
    { error: error.code === 'settings_conflict' ? 'Settings changed. Start connection again.' : error.code === 'not_ready'
      ? 'The connection is not ready for this action.' : 'Connection could not be completed.', connectionError: error.code }]
  if (error instanceof SetupError) return [400, { error: error.message, setup: error.problem }]
  if (error instanceof RouteError || error instanceof WechatLoginError) return [error.status, { error: error.message }]
  if (error instanceof UserError) return [error.missing ? 404 : 400, { error: error.message, code: error.code, values: error.values }]
  if (error instanceof SettingsConflict || error instanceof PromptConflict || error instanceof OperatorRequestConflict) return [409, { error: error.message }]
  return [500, { error: error instanceof Error ? error.message : String(error) }]
}

function machineView({ stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }: Machine) {
  return { stateDir, promptMaxChars: promptMaxChars.get(), admissionContextMaxPages: admissionContextMaxPages.get(),
    admissionContextTimeoutMs: admissionContextTimeoutMs.get() }
}
function setupView(runtime: HttpHost) {
  const resolved = runtime.configured() ? runtime.deployment : undefined
  return {
    machine: machineView(runtime.machine), problem: runtime.setupProblem ?? null, feishuProblem: runtime.feishuProblem ?? null,
    accounts: resolved ? { repository: resolved.repository, agent: resolved.gitlab?.login ?? resolved.github?.login ?? '', feishu: resolved.feishu ? { appId: resolved.feishu.appId, brand: resolved.feishu.brand, botId: resolved.feishu.botId, name: resolved.feishu.name } : null } : null,
  }
}
/** Build the `/orchestrator/api/state` response consumed by the management panel and `scripts/dsh-superagent status` (`docs/006-deployment.md`). */
export function stateView(runtime: HttpHost) {
  const settings = runtime.store.settings()
  return { setup: setupView(runtime), load: { ...executorLoad(runtime.store, runtime.executor.activeCount()),
    maxWorkers: settings.executor.maxWorkers },
    masterId: runtime.masterId, paused: settings.paused, health: runtime.health }
}
const views = (runtime: HttpHost): ViewHost => ({ store: runtime.store, sources: runtime.sources, links: runtime.links() })
const setupState = (runtime: HttpHost): SetupState => ({ deployment: runtime.configured() ? runtime.deployment : undefined,
  problem: runtime.setupProblem, feishuProblem: runtime.feishuProblem })
export type StateView = ReturnType<typeof stateView>
/** Builds a ticket's detail view; `environment` is empty while waiting for setup because it requires the resolved deployment. */
function ticketPage(runtime: HttpHost, id: string) {
  const detail = ticketDetail(views(runtime), id), ticket = runtime.store.tickets.get(id)
  if (!detail || !ticket) throw new RouteError(404, 'Ticket not found')
  return { ...detail, environment: runtime.configured() ? runtime.ticketEnvironment(ticket) : [] }
}
export type TicketPageView = ReturnType<typeof ticketPage>
function promptsView(runtime: HttpHost, revision: number | undefined, offset: number) {
  const current = runtime.prompts.current()
  const shown = revision === undefined || revision === current.revision ? current : runtime.prompts.version(revision)
  // Each built-in part with the key of its text, which an override records as its base, and for the overrides shown whose
  // built-in text changed since, the text they were edited from when known.
  const parts = Object.entries(builtInParts()).map(([key, part]) => ({ key, ...part, base: builtInBase(part.text) }))
  return { masterId: runtime.masterId, current: shown, defaults: defaultPrompts(), sections: TEAM_SECTIONS, skillName: SKILL_NAME.source,
    builtin: Object.keys(sourceSkills), skillPrefix: SKILL_PREFIX, parts, defaultChanged: runtime.prompts.defaultChanged(shown.config),
    ...runtime.sessions.status(), ...runtime.prompts.history(offset) }
}
export type PromptsView = ReturnType<typeof promptsView>

interface Input<K extends keyof Api> {
  params: RouteParams<K>; query: Record<string, string>; body: (maxBytes?: number) => Promise<unknown>
}
type Routes = { [K in keyof Api]: (input: Input<K>) => ApiResponse<K> | Promise<ApiResponse<K>> }
const offset = z.coerce.number().int().nonnegative().catch(0)
const limit = (fallback: number, max: number) => z.coerce.number().int().positive().catch(fallback).transform(value => Math.min(max, value))
const TicketsQuery = z.object({ state: z.enum(TICKET_FILTERS).catch('open'), offset, limit: limit(20, 1000) })
const ThreadsQuery = z.object({ filter: z.enum(THREAD_FILTERS).catch('subscribed'), offset, limit: limit(20, 1000) })
const ThreadQuery = z.object({ limit: limit(50, 100), before: z.string().optional(), around: z.string().optional() })
const DecisionsQuery = z.object({ kind: z.string().default(''), window: z.literal('24h').optional().catch(undefined), offset,
  limit: limit(30, 200) })
const count = z.coerce.number().int().nonnegative()
const PromptsQuery = z.object({ revision: count.optional(), offset: count.default(0) })
const SourceBlock = z.templateLiteral(['source:', z.string().regex(/^[a-z][a-z0-9-]*$/)])
const SettingsBlockSchema = z.union([z.enum(['policy', 'eval', 'executor']), SourceBlock])
const SaveRequest = z.object({ value: z.unknown(), revision: z.number().int().nonnegative() })

function routes(runtime: HttpHost): Routes {
  const { store } = runtime
  const ticket = (id: string) => { if (!store.tickets.get(id)) throw new RouteError(404, 'Ticket not found'); return id }
  const promptBody = (input: { body: (maxBytes?: number) => Promise<unknown> }) => input.body(4 * runtime.machine.promptMaxChars.get() + 4096)
  return {
    'POST requests': async ({ body }) => runtime.operatorRequests.submit(OperatorRequestSchema.parse(await body())),
    'GET connections/dingtalk-user/subscriptions': () => runtime.dingtalkSubscriptions.list(),
    'POST connections/dingtalk-user/subscriptions': async ({ body }) => runtime.dingtalkSubscriptions.subscribe(DingTalkSubscribe.parse(await body(2048))),
    'POST connections/dingtalk-user/subscriptions/:id/unsubscribe': async ({ params, body }) => {
      z.object({}).strict().parse(await body(1024))
      return runtime.dingtalkSubscriptions.unsubscribe(params.id)
    },
    'POST connections/dingtalk-user/subscriptions/:id/check': async ({ params, body }) => {
      z.object({}).strict().parse(await body(1024))
      return runtime.dingtalkSubscriptions.check(params.id)
    },
    'POST connections/dingtalk-user/subscriptions/:id/mode': async ({ params, body }) =>
      runtime.dingtalkSubscriptions.setMode(params.id, DingTalkSubscriptionMode.parse(await body(1024))),
    'POST connections/dingtalk-user/subscriptions/:id/assess-latest': async ({ params, body }) => {
      z.object({}).strict().parse(await body(1024))
      return runtime.dingtalkSubscriptions.assessLatest(params.id)
    },
    'GET connections/dingtalk-user': () => runtime.dingtalkUser.current(),
    'GET connections/dingtalk-user/groups': () => runtime.dingtalkUser.groupList() ?? null,
    'POST connections/dingtalk-user/groups/refresh': async ({ body }) => {
      z.object({}).strict().parse(await body(1024))
      return runtime.dingtalkUser.refreshGroups()
    },
    'POST connections/dingtalk-user/connect': async ({ body }) => runtime.dingtalkUser.begin(DingTalkUserConnect.parse(await body(2048))),
    'POST connections/dingtalk-user/cancel': async ({ body }) => { z.object({}).strict().parse(await body(1024)); return runtime.dingtalkUser.cancel() },
    'POST connections/dingtalk-user/disconnect': async ({ body }) => { z.object({}).strict().parse(await body(1024)); return runtime.dingtalkUser.disconnect() },
    'POST connections/dingtalk-user/read': async ({ body }) => {
      const input = z.object({ resource: z.string().min(1).max(16000) }).strict().parse(await body(20000))
      return runtime.dingtalkUser.read(input.resource)
    },
    'GET connections/feishu-user': () => runtime.feishuUser.current(),
    'POST connections/feishu-user/authorize': async ({ body }) => runtime.feishuUser.begin(FeishuUserBegin.parse(await body(8192))),
    'POST connections/feishu-user/cancel': async ({ body }) => { z.object({}).strict().parse(await body(1024)); return runtime.feishuUser.cancel() },
    'POST connections/feishu-user/refresh': async ({ body }) => { z.object({}).strict().parse(await body(1024)); return runtime.feishuUser.renew() },
    'POST connections/feishu-user/disconnect': async ({ body }) => { z.object({}).strict().parse(await body(1024)); return runtime.feishuUser.disconnect() },
    'POST connections/feishu-user/read': async ({ body }) => {
      const input = z.object({ resource: z.string().min(1).max(12000) }).strict().parse(await body(16384))
      return runtime.feishuUser.read(input.resource)
    },
    'GET sources/:platform/connect': ({ params }) => runtime.cliConnect.current(CliPlatformSchema.parse(params.platform)),
    'POST sources/:platform/connect': async ({ params, body }) => runtime.cliConnect.begin(CliPlatformSchema.parse(params.platform), CliConnectRequestSchema.parse(await body(4096))),
    'POST sources/:platform/connect/:id/select': async ({ params, body }) => {
      const input = z.object({ appId: z.string().min(1).max(256) }).strict().parse(await body(4096))
      return runtime.cliConnect.select(CliPlatformSchema.parse(params.platform), params.id, input.appId)
    },
    'POST sources/:platform/connect/:id/credentials': async ({ params, body }) => runtime.cliConnect.credentials(CliPlatformSchema.parse(params.platform), params.id, CliCredentialsSchema.parse(await body(24 * 1024))),
    'POST sources/:platform/connect/:id/check': async ({ params, body }) => {
      z.object({}).strict().parse(await body(4096))
      return runtime.cliConnect.check(CliPlatformSchema.parse(params.platform), params.id)
    },
    'POST sources/:platform/connect/:id/confirm': async ({ params, body }) => runtime.cliConnect.confirm(CliPlatformSchema.parse(params.platform), params.id, CliConfirmSchema.parse(await body(4096))),
    'POST sources/:platform/connect/:id/cancel': async ({ params, body }) => {
      z.object({}).strict().parse(await body(4096))
      return runtime.cliConnect.cancel(CliPlatformSchema.parse(params.platform), params.id)
    },
    'POST sources/:platform/pair': async ({ params, body }) => runtime.cliConnect.pair(CliPlatformSchema.parse(params.platform), CliRevisionsSchema.parse(await body(4096))),
    'POST sources/:platform/pair/:id/cancel': async ({ params, body }) => {
      z.object({}).strict().parse(await body(4096))
      return runtime.cliConnect.cancelPair(CliPlatformSchema.parse(params.platform), params.id)
    },
    'GET sources/wechat/login': () => runtime.wechatLogin.current(),
    'POST sources/wechat/login': async ({ body }) => runtime.wechatLogin.begin(WechatLoginRequestSchema.parse(await body(4096))),
    'GET sources/wechat/login/:id': ({ params }) => runtime.wechatLogin.get(params.id),
    'POST sources/wechat/login/:id/cancel': async ({ params, body }) => {
      z.object({}).strict().parse(await body(4096))
      return runtime.wechatLogin.cancel(params.id)
    },
    'POST sources/wechat/login/:id/verify': async ({ params, body }) => {
      const input = z.object({ code: z.string().regex(/^\d{4,12}$/) }).strict().parse(await body(4096))
      return runtime.wechatLogin.verify(params.id, input.code)
    },
    'GET state': () => stateView(runtime),
    'GET overview': () => overview(views(runtime), runtime.health, policyVersion(store.settings()),
      executorLoad(store, runtime.executor.activeCount()), runtime.setupProblem ?? runtime.feishuProblem),
    'GET search': ({ query }) => search(views(runtime), query.q ?? '', runtime.sourceLinks),
    'GET sources': () => sourcesStatus(views(runtime), runtime.health, setupState(runtime)),
    'GET settings': () => settingsView(store, runtime.sources, runtime.health, setupState(runtime), runtime.machine.stateDir, runtime.dingtalkUser.groupList()),
    'POST sources/:id/labels': ({ params }) => runtime.settings.refreshLabels(params.id),
    'GET threads': ({ query }) => {
      const { filter, offset, limit } = ThreadsQuery.parse(query)
      return threadList(views(runtime), filter, offset, limit)
    },
    'GET threads/:key': ({ params, query }) => {
      const { limit, before, around } = ThreadQuery.parse(query)
      const detail = threadDetail(views(runtime), params.key, before, limit, around)
      if (!detail) throw new RouteError(404, 'Thread not found')
      return detail
    },
    'POST threads/:key/unsubscribe': async ({ params }) => {
      const removed = runtime.engine.unsubscribe(params.key)
      return { removed, thread: params.key, context_delivery: await runtime.sessions.delivery(`subscription:${params.key}`) }
    },
    'POST triggers/:id/requeue': ({ params }) => {
      const queued = runtime.engine.reevaluate(params.id)
      runtime.requestPass()
      return { queued }
    },
    'GET decisions': ({ query }) => {
      const { kind, window, offset, limit } = DecisionsQuery.parse(query)
      const since = window ? new Date(Date.now() - 86_400_000).toISOString() : ''
      return decisionList(views(runtime), kind.split(',').filter(Boolean), offset, limit, since)
    },
    'POST decisions/:id/dismiss': ({ params }) => { runtime.engine.dismiss(params.id); return { dismissed: true } },
    'GET tickets': ({ query }) => {
      const { state, offset, limit } = TicketsQuery.parse(query)
      return ticketList(views(runtime), state, offset, limit)
    },
    'GET tickets/:id': ({ params }) => ticketPage(runtime, params.id),
    'POST tickets/:id/retry': ({ params }) => { const id = ticket(params.id); runtime.engine.retryTicket(id); return { retried: true } },
    'POST tickets/:id/stop': ({ params }) => { const id = ticket(params.id); runtime.engine.stopTicket(id); return { stopped: true } },
    'POST executor/pause': async ({ body }) => runtime.settings.pause(z.object({ paused: z.boolean() }).parse(await body()).paused, 'panel'),
    'PUT settings/:block': async ({ params, body }) => {
      const block = SettingsBlockSchema.parse(params.block)
      const known = !block.startsWith('source:') || runtime.sources.instances().some(instance => `source:${instance.id}` === block)
      if (!known) throw new RouteError(404, 'Source not found')
      const request = SaveRequest.parse(await body())
      return runtime.settings.save(block, request.value, request.revision, 'panel')
    },
    'GET policy/history': () => policyHistory(store, runtime.sources, policyVersion(store.settings())),
    'POST policy-sync/:id': async ({ params }) => ({ policy: await runtime.settings.sync(params.id) }),
    'POST setup/check': () => { runtime.checkSetup(); return { restarting: true } },
    'GET models': () => runtime.models(),
    'GET prompts': ({ query }) => { const { revision, offset } = PromptsQuery.parse(query); return promptsView(runtime, revision, offset) },
    'PUT prompts': async input => {
      const request = z.object({ config: z.unknown(), baseRevision: z.number().int().nonnegative() }).parse(await promptBody(input))
      return savePrompts(runtime, request.config, request.baseRevision, 'panel')
    },
    'POST prompts/preview': async input => runtime.prompts.preview(await promptBody(input)),
  }
}
function decoded(segment: string): string {
  try { return decodeURIComponent(segment) } catch { throw new RouteError(400, 'A path segment has a malformed escape') }
}
function match(table: Routes, method: string, segments: string[]) {
  for (const [route, run] of Object.entries(table)) {
    const [verb, path] = route.split(' ') as [string, string]
    const pattern = path.split('/')
    const fits = pattern.length === segments.length && pattern.every((part, index) => part.startsWith(':') || part === segments[index])
    if (verb !== method || !fits) continue
    const params: Record<string, string> = {}
    pattern.forEach((part, index) => { if (part.startsWith(':')) params[part.slice(1)] = decoded(segments[index]!) })
    return { run: run as (input: Input<keyof Api>) => unknown, params }
  }
  return undefined
}
export function registerHttp(ctx: Context, runtime: HttpHost): () => void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Orchestrator management requires a loopback Web server')
  const table = routes(runtime)
  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: '/orchestrator', handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname === FEISHU_USER_CALLBACK || url.pathname === FEISHU_USER_DONE) {
        // OAuth browser redirects cannot supply the panel header. Only these fixed paths bypass that header,
        // with a loopback Host check and a single-use, short-lived state + PKCE exchange on the callback.
        const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
          'content-security-policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" }
        if (req.method !== 'GET' || req.headers.host !== `127.0.0.1:${ctx.webServer.port}`) {
          res.writeHead(403, headers); res.end('Invalid OAuth callback request.'); return
        }
        if (url.pathname === FEISHU_USER_DONE) {
          res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' })
          res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>Superagent 飞书授权</title><p>授权处理已完成，请返回 Superagent 的飞书本人消息连接卡查看结果。</p></html>'); return
        }
        try {
          await runtime.feishuUser.callback(url.searchParams)
          res.writeHead(303, { ...headers, location: FEISHU_USER_DONE }); res.end()
        } catch (error) {
          if (error instanceof FeishuUserError && error.code !== 'invalid_state') {
            res.writeHead(303, { ...headers, location: FEISHU_USER_DONE }); res.end()
          } else { res.writeHead(403, headers); res.end('Invalid or expired OAuth authorization. Start again in Superagent.') }
        }
        return
      }
      if (!url.pathname.startsWith('/orchestrator/api/')) { res.writeHead(404); res.end(); return }
      if (!sameOrigin(req, ctx.webServer.port)) { json(res, 403, { error: 'Same-origin management request required' }); return }
      try {
        await runtime.ready
        const route = match(table, req.method ?? 'GET', url.pathname.slice('/orchestrator/api/'.length).split('/'))
        if (!route) throw new RouteError(404, 'Unknown operation')
        const query = Object.fromEntries(url.searchParams)
        json(res, 200, await route.run({ params: route.params as never, query, body: maxBytes => readBody(req, maxBytes) }))
      } catch (error) { json(res, ...failure(error)) }
    } })]
  return () => { for (const dispose of disposers) dispose() }
}
