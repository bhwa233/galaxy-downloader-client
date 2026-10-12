import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ExternalLink, Link as LinkIcon, RotateCw, Search, Trash2 } from 'lucide-react'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { toast } from '@/components/ui/toast'
import { MediaCover } from './MediaCard'
import { formatRelative, platformLabel } from '@/lib/utils'
import type { HistoryEntry } from '../../../shared/contracts'
import type { Send } from '@/App'


// 解析历史: every successful parse, newest first, so one can be parsed again in a click.
export function History({ entries, send, reparse, parsing }: {
  entries: HistoryEntry[]; send: Send; reparse: (url: string) => void; parsing: boolean
}) {
  const { t } = useTranslation(['history', 'common'])
  const [query, setQuery] = useState('')
  if (!entries.length) return null
  const kindOf = (entry: HistoryEntry) => {
    const items = t('common:items', { count: entry.count })
    if (entry.listing) return `${t(`listing.${entry.listing}`)} · ${items}`
    return entry.count > 1 ? items : t('single')
  }
  const needle = query.trim().toLocaleLowerCase()
  const matches = needle ? entries.filter(entry => `${entry.title} ${platformLabel(entry.platform)}`.toLocaleLowerCase().includes(needle)) : entries
  const copy = (url: string) => void send('clipboard:write', { text: url }).then(ok => { if (ok) toast.add({ type: 'success', title: t('common:linkCopied') }) })
  return <section aria-labelledby="parse-history" className="flex flex-col gap-3 border-t pt-4">
    <div className="flex flex-wrap items-center gap-2">
      <h2 id="parse-history" className="font-medium">{t('title')}</h2>
      <span className="text-xs text-muted-foreground">{t('summary', { count: entries.length })}</span>
      <InputGroup className="ml-auto w-56">
        <InputGroupInput aria-label={t('searchLabel')} placeholder={t('searchPlaceholder')} value={query} onChange={event => setQuery(event.target.value)} />
        <InputGroupAddon><Search /></InputGroupAddon>
      </InputGroup>
      <AlertDialog>
        <AlertDialogTrigger render={<Button variant="ghost" size="sm" />}>{t('common:clear')}</AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('clearTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('clearDescription', { count: entries.length })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void send('history:clear', null).then(ok => { if (ok) toast.add({ type: 'success', title: t('cleared') }) })}>{t('common:clear')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
    {!matches.length ? <p className="py-4 text-center text-sm text-muted-foreground">{t('noMatch')}</p>
      : <ul className="flex flex-col divide-y rounded-lg border">{matches.map(entry => <ContextMenu key={entry.url}>
        {/* The row's own buttons again, on right-click, the way the result cards and the task list work. */}
        <ContextMenuTrigger render={<li className="flex items-center gap-3 px-3 py-2.5" />}>
          <MediaCover kind="video" thumbnail={entry.thumbnail} alt="" className="h-10 w-16 shrink-0 rounded-md" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm" title={entry.title}>{entry.title || t('common:untitled')}</p>
            <p className="truncate text-xs text-muted-foreground">{platformLabel(entry.platform)} · {kindOf(entry)} · {formatRelative(entry.parsedAt)}</p>
          </div>
          <Button variant="outline" size="sm" disabled={parsing} onClick={() => reparse(entry.url)}><RotateCw />{t('reparse')}</Button>
          <Button variant="ghost" size="icon-sm" aria-label={t('common:copyLink')} title={t('common:copyLink')} onClick={() => copy(entry.url)}><LinkIcon /></Button>
          <Button variant="ghost" size="icon-sm" aria-label={t('common:openPage')} title={t('common:openPage')} onClick={() => void send('shell:open', { url: entry.url })}><ExternalLink /></Button>
          <Button variant="ghost" size="icon-sm" aria-label={t('remove')} title={t('remove')} onClick={() => void send('history:remove', { url: entry.url })}><Trash2 /></Button>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44">
          <ContextMenuItem disabled={parsing} onClick={() => reparse(entry.url)}><RotateCw />{t('reparse')}</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => copy(entry.url)}><LinkIcon />{t('common:copyLink')}</ContextMenuItem>
          <ContextMenuItem onClick={() => void send('shell:open', { url: entry.url })}><ExternalLink />{t('common:openPage')}</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onClick={() => void send('history:remove', { url: entry.url })}><Trash2 />{t('remove')}</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>)}</ul>}
  </section>
}
