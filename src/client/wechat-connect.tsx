/** Local QR onboarding for WeChat; credentials stay on the host and only transient login state reaches the panel. */
import { useEffect, useRef, useState } from 'react'
import { LoginQr } from './login-qr.tsx'
import type { WechatLoginView } from '../app/api.ts'
import { usePoll, type SourceView } from './api.ts'
import { Button, Icon, Input, Modal, StateDot, Switch, Tag } from './controls.tsx'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { settingsRoute } from './route.ts'
import { useSettings } from './settings-kit.tsx'
import { Hint, When } from './widgets.tsx'

const pending = (view: WechatLoginView | null | undefined) => !!view && ['starting', 'waiting', 'scanned', 'verification', 'saving'].includes(view.status)

export function WechatConnection({ source, disabled }: { source: SourceView; disabled: boolean }) {
  const { t, call, notify, navigate } = usePanel()
  const { state, reload: reloadState } = usePanelData()
  const { settings, reload: reloadSettings } = useSettings()
  const { data: login, error, reload } = usePoll(() => call('GET sources/wechat/login'), [call], 1500)
  const [enable, setEnable] = useState(true)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [code, setCode] = useState('')
  const completed = useRef<string>()
  const configured = !!source.value.config.accountId && !!source.value.config.credentialsFile
  const active = pending(login)
  const action = useAction(async (kind: 'start' | 'refresh' | 'cancel' | 'verify', replace: boolean = false) => {
    if ((kind === 'refresh' || kind === 'cancel') && login) await call('POST sources/wechat/login/:id/cancel', { id: login.id, body: {} })
    if (kind === 'start' || kind === 'refresh') {
      await call('POST sources/wechat/login', { body: { enable, replace, sourceRevision: source.revision,
        policyRevision: settings.blocks.policy.revision } })
      setReplaceOpen(false)
    }
    if (kind === 'verify' && login) {
      const value = code.trim()
      setCode('')
      await call('POST sources/wechat/login/:id/verify', { id: login.id, body: { code: value } })
    }
    if (kind !== 'verify') setCode('')
    await reload()
  })
  useEffect(() => {
    if (login?.status !== 'connected' || completed.current === login.id) return
    completed.current = login.id
    void Promise.all([reloadSettings(), reloadState()]).then(() => notify(t('wechatBound')))
  }, [login?.id, login?.status, reloadSettings, reloadState, notify, t])
  useEffect(() => { if (login?.status !== 'verification') setCode('') }, [login?.status])
  const start = () => { if (configured) setReplaceOpen(true); else void action.run('start') }
  const busy = action.busy || disabled
  const status = login?.status
  const step = status === 'waiting' || status === 'scanned' || status === 'verification' || status === 'saving' ? status : 'starting'
  const expired = status === 'expired'
  const failed = status === 'error'
  const connected = status === 'connected' || configured
  const health = state?.health.wechat
  return <div className="dt-wechat-connect">
    <div className="dt-row-title"><Icon name="message" /><strong>{t('wechatConnectTitle')}</strong>
      {configured && <Tag tone="success">{t('wechatBound')}</Tag>}
    </div>
    <Hint>{t('wechatConnectHint')}</Hint>
    {disabled && <Hint>{t('wechatUnsaved')}</Hint>}
    {error && <p className="dt-error" role="alert">{error.message}</p>}
    {failed && <p className="dt-error" role="alert">{t(`wechatError.${login?.error ?? 'upstream_failed'}`)}</p>}
    {expired && <p className="dt-hint" role="status">{t('wechatExpired')}</p>}
    {status === 'cancelled' && <Hint>{t('wechatCancelled')}</Hint>}
    {active && <div className="dt-login-flow">
      {(status === 'waiting' || status === 'scanned') && login?.qrUrl && <LoginQr value={login.qrUrl} label={t('wechatQrLabel')} failure={t('wechatQrFailed')} />}
      <div className="dt-login-guidance">
        <p className="dt-login-status" role="status"><StateDot state="ongoing" />{t(`wechatStatus.${step}`)}</p>
        {(status === 'waiting' || status === 'scanned') && <>
          <ol className="dt-login-steps"><li>{t('wechatStepScan')}</li><li>{t('wechatStepConfirm')}</li><li>{t('wechatStepDone')}</li></ol>
          <Hint>{t('wechatExpires')} <When at={login?.expiresAt} /></Hint>
        </>}
        {status === 'verification' && <div className="dt-login-verification">
          <label htmlFor="dt-wechat-code">{t('wechatCode')}</label>
          <Input id="dt-wechat-code" value={code} inputMode="numeric" autoComplete="one-time-code" maxLength={12}
            onChange={event => setCode(event.target.value.replace(/\D/g, ''))}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); if (/^\d{4,12}$/.test(code)) void action.run('verify') } }} />
          <Button variant="primary" disabled={busy || !/^\d{4,12}$/.test(code)} onClick={() => { void action.run('verify') }}>{t('wechatVerify')}</Button>
        </div>}
        <div className="dt-row-buttons">
          {status !== 'saving' && <Button disabled={busy} onClick={() => { void action.run('cancel') }}>{t('cancel')}</Button>}
          {(status === 'waiting' || status === 'scanned') && <Button disabled={busy} icon={<Icon name="refresh" />}
            onClick={() => { void action.run('refresh', configured) }}>{t('wechatRefreshQr')}</Button>}
        </div>
      </div>
    </div>}
    {!active && <>
      <div className="dt-switch-row"><span>{t('wechatEnableAfter')}</span>
        <Switch checked={enable} onChange={setEnable} label={t('wechatEnableAfter')} />
      </div>
      {connected && <div className="dt-login-next">
        <Hint>{source.value.enabled || login?.enabled ? state?.paused ? t('wechatPaused') : t('wechatSendHint') : t('wechatSavedOff')}</Hint>
        {(source.value.enabled || login?.enabled) && !state?.paused && <code className="dt-code">/superagent {t('wechatExample')}</code>}
        {health?.state === 'error' && source.value.enabled && <p className="dt-error" role="status">{t('wechatConnectionError')}</p>}
      </div>}
      <div className="dt-row-buttons">
        <Button variant={configured ? 'outline' : 'primary'} disabled={busy || login === undefined || !!error} icon={<Icon name={configured ? 'refresh' : 'plus'} />}
          onClick={start}>{action.busy ? t('wechatStarting') : configured ? t('wechatReconnect') : expired || failed ? t('wechatRetry') : t('wechatStart')}</Button>
        {configured && <Button onClick={() => navigate(settingsRoute('eval'))}>{t('wechatAllowedUsers')}</Button>}
      </div>
    </>}
    <Modal open={replaceOpen} onClose={() => setReplaceOpen(false)} title={t('wechatReconnect')}
      description={t('wechatReplaceHint')} closeLabel={t('close')} footer={<>
        <Button onClick={() => setReplaceOpen(false)}>{t('cancel')}</Button>
        <Button variant="primary" disabled={busy} onClick={() => { void action.run('start', true) }}>{t('wechatContinue')}</Button>
      </>} />
  </div>
}
