---
name: run-electron-client
description: Build, launch, drive and screenshot the Galaxy Downloader Electron client (electron-client). Use when asked to run, start, open, smoke-test, screenshot or click through the desktop app, or to verify a UI/main-process change in the real app rather than in tests.
---

# Run the Galaxy Downloader client

Electron + Vite + React desktop app. The skill is tracked under `.agents/skills/`
alongside the repo's other skills; `.claude/skills/run-electron-client` is a
symlink to it so Claude Code still auto-discovers it (`.claude/` is gitignored).

The agent path is a REPL driver,
`.agents/skills/run-electron-client/driver.mjs`, which launches the **built** app
through Playwright's `_electron` and accepts one command per line
(`launch`, `click`, `fill`, `ss`, `eval`, `state`, `quit`). Screenshots land in
`test-results/driver/`.

All paths below are relative to the unit root (`electron-client/`).

## Prerequisites — this repo only runs from inside WSL

The working tree lives on the WSL filesystem (`~/code/electron-client`, reachable
from Windows as `\\wsl.localhost\Ubuntu\home\<user>\code\electron-client`), and
`node_modules` is a Linux pnpm store full of Linux symlinks. Running `pnpm` from
Windows silently sees an empty `node_modules`. Every command must run in the
Ubuntu distro.

Node is installed through nvm and is **not** on the PATH of a non-login
`wsl.exe ... bash -c` shell, so export it explicitly:

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"   # node v24.15.0, pnpm 11.8.0
```

No `apt-get` was needed: WSLg supplies `DISPLAY=:0`, so Electron opens a real
window on the Windows desktop and `xvfb` is unnecessary. `resources/engine/`
(`media-engine`, `ffmpeg`) was already populated; if it is missing, run
`pnpm engine:dev` first.

### Calling into WSL from a Windows Git Bash shell

```bash
MSYS_NO_PATHCONV=1 wsl.exe -d Ubuntu -- bash /home/<user>/<script>.sh
```

`MSYS_NO_PATHCONV=1` is required — without it Git Bash rewrites `/home/...` into
`C:/Program Files/Git/home/...` and bash reports "No such file or directory".
Write the script to a file rather than passing `bash -lc '...'`: a login shell
inherits the full Windows `PATH`, which contains unquoted spaces and parentheses
and produces `syntax error near unexpected token '('`.

## Build

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd ~/code/electron-client
pnpm build            # typecheck + vite build + dist-electron/{main,preload}
```

## Run (agent path) — the driver

One-shot smoke run, commands piped in:

```bash
export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"
cd ~/code/electron-client
node .agents/skills/run-electron-client/driver.mjs <<'CMDS'
launch
ss home
text h1
click 新建任务
ss new-task
errors
quit
CMDS
```

Verified output:

```
driver ready
ok launched /tmp/galaxy-driver-yqLDVj
ok /home/<user>/code/electron-client/test-results/driver/home.png
ok 全部任务
ok clicked 新建任务
ok /home/<user>/code/electron-client/test-results/driver/new-task.png
ok none
ok closed
```

Every command answers with a single `ok <...>` or `err <...>` line, so a caller
can grep for the result.

| Command | Effect |
| --- | --- |
| `launch [dir]` | Launch with `CLIENT_TEST_DATA` pointed at a fresh temp dir (or `dir`) |
| `real` | Launch against the real user profile — shows the user's actual jobs and settings |
| `ss <name>` | Full-page screenshot to `test-results/driver/<name>.png` |
| `click <name>` | Click the first button/tab/link with that accessible name |
| `fill <label> <value>` | Fill the textbox with that accessible name |
| `text [selector]` | Dump text (default `body`), collapsed and truncated to 1200 chars |
| `eval <js>` | Evaluate an expression in the renderer, print JSON (awaited) |
| `state` | `window.desktopApi.command('state:get', null)` |
| `errors` | Renderer `pageerror` messages collected since launch |
| `quit` | Close the app and exit |

### Interactive, held open across turns (tmux)

```bash
tmux new-session -d -s galaxy
tmux send-keys -t galaxy "export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:\$PATH && cd $HOME/code/electron-client && node .agents/skills/run-electron-client/driver.mjs" Enter
sleep 2
tmux send-keys -t galaxy "real" Enter
sleep 12
tmux send-keys -t galaxy "click 已完成" Enter
sleep 3
tmux send-keys -t galaxy "ss real-completed" Enter
sleep 4
tmux capture-pane -pt galaxy | grep -v '^$' | tail -12
```

