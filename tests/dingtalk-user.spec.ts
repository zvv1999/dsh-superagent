import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DingTalkUser } from '../src/app/dingtalk-user.ts'
import type { CliCommandOptions, CliDriver } from '../src/app/cli-connect-types.ts'

const DIRECTORY = 'dingtalk-00000000-0000-4000-8000-000000000001'
const PROFILE = 'ding_corp:owner'
const CHAT = 'cid+private/=id'
const ledger = { complete: false, hasMore: false, paginationKnown: false, partial: false, failedCount: 0, stopReason: 'pagination_metadata_unknown' }
let root: string, configDir: string, time: number, controller: AbortController, connection: DingTalkUser
let snapshot: Record<string, unknown>, chatPage: Record<string, unknown>, messagePage: Record<string, unknown>
const run = vi.fn<(args: readonly string[], options: CliCommandOptions) => Promise<{ stdout: string; stderr: string }>>()
const configurations = vi.fn<() => Promise<string[]>>()
const authorize = vi.fn<CliDriver['authorize']>()
const cli = {
  installed: vi.fn(async () => true), ensure: vi.fn(async () => 'private-pinned-dws'), configurations,
  connectionDirectory: vi.fn(async () => configDir),
  io: (_platform: string, _executable: string | undefined, directory: string) => ({ executable: 'private-pinned-dws', configDir: directory, run }),
}
const make = () => new DingTalkUser({ stateDir: root, lifetime: controller.signal, cli, authorize, now: () => time })
const result = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: 'untrusted private diagnostics must never escape' })
beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), 'dingtalk-user-')); time = Date.now(); controller = new AbortController()
  configDir = join(root, 'managed-im', 'connections', DIRECTORY)
  await mkdir(configDir, { recursive: true, mode: 0o700 })
  snapshot = { success: true, authenticated: true, token_valid: true, refresh_token_valid: true,
    corp_id: 'ding_corp', corp_name: 'Owner org', user_id: 'owner', user_name: 'Owner',
    expires_at: new Date(time + 120_000).toISOString(), refresh_expires_at: new Date(time + 86400_000).toISOString(),
    access_token: 'never-expose-this-token' }
  chatPage = { ...ledger, chats: [{ openConversationId: CHAT, name: 'Existing private chat', conversationType: 'direct', accessToken: 'never-expose-this-token' }], nextCursor: 0 }
  messagePage = { ...ledger, paginationKnown: true, hasMore: true, stopReason: 'single_page',
    messages: [{ messageId: 'm_one', conversationId: CHAT, createTime: '2026-11-09 10:00:00', text: 'untrusted chat content', sender: 'Other person',
      quotedMessage: { messageId: 'm_quote', text: 'quoted text' }, accessToken: 'never-expose-this-token' }], nextPageToken: 'bound-page-token' }
  configurations.mockReset().mockResolvedValue([configDir])
  authorize.mockReset().mockImplementation(async (_cli, _signal, emit) => {
    emit({ url: 'https://login.dingtalk.com/test-consent', userCode: 'private-device-code' })
    return { profileId: PROFILE }
  })
  run.mockReset().mockImplementation(async args => {
    if (args[0] === 'auth') return result(snapshot)
    if (args[1] === '+chat-list') return result(chatPage)
    if (args[1] === '+chat-messages') return result(messagePage)
    throw new Error('Unexpected command')
  })
  connection = make()
})
afterEach(async () => { controller.abort(); await connection.cancel(); await rm(root, { recursive: true, force: true }) })
async function connect() {
  await connection.begin({ mode: 'saved' })
  await vi.waitFor(async () => { expect(await connection.current()).toMatchObject({ status: 'connected' }) })
}

