import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { CliConnect } from '../src/app/cli-connect.ts'
import { CliFailure, type CliDriver, type CliIdentity, type CliIo, type CliPlatform, type CliPrepareInput, type CliPrepared } from '../src/app/cli-connect-types.ts'
import type { CliConnectRequest } from '../src/app/api.ts'
import { ManagedCli } from '../src/app/managed-cli.ts'
import { Settings, SettingsConflict, type SettingsHost } from '../src/app/settings.ts'
import { Store } from '../src/app/store.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { ImSource } from '../src/sources/im.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import type { Trigger } from '../src/core/index.ts'

const cleanup: (() => Promise<void>)[] = []
const pending: (() => void)[] = []
afterEach(async () => {
  for (const resolve of pending.splice(0)) resolve()
  for (const close of cleanup.splice(0).reverse()) await close()
  vi.restoreAllMocks(); vi.useRealTimers()
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  pending.push(() => resolve(undefined as T))
  return { promise, resolve }
}
const apps = [{ id: 'app-one', name: 'One' }, { id: 'app-two', name: 'Two' }]
const secret = 'HOST_ONLY_APP_SECRET'
const token = 'HOST_ONLY_AUTH_TOKEN'
const appFeishu = { id: 'cli_new', name: 'Feishu bot' }
const allChecks: CliPrepared['checks'] = ['identity', 'bot', 'receive', 'send', 'published'].map(id => ({ id: id as CliPrepared['checks'][number]['id'], state: 'passed' }))
function driver(platform: CliPlatform) {
  return {
    recover: vi.fn<NonNullable<CliDriver['recover']>>().mockResolvedValue(undefined),
    authorize: vi.fn<CliDriver['authorize']>().mockResolvedValue(platform === 'feishu' ? { app: appFeishu } : { name: 'Operator', profileId: token }),
    applications: vi.fn<CliDriver['applications']>().mockResolvedValue(platform === 'feishu' ? [appFeishu] : apps),
    prepare: vi.fn<CliDriver['prepare']>().mockImplementation(async input => ({ accountId: input.app.id, name: input.app.name,
      checks: allChecks, platformUrl: platform === 'feishu' ? `https://open.feishu.cn/app/${input.app.id}` : 'https://open-dev.dingtalk.com/',
      ...(platform === 'dingtalk' ? { credential: { clientId: input.app.id, clientSecret: input.credentials?.secret ?? secret } } : {}),
    })),
  }
}
async function fixture(platform: CliPlatform = 'dingtalk', configured = false) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'cli-connect-test-')), directory = join(root, 'state')
  await mkdir(directory, { mode: 0o700 })
  const store = new Store(join(root, 'test.sqlite'))
  store.saveSettings({ sources: {
    feishu: { enabled: configured && platform === 'feishu', config: configured && platform === 'feishu' ? { cli: '/fake/old-bot' } : {} },
    dingtalk: { enabled: configured && platform === 'dingtalk', config: configured && platform === 'dingtalk' ? { accountId: 'old-account', credentialsFile: '/private/old.json' } : {} },
    wechat: { enabled: true, config: { accountId: 'other-account', credentialsFile: '/private/other.json', directMessages: true } },
  }, policy: { sources: { wechat: { allowed: [{ id: 'other-user' }], admission: {} }, [platform]: { allowed: configured ? [{ id: platform === 'feishu' ? 'ou_old' : 'old-user' }] : [], admission: {} } } } })
  const sources = new SourceRegistry(() => store.settings())
  sources.register(feishuKind)
  sources.register(new ImSource('dingtalk', { connect: vi.fn() }).kind)
  sources.register(new ImSource('wechat', { connect: vi.fn() }).kind)
  const lifetime = new AbortController(), notify = vi.fn(), changed = vi.fn(), requestPass = vi.fn()
  const setup = { configured: () => true, checkAccounts: vi.fn(async () => {}), restart: vi.fn(), blockCommands: vi.fn() }
  const host = { store, sources, lifetime: lifetime.signal, sessions: { notify, delivery: vi.fn() }, engine: { policyChanged: changed },
    requestPass, context: {}, sourceHost: {}, setup, health: {} } as unknown as SettingsHost
  const settings = new Settings(host)
  const directories: string[] = []
  const managed = {
    installed: vi.fn(async () => true), ensure: vi.fn(async () => '/mock/native'),
    configurations: vi.fn(async (_platform: CliPlatform): Promise<string[]> => []),
    connectionDirectory: vi.fn(async () => { const dir = await mkdtemp(join(directory, 'attempt-')); directories.push(dir); return dir }),
    io: vi.fn((_platform: CliPlatform, executable: string | undefined, configDir: string): CliIo => ({ executable: executable ?? '/mock/native', configDir, run: vi.fn(async () => ({ stdout: '', stderr: '' })) })),
    compactFeishu: vi.fn(async (cli: CliIo, _appId: string, _signal: AbortSignal) => cli),
    wrapper: vi.fn(async (cli: CliIo) => { const file = join(cli.configDir, 'lark-bot'); await writeFile(file, '#!/bin/sh\n', { flag: 'wx', mode: 0o700 }); return file }),
  }
  let feishuAccount = configured && platform === 'feishu' ? 'cli_old' : ''
  const account = (which: CliPlatform) => which === 'feishu' ? feishuAccount : String(sources.instance('dingtalk')?.config.accountId ?? '')
  const drivers = { feishu: driver('feishu'), dingtalk: driver('dingtalk') }
  const connect = new CliConnect({ stateDir: directory, store, sources, settings, lifetime: lifetime.signal, account }, managed as unknown as ManagedCli, drivers)
  cleanup.push(async () => {
    lifetime.abort(); await connect.dispose(); store.close()
    if (!root.startsWith(join(await realpath(tmpdir()), 'cli-connect-test-'))) throw new Error('Unexpected cleanup path')
    await rm(root, { recursive: true, force: true })
  })
  const revisions = () => ({ sourceRevision: store.blockRevision(`source:${platform}`), policyRevision: store.blockRevision('policy') })
  const request = (extra: Partial<CliConnectRequest> = {}): CliConnectRequest => ({ mode: 'quick', enable: true, ...revisions(), ...extra })
  return { root, directory, store, sources, settings, lifetime, setup, notify, changed, requestPass, managed, drivers, driver: drivers[platform],
    connect, platform, directories, revisions, request, account, setFeishuAccount: (value: string) => { feishuAccount = value } }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
