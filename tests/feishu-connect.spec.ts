import { chmod, link, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { feishuDriver } from '../src/app/feishu-connect.ts'
import { CliFailure, type CliCommandOptions, type CliIo, type CliPrepareInput } from '../src/app/cli-connect-types.ts'

const roots: string[] = []
afterEach(async () => {
  vi.unstubAllGlobals(); vi.restoreAllMocks()
  const base = await realpath(tmpdir())
  for (const root of roots.splice(0)) {
    if (!root.startsWith(join(base, 'feishu-connect-test-'))) throw new Error('Unexpected cleanup path')
    await rm(root, { recursive: true, force: true })
  }
})
const app = { id: 'cli_test123', name: 'Test app' }
const secret = 'PRIVATE_APP_SECRET'
const qr = 'https://open.feishu.cn/page/cli?user_code=scan-code&lpv=1.0.99&ocv=1.0.99&from=cli'
const status = { appId: app.id, brand: 'feishu', defaultAs: 'bot', identities: { bot: { status: 'ready', available: true, verified: true } } }
const version = { status: 1, publish_time: '123', event_infos: [{ event_type: 'im.message.receive_v1' }], scopes: [
  { scope: 'im:message.p2p_msg:readonly', token_types: ['tenant'] }, { scope: 'im:message:send_as_bot', token_types: ['tenant'] },
] }
function stdout(value: unknown) { return { stdout: typeof value === 'string' ? value : JSON.stringify(value), stderr: '' } }
async function fixture() {
  const configDir = await mkdtemp(join(await realpath(tmpdir()), 'feishu-connect-test-'))
  roots.push(configDir)
  const run = vi.fn(async (args: readonly string[], _options: CliCommandOptions) => {
    if (args.join(' ') === 'config strict-mode') return stdout('strict-mode: bot (source: profile)\n')
    if (args[0] === 'config') return stdout('')
    if (args[0] === 'auth') return stdout(status)
    if (args[2] === '/open-apis/bot/v3/info') return stdout({ code: 0, bot: { open_id: 'ou_bot123', app_name: 'Assistant' } })
    return stdout({ code: 0, data: { items: [version] } })
  })
  const cli: CliIo = { executable: '/managed/lark-cli', configDir, run }
  const controller = new AbortController()
  const input: CliPrepareInput = { cli, app, identity: { app }, signal: controller.signal }
  return { cli, run, input, controller }
}
function validFetch() {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ access_token: 'PRIVATE_TENANT_TOKEN', expires_in: 7200 })))
  vi.stubGlobal('fetch', fetcher)
  return fetcher
}

it('extracts an exact official URL across stderr chunks and never exposes CLI output or credentials', async () => {
  const h = await fixture(), challenge = vi.fn()
  h.run.mockImplementationOnce(async (args, options) => {
    expect(args).toEqual(['config', 'init', '--new', '--brand', 'feishu', '--lang', 'zh_cn'])
    options.onOutput?.('stdout', `${secret}\n${qr}\n`)
    options.onOutput?.('stderr', `QR blocks\n  ${qr.slice(0, 64)}`)
    expect(challenge).not.toHaveBeenCalled()
    options.onOutput?.('stderr', `${qr.slice(64)}\n${secret}\n${qr}\n`)
    return { stdout: JSON.stringify({ appId: app.id, appSecret: '****', brand: 'feishu' }), stderr: secret }
  })
  const result = await feishuDriver.authorize(h.cli, h.input.signal, challenge)
  expect(result).toEqual({ app: { id: app.id, name: app.id } })
  expect(challenge).toHaveBeenCalledOnce()
  expect(challenge.mock.calls[0]![0]).toEqual({ url: qr, expiresAt: expect.any(String) })
  expect(JSON.stringify([result, challenge.mock.calls])).not.toContain(secret)
  expect(await feishuDriver.applications(h.cli, result, h.input.signal)).toEqual([result.app])
})

it.each([
  'https://open.feishu.cn.evil.test/page/cli?user_code=code',
  'http://open.feishu.cn/page/cli?user_code=code',
  'https://open.feishu.cn/page/cli?user_code=code#fragment',
  'https://open.feishu.cn/page/cli/../evil?user_code=code',
  'https://open.feishu.cn/page/cli?other=code',
])('does not emit a challenge for untrusted URL %s', async url => {
  const h = await fixture(), challenge = vi.fn()
  h.run.mockResolvedValueOnce({ stdout: JSON.stringify({ appId: app.id, appSecret: '****', brand: 'feishu' }), stderr: `  ${url}\n` })
  await feishuDriver.authorize(h.cli, h.input.signal, challenge)
  expect(challenge).not.toHaveBeenCalled()
})

