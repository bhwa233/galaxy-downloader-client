// Adapted from nexmoe/VidBee ce82483 (MIT). See LICENSE in this directory.
import { cpus, totalmem } from 'node:os'
import { type AsrLanguageGroup, type AsrTierId, asrTierInfo, type MachineClass } from './asr-tiers'

export type OsKind = 'linux' | 'macos' | 'other' | 'windows'

export type GpuKind = 'amd' | 'apple' | 'intel' | 'nvidia' | 'unknown'

export interface GpuDeviceHint {
  active?: boolean
  deviceString?: string
  vendorId?: number
  vendorString?: string
}

export interface MachineProfile {
  arch: string
  class: MachineClass
  cpuCount: number
  gpu: GpuKind
  gpuName: string | null
  os: OsKind
  ramBytes: number
}

export interface RecommendAsrInput {
  arch?: string
  cpuCount: number
  gpu?: GpuKind
  language: string
  os?: OsKind
  ramBytes: number
}

const NVIDIA_VENDOR = 0x10_de
const AMD_VENDOR = 0x10_02
const INTEL_VENDOR = 0x80_86
const APPLE_VENDOR = 0x10_6b

const GPU_RANK: Record<GpuKind, number> = {
  nvidia: 4,
  apple: 3,
  amd: 2,
  intel: 1,
  unknown: 0
}

/**
 * Map an app language code to the ASR language group used for ranking.
 */
export const languageGroupFor = (language: string): AsrLanguageGroup => {
  const normalized = language.trim().toLowerCase()
  if (normalized.startsWith('zh')) {
    return 'zh'
  }
  if (normalized.startsWith('ja') || normalized.startsWith('ko')) {
    return 'cjk'
  }
  if (normalized.startsWith('en')) {
    return 'en'
  }
  return 'multi'
}

/**
 * Map a Node platform id to the OS group used for recommendations.
 */
export const osKindFor = (platform: string): OsKind => {
  if (platform === 'darwin') {
    return 'macos'
  }
  if (platform === 'win32') {
    return 'windows'
  }
  if (platform === 'linux') {
    return 'linux'
  }
  return 'other'
}

/**
 * Classify this machine from RAM and CPU count.
 */
export const classifyMachine = (ramBytes: number, cpuCount: number): MachineClass => {
  const ramGB = ramBytes / 1024 ** 3
  if (ramGB < 8) {
    return 'low'
  }
  if (ramGB < 16 || cpuCount <= 4) {
    return 'mid'
  }
  return 'high'
}

/**
 * Guess a GPU vendor from PCI ids and device name strings.
 */
export const gpuKindFromHint = (device: GpuDeviceHint): GpuKind => {
  const vendor = Number(device.vendorId ?? 0)
  if (vendor === NVIDIA_VENDOR) {
    return 'nvidia'
  }
  if (vendor === APPLE_VENDOR) {
    return 'apple'
  }
  if (vendor === AMD_VENDOR) {
    return 'amd'
  }
  if (vendor === INTEL_VENDOR) {
    return 'intel'
  }
  const text = `${device.vendorString ?? ''} ${device.deviceString ?? ''}`.toLowerCase()
  if (/\bnvidia\b|\bgeforce\b|\brtx\b|\bquadro\b/.test(text)) {
    return 'nvidia'
  }
  if (/\bapple\b|\bmetal renderer\b/.test(text)) {
    return 'apple'
  }
  if (/\bamd\b|\bradeon\b/.test(text)) {
    return 'amd'
  }
  if (/\bintel\b|\biris\b|\buhd\b/.test(text)) {
    return 'intel'
  }
  return 'unknown'
}

/**
 * Pull GPU device hints out of Electron/Chromium getGPUInfo payloads.
 */
export const collectGpuDevices = (info: unknown): GpuDeviceHint[] => {
  if (!info || typeof info !== 'object') {
    return []
  }
  const record = info as Record<string, unknown>
  const raw = record.gpuDevice ?? record.gpuDevices
  const devices: GpuDeviceHint[] = []
  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (item && typeof item === 'object') {
        devices.push(item as GpuDeviceHint)
      }
    }
  }
  const aux = record.auxAttributes
  if (aux && typeof aux === 'object') {
    const fields = aux as Record<string, unknown>
    devices.push({
      deviceString: String(fields.glRenderer ?? fields.displayName ?? ''),
      vendorString: String(fields.glVendor ?? fields.vendorString ?? '')
    })
  }
  return devices
}

