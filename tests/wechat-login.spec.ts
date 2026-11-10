import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { WechatLogin } from '../src/app/wechat-login.ts'
import { Settings, type SettingsHost } from '../src/app/settings.ts'
import { Store } from '../src/app/store.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { ImSource } from '../src/sources/im.ts'
import { type WechatPoll } from '../src/sources/im-wechat-login.ts'
import type { WechatLoginRequest } from '../src/app/api.ts'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); vi.useRealTimers() })
const confirmed: WechatPoll = { status: 'confirmed', confirmation: { accountId: 'bot-new', userId: 'alice',
  credential: { token: 'TOKEN_SECRET', botId: 'bot-new', baseUrl: 'https://ilinkai.weixin.qq.com' } } }
async function fixture() {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'wechat-panel-test-'))
  const directory = join(root, 'state')
  await mkdir(directory, { mode: 0o700 })
  const store = new Store(join(root, 'test.sqlite'))
  store.saveSettings({ sources: { wechat: { enabled: false, config: {} } } })
  const sources = new SourceRegistry(() => store.settings())
  sources.register(new ImSource('wechat', { connect: vi.fn() }).kind)
  const lifetime = new AbortController(), notify = vi.fn(), changed = vi.fn(), requestPass = vi.fn()
  const host = { store, sources, lifetime: lifetime.signal, sessions: { notify, delivery: vi.fn() }, engine: { policyChanged: changed },
    requestPass, context: {}, sourceHost: {}, setup: {}, health: {} } as unknown as SettingsHost
  const settings = new Settings(host)
  const protocol = { begin: vi.fn(async () => ({ qrcode: 'QR_POLL_SECRET', url: 'https://liteapp.weixin.qq.com/q/test' })),
    poll: vi.fn<(qr: string, base: string, signal: AbortSignal, code?: string) => Promise<WechatPoll>>().mockResolvedValue(confirmed),
    pause: vi.fn(async () => {}) }
  const login = new WechatLogin({ stateDir: directory, store, sources, settings, lifetime: lifetime.signal }, protocol)
  cleanups.push(async () => {
    await login.dispose(); store.close()
    if (!root.startsWith(join(await realpath(tmpdir()), 'wechat-panel-test-'))) throw new Error('Unexpected cleanup path')
    await rm(root, { recursive: true, force: true })
  })
  const request = (extra: Partial<WechatLoginRequest> = {}): WechatLoginRequest => ({ enable: true,
    sourceRevision: store.blockRevision('source:wechat'), policyRevision: store.blockRevision('policy'), ...extra })
  return { login, directory, store, sources, settings, protocol, lifetime, notify, changed, requestPass, request }
}
function pending(h: Awaited<ReturnType<typeof fixture>>, respectsAbort = true) {
  let resolve!: (poll: WechatPoll) => void
  h.protocol.poll.mockImplementationOnce((_qr, _base, signal) => new Promise(settle => {
    resolve = settle
    if (respectsAbort) signal.addEventListener('abort', () => settle({ status: 'expired' }), { once: true })
  }))
  return (value: WechatPoll) => resolve(value)
}
async function state(h: Awaited<ReturnType<typeof fixture>>, status: string) {
  await vi.waitFor(() => expect(h.login.current()?.status).toBe(status))
}

it('requires upstream confirmation before atomically saving private credentials, account and the scanner policy', async () => {
  const h = await fixture(), confirm = pending(h), before = h.store.settings()
  expect(h.login.current()).toBeNull()
  const started = h.login.begin(h.request())
  expect(started.status).toBe('starting')
  await state(h, 'waiting')
  expect(h.store.settings()).toEqual(before)
  expect(await readdir(h.directory)).toEqual([])
  expect(JSON.stringify(h.login.current())).not.toContain('QR_POLL_SECRET')
  confirm(confirmed)
  await state(h, 'connected')
  expect(h.login.current()).toMatchObject({ id: started.id, accountId: 'bot-new', userId: 'alice', enabled: true })
  expect(h.login.current()).not.toHaveProperty('qrUrl')
  const source = h.store.settings().sources.wechat!
  expect(source).toMatchObject({ enabled: true, config: { accountId: 'bot-new', directMessages: true } })
  const file = String(source.config.credentialsFile)
  expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ token: 'TOKEN_SECRET', botId: 'bot-new', baseUrl: 'https://ilinkai.weixin.qq.com' })
  expect((await stat(file)).mode & 0o777).toBe(0o600)
  expect((await stat(join(h.directory, 'im-private'))).mode & 0o777).toBe(0o700)
  expect(h.store.settings().policy.sources.wechat?.allowed).toEqual([{ id: 'alice' }])
  expect(h.store.blockRevision('source:wechat')).toBe(1)
  expect(h.store.blockRevision('policy')).toBe(1)
  expect(JSON.stringify([h.login.current(), h.store.settingsHistory(), h.notify.mock.calls])).not.toContain('TOKEN_SECRET')
  expect(h.changed).toHaveBeenCalledOnce()
  expect(h.requestPass).toHaveBeenCalledOnce()
})

