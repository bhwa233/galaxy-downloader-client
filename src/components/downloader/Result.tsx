import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Check, Copy, Download, ExternalLink, FolderOpen, Image as ImageIcon, ImageDown, LayoutGrid, Link as LinkIcon, List, ListChecks, Music2, Play, Search, Video, X } from 'lucide-react'
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger, ContextMenuTrigger } from '@/components/ui/context-menu'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { MediaCard, MediaGrid, MediaRow } from './MediaCard'
import { Field, FieldLabel } from '@/components/ui/field'
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group'
import { Spinner } from '@/components/ui/spinner'
import { toast } from '@/components/ui/toast'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Choice } from './Choice'
import { fixableBySignIn, wallTitle } from './walls'
import { formatBytes, platformLabel } from '@/lib/utils'
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { downloadKinds, type ClientState, type DownloadKind, type MediaItem, type MediaResult, type Settings } from '../../../shared/contracts'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { Send } from '@/App'
// What a card can do, handed down once rather than prop by prop.
type Actions = {
  selected: string[]
  toggle: (id: string, checked: boolean) => void
  // Ticks everything from the last card toggled up to this one.
  rangeTo?: (id: string) => void
  // Called before the click reaches the checkbox, so a Shift+click can become a range.
  shift: (event: React.MouseEvent) => void
  sizeOf: (item: MediaItem) => string | undefined
  downloadOne: (item: MediaItem, kind: DownloadKind) => void
  // The text, and what to say once it is on the clipboard.
  copy: (text: string, done: string) => void
  open: (url: string) => void
  saveCover: (item: MediaItem) => void
  preview: (item: MediaItem) => void
  // 只看图片 is on: every card is a picture, a video's being its cover.
  pictures: boolean
  // The page a single parse was read from, for the items that have no page of their own.
  page: string
}
type ViewProps = { items: MediaItem[]; actions: Actions }
// How far back 时间 reaches, in days; 'all' does not filter.
const PERIODS = [{ value: 'all', key: 'all' }, { value: '7', key: 'week' }, { value: '30', key: 'month' }, { value: '90', key: 'quarter' }, { value: '365', key: 'year' }] as const
type T = TFunction<['result', 'common']>
// A picture is already on screen as its cover, and a locked item would not play for this account.
const previewable = (item: MediaItem) => item.kind !== 'image' && !item.wall
const hasCover = (item: MediaItem) => Boolean(item.thumbnail && /^https?:\/\//.test(item.thumbnail))
// Under 只看图片 a video stands in as its cover, downloaded as one. It keeps its own shape, so the
// cover is shown whole rather than cropped square.
const asPicture = (item: MediaItem, actions: Actions, t: T) => actions.pictures && item.kind !== 'image'
  ? { duration: undefined, label: t('common:kinds.cover'), size: undefined, onPreview: undefined }
  : { size: actions.sizeOf(item), onPreview: previewable(item) ? () => actions.preview(item) : undefined }

// An item behind a wall - a paid 短剧 episode - is listed so the whole show reads as it is, but cannot
// be picked. The card carries the reason; a click, which is the user trying, says it as a toast.
const lockedProps = (item: MediaItem, t: T) => item.wall
  ? { locked: wallTitle(item.wall), onLocked: () => toast.add({ type: 'info', title: wallTitle(item.wall!), description: t('locked', { title: item.title.slice(0, 40) }) }) }
  : {}

// Right-clicking a card. What acts on the item comes first, then the selection, then its addresses. A
// locked item keeps only the addresses: nothing can be queued from it. 'contents' keeps the trigger
// out of the layout, so wrapping a grid cell does not become a cell; it is also where a Shift+click is
// noticed before the checkbox inside acts on it.
function ItemMenu({ item, actions, children }: { item: MediaItem; actions: Actions; children: React.ReactNode }) {
  const { t } = useTranslation(['result', 'common'])
  const url = item.url || actions.page
  const picked = actions.selected.includes(item.id)
  const cover = item.thumbnail && /^https?:\/\//.test(item.thumbnail) ? item.thumbnail : undefined
  return <ContextMenu>
    <ContextMenuTrigger render={<div className="contents" onClickCapture={actions.shift} onMouseDownCapture={event => { if (event.shiftKey) event.preventDefault() }} />}>{children}</ContextMenuTrigger>
    <ContextMenuContent className="w-48">
      {!item.wall && <>
        {previewable(item) && <ContextMenuItem onClick={() => actions.preview(item)}><Play />{t('preview')}</ContextMenuItem>}
        <ContextMenuSub>
          <ContextMenuSubTrigger><Download />{t('menu.downloadOne')}</ContextMenuSubTrigger>
          <ContextMenuSubContent className="w-36">
            <ContextMenuItem onClick={() => actions.downloadOne(item, 'video')}>{item.kind === 'image' ? <><ImageIcon />{t('common:kinds.picture')}</> : <><Video />{t('common:kinds.video')}</>}</ContextMenuItem>
            {item.kind !== 'image' && <ContextMenuItem onClick={() => actions.downloadOne(item, 'audio')}><Music2 />{t('common:kinds.audio')}</ContextMenuItem>}
            {cover && <ContextMenuItem onClick={() => actions.downloadOne(item, 'cover')}><ImageDown />{t('common:kinds.cover')}</ContextMenuItem>}
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => actions.toggle(item.id, !picked)}>{picked ? <><X />{t('menu.deselect')}</> : <><Check />{t('menu.select')}</>}</ContextMenuItem>
        {actions.rangeTo && <ContextMenuItem onClick={() => actions.rangeTo!(item.id)}><ListChecks />{t('menu.selectToHere')}</ContextMenuItem>}
        <ContextMenuSeparator />
      </>}
      <ContextMenuItem onClick={() => actions.copy(url, t('common:linkCopied'))}><LinkIcon />{t('common:copyLink')}</ContextMenuItem>
      <ContextMenuItem onClick={() => actions.copy(item.title, t('copied.title'))}><Copy />{t('menu.copyTitle')}</ContextMenuItem>
      {cover && <ContextMenuItem onClick={() => actions.copy(cover, t('copied.cover'))}><ImageIcon />{t('menu.copyCover')}</ContextMenuItem>}
      {cover && <ContextMenuItem onClick={() => actions.saveCover(item)}><ImageDown />{t('menu.saveCover')}</ContextMenuItem>}
      <ContextMenuItem onClick={() => actions.open(url)}><ExternalLink />{t('common:openPage')}</ContextMenuItem>
    </ContextMenuContent>
  </ContextMenu>
}
const qualityLabel = (formats: MediaItem['formats'], kind: MediaItem['kind'], t: T) => formats.length ? t('quality.count', { count: formats.length }) : kind === 'image' ? t('quality.original') : kind === 'audio' ? t('common:kinds.audio') : t('quality.best')
function ThumbnailGrid({ items, actions }: ViewProps) {
  const { t } = useTranslation(['result', 'common'])
  return <MediaGrid minWidth="11rem" className="select-none">{items.map(({ id, formats: _formats, wall: _wall, ...shown }, index) =>
    <ItemMenu key={id} item={items[index]} actions={actions}>
      <MediaCard {...shown} {...lockedProps(items[index], t)} {...asPicture(items[index], actions, t)} selected={actions.selected.includes(id)} onSelectedChange={checked => actions.toggle(id, checked)} />
    </ItemMenu>)}</MediaGrid>
}
function ItemList({ items, actions }: ViewProps) {
  const { t } = useTranslation(['result', 'common'])
  return <div className="flex flex-col gap-2 select-none">{items.map(({ id, formats, wall: _wall, ...shown }, index) =>
    <ItemMenu key={id} item={items[index]} actions={actions}>
      <MediaRow {...shown} {...lockedProps(items[index], t)} {...asPicture(items[index], actions, t)} selected={actions.selected.includes(id)} onSelectedChange={checked => actions.toggle(id, checked)} trailing={<Badge variant="outline">{actions.pictures ? shown.kind === 'image' ? t('quality.original') : t('common:kinds.cover') : qualityLabel(formats, shown.kind, t)}</Badge>} />
    </ItemMenu>)}</div>
}
export function Result({ result, parse, settings, send, login, connecting, close }: {
  result: MediaResult; parse: ClientState['parse']; settings: Settings; send: Send
  login: (url?: string) => void; connecting: boolean; close: () => void
}) {
  const { t } = useTranslation(['result', 'common'])
  const [submitting, setSubmitting] = useState(false)
  // The first item comes picked, so a single video is ready to download without a click and a listing
  // starts somewhere rather than at nothing; 全选 covers everything loaded when they want all of it.
  // Only at mount, which is per parse: 加载更多 keeps whatever the user has ticked by then.
  const [selected, setSelected] = useState<string[]>(() => { const first = result.items.find(item => !item.wall); return first ? [first.id] : [] })
  const [format, setFormat] = useState('best')
  // What to download of each ticked item, any combination of the three. Back to the media alone on
  // every parse, so a choice made for one result does not quietly carry over to the next.
  const [kinds, setKinds] = useState<DownloadKind[]>(['video'])
  const [loading, setLoading] = useState(false)
  // Which tab is open, where the result has more than one. Held by id rather than by index so loading
  // more, which rebuilds the result, does not move the user to another tab.
  const [tab, setTab] = useState<string | undefined>(result.groups?.[0]?.id)
  const [only, setOnly] = useState('all')
  // 关键字 and 时间, top right. The cut-off is taken when the period is picked rather than on every
  // render, so the list does not change under the user as the clock moves.
  const [keyword, setKeyword] = useState('')
  const [period, setPeriod] = useState('all')
  const [since, setSince] = useState<number>()
  // The last card toggled, which a Shift+click or 选中到这里 extends from, and whether the click being
  // handled right now had Shift held.
  const anchor = useRef<string | undefined>(undefined)
  const shiftHeld = useRef(false)
  const tabs = result.groups && result.groups.length > 1 ? result.groups : undefined
  const group = result.groups?.find(entry => entry.id === tab) || result.groups?.[0]
  // Only the open tab is on screen; the selection stays whole, so what was ticked in the other one is
  // still downloaded. Pagination belongs to the tab as well: 分P arrive in one reply and a 合集 has pages.
  const inGroup = group ? result.items.filter(item => group.itemIds.includes(item.id)) : result.items
  // 只看 narrows what is on screen, which is also what 全选 picks - a filter that only hid rows while
  // the button below still queued everything would be a filter in name only. Off unless the result is
  // a listing: a single work is not a batch and has nothing to filter.
  // 图片 takes the listing as pictures: a 图文's own and every video's cover, which is what it then
  // downloads - a video picked there is saved as its cover, not as the video.
  const pictures = Boolean(result.listing) && only === 'image'
  // Both narrow what is loaded, like 只看, and so what 全选 picks. 时间 is offered only where the
  // platform said when anything was published; an item it said nothing about is left out once a
  // period is picked, since it cannot be shown to be inside it.
  const searchable = inGroup.length > 1
  const dated = searchable && inGroup.some(item => item.publishedAt !== undefined)
  const needle = keyword.trim().toLocaleLowerCase()
  const matches = (item: MediaItem) => (!needle || item.title.toLocaleLowerCase().includes(needle))
    && (since === undefined || (item.publishedAt !== undefined && item.publishedAt >= since))
  const visible = (!result.listing ? inGroup : inGroup.filter(item => only === 'all' || (only === 'image' ? item.kind === 'image' || hasCover(item) : item.kind !== 'image'))).filter(matches)
  // 设置 → 单次批量上限. Not editable here: one place to set it, and the result says when it applied.
  const cap = settings.batchLimit > 0 ? settings.batchLimit : undefined
  const pagination = group?.pagination
  // The next page is added below what is already here; nothing loaded so far goes away.
  const loadMore = () => { if (loading || !pagination?.hasMore) return; setLoading(true); void send('media:page', { resultId: result.id, page: pagination.index + 1, groupId: group?.id }).finally(() => setLoading(false)) }
  // Covers carry the meaning in a listing or a set of pictures; a single video reads better as a row.
  // Picking a view stores it, so from then on the choice holds for every result.
  const view = settings.resultView === 'auto' ? (result.listing || result.items.every(item => item.kind === 'image') ? 'grid' : 'list') : settings.resultView
  const selectedItems = result.items.filter(item => selected.includes(item.id))
  // A single work offers its own tiers. A listing's entries have none, so it offers the tiers read off
  // its first video, for every video it queues; one that a later video lacks falls back to its best.
  const own = selectedItems.length === 1 ? selectedItems[0].formats : []
  const formats = own.length ? own : result.listing ? result.formats || [] : []
  const reading = Boolean(result.listing) && !result.formats
  // 全选 is everything loaded that can be picked; a locked item is never part of it.
  const pickable = visible.filter(item => !item.wall)
  const pageSelected = pickable.length > 0 && pickable.every(item => selected.includes(item.id))
  // What this click would actually queue. Taken in listing order rather than in the order the user
  // happened to tick things, so a cap of 20 means the first twenty of the list every time. The button
  // below counts this, not the selection: saying "下载所选 (200)" and queueing 20 would be a lie.
  const queueing = (cap ? selectedItems.slice(0, cap) : selectedItems).map(item => item.id)
  // Ticks or unticks every pickable card between two, in the order they are on screen.
  const between = (from: string, to: string) => {
    const order = visible.filter(item => !item.wall).map(item => item.id)
    const [start, end] = [order.indexOf(from), order.indexOf(to)].sort((first, second) => first - second)
    return start < 0 ? [to] : order.slice(start, end + 1)
  }
  // A listing's tier list is the same whatever is ticked, so ticking keeps the chosen tier; a single
  // work's list changes with the item, so there it goes back to the default. A Shift+click extends
  // from the last card toggled, the way a file list does.
  const toggle = (id: string, checked: boolean) => {
    if (checked && result.items.find(item => item.id === id)?.wall) return
    if (!result.listing) setFormat('best')
    const ids = shiftHeld.current && anchor.current && anchor.current !== id ? between(anchor.current, id) : [id]
    shiftHeld.current = false
    anchor.current = id
    setSelected(current => checked ? [...new Set([...current, ...ids])] : current.filter(item => !ids.includes(item)))
  }
  const rangeTo = (id: string) => {
    const from = anchor.current || selected[0]
    const ids = from ? between(from, id) : [id]
    anchor.current = id
    setSelected(current => [...new Set([...current, ...ids])])
  }
  // The tier a download of this item would get: the chosen one where the item has it, otherwise the
  // best within 设置's quality cap - the same choice the queue makes.
  const heightCap = settings.videoQuality !== 'best' ? Number(settings.videoQuality) : undefined
  const tierOf = (list: MediaItem['formats']) => list.find(entry => entry.id === format)
    ?? list.find(entry => !heightCap || (entry.height || 0) <= heightCap) ?? list[list.length - 1]
  // Estimated, and said so: an item's own tier size where it has tiers; on a listing, the bitrate of
  // the tier read off its first video times this item's own duration. Nothing where neither is known.
  // A tier picked by name downloads its AVC variant, so its own size; 默认画质 - or a picked tier this
  // item lacks, which falls back to it - lets the engine take its preferred variant, often HEVC or VP9
  // at half the size, so that one's (measured 2026-09-24: 72.8 MB shown for a 33.9 MB download before).
  const bytesOf = (item: MediaItem): number | undefined => {
    if (item.kind === 'image' || item.wall) return undefined
    const list = item.formats.length ? item.formats : result.listing ? result.formats || [] : []
    const tier = tierOf(list)
    if (!tier) return undefined
    const picked = tier.id === format
    if (item.formats.length) return picked ? tier.size : tier.preferredSize ?? tier.size
    const bitrate = picked ? tier.bitrate : tier.preferredBitrate ?? tier.bitrate
    // A listing estimate is valid only when the sample exposes a measured bitrate. Never invent a
    // size from a missing or zero bitrate; unknown is safer than a multi-GB display.
    return bitrate && bitrate > 0 && item.duration && item.duration > 0 ? Math.round(bitrate * 1000 / 8 * item.duration) : undefined
  }
  const sizeOf = (item: MediaItem) => { const bytes = bytesOf(item); return bytes ? t('about', { size: formatBytes(bytes) }) : undefined }
  // How many tasks each kind makes of what would be queued: a picture has no audio, and an item with
  // no cover address has no cover. What is left out is said in the bar, not discovered afterwards.
  const queuedItems = queueing.map(id => result.items.find(item => item.id === id)!)
  const counts: Record<DownloadKind, number> = {
    video: queuedItems.length,
    audio: queuedItems.filter(item => item.kind !== 'image').length,
    cover: queuedItems.filter(item => item.thumbnail && /^https?:\/\//.test(item.thumbnail)).length,
  }
  // Under 只看图片 each item is one picture task: a 图文's images, or a video's cover where it has one.
  const pictureKind = (item: MediaItem): DownloadKind => item.kind === 'image' ? 'video' : 'cover'
  const pictured = queuedItems.filter(item => item.kind === 'image' || hasCover(item)).length
  const tasks = pictures ? pictured : kinds.reduce((sum, kind) => sum + counts[kind], 0)
  const skipped = pictures
    ? pictured < queuedItems.length ? [t('missing.cover', { count: queuedItems.length - pictured })] : []
    : kinds.filter(kind => counts[kind] < queuedItems.length).map(kind => t(`missing.${kind}`, { count: queuedItems.length - counts[kind] }))
  const selectAll = (checked: boolean) => { const ids = pickable.map(item => item.id); setSelected(current => checked ? [...new Set([...current, ...ids])] : current.filter(id => !ids.includes(id))) }
  const download = () => {
    if (submitting) return
    setSubmitting(true)
    // Pictures are asked for in two parts, because what a picture is differs by kind: a 图文's
    // media is its images, a video's picture is its cover.
    const requests = pictures
      ? (['video', 'cover'] as const).map(kind => ({ kind, itemIds: queuedItems.filter(item => pictureKind(item) === kind).map(item => item.id) }))
        .filter(entry => entry.itemIds.length).map(entry => send('media:download', { resultId: result.id, itemIds: entry.itemIds, format: 'best', kinds: [entry.kind] }))
      : [send('media:download', { resultId: result.id, itemIds: queueing, format: kinds.includes('video') ? tierFor(queuedItems) : 'best', kinds })]
    void Promise.all(requests)
      .then(replies => {
        if (replies.some(reply => !reply)) return
        // Nothing added means every one of them was already on its way; saying so beats claiming
        // to have started downloads that were started earlier.
        const added = replies.reduce((sum, reply) => sum + (reply ? reply.added ?? 0 : 0), 0)
        if (added) toast.add({ type: 'success', title: t('toast.queued'), description: t('toast.started', { count: added }) + (added < tasks ? t('toast.alsoQueued', { count: tasks - added }) : '') })
        else toast.add({ type: 'info', title: t('toast.inQueue'), description: t('toast.allInQueue', { count: tasks }) })
      })
      .finally(() => setSubmitting(false))
  }
  // The chosen tier where every one of these can take it - their own tiers, or a listing's - and the
  // default where it cannot.
  const tierFor = (picked: MediaItem[]) => picked.every(item => item.kind === 'image' || item.formats.some(entry => entry.id === format) || (result.listing && result.formats?.some(entry => entry.id === format))) ? format : 'best'
  // One card queued from its menu, whatever else is ticked - the selection is left as it was.
  const downloadOne = (item: MediaItem, kind: DownloadKind) => {
    void send('media:download', { resultId: result.id, itemIds: [item.id], format: kind === 'video' ? tierFor([item]) : 'best', kinds: [kind] })
      .then(reply => {
        if (!reply) return
        if (reply.added === 0) toast.add({ type: 'info', title: t('toast.inQueue'), description: t('toast.oneInQueue', { title: item.title.slice(0, 40), kind: t(`common:kinds.${kind}`) }) })
        else toast.add({ type: 'success', title: t('toast.queuedKind', { kind: t(`common:kinds.${kind}`) }), description: item.title.slice(0, 60) })
      })
  }
  const actions: Actions = {
    selected, toggle, sizeOf, downloadOne, page: result.url,
    rangeTo: result.items.length > 1 ? rangeTo : undefined,
    shift: event => { shiftHeld.current = event.shiftKey },
    // Through the main process rather than navigator.clipboard, which a page loaded from file:// is not
    // a secure enough context to be given.
    copy: (text, done) => void send('clipboard:write', { text }).then(ok => { if (ok) toast.add({ type: 'success', title: done }) }),
    open: url => void send('shell:open', { url }),
    saveCover: item => void send('media:cover', { url: item.thumbnail!, title: item.title }),
    preview: item => void send('media:preview', { resultId: result.id, itemId: item.id }),
    pictures,
  }
  // What the selection adds up to, from the items whose size could be estimated.
  const queuedBytes = queueing.reduce((sum, id) => sum + (bytesOf(result.items.find(item => item.id === id)!) || 0), 0)
  // No card of its own: the page is the new-task page and this is its result, so one title, one close.
  return <section aria-label={t('title')} className="flex flex-col gap-4">
    <div className="flex items-start gap-3 border-t pt-4">
      <div className="min-w-0 flex-1">
        <h2 className="line-clamp-2 font-medium break-words" title={result.title}>{result.title}</h2>
        <p className="text-xs text-muted-foreground">
          {platformLabel(result.platform)} · {pagination?.total ? t('loadedOf', { total: pagination.total, loaded: inGroup.length }) : t('common:items', { count: inGroup.length })}
        </p>
      </div>
      {searchable && <InputGroup className="w-44">
        <InputGroupInput aria-label={t('keywordLabel')} placeholder={t('keywordPlaceholder')} value={keyword} onChange={event => setKeyword(event.target.value)} />
        <InputGroupAddon><Search /></InputGroupAddon>
      </InputGroup>}
      {dated && <Choice className="w-28" label={t('published')} hideLabel value={period} options={PERIODS.map(entry => ({ value: entry.value, label: t(`periods.${entry.key}`) }))}
        onChange={value => { setPeriod(value); setSince(value === 'all' ? undefined : Date.now() / 1000 - Number(value) * 86_400) }} />}
      <ToggleGroup spacing={0} variant="outline" value={[view]} onValueChange={value => { const next = value[0]; if (next && next !== view) void send('settings:save', { ...settings, resultView: next as Settings['resultView'] }) }}>
        <ToggleGroupItem value="list" aria-label={t('listView')}><List /></ToggleGroupItem>
        <ToggleGroupItem value="grid" aria-label={t('gridView')}><LayoutGrid /></ToggleGroupItem>
      </ToggleGroup>
      <Button variant="ghost" size="icon" aria-label={t('clearResult')} title={t('clearResult')} onClick={close}><X /></Button>
    </div>
    {/* Only where the same parse produced two listings - a 哔哩哔哩 video that is multi-part and also
        belongs to a collection. Switching sends no request: both arrived with the parse, and what was
        ticked in the other tab stays ticked and stays in the download below. */}
    {(tabs || result.listing) && <div className="flex flex-wrap items-center gap-3">
      {tabs && <Tabs value={group?.id} onValueChange={value => setTab(String(value))}>
        <TabsList>{tabs.map(entry => <TabsTrigger key={entry.id} value={entry.id}>{entry.title}<Badge variant="secondary">{entry.pagination?.total ?? entry.itemIds.length}</Badge></TabsTrigger>)}</TabsList>
      </Tabs>}
      {/* 只看 only on a listing: a single work is not a batch and has nothing to filter. It narrows
          what is on screen, which is also what 全选 takes. */}
      {result.listing && <ToggleGroup spacing={0} variant="outline" size="sm" value={[only]} onValueChange={value => { const next = value[0]; if (next) setOnly(String(next)) }}>
        <ToggleGroupItem value="all">{t('onlyAll')}</ToggleGroupItem>
        <ToggleGroupItem value="video">{t('common:kinds.video')}</ToggleGroupItem>
        <ToggleGroupItem value="image">{t('common:kinds.picture')}</ToggleGroupItem>
      </ToggleGroup>}
    </div>}
    {/* The engine stops a playlist at its own limit, so a list that reached it is only its front. */}
    {result.truncated && <Alert>
      <AlertTitle>{t('truncated.title', { count: result.truncated.shown })}</AlertTitle>
      <AlertDescription>{result.truncated.total ? t('truncated.total', { total: result.truncated.total }) : t('truncated.limit')}{t('truncated.hint')}</AlertDescription>
    </Alert>}
    {/* One block in the platform's own order. Each card says what it is, and 只看 splits by kind when
        wanted, so sections per kind only broke the order the listing came in. It grows with the page
        rather than scrolling inside a box of its own - 解析历史 is hidden while a result is open, so
        there is nothing below it to keep in reach, and the download bar stays pinned regardless. The
        padding keeps the selected card's ring from being clipped at the edge. */}
    <div className="-mx-1 flex flex-col gap-4 p-1">
      {!visible.length && inGroup.length ? <p className="py-8 text-center text-sm text-muted-foreground">{t('noMatch')}</p>
        : view === 'grid' ? <ThumbnailGrid items={visible} actions={actions} /> : <ItemList items={visible} actions={actions} />}
      {/* A result on screen with a message attached means the page the user asked for did not arrive.
          It is reported here, at the end of the list, next to the control they used. */}
      {parse.message && <Alert variant="destructive">
        <AlertTitle>{parse.verify ? t('common:verifyTitle') : (parse.wall && wallTitle(parse.wall)) || t('loadMoreFailed')}</AlertTitle>
        <AlertDescription>{parse.message}</AlertDescription>
        {(parse.verify || fixableBySignIn(parse.wall)) && <AlertAction>
          {/* The page is loaded again on its own once the window closes, so this is the only click. */}
          <Button variant="outline" size="sm" disabled={connecting} onClick={() => login(parse.loginUrl || '')}>{parse.verify ? t('common:openVerify') : t('common:openLogin')}</Button>
        </AlertAction>}
      </Alert>}
      {pagination?.hasMore && <div className="flex justify-center">
        <Button variant="outline" disabled={loading} onClick={loadMore}>
          {loading ? <Spinner aria-hidden="true" /> : null}{loading ? t('loading') : t('loadMore')}
        </Button>
      </div>}
    </div>
    {/* Pinned to the bottom of the page while the list scrolls, so what is ticked can be downloaded
        from wherever the user is in it, instead of scrolling back to the top for the button. */}
    <div className="sticky bottom-0 z-10 -mx-2 flex flex-wrap items-center gap-3 rounded-xl border bg-background/95 px-4 py-3 shadow-lg backdrop-blur supports-[backdrop-filter]:bg-background/80">
      {result.items.length > 1 && <Field orientation="horizontal" className="w-fit">
        <Checkbox id="result-select-all" checked={pageSelected} disabled={!pickable.length} onCheckedChange={checked => selectAll(checked === true)} />
        <FieldLabel htmlFor="result-select-all" className="font-normal">{t('selectAll')}</FieldLabel>
      </Field>}
      <span className="text-sm text-muted-foreground tabular-nums">
        {t('selected', { count: selectedItems.length })}{result.items.length > 1 ? ` / ${pickable.length}` : ''}
        {cap && selectedItems.length > cap ? t('capNote', { count: cap }) : ''}
        {queuedBytes && kinds.includes('video') && !pictures ? ` · ${t('about', { size: formatBytes(queuedBytes) })}` : ''}
        {skipped.length ? t('skipped', { list: skipped.join(t('listSeparator')) }) : ''}
      </span>
      <div className="ml-auto flex flex-wrap items-center gap-3">
        {/* 下载内容: any combination of the media, its audio and its cover. Never empty - unticking the
            last one leaves it ticked. The audio format is 设置's, not chosen here. */}
        <Field className="w-36">
          <FieldLabel className="sr-only">{t('downloadContent')}</FieldLabel>
          <Select multiple disabled={pictures} value={kinds} onValueChange={next => { const list = next as DownloadKind[]; if (list.length) setKinds(downloadKinds.filter(kind => list.includes(kind))) }}>
            <SelectTrigger aria-label={t('downloadContent')} className="w-full"><SelectValue>{() => pictures ? t('common:kinds.picture') : kinds.map(kind => t(`common:kinds.${kind}`)).join(' + ')}</SelectValue></SelectTrigger>
            <SelectContent><SelectGroup>{downloadKinds.map(kind => <SelectItem key={kind} value={kind}>{t(`common:kinds.${kind}`)}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>
        </Field>
        {/* Always here, whatever is chosen: a control that does not apply says so by being disabled
            rather than by leaving a hole where it was. Only the media itself has a quality. */}
        <Choice className="w-44" label={t('quality.label')} hideLabel disabled={pictures || !kinds.includes('video')} value={format} onChange={setFormat} options={[{ value: 'best', label: reading ? t('quality.reading') : t('quality.default') }, ...formats.map(item => ({ value: item.id, label: item.label || item.id }))]} />
        <Button variant="ghost" size="sm" className="max-w-56 justify-start overflow-hidden text-muted-foreground" title={t('saveTo', { dir: settings.downloadDirectory })} onClick={() => void send('settings:directory', null)}>
          <FolderOpen /><span className="truncate">{settings.downloadDirectory}</span>
        </Button>
        {/* Enqueueing says so and leaves the listing where it is: the tasks are there whenever they look. */}
        <Button disabled={!queueing.length || submitting} onClick={download}><Download />{pictures ? t('download.pictures', { count: tasks }) : kinds.length > 1 ? t('download.files', { count: tasks }) : kinds[0] === 'video' ? t('download.items', { count: tasks }) : kinds[0] === 'audio' ? t('download.audio', { count: tasks }) : t('download.cover', { count: tasks })}</Button>
      </div>
    </div>
  </section>
}
