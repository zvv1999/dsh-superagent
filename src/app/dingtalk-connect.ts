/** dws 1.0.67 management adapter. Personal OAuth stays in the host's managed CLI directory. */
import { stripVTControlCharacters } from 'node:util'
import { CliFailure, type CliApplication, type CliChallenge, type CliDriver, type CliIdentity, type CliIo, type CliPrepareInput, type CliPrepared } from './cli-connect-types.ts'

const PLATFORM_URL = 'https://open-dev.dingtalk.com/'
const MAX_JSON = 1024 * 1024
const MAX_APPS = 1000
const MAX_PAGES = 50

type ObjectValue = Record<string, unknown>
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CliFailure('invalid_response')
  return value as ObjectValue
}
function text(value: unknown, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new CliFailure('invalid_response')
  return value.trim()
}
function id(value: unknown): string {
  const result = text(value)
  // Profile selectors are CSV and colon-delimited in dws: identities must never inject another selector.
  if (!/^[A-Za-z0-9_.@-]+$/u.test(result)) throw new CliFailure('invalid_response')
  return result
}
function optionalText(value: unknown): string | undefined { return value === undefined ? undefined : text(value, 256) }
function json(raw: string): ObjectValue {
  if (raw.length > MAX_JSON) throw new CliFailure('invalid_response')
  try { return object(JSON.parse(raw)) } catch { throw new CliFailure('invalid_response') }
}
function active(signal: AbortSignal): void { if (signal.aborted) throw new CliFailure('cancelled') }
function profile(identity: CliIdentity): string {
  const parts = identity.profileId?.split(':')
  if (!parts || parts.length !== 2) throw new CliFailure('authorization_failed')
  return `${id(parts[0])}:${id(parts[1])}`
}
async function command(cli: CliIo, args: string[], signal: AbortSignal): Promise<ObjectValue> {
  active(signal)
  try {
    const result = await cli.run(args, { signal, timeoutMs: 45_000 })
    active(signal)
    return json(result.stdout)
  } catch (error) {
    active(signal)
    if (error instanceof CliFailure) throw error
    throw new CliFailure('network_failed')
  }
}
function envelope(result: ObjectValue): ObjectValue {
  if (result.ok !== true || result.outcome !== 'success' || result.dry_run === true) throw new CliFailure('invalid_response')
  return object(result.data)
}
function aliases(data: ObjectValue, keys: string[], parse = id): string | undefined {
  const values = keys.filter(key => data[key] !== undefined).map(key => parse(data[key]))
  if (new Set(values).size > 1) throw new CliFailure('invalid_response')
  return values[0]
}
function secret(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new CliFailure('credentials_required')
  const result = text(value, 8192)
  if (/[\s*<>]/u.test(result) || /^(?:\[?(?:redacted|masked|hidden|secret|placeholder)\]?|x{4,}|•+)$/iu.test(result)) throw new CliFailure('credentials_required')
  return result
}
function target(data: ObjectValue, app: CliApplication, clientId: string): void {
  if (data.unifiedAppId !== undefined && id(data.unifiedAppId) !== app.id) throw new CliFailure('invalid_response')
  const actual = aliases(data, ['clientId', 'appKey', 'clientID'])
  if (actual && actual !== clientId) throw new CliFailure('invalid_response')
}

/** The CLI has no JSON device-start protocol: parse only its documented, labelled stderr lines. */
function challengeReader(signal: AbortSignal, emit: (value: CliChallenge) => void) {
  let pending = ''; let total = 0; let code: string | undefined; let expiresAt: string | undefined
  let label: 'complete' | 'manual' | undefined; let complete = false
  const line = (raw: string) => {
    active(signal)
    const value = stripVTControlCharacters(raw).trim()
    const codeMatch = /^(?:authorization code:|授权码:)\s*([A-Za-z0-9-]{2,64})$/u.exec(value)
    if (codeMatch) { code = codeMatch[1]; expiresAt = undefined; complete = false; label = undefined; return }
    const expiry = /^(?:Authorization code will expire in (\d+) seconds\.|授权码将在 (\d+) 秒后过期。)$/u.exec(value)
    if (expiry) {
      const seconds = Number(expiry[1] ?? expiry[2])
      if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600) throw new CliFailure('invalid_response')
      expiresAt = new Date(Date.now() + seconds * 1000).toISOString(); return
    }
    if (value === 'Authorization link (code included):' || value === '授权链接（已填入授权码）：') { label = 'complete'; return }
    if (value === 'Link for entering the code manually:' || value === '手动输入授权码的链接：') { label = 'manual'; return }
    if (!label || !value) return
    const kind = label; label = undefined
    let url: URL
    try { url = new URL(value) } catch { throw new CliFailure('invalid_response') }
    if (value.length > 8192 || url.protocol !== 'https:' || !['login.dingtalk.com', 'login.dingtalk.io'].includes(url.hostname)
      || url.username || url.password || (url.port && url.port !== '443') || !code || !expiresAt) throw new CliFailure('invalid_response')
    if (kind === 'manual' && complete) return
    complete = kind === 'complete'
    emit({ url: url.href, userCode: code, expiresAt })
  }
  return {
    write(chunk: string) {
      total += chunk.length
      if (total > MAX_JSON) throw new CliFailure('invalid_response')
      pending += chunk
      let end: number
      while ((end = pending.indexOf('\n')) >= 0) { const current = pending.slice(0, end); pending = pending.slice(end + 1); line(current) }
      if (pending.length > 16384) throw new CliFailure('invalid_response')
    },
    finish() { if (pending) { line(pending); pending = '' } },
  }
}

