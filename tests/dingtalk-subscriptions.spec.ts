import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DingTalkSubscriptions } from '../src/app/dingtalk-subscriptions.ts'
import { DingTalkUserError } from '../src/app/dingtalk-user.ts'
import type { DingTalkUserView } from '../src/app/api.ts'
import { Store } from '../src/app/store.ts'
import { KV } from '../src/kv.ts'

const chatId = 'cid+owner/chat=', senderId = 'person-other'
const resource = `dingtalk-user/chat/${encodeURIComponent(chatId)}/messages?page_size=50`
const input = { chatId, name: 'Selected person', senderId }
const message = (id: string, sender = senderId, conversation = chatId) => ({ messageId: id, conversationId: conversation,
  senderId: sender, createTime: '2026-11-09 14:00:00', text: 'untrusted message body must not be saved' })
const page = (ids: string[], next: string | null = null) => ({ items: ids.map(id => message(id)),
  pagination_known: true, has_more: next !== null, next_resource: next })
let root: string, store: Store, lifetime: AbortController, subscriptions: DingTalkSubscriptions, status: DingTalkUserView
const read = vi.fn<(resource: string, signal?: AbortSignal) => Promise<unknown>>()
const readKey = vi.fn<() => Promise<string>>()
const notify = vi.fn()
const make = () => new DingTalkSubscriptions({ store, connection: { current: async () => status, read, readKey },
  lifetime: lifetime.signal, notify })
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'personal-dingtalk-subscription-')); store = new Store(join(root, 'state.sqlite'))
  lifetime = new AbortController()
  status = { status: 'connected', configured: true, cli: { installed: true, version: '1.0.67' },
    user: { id: 'owner', corpId: 'corp', name: 'Owner' } }
  read.mockReset().mockResolvedValue(page(['baseline']))
  readKey.mockReset().mockResolvedValue('current-grant')
  notify.mockReset(); subscriptions = make()
})
afterEach(async () => { lifetime.abort(); await subscriptions.dispose(); store.close(); await rm(root, { recursive: true, force: true }) })

it('baselines existing history, subscribes idempotently and retains only scoped metadata', async () => {
  const first = await subscriptions.subscribe(input)
  expect(first).toMatchObject({ status: 'listening', received: 0, pollSeconds: 30, chatId, senderId })
  expect(await subscriptions.subscribe(input)).toEqual(first)
  expect(read).toHaveBeenCalledTimes(1)
  expect(notify).not.toHaveBeenCalled()
  expect(JSON.stringify(store.get(KV.dingtalkUser.subscriptions(first.id)))).not.toContain('untrusted message body')
})

it('notifies only new messages from the selected person and never replays them after restart', async () => {
  const first = await subscriptions.subscribe(input)
  read.mockResolvedValue({ ...page([]), items: [message('new'), message('mine', 'owner'), message('new'), message('baseline')] })
  expect(await subscriptions.check()).toMatchObject([{ received: 1, status: 'listening' }])
  expect(notify).toHaveBeenCalledTimes(1)
  expect(notify.mock.calls[0]![1]).toMatchObject({ type: 'personal_dingtalk_update', message_ids: ['new'],
    subscription: { id: first.id, messagesResource: resource } })
  expect(JSON.stringify(notify.mock.calls)).not.toContain('untrusted message body')
  subscriptions = make()
  expect(await subscriptions.check()).toMatchObject([{ received: 1 }])
  expect(notify).toHaveBeenCalledTimes(1)
})

it('checkpoints a bounded catch-up and resumes the provider page cursor after restart', async () => {
  const item = await subscriptions.subscribe(input)
  read.mockImplementation(async target => {
    if (target === resource) return page(['new-1'], `${resource}&page_token=two`)
    if (target.endsWith('=two')) return page(['new-2'], `${resource}&page_token=three`)
    if (target.endsWith('=three')) return page(['new-3'], `${resource}&page_token=four`)
    return page(['new-4', 'baseline'])
  })
  expect(await subscriptions.check()).toMatchObject([{ status: 'catching_up', received: 3 }])
  expect(store.get(KV.dingtalkUser.subscriptions(item.id))?.continuation).toBe(`${resource}&page_token=four`)
  subscriptions = make()
  expect(await subscriptions.check()).toMatchObject([{ status: 'listening', received: 4 }])
  expect(read.mock.lastCall![0]).toBe(`${resource}&page_token=four`)
})

it('preserves the last successful checkpoint when a later page fails and retries without duplicate notices', async () => {
  const item = await subscriptions.subscribe(input)
  read.mockImplementation(async target => {
    if (target === resource) return page(['new'], `${resource}&page_token=two`)
    throw new Error('private provider error with token must not escape')
  })
  expect(await subscriptions.check()).toMatchObject([{ received: 1, status: 'error', error: 'upstream_failed' }])
  expect(store.get(KV.dingtalkUser.subscriptions(item.id))?.continuation).toBe(`${resource}&page_token=two`)
  read.mockResolvedValue(page(['baseline']))
  expect(await subscriptions.check()).toMatchObject([{ received: 1, status: 'listening' }])
  expect(notify).toHaveBeenCalledTimes(1)
})

