import { createHash, randomUUID } from 'node:crypto'
import { cpus, totalmem } from 'node:os'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ModelId, ModelStatus } from '../../../shared/processing'
import { ASR_TIERS } from './vendor/asr-tiers'
import { recommendAsrModels } from './vendor/asr-recommend'
import { catalogFor, MODEL_CATALOG } from './vendor/model-catalog'
import type { ModelFileSpec, ModelGroup, ModelRole } from './vendor/types'

type Download = { phase: 'downloading' | 'unpacking' | 'verifying'; progress: number; bytes: number; abort: AbortController; error?: string }
type Unpack = (archive: string, directory: string, files: string[], signal: AbortSignal) => Promise<void>
export const modelNames: Record<ModelId, string> = { minimal: 'Whisper Tiny', 'whisper-base': 'Whisper Base', balanced: 'Whisper Small', 'whisper-medium': 'Whisper Medium', 'whisper-turbo': 'Whisper Turbo', 'sense-voice': 'SenseVoice Small', 'sense-voice-2025': 'SenseVoice 2025', 'parakeet-v2': 'Parakeet v2', 'parakeet-v3': 'Parakeet v3', quality: 'Qwen3-ASR 0.6B', 'qwen3-1.7b': 'Qwen3-ASR 1.7B', 'fire-red-asr': 'FireRedASR v2', orukeet: 'Orukeet' }

