import type { Settings } from '../../shared/contracts'

// What the client says about itself, in one place. A request that claims to be Chrome and then behaves
// like something else is easier to pick out than one that never claimed anything, so every piece of the
// claim - the user agent, the language, the client hints - has to agree with the others.

// Electron's default agent names the application and Electron itself, either of which identifies this
// client exactly. What is left is an ordinary Chrome on this platform.
export function chromeUserAgent(agent: string): string {
  return agent
    .replace(/ Electron\/[\d.]+/, '')
    // Whatever sits between the engine and the Chrome version is the application's own name and version.
    .replace(/(\(KHTML, like Gecko\) ).*?(?=Chrome\/)/, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

const LANGUAGES: Record<Settings['locale'], string> = {
  zh: 'zh-CN,zh;q=0.9', en: 'en-US,en;q=0.9',
}
export const acceptLanguageFor = (locale: Settings['locale']): string => LANGUAGES[locale] || LANGUAGES.zh

// Chrome announces its brand and platform on every request. Saying nothing while calling oneself Chrome
// is a contradiction; the version therefore comes from the Chromium actually running, never a constant.
export function clientHints(chrome: string, platform: NodeJS.Platform): Record<string, string> {
  const major = chrome.split('.')[0] || '0'
  const name = platform === 'darwin' ? 'macOS' : platform === 'win32' ? 'Windows' : 'Linux'
  return {
    'sec-ch-ua': `"Chromium";v="${major}", "Not=A?Brand";v="24", "Google Chrome";v="${major}"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': `"${name}"`,
  }
}

const siteOf = (host: string) => host.split('.').slice(-2).join('.')

// What a request would say about where it came from. Only answered for a request that names a referrer:
// a guess here would contradict the one thing the request does state.
export function fetchMetadata(address: string, referrer: string | undefined): Record<string, string> {
  if (!referrer) return {}
  try {
    const target = new URL(address); const from = new URL(referrer)
    const site = target.origin === from.origin ? 'same-origin' : siteOf(target.hostname) === siteOf(from.hostname) ? 'same-site' : 'cross-site'
    return { 'sec-fetch-site': site, 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' }
  } catch { return {} }
}

// A login is rarely kept on the domain being parsed alone: YouTube's account cookies live on google.com,
// and both 抖音 and 哔哩哔哩 mint theirs on a separate sign-in host. Cookies are collected from all of
// them, or the request goes out as a visitor while the user is in fact signed in.
const RELATED: { host: RegExp; also: string[] }[] = [
  { host: /(^|\.)youtube\.com$/, also: ['https://www.google.com/', 'https://accounts.google.com/'] },
  { host: /(^|\.)bilibili\.com$/, also: ['https://www.bilibili.com/', 'https://passport.bilibili.com/'] },
  { host: /(^|\.)douyin\.com$/, also: ['https://www.douyin.com/', 'https://sso.douyin.com/'] },
  { host: /(^|\.)xiaohongshu\.com$/, also: ['https://www.xiaohongshu.com/'] },
]

export function relatedTo(url: string): string[] {
  let target: URL
  try { target = new URL(url) } catch { return [] }
  const also = RELATED.find(entry => entry.host.test(target.hostname))?.also || []
  // The parsed origin itself is always worth asking about: a cookie set for the bare domain does not
  // come back from a query for a deep link on a different subdomain.
  return [...new Set([target.origin + '/', ...also])]
}