it('blocks foreign account and conversation reads, and treats unknown pagination as a failure', async () => {
  await subscriptions.subscribe(input)
  status = { ...status, user: { id: 'different-owner', corpId: 'corp', name: 'Other' } }
  const before = read.mock.calls.length
  expect(await subscriptions.check()).toMatchObject([{ status: 'suspended' }])
  expect(read).toHaveBeenCalledTimes(before)
  status = { ...status, user: { id: 'owner', corpId: 'corp', name: 'Owner' } }
  read.mockResolvedValue({ ...page([]), items: [message('foreign', senderId, 'cid_foreign')] })
  expect(await subscriptions.check()).toMatchObject([{ received: 0, error: 'upstream_failed' }])
  read.mockResolvedValue({ ...page([]), pagination_known: false, has_more: null })
  expect(await subscriptions.check()).toMatchObject([{ received: 0, error: 'upstream_failed' }])
  expect(notify).not.toHaveBeenCalled()
})

it('invalidates an in-flight page on unsubscribe and allows a fresh baseline on a later subscription', async () => {
  const item = await subscriptions.subscribe(input), pending = Promise.withResolvers<unknown>()
  read.mockReturnValue(pending.promise)
  const check = subscriptions.check()
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  expect(subscriptions.unsubscribe(item.id)).toEqual({ removed: true })
  pending.resolve(page(['new', 'baseline']))
  expect(await check).toEqual([])
  expect(notify.mock.calls.map(call => call[1].type)).toEqual(['personal_dingtalk_subscription_removed'])
  read.mockResolvedValue(page(['new']))
  expect(await subscriptions.subscribe(input)).toMatchObject({ received: 0 })
})

it('rejects a changed grant during a pending baseline and a redirected continuation before checkpointing it', async () => {
  readKey.mockResolvedValueOnce('old').mockResolvedValueOnce('new')
  await expect(subscriptions.subscribe(input)).rejects.toMatchObject({ code: 'not_connected' })
  expect(await subscriptions.list()).toEqual([])
  readKey.mockResolvedValue('valid')
  await subscriptions.subscribe(input)
  read.mockResolvedValue(page(['new'], 'dingtalk-user/chat/cid_foreign/messages?page_size=50&page_token=evil'))
  expect(await subscriptions.check()).toMatchObject([{ received: 0, error: 'upstream_failed' }])
  expect(notify).not.toHaveBeenCalled()
})

it('retains a historical gap across successful polling and restart while continuing to receive new messages', async () => {
  await subscriptions.subscribe(input)
  read.mockResolvedValue(page(['only-new-after-recalls']))
  const [gap] = await subscriptions.check()
  expect(gap).toMatchObject({ received: 1, status: 'listening', historyGapAt: expect.any(String) })
  expect(gap).not.toHaveProperty('error')
  subscriptions = make()
  expect(await subscriptions.check()).toMatchObject([{ received: 1, status: 'listening', historyGapAt: gap!.historyGapAt }])
  read.mockResolvedValue(page(['later-message', 'only-new-after-recalls']))
  expect(await subscriptions.check()).toMatchObject([{ received: 2, status: 'listening', historyGapAt: gap!.historyGapAt }])
})

it('retains an unresolved historical gap when a temporary read error occurs and then recovers', async () => {
  await subscriptions.subscribe(input)
  read.mockResolvedValue(page(['after-gap']))
  const [gap] = await subscriptions.check()
  read.mockRejectedValue(new Error('temporary provider failure'))
  expect(await subscriptions.check()).toMatchObject([{ status: 'error', error: 'upstream_failed', historyGapAt: gap!.historyGapAt }])
  read.mockResolvedValue(page(['after-gap']))
  expect(await subscriptions.check()).toMatchObject([{ status: 'listening', historyGapAt: gap!.historyGapAt }])
  expect((await subscriptions.list())[0]).not.toHaveProperty('error')
})

it('preserves legacy history-gap records separately from new read errors', async () => {
  const item = await subscriptions.subscribe(input)
  const row = store.get(KV.dingtalkUser.subscriptions(item.id))!
  store.set(KV.dingtalkUser.subscriptions(item.id), { ...row, error: 'history_gap' })
  expect(await subscriptions.list()).toMatchObject([{ status: 'listening', historyGapAt: row.lastCheckedAt }])
  read.mockRejectedValue(new Error('temporary provider failure'))
  expect(await subscriptions.check()).toMatchObject([{ status: 'error', error: 'upstream_failed', historyGapAt: row.lastCheckedAt }])
  subscriptions = make(); read.mockResolvedValue(page(['baseline']))
  expect(await subscriptions.check()).toMatchObject([{ status: 'listening', historyGapAt: row.lastCheckedAt }])
})

it('suspends on expiry, bounds targets and rejects unsupported subscription input', async () => {
  await subscriptions.subscribe(input)
  read.mockRejectedValue(new DingTalkUserError('expired'))
  expect(await subscriptions.check()).toMatchObject([{ received: 0, error: 'expired' }])
  read.mockResolvedValue(page(['baseline']))
  for (let n = 1; n < 10; n++) {
    read.mockResolvedValue({ ...page([]), items: [message('baseline', senderId, `cid_${n}`)] })
    await subscriptions.subscribe({ ...input, chatId: `cid_${n}` })
  }
  await expect(subscriptions.subscribe({ ...input, chatId: 'cid_over_limit' })).rejects.toMatchObject({ code: 'subscription_limit' })
  await expect(subscriptions.subscribe({ ...input, chatId: '../secret' })).rejects.toThrow()
})

it('checks on start and every 30 seconds, with no new reads after shutdown', async () => {
  await subscriptions.subscribe(input)
  vi.useFakeTimers()
  try {
    subscriptions.start()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(read).toHaveBeenCalledTimes(3)
    lifetime.abort()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(read).toHaveBeenCalledTimes(3)
  } finally { vi.useRealTimers() }
})
