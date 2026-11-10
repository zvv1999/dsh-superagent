import { createHash } from 'node:crypto'
import { chmod, lstat, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { FEISHU_USER_READ_SCOPES, FEISHU_USER_SCOPES, FeishuUser } from '../src/app/feishu-user.ts'

let directory: string, time: number, controller: AbortController
const APP = 'cli_test123456789'
const SECRET = 'fake-private-app-secret', ACCESS = 'fake-private-user-token', REFRESH = 'fake-private-refresh-token'
const token = (rotation = 0) => ({ code: 0, access_token: rotation ? `${ACCESS}-${rotation}` : ACCESS,
  refresh_token: rotation ? `${REFRESH}-${rotation}` : REFRESH, refresh_token_expires_in: 604800,
  expires_in: 120, token_type: 'Bearer', scope: FEISHU_USER_SCOPES.join(' ') })
const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, data }))
const transport = vi.fn<typeof fetch>()
let connection: FeishuUser
let rotations: number
const refreshCalls = () => transport.mock.calls.filter(([, init]) => init?.method === 'POST'
  && JSON.parse(String(init.body)).grant_type === 'refresh_token')
const make = () => new FeishuUser({ stateDir: directory, lifetime: controller.signal, port: () => 3082, fetch: transport, now: () => time })
beforeEach(async () => {
  directory = await mkdtemp(join(await realpath(tmpdir()), 'feishu-user-')); controller = new AbortController(); time = Date.now()
  rotations = 0
  transport.mockReset().mockImplementation(async (input, init) => {
    const url = String(input)
    if (url === 'https://open.feishu.cn/open-apis/authen/v2/oauth/token') {
      const body = JSON.parse(String(init?.body))
      const value = token(body.grant_type === 'refresh_token' ? ++rotations : 0)
      // Omitting scope can return the wider historical grant, including implicit profile access.
      if (body.grant_type === 'refresh_token' && !body.scope) value.scope += ' user_profile'
      return new Response(JSON.stringify(value))
    }
    if (url.endsWith('/user_info')) return ok({ open_id: 'ou_owner', name: 'Owner', email: 'ignored@example.test' })
    return ok({ items: [{ chat_id: 'oc_private', chat_type: 'p2p', name: 'Private' }], has_more: false })
  })
  connection = make()
})
afterEach(async () => { controller.abort(); vi.useRealTimers(); await rm(directory, { recursive: true, force: true }) })
async function authorize() {
  const view = await connection.begin({ appId: APP, secret: SECRET })
  const url = new URL(view.authorizationUrl!)
  await connection.callback(new URLSearchParams({ state: url.searchParams.get('state')!, code: 'one-time-code' }))
  return url
}

it('exchanges single-use state + S256 for four read scopes and offline access, saving all credentials privately', async () => {
  const url = await authorize()
  expect(url.origin).toBe('https://accounts.feishu.cn')
  expect(url.searchParams.get('scope')?.split(' ')).toEqual(FEISHU_USER_SCOPES)
  const exchange = transport.mock.calls[0]!
  expect(exchange[0]).toBe('https://open.feishu.cn/open-apis/authen/v2/oauth/token')
  const body = JSON.parse(String(exchange[1]!.body)) as Record<string, string>
  expect(body.client_secret).toBe(SECRET)
  expect(body.scope).toBe(FEISHU_USER_SCOPES.join(' '))
  expect(createHash('sha256').update(body.code_verifier!).digest('base64url')).toBe(url.searchParams.get('code_challenge'))
  expect(exchange[1]?.redirect).toBe('error')
  const view = await connection.current()
  expect(view).toMatchObject({ status: 'connected', renewal: 'automatic', user: { id: 'ou_owner', name: 'Owner' },
    refreshExpiresAt: new Date(time + 604800000).toISOString() })
  expect(JSON.stringify(view)).not.toMatch(/fake-private|one-time-code|code_verifier|authorizationUrl/)
  const file = join(directory, 'feishu-user-private', 'connection.json')
  const saved = JSON.parse(await readFile(file, 'utf8'))
  expect(saved).toMatchObject({ appId: APP, accessToken: ACCESS, secret: SECRET })
  expect(saved.refresh).toEqual({ token: REFRESH, expiresAt: time + 604800000 })
  if (process.platform !== 'win32') {
    expect((await lstat(file)).mode & 0o777).toBe(0o600)
    expect((await lstat(join(directory, 'feishu-user-private'))).mode & 0o777).toBe(0o700)
  }
  expect(await make().current()).toMatchObject({ status: 'connected', appId: APP })
  await expect(connection.callback(new URLSearchParams({ state: url.searchParams.get('state')!, code: 'one-time-code' })))
    .rejects.toMatchObject({ code: 'invalid_state' })
  expect(transport).toHaveBeenCalledTimes(3)
})

