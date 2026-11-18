import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Bell, Check, CheckCheck, Clock, ExternalLink, LogIn, Pause, Play, Plus, RefreshCw, Search, Settings2, Trash2 } from 'lucide-react'
import type { ClientState } from '../../../shared/contracts'
import { subscriptionPlatforms, type SubscriptionCandidate, type SubscriptionItem, type SubscriptionPlatform, type SubscriptionSource, type SubscriptionType } from '../../../shared/subscriptions'
import type { Send } from '@/App'
import { i18n } from '../../../shared/i18n'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldSet, FieldLegend } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { ItemGroup } from '@/components/ui/item'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Choice } from './Choice'
import { MediaCover } from './MediaCard'
import { TaskListRow } from './Tasks'
import { formatDuration } from '@/lib/utils'

const moment = (value?: number) => value === undefined ? i18n.t('subscriptions:never') : new Date(value).toLocaleString(i18n.language === 'en' ? 'en-US' : 'zh-CN')
const emptyState = { sources: [], items: [], checking: false }

export function Subscriptions({ state, send, parse, parseAuthor, settings, error }: {
  state: ClientState; send: Send; parse: (item: SubscriptionItem) => void; parseAuthor: (source: SubscriptionSource) => void; settings: () => void; error?: string;
}) {
  const { t } = useTranslation('subscriptions')
  const subscriptions = state.subscriptions || emptyState
  const [tab, setTab] = useState('updates')
  const [unread, setUnread] = useState('unread')
  const [query, setQuery] = useState('')
  const [platform, setPlatform] = useState('all')
  const [author, setAuthor] = useState('all')
  const [selected, setSelected] = useState<string>()
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState(false)
  const [shown, setShown] = useState(120)
  const source = subscriptions.sources.find(source => source.id === selected)
  const focusToken = state.subscriptions?.focus?.token
  const focusSourceId = state.subscriptions?.focus?.sourceId
  useEffect(() => {
    if (!focusToken || !focusSourceId) return
    setTab('updates'); setAuthor(focusSourceId); setPlatform('all'); setQuery(''); setUnread('unread')
  }, [focusToken, focusSourceId])
  useEffect(() => { setShown(120) }, [query, platform, author, tab, unread])
  // Removing a source also removes a selected filter, instead of leaving an invisible empty filter.
  useEffect(() => {
    if (author !== 'all' && !subscriptions.sources.some(source => source.id === author)) setAuthor('all')
  }, [author, subscriptions.sources])
  const needle = query.trim().toLocaleLowerCase()
  const matchesSource = (source: SubscriptionSource) => (platform === 'all' || source.platform === platform) && (author === 'all' || source.id === author)
  const authors = subscriptions.sources.filter(source => platform === 'all' || source.platform === platform)
  const sources = subscriptions.sources.filter(source => matchesSource(source) && (!needle || (source.name + ' ' + source.url + ' ' + (source.latestTitle || '')).toLocaleLowerCase().includes(needle)))
  const bySource = new Map(subscriptions.sources.map(source => [source.id, source]))
  const items = subscriptions.items.filter(item => {
    const source = bySource.get(item.sourceId)
    return source && matchesSource(source) && (unread !== 'unread' || !item.read) && (!needle || (source.name + ' ' + item.title + ' ' + item.url).toLocaleLowerCase().includes(needle))
  }).sort((a, b) => b.discoveredAt - a.discoveredAt || (b.publishedAt || 0) - (a.publishedAt || 0))
  const count = subscriptions.items.filter(item => !item.read).length
  const status = (source: SubscriptionSource) => <Badge variant={source.enabled && ['failed', 'needs-login'].includes(source.status) ? 'destructive' : 'secondary'}>
    {source.enabled ? t(`status.${source.status}`) : t('paused')}
  </Badge>
  const schedule = state.subscriptions?.schedule
  const enabled = subscriptions.sources.some(source => source.enabled)
  const checkSource = (source: SubscriptionSource) => void send('subscriptions:check', { id: source.id })
  return <Tabs value={tab} onValueChange={setTab} className="flex w-full min-w-0 flex-col gap-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
        <TabsList><TabsTrigger value="updates">{t('updates')} <span className="tabular-nums">{count}</span></TabsTrigger>
          <TabsTrigger value="manage">{t('manage')} <span className="tabular-nums">{subscriptions.sources.length}</span></TabsTrigger></TabsList>
      <div className="flex gap-2">
        <Button variant="outline" disabled={subscriptions.checking || !subscriptions.sources.some(source => source.enabled)} onClick={() => void send('subscriptions:check', {})}>
          {subscriptions.checking ? <Spinner /> : <RefreshCw />}{t(subscriptions.checking ? 'checking' : 'check')}
        </Button>
        <Button onClick={() => setAdding(true)}><Plus />{t('add')}</Button>
      </div>
    </div>
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <Clock className="size-3.5" /><span>{state.settings.subscriptionAutomatic ? t('schedule', { hours: state.settings.subscriptionIntervalHours }) : t('automaticOff')}</span>
      <span>{t('lastCheck')}：{moment(schedule?.lastCheckedAt)}</span>
      <span>{t('nextCheck')}：{!enabled ? t('noEnabled') : state.settings.subscriptionAutomatic ? moment(schedule?.nextCheckAt) : t('automaticOff')}</span>
      {schedule?.progress ? <span role="status">{t('roundProgress', schedule.progress)}</span> : schedule?.result && <span>{t('roundResult', schedule.result)}{schedule.result.skipped > 0 && ' · ' + t('roundSkipped', { count: schedule.result.skipped })}</span>}
      <Button variant="link" size="sm" onClick={settings}><Settings2 />{t('settings')}</Button>
    </div>
    <div className="flex flex-wrap items-end gap-3">
      {tab === 'updates' && <ToggleGroup value={[unread]} onValueChange={values => { if (values[0]) setUnread(values[0]) }} aria-label={t('unread')}>
        <ToggleGroupItem value="unread">{t('unread')}</ToggleGroupItem><ToggleGroupItem value="all">{t('all')}</ToggleGroupItem>
      </ToggleGroup>}
      <InputGroup className="min-w-44 flex-1"><InputGroupInput value={query} onChange={event => setQuery(event.target.value)} aria-label={t('search')} placeholder={t('searchPlaceholder')} /><InputGroupAddon><Search /></InputGroupAddon></InputGroup>
      <Choice className="w-36" label={t('platform')} value={platform} onChange={value => { setPlatform(value); setAuthor('all') }} options={[{ value: 'all', label: t('allPlatforms') }, ...Object.keys(subscriptionPlatforms).map(value => ({ value, label: t(`platforms.${value as SubscriptionPlatform}`) }))]} />
      <Choice className="w-52" label={t('author')} value={author} onChange={setAuthor} options={[{ value: 'all', label: t('allAuthors') }, ...authors.map(source => ({ value: source.id, label: source.name + ' · ' + t(`platforms.${source.platform}`) }))]} />
      {tab === 'updates' && <Button variant="ghost" disabled={!items.some(item => !item.read)} onClick={() => void send('subscriptions:read', { ids: items.map(item => item.id), read: true })}><CheckCheck />{t('markAll')}</Button>}
    </div>
    <TabsContent value={tab} className="flex w-full min-w-0 flex-col gap-4">{tab === 'updates' && items.length > 0 ? <>
      <ItemGroup className="gap-1">{items.slice(0, shown).map(item => {
        const source = bySource.get(item.sourceId)!
        return <TaskListRow key={item.id} title={item.title} density={state.settings.density}
          select={() => parse(item)} selectLabel={t('parse') + '：' + item.title}
          cover={<MediaCover kind={item.type === 'image' ? 'image' : 'video'} thumbnail={item.thumbnail} className="size-full rounded-md">
            {item.duration !== undefined && <span className="absolute right-0.5 bottom-0.5 rounded bg-background/80 px-1 text-[10px]">{formatDuration(item.duration)}</span>}
          </MediaCover>}
          subtitle={<><button className="hover:underline" onClick={() => setSelected(source.id)}>{source.name}</button> · {t(`platforms.${source.platform}`)} · {item.publishedAt ? t('published', { time: moment(item.publishedAt * 1000) }) : t('discovered', { time: moment(item.discoveredAt) })}</>}
          status={<span className="text-xs text-muted-foreground">{!item.read && t('unread')} · {t(`types.${item.type}`)}</span>}
          actions={<><Button variant="ghost" size="icon-sm" aria-label={t('open') + '：' + item.title} title={t('open')} onClick={() => void send('subscriptions:open', { id: item.id, action: 'work' })}><ExternalLink /></Button>
            <Button variant="outline" size="sm" onClick={() => parse(item)}><Search data-icon="inline-start" />{t('parse')}</Button>
            <Button variant="ghost" size="icon-sm" aria-label={t(item.read ? 'unreadAction' : 'read') + '：' + item.title} onClick={() => void send('subscriptions:read', { ids: [item.id], read: !item.read })}><Check /></Button></>} />
      })}</ItemGroup>
      {items.length > shown && <Button variant="outline" className="self-center" onClick={() => setShown(value => value + 120)}>{t('more')}</Button>}
      <p className="text-xs text-muted-foreground">{t('summary', { count: items.length })}</p>
    </> : tab === 'manage' && sources.length > 0 ? <>
      <ItemGroup className="gap-1">{sources.slice(0, shown).map(source => <TaskListRow key={source.id} title={source.name}
        subtitle={<span className="block truncate" title={source.latestTitle || t('noRecent')}>{t(`platforms.${source.platform}`)} · {t('recent')}：{source.latestTitle || t('noRecent')}</span>}
        density={state.settings.density} select={() => setSelected(source.id)} selectLabel={t('details') + '：' + source.name}
        coverShape="square" cover={<MediaCover kind="image" thumbnail={source.avatar} className="size-full rounded-md" />}
        status={status(source)}
        actions={<>
          <Button variant="ghost" size="icon-sm" disabled={!source.enabled || source.status === 'checking'} aria-label={t('check') + '：' + source.name} onClick={() => checkSource(source)}>{source.status === 'checking' ? <Spinner /> : <RefreshCw />}</Button>
          {source.status === 'needs-login' && <Button variant="outline" size="sm" onClick={() => void send('subscriptions:open', { id: source.id, action: 'login' })}><LogIn />{t('login')}</Button>}
          <Button variant="ghost" size="icon-sm" aria-label={t(source.enabled ? 'pause' : 'resume') + '：' + source.name} onClick={() => void send('subscriptions:update', { id: source.id, enabled: !source.enabled })}>{source.enabled ? <Pause /> : <Play />}</Button>
        </>}>
        {source.error && <p className={source.status === 'partial' ? 'text-xs text-muted-foreground' : 'text-xs text-destructive'}>{source.error}</p>}
      </TaskListRow>)}</ItemGroup>
      {sources.length > shown && <Button variant="outline" className="self-center" onClick={() => setShown(value => value + 120)}>{t('more')}</Button>}
      <p className="text-xs text-muted-foreground">{t('sourceSummary', { count: sources.length })}</p>
    </> : <Empty><EmptyHeader><EmptyMedia variant="icon"><Bell /></EmptyMedia>
      <EmptyTitle>{!subscriptions.sources.length ? t('emptyTitle') : needle || platform !== 'all' || author !== 'all' ? t('noMatch') : t('noUpdates')}</EmptyTitle>
      <EmptyDescription>{!subscriptions.sources.length ? t('emptyHint') : needle || platform !== 'all' || author !== 'all' ? t('noMatchHint') : t('noUpdatesHint')}</EmptyDescription></EmptyHeader>
      {!subscriptions.sources.length && <EmptyContent><Button onClick={() => setAdding(true)}><Plus />{t('add')}</Button></EmptyContent>}
    </Empty>}</TabsContent>
    <AddSubscription open={adding} change={setAdding} send={send} error={error} login={state.subscriptions?.resolveLogin} added={() => { setTab('manage'); setAuthor('all'); setPlatform('all'); setQuery('') }} />
    <Sheet open={Boolean(source)} onOpenChange={open => { if (!open) setSelected(undefined) }}><SheetContent className="sm:max-w-lg">
      <SheetHeader><SheetTitle>{t('details')}</SheetTitle><SheetDescription>{t('detailsHint')}</SheetDescription></SheetHeader>
      {source && <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-4 pb-4">
        <div className="flex items-center justify-between gap-3"><h2 className="text-base font-medium">{source.name}</h2>{status(source)}</div>
        <p className="text-sm text-muted-foreground">{t(`platforms.${source.platform}`)} · {source.types.map(type => t(`types.${type}`)).join(' / ')}</p>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => { setSelected(undefined); parseAuthor(source) }}><Search data-icon="inline-start" />{t('parseAuthorPage')}</Button>
          <Button variant="ghost" size="icon" aria-label={t('authorPage')} title={t('authorPage')} onClick={() => void send('subscriptions:open', { id: source.id, action: 'author' })}><ExternalLink /></Button>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-sm"><dt className="text-muted-foreground">{t('lastCheck')}</dt><dd>{moment(source.lastCheckedAt)}</dd>
          <dt className="text-muted-foreground">{t('lastSuccess')}</dt><dd>{moment(source.lastSuccessAt)}</dd>
          <dt className="text-muted-foreground">{t('nextCheck')}</dt><dd>{!source.enabled ? t('paused') : state.settings.subscriptionAutomatic ? moment(source.nextCheckAt) : t('automaticOff')}</dd></dl>
        <Field orientation="horizontal"><FieldLabel htmlFor="subscription-source-notify">{t('notify')}</FieldLabel><Switch id="subscription-source-notify" checked={source.notify} onCheckedChange={notify => void send('subscriptions:update', { id: source.id, notify })} /></Field>
        {source.error && <Alert variant={source.status === 'partial' ? 'default' : 'destructive'}><AlertTitle>{t(`status.${source.status}`)}</AlertTitle><AlertDescription>{source.error}</AlertDescription></Alert>}
        {source.status === 'needs-login' && <Button variant="outline" onClick={() => void send('subscriptions:open', { id: source.id, action: 'login' })}><LogIn />{t('login')}</Button>}
        <Button variant="outline" disabled={!source.enabled || source.status === 'checking'} onClick={() => checkSource(source)}><RefreshCw />{t('check')}</Button>
        <div className="flex flex-col gap-3"><h3 className="text-sm font-medium">{t('recent')}</h3>
          {subscriptions.items.filter(item => item.sourceId === source.id).slice(0, 5).map(item => <div className="flex items-start gap-2" key={item.id}>
            <button className="min-w-0 flex-1 text-left text-sm hover:underline" onClick={() => { setSelected(undefined); parse(item) }} title={t('parse') + '：' + item.title}>{item.title}</button>
            <Button variant="ghost" size="icon-sm" aria-label={t('open') + '：' + item.title} title={t('open')} onClick={() => void send('subscriptions:open', { id: item.id, action: 'work' })}><ExternalLink /></Button>
          </div>)}
        </div>
        <div className="mt-auto flex justify-between gap-3"><Button variant="ghost" className="text-destructive" onClick={() => setRemoving(true)}><Trash2 />{t('remove')}</Button>
          <Button variant="outline" onClick={() => void send('subscriptions:update', { id: source.id, enabled: !source.enabled })}>{source.enabled ? <Pause /> : <Play />}{t(source.enabled ? 'pause' : 'resume')}</Button></div>
      </div>}
    </SheetContent></Sheet>
    <AlertDialog open={removing} onOpenChange={setRemoving}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{t('removeTitle')}</AlertDialogTitle><AlertDialogDescription>{t('removeHint')}</AlertDialogDescription></AlertDialogHeader>
      <AlertDialogFooter><AlertDialogCancel render={<Button variant="outline" />}>{t('cancel')}</AlertDialogCancel><AlertDialogAction render={<Button variant="destructive" onClick={() => { if (source) void send('subscriptions:remove', { id: source.id }).then(ok => { if (ok) { setRemoving(false); setSelected(undefined) } }) }} />}>{t('remove')}</AlertDialogAction></AlertDialogFooter>
    </AlertDialogContent></AlertDialog>
  </Tabs>
}

