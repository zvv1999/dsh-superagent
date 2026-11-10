/** Ephemeral, panel-only WeChat pairing; credentials never enter settings, API responses, or model context. */
import { randomUUID } from 'node:crypto'
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, parse, resolve, sep } from 'node:path'
import { z } from 'zod'
import { beginWechatLogin, pollWechatLogin, type WechatConfirmation } from '../sources/im-wechat-login.ts'
import { WECHAT_API } from '../sources/im-wechat.ts'
import { pause } from '../sources/poll.ts'
import type { WechatLoginRequest, WechatLoginView } from './api.ts'
import { SettingsConflict, type Settings } from './settings.ts'
import type { Store } from './store.ts'
import type { SourceRegistry } from '../sources/registry.ts'

export const WechatLoginRequestSchema = z.object({ enable: z.boolean(), replace: z.boolean().default(false),
  sourceRevision: z.number().int().nonnegative(), policyRevision: z.number().int().nonnegative() }).strict()
/** Safe, fixed pairing-route failure serialized by the management HTTP boundary. */
export class WechatLoginError extends Error {
  constructor(readonly status: 400 | 404 | 409, message: string) { super(message) }
}
interface Host {
  stateDir: string
  lifetime: AbortSignal
  store: Pick<Store, 'settings' | 'blockRevision'>
  sources: Pick<SourceRegistry, 'instance'>
  settings: Pick<Settings, 'bindWechat'>
}
const protocol = { begin: beginWechatLogin, poll: pollWechatLogin, pause }
interface Session {
  view: WechatLoginView
  request: WechatLoginRequest
  abort: AbortController
  timer: ReturnType<typeof setTimeout>
  task?: Promise<void>
  code?: string
  wake?: () => void
}
const active = (view: WechatLoginView) => ['starting', 'waiting', 'scanned', 'verification', 'saving'].includes(view.status)

/** Check every path component before creating an exclusive file. Never overwrite or remove an existing account credential. */
function checkDirectories(directory: string): void {
  const absolute = resolve(directory), root = parse(absolute).root
  let path = root
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    path = join(path, part)
    const info = lstatSync(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe private directory')
  }
}
function syncDirectory(directory: string): void {
  // Windows does not expose POSIX directory fsync or permission bits; the profile's ACL remains authoritative.
  if (process.platform === 'win32') return
  const handle = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try { fsyncSync(handle) } finally { closeSync(handle) }
}
function privateCredential(stateDir: string, credential: WechatConfirmation['credential']): { file: string; rollback(): void } {
  checkDirectories(stateDir)
  const directory = join(resolve(stateDir), 'im-private')
  try { mkdirSync(directory, { mode: 0o700 }) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
  checkDirectories(directory)
  const info = lstatSync(directory)
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) throw new Error('Unsafe private directory permissions')
  const file = join(directory, `wechat-credential-${randomUUID()}.json`)
  const handle = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  const identity = fstatSync(handle)
  const rollback = () => {
    // This is always the exact, exclusive file created above; refuse a swapped path or directory.
    checkDirectories(dirname(file))
    const current = lstatSync(file)
    if (!current.isFile() || current.isSymbolicLink() || current.ino !== identity.ino || current.dev !== identity.dev) throw new Error('Private credential changed')
    unlinkSync(file)
  }
  try {
    writeFileSync(handle, JSON.stringify(credential)); fsyncSync(handle)
    // Persist both directory entries before SQLite may refer to the credential after a crash.
    syncDirectory(directory); syncDirectory(resolve(stateDir))
  }
  catch (error) { closeSync(handle); rollback(); throw error }
  closeSync(handle)
  return { file, rollback }
}