it('handles a final URL line without a newline and keeps cancellation distinct from authorization failure', async () => {
  const h = await fixture(), challenge = vi.fn()
  h.run.mockImplementationOnce(async (_args, options) => {
    options.onOutput?.('stderr', qr)
    return { stdout: JSON.stringify({ appId: app.id, appSecret: '****', brand: 'feishu' }), stderr: qr }
  })
  await feishuDriver.authorize(h.cli, h.input.signal, challenge)
  expect(challenge).toHaveBeenCalledOnce()
  h.run.mockImplementationOnce(async () => { h.controller.abort(); throw new Error(secret) })
  await expect(feishuDriver.authorize(h.cli, h.input.signal, vi.fn())).rejects.toEqual(new CliFailure('cancelled'))
})

it('rejects invalid completion schemas and sanitizes runner failures', async () => {
  const h = await fixture()
  h.run.mockResolvedValueOnce(stdout({ appId: app.id, appSecret: secret, brand: 'feishu' }))
  await expect(feishuDriver.authorize(h.cli, h.input.signal, vi.fn())).rejects.toMatchObject({ code: 'invalid_response' })
  h.run.mockRejectedValueOnce(new Error(secret))
  await expect(feishuDriver.authorize(h.cli, h.input.signal, vi.fn())).rejects.toEqual(new CliFailure('authorization_failed'))
})

function registeredConfig(appId = app.id) {
  return { apps: [{ appId, brand: 'feishu', users: [], appSecret: { source: 'keychain', id: `appsecret:${appId}` } }] }
}
async function saveRegistered(cli: CliIo, config: unknown = registeredConfig()) {
  await writeFile(join(cli.configDir, 'config.json'), JSON.stringify(config), { flag: 'wx', mode: 0o600 })
}

it('recovers app identity from this attempt after init saves configuration but its probe exits nonzero', async () => {
  const h = await fixture()
  h.run.mockImplementationOnce(async () => { await saveRegistered(h.cli); throw new CliFailure('authorization_failed') })
  const identity = await feishuDriver.authorize(h.cli, h.input.signal, vi.fn())
  expect(identity).toEqual({ app: { id: app.id, name: app.id } })
  expect(h.run).toHaveBeenCalledOnce()
  expect(h.run.mock.calls[0]![0]).toContain('init')
  expect(identity).not.toHaveProperty('checks'); expect(identity).not.toHaveProperty('canConfirm')
  expect(JSON.stringify(identity)).not.toContain('appsecret:')
})

it('refuses registration in a preexisting configuration rather than recovering an older app as a new scan', async () => {
  const h = await fixture()
  await saveRegistered(h.cli)
  await expect(feishuDriver.authorize(h.cli, h.input.signal, vi.fn())).rejects.toEqual(new CliFailure('not_ready'))
  expect(h.run).not.toHaveBeenCalled()
})

it.each(['cancelled', 'expired'] as const)('does not recover a saved config after a %s process', async code => {
  const h = await fixture()
  h.run.mockImplementationOnce(async () => { await saveRegistered(h.cli); throw new CliFailure(code) })
  await expect(feishuDriver.authorize(h.cli, h.input.signal, vi.fn())).rejects.toEqual(new CliFailure(code))
})

it('does not recover a late config when the session signal was aborted', async () => {
  const h = await fixture()
  h.run.mockImplementationOnce(async () => {
    await saveRegistered(h.cli); h.controller.abort(); throw new CliFailure('authorization_failed')
  })
  await expect(feishuDriver.authorize(h.cli, h.input.signal, vi.fn())).rejects.toEqual(new CliFailure('cancelled'))
})

it('recovers only safe app metadata without executing the CLI, reading keychain values, or returning refs', async () => {
  const h = await fixture()
  expect(await feishuDriver.recover!(h.cli, h.input.signal)).toBeUndefined()
  await saveRegistered(h.cli)
  const identity = await feishuDriver.recover!(h.cli, h.input.signal)
  expect(identity).toEqual({ app: { id: app.id, name: app.id } })
  expect(h.run).not.toHaveBeenCalled()
  expect(JSON.stringify(identity)).not.toContain('appsecret:')
  h.controller.abort()
  await expect(feishuDriver.recover!(h.cli, h.input.signal)).rejects.toEqual(new CliFailure('cancelled'))
})