it('reuses the existing private personal login, fixes the organization/user on every read, and saves no credentials', async () => {
  await connect()
  expect(authorize).not.toHaveBeenCalled()
  expect(await connection.current()).toMatchObject({ status: 'connected', configured: true, user: { id: 'owner', corpId: 'ding_corp' } })
  const file = join(root, 'dingtalk-user-private', 'selection.json')
  const saved = await readFile(file, 'utf8')
  expect(saved).toContain(PROFILE)
  expect(saved).not.toMatch(/never-expose|access_token|clientSecret/)
  expect(JSON.stringify(await connection.current())).not.toContain('never-expose')
  if (process.platform !== 'win32') expect((await lstat(file)).mode & 0o777).toBe(0o600)
  expect(await make().current()).toMatchObject({ status: 'connected' })
  const reads = run.mock.calls.filter(([args]) => args[0] === 'chat')
  expect(reads).toHaveLength(1)
  expect(reads[0]![0]).toEqual(['chat', '+chat-list', '--types', 'group,p2p', '--page-size', '1', '--profile', PROFILE, '--format', 'json', '--timeout', '20'])
})

it('preserves unknown list completeness and provides encoded conversation resources without leaking raw CLI fields', async () => {
  await connect()
  const page = await connection.read('dingtalk-user/chats?page_size=20')
  expect(page).toMatchObject({ has_more: null, complete: false, pagination_known: false, next_resource: null,
    items: [{ messages_resource: `dingtalk-user/chat/${encodeURIComponent(CHAT)}/messages` }] })
  expect(JSON.stringify(page)).not.toContain('never-expose')
  chatPage = { ...chatPage, hasMore: true, paginationKnown: true, nextCursor: 20 }
  expect(await connection.read('dingtalk-user/chats')).toMatchObject({ has_more: true, next_resource: 'dingtalk-user/chats?page_size=20&page_token=20' })
  chatPage = { ...chatPage, nextCursor: 0 }
  await expect(connection.read('dingtalk-user/chats')).rejects.toMatchObject({ code: 'upstream_failed' })
})

it('reads only the selected private/group conversation, passes an opaque continuation literally and keeps quoted context', async () => {
  await connect()
  const resource = `dingtalk-user/chat/${encodeURIComponent(CHAT)}/messages?page_size=3`
  const page = await connection.read(resource) as { next_resource: string }
  expect(page).toMatchObject({ has_more: true, complete: false, items: [{ messageId: 'm_one', quotedMessage: { text: 'quoted text' } }] })
  expect(page.next_resource).toBe(`${resource}&page_token=bound-page-token`)
  expect(JSON.stringify(page)).not.toContain('never-expose')
  messagePage = { ...messagePage, nextPageToken: 'next-bound-page-token' }
  await connection.read(page.next_resource)
  expect(run.mock.lastCall![0]).toEqual(['chat', '+chat-messages', '--group', CHAT, '--limit', '3', '--page-token', 'bound-page-token',
    '--direction', 'older', '--profile', PROFILE, '--format', 'json', '--timeout', '20'])
  messagePage = { ...messagePage, messages: [{ messageId: 'foreign', conversationId: 'cid_other', text: 'private elsewhere' }] }
  await expect(connection.read(resource)).rejects.toMatchObject({ code: 'upstream_failed' })
})

it('offers only personal groups and preserves an explicit incomplete state when list pagination is unknown', async () => {
  await connect()
  chatPage = { ...chatPage, chats: [...chatPage.chats as object[],
    { openConversationId: 'cid_group', name: '  我的项目群  ', conversationType: 'group' }] }
  const list = await connection.refreshGroups()
  expect(list).toEqual({ labels: { cid_group: '我的项目群' }, complete: false, scanned: 2, pages: 1 })
  expect(connection.groupList()).toEqual(list)
  expect(run.mock.lastCall![0]).toContain('100')
  run.mockRejectedValueOnce(new Error('private upstream failure'))
  await expect(connection.refreshGroups()).rejects.toMatchObject({ code: 'upstream_failed' })
  expect(connection.groupList()).toEqual(list)
  time += 2 * 86400_000
  expect(connection.groupList()).toBeUndefined()
})

