// @vitest-environment jsdom
/** WeChat onboarding through the real settings panel and typed fake management API. */
import { beforeEach, expect, it } from 'vitest'
import { ImSource } from '../src/sources/im.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { zh } from '../src/client/locales.ts'
import { at, click, field, find, mount, remount, text, type, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
beforeEach(() => {
  server.kinds.push(new ImSource('wechat', { connect: async () => { throw new Error('Panel tests must not connect to WeChat') } }).kind as unknown as SourceKind)
  server.settings.sources.wechat = { enabled: false, config: { accountId: '', credentialsFile: '', directMessages: true, chats: [] } }
  at({ page: 'settings', query: { group: 'source' } })
})
const request = (suffix: string) => server.requests.filter(item => item.method === 'POST' && item.path.endsWith(suffix))
const qr = () => document.querySelector('svg[aria-label="用手机微信扫描此二维码"]')

it('starts from one button and renders the QR locally without requiring account fields', async () => {
  await mount()
  expect(text()).not.toContain('私有凭证文件路径')
  expect(server.requests.some(item => item.method === 'POST' && item.path.includes('/login'))).toBe(false)
  await click(zh.wechatStart)
  expect(request('sources/wechat/login')[0]?.body).toEqual({ enable: true, replace: false, sourceRevision: 0, policyRevision: 3 })
  expect(qr()?.querySelector('path')?.getAttribute('d')).toContain('M')
  expect(document.querySelector('img')).toBeNull()
  expect(text()).toContain(zh.wechatStepConfirm)
  expect(text()).not.toContain('liteapp.weixin.qq.com')
  expect(JSON.stringify(sessionStorage)).not.toContain('liteapp.weixin.qq.com')
})

it('restores an in-progress scan after refresh without starting another login', async () => {
  await mount(); await click(zh.wechatStart)
  server.wechatLogin = { ...server.wechatLogin!, status: 'scanned' }
  await remount()
  expect(text()).toContain(zh['wechatStatus.scanned'])
  expect(qr()).not.toBeNull()
  expect(request('sources/wechat/login')).toHaveLength(1)
})

it('cancels the previous QR before refreshing and leaves account settings untouched on cancellation', async () => {
  await mount(); await click(zh.wechatStart)
  const original = structuredClone(server.settings.sources.wechat)
  await click(zh.wechatRefreshQr)
  expect(request('login-1/cancel')).toHaveLength(1)
  expect(server.wechatLogin?.id).toBe('login-2')
  await click(zh.cancel)
  expect(qr()).toBeNull()
  expect(text()).toContain(zh.wechatCancelled)
  expect(server.settings.sources.wechat).toEqual(original)
})

it('removes an expired QR and offers a fresh login', async () => {
  server.wechatLogin = { id: 'expired', status: 'expired', qrUrl: 'https://liteapp.weixin.qq.com/q/expired', expiresAt: new Date(0).toISOString() }
  await mount()
  expect(qr()).toBeNull()
  expect(text()).toContain(zh.wechatExpired)
  await click(zh.wechatRetry)
  expect(qr()).not.toBeNull()
  expect(server.wechatLogin?.id).toBe('login-1')
})

it('accepts a verification code on the panel and clears it after submission', async () => {
  server.wechatLogin = { id: 'verify', status: 'verification', expiresAt: new Date(Date.now() + 60000).toISOString() }
  await mount()
  const input = field<HTMLInputElement>(zh.wechatCode)
  await type(input, '123456')
  await click(zh.wechatVerify)
  expect(request('verify/verify')[0]?.body).toEqual({ code: '123456' })
  expect(document.querySelector('#dt-wechat-code')).toBeNull()
  expect(JSON.stringify(sessionStorage)).not.toContain('123456')
  expect(text()).toContain(zh['wechatStatus.scanned'])
})

it('shows a ready-to-send example after confirmation without another settings save', async () => {
  await mount(); await click(zh.wechatStart)
  server.settings.sources.wechat = { enabled: true, config: { accountId: 'bot-1', credentialsFile: '/private/wechat.json', directMessages: true, chats: [] } }
  server.settings.policy.sources.wechat = { allowed: [{ id: 'scanner' }], admission: {} }
  server.revisions['source:wechat'] = 1; server.revisions.policy = 4
  server.wechatLogin = { ...server.wechatLogin!, status: 'connected', accountId: 'bot-1', userId: 'scanner', enabled: true }
  await remount()
  expect(qr()).toBeNull()
  expect(text()).toContain(zh.wechatBound)
  expect(text()).toContain(`/superagent ${zh.wechatExample}`)
  expect(server.requests.filter(item => item.method === 'PUT')).toEqual([])
  expect(text()).not.toContain('/private/wechat.json')
})

it('requires a specific account replacement confirmation and allows opting out of enabling', async () => {
  server.settings.sources.wechat = { enabled: false, config: { accountId: 'old-bot', credentialsFile: '/private/old.json', directMessages: true, chats: [] } }
  await mount(); await click(zh.wechatEnableAfter); await click(zh.wechatReconnect)
  expect(request('sources/wechat/login')).toHaveLength(0)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(zh.wechatReplaceHint)
  await click(zh.wechatContinue)
  expect(request('sources/wechat/login')[0]?.body).toMatchObject({ replace: true, enable: false })
  expect(server.settings.sources.wechat?.config.accountId).toBe('old-bot')
})

it('keeps explicit local errors visible and prevents login over unsaved source changes', async () => {
  server.wechatLogin = { id: 'failed', status: 'error', error: 'settings_conflict', expiresAt: new Date().toISOString() }
  await mount()
  expect(text()).toContain(zh['wechatError.settings_conflict'])
  expect(qr()).toBeNull()
  const card = document.querySelector('#dt-source-wechat')!
  await click(card.querySelector<HTMLElement>('[role="switch"]')!)
  expect(text()).toContain(zh.wechatUnsaved)
  expect((find(zh.wechatRetry) as HTMLButtonElement).disabled).toBe(true)
})
