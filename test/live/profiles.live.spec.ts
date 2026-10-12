import path from 'node:path'
import { expect, test, _electron as electron } from '@playwright/test'
import { PROFILE_FIXTURES } from '../fixtures/profiles'

// Opt-in probe against the real upstreams. Run with `pnpm test:live:profiles`.
// It drives the packaged client itself, because the listing route now runs inside the client's own
// browser session: the 'browser' fixtures need that session already signed in, which you do once
// through 设置 → 浏览器 → 打开登录窗口. The 'engine' fixtures need the dev engine (`pnpm engine:dev`).
// The probe deliberately uses the real user data directory so it sees that login; it only parses,
// and never enqueues a download.
const root = path.resolve(import.meta.dirname, '../..')

test('creator profiles list posts with loadable covers', async () => {
  test.setTimeout(PROFILE_FIXTURES.length * 180_000)
  // Windows treats an empty value as set, which would start Electron as plain Node and never open a window.
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({ args: ['.', '--no-sandbox'], cwd: root, env })
  const page = await app.firstWindow()
  const failures: string[] = []
  try {
    for (const fixture of PROFILE_FIXTURES) {
      const reply = await page.evaluate(url => window.desktopApi.command('media:parse', { url }), fixture.url)
      if (!reply.ok) { failures.push(`${fixture.platform}: ${reply.message}`); continue }
      const result = reply.state.parse.result
      if (!result) { failures.push(`${fixture.platform}: ${reply.state.parse.message || '没有解析结果'}`); continue }
      const covered = result.items.filter(item => item.thumbnail && /^https?:/.test(item.thumbnail))
      console.log(`${fixture.platform}: ${result.items.length} items, ${covered.length} with a cover, method=${result.method}`)
      console.log(result.items.slice(0, 3).map(item => `  ${item.kind} ${item.title.slice(0, 40)} ${item.thumbnail?.slice(0, 60) || '(no cover)'}`).join('\n'))
      if (!result.items.length) { failures.push(`${fixture.platform}: 列表为空`); continue }
      // Every task card shows a cover, so a listing without any thumbnail is a regression even when the URLs still work.
      if (!covered.length) { failures.push(`${fixture.platform}: 没有任何封面`); continue }
      // A cover the renderer cannot load is the same failure as a missing one; the renderer sends no referrer.
      const response = await fetch(covered[0].thumbnail!, { headers: { 'User-Agent': 'Mozilla/5.0' } })
      if (response.status !== 200) failures.push(`${fixture.platform}: 封面返回 ${response.status}`)
      // A profile that reports a second page has to deliver posts the first page did not hold.
      if (!result.groups?.[0]?.pagination?.hasMore) continue
      const turned = await page.evaluate(input => window.desktopApi.command('media:page', input), { resultId: result.id, page: 2 })
      if (!turned.ok) {
        // A fixture marked as needing a sign-in is allowed to be refused a second page when this
        // client has not signed in: 抖音 reports that more posts exist and then serves them only to a
        // visitor it knows. Reported rather than swallowed, so a real regression still shows up here.
        const refused = fixture.needsSignIn && /登录/.test(turned.message || '')
        if (refused) console.log(`${fixture.platform}: page 2 refused while signed out — ${turned.message}`)
        else failures.push(`${fixture.platform}: 第 2 页 ${turned.message}`)
        continue
      }
      const second = turned.state.parse.result
      const fresh = second?.items.filter(item => !result.items.some(first => first.id === item.id)) || []
      console.log(`${fixture.platform}: page 2 has ${second?.items.length ?? 0} items, ${fresh.length} of them new`)
      if (fresh.length !== second?.items.length) failures.push(`${fixture.platform}: 第 2 页与第 1 页重复`)
    }
  } finally { await app.close() }
  expect(failures, failures.join('\n')).toEqual([])
})
