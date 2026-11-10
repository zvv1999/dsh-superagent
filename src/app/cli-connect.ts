/** Local-panel coordinator for managed CLI authorization, account binding and private-message pairing. */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { lstat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import type { CliConnectRequest, CliConnectView, CliPairView } from './api.ts'
import { CliFailure, type CliCredentials, type CliDriver, type CliIdentity, type CliIo, type CliPlatform, type CliPrepared } from './cli-connect-types.ts'
import { dingtalkDriver } from './dingtalk-connect.ts'
import { feishuDriver } from './feishu-connect.ts'
import { checkDirectoryChain, CLI_RELEASES, ManagedCli } from './managed-cli.ts'
import { SettingsConflict, type Settings } from './settings.ts'
import type { Store } from './store.ts'

export const CliPlatformSchema = z.enum(['feishu', 'dingtalk'])
export const CliConnectRequestSchema = z.object({ mode: z.enum(['quick', 'manual', 'resume']), enable: z.boolean(), replace: z.boolean().default(false),
  sourceRevision: z.number().int().nonnegative(), policyRevision: z.number().int().nonnegative() }).strict()
export const CliCredentialsSchema = z.object({ appId: z.string().trim().min(1).max(256).regex(/^[a-zA-Z0-9_.-]+$/),
  clientId: z.string().trim().min(1).max(256).regex(/^[a-zA-Z0-9_.-]+$/).optional(), secret: z.string().min(1).max(16384).regex(/^[^\r\n\0]+$/) }).strict()
export const CliRevisionsSchema = z.object({ sourceRevision: z.number().int().nonnegative(), policyRevision: z.number().int().nonnegative() }).strict()
export const CliConfirmSchema = CliRevisionsSchema.extend({ enable: z.boolean() }).strict()
interface Host {
  stateDir: string
  lifetime: AbortSignal
  store: Pick<Store, 'settings' | 'blockRevision'>
  sources: Pick<SourceRegistry, 'instance' | 'scope'>
  settings: Pick<Settings, 'bindCli' | 'pairCliUser'>
  account(platform: CliPlatform): string
}
interface Session {
  view: CliConnectView
  request: CliConnectRequest
  abort: AbortController
  timer: ReturnType<typeof setTimeout>
  challengeTimer?: ReturnType<typeof setTimeout>
  deadline: string
  busy: boolean
  identity: CliIdentity
  cli?: CliIo
  prepared?: CliPrepared
  recovered?: Map<string, { cli: CliIo; identity: CliIdentity }>
  boundRevision?: number
}
interface Pairing {
  view: CliPairView
  sourceRevision: number
  policyRevision: number
  account: string
  timer: ReturnType<typeof setTimeout>
}
const active = (status: CliConnectView['status']) => !['connected', 'cancelled', 'expired', 'error'].includes(status)
const drivers: Record<CliPlatform, CliDriver> = { feishu: feishuDriver, dingtalk: dingtalkDriver }

/** Keeps pending authorizations and pairing codes out of persistent settings, domain messages and model tools. */
export class CliConnect {
  private readonly sessions = new Map<CliPlatform, Session>()
  private readonly pairings = new Map<CliPlatform, Pairing>()
  private readonly tasks = new Set<Promise<void>>()
  private disposed = false
  constructor(private readonly host: Host, private readonly managed: ManagedCli = new ManagedCli(host.stateDir),
    private readonly transport: Record<CliPlatform, CliDriver> = drivers) {
    host.lifetime.addEventListener('abort', () => { void this.dispose() }, { once: true })
  }
  private snapshot(platform: CliPlatform) {
    const instance = this.host.sources.instance(platform)
    if (!instance) throw new CliFailure('not_ready')
    const configured = !!(platform === 'feishu' ? instance.config.cli : instance.config.accountId && instance.config.credentialsFile)
    const allowed = (this.host.store.settings().policy.sources[platform]?.allowed.length ?? 0) > 0
    return { configured, enabled: instance.enabled, allowed }
  }
  private async recoverable(platform: CliPlatform, signal: AbortSignal, executable?: string) {
    const recover = this.transport[platform].recover, found = new Map<string, { cli: CliIo; identity: CliIdentity }>()
    if (!recover || signal.aborted) return found
    for (const directory of await this.managed.configurations(platform)) {
      if (signal.aborted) break
      const cli = this.managed.io(platform, executable, directory), identity = await recover(cli, signal)
      if (identity?.app && !found.has(identity.app.id)) found.set(identity.app.id, { cli, identity })
    }
    return found
  }
  async current(platform: CliPlatform): Promise<CliConnectView> {
    const saved = this.snapshot(platform)
    let session = this.sessions.get(platform)
    if (session?.boundRevision !== undefined && session.boundRevision !== this.host.store.blockRevision(`source:${platform}`)) {
      this.sessions.delete(platform); session = undefined
    }
    return structuredClone({ platform, id: null, status: saved.configured ? 'connected' : 'idle', ...session?.view, ...saved,
      canResume: !saved.configured && (!session || !active(session.view.status))
        && (await this.recoverable(platform, this.host.lifetime)).size > 0,
      cli: { installed: await this.managed.installed(platform), version: CLI_RELEASES[platform].version },
      ...this.pairings.has(platform) ? { pairing: this.pairings.get(platform)!.view } : {} })
  }
  private revisions(platform: CliPlatform, request: { sourceRevision: number; policyRevision: number }) {
    if (this.disposed || this.host.lifetime.aborted) throw new CliFailure('cancelled')
    if (request.sourceRevision !== this.host.store.blockRevision(`source:${platform}`) || request.policyRevision !== this.host.store.blockRevision('policy')) throw new CliFailure('settings_conflict')
  }
  private finish(session: Session, status: 'connected' | 'cancelled' | 'expired' | 'error', error?: CliConnectView['error']) {
    clearTimeout(session.timer); if (session.challengeTimer) clearTimeout(session.challengeTimer)
    session.view.status = status; delete session.view.challenge
    if (error) session.view.error = error; else delete session.view.error
    session.prepared = undefined
    session.abort.abort()
  }
  private task(session: Session, work: () => Promise<void>): void {
    if (session.busy || session.abort.signal.aborted) throw new CliFailure('not_ready')
    session.busy = true
    const job = (async () => {
      try { await work() }
      catch (error) {
        if (session.abort.signal.aborted) return
        if (error instanceof CliFailure && session.view.status === 'checking' && session.view.selectedApp) {
          const correctCredentials = error.code === 'credentials_required' || error.code === 'invalid_credentials'
            && (session.request.mode === 'manual' || session.view.platform === 'dingtalk')
          if (correctCredentials || ['network_failed', 'permission_required', 'invalid_credentials', 'invalid_response', 'authorization_failed', 'platform_policy_denied'].includes(error.code)) {
            session.view.status = correctCredentials ? 'credentials' : 'review'
            session.view.canConfirm = false
            if (error.code !== 'credentials_required') session.view.error = error.code
            session.view.checks = [{ id: 'identity', state: 'action' }, { id: 'bot', state: 'unknown' }]
            session.view.platformUrl ??= session.view.platform === 'feishu' ? 'https://open.feishu.cn/app' : 'https://open-dev.dingtalk.com/'
            return
          }
        }
        const code = error instanceof CliFailure ? error.code : error instanceof SettingsConflict ? 'settings_conflict' : 'save_failed'
        this.finish(session, code === 'expired' ? 'expired' : 'error', code)
      } finally { session.busy = false }
    })()
    this.tasks.add(job); void job.finally(() => this.tasks.delete(job))
  }
  private session(platform: CliPlatform, id: string): Session {
    const session = this.sessions.get(platform)
    if (!session || session.view.id !== id) throw new CliFailure('not_ready')
    return session
  }
  async begin(platform: CliPlatform, request: CliConnectRequest): Promise<CliConnectView> {
    this.revisions(platform, request)
    const saved = this.snapshot(platform)
    if (saved.configured && !request.replace) throw new CliFailure('settings_conflict')
    const previous = this.sessions.get(platform)
    if (previous && active(previous.view.status)) {
      if (JSON.stringify(previous.request) !== JSON.stringify(request)) throw new CliFailure('not_ready')
      return this.current(platform)
    }
    const expiresAt = new Date(Date.now() + 20 * 60_000).toISOString()
    const session: Session = { request: { ...request }, abort: new AbortController(), busy: false, identity: {}, deadline: expiresAt,
      view: { platform, id: randomUUID(), mode: request.mode, canConfirm: false, status: 'installing', expiresAt, ...saved,
        cli: { installed: false, version: CLI_RELEASES[platform].version } },
      timer: setTimeout(() => this.finish(session, 'expired', 'expired'), 20 * 60_000) }
    session.timer.unref?.(); this.sessions.set(platform, session)
    this.task(session, async () => {
      const executable = await this.managed.ensure(platform, session.abort.signal)
      if (session.abort.signal.aborted) return
      session.view.cli.installed = true
      if (request.mode === 'resume') {
        session.recovered = await this.recoverable(platform, session.abort.signal, executable)
        if (session.abort.signal.aborted) return
        if (!session.recovered.size) throw new CliFailure('not_ready')
        session.view.apps = [...session.recovered.values()].map(saved => saved.identity.app!)
        session.view.status = 'select_app'
        return
      }
      const configDir = await this.managed.connectionDirectory(platform)
      session.cli = this.managed.io(platform, executable, configDir)
      if (session.abort.signal.aborted) return
      if (request.mode === 'manual') { session.view.status = 'credentials'; return }
      session.view.status = 'authorizing'
      const identity = await this.transport[platform].authorize(session.cli, session.abort.signal, value => {
        if (session.abort.signal.aborted) return
        const deadline = Math.min(Date.parse(session.deadline), Date.parse(value.expiresAt ?? session.deadline))
        if (!Number.isFinite(deadline) || deadline <= Date.now()) { this.finish(session, 'expired', 'expired'); return }
        if (session.challengeTimer) clearTimeout(session.challengeTimer)
        session.view.expiresAt = new Date(deadline).toISOString()
        session.view.status = 'waiting'; session.view.challenge = { ...value, expiresAt: session.view.expiresAt }
        session.challengeTimer = setTimeout(() => this.finish(session, 'expired', 'expired'), deadline - Date.now()); session.challengeTimer.unref?.()
      })
      if (session.abort.signal.aborted) return
      if (session.challengeTimer) clearTimeout(session.challengeTimer)
      session.view.expiresAt = session.deadline
      session.identity = identity; delete session.view.challenge
      session.view.account = { ...identity.name ? { name: identity.name } : {}, ...identity.organization ? { organization: identity.organization } : {} }
      session.view.status = 'checking'
      const apps = await this.transport[platform].applications(session.cli, identity, session.abort.signal)
      if (session.abort.signal.aborted) return
      session.view.apps = apps
      if (platform === 'feishu' && identity.app) { session.view.selectedApp = identity.app; await this.prepare(session) }
      else session.view.status = 'select_app'
    })
    return this.current(platform)
  }
  private async prepare(session: Session, credentials?: CliCredentials) {
    const app = session.view.selectedApp
    if (!session.cli || !app) throw new CliFailure('not_ready')
    session.view.status = 'checking'; session.view.canConfirm = false; delete session.view.error
    if (session.view.platform === 'feishu') session.view.platformUrl = `https://open.feishu.cn/app/${encodeURIComponent(app.id)}`
    const prepared = await this.transport[session.view.platform].prepare({ cli: session.cli, identity: session.identity, app,
      ...credentials ? { credentials } : {}, ...session.prepared ? { previous: session.prepared } : {}, signal: session.abort.signal })
    if (session.abort.signal.aborted) return
    session.prepared = prepared; session.view.checks = prepared.checks; session.view.platformUrl = prepared.platformUrl
    session.view.selectedApp = { ...app, name: prepared.name }
    session.view.status = 'review'; session.view.canConfirm = !prepared.checks.some(check => check.state === 'action')
  }
  async select(platform: CliPlatform, id: string, appId: string): Promise<CliConnectView> {
    const session = this.session(platform, id)
    if (session.view.status !== 'select_app') throw new CliFailure('not_ready')
    const app = session.view.apps?.find(item => item.id === appId)
    if (!app) throw new CliFailure('invalid_response')
    session.view.selectedApp = app
    if (session.request.mode === 'resume') {
      const saved = session.recovered?.get(app.id)
      if (!saved) throw new CliFailure('not_ready')
      session.cli = saved.cli; session.identity = saved.identity
    }
    this.task(session, () => this.prepare(session))
    return this.current(platform)
  }
  async credentials(platform: CliPlatform, id: string, credentials: CliCredentials): Promise<CliConnectView> {
    const session = this.session(platform, id)
    if (session.view.status !== 'credentials' || !session.cli) throw new CliFailure('not_ready')
    if (session.request.mode === 'manual') {
      session.view.selectedApp = { id: credentials.appId, name: credentials.appId,
        ...platform === 'dingtalk' ? { clientId: credentials.clientId ?? credentials.appId } : {} }
      session.identity = {}; session.prepared = undefined; session.view.status = 'checking'
      this.task(session, async () => {
        const configDir = await this.managed.connectionDirectory(platform)
        if (session.abort.signal.aborted) return
        session.cli = this.managed.io(platform, session.cli!.executable, configDir)
        await this.prepare(session, credentials)
      })
    } else {
      if (!session.view.selectedApp || session.view.selectedApp.id !== credentials.appId) throw new CliFailure('invalid_credentials')
      this.task(session, () => this.prepare(session, credentials))
    }
    return this.current(platform)
  }
  async check(platform: CliPlatform, id: string): Promise<CliConnectView> {
    const session = this.session(platform, id)
    if (session.view.status !== 'review') throw new CliFailure('not_ready')
    this.task(session, () => this.prepare(session))
    return this.current(platform)
  }
  async confirm(platform: CliPlatform, id: string, request: { enable: boolean; sourceRevision: number; policyRevision: number }): Promise<CliConnectView> {
    const session = this.session(platform, id)
    this.revisions(platform, request); this.revisions(platform, session.request)
    if (session.view.status !== 'review' || !session.view.canConfirm || !session.prepared || !session.cli) throw new CliFailure('not_ready')
    const prepared = session.prepared, cli = session.cli
    session.view.status = 'saving'
    this.task(session, async () => {
      let file: string | undefined, inode: number | undefined
      try {
        const config: Record<string, unknown> = {}
        if (platform === 'feishu') config.cli = await this.managed.wrapper(await this.managed.compactFeishu(cli, prepared.accountId, session.abort.signal))
        else {
          if (!prepared.credential || prepared.credential.clientId !== prepared.accountId) throw new CliFailure('invalid_credentials')
          await checkDirectoryChain(cli.configDir)
          file = join(cli.configDir, `robot-${randomUUID()}.json`)
          await writeFile(file, JSON.stringify(prepared.credential), { flag: 'wx', mode: 0o600 }); inode = (await lstat(file)).ino
          Object.assign(config, { accountId: prepared.accountId, credentialsFile: file })
        }
        if (session.abort.signal.aborted) throw new CliFailure('cancelled')
        await this.host.settings.bindCli({ platform, config, accountId: prepared.accountId, previousAccountId: this.host.account(platform),
          enable: request.enable, replace: !!session.request.replace, sourceRevision: session.request.sourceRevision,
          policyRevision: session.request.policyRevision, signal: session.abort.signal })
        session.boundRevision = this.host.store.blockRevision(`source:${platform}`)
        this.finish(session, 'connected')
      } catch (error) {
        if (file && this.host.sources.instance(platform)?.config.credentialsFile !== file) {
          try {
            await checkDirectoryChain(cli.configDir)
            const info = await lstat(file)
            if (dirname(resolve(file)) === resolve(cli.configDir) && !info.isSymbolicLink() && info.isFile() && info.ino === inode) await unlink(file)
          } catch { /* Never remove a replaced or redirected path. */ }
        }
        throw error
      }
    })
    return this.current(platform)
  }
  async cancel(platform: CliPlatform, id: string): Promise<CliConnectView> {
    const session = this.session(platform, id)
    if (active(session.view.status)) this.finish(session, 'cancelled')
    return this.current(platform)
  }
  async pair(platform: CliPlatform, request: { sourceRevision: number; policyRevision: number }): Promise<CliConnectView> {
    this.revisions(platform, request)
    const saved = this.snapshot(platform)
    if (!saved.configured || !saved.enabled || !this.host.account(platform) || this.host.sources.instance(platform)?.config.directMessages === false) throw new CliFailure('not_ready')
    const previous = this.pairings.get(platform)
    if (previous?.view.status === 'waiting' && previous.sourceRevision === request.sourceRevision && previous.policyRevision === request.policyRevision) return this.current(platform)
    if (previous) clearTimeout(previous.timer)
    const pairing: Pairing = { ...request, account: this.host.account(platform), view: { id: randomUUID(), status: 'waiting',
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(), command: `/superagent pair ${randomBytes(18).toString('base64url')}` },
      timer: setTimeout(() => { pairing.view.status = 'expired'; delete pairing.view.command }, 5 * 60_000) }
    pairing.timer.unref?.(); this.pairings.set(platform, pairing)
    return this.current(platform)
  }
  async cancelPair(platform: CliPlatform, id: string): Promise<CliConnectView> {
    const pairing = this.pairings.get(platform)
    if (!pairing || pairing.view.id !== id) throw new CliFailure('not_ready')
    if (pairing.view.status === 'waiting') { clearTimeout(pairing.timer); pairing.view.status = 'cancelled'; delete pairing.view.command }
    return this.current(platform)
  }
  /** Reserve pairing messages before Engine intake, including stale/replayed codes, so secrets never become tasks or context. */
  receive(trigger: Trigger): boolean {
    if (trigger.source !== 'feishu' && trigger.source !== 'dingtalk') return false
    const text = trigger.text.trim()
    if (!/^\/superagent\s+pair(?:\s|$)/.test(text)) return false
    const platform = trigger.source, pairing = this.pairings.get(platform), expected = pairing?.view.command
    if (!pairing || pairing.view.status !== 'waiting' || !expected || this.disposed || !trigger.human || trigger.addressed !== 'direct'
      || trigger.actor.source !== platform || trigger.channel?.source !== platform || !trigger.actor.id || Date.now() >= Date.parse(pairing.view.expiresAt)) return true
    const received = Buffer.from(text), wanted = Buffer.from(expected)
    if (received.length !== wanted.length || !timingSafeEqual(received, wanted)) return true
    if (this.host.account(platform) !== pairing.account || !this.host.sources.scope(trigger).listened) return true
    if (platform === 'dingtalk' && trigger.meta.accountId !== pairing.account) return true
    try {
      this.host.settings.pairCliUser({ platform, userId: trigger.actor.id, sourceRevision: pairing.sourceRevision, policyRevision: pairing.policyRevision })
      pairing.view.status = 'paired'; pairing.view.userId = trigger.actor.id
    } catch { pairing.view.status = 'conflict' }
    clearTimeout(pairing.timer); delete pairing.view.command
    return true
  }
  async dispose(): Promise<void> {
    this.disposed = true
    for (const session of this.sessions.values()) if (active(session.view.status)) this.finish(session, 'cancelled')
    for (const pairing of this.pairings.values()) { clearTimeout(pairing.timer); delete pairing.view.command }
    await Promise.allSettled([...this.tasks])
  }
}
