import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Job, Settings } from '../../../shared/contracts'
import type { Caption, ProcessingDocument, ProcessingState, ProcessingSummary, ModelId } from '../../../shared/processing'
import { Engine, redact, runProcess } from '../engine'
import { ModelManager } from './models'
import { parseCaptionTrack, type CaptionTrack as RawTrack } from './vendor/captions'
import type { PipelineResult } from './vendor/types'
import { i18n } from '../../../shared/i18n'

type StoredDocument = ProcessingDocument & { sourcePath: string; sourceSignature: string; trackData: Record<string, Caption[]>; trackSpeakers: Record<string, ProcessingDocument['speakers']>; exportPaths: string[]; pending?: { action: 'transcribe' | 'recognize' | 'speakers'; speakers: Settings['transcriptionSpeakers'] } }
const extensions = new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v', '.mp3', '.m4a', '.wav', '.flac', '.ogg', '.opus', '.aac', '.ts'])
const busy = (doc: ProcessingDocument) => doc.status === 'running' || doc.status === 'queued'
const signature = (file: string) => { const info = statSync(file); return `${info.size}:${info.mtimeMs}` }
const clock = (ms: number, vtt = false) => { const whole = Math.max(0, Math.round(ms)); return `${String(Math.floor(whole / 3600000)).padStart(2, '0')}:${String(Math.floor(whole / 60000) % 60).padStart(2, '0')}:${String(Math.floor(whole / 1000) % 60).padStart(2, '0')}${vtt ? '.' : ','}${String(whole % 1000).padStart(3, '0')}` }
export function exportCaptions(doc: ProcessingDocument, format: 'srt' | 'vtt' | 'txt' | 'md'): string {
  if (format === 'srt' || format === 'vtt') return (format === 'vtt' ? 'WEBVTT\n\n' : '') + doc.captions.map((cue, index) => `${format === 'srt' ? index + 1 + '\n' : ''}${clock(cue.startMs, format === 'vtt')} --> ${clock(cue.endMs, format === 'vtt')}\n${cue.text}`).join('\n\n') + '\n'
  const speaker = (cue: Caption) => doc.speakers.find(speaker => speaker.id === cue.speakerId)?.name
  return (format === 'md' ? `# ${doc.title}\n\n` : '') + doc.captions.map(cue => `${format === 'md' ? `**${clock(cue.startMs).split(',')[0]}** ` : ''}${speaker(cue) ? speaker(cue) + ': ' : ''}${cue.text}`).join('\n\n') + '\n'
}