it('follows validated personal group pages and deduplicates group IDs without fetching any messages', async () => {
  await connect()
  run.mockClear()
  run.mockImplementation(async args => {
    if (args[0] === 'auth') return result(snapshot)
    if (args[1] !== '+chat-list') throw new Error('Group discovery must not read messages')
    const second = args.includes('--page-token')
    return result({ ...ledger, paginationKnown: true, hasMore: !second, complete: second, nextCursor: second ? 0 : 2,
      chats: second ? [{ openConversationId: 'cid_group', name: 'Renamed', conversationType: 'group' },
        { openConversationId: 'cid_other', name: 'Other', conversationType: 'group' }]
        : [{ openConversationId: 'cid_group', name: 'Group', conversationType: 'group' },
          { openConversationId: CHAT, name: 'Private', conversationType: 'direct' }] })
  })
  expect(await connection.refreshGroups()).toEqual({ labels: { cid_group: 'Renamed', cid_other: 'Other' },
    complete: true, scanned: 4, pages: 2 })
  expect(run.mock.calls.filter(([args]) => args[0] === 'chat')).toHaveLength(2)
  expect(run.mock.lastCall![0]).toContain('2')
})

it('bounds group discovery and never labels a capped result as complete', async () => {
  await connect()
  run.mockImplementation(async args => {
    if (args[0] === 'auth') return result(snapshot)
    const index = args.indexOf('--page-token'), cursor = index < 0 ? 0 : Number(args[index + 1])
    return result({ ...ledger, paginationKnown: true, hasMore: true, nextCursor: cursor + 1,
      chats: [{ openConversationId: `cid_${cursor}`, name: `Group ${cursor}`, conversationType: 'group' }] })
  })
  expect(await connection.refreshGroups()).toMatchObject({ complete: false, scanned: 10, pages: 10 })
})

it('invalidates group candidates on disconnect, rejects a late read, and clears them on renewed authorization', async () => {
  await connect()
  chatPage = { ...chatPage, chats: [{ openConversationId: 'cid_group', name: 'Group', conversationType: 'group' }] }
  await connection.refreshGroups()
  let finish!: (value: ReturnType<typeof result>) => void
  run.mockImplementation(async args => args[0] === 'auth' ? result(snapshot) : new Promise(resolve => { finish = resolve }))
  const refresh = connection.refreshGroups()
  const failed = expect(refresh).rejects.toMatchObject({ code: 'not_connected' })
  await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
  await connection.disconnect()
  expect(connection.groupList()).toBeUndefined()
  finish(result(chatPage)); await failed
  expect(connection.groupList()).toBeUndefined()
  run.mockImplementation(async args => result(args[0] === 'auth' ? snapshot : chatPage))
  await connect(); await connection.refreshGroups()
  await connection.begin({ mode: 'saved' })
  expect(connection.groupList()).toBeUndefined()
})

it('removes group candidates when the saved personal identity no longer matches DWS', async () => {
  await connect(); await connection.refreshGroups()
  snapshot.user_id = 'another-owner'
  await expect(connection.refreshGroups()).rejects.toMatchObject({ code: 'identity_changed' })
  expect(connection.groupList()).toBeUndefined()
})

it('rejects unrecognized operations, duplicate parameters, invalid IDs and unbounded queries before invoking DWS', async () => {
  await connect()
  const before = run.mock.calls.length
  for (const resource of ['dingtalk-user/send', 'dingtalk-user/chats?command=send', 'dingtalk-user/chats?page_size=101',
    'dingtalk-user/chats?page_size=1&page_size=2', 'dingtalk-user/chats?page_token=-1',
    'dingtalk-user/chat/..%2F..%2Fsecret/messages', 'dingtalk-user/chat/%ZZ/messages',
    `dingtalk-user/chat/${encodeURIComponent(CHAT)}/messages?download_resources=true`,
    `dingtalk-user/chat/${encodeURIComponent(CHAT)}/messages?time=garbage`]) {
    await expect(connection.read(resource)).rejects.toMatchObject({ code: 'invalid_resource' })
  }
  expect(run).toHaveBeenCalledTimes(before)
})

