// @vitest-environment jsdom
/** Managed CLI onboarding through the real panel; all platform and installation activity is a typed fake. */
import { act } from 'react'
import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { ImSource } from '../src/sources/im.ts'
import type { SourceKind } from '../src/sources/kind.ts'
import { zh, en } from '../src/client/locales.ts'
import { at, click, field, find, mount as mountPanel, remount as remountPanel, settle, text, type, usePanel } from './fixtures/panel.tsx'
import { server } from './fixtures/panel-server.ts'

usePanel()
beforeEach(() => {
  server.kinds.push(new ImSource('dingtalk', { connect: async () => { throw new Error('Panel tests must not connect to DingTalk') } }).kind as unknown as SourceKind)
  server.settings.sources.dingtalk = { enabled: false, config: { accountId: '', credentialsFile: '', directMessages: true, chats: [] } }
  at({ page: 'settings', query: { group: 'source' } })
})
const posts = (suffix: string) => server.requests.filter(item => item.method === 'POST' && item.path.endsWith(suffix))
const ding = () => server.cliConnect.dingtalk
const feishu = () => server.cliConnect.feishu
const qr = () => document.querySelector('.dt-cli-connect svg[role="img"]')
const privateStorage = () => JSON.stringify([sessionStorage, localStorage])
const openBotConnections = async (english = false) => {
  const dictionary = english ? en : zh
  for (const platform of ['feishu', 'dingtalk'] as const) {
    const label = dictionary.imBotManageLabel.replace('{name}', dictionary[`imPlatform.${platform}`])
    const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    if (button?.getAttribute('aria-expanded') === 'false') await click(button)
  }
}
const mount = async (dictionary = zh) => { await mountPanel(dictionary); await openBotConnections(dictionary === en) }
const remount = async (dictionary = zh) => { await remountPanel(dictionary); await openBotConnections(dictionary === en) }
const review = (platform: 'feishu' | 'dingtalk' = 'dingtalk') => Object.assign(server.cliConnect[platform], {
  id: 'review-session', status: 'review', canConfirm: true, selectedApp: { id: 'app-second', name: 'Chosen Bot', clientId: 'client-second' },
  checks: [{ id: 'identity', state: 'passed' }, { id: 'receive', state: 'action' }, { id: 'published', state: 'unknown' }],
  platformUrl: 'https://example.test/app/settings',
})
const ticking = () => { vi.useFakeTimers({ shouldAdvanceTime: true }); onTestFinished(() => { vi.useRealTimers() }) }
const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(1600) }); await settle() }

it('starts Feishu quick setup with revisions and waits for installation without terminal instructions', async () => {
  await mount()
  expect(text()).not.toContain('机器人的 lark-cli')
  expect(text()).not.toContain('私有凭证文件路径')
  await click(zh.cliFeishuStart)
  expect(posts('sources/feishu/connect')[0]?.body).toEqual({ mode: 'quick', enable: true, replace: false, sourceRevision: 0, policyRevision: 3 })
  expect(text()).toContain(zh['cliStatus.installing'])
  expect(text()).not.toContain('npm install')
  expect(qr()).toBeNull()
})

it.each(['feishu', 'dingtalk'] as const)('connects %s after an enable-only draft and rebases onto the saved connection', async platform => {
  ticking()
  server.settings.sources[platform]!.enabled = false
  server.cliConnect[platform].enabled = false
  await mount()
  const card = document.getElementById(`dt-source-${platform}`)!
  await click(card.querySelector<HTMLElement>('[role="switch"]')!)
  const manual = [...card.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === zh.cliManual)!
  expect(manual.disabled).toBe(false)
  await click(manual)
  expect(posts(`sources/${platform}/connect`)[0]?.body).toEqual({ mode: 'manual', enable: true, replace: false, sourceRevision: 0, policyRevision: 3 })
  review(platform); await tick()
  await click(zh.cliConfirm)
  expect(posts('review-session/confirm')[0]?.body).toEqual({ enable: true, sourceRevision: 0, policyRevision: 3 })
  expect(server.settings.sources[platform]!.enabled).toBe(true)
  expect(card.querySelector('.dt-savebar')).toBeNull()
  expect(card.querySelector<HTMLElement>('[role="switch"]')?.getAttribute('aria-checked')).toBe('true')
})

