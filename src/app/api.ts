/** Type-only management API contract between the web panel and host routes, imported by the panel without bundling host code. */
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { CliApplication, CliChallenge, CliCheck, CliFailureCode, CliPlatform } from './cli-connect-types.ts'
import type { FeishuUserFailure } from './feishu-user.ts'
import type { DingTalkGroupList, DingTalkUserFailure } from './dingtalk-user.ts'
import type { OperatorRequest, OperatorReceipt } from '../sources/operator.ts'
import type { ReceiveResult } from '../core/index.ts'
import type { PromptConfig, Prompts } from './prompts.ts'
import type { PromptsView, StateView, TicketPageView } from './http.ts'
import type { HistoryView } from './settings-history.ts'
import type { OverviewView } from './views/overview.ts'
import type { SettingsView } from './views/settings.ts'
import type { SourceStatusView } from './views/sources.ts'
import type { DecisionListView, SearchView, ThreadDetailView, ThreadListView } from './views/threads.ts'
import type { TicketListView } from './views/tickets.ts'

export const TICKET_FILTERS = ['open', 'person', 'working', 'idle', 'ended'] as const
export const THREAD_FILTERS = ['subscribed', 'evaluating', 'recent', 'all'] as const
export type TicketFilter = typeof TICKET_FILTERS[number]
export type ThreadFilter = typeof THREAD_FILTERS[number]
interface Paged { offset?: number; limit?: number }
/** Whether a context update was already injected into the main Session or is still pending delivery. */
type Delivery = 'injected' | 'pending'

export interface WechatLoginRequest {
  enable: boolean
  replace?: boolean
  sourceRevision: number
  policyRevision: number
}
/** Ephemeral local-panel view. Bot credentials and the upstream polling handle never cross this boundary. */
export interface WechatLoginView {
  id: string
  status: 'starting' | 'waiting' | 'scanned' | 'verification' | 'saving' | 'connected' | 'expired' | 'cancelled' | 'error'
  expiresAt: string
  qrUrl?: string
  accountId?: string
  userId?: string
  enabled?: boolean
  error?: 'upstream_failed' | 'missing_user' | 'settings_conflict' | 'save_failed'
}

export interface CliConnectRequest {
  mode: 'quick' | 'manual' | 'resume'
  enable: boolean
  replace?: boolean
  sourceRevision: number
  policyRevision: number
}
export interface CliPairView {
  id: string
  status: 'waiting' | 'paired' | 'cancelled' | 'expired' | 'conflict'
  expiresAt: string
  command?: string
  userId?: string
}
export interface CliConnectView {
  platform: CliPlatform
  id: string | null
  mode?: 'quick' | 'manual' | 'resume'
  canConfirm?: boolean
  canResume?: boolean
  status: 'idle' | 'installing' | 'authorizing' | 'waiting' | 'select_app' | 'credentials' | 'checking' | 'review'
    | 'saving' | 'connected' | 'cancelled' | 'expired' | 'error'
  cli: { installed: boolean; version: string }
  configured: boolean
  enabled: boolean
  allowed: boolean
  expiresAt?: string
  challenge?: CliChallenge
  account?: { name?: string; organization?: string }
  apps?: CliApplication[]
  selectedApp?: CliApplication
  checks?: CliCheck[]
  platformUrl?: string
  error?: CliFailureCode
  pairing?: CliPairView
}

/** Safe metadata only; OAuth tokens, verifier and App Secret never reach the panel. */
export interface FeishuUserView {
  status: 'disconnected' | 'waiting' | 'checking' | 'connected' | 'expired' | 'error'
  configured: boolean
  redirectUri: string
  scopes: string[]
  appId?: string
  user?: { id: string; name: string }
  expiresAt?: string
  renewal: 'unavailable' | 'automatic' | 'reauthorize' | 'retrying'
  refreshExpiresAt?: string
  refreshedAt?: string
  renewalError?: FeishuUserFailure
  authorizationUrl?: string
  authorizationExpiresAt?: string
  error?: FeishuUserFailure
  upstreamCode?: number
}

/** Only safe account metadata and an ephemeral consent challenge; no DWS credential files or raw command output. */
export interface DingTalkUserView {
  status: 'disconnected' | 'checking' | 'waiting' | 'select_account' | 'connected' | 'expired' | 'error'
  configured: boolean
  cli: { installed: boolean; version: string }
  user?: { id: string; name: string; corpId: string; organization?: string }
  expiresAt?: string
  refreshExpiresAt?: string
  challenge?: CliChallenge
  accounts?: { profileId: string; user: NonNullable<DingTalkUserView['user']> }[]
  error?: DingTalkUserFailure
}

export interface DingTalkSubscriptionView {
  id: string; chatId: string; name: string; senderId?: string
  status: 'listening' | 'catching_up' | 'suspended' | 'error'
  startedAt: string; lastCheckedAt: string; lastMessageAt?: string; received: number; pollSeconds: number
  messagesResource: string; historyGapAt?: string; error?: string
  mode: 'context' | 'tasks'; triggered: number; evaluationMode: 'off' | 'observe' | 'auto'
  lastTriggerId?: string; lastThreadKey?: string; unreadable?: number
}