async function state(h: Fixture, status: string) { await vi.waitFor(async () => expect((await h.connect.current(h.platform)).status).toBe(status)) }
async function ready(h: Fixture, replace = false) {
  const started = await h.connect.begin(h.platform, h.request({ replace }))
  if (h.platform === 'dingtalk') { await state(h, 'select_app'); await h.connect.select(h.platform, started.id!, apps[1]!.id) }
  await state(h, 'review')
  return started.id!
}

it.each(['receive', 'send', 'published'] as const)('blocks saving when %s is known to need platform configuration, then allows a successful recheck', async id => {
  const h = await fixture('feishu')
  h.driver.prepare.mockResolvedValueOnce({ accountId: appFeishu.id, name: appFeishu.name,
    checks: allChecks.map(check => check.id === id ? { ...check, state: 'action' } : check), platformUrl: 'https://open.feishu.cn/app' })
  const session = await ready(h)
  expect(await h.connect.current(h.platform)).toMatchObject({ status: 'review', canConfirm: false })
  await expect(h.connect.confirm(h.platform, session, { enable: true, ...h.revisions() })).rejects.toMatchObject({ code: 'not_ready' })
  expect(h.store.settings().sources.feishu!.config.cli).toBeUndefined()
  await h.connect.check(h.platform, session); await state(h, 'review')
  expect(await h.connect.current(h.platform)).toMatchObject({ canConfirm: true, checks: allChecks })
})
function revision(h: Fixture, block: 'policy' | `source:${string}`) {
  h.store.saveSettings(h.store.settings(), { source: 'panel', block, policyVersion: '', policyChanged: false, notified: [] })
}
function trigger(h: Fixture, text: string, extra: Partial<Trigger> = {}): Trigger {
  return { id: 'pair-message', source: h.platform, threads: [{ source: h.platform, id: 'dm' }],
    actor: { source: h.platform, id: h.platform === 'feishu' ? 'ou_person' : 'person' }, human: true, addressed: 'direct',
    channel: { source: h.platform, thread: 'dm', address: {} }, at: new Date().toISOString(), text,
    meta: { direct: true, accountId: h.account(h.platform) }, ...extra }
}

async function resumable(h: Fixture) {
  const first = await mkdtemp(join(h.directory, 'saved-first-'))
  const second = await mkdtemp(join(h.directory, 'saved-second-'))
  const candidates = [{ id: 'cli_saved1', name: 'Saved one' }, { id: 'cli_saved2', name: 'Saved two' }]
  h.managed.configurations.mockResolvedValue([first, second])
  h.driver.recover.mockImplementation(async cli => ({ app: cli.configDir === first ? candidates[0] : candidates[1] }))
  return { first, second, candidates }
}

it('resumes saved apps only after explicit selection and binds the selected original directory without authorizing again', async () => {
  const h = await fixture('feishu'), saved = await resumable(h), before = h.store.settings()
  expect((await h.connect.current(h.platform)).canResume).toBe(true)
  expect(h.managed.ensure).not.toHaveBeenCalled(); expect(h.managed.connectionDirectory).not.toHaveBeenCalled()
  const started = await h.connect.begin(h.platform, h.request({ mode: 'resume' }))
  await state(h, 'select_app')
  expect(h.managed.ensure).toHaveBeenCalledOnce()
  const view = await h.connect.current(h.platform)
  expect(view.mode).toBe('resume'); expect(view.apps).toEqual(saved.candidates)
  expect(view.selectedApp).toBeUndefined(); expect(view.canConfirm).toBe(false)
  expect(h.driver.authorize).not.toHaveBeenCalled(); expect(h.driver.prepare).not.toHaveBeenCalled()
  expect(h.managed.connectionDirectory).not.toHaveBeenCalled()
  expect(h.store.settings()).toEqual(before)
  await expect(h.connect.confirm(h.platform, started.id!, { enable: true, ...h.revisions() })).rejects.toEqual(new CliFailure('not_ready'))
  await expect(h.connect.select(h.platform, started.id!, 'cli_unknown')).rejects.toEqual(new CliFailure('invalid_response'))
  await h.connect.select(h.platform, started.id!, saved.candidates[1]!.id)
  await state(h, 'review')
  expect(h.driver.prepare).toHaveBeenCalledOnce()
  expect(h.driver.prepare.mock.calls[0]![0]).toMatchObject({ app: saved.candidates[1], identity: { app: saved.candidates[1] }, cli: { configDir: saved.second } })
  await h.connect.confirm(h.platform, started.id!, { enable: true, ...h.revisions() })
  await state(h, 'connected')
  expect(h.managed.wrapper.mock.calls[0]![0].configDir).toBe(saved.second)
  expect(h.store.settings().sources.feishu?.config.cli).toBe(join(saved.second, 'lark-bot'))
  expect(h.driver.authorize).not.toHaveBeenCalled(); expect(h.managed.connectionDirectory).not.toHaveBeenCalled()
  expect(h.store.settings().policy.sources.feishu?.allowed).toEqual([])
})