it('honors save-without-enable and rejects a confirmation without a scanner identity', async () => {
  const h = await fixture()
  h.login.begin(h.request({ enable: false }))
  await state(h, 'connected')
  expect(h.store.settings().sources.wechat?.enabled).toBe(false)
  const before = h.store.settings(), files = await readdir(join(h.directory, 'im-private'))
  h.protocol.poll.mockResolvedValueOnce({ ...confirmed, confirmation: { ...confirmed.confirmation, userId: undefined } })
  h.login.begin(h.request({ replace: true }))
  await state(h, 'error')
  expect(h.login.current()?.error).toBe('missing_user')
  expect(h.store.settings()).toEqual(before)
  expect(await readdir(join(h.directory, 'im-private'))).toEqual(files)
})

it('shares duplicate begin and polls only once; cancellation ignores late confirmation and allows refresh', async () => {
  const h = await fixture(), confirm = pending(h, false), request = h.request()
  const first = h.login.begin(request)
  expect(h.login.begin(request).id).toBe(first.id)
  expect(() => h.login.begin({ ...request, enable: false })).toThrow('Cancel the current')
  await state(h, 'waiting')
  for (let i = 0; i < 10; i++) h.login.get(first.id)
  expect(h.protocol.begin).toHaveBeenCalledOnce()
  expect(h.protocol.poll).toHaveBeenCalledOnce()
  expect(h.login.cancel(first.id).status).toBe('cancelled')
  confirm(confirmed)
  await Promise.resolve()
  expect(h.store.settings().sources.wechat?.config.accountId).toBeUndefined()
  expect(await readdir(h.directory)).toEqual([])
  const next = h.login.begin(h.request())
  expect(next.id).not.toBe(first.id)
  expect(() => h.login.cancel(first.id)).toThrow('not found')
  await state(h, 'connected')
})

it('expires locally or upstream and permits retry; disposal aborts pending requests', async () => {
  const h = await fixture()
  h.protocol.poll.mockResolvedValueOnce({ status: 'expired' })
  h.login.begin(h.request())
  await state(h, 'expired')
  expect(h.login.current()).not.toHaveProperty('qrUrl')
  vi.useFakeTimers()
  const late = pending(h, false)
  h.login.begin(h.request())
  await vi.advanceTimersByTimeAsync(5 * 60_000)
  expect(h.login.current()?.status).toBe('expired')
  late(confirmed)
  await Promise.resolve()
  expect(h.store.settings().sources.wechat?.enabled).toBe(false)
  vi.useRealTimers()
  pending(h)
  h.login.begin(h.request())
  await state(h, 'waiting')
  h.lifetime.abort()
  await h.login.dispose()
  expect(h.login.current()?.status).toBe('cancelled')
  expect(() => h.login.begin(h.request())).toThrow('stopping')
  expect(await readdir(h.directory)).toEqual([])
})

it('waits for a one-use verification code without starting concurrent polling or reflecting it', async () => {
  const h = await fixture()
  h.protocol.poll.mockResolvedValueOnce({ status: 'verification' })
  const start = h.login.begin(h.request())
  await state(h, 'verification')
  expect(h.protocol.poll).toHaveBeenCalledOnce()
  expect(() => h.login.verify(start.id, 'not-a-code')).toThrow()
  const view = h.login.verify(start.id, '123456')
  expect(JSON.stringify(view)).not.toContain('123456')
  expect(() => h.login.verify(start.id, '123456')).toThrow('not waiting')
  await state(h, 'connected')
  expect(h.protocol.poll.mock.calls[1]?.[3]).toBe('123456')
})

