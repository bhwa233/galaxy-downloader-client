import { useState } from 'react'
import { Download, FolderOpen, Image, Music2, Pause, Play, RotateCcw, Video, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { formatBytes, formatDuration } from '@/lib/utils'
import type { Job } from '../../../shared/contracts'
import type { Send } from '@/App'

export const statuses: Record<Job['status'], string> = { queued: '等待中', running: '下载中', paused: '已暂停', completed: '已完成', cancelled: '已取消', failed: '失败' }
export const kinds = { video: '视频', audio: '音频', image: '图文' }
function Cover({ job }: { job: Job }) {
  const [broken, setBroken] = useState(false)
  const Icon = job.kind === 'image' ? Image : job.kind === 'audio' ? Music2 : Video
  return <div className={`task-cover cover-${job.kind || 'video'}`}>{!broken && job.thumbnail && /^https?:/.test(job.thumbnail) ? <img src={job.thumbnail} referrerPolicy="no-referrer" alt="" loading="lazy" onError={() => setBroken(true)} /> : <Icon aria-hidden="true" />}<span>{kinds[job.kind || 'video']}</span></div>
}
function Actions({ job, send }: { job: Job; send: Send }) {
  const [busy, setBusy] = useState(false)
  const run = (action: 'pause' | 'resume' | 'retry' | 'cancel' | 'reveal') => { setBusy(true); void send('jobs:action', { id: job.id, action }).finally(() => setBusy(false)) }
  return <div className="task-actions">{job.status === 'running' || job.status === 'queued' ? <><Button variant="ghost" size="icon" title="暂停" aria-label="暂停" disabled={busy} onClick={() => run('pause')}><Pause /></Button><Button variant="ghost" size="icon" title="取消" aria-label="取消" disabled={busy} onClick={() => run('cancel')}><X /></Button></> : job.status === 'completed' ? <Button variant="ghost" size="icon" aria-label="打开文件位置" title="打开文件位置" disabled={busy} onClick={() => run('reveal')}><FolderOpen /></Button> : <Button variant="ghost" size="icon" title={job.status === 'paused' ? '继续' : '重试'} aria-label={job.status === 'paused' ? '继续' : '重试'} disabled={busy} onClick={() => run(job.status === 'paused' ? 'resume' : 'retry')}>{job.status === 'paused' ? <Play /> : <RotateCcw />}</Button>}</div>
}
export function TaskCard({ job, send, select }: { job: Job; send: Send; select: () => void }) {
  return <article className={`task-row status-${job.status}`}>
    <button className="task-select" onClick={select} aria-label={`查看任务 ${job.title}`}><Cover job={job} /></button>
    <div className="task-body"><div className="task-heading"><button onClick={select} className="task-title" title={job.title}>{job.title}</button><span className={`status-label ${job.status}`}>{statuses[job.status]}</span></div>
      <div className="task-subtitle"><span>{job.platform}</span><span>·</span><span>{new Date(job.createdAt).toLocaleString()}</span></div>
      <Progress value={job.progress * 100} className="h-1.5" />
      <div className="task-metrics"><span>{job.downloaded !== undefined ? formatBytes(job.downloaded) : '—'}{job.total ? ` / ${formatBytes(job.total)}` : ''}</span><span>{job.status === 'running' ? job.speed ? `${formatBytes(job.speed)}/s` : '正在准备…' : `${Math.round(job.progress * 100)}%`}</span>{job.status === 'running' && job.eta !== undefined && <span>剩余 {formatDuration(job.eta)}</span>}</div>
      {job.error && <p className="task-error" title={job.error}>{job.error}</p>}
    </div><Actions job={job} send={send} />
  </article>
}
export function TaskInspector({ job, send, close, error }: { job?: Job; send: Send; close: () => void; error?: string }) {
  const [tab, setTab] = useState('概览')
  return <Dialog open={Boolean(job)} onOpenChange={open => { if (!open) close() }}><DialogContent placement="right" className="task-drawer"><DialogHeader><DialogTitle>任务详情</DialogTitle><DialogDescription>查看文件、下载状态和活动记录。</DialogDescription></DialogHeader>{error && <div role="alert" className="error-banner">{error}</div>}{job && <><div className="inspector-heading"><Cover key={job.id} job={job} /><h2>{job.title}</h2><span className={`status-label ${job.status}`}>{statuses[job.status]}</span><Actions job={job} send={send} /></div><nav className="inspector-tabs" aria-label="任务详情分类">{['概览', '文件', '活动日志'].map(name => <Button key={name} variant={tab === name ? 'secondary' : 'ghost'} onClick={() => setTab(name)}>{name}{name === '文件' ? ` (${job.files.length})` : ''}</Button>)}</nav>
      {tab === '概览' && <div className="space-y-5"><Progress value={job.progress * 100} /><dl className="task-facts"><dt>进度</dt><dd>{Math.round(job.progress * 100)}%</dd><dt>平台 / 类型</dt><dd>{job.platform} / {kinds[job.kind || 'video']}</dd><dt>解析方式</dt><dd>{job.method === 'chrome' ? 'Chrome 浏览器' : '本地解析'}</dd><dt>来源</dt><dd className="break-all">{job.url}</dd><dt>保存目录</dt><dd className="break-all">{job.directory}</dd><dt>已下载</dt><dd>{job.downloaded !== undefined ? formatBytes(job.downloaded) : '尚无数据'}</dd><dt>当前速度</dt><dd>{job.status === 'running' && job.speed ? `${formatBytes(job.speed)}/s` : '—'}</dd><dt>创建时间</dt><dd>{new Date(job.createdAt).toLocaleString()}</dd>{job.completedAt && <><dt>完成时间</dt><dd>{new Date(job.completedAt).toLocaleString()}</dd></>}</dl><TaskLimit key={`${job.id}-${job.speedLimit}`} job={job} send={send} />{job.error && <div role="alert" className="error-banner"><p>{job.error}</p><p className="mt-2">可重试任务；如果登录态失效，请先在浏览器登录并重新连接。</p></div>}</div>}
      {tab === '文件' && <div className="space-y-3">{job.files.length ? job.files.map(file => <div className="file-item" key={file}><Download className="size-4 shrink-0" /><span className="break-all">{file}</span></div>) : <p className="empty-copy">文件保存后会显示在这里。暂停和取消会保留已下载的部分文件。</p>}{job.status === 'completed' && <Button variant="outline" onClick={() => void send('jobs:action', { id: job.id, action: 'reveal' })}><FolderOpen />打开下载目录</Button>}</div>}
      {tab === '活动日志' && <><p className="text-xs text-muted-foreground">显示最近 150 条记录，敏感请求信息已隐藏。</p><pre className="activity-log">{job.logs.join('\n') || '暂无活动记录'}</pre><Button variant="outline" onClick={() => void send('logs:export', null)}>导出诊断日志</Button></>}
    </>}</DialogContent></Dialog>
}
function TaskLimit({ job, send }: { job: Job; send: Send }) {
  const [value, setValue] = useState(job.speedLimit || 0)
  return <form className="space-y-2 border-t pt-4" onSubmit={e => { e.preventDefault(); void send('jobs:limit', { id: job.id, speedLimit: value }) }}><label htmlFor="task-limit" className="text-sm">单任务限速（KiB/s）</label><div className="flex gap-2"><Input id="task-limit" required type="number" min={0} max={1048576} value={value} onChange={e => setValue(e.target.valueAsNumber)} disabled={job.status === 'running' || job.status === 'completed'} /><Button variant="outline" disabled={job.status === 'running' || job.status === 'completed'}>保存</Button></div><p className="text-xs text-muted-foreground">0 为不限速。下载中请先暂停，修改后继续任务。</p></form>
}