it('binds the compacted Feishu wrapper after verification and before saving the connection', async () => {
  const h = await fixture('feishu'), id = await ready(h)
  const compacted = h.managed.io('feishu', '/mock/native', await mkdtemp(join(h.directory, 'compacted-')))
  h.managed.compactFeishu.mockResolvedValueOnce(compacted)
  await h.connect.confirm(h.platform, id, { enable: true, ...h.revisions() }); await state(h, 'connected')
  expect(h.managed.compactFeishu).toHaveBeenCalledWith(expect.any(Object), appFeishu.id, expect.any(AbortSignal))
  expect(h.managed.wrapper).toHaveBeenCalledWith(compacted)
  expect(h.store.settings().sources.feishu!.config.cli).toBe(join(compacted.configDir, 'lark-bot'))
})

it('keeps settings unchanged when the Feishu socket path cannot be made safe', async () => {
  const h = await fixture('feishu'), id = await ready(h), before = h.store.settings()
  h.managed.compactFeishu.mockRejectedValueOnce(new CliFailure('config_path_too_long'))
  await h.connect.confirm(h.platform, id, { enable: true, ...h.revisions() }); await state(h, 'error')
  expect(await h.connect.current(h.platform)).toMatchObject({ error: 'config_path_too_long' })
  expect(h.store.settings()).toEqual(before)
  expect(h.managed.wrapper).not.toHaveBeenCalled()
})

it('requires explicit selection even when only one saved app is recoverable', async () => {
  const h = await fixture('feishu'), saved = await resumable(h)
  h.managed.configurations.mockResolvedValue([saved.first])
  await h.connect.begin(h.platform, h.request({ mode: 'resume' }))
  await state(h, 'select_app')
  const view = await h.connect.current(h.platform)
  expect(view.apps).toEqual([saved.candidates[0]])
  expect(view.selectedApp).toBeUndefined(); expect(view.canConfirm).toBe(false)
  expect(h.driver.authorize).not.toHaveBeenCalled(); expect(h.driver.prepare).not.toHaveBeenCalled()
  expect(h.managed.connectionDirectory).not.toHaveBeenCalled()
})

it.each(['no directories', 'no recoverable app'])('does not resume or create an app when there are %s', async reason => {
  const h = await fixture('feishu'), before = h.store.settings()
  if (reason === 'no recoverable app') {
    await resumable(h)
    h.driver.recover.mockResolvedValue(undefined)
  }
  const started = await h.connect.begin(h.platform, h.request({ mode: 'resume' }))
  await state(h, 'error')
  expect(await h.connect.current(h.platform)).toMatchObject({ error: 'not_ready', canConfirm: false, canResume: false })
  await expect(h.connect.confirm(h.platform, started.id!, { enable: true, ...h.revisions() })).rejects.toEqual(new CliFailure('not_ready'))
  expect(h.driver.authorize).not.toHaveBeenCalled(); expect(h.driver.prepare).not.toHaveBeenCalled()
  expect(h.managed.connectionDirectory).not.toHaveBeenCalled()
  expect(h.store.settings()).toEqual(before)
})

it.each(['quick', 'resume'] as const)('keeps %s platform-policy refusal in review, blocks confirmation, and permits independent rechecking', async mode => {
  const h = await fixture('feishu'), before = h.store.settings()
  const saved = mode === 'resume' ? await resumable(h) : undefined
  h.driver.prepare.mockRejectedValueOnce(new CliFailure('platform_policy_denied'))
  const started = await h.connect.begin(h.platform, h.request({ mode }))
  if (saved) {
    await state(h, 'select_app')
    await h.connect.select(h.platform, started.id!, saved.candidates[0]!.id)
  }
  await state(h, 'review')
  const view = await h.connect.current(h.platform)
  expect(view).toMatchObject({ error: 'platform_policy_denied', canConfirm: false })
  expect(view.selectedApp?.id).toBe(saved?.candidates[0]!.id ?? appFeishu.id)
  await expect(h.connect.confirm(h.platform, started.id!, { enable: true, ...h.revisions() })).rejects.toEqual(new CliFailure('not_ready'))
  expect(h.store.settings()).toEqual(before); expect(h.managed.wrapper).not.toHaveBeenCalled()
  await h.connect.check(h.platform, started.id!)
  await state(h, 'review')
  expect(await h.connect.current(h.platform)).toMatchObject({ canConfirm: true })
  expect((await h.connect.current(h.platform)).error).toBeUndefined()
  expect(h.driver.prepare).toHaveBeenCalledTimes(2)
  if (saved) {
    expect(h.driver.authorize).not.toHaveBeenCalled()
    expect(h.driver.prepare.mock.calls.every(([input]) => input.cli.configDir === saved.first && !input.credentials)).toBe(true)
  }
})

