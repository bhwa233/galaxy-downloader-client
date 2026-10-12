import { afterEach, expect, test } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { cookieHeader, downloadHttp, fetchWithCookies } from '../electron/services/http-download'
import type { Cookie } from '../electron/services/engine'
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map(fn => fn())) })
async function server(handler: Parameters<typeof createServer>[0]): Promise<string> {
  const instance = createServer(handler)
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { instance.closeAllConnections(); instance.close(() => resolve()) }))
  return `http://127.0.0.1:${(instance.address() as { port: number }).port}`
}
async function directory() { const dir = await mkdtemp(path.join(tmpdir(), 'client-http-')); cleanup.push(() => rm(dir, { recursive: true, force: true })); return dir }
const cookie: Cookie = { name: 'session', value: 'private', domain: '.example.test', path: '/media', secure: true, expires: -1 }
test('cookies obey host, path, expiry and TLS boundaries', () => {
  expect(cookieHeader([cookie], 'https://cdn.example.test/media/video')).toBe('session=private')
  for (const url of ['http://example.test/media/a', 'https://example.test/media-other', 'https://example.test.evil.test/media', 'https://other.test/media']) expect(cookieHeader([cookie], url)).toBe('')
  expect(cookieHeader([{ ...cookie, domain: 'example.test' }], 'https://cdn.example.test/media')).toBe('')
  expect(cookieHeader([{ ...cookie, expires: 1 }], 'https://example.test/media')).toBe('')
})
test('cross-domain redirects do not carry browser cookies to another origin', async () => {
  const sent: { url: string; cookie: string | null }[] = []
  await fetchWithCookies(async (url, init) => { sent.push({ url, cookie: new Headers(init?.headers).get('cookie') }); return sent.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://attacker.test/file' } }) : new Response('file') }, 'https://example.test/media', [cookie])
  expect(sent.map(item => item.cookie)).toEqual(['session=private', null])
})
test.each([true, false])('range resume saves an intact file when server honors range=%s', async honors => {
  const bytes = Buffer.from('complete media content')
  const requests: string[] = []
  const url = `${await server((req, res) => { requests.push(req.headers.range || ''); const offset = honors ? 8 : 0; res.writeHead(honors ? 206 : 200, { 'content-length': bytes.length - offset, etag: '"fixture"', ...(honors ? { 'content-range': `bytes ${offset}-${bytes.length - 1}/${bytes.length}` } : {}) }); res.end(bytes.subarray(offset)) })}/video`
  const target = path.join(await directory(), 'video.mp4')
  await writeFile(`${target}.part`, bytes.subarray(0, 8))
  await writeFile(`${target}.part.json`, JSON.stringify({ source: createHash('sha256').update(url).digest('hex'), etag: '"fixture"' }))
  await downloadHttp(fetch, url, target, [], {}, new AbortController().signal, () => {})
  expect(requests).toEqual(['bytes=8-'])
  expect(await readFile(target)).toEqual(bytes)
})

// Batch pause used to call pump for each task, starting pending tasks while pausing.
import { Queue } from '../electron/services/queue'
import { Store } from '../electron/services/store'
import { Engine } from '../electron/services/engine'
import type { ParsePlan } from '../electron/services/parser'
import type { MediaItem } from '../shared/contracts'
const imageItem: MediaItem = { id: '1', title: '图片', kind: 'image', formats: [] }
function httpPlan(url: string): ParsePlan {
  return { result: { id: 'fixture', url, title: '作品', platform: 'local', method: 'direct', items: [imageItem] }, sources: new Map([['1', { kind: 'http', url, cookies: [], headers: {}, extension: 'jpg' }]]) }
}
test('batch pause stops all pending work and resume completes intact files', async () => {
  const requests: string[] = []
  const url = await server((req, res) => {
    requests.push(req.url!)
    res.writeHead(200, { 'content-length': 4, etag: '"fixture"' }); res.write('ab')
    const timer = setTimeout(() => res.end('cd'), 150)
    res.on('close', () => clearTimeout(timer))
  })
  const dir = await directory()
  const store = new Store(dir, dir); store.data.settings.concurrency = 1
  const queue = new Queue(store, new Engine('', '', false), fetch, async job => httpPlan(job.url), () => {})
  cleanup.push(async () => queue.stop())
  queue.enqueue(httpPlan(`${url}/first`), [imageItem], 'best', false)
  queue.enqueue(httpPlan(`${url}/second`), [imageItem], 'best', false)
  await expect.poll(() => requests.length).toBe(1)
  queue.batch('pause')
  expect(queue.jobs.every(job => job.status === 'paused')).toBe(true)
  await new Promise(resolve => setTimeout(resolve, 50))
  expect(requests).toEqual(['/first'])
  queue.batch('resume')
  await expect.poll(() => queue.jobs.every(job => job.status === 'completed')).toBe(true)
  for (const job of queue.jobs) expect(await readFile(job.files[0], 'utf8')).toBe('abcd')
})
test('a post that turns out to hold several media files becomes one task per file', async () => {
  const url = await server((req, res) => res.end(req.url))
  const dir = await directory()
  const store = new Store(dir, dir)
  const home = httpPlan(`${url}/home`)
  home.result.listing = 'profile'
  home.sources.set('1', { kind: 'engine', request: { operation: 'download', url: `${url}/post-42` } })
  const queue = new Queue(store, new Engine('', '', false), fetch, async job => {
    // The job keeps the post's own address, which is the only thing the listing gave it.
    expect(job.url).toBe(`${url}/post-42`)
    const post = httpPlan(`${url}/image-a`)
    post.result.items.push({ ...imageItem, id: 'different-id', title: '第二张' })
    post.sources.set('different-id', { kind: 'http', url: `${url}/image-b`, cookies: [], headers: {}, extension: 'jpg' })
    return post
  }, () => {})
  cleanup.push(async () => queue.stop())
  queue.enqueue(home, [imageItem], 'best', false)
  // One row was ticked; two files came back, so there are two tasks - 2.4's "每个媒体文件一个任务".
  await expect.poll(() => queue.jobs.length).toBe(2)
  await expect.poll(() => queue.jobs.every(job => job.status === 'completed')).toBe(true)
  const saved = await Promise.all(queue.jobs.map(async job => (await readFile(job.files[0], 'utf8'))))
  expect(saved.sort()).toEqual(['/image-a', '/image-b'])
  // Each task holds exactly its own file, and each is a row that can be paused or deleted on its own.
  expect(queue.jobs.every(job => job.files.length === 1)).toBe(true)
  expect(queue.jobs.map(job => job.title).sort()).toEqual(['图片', '第二张'])
  // They are one batch, so the whole post can still be acted on at once.
  expect(new Set(queue.jobs.map(job => job.batchId)).size).toBe(1)
  expect(queue.jobs[0].batchId).toBeTruthy()
})
test('restart only restores interrupted work when enabled, preserving explicitly paused jobs', async () => {
  const dir = await directory()
  const store = new Store(dir, dir)
  store.data.settings.resumeOnStart = true
  store.data.jobs = ['running', 'queued', 'paused', 'failed'].map((status, index) => ({
    id: String(index), itemId: '1', url: 'https://example.test/post', title: '作品', platform: 'test', method: 'direct',
    format: 'best', audioOnly: false, status: status as import('../shared/contracts').JobStatus,
    progress: 0.5, files: [], directory: dir, createdAt: new Date().toISOString(), logs: [],
  }))
  store.data.jobs[0].url = 'https://www.douyin.com/user/example'
  store.data.jobs[0].sourceUrl = 'https://www.douyin.com/video/123456'
  store.save()
  expect(new Store(dir, dir).data.jobs[0]).toMatchObject({ url: 'https://www.douyin.com/video/123456', itemId: '*' })
  expect(new Store(dir, dir).data.jobs.map(job => job.status)).toEqual(['queued', 'queued', 'paused', 'failed'])
  store.data.settings.resumeOnStart = false; store.save()
  expect(new Store(dir, dir).data.jobs.map(job => job.status)).toEqual(['paused', 'paused', 'paused', 'failed'])
})
test('HTTP rate limiting applies backpressure and still saves the exact payload', async () => {
  const bytes = Buffer.alloc(1024, 'x')
  const url = await server((_req, res) => { res.setHeader('content-length', bytes.length); res.end(bytes) })
  const target = path.join(await directory(), 'limited.bin')
  const started = Date.now()
  await downloadHttp(fetch, url, target, [], {}, new AbortController().signal, () => {}, { speedLimit: 2048 })
  expect(Date.now() - started).toBeGreaterThanOrEqual(450)
  expect(await readFile(target)).toEqual(bytes)
})