it('rejects missing, forged, duplicate, non-ASCII, expired and cancelled state before any token request', async () => {
  const pending = await connection.begin({ appId: APP, secret: SECRET })
  const state = new URL(pending.authorizationUrl!).searchParams.get('state')!
  for (const query of ['', 'state=forged', `state=${state}&state=${state}`, `state=${'你'.repeat(state.length)}`]) {
    await expect(connection.callback(new URLSearchParams(`${query}&code=c`))).rejects.toMatchObject({ code: 'invalid_state' })
  }
  time += 300001
  await expect(connection.callback(new URLSearchParams({ state, code: 'c' }))).rejects.toMatchObject({ code: 'invalid_state' })
  const fresh = await connection.begin({ appId: APP, secret: SECRET })
  await connection.cancel()
  await expect(connection.callback(new URLSearchParams({ state: new URL(fresh.authorizationUrl!).searchParams.get('state')!, code: 'c' })))
    .rejects.toMatchObject({ code: 'invalid_state' })
  expect(transport).not.toHaveBeenCalled()
})

it.each([FEISHU_USER_SCOPES.slice(0, 3).join(' '), FEISHU_USER_READ_SCOPES.join(' '),
  `${FEISHU_USER_SCOPES.join(' ')} im:message:send`, `${FEISHU_USER_SCOPES.join(' ')} offline_access`])('fails closed when granted scopes differ: %s', async scope => {
  transport.mockResolvedValueOnce(new Response(JSON.stringify({ ...token(), scope })))
  await expect(authorize()).rejects.toMatchObject({ code: 'missing_scopes' })
  expect(await connection.current()).toMatchObject({ status: 'error', configured: false, error: 'missing_scopes' })
  expect(transport).toHaveBeenCalledTimes(1)
})

it('keeps the previous grant after failed replacement and reuses its app secret only for the same app', async () => {
  await authorize()
  const key = await connection.readKey()
  await expect(connection.begin({ appId: 'cli_another123456' })).rejects.toMatchObject({ code: 'authorization_failed' })
  const view = await connection.begin({ appId: APP })
  const state = new URL(view.authorizationUrl!).searchParams.get('state')!
  await expect(connection.callback(new URLSearchParams({ state, error: 'access_denied', error_description: SECRET })))
    .rejects.toMatchObject({ code: 'denied' })
  expect(await connection.readKey()).toBe(key)
  expect(JSON.stringify(await connection.current())).not.toContain(SECRET)
  await connection.cancel()
  expect(await connection.current()).toMatchObject({ status: 'connected' })
})

it('reads bounded private/group history with provider pagination, fixed GET APIs and no credential echo', async () => {
  await authorize()
  transport.mockResolvedValueOnce(ok({ items: [{ chat_id: 'oc_private', chat_type: 'p2p', extra: SECRET }], has_more: true, page_token: 'next/+=' }))
  const page = await connection.read('feishu-user/chats?page_size=1') as { items: unknown[]; next_resource: string }
  expect(page.items).toEqual([{ chat_id: 'oc_private', chat_type: 'p2p' }])
  expect(new URL(page.next_resource, 'https://example.test').searchParams.get('page_token')).toBe('next/+=')
  for (const chat of ['oc_private', 'oc_group']) {
    transport.mockResolvedValueOnce(ok({ items: [{ message_id: 'om_one', chat_id: chat, msg_type: 'text', create_time: '123',
      body: { content: '{"text":"Untrusted chat content"}' }, unapproved: SECRET }], has_more: false, page_token: '' }))
    const result = await connection.read(`feishu-user/chat/${chat}/messages?page_size=3&start_time=10&end_time=20`)
    expect(result).toMatchObject({ items: [{ chat_id: chat, msg_type: 'text' }], next_resource: null })
    expect(JSON.stringify(result)).not.toContain(SECRET)
    const call = transport.mock.calls.at(-1)!
    const url = new URL(String(call[0]))
    expect(url.origin).toBe('https://open.feishu.cn')
    expect(url.pathname).toBe('/open-apis/im/v1/messages')
    expect(url.searchParams.get('container_id')).toBe(chat)
    expect(url.searchParams.get('page_size')).toBe('3')
    expect(url.searchParams.get('sort_type')).toBe('ByCreateTimeDesc')
    expect(call[1]?.method).toBe('GET')
  }
})