it('lets connection review override an enable draft without restoring it after confirmation', async () => {
  ticking()
  await mount()
  const card = document.getElementById('dt-source-dingtalk')!
  await click(card.querySelector<HTMLElement>('[role="switch"]')!)
  review(); await tick()
  await click(zh.cliEnableAfter)
  await click(zh.cliConfirm)
  expect(posts('review-session/confirm')[0]?.body).toMatchObject({ enable: false })
  expect(server.settings.sources.dingtalk!.enabled).toBe(false)
  expect(card.querySelector('.dt-savebar')).toBeNull()
})

it('blocks pairing while an enable change is unsaved even though reconnect remains available', async () => {
  Object.assign(ding(), { configured: true, enabled: true })
  server.settings.sources.dingtalk!.enabled = true
  await mount()
  const card = document.getElementById('dt-source-dingtalk')!
  await click(card.querySelector<HTMLElement>('[role="switch"]')!)
  expect((find(zh.cliPair) as HTMLButtonElement).disabled).toBe(true)
  expect([...card.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === zh.cliReconnect)?.disabled).toBe(false)
  expect(posts('sources/dingtalk/pair')).toHaveLength(0)
})

it('keeps onboarding blocked for unsaved changes within a group receive row', async () => {
  await mount()
  const card = document.getElementById('dt-source-feishu')!
  await type(card.querySelector('select[aria-label="接收"]')!, 'all')
  expect((find(zh.cliFeishuStart) as HTMLButtonElement).disabled).toBe(true)
  expect(posts('sources/feishu/connect')).toHaveLength(0)
})

it.each(['idle', 'error', 'expired', 'cancelled'] as const)('prioritizes resuming saved Feishu authorization from %s', async status => {
  Object.assign(feishu(), { status, canResume: true, apps: [{ id: 'test-saved-app', name: 'Saved Bot' }] })
  await mount()
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('#dt-source-feishu .dt-cli-connect button')]
  expect(buttons.slice(0, 3).map(button => button.textContent)).toEqual([zh.cliResume, zh.cliFeishuCreateNew, zh.cliManual])
  expect(buttons[0]?.className).toContain('dt-btn-primary')
  expect(text()).toContain(zh.cliResumeHint)
  await click(zh.cliResume)
  expect(posts('sources/feishu/connect').map(request => request.body)).toEqual([
    { mode: 'resume', enable: true, replace: false, sourceRevision: 0, policyRevision: 3 },
  ])
  expect(text()).toContain('Saved Bot')
  expect((find(zh.cliUseApp) as HTMLButtonElement).disabled).toBe(true)
  expect(qr()).toBeNull()
})