async function authorize(cli: CliIo, signal: AbortSignal, emit: (value: CliChallenge) => void): Promise<CliIdentity> {
  active(signal)
  const reader = challengeReader(signal, emit)
  const parserAbort = new AbortController()
  let streamed = false; let parseError: CliFailure | undefined
  try {
    const result = await cli.run(['auth', 'login', '--device', '--no-browser', '--format', 'json', '--yes'], {
      signal: AbortSignal.any([signal, parserAbort.signal]), timeoutMs: 16 * 60_000,
      onOutput(stream, chunk) {
        if (stream !== 'stderr' || parseError || signal.aborted) return
        streamed = true
        try { reader.write(chunk) } catch { parseError = new CliFailure('invalid_response'); parserAbort.abort() }
      },
    })
    active(signal)
    if (parseError) throw parseError
    if (!streamed) reader.write(result.stderr)
    reader.finish()
    const resultJson = json(result.stdout)
    if (resultJson.success !== true || (resultJson.token_valid !== true && resultJson.refresh_token_valid !== true)) throw new CliFailure('authorization_failed')
    const corpId = id(resultJson.corp_id); const userId = id(resultJson.user_id)
    return { profileId: `${corpId}:${userId}`, userId, name: optionalText(resultJson.user_name), organization: optionalText(resultJson.corp_name) }
  } catch (error) {
    active(signal)
    if (parseError) throw parseError
    if (error instanceof CliFailure) throw error
    throw new CliFailure('authorization_failed')
  }
}

async function applications(cli: CliIo, identity: CliIdentity, signal: AbortSignal): Promise<CliApplication[]> {
  const selectedProfile = profile(identity)
  const apps = new Map<string, CliApplication>(); const cursors = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await command(cli, ['dev', 'app', 'list', '--page-size', '20', ...(cursor ? ['--cursor', cursor] : []), '--profile', selectedProfile, '--format', 'json'], signal)
    const data = envelope(result)
    if (!Array.isArray(data.items) || data.items.length > MAX_APPS) throw new CliFailure('invalid_response')
    for (const item of data.items) {
      const raw = object(item); const appId = id(raw.unifiedAppId)
      const app: CliApplication = { id: appId, name: raw.name === undefined ? appId : text(raw.name, 256), clientId: aliases(raw, ['appKey', 'clientId', 'clientID']) }
      const prior = apps.get(appId)
      if (prior && (prior.clientId !== app.clientId || prior.name !== app.name)) throw new CliFailure('invalid_response')
      apps.set(appId, app)
      if (apps.size > MAX_APPS) throw new CliFailure('invalid_response')
    }
    const pagination = object(object(result.meta).pagination)
    if (typeof pagination.endpoint_exhausted !== 'boolean') throw new CliFailure('invalid_response')
    if (pagination.endpoint_exhausted) return [...apps.values()]
    cursor = text(pagination.next_token, 4096)
    if (cursors.has(cursor)) throw new CliFailure('invalid_response')
    cursors.add(cursor)
  }
  // Never present a truncated listing as the complete selection set.
  throw new CliFailure('invalid_response')
}

/** Validate only app credentials. Acquiring a token neither sends a message nor consumes Stream callbacks. */
async function validateCredential(clientId: string, clientSecret: string, signal: AbortSignal): Promise<void> {
  active(signal)
  const requestSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)])
  try {
    const response = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ appKey: clientId, appSecret: clientSecret }), signal: requestSignal,
    })
    if (!response.ok) {
      await response.body?.cancel()
      throw new CliFailure(response.status === 429 || response.status >= 500 ? 'network_failed' : 'invalid_credentials')
    }
    if (!response.body) throw new CliFailure('invalid_response')
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let raw = ''; let bytes = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.byteLength
        if (bytes > 65536) { await reader.cancel(); throw new CliFailure('invalid_response') }
        raw += decoder.decode(part.value, { stream: true })
      }
      raw += decoder.decode()
    } finally { reader.releaseLock() }
    active(signal)
    const data = json(raw)
    if (data.code !== undefined || data.errcode !== undefined || typeof data.accessToken !== 'string' || typeof data.expireIn !== 'number'
      || !Number.isFinite(data.expireIn) || data.expireIn <= 0) throw new CliFailure('invalid_credentials')
    try { secret(data.accessToken) } catch { throw new CliFailure('invalid_credentials') }
  } catch (error) {
    active(signal)
    if (error instanceof CliFailure) throw error
    throw new CliFailure('network_failed')
  }
}