/**
 * Turn an ANGLE blob into a short chip name such as "Apple M4 Max".
 */
export const prettyGpuName = (raw: string | null | undefined): string | null => {
  const text = raw?.trim() ?? ''
  if (!text) {
    return null
  }
  const appleChip = text.match(/Apple\s+M\d+(?:\s+(?:Pro|Max|Ultra|Plus))?/i)
  if (appleChip?.[0]) {
    return appleChip[0].replace(/\s+/g, ' ').trim()
  }
  const metal = text.match(/Metal Renderer:\s*([^,)]+)/i)
  if (metal?.[1]) {
    return metal[1].trim()
  }
  if (/angle/i.test(text)) {
    return null
  }
  return text
}

/**
 * True when this host is Apple Silicon, including CPU-model fallback.
 */
export const isAppleSilicon = (opts?: {
  arch?: string
  cpuModel?: string
  platform?: string
}): boolean => {
  const platform = opts?.platform ?? process.platform
  const arch = opts?.arch ?? process.arch
  if (platform === 'darwin' && arch === 'arm64') {
    return true
  }
  return platform === 'darwin' && /^Apple\s+M\d+/i.test(opts?.cpuModel ?? '')
}

/**
 * Pick the strongest GPU from a Chromium/Electron gpuDevice list.
 */
export const classifyGpuDevices = (devices: readonly GpuDeviceHint[]): GpuKind => {
  const ranked = devices
    .map((device) => ({ device, kind: gpuKindFromHint(device) }))
    .filter((item) => item.kind !== 'unknown' || item.device.active)
  if (ranked.length === 0) {
    return 'unknown'
  }
  const active = ranked.filter((item) => item.device.active !== false)
  const pool = active.length > 0 ? active : ranked
  return (
    pool.sort((left, right) => GPU_RANK[right.kind] - GPU_RANK[left.kind])[0]?.kind ?? 'unknown'
  )
}

/**
 * Human-readable name from the strongest listed GPU.
 */
export const gpuNameFromDevices = (devices: readonly GpuDeviceHint[]): string | null => {
  const kind = classifyGpuDevices(devices)
  if (kind === 'unknown') {
    return null
  }
  const match = [...devices]
    .reverse()
    .find((device) => gpuKindFromHint(device) === kind && device.deviceString?.trim())
  return prettyGpuName(match?.deviceString)
}

/**
 * Intel iGPUs are the only GPU class that should prefer smaller/faster models.
 */
export const isWeakGpu = (gpu: GpuKind): boolean => gpu === 'intel'

/**
 * Resolve a GPU vendor and display name, falling back to Apple Silicon.
 */
export const resolveGpuProfile = (opts?: {
  arch?: string
  cpuModel?: string
  devices?: readonly GpuDeviceHint[]
  gpu?: GpuKind
  gpuName?: string | null
  platform?: string
}): { gpu: GpuKind; gpuName: string | null } => {
  const cpuModel = opts?.cpuModel ?? cpus()[0]?.model
  const apple = isAppleSilicon({
    arch: opts?.arch,
    cpuModel,
    platform: opts?.platform
  })
  const detected =
    opts?.gpu && opts.gpu !== 'unknown' ? opts.gpu : classifyGpuDevices(opts?.devices ?? [])
  const gpu = detected === 'unknown' ? (apple ? 'apple' : 'unknown') : detected
  const fromHint = prettyGpuName(opts?.gpuName)
  if (fromHint) {
    return { gpu, gpuName: fromHint }
  }
  const fromDevices = prettyGpuName(gpuNameFromDevices(opts?.devices ?? []))
  if (fromDevices) {
    return { gpu, gpuName: fromDevices }
  }
  if (gpu !== 'apple') {
    return { gpu, gpuName: null }
  }
  const appleChip = /^Apple\s+M\d+/i.test(cpuModel ?? '') ? cpuModel?.trim() : undefined
  return { gpu, gpuName: appleChip || 'Apple Silicon' }
}

