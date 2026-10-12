# Electron client

- This is an independent pnpm workspace; run commands from `electron-client/`.
- `pnpm install`, `pnpm engine:dev`, `pnpm dev` for development.
- Gates: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:e2e`.
- **Prototype stage: do not write test cases.** No new or modified Vitest/Playwright/live specs, including updating an existing test to match changed behaviour. Verify changes by running the real client against real sites (throwaway probe scripts are fine, delete them afterwards) and record the results in `docs/test-links.md` / `docs/requirements.md` instead.
- Tests: Vitest for domain logic / trust boundaries; Playwright for the actual Electron window. No template counter tests.
- Live probe: `pnpm test:live:profiles` drives the real client through Playwright `_electron`, parses the four creator pages in `test/fixtures/profiles.ts` and asserts each listing returns loadable covers. Not part of `pnpm test` or `pnpm test:e2e` — it needs `pnpm engine:dev` and the accounts already signed in through 设置 → 浏览器 → 打开登录窗口, so it runs against the real user data directory.
- UI primitives are copied from Galaxy into `src/components/ui`; runtime dependencies are in package.json.
- All parser, browser, tool and download logic stays in the main process or local Python engine. Never call the remote Worker/DLP services.
- Authentication is two hops: yt-dlp first (best-effort `--cookies-from-browser`, silently dropped when the cookie database is unreadable), then the client's own browser session in the `persist:media` partition. No external Chrome CDP and no cookie file import.
- The embedded browser loads third-party pages: keep its partition off the main window, `nodeIntegration` off, window-open denied, and never hand its session to the renderer.
- Never return cookies, authorization headers or arbitrary file/IPC capabilities to renderer code.
- Scaffold provenance: electron-vite/electron-vite-react revision 18d31d5dcfe6637aa1dd6699babcab1849c83f98.
