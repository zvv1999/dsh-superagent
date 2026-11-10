import { afterEach, describe, expect, it, vi } from 'vitest'
import { dingtalkDriver } from '../src/app/dingtalk-connect.ts'
import { CliFailure, type CliApplication, type CliCommandOptions, type CliIdentity, type CliIo, type CliPrepared } from '../src/app/cli-connect-types.ts'

const identity: CliIdentity = { profileId: 'corp-user:user-1', userId: 'user-1' }
const app: CliApplication = { id: 'unified-1', name: 'Task robot', clientId: 'ding-client-1' }
const signal = () => new AbortController().signal
const login = { success: true, token_valid: true, corp_id: 'corp-user', user_id: 'user-1', user_name: 'Operator', corp_name: 'Organization' }
const success = (data: unknown, meta?: unknown) => ({ ok: true, outcome: 'success', data, ...(meta ? { meta } : {}) })
const page = (items: unknown[], next?: string) => success({ items }, { pagination: { endpoint_exhausted: !next, ...(next ? { next_token: next } : {}) } })
const appItem = { unifiedAppId: app.id, name: app.name, appKey: app.clientId }
function cli(...responses: unknown[]): CliIo & { run: ReturnType<typeof vi.fn> } {
  return { executable: '/managed/dws', configDir: '/managed/auth/dingtalk', run: vi.fn(async () => ({ stdout: JSON.stringify(responses.shift()), stderr: '' })) }
}
function prepareCli(credentials: unknown = { clientId: app.clientId, clientSecret: 'fixture-private-value' }, robot: unknown = { robotStatus: 'ONLINE', robotCode: app.clientId }) {
  return cli(success(appItem), success(robot), success(credentials))
}
function tokenResponse(body: unknown = { accessToken: 'fixture-access-value', expireIn: 7200 }, status = 200) {
  return vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })))
}
const authText = (url = 'https://login.dingtalk.com/oauth2/device/verify?user_code=CODE-123') =>
  `noise not meant for the panel\n  authorization code: CODE-123\n  Authorization code will expire in 600 seconds.\n\n  Authorization link (code included):\n${url}\n\n  Link for entering the code manually:\nhttps://login.dingtalk.com/oauth2/device/verify\n`

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('dingtalk management authorization', () => {
  it('parses chunked labelled stderr and only returns the actual successful profile', async () => {
    const io = cli(); const challenge = vi.fn()
    io.run.mockImplementation(async (_args: readonly string[], options: CliCommandOptions) => {
      const output = authText()
      for (let start = 0; start < output.length; start += 7) options.onOutput?.('stderr', output.slice(start, start + 7))
      options.onOutput?.('stdout', '{"secret":"do-not-forward"}')
      return { stdout: JSON.stringify({ ...login, access_token: 'do-not-forward' }), stderr: output }
    })
    const result = await dingtalkDriver.authorize(io, signal(), challenge)
    expect(result).toEqual({ profileId: 'corp-user:user-1', userId: 'user-1', name: 'Operator', organization: 'Organization' })
    expect(challenge).toHaveBeenCalledTimes(1)
    expect(challenge.mock.calls[0]![0]).toEqual({ url: 'https://login.dingtalk.com/oauth2/device/verify?user_code=CODE-123', userCode: 'CODE-123', expiresAt: expect.any(String) })
    expect(io.run.mock.calls[0]![0]).toEqual(['auth', 'login', '--device', '--no-browser', '--format', 'json', '--yes'])
    expect(io.run.mock.calls[0]![1].timeoutMs).toBe(960000)
  })

  it('accepts final buffered stderr, ANSI code, and refresh-only success', async () => {
    const io = cli(); const challenge = vi.fn()
    io.run.mockResolvedValue({ stdout: JSON.stringify({ ...login, token_valid: undefined, refresh_token_valid: true }), stderr: authText().replace('CODE-123\n', '\x1b[33mCODE-123\x1b[0m\n') })
    await dingtalkDriver.authorize(io, signal(), challenge)
    expect(challenge).toHaveBeenCalledTimes(1)
  })

  it('replaces expired challenges when the CLI retries authorization', async () => {
    const io = cli(); const challenge = vi.fn()
    io.run.mockResolvedValue({ stdout: JSON.stringify(login), stderr: authText() + authText().replaceAll('CODE-123', 'NEXT-456') })
    await dingtalkDriver.authorize(io, signal(), challenge)
    expect(challenge.mock.calls.map(([value]) => value.userCode)).toEqual(['CODE-123', 'NEXT-456'])
  })

  it.each(['https://login.dingtalk.com.attacker.invalid/verify', 'http://login.dingtalk.com/verify', 'https://user:password@login.dingtalk.com/verify', 'https://login.dingtalk.com:444/verify'])('rejects an untrusted challenge URL %s', async url => {
    const io = cli(); const challenge = vi.fn()
    io.run.mockImplementation(async (_args: readonly string[], options: CliCommandOptions) => {
      options.onOutput?.('stderr', authText(url))
      expect(options.signal.aborted).toBe(true)
      throw new Error('raw private process error')
    })
    await expect(dingtalkDriver.authorize(io, signal(), challenge)).rejects.toMatchObject({ code: 'invalid_response', message: 'invalid_response' })
    expect(challenge).not.toHaveBeenCalled()
  })

  it('passes cancellation to the process and emits no post-cancel challenge', async () => {
    const io = cli(); const stop = new AbortController(); const challenge = vi.fn()
    io.run.mockImplementation(async (_args: readonly string[], options: CliCommandOptions) => {
      stop.abort()
      expect(options.signal.aborted).toBe(true)
      options.onOutput?.('stderr', authText())
      throw new Error('private cancellation output')
    })
    await expect(dingtalkDriver.authorize(io, stop.signal, challenge)).rejects.toMatchObject({ code: 'cancelled' })
    expect(challenge).not.toHaveBeenCalled()
  })

  it.each([{ ...login, user_id: 'user:other' }, { ...login, corp_id: 'corp,other' }, { ...login, token_valid: false }, { success: true }, { success: false }])('rejects ambiguous or incomplete identity %#', async result => {
    const io = cli(result)
    await expect(dingtalkDriver.authorize(io, signal(), vi.fn())).rejects.toBeInstanceOf(CliFailure)
  })
})