it('resumes the saved app and rechecks a platform policy denial without rescanning or allowing confirmation', async () => {
  ticking()
  Object.assign(feishu(), { canResume: true, apps: [{ id: 'test-saved-app', name: 'Saved Bot' }] })
  await mount(); await click(zh.cliResume)
  await click(document.querySelector<HTMLInputElement>('input[value="test-saved-app"]')!)
  await click(zh.cliUseApp)
  expect(posts('connect-1/select')[0]?.body).toEqual({ appId: 'test-saved-app' })
  Object.assign(feishu(), { status: 'review', error: 'platform_policy_denied', canConfirm: false,
    platformUrl: 'https://example.test/data-security', checks: [{ id: 'bot', state: 'action' }] })
  await tick()
  expect(text()).toContain(zh['cliError.platform_policy_denied'])
  expect(text()).not.toContain(zh['cliError.invalid_credentials'])
  expect(find(zh.cliPlatformSettings).getAttribute('href')).toBe('https://example.test/data-security')
  expect((find(zh.cliConfirm) as HTMLButtonElement).disabled).toBe(true)
  expect((find(zh.cliRecheck) as HTMLButtonElement).disabled).toBe(false)
  expect(qr()).toBeNull()
  await click(zh.cliConfirm)
  expect(posts('connect-1/confirm')).toHaveLength(0)
  await remount(en)
  expect(text()).toContain(en['cliError.platform_policy_denied'])
  await click(en.cliRecheck)
  expect(posts('connect-1/check')).toHaveLength(1)
  expect(posts('sources/feishu/connect')).toHaveLength(1)
  expect(qr()).toBeNull()
  expect(text()).not.toContain(en['cliStatus.waiting'])
})

it('keeps a resumed app fixed if credentials are requested and hides resume for configured sources', async () => {
  Object.assign(feishu(), { id: 'resumed', mode: 'resume', status: 'credentials', canResume: true,
    selectedApp: { id: 'test-saved-app', name: 'Saved Bot' } })
  await mount()
  expect(field<HTMLInputElement>(zh.cliAppId).value).toBe('test-saved-app')
  expect(field<HTMLInputElement>(zh.cliAppId).readOnly).toBe(true)
  expect(text()).not.toContain(zh.cliResume)
  await type(field<HTMLInputElement>(zh.cliSecret), 'test-resume-secret')
  await click(zh.cliSubmitCredentials)
  expect(posts('resumed/credentials')[0]?.body).toEqual({ appId: 'test-saved-app', secret: 'test-resume-secret' })
  expect(privateStorage()).not.toContain('test-resume-secret')
  Object.assign(feishu(), { id: null, mode: undefined, status: 'idle', configured: true })
  await remount()
  expect(text()).not.toContain(zh.cliResume)
})

it('polls device authorization and renders its QR locally with an official link and device code', async () => {
  ticking()
  await mount(); await click(zh.cliDingtalkStart)
  Object.assign(ding(), { status: 'waiting', challenge: { url: 'https://example.test/authorize', userCode: 'TEST-DEVICE', expiresAt: new Date(Date.now() + 60000).toISOString() } })
  await tick()
  expect(text()).toContain(zh['cliStatus.waiting'])
  expect(text()).toContain('TEST-DEVICE')
  expect(find(zh.cliAuthorize).getAttribute('href')).toBe('https://example.test/authorize')
  expect(qr()?.querySelector('rect')?.getAttribute('fill')).toBe('#fff')
  expect(qr()?.querySelector('path')?.getAttribute('fill')).toBe('#000')
  expect(document.querySelector('.dt-cli-connect img')).toBeNull()
  expect(privateStorage()).not.toContain('TEST-DEVICE')
  await remount()
  expect(text()).toContain('TEST-DEVICE')
  expect(posts('sources/dingtalk/connect')).toHaveLength(1)
})

it('requires an explicit application choice and submits the chosen bot rather than the first one', async () => {
  Object.assign(ding(), { id: 'choose', status: 'select_app', apps: [{ id: 'first', name: 'First Bot' }, { id: 'second', name: 'Second Bot' }] })
  await mount()
  expect((find(zh.cliUseApp) as HTMLButtonElement).disabled).toBe(true)
  expect(document.querySelector('input[type="radio"]:checked')).toBeNull()
  await click(document.querySelector<HTMLInputElement>('input[value="second"]')!)
  await click(zh.cliUseApp)
  expect(posts('choose/select')[0]?.body).toEqual({ appId: 'second' })
  expect(ding().selectedApp?.id).toBe('second')
  expect(text()).toContain(zh['cliStatus.checking'])
})

