/** Feishu CLI 1.0.99 onboarding: app registration only; never personal OAuth. */
import { constants } from 'node:fs'
import { lstat, open, readdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { CliFailure, type CliCheck, type CliCommandOptions, type CliDriver, type CliIdentity, type CliIo, type CliPrepareInput } from './cli-connect-types.ts'
import { checkDirectoryChain } from './managed-cli.ts'

const appIdSchema = z.string().regex(/^cli_[A-Za-z0-9]+$/)
const initSchema = z.object({ appId: appIdSchema, appSecret: z.literal('****'), brand: z.enum(['feishu', 'lark']) })
const statusSchema = z.object({ appId: appIdSchema, brand: z.enum(['feishu', 'lark']), defaultAs: z.string(),
  identities: z.object({ bot: z.object({ status: z.string(), available: z.boolean(), verified: z.boolean().optional(),
    error: z.object({ code: z.number().optional(), type: z.string().optional(), subtype: z.string().optional() }).optional() }) }) })
const savedSchema = z.object({ apps: z.array(z.object({ appId: appIdSchema, brand: z.enum(['feishu', 'lark']),
  appSecret: z.object({ source: z.enum(['keychain', 'file']), id: z.string() }), users: z.array(z.unknown()).max(0).optional(),
})).length(1) })
const botSchema = z.object({ code: z.literal(0), bot: z.object({ open_id: z.string().regex(/^ou_[A-Za-z0-9]+$/), app_name: z.string().max(200).optional() }) })
const versionsSchema = z.object({ code: z.literal(0), data: z.object({ items: z.array(z.object({
  status: z.number(), publish_time: z.union([z.string(), z.number()]).nullable().optional(),
  event_infos: z.array(z.object({ event_type: z.string() })).optional(),
  scopes: z.array(z.object({ scope: z.string(), token_types: z.array(z.string()).nullable().optional() })).optional(),
})) }) })
const tokenSchema = z.object({ code: z.literal(0).optional(), error: z.string().optional(), access_token: z.string().min(1), expires_in: z.number().positive() })
const commandTimeout = 30_000

function active(signal: AbortSignal): void { if (signal.aborted) throw new CliFailure('cancelled') }
function parse<T>(schema: z.ZodType<T>, text: string): T {
  try { return schema.parse(JSON.parse(text)) } catch { throw new CliFailure('invalid_response') }
}
async function run(cli: CliIo, args: readonly string[], options: CliCommandOptions, fallback: 'authorization_failed' | 'invalid_credentials' | 'permission_required' = 'invalid_credentials') {
  active(options.signal)
  try {
    const result = await cli.run(args, { timeoutMs: commandTimeout, ...options })
    active(options.signal)
    return result
  } catch (error) {
    active(options.signal)
    throw error instanceof CliFailure ? error : new CliFailure(fallback)
  }
}

/** Parse complete lines only: streaming chunks may end in the middle of a URL. */
function registrationUrl(line: string): string | undefined {
  const value = line.trim()
  if (value.length > 4096 || !value.startsWith('https://open.feishu.cn/page/cli?') || /[\s<>"'\\]/.test(value)) return
  try {
    const url = new URL(value)
    if (url.origin !== 'https://open.feishu.cn' || url.pathname !== '/page/cli' || url.hash || url.username || url.password) return
    if (!url.searchParams.get('user_code')) return
    return value
  } catch { return }
}

async function emptyPrivateDirectory(path: string): Promise<void> {
  try {
    if (!isAbsolute(path)) throw new Error()
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 || (await readdir(path)).length) throw new Error()
  } catch { throw new CliFailure('not_ready') }
}

/** Bound token response before parsing; upstream bodies and tokens never become public errors. */
async function responseText(response: Response): Promise<string> {
  if (!response.body) throw new CliFailure('invalid_response')
  const reader = response.body.getReader(), chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.byteLength
      if (length > 65_536) throw new CliFailure('invalid_response')
      chunks.push(next.value)
    }
    return Buffer.concat(chunks).toString('utf8')
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

async function configureExisting(input: CliPrepareInput): Promise<void> {
  const { cli, credentials, signal, app } = input
  if (!credentials || !appIdSchema.safeParse(credentials.appId).success || credentials.appId !== app.id
    || !credentials.secret.trim() || credentials.secret.length > 4096 || /[\r\n\0]/.test(credentials.secret)) throw new CliFailure('invalid_credentials')
  active(signal)
  await emptyPrivateDirectory(cli.configDir)
  // Mint directly using the submitted secret, never a cached token from a CLI profile.
  try {
    const response = await fetch('https://accounts.feishu.cn/oauth/v3/token', {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: credentials.appId, client_secret: credentials.secret.trim() }),
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new CliFailure(response.status === 400 || response.status === 401 || response.status === 403 ? 'invalid_credentials' : 'network_failed')
    }
    const text = await responseText(response)
    let body: unknown
    try { body = JSON.parse(text) } catch { throw new CliFailure('invalid_response') }
    if (body && typeof body === 'object' && 'error' in body && body.error) throw new CliFailure('invalid_credentials')
    parse(tokenSchema, text)
  } catch (error) {
    active(signal)
    if (error instanceof CliFailure) throw error
    throw new CliFailure('network_failed')
  }
  active(signal)
  await emptyPrivateDirectory(cli.configDir)
  // macOS appsecret:<appId> entries are shared across config directories. File refs
  // are supported by the official CLI and avoid touching that shared keychain.
  const secretPath = join(cli.configDir, 'app-secret')
  try {
    active(signal)
    await writeFile(secretPath, credentials.secret.trim(), { flag: 'wx', mode: 0o600 })
    active(signal)
    await writeFile(join(cli.configDir, 'config.json'), JSON.stringify({ apps: [{
      appId: app.id, appSecret: { source: 'file', id: secretPath }, brand: 'feishu', lang: 'zh_cn',
      strictMode: 'bot', defaultAs: 'bot', users: [],
    }] }), { flag: 'wx', mode: 0o600 })
    active(signal)
  } catch (error) {
    active(signal)
    throw error instanceof CliFailure ? error : new CliFailure('save_failed')
  }
}

async function publishedChecks(cli: CliIo, appId: string, signal: AbortSignal): Promise<CliCheck[]> {
  const unknown: CliCheck[] = [{ id: 'published', state: 'unknown' }, { id: 'receive', state: 'unknown' }, { id: 'send', state: 'unknown' }]
  try {
    const result = await run(cli, ['api', 'GET', `/open-apis/application/v6/applications/${appId}/app_versions`,
      '--params', JSON.stringify({ lang: 'zh_cn', page_size: 2 }), '--as', 'bot', '--format', 'ndjson'], { signal }, 'permission_required')
    const versions = parse(versionsSchema, result.stdout)
    const published = versions.data.items.find(item => item.status === 1 && item.publish_time != null && String(item.publish_time) !== '' && String(item.publish_time) !== '0')
    if (!published) return [{ id: 'published', state: 'action' }, { id: 'receive', state: 'action' }, { id: 'send', state: 'action' }]
    const scopes = new Set(published.scopes?.filter(scope => scope.token_types == null || scope.token_types.includes('tenant')).map(scope => scope.scope))
    // Matches the CLI's own im.message.receive_v1 preflight: private messages are
    // sufficient for initial pairing. Group/history grants depend on source settings.
    const receive = scopes.has('im:message.p2p_msg:readonly')
    const send = scopes.has('im:message:send_as_bot')
    const subscribed = published.event_infos?.some(event => event.event_type === 'im.message.receive_v1')
    return [{ id: 'published', state: 'passed' },
      { id: 'receive', state: published.scopes === undefined || published.event_infos === undefined ? 'unknown' : receive && subscribed ? 'passed' : 'action' },
      { id: 'send', state: published.scopes === undefined ? 'unknown' : send ? 'passed' : 'action' }]
  } catch {
    active(signal)
    return unknown
  }
}

/** Registration can save the app and then exit nonzero from its separate token probe. */
async function recover(cli: CliIo, signal: AbortSignal): Promise<CliIdentity | undefined> {
  active(signal)
  if (!isAbsolute(cli.configDir)) return
  try {
    await checkDirectoryChain(cli.configDir)
    const directory = await lstat(cli.configDir)
    if (process.platform !== 'win32' && ((directory.mode & 0o077) || directory.uid !== process.getuid?.())) return
    const configPath = join(cli.configDir, 'config.json')
    const pathInfo = await lstat(configPath)
    if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) return
    const file = await open(configPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const info = await file.stat()
      if (!info.isFile() || info.nlink !== 1 || info.size > 65_536
        || (process.platform !== 'win32' && ((info.mode & 0o077) || info.uid !== process.getuid?.()))) return
      const buffer = Buffer.alloc(65_537), { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      if (bytesRead > 65_536) return
      const data = savedSchema.parse(JSON.parse(buffer.toString('utf8', 0, bytesRead))), app = data.apps[0]!
      if (app.appSecret.source === 'keychain') {
        if (app.appSecret.id !== `appsecret:${app.appId}`) return
      } else {
        if (app.appSecret.id !== join(cli.configDir, 'app-secret')) return
        const secret = await lstat(app.appSecret.id)
        if (!secret.isFile() || secret.isSymbolicLink() || secret.nlink !== 1 || secret.size < 1 || secret.size > 4096
          || (process.platform !== 'win32' && ((secret.mode & 0o077) || secret.uid !== process.getuid?.()))) return
      }
      active(signal)
      return { app: { id: app.appId, name: app.appId } }
    } finally { await file.close() }
  } catch { active(signal); return }
}

export const feishuDriver: CliDriver = {
  recover,
  async authorize(cli, signal, challenge) {
    active(signal)
    await emptyPrivateDirectory(cli.configDir)
    let pending = '', seen = false
    const lines = (chunk: string, final = false) => {
      pending += chunk
      const parts = pending.split(/\r?\n/)
      pending = final ? '' : parts.pop() ?? ''
      if (pending.length > 8192) pending = ''
      for (const line of parts) {
        const url = registrationUrl(line)
        if (!url || seen) continue
        active(signal)
        seen = true
        challenge({ url, expiresAt: new Date(Date.now() + 600_000).toISOString() })
      }
    }
    let result
    try {
      result = await run(cli, ['config', 'init', '--new', '--brand', 'feishu', '--lang', 'zh_cn'], {
        signal, timeoutMs: 660_000, onOutput: (stream, chunk) => { if (stream === 'stderr') lines(chunk) },
      }, 'authorization_failed')
    } catch (error) {
      active(signal)
      if (error instanceof CliFailure && error.code === 'authorization_failed') {
        const saved = await recover(cli, signal)
        if (saved) return saved
      }
      throw error
    }
    // A runner can also return output without streaming (e.g. a process exits immediately).
    if (!seen) { pending = ''; lines(result.stderr + '\n', true) }
    const data = parse(initSchema, result.stdout)
    return { app: { id: data.appId, name: data.appId } }
  },
  async applications(_cli, identity, signal) {
    active(signal)
    if (!identity.app || !appIdSchema.safeParse(identity.app.id).success) throw new CliFailure('credentials_required')
    return [{ id: identity.app.id, name: identity.app.name }]
  },
  async prepare(input) {
    const { cli, app, previous, signal } = input
    active(signal)
    if (!appIdSchema.safeParse(app.id).success) throw new CliFailure('invalid_credentials')
    if (previous && previous.accountId !== app.id) throw new CliFailure('invalid_credentials')
    if (!previous) {
      if (input.credentials) await configureExisting(input)
      await run(cli, ['config', 'strict-mode', 'bot'], { signal }, 'permission_required')
      await run(cli, ['config', 'default-as', 'bot'], { signal }, 'permission_required')
    }
    const mode = await run(cli, ['config', 'strict-mode'], { signal }, 'permission_required')
    if (!/^strict-mode:\s*bot(?:\s|$)/m.test(mode.stdout)) throw new CliFailure('permission_required')
    const status = parse(statusSchema, (await run(cli, ['auth', 'status', '--verify', '--json'], { signal })).stdout)
    if (status.defaultAs !== 'bot') throw new CliFailure('permission_required')
    if (status.appId !== app.id) throw new CliFailure('invalid_credentials')
    if (status.identities.bot.error?.code === 21001 && status.identities.bot.error.type === 'policy') throw new CliFailure('platform_policy_denied')
    if (status.identities.bot.status !== 'ready' || !status.identities.bot.available || status.identities.bot.verified !== true) throw new CliFailure('invalid_credentials')
    const bot = parse(botSchema, (await run(cli, ['api', 'GET', '/open-apis/bot/v3/info', '--as', 'bot', '--format', 'ndjson'], { signal })).stdout)
    const checks: CliCheck[] = [{ id: 'identity', state: 'passed' }, { id: 'bot', state: 'passed' }, ...await publishedChecks(cli, app.id, signal)]
    active(signal)
    return { accountId: app.id, name: bot.bot.app_name || app.name || app.id, checks,
      platformUrl: `https://${status.brand === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn'}/app/${app.id}` }
  },
}
