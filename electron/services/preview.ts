import type { ParsePlan } from './parser'

// The page an item is watched on before it is downloaded: its own where a listing gave it one, the
// address its download resolves where the engine had one, and otherwise the address that was parsed -
// which for a direct file is the file itself. A 哔哩哔哩 分P shares its parent's page and is told apart
// by its index, which the page takes as '?p='.
export function previewPage(plan: ParsePlan, itemId: string): { url: string; title: string } {
  const item = plan.catalog.get(itemId)
  if (!item) throw new Error('解析结果已过期，请重新解析')
  const source = plan.sources.get(itemId)
  const engine = source?.kind === 'engine' ? source.request : undefined
  const page = new URL(item.url || engine?.url || plan.result.url)
  if (!item.url && engine?.entry && /(^|\.)bilibili\.com$/.test(page.hostname)) page.searchParams.set('p', String(engine.entry))
  return { url: page.href, title: item.title }
}
