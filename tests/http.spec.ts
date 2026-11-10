import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { registerHttp } from '../src/app/http.ts'
import { PromptConflict } from '../src/app/prompts.ts'
import { SettingsConflict } from '../src/app/settings.ts'
import type { HttpHost } from '../src/app/http.ts'
import { SettingsSchema } from '../src/policy.ts'
import { SetupError } from '../src/setup.ts'
import { OperatorRequestConflict } from '../src/sources/operator.ts'

type Handler = (req: unknown, res: unknown) => Promise<void>
type Headers = Record<string, string | undefined>
/** Mount management HTTP routes on a fake web server and return a request helper that includes default panel headers. */
function serve(runtime: Partial<Record<keyof HttpHost, unknown>>, host = '127.0.0.1', responseHeaders?: Record<string, string>) {
  let handler: Handler = async () => {}
  const ctx = { webServer: { host, port: 3082, register: (route: { handler: Handler }) => { handler = route.handler; return () => {} } } }
  registerHttp(ctx as never, { ready: Promise.resolve(), ...runtime } as unknown as HttpHost)
  return async (method: string, path: string, body?: unknown, headers: Headers = {}) => {
    let status = 0, text = ''
    const chunks = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
    const sent = Object.fromEntries(Object.entries({ host: '127.0.0.1:3082', 'x-orchestrator-request': '1', ...headers }).filter(([,
      value]) => value !== undefined))
    const req = { method, url: `/orchestrator/api/${path}`, headers: sent, async *[Symbol.asyncIterator]() { yield* chunks } }
    await handler(req, { writeHead: (code: number, headers: Record<string, string>) => {
      status = code
      if (responseHeaders) Object.assign(responseHeaders, headers)
    }, end: (data: string) => { text = data } })
    return { status, body: JSON.parse(text) as Record<string, unknown> }
  }
}

it('accepts only bounded explicit owner requests behind the loopback management gate', async () => {
  const submit = vi.fn(() => ({ triggerId: 'owner-request', result: 'stored' as const }))
  const call = serve({ operatorRequests: { submit } })
  const request = { id: 'verify-schedule-20261109', text: 'Verify the scheduling defect.' }
  for (const headers of [{ origin: 'https://outside.example' }, { 'x-orchestrator-request': undefined }, { host: 'outside.example:3082' }]) {
    expect(await call('POST', 'requests', request, headers)).toMatchObject({ status: 403 })
  }
  expect(submit).not.toHaveBeenCalled()
  for (const body of [{ ...request, actor: 'another-person' }, { ...request, source: 'dingtalk' },
    { ...request, channel: { source: 'dingtalk' } }, { ...request, command: 'execute' },
    { ...request, id: '../outside' }, { ...request, text: '' }, { ...request, text: 'a'.repeat(30_001) }]) {
    expect(await call('POST', 'requests', body)).toMatchObject({ status: 400 })
  }
  expect(submit).not.toHaveBeenCalled()
  expect(await call('POST', 'requests', request)).toMatchObject({ status: 200, body: { triggerId: 'owner-request', result: 'stored' } })
  expect(submit).toHaveBeenCalledWith(request)
  submit.mockImplementation(() => { throw new OperatorRequestConflict('Request ID already contains different text') })
  expect(await call('POST', 'requests', request)).toMatchObject({ status: 409 })
})