it('requires explicit replacement, retains the old credential and resets a different account authorization', async () => {
  const h = await fixture(), oldFile = join(h.directory, 'old.json')
  await writeFile(oldFile, 'OLD_TOKEN', { mode: 0o600 })
  const old = h.store.settings()
  h.store.saveSettings({ ...old, sources: { wechat: { enabled: true, config: { accountId: 'old-bot', credentialsFile: oldFile } } },
    policy: { ...old.policy, sources: { wechat: { allowed: [{ id: 'old-user' }], admission: { direct: { unlistedAddressed: 'explicit' } } },
      github: { allowed: [{ id: 'keep-me' }] } } } })
  expect(() => h.login.begin(h.request())).toThrow('explicit confirmation')
  expect(h.protocol.begin).not.toHaveBeenCalled()
  pending(h)
  const prior = h.store.settings(), cancelled = h.login.begin(h.request({ replace: true }))
  await state(h, 'waiting')
  h.login.cancel(cancelled.id)
  expect(h.store.settings()).toEqual(prior)
  expect(await readFile(oldFile, 'utf8')).toBe('OLD_TOKEN')
  h.login.begin(h.request({ replace: true }))
  await state(h, 'connected')
  expect(h.store.settings().policy.sources.wechat).toEqual({ allowed: [{ id: 'alice' }], admission: {} })
  expect(h.store.settings().policy.sources.github?.allowed).toEqual([{ id: 'keep-me' }])
  expect(await readFile(oldFile, 'utf8')).toBe('OLD_TOKEN')
  // Reauthentication of the same account preserves its existing users and admission overrides.
  const current = h.store.settings()
  h.store.saveSettings({ ...current, policy: { ...current.policy, sources: { ...current.policy.sources,
    wechat: { allowed: [{ id: 'friend' }], admission: { direct: { unlistedAddressed: 'ignore' } } } } } })
  h.login.begin(h.request({ replace: true }))
  await state(h, 'connected')
  expect(h.store.settings().policy.sources.wechat).toEqual({ allowed: [{ id: 'friend' }, { id: 'alice' }], admission: { direct: { unlistedAddressed: 'ignore' } } })
})

it.each(['policy', 'source:wechat'] as const)('refuses %s edits made while scanning without overwriting them', async block => {
  const h = await fixture(), confirm = pending(h)
  h.login.begin(h.request())
  await state(h, 'waiting')
  h.store.saveSettings(h.store.settings(), { block, source: 'panel', policyVersion: '', policyChanged: false, notified: [] })
  const current = h.store.settings()
  confirm(confirmed)
  await state(h, 'error')
  expect(h.login.current()?.error).toBe('settings_conflict')
  expect(h.store.settings()).toEqual(current)
  expect(await readdir(h.directory)).toEqual([])
})

it('rolls back both settings revisions and the new credential if the second write fails', async () => {
  const h = await fixture(), old = h.store.settings(), history = h.store.settingsHistory()
  const save = h.store.saveSettings.bind(h.store)
  vi.spyOn(h.store, 'saveSettings').mockImplementationOnce(save).mockImplementationOnce(() => { throw new Error('TOKEN_SECRET upstream arbitrary text') })
  h.login.begin(h.request())
  await state(h, 'error')
  expect(h.login.current()?.error).toBe('save_failed')
  expect(h.store.settings()).toEqual(old)
  expect(h.store.settingsHistory()).toEqual(history)
  expect(h.store.blockRevision('source:wechat')).toBe(0)
  expect(h.store.blockRevision('policy')).toBe(0)
  expect(await readdir(join(h.directory, 'im-private'))).toEqual([])
  expect(h.notify).not.toHaveBeenCalled()
  expect(h.requestPass).not.toHaveBeenCalled()
  expect(JSON.stringify(h.login.current())).not.toContain('TOKEN_SECRET')
})

it('rejects symlinked private directories without touching the symlink target', async () => {
  const h = await fixture()
  await symlink(h.directory, join(h.directory, 'im-private'))
  h.login.begin(h.request())
  await state(h, 'error')
  expect(h.login.current()?.error).toBe('save_failed')
  expect(await readdir(h.directory)).toEqual(['im-private'])
  expect(h.store.settings().sources.wechat?.enabled).toBe(false)
})

it('redacts arbitrary upstream errors in the session view', async () => {
  const h = await fixture()
  h.protocol.begin.mockRejectedValueOnce(new Error('TOKEN_SECRET QR_POLL_SECRET'))
  h.login.begin(h.request())
  await state(h, 'error')
  expect(h.login.current()).toMatchObject({ error: 'upstream_failed' })
  expect(JSON.stringify(h.login.current())).not.toMatch(/TOKEN_SECRET|QR_POLL_SECRET/)
})
