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
import { fixableBySignIn, wallTitles } from '@/components/downloader/walls'
import { DictionaryContext, dictionaries } from '@/i18n/client'
import { cn, formatBytes } from '@/lib/utils'
import type { ClientState, Command, CommandInput, Job, JobFile } from '../shared/contracts'

const Result = lazy(() => import('@/components/downloader/Result').then(module => ({ default: module.Result })))
const Preferences = lazy(() => import('@/components/downloader/Preferences').then(module => ({ default: module.Preferences })))

// Falsy when the command failed, so 'if (ok)' still reads the way it did; a success carries back
// whatever the main process wanted to say about it, which today is how many downloads it started.
export type Send = <C extends Command>(command: C, input: CommandInput<C>) => Promise<false | { added?: number; files?: JobFile[] }>
const navigation = [
  { id: 'all', label: '全部任务', icon: List },
  { id: 'running', label: '下载中', icon: ArrowDown },
  { id: 'completed', label: '已完成', icon: CheckCheck },
] as const
export default function App() {
  const [state, setState] = useState<ClientState>()
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
    try { const reply = await window.desktopApi.command(command, input); if (reply.ok) { setState(reply.state); return { added: reply.added, files: reply.files } }; setError(reply.message) } catch (failure) { setError(String(failure)) }
    return false
  }, [])
  useEffect(() => { const unsubscribe = window.desktopApi.subscribe(setState); void send('state:get', null); return unsubscribe }, [send])
  const theme = state?.settings.theme
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => { document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && media.matches)) }
    apply(); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply)
  }, [theme])
  if (!state) return <main className="grid min-h-screen place-items-center"><p role="status">{error || '正在启动本地客户端…'}</p></main>
  const active = state.jobs.filter(job => job.status === 'running')
  const speed = active.reduce((sum, job) => sum + (job.speed || 0), 0)
  const query = search.trim().toLocaleLowerCase()
  const jobs = state.jobs.filter(job => (page === 'all' || job.status === page) && (kind === 'all' || (job.kind || (job.audioOnly ? 'audio' : 'video')) === kind) && (platform === 'all' || job.platform === platform) && (!query || `${job.title} ${job.platform} ${job.url}`.toLocaleLowerCase().includes(query))).sort((a, b) => sort === 'oldest' ? a.createdAt.localeCompare(b.createdAt) : sort === 'progress' ? b.progress - a.progress : sort === 'title' ? a.title.localeCompare(b.title) : b.createdAt.localeCompare(a.createdAt))
  const title = page === 'settings' ? '设置' : page === 'new' ? '新建任务' : navigation.find(item => item.id === page)?.label || '任务'
  const batch = (action: 'pause' | 'resume') => { setBatchBusy(true); void send('jobs:batch', { action }).finally(() => setBatchBusy(false)) }
  const paste = async () => { setPage('new'); try { const reply = await window.desktopApi.command('clipboard:read', null); if (reply.ok) setUrl(reply.clipboardText || ''); else setError(reply.message) } catch { setError('无法读取剪贴板，请在输入框中粘贴链接。') } }
  const login = (url = '') => { setConnecting(true); void send('browser:login', { url }).finally(() => setConnecting(false)) }
  const browserState = state.browser.sites ? `应用内浏览器 · ${state.browser.sites} 个站点有会话` : '应用内浏览器暂无会话'
  const errorBanner = error && <Alert variant="destructive">
    <AlertTitle>操作未完成</AlertTitle>
    <AlertDescription>{error}</AlertDescription>
    <AlertAction><Button variant="ghost" size="icon" aria-label="关闭错误提示" onClick={() => setError('')}><X /></Button></AlertAction>
  </Alert>
  return <DictionaryContext.Provider value={dictionaries[state.settings.locale]}><Toaster><TooltipProvider><SidebarProvider>
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <div className="flex items-center gap-2 px-1 py-1.5">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground"><Sparkles className="size-4" /></div>
          <div className="grid leading-tight group-data-[collapsible=icon]:hidden"><span className="text-sm font-semibold">Galaxy</span><span className="text-xs text-muted-foreground">媒体下载管理器</span></div>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup><SidebarGroupContent><SidebarMenu>
          <SidebarMenuItem><SidebarMenuButton tooltip="新建任务" isActive={page === 'new'} onClick={() => setPage('new')}><Plus /><span>新建任务</span></SidebarMenuButton></SidebarMenuItem>
        </SidebarMenu></SidebarGroupContent></SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>工作空间</SidebarGroupLabel>
          <SidebarGroupContent><SidebarMenu>{navigation.map(({ id, label, icon: Icon }) => <SidebarMenuItem key={id}>
            <SidebarMenuButton tooltip={label} isActive={page === id} onClick={() => setPage(id)}><Icon /><span>{label}</span></SidebarMenuButton>
            <SidebarMenuBadge>{id === 'all' ? state.jobs.length : state.jobs.filter(job => job.status === id).length}</SidebarMenuBadge>
          </SidebarMenuItem>)}</SidebarMenu></SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <Item variant="muted" size="sm" className="group-data-[collapsible=icon]:hidden">
          <ItemMedia><ArrowDown className="size-4" /></ItemMedia>
          <ItemContent><ItemTitle className="tabular-nums">{formatBytes(speed)}<span className="text-muted-foreground"> /s</span></ItemTitle><ItemDescription>{active.length} 个任务正在下载</ItemDescription></ItemContent>
        </Item>
        <SidebarMenu>
          <SidebarMenuItem><SidebarMenuButton tooltip="设置" isActive={page === 'settings'} onClick={() => setPage('settings')}><Settings2 /><span>设置</span></SidebarMenuButton></SidebarMenuItem>
          <SidebarMenuItem><div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground group-data-[collapsible=icon]:hidden"><ShieldCheck className="size-3.5" />本机解析 · 本地保存</div></SidebarMenuItem>
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
        {page === 'settings' ? <Suspense fallback={<p role="status">正在打开设置…</p>}><Preferences key="preferences" state={state} send={send} /></Suspense> : page === 'new' ? <div className="flex flex-col gap-4">
            {errorBanner}
            {/* One link at a time, so the box is two lines and never grows: what gets pasted is often a
                whole share message - 抖音 and 小红书 put the link inside a sentence - and the link is taken
                out of it before parsing. Enter parses; there is no new line to type. Pasting and parsing
                sit under it, half the width each; while a parse runs, the second offers to stop it rather
                than a third button appearing. */}
            <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); if (url.trim()) void send('media:parse', { url }) }}>
              <InputGroup>
                <InputGroupTextarea id="media-url" aria-label="媒体链接" rows={2} className="min-h-0 field-sizing-fixed" placeholder="粘贴视频、图文或用户主页链接，也可以直接粘贴带链接的分享文案…" value={url}
                  onChange={event => setUrl(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.currentTarget.form?.requestSubmit() } }} />
              </InputGroup>
              <div className="grid grid-cols-2 gap-2">
                <Button type="button" size="lg" variant="outline" onClick={() => void paste()}><ClipboardPaste />粘贴链接</Button>
                {state.parse.status === 'parsing'
                  ? <Button type="button" size="lg" variant="outline" onClick={() => void send('media:cancel', null)}><Spinner aria-hidden="true" />取消解析</Button>
                  : <Button type="submit" size="lg" disabled={!url.trim()}>解析<kbd aria-hidden="true" className="rounded border border-current/30 px-1 font-sans text-[11px] leading-4 opacity-70">Enter</kbd></Button>}
              </div>
            </form>
            {/* A message arriving alongside a result belongs to a page the user turned, and is shown
                down beside the pager they clicked rather than up here, above everything they read. */}
            {/* The four permission walls are named apart from each other and from an ordinary failure:
                only one of them is fixed by signing in, and 'encrypted' is fixed by nothing, so it is
                the one that gets no button. */}
            {state.parse.message && !state.parse.result && <Alert variant="destructive">
              <AlertTitle>{state.parse.verify ? '需要完成验证' : (state.parse.wall && wallTitles[state.parse.wall]) || '解析未完成'}</AlertTitle>
              <AlertDescription>{state.parse.message}</AlertDescription>
              {(state.parse.verify || fixableBySignIn(state.parse.wall)) && <AlertAction><Button variant="outline" size="sm" disabled={connecting} onClick={() => login(state.parse.loginUrl || '')}>{state.parse.verify ? '打开验证页面' : '打开登录窗口'}</Button></AlertAction>}
            </Alert>}
            {/* Closing a result clears it, which is what the ✕ beside it means; it no longer leaves the page. */}
            {state.parse.result && <Suspense fallback={<p role="status">正在显示解析结果…</p>}><Result key={state.parse.result.id} result={state.parse.result} parse={state.parse} settings={state.settings} send={send} login={login} connecting={connecting} close={() => void send('media:cancel', null)} /></Suspense>}
            {/* Only while no result is on screen: the result is what is being worked on, and closing it
                brings the way back to earlier parses. */}
            {!state.parse.result && <History entries={state.history} send={send} parsing={state.parse.status === 'parsing'}
              reparse={address => { setUrl(address); void send('media:parse', { url: address }) }} />}
          </div> : <>
          <Card>
            <CardHeader>
              <CardTitle>{title}</CardTitle>
              <CardDescription>{jobs.length} 项</CardDescription>
              <CardAction className="flex gap-1">
                <Button variant="ghost" size="sm" disabled={batchBusy || !state.jobs.some(job => ['paused', 'failed', 'queued'].includes(job.status))} onClick={() => batch('resume')}><Play />开始全部</Button>
                <Button variant="ghost" size="sm" disabled={batchBusy || !state.jobs.some(job => ['running', 'queued'].includes(job.status))} onClick={() => batch('pause')}><Pause />暂停全部</Button>
                <AlertDialog open={clearOpen} onOpenChange={open => { setClearOpen(open); if (!open) setClearFiles(false) }}>
                  <AlertDialogTrigger render={<Button variant="ghost" size="sm" disabled={!state.jobs.some(job => ['completed', 'failed', 'cancelled'].includes(job.status))} />}>清理记录</AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>清理已结束任务记录？</AlertDialogTitle>
                      <AlertDialogDescription>移除已完成、失败和已取消的记录。{clearFiles ? '这些任务下载的文件会一并移入回收站。' : '磁盘中的文件会保留。'}</AlertDialogDescription>
                    </AlertDialogHeader>
                    {/* Off every time the dialog opens: deleting files is a thing to ask for, never a
                        setting that quietly carries over from the last time records were cleared. */}
                    <Field orientation="horizontal" className="w-fit">
                      <Checkbox id="clear-delete-files" checked={clearFiles} onCheckedChange={checked => setClearFiles(checked === true)} />
                      <FieldLabel htmlFor="clear-delete-files" className="font-normal">同时删除已下载的文件</FieldLabel>
                    </Field>
                    <AlertDialogFooter>
                      <AlertDialogCancel render={<Button variant="outline" />}>保留记录</AlertDialogCancel>
                      <AlertDialogAction render={<Button onClick={() => void send('jobs:clear', { deleteFiles: clearFiles }).then(ok => { if (ok) setClearOpen(false) })} />}>清理记录</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </CardAction>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-wrap items-end gap-3">
                <InputGroup className="min-w-52 flex-1">
                  <InputGroupInput aria-label="搜索任务" placeholder="搜索名称或链接…" value={search} onChange={event => setSearch(event.target.value)} />
                  <InputGroupAddon><Search /></InputGroupAddon>
                </InputGroup>
                <Choice className="w-36" label="媒体类型" value={kind} onChange={setKind} options={[{ value: 'all', label: '全部类型' }, { value: 'video', label: '视频' }, { value: 'audio', label: '音频' }, { value: 'image', label: '图文' }]} />
                <Choice className="w-36" label="平台" value={platform} onChange={setPlatform} options={[{ value: 'all', label: '全部平台' }, ...[...new Set(state.jobs.map(job => job.platform))].map(value => ({ value, label: value }))]} />
                <Choice className="w-36" label="排序" value={sort} onChange={setSort} options={[{ value: 'newest', label: '最新添加' }, { value: 'oldest', label: '最早添加' }, { value: 'progress', label: '下载进度' }, { value: 'title', label: '名称' }]} />
                <ToggleGroup className="mb-1" spacing={0} variant="outline" value={[state.settings.view]} onValueChange={value => { const view = value[0]; if (view && view !== state.settings.view) void send('settings:save', { ...state.settings, view: view as ClientState['settings']['view'] }) }}>
                  <ToggleGroupItem value="list" aria-label="列表视图"><List /></ToggleGroupItem>
                  <ToggleGroupItem value="grid" aria-label="卡片视图"><LayoutGrid /></ToggleGroupItem>
                </ToggleGroup>
              </div>
              {jobs.length ? state.settings.view === 'grid'
                ? <MediaGrid minWidth="20rem">{jobs.map(job => <TaskCard key={job.id} job={job} send={send} select={() => setSelectedJob(job.id)} view="grid" density={state.settings.density} />)}</MediaGrid>
                : <ItemGroup className="gap-1">{jobs.map(job => <TaskCard key={job.id} job={job} send={send} select={() => setSelectedJob(job.id)} view="list" density={state.settings.density} />)}</ItemGroup>
                : <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon"><FolderOpen /></EmptyMedia>
                    <EmptyTitle><h3>{state.jobs.length ? '没有匹配的任务' : '下载列表还是空的'}</h3></EmptyTitle>
                    <EmptyDescription>{state.jobs.length ? '试试其他分类、筛选条件或关键词。' : '添加一个链接，开始整理你的媒体文件。'}</EmptyDescription>
                  </EmptyHeader>
                  <EmptyContent><Button variant="outline" onClick={() => { if (state.jobs.length) { setSearch(''); setKind('all'); setPlatform('all'); setPage('all') } else setPage('new') }}>{state.jobs.length ? '查看全部任务' : '添加第一个任务'}</Button></EmptyContent>
                </Empty>}
            </CardContent>
          </Card>
          <footer className="flex justify-between gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5"><ShieldCheck className="size-3.5" />所有解析与下载均在本机执行</span>
            <span className="flex max-w-1/2 items-center gap-1.5 truncate" title={state.settings.downloadDirectory}><FolderOpen className="size-3.5 shrink-0" /><span className="truncate">{state.settings.downloadDirectory}</span></span>
          </footer>
        </>}
      </main>
    </SidebarInset>
    <TaskInspector error={error} job={state.jobs.find((job: Job) => job.id === selectedJob)} send={send} close={() => setSelectedJob(undefined)} />
    <Preview preview={state.preview} send={send} />
  </SidebarProvider></TooltipProvider></Toaster></DictionaryContext.Provider>
}
