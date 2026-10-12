import net from 'node:net'
import { spawn } from 'node:child_process'
import { Command, Option } from 'commander'
import { controlAddress, type ControlReply } from '../../shared/control'
import type { ClientState, Job, MediaResult } from '../../shared/contracts'

// `galaxy`: the command line for Galaxy Downloader. It does no parsing or downloading of its own - it
// drives the client that is running (starting it in the background when it is not) through the local
// control channel, so a command gets the same sign-ins, listing adapters and queue as the window.
// Every command takes --json, which prints one JSON object to stdout and nothing else; that is the
// form an agent reads. Progress goes to stderr.
//
// Exit codes: 0 done; 1 failed; 2 needs a sign-in or a verification (run `galaxy login`); 3 refused by
// the platform for a reason no sign-in lifts here (membership, purchase, encryption); 4 the client
// could not be reached.
const EXIT = { failed: 1, login: 2, wall: 3, unreachable: 4 } as const
// Set by the launcher a development build installs, so it talks to that build rather than an installed one.
const development = process.env.GALAXY_DEV === '1'
const address = controlAddress(development)

class Failure extends Error {
  constructor(message: string, readonly code: number, readonly detail: Record<string, unknown> = {}) { super(message) }
}

let nextId = 1
function request(socket: net.Socket, command: string, input: unknown): Promise<ControlReply> {
  const id = nextId++
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = (chunk: string) => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      socket.off('data', onData); socket.off('error', reject)
      try { resolve(JSON.parse(buffer.slice(0, newline)) as ControlReply) } catch (error) { reject(error) }
    }
    socket.on('data', onData); socket.once('error', reject)
    socket.write(`${JSON.stringify({ id, command, input })}\n`)
  })
}

function connect(): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(address)
    socket.setEncoding('utf8')
    socket.once('connect', () => { socket.off('error', reject); resolve(socket) })
    socket.once('error', reject)
  })
}

// Connects to the running client, starting it hidden first when it is not running and the command
// line knows where it is installed (the `galaxy` launcher passes GALAXY_APP).
async function client(): Promise<net.Socket> {
  try { return await connect() } catch { /* Not running yet. */ }
  const app = process.env.GALAXY_APP
  if (!app) throw new Failure(`Galaxy Downloader is not running, and GALAXY_APP does not say where it is installed (${address}).`, EXIT.unreachable)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  spawn(app, ['--background'], { detached: true, stdio: 'ignore', env }).unref()
  process.stderr.write('Starting Galaxy Downloader in the background…\n')
  for (let waited = 0; waited < 60_000; waited += 500) {
    await new Promise(resolve => setTimeout(resolve, 500))
    try { return await connect() } catch { /* Still starting. */ }
  }
  throw new Failure('Galaxy Downloader did not start within 60 seconds.', EXIT.unreachable)
}

// A refusal carries what kind it is: a sign-in or a verification the user can do, or a wall they cannot.
async function call<T extends Record<string, unknown>>(command: string, input: unknown): Promise<T> {
  const socket = await client()
  try {
    const reply = await request(socket, command, input)
    if (reply.ok) return reply as unknown as T
    const { message, wall, verify, loginUrl } = reply as { message?: string; wall?: string; verify?: boolean; loginUrl?: string }
    const code = verify || wall === 'login' ? EXIT.login : wall ? EXIT.wall : EXIT.failed
    throw new Failure(message || 'The client refused the command.', code, { wall, verify, loginUrl })
  } finally { socket.destroy() }
}

let json = false
function output(value: Record<string, unknown>, human: () => void): void {
  if (json) process.stdout.write(`${JSON.stringify({ ok: true, ...value })}\n`)
  else human()
}
const table = (rows: string[][]) => {
  const widths = rows[0]?.map((_, column) => Math.max(...rows.map(row => [...row[column]].length))) || []
  for (const row of rows) console.log(row.map((cell, column) => cell + ' '.repeat(widths[column] - [...cell].length)).join('  ').trimEnd())
}
const size = (bytes?: number) => bytes ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : ''
const clock = (seconds?: number) => seconds === undefined ? '' : `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`

// What an item of a result looks like on the command line: its position (what --items takes), its id
// and what the client knows about it, with the qualities --format accepts.
const describe = (result: MediaResult) => ({
  id: result.id, title: result.title, platform: result.platform, listing: result.listing, url: result.url,
  pagination: result.groups?.[0]?.pagination,
  items: result.items.map((item, index) => ({
    index: index + 1, id: item.id, title: item.title, kind: item.kind, duration: item.duration, url: item.url, locked: item.wall,
    formats: (item.formats.length ? item.formats : result.formats || []).map(format => ({ id: format.id, label: format.label, height: format.height, size: format.size })),
  })),
})
const jobView = (job: Job) => ({
  id: job.id, title: job.title, platform: job.platform, status: job.status, progress: Math.round(job.progress * 1000) / 10,
  kind: job.kind, files: job.files, error: job.error, speed: job.speed, eta: job.eta, createdAt: job.createdAt, completedAt: job.completedAt,
})