describe('dingtalk application selection', () => {
  it('pins exact profile on every page and deduplicates consistent items', async () => {
    const io = cli(page([appItem], 'next-cursor'), page([appItem, { unifiedAppId: 'unified-2', name: 'Other' }]))
    await expect(dingtalkDriver.applications(io, identity, signal())).resolves.toEqual([app, { id: 'unified-2', name: 'Other', clientId: undefined }])
    for (const [args] of io.run.mock.calls) expect(args).toEqual(expect.arrayContaining(['--profile', identity.profileId, '--format', 'json']))
    expect(io.run.mock.calls[1]![0]).toContain('--cursor')
    expect(io.run.mock.calls[1]![0]).toContain('next-cursor')
  })

  it.each([
    [page([appItem], 'loop'), page([appItem], 'loop')],
    [page([appItem, { ...appItem, appKey: 'different' }])],
    [success({ items: [appItem] })],
    [page([{ name: 'missing identifier' }])],
    [{ ok: true, outcome: 'partial', data: { items: [appItem] } }],
  ])('rejects malformed, conflicting, partial or looping listings %#', async (...responses) => {
    await expect(dingtalkDriver.applications(cli(...responses), identity, signal())).rejects.toMatchObject({ code: 'invalid_response' })
  })

  it('stops at the page limit instead of silently truncating results', async () => {
    const io = cli(...Array.from({ length: 50 }, (_, n) => page([], `cursor-${n}`)))
    await expect(dingtalkDriver.applications(io, identity, signal())).rejects.toMatchObject({ code: 'invalid_response' })
    expect(io.run).toHaveBeenCalledTimes(50)
  })

  it('rejects an absent or multi-profile selector before running commands', async () => {
    const io = cli()
    await expect(dingtalkDriver.applications(io, { profileId: 'corp:user,other:user' }, signal())).rejects.toBeInstanceOf(CliFailure)
    expect(io.run).not.toHaveBeenCalled()
  })
})