it('locks DingTalk credentials to the selected app and clears the secret even when submission fails', async () => {
  Object.assign(ding(), { id: 'credentials', status: 'credentials', selectedApp: { id: 'chosen-app', name: 'Chosen Bot', clientId: 'chosen-client' } })
  server.cliCredentialsError = true
  await mount()
  expect(field<HTMLInputElement>(zh.cliAppId).readOnly).toBe(true)
  expect(field<HTMLInputElement>(zh.cliClientId).value).toBe('chosen-client')
  const input = field<HTMLInputElement>(zh.cliSecret)
  expect(input.type).toBe('password')
  expect(input.value).toBe('')
  await type(input, 'ephemeral-test-secret')
  expect(privateStorage()).not.toContain('ephemeral-test-secret')
  await click(zh.cliSubmitCredentials)
  expect(posts('credentials/credentials')[0]?.body).toEqual({ appId: 'chosen-app', clientId: 'chosen-client', secret: 'ephemeral-test-secret' })
  expect(field<HTMLInputElement>(zh.cliSecret).value).toBe('')
  expect(privateStorage()).not.toContain('ephemeral-test-secret')
  await type(field<HTMLInputElement>(zh.cliSecret), 'discard-on-refresh')
  await remount()
  expect(field<HTMLInputElement>(zh.cliSecret).value).toBe('')
  await type(field<HTMLInputElement>(zh.cliSecret), 'discard-on-cancel')
  await click(zh.cancel)
  expect(document.querySelector('.dt-cli-connect input[type="password"]')).toBeNull()
  expect(privateStorage()).not.toContain('discard-on-cancel')
})

it('supports connecting an existing Feishu app without starting quick creation', async () => {
  await mount(); await click(zh.cliManual)
  expect(posts('sources/feishu/connect')[0]?.body).toMatchObject({ mode: 'manual' })
  await type(field<HTMLInputElement>(zh.cliAppId), 'test-existing-app')
  await type(field<HTMLInputElement>(zh.cliSecret), 'test-existing-secret')
  await click(zh.cliSubmitCredentials)
  expect(posts('connect-1/credentials')[0]?.body).toEqual({ appId: 'test-existing-app', secret: 'test-existing-secret' })
  expect(document.querySelector('.dt-cli-connect input[type="password"]')).toBeNull()
  expect(privateStorage()).not.toContain('test-existing-secret')
})

it('connects DingTalk with bot credentials after personal authorization is unavailable', async () => {
  Object.assign(ding(), { id: 'unavailable-auth', status: 'error', error: 'authorization_failed' })
  await mount()
  const manual = [...document.querySelectorAll<HTMLButtonElement>('#dt-source-dingtalk button')].find(button => button.textContent === zh.cliManual)!
  await click(manual)
  expect(posts('sources/dingtalk/connect')[0]?.body).toMatchObject({ mode: 'manual' })
  expect(qr()).toBeNull()
  expect(field<HTMLInputElement>(zh.cliDingtalkClientId).readOnly).toBe(false)
  expect(text()).not.toContain(zh.cliClientId)
  await type(field<HTMLInputElement>(zh.cliDingtalkClientId), 'test-direct-client')
  await type(field<HTMLInputElement>(zh.cliSecret), 'test-direct-secret')
  await click(zh.cliSubmitCredentials)
  expect(posts('connect-1/credentials')[0]?.body).toEqual({ appId: 'test-direct-client', secret: 'test-direct-secret' })
  expect(posts('connect-1/select')).toHaveLength(0)
  expect(text()).toContain(zh['cliStatus.checking'])
  expect(privateStorage()).not.toContain('test-direct-secret')
})

