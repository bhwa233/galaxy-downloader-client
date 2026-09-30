import { useEffect, useState } from 'react'
import { Copy, Download, ExternalLink, FileX, FolderOpen, Image as ImageIcon, Layers, Link as LinkIcon, LogIn, Music, Pause, Play, RotateCcw, SquareArrowOutUpRight, Trash2, X } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Item, ItemActions, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item'
import { Progress } from '@/components/ui/progress'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { MediaCover, MediaStatsRow, cardOutline } from './MediaCard'
import { fixableBySignIn, wallTitles } from './walls'
import { cn, formatBytes, formatDate, formatDuration } from '@/lib/utils'
import type { Job, JobFile, Settings, jobActionInput } from '../../../shared/contracts'
import type { Send } from '@/App'
import type { z } from 'zod'
type JobAction = z.infer<typeof jobActionInput>['action']

export const statuses: Record<Job['status'], string> = { queued: '等待中', running: '下载中', paused: '已暂停', completed: '已完成', cancelled: '已取消', failed: '失败' }
export const kinds = { video: '视频', audio: '音频', image: '图文' }
const statusTone: Record<Job['status'], string> = { queued: 'text-muted-foreground', running: 'text-blue-600 dark:text-blue-400', paused: 'text-muted-foreground', completed: 'text-emerald-600 dark:text-emerald-400', cancelled: 'text-muted-foreground', failed: 'text-destructive' }
function Cover({ job, className }: { job: Job; className?: string }) {
  return <MediaCover kind={job.kind || 'video'} thumbnail={job.thumbnail} className={cn('size-full rounded-md', className)}>
    <span className="absolute right-0.5 bottom-0.5 rounded bg-background/80 px-1 text-[10px] leading-4">{kinds[job.kind || 'video']}</span>
  </MediaCover>
}
function Actions({ job, send }: { job: Job; send: Send }) {
  const [busy, setBusy] = useState(false)
  const run = (action: JobAction) => { setBusy(true); void send('jobs:action', { id: job.id, action }).finally(() => setBusy(false)) }
  if (job.status === 'running' || job.status === 'queued') return <>
    <Button variant="ghost" size="icon" title="暂停" aria-label="暂停" disabled={busy} onClick={() => run('pause')}><Pause /></Button>
    <Button variant="ghost" size="icon" title="取消" aria-label="取消" disabled={busy} onClick={() => run('cancel')}><X /></Button>
  </>
  if (job.status === 'completed') return <Button variant="ghost" size="icon" title="打开文件位置" aria-label="打开文件位置" disabled={busy} onClick={() => run('reveal')}><FolderOpen /></Button>
  const resume = job.status === 'paused'
  return <Button variant="ghost" size="icon" title={resume ? '继续' : '重试'} aria-label={resume ? '继续' : '重试'} disabled={busy} onClick={() => run(resume ? 'resume' : 'retry')}>{resume ? <Play /> : <RotateCcw />}</Button>
}
// Right-clicking a task. The row already carries the one action its state calls for; this is where the
// rest of them live, including the ones that had nowhere else to be: the link it came from, the page
// behind it, the path it was written to, and removing this single record.
function JobMenu({ job, send, children }: { job: Job; send: Send; children: React.ReactNode }) {
  const [removing, setRemoving] = useState(false)
  const [removingBatch, setRemovingBatch] = useState(false)
  const [withFiles, setWithFiles] = useState(false)
  const run = (action: JobAction) => void send('jobs:action', { id: job.id, action })
  const batch = (action: 'pause' | 'resume' | 'retry' | 'cancel') => void send('jobs:batch', { action, batchId: job.batchId })
  const working = job.status === 'running' || job.status === 'queued'
  const done = job.status === 'completed'
  return <>
    <ContextMenu>
      <ContextMenuTrigger render={<div className="contents" />}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onClick={() => run('copy-link')}><LinkIcon />复制链接</ContextMenuItem>
        <ContextMenuItem onClick={() => run('open-page')}><ExternalLink />打开原网页</ContextMenuItem>
        {done && <>
          <ContextMenuItem onClick={() => run('open')}><SquareArrowOutUpRight />打开</ContextMenuItem>
          <ContextMenuItem onClick={() => run('reveal')}><FolderOpen />打开文件位置</ContextMenuItem>
          <ContextMenuItem onClick={() => run('copy-path')}><Copy />复制文件路径</ContextMenuItem>
        </>}
        <ContextMenuSeparator />
        {/* Both add a file beside the task rather than changing it, so neither waits for it to finish.
            The cover comes from the address already on the record; the audio is a second task. */}
        {job.thumbnail && <ContextMenuItem onClick={() => run('thumbnail')}><ImageIcon />下载封面</ContextMenuItem>}
        {!job.audioOnly && job.kind !== 'image' && <ContextMenuItem onClick={() => run('audio')}><Music />下载音频</ContextMenuItem>}
        <ContextMenuSeparator />
        {working && <>
          <ContextMenuItem onClick={() => run('pause')}><Pause />暂停</ContextMenuItem>
          <ContextMenuItem onClick={() => run('cancel')}><X />取消</ContextMenuItem>
        </>}
        {job.status === 'paused' && <ContextMenuItem onClick={() => run('resume')}><Play />继续</ContextMenuItem>}
        {(job.status === 'failed' || job.status === 'cancelled') && <ContextMenuItem onClick={() => run('retry')}><RotateCcw />重试</ContextMenuItem>}
        <ContextMenuItem variant="destructive" onClick={() => { setWithFiles(false); setRemoving(true) }}><Trash2 />删除记录…</ContextMenuItem>
        {/* The batch this task was queued with. Everything above stays available on the task itself:
            acting on the batch is doing the same thing to each of them, not taking their controls away. */}
        {job.batchId && <>
          <ContextMenuSeparator />
          <ContextMenuSub>
            <ContextMenuSubTrigger><Layers />整批：{job.batchTitle || '这次解析'}</ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-44">
              <ContextMenuItem onClick={() => batch('pause')}><Pause />暂停整批</ContextMenuItem>
              <ContextMenuItem onClick={() => batch('resume')}><Play />继续整批</ContextMenuItem>
              <ContextMenuItem onClick={() => batch('retry')}><RotateCcw />重试整批</ContextMenuItem>
              <ContextMenuItem onClick={() => batch('cancel')}><X />取消整批</ContextMenuItem>
              <ContextMenuItem variant="destructive" onClick={() => { setWithFiles(false); setRemovingBatch(true) }}><Trash2 />删除整批…</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        </>}
      </ContextMenuContent>
    </ContextMenu>
    {/* Asked for the same way clearing the whole list is, because it does the same thing to one row. */}
    <AlertDialog open={removing} onOpenChange={open => { setRemoving(open); if (!open) setWithFiles(false) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除这条任务记录？</AlertDialogTitle>
          <AlertDialogDescription>{job.title}{withFiles ? ' — 下载的文件会一并移入回收站。' : ' — 磁盘中的文件会保留。'}</AlertDialogDescription>
        </AlertDialogHeader>
        <Field orientation="horizontal" className="w-fit">
          <Checkbox id={`remove-files-${job.id}`} checked={withFiles} onCheckedChange={checked => setWithFiles(checked === true)} />
          <FieldLabel htmlFor={`remove-files-${job.id}`} className="font-normal">同时删除已下载的文件</FieldLabel>
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel render={<Button variant="outline" />}>保留</AlertDialogCancel>
          <AlertDialogAction render={<Button variant="destructive" onClick={() => void send('jobs:remove', { id: job.id, deleteFiles: withFiles }).then(ok => { if (ok) setRemoving(false) })} />}>删除记录</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    {/* A batch is many records at once, so it is asked for the same way and says how many. */}
    <AlertDialog open={removingBatch} onOpenChange={open => { setRemovingBatch(open); if (!open) setWithFiles(false) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>删除这一批任务记录？</AlertDialogTitle>
          <AlertDialogDescription>{job.batchTitle || '这次解析'} 的全部任务{withFiles ? ' — 它们下载的文件会一并移入回收站。' : ' — 磁盘中的文件会保留。'}</AlertDialogDescription>
        </AlertDialogHeader>
        <Field orientation="horizontal" className="w-fit">
          <Checkbox id={`remove-batch-files-${job.id}`} checked={withFiles} onCheckedChange={checked => setWithFiles(checked === true)} />
          <FieldLabel htmlFor={`remove-batch-files-${job.id}`} className="font-normal">同时删除已下载的文件</FieldLabel>
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel render={<Button variant="outline" />}>保留</AlertDialogCancel>
          <AlertDialogAction render={<Button variant="destructive" onClick={() => void send('jobs:batch', { action: 'remove', batchId: job.batchId, deleteFiles: withFiles }).then(ok => { if (ok) setRemovingBatch(false) })} />}>删除整批</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
}
function Metrics({ job }: { job: Job }) {
  return <div className="flex flex-wrap justify-between gap-3 text-xs tabular-nums text-muted-foreground">
    <span>{job.downloaded !== undefined ? formatBytes(job.downloaded) : '—'}{job.total ? ` / ${formatBytes(job.total)}` : ''}</span>
    <span>{job.status === 'running' ? job.speed ? `${formatBytes(job.speed)}/s` : '正在准备…' : job.status === 'completed' ? job.completedAt ? `完成于 ${new Date(job.completedAt).toLocaleString()}` : '' : `${Math.round(job.progress * 100)}%`}</span>
    {job.status === 'running' && job.eta !== undefined && <span>剩余 {formatDuration(job.eta)}</span>}
  </div>
}
export function TaskCard({ job, send, select, view = 'list', density = 'comfortable' }: { job: Job; send: Send; select: () => void; view?: Settings['view']; density?: Settings['density'] }) {
  const compact = density === 'compact'
  const heading = <div className="flex min-w-0 items-center gap-2">
    <button className="min-w-0 truncate text-left text-sm font-medium" onClick={select} title={job.title}>{job.title}</button>
    <span className={cn('shrink-0 text-[11px]', statusTone[job.status])}>{statuses[job.status]}</span>
  </div>
  // The batch is named on every task of it rather than as a header above a group: the list is sorted
  // and filtered by the user, so tasks of one batch are not necessarily next to each other.
  const subtitle = <>{job.platform} · {new Date(job.createdAt).toLocaleString()}{job.batchId ? ` · 批次：${job.batchTitle || '这次解析'}` : ''}</>
  // Wrapped once around whichever shape the view asks for, so a right-click anywhere on the task opens
  // the same menu.
  if (view === 'grid') return <JobMenu job={job} send={send}><Card className={cn('gap-3', cardOutline(), compact ? 'p-3' : 'p-4')}>
    <CardContent className="flex flex-col gap-3 p-0">
      <button className="aspect-video w-full overflow-hidden rounded-md" onClick={select} aria-label={`查看任务 ${job.title}`}><Cover job={job} /></button>
      {heading}
      <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
      {/* A finished task has nothing left to measure; a full bar on every row of the list was noise. */}
      {job.status !== 'completed' && <Progress value={job.progress * 100} className="h-1.5" />}
      <Metrics job={job} />
      {job.error && <p className="line-clamp-2 text-xs text-destructive" title={job.error}>{job.error}</p>}
      <div className="flex justify-end gap-1"><Actions job={job} send={send} /></div>
    </CardContent>
  </Card></JobMenu>
  return <JobMenu job={job} send={send}><Item variant="outline" size={compact ? 'sm' : 'default'}>
    <ItemMedia variant="image" className={compact ? 'size-12' : 'h-14 w-20'}>
      <button className="size-full" onClick={select} aria-label={`查看任务 ${job.title}`}><Cover job={job} /></button>
    </ItemMedia>
    <ItemContent className="gap-1.5">
      <ItemTitle className="w-full">{heading}</ItemTitle>
      <ItemDescription>{subtitle}</ItemDescription>
      {job.status !== 'completed' && <Progress value={job.progress * 100} className="h-1.5" />}
      <Metrics job={job} />
      {job.error && <p className="line-clamp-2 text-xs text-destructive" title={job.error}>{job.error}</p>}
    </ItemContent>
    <ItemActions><Actions job={job} send={send} /></ItemActions>
  </Item></JobMenu>
}
// What a failure was and what to do about it. A permission wall is known for certain, from the engine's
// own wording, and its message already says what to do. Anything else is read off the error the way a
// user would read it; where nothing matches, the error is shown as it is with the general advice.
const FAILURES: { pattern: RegExp; title: string; hint: string }[] = [
  { pattern: /自动续传/, title: '下载中断，稍后自动续传', hint: '会在上面的时间后从断点继续，也可以现在就重试。' },
  { pattern: /ENOSPC|no space left|disk full|磁盘空间/i, title: '磁盘空间不足', hint: '清理出空间，或在设置中换一个下载目录，然后重试。' },
  { pattern: /EACCES|EPERM|EROFS|permission denied|read-only file system|拒绝访问/i, title: '没有写入权限', hint: '在设置中换一个下载目录，或检查这个目录的权限，然后重试。' },
  { pattern: /HTTP Error 40[34]|HTTP Error 410|\b40[34] Forbidden|\b410\b|expired|已过期|已失效/i, title: '媒体地址失效或被拒绝', hint: '重试会重新解析作品、换一个新的地址。反复出现时，可能需要在应用内浏览器重新登录。' },
  { pattern: /timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|socket hang up|network|网络|超时/i, title: '网络连接出错', hint: '检查网络或系统代理后重试；网络慢时可以在设置中加长连接超时。' },
  { pattern: /ffmpeg|postprocess|merg(e|ing)|合并|转换失败/i, title: '合并或转换失败', hint: '在设置 → 工具与更新里检查 FFmpeg 是否可用，然后重试。' },
]
function advice(job: Job): { title: string; hint?: string; login: boolean } {
  if (job.wall) return { title: wallTitles[job.wall], login: fixableBySignIn(job.wall) }
  const known = FAILURES.find(entry => entry.pattern.test(job.error || ''))
  return known ? { ...known, login: false } : { title: '下载失败', hint: '可以直接重试；反复失败时，导出诊断日志便于排查。', login: false }
}
// The failure, said at the top of the detail with what can be done about it right there.
function Failure({ job, send }: { job: Job; send: Send }) {
  const { title, hint, login } = advice(job)
  const retry = job.status === 'failed' || job.status === 'cancelled'
  return <Alert variant="destructive">
    <AlertTitle>{title}</AlertTitle>
    <AlertDescription className="break-all"><p>{job.error}</p>{hint && <p>{hint}</p>}</AlertDescription>
    {(login || retry) && <div className="mt-2 flex flex-wrap gap-2">
      {login && <Button variant="outline" size="sm" onClick={() => void send('jobs:action', { id: job.id, action: 'login' })}><LogIn />打开登录窗口</Button>}
      {retry && <Button variant="outline" size="sm" onClick={() => void send('jobs:action', { id: job.id, action: 'retry' })}><RotateCcw />重试</Button>}
    </div>}
  </Alert>
}
// Each file the job recorded, looked up on disk when the tab is opened and again whenever the list of
// files changes - a file moved or deleted since the download says so rather than being listed as if
// nothing had happened.
function Files({ job, send }: { job: Job; send: Send }) {
  const [found, setFound] = useState<JobFile[]>()
  const key = job.files.join('\n')
  useEffect(() => { void send('jobs:files', { id: job.id }).then(reply => { if (reply) setFound(reply.files) }) }, [send, job.id, key])
  if (!job.files.length) return <p className="text-sm text-muted-foreground">文件保存后会显示在这里。暂停和取消会保留已下载的部分文件。</p>
  return <>{job.files.map(file => {
    const entry = found?.find(item => item.path === file)
    return <Item key={file} variant="outline" size="sm">
      <ItemMedia>{entry && !entry.exists ? <FileX className="size-4 text-destructive" /> : <Download className="size-4" />}</ItemMedia>
      <ItemContent>
        <ItemTitle className="break-all whitespace-normal">{file}</ItemTitle>
        <ItemDescription className={cn('tabular-nums', entry && !entry.exists && 'text-destructive')}>
          {!entry ? '正在检查…' : entry.exists ? entry.size !== undefined ? formatBytes(entry.size) : '已保存' : '文件不存在，可能已被移动或删除'}
        </ItemDescription>
      </ItemContent>
    </Item>
  })}</>
}
export function TaskInspector({ job, send, close, error }: { job?: Job; send: Send; close: () => void; error?: string }) {
  const [tab, setTab] = useState('概览')
  return <Sheet open={Boolean(job)} onOpenChange={open => { if (!open) close() }}>
    <SheetContent side="right" className="sm:max-w-lg">
      <SheetHeader>
        <SheetTitle>任务详情</SheetTitle>
        <SheetDescription>查看文件、下载状态和活动记录。</SheetDescription>
      </SheetHeader>
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
        {error && <Alert variant="destructive"><AlertTitle>操作未完成</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
        {job && <>
          <Item variant="muted">
            <ItemMedia variant="image" className="h-14 w-20"><Cover key={job.id} job={job} /></ItemMedia>
            <ItemContent>
              <ItemTitle className="line-clamp-2 whitespace-normal">{job.title}</ItemTitle>
              <ItemDescription className={statusTone[job.status]}>{statuses[job.status]}</ItemDescription>
            </ItemContent>
            <ItemActions><Actions job={job} send={send} /></ItemActions>
          </Item>
          <Tabs value={tab} onValueChange={value => setTab(String(value))}>
            <TabsList>
              <TabsTrigger value="概览">概览</TabsTrigger>
              <TabsTrigger value="文件">文件 ({job.files.length})</TabsTrigger>
              <TabsTrigger value="活动日志">活动日志</TabsTrigger>
            </TabsList>
            <TabsContent value="概览" className="flex flex-col gap-4">
              {job.error && <Failure job={job} send={send} />}
              <Progress value={job.progress * 100} />
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm [&_dt]:text-muted-foreground">
                <dt>进度</dt><dd className="tabular-nums">{Math.round(job.progress * 100)}%</dd>
                <dt>平台 / 类型</dt><dd>{job.platform} / {kinds[job.kind || 'video']}</dd>
                <dt>解析方式</dt><dd>{job.method === 'browser' ? '应用内浏览器' : '本地解析'}</dd>
                {/* What the platform said about the media when it was parsed; older jobs carry none of it. */}
                {job.author && <><dt>作者</dt><dd>{job.author}</dd></>}
                {job.publishedAt !== undefined && <><dt>发布时间</dt><dd>{formatDate(job.publishedAt)}</dd></>}
                {job.duration !== undefined && <><dt>时长</dt><dd className="tabular-nums">{formatDuration(job.duration)}</dd></>}
                {(job.views ?? job.danmaku ?? job.comments ?? job.likes) !== undefined && <><dt>播放 / 弹幕 / 评论 / 点赞</dt><dd><MediaStatsRow views={job.views} danmaku={job.danmaku} comments={job.comments} likes={job.likes} className="text-sm" /></dd></>}
                <dt>来源</dt><dd className="break-all">{job.url}</dd>
                <dt>保存目录</dt><dd className="break-all">{job.directory}</dd>
                <dt>已下载</dt><dd className="tabular-nums">{job.downloaded !== undefined ? formatBytes(job.downloaded) : '尚无数据'}{job.total ? ` / ${formatBytes(job.total)}` : ''}</dd>
                <dt>当前速度</dt><dd className="tabular-nums">{job.status === 'running' && job.speed ? `${formatBytes(job.speed)}/s` : '—'}</dd>
                {job.status === 'running' && job.eta !== undefined && <><dt>剩余时间</dt><dd className="tabular-nums">{formatDuration(job.eta)}</dd></>}
                {/* Breaks picked up again on their own since the last time it finished or was retried by hand. */}
                {job.attempts ? <><dt>自动续传</dt><dd className="tabular-nums">{job.attempts} 次</dd></> : null}
                <dt>创建时间</dt><dd>{new Date(job.createdAt).toLocaleString()}</dd>
                {job.completedAt && <><dt>完成时间</dt><dd>{new Date(job.completedAt).toLocaleString()}</dd></>}
              </dl>
              <TaskLimit key={`${job.id}-${job.speedLimit}`} job={job} send={send} />
            </TabsContent>
            <TabsContent value="文件" className="flex flex-col gap-3">
              {tab === '文件' && <Files job={job} send={send} />}
              {job.status === 'completed' && <Button variant="outline" onClick={() => void send('jobs:action', { id: job.id, action: 'reveal' })}><FolderOpen />打开下载目录</Button>}
            </TabsContent>
            <TabsContent value="活动日志" className="flex flex-col gap-3">
              <p className="text-xs text-muted-foreground">显示最近 150 条记录，敏感请求信息已隐藏。</p>
              <pre className="activity-log max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">{job.logs.join('\n') || '暂无活动记录'}</pre>
              <Button variant="outline" onClick={() => void send('logs:export', null)}>导出诊断日志</Button>
            </TabsContent>
          </Tabs>
        </>}
      </div>
    </SheetContent>
  </Sheet>
}
function TaskLimit({ job, send }: { job: Job; send: Send }) {
  const [value, setValue] = useState(job.speedLimit || 0)
  const locked = job.status === 'running' || job.status === 'completed'
  return <form className="border-t pt-4" onSubmit={event => { event.preventDefault(); void send('jobs:limit', { id: job.id, speedLimit: value }) }}>
    <Field data-disabled={locked || undefined}>
      <FieldLabel htmlFor="task-limit">单任务限速（KiB/s）</FieldLabel>
      <div className="flex gap-2">
        <Input id="task-limit" required type="number" min={0} max={1048576} value={value} onChange={event => setValue(event.target.valueAsNumber)} disabled={locked} />
        <Button variant="outline" disabled={locked}>保存</Button>
      </div>
      <FieldDescription>0 为不限速。下载中请先暂停，修改后继续任务。</FieldDescription>
    </Field>
  </form>
}