/**
 * Read RAM, CPU, OS, and optional GPU from the current process host.
 */
export const readMachineProfile = (opts?: {
  arch?: string
  cpuModel?: string
  devices?: readonly GpuDeviceHint[]
  gpu?: GpuKind
  gpuName?: string | null
  platform?: string
}): MachineProfile => {
  const platform = opts?.platform ?? process.platform
  const arch = opts?.arch ?? process.arch
  const os = osKindFor(platform)
  const ramBytes = totalmem()
  const cpuCount = Math.max(1, cpus().length)
  const resolved = resolveGpuProfile({
    arch,
    cpuModel: opts?.cpuModel,
    devices: opts?.devices,
    gpu: opts?.gpu,
    gpuName: opts?.gpuName,
    platform
  })
  return {
    arch,
    class: classifyMachine(ramBytes, cpuCount),
    cpuCount,
    gpu: resolved.gpu,
    gpuName: resolved.gpuName,
    os,
    ramBytes
  }
}

/**
 * Drop models that need more RAM than this machine can spare.
 */
const fitsRam = (id: AsrTierId, ramBytes: number): boolean => {
  const ramGB = ramBytes / 1024 ** 3
  return ramGB + 0.5 >= asrTierInfo(id).minRamGB
}

/**
 * Keep the first unique ids that still fit in RAM.
 */
const pickFits = (ids: readonly AsrTierId[], ramBytes: number): AsrTierId[] => {
  const picked: AsrTierId[] = []
  for (const id of ids) {
    if (picked.includes(id) || !fitsRam(id, ramBytes)) {
      continue
    }
    picked.push(id)
    if (picked.length >= 3) {
      break
    }
  }
  if (picked.length === 0 && fitsRam('minimal', ramBytes)) {
    return ['minimal']
  }
  return picked.length > 0 ? picked : ['minimal']
}

/**
 * Recommend up to three ASR models for this machine, GPU, OS, and UI language.
 */
export const recommendAsrModels = (input: RecommendAsrInput): AsrTierId[] => {
  const machine = classifyMachine(input.ramBytes, input.cpuCount)
  const group = languageGroupFor(input.language)
  const gpu = input.gpu ?? 'unknown'
  const weak = isWeakGpu(gpu)
  const appleSilicon = input.os === 'macos' && (input.arch === 'arm64' || gpu === 'apple')
  const strong = !weak && (gpu === 'apple' || gpu === 'nvidia' || gpu === 'amd' || appleSilicon)
  if (machine === 'low') {
    const lowZh: AsrTierId[] = ['minimal', 'whisper-base', 'sense-voice']
    return pickFits(
      group === 'zh' ? lowZh : ['minimal', 'whisper-base', 'balanced'],
      input.ramBytes
    )
  }
  if (group === 'zh') {
    if (machine === 'high' && (strong || gpu === 'unknown')) {
      return pickFits(['quality', 'sense-voice-2025', 'whisper-turbo'], input.ramBytes)
    }
    if (machine === 'high') {
      return pickFits(['sense-voice-2025', 'quality', 'whisper-turbo'], input.ramBytes)
    }
    return pickFits(['sense-voice-2025', 'sense-voice', 'whisper-base'], input.ramBytes)
  }
  if (group === 'cjk') {
    return pickFits(['sense-voice-2025', 'sense-voice', 'whisper-turbo'], input.ramBytes)
  }
  if (group === 'en') {
    if (machine === 'high' && (strong || gpu === 'unknown')) {
      return pickFits(['parakeet-v3', 'whisper-turbo', 'balanced'], input.ramBytes)
    }
    return pickFits(['parakeet-v2', 'balanced', 'whisper-base'], input.ramBytes)
  }
  if (machine === 'high' && (strong || gpu === 'unknown')) {
    return pickFits(['whisper-turbo', 'sense-voice-2025', 'parakeet-v3'], input.ramBytes)
  }
  return pickFits(['sense-voice-2025', 'balanced', 'whisper-base'], input.ramBytes)
}