it('corrects a rejected manual Client ID and secret in the same session without persisting either secret', async () => {
  server.cliCredentialsError = true
  await mount()
  await click([...document.querySelectorAll<HTMLButtonElement>('#dt-source-dingtalk button')].find(button => button.textContent === zh.cliManual)!)
  await type(field<HTMLInputElement>(zh.cliDingtalkClientId), 'test-wrong-client')
  await type(field<HTMLInputElement>(zh.cliSecret), 'test-wrong-secret')
  await click(zh.cliSubmitCredentials)
  expect(text()).toContain(zh['cliError.invalid_credentials'])
  expect(field<HTMLInputElement>(zh.cliSecret).value).toBe('')
  expect(field<HTMLInputElement>(zh.cliDingtalkClientId).readOnly).toBe(false)
  expect(text()).not.toContain(zh.cliClientId)
  expect(ding().selectedApp?.id).toBe('test-wrong-client')
  await remount()
  expect(field<HTMLInputElement>(zh.cliDingtalkClientId).value).toBe('test-wrong-client')
  expect(field<HTMLInputElement>(zh.cliSecret).value).toBe('')
  await type(field<HTMLInputElement>(zh.cliDingtalkClientId), '')
  await type(field<HTMLInputElement>(zh.cliSecret), 'test-corrected-secret')
  expect((find(zh.cliSubmitCredentials) as HTMLButtonElement).disabled).toBe(true)
  await type(field<HTMLInputElement>(zh.cliDingtalkClientId), 'test-corrected-client')
  server.cliCredentialsError = false
  await click(zh.cliSubmitCredentials)
  expect(posts('connect-1/credentials').map(request => request.body)).toEqual([
    { appId: 'test-wrong-client', secret: 'test-wrong-secret' },
    { appId: 'test-corrected-client', secret: 'test-corrected-secret' },
  ])
  expect(posts('sources/dingtalk/connect')).toHaveLength(1)
  expect(text()).not.toContain(zh['cliError.invalid_credentials'])
  expect(text()).toContain(zh['cliStatus.checking'])
  expect(document.querySelector('.dt-cli-connect input[type="password"]')).toBeNull()
  expect(privateStorage()).not.toContain('test-wrong-secret')
  expect(privateStorage()).not.toContain('test-corrected-secret')
})

it('keeps an unready bot in review for platform fixes and rechecking without allowing confirmation', async () => {
  ticking(); review()
  Object.assign(ding(), { error: 'permission_required', canConfirm: false })
  await mount()
  expect(text()).toContain(zh['cliError.permission_required'])
  expect(find(zh.cliPlatformSettings).getAttribute('href')).toBe('https://example.test/app/settings')
  expect((find(zh.cliConfirm) as HTMLButtonElement).disabled).toBe(true)
  expect((find(zh.cliRecheck) as HTMLButtonElement).disabled).toBe(false)
  await click(zh.cliConfirm)
  expect(posts('review-session/confirm')).toHaveLength(0)
  await click(zh.cliRecheck)
  expect(posts('review-session/check')).toHaveLength(1)
  Object.assign(ding(), { status: 'review', error: undefined, canConfirm: true })
  await tick()
  expect(text()).not.toContain(zh['cliError.permission_required'])
  expect((find(zh.cliConfirm) as HTMLButtonElement).disabled).toBe(false)
  expect(posts('sources/dingtalk/connect')).toHaveLength(0)
})

it('requires saving enabled direct messages before offering a private pairing command', async () => {
  Object.assign(ding(), { configured: true, enabled: true })
  Object.assign(server.settings.sources.dingtalk!, { enabled: true })
  server.settings.sources.dingtalk!.config.directMessages = false
  await mount()
  expect(text()).toContain(zh.cliPairDirectMessagesOff)
  expect((find(zh.cliPair) as HTMLButtonElement).disabled).toBe(true)
  await click(zh.cliPair)
  expect(posts('sources/dingtalk/pair')).toHaveLength(0)
  const card = document.getElementById('dt-source-dingtalk')!
  await click(card.querySelector<HTMLElement>('[role="switch"][aria-label="接收私聊"]')!)
  expect((find(zh.cliPair) as HTMLButtonElement).disabled).toBe(true)
  await act(async () => { card.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }); await settle()
  expect(text()).not.toContain(zh.cliPairDirectMessagesOff)
  expect((find(zh.cliPair) as HTMLButtonElement).disabled).toBe(false)
  await click(zh.cliPair)
  expect(posts('sources/dingtalk/pair')[0]?.body).toEqual({ sourceRevision: 1, policyRevision: 3 })
  expect(text()).toContain('/superagent pair')
})