// '1,3-5' → [1, 3, 4, 5]
function positions(spec: string, count: number): number[] {
  const picked = new Set<number>()
  for (const part of spec.split(',').map(value => value.trim()).filter(Boolean)) {
    const [from, to] = part.split('-').map(Number)
    if (!Number.isInteger(from) || (to !== undefined && !Number.isInteger(to))) throw new Failure(`Not an item number or range: ${part}`, EXIT.failed)
    for (let at = from; at <= (to ?? from); at++) {
      if (at < 1 || at > count) throw new Failure(`Item ${at} does not exist; the result has ${count}.`, EXIT.failed)
      picked.add(at)
    }
  }
  return [...picked].sort((a, b) => a - b)
}

async function jobs(): Promise<Job[]> { return (await call<{ state: ClientState }>('state:get', null)).state.jobs }
async function findJob(id: string): Promise<Job> {
  const found = (await jobs()).filter(job => job.id.startsWith(id))
  if (found.length !== 1) throw new Failure(found.length ? `More than one task starts with ${id}.` : `No task ${id}.`, EXIT.failed)
  return found[0]
}
const finished = (job: Job) => ['completed', 'failed', 'cancelled'].includes(job.status)

async function wait(ids: string[], timeout: number): Promise<Job[]> {
  const started = Date.now()
  for (;;) {
    const current = (await jobs()).filter(job => ids.includes(job.id))
    if (!json) process.stderr.write(`\r${current.map(job => `${job.title.slice(0, 24)} ${Math.round(job.progress * 100)}%`).join('  ')}   `)
    if (current.length === ids.length && current.every(finished)) { if (!json) process.stderr.write('\n'); return current }
    if (timeout && Date.now() - started > timeout * 1000) throw new Failure(`Still running after ${timeout} seconds.`, EXIT.failed, { jobs: current.map(jobView) })
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

const program = new Command('galaxy')
  .description('Parse and download media with Galaxy Downloader, using the sign-ins kept in the client.')
  .option('--json', 'print one JSON object to stdout (for scripts and agents)')
  .hook('preAction', command => { json = Boolean(command.opts().json) })
  .showHelpAfterError()

program.command('status').description('whether the client is running, its version, engine and download folder').action(async () => {
  const reply = await call<{ state: ClientState; version: string }>('cli:hello', null)
  const { tools, settings } = reply.state
  output({ version: reply.version, engine: tools.engine, ffmpeg: tools.ffmpeg, downloadDirectory: settings.downloadDirectory, locale: settings.locale }, () => {
    console.log(`Galaxy Downloader ${reply.version}`)
    console.log(`engine   ${tools.engine.available ? tools.engine.version : `unavailable ${tools.engine.error || ''}`}`)
    console.log(`ffmpeg   ${tools.ffmpeg.available ? tools.ffmpeg.version : `unavailable ${tools.ffmpeg.error || ''}`}`)
    console.log(`folder   ${settings.downloadDirectory}`)
  })
})

program.command('parse').argument('<url>', 'a post, video, profile or collection link (a share message with a link in it works too)')
  .description('list what a link holds: its items and the qualities they come in')
  .option('--page <n>', 'the page of a listing to read', '1')
  .action(async (url: string, options: { page: string }) => {
    const { result } = await call<{ result: MediaResult }>('cli:parse', { url, page: Number(options.page) })
    const view = describe(result)
    output({ result: view }, () => {
      console.log(`${view.title} · ${view.platform} · ${view.items.length} item(s)${view.pagination?.hasMore ? `, more with --page ${view.pagination.index + 1}` : ''}`)
      table([['#', 'kind', 'length', 'title'], ...view.items.map(item => [String(item.index), item.locked ? `${item.kind}*` : item.kind, clock(item.duration), item.title.slice(0, 60)])])
      // One item's own qualities, or a listing's, which its first video stands for and every item shares.
      const formats = view.items.length === 1 || view.listing ? view.items.find(item => item.formats.length)?.formats || [] : []
      if (formats.length) { console.log(`\nformats (--format)${view.listing ? ', read off the first video' : ''}:`); table(formats.map(format => [format.id, format.label, size(format.size)])) }
    })
  })

program.command('download').argument('<url>', 'the link to download from')
  .description('parse a link and queue its items; with --wait, stay until they finish')
  .option('--items <list>', "which items, by number from `galaxy parse`: '1,3-5'")
  .option('--all', 'every item on the page')
  .option('--page <n>', 'the page of a listing to read', '1')
  .option('--format <id>', 'a quality id from `galaxy parse`; the default follows the settings', 'best')
  .addOption(new Option('--kind <kinds>', 'what to save of each item: video, audio, cover, comma separated').default('video'))
  .option('--wait', 'wait for the downloads to finish and print the files')
  .option('--timeout <seconds>', 'give up waiting after this long (0: never)', '0')
  .action(async (url: string, options: { items?: string; all?: boolean; page: string; format: string; kind: string; wait?: boolean; timeout: string }) => {
    const { result } = await call<{ result: MediaResult }>('cli:parse', { url, page: Number(options.page) })
    const count = result.items.length
    let picked: number[]
    if (options.items) picked = positions(options.items, count)
    else if (options.all || count === 1) picked = result.items.map((_, index) => index + 1)
    else throw new Failure(`The link holds ${count} items; choose with --items or take them all with --all.`, EXIT.failed, { result: describe(result) })
    const kinds = options.kind.split(',').map(kind => kind.trim()).filter(Boolean)
    const reply = await call<{ added: number; jobIds: string[] }>('media:download', { resultId: result.id, itemIds: picked.map(index => result.items[index - 1].id), format: options.format, kinds })
    if (!options.wait) {
      output({ added: reply.added, jobIds: reply.jobIds }, () => console.log(reply.added ? `Queued ${reply.added} task(s): ${reply.jobIds.map(id => id.slice(0, 8)).join(' ')}` : 'Already in the queue; nothing added.'))
      return
    }
    const done = await wait(reply.jobIds, Number(options.timeout))
    const failed = done.filter(job => job.status !== 'completed')
    output({ added: reply.added, jobs: done.map(jobView) }, () => { for (const job of done) console.log(job.status === 'completed' ? job.files.join('\n') : `${job.status}: ${job.title} ${job.error || ''}`) })
    if (failed.length) process.exitCode = EXIT.failed
  })

program.command('jobs').description('the task list')
  .addOption(new Option('--status <status>', 'only tasks in this state').choices(['queued', 'running', 'paused', 'completed', 'cancelled', 'failed']))
  .action(async (options: { status?: string }) => {
    const list = (await jobs()).filter(job => !options.status || job.status === options.status)
    output({ jobs: list.map(jobView) }, () => table([['id', 'status', 'progress', 'title'], ...list.map(job => [job.id.slice(0, 8), job.status, `${Math.round(job.progress * 100)}%`, job.title.slice(0, 60)])]))
  })

program.command('job').argument('<id>', 'a task id, or the start of one').description('one task in full').action(async (id: string) => {
  const job = await findJob(id)
  output({ job: jobView(job) }, () => { for (const [key, value] of Object.entries(jobView(job))) if (value !== undefined) console.log(`${key.padEnd(12)}${Array.isArray(value) ? value.join('\n            ') : value}`) })
})

program.command('wait').argument('<ids...>', 'task ids, or the start of them').description('wait until the tasks finish')
  .option('--timeout <seconds>', 'give up after this long (0: never)', '0')
  .action(async (ids: string[], options: { timeout: string }) => {
    const full = await Promise.all(ids.map(async id => (await findJob(id)).id))
    const done = await wait(full, Number(options.timeout))
    output({ jobs: done.map(jobView) }, () => { for (const job of done) console.log(`${job.status}  ${job.title}${job.files.length ? `\n  ${job.files.join('\n  ')}` : ''}`) })
    if (done.some(job => job.status !== 'completed')) process.exitCode = EXIT.failed
  })

for (const action of ['pause', 'resume', 'retry', 'cancel'] as const) {
  program.command(action).argument('<id>', 'a task id, or the start of one').description(`${action} a task`).action(async (id: string) => {
    const job = await findJob(id)
    await call('jobs:action', { id: job.id, action })
    output({ id: job.id, action }, () => console.log(`${action}: ${job.title}`))
  })
}

program.command('login').argument('[url]', 'the page to open; a failed parse names it').description('open the sign-in window, for the user to sign in or pass a verification')
  .action(async (url?: string) => {
    await call('browser:login', { url: url || '' })
    output({ opened: url || '' }, () => console.log('The sign-in window is open. Sign in or pass the check there, close it, then run the command again.'))
  })

program.parseAsync(process.argv).catch((error: unknown) => {
  const failure = error instanceof Failure ? error : new Failure(error instanceof Error ? error.message : String(error), EXIT.failed)
  if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: failure.message, exitCode: failure.code, ...failure.detail })}\n`)
  else process.stderr.write(`galaxy: ${failure.message}\n`)
  process.exitCode = failure.code
})