it('gates personal DingTalk history and rejects caller-supplied commands, paths, credentials or permissions', async () => {
  const view = { status: 'disconnected', configured: false, cli: { installed: true, version: '1.0.67' } }
  const dingtalkUser = { current: vi.fn(() => view), begin: vi.fn(() => view), cancel: vi.fn(() => view),
    disconnect: vi.fn(() => view), read: vi.fn(() => ({ items: [] })), groupList: vi.fn(),
    refreshGroups: vi.fn(() => ({ labels: { cid_team: 'Team' }, complete: false, scanned: 100, pages: 1 })) }
  const call = serve({ dingtalkUser })
  for (const [path, body] of [['connect', { mode: 'saved' }], ['cancel', {}], ['disconnect', {}], ['read', { resource: 'dingtalk-user/chats' }], ['groups/refresh', {}]]) {
    expect(await call('POST', `connections/dingtalk-user/${path}`, body, { origin: 'https://evil.test' })).toMatchObject({ status: 403 })
  }
  expect(dingtalkUser.begin).not.toHaveBeenCalled(); expect(dingtalkUser.read).not.toHaveBeenCalled()
  expect(dingtalkUser.refreshGroups).not.toHaveBeenCalled()
  expect(await call('GET', 'connections/dingtalk-user', undefined, { 'x-orchestrator-request': undefined })).toMatchObject({ status: 403 })
  expect(await call('POST', 'connections/dingtalk-user/connect', { mode: 'saved', configDir: '/outside', scopes: ['send'] })).toMatchObject({ status: 400 })
  expect(await call('POST', 'connections/dingtalk-user/read', { resource: 'dingtalk-user/chats', command: 'send' })).toMatchObject({ status: 400 })
  expect(await call('POST', 'connections/dingtalk-user/connect', { mode: 'saved' })).toMatchObject({ status: 200 })
  expect(await call('POST', 'connections/dingtalk-user/read', { resource: 'dingtalk-user/chats' })).toMatchObject({ status: 200 })
  expect(await call('GET', 'connections/dingtalk-user/groups')).toMatchObject({ status: 200, body: null })
  expect(await call('GET', 'connections/dingtalk-user/groups', undefined, { 'x-orchestrator-request': undefined })).toMatchObject({ status: 403 })
  expect(await call('POST', 'connections/dingtalk-user/groups/refresh', { accountId: 'other' })).toMatchObject({ status: 400 })
  expect(await call('POST', 'connections/dingtalk-user/groups/refresh', {})).toMatchObject({ status: 200,
    body: { labels: { cid_team: 'Team' }, complete: false, scanned: 100, pages: 1 } })
})

it('keeps personal Feishu credentials and history behind the same-origin gate and validates the read-only contract', async () => {
  const view = { status: 'disconnected', configured: false, scopes: [], redirectUri: 'http://127.0.0.1:3082/orchestrator/oauth/feishu/callback' }
  const feishuUser = { current: vi.fn(() => view), begin: vi.fn(() => view), cancel: vi.fn(() => view),
    disconnect: vi.fn(() => view), renew: vi.fn(() => view), read: vi.fn(() => ({ items: [] })) }
  const call = serve({ feishuUser })
  const posts = [['authorize', { appId: 'cli_test123456', secret: 'private-test-secret' }], ['cancel', {}], ['disconnect', {}],
    ['refresh', {}], ['read', { resource: 'feishu-user/chats?page_size=1' }]] as const
  for (const [path, body] of posts) {
    expect(await call('POST', `connections/feishu-user/${path}`, body, { origin: 'https://evil.test' })).toMatchObject({ status: 403 })
  }
  expect(feishuUser.begin).not.toHaveBeenCalled(); expect(feishuUser.read).not.toHaveBeenCalled()
  expect(feishuUser.renew).not.toHaveBeenCalled()
  expect(await call('POST', 'connections/feishu-user/refresh', { refresh_token: 'forged' })).toMatchObject({ status: 400 })
  expect(await call('POST', 'connections/feishu-user/refresh', {})).toMatchObject({ status: 200 })
  expect(feishuUser.renew).toHaveBeenCalledTimes(1)
  expect(await call('POST', 'connections/feishu-user/authorize', { appId: 'cli_test123456', secret: 's', scopes: ['send'] })).toMatchObject({ status: 400 })
  expect(await call('POST', 'connections/feishu-user/read', { resource: 'feishu-user/chats', token: 'forged' })).toMatchObject({ status: 400 })
  expect(await call('POST', 'connections/feishu-user/read', { resource: 'feishu-user/chats?page_size=1' })).toMatchObject({ status: 200 })
})