it('resumes an existing-app connection from its own private secret file without returning credential references', async () => {
  const h = await fixture()
  validFetch()
  await feishuDriver.prepare({ ...h.input, credentials: { appId: app.id, secret } })
  h.run.mockClear()
  const identity = await feishuDriver.recover!(h.cli, h.input.signal)
  expect(identity).toEqual({ app: { id: app.id, name: app.id } })
  expect(h.run).not.toHaveBeenCalled()
  expect(JSON.stringify(identity)).not.toContain(secret)
  expect(JSON.stringify(identity)).not.toContain(h.cli.configDir)
})

it.each(['missing', 'symlink', 'hardlink', 'empty', 'oversized'] as const)('refuses a %s existing-app secret file during recovery', async kind => {
  const h = await fixture(), target = join(h.cli.configDir, 'app-secret'), original = join(h.cli.configDir, 'original-secret')
  await saveRegistered(h.cli, { apps: [{ ...registeredConfig().apps[0], appSecret: { source: 'file', id: target } }] })
  if (kind === 'symlink' || kind === 'hardlink') {
    await writeFile(original, secret, { mode: 0o600 })
    if (kind === 'symlink') await symlink(original, target)
    else await link(original, target)
  } else if (kind !== 'missing') await writeFile(target, kind === 'empty' ? '' : 's'.repeat(4097), { mode: 0o600 })
  expect(await feishuDriver.recover!(h.cli, h.input.signal)).toBeUndefined()
  expect(h.run).not.toHaveBeenCalled()
})

it.skipIf(process.platform === 'win32')('refuses a group-readable existing-app secret file', async () => {
  const h = await fixture(), target = join(h.cli.configDir, 'app-secret')
  await saveRegistered(h.cli, { apps: [{ ...registeredConfig().apps[0], appSecret: { source: 'file', id: target } }] })
  await writeFile(target, secret, { mode: 0o600 }); await chmod(target, 0o644)
  expect(await feishuDriver.recover!(h.cli, h.input.signal)).toBeUndefined()
})

it.each([
  { name: 'multiple apps', config: { apps: [...registeredConfig().apps, ...registeredConfig('cli_other').apps] } },
  { name: 'mismatched keychain ref', config: { apps: [{ ...registeredConfig().apps[0], appSecret: { source: 'keychain', id: 'appsecret:cli_other' } }] } },
  { name: 'file secret ref', config: { apps: [{ ...registeredConfig().apps[0], appSecret: { source: 'file', id: '/private/someone-secret' } }] } },
  { name: 'plaintext secret', config: { apps: [{ ...registeredConfig().apps[0], appSecret: secret }] } },
  { name: 'personal OAuth users', config: { apps: [{ ...registeredConfig().apps[0], users: [{ userOpenId: 'ou_person', userName: 'Personal user' }] }] } },
])('does not recover $name from a private config file', async ({ config }) => {
  const h = await fixture()
  await saveRegistered(h.cli, config)
  expect(await feishuDriver.recover!(h.cli, h.input.signal)).toBeUndefined()
  expect(h.run).not.toHaveBeenCalled()
})

it('refuses symlink and multiply linked configuration files', async () => {
  const h = await fixture(), target = join(h.cli.configDir, 'original.json')
  await writeFile(target, JSON.stringify(registeredConfig()), { mode: 0o600 })
  await symlink(target, join(h.cli.configDir, 'config.json'))
  expect(await feishuDriver.recover!(h.cli, h.input.signal)).toBeUndefined()
  const second = await fixture()
  await link(target, join(second.cli.configDir, 'config.json'))
  expect(await feishuDriver.recover!(second.cli, second.input.signal)).toBeUndefined()
})

it.skipIf(process.platform === 'win32')('refuses group-readable config files even after init exits nonzero', async () => {
  const h = await fixture()
  h.run.mockImplementationOnce(async () => {
    await saveRegistered(h.cli); await chmod(join(h.cli.configDir, 'config.json'), 0o644)
    throw new CliFailure('authorization_failed')
  })
  await expect(feishuDriver.authorize(h.cli, h.input.signal, vi.fn())).rejects.toEqual(new CliFailure('authorization_failed'))
  expect(await feishuDriver.recover!(h.cli, h.input.signal)).toBeUndefined()
})