it('keeps authorization in memory and waits for explicit app selection without leaking host identity tokens', async () => {
  const h = await fixture(), before = h.store.settings(), history = h.store.settingsHistory()
  const started = await h.connect.begin(h.platform, h.request())
  await state(h, 'select_app')
  const view = await h.connect.current(h.platform)
  expect(view.apps).toEqual(apps); expect(view.selectedApp).toBeUndefined()
  expect(h.driver.prepare).not.toHaveBeenCalled()
  expect(h.store.settings()).toEqual(before); expect(h.store.settingsHistory()).toEqual(history)
  expect(JSON.stringify(view)).not.toContain(token)
  await expect(h.connect.select(h.platform, started.id!, 'not-listed')).rejects.toEqual(new CliFailure('invalid_response'))
  await h.connect.select(h.platform, started.id!, apps[1]!.id)
  await state(h, 'review')
  expect(h.driver.prepare.mock.calls[0]![0].app.id).toBe(apps[1]!.id)
})

it('coalesces simultaneous begin calls into one authorization attempt', async () => {
  const h = await fixture(), gate = deferred<CliIdentity>()
  h.driver.authorize.mockReturnValue(gate.promise)
  const views = await Promise.all([h.connect.begin(h.platform, h.request()), h.connect.begin(h.platform, h.request())])
  expect(views[0]!.id).toBe(views[1]!.id)
  await state(h, 'authorizing')
  expect(h.managed.ensure).toHaveBeenCalledOnce(); expect(h.driver.authorize).toHaveBeenCalledOnce()
  await expect(h.connect.begin(h.platform, h.request({ mode: 'manual' }))).rejects.toEqual(new CliFailure('not_ready'))
  gate.resolve({})
})

it('ignores late authorization and prepare completions after cancellation', async () => {
  const h = await fixture(), auth = deferred<CliIdentity>(), before = h.store.settings()
  h.driver.authorize.mockImplementationOnce(async (_cli, _signal, challenge) => {
    challenge({ url: 'https://official.example/authorize', expiresAt: new Date(Date.now() + 60_000).toISOString() })
    return auth.promise
  })
  const started = await h.connect.begin(h.platform, h.request())
  await state(h, 'waiting'); await h.connect.cancel(h.platform, started.id!)
  auth.resolve({ name: 'Late', profileId: token })
  await Promise.resolve(); await Promise.resolve()
  expect((await h.connect.current(h.platform))).toMatchObject({ status: 'cancelled' })
  expect((await h.connect.current(h.platform)).challenge).toBeUndefined()
  expect(h.driver.applications).not.toHaveBeenCalled(); expect(h.store.settings()).toEqual(before)
  const prepare = deferred<CliPrepared>()
  h.driver.prepare.mockReturnValueOnce(prepare.promise)
  const next = await h.connect.begin(h.platform, h.request())
  await state(h, 'select_app'); await h.connect.select(h.platform, next.id!, apps[0]!.id)
  await state(h, 'checking'); await h.connect.cancel(h.platform, next.id!)
  prepare.resolve({ accountId: apps[0]!.id, name: 'Late', checks: allChecks, platformUrl: '' })
  await Promise.resolve(); await Promise.resolve()
  expect((await h.connect.current(h.platform)).status).toBe('cancelled')
  expect(h.store.settings()).toEqual(before)
})

it('keeps manual credentials and prepared secrets out of every panel view until explicit confirmation', async () => {
  const h = await fixture(), before = h.store.settings()
  const started = await h.connect.begin(h.platform, h.request({ mode: 'manual' }))
  await state(h, 'credentials')
  await h.connect.credentials(h.platform, started.id!, { appId: apps[0]!.id, secret })
  await state(h, 'review')
  expect(h.driver.authorize).not.toHaveBeenCalled()
  expect(h.driver.prepare.mock.calls[0]![0].credentials?.secret).toBe(secret)
  expect(JSON.stringify(await h.connect.current(h.platform))).not.toContain(secret)
  expect(h.store.settings()).toEqual(before)
  expect(await readdir(h.directories[0]!)).toEqual([])
})

it('requests credentials for the explicitly selected application and rejects credentials for a different app', async () => {
  const h = await fixture()
  h.driver.prepare.mockRejectedValueOnce(new CliFailure('credentials_required'))
  const started = await h.connect.begin(h.platform, h.request())
  await state(h, 'select_app'); await h.connect.select(h.platform, started.id!, apps[1]!.id)
  await state(h, 'credentials')
  await expect(h.connect.credentials(h.platform, started.id!, { appId: apps[0]!.id, secret })).rejects.toEqual(new CliFailure('invalid_credentials'))
  await h.connect.credentials(h.platform, started.id!, { appId: apps[1]!.id, secret })
  await state(h, 'review')
  expect(h.driver.prepare.mock.calls.at(-1)![0].app.id).toBe(apps[1]!.id)
  expect(JSON.stringify(await h.connect.current(h.platform))).not.toContain(secret)
  expect(h.store.settings().sources.dingtalk?.config).toEqual({})
})

