import { afterAll, beforeAll, expect, test } from 'vitest'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type BrowserContext } from 'playwright-core'
import { Engine } from '../../electron/services/engine'
import { ChromeConnection } from '../../electron/services/chrome'
import { Parser } from '../../electron/services/parser'
import { PROFILE_FIXTURES } from '../fixtures/profiles'

// Opt-in probe against the real upstreams. Run with `pnpm test:live:profiles`.
// The 'chrome' fixtures need a Chrome on port 9222 whose profile is signed in: either start one
// yourself, or set LIVE_CHROME_BIN (and optionally LIVE_CHROME_PROFILE) to let this file launch it.
// The 'engine' fixtures need the dev engine (`pnpm engine:dev`).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
// An absent resources directory makes Engine fall back to .venv/python and node_modules/ffmpeg-static.
const engine = new Engine(root, path.join(root, 'resources'), false)
const chrome = new ChromeConnection()
const parser = new Parser(engine, chrome)
let launched: BrowserContext | undefined

beforeAll(async () => {
  const executablePath = process.env.LIVE_CHROME_BIN
  if (!executablePath) return
  // Chrome must outlive the shell that started it, so the probe owns the process instead.
  launched = await chromium.launchPersistentContext(process.env.LIVE_CHROME_PROFILE || path.join(root, '.live-chrome'), {
    executablePath, headless: process.env.LIVE_CHROME_HEADED !== '1',
    args: ['--remote-debugging-port=9222', '--no-sandbox', '--disable-gpu', '--no-first-run', '--no-default-browser-check'],
    viewport: { width: 1440, height: 900 },
  })
})
afterAll(async () => { await chrome.disconnect(); await launched?.close() })

test.each(PROFILE_FIXTURES)('$platform profile lists posts with covers', async fixture => {
  const { result } = await parser.parse(fixture.url, undefined, '', new AbortController().signal)
  const covered = result.items.filter(item => item.thumbnail && /^https?:/.test(item.thumbnail))
  console.log(`${fixture.platform}: ${result.items.length} items, ${covered.length} with a cover, method=${result.method}`)
  console.log(result.items.slice(0, 3).map(item => `  ${item.kind} ${item.title.slice(0, 40)} ${item.thumbnail?.slice(0, 60) || '(no cover)'}`).join('\n'))
  expect(result.items.length).toBeGreaterThan(0)
  // Every task card shows a cover, so a listing without any thumbnail is a regression even when the URLs still work.
  expect(covered.length).toBeGreaterThan(0)
  // A cover the renderer cannot load is the same failure as a missing one; the renderer sends no referrer.
  const response = await fetch(covered[0].thumbnail!, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  expect(response.status, `cover fetch for ${fixture.platform}`).toBe(200)
}, 300_000)
