/** Personal-history authorization, independent of bot task sources and their CLI onboarding. */
import { useEffect, useRef, useState } from 'react'
import { usePoll } from './api.ts'
import { Button, DisclosureRow, Icon, Input, Modal, Tag } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { Field } from './settings-kit.tsx'
import { Hint, When } from './widgets.tsx'

export function FeishuUserConnection({ embedded = false }: { embedded?: boolean }) {
  const { t, call, notify } = usePanel()
  const { data: view, error, reload } = usePoll(() => call('GET connections/feishu-user'), [call], 2000)
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [details, setDetails] = useState(false)
  const [appId, setAppId] = useState('')
  const [secret, setSecret] = useState('')
  const wasActive = useRef(false)
  const active = view?.status === 'waiting' || view?.status === 'checking'
  useEffect(() => { if (view?.appId) setAppId(view.appId) }, [view?.appId])
  useEffect(() => {
    if (wasActive.current && view?.status === 'connected') {
      setOpen(false); setEditing(false); setSecret('')
    }
    wasActive.current = active
  }, [active, view?.status])
  const close = () => { setOpen(false); setEditing(false); setDetails(false); setSecret(''); setAppId(view?.appId ?? '') }
  const action = useAction(async (kind: 'authorize' | 'cancel' | 'disconnect' | 'check' | 'refresh') => {
    const credential = secret.trim()
    setSecret('')
    if (kind === 'authorize') await call('POST connections/feishu-user/authorize', {
      body: { appId: appId.trim(), ...credential ? { secret: credential } : {} } })
    if (kind === 'cancel') await call('POST connections/feishu-user/cancel', { body: {} })
    if (kind === 'disconnect') await call('POST connections/feishu-user/disconnect', { body: {} })
    if (kind === 'refresh') await call('POST connections/feishu-user/refresh', { body: {} })
    if (kind === 'check') {
      await call('POST connections/feishu-user/read', { body: { resource: 'feishu-user/chats?page_size=1' } })
      notify(t('feishuUserReadPassed'))
    }
    await reload()
  })
  const connected = view?.status === 'connected'
  const canReuse = view?.configured && view.appId === appId.trim()
  const credentials = !active && (!view?.configured || editing)
  const manageLabel = t('imPersonalManage', { name: t('imPlatform.feishu') })
  return <section id="dt-source-feishu-user" className={embedded ? 'dt-platform-section' : 'dt-card'}>
    <div className="dt-connection-row">
      <span className="dt-connection-icon"><Icon name="user" /></span>
      <div className="dt-connection-main">
        <div className="dt-connection-title"><strong>{t(embedded ? 'imPersonalTitle' : 'feishuUserTitle')}</strong>
          {view && <Tag tone={connected ? 'success' : view.status === 'error' || view.status === 'expired' ? 'warning' : 'quiet'}>
            {t(`feishuUserStatus.${view.status}`)}</Tag>}
        </div>
        <p className="dt-connection-description">{view?.user?.name ?? t('imPersonalSummary')}
          {connected && view.renewal === 'automatic' && <span className="dt-connection-fact">{t('imAutomaticRenewal')}</span>}</p>
      </div>
      <Button size="sm" variant={view?.configured ? 'outline' : 'primary'} aria-label={manageLabel} aria-haspopup="dialog"
        disabled={!view || action.busy} onClick={() => { setEditing(view?.renewal === 'reauthorize'); setOpen(true) }}>
        {t(active ? 'imContinueAuthorization' : view?.configured ? 'imManage' : 'imConnect')}</Button>
    </div>
    {error && <p role="alert" className="dt-error">{error.message}</p>}
    {view?.error && <p role="alert" className="dt-error">{t(`feishuUserError.${view.error}`)}
      {view.upstreamCode === undefined ? '' : ` (${view.upstreamCode})`}</p>}
    {view?.renewal === 'reauthorize' && <Hint>{t('imRenewalNeedsConsent')}</Hint>}
    {view?.renewal === 'retrying' && <Hint>{t('feishuUserRenewal.retrying')}</Hint>}
    {view?.renewalError && <p role="alert" className="dt-error">{t(`feishuUserError.${view.renewalError}`)}</p>}
    <Modal open={open} onClose={close} title={manageLabel} closeLabel={t('close')} className="dt-connection-modal">
      <form className="dt-connection-form" autoComplete="off" onSubmit={event => {
        event.preventDefault(); if (credentials && !action.busy) void action.run('authorize')
      }}>
        {view?.user && <div className="dt-connection-account"><Icon name="user" /><strong>{view.user.name}</strong>
          <Tag tone={connected ? 'success' : 'warning'}>{t(`feishuUserStatus.${view.status}`)}</Tag></div>}
        <Hint>{t(`feishuUserRenewal.${view?.renewal ?? 'unavailable'}`)}</Hint>
        {view?.error && <p role="alert" className="dt-error">{t(`feishuUserError.${view.error}`)}</p>}
        {view?.authorizationUrl && <div className="dt-authorization-prompt">
          <a className="dt-inline-link" href={view.authorizationUrl} target="_blank" rel="noreferrer noopener">{t('feishuUserOpenAuthorization')}</a>
          <Hint>{t('feishuUserWaiting')}</Hint>
        </div>}
        {credentials && <div className="dt-cli-credentials">
          <Hint>{t('feishuUserHint')}</Hint>
          <Field label={t('feishuUserAppId')}><Input value={appId} disabled={action.busy} autoComplete="off"
            onChange={event => { setAppId(event.target.value); setSecret('') }} /></Field>
          <Field label={t('feishuUserSecret')} hint={canReuse ? t('feishuUserSecretSaved') : t('feishuUserSecretHint')}>
            <Input type="password" value={secret} disabled={action.busy} autoComplete="new-password"
              onChange={event => setSecret(event.target.value)} /></Field>
          {view?.redirectUri && <Hint>{t('feishuUserCallback')} <code>{view.redirectUri}</code></Hint>}
          <div className="dt-row-buttons"><Button type="submit" variant="primary"
            disabled={action.busy || !appId.trim() || (!canReuse && !secret.trim())}>
            {t(view?.renewal === 'reauthorize' ? 'feishuUserUpgrade' : 'feishuUserAuthorize')}</Button>
            {view?.configured && <Button disabled={action.busy} onClick={() => { setEditing(false); setSecret(''); setAppId(view.appId ?? '') }}>{t('cancel')}</Button>}
          </div>
        </div>}
        {!active && !credentials && <div className="dt-row-buttons">
          {connected && <Button variant="outline" disabled={action.busy} onClick={() => { void action.run('check') }}>{t('feishuUserCheck')}</Button>}
          {view?.renewal === 'automatic' && <Button disabled={action.busy} onClick={() => { void action.run('refresh') }}>{t('feishuUserRefresh')}</Button>}
          <Button disabled={action.busy} onClick={() => setEditing(true)}>{t('imReauthorize')}</Button>
        </div>}
        {active && <div className="dt-row-buttons"><Button disabled={action.busy || view?.status === 'checking'}
          onClick={() => { void action.run('cancel') }}>{t('cancel')}</Button></div>}
        <DisclosureRow icon={<Icon name="settings" />} title={t('imConnectionDetails')} open={details} onToggle={() => setDetails(!details)}>
          <dl className="dt-connection-details">
            {view?.appId && <><dt>{t('feishuUserAppId')}</dt><dd><code>{view.appId}</code></dd></>}
            {view?.expiresAt && <><dt>{t('feishuUserExpires')}</dt><dd><When at={view.expiresAt} /></dd></>}
            {view?.refreshExpiresAt && <><dt>{t('feishuUserRefreshExpires')}</dt><dd><When at={view.refreshExpiresAt} /></dd></>}
            {view?.refreshedAt && <><dt>{t('feishuUserRefreshed')}</dt><dd><When at={view.refreshedAt} /></dd></>}
            {view?.scopes && <><dt>{t('imGrantedPermissions')}</dt><dd><code>{view.scopes.join(' · ')}</code></dd></>}
          </dl>
        </DisclosureRow>
        {view?.configured && !active && <div className="dt-danger-zone"><Hint>{t('imDisconnectHint')}</Hint>
          <Button size="sm" disabled={action.busy} onClick={() => { void action.run('disconnect') }}>{t('feishuUserDisconnect')}</Button></div>}
      </form>
    </Modal>
  </section>
}