it('distinguishes missing and unknown checks, links platform settings, and rechecks on request', async () => {
  review()
  await mount()
  const rows = [...document.querySelectorAll('.dt-cli-check')].map(row => row.textContent)
  expect(rows).toEqual([`${zh['cliCheck.identity']}${zh['cliCheckState.passed']}`, `${zh['cliCheck.receive']}${zh['cliCheckState.action']}`, `${zh['cliCheck.published']}${zh['cliCheckState.unknown']}`])
  expect(text()).toContain(zh.cliPermissionsHint)
  expect(find(zh.cliPlatformSettings).getAttribute('href')).toBe('https://example.test/app/settings')
  expect(text()).not.toContain(zh.cliPaired)
  await click(zh.cliRecheck)
  expect(posts('review-session/check')).toHaveLength(1)
  expect(text()).toContain(zh['cliStatus.checking'])
})

it('confirms with both revisions, reloads settings, and pairs only by sending the private command', async () => {
  ticking(); review()
  const clipboard = vi.fn(async () => {})
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: clipboard }, configurable: true })
  await mount(); await click(zh.cliConfirm)
  expect(posts('review-session/confirm')[0]?.body).toEqual({ enable: true, sourceRevision: 0, policyRevision: 3 })
  expect(text()).toContain(zh.cliConfigured)
  expect(text()).not.toContain(zh.cliPaired)
  await click(zh.cliPair)
  expect(posts('sources/dingtalk/pair')[0]?.body).toEqual({ sourceRevision: 1, policyRevision: 3 })
  const command = ding().pairing!.command!
  expect(text()).toContain(command)
  expect(privateStorage()).not.toContain(command)
  await click(zh.cliCopyCommand)
  expect(clipboard).toHaveBeenCalledWith(command)
  expect(ding().allowed).toBe(false)
  ding().pairing = { ...ding().pairing!, status: 'paired', userId: 'actual-sender', command: undefined }
  ding().allowed = true
  server.revisions.policy = 4
  await tick()
  expect(text()).toContain(zh.cliPaired)
  expect(text()).not.toContain(command)
  expect(posts('sources/dingtalk/pair')).toHaveLength(1)
})

it('clears a cancelled pairing command and allows requesting a new one', async () => {
  Object.assign(ding(), { configured: true, enabled: true })
  await mount(); await click(zh.cliPair)
  const command = ding().pairing!.command!
  await click(zh.cancel)
  expect(text()).not.toContain(command)
  expect(text()).toContain(zh['cliPair.cancelled'])
  await click(zh.cliPair)
  expect(ding().pairing!.command).not.toBe(command)
  expect(privateStorage()).not.toContain('/superagent pair')
})

it('recovers after Feishu saving restarts the host and completes with a null session id', async () => {
  ticking(); review('feishu'); server.cliConfirmRestart = true
  await mount(); await click(zh.cliConfirm)
  expect(text()).toContain(zh.cliRecovering)
  Object.assign(feishu(), { id: null, status: 'idle', configured: true, enabled: true })
  server.down = false
  await tick()
  expect(text()).toContain(zh.cliConfigured)
  expect(text()).not.toContain(zh.cliRecovering)
  expect(find(zh.cliPair)).toBeDefined()
  await click(zh.cliPair)
  expect(posts('sources/feishu/pair')[0]?.body).toEqual({ sourceRevision: 1, policyRevision: 3 })
})