export interface Api {
  'POST requests': { body: OperatorRequest; response: OperatorReceipt }
  'GET connections/dingtalk-user/subscriptions': { response: DingTalkSubscriptionView[] }
  'POST connections/dingtalk-user/subscriptions': { body: { chatId: string; name: string; senderId?: string }; response: DingTalkSubscriptionView }
  'POST connections/dingtalk-user/subscriptions/:id/unsubscribe': { body: Record<string, never>; response: { removed: boolean } }
  'POST connections/dingtalk-user/subscriptions/:id/check': { body: Record<string, never>; response: DingTalkSubscriptionView[] }
  'POST connections/dingtalk-user/subscriptions/:id/mode': { body: { mode: 'context' | 'tasks' }; response: DingTalkSubscriptionView }
  'POST connections/dingtalk-user/subscriptions/:id/assess-latest': { body: Record<string, never>; response: { triggerId: string; result: ReceiveResult } }
  'GET connections/dingtalk-user': { response: DingTalkUserView }
  'GET connections/dingtalk-user/groups': { response: DingTalkGroupList | null }
  'POST connections/dingtalk-user/groups/refresh': { body: Record<string, never>; response: DingTalkGroupList }
  'POST connections/dingtalk-user/connect': { body: { mode: 'saved' | 'authorize'; profileId?: string }; response: DingTalkUserView }
  'POST connections/dingtalk-user/cancel': { body: Record<string, never>; response: DingTalkUserView }
  'POST connections/dingtalk-user/disconnect': { body: Record<string, never>; response: DingTalkUserView }
  'POST connections/dingtalk-user/read': { body: { resource: string }; response: unknown }
  'GET connections/feishu-user': { response: FeishuUserView }
  'POST connections/feishu-user/authorize': { body: { appId: string; secret?: string }; response: FeishuUserView }
  'POST connections/feishu-user/cancel': { body: Record<string, never>; response: FeishuUserView }
  'POST connections/feishu-user/refresh': { body: Record<string, never>; response: FeishuUserView }
  'POST connections/feishu-user/disconnect': { body: Record<string, never>; response: FeishuUserView }
  'POST connections/feishu-user/read': { body: { resource: string }; response: unknown }
  'GET sources/:platform/connect': { response: CliConnectView }
  'POST sources/:platform/connect': { body: CliConnectRequest; response: CliConnectView }
  'POST sources/:platform/connect/:id/select': { body: { appId: string }; response: CliConnectView }
  'POST sources/:platform/connect/:id/credentials': { body: { appId: string; clientId?: string; secret: string }; response: CliConnectView }
  'POST sources/:platform/connect/:id/check': { body: Record<string, never>; response: CliConnectView }
  'POST sources/:platform/connect/:id/confirm': { body: { enable: boolean; sourceRevision: number; policyRevision: number }; response: CliConnectView }
  'POST sources/:platform/connect/:id/cancel': { body: Record<string, never>; response: CliConnectView }
  'POST sources/:platform/pair': { body: { sourceRevision: number; policyRevision: number }; response: CliConnectView }
  'POST sources/:platform/pair/:id/cancel': { body: Record<string, never>; response: CliConnectView }
  'GET sources/wechat/login': { response: WechatLoginView | null }
  'POST sources/wechat/login': { body: WechatLoginRequest; response: WechatLoginView }
  'GET sources/wechat/login/:id': { response: WechatLoginView }
  'POST sources/wechat/login/:id/cancel': { body: Record<string, never>; response: WechatLoginView }
  'POST sources/wechat/login/:id/verify': { body: { code: string }; response: WechatLoginView }
  'GET state': { response: StateView }
  'GET overview': { response: OverviewView }
  'GET search': { query: { q: string }; response: SearchView }
  'GET sources': { response: SourceStatusView[] }
  'GET settings': { response: SettingsView }
  'POST sources/:id/labels': { response: { added: string[] } }
  'GET threads': { query?: Paged & { filter?: ThreadFilter }; response: ThreadListView }
  'GET threads/:key': { query?: { limit?: number; before?: string; around?: string }; response: ThreadDetailView }
  'POST threads/:key/unsubscribe': { response: { removed: boolean; thread: string; context_delivery: Delivery } }
  'POST triggers/:id/requeue': { response: { queued: boolean } }
  'GET decisions': { query?: Paged & { kind?: string; window?: '24h' }; response: DecisionListView }
  'POST decisions/:id/dismiss': { response: { dismissed: true } }
  'GET tickets': { query?: Paged & { state?: TicketFilter }; response: TicketListView }
  'GET tickets/:id': { response: TicketPageView }
  'POST tickets/:id/retry': { response: { retried: true } }
  'POST tickets/:id/stop': { response: { stopped: true } }
  'POST executor/pause': { body: { paused: boolean }; response: { paused: boolean } }
  'PUT settings/:block': { body: { value: unknown; revision: number }; response: { revision: number; restarting: boolean } }
  'GET policy/history': { response: HistoryView }
  'POST policy-sync/:id': { response: { policy: unknown } }
  'POST setup/check': { response: { restarting: true } }
  'GET models': { response: ModelCatalog }
  'GET prompts': { query?: { revision?: number; offset?: number }; response: PromptsView }
  'PUT prompts': { body: { config: PromptConfig; baseRevision: number }; response: { revision: number; context_delivery: Delivery } }
  'POST prompts/preview': { body: PromptConfig; response: ReturnType<Prompts['preview']> }
}
type Path<K> = K extends `${string} ${infer P}` ? P : never
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}` ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}` ? Record<Name, string> : unknown
export type RouteParams<K extends keyof Api> = Params<Path<K>>
export type ApiRequest<K extends keyof Api> = RouteParams<K> & Omit<Api[K], 'response'>
export type ApiResponse<K extends keyof Api> = Api[K]['response']