/** Explicit bot credentials can be verified without CLI Access Management or a personal OAuth identity. */
async function prepareDirect({ app, credentials, previous, signal }: CliPrepareInput): Promise<CliPrepared> {
  active(signal)
  const appId = id(app.id)
  const clientId = id(app.clientId ?? appId)
  let clientSecret: string
  if (credentials) {
    if (id(credentials.appId) !== appId || id(credentials.clientId ?? appId) !== clientId) throw new CliFailure('invalid_credentials')
    clientSecret = secret(credentials.secret)
  } else {
    if (!previous || previous.accountId !== clientId || previous.credential?.clientId !== clientId
      || (previous.credential.robotCode !== undefined && previous.credential.robotCode !== clientId)) throw new CliFailure('invalid_credentials')
    clientSecret = secret(previous.credential.clientSecret)
  }
  const name = app.name === undefined || app.name === '' ? clientId : text(app.name, 256)
  await validateCredential(clientId, clientSecret, signal)
  return {
    accountId: clientId, name, platformUrl: PLATFORM_URL,
    checks: [{ id: 'identity', state: 'passed' }, { id: 'bot', state: 'unknown' },
      { id: 'receive', state: 'unknown' }, { id: 'send', state: 'unknown' }, { id: 'published', state: 'unknown' }],
    credential: { clientId, clientSecret },
  }
}

async function prepare({ cli, identity, app, credentials, previous, signal }: CliPrepareInput): Promise<CliPrepared> {
  if (identity.profileId === undefined && (credentials || previous)) return prepareDirect({ cli, identity, app, credentials, previous, signal })
  const selectedProfile = profile(identity); const appId = id(app.id)
  const args = (path: string[]) => [...path, '--unified-app-id', appId, '--profile', selectedProfile, '--format', 'json']
  const details = envelope(await command(cli, args(['dev', 'app', 'get']), signal))
  if (id(details.unifiedAppId) !== appId) throw new CliFailure('invalid_response')
  const clientId = aliases(details, ['appKey', 'clientId', 'clientID'])
  if (!clientId) throw new CliFailure('invalid_response')
  if (app.clientId !== undefined && id(app.clientId) !== clientId) throw new CliFailure('invalid_response')
  const robot = envelope(await command(cli, args(['dev', 'app', 'robot', 'get']), signal))
  target(robot, app, clientId)
  const robotCode = robot.robotCode === undefined ? undefined : id(robot.robotCode)
  if (robotCode && robotCode !== clientId) throw new CliFailure('invalid_response')
  let clientSecret: string
  if (credentials) {
    if (credentials.appId !== appId || (credentials.clientId !== undefined && credentials.clientId !== clientId)) throw new CliFailure('invalid_credentials')
    clientSecret = secret(credentials.secret)
  } else if (previous) {
    if (previous.accountId !== clientId || previous.credential?.clientId !== clientId) throw new CliFailure('invalid_credentials')
    if (previous.credential.robotCode && previous.credential.robotCode !== (robotCode ?? clientId)) throw new CliFailure('invalid_credentials')
    clientSecret = secret(previous.credential.clientSecret)
  } else {
    const data = envelope(await command(cli, args(['dev', 'app', 'credentials', 'get']), signal))
    target(data, app, clientId)
    if (!aliases(data, ['clientId', 'appKey', 'clientID'])) throw new CliFailure('credentials_required')
    const value = aliases(data, ['clientSecret', 'appSecret'], secret)
    if (!value) throw new CliFailure('credentials_required')
    clientSecret = value
  }
  await validateCredential(clientId, clientSecret, signal)
  return {
    accountId: clientId, name: text(app.name, 256), platformUrl: PLATFORM_URL,
    checks: [
      { id: 'identity', state: 'passed' },
      { id: 'bot', state: robot.robotStatus === 'ONLINE' ? 'passed' : ['UNCONFIGURED', 'OFFLINE'].includes(String(robot.robotStatus)) ? 'action' : 'unknown' },
      { id: 'receive', state: 'unknown' }, { id: 'send', state: 'unknown' }, { id: 'published', state: 'unknown' },
    ],
    credential: { clientId, clientSecret, ...(robotCode ? { robotCode } : {}) },
  }
}

export const dingtalkDriver: CliDriver = { authorize, applications, prepare }