it('rejects arbitrary endpoints, send operations, duplicate or excessive query inputs before fetching', async () => {
  await authorize(); transport.mockClear()
  for (const resource of ['https://evil.test', 'feishu-user/chat/oc_test/messages/send', 'feishu-user/chats?page_size=101',
    'feishu-user/chats?types=all', 'feishu-user/chats?page_size=1&page_size=2', 'feishu-user/chat/../messages',
    'feishu-user/chat/oc_test/messages?page_size=51', 'feishu-user/chat/oc_test/messages?sort_type=bad']) {
    await expect(connection.read(resource), resource).rejects.toMatchObject({ code: 'invalid_resource' })
  }
  expect(transport).not.toHaveBeenCalled()
})

it('rejects a provider page larger than requested and messages from a different conversation', async () => {
  await authorize()
  transport.mockResolvedValueOnce(ok({ items: [{ chat_id: 'oc_one' }, { chat_id: 'oc_two' }], has_more: false }))
  await expect(connection.read('feishu-user/chats?page_size=1')).rejects.toMatchObject({ code: 'upstream_failed' })
  transport.mockResolvedValueOnce(ok({ items: [{ message_id: 'om_one', chat_id: 'oc_other', msg_type: 'text', create_time: '123' }], has_more: false }))
  await expect(connection.read('feishu-user/chat/oc_one/messages')).rejects.toMatchObject({ code: 'upstream_failed' })
})

it('retains old four-scope grants without claiming renewal and upgrades them only through explicit consent', async () => {
  await authorize()
  const file = join(directory, 'feishu-user-private', 'connection.json')
  const saved = JSON.parse(await readFile(file, 'utf8'))
  delete saved.refresh; delete saved.refreshAt; saved.scopes = [...FEISHU_USER_READ_SCOPES]
  await writeFile(file, JSON.stringify(saved))
  controller.abort(); controller = new AbortController(); connection = make()
  expect(await connection.current()).toMatchObject({ status: 'connected', renewal: 'reauthorize' })
  transport.mockClear(); time += 120001
  expect(await connection.current()).toMatchObject({ status: 'expired' })
  await expect(connection.read('feishu-user/chats')).rejects.toMatchObject({ code: 'expired' })
  expect(transport).not.toHaveBeenCalled()
  await connection.disconnect()
  await expect(connection.readKey()).rejects.toMatchObject({ code: 'not_connected' })
  expect(await make().current()).toMatchObject({ status: 'disconnected', configured: false })
})

it('rotates once for concurrent reads, preserves page identity and reloads the new private credentials', async () => {
  await authorize()
  const key = await connection.readKey()
  time += 108001
  await Promise.all(Array.from({ length: 8 }, () => connection.read('feishu-user/chats?page_size=1')))
  expect(refreshCalls()).toHaveLength(1)
  expect(JSON.parse(String(refreshCalls()[0]![1]!.body))).toEqual({ grant_type: 'refresh_token', client_id: APP,
    client_secret: SECRET, refresh_token: REFRESH, scope: FEISHU_USER_SCOPES.join(' ') })
  expect(await connection.readKey()).toBe(key)
  expect(await connection.current()).toMatchObject({ status: 'connected', renewal: 'automatic',
    refreshedAt: new Date(time).toISOString(), expiresAt: new Date(time + 120000).toISOString() })
  const saved = JSON.parse(await readFile(join(directory, 'feishu-user-private', 'connection.json'), 'utf8'))
  expect(saved.accessToken).toBe(`${ACCESS}-1`)
  expect(saved.refresh).toEqual({ token: `${REFRESH}-1`, expiresAt: time + 604800000 })
  expect(JSON.stringify(await connection.current())).not.toMatch(/fake-private|refresh_token|access_token|client_secret/)
  controller.abort(); controller = new AbortController(); connection = make()
  expect(await connection.current()).toMatchObject({ status: 'connected', renewal: 'automatic' })
  time += 108001
  await connection.readKey()
  expect(JSON.parse(String(refreshCalls()[1]![1]!.body)).refresh_token).toBe(`${REFRESH}-1`)
})