function AddSubscription({ open, change, send, error, added, login }: { open: boolean; change: (open: boolean) => void; send: Send; error?: string; added: () => void; login?: { url: string; verify: boolean } }) {
  const { t } = useTranslation('subscriptions')
  const [url, setUrl] = useState('')
  const [candidate, setCandidate] = useState<SubscriptionCandidate>()
  const [types, setTypes] = useState<SubscriptionType[]>([])
  const [notify, setNotify] = useState(true)
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const reset = (value: boolean) => { generation.current += 1; setCandidate(undefined); setBusy(false); change(value) }
  const resolve = async () => {
    const current = ++generation.current
    setBusy(true); setCandidate(undefined)
    const reply = await send('subscriptions:resolve', { url })
    if (generation.current !== current) return
    if (reply && reply.subscriptionCandidate) { setCandidate(reply.subscriptionCandidate); setTypes(reply.subscriptionCandidate.types) }
    setBusy(false)
  }
  return <Dialog open={open} onOpenChange={reset}><DialogContent>
    <DialogHeader><DialogTitle>{t('addTitle')}</DialogTitle><DialogDescription>{t('addHint')}</DialogDescription></DialogHeader>
    <FieldGroup>
      <Field><FieldLabel htmlFor="subscription-url">{t('url')}</FieldLabel><div className="flex gap-2">
        <Input id="subscription-url" value={url} onChange={event => { generation.current += 1; setUrl(event.target.value); setCandidate(undefined); setBusy(false) }} onKeyDown={event => { if (event.key === 'Enter' && url.trim() && !busy) { event.preventDefault(); void resolve() } }} placeholder="https://…" />
        <Button variant="outline" disabled={busy || !url.trim()} onClick={() => void resolve()}>{busy ? <Spinner /> : <Search />}{t(busy ? 'recognizing' : 'recognize')}</Button>
      </div></Field>
      {error && !busy && <Alert variant="destructive"><AlertTitle>{t('addTitle')}</AlertTitle><AlertDescription>{error}
        {login && <div className="mt-2 flex flex-col items-start gap-2"><Button variant="outline" onClick={() => void send('browser:login', { url: login.url })}><LogIn />{t(login.verify ? 'verify' : 'login')}</Button><p>{t('identifyAfterLogin')}</p></div>}
      </AlertDescription></Alert>}
      {candidate && <>
        <div className="flex items-center gap-3"><MediaCover kind="image" thumbnail={candidate.avatar} className="size-12 shrink-0 rounded-md" /><div className="min-w-0"><p className="text-sm font-medium">{candidate.name}</p><p className="text-xs text-muted-foreground">{t(`platforms.${candidate.platform}`)}</p></div></div>
        <FieldSet><FieldLegend>{t('content')}</FieldLegend><div className="flex flex-wrap gap-4">{candidate.types.map(type => <Field key={type} orientation="horizontal" className="w-fit"><Checkbox id={'subscription-type-' + type} checked={types.includes(type)} onCheckedChange={checked => setTypes(current => checked ? [...new Set([...current, type])] : current.filter(value => value !== type))} /><FieldLabel htmlFor={'subscription-type-' + type}>{t(`types.${type}`)}</FieldLabel></Field>)}</div></FieldSet>
        <Field orientation="horizontal"><FieldLabel htmlFor="subscription-notify">{t('notify')}</FieldLabel><Switch id="subscription-notify" checked={notify} onCheckedChange={setNotify} /></Field>
        <div className="flex flex-col gap-1"><p className="text-xs text-muted-foreground">{t('recent')}</p>{candidate.recent.slice(0, 3).map((item, index) => <p className="truncate text-sm" key={index} title={item.title}>{item.title}</p>)}</div>
      </>}
      <FieldDescription>{t('baselineHint')}</FieldDescription>
    </FieldGroup>
    <DialogFooter><Button variant="outline" onClick={() => reset(false)}>{t('cancel')}</Button><Button disabled={!candidate || !types.length || busy} onClick={() => {
      if (!candidate) return
      setBusy(true); void send('subscriptions:add', { token: candidate.token, types, notify }).then(ok => { if (ok) { added(); reset(false) } else setBusy(false) })
    }}>{busy && candidate ? <Spinner /> : <Plus />}{t('add')}</Button></DialogFooter>
  </DialogContent></Dialog>
}
