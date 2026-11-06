import { afterEach, expect, test } from 'vitest'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Store } from '../electron/services/store'
import { Queue } from '../electron/services/queue'
import { Engine } from '../electron/services/engine'
import type { MediaItem } from '../shared/contracts'
import type { ParsePlan } from '../electron/services/parser'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map(fn => fn())) })
async function server(handler: Parameters<typeof createServer>[0]): Promise<string> {
  const instance = createServer(handler)
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => new Promise<void>(resolve => { instance.closeAllConnections(); instance.close(() => resolve()) }))
  return `http://127.0.0.1:${(instance.address() as { port: number }).port}`
}
async function directory() { const dir = await mkdtemp(path.join(tmpdir(), 'client-covers-')); cleanup.push(() => rm(dir, { recursive: true, force: true })); return dir }

const videoItem: MediaItem = { id: '1', title: '一个视频', kind: 'video', formats: [] }
const plan = (url: string, item = videoItem): ParsePlan => ({
  result: { id: 'fixture', url, title: '作品', platform: 'local', method: 'direct', items: [item] },
  sources: new Map([['1', { kind: 'http', url, cookies: [], headers: {}, extension: 'mp4' }]]),
  catalog: new Map([[item.id, item]]),
})

test('a cover is saved beside the task it belongs to, whatever state that task is in', async () => {
  // Only the header is read: a WebP signature is enough to count as a real picture.
  const picture = Buffer.from('RIFF\0\0\0\0WEBPVP8 picture-bytes', 'latin1')
  const url = await server((_req, res) => res.end(picture))
  const dir = await directory()
  const store = new Store(dir, dir)
  store.data.settings.concurrency = 1
  const queue = new Queue(store, new Engine('', '', false), fetch, async job => plan(job.url), () => {})
  cleanup.push(async () => queue.stop())
  queue.enqueue(plan('https://example.test/post', { ...videoItem, thumbnail: `${url}/cover.webp` }), [{ ...videoItem, thumbnail: `${url}/cover.webp` }], 'best', false)
  const job = queue.jobs[0]
  // Never finished, and that is deliberately not a condition: the picture is not the media.
  expect(job.status).not.toBe('completed')
  await queue.thumbnail(job.id)
  const saved = job.files.find(file => file.includes('-cover.'))!
  expect(path.dirname(saved)).toBe(path.resolve(job.directory))
  // The platform's own format is kept, and the job's stem is what makes it this task's file.
  expect(saved.endsWith('-cover.webp')).toBe(true)
  expect(await readFile(saved)).toEqual(picture)
  // Twice does not record it twice.
  await queue.thumbnail(job.id)
  expect(job.files.filter(file => file.includes('-cover.'))).toHaveLength(1)
  // A task with no cover address says so instead of writing an empty file.
  queue.enqueue(plan('https://example.test/other'), [videoItem], 'best', false)
  await expect(queue.thumbnail(queue.jobs[0].id)).rejects.toThrow('没有记录封面地址')
})

test('one enqueue makes one batch, and the batch can be acted on without taking the tasks over', async () => {
  const dir = await directory()
  const store = new Store(dir, dir)
  store.data.settings.concurrency = 1
  const queue = new Queue(store, new Engine('', '', false), fetch, async job => plan(job.url), () => {})
  cleanup.push(async () => queue.stop())
  const three = ['a', 'b', 'c'].map(id => ({ ...videoItem, id }))
  const many: ParsePlan = {
    result: { id: 'fixture', url: 'https://example.test/home', title: '某位作者的投稿', platform: 'local', method: 'browser', listing: 'profile', groups: [{ id: 'posts', title: '投稿', itemIds: ['a', 'b', 'c'] }], items: three },
    sources: new Map(three.map(item => [item.id, { kind: 'engine', request: { operation: 'download', url: `https://example.test/post-${item.id}` } }])),
    catalog: new Map(three.map(item => [item.id, item])),
  }
  expect(queue.enqueue(many, three, 'best', false)).toBe(3)
  const batchId = queue.jobs[0].batchId!
  expect(batchId).toBeTruthy()
  expect(queue.jobs.every(job => job.batchId === batchId)).toBe(true)
  expect(queue.jobs[0].batchTitle).toBe('某位作者的投稿')
  // A single download is not a batch: there is nothing to group it with.
  queue.enqueue(plan('https://example.test/one'), [videoItem], 'best', false)
  expect(queue.jobs[0].batchId).toBeUndefined()
  // The batch moves as a whole and leaves the task outside it alone.
  await queue.batch('pause', batchId)
  expect(queue.jobs.filter(job => job.batchId === batchId).every(job => job.status === 'paused')).toBe(true)
  expect(queue.jobs.find(job => !job.batchId)!.status).not.toBe('paused')
  await queue.batch('cancel', batchId)
  expect(queue.jobs.filter(job => job.batchId === batchId).every(job => job.status === 'cancelled')).toBe(true)
  await queue.batch('retry', batchId)
  // Including the one that was running when the batch was cancelled: its abort may still be unwinding,
  // and skipping it would leave one task of the batch behind with no sign that it had been.
  expect(queue.jobs.filter(job => job.batchId === batchId).every(job => job.status !== 'cancelled')).toBe(true)
  // Deleting a batch takes its records and nothing else's.
  await queue.batch('remove', batchId)
  expect(queue.jobs.map(job => job.batchId)).toEqual([undefined])
  await expect(queue.batch('pause', batchId)).rejects.toThrow('已经不存在')
})
