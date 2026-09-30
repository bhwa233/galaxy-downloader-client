import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { ArrowDown, CheckCheck, ClipboardPaste, FolderOpen, LayoutGrid, List, Pause, Play, Plus, Search, Settings2, ShieldCheck, Sparkles, X } from 'lucide-react'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Checkbox } from '@/components/ui/checkbox'
import { Field, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupTextarea } from '@/components/ui/input-group'
import { Item, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Separator } from '@/components/ui/separator'
import { Sidebar, SidebarContent, SidebarFooter, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarMenu, SidebarMenuBadge, SidebarMenuButton, SidebarMenuItem, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { Spinner } from '@/components/ui/spinner'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Toaster } from '@/components/ui/toast'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { Choice } from '@/components/downloader/Choice'
import { History } from '@/components/downloader/History'
import { MediaGrid } from '@/components/downloader/MediaCard'
import { Preview } from '@/components/downloader/Preview'
import { TaskCard, TaskInspector } from '@/components/downloader/Tasks'
import { fixableBySignIn, wallTitle } from '@/components/downloader/walls'
import { I18nextProvider, useTranslation } from 'react-i18next'
import { i18n, setLocale } from '../shared/i18n'
import { cn, formatBytes, platformLabel } from '@/lib/utils'
import type { ClientState, Command, CommandInput, Job, JobFile } from '../shared/contracts'

const Result = lazy(() => import('@/components/downloader/Result').then(module => ({ default: module.Result })))
const Preferences = lazy(() => import('@/components/downloader/Preferences').then(module => ({ default: module.Preferences })))