describe('dingtalk direct bot credentials without personal OAuth', () => {
  const directApp: CliApplication = { id: 'ding-direct-1', name: '' }
  const directCredentials = { appId: directApp.id, secret: 'manual-private-value' }

  it('validates explicit credentials without any CLI call or user identity grant', async () => {
    tokenResponse()
    const io = cli()
    const result = await dingtalkDriver.prepare({ cli: io, identity: {}, app: directApp, credentials: directCredentials, signal: signal() })
    expect(io.run).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledWith('https://api.dingtalk.com/v1.0/oauth2/accessToken', expect.objectContaining({ body: JSON.stringify({ appKey: directApp.id, appSecret: directCredentials.secret }) }))
    expect(result).toEqual({ accountId: directApp.id, name: directApp.id, platformUrl: 'https://open-dev.dingtalk.com/',
      checks: [{ id: 'identity', state: 'passed' }, { id: 'bot', state: 'unknown' }, { id: 'receive', state: 'unknown' }, { id: 'send', state: 'unknown' }, { id: 'published', state: 'unknown' }],
      credential: { clientId: directApp.id, clientSecret: directCredentials.secret } })
    expect(result.ownerId).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('fixture-access-value')
  })

  it('accepts an explicit matching client ID without claiming unified app verification', async () => {
    tokenResponse()
    const io = cli()
    const result = await dingtalkDriver.prepare({ cli: io, identity: {}, app, credentials: { appId: app.id, clientId: app.clientId, secret: directCredentials.secret }, signal: signal() })
    expect(io.run).not.toHaveBeenCalled()
    expect(result.accountId).toBe(app.clientId)
    expect(result.name).toBe(app.name)
    expect(result.checks.filter(check => check.state === 'passed')).toEqual([{ id: 'identity', state: 'passed' }])
  })

  it('rechecks the same direct identity with the previous private secret', async () => {
    tokenResponse()
    const io = cli()
    const previous = await dingtalkDriver.prepare({ cli: io, identity: {}, app: directApp, credentials: directCredentials, signal: signal() })
    const result = await dingtalkDriver.prepare({ cli: io, identity: {}, app: directApp, previous, signal: signal() })
    expect(result).toEqual(previous)
    expect(io.run).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it.each([
    { appId: 'different-app', secret: 'private-value' },
    { appId: directApp.id, clientId: 'different-client', secret: 'private-value' },
    { appId: '', secret: 'private-value' },
    { appId: directApp.id, clientId: '', secret: 'private-value' },
    { appId: directApp.id, clientId: 'client,other', secret: 'private-value' },
    { appId: directApp.id, secret: '[REDACTED]' },
  ])('rejects mismatched, malformed or placeholder manual input %#', async credentials => {
    tokenResponse()
    const io = cli()
    await expect(dingtalkDriver.prepare({ cli: io, identity: {}, app: directApp, credentials, signal: signal() })).rejects.toBeInstanceOf(CliFailure)
    expect(io.run).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('cannot reuse previous credentials across client IDs', async () => {
    tokenResponse()
    const io = cli()
    const previous = await dingtalkDriver.prepare({ cli: io, identity: {}, app: directApp, credentials: directCredentials, signal: signal() })
    vi.mocked(fetch).mockClear()
    await expect(dingtalkDriver.prepare({ cli: io, identity: {}, app: { ...directApp, id: 'another-client' }, previous, signal: signal() })).rejects.toMatchObject({ code: 'invalid_credentials' })
    expect(io.run).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not treat a malformed existing profile as authorization to bypass account verification', async () => {
    tokenResponse()
    const io = cli()
    await expect(dingtalkDriver.prepare({ cli: io, identity: { profileId: '' }, app: directApp, credentials: directCredentials, signal: signal() })).rejects.toMatchObject({ code: 'authorization_failed' })
    expect(io.run).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not return a prepared result for invalid bot credentials', async () => {
    tokenResponse({ code: 'invalid_secret', message: 'private-upstream-error' }, 401)
    const io = cli()
    await expect(dingtalkDriver.prepare({ cli: io, identity: {}, app: directApp, credentials: directCredentials, signal: signal() })).rejects.toMatchObject({ code: 'invalid_credentials', message: 'invalid_credentials' })
    expect(io.run).not.toHaveBeenCalled()
  })
})

describe('dingtalk selected robot preparation', () => {
  it('validates credentials privately and keeps publication and message checks unknown', async () => {
    tokenResponse()
    const io = prepareCli()
    const prepared = await dingtalkDriver.prepare({ cli: io, identity, app, signal: signal() })
    expect(prepared).toEqual({ accountId: app.clientId, name: app.name, platformUrl: 'https://open-dev.dingtalk.com/',
      checks: [{ id: 'identity', state: 'passed' }, { id: 'bot', state: 'passed' }, { id: 'receive', state: 'unknown' }, { id: 'send', state: 'unknown' }, { id: 'published', state: 'unknown' }],
      credential: { clientId: app.clientId, clientSecret: 'fixture-private-value', robotCode: app.clientId } })
    expect(prepared.ownerId).toBeUndefined()
    for (const [args] of io.run.mock.calls) {
      expect(args).toEqual(expect.arrayContaining(['--unified-app-id', app.id, '--profile', identity.profileId]))
      expect(args.join(' ')).not.toContain('fixture-private-value')
    }
    expect(fetch).toHaveBeenCalledWith('https://api.dingtalk.com/v1.0/oauth2/accessToken', expect.objectContaining({ method: 'POST', redirect: 'error', body: JSON.stringify({ appKey: app.clientId, appSecret: 'fixture-private-value' }) }))
    expect(JSON.stringify(prepared)).not.toContain('fixture-access-value')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each([{}, { clientId: app.clientId }, { clientId: app.clientId, clientSecret: '' }, { clientId: app.clientId, clientSecret: '[REDACTED]' }, { appKey: app.clientId, appSecret: '****' }, { appKey: app.clientId, appSecret: '<APP_SECRET>' }])('requires private manual entry for absent or placeholder credentials %#', async credentials => {
    tokenResponse()
    await expect(dingtalkDriver.prepare({ cli: prepareCli(credentials), identity, app, signal: signal() })).rejects.toMatchObject({ code: 'credentials_required' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    { clientId: 'wrong', clientSecret: 'fixture-private-value' },
    { clientId: app.clientId, appKey: 'wrong', clientSecret: 'fixture-private-value' },
    { clientId: app.clientId, clientSecret: 'fixture-private-value', appSecret: 'other-private-value' },
    { unifiedAppId: 'wrong', clientId: app.clientId, clientSecret: 'fixture-private-value' },
  ])('rejects credential identity and alias conflicts %#', async credentials => {
    tokenResponse()
    await expect(dingtalkDriver.prepare({ cli: prepareCli(credentials), identity, app, signal: signal() })).rejects.toMatchObject({ code: 'invalid_response' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects app selection mismatch before reading robot or secrets', async () => {
    const io = cli(success({ ...appItem, unifiedAppId: 'another-app' }))
    await expect(dingtalkDriver.prepare({ cli: io, identity, app, signal: signal() })).rejects.toMatchObject({ code: 'invalid_response' })
    expect(io.run).toHaveBeenCalledTimes(1)
  })

  it('accepts manually supplied credentials without fetching or passing secrets to dws', async () => {
    tokenResponse()
    const io = prepareCli()
    const result = await dingtalkDriver.prepare({ cli: io, identity, app, credentials: { appId: app.id, clientId: app.clientId, secret: 'manual-private-value' }, signal: signal() })
    expect(result.credential?.clientSecret).toBe('manual-private-value')
    expect(io.run).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(io.run.mock.calls)).not.toContain('manual-private-value')
  })

  it('rejects a manual client ID mismatch', async () => {
    tokenResponse()
    await expect(dingtalkDriver.prepare({ cli: prepareCli(), identity, app, credentials: { appId: app.id, clientId: 'other-client', secret: 'private-value' }, signal: signal() })).rejects.toMatchObject({ code: 'invalid_credentials' })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('reuses previous private credentials during recheck instead of retrieving a once-only secret again', async () => {
    tokenResponse()
    const previous: CliPrepared = { accountId: app.clientId!, name: app.name, checks: [], platformUrl: '', credential: { clientId: app.clientId!, clientSecret: 'previous-private-value' } }
    const io = prepareCli(undefined, { robotStatus: 'OFFLINE' })
    const result = await dingtalkDriver.prepare({ cli: io, identity, app, previous, signal: signal() })
    expect(io.run).toHaveBeenCalledTimes(2)
    expect(result.credential?.clientSecret).toBe('previous-private-value')
    expect(result.checks.find(check => check.id === 'bot')?.state).toBe('action')
  })

  it.each([{ accessToken: '***', expireIn: 7200 }, { accessToken: 'fixture-value', expireIn: 0 }, { accessToken: 'fixture-value' }, { code: 'invalid', message: 'private server message' }])('rejects invalid access-token responses without exposing them %#', async body => {
    tokenResponse(body)
    await expect(dingtalkDriver.prepare({ cli: prepareCli(), identity, app, signal: signal() })).rejects.toMatchObject({ code: 'invalid_credentials', message: 'invalid_credentials' })
  })

  it('normalizes raw network errors without disclosing request secrets', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fixture-private-value: untrusted upstream error') }))
    await expect(dingtalkDriver.prepare({ cli: prepareCli(), identity, app, signal: signal() })).rejects.toMatchObject({ message: 'network_failed' })
  })

  it('aborts token validation with the caller and reports cancelled', async () => {
    const stop = new AbortController()
    vi.stubGlobal('fetch', vi.fn(async (_url, options: RequestInit) => {
      stop.abort()
      expect(options.signal?.aborted).toBe(true)
      throw new Error('aborted with private response')
    }))
    await expect(dingtalkDriver.prepare({ cli: prepareCli(), identity, app, signal: stop.signal })).rejects.toMatchObject({ code: 'cancelled' })
  })
})