it('classifies bot policy error 21001 without leaking the upstream message or treating the app as ready', async () => {
  const h = await fixture(), implementation = h.run.getMockImplementation()!
  h.run.mockImplementation(async (args, options) => args[0] === 'auth' ? stdout({ ...status, identities: { bot: {
    status: 'verify_failed', available: false, verified: false,
    error: { code: 21001, type: 'policy', subtype: 'access_denied', message: `RAW_PLATFORM_POLICY ${secret}` },
  } } }) : implementation(args, options))
  await expect(feishuDriver.prepare(h.input)).rejects.toEqual(new CliFailure('platform_policy_denied'))
  expect(h.run.mock.calls.some(([args]) => args[2] === '/open-apis/bot/v3/info')).toBe(false)
})

it('sets and verifies strict bot mode, reads published grants, and never invents an owner', async () => {
  const h = await fixture()
  const result = await feishuDriver.prepare(h.input)
  expect(h.run.mock.calls.slice(0, 3).map(call => call[0])).toEqual([
    ['config', 'strict-mode', 'bot'], ['config', 'default-as', 'bot'], ['config', 'strict-mode'],
  ])
  expect(result).toEqual({ accountId: app.id, name: 'Assistant', platformUrl: `https://open.feishu.cn/app/${app.id}`, checks: [
    { id: 'identity', state: 'passed' }, { id: 'bot', state: 'passed' }, { id: 'published', state: 'passed' },
    { id: 'receive', state: 'passed' }, { id: 'send', state: 'passed' },
  ] })
  expect(h.run.mock.calls.some(call => call[0].includes('login') || call[0].includes('remove'))).toBe(false)
})

it('rejects a CLI that retains user mode or a bot not verified against the server', async () => {
  const h = await fixture()
  h.run.mockImplementationOnce(async () => stdout('')).mockImplementationOnce(async () => stdout(''))
    .mockImplementationOnce(async () => stdout('strict-mode: off'))
  await expect(feishuDriver.prepare(h.input)).rejects.toMatchObject({ code: 'permission_required' })
  const real = h.run.getMockImplementation()!
  h.run.mockImplementation(async (args, options) => args[0] === 'auth'
    ? stdout({ ...status, identities: { bot: { status: 'ready', available: true, verified: false } } }) : real(args, options))
  await expect(feishuDriver.prepare(h.input)).rejects.toMatchObject({ code: 'invalid_credentials' })
})

it('validates a submitted secret before exclusively writing private file references without CLI stdin or keychain mutation', async () => {
  const h = await fixture(), fetcher = validFetch()
  const prepared = await feishuDriver.prepare({ ...h.input, credentials: { appId: app.id, secret } })
  expect(fetcher).toHaveBeenCalledOnce()
  const [url, request] = (fetcher.mock.calls as unknown as [string, RequestInit][])[0]!
  expect(url).toBe('https://accounts.feishu.cn/oauth/v3/token')
  expect(request.redirect).toBe('error')
  expect(String(request.body)).toContain('grant_type=client_credentials')
  expect(new URLSearchParams(String(request.body)).get('client_secret')).toBe(secret)
  expect(await readFile(join(h.cli.configDir, 'app-secret'), 'utf8')).toBe(secret)
  const config = JSON.parse(await readFile(join(h.cli.configDir, 'config.json'), 'utf8'))
  expect(config.apps[0]).toMatchObject({ appId: app.id, appSecret: { source: 'file', id: join(h.cli.configDir, 'app-secret') }, strictMode: 'bot', defaultAs: 'bot', users: [] })
  for (const name of ['app-secret', 'config.json']) expect((await stat(join(h.cli.configDir, name))).mode & 0o777).toBe(0o600)
  expect(JSON.stringify([prepared, config, h.run.mock.calls])).not.toContain(secret)
  expect(JSON.stringify(prepared)).not.toContain('PRIVATE_TENANT_TOKEN')
  expect(h.run.mock.calls.some(call => call[0].includes('init'))).toBe(false)
})

it.each([400, 401, 403])('does not write files when the token endpoint rejects credentials (%s)', async code => {
  const h = await fixture()
  vi.stubGlobal('fetch', vi.fn(async () => new Response(secret, { status: code })))
  await expect(feishuDriver.prepare({ ...h.input, credentials: { appId: app.id, secret } })).rejects.toMatchObject({ code: 'invalid_credentials' })
  expect(await readdir(h.cli.configDir)).toEqual([])
  expect(h.run).not.toHaveBeenCalled()
})

