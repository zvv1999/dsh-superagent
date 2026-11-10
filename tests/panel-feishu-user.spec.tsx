// @vitest-environment jsdom
import { act } from 'react'
import { beforeEach, expect, it } from 'vitest'
import { zh } from '../src/client/locales.ts'
import { at, click, field, mount, text, type, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
beforeEach(() => { at({ page: 'settings', query: { group: 'source' } }) })

it('authorizes personal reads separately from bot sources and clears the secret without saving it in drafts or storage', async () => {
  const before = JSON.stringify(server.settings)
  await mount()
  expect(document.querySelector('[data-platform="feishu"]')?.textContent).toContain(zh.imPersonalTitle)
  await click(zh.imPersonalManage.replace('{name}', zh['imPlatform.feishu']))
  await type(field<HTMLInputElement>(zh.feishuUserAppId), 'cli_personal123456')
  await type(field<HTMLInputElement>(zh.feishuUserSecret), 'test-personal-secret')
  await click(zh.feishuUserAuthorize)
  expect(server.requests.filter(item => item.path.endsWith('feishu-user/authorize')).map(item => item.body))
    .toEqual([{ appId: 'cli_personal123456', secret: 'test-personal-secret' }])
  expect(JSON.stringify([sessionStorage, localStorage])).not.toContain('test-personal-secret')
  expect(document.querySelector('[role="dialog"] input[type="password"]')).toBeNull()
  expect(document.querySelector<HTMLAnchorElement>('[role="dialog"] a')?.href).toBe('https://accounts.feishu.cn/test-consent')
  expect(JSON.stringify(server.settings)).toBe(before)
})

it('keeps connected credentials out of the summary and discards an unfinished secret when management closes', async () => {
  Object.assign(server.feishuUser, { status: 'connected', configured: true, renewal: 'automatic', appId: 'cli_personal123456',
    user: { id: 'ou_owner', name: 'Owner' } })
  await mount()
  const opener = document.querySelector<HTMLButtonElement>(`button[aria-label="${zh.imPersonalManage.replace('{name}', zh['imPlatform.feishu'])}"]`)!
  opener.focus()
  await click(opener)
  expect(document.querySelector('input[type="password"]')).toBeNull()
  await click(zh.imReauthorize)
  await type(field<HTMLInputElement>(zh.feishuUserSecret), 'discard-on-close')
  await act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })) })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(document.activeElement).toBe(opener)
  await click(opener)
  await click(zh.imReauthorize)
  expect(field<HTMLInputElement>(zh.feishuUserSecret).value).toBe('')
  expect(JSON.stringify([sessionStorage, localStorage])).not.toContain('discard-on-close')
  expect(server.requests.filter(item => item.method !== 'GET')).toEqual([])
})

it('reauthorizes an expired saved application without echoing credentials or enabling the bot source', async () => {
  Object.assign(server.feishuUser, { status: 'expired', configured: true, renewal: 'reauthorize', appId: 'cli_personal123456',
    user: { id: 'ou_owner', name: 'Owner' }, expiresAt: '2026-11-10T02:00:00Z' })
  await mount()
  expect(text()).toContain(zh.imRenewalNeedsConsent)
  await click(zh.imPersonalManage.replace('{name}', zh['imPlatform.feishu']))
  await click(zh.imConnectionDetails)
  expect(text()).toContain(zh.feishuUserExpires)
  expect(text()).toContain(zh['feishuUserRenewal.reauthorize'])
  expect(text()).toContain('offline_access')
  expect(text()).not.toContain('本次授权到期')
  expect(field<HTMLInputElement>(zh.feishuUserSecret).value).toBe('')
  await click(zh.feishuUserUpgrade)
  expect(server.requests.find(item => item.path.endsWith('feishu-user/authorize'))?.body).toEqual({ appId: 'cli_personal123456' })
  expect(server.requests.some(item => item.path.includes('sources/feishu/connect') && item.method === 'POST')).toBe(false)
})

it('shows automatic renewal independently of the access-token expiry and verifies rotation without saving bot settings', async () => {
  Object.assign(server.feishuUser, { status: 'connected', configured: true, renewal: 'automatic', appId: 'cli_personal123456',
    expiresAt: '2026-11-10T02:00:00Z', refreshExpiresAt: '2026-11-17T02:00:00Z' })
  const before = JSON.stringify(server.settings)
  await mount()
  expect(text()).toContain(zh.imAutomaticRenewal)
  expect(document.querySelector('input[type="password"]')).toBeNull()
  expect(text()).not.toContain(zh.feishuUserExpires)
  await click(zh.imPersonalManage.replace('{name}', zh['imPlatform.feishu']))
  await click(zh.imConnectionDetails)
  expect(text()).toContain(zh['feishuUserRenewal.automatic'])
  expect(text()).toContain(zh.feishuUserRefreshExpires)
  await click(zh.feishuUserRefresh)
  expect(text()).toContain(zh.feishuUserRefreshed)
  expect(server.requests.filter(item => item.method !== 'GET')).toEqual([
    expect.objectContaining({ path: 'connections/feishu-user/refresh', body: {} })])
  expect(JSON.stringify(server.settings)).toBe(before)
})
