import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Engine, redact } from './engine'
import { downloadHttp, type Fetcher } from './http-download'

import type { KernelState } from '../../shared/processing'
type Release = { version: string; file: string; sha256: string }
type Installed = { active?: Release; previous?: Release; checkedAt?: string }
/** An official pure-Python wheel is loaded per engine process; running jobs keep their kernel. */
export class KernelUpdates {
  state: KernelState = { status: 'idle' }
  private installed: Installed = {}
  private active?: AbortController
  private timer?: ReturnType<typeof setTimeout>
  private get manifest(): string { return path.join(this.directory, 'installed.json') }
  constructor(private directory: string, private engine: Engine, private fetcher: Fetcher, private changed: () => void) {
    mkdirSync(directory, { recursive: true })
    try { this.installed = JSON.parse(readFileSync(this.manifest, 'utf8')) as Installed } catch { /* Bundled kernel is the initial fallback. */ }
  }
  private file(release: Release): string { if (path.basename(release.file) !== release.file || !/^yt_dlp-[\d.]+-py3-none-any\.whl$/.test(release.file)) throw new Error('Invalid kernel filename'); return path.join(this.directory, release.file) }
  private async verified(release: Release): Promise<boolean> {
    const file = this.file(release)
    if (!existsSync(file)) return false
    const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk)
    return hash.digest('hex') === release.sha256
  }
  private save(): void { writeFileSync(this.manifest + '.tmp', JSON.stringify(this.installed), { mode: 0o600 }); renameSync(this.manifest + '.tmp', this.manifest) }
  async initialize(): Promise<void> {
    const release = this.installed.active
    if (release) {
      try { if (!await this.verified(release)) throw new Error('Installed kernel checksum mismatch'); await this.engine.request({ operation: 'kernel-check', kernelWheel: this.file(release) }); this.engine.kernelWheel = this.file(release) }
      catch (error) { this.state.error = redact(String(error)); this.engine.kernelWheel = undefined }
    }
    await this.refreshVersion()
  }
  private async refreshVersion(): Promise<void> {
    const info = await this.engine.request<{ version: string }>({ operation: 'version' })
    this.state = { ...this.state, version: info.version, previous: this.installed.active ? this.installed.previous?.version || 'bundled' : undefined, checkedAt: this.installed.checkedAt }; this.changed()
  }
  schedule(enabled: boolean): void {
    clearTimeout(this.timer)
    if (!enabled || process.env.CLIENT_TEST_DATA) return
    const elapsed = Date.now() - Date.parse(this.installed.checkedAt || '1970-01-01')
    this.timer = setTimeout(() => { void this.check().finally(() => this.schedule(enabled)) }, Math.max(30_000, 24 * 3600_000 - elapsed)); this.timer.unref()
  }
  async check(): Promise<void> {
    if (this.active) return
    const controller = new AbortController(); this.active = controller
    this.state = { ...this.state, status: 'checking', error: undefined }; this.changed()
    try {
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)])
      const response = await this.fetcher('https://pypi.org/pypi/yt-dlp/json', { signal })
      if (!response.ok) throw new Error(`PyPI HTTP ${response.status}`)
      const data = await response.json() as { info: { version: string }; urls: { filename: string; url: string; digests: { sha256: string } }[] }
      const version = data.info.version
      if (!/^\d{4}\.\d{1,2}\.\d{1,2}(?:\.\d+)?$/.test(version)) throw new Error('Invalid yt-dlp release')
      const parts = (value: string) => value.split('.').map(Number)
      const newer = parts(version).some((value, index, all) => all.slice(0, index).every((part, i) => part === (parts(this.state.version || '0')[i] || 0)) && value > (parts(this.state.version || '0')[index] || 0))
      if (newer) {
        const wheel = data.urls.find(file => file.filename === `yt_dlp-${version}-py3-none-any.whl`)
        if (!wheel || new URL(wheel.url).hostname !== 'files.pythonhosted.org' || !wheel.url.startsWith('https://') || !/^[a-f\d]{64}$/.test(wheel.digests.sha256)) throw new Error('Official yt-dlp wheel is unavailable')
        const release: Release = { version, file: wheel.filename, sha256: wheel.digests.sha256 }
        const target = this.file(release)
        this.state.status = 'downloading'; this.changed()
        await downloadHttp(this.fetcher, wheel.url, target, [], {}, signal, progress => { this.state.progress = progress; this.changed() })
        if (!await this.verified(release)) { rmSync(target, { force: true }); throw new Error('Kernel checksum mismatch') }
        const probe = await this.engine.request<{ version: string }>({ operation: 'kernel-check', kernelWheel: target }, signal)
        if (probe.version !== version) throw new Error('Kernel compatibility check failed')
        this.installed.previous = this.installed.active; this.installed.active = release; this.engine.kernelWheel = target
      }
      this.installed.checkedAt = new Date().toISOString(); this.save(); this.state.status = 'idle'; await this.refreshVersion()
    } catch (error) { this.state.status = 'error'; this.state.error = redact(error instanceof Error ? error.message : String(error)); this.installed.checkedAt = new Date().toISOString(); this.save(); this.changed() }
    finally { this.active = undefined }
  }
  async rollback(): Promise<void> {
    if (this.active) throw new Error('Wait for the kernel update to finish')
    const previous = this.installed.previous
    if (previous) { if (!await this.verified(previous)) throw new Error('Previous kernel is unavailable'); await this.engine.request({ operation: 'kernel-check', kernelWheel: this.file(previous) }) }
    this.installed.active = previous; this.installed.previous = undefined; this.engine.kernelWheel = previous ? this.file(previous) : undefined
    this.save(); this.state.status = 'idle'; this.state.error = undefined; await this.refreshVersion()
  }
  stop(): void { clearTimeout(this.timer); this.active?.abort() }
}
