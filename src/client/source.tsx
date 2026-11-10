/** Source status view (health, filtered Triggers, dropped replies) and Source settings cards. */
import { useEffect, useState } from 'react'
import type { FieldSpec } from '../sources/kind.ts'
import { usePoll, type DroppedReply, type SourceStatusRow, type SourceView } from './api.ts'
import { Button, DisclosureRow, Dot, Icon, InfoTip, Switch, Tag } from './controls.tsx'
import { SaveBar } from './draft.tsx'
import { sourceMark } from './marks.ts'
import { usePanel, usePanelData } from './provider.tsx'
import { setupPage, settingsRoute, type Route } from './route.ts'
import { ConfigHistory, Fields, SourceField, useBlockDraft, useSettings } from './settings-kit.tsx'
import { actorName, healthText, localized, readableMarkers, reasonLabel, valueLabel, when } from './text.ts'
import { CliConnection } from './cli-connect.tsx'
import { WechatConnection } from './wechat-connect.tsx'
import { FeishuUserConnection } from './feishu-user.tsx'
import { DingTalkUserConnection } from './dingtalk-user.tsx'
import { CheckSetupButton, Hint, LabelValue, LoadState, SetupMessage, StatusHead, When } from './widgets.tsx'

function SourceCard({ source, embedded = false, focused = false }: { source: SourceView; embedded?: boolean; focused?: boolean }) {
  const { t, call } = usePanel()
  const { running } = usePanelData()
  const { reload } = useSettings()
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [expanded, setExpanded] = useState(focused)
  useEffect(() => { if (focused) setExpanded(true) }, [focused])
  const refreshLabels = async () => { const { added } = await call('POST sources/:id/labels',
    { id: source.id }); await reload(); return added }
  const draft = useBlockDraft(`source:${source.id}`, source.value, source.revision)
  const value = draft.value
  const { problem, value: saved } = source
  const configDirty = JSON.stringify(value.config) !== JSON.stringify(saved.config)
  const pendingEnabled = value.enabled === saved.enabled ? undefined : value.enabled
  const changed = (key: string) => String(value.config[key] ?? '') !== String(saved.config[key] ?? '')
  // Saving a modified setup-sensitive field restarts dsh-superagent, interrupting running Assignments.
  const restarts = draft.dirty && source.restarts.some(changed)
  const description = localized(t, source.description)
  // Hide derived facts for unsaved field edits until the new value is saved.
  const field = (spec: FieldSpec) => <SourceField key={spec.key} field={spec} value={value.config[spec.key]} saved={saved.config[spec.key]}
    labels={source.labels}
    refreshLabels={refreshLabels} fact={spec.type === 'fact' || !changed(spec.key) ? source.facts[spec.key] : undefined}
    onChange={next => {
      const named = source.id === 'dingtalk' && spec.key === 'chats' && Array.isArray(next)
        ? next.map((chat: Record<string, string>) => ({ ...chat, ...source.labels[chat.chatId ?? '']
          ? { name: source.labels[chat.chatId ?? '']!.slice(0, 100) } : {} })) : next
      draft.edit({ ...value, config: { ...value.config, [spec.key]: named } })
    }} />
  const isAdvanced = (spec: FieldSpec) => spec.advanced
    || (['wechat', 'dingtalk'].includes(source.id) && ['accountId', 'credentialsFile'].includes(spec.key))
    || (source.id === 'feishu' && spec.key === 'cli')
  const advanced = source.fields.filter(isAdvanced)
  const detailsOpen = !embedded || expanded
  const chats = Array.isArray(value.config.chats) ? value.config.chats as { chatId: string; name?: string }[] : []
  return <form id={`dt-source-${source.id}`} className={embedded ? 'dt-platform-section' : 'dt-card'} onSubmit={event => { void draft.submit(event) }}>
    <Fields disabled={draft.busy}>
      <div className={embedded ? 'dt-connection-row' : 'dt-card-head'}>
        {embedded && <span className="dt-connection-icon"><Icon name="inbox" /></span>}
        <div className="dt-row-main">
          <div className="dt-row-title">
            <span className="dt-card-title">{embedded ? t('imBotTitle') : localized(t, source.title)}</span>{description && <InfoTip text={description} />}
            {!source.installed ? <Tag tone="warning">{t('sourceNotInstalled')}</Tag>
              : embedded && <Tag tone={value.enabled ? 'success' : 'quiet'}>{t(value.enabled ? 'imBotEnabled' : 'imBotDisabled')}</Tag>}
          </div>
          {embedded && <p className="dt-connection-description">{chats.length > 0
            ? chats.map(chat => <span key={chat.chatId} className="dt-connection-group" title={chat.chatId}>{chat.name || source.labels[chat.chatId] || chat.chatId}</span>)
            : t('sourceListeningGroups', { count: 0 })}
            <span className="dt-connection-fact">{t(value.config.directMessages === false ? 'sourceListeningDirectOff' : 'sourceListeningDirectOn')}</span></p>}
        </div>
        {embedded && source.installed && <Button size="sm" aria-label={t('imBotManageLabel', { name: localized(t, source.title) })}
          aria-expanded={detailsOpen} aria-controls={`dt-source-${source.id}-details`} onClick={() => setExpanded(!expanded)}
          icon={<Icon name={detailsOpen ? 'chevron-up' : 'chevron-down'} size={14} />}>{t('imBotManage')}</Button>}
        {source.installed && <Switch checked={value.enabled} onChange={enabled => draft.edit({ ...value, enabled })}
          label={t('sourceEnable', { name: localized(t, source.title) })} />}
      </div>
      {problem && <div className="dt-row-buttons">
        <p className="dt-error" role="status"><SetupMessage problem={problem} lead /></p><CheckSetupButton />
      </div>}
      {!source.installed && <Hint>{t('sourceNotInstalledHint')}</Hint>}
      {detailsOpen && <div id={`dt-source-${source.id}-details`} className="dt-source-settings-details">
      {embedded && <Hint>{t('imBotHint')}</Hint>}
      {source.installed && (source.id === 'feishu' || source.id === 'dingtalk') && <CliConnection source={source} platform={source.id}
        disabled={draft.busy || configDirty} pendingEnabled={pendingEnabled}
        onEnableChange={enabled => draft.edit({ ...value, enabled })} />}
      {source.installed && source.id === 'feishu' && source.facts.cli && !changed('cli') && <Hint>{localized(t, source.facts.cli)}</Hint>}
      {source.installed && source.id === 'wechat' && <WechatConnection source={source} disabled={draft.busy || draft.dirty} />}
      {source.installed && source.fields.filter(spec => !isAdvanced(spec)).map(field)}
      {source.id === 'dingtalk' && <Hint>{t('dingtalkGroupsHint')}</Hint>}
      {source.labelStatus && <Hint>{t(source.labelStatus.complete ? 'dingtalkGroupsComplete' : 'dingtalkGroupsPartial', {
        count: source.labelStatus.count, scanned: source.labelStatus.scanned })}</Hint>}
      {source.installed && advanced.length > 0 && <DisclosureRow icon={<Icon name="settings" />} title={t('advanced')} open={advancedOpen}
        onToggle={() => setAdvancedOpen(!advancedOpen)}>
        <div className="dt-disclosure-body">{advanced.map(field)}</div>
      </DisclosureRow>}
      </div>}
    </Fields>
    <SaveBar {...draft} status={restarts && running > 0 ? t('restartInterrupts', { count: running }) : undefined}
      onDiscard={draft.discard} />
  </form>
}

