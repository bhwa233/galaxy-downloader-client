import { createRequire } from 'node:module'
import { loadChunkManifest, saveChunkManifest, sourceFingerprint } from './vendor/chunk-manifest'
import { ModelManager } from './models'
import { SherpaTranscriptionPipeline, type SherpaAddon } from './vendor/pipeline-sherpa'
import type { PipelineRunInput } from './vendor/pipeline'

const require = createRequire(import.meta.url)
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => { input += chunk; if (input.length > 32 * 1024 * 1024) process.exit(1) })
const emit = (value: unknown) => process.stdout.write(JSON.stringify(value) + '\n')
process.stdin.on('end', () => {
  void (async () => {
    const request = JSON.parse(input) as PipelineRunInput & { modelsDirectory: string }
    if (request.manifestPath && !loadChunkManifest(request.manifestPath)) saveChunkManifest(request.manifestPath, { key: { taskId: request.sourceFilePath, fingerprint: sourceFingerprint(request.sourceFilePath), modelVersion: `galaxy-v1-${request.asrTier}` }, durationMs: request.durationMs, speakers: [], turns: [], chunks: [], stages: [] })
    const models = new ModelManager(request.modelsDirectory)
    const pipeline = new SherpaTranscriptionPipeline({ models, createAddon: () => require('sherpa-onnx-node') as SherpaAddon, provider: 'cpu' })
    const result = await pipeline.run({ ...request, onProgress: progress => emit({ kind: 'processing', status: progress.stage, progress: progress.percent }), onPartial: segment => emit({ kind: 'partial', result: segment }) })
    emit({ kind: 'result', result })
  })().then(() => process.exit(0), error => { process.stderr.write(error instanceof Error ? error.stack || error.message : String(error)); process.exit(1) })
})