export class ProcessingService {
  readonly models: ModelManager
  private documents = new Map<string, StoredDocument>()
  private active = new Map<string, AbortController>()
  private stopped = false
  constructor(private directory: string, private engine: Engine, private root: string, private settings: () => Settings, fetcher: typeof fetch, private changed: () => void, private platformCaptions: (jobId: string, directory: string, signal: AbortSignal) => Promise<{ file: string; language: string }[]>) {
    mkdirSync(directory, { recursive: true })
    this.models = new ModelManager(path.join(directory, 'models'), fetcher, async (input, output, archiveFiles, signal) => { await engine.request({ operation: 'unpack', input, output, archiveFiles }, signal) }, () => { this.changed(); this.pump() })
    for (const id of readdirSync(directory).filter(id => /^[0-9a-f-]{36}$/.test(id))) {
      try {
        const doc = JSON.parse(readFileSync(path.join(directory, id, 'document.json'), 'utf8')) as StoredDocument
        if (doc.id !== id || !Array.isArray(doc.captions) || typeof doc.sourcePath !== 'string') continue
        if (doc.status === 'running' || doc.status === 'queued') { doc.status = 'cancelled'; doc.error = 'Processing interrupted; start again to resume.' }
        doc.trackData ||= {}; doc.trackSpeakers ||= {}; doc.exportPaths ||= []; doc.exports ||= []
        this.documents.set(id, doc)
      } catch { /* Preserve unreadable documents on disk without exposing partial state. */ }
    }
  }
  state(jobs: Job[] = []): ProcessingState {
    const documents = [...this.documents.values()]
    const sources = jobs.filter(job => job.status === 'completed').flatMap(job => {
      const source = this.sourceForJob(job)
      if (!source || documents.some(doc => doc.sourcePath === source.file && doc.sourceSignature === source.signature)) return []
      return [{ jobId: job.id, title: job.title, sourceName: path.basename(source.file) }]
    })
    return { documents: documents.map(doc => this.summary(doc)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), sources, models: this.models.statuses(this.settings().captionLanguages[0] || this.settings().locale), runtime: 'sherpa-onnx · CPU · offline' }
  }
  private sourceForJob(job: Job): { file: string; signature: string } | undefined {
    if (job.kind === 'image') return
    // Reuse the same recorded-file boundary for the picker, task entry and automatic processing.
    for (const candidate of new Set([...(job.originalFiles || []), ...(job.status === 'completed' ? job.files : [])])) {
      if (path.dirname(path.resolve(candidate)) !== path.resolve(job.directory)) continue
      try {
        const file = realpathSync(candidate), info = statSync(file)
        if (path.dirname(file) !== realpathSync(job.directory) || !extensions.has(path.extname(file).toLowerCase()) || !info.isFile() || !info.size) continue
        return { file, signature: `${info.size}:${info.mtimeMs}` }
      } catch { /* Missing downloads cannot be selected; another recorded original may still exist. */ }
    }
  }
  async fromJob(job: Job): Promise<ProcessingDocument> {
    const source = this.sourceForJob(job)
    if (!source) throw new Error(i18n.t('processing:mediaUnavailable'))
    return this.importFile(source.file, job)
  }
  private summary(doc: StoredDocument): ProcessingSummary { return { id: doc.id, title: doc.title, sourceName: doc.sourceName, jobId: doc.jobId, durationSeconds: doc.durationSeconds, status: doc.status, stage: doc.stage, progress: doc.progress, error: doc.error, updatedAt: doc.updatedAt, captionCount: doc.captions.length, language: doc.language, model: doc.model } }
  get(id: string): ProcessingDocument { const doc = this.require(id); return { ...this.summary(doc), revision: doc.revision, captions: doc.captions, speakers: doc.speakers, tracks: doc.tracks, activeTrack: doc.activeTrack, exports: doc.exports } }
  private require(id: string): StoredDocument { const doc = this.documents.get(id); if (!doc) throw new Error('Media document not found'); return doc }
  media(id: string): string { const doc = this.require(id); if (!existsSync(doc.sourcePath)) throw new Error('Source media is missing'); return doc.sourcePath }
  private folder(id: string): string { const directory = path.join(this.directory, id); mkdirSync(directory, { recursive: true }); return directory }
  private save(doc: StoredDocument): void {
    doc.updatedAt = new Date().toISOString()
    const target = path.join(this.folder(doc.id), 'document.json')
    writeFileSync(target + '.tmp', JSON.stringify(doc), { mode: 0o600 }); renameSync(target + '.tmp', target); this.changed()
  }
  private editable(doc: StoredDocument): void { if (busy(doc) || this.active.has(doc.id)) throw new Error('Wait for processing to finish first') }
  async importFile(file: string, job?: Job): Promise<ProcessingDocument> {
    const sourcePath = realpathSync(file)
    if (!extensions.has(path.extname(sourcePath).toLowerCase()) || !statSync(sourcePath).isFile() || !statSync(sourcePath).size) throw new Error('Choose a non-empty video or audio file')
    const sourceSignature = signature(sourcePath)
    const existing = [...this.documents.values()].find(doc => doc.sourcePath === sourcePath && doc.sourceSignature === sourceSignature)
    if (existing) return this.get(existing.id)
    const metadata = await this.engine.request<{ durationSeconds: number }>({ operation: 'inspect', input: sourcePath })
    const doc: StoredDocument = { id: randomUUID(), title: job?.title || path.basename(sourcePath, path.extname(sourcePath)), sourceName: path.basename(sourcePath), sourcePath, sourceSignature, jobId: job?.id, durationSeconds: metadata.durationSeconds, status: 'idle', updatedAt: new Date().toISOString(), captionCount: 0, revision: 0, captions: [], speakers: [], tracks: [], trackData: {}, trackSpeakers: {}, exportPaths: [], exports: [] }
    this.documents.set(doc.id, doc)
    try { await this.localCaptions(doc) } catch (error) { this.documents.delete(doc.id); rmSync(this.folder(doc.id), { recursive: true, force: true }); throw error }
    this.save(doc); return this.get(doc.id)
  }
  async completed(job: Job): Promise<void> {
    if (!job.autoTranscribe || job.workMode !== 'edit' || job.kind === 'image') return
    const source = this.sourceForJob(job)
    if (!source) return
    const doc = await this.importFile(source.file, job)
    this.enqueue(doc.id, 'transcribe', job.transcriptionModel || this.settings().transcriptionModel, job.transcriptionSpeakers || this.settings().transcriptionSpeakers)
  }
  private addTrack(doc: StoredDocument, text: string, format: RawTrack['format'], language: string, source: 'platform' | 'file', name: string, deduplicate = true): void {
    const cues = parseCaptionTrack(text, format).filter(cue => Number.isFinite(cue.startMs) && Number.isFinite(cue.endMs) && cue.endMs > cue.startMs && cue.text.trim())
    if (!cues.length) return
    const held = doc.tracks.find(track => track.language === language && track.source === source)
    if (held && deduplicate) return
    const id = randomUUID(), speakers = new Map<string, string>()
    const captions = cues.map(cue => { if (cue.speaker && !speakers.has(cue.speaker)) speakers.set(cue.speaker, randomUUID()); return { id: randomUUID(), text: cue.text, startMs: Math.round(cue.startMs), endMs: Math.round(cue.endMs), speakerId: cue.speaker ? speakers.get(cue.speaker)! : null } })
    doc.tracks.push({ id, language, source, name }); doc.trackData[id] = captions; doc.trackSpeakers[id] = [...speakers].map(([name, id]) => ({ id, name }))
    if (!doc.activeTrack) {
      doc.activeTrack = id; doc.captions = captions; doc.language = language; doc.status = 'completed'; doc.captionCount = captions.length
      doc.speakers = doc.trackSpeakers[id]
    }
  }
  private async localCaptions(doc: StoredDocument): Promise<void> {
    const stem = path.basename(doc.sourcePath, path.extname(doc.sourcePath)), parent = path.dirname(doc.sourcePath)
    const languageOrder = this.settings().captionLanguages
    const files = readdirSync(parent).filter(file => (file.startsWith(stem + '.') || file === stem + '.srt') && /\.(?:srt|vtt|ass)$/i.test(file)).sort((a, b) => {
      const score = (file: string) => { const language = file.slice(stem.length + 1).split('.')[0]; const index = languageOrder.findIndex(value => language.toLowerCase().startsWith(value.toLowerCase())); return index < 0 ? 100 : index }
      return score(a) - score(b)
    })
    for (const file of files.slice(0, 20)) {
      const full = path.join(parent, file)
      if (statSync(full).size > 16 * 1024 * 1024) continue
      this.addTrack(doc, readFileSync(full, 'utf8'), path.extname(file).slice(1).toLowerCase() as RawTrack['format'], file.slice(stem.length + 1, -path.extname(file).length) || 'und', 'file', file)
    }
    if (!doc.tracks.length) {
      const result = await this.engine.request<{ tracks: { file: string; language: string }[] }>({ operation: 'embedded-captions', input: doc.sourcePath, output: this.folder(doc.id) })
      for (const track of result.tracks) this.addTrack(doc, readFileSync(track.file, 'utf8'), 'srt', track.language, 'file', `Embedded · ${track.language}`)
    }
  }
  importCaptions(id: string, file: string): ProcessingDocument {
    const doc = this.require(id); this.editable(doc)
    const format = path.extname(file).slice(1).toLowerCase()
    if (!['srt', 'vtt', 'ass'].includes(format) || statSync(file).size > 16 * 1024 * 1024) throw new Error('Choose an SRT, VTT or ASS subtitle file under 16 MB')
    if (doc.activeTrack) { doc.trackData[doc.activeTrack] = doc.captions; doc.trackSpeakers[doc.activeTrack] = doc.speakers }
    const old = doc.activeTrack; doc.activeTrack = undefined
    const language = path.basename(file).match(/\.([a-z]{2,3}(?:-[a-z0-9]{2,8})*)\.(?:srt|vtt|ass)$/i)?.[1] || 'und'
    this.addTrack(doc, readFileSync(file, 'utf8'), format as RawTrack['format'], language, 'file', path.basename(file), false)
    if (!doc.activeTrack) { doc.activeTrack = old; throw new Error('No usable captions found') }
    doc.revision++; this.save(doc); return this.get(id)
  }
  switchTrack(id: string, trackId: string): ProcessingDocument {
    const doc = this.require(id); this.editable(doc)
    const track = doc.tracks.find(track => track.id === trackId)
    if (!track || !doc.trackData[trackId]) throw new Error('Subtitle track not found')
    if (doc.activeTrack) { doc.trackData[doc.activeTrack] = doc.captions; doc.trackSpeakers[doc.activeTrack] = doc.speakers }
    doc.activeTrack = trackId; doc.captions = doc.trackData[trackId]; doc.speakers = doc.trackSpeakers[trackId] || []; doc.language = track.language; doc.captionCount = doc.captions.length; doc.revision++; this.save(doc); return this.get(id)
  }
  edit(input: { id: string; revision: number; captionId: string; text: string; startMs: number; endMs: number; speakerId: string | null }): ProcessingDocument {
    const doc = this.require(input.id); this.editable(doc)
    if (doc.revision !== input.revision) throw new Error('This transcript changed; reload before saving')
    const cue = doc.captions.find(cue => cue.id === input.captionId)
    if (!cue || input.speakerId && !doc.speakers.some(speaker => speaker.id === input.speakerId)) throw new Error('Subtitle or speaker not found')
    Object.assign(cue, { text: input.text, startMs: input.startMs, endMs: input.endMs, speakerId: input.speakerId, words: cue.text === input.text && cue.startMs === input.startMs && cue.endMs === input.endMs ? cue.words : [] })
    doc.captions.sort((a, b) => a.startMs - b.startMs); doc.revision++; this.save(doc); return this.get(input.id)
  }
  speaker(id: string, speakerId: string, name: string): ProcessingDocument { const doc = this.require(id); this.editable(doc); const speaker = doc.speakers.find(speaker => speaker.id === speakerId); if (!speaker) throw new Error('Speaker not found'); speaker.name = name; doc.revision++; this.save(doc); return this.get(id) }
  enqueue(id: string, action: 'transcribe' | 'recognize' | 'speakers', model: ModelId, speakers: Settings['transcriptionSpeakers']): ProcessingDocument {
    const doc = this.require(id); this.editable(doc)
    if (action === 'speakers' && !doc.captions.length) throw new Error('Read or recognize subtitles first')
    doc.model = model; doc.pending = { action, speakers }; doc.status = 'queued'; doc.error = undefined; doc.progress = 0; this.save(doc); this.pump(); return this.get(id)
  }
  cancel(id: string): void { const doc = this.require(id); this.active.get(id)?.abort(); doc.status = 'cancelled'; doc.error = undefined; this.save(doc) }
  remove(id: string): void { const doc = this.require(id); this.editable(doc); this.documents.delete(id); rmSync(this.folder(id), { recursive: true, force: true }); this.changed() }
  modelInUse(id: string): boolean { return [...this.documents.values()].some(doc => (busy(doc) || this.active.has(doc.id)) && (id === 'speaker' || doc.model === id)) }
  private pump(): void {
    if (this.stopped) return
    for (const doc of this.documents.values()) {
      if (this.active.size >= this.settings().transcriptionConcurrency) break
      if (this.active.has(doc.id) || !['queued', 'waiting-model'].includes(doc.status) || !doc.pending) continue
      if (doc.status === 'waiting-model' && !this.models.ready(doc.model!)) continue
      const controller = new AbortController(); this.active.set(doc.id, controller)
      void this.run(doc, controller.signal).catch(error => { doc.status = controller.signal.aborted ? 'cancelled' : 'failed'; doc.error = controller.signal.aborted ? undefined : redact(error instanceof Error ? error.message : String(error)); this.save(doc) }).finally(() => { this.active.delete(doc.id); this.pump() })
    }
  }
  private async run(doc: StoredDocument, signal: AbortSignal): Promise<void> {
    doc.status = 'running'; doc.stage = 'captions'; this.save(doc)
    if (signature(doc.sourcePath) !== doc.sourceSignature) throw new Error('Source file changed; import it again')
    const pending = doc.pending!
    if (pending.action === 'transcribe') {
      if (!doc.captions.length) await this.localCaptions(doc)
      if (!doc.captions.length && doc.jobId) {
        const tracks = await this.platformCaptions(doc.jobId, this.folder(doc.id), signal)
        for (const track of tracks) this.addTrack(doc, readFileSync(track.file, 'utf8'), path.extname(track.file).slice(1) as RawTrack['format'], track.language, 'platform', `Platform · ${track.language}`)
      }
      if (doc.captions.length) { doc.status = 'completed'; doc.stage = undefined; doc.progress = 1; doc.pending = undefined; this.save(doc); return }
    }
    if (pending.action !== 'speakers' && !this.models.ready(doc.model!)) { doc.status = 'waiting-model'; doc.stage = 'models'; this.save(doc); return }
    if (pending.action !== 'speakers' || pending.speakers !== 1) {
      doc.stage = 'models'; this.save(doc)
      const ready = this.models.ensureReady({ groups: pending.action === 'speakers' ? ['speaker'] : pending.speakers === 1 ? ['vad'] : ['vad', 'speaker'] })
      // Model downloads are shared. Cancelling this document releases its queue slot immediately.
      await new Promise<void>((resolve, reject) => {
        const cancel = () => reject(signal.reason)
        signal.addEventListener('abort', cancel, { once: true })
        ready.then(() => { signal.removeEventListener('abort', cancel); resolve() }, error => { signal.removeEventListener('abort', cancel); reject(error) })
        if (signal.aborted) cancel()
      })
    }
    signal.throwIfAborted()
    doc.stage = 'preparing-audio'; this.save(doc)
    const wav = path.join(this.folder(doc.id), 'audio.wav')
    const audio = await this.engine.request<{ durationSeconds: number }>({ operation: 'audio', input: doc.sourcePath, output: wav }, signal)
    const previous = doc.captions.map(cue => ({ ...cue })), oldSpeakers = doc.speakers
    if (pending.action === 'recognize') rmSync(path.join(this.folder(doc.id), `chunks-${doc.model}.json`), { force: true })
    if (doc.activeTrack) doc.trackSpeakers[doc.activeTrack] = oldSpeakers
    const request = {
      sourceFilePath: doc.sourcePath, wavPath: wav, durationMs: Math.round(audio.durationSeconds * 1000), modelsDirectory: this.models.directory,
      skipVad: false, autoSkipAllowed: true, asrTier: doc.model, speakerCount: pending.speakers, language: this.settings().captionLanguages[0],
      manifestPath: pending.action === 'speakers' ? undefined : path.join(this.folder(doc.id), `chunks-${doc.model}.json`),
      existingTranscript: pending.action === 'speakers' ? { language: doc.language || null, modelVersion: 'galaxy-transcript', asrTier: doc.model!, speakers: oldSpeakers.map(speaker => ({ speakerKey: speaker.id, displayName: speaker.name })), segments: previous.map(cue => ({ ...cue, speakerKey: cue.speakerId, confidence: null })) } : undefined,
    }
    const result = await runProcess<PipelineResult>(process.execPath, [path.join(this.root, 'dist-electron/processing/worker.mjs')], request, signal, event => {
      if (event.kind === 'processing') { doc.stage = event.status; doc.progress = typeof event.progress === 'number' ? event.progress : undefined; this.changed() }
    }, 24 * 60 * 60 * 1000)
    signal.throwIfAborted()
    doc.durationSeconds = audio.durationSeconds; doc.language = result.language || doc.language
    doc.speakers = result.speakers.map(speaker => ({ id: speaker.speakerKey, name: oldSpeakers.find(old => old.id === speaker.speakerKey)?.name || speaker.displayName }))
    if (pending.action === 'speakers') {
      // Re-diarization overlays ownership only: keep every id, timestamp, word and human edit.
      doc.captions = previous.map(cue => { const middle = (cue.startMs + cue.endMs) / 2; const assigned = result.segments.find(segment => segment.startMs <= middle && segment.endMs >= middle) || result.segments.find(segment => segment.startMs < cue.endMs && segment.endMs > cue.startMs); return { ...cue, speakerId: assigned?.speakerKey || null } })
    } else {
      if (doc.activeTrack) doc.trackData[doc.activeTrack] = previous
      doc.captions = result.segments.map(segment => ({ id: randomUUID(), text: segment.text, startMs: segment.startMs, endMs: segment.endMs, speakerId: segment.speakerKey, words: segment.words }))
      const id = randomUUID(); doc.tracks.push({ id, source: 'asr', language: doc.language || 'und', name: `ASR · ${doc.model}` }); doc.activeTrack = id; doc.trackData[id] = doc.captions; doc.trackSpeakers[id] = doc.speakers
    }
    doc.captionCount = doc.captions.length; doc.revision++; doc.status = 'completed'; doc.progress = 1; doc.stage = result.resultKind === 'no-speech' ? 'no-speech' : undefined; doc.pending = undefined; this.save(doc)
    rmSync(wav, { force: true })
  }
  async export(id: string, format: 'txt' | 'md' | 'srt' | 'vtt' | 'soft' | 'burn' | 'video', output: string): Promise<ProcessingDocument> {
    const doc = this.require(id); this.editable(doc)
    if (['soft', 'burn', 'srt', 'vtt'].includes(format) && !doc.captions.length) throw new Error('No subtitles to export')
    if (path.resolve(output) === path.resolve(doc.sourcePath) || existsSync(output)) throw new Error('Choose a new output file; originals are never overwritten')
    if (['txt', 'md', 'srt', 'vtt'].includes(format)) {
      writeFileSync(output, exportCaptions(this.get(id), format as 'txt' | 'md' | 'srt' | 'vtt'), { flag: 'wx', mode: 0o600 })
    } else {
      const controller = new AbortController(); this.active.set(id, controller); doc.status = 'running'; doc.stage = 'exporting'; doc.progress = 0; this.changed()
      const captionFile = path.join(this.folder(id), 'export.srt'); writeFileSync(captionFile, exportCaptions(this.get(id), 'srt'), { mode: 0o600 })
      const languages = new Set<string>(), captionFiles: { file: string; language: string }[] = []
      if (format === 'soft') for (const track of [...doc.tracks.filter(track => track.id === doc.activeTrack), ...doc.tracks.filter(track => track.id !== doc.activeTrack)]) {
        if (languages.has(track.language) || captionFiles.length >= 5) continue
        const captions = track.id === doc.activeTrack ? doc.captions : doc.trackData[track.id]
        if (!captions?.length) continue
        const file = path.join(this.folder(id), `export-${captionFiles.length}.srt`)
        writeFileSync(file, exportCaptions({ ...this.get(id), captions }, 'srt'), { mode: 0o600 }); captionFiles.push({ file, language: track.language }); languages.add(track.language)
      }
      try {
        await this.engine.request({ operation: 'render', input: doc.sourcePath, output, renderMode: format as 'soft' | 'burn' | 'video', captionFile, captionFiles, outputResolution: this.settings().outputResolution }, controller.signal, event => { if (event.kind === 'processing') { doc.progress = typeof event.progress === 'number' ? event.progress : undefined; this.changed() } })
        doc.status = 'completed'; doc.stage = undefined; doc.progress = 1
      } catch (error) { doc.status = controller.signal.aborted ? 'cancelled' : 'failed'; doc.error = String(error instanceof Error ? error.message : error); throw error }
      finally { this.active.delete(id); rmSync(captionFile, { force: true }); for (const track of captionFiles) rmSync(track.file, { force: true }); this.save(doc); this.pump() }
    }
    doc.exportPaths.push(output); doc.exports.push({ name: path.basename(output), createdAt: new Date().toISOString() }); this.save(doc); return this.get(id)
  }
  exportPath(id: string, index: number): string { const file = this.require(id).exportPaths[index]; if (!file || !existsSync(file)) throw new Error('Exported file is missing'); return file }
  stop(): void { this.stopped = true; this.models.stop(); for (const controller of this.active.values()) controller.abort() }
  refresh(): void { this.pump(); this.changed() }
}
