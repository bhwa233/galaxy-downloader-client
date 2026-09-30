# Galaxy Downloader

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

`pnpm engine:build` produces the platform-specific `resources/engine/media-engine` and FFmpeg files.

## Releases

Bump `version` in `package.json` and merge to `main`. When no tag for that version exists yet, CI builds Windows x64 (NSIS), macOS arm64 (dmg/zip) and Linux x64 (AppImage), then publishes them together as a GitHub Release tagged with the bare version (e.g. `0.2.0`). Pushes that keep the version unchanged only run the checks.

Builds are not code-signed yet:

- **Windows** — SmartScreen warns on first run; choose *More info → Run anyway*. In-app updates work.
- **macOS** — the first launch is blocked; allow it under *System Settings → Privacy & Security*. In-app updates open the release page for a manual download.

The implementation and acceptance details are in [`docs/electron-client-plan.md`](../docs/electron-client-plan.md).

## License

Galaxy Downloader is dual-licensed:

- **AGPL-3.0-only** — the default open-source track. Full text in [`LICENSE`](./LICENSE). Redistribution, modification and network use carry the AGPL's source-disclosure obligations.
- **Commercial license** — required for any use the AGPL does not permit, such as embedding this software in a closed-source product or offering a modified version as a hosted service without releasing the corresponding source.

Commercial use without either complying with the AGPL or holding a written commercial license is not permitted. See [`LICENSING.md`](./LICENSING.md) for the terms and for how to obtain a commercial license.

Third-party components keep their own licenses — see [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