it('keeps disabled saved sources out of pairing until the source is enabled', async () => {
  review()
  await mount(); await click(zh.cliEnableAfter); await click(zh.cliConfirm)
  expect(posts('review-session/confirm')[0]?.body).toMatchObject({ enable: false })
  expect(text()).toContain(zh.cliSavedOff)
  expect(text()).not.toContain(zh.cliPair)
  expect(text()).not.toContain(zh.cliPaired)
})

it('requires a concrete replacement confirmation and respects dirty source drafts', async () => {
  Object.assign(feishu(), { configured: true, enabled: false })
  await mount(); await click(zh.cliReconnect)
  expect(posts('sources/feishu/connect')).toHaveLength(0)
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('保存时会替换当前机器人的连接配置')
  await click(zh.cliReplaceConfirm)
  expect(posts('sources/feishu/connect')[0]?.body).toMatchObject({ replace: true })
  await click(zh.cancel)
  await click(document.querySelector<HTMLElement>('#dt-source-feishu [role="switch"][aria-label="接收私聊"]')!)
  expect(text()).toContain(zh.cliUnsaved)
  expect((find(zh.cliReconnect) as HTMLButtonElement).disabled).toBe(true)
})

it('hides expired challenges and retries with fresh authorization', async () => {
  Object.assign(ding(), { id: 'expired', status: 'expired', challenge: { url: 'https://example.test/expired', userCode: 'OLD-CODE' } })
  await mount()
  expect(text()).toContain(zh['cliStatus.expired'])
  expect(text()).not.toContain('OLD-CODE')
  expect(qr()).toBeNull()
  await click(zh.cliRetry)
  expect(ding().id).toBe('connect-1')
  expect(text()).toContain(zh['cliStatus.installing'])
})

it('shows a stable authorization error and retries without exposing old challenges', async () => {
  Object.assign(ding(), { id: 'failed', status: 'error', error: 'authorization_failed', challenge: { url: 'https://example.test/stale', userCode: 'STALE-CODE' } })
  await mount()
  expect(text()).toContain(zh['cliError.authorization_failed'])
  expect(text()).not.toContain('STALE-CODE')
  expect(qr()).toBeNull()
  await click(zh.cliRetry)
  expect(text()).toContain(zh['cliStatus.installing'])
  expect(text()).not.toContain(zh['cliError.authorization_failed'])
})

it('prevents confirmation over unsaved edits while retaining cancellation', async () => {
  review()
  await mount()
  await click(document.querySelector<HTMLElement>('#dt-source-dingtalk [role="switch"][aria-label="接收私聊"]')!)
  expect((find(zh.cliConfirm) as HTMLButtonElement).disabled).toBe(true)
  expect(posts('review-session/confirm')).toHaveLength(0)
  await click(zh.cancel)
  expect(posts('review-session/cancel')).toHaveLength(1)
  expect(text()).toContain(zh['cliStatus.cancelled'])
})

it('finishes replacing a configured Feishu bot when a restart discards the new session', async () => {
  ticking()
  Object.assign(feishu(), { configured: true, enabled: true })
  await mount(); await click(zh.cliReconnect); await click(zh.cliReplaceConfirm)
  review('feishu')
  await tick()
  server.cliConfirmRestart = true
  await click(zh.cliConfirm)
  Object.assign(feishu(), { id: null, status: 'idle', configured: true, enabled: true })
  server.down = false
  await tick()
  expect(text()).not.toContain(zh.cliRecovering)
  expect(find(zh.cliPair)).toBeDefined()
})

it('renders the managed onboarding and permission checks in English', async () => {
  review()
  await mount(en)
  expect(text()).toContain(en.cliPermissionsHint)
  expect(text()).toContain(en['cliCheckState.unknown'])
  expect(find(en.cliConfirm)).toBeDefined()
  expect(text()).not.toContain('cliStatus.')
})
