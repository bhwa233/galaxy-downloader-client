import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
import { fixableBySignIn, wallTitle } from './walls'
import { cn, formatBytes, formatDate, formatDuration, platformLabel } from '@/lib/utils'
import { i18n } from '../../../shared/i18n'
import type { Job, JobFile, Settings, jobActionInput } from '../../../shared/contracts'
import type { Send } from '@/App'
import type { z } from 'zod'
type JobAction = z.infer<typeof jobActionInput>['action']

const statusTone: Record<Job['status'], string> = { queued: 'text-muted-foreground', running: 'text-blue-600 dark:text-blue-400', paused: 'text-muted-foreground', completed: 'text-emerald-600 dark:text-emerald-400', cancelled: 'text-muted-foreground', failed: 'text-destructive' }
// A moment written out in the language the window is showing.
const localTime = (iso: string) => new Date(iso).toLocaleString(i18n.language === 'en' ? 'en-US' : 'zh-CN')
function Cover({ job, className }: { job: Job; className?: string }) {
  const { t } = useTranslation(['tasks', 'common'])
  return <MediaCover kind={job.kind || 'video'} thumbnail={job.thumbnail} className={cn('size-full rounded-md', className)}>
    <span className="absolute right-0.5 bottom-0.5 rounded bg-background/80 px-1 text-[10px] leading-4">{t(`common:kinds.${job.kind || 'video'}`)}</span>
  </MediaCover>
}
function Actions({ job, send }: { job: Job; send: Send }) {
  const { t } = useTranslation(['tasks', 'common'])
  const [busy, setBusy] = useState(false)
  const run = (action: JobAction) => { setBusy(true); void send('jobs:action', { id: job.id, action }).finally(() => setBusy(false)) }
  if (job.status === 'running' || job.status === 'queued') return <>
    <Button variant="ghost" size="icon" title={t('pause')} aria-label={t('pause')} disabled={busy} onClick={() => run('pause')}><Pause /></Button>
    <Button variant="ghost" size="icon" title={t('common:cancel')} aria-label={t('common:cancel')} disabled={busy} onClick={() => run('cancel')}><X /></Button>
  </>
  if (job.status === 'completed') return <Button variant="ghost" size="icon" title={t('revealFile')} aria-label={t('revealFile')} disabled={busy} onClick={() => run('reveal')}><FolderOpen /></Button>
  const resume = job.status === 'paused'
  const label = resume ? t('resume') : t('common:retry')
  return <Button variant="ghost" size="icon" title={label} aria-label={label} disabled={busy} onClick={() => run(resume ? 'resume' : 'retry')}>{resume ? <Play /> : <RotateCcw />}</Button>
}
// Right-clicking a task. The row already carries the one action its state calls for; this is where the
// rest of them live, including the ones that had nowhere else to be: the link it came from, the page
// behind it, the path it was written to, and removing this single record.
function JobMenu({ job, send, children }: { job: Job; send: Send; children: React.ReactNode }) {
  const { t } = useTranslation(['tasks', 'common'])
  const [removing, setRemoving] = useState(false)
  const [removingBatch, setRemovingBatch] = useState(false)
  const [withFiles, setWithFiles] = useState(false)
  const run = (action: JobAction) => void send('jobs:action', { id: job.id, action })
  const batch = (action: 'pause' | 'resume' | 'retry' | 'cancel') => void send('jobs:batch', { action, batchId: job.batchId })
  const working = job.status === 'running' || job.status === 'queued'
  const done = job.status === 'completed'
  const batchTitle = job.batchTitle || t('thisParse')
  return <>
    <ContextMenu>
      <ContextMenuTrigger render={<div className="contents" />}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-52">
        <ContextMenuItem onClick={() => run('copy-link')}><LinkIcon />{t('common:copyLink')}</ContextMenuItem>
        <ContextMenuItem onClick={() => run('open-page')}><ExternalLink />{t('common:openPage')}</ContextMenuItem>
        {done && <>
          <ContextMenuItem onClick={() => run('open')}><SquareArrowOutUpRight />{t('open')}</ContextMenuItem>
          <ContextMenuItem onClick={() => run('reveal')}><FolderOpen />{t('revealFile')}</ContextMenuItem>
          <ContextMenuItem onClick={() => run('copy-path')}><Copy />{t('copyPath')}</ContextMenuItem>
        </>}
        <ContextMenuSeparator />
        {/* Both add a file beside the task rather than changing it, so neither waits for it to finish.
            The cover comes from the address already on the record; the audio is a second task. */}
        {job.thumbnail && <ContextMenuItem onClick={() => run('thumbnail')}><ImageIcon />{t('downloadCover')}</ContextMenuItem>}
        {!job.audioOnly && job.kind !== 'image' && <ContextMenuItem onClick={() => run('audio')}><Music />{t('downloadAudio')}</ContextMenuItem>}
        <ContextMenuSeparator />
        {working && <>
          <ContextMenuItem onClick={() => run('pause')}><Pause />{t('pause')}</ContextMenuItem>
          <ContextMenuItem onClick={() => run('cancel')}><X />{t('common:cancel')}</ContextMenuItem>
        </>}
        {job.status === 'paused' && <ContextMenuItem onClick={() => run('resume')}><Play />{t('resume')}</ContextMenuItem>}
        {(job.status === 'failed' || job.status === 'cancelled') && <ContextMenuItem onClick={() => run('retry')}><RotateCcw />{t('common:retry')}</ContextMenuItem>}
        <ContextMenuItem variant="destructive" onClick={() => { setWithFiles(false); setRemoving(true) }}><Trash2 />{t('removeRecordMenu')}</ContextMenuItem>
        {/* The batch this task was queued with. Everything above stays available on the task itself:
            acting on the batch is doing the same thing to each of them, not taking their controls away. */}
        {job.batchId && <>
          <ContextMenuSeparator />
          <ContextMenuSub>
            <ContextMenuSubTrigger><Layers />{t('batchMenu', { title: batchTitle })}</ContextMenuSubTrigger>
            <ContextMenuSubContent className="w-44">
              <ContextMenuItem onClick={() => batch('pause')}><Pause />{t('batch.pause')}</ContextMenuItem>
              <ContextMenuItem onClick={() => batch('resume')}><Play />{t('batch.resume')}</ContextMenuItem>
              <ContextMenuItem onClick={() => batch('retry')}><RotateCcw />{t('batch.retry')}</ContextMenuItem>
              <ContextMenuItem onClick={() => batch('cancel')}><X />{t('batch.cancel')}</ContextMenuItem>
              <ContextMenuItem variant="destructive" onClick={() => { setWithFiles(false); setRemovingBatch(true) }}><Trash2 />{t('batch.removeMenu')}</ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        </>}
      </ContextMenuContent>
    </ContextMenu>
    {/* Asked for the same way clearing the whole list is, because it does the same thing to one row. */}
    <AlertDialog open={removing} onOpenChange={open => { setRemoving(open); if (!open) setWithFiles(false) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('removeDialog.title')}</AlertDialogTitle>
          <AlertDialogDescription>{withFiles ? t('removeDialog.withFiles', { title: job.title }) : t('removeDialog.keepFiles', { title: job.title })}</AlertDialogDescription>
        </AlertDialogHeader>
        <Field orientation="horizontal" className="w-fit">
          <Checkbox id={`remove-files-${job.id}`} checked={withFiles} onCheckedChange={checked => setWithFiles(checked === true)} />
          <FieldLabel htmlFor={`remove-files-${job.id}`} className="font-normal">{t('alsoDeleteFiles')}</FieldLabel>
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel render={<Button variant="outline" />}>{t('keep')}</AlertDialogCancel>
          <AlertDialogAction render={<Button variant="destructive" onClick={() => void send('jobs:remove', { id: job.id, deleteFiles: withFiles }).then(ok => { if (ok) setRemoving(false) })} />}>{t('removeDialog.confirm')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    {/* A batch is many records at once, so it is asked for the same way and says how many. */}
    <AlertDialog open={removingBatch} onOpenChange={open => { setRemovingBatch(open); if (!open) setWithFiles(false) }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('removeBatchDialog.title')}</AlertDialogTitle>
          <AlertDialogDescription>{withFiles ? t('removeBatchDialog.withFiles', { title: batchTitle }) : t('removeBatchDialog.keepFiles', { title: batchTitle })}</AlertDialogDescription>
        </AlertDialogHeader>
        <Field orientation="horizontal" className="w-fit">
          <Checkbox id={`remove-batch-files-${job.id}`} checked={withFiles} onCheckedChange={checked => setWithFiles(checked === true)} />
          <FieldLabel htmlFor={`remove-batch-files-${job.id}`} className="font-normal">{t('alsoDeleteFiles')}</FieldLabel>
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel render={<Button variant="outline" />}>{t('keep')}</AlertDialogCancel>
          <AlertDialogAction render={<Button variant="destructive" onClick={() => void send('jobs:batch', { action: 'remove', batchId: job.batchId, deleteFiles: withFiles }).then(ok => { if (ok) setRemovingBatch(false) })} />}>{t('batch.remove')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>
}
function Metrics({ job }: { job: Job }) {
  const { t } = useTranslation(['tasks', 'common'])
  return <div className="flex flex-wrap justify-between gap-3 text-xs tabular-nums text-muted-foreground">
    <span>{job.downloaded !== undefined ? formatBytes(job.downloaded) : '—'}{job.total ? ` / ${formatBytes(job.total)}` : ''}</span>
    <span>{job.status === 'running' ? job.speed ? `${formatBytes(job.speed)}/s` : t('preparing') : job.status === 'completed' ? job.completedAt ? t('completedAt', { time: localTime(job.completedAt) }) : '' : `${Math.round(job.progress * 100)}%`}</span>
    {job.status === 'running' && job.eta !== undefined && <span>{t('remaining', { time: formatDuration(job.eta) })}</span>}
  </div>
}
export function TaskCard({ job, send, select, view = 'list', density = 'comfortable' }: { job: Job; send: Send; select: () => void; view?: Settings['view']; density?: Settings['density'] }) {
  const { t } = useTranslation(['tasks', 'common'])
  const compact = density === 'compact'
  const heading = <div className="flex min-w-0 items-center gap-2">
    <button className="min-w-0 truncate text-left text-sm font-medium" onClick={select} title={job.title}>{job.title}</button>
    <span className={cn('shrink-0 text-[11px]', statusTone[job.status])}>{t(`common:statuses.${job.status}`)}</span>
  </div>
  // The batch is named on every task of it rather than as a header above a group: the list is sorted
  // and filtered by the user, so tasks of one batch are not necessarily next to each other.
  const subtitle = <>{platformLabel(job.platform)} · {localTime(job.createdAt)}{job.batchId ? ` · ${t('batchLabel', { title: job.batchTitle || t('thisParse') })}` : ''}</>
  // Wrapped once around whichever shape the view asks for, so a right-click anywhere on the task opens
  // the same menu.
  if (view === 'grid') return <JobMenu job={job} send={send}><Card className={cn('gap-3', cardOutline(), compact ? 'p-3' : 'p-4')}>
    <CardContent className="flex flex-col gap-3 p-0">
      <button className="aspect-video w-full overflow-hidden rounded-md" onClick={select} aria-label={t('viewTask', { title: job.title })}><Cover job={job} /></button>
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
      <button className="size-full" onClick={select} aria-label={t('viewTask', { title: job.title })}><Cover job={job} /></button>
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
type FailureKind = 'resuming' | 'noSpace' | 'permission' | 'expired' | 'network' | 'convert'
const FAILURES: { pattern: RegExp; kind: FailureKind }[] = [
  { pattern: /自动续传|resuming automatically/i, kind: 'resuming' },
  { pattern: /ENOSPC|no space|not enough (disk )?space|insufficient (disk )?space|disk full|磁盘空间/i, kind: 'noSpace' },
  { pattern: /EACCES|EPERM|EROFS|permission denied|access (is )?denied|read-only file system|not writable|拒绝访问/i, kind: 'permission' },
  { pattern: /HTTP Error 40[34]|HTTP Error 410|\b40[34] Forbidden|\b410\b|expired|no longer valid|已过期|已失效/i, kind: 'expired' },
  { pattern: /timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|socket hang up|network|网络|超时/i, kind: 'network' },
  { pattern: /ffmpeg|postprocess|merg(e|ing)|conver(t|sion)|合并|转换失败/i, kind: 'convert' },
]
// The failure, said at the top of the detail with what can be done about it right there.
function Failure({ job, send }: { job: Job; send: Send }) {
  const { t } = useTranslation(['tasks', 'common'])
  const kind = FAILURES.find(entry => entry.pattern.test(job.error || ''))?.kind ?? 'generic'
  const title = job.wall ? wallTitle(job.wall) : t(`failures.${kind}.title`)
  const hint = job.wall ? undefined : t(`failures.${kind}.hint`)
  const login = job.wall ? fixableBySignIn(job.wall) : false
  const retry = job.status === 'failed' || job.status === 'cancelled'
  return <Alert variant="destructive">
    <AlertTitle>{title}</AlertTitle>
    <AlertDescription className="break-words"><p>{job.error}</p>{hint && <p>{hint}</p>}</AlertDescription>
    {(login || retry) && <div className="mt-2 flex flex-wrap gap-2">
      {login && <Button variant="outline" size="sm" onClick={() => void send('jobs:action', { id: job.id, action: 'login' })}><LogIn />{t('common:openLogin')}</Button>}
      {retry && <Button variant="outline" size="sm" onClick={() => void send('jobs:action', { id: job.id, action: 'retry' })}><RotateCcw />{t('common:retry')}</Button>}
    </div>}
  </Alert>
}
// Each file the job recorded, looked up on disk when the tab is opened and again whenever the list of
// files changes - a file moved or deleted since the download says so rather than being listed as if
// nothing had happened.
function Files({ job, send }: { job: Job; send: Send }) {
  const { t } = useTranslation(['tasks', 'common'])
  const [found, setFound] = useState<JobFile[]>()
  const key = job.files.join('\n')
  useEffect(() => { void send('jobs:files', { id: job.id }).then(reply => { if (reply) setFound(reply.files) }) }, [send, job.id, key])
  if (!job.files.length) return <p className="text-sm text-muted-foreground">{t('files.empty')}</p>
  return <>{job.files.map(file => {
    const entry = found?.find(item => item.path === file)
    return <Item key={file} variant="outline" size="sm">
      <ItemMedia>{entry && !entry.exists ? <FileX className="size-4 text-destructive" /> : <Download className="size-4" />}</ItemMedia>
      <ItemContent>
        <ItemTitle className="break-all whitespace-normal">{file}</ItemTitle>
        <ItemDescription className={cn('tabular-nums', entry && !entry.exists && 'text-destructive')}>
          {!entry ? t('files.checking') : entry.exists ? entry.size !== undefined ? formatBytes(entry.size) : t('files.saved') : t('files.missing')}
        </ItemDescription>
      </ItemContent>
    </Item>
  })}</>
}
type InspectorTab = 'overview' | 'files' | 'log'
export function TaskInspector({ job, send, close, error }: { job?: Job; send: Send; close: () => void; error?: string }) {
  const { t } = useTranslation(['tasks', 'common'])
  const [tab, setTab] = useState<InspectorTab>('overview')
  return <Sheet open={Boolean(job)} onOpenChange={open => { if (!open) close() }}>
    <SheetContent side="right" className="sm:max-w-lg">
      <SheetHeader>
        <SheetTitle>{t('inspector.title')}</SheetTitle>
        <SheetDescription>{t('inspector.description')}</SheetDescription>
      </SheetHeader>
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto px-4 pb-4">
        {error && <Alert variant="destructive"><AlertTitle>{t('inspector.actionFailed')}</AlertTitle><AlertDescription>{error}</AlertDescription></Alert>}
        {job && <>
          <Item variant="muted">
            <ItemMedia variant="image" className="h-14 w-20"><Cover key={job.id} job={job} /></ItemMedia>
            <ItemContent>
              <ItemTitle className="line-clamp-2 whitespace-normal">{job.title}</ItemTitle>
              <ItemDescription className={statusTone[job.status]}>{t(`common:statuses.${job.status}`)}</ItemDescription>
            </ItemContent>
            <ItemActions><Actions job={job} send={send} /></ItemActions>
          </Item>
          <Tabs value={tab} onValueChange={value => setTab(value as InspectorTab)}>
            <TabsList>
              <TabsTrigger value="overview">{t('tabs.overview')}</TabsTrigger>
              <TabsTrigger value="files">{t('tabs.files')} ({job.files.length})</TabsTrigger>
              <TabsTrigger value="log">{t('tabs.log')}</TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="flex flex-col gap-4">
              {job.error && <Failure job={job} send={send} />}
              <Progress value={job.progress * 100} />
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm [&_dt]:text-muted-foreground">
                <dt>{t('fields.progress')}</dt><dd className="tabular-nums">{Math.round(job.progress * 100)}%</dd>
                <dt>{t('fields.platformKind')}</dt><dd>{platformLabel(job.platform)} / {t(`common:kinds.${job.kind || 'video'}`)}</dd>
                <dt>{t('fields.method')}</dt><dd>{job.method === 'browser' ? t('methods.browser') : t('methods.local')}</dd>
                {/* What the platform said about the media when it was parsed; older jobs carry none of it. */}
                {job.author && <><dt>{t('fields.author')}</dt><dd>{job.author}</dd></>}
                {job.publishedAt !== undefined && <><dt>{t('fields.publishedAt')}</dt><dd>{formatDate(job.publishedAt)}</dd></>}
                {job.duration !== undefined && <><dt>{t('fields.duration')}</dt><dd className="tabular-nums">{formatDuration(job.duration)}</dd></>}
                {(job.views ?? job.danmaku ?? job.comments ?? job.likes) !== undefined && <><dt>{t('fields.stats')}</dt><dd><MediaStatsRow views={job.views} danmaku={job.danmaku} comments={job.comments} likes={job.likes} className="text-sm" /></dd></>}
                <dt>{t('fields.source')}</dt><dd className="break-all">{job.url}</dd>
                <dt>{t('fields.directory')}</dt><dd className="break-all">{job.directory}</dd>
                <dt>{t('fields.downloaded')}</dt><dd className="tabular-nums">{job.downloaded !== undefined ? formatBytes(job.downloaded) : t('noData')}{job.total ? ` / ${formatBytes(job.total)}` : ''}</dd>
                <dt>{t('fields.speed')}</dt><dd className="tabular-nums">{job.status === 'running' && job.speed ? `${formatBytes(job.speed)}/s` : '—'}</dd>
                {job.status === 'running' && job.eta !== undefined && <><dt>{t('fields.eta')}</dt><dd className="tabular-nums">{formatDuration(job.eta)}</dd></>}
                {/* Breaks picked up again on their own since the last time it finished or was retried by hand. */}
                {job.attempts ? <><dt>{t('fields.autoResume')}</dt><dd className="tabular-nums">{t('attempts', { count: job.attempts })}</dd></> : null}
                <dt>{t('fields.createdAt')}</dt><dd>{localTime(job.createdAt)}</dd>
                {job.completedAt && <><dt>{t('fields.completedAt')}</dt><dd>{localTime(job.completedAt)}</dd></>}
              </dl>
              <TaskLimit key={`${job.id}-${job.speedLimit}`} job={job} send={send} />
            </TabsContent>
            <TabsContent value="files" className="flex flex-col gap-3">
              {tab === 'files' && <Files job={job} send={send} />}
              {job.status === 'completed' && <Button variant="outline" onClick={() => void send('jobs:action', { id: job.id, action: 'reveal' })}><FolderOpen />{t('openFolder')}</Button>}
            </TabsContent>
            <TabsContent value="log" className="flex flex-col gap-3">
              <p className="text-xs text-muted-foreground">{t('logNote')}</p>
              <pre className="activity-log max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">{job.logs.join('\n') || t('logEmpty')}</pre>
              <Button variant="outline" onClick={() => void send('logs:export', null)}>{t('exportLog')}</Button>
            </TabsContent>
          </Tabs>
        </>}
      </div>
    </SheetContent>
  </Sheet>
}
function TaskLimit({ job, send }: { job: Job; send: Send }) {
  const { t } = useTranslation(['tasks', 'common'])
  const [value, setValue] = useState(job.speedLimit || 0)
  const locked = job.status === 'running' || job.status === 'completed'
  return <form className="border-t pt-4" onSubmit={event => { event.preventDefault(); void send('jobs:limit', { id: job.id, speedLimit: value }) }}>
    <Field data-disabled={locked || undefined}>
      <FieldLabel htmlFor="task-limit">{t('limit.label')}</FieldLabel>
      <div className="flex gap-2">
        <Input id="task-limit" required type="number" min={0} max={1048576} value={value} onChange={event => setValue(event.target.valueAsNumber)} disabled={locked} />
        <Button variant="outline" disabled={locked}>{t('common:save')}</Button>
      </div>
      <FieldDescription>{t('limit.description')}</FieldDescription>
    </Field>
  </form>
}
