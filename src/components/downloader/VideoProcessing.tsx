import { memo, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Captions, Download, FilePlus2, Play, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Progress } from '@/components/ui/progress'
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty'
import { Choice } from './Choice'
import { formatBytes, formatDuration, cn } from '@/lib/utils'
import type { ClientState, Command, CommandInput } from '../../../shared/contracts'
import type { Caption, ModelId, ProcessingDocument } from '../../../shared/processing'
import type { Send } from '@/App'

const CaptionRow = memo(function CaptionRow({ cue, speaker, selected, select, play }: { cue: Caption; speaker?: string; selected: boolean; select: () => void; play: () => void }) {
  const { t } = useTranslation('processing')
  return <div className={cn('flex gap-3 rounded-md border p-3 [content-visibility:auto] [contain-intrinsic-size:auto_80px]', selected && 'border-selection bg-selection/5')}>
    <Button variant="ghost" size="sm" className="shrink-0 tabular-nums" title={t('play')} onClick={play}><Play />{formatDuration(cue.startMs / 1000)}</Button>
    <button className="min-w-0 flex-1 text-left" onClick={select}><span className="mb-1 block text-xs text-muted-foreground">{speaker || t('unknown')}</span><span className="whitespace-pre-wrap text-sm">{cue.text}</span></button>
  </div>
})

