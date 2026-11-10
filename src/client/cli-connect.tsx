/** Managed Feishu/DingTalk onboarding; authorization challenges and secrets stay in component memory. */
import { useEffect, useRef, useState } from 'react'
import type { CliConnectRequest } from '../app/api.ts'
import type { CliPlatform } from '../app/cli-connect-types.ts'
import { ApiError, usePoll, type SourceView } from './api.ts'
import { Button, Icon, Input, Modal, StateDot, Switch, Tag } from './controls.tsx'
import { LoginQr } from './login-qr.tsx'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { Field, useSettings } from './settings-kit.tsx'
import { ExternalLink, Hint, When } from './widgets.tsx'

const activeStatuses = ['installing', 'authorizing', 'waiting', 'select_app', 'credentials', 'checking', 'review', 'saving'] as const

export function CliConnection({ source, platform, disabled, pendingEnabled, onEnableChange }: {
  source: SourceView; platform: CliPlatform; disabled: boolean; pendingEnabled?: boolean | undefined; onEnableChange: (enabled: boolean) => void
}) {
  const { t, call, notify, restart } = usePanel()
  const { state, reload: reloadState } = usePanelData()
  const { settings, reload: reloadSettings } = useSettings()
  const { data: view, error, reload } = usePoll(() => call('GET sources/:platform/connect', { platform }), [call, platform], 1500)
  const [enable, setEnable] = useState(true)
  useEffect(() => { if (pendingEnabled !== undefined) setEnable(pendingEnabled) }, [pendingEnabled])
  const [replaceMode, setReplaceMode] = useState<CliConnectRequest['mode']>()
  const [appId, setAppId] = useState('')
  const [clientId, setClientId] = useState('')
  const [secret, setSecret] = useState('')
  const [recovering, setRecovering] = useState(false)
  const completed = useRef('')
  const status = view?.status ?? 'idle'
  const activeStatus = activeStatuses.find(phase => phase === status)
  const active = !!activeStatus
  const configured = !!view?.configured
  const canResume = platform === 'feishu' && !configured && !!view?.canResume
    && ['idle', 'error', 'cancelled', 'expired'].includes(status)
  const pairing = view?.pairing
  const fixedApp = view?.mode !== 'manual' ? view?.selectedApp : undefined
  const credentialAppId = fixedApp?.id ?? appId.trim()
  const directMessagesOff = source.value.config.directMessages === false
  const revisions = { sourceRevision: source.revision, policyRevision: settings.blocks.policy.revision }
  useEffect(() => {
    setSecret(''); setAppId(view?.selectedApp?.id ?? ''); setClientId(view?.selectedApp?.clientId ?? '')
  }, [view?.id, status, view?.selectedApp?.id, view?.selectedApp?.clientId])
  useEffect(() => {
    if (['error', 'cancelled', 'expired'].includes(status)) setRecovering(false)
  }, [status])
  useEffect(() => {
    if (!configured || (active && status !== 'saving')) return
    // A restart can discard the session id. Persisted configuration still completes the flow.
    if (status === 'saving') return
    const key = `${view?.id ?? 'configured'}:${view?.allowed}:${pairing?.status}`
    if (completed.current === key) return
    completed.current = key
    setRecovering(false)
    void Promise.all([reloadSettings(), reloadState()])
  }, [configured, active, status, view?.id, view?.allowed, pairing?.status, reloadSettings, reloadState])
  const action = useAction(async (kind: 'start' | 'select' | 'credentials' | 'check' | 'confirm' | 'cancel' | 'pair' | 'cancelPair',
    mode: CliConnectRequest['mode'] = 'quick', replace: boolean = false) => {
    const enteredSecret = kind === 'credentials' ? secret : ''
    setSecret('')
    if (kind === 'start') {
      await call('POST sources/:platform/connect', { platform, body: { mode, enable, replace, ...revisions } })
      setReplaceMode(undefined)
    } else if (kind === 'pair') {
      await call('POST sources/:platform/pair', { platform, body: revisions })
    } else if (kind === 'cancelPair' && pairing) {
      await call('POST sources/:platform/pair/:id/cancel', { platform, id: pairing.id, body: {} })
    } else if (view?.id) {
      const params = { platform, id: view.id }
      if (kind === 'select') await call('POST sources/:platform/connect/:id/select', { ...params, body: { appId } })
      if (kind === 'credentials') await call('POST sources/:platform/connect/:id/credentials', { ...params,
        body: { appId: credentialAppId, ...view.mode !== 'manual' && clientId.trim() ? { clientId: clientId.trim() } : {}, secret: enteredSecret } })
      if (kind === 'check') await call('POST sources/:platform/connect/:id/check', { ...params, body: {} })
      if (kind === 'cancel') await call('POST sources/:platform/connect/:id/cancel', { ...params, body: {} })
      if (kind === 'confirm') {
        completed.current = ''
        setRecovering(true)
        try {
          await call('POST sources/:platform/connect/:id/confirm', { ...params, body: { enable, ...revisions } })
          if (platform === 'feishu') restart()
        } catch (failure) {
          if (!(failure instanceof ApiError && failure.details.unreachable)) { setRecovering(false); throw failure }
          restart()
        }
      }
    }
    await reload()
  })
  const copy = useAction(async () => {
    if (!pairing?.command) return
    await navigator.clipboard.writeText(pairing.command)
    notify(t('copied'))
  })
  const busy = disabled || action.busy
  const start = (mode: CliConnectRequest['mode']) => {
    if (configured) setReplaceMode(mode)
    else void action.run('start', mode)
  }
  const ready = configured && !active && !recovering
  const authorization = status === 'authorizing' || status === 'waiting'
  const missing = view?.checks?.some(check => check.state === 'action')
  return <div className="dt-cli-connect">
    <div className="dt-row-title"><Icon name="message" /><strong>{t('cliConnectTitle', { name: t(`source.${platform}`) })}</strong>
      {configured && <Tag tone="success">{t('cliConfigured')}</Tag>}
    </div>
    <Hint>{t(canResume || view?.mode === 'resume' ? 'cliResumeHint' : platform === 'feishu' ? 'cliFeishuHint' : 'cliDingtalkHint')}</Hint>
    {(disabled || (ready && pendingEnabled !== undefined)) && <Hint>{t('cliUnsaved')}</Hint>}
    {error && <p className="dt-error" role="status">{t(recovering || status === 'saving' ? 'cliRecovering' : 'cliUnavailable')}</p>}
    {(view?.error || status === 'error') && <p className="dt-error" role="alert">{t(`cliError.${view?.error ?? 'authorization_failed'}`)}</p>}
    {(status === 'expired' || status === 'cancelled') && <Hint>{t(`cliStatus.${status}`)}</Hint>}
    {recovering && !active && <p role="status">{t('cliRecovering')}</p>}
    {active && <>
      <p className="dt-login-status" role="status"><StateDot state={status === 'review' ? 'idle' : 'ongoing'} />{t(`cliStatus.${activeStatus ?? 'installing'}`)}</p>
      {authorization && view?.challenge && <div className="dt-login-flow">
        <LoginQr value={view.challenge.url} label={t('cliQrLabel', { name: t(`source.${platform}`) })} failure={t('cliQrFailed')} />
        <div className="dt-login-guidance">
          <Hint>{t('cliAuthorizeHint')}</Hint>
          <ExternalLink href={view.challenge.url}>{t('cliAuthorize')}</ExternalLink>
          {view.challenge.userCode && <div><span>{t('cliDeviceCode')}</span><code className="dt-code">{view.challenge.userCode}</code></div>}
          {view.challenge.expiresAt && <Hint>{t('cliExpires')} <When at={view.challenge.expiresAt} /></Hint>}
        </div>
      </div>}
      {view?.account && <Hint>{[view.account.name, view.account.organization].filter(Boolean).join(' · ')}</Hint>}
      {status === 'select_app' && <>
        <div className="dt-cli-apps" role="radiogroup" aria-label={t('cliSelectApp')}>
          {view?.apps?.map(app => <label key={app.id} className="dt-cli-app"><input type="radio" name={`cli-app-${platform}`}
            value={app.id} checked={appId === app.id} onChange={() => setAppId(app.id)} disabled={busy} />
            <span>{app.name}<small className="dt-mono">{app.id}</small></span></label>)}
        </div>
        {!view?.apps?.length && <Hint>{t('cliNoApps')}</Hint>}
        <Button variant="primary" disabled={busy || !view?.apps?.some(app => app.id === appId)} onClick={() => { void action.run('select') }}>{t('cliUseApp')}</Button>
      </>}
      {status === 'credentials' && <div className="dt-cli-credentials" onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); if (!busy && credentialAppId && secret) void action.run('credentials') }
      }}>
        <Hint>{t('cliCredentialsHint')}</Hint>
        <Field label={t(platform === 'dingtalk' && !fixedApp ? 'cliDingtalkClientId' : 'cliAppId')}><Input value={fixedApp?.id ?? appId} readOnly={!!fixedApp}
          onChange={event => setAppId(event.target.value)} autoComplete="off" /></Field>
        {platform === 'dingtalk' && fixedApp && <Field label={t('cliClientId')}><Input value={clientId} onChange={event => setClientId(event.target.value)} autoComplete="off" /></Field>}
        <Field label={t('cliSecret')}><Input type="password" value={secret} onChange={event => setSecret(event.target.value)} autoComplete="new-password" /></Field>
        <Button variant="primary" disabled={busy || !credentialAppId || !secret} onClick={() => { void action.run('credentials') }}>{t('cliSubmitCredentials')}</Button>
      </div>}
      {status === 'review' && <>
        {view?.selectedApp && <div className="dt-row-title"><strong>{view.selectedApp.name}</strong><code>{view.selectedApp.id}</code></div>}
        <ul className="dt-plain-list">{view?.checks?.map(check => <li key={check.id} className="dt-cli-check">
          <span>{t(`cliCheck.${check.id}`)}</span><Tag tone={check.state === 'passed' ? 'success' : check.state === 'action' ? 'warning' : 'neutral'}>{t(`cliCheckState.${check.state}`)}</Tag>
        </li>)}</ul>
        <Hint>{t(missing ? 'cliPermissionsHint' : 'cliReviewHint')}</Hint>
        {view?.platformUrl && <ExternalLink href={view.platformUrl}>{t('cliPlatformSettings')}</ExternalLink>}
        <div className="dt-switch-row"><span>{t('cliEnableAfter')}</span><Switch checked={enable}
          onChange={enabled => { setEnable(enabled); onEnableChange(enabled) }} label={t('cliEnableAfter')} /></div>
        <div className="dt-row-buttons">
          <Button disabled={busy} onClick={() => { void action.run('check') }}>{t('cliRecheck')}</Button>
          <Button variant="primary" disabled={busy || view?.canConfirm === false} onClick={() => { void action.run('confirm') }}>{t('cliConfirm')}</Button>
        </div>
      </>}
      {status !== 'saving' && <div className="dt-row-buttons"><Button disabled={action.busy} onClick={() => { void action.run('cancel') }}>{t('cancel')}</Button></div>}
    </>}
    {ready && <div className="dt-login-next">
      {!view?.enabled ? <Hint>{t('cliSavedOff')}</Hint> : <>
        {(pairing?.status === 'paired' || view.allowed) && <Hint>{t('cliPaired')}</Hint>}
        {state?.paused && <Hint>{t('cliPaused')}</Hint>}
        {pairing?.status === 'waiting' && <>
          <Hint>{t('cliPairHint', { name: t(`source.${platform}`) })}</Hint>
          {pairing.command && <><code className="dt-code">{pairing.command}</code><Button disabled={copy.busy} onClick={() => { void copy.run() }}>{t('cliCopyCommand')}</Button></>}
          <Hint>{t('cliExpires')} <When at={pairing.expiresAt} /></Hint>
          <Button disabled={action.busy} onClick={() => { void action.run('cancelPair') }}>{t('cancel')}</Button>
        </>}
        {pairing && (pairing.status === 'cancelled' || pairing.status === 'expired' || pairing.status === 'conflict') && <Hint>{t(`cliPair.${pairing.status}`)}</Hint>}
        {directMessagesOff && <Hint>{t('cliPairDirectMessagesOff')}</Hint>}
        {pairing?.status !== 'waiting' && <Button variant="primary" disabled={busy || pendingEnabled !== undefined || directMessagesOff} onClick={() => { void action.run('pair') }}>{t('cliPair')}</Button>}
      </>}
    </div>}
    {!active && !recovering && <div className="dt-row-buttons">
      {canResume && <Button variant="primary" disabled={busy || !!error || pairing?.status === 'waiting'} onClick={() => start('resume')}>{t('cliResume')}</Button>}
      <Button variant={configured || canResume ? 'outline' : 'primary'} disabled={busy || !view || !!error || pairing?.status === 'waiting'} onClick={() => start('quick')}>
        {t(canResume ? 'cliFeishuCreateNew' : configured ? 'cliReconnect' : status === 'error' || status === 'expired' || status === 'cancelled' ? 'cliRetry' : platform === 'feishu' ? 'cliFeishuStart' : 'cliDingtalkStart')}
      </Button>
      <Button disabled={busy || !view || !!error || pairing?.status === 'waiting'} onClick={() => start('manual')}>{t('cliManual')}</Button>
    </div>}
    <Modal open={replaceMode !== undefined} onClose={() => setReplaceMode(undefined)} title={t('cliReconnect')}
      description={t('cliReplaceHint', { name: t(`source.${platform}`) })} closeLabel={t('close')} footer={<>
        <Button onClick={() => setReplaceMode(undefined)}>{t('cancel')}</Button>
        <Button variant="primary" disabled={busy} onClick={() => { void action.run('start', replaceMode, true) }}>{t('cliReplaceConfirm')}</Button>
      </>} />
  </div>
}