// Falsy when the command failed, so 'if (ok)' still reads the way it did; a success carries back
// whatever the main process wanted to say about it, which today is how many downloads it started.
export type Send = <C extends Command>(command: C, input: CommandInput<C>) => Promise<false | { added?: number; files?: JobFile[] }>
const navigation = [
  { id: 'all', icon: List },
  { id: 'running', icon: ArrowDown },
  { id: 'completed', icon: CheckCheck },
] as const
export default function App() {
  const { t } = useTranslation(['app', 'common'], { i18n })
  const [state, setState] = useState<ClientState>()
  // The language follows the settings before the state is rendered, so a switch never shows a frame in the old one.
  const apply = useCallback((next: ClientState) => { setLocale(next.settings.locale); document.documentElement.lang = next.settings.locale === 'en' ? 'en' : 'zh-CN'; setState(next) }, [])
  const [error, setError] = useState('')
  const [url, setUrl] = useState('')
  const [page, setPage] = useState<'all' | 'running' | 'completed' | 'settings' | 'new'>('all')
  const [selectedJob, setSelectedJob] = useState<string>()
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState('all')
  const [platform, setPlatform] = useState('all')
  const [sort, setSort] = useState('newest')
  const [connecting, setConnecting] = useState(false)
  const [batchBusy, setBatchBusy] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const [clearFiles, setClearFiles] = useState(false)
  const send: Send = useCallback(async (command, input) => {
    setError('')
    try { const reply = await window.desktopApi.command(command, input); if (reply.ok) { apply(reply.state); return { added: reply.added, files: reply.files } }; setError(reply.message) } catch (failure) { setError(String(failure)) }
    return false
  }, [apply])
  useEffect(() => { const unsubscribe = window.desktopApi.subscribe(apply); void send('state:get', null); return unsubscribe }, [send, apply])
  const theme = state?.settings.theme
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => { document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && media.matches)) }
    apply(); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply)
  }, [theme])
  if (!state) return <main className="grid min-h-screen place-items-center"><p role="status">{error || t('starting')}</p></main>
  const active = state.jobs.filter(job => job.status === 'running')
  const speed = active.reduce((sum, job) => sum + (job.speed || 0), 0)
  const query = search.trim().toLocaleLowerCase()
  const jobs = state.jobs.filter(job => (page === 'all' || job.status === page) && (kind === 'all' || (job.kind || (job.audioOnly ? 'audio' : 'video')) === kind) && (platform === 'all' || job.platform === platform) && (!query || `${job.title} ${job.platform} ${job.url}`.toLocaleLowerCase().includes(query))).sort((a, b) => sort === 'oldest' ? a.createdAt.localeCompare(b.createdAt) : sort === 'progress' ? b.progress - a.progress : sort === 'title' ? a.title.localeCompare(b.title) : b.createdAt.localeCompare(a.createdAt))
  const title = t(`nav.${page}`)
  const batch = (action: 'pause' | 'resume') => { setBatchBusy(true); void send('jobs:batch', { action }).finally(() => setBatchBusy(false)) }
  const paste = async () => { setPage('new'); try { const reply = await window.desktopApi.command('clipboard:read', null); if (reply.ok) setUrl(reply.clipboardText || ''); else setError(reply.message) } catch { setError(t('clipboardFailed')) } }
  const login = (url = '') => { setConnecting(true); void send('browser:login', { url }).finally(() => setConnecting(false)) }
  const browserState = state.browser.sites ? t('browserSessions', { count: state.browser.sites }) : t('browserNoSessions')
  const errorBanner = error && <Alert variant="destructive">
    <AlertTitle>{t('actionFailed')}</AlertTitle>
    <AlertDescription>{error}</AlertDescription>
    <AlertAction><Button variant="ghost" size="icon" aria-label={t('dismissError')} onClick={() => setError('')}><X /></Button></AlertAction>
  </Alert>
  return <I18nextProvider i18n={i18n}><Toaster><TooltipProvider><SidebarProvider>
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-1 py-1.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Sparkles className="size-4" /></div>
          <div className="grid leading-tight group-data-[collapsible=icon]:hidden"><span className="text-sm font-semibold">Galaxy</span><span className="text-xs text-muted-foreground">{t('appSubtitle')}</span></div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup><SidebarGroupContent><SidebarMenu>
          <SidebarMenuItem><SidebarMenuButton tooltip={t('nav.new')} isActive={page === 'new'} onClick={() => setPage('new')}><Plus /><span>{t('nav.new')}</span></SidebarMenuButton></SidebarMenuItem>
        </SidebarMenu></SidebarGroupContent></SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>{t('workspace')}</SidebarGroupLabel>
          <SidebarGroupContent><SidebarMenu>{navigation.map(({ id, icon: Icon }) => <SidebarMenuItem key={id}>
            <SidebarMenuButton tooltip={t(`nav.${id}`)} isActive={page === id} onClick={() => setPage(id)}><Icon /><span>{t(`nav.${id}`)}</span></SidebarMenuButton>
            <SidebarMenuBadge>{id === 'all' ? state.jobs.length : state.jobs.filter(job => job.status === id).length}</SidebarMenuBadge>
          </SidebarMenuItem>)}</SidebarMenu></SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <Item variant="muted" size="sm" className="group-data-[collapsible=icon]:hidden">
          <ItemMedia><ArrowDown className="size-4" /></ItemMedia>
          <ItemContent><ItemTitle className="tabular-nums">{formatBytes(speed)}<span className="text-muted-foreground"> /s</span></ItemTitle><ItemDescription>{t('activeDownloads', { count: active.length })}</ItemDescription></ItemContent>
        </Item>
        <SidebarMenu>
          <SidebarMenuItem><SidebarMenuButton tooltip={t('nav.settings')} isActive={page === 'settings'} onClick={() => setPage('settings')}><Settings2 /><span>{t('nav.settings')}</span></SidebarMenuButton></SidebarMenuItem>
          <SidebarMenuItem><div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden"><ShieldCheck className="size-3.5" />{t('localOnly')}</div></SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
    <SidebarInset className="h-svh">
      <header className="flex h-16 shrink-0 items-center gap-2 border-b px-4">
        <SidebarTrigger />
        <Separator orientation="vertical" className="mr-1 h-5" />
        <div className="grid leading-tight">
          <span className="text-[10px] tracking-[0.18em] text-muted-foreground">GALAXY DOWNLOADER</span>
          <h1 className="text-base font-semibold">{title}</h1>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger render={<span className="flex items-center px-1" role="img" aria-label={browserState} />}><span className={cn('size-2 rounded-full', state.browser.sites ? 'bg-emerald-500' : 'bg-muted-foreground')} /></TooltipTrigger>
            <TooltipContent>{browserState}</TooltipContent>
          </Tooltip>
        </div>
      </header>
      <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-6">
        {page !== 'new' && !selectedJob && errorBanner}
        {page === 'settings' ? <Suspense fallback={<p role="status">{t('openingSettings')}</p>}><Preferences key="preferences" state={state} send={send} /></Suspense> : page === 'new' ? <div className="flex flex-col gap-4">
            {errorBanner}
            {/* One link at a time, so the box is two lines and never grows: what gets pasted is often a
                whole share message - 抖音 and 小红书 put the link inside a sentence - and the link is taken
                out of it before parsing. Enter parses; there is no new line to type. Pasting and parsing
                sit under it, half the width each; while a parse runs, the second offers to stop it rather
                than a third button appearing. */}
            <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); if (url.trim()) void send('media:parse', { url }) }}>
              <InputGroup>
                <InputGroupTextarea id="media-url" aria-label={t('mediaUrl')} rows={2} className="min-h-0 field-sizing-fixed" placeholder={t('mediaUrlPlaceholder')} value={url}
                  onChange={event => setUrl(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} />
              </InputGroup>
              <div className="grid grid-cols-2 gap-2">
                <Button type="button" size="lg" variant="outline" onClick={() => void paste()}><ClipboardPaste />{t('pasteLink')}</Button>
                {state.parse.status === 'parsing'
                  ? <Button type="button" size="lg" variant="outline" onClick={() => void send('media:cancel', null)}><Spinner aria-hidden="true" />{t('cancelParse')}</Button>
                  : <Button type="submit" size="lg" disabled={!url.trim()}>{t('parse')}<kbd aria-hidden="true" className="rounded border border-current/30 px-1 font-sans text-[11px] leading-4 opacity-70">Enter</kbd></Button>}
              </div>
            </form>
            {/* A message arriving alongside a result belongs to a page the user turned, and is shown
                down beside the pager they clicked rather than up here, above everything they read. */}
            {/* The four permission walls are named apart from each other and from an ordinary failure:
                only one of them is fixed by signing in, and 'encrypted' is fixed by nothing, so it is
                the one that gets no button. */}
            {state.parse.message && !state.parse.result && <Alert variant="destructive">
              <AlertTitle>{state.parse.verify ? t('common:verifyTitle') : (state.parse.wall && wallTitle(state.parse.wall)) || t('parseFailed')}</AlertTitle>
              <AlertDescription>{state.parse.message}</AlertDescription>
              {(state.parse.verify || fixableBySignIn(state.parse.wall)) && <AlertAction><Button variant="outline" size="sm" disabled={connecting} onClick={() => login(state.parse.loginUrl || '')}>{state.parse.verify ? t('common:openVerify') : t('common:openLogin')}</Button></AlertAction>}
            </Alert>}
            {/* Closing a result clears it, which is what the ✕ beside it means; it no longer leaves the page. */}
            {state.parse.result && <Suspense fallback={<p role="status">{t('showingResult')}</p>}><Result key={state.parse.result.id} result={state.parse.result} parse={state.parse} settings={state.settings} send={send} login={login} connecting={connecting} close={() => void send('media:cancel', null)} /></Suspense>}
            {/* Only while no result is on screen: the result is what is being worked on, and closing it
                brings the way back to earlier parses. */}
            {!state.parse.result && <History entries={state.history} send={send} parsing={state.parse.status === 'parsing'}
              reparse={address => { setUrl(address); void send('media:parse', { url: address }) }} />}
          </div> : <>
          <Card>
            <CardHeader>
              <CardTitle>{title}</CardTitle>
              <CardDescription>{t('common:items', { count: jobs.length })}</CardDescription>
              <CardAction className="flex gap-1">
                <Button variant="ghost" size="sm" disabled={batchBusy || !state.jobs.some(job => ['paused', 'failed', 'queued'].includes(job.status))} onClick={() => batch('resume')}><Play />{t('startAll')}</Button>
                <Button variant="ghost" size="sm" disabled={batchBusy || !state.jobs.some(job => ['running', 'queued'].includes(job.status))} onClick={() => batch('pause')}><Pause />{t('pauseAll')}</Button>
                <AlertDialog open={clearOpen} onOpenChange={open => { setClearOpen(open); if (!open) setClearFiles(false) }}>
                  <AlertDialogTrigger render={<Button variant="ghost" size="sm" disabled={!state.jobs.some(job => ['completed', 'failed', 'cancelled'].includes(job.status))} />}>{t('clearRecords')}</AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t('clearTitle')}</AlertDialogTitle>
                      <AlertDialogDescription>{t('clearDescription', { files: clearFiles ? t('clearDeletesFiles') : t('clearKeepsFiles') })}</AlertDialogDescription>
                    </AlertDialogHeader>
                    {/* Off every time the dialog opens: deleting files is a thing to ask for, never a
                        setting that quietly carries over from the last time records were cleared. */}
                    <Field orientation="horizontal" className="w-fit">
                      <Checkbox id="clear-delete-files" checked={clearFiles} onCheckedChange={checked => setClearFiles(checked === true)} />
                      <FieldLabel htmlFor="clear-delete-files" className="font-normal">{t('clearAlsoDelete')}</FieldLabel>
                    </Field>
                    <AlertDialogFooter>
                      <AlertDialogCancel render={<Button variant="outline" />}>{t('keepRecords')}</AlertDialogCancel>
                      <AlertDialogAction render={<Button onClick={() => void send('jobs:clear', { deleteFiles: clearFiles }).then(ok => { if (ok) setClearOpen(false) })} />}>{t('clearRecords')}</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-wrap items-end gap-3">
                <InputGroup className="min-w-52 flex-1">
                  <InputGroupInput aria-label={t('searchTasks')} placeholder={t('searchPlaceholder')} value={search} onChange={event => setSearch(event.target.value)} />
                  <InputGroupAddon><Search /></InputGroupAddon>
                </InputGroup>
                <Choice className="w-36" label={t('filters.kind')} value={kind} onChange={setKind} options={[{ value: 'all', label: t('filters.allKinds') }, ...(['video', 'audio', 'image'] as const).map(value => ({ value, label: t(`common:kinds.${value}`) }))]} />
                <Choice className="w-36" label={t('filters.platform')} value={platform} onChange={setPlatform} options={[{ value: 'all', label: t('filters.allPlatforms') }, ...[...new Set(state.jobs.map(job => job.platform))].map(value => ({ value, label: platformLabel(value) }))]} />
                <Choice className="w-36" label={t('filters.sort')} value={sort} onChange={setSort} options={(['newest', 'oldest', 'progress', 'title'] as const).map(value => ({ value, label: t(`filters.${value}`) }))} />
                <ToggleGroup className="mb-1" spacing={0} variant="outline" value={[state.settings.view]} onValueChange={value => { const view = value[0]; if (view && view !== state.settings.view) void send('settings:save', { ...state.settings, view: view as ClientState['settings']['view'] }) }}>
                  <ToggleGroupItem value="list" aria-label={t('listView')}><List /></ToggleGroupItem>
                  <ToggleGroupItem value="grid" aria-label={t('gridView')}><LayoutGrid /></ToggleGroupItem>
                </ToggleGroup>
              </div>
              {jobs.length ? state.settings.view === 'grid'
                ? <MediaGrid minWidth="20rem">{jobs.map(job => <TaskCard key={job.id} job={job} send={send} select={() => setSelectedJob(job.id)} view="grid" density={state.settings.density} />)}</MediaGrid>
                : <ItemGroup className="gap-1">{jobs.map(job => <TaskCard key={job.id} job={job} send={send} select={() => setSelectedJob(job.id)} view="list" density={state.settings.density} />)}</ItemGroup>
                : <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon"><FolderOpen /></EmptyMedia>
                    <EmptyTitle><h3>{state.jobs.length ? t('empty.noMatchTitle') : t('empty.emptyTitle')}</h3></EmptyTitle>
                    <EmptyDescription>{state.jobs.length ? t('empty.noMatchDescription') : t('empty.emptyDescription')}</EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent><Button variant="outline" onClick={() => { if (state.jobs.length) { setSearch(''); setKind('all'); setPlatform('all'); setPage('all') } else setPage('new') }}>{state.jobs.length ? t('empty.showAll') : t('empty.addFirst')}</Button></EmptyContent>
                </Empty>}
            </CardContent>
          </Card>
          <footer className="flex justify-between gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5"><ShieldCheck className="size-3.5" />{t('localFooter')}</span>
            <span className="flex max-w-1/2 items-center gap-1.5 truncate" title={state.settings.downloadDirectory}><FolderOpen className="size-3.5 shrink-0" /><span className="truncate">{state.settings.downloadDirectory}</span></span>
          </footer>
        </>}
      </main>
    </SidebarInset>
    <TaskInspector error={error} job={state.jobs.find((job: Job) => job.id === selectedJob)} send={send} close={() => setSelectedJob(undefined)} />
    <Preview preview={state.preview} send={send} />
  </SidebarProvider></TooltipProvider></Toaster></I18nextProvider>
}
