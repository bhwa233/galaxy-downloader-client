#!/usr/bin/env node
// Line-oriented REPL that drives the built Electron client through Playwright's
// `_electron` launcher. Run it inside tmux and talk to it with `send-keys`, or
// pipe a here-doc of commands into it for a one-shot smoke run.
//
// Commands (one per line):
//   launch [dataDir]      launch the app; dataDir defaults to a fresh temp dir
//   real                  launch against the real user profile (no CLIENT_TEST_DATA)
//   ss <name>             screenshot the window to test-results/driver/<name>.png
//   click <name>          click the first button/tab/link whose accessible name matches
//   fill <label> <value>  fill the textbox with that accessible name
//   text [selector]       dump text content (defaults to body, truncated)
//   eval <js>             run JS in the renderer and print the JSON result
//   state                 print the persisted app state via the desktopApi bridge
//   errors                print renderer pageerror messages collected so far
//   quit                  close the app and exit
//
// Every command prints `ok <...>` or `err <message>` on a single line so a
// caller can grep the tmux pane for the result.

import path from 'node:path'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { _electron as electron } from '@playwright/test'

const root = path.resolve(import.meta.dirname, '../../..')
const shots = path.join(root, 'test-results', 'driver')
mkdirSync(shots, { recursive: true })

let app = null
let page = null
const errors = []

async function launch(dataDir) {
  if (app) throw new Error('already launched; run quit first')
  // An empty ELECTRON_RUN_AS_NODE still counts as set on Windows and would start
  // Electron as plain Node with no window, so it is deleted rather than blanked.
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  if (dataDir !== null) env.CLIENT_TEST_DATA = dataDir ?? mkdtempSync(path.join(tmpdir(), 'galaxy-driver-'))
  app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: root, env })
  page = await app.firstWindow()
  page.on('pageerror', error => errors.push(error.message))
  await page.waitForLoadState('domcontentloaded')
  return env.CLIENT_TEST_DATA ?? 'real profile'
}

function requirePage() {
  if (!page) throw new Error('not launched')
  return page
}

// The UI is built from buttons, tabs and links with Chinese accessible names, so
// a single name-based lookup across those roles covers most interactions.
function byName(name) {
  const p = requirePage()
  return p.getByRole('button', { name }).or(p.getByRole('tab', { name })).or(p.getByRole('link', { name })).first()
}

const handlers = {
  launch: async rest => `launched ${await launch(rest || undefined)}`,
  real: async () => `launched ${await launch(null)}`,
  ss: async rest => {
    const file = path.join(shots, `${rest || 'shot'}.png`)
    await requirePage().screenshot({ path: file, fullPage: true })
    return file
  },
  click: async rest => {
    await byName(rest).click({ timeout: 15_000 })
    return `clicked ${rest}`
  },
  fill: async rest => {
    const [label, ...value] = rest.split(' ')
    await requirePage().getByRole('textbox', { name: label }).fill(value.join(' '))
    return `filled ${label}`
  },
  text: async rest => {
    const target = rest ? requirePage().locator(rest) : requirePage().locator('body')
    return (await target.first().innerText()).replace(/\s+/g, ' ').slice(0, 1200)
  },
  eval: async rest => JSON.stringify(await requirePage().evaluate(`(async () => (${rest}))()`)),
  // The callback runs in the renderer, not here, so 'window' is the page's own global.
  // eslint-disable-next-line no-undef -- browser context, serialized into the page by Playwright.
  state: async () => JSON.stringify(await requirePage().evaluate(() => window.desktopApi.command('state:get', null))).slice(0, 1200),
  errors: async () => (errors.length ? errors.join(' | ') : 'none'),
  quit: async () => {
    if (app) await app.close()
    app = null
    page = null
    return 'closed'
  },
}

const rl = createInterface({ input: process.stdin })
console.log('driver ready')
for await (const line of rl) {
  const trimmed = line.trim()
  if (!trimmed) continue
  const [name, ...rest] = trimmed.split(' ')
  const handler = handlers[name]
  if (!handler) {
    console.log(`err unknown command ${name}`)
    continue
  }
  try {
    console.log(`ok ${await handler(rest.join(' '))}`)
  } catch (error) {
    console.log(`err ${String(error.message ?? error).replace(/\s+/g, ' ').slice(0, 500)}`)
  }
  if (name === 'quit') break
}
process.exit(0)