/** Owns one ephemeral panel pairing session, serializes upstream polling, and cancels every pending task on runtime disposal. */
export class WechatLogin {
  private session?: Session
  private disposed = false
  private readonly tasks = new Set<Promise<void>>()
  private readonly stopped = () => { void this.dispose() }
  constructor(private readonly host: Host, private readonly transport = protocol, private readonly ttl = 5 * 60_000) {
    host.lifetime.addEventListener('abort', this.stopped, { once: true })
  }
  current(): WechatLoginView | null { return this.session ? this.view(this.session) : null }
  get(id: string): WechatLoginView { return this.view(this.find(id)) }
  begin(input: WechatLoginRequest): WechatLoginView {
    const request = WechatLoginRequestSchema.parse(input)
    if (this.disposed || this.host.lifetime.aborted) throw new WechatLoginError(409, 'WeChat login is unavailable while stopping.')
    if (this.session && active(this.session.view)) {
      if (JSON.stringify(request) !== JSON.stringify(this.session.request)) throw new WechatLoginError(409, 'Cancel the current WeChat login before changing options.')
      return this.view(this.session)
    }
    const instance = this.host.sources.instance('wechat')
    if (!instance) throw new WechatLoginError(404, 'WeChat source is not installed.')
    this.checkRevisions(request)
    if ((instance.config.accountId || instance.config.credentialsFile) && !request.replace) {
      throw new WechatLoginError(409, 'Replacing a WeChat account requires explicit confirmation.')
    }
    const session: Session = { request, abort: new AbortController(),
      view: { id: randomUUID(), status: 'starting', expiresAt: new Date(Date.now() + this.ttl).toISOString() },
      timer: setTimeout(() => this.finish(session, 'expired'), this.ttl) }
    session.timer.unref?.()
    this.session = session
    session.task = this.run(session)
    this.tasks.add(session.task)
    void session.task.then(() => { this.tasks.delete(session.task!) })
    return this.view(session)
  }
  cancel(id: string): WechatLoginView {
    const session = this.find(id)
    if (active(session.view)) this.finish(session, 'cancelled')
    return this.view(session)
  }
  verify(id: string, value: string): WechatLoginView {
    const code = z.string().regex(/^\d{4,12}$/).parse(value), session = this.find(id)
    if (session.view.status !== 'verification' || session.code) throw new WechatLoginError(409, 'WeChat login is not waiting for a verification code.')
    session.code = code
    session.view.status = 'scanned'
    session.wake?.()
    return this.view(session)
  }
  async dispose(): Promise<void> {
    this.disposed = true
    this.host.lifetime.removeEventListener('abort', this.stopped)
    const session = this.session
    if (session && active(session.view)) this.finish(session, 'cancelled')
    await Promise.all(this.tasks)
  }
  private find(id: string): Session {
    if (!this.session || this.session.view.id !== id) throw new WechatLoginError(404, 'WeChat login session not found.')
    return this.session
  }
  private view(session: Session): WechatLoginView { return { ...session.view } }
  private finish(session: Session, status: 'expired' | 'cancelled' | 'error' | 'connected', error?: WechatLoginView['error']): void {
    session.view.status = status
    delete session.view.qrUrl
    if (error) session.view.error = error
    session.code = undefined
    clearTimeout(session.timer)
    session.abort.abort()
    session.wake?.()
  }
  private checkRevisions(request: WechatLoginRequest): void {
    if (request.sourceRevision !== this.host.store.blockRevision('source:wechat')
      || request.policyRevision !== this.host.store.blockRevision('policy')) throw new SettingsConflict('Settings changed. Start WeChat login again.')
  }
  private async run(session: Session): Promise<void> {
    const signal = session.abort.signal
    try {
      const login = await this.transport.begin(signal)
      if (signal.aborted) return
      session.view.qrUrl = login.url
      session.view.status = 'waiting'
      let base = WECHAT_API
      while (!signal.aborted) {
        const code = session.code; session.code = undefined
        const result = await this.transport.poll(login.qrcode, base, signal, code)
        if (signal.aborted) return
        if (result.status === 'confirmed') {
          const { accountId, userId, credential } = result.confirmation
          if (!userId) { this.finish(session, 'error', 'missing_user'); return }
          session.view.status = 'saving'
          // No await between the final concurrency check, exclusive write and synchronous settings transaction.
          this.checkRevisions(session.request)
          let saved: ReturnType<typeof privateCredential> | undefined
          try {
            saved = privateCredential(this.host.stateDir, credential)
            this.host.settings.bindWechat({ ...session.request, accountId, userId, credentialsFile: saved.file })
          } catch (error) {
            try { saved?.rollback() } catch { /* Never report paths, upstream values, or token data. */ }
            this.finish(session, 'error', error instanceof SettingsConflict ? 'settings_conflict' : 'save_failed')
            return
          }
          session.view.accountId = accountId; session.view.userId = userId; session.view.enabled = session.request.enable
          this.finish(session, 'connected')
          return
        }
        if (result.status === 'expired') { this.finish(session, 'expired'); return }
        if (result.status === 'redirect') base = result.base
        else session.view.status = result.status
        if (result.status === 'verification') {
          await new Promise<void>(resolve => { session.wake = resolve })
          session.wake = undefined
        } else await this.transport.pause(1000, signal)
      }
    } catch (error) {
      if (!signal.aborted) this.finish(session, 'error', error instanceof SettingsConflict ? 'settings_conflict' : 'upstream_failed')
    }
  }
}