it('recovers manual credential failures in the same session with corrected app ID and a fresh private directory', async () => {
  const h = await fixture('feishu'), before = h.store.settings(), rejectedSecret = 'REJECTED_PRIVATE_SECRET', correctedSecret = 'CORRECTED_PRIVATE_SECRET'
  h.driver.prepare.mockImplementationOnce(async input => {
    await writeFile(join(input.cli.configDir, 'partial-secret'), input.credentials!.secret, { flag: 'wx', mode: 0o600 })
    throw new CliFailure('invalid_credentials')
  })
  const started = await h.connect.begin(h.platform, h.request({ mode: 'manual' }))
  await state(h, 'credentials')
  await h.connect.credentials(h.platform, started.id!, { appId: 'cli_wrong', secret: rejectedSecret })
  await state(h, 'credentials')
  expect(await h.connect.current(h.platform)).toMatchObject({ id: started.id, status: 'credentials', error: 'invalid_credentials', canConfirm: false })
  const failed = h.driver.prepare.mock.calls[0]![0]
  expect(failed.signal.aborted).toBe(false)
  await expect(h.connect.confirm(h.platform, started.id!, { enable: true, ...h.revisions() })).rejects.toEqual(new CliFailure('not_ready'))
  await h.connect.credentials(h.platform, started.id!, { appId: 'cli_corrected', secret: correctedSecret })
  await state(h, 'review')
  const successful = h.driver.prepare.mock.calls[1]![0], view = await h.connect.current(h.platform)
  expect(view).toMatchObject({ id: started.id, mode: 'manual', canConfirm: true, selectedApp: { id: 'cli_corrected' } })
  expect(view.error).toBeUndefined()
  expect(successful.cli.configDir).not.toBe(failed.cli.configDir)
  expect(successful.previous).toBeUndefined()
  expect(successful.credentials).toEqual({ appId: 'cli_corrected', secret: correctedSecret })
  expect(await readdir(successful.cli.configDir)).toEqual([])
  expect(await readFile(join(failed.cli.configDir, 'partial-secret'), 'utf8')).toBe(rejectedSecret)
  expect(h.driver.authorize).not.toHaveBeenCalled(); expect(h.driver.applications).not.toHaveBeenCalled()
  expect(h.store.settings()).toEqual(before)
  expect(JSON.stringify(view)).not.toContain(rejectedSecret); expect(JSON.stringify(view)).not.toContain(correctedSecret)
  await h.connect.confirm(h.platform, started.id!, { enable: true, ...h.revisions() }); await state(h, 'connected')
  expect(h.store.settings().sources.feishu?.config.cli).toBe(join(successful.cli.configDir, 'lark-bot'))
})

it('keeps a quick Feishu bot session retryable but unconfirmable until permission and identity checks recover', async () => {
  const h = await fixture('feishu'), before = h.store.settings()
  h.driver.prepare.mockRejectedValueOnce(new CliFailure('permission_required')).mockRejectedValueOnce(new CliFailure('invalid_credentials'))
  const started = await h.connect.begin(h.platform, h.request())
  await state(h, 'review')
  expect(await h.connect.current(h.platform)).toMatchObject({ id: started.id, error: 'permission_required', canConfirm: false })
  expect(h.driver.prepare.mock.calls[0]![0].signal.aborted).toBe(false)
  await expect(h.connect.confirm(h.platform, started.id!, { enable: true, ...h.revisions() })).rejects.toEqual(new CliFailure('not_ready'))
  await h.connect.check(h.platform, started.id!); await state(h, 'review')
  expect(await h.connect.current(h.platform)).toMatchObject({ id: started.id, error: 'invalid_credentials', canConfirm: false })
  await expect(h.connect.confirm(h.platform, started.id!, { enable: true, ...h.revisions() })).rejects.toEqual(new CliFailure('not_ready'))
  expect(h.managed.wrapper).not.toHaveBeenCalled(); expect(h.store.settings()).toEqual(before)
  await h.connect.check(h.platform, started.id!); await state(h, 'review')
  const recovered = await h.connect.current(h.platform)
  expect(recovered).toMatchObject({ id: started.id, canConfirm: true, selectedApp: appFeishu, checks: allChecks })
  expect(recovered.error).toBeUndefined()
  expect(h.driver.authorize).toHaveBeenCalledOnce(); expect(h.driver.applications).toHaveBeenCalledOnce()
  expect(new Set(h.driver.prepare.mock.calls.map(([input]) => input.cli.configDir)).size).toBe(1)
  await h.connect.confirm(h.platform, started.id!, { enable: true, ...h.revisions() }); await state(h, 'connected')
})

it('confirms source and policy atomically, preserves other sources, and writes private credentials only on confirmation', async () => {
  const h = await fixture(), other = h.store.settings().sources.wechat, otherPolicy = h.store.settings().policy.sources.wechat
  const id = await ready(h)
  await h.connect.confirm(h.platform, id, { enable: true, ...h.revisions() })
  await state(h, 'connected')
  const saved = h.store.settings(), file = String(saved.sources.dingtalk!.config.credentialsFile)
  expect(saved.sources.dingtalk).toMatchObject({ enabled: true, config: { accountId: apps[1]!.id, directMessages: true, chats: [] } })
  expect(saved.policy.sources.dingtalk?.allowed).toEqual([])
  expect(saved.sources.wechat).toEqual(other); expect(saved.policy.sources.wechat).toEqual(otherPolicy)
  expect(h.store.blockRevision('source:dingtalk')).toBe(1); expect(h.store.blockRevision('policy')).toBe(1)
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ clientId: apps[1]!.id, clientSecret: secret })
  if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
  expect(JSON.stringify([await h.connect.current(h.platform), h.store.settingsHistory(), h.notify.mock.calls])).not.toContain(secret)
  const versions = h.store.settingsHistory().slice(0, 2)
  expect(versions).toHaveLength(2)
  expect(versions.every(version => version.settings.sources.dingtalk?.config.accountId === apps[1]!.id)).toBe(true)
})

