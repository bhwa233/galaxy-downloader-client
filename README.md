# Galaxy Downloader Desktop

Electron desktop client for local parsing and downloading. The client reuses the Galaxy Downloader visual language and runs yt-dlp, FFmpeg, browser Profile reading, Chrome CDP, parsing, queue, and storage locally. It never calls the bhwa233 Worker or remote DLP at runtime.

## Development

```bash
pnpm install
pnpm engine:dev
pnpm dev
```

The selected browser Profile is read through yt-dlp. If that is unavailable or insufficient, click **连接 Chrome** and follow the Chrome remote debugging consent prompt. No cookies.txt import or embedded login is provided.

```bash
pnpm check       # typecheck, lint, domain tests, renderer/main build
pnpm test:e2e    # real Electron window and local media fixture
pnpm package     # native PyInstaller engine + FFmpeg + electron-builder package
```

`pnpm engine:build` produces the platform-specific `resources/engine/media-engine` and FFmpeg files. The CI workflow builds native packages on Ubuntu, Windows, and macOS. Configure signing and GitHub release credentials before publishing production updates.

The implementation and acceptance details are in [`docs/electron-client-plan.md`](../docs/electron-client-plan.md).
