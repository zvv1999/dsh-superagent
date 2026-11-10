// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { at, click, mount, text, type, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
beforeEach(() => { at({ page: 'settings', query: { group: 'source' } }) })

it('connects saved personal DingTalk reads independently of robot switches and task policy', async () => {
  const before = JSON.stringify(server.settings)
  await mount()
  expect(document.querySelector('[data-platform="dingtalk"]')?.textContent).toContain(zh.imPersonalTitle)
  await click(zh.imPersonalManage.replace('{name}', zh['imPlatform.dingtalk']))
  await click(zh.dingtalkUserReuse)
  expect(server.requests.find(item => item.path.endsWith('dingtalk-user/connect'))?.body).toEqual({ mode: 'saved' })
  expect(document.querySelector('#dt-source-dingtalk-user')?.textContent).toContain(zh['dingtalkUserStatus.connected'])
  expect(JSON.stringify(server.settings)).toBe(before)
  expect(server.requests.some(item => item.path.includes('sources/dingtalk/connect') && item.method === 'POST')).toBe(false)
})

it('shows consent only in the personal card and can cancel without losing an existing connection', async () => {
  Object.assign(server.dingtalkUser, { configured: true, status: 'connected', user: { id: 'owner', corpId: 'ding_corp', name: 'Owner' } })
  await mount()
  await click(zh.imPersonalManage.replace('{name}', zh['imPlatform.dingtalk']))
  await click(zh.dingtalkUserAuthorize)
  expect(document.querySelector<HTMLAnchorElement>('[role="dialog"] a')?.href).toBe('https://login.dingtalk.com/test-consent')
  await click(zh.cancel)
  expect(document.querySelector('#dt-source-dingtalk-user')?.textContent).toContain(zh['dingtalkUserStatus.connected'])
})

it('shows the selected subscription and lets the owner check or cancel it without changing task intake', async () => {
  const before = JSON.stringify(server.settings)
  server.dingtalkSubscriptions = [{ id: 'one', chatId: 'cid_one', name: 'Selected person', senderId: 'selected',
    status: 'listening', received: 3, pollSeconds: 30, startedAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(), messagesResource: 'dingtalk-user/chat/cid_one/messages' }]
  await mount()
  expect(text()).toContain('Selected person')
  expect(text()).toContain(zh['dingtalkSubscriptionStatus.listening'])
  await click(zh.dingtalkSubscriptionCheck)
  expect(server.requests.some(item => item.path === 'connections/dingtalk-user/subscriptions/one/check')).toBe(true)
  await click(zh.imPersonalManage.replace('{name}', zh['imPlatform.dingtalk']))
  await click(zh.dingtalkSubscriptionCancel)
  expect(text()).not.toContain('Selected person')
  expect(server.dingtalkSubscriptions).toEqual([])
  expect(JSON.stringify(server.settings)).toBe(before)
})

it('shows an unresolved historical gap even while the selected subscription is receiving messages', async () => {
  server.dingtalkSubscriptions = [{ id: 'one', chatId: 'cid_one', name: 'Selected person',
    status: 'listening', received: 3, pollSeconds: 30, startedAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(), historyGapAt: new Date().toISOString(),
    messagesResource: 'dingtalk-user/chat/cid_one/messages' }]
  await mount()
  const subscription = document.querySelector('.dt-subscription')!
  expect(subscription.textContent).toContain(zh['dingtalkSubscriptionStatus.listening'])
  expect(subscription.textContent).toContain(zh.dingtalkSubscriptionHistoryGap)
  expect(subscription.querySelector('[role="alert"]')).not.toBeNull()
})

it('lets the owner choose and subscribe to personal group messages without any robot plugin or task-source changes', async () => {
  server.kinds = server.kinds.filter(kind => kind.kind !== 'dingtalk')
  Object.assign(server.dingtalkUser, { configured: true, status: 'connected', user: { id: 'owner', corpId: 'ding_corp', name: 'Owner' } })
  server.dingtalkJoining = { labels: { cid_project: '我的项目群', cid_other: '另一个群' }, complete: false, scanned: 100, pages: 1 }
  const before = structuredClone(server.settings)
  await mount(); await click(zh.imPersonalManage.replace('{name}', zh['imPlatform.dingtalk']))
  expect(text()).toContain('无需添加机器人')
  const picker = () => document.querySelector<HTMLSelectElement>('select[aria-label="选择要订阅读取的群"]')!
  expect(picker().disabled).toBe(true)
  await click(zh.dingtalkGroupRefresh)
  expect(picker().disabled).toBe(false)
  expect(text()).toContain('列表可能不完整')
  await type(picker(), 'cid_project')
  expect(server.dingtalkSubscriptions).toEqual([])
  expect(server.requests.filter(item => item.method === 'POST').map(item => item.path)).toEqual(['connections/dingtalk-user/groups/refresh'])
  await click(zh.dingtalkGroupSubscribe)
  expect(server.requests.find(item => item.path === 'connections/dingtalk-user/subscriptions' && item.method === 'POST')?.body)
    .toEqual({ chatId: 'cid_project', name: '我的项目群' })
  expect(server.dingtalkSubscriptions).toMatchObject([{ chatId: 'cid_project', name: '我的项目群', status: 'listening' }])
  expect([...picker().options].some(option => option.value === 'cid_project')).toBe(false)
  expect(server.settings).toEqual(before)
  expect(server.requests.some(item => item.method === 'PUT' || (item.method === 'POST' && item.path.startsWith('sources/')))).toBe(false)
})

it('excludes full-chat subscriptions, keeps sender-restricted chats selectable and preserves selection on refresh failure', async () => {
  Object.assign(server.dingtalkUser, { configured: true, status: 'connected' })
  server.dingtalkGroups = { labels: { cid_full: '已订阅群', cid_filtered: '按人订阅群', cid_suspended: '其他账号的旧订阅' }, complete: true, scanned: 3, pages: 1 }
  const base = { status: 'listening' as const, received: 0, pollSeconds: 30, startedAt: '', lastCheckedAt: '', messagesResource: '' }
  server.dingtalkSubscriptions = [{ ...base, id: 'full', chatId: 'cid_full', name: '已订阅群' },
    { ...base, id: 'filtered', chatId: 'cid_filtered', name: '按人订阅群', senderId: 'selected-person' },
    { ...base, id: 'suspended', chatId: 'cid_suspended', name: '其他账号的旧订阅', status: 'suspended' }]
  await mount(); await click(zh.imPersonalManage.replace('{name}', zh['imPlatform.dingtalk']))
  const picker = document.querySelector<HTMLSelectElement>('select[aria-label="选择要订阅读取的群"]')!
  expect([...picker.options].map(option => option.value).sort()).toEqual(['', 'cid_filtered', 'cid_suspended'])
  await type(picker, 'cid_filtered')
  server.joinError = 'DingTalk user connection: upstream_failed'
  await click(zh.dingtalkGroupRefresh)
  expect(picker.value).toBe('cid_filtered')
  expect(server.requests.some(item => item.method === 'POST' && item.path === 'connections/dingtalk-user/subscriptions')).toBe(false)
})