it('renews in the background with no open panel or reads, and stops timers on lifetime abort', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await authorize()
  time += 108000
  await vi.advanceTimersByTimeAsync(108000)
  await vi.waitFor(async () => expect((await connection.current()).refreshedAt).toBe(new Date(time).toISOString()))
  expect(refreshCalls()).toHaveLength(1)
  controller.abort(); time += 120000
  await vi.advanceTimersByTimeAsync(120000)
  expect(refreshCalls()).toHaveLength(1)
  await expect(connection.readKey()).rejects.toMatchObject({ code: 'not_connected' })
})

it('refreshes once and retries a bounded read when Feishu rejects the access token early', async () => {
  await authorize()
  transport.mockResolvedValueOnce(new Response(JSON.stringify({ code: 99991663, msg: SECRET })))
  expect(await connection.read('feishu-user/chats?page_size=1')).toMatchObject({ has_more: false })
  expect(refreshCalls()).toHaveLength(1)
  expect(transport.mock.calls.at(-1)![1]!.headers).toEqual({ authorization: `Bearer ${ACCESS}-1` })
})

it.each([20026, 20037, 20064, 20073, 20074, 'network'])('never replays a rejected or ambiguous single-use refresh token (%s), including after restart', async code => {
  await authorize(); time += 108001
  if (code === 'network') transport.mockRejectedValueOnce(new Error(SECRET))
  else transport.mockResolvedValueOnce(new Response(JSON.stringify({ code, msg: `${SECRET} ${REFRESH}` })))
  await connection.readKey() // The original access token is still valid.
  expect(await connection.current()).toMatchObject({ status: 'connected', renewal: 'reauthorize', renewalError: 'refresh_failed' })
  expect(JSON.stringify(await connection.current())).not.toContain(SECRET)
  controller.abort(); controller = new AbortController(); connection = make()
  expect(await connection.current()).toMatchObject({ renewal: 'reauthorize' })
  time += 12000
  await expect(connection.readKey()).rejects.toMatchObject({ code: 'expired' })
  expect(refreshCalls()).toHaveLength(1)
})

it('requires new consent when the refresh credential expires rather than extending local validity', async () => {
  transport.mockResolvedValueOnce(new Response(JSON.stringify({ ...token(), refresh_token_expires_in: 60 })))
  await authorize(); time += 120001
  expect(await connection.current()).toMatchObject({ status: 'expired', renewal: 'reauthorize' })
  await expect(connection.readKey()).rejects.toMatchObject({ code: 'expired' })
  expect(refreshCalls()).toHaveLength(0)
})

it('retries only documented temporary OAuth failures with backoff and stops after three attempts', async () => {
  await authorize(); time += 108001
  const temporary = () => new Response(JSON.stringify({ code: 20072, error_description: SECRET }), { status: 503 })
  transport.mockResolvedValueOnce(temporary())
  await connection.readKey()
  expect(await connection.current()).toMatchObject({ renewal: 'retrying' })
  await connection.readKey()
  expect(refreshCalls()).toHaveLength(1)
  time += 60001; transport.mockResolvedValueOnce(temporary())
  await expect(connection.readKey()).rejects.toMatchObject({ code: 'upstream_failed' })
  time += 60001
  await expect(connection.readKey()).rejects.toMatchObject({ code: 'expired' })
  expect(refreshCalls()).toHaveLength(2)
  time += 60000; transport.mockResolvedValueOnce(temporary())
  await expect(connection.readKey()).rejects.toMatchObject({ code: 'refresh_failed' })
  expect(await connection.current()).toMatchObject({ renewal: 'reauthorize' })
  time += 120000
  await expect(connection.readKey()).rejects.toMatchObject({ code: 'expired' })
  expect(refreshCalls()).toHaveLength(3)
})

