import path from 'node:path'
import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist-electron/processing', emptyOutDir: true, target: 'node24',
    lib: { entry: path.resolve('electron/services/processing/worker.ts'), formats: ['es'], fileName: () => 'worker.mjs' },
    rolldownOptions: { platform: 'node', external: [...builtinModules, ...builtinModules.map(name => `node:${name}`), 'sherpa-onnx-node', 'opencc-js'] },
  },
})
