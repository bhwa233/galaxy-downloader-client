import { builtinModules } from 'node:module'
import { defineConfig } from 'vite'

// The command line, built on its own into one file with nothing split out: dist-electron/cli/galaxy.mjs.
// The client copies it out of the app when the command is installed and runs it with its own binary
// as Node (ELECTRON_RUN_AS_NODE), so it cannot lean on chunks that live inside the app.
export default defineConfig({
  // The window's public files have no place next to a command line bundle.
  publicDir: false,
  build: {
    outDir: 'dist-electron/cli', emptyOutDir: true, target: 'node22', minify: false,
    lib: { entry: 'electron/cli/galaxy.ts', formats: ['es'], fileName: () => 'galaxy.mjs' },
    rolldownOptions: { external: [...builtinModules, ...builtinModules.map(name => `node:${name}`)] },
  },
})