it('supports saving without enabling and requires explicit replacement of an existing account', async () => {
  const h = await fixture(), id = await ready(h)
  await h.connect.confirm(h.platform, id, { enable: false, ...h.revisions() }); await state(h, 'connected')
  expect(h.store.settings().sources.dingtalk?.enabled).toBe(false)
  await expect(h.connect.begin(h.platform, h.request())).rejects.toEqual(new CliFailure('settings_conflict'))
  await expect(h.connect.pair(h.platform, h.revisions())).rejects.toEqual(new CliFailure('not_ready'))
})

it('rolls back credential files and both revisions when the settings transaction fails', async () => {
  const h = await fixture(), id = await ready(h), before = h.store.settings(), history = h.store.settingsHistory()
  const original = h.store.saveSettings.bind(h.store)
  vi.spyOn(h.store, 'saveSettings').mockImplementation((value, record) => {
    if (record?.block === 'policy') throw new Error('PRIVATE_FAILURE')
    return original(value, record)
  })
  await h.connect.confirm(h.platform, id, { enable: true, ...h.revisions() }); await state(h, 'error')
  expect(h.store.settings()).toEqual(before); expect(h.store.settingsHistory()).toEqual(history)
  expect(h.revisions()).toEqual({ sourceRevision: 0, policyRevision: 0 })
  expect(await readdir(h.directories[0]!)).toEqual([])
  expect((await h.connect.current(h.platform)).error).toBe('save_failed')
  expect(h.requestPass).not.toHaveBeenCalled()
})

it('rejects stale source or policy revisions before confirmation and before committing an async account check', async () => {
  const h = await fixture('feishu'), id = await ready(h), before = h.store.settings()
  const old = h.revisions(); revision(h, 'policy')
  await expect(h.connect.confirm(h.platform, id, { enable: true, ...old })).rejects.toEqual(new CliFailure('settings_conflict'))
  expect(h.store.settings()).toEqual(before)
  const second = await fixture('feishu'), next = await ready(second), gate = deferred<void>()
  second.setup.checkAccounts.mockReturnValueOnce(gate.promise)
  await second.connect.confirm(second.platform, next, { enable: true, ...second.revisions() })
  await state(second, 'saving'); revision(second, 'source:feishu'); gate.resolve()
  await state(second, 'error')
  expect(second.store.settings().sources.feishu?.config.cli).toBeUndefined()
  expect((await second.connect.current(second.platform)).error).toBe('settings_conflict')
})

it('never binds after cancellation while account verification is pending', async () => {
  const h = await fixture('feishu'), id = await ready(h), gate = deferred<void>(), before = h.store.settings()
  h.setup.checkAccounts.mockReturnValueOnce(gate.promise)
  await h.connect.confirm(h.platform, id, { enable: true, ...h.revisions() }); await state(h, 'saving')
  await h.connect.cancel(h.platform, id); gate.resolve()
  await Promise.resolve(); await Promise.resolve()
  expect(h.store.settings()).toEqual(before)
  expect((await h.connect.current(h.platform)).status).toBe('cancelled')
})

it('rechecks using previous host-only preparation and does not retain a failed preparation as confirmable', async () => {
  const h = await fixture(), id = await ready(h)
  await h.connect.check(h.platform, id); await state(h, 'review')
  expect(h.driver.prepare.mock.calls.at(-1)![0].previous?.credential?.clientSecret).toBe(secret)
  h.driver.prepare.mockRejectedValueOnce(new CliFailure('permission_required'))
  await h.connect.check(h.platform, id); await state(h, 'review')
  expect(await h.connect.current(h.platform)).toMatchObject({ id, error: 'permission_required', canConfirm: false })
  await expect(h.connect.confirm(h.platform, id, { enable: true, ...h.revisions() })).rejects.toEqual(new CliFailure('not_ready'))
  expect(await readdir(h.directories[0]!)).toEqual([])
})

it('expires pending authorization and disposal aborts and drains every background task', async () => {
  const h = await fixture(), gate = deferred<CliIdentity>()
  h.driver.authorize.mockReturnValue(gate.promise)
  const id = (await h.connect.begin(h.platform, h.request())).id!
  await state(h, 'authorizing')
  vi.useFakeTimers()
  // Session timers were created before switching clocks; a separate session proves the timer behavior.
  await h.connect.cancel(h.platform, id); gate.resolve({})
  const next = await fixture(), released = vi.fn()
  next.driver.authorize.mockImplementation(async (_cli, signal) => new Promise(resolve => signal.addEventListener('abort', () => { released(); resolve({}) }, { once: true })))
  await next.connect.begin(next.platform, next.request()); await state(next, 'authorizing')
  await vi.advanceTimersByTimeAsync(20 * 60_000)
  expect((await next.connect.current(next.platform)).status).toBe('expired'); expect(released).toHaveBeenCalledOnce()
  const third = await fixture(), stopped = vi.fn()
  third.driver.authorize.mockImplementation(async (_cli, signal) => new Promise(resolve => signal.addEventListener('abort', () => { stopped(); resolve({}) }, { once: true })))
  await third.connect.begin(third.platform, third.request()); await state(third, 'authorizing')
  third.lifetime.abort(); await third.connect.dispose()
  expect(stopped).toHaveBeenCalledOnce(); expect((await third.connect.current(third.platform)).status).toBe('cancelled')
})