it('uses DWS refresh under the fixed profile, while expiry and identity mismatch prevent both reads and cached access', async () => {
  await connect()
  const key = await connection.readKey()
  snapshot.expires_at = new Date(time + 3600_000).toISOString()
  await connection.read('dingtalk-user/chats')
  expect(await connection.readKey()).toBe(key)
  expect(await connection.current()).toMatchObject({ expiresAt: snapshot.expires_at })
  snapshot.user_id = 'different-owner'
  await expect(connection.readKey()).rejects.toMatchObject({ code: 'identity_changed' })
  await expect(connection.read('dingtalk-user/chats')).rejects.toMatchObject({ code: 'identity_changed' })
  time += 86400_001
  await expect(connection.read('dingtalk-user/chats')).rejects.toMatchObject({ code: 'expired' })
})

it('invalidates a pending read on local disconnect and leaves the CLI login and source settings alone', async () => {
  await connect()
  let finish: (value: { stdout: string; stderr: string }) => void = () => {}
  const started = Promise.withResolvers<void>()
  run.mockImplementation(async args => {
    if (args[0] === 'auth') return result(snapshot)
    started.resolve()
    return new Promise(resolve => { finish = resolve })
  })
  const pending = connection.read('dingtalk-user/chats')
  await started.promise
  expect(await connection.disconnect()).toMatchObject({ configured: false, status: 'disconnected' })
  finish(result(chatPage))
  await expect(pending).rejects.toMatchObject({ code: 'not_connected' })
  await expect(connection.readKey()).rejects.toMatchObject({ code: 'not_connected' })
  expect(run.mock.calls.every(([args]) => args[0] === 'auth' || args[0] === 'chat')).toBe(true)
})

it('cancels a new consent attempt without replacing the working connection or exposing device codes in saved metadata', async () => {
  await connect()
  const before = await readFile(join(root, 'dingtalk-user-private', 'selection.json'), 'utf8')
  const finish = Promise.withResolvers<{ profileId: string }>()
  authorize.mockImplementation(async (_cli, _signal, emit) => {
    emit({ url: 'https://login.dingtalk.com/test-consent', userCode: 'private-device-code' })
    return finish.promise
  })
  await connection.begin({ mode: 'authorize' })
  await vi.waitFor(async () => { expect(await connection.current()).toMatchObject({ status: 'waiting' }) })
  await connection.cancel(); finish.resolve({ profileId: PROFILE })
  expect(await connection.current()).toMatchObject({ status: 'connected' })
  expect(await readFile(join(root, 'dingtalk-user-private', 'selection.json'), 'utf8')).toBe(before)
})

it('offers multiple saved identities for explicit selection and rejects stale or foreign profile choices', async () => {
  const other = join(root, 'managed-im', 'connections', 'dingtalk-00000000-0000-4000-8000-000000000002')
  await mkdir(other, { mode: 0o700 })
  configurations.mockResolvedValue([configDir, other])
  let n = 0
  run.mockImplementation(async args => {
    if (args[0] === 'auth') return result({ ...snapshot, user_id: ++n % 2 ? 'owner' : 'other-owner' })
    return result(chatPage)
  })
  await connection.begin({ mode: 'saved' })
  await vi.waitFor(async () => { expect(await connection.current()).toMatchObject({ status: 'select_account', accounts: [{ profileId: PROFILE }, { profileId: 'ding_corp:other-owner' }] }) })
  expect((await connection.current()).configured).toBe(false)
  await connection.begin({ mode: 'saved', profileId: 'ding_corp:foreign' })
  await vi.waitFor(async () => { expect(await connection.current()).toMatchObject({ status: 'error', error: 'identity_changed' }) })
})

it('does not restore malformed or directory-traversing selections and hides unexpected process diagnostics', async () => {
  await connection.current()
  await writeFile(join(root, 'dingtalk-user-private', 'selection.json'), JSON.stringify({ directory: '../outside', profileId: PROFILE }), { mode: 0o600 })
  expect(await make().current()).toMatchObject({ status: 'error', configured: false, error: 'save_failed' })
  await connect()
  run.mockRejectedValue(new Error('access_token=never-expose-this-token'))
  await expect(connection.read('dingtalk-user/chats')).rejects.toThrow('DingTalk user connection: upstream_failed')
})