export function SourceSettings({ focus }: { focus?: string }) {
  const { t } = usePanel()
  const { sources } = useSettings().settings
  useEffect(() => { if (focus) document.getElementById(`dt-source-${focus}`)?.scrollIntoView?.({ block: 'start' }) }, [focus])
  return <div className="dt-form">
    <Hint>{t('imConnectionsHint')}</Hint>
    {(['feishu', 'dingtalk'] as const).map(platform => {
      const source = sources.find(item => item.id === platform)
      return <section key={platform} className="dt-card dt-platform-card" aria-label={t(`imPlatform.${platform}`)} data-platform={platform}>
        <div className="dt-platform-head"><span className="dt-platform-icon"><Icon name="message" size={18} /></span>
          <h3>{t(`imPlatform.${platform}`)}</h3></div>
        {platform === 'feishu' ? <FeishuUserConnection embedded /> : <DingTalkUserConnection embedded />}
        {source ? <SourceCard source={source} embedded focused={focus === platform} /> : <div className="dt-platform-section"><Hint>{t('imBotUnavailable')}</Hint></div>}
      </section>
    })}
    {sources.filter(source => !['feishu', 'dingtalk', 'dingtalk-user'].includes(source.id)).map(source => <SourceCard key={source.id} source={source} />)}
    <ConfigHistory blocks={['source:']} />
  </div>
}