it('permits only the exact loopback OAuth GET callback without the panel header and removes codes from the result URL', async () => {
  let handler: Handler = async () => {}
  const callback = vi.fn(async () => {})
  registerHttp({ webServer: { host: '127.0.0.1', port: 3082, register: (route: { handler: Handler }) => {
    handler = route.handler; return () => {}
  } } } as never, { feishuUser: { callback } } as unknown as HttpHost)
  const request = async (method: string, host: string, path: string) => {
    let status = 0, headers: Record<string, string> = {}, text = ''
    await handler({ method, headers: { host }, url: path }, {
      writeHead: (code: number, values: Record<string, string>) => { status = code; headers = values }, end: (value?: string) => { text = value ?? '' } })
    return { status, headers, text }
  }
  const path = '/orchestrator/oauth/feishu/callback?state=one&code=private-code'
  for (const [method, host] of [['POST', '127.0.0.1:3082'], ['GET', 'evil.test:3082'], ['GET', '127.0.0.1:9999']]) {
    expect((await request(method!, host!, path)).status).toBe(403)
  }
  expect(callback).not.toHaveBeenCalled()
  const result = await request('GET', '127.0.0.1:3082', path)
  expect(result).toMatchObject({ status: 303, headers: { location: '/orchestrator/oauth/feishu/done',
    'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } })
  expect(JSON.stringify(result)).not.toContain('private-code')
  expect((await request('GET', '127.0.0.1:3082', '/orchestrator/api/connections/feishu-user')).status).toBe(403)
})

it('gates personal subscriptions by same origin and validates only bounded target metadata', async () => {
  const subscriptions = { list: vi.fn(async () => []), subscribe: vi.fn(async () => ({ id: 'one' })),
    unsubscribe: vi.fn(() => ({ removed: true })), check: vi.fn(async () => []),
    setMode: vi.fn(async () => ({ id: 'one', mode: 'tasks' })), assessLatest: vi.fn(async () => ({ triggerId: 'latest', result: 'stored' })) }
  const call = serve({ dingtalkSubscriptions: subscriptions })
  for (const [method, path, body] of [
    ['GET', 'connections/dingtalk-user/subscriptions', undefined],
    ['POST', 'connections/dingtalk-user/subscriptions', { chatId: 'cid_one', name: 'Selected', senderId: 'person' }],
    ['POST', 'connections/dingtalk-user/subscriptions/one/check', {}],
    ['POST', 'connections/dingtalk-user/subscriptions/one/unsubscribe', {}],
    ['POST', 'connections/dingtalk-user/subscriptions/one/mode', { mode: 'tasks' }],
    ['POST', 'connections/dingtalk-user/subscriptions/one/assess-latest', {}],
  ] as const) {
    expect(await call(method, path, body, { origin: 'https://evil.example' })).toMatchObject({ status: 403 })
    expect(await call(method, path, body)).toMatchObject({ status: 200 })
  }
  const before = subscriptions.subscribe.mock.calls.length
  for (const body of [{ chatId: '../secret', name: 'Bad' }, { chatId: 'cid_one', name: 'Selected', command: 'send' },
    { chatId: 'cid_one', name: 'a'.repeat(257) }]) {
    expect(await call('POST', 'connections/dingtalk-user/subscriptions', body)).toMatchObject({ status: 400 })
  }
  expect(subscriptions.subscribe).toHaveBeenCalledTimes(before)
  for (const body of [{ mode: 'auto' }, { mode: 'tasks', owner: 'forged' }]) {
    expect(await call('POST', 'connections/dingtalk-user/subscriptions/one/mode', body)).toMatchObject({ status: 400 })
  }
  expect(await call('POST', 'connections/dingtalk-user/subscriptions/one/assess-latest', { text: 'forged' })).toMatchObject({ status: 400 })
  expect(subscriptions.setMode).toHaveBeenCalledTimes(1)
  expect(subscriptions.assessLatest).toHaveBeenCalledTimes(1)
})

it('answers each kind of failure with its own status', async () => {
  const saves: unknown[] = []
  const call = serve({
    store: { tickets: { get: () => undefined }, blockRevision: () => 0 },
    sources: { instances: () => [{ id: 'github' }] },
    settings: { save: async (...args: unknown[]) => {
      saves.push(args)
      if (args[1] === 'stale') throw new SettingsConflict('Settings changed. Reload before saving.')
      if (args[1] === 'invalid') z.object({ maxWorkers: z.number() }).parse({})
      if (args[1] === 'refused') throw new SetupError('agentCliUnset')
      if (args[1] === 'broken') throw new Error('disk full')
      return { saved: true, revision: 1, restarting: false }
    } },
  })
  expect(await call('PUT', 'settings/executor', { value: 'stale', revision: 0 })).toMatchObject({ status: 409 })
  expect(await call('PUT', 'settings/executor', { value: 'invalid', revision: 0 })).toMatchObject({ status: 400, body: { issues: [{ path: 'maxWorkers' }] } })
  expect(await call('PUT', 'settings/source:github', { value: 'refused', revision: 0 })).toMatchObject({ status: 400, body: { setup: { code: 'agentCliUnset', place: 'github' } } })
  expect(await call('PUT', 'settings/executor', { value: 'broken', revision: 0 })).toEqual({ status: 500, body: { error: 'disk full' } })
  // Block names are validated before calling settings.save: reject unknown blocks or non-existent Sources.
  expect(await call('PUT', 'settings/pause', { value: {}, revision: 0 })).toMatchObject({ status: 400 })
  expect(await call('PUT', 'settings/source:feishu', { value: {}, revision: 0 })).toEqual({ status: 404, body: { error: 'Source not found' } })
  expect(saves).toHaveLength(4)
  expect(await call('POST', 'tickets/t9/retry')).toEqual({ status: 404, body: { error: 'Ticket not found' } })
  expect(await call('GET', 'nothing/here')).toEqual({ status: 404, body: { error: 'Unknown operation' } })
  expect(await call('POST', 'executor/pause', 'not json')).toEqual({ status: 400, body: { error: 'The request body is not JSON' } })
})

it('decodes path parameters and parses each route\'s query', async () => {
  const seen: unknown[] = []
  const call = serve({
    store: { settings: () => SettingsSchema.parse({}),
      read: { decisions: (filter: unknown, offset: number, limit: number) => { seen.push({ filter, offset, limit }); return { items: [], more: false } } } },
    links: () => () => ({ url: '', label: { zh: '', en: '' } }),
    engine: { unsubscribe: (key: string) => { seen.push(key); return true } },
    sessions: { delivery: async () => 'injected' },
  })
  expect(await call('POST', `threads/${encodeURIComponent('feishu:oc_1:om/root')}/unsubscribe`)).toMatchObject({ status: 200, body: { context_delivery: 'injected' } })
  // Invalid offsets default to 0, and limits above the route maximum are clamped.
  expect(await call('GET', 'decisions?kind=accept%2Creopen&limit=500&offset=x&window=24h')).toEqual({ status: 200, body: { items: [], next_offset: null } })
  expect(seen).toEqual(['feishu:oc_1:om/root', { filter: { kinds: ['accept', 'reopen'], since: expect.any(String) }, offset: 0, limit: 200 }])
})

it('answers only a same-origin request from the panel on the loopback address', async () => {
  const call = serve({ sessions: { delivery: async () => 'injected' }, engine: { unsubscribe: () => true } })
  const post = (headers: Headers) => call('POST', 'threads/github%3A1/unsubscribe', undefined, headers)
  for (const headers of [{ 'x-orchestrator-request': undefined }, { host: 'evil.example:3082' }, { host: '127.0.0.1:9999' },
    { origin: 'http://evil.example' }, { host: 'localhost:3082', origin: 'http://127.0.0.1:3082' }]) {
    expect(await post(headers), JSON.stringify(headers)).toEqual({ status: 403,
      body: { error: 'Same-origin management request required' } })
  }
  expect(await post({ host: 'localhost:3082', origin: 'http://localhost:3082' })).toMatchObject({ status: 200 })
  // Management routes require a loopback Web server.
  expect(() => serve({}, '0.0.0.0')).toThrow('Orchestrator management requires a loopback Web server')
})

it('answers a prompt save that lost a race with 409, and a settings body over 128 KiB with 400', async () => {
  const saves: unknown[] = []
  const call = serve({
    machine: { promptMaxChars: { get: () => 100_000 } },
    store: { atomic: (work: () => unknown) => work(), blockRevision: () => 0 },
    prompts: { save: () => { throw new PromptConflict('Prompt version changed to 3; compare the latest version before saving') } },
    sessions: { notify: () => {}, delivery: async () => 'injected' },
    settings: { save: async (...args: unknown[]) => { saves.push(args); return { saved: true, revision: 1, restarting: false } } },
  })
  expect(await call('PUT', 'prompts', { config: {}, baseRevision: 2 }))
    .toEqual({ status: 409, body: { error: 'Prompt version changed to 3; compare the latest version before saving' } })
  const value = { prepare: 'x'.repeat(128 * 1024) }
  expect(await call('PUT', 'settings/executor', { value, revision: 0 })).toEqual({ status: 400,
    body: { error: `Request exceeds ${128 * 1024} bytes` } })
  expect(saves).toEqual([])
})

it('protects every WeChat pairing endpoint with the existing same-origin gate and strictly validates inputs', async () => {
  const view = { id: 'login-1', status: 'waiting', expiresAt: new Date().toISOString(), qrUrl: 'https://liteapp.weixin.qq.com/q/secret' }
  const wechatLogin = { current: vi.fn(() => view), begin: vi.fn(() => view), get: vi.fn(() => view),
    cancel: vi.fn(() => ({ ...view, status: 'cancelled' })), verify: vi.fn(() => view) }
  const headers: Record<string, string> = {}
  const call = serve({ wechatLogin }, '127.0.0.1', headers)
  const request = { enable: true, sourceRevision: 0, policyRevision: 0 }
  const routes = [['GET', 'sources/wechat/login', undefined], ['POST', 'sources/wechat/login', request],
    ['GET', 'sources/wechat/login/login-1', undefined], ['POST', 'sources/wechat/login/login-1/cancel', {}],
    ['POST', 'sources/wechat/login/login-1/verify', { code: '123456' }]] as const
  for (const [method, path, body] of routes) {
    for (const headers of [{ 'x-orchestrator-request': undefined }, { origin: 'https://evil.example' }, { host: 'evil.example:3082' }]) {
      expect(await call(method, path, body, headers)).toEqual({ status: 403, body: { error: 'Same-origin management request required' } })
    }
  }
  for (const handler of Object.values(wechatLogin)) expect(handler).not.toHaveBeenCalled()
  expect(await call('POST', 'sources/wechat/login', { ...request, token: 'TOKEN_SECRET', url: 'https://evil.example' })).toMatchObject({ status: 400 })
  expect(await call('POST', 'sources/wechat/login', { enable: true })).toMatchObject({ status: 400 })
  expect(await call('POST', 'sources/wechat/login/login-1/verify', { code: 'bad' })).toMatchObject({ status: 400 })
  expect(wechatLogin.begin).not.toHaveBeenCalled()
  expect(wechatLogin.verify).not.toHaveBeenCalled()
  for (const [method, path, body] of routes) expect(await call(method, path, body)).toMatchObject({ status: 200 })
  expect(wechatLogin.begin).toHaveBeenCalledWith({ ...request, replace: false })
  expect(wechatLogin.cancel).toHaveBeenCalledWith('login-1')
  expect(wechatLogin.verify).toHaveBeenCalledWith('login-1', '123456')
  expect(headers).toMatchObject({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
})

it('protects every CLI authorization operation before reading sensitive inputs and never caches its response', async () => {
  const view = { platform: 'dingtalk', id: 'attempt-1', status: 'waiting', cli: { installed: true, version: '1.0.67' }, configured: false, enabled: false, allowed: false }
  const cliConnect = Object.fromEntries(['current', 'begin', 'select', 'credentials', 'check', 'confirm', 'cancel', 'pair', 'cancelPair'].map(name => [name, vi.fn(() => view)]))
  const headers: Record<string, string> = {}, call = serve({ cliConnect }, '127.0.0.1', headers)
  const revisions = { sourceRevision: 0, policyRevision: 0 }, start = { ...revisions, enable: true, mode: 'quick' }
  const routes = [['GET', 'sources/dingtalk/connect', undefined], ['POST', 'sources/dingtalk/connect', start],
    ['POST', 'sources/dingtalk/connect/attempt-1/select', { appId: 'app-1' }],
    ['POST', 'sources/dingtalk/connect/attempt-1/credentials', { appId: 'app-1', secret: 'PRIVATE_INPUT_SECRET' }],
    ['POST', 'sources/dingtalk/connect/attempt-1/check', {}], ['POST', 'sources/dingtalk/connect/attempt-1/confirm', { ...revisions, enable: true }],
    ['POST', 'sources/dingtalk/connect/attempt-1/cancel', {}], ['POST', 'sources/dingtalk/pair', revisions],
    ['POST', 'sources/dingtalk/pair/pair-1/cancel', {}]] as const
  for (const [method, path, body] of routes) for (const unsafe of [{ 'x-orchestrator-request': undefined }, { origin: 'https://other.example' }, { host: 'other.example:3082' }]) {
    expect(await call(method, path, body, unsafe)).toMatchObject({ status: 403 })
  }
  for (const handler of Object.values(cliConnect)) expect(handler).not.toHaveBeenCalled()
  for (const [method, path, body] of routes) {
    const result = await call(method, path, body)
    expect(result).toEqual({ status: 200, body: view })
    expect(JSON.stringify(result)).not.toContain('PRIVATE_INPUT_SECRET')
    expect(headers).toMatchObject({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  }
  expect(cliConnect.credentials).toHaveBeenCalledWith('dingtalk', 'attempt-1', { appId: 'app-1', secret: 'PRIVATE_INPUT_SECRET' })
  expect(await call('GET', 'sources/feishu/connect')).toMatchObject({ status: 200 })
  expect(cliConnect.current).toHaveBeenLastCalledWith('feishu')
  expect(await call('GET', 'sources/unknown/connect')).toMatchObject({ status: 400 })
  expect(await call('POST', 'sources/dingtalk/connect', { ...start, command: 'arbitrary command' })).toMatchObject({ status: 400 })
  expect(await call('POST', 'sources/dingtalk/connect/attempt-1/confirm', { enable: true })).toMatchObject({ status: 400 })
  expect(await call('POST', 'sources/dingtalk/connect/attempt-1/credentials', { appId: '../outside', secret: 'SECRET' })).toMatchObject({ status: 400 })
  expect(await call('POST', 'sources/dingtalk/pair', { ...revisions, userId: 'not-a-message-sender' })).toMatchObject({ status: 400 })
  expect(await call('POST', 'sources/dingtalk/connect/attempt-1/cancel', { secret: 'SECRET' })).toMatchObject({ status: 400 })
  expect(await call('POST', 'sources/dingtalk/connect/attempt-1/credentials', { appId: 'app-1', secret: 's'.repeat(25 * 1024) })).toMatchObject({ status: 400 })
})