it('aborts pending authorization at the QR deadline and ignores a late identity instead of selecting applications', async () => {
  vi.useFakeTimers()
  const h = await fixture(), gate = deferred<CliIdentity>()
  let authorizingSignal: AbortSignal | undefined
  h.driver.authorize.mockImplementationOnce(async (_cli, signal, challenge) => {
    authorizingSignal = signal
    challenge({ url: 'https://official.example/qr', expiresAt: new Date(Date.now() + 30_000).toISOString() })
    return gate.promise
  })
  await h.connect.begin(h.platform, h.request()); await state(h, 'waiting')
  const waiting = await h.connect.current(h.platform), before = h.store.settings()
  await vi.advanceTimersByTimeAsync(Date.parse(waiting.expiresAt!) - Date.now())
  expect(authorizingSignal?.aborted).toBe(true)
  expect(await h.connect.current(h.platform)).toMatchObject({ status: 'expired', error: 'expired' })
  expect((await h.connect.current(h.platform)).challenge).toBeUndefined()
  gate.resolve({ name: 'Late operator', profileId: token })
  await vi.advanceTimersByTimeAsync(0)
  expect(h.driver.applications).not.toHaveBeenCalled(); expect(h.driver.prepare).not.toHaveBeenCalled()
  expect((await h.connect.current(h.platform)).status).toBe('expired')
  expect(h.store.settings()).toEqual(before)
})

it('clears the old QR deadline after success while retaining the overall review deadline', async () => {
  vi.useFakeTimers()
  const h = await fixture('feishu')
  let qrDeadline = 0, authorizingSignal: AbortSignal | undefined
  h.driver.authorize.mockImplementationOnce(async (_cli, signal, challenge) => {
    authorizingSignal = signal; qrDeadline = Date.now() + 30_000
    challenge({ url: 'https://official.example/qr', expiresAt: new Date(qrDeadline).toISOString() })
    return { app: appFeishu }
  })
  await ready(h)
  const review = await h.connect.current(h.platform)
  expect(Date.parse(review.expiresAt!)).toBeGreaterThan(qrDeadline)
  expect(review.challenge).toBeUndefined()
  await vi.advanceTimersByTimeAsync(qrDeadline - Date.now() + 1)
  expect(authorizingSignal?.aborted).toBe(false)
  expect((await h.connect.current(h.platform)).status).toBe('review')
  await vi.advanceTimersByTimeAsync(Date.parse(review.expiresAt!) - Date.now())
  expect(authorizingSignal?.aborted).toBe(true)
  expect((await h.connect.current(h.platform)).status).toBe('expired')
})

it('clears only the changed account admission and chat scope while same-account rebinding preserves them', async () => {
  const h = await fixture('dingtalk', true)
  const current = h.store.settings()
  h.store.saveSettings({ ...current, sources: { ...current.sources, dingtalk: { enabled: true, config: { ...current.sources.dingtalk!.config, directMessages: false,
    chats: [{ chatId: 'old-chat', listen: 'all' }] } } } })
  const sameInput = { platform: h.platform, config: { accountId: 'old-account', credentialsFile: '/private/refreshed.json' }, accountId: 'old-account', previousAccountId: 'old-account',
    enable: true, replace: true, ...h.revisions(), signal: h.lifetime.signal }
  await h.settings.bindCli(sameInput)
  expect(h.store.settings().policy.sources.dingtalk?.allowed).toEqual([{ id: 'old-user' }])
  expect(h.store.settings().sources.dingtalk?.config).toMatchObject({ directMessages: false, chats: [{ chatId: 'old-chat', listen: 'all' }] })
  await h.settings.bindCli({ ...sameInput, ...h.revisions(), accountId: 'new-account', config: { accountId: 'new-account', credentialsFile: '/private/new.json' } })
  expect(h.store.settings().policy.sources.dingtalk).toMatchObject({ allowed: [], admission: {} })
  expect(h.store.settings().sources.dingtalk?.config).toMatchObject({ directMessages: true, chats: [] })
  expect(h.store.settings().policy.sources.wechat?.allowed).toEqual([{ id: 'other-user' }])
})

it('does not modify settings when account validation fails and preserves unrelated updates during that check', async () => {
  const h = await fixture('feishu'), original = h.store.settings()
  const input = { platform: h.platform, config: { cli: '/new/bot' }, accountId: 'cli_new', previousAccountId: '', enable: true,
    replace: false, ...h.revisions(), signal: h.lifetime.signal }
  h.setup.checkAccounts.mockRejectedValueOnce(new Error('verification failed'))
  await expect(h.settings.bindCli(input)).rejects.toThrow('verification failed')
  expect(h.store.settings()).toEqual(original)
  const gate = deferred<void>(); h.setup.checkAccounts.mockReturnValueOnce(gate.promise)
  const saving = h.settings.bindCli(input)
  const current = h.store.settings()
  h.store.saveSettings({ ...current, sources: { ...current.sources, wechat: { ...current.sources.wechat!, enabled: false } } },
    { source: 'panel', block: 'source:wechat', policyVersion: '', policyChanged: false, notified: [] })
  gate.resolve(); await saving
  expect(h.store.settings().sources.wechat?.enabled).toBe(false)
  expect(h.store.settings().sources.feishu?.config.cli).toBe('/new/bot')
})