function DroppedReplies({ items }: { items: DroppedReply[] }) {
  const { t, navigate } = usePanel()
  const [open, setOpen] = useState(false)
  // Link to the message's Ticket, or fall back to its Thread for messages queued before receipts recorded `ticketId`.
  const target = (item: DroppedReply): { route: Route; name: string } | undefined => item.ticket
    ? { route: { page: 'execution', id: item.ticket.id }, name: item.ticket.title }
    : item.thread ? { route: { page: 'trigger', id: item.thread }, name: t('term.thread') } : undefined
  return <DisclosureRow icon={<Icon name="dismiss" />} title={<>{t('sourceDroppedTitle')} <span
    className="dt-count">{items.length}</span></>} open={open}
    onToggle={() => setOpen(!open)}>
    <div className="dt-disclosure-body">
      <Hint>{t('sourceDroppedHint')}</Hint>
      <ul className="dt-list">{items.map(item => {
        const link = target(item)
        return <li key={item.id} className="dt-row"><Dot state="idle" /><div className="dt-row-main">
          <div className="dt-row-title dt-line">{readableMarkers(t, item.preview) || t('empty')}</div>
          <div className="dt-row-meta">
            <Tag tone="neutral">{reasonLabel(t, item.dropped.reason)}</Tag><When at={item.dropped.at} />
            {link && <button type="button" className="dt-textlink" onClick={() => navigate(link.route)}>{link.name}</button>}
          </div>
        </div></li>
      })}</ul>
    </div>
  </DisclosureRow>
}
function SourceRow({ source }: { source: SourceStatusRow }) {
  const { t, navigate } = usePanel()
  const { setup } = usePanelData()
  const [filteredOpen, setFilteredOpen] = useState(false)
  const { problem, dropped } = source
  const { dot, label: state } = sourceMark(t, source.state)
  const personal = source.id === 'feishu' || source.id === 'dingtalk'
  const connected = source.id === 'dingtalk' && source.state === 'ready'
  const status = <span className="dt-status-text" data-state={dot}>{connected ? t('sourceConnected') : state}</span>
  const { received, filtered, lastAt } = source.stats
  // Omit healthy parts and suppress per-part notes when a setup problem already explains why the Source is stopped.
  const notes = source.enabled && !problem && !setup?.problem ? source.health.filter(item => item.state === 'error'
    || item.state === 'paused') : []
  return <li className="dt-row" data-source={source.id}>
    {!personal && <Dot state={dot} label={state} />}
    <div className="dt-row-main">
      <div className="dt-row-title"><span className="dt-row-name">{localized(t, source.title)}</span>{!personal && status}</div>
      {personal && <>
        <div className="dt-source-personal">{source.id === 'feishu' ? <FeishuUserConnection embedded /> : <DingTalkUserConnection embedded />}</div>
        <div className="dt-source-bot-head">
          <Dot state={dot} label={state} /><span>{t('imBotTitle')}</span>{status}
          <button type="button" className="dt-textlink" aria-label={t('imBotManageLabel', { name: localized(t, source.title) })}
            onClick={() => navigate(settingsRoute('source', { source: source.id }))}>{t('imBotManage')}</button>
        </div>
      </>}
      <div className="dt-row-meta">
        {received > 0 && <LabelValue label={t('sourceReceivedLabel')}
          value={received} />}{filtered > 0 && <LabelValue label={t('sourceFilteredLabel')} value={filtered} />}
        {lastAt && <LabelValue label={t('sourceLatestLabel')} value={when(lastAt, t('lang'))} />}
      </div>
      {source.listening && <section className="dt-source-scope" aria-label={t('sourceListeningTitle')}>
        <div className="dt-source-scope-head">
          <span className="dt-source-scope-title">{t('sourceListeningTitle')}</span>
          <button type="button" className="dt-textlink" onClick={() => navigate(settingsRoute('source', { source: source.id }))}>
            {t('sourceListeningManage')}
          </button>
        </div>
        <div className="dt-row-meta">
          <Tag tone="neutral">{t('sourceListeningGroups', { count: source.listening.chats.length })}</Tag>
          <Tag tone="quiet">{t(source.listening.directMessages ? 'sourceListeningDirectOn' : 'sourceListeningDirectOff')}</Tag>
        </div>
        {source.listening.chats.length > 0 ? <ul className="dt-source-chats">{source.listening.chats.map(chat => <li key={chat.id}
          className="dt-source-chat">
          <span className="dt-source-chat-name" title={chat.id}>{chat.name}</span>
          <Tag tone="info">{t(chat.listen === 'all' ? 'sourceListeningAll' : 'sourceListeningMentions')}</Tag>
        </li>)}</ul> : <Hint>{t('sourceListeningEmpty')}</Hint>}
        <Hint>{t('sourceListeningHint')}</Hint>
      </section>}
      {problem && <p className="dt-error">
        <SetupMessage problem={problem} lead /> <button type="button" className="dt-textlink"
          onClick={() => navigate(settingsRoute('source', { source: source.id }))}>
          {t('sourceOpenSettings')}
        </button>
      </p>}
      {notes.map(item => <p key={item.name} className={item.state === 'error' ? 'dt-error dt-clamp' : 'dt-hint dt-clamp'}>
        {valueLabel(t, 'health', item.name)}{t('labelSeparator')}<span className={item.code ? undefined : 'dt-mono'}>{healthText(t,
          item)}</span>
      </p>)}
      {source.filtered.length > 0 && <DisclosureRow icon={<Icon name="filter" />} title={t('sourceFilteredTitle')} open={filteredOpen}
        onToggle={() => setFilteredOpen(!filteredOpen)}>
        <div className="dt-disclosure-body">
          <Hint>{t('sourceFilteredHistoryHint')}</Hint>
          <ul className="dt-list">{source.filtered.map(item => <li key={item.id} className="dt-row"><Dot state="idle" /><div
            className="dt-row-main">
            {item.conversation && <div className="dt-source-conversation" title={item.conversation.id}>
              {item.conversation.direct ? t('sourceConversationDirect') : item.conversation.name || t('sourceConversationUnknown')}
            </div>}
            <div className="dt-source-message"><span title={item.actor.id}>{actorName(t, item.actor)}</span>
              {t('labelSeparator')}{readableMarkers(t, item.preview) || t('empty')}</div>
            <div className="dt-row-meta"><Tag tone="neutral">{item.reason?.code === 'chat_not_allowed'
              ? t('sourceChatFilteredAtArrival') : t('sourceFilterAtArrival', { reason: reasonLabel(t, item.reason) })}</Tag><When at={item.at} /></div>
            {item.currentScope?.listened && <div className="dt-row-meta"><Tag tone="success">{t('sourceScopeAllowedNow')}</Tag></div>}
            {item.currentScope && !item.currentScope.listened && item.currentScope.reason !== item.reason?.code && <Hint>
              {t('sourceScopeBlockedNow', { reason: reasonLabel(t, { code: item.currentScope.reason }) })}
            </Hint>}
          </div></li>)}</ul>
        </div>
      </DisclosureRow>}
      {dropped.length > 0 && <DroppedReplies items={dropped} />}
    </div>
  </li>
}

export function SourceStatus() {
  const { t, call, navigate } = usePanel()
  const { setup } = usePanelData()
  const { data, error } = usePoll(() => call('GET sources'), [])
  // Global deployment setup problems halt all Sources and show at the top; Source-specific setup problems show on that Source's row.
  const elsewhere = setup?.problem?.place === 'deployment' ? setup.problem : undefined
  return <div className="dt-form">
    <StatusHead hint={t('sourceStatusIntro')} settings="source" />
    {elsewhere && <p className="dt-error">
      <SetupMessage problem={elsewhere} lead /> <button type="button" className="dt-textlink"
        onClick={() => navigate(setupPage(elsewhere.place))}>{t('setupFixLink')}</button>
    </p>}
    <LoadState error={error} loading={!data} />
    {data && <ul className="dt-list">{data.map(source => <SourceRow key={source.id} source={source} />)}</ul>}
  </div>
}
