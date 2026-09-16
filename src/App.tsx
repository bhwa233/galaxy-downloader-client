import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { ArrowDown, CheckCheck, FolderOpen, Globe, LayoutGrid, List, LoaderCircle, Pause, Play, Plus, Search, Settings2, ShieldCheck, Sparkles, Sun, Moon, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Choice } from '@/components/downloader/Choice'
import { TaskCard, TaskInspector } from '@/components/downloader/Tasks'
import { DictionaryContext, dictionaries } from '@/i18n/client'
import { formatBytes } from '@/lib/utils'
import type { ClientState, Command, CommandInput, Job } from '../shared/contracts'

const Result = lazy(() => import('@/components/downloader/Result').then(module => ({ default: module.Result })))
const Preferences = lazy(() => import('@/components/downloader/Preferences').then(module => ({ default: module.Preferences })))

export type Send = <C extends Command>(command: C, input: CommandInput<C>) => Promise<boolean>
const navigation = [
  { id: 'all', label: '全部任务', icon: List },
  { id: 'running', label: '下载中', icon: ArrowDown },
  { id: 'completed', label: '已完成', icon: CheckCheck },
] as const
export default function App() {
  const [state, setState] = useState<ClientState>()
  const [error, setError] = useState('')
  const [url, setUrl] = useState('')
  const [filter, setFilter] = useState<'all' | 'video' | 'audio' | 'image'>('all')
  const [page, setPage] = useState<'all' | 'running' | 'completed' | 'settings' | 'new'>('all')
  const [selectedJob, setSelectedJob] = useState<string>()
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState('all')
  const [platform, setPlatform] = useState('all')
  const [sort, setSort] = useState('newest')
  const [connecting, setConnecting] = useState(false)
  const [batchBusy, setBatchBusy] = useState(false)
  const [clearOpen, setClearOpen] = useState(false)
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches)
  const send: Send = useCallback(async (command, input) => {
    setError('')
    try { const reply = await window.desktopApi.command(command, input); if (reply.ok) { setState(reply.state); return true }; setError(reply.message) } catch (failure) { setError(String(failure)) }
    return false
  }, [])
  useEffect(() => { const unsubscribe = window.desktopApi.subscribe(setState); void send('state:get', null); return unsubscribe }, [send])
  const theme = state?.settings.theme
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)')
    const apply = () => { setSystemDark(media.matches); document.documentElement.classList.toggle('dark', theme === 'dark' || (theme === 'system' && media.matches)) }
    apply(); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply)
  }, [theme])
  if (!state) return <main className="grid min-h-screen place-items-center"><p role="status">{error || '正在启动本地客户端…'}</p></main>
  const night = theme === 'dark' || (theme === 'system' && systemDark)
  const active = state.jobs.filter(job => job.status === 'running')
  const speed = active.reduce((sum, job) => sum + (job.speed || 0), 0)
  const query = search.trim().toLocaleLowerCase()
  const jobs = state.jobs.filter(job => (page === 'all' || job.status === page) && (kind === 'all' || (job.kind || (job.audioOnly ? 'audio' : 'video')) === kind) && (platform === 'all' || job.platform === platform) && (!query || `${job.title} ${job.platform} ${job.url}`.toLocaleLowerCase().includes(query))).sort((a, b) => sort === 'oldest' ? a.createdAt.localeCompare(b.createdAt) : sort === 'progress' ? b.progress - a.progress : sort === 'title' ? a.title.localeCompare(b.title) : b.createdAt.localeCompare(a.createdAt))
  const title = page === 'settings' ? '设置' : page === 'new' ? '新建任务' : navigation.find(item => item.id === page)?.label || '任务'
  const batch = (action: 'pause' | 'resume') => { setBatchBusy(true); void send('jobs:batch', { action }).finally(() => setBatchBusy(false)) }
  const paste = async () => { setPage('new'); try { const reply = await window.desktopApi.command('clipboard:read', null); if (reply.ok) setUrl(reply.clipboardText || ''); else setError(reply.message) } catch { setError('无法读取剪贴板，请在输入框中粘贴链接。') } }
  const connect = () => { setConnecting(true); void send('browser:connect', null).then(ok => { if (!ok) return send('browser:guide', null) }).finally(() => setConnecting(false)) }
  // Without a Chrome connection the only login state is whatever cookie database was discovered on disk.
  const cookieProfile = state.profiles.find(profile => profile.id === state.settings.browserProfileId && profile.available)
  const loginState = state.chrome.connected ? 'Chrome 已连接' : cookieProfile ? `已读取 ${cookieProfile.label} 的登录态` : '未找到浏览器登录态'
  const errorBanner = error && <div role="alert" className="error-banner"><span>{error}</span><Button size="icon" variant="ghost" aria-label="关闭错误提示" onClick={() => setError('')}><X /></Button></div>
  return <DictionaryContext.Provider value={dictionaries[state.settings.locale]}><div className="manager-shell">
    <aside className="sidebar"><div className="brand"><div className="brand-mark"><Sparkles /></div><div><strong>Galaxy</strong><span>媒体下载管理器</span></div></div><Button className="sidebar-new" onClick={() => setPage('new')}><Plus />新建任务</Button><p className="nav-caption">工作空间</p><nav aria-label="主导航">{navigation.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${page === id ? 'active' : ''}`} onClick={() => setPage(id)} aria-current={page === id ? 'page' : undefined}><Icon /><span>{label}</span><small>{id === 'all' ? state.jobs.length : state.jobs.filter(job => job.status === id).length}</small></button>)}</nav><div className="sidebar-bottom"><div className="sidebar-transfer"><ArrowDown /><span>{formatBytes(speed)}<small> /s</small></span><p>{active.length} 个任务正在下载</p></div><button className={`nav-item ${page === 'settings' ? 'active' : ''}`} onClick={() => setPage('settings')}><Settings2 /><span>设置</span></button><div className="local-badge"><ShieldCheck />本机解析 · 本地保存</div></div></aside>
    <div className="manager-main"><header className="manager-header"><div><span className="eyebrow">GALAXY DOWNLOADER</span><h1>{title}</h1></div><div className="header-actions"><span className="connection-state" title={loginState}><i className={state.chrome.connected ? 'connected' : cookieProfile ? 'partial' : ''} />{loginState}</span><Button variant="ghost" size="icon" aria-label={night ? '切换浅色主题' : '切换夜间主题'} title={night ? '浅色主题' : '夜间主题'} onClick={() => void send('settings:save', { ...state.settings, theme: night ? 'light' : 'dark' })}>{night ? <Sun /> : <Moon />}</Button><Button variant="outline" onClick={() => void paste()}>粘贴链接</Button><Button onClick={() => setPage('new')}><Plus />新建任务</Button></div></header>
      <main className="manager-content">{page !== 'new' && !selectedJob && errorBanner}
        {page === 'settings' ? <Suspense fallback={<p role="status">正在打开设置…</p>}><Preferences key="preferences" state={state} send={send} /></Suspense> : page === 'new' ? <section className="task-panel parse-page">
          <div className="panel-heading"><div><h2>新建下载任务</h2><span>支持单条媒体与用户主页作品，解析后选择需要保存的内容。</span></div><Button variant="ghost" size="icon" aria-label="返回任务列表" onClick={() => setPage('all')}><X /></Button></div>
          {errorBanner}
          <form className="parse-form" onSubmit={event => { event.preventDefault(); void send('media:parse', { url, filter }) }}><Input className="h-12" aria-label="媒体链接" placeholder="粘贴视频、图文或用户主页链接…" value={url} onChange={event => setUrl(event.target.value)} /><div className="flex items-end gap-3"><Choice label="内容筛选" value={filter} onChange={value => setFilter(value as typeof filter)} options={[{ value: 'all', label: '全部内容' }, { value: 'video', label: '仅视频' }, { value: 'audio', label: '仅音频' }, { value: 'image', label: '仅图文' }]} /><span className="mr-auto pb-2 text-xs text-muted-foreground">主页仅获取作品</span><Button type="submit" disabled={!url.trim() || state.parse.status === 'parsing'}>{state.parse.status === 'parsing' ? <><LoaderCircle className="animate-spin" />正在解析</> : '解析'}</Button>{state.parse.status === 'parsing' && <Button type="button" variant="outline" onClick={() => void send('media:cancel', null)}>取消</Button>}</div></form>
          <div className="browser-hint"><Globe /><span>{state.chrome.connected ? '已连接 Chrome，可复用当前登录态' : cookieProfile ? `${loginState}，主页列表仍需连接 Chrome` : '未找到浏览器登录态，需要登录的内容请连接 Chrome'}</span><Button size="sm" variant="ghost" disabled={connecting} onClick={connect}>{connecting ? '等待授权…' : '连接 Chrome'}</Button></div>
          {state.parse.message && <div role="alert" className="error-banner"><span>{state.parse.message}</span>{state.parse.status === 'needs-chrome' && <Button variant="outline" size="sm" onClick={() => void send('browser:guide', null)}>打开授权页</Button>}</div>}
          <Button variant="outline" className="justify-start overflow-hidden" title={state.settings.downloadDirectory} onClick={() => void send('settings:directory', null)}><FolderOpen /><span className="truncate">保存到：{state.settings.downloadDirectory}</span></Button>
          {state.parse.result && <Suspense fallback={<p role="status">正在显示解析结果…</p>}><Result key={state.parse.result.id} result={state.parse.result} send={send} close={() => setPage('all')} /></Suspense>}
        </section> : <>

          <section className="task-panel"><div className="panel-heading"><div><h2>{title}</h2><span>{jobs.length} 项</span></div><div className="flex gap-1"><Button variant="ghost" size="sm" disabled={batchBusy || !state.jobs.some(job => ['paused', 'failed', 'queued'].includes(job.status))} onClick={() => batch('resume')}><Play />开始全部</Button><Button variant="ghost" size="sm" disabled={batchBusy || !state.jobs.some(job => ['running', 'queued'].includes(job.status))} onClick={() => batch('pause')}><Pause />暂停全部</Button><Button variant="ghost" size="sm" disabled={!state.jobs.some(job => ['completed', 'failed', 'cancelled'].includes(job.status))} onClick={() => setClearOpen(true)}>清理记录</Button></div></div>
            <div className="task-toolbar"><div className="task-search"><Search /><Input aria-label="搜索任务" placeholder="搜索名称或链接…" value={search} onChange={e => setSearch(e.target.value)} /></div><Choice label="媒体类型" value={kind} onChange={setKind} options={[{ value: 'all', label: '全部类型' }, { value: 'video', label: '视频' }, { value: 'audio', label: '音频' }, { value: 'image', label: '图文' }]} /><Choice label="平台" value={platform} onChange={setPlatform} options={[{ value: 'all', label: '全部平台' }, ...[...new Set(state.jobs.map(job => job.platform))].map(value => ({ value, label: value }))]} /><Choice label="排序" value={sort} onChange={setSort} options={[{ value: 'newest', label: '最新添加' }, { value: 'oldest', label: '最早添加' }, { value: 'progress', label: '下载进度' }, { value: 'title', label: '名称' }]} /><div className="view-switch">{(['list', 'grid'] as const).map(view => <Button key={view} variant={state.settings.view === view ? 'secondary' : 'ghost'} size="icon" aria-label={view === 'list' ? '列表视图' : '卡片视图'} aria-pressed={state.settings.view === view} onClick={() => void send('settings:save', { ...state.settings, view })}>{view === 'list' ? <List /> : <LayoutGrid />}</Button>)}</div></div>
            <div className={`task-collection ${state.settings.view} ${state.settings.density}`}>{jobs.length ? jobs.map(job => <TaskCard key={job.id} job={job} send={send} select={() => setSelectedJob(job.id)} />) : <div className="empty-state"><div><FolderOpen /></div><h3>{state.jobs.length ? '没有匹配的任务' : '下载列表还是空的'}</h3><p>{state.jobs.length ? '试试其他分类、筛选条件或关键词。' : '添加一个链接，开始整理你的媒体文件。'}</p><Button variant="outline" onClick={() => { if (state.jobs.length) { setSearch(''); setKind('all'); setPlatform('all'); setPage('all') } else setPage('new') }}>{state.jobs.length ? '查看全部任务' : '添加第一个任务'}</Button></div>}</div>
          </section><footer className="workspace-footer"><span><ShieldCheck />所有解析与下载均在本机执行</span><span title={state.settings.downloadDirectory}><FolderOpen />{state.settings.downloadDirectory}</span></footer>
        </>}
      </main>
    </div>
    <TaskInspector error={error} job={state.jobs.find((job: Job) => job.id === selectedJob)} send={send} close={() => setSelectedJob(undefined)} />
    <Dialog open={clearOpen} onOpenChange={setClearOpen}><DialogContent><DialogHeader><DialogTitle>清理已结束任务记录？</DialogTitle><DialogDescription>移除已完成、失败和已取消的记录。磁盘中的文件会保留。</DialogDescription></DialogHeader><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setClearOpen(false)}>保留记录</Button><Button onClick={() => void send('jobs:clear', null).then(ok => { if (ok) setClearOpen(false) })}>清理记录</Button></div></DialogContent></Dialog>
  </div></DictionaryContext.Provider>
}