/** Model URLs and paths come exclusively from the attributed, pinned VidBee catalogue. */
export class ModelManager {
  private pending = new Map<string, Promise<void>>()
  private active = new Map<string, Download>()
  private failures = new Map<string, string>()
  constructor(readonly directory: string, private fetcher?: typeof fetch, private unpack?: Unpack, private changed: () => void = () => {}) { mkdirSync(directory, { recursive: true }) }
  private present(spec: ModelFileSpec): boolean {
    const file = path.join(this.directory, spec.fileName)
    try {
      if (spec.directoryMembers) return spec.directoryMembers.every(member => statSync(path.join(file, member.name)).size >= member.minBytes)
      return statSync(file).isFile() && statSync(file).size > 0
    } catch { return false }
  }
  private receipt(tier: string): string { return path.join(this.directory, `.ready-${tier}.json`) }
  ready(tier: ModelId | 'speaker'): boolean {
    const specs = tier === 'speaker' ? catalogFor({ groups: ['vad', 'speaker'] }) : catalogFor({ groups: ['asr'], tiers: [tier] })
    return existsSync(this.receipt(tier)) && specs.length > 0 && specs.every(spec => this.present(spec))
  }
  pathById(id: string): string | null { const spec = MODEL_CATALOG.find(spec => spec.id === id); return spec && this.present(spec) ? path.join(this.directory, spec.fileName) : null }
  pathByRole(role: ModelRole, tier?: ModelId): string | null { const spec = MODEL_CATALOG.find(spec => spec.role === role && (tier ? spec.tier === tier : !spec.tier) && this.present(spec)); return spec ? path.join(this.directory, spec.fileName) : null }
  incompleteModelIssue(tier: ModelId): string | null { return this.ready(tier) ? null : `Model not installed: ${modelNames[tier]}` }
  async ensureReady(options: { groups?: readonly ModelGroup[]; tiers?: readonly ModelId[] }): Promise<void> {
    const specs = catalogFor(options)
    if (specs.every(spec => this.present(spec))) return
    if (!this.fetcher) throw new Error('Required local model files are missing')
    for (const tier of options.tiers || []) await this.download(tier)
    if (options.groups?.some(group => group === 'vad' || group === 'speaker')) await this.download('speaker')
    if (!specs.every(spec => this.present(spec))) throw new Error('Required local model files are missing')
  }
  statuses(language: string): ModelStatus[] {
    const recommended = recommendAsrModels({ ramBytes: totalmem(), cpuCount: cpus().length, language, os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux', arch: process.arch })
    const entries = ASR_TIERS.map(tier => ({ id: tier.id, name: modelNames[tier.id], family: tier.family, expectedBytes: tier.bytesHint, languages: [...tier.languages], license: tier.id === 'orukeet' ? 'CC BY-SA 4.0' : tier.family === 'parakeet' ? 'CC BY 4.0' : tier.family === 'whisper' ? 'MIT' : 'Apache 2.0' }))
    return [...entries, { id: 'speaker' as const, name: 'Speaker analysis / VAD', family: 'speaker', expectedBytes: 35_000_000, languages: ['multi'], license: 'Model-specific: pyannote / 3D-Speaker' }].map(entry => {
      const current = this.active.get(entry.id)
      const specs = entry.id === 'speaker' ? catalogFor({ groups: ['vad', 'speaker'] }) : catalogFor({ groups: ['asr'], tiers: [entry.id] })
      const bytes = specs.reduce((sum, spec) => { try { const file = path.join(this.directory, spec.fileName); return sum + (spec.directoryMembers ? spec.directoryMembers.reduce((n, member) => n + statSync(path.join(file, member.name)).size, 0) : statSync(file).size) } catch { return sum } }, 0)
      return { ...entry, ready: this.ready(entry.id), phase: current?.phase, downloading: Boolean(current), bytes: current?.bytes || bytes, progress: current?.progress, error: this.failures.get(entry.id), recommended: entry.id !== 'speaker' && recommended.includes(entry.id) }
    })
  }
  cancel(id: string): void { this.active.get(id)?.abort.abort() }
  stop(): void { for (const current of this.active.values()) current.abort.abort() }
  remove(id: ModelId | 'speaker'): void {
    if (this.active.has(id)) throw new Error('Cancel the model download first')
    const specs = id === 'speaker' ? catalogFor({ groups: ['vad', 'speaker'] }) : catalogFor({ groups: ['asr'], tiers: [id] })
    for (const spec of specs) rmSync(path.join(this.directory, spec.fileName), { force: true, recursive: true })
    rmSync(this.receipt(id), { force: true }); this.failures.delete(id); this.changed()
  }
  private async hash(file: string): Promise<string> { const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex') }
  private async downloadFile(url: string, destination: string, signal: AbortSignal, update: (bytes: number, total: number) => void): Promise<void> {
    const response = await this.fetcher!(url, { signal })
    if (!response.ok || !response.body) throw new Error(`Model download HTTP ${response.status}`)
    const total = Number(response.headers.get('content-length')) || 0
    mkdirSync(path.dirname(destination), { recursive: true })
    let bytes = 0, last = 0
    const stream = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])
    stream.on('data', (chunk: Buffer) => { bytes += chunk.length; if (Date.now() - last > 250) { update(bytes, total); last = Date.now() } })
    await pipeline(stream, createWriteStream(destination, { mode: 0o600 }), { signal })
    if (!bytes || total && total !== bytes) throw new Error('Model download was truncated')
    update(bytes, total)
  }
  download(id: ModelId | 'speaker'): Promise<void> {
    const existing = this.pending.get(id)
    if (existing) return existing
    const work = Promise.resolve().then(() => this.performDownload(id)).finally(() => this.pending.delete(id))
    this.pending.set(id, work); return work
  }
  private async performDownload(id: ModelId | 'speaker'): Promise<void> {
    if (this.active.has(id) || this.ready(id)) return
    if (!this.fetcher || !this.unpack) throw new Error('Model downloads are unavailable in an inference worker')
    const item: Download = { phase: 'downloading', abort: new AbortController(), bytes: 0, progress: 0 }
    this.active.set(id, item); this.failures.delete(id); this.changed()
    const stage = path.join(this.directory, `.staging-${randomUUID()}`), signal = item.abort.signal
    mkdirSync(stage, { recursive: true })
    try {
      const specs = id === 'speaker' ? catalogFor({ groups: ['vad', 'speaker'] }) : catalogFor({ groups: ['asr'], tiers: [id] })
      const groups = Map.groupBy(specs, spec => spec.url)
      let completed = 0
      for (const [url, group] of groups) {
        signal.throwIfAborted(); item.phase = 'downloading'
        const update = (bytes: number, total: number) => { item.bytes = completed + bytes; item.progress = total ? Math.min(.99, (Array.from(groups.keys()).indexOf(url) + bytes / total) / groups.size) : 0; this.changed() }
        const archive = /\.tar\.(?:bz2|gz|xz)(?:\?|$)/.test(url)
        if (archive) {
          const file = path.join(stage, 'model.archive')
          await this.downloadFile(url, file, signal, update)
          item.phase = 'unpacking'; this.changed()
          await this.unpack(file, stage, group.flatMap(spec => spec.directoryMembers ? spec.directoryMembers.map(member => `${spec.fileName}/${member.name}`) : [spec.fileName]), signal)
          completed += statSync(file).size; rmSync(file)
        } else for (const spec of group) {
          if (spec.directoryMembers) for (const member of spec.directoryMembers) {
            const file = path.join(stage, spec.fileName, member.name)
            await this.downloadFile(`${url}/${member.name}`, file, signal, update); completed += statSync(file).size
          } else {
            const file = path.join(stage, spec.fileName)
            await this.downloadFile(url, file, signal, update); completed += statSync(file).size
          }
        }
      }
      item.phase = 'verifying'; this.changed()
      for (const spec of specs) {
        signal.throwIfAborted()
        const file = path.join(stage, spec.fileName)
        let digest = spec.sha256
        if (spec.checksumManifest) {
          const manifestSpec = specs.find(entry => entry.fileName === spec.checksumManifest)!
          const manifestPath = path.join(stage, manifestSpec.fileName)
          if (await this.hash(manifestPath) !== manifestSpec.sha256) throw new Error('Model manifest checksum mismatch')
          const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { files: { path: string; sha256: string }[] }
          digest = manifest.files.find(entry => path.basename(entry.path) === path.basename(spec.fileName))?.sha256
          if (!digest) throw new Error('Model file missing from pinned manifest')
        }
        if (digest && await this.hash(file) !== digest) throw new Error('Model checksum mismatch')
        if (spec.directoryMembers) for (const member of spec.directoryMembers) {
          const memberFile = path.join(file, member.name)
          if (statSync(memberFile).size < member.minBytes || await this.hash(memberFile) !== member.sha256) throw new Error('Tokenizer checksum mismatch')
          if (member.json) JSON.parse(readFileSync(memberFile, 'utf8'))
        }
        if (!spec.directoryMembers && (!statSync(file).isFile() || !statSync(file).size)) throw new Error('Empty model file')
      }
      // Publish verified files only; the receipt is the final atomic readiness marker.
      for (const spec of specs) {
        const destination = path.join(this.directory, spec.fileName)
        mkdirSync(path.dirname(destination), { recursive: true })
        if (spec.directoryMembers) { rmSync(destination, { force: true, recursive: true }) }
        renameSync(path.join(stage, spec.fileName), destination)
      }
      writeFileSync(this.receipt(id) + '.tmp', JSON.stringify({ version: 1, files: specs.map(spec => spec.fileName) }), { mode: 0o600 })
      renameSync(this.receipt(id) + '.tmp', this.receipt(id))
    } catch (error) { this.failures.set(id, signal.aborted ? 'Download cancelled' : String(error instanceof Error ? error.message : error)); throw error }
    finally { rmSync(stage, { recursive: true, force: true }); this.active.delete(id); this.changed() }
  }
}
