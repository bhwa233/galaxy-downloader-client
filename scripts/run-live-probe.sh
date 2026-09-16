#!/usr/bin/env bash
# Convenience wrapper for the live profile probe: points it at a signed-in Chrome and runs vitest.
# Override CHROME_BIN / CHROME_PROFILE for your machine. Extra args go to vitest (e.g. -t 抖音).
set -u
# nvm's node is not on PATH for non-login shells.
[ -d "$HOME/.nvm/versions/node" ] && PATH="$(ls -d "$HOME"/.nvm/versions/node/*/bin | tail -1):$PATH"
cd "$(dirname "$0")/.."

export LIVE_CHROME_BIN="${CHROME_BIN:-$HOME/.agent-browser/browsers/chrome-148.0.7778.97/chrome}"
export LIVE_CHROME_PROFILE="${CHROME_PROFILE:-$HOME/.config/bhwa233-wsl-chromium}"
node node_modules/vitest/vitest.mjs run --config vitest.live.config.ts "$@"
