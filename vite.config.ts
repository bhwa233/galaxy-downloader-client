import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { electronSimple } from 'vite-plugin-electron/multi-env'
import pkg from './package.json' with { type: 'json' }
const root = path.dirname(fileURLToPath(import.meta.url))
export default defineConfig({
  resolve: { alias: { '@': path.join(root, 'src') } },
  plugins: [react(), tailwindcss(), electronSimple({
    main: { input: 'electron/main/index.ts', options: { build: { outDir: 'dist-electron/main', rolldownOptions: { external: ['electron', ...Object.keys(pkg.dependencies)] } } } },
    preload: { input: 'electron/preload/index.ts', options: { build: { outDir: 'dist-electron/preload', rolldownOptions: { external: ['electron'], output: { format: 'cjs', entryFileNames: 'index.cjs' } } } } },
  })],
  clearScreen: false,
})
