// Adapted from nexmoe/VidBee ce82483 (MIT). See LICENSE in this directory.
import { readFileSync } from 'node:fs'
const TARGET_SAMPLE_RATE = 16000

export interface PcmWave {
  sampleRate: number
  samples: Float32Array
}

/**
 * Read a PCM WAV into a JS-owned Float32Array.
 * sherpa-onnx-node's readWave uses N-API external buffers, which Electron-as-Node rejects.
 */
export function readPcmWav(path: string): PcmWave {
  const buf = readFileSync(path)
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`not a wav file: ${path}`)
  }
  let offset = 12
  let sampleRate = TARGET_SAMPLE_RATE
  let bitsPerSample = 16
  let channels = 1
  let data: Buffer | null = null
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const start = offset + 8
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(start + 2)
      sampleRate = buf.readUInt32LE(start + 4)
      bitsPerSample = buf.readUInt16LE(start + 14)
    } else if (id === 'data') {
      data = buf.subarray(start, start + size)
      break
    }
    offset = start + size + (size % 2)
  }
  if (!data) {
    throw new Error(`wav has no data chunk: ${path}`)
  }
  const frameSize = Math.max(1, channels) * Math.max(1, bitsPerSample / 8)
  const frames = Math.floor(data.length / frameSize)
  const samples = new Float32Array(frames)
  if (bitsPerSample === 16) {
    for (let i = 0; i < frames; i += 1) {
      let sum = 0
      for (let ch = 0; ch < channels; ch += 1) {
        sum += data.readInt16LE((i * channels + ch) * 2) / 32768
      }
      samples[i] = sum / channels
    }
  } else if (bitsPerSample === 32) {
    for (let i = 0; i < frames; i += 1) {
      let sum = 0
      for (let ch = 0; ch < channels; ch += 1) {
        sum += data.readFloatLE((i * channels + ch) * 4)
      }
      samples[i] = sum / channels
    }
  } else if (bitsPerSample === 8) {
    for (let i = 0; i < frames; i += 1) {
      let sum = 0
      for (let ch = 0; ch < channels; ch += 1) {
        sum += ((data[i * channels + ch] ?? 128) - 128) / 128
      }
      samples[i] = sum / channels
    }
  } else {
    throw new Error(`unsupported wav bit depth: ${bitsPerSample}`)
  }
  return { sampleRate, samples }
}