it('rejects OAuth errors in HTTP 200, invalid responses and network failures without writing or exposing bodies', async () => {
  const h = await fixture(), input = { ...h.input, credentials: { appId: app.id, secret } }
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: 'invalid_client', error_description: secret })))
    .mockResolvedValueOnce(new Response('not JSON ' + secret)).mockRejectedValueOnce(new Error(secret))
  vi.stubGlobal('fetch', fetcher)
  await expect(feishuDriver.prepare(input)).rejects.toEqual(new CliFailure('invalid_credentials'))
  await expect(feishuDriver.prepare(input)).rejects.toEqual(new CliFailure('invalid_response'))
  await expect(feishuDriver.prepare(input)).rejects.toEqual(new CliFailure('network_failed'))
  expect(await readdir(h.cli.configDir)).toEqual([])
})

it('checks cancellation after validation and refuses nonempty attempt directories', async () => {
  const h = await fixture()
  vi.stubGlobal('fetch', vi.fn(async () => {
    h.controller.abort()
    return new Response(JSON.stringify({ access_token: 'token', expires_in: 7200 }))
  }))
  await expect(feishuDriver.prepare({ ...h.input, credentials: { appId: app.id, secret } })).rejects.toMatchObject({ code: 'cancelled' })
  expect(await readdir(h.cli.configDir)).toEqual([])
  const second = await fixture(), fetcher = validFetch()
  await writeFile(join(second.cli.configDir, 'config.json'), 'existing')
  await expect(feishuDriver.prepare({ ...second.input, credentials: { appId: app.id, secret } })).rejects.toMatchObject({ code: 'not_ready' })
  expect(fetcher).not.toHaveBeenCalled()
  expect(await readFile(join(second.cli.configDir, 'config.json'), 'utf8')).toBe('existing')
})

it('rechecks prepared applications without reinitializing or writing credentials', async () => {
  const h = await fixture(), fetcher = validFetch()
  const previous = await feishuDriver.prepare(h.input)
  h.run.mockClear()
  await feishuDriver.prepare({ ...h.input, previous, credentials: { appId: app.id, secret } })
  expect(fetcher).not.toHaveBeenCalled()
  expect(await readdir(h.cli.configDir)).toEqual([])
  expect(h.run.mock.calls.some(call => call[0][0] === 'config' && call[0].length > 2)).toBe(false)
})

it('uses the live version rather than drafts and excludes user-only or explicitly empty token types', async () => {
  const h = await fixture(), real = h.run.getMockImplementation()!
  h.run.mockImplementation(async (args, options) => args[2]?.endsWith('/app_versions') ? stdout({ code: 0, data: { items: [
    { ...version, status: 2 }, { ...version, scopes: [
      { scope: 'im:message.p2p_msg:readonly', token_types: ['user'] },
      { scope: 'im:message:send_as_bot', token_types: [] },
    ] },
  ] } }) : real(args, options))
  expect((await feishuDriver.prepare(h.input)).checks.slice(2)).toEqual([
    { id: 'published', state: 'passed' }, { id: 'receive', state: 'action' }, { id: 'send', state: 'action' },
  ])
})

it('accepts unclassified tenant grants but requires the published message event', async () => {
  const h = await fixture(), real = h.run.getMockImplementation()!
  h.run.mockImplementation(async (args, options) => args[2]?.endsWith('/app_versions') ? stdout({ code: 0, data: { items: [
    { ...version, event_infos: [], scopes: [{ scope: 'im:message.p2p_msg:readonly' }, { scope: 'im:message:send_as_bot', token_types: null }] },
  ] } }) : real(args, options))
  expect((await feishuDriver.prepare(h.input)).checks.slice(2)).toEqual([
    { id: 'published', state: 'passed' }, { id: 'receive', state: 'action' }, { id: 'send', state: 'passed' },
  ])
})

it('reports unpublished as action and unavailable scope metadata as unknown', async () => {
  const h = await fixture(), real = h.run.getMockImplementation()!
  h.run.mockImplementation(async (args, options) => args[2]?.endsWith('/app_versions') ? stdout({ code: 0, data: { items: [] } }) : real(args, options))
  expect((await feishuDriver.prepare(h.input)).checks.slice(2).map(check => check.state)).toEqual(['action', 'action', 'action'])
  h.run.mockImplementation(async (args, options) => {
    if (args[2]?.endsWith('/app_versions')) throw new Error(secret)
    return real(args, options)
  })
  const result = await feishuDriver.prepare(h.input)
  expect(result.checks.slice(2).map(check => check.state)).toEqual(['unknown', 'unknown', 'unknown'])
  expect(JSON.stringify(result)).not.toContain(secret)
})
