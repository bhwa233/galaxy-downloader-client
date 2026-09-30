import { useState } from 'react'
import { ExternalLink, Link as LinkIcon, RotateCw, Search, Trash2 } from 'lucide-react'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { toast } from '@/components/ui/toast'
import { MediaCover } from './MediaCard'
import type { HistoryEntry } from '../../../shared/contracts'
import type { Send } from '@/App'

// 'Bilibili' is the name the engine files it under; the user knows it by its own.
const platformName = (platform: string) => platform === 'Bilibili' ? '哔哩哔哩' : platform

function kindOf(entry: HistoryEntry): string {
  if (entry.listing === 'parts') return `分P · ${entry.count} 项`
  if (entry.listing === 'collection') return `合集 · ${entry.count} 项`
  if (entry.listing === 'profile') return `主页 · ${entry.count} 项`
  return entry.count > 1 ? `${entry.count} 项` : '单条'
}

// Near times said the way a person would; older ones as a date.
function when(iso: string): string {
  const seconds = (Date.now() - Date.parse(iso)) / 1000
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`
  if (seconds < 172_800) return '昨天'
  const date = new Date(iso)
  return `${date.getMonth() + 1}-${date.getDate()}`
}

// 解析历史: every successful parse, newest first, so one can be parsed again in a click.
export function History({ entries, send, reparse, parsing }: {
  entries: HistoryEntry[]; send: Send; reparse: (url: string) => void; parsing: boolean
}) {
  const [query, setQuery] = useState('')
  if (!entries.length) return null
  const needle = query.trim().toLocaleLowerCase()
  const matches = needle ? entries.filter(entry => `${entry.title} ${platformName(entry.platform)}`.toLocaleLowerCase().includes(needle)) : entries
  const copy = (url: string) => void send('clipboard:write', { text: url }).then(ok => { if (ok) toast.add({ type: 'success', title: '链接已复制' }) })
  return <section aria-labelledby="parse-history" className="flex flex-col gap-3 border-t pt-4">
    <div className="flex flex-wrap items-center gap-2">
      <h2 id="parse-history" className="font-medium">解析历史</h2>
      <span className="text-xs text-muted-foreground">{entries.length} 条，仅保存在本机</span>
      <InputGroup className="ml-auto w-56">
        <InputGroupInput aria-label="搜索解析历史" placeholder="搜索标题…" value={query} onChange={event => setQuery(event.target.value)} />
        <InputGroupAddon><Search /></InputGroupAddon>
      </InputGroup>
      <AlertDialog>
        <AlertDialogTrigger render={<Button variant="ghost" size="sm" />}>清空</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>清空解析历史？</AlertDialogTitle>
            <AlertDialogDescription>只删除这 {entries.length} 条解析记录，不影响下载任务和已下载的文件。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>取消</AlertDialogCancel>
            <AlertDialogAction onClick={() => void send('history:clear', null).then(ok => { if (ok) toast.add({ type: 'success', title: '解析历史已清空' }) })}>清空</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    {!matches.length ? <p className="py-4 text-center text-sm text-muted-foreground">没有匹配的解析记录</p>
      : <ul className="flex flex-col divide-y rounded-lg border">{matches.map(entry => <ContextMenu key={entry.url}>
        {/* The row's own buttons again, on right-click, the way the result cards and the task list work. */}
        <ContextMenuTrigger render={<li className="flex items-center gap-3 px-3 py-2.5" />}>
          <MediaCover kind="video" thumbnail={entry.thumbnail} alt="" className="h-10 w-16 shrink-0 rounded-md" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm" title={entry.title}>{entry.title || '未知标题'}</p>
            <p className="truncate text-xs text-muted-foreground">{platformName(entry.platform)} · {kindOf(entry)} · {when(entry.parsedAt)}</p>
          </div>
          <Button variant="outline" size="sm" disabled={parsing} onClick={() => reparse(entry.url)}><RotateCw />重新解析</Button>
          <Button variant="ghost" size="icon-sm" aria-label="复制链接" title="复制链接" onClick={() => copy(entry.url)}><LinkIcon /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="打开原网页" title="打开原网页" onClick={() => void send('shell:open', { url: entry.url })}><ExternalLink /></Button>
          <Button variant="ghost" size="icon-sm" aria-label="删除这条记录" title="删除这条记录" onClick={() => void send('history:remove', { url: entry.url })}><Trash2 /></Button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44">
          <ContextMenuItem disabled={parsing} onClick={() => reparse(entry.url)}><RotateCw />重新解析</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => copy(entry.url)}><LinkIcon />复制链接</ContextMenuItem>
          <ContextMenuItem onClick={() => void send('shell:open', { url: entry.url })}><ExternalLink />打开原网页</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onClick={() => void send('history:remove', { url: entry.url })}><Trash2 />删除这条记录</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>)}</ul>}
  </section>
}
