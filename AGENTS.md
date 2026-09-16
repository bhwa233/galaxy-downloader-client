# Electron client

- This is an independent pnpm workspace; run commands from `electron-client/`.
- `pnpm install`, `pnpm engine:dev`, `pnpm dev` for development.
- Gates: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:e2e`.
- Tests: Vitest for domain logic / trust boundaries; Playwright for the actual Electron window. No template counter tests.
- Live probe: `pnpm test:live:profiles` parses the four real creator pages in `test/fixtures/profiles.ts` and asserts each listing returns loadable covers. Not part of `pnpm test` — it needs Chrome with remote debugging on 9222, the accounts signed in, and `pnpm engine:dev`. `scripts/run-live-probe.sh` launches that Chrome itself (`LIVE_CHROME_BIN` / `LIVE_CHROME_PROFILE`); a Chrome backgrounded from a shell dies on WSL, so the probe owns the process.
- UI primitives are copied from Galaxy into `src/components/ui`; runtime dependencies are in package.json.
- All parser, browser, tool and download logic stays in the main process or local Python engine. Never call the remote Worker/DLP services.
- Authentication: selected browser through yt-dlp, then authorized Chrome CDP. No cookie import, embedded login or alternate CDP browsers.
- Never return cookies, authorization headers or arbitrary file/IPC capabilities to renderer code.
- Scaffold provenance: electron-vite/electron-vite-react revision 18d31d5dcfe6637aa1dd6699babcab1849c83f98.