tmux is required for anything long-lived: a process started by
`wsl.exe -- bash <script>` is killed when that `wsl.exe` call returns, even with
`setsid nohup ... &`.

## Run (human path) — dev server with hot reload

```bash
pkill -f "vite/bin/vite.js"; sleep 1
tmux new-session -d -s devapp
tmux send-keys -t devapp "export PATH=$HOME/.nvm/versions/node/v24.15.0/bin:\$PATH && cd $HOME/code/electron-client && pnpm dev" Enter
sleep 25
tmux capture-pane -pt devapp | grep -v '^$' | tail -20
```

Vite serves on `http://127.0.0.1:5173` and `vite-plugin-electron` spawns Electron
with `--no-sandbox`. The window appears on the Windows desktop titled
**`Galaxy Downloader (Ubuntu)`** (it is an `msrdc` window — WSLg). Stop with
`tmux kill-session -t devapp`.

To capture that real OS window from Windows **without stealing focus**:

```bash
powershell.exe -NoProfile -ExecutionPolicy Bypass -File \
  '//wsl.localhost/Ubuntu/home/<user>/code/electron-client/.agents/skills/run-electron-client/window-shot.ps1'
# -> C:\Users\<you>\AppData\Local\Temp\app.png 1276x947
```

Use forward slashes in that UNC path: Git Bash collapses `\\wsl.localhost\...`
into a single leading backslash and PowerShell reports the file does not exist.

## Test

```bash
pnpm test        # vitest, 42 tests / 6 files, ~1.5s
pnpm test:e2e    # pnpm build + Playwright _electron full download flow, ~8s
```

`pnpm test:live:profiles` hits real upstream sites and needs accounts already
signed in through 设置 → 浏览器 → 打开登录窗口; it is not part of the gates.

## Gotchas

- **Stale Vite wins the port race.** If a previous `vite` is still alive, the new
  one prints `Port 5173 is in use, trying another one...` and binds 5174 — then
  the old one gets killed, Electron is left pointing at a dead
  `VITE_DEV_SERVER_URL`, and the window is blank. Always
  `pkill -f "vite/bin/vite.js"` before starting dev, and check the bound port with
  `ss -ltn | grep 517`.
- **`tools.engine.available` is `false` for the first few seconds.** The engine
  probe is async; querying `state` right after `launch` reports the engine missing
  and the status dot renders grey. Wait ~10s before asserting on it:
  `eval new Promise(r => setTimeout(r, 15000)).then(() => window.desktopApi.command('state:get', null)).then(s => s.state.tools)`
  returns `{"engine":{"available":true,"version":"2026.08.19"}, ...}`.
- **`ELECTRON_RUN_AS_NODE` must be deleted, not blanked** — an empty value still
  counts as set and starts Electron as plain Node with no window. The driver does
  this already.
- **`text <selector>` on a missing element blocks for 30s** before returning
  `err locator.innerText: Timeout 30000ms exceeded`. Only query selectors you know
  are mounted (`.activity-log` exists only inside an open task detail).
- **The driver's accessible names are Chinese.** `click 新建任务`, `click 已完成`,
  `fill 媒体链接 <url>`. Copy them from `test/e2e/e2e.spec.ts`, which is the
  authoritative list of working selectors.
- **`tmux new-session -d -s x "<command>"` hung silently** in this environment —
  the pane process existed but produced no output for minutes. `tmux new-session -d`
  followed by `send-keys` works reliably; use that form.
- Two `ERROR:net/socket/ssl_client_socket_impl.cc:924 handshake failed ... net_error -100`
  lines in the dev log are thumbnail fetches failing behind the host proxy. Benign.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `bash: node: command not found` | The nvm bin dir is missing from a non-login shell; `export PATH="$HOME/.nvm/versions/node/v24.15.0/bin:$PATH"`. |
| `bash: C:/Program Files/Git/home/...: No such file or directory` | Prefix the `wsl.exe` call with `MSYS_NO_PATHCONV=1`. |
| `syntax error near unexpected token '('` from `wsl.exe -- bash -lc` | The Windows PATH leaked into the login shell; put the commands in a `.sh` file and run `bash <file>`. |
| `ls node_modules/electron/dist` fails from Windows | You are outside WSL; the store is Linux-only. Re-run inside the distro. |
| Background `pnpm dev` exits instantly with an empty log | It was reaped when `wsl.exe` returned. Use tmux. |
| Blank app window | Stale Vite on another port — see the first gotcha. |
| `window-shot.ps1` prints `NOTFOUND` | No WSLg window is open; it only sees the human dev path's window, not the driver's headless-ish `_electron` launch. Use the driver's `ss` instead. |