export function VideoProcessing({ state, send, initialId }: { state: ClientState; send: Send; initialId?: string }) {
  const { t } = useTranslation('processing')
  const processing = state.processing
  const [selected, setSelected] = useState(initialId || processing?.documents[0]?.id || '')
  const [document, setDocument] = useState<ProcessingDocument>()
  const [tab, setTab] = useState('workspace')
  const [query, setQuery] = useState(''), search = useDeferredValue(query)
  const [speakerFilter, setSpeakerFilter] = useState('all')
  const [model, setModel] = useState<ModelId>(state.settings.transcriptionModel)
  const [speakers, setSpeakers] = useState(state.settings.transcriptionSpeakers)
  const [format, setFormat] = useState<'txt' | 'md' | 'srt' | 'vtt' | 'soft' | 'burn' | 'video'>('srt')
  const [edit, setEdit] = useState<Caption>()
  const [error, setError] = useState('')
  const [playbackError, setPlaybackError] = useState(false)
  useEffect(() => setPlaybackError(false), [selected])
  const [requesting, setRequesting] = useState(false)
  const player = useRef<HTMLVideoElement>(null)
  const summary = processing?.documents.find(doc => doc.id === selected)
  const busy = summary?.status === 'running' || summary?.status === 'queued'
  useEffect(() => {
    if (!selected) { setDocument(undefined); return }
    let current = true
    void send('processing:get', { id: selected }).then(reply => { if (current && reply && reply.document) setDocument(reply.document) })
    return () => { current = false }
  }, [selected, summary?.updatedAt, summary?.status, send])
  useEffect(() => { if (initialId) setSelected(initialId) }, [initialId])
  useEffect(() => { if (!selected && processing?.documents[0]) setSelected(processing.documents[0].id) }, [selected, processing?.documents])
  const command = async <C extends Command>(name: C, input: CommandInput<C>) => {
    setError(''); setRequesting(true)
    try { const reply = await send(name, input); if (reply && reply.document) { setDocument(reply.document); setSelected(reply.document.id) }; return reply }
    finally { setRequesting(false) }
  }
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return document?.captions.filter(cue => (speakerFilter === 'all' || cue.speakerId === speakerFilter) && (!needle || cue.text.toLowerCase().includes(needle) || document.speakers.find(speaker => speaker.id === cue.speakerId)?.name.toLowerCase().includes(needle))) || []
  }, [document, search, speakerFilter])
  const start = (action: 'transcribe' | 'recognize' | 'speakers') => void command('processing:run', { id: selected, action, model, speakers })
  const mediaOptions = [
    ...(processing?.documents.map(doc => ({ value: doc.id, label: doc.title })) || []),
    ...(processing?.sources?.map(source => ({ value: `job:${source.jobId}`, label: `${t('downloaded')} · ${source.title} (${source.sourceName.split('.').at(-1)?.toUpperCase()})` })) || []),
  ]
  const chooseMedia = (value: string) => {
    setEdit(undefined); setSpeakerFilter('all'); setQuery('')
    if (value.startsWith('job:')) void command('processing:from-job', { id: value.slice(4) })
    else if (value !== selected) { setDocument(undefined); setSelected(value) }
  }
  const seek = (ms: number) => { if (player.current) { player.current.currentTime = ms / 1000; void player.current.play().catch(() => {}) } }
  return <div className="flex min-h-full shrink-0 flex-col gap-4">
    <Card>
      <CardHeader><CardTitle>{t('title')}</CardTitle><CardDescription>{t('description')}</CardDescription><CardAction><Button disabled={requesting} onClick={() => void command('processing:import', null)}><FilePlus2 />{t('import')}</Button></CardAction></CardHeader>
      <CardContent><p className="text-xs text-muted-foreground">{t('offline')}</p></CardContent>
    </Card>
    <Tabs value={tab} onValueChange={value => setTab(String(value))} className="flex-1">
      <TabsList><TabsTrigger value="workspace">{t('workspace')}</TabsTrigger><TabsTrigger value="models">{t('models')}</TabsTrigger></TabsList>
      <TabsContent value="workspace" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <Choice className="min-w-64 flex-1" label={t('choose')} value={selected} onChange={chooseMedia} options={mediaOptions} disabled={requesting || !mediaOptions.length} placeholder={t(mediaOptions.length ? 'choosePlaceholder' : 'noAvailableMedia')} />
          {selected && <Button variant="outline" disabled={busy || requesting} onClick={() => void command('processing:captions', { id: selected })}><Captions />{t('importCaptions')}</Button>}
          {selected && <Button variant="ghost" disabled={busy || requesting} onClick={() => void command('processing:remove', { id: selected }).then(reply => { if (reply) { setSelected(''); setDocument(undefined); setEdit(undefined) } })}>{t('remove')}</Button>}
        </div>
        <FieldDescription>{t('chooseHint')}</FieldDescription>
        {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
        {!document ? <Empty><EmptyHeader><EmptyMedia variant="icon"><Captions /></EmptyMedia><EmptyTitle>{t('empty')}</EmptyTitle><EmptyDescription>{t('emptyHint')}</EmptyDescription></EmptyHeader></Empty> : <>
          <Card><CardContent className="flex flex-wrap items-end gap-3 pt-4">
            <Choice className="w-52" label={t('model')} value={model} onChange={value => setModel(value as ModelId)} options={processing?.models.filter(item => item.id !== 'speaker').map(item => ({ value: item.id, label: item.name })) || []} />
            <Choice className="w-32" label={t('speakers')} value={String(speakers)} onChange={value => setSpeakers(value === 'auto' ? 'auto' : Number(value))} options={[{ value: 'auto', label: t('auto') }, ...Array.from({ length: 8 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))]} />
            <Button disabled={busy || requesting} onClick={() => start('transcribe')}>{t('start')}</Button>
            {document.captions.length > 0 && <><Button variant="outline" disabled={busy || requesting} onClick={() => start('recognize')}>{t('recognize')}</Button><Button variant="outline" disabled={busy || requesting} onClick={() => start('speakers')}>{t('diarize')}</Button></>}
            {busy && <Button variant="outline" onClick={() => void command('processing:cancel', { id: selected })}><X />{t('cancel')}</Button>}
            <div className="w-full text-xs text-muted-foreground">{t(`statuses.${summary?.status || document.status}`)}{summary?.stage && ` · ${t(`stages.${summary.stage}` as 'stages.recognizing', { defaultValue: summary.stage })}`}</div>
            {busy && <Progress className="w-full" value={(summary?.progress || 0) * 100} />}
            {summary?.error && <Alert variant="destructive" className="w-full"><AlertDescription>{summary.error}</AlertDescription></Alert>}
            {summary?.status === 'waiting-model' && <Alert className="w-full"><AlertDescription>{t('needModel')}<Button size="sm" variant="outline" onClick={() => void command('models:download', { id: summary.model || model })}><Download />{t('downloadContinue')}</Button></AlertDescription></Alert>}
          </CardContent></Card>
          <div className="grid gap-4 lg:grid-cols-[minmax(280px,0.85fr)_minmax(360px,1.15fr)]">
            <div className="flex min-w-0 flex-col gap-4">
              <video key={document.id} ref={player} src={`galaxy-media://processing/${document.id}`} controls onError={() => setPlaybackError(true)} preload="metadata" className={cn("w-full rounded-xl bg-black", /\.(mp3|m4a|wav|flac|ogg|opus|aac)$/i.test(document.sourceName) ? "h-20" : "aspect-video")} />
              {playbackError && <Alert><AlertDescription>{t('playbackError')}</AlertDescription></Alert>}
              <Card><CardHeader><CardTitle>{document.title}</CardTitle><CardDescription>{document.sourceName} · {formatDuration(document.durationSeconds)}</CardDescription></CardHeader><CardContent><FieldGroup>
                <Choice label={t('format')} value={format} onChange={value => setFormat(value as typeof format)} options={[{ value: 'txt', label: 'TXT' }, { value: 'md', label: 'Markdown' }, { value: 'srt', label: 'SRT' }, { value: 'vtt', label: 'VTT' }, ...(/\.(mp3|m4a|wav|flac|ogg|opus|aac)$/i.test(document.sourceName) ? [] : (['soft', 'burn', 'video'] as const).map(value => ({ value, label: value === 'video' && state.settings.outputFormat === 'mkv' ? t(value).replace('MP4', 'MKV') : t(value) })))]} />
                <Button disabled={busy || requesting || format !== 'video' && !document.captions.length} onClick={() => void command('processing:export', { id: selected, format })}><Download />{t('export')}</Button>
                {document.exports.map((file, index) => <Button key={`${file.createdAt}-${index}`} className="justify-start overflow-hidden" variant="ghost" onClick={() => void command('processing:open-export', { id: selected, index })}><Play /><span className="truncate">{file.name}</span></Button>)}
              </FieldGroup></CardContent></Card>
              {document.speakers.length > 0 && <Card><CardHeader><CardTitle>{t('speakerList')}</CardTitle></CardHeader><CardContent><FieldGroup>{document.speakers.map(speaker => <form key={speaker.id} className="flex gap-2" onSubmit={event => { event.preventDefault(); const name = String(new FormData(event.currentTarget).get('name') || '').trim(); if (name) void command('processing:speaker', { id: selected, speakerId: speaker.id, name }) }}><Input key={speaker.name} name="name" defaultValue={speaker.name} aria-label={t('name')} maxLength={100} /><Button type="submit" variant="outline" disabled={busy}>{t('rename')}</Button></form>)}</FieldGroup></CardContent></Card>}
            </div>
            <div className="flex min-w-0 flex-col gap-3">
              {document.tracks.length > 0 && <Choice label={t('track')} value={document.activeTrack || ''} onChange={trackId => { setEdit(undefined); void command('processing:track', { id: selected, trackId }) }} disabled={busy} options={document.tracks.map(track => ({ value: track.id, label: `${t(track.source === 'asr' ? 'asr' : track.source === 'platform' ? 'platform' : 'file')} · ${track.source === 'file' ? track.name : track.language}` }))} />}
              <div className="flex flex-wrap gap-2"><div className="relative min-w-48 flex-1"><Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" /><Input className="pl-9" aria-label={t('search')} placeholder={t('search')} value={query} onChange={event => setQuery(event.target.value)} /></div>{document.speakers.length > 0 && <Choice className="w-36" label={t('speaker')} hideLabel value={speakerFilter} onChange={setSpeakerFilter} options={[{ value: 'all', label: t('allSpeakers') }, ...document.speakers.map(speaker => ({ value: speaker.id, label: speaker.name }))]} />}</div>
              {edit && <Card><CardHeader><CardTitle>{t('edit')}</CardTitle><CardAction><Button size="icon-sm" variant="ghost" onClick={() => setEdit(undefined)}><X /></Button></CardAction></CardHeader><CardContent><form className="flex flex-col gap-3" onSubmit={event => { event.preventDefault(); if (edit.endMs <= edit.startMs) return; void command('processing:edit', { id: selected, revision: document.revision, captionId: edit.id, text: edit.text, startMs: edit.startMs, endMs: edit.endMs, speakerId: edit.speakerId }).then(reply => { if (reply) setEdit(undefined) }) }}><Field><FieldLabel htmlFor="caption-text">{t('text')}</FieldLabel><Textarea id="caption-text" value={edit.text} onChange={event => setEdit({ ...edit, text: event.target.value })} maxLength={20000} /></Field><div className="grid grid-cols-2 gap-3"><Field><FieldLabel htmlFor="caption-start">{t('startMs')}</FieldLabel><Input id="caption-start" type="number" min={0} required value={edit.startMs} onChange={event => setEdit({ ...edit, startMs: event.target.valueAsNumber })} /></Field><Field><FieldLabel htmlFor="caption-end">{t('endMs')}</FieldLabel><Input id="caption-end" type="number" min={edit.startMs + 1} required value={edit.endMs} onChange={event => setEdit({ ...edit, endMs: event.target.valueAsNumber })} /></Field></div><Choice label={t('speaker')} value={edit.speakerId || 'none'} onChange={value => setEdit({ ...edit, speakerId: value === 'none' ? null : value })} options={[{ value: 'none', label: t('unknown') }, ...document.speakers.map(speaker => ({ value: speaker.id, label: speaker.name }))]} /><Button type="submit" disabled={busy || requesting}>{t('save')}</Button></form></CardContent></Card>}
              <div className="flex max-h-[65vh] flex-col gap-2 overflow-auto pr-1">
                {filtered.map(cue => <CaptionRow key={cue.id} cue={cue} selected={edit?.id === cue.id} speaker={document.speakers.find(speaker => speaker.id === cue.speakerId)?.name} select={() => { if (!busy) setEdit({ ...cue }) }} play={() => seek(cue.startMs)} />)}
                {!filtered.length && <p className="p-8 text-center text-sm text-muted-foreground">{document.captions.length ? t('noMatches') : t('noCaptions')}</p>}
              </div>
            </div>
          </div>
        </>}
      </TabsContent>
      <TabsContent value="models"><p className="mb-4 text-sm text-muted-foreground">{t('sizeHint')}</p><div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">{processing?.models.map(item => <Card key={item.id}><CardHeader><CardTitle>{item.name}</CardTitle><CardDescription>{item.family} · {item.languages.join(', ')}</CardDescription><CardAction>{item.recommended ? <Badge variant="secondary">{t('recommended')}</Badge> : item.ready ? <Badge variant="outline">{t('installed')}</Badge> : null}</CardAction></CardHeader><CardContent className="flex flex-col gap-3"><p className="text-sm text-muted-foreground">{item.ready ? formatBytes(item.bytes) : `≈ ${formatBytes(item.expectedBytes)}`} · {item.license}</p>{item.downloading && <><Progress value={(item.progress || 0) * 100} /><p className="text-xs tabular-nums">{t(`downloadPhases.${item.phase || 'downloading'}`)} · {formatBytes(item.bytes)}</p></>}{item.error && <p className="text-sm text-destructive">{item.error}</p>}<div className="flex flex-wrap gap-2">{item.downloading ? <Button variant="outline" onClick={() => void command('models:cancel', { id: item.id })}>{t('cancelDownload')}</Button> : item.ready ? <><Button variant="outline" disabled={busy} onClick={() => void command('models:remove', { id: item.id })}>{t('deleteModel')}</Button>{item.id !== 'speaker' && <Button onClick={() => { if (item.id !== 'speaker') { setModel(item.id); void send('settings:save', { ...state.settings, transcriptionModel: item.id }); setTab('workspace') } }}>{t('use')}</Button>}</> : <Button onClick={() => void command('models:download', { id: item.id })}><Download />{t('download')}</Button>}</div><FieldDescription>{processing.runtime}</FieldDescription></CardContent></Card>)}</div></TabsContent>
    </Tabs>
  </div>
}