it('pairs only the current human direct sender with an exact nonce, consumes it once, and preserves other allowlists', async () => {
  const h = await fixture('dingtalk', true), view = await h.connect.pair(h.platform, h.revisions()), command = view.pairing!.command!
  const before = h.store.settings()
  const invalid: Partial<Trigger>[] = [{ human: false }, { addressed: 'mention' }, { actor: { source: 'feishu', id: 'person' } },
    { channel: { source: 'feishu', thread: 'dm', address: {} } }, { meta: { direct: true, accountId: 'wrong-account' } },
    { meta: { direct: false, accountId: h.account(h.platform) } }]
  for (const extra of invalid) expect(h.connect.receive(trigger(h, command, extra))).toBe(true)
  expect(h.connect.receive(trigger(h, '/superagent pair ' + 'x'.repeat(24)))).toBe(true)
  expect(h.store.settings()).toEqual(before)
  expect(h.connect.receive(trigger(h, command))).toBe(true)
  expect(h.store.settings().policy.sources.dingtalk?.allowed).toEqual([{ id: 'old-user' }, { id: 'person' }])
  expect(h.store.settings().policy.sources.wechat?.allowed).toEqual([{ id: 'other-user' }])
  expect((await h.connect.current(h.platform)).pairing).toMatchObject({ status: 'paired', userId: 'person' })
  expect((await h.connect.current(h.platform)).pairing?.command).toBeUndefined()
  const revision = h.store.blockRevision('policy')
  expect(h.connect.receive(trigger(h, command, { actor: { source: h.platform, id: 'other-person' } }))).toBe(true)
  expect(h.store.blockRevision('policy')).toBe(revision)
  expect(JSON.stringify(h.store.settingsHistory())).not.toContain(command)
})

it.each(['policy', 'source:dingtalk'] as const)('refuses pairing when the captured %s revision changed', async block => {
  const h = await fixture('dingtalk', true), view = await h.connect.pair(h.platform, h.revisions()), before = h.store.settings()
  revision(h, block)
  expect(h.connect.receive(trigger(h, view.pairing!.command!))).toBe(true)
  expect(h.store.settings()).toEqual(before)
  expect((await h.connect.current(h.platform)).pairing?.status).toBe('conflict')
})

it('filters expired, cancelled, replayed and malformed pairing commands before domain intake', async () => {
  const h = await fixture('dingtalk', true)
  for (const text of ['/superagent pair short', '/superagent pair', '/superagent pair wrong-code!']) expect(h.connect.receive(trigger(h, text))).toBe(true)
  expect(h.connect.receive(trigger(h, 'ordinary task'))).toBe(false)
  vi.useFakeTimers()
  const first = (await h.connect.pair(h.platform, h.revisions())).pairing!
  await h.connect.cancelPair(h.platform, first.id)
  expect(h.connect.receive(trigger(h, first.command!))).toBe(true)
  const second = (await h.connect.pair(h.platform, h.revisions())).pairing!
  expect(second.command).not.toBe(first.command)
  expect(h.connect.receive(trigger(h, first.command!))).toBe(true)
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  expect((await h.connect.current(h.platform)).pairing).toMatchObject({ status: 'expired' })
  expect(h.connect.receive(trigger(h, second.command!))).toBe(true)
  expect(h.store.settings().policy.sources.dingtalk?.allowed).toEqual([{ id: 'old-user' }])
})

it('checks Feishu account identity at pairing time and grants no guessed app owner', async () => {
  const h = await fixture('feishu', true), view = await h.connect.pair(h.platform, h.revisions())
  h.setFeishuAccount('cli_other')
  expect(h.connect.receive(trigger(h, view.pairing!.command!))).toBe(true)
  expect(h.store.settings().policy.sources.feishu?.allowed).toEqual([{ id: 'ou_old' }])
  h.setFeishuAccount('cli_old')
  expect(h.connect.receive(trigger(h, view.pairing!.command!))).toBe(true)
  expect(h.store.settings().policy.sources.feishu?.allowed).toEqual([{ id: 'ou_old' }, { id: 'ou_person' }])
})

it('rejects direct pairing writes after lifetime stop or source disable without partially modifying policy', async () => {
  const h = await fixture('dingtalk', true), old = h.store.settings()
  h.lifetime.abort()
  expect(() => h.settings.pairCliUser({ platform: h.platform, userId: 'person', ...h.revisions() })).toThrow(SettingsConflict)
  expect(h.store.settings()).toEqual(old)
  const other = await fixture('dingtalk', true), before = other.store.settings()
  other.store.saveSettings({ ...before, sources: { ...before.sources, dingtalk: { ...before.sources.dingtalk!, enabled: false } } })
  expect(() => other.settings.pairCliUser({ platform: other.platform, userId: 'person', ...other.revisions() })).toThrow(SettingsConflict)
  expect(other.store.settings().policy.sources.dingtalk?.allowed).toEqual([{ id: 'old-user' }])
})
