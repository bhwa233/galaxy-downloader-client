---
name: galaxy-downloader
description: Download videos, audio, covers and whole profiles or collections from Bilibili, YouTube, Douyin, Xiaohongshu, Weibo, X, Instagram, WeChat articles and other yt-dlp sites through the Galaxy Downloader desktop client, using the sign-ins the user keeps in it. Use when the user asks to download, save or grab media from a link, list what a profile/collection/multi-part video holds, check or wait on downloads, or asks for "galaxy". Triggers - 下载视频, 下载音频, 保存封面, 批量下载主页, 下载合集, download this video, save the audio, grab the cover, galaxy download.
---

# Galaxy Downloader

Drive the Galaxy Downloader client with its `galaxy` command. The command does no downloading of its own: it talks to the client running on this machine (and starts it in the background if needed), so it uses the same sign-ins, listing support and task queue as the app window.

## Before anything

Run `galaxy status --json`.

- Works → go on.
- `command not found` → the command is not installed. Tell the user: install Galaxy Downloader from https://github.com/bhwa233/galaxy-downloader-client/releases, then in the app open **Settings → Tools & updates → Install command line tool**, and open a new terminal. Do not try to install it yourself.
- Exit code 4 → the client could not be started or reached; tell the user to open Galaxy Downloader once.

Always pass `--json`. Stdout is then exactly one JSON object; progress goes to stderr.

## Workflow

1. **Look first**: `galaxy parse "<url>" --json`. A share message with a link inside works too.
   - `result.items[]` has `index` (what `--items` takes), `title`, `kind` (`video` / `audio` / `image`), `duration` (seconds), `locked` (a paywall that makes the item unavailable) and `formats[]` (`id`, `label`, `height`, `size` in bytes).
   - `result.pagination.hasMore` means a listing has more pages: `--page 2`, `--page 3`, …
2. **Download**: `galaxy download "<url>" --items 1,3-5 --wait --json`
   - A single item needs no `--items`. Several items need `--items` or `--all`; without either the command fails on purpose rather than downloading a whole profile.
   - `--kind video` (default), `audio`, `cover`, or combined: `--kind video,cover`.
   - `--format <id>` picks a quality from step 1; leave it out for the user's default.
   - With `--wait` the reply is `{ ok, added, jobs: [{ id, status, files[], error }] }`; report `files` to the user. Without `--wait` it returns `jobIds` immediately; follow up with `galaxy wait <id…> --json`.
   - Long downloads: add `--timeout <seconds>` and fall back to `galaxy job <id> --json`.
3. **Manage**: `galaxy jobs [--status failed] --json`, `galaxy job <id>`, `galaxy retry|pause|resume|cancel <id>`. Ids can be shortened to their first 8 characters.

## Exit codes

| Code | Meaning | What to do |
| --- | --- | --- |
| 0 | done | report the result |
| 1 | failed | read `error`; retry once if it looks transient, otherwise report it |
| 2 | the platform wants a sign-in or a verification | run `galaxy login "<loginUrl>"` (the reply carries `loginUrl`), ask the user to sign in or pass the check in the window that opens and close it, then run the same command again |
| 3 | refused for a reason no sign-in lifts here: `wall` is `membership`, `purchase` or `encrypted` | tell the user plainly; do not look for a way around it |
| 4 | client unreachable | see "Before anything" |

## Boundaries

- Never ask for, type or store the user's passwords or cookies. Sign-ins happen only in the app's own window, by the user.
- Do not try to get around paywalls, DRM or platform checks. Exit code 3 is final.
- Download only what the user asked for, and what they are entitled to download.
- Files land in the folder set in the app (`galaxy status --json` → `downloadDirectory`); the command line cannot change it.