it('rejects a wider refresh scope rather than silently adding message or profile access', async () => {
  await authorize(); time += 108001
  transport.mockResolvedValueOnce(new Response(JSON.stringify({ ...token(1), scope: `${token().scope} user_profile` })))
  await connection.readKey()
  expect(await connection.current()).toMatchObject({ renewal: 'reauthorize', renewalError: 'missing_scopes' })
})

it('saves rotation intent before a request and retries only a failed pre-request save', async () => {
  await authorize(); time += 108001
  const root = join(directory, 'feishu-user-private')
  const backup = join(directory, 'retained-private')
  await rename(root, backup); await writeFile(root, 'directory temporarily unavailable')
  await connection.readKey()
  expect(await connection.current()).toMatchObject({ renewal: 'retrying', renewalError: 'save_failed' })
  expect(refreshCalls()).toHaveLength(0)
  await rm(root); await rename(backup, root); time += 60001
  await connection.readKey()
  expect(refreshCalls()).toHaveLength(1)
  expect(await connection.current()).toMatchObject({ renewal: 'automatic' })
})

it('leaves a consumed marker on disk if saving the rotated token fails, preventing reuse after restart', async () => {
  await authorize(); time += 108001
  const root = join(directory, 'feishu-user-private')
  const backup = join(directory, 'retained-private')
  transport.mockImplementationOnce(async () => {
    const pending = JSON.parse(await readFile(join(root, 'connection.json'), 'utf8'))
    expect(pending.refresh.used).toBe(true)
    await rename(root, backup); await writeFile(root, 'directory temporarily unavailable')
    return new Response(JSON.stringify(token(1)))
  })
  await connection.readKey()
  expect(await connection.current()).toMatchObject({ renewal: 'reauthorize', renewalError: 'save_failed' })
  await rm(root); await rename(backup, root)
  controller.abort(); controller = new AbortController(); connection = make()
  expect(await connection.current()).toMatchObject({ renewal: 'reauthorize' })
  time += 12000
  await expect(connection.readKey()).rejects.toMatchObject({ code: 'expired' })
  expect(refreshCalls()).toHaveLength(1)
})

it('serializes disconnect behind an in-flight rotation and leaves no credentials or subsequent requests', async () => {
  await authorize(); time += 108001
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  transport.mockImplementationOnce(async () => { await pending; return new Response(JSON.stringify(token(1))) })
  const reading = connection.readKey()
  await vi.waitFor(() => expect(refreshCalls()).toHaveLength(1))
  const disconnecting = connection.disconnect()
  release()
  await reading; await disconnecting
  const count = transport.mock.calls.length
  expect(await connection.current()).toMatchObject({ status: 'disconnected', renewal: 'unavailable' })
  await expect(connection.readKey()).rejects.toMatchObject({ code: 'not_connected' })
  expect(transport).toHaveBeenCalledTimes(count)
  expect(await make().current()).toMatchObject({ status: 'disconnected' })
})

it('redacts upstream errors and reports the robot-capability prerequisite without falling back to bot or CLI', async () => {
  transport.mockResolvedValueOnce(new Response(JSON.stringify(token())))
    .mockResolvedValueOnce(ok({ open_id: 'ou_owner', name: 'Owner' }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ code: 232025, msg: `${SECRET} ${ACCESS}` })))
  await expect(authorize()).rejects.toMatchObject({ code: 'bot_required', upstreamCode: 232025 })
  expect(JSON.stringify(await connection.current())).not.toMatch(/fake-private/)
  expect(transport).toHaveBeenCalledTimes(3)
})

it('fails closed on unsafe credential permissions or symlinked storage', async () => {
  await authorize()
  const file = join(directory, 'feishu-user-private', 'connection.json')
  if (process.platform !== 'win32') {
    await chmod(file, 0o644)
    expect(await make().current()).toMatchObject({ status: 'error', configured: false, error: 'save_failed' })
    await chmod(file, 0o600)
    const other = join(directory, 'other.json')
    await rename(file, other)
    await symlink(other, file)
    expect(await make().current()).toMatchObject({ status: 'error', configured: false, error: 'save_failed' })
  }
})
