/** Owner-only DingTalk reads, separate from robot pairing and source switches. */
import { useState } from 'react'
import { usePoll } from './api.ts'
import type { DingTalkSubscriptionView } from '../app/api.ts'
import { Button, Icon, Modal, Tag } from './controls.tsx'
import { useAction, usePanel } from './provider.tsx'
import { Hint, When } from './widgets.tsx'
import { settingsRoute } from './route.ts'

function PersonalGroupPicker({ subscriptions, onSubscribed }: {
  subscriptions: DingTalkSubscriptionView[]; onSubscribed: () => Promise<void>
}) {
  const { t, call, notify } = usePanel()
  const [chatId, setChatId] = useState('')
  const { data: groups, error, reload } = usePoll(() => call('GET connections/dingtalk-user/groups'), [call], 2000)
  const available = Object.entries(groups?.labels ?? {}).filter(([id]) => !subscriptions.some(item => item.chatId === id && !item.senderId && item.status !== 'suspended'))
    .sort(([, a], [, b]) => a.localeCompare(b))
  const selected = available.find(([id]) => id === chatId)
  const refresh = useAction(async () => {
    await call('POST connections/dingtalk-user/groups/refresh', { body: {} })
    await reload()
  })
  const subscribe = useAction(async () => {
    if (!selected) return
    await call('POST connections/dingtalk-user/subscriptions', { body: { chatId: selected[0], name: selected[1].slice(0, 256) } })
    setChatId('')
    await onSubscribed()
    notify(t('dingtalkGroupSubscribed', { name: selected[1] }))
  })
  return <div className="dt-subscription-section">
    <div className="dt-subhead"><strong>{t('dingtalkGroupReadTitle')}</strong>
      <Button size="sm" icon={<Icon name="refresh" size={14} />} disabled={refresh.busy || subscribe.busy}
        aria-busy={refresh.busy} onClick={() => { void refresh.run() }}>{t('dingtalkGroupRefresh')}</Button>
    </div>
    <Hint>{t('dingtalkGroupReadHint')}</Hint>
    {error && <p role="alert" className="dt-error">{error.message}</p>}
    {groups && <Hint>{t(groups.complete ? 'dingtalkGroupsComplete' : 'dingtalkGroupsPartial', {
      count: Object.keys(groups.labels).length, scanned: groups.scanned })}</Hint>}
    <select className="dt-select" aria-label={t('dingtalkGroupChoose')} value={selected?.[0] ?? ''}
      disabled={refresh.busy || subscribe.busy || !available.length} onChange={event => setChatId(event.target.value)}>
      <option value="" disabled>{t('dingtalkGroupChoose')}</option>
      {available.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
    </select>
    {!available.length && <Hint>{t(groups ? 'dingtalkGroupNoUnsubscribed' : 'dingtalkGroupNotLoaded')}</Hint>}
    <div className="dt-row-buttons"><Button variant="primary" disabled={!selected || subscribe.busy || refresh.busy}
      onClick={() => { void subscribe.run() }}>{t('dingtalkGroupSubscribe')}</Button></div>
  </div>
}

export function DingTalkUserConnection({ embedded = false }: { embedded?: boolean }) {
  const { t, call, notify, navigate } = usePanel()
  const [open, setOpen] = useState(false)
  const { data: view, error, reload } = usePoll(() => call('GET connections/dingtalk-user'), [call], 2000)
  const { data: subscriptions, error: subscriptionError, reload: reloadSubscriptions } = usePoll(
    () => call('GET connections/dingtalk-user/subscriptions'), [call], 5000)
  const subscriptionAction = useAction(async (id: string, kind: 'check' | 'unsubscribe' | 'context' | 'tasks' | 'assess') => {
    if (kind === 'check') await call('POST connections/dingtalk-user/subscriptions/:id/check', { id, body: {} })
    else if (kind === 'unsubscribe') await call('POST connections/dingtalk-user/subscriptions/:id/unsubscribe', { id, body: {} })
    else if (kind === 'assess') {
      await call('POST connections/dingtalk-user/subscriptions/:id/assess-latest', { id, body: {} })
      notify(t('dingtalkSubscriptionAssessed'))
    } else await call('POST connections/dingtalk-user/subscriptions/:id/mode', { id, body: { mode: kind } })
    await reloadSubscriptions()
  })
  const action = useAction(async (kind: 'saved' | 'authorize' | 'cancel' | 'disconnect' | 'check', profileId?: string) => {
    if (kind === 'saved' || kind === 'authorize') await call('POST connections/dingtalk-user/connect', {
      body: { mode: kind, ...profileId ? { profileId } : {} } })
    if (kind === 'cancel') await call('POST connections/dingtalk-user/cancel', { body: {} })
    if (kind === 'disconnect') await call('POST connections/dingtalk-user/disconnect', { body: {} })
    if (kind === 'check') {
      await call('POST connections/dingtalk-user/read', { body: { resource: 'dingtalk-user/chats?page_size=1' } })
      notify(t('feishuUserReadPassed'))
    }
    await reload()
  })
  const active = view?.status === 'checking' || view?.status === 'waiting' || view?.status === 'select_account'
  const connected = view?.status === 'connected'
  const manageLabel = t('imPersonalManage', { name: t('imPlatform.dingtalk') })
  const subscriptionRows = (manage = false) => <ul className="dt-subscriptions">{subscriptions?.map(item => <li key={item.id} className="dt-subscription">
    <Icon name="message" />
    <div className="dt-connection-main"><div className="dt-connection-title"><strong>{item.name}</strong>
      <Tag tone={item.status === 'listening' ? 'success' : 'warning'}>{t(`dingtalkSubscriptionStatus.${item.status}`)}</Tag></div>
      <div className="dt-row-meta"><span>{t('dingtalkSubscriptionReceived')} {item.received}</span>
        <span>{t(item.mode === 'tasks' ? 'dingtalkSubscriptionTasks' : 'dingtalkSubscriptionContext')}</span>
        {item.mode === 'tasks' && <span>{t('dingtalkSubscriptionTriggered')} {item.triggered}</span>}
        <span>{t('dingtalkSubscriptionChecked')} <When at={item.lastCheckedAt} /></span></div>
      {item.mode === 'tasks' && <Hint>{t('dingtalkSubscriptionGlobalMode', { mode: t(`mode.${item.evaluationMode}`) })}{' '}
        <button type="button" className="dt-textlink" onClick={() => navigate(settingsRoute('eval'))}>{t('dingtalkSubscriptionModeSettings')}</button></Hint>}
      {!!item.unreadable && <Hint>{t('dingtalkSubscriptionUnreadable', { count: item.unreadable })}</Hint>}
      {(item.historyGapAt || item.error === 'history_gap') && <p role="alert" className="dt-error">{t('dingtalkSubscriptionHistoryGap')}</p>}
      {item.error && item.error !== 'history_gap' && <p role="alert" className="dt-error">{t('dingtalkSubscriptionReadError')}</p>}
    </div>
    <Button size="sm" icon={<Icon name="refresh" size={14} />} disabled={subscriptionAction.busy || item.status === 'suspended'}
      onClick={() => { void subscriptionAction.run(item.id, 'check') }}>{t('dingtalkSubscriptionCheck')}</Button>
    {item.lastThreadKey && item.lastTriggerId && <Button size="sm" onClick={() => {
      if (item.lastThreadKey && item.lastTriggerId) navigate({ page: 'trigger', id: item.lastThreadKey, query: { trigger: item.lastTriggerId } })
    }}>{t('dingtalkSubscriptionTrace')}</Button>}
    {manage && <div className="dt-row-buttons">
      <Button size="sm" disabled={subscriptionAction.busy || (item.mode !== 'tasks' && item.status === 'suspended')}
        onClick={() => { void subscriptionAction.run(item.id, item.mode === 'tasks' ? 'context' : 'tasks') }}>
        {t(item.mode === 'tasks' ? 'dingtalkSubscriptionDisableTasks' : 'dingtalkSubscriptionEnableTasks')}</Button>
      {item.mode === 'tasks' && <Button size="sm" disabled={subscriptionAction.busy || item.status === 'suspended'}
        onClick={() => { void subscriptionAction.run(item.id, 'assess') }}>{t('dingtalkSubscriptionAssessLatest')}</Button>}
      <Button size="sm" disabled={subscriptionAction.busy}
        onClick={() => { void subscriptionAction.run(item.id, 'unsubscribe') }}>{t('dingtalkSubscriptionCancel')}</Button>
    </div>}
  </li>)}</ul>
  return <section id="dt-source-dingtalk-user" className={embedded ? 'dt-platform-section' : 'dt-card'}>
    <div className="dt-connection-row">
      <span className="dt-connection-icon"><Icon name="user" /></span>
      <div className="dt-connection-main">
        <div className="dt-connection-title"><strong>{t(embedded ? 'imPersonalTitle' : 'dingtalkUserTitle')}</strong>
          {view && <Tag tone={connected ? 'success' : view.status === 'error' || view.status === 'expired' ? 'warning' : 'quiet'}>
            {t(`dingtalkUserStatus.${view.status}`)}</Tag>}
        </div>
        <p className="dt-connection-description">{view?.user
          ? [view.user.name, view.user.organization].filter(Boolean).join(' · ') : t('imPersonalSummary')}</p>
      </div>
      <Button size="sm" variant={view?.configured ? 'outline' : 'primary'} aria-label={manageLabel} aria-haspopup="dialog"
        disabled={!view || action.busy} onClick={() => setOpen(true)}>{t(active ? 'imContinueAuthorization' : view?.configured ? 'imManage' : 'imConnect')}</Button>
    </div>
    {error && <p role="alert" className="dt-error">{error.message}</p>}
    {view?.error && <p role="alert" className="dt-error">{t(`dingtalkUserError.${view.error}`)}</p>}
    {subscriptionError && <p role="alert" className="dt-error">{subscriptionError.message}</p>}
    {!!subscriptions?.length && <div className="dt-subscription-section"><span className="dt-subscription-heading">{t('dingtalkSubscriptionsTitle')} · {subscriptions.length}</span>
      {subscriptionRows()}</div>}
    <Modal open={open} onClose={() => setOpen(false)} title={manageLabel} closeLabel={t('close')} className="dt-connection-modal">
      <div className="dt-connection-form">
        {view?.user && <div className="dt-connection-account"><Icon name="user" /><strong>{view.user.name}</strong>
          {view.user.organization && <span>{view.user.organization}</span>}</div>}
        <Hint>{t('dingtalkUserHint')}</Hint>
        {view?.refreshExpiresAt && <Hint>{t('dingtalkUserRefreshExpires')} <When at={view.refreshExpiresAt} /></Hint>}
        {view?.error && <p role="alert" className="dt-error">{t(`dingtalkUserError.${view.error}`)}</p>}
        {view?.challenge && <div className="dt-authorization-prompt">
          <a className="dt-inline-link" href={view.challenge.url} target="_blank" rel="noreferrer noopener">{t('dingtalkUserOpenAuthorization')}</a>
          {view.challenge.userCode && <code>{view.challenge.userCode}</code>}
          <Hint>{t('dingtalkUserWaiting')}</Hint>
        </div>}
        {view?.accounts?.map(account => <Button key={account.profileId} disabled={action.busy}
          onClick={() => { void action.run('saved', account.profileId) }}>
          {account.user.name} · {account.user.organization ?? account.user.corpId}
        </Button>)}
        <div className="dt-row-buttons">
          {!active && !view?.configured && <Button variant="primary" disabled={action.busy} onClick={() => { void action.run('saved') }}>
            {t('dingtalkUserReuse')}</Button>}
          {!active && <Button disabled={action.busy} onClick={() => { void action.run('authorize') }}>{t('dingtalkUserAuthorize')}</Button>}
          {active && <Button disabled={action.busy} onClick={() => { void action.run('cancel') }}>{t('cancel')}</Button>}
          {connected && <Button variant="outline" disabled={action.busy} onClick={() => { void action.run('check') }}>{t('feishuUserCheck')}</Button>}
        </div>
        {connected && <PersonalGroupPicker subscriptions={subscriptions ?? []} onSubscribed={reloadSubscriptions} />}
        {!!subscriptions?.length && <div className="dt-subscription-section"><strong>{t('dingtalkSubscriptionsTitle')}</strong>
          <Hint>{t('dingtalkSubscriptionsHint')}</Hint>{subscriptionRows(true)}</div>}
        {view?.configured && !active && <div className="dt-danger-zone"><Hint>{t('imDisconnectHint')}</Hint>
          <Button size="sm" disabled={action.busy} onClick={() => { void action.run('disconnect') }}>{t('feishuUserDisconnect')}</Button></div>}
      </div>
    </Modal>
  </section>
}
