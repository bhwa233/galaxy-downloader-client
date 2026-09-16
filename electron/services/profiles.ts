import { createHash } from 'node:crypto'
import { access, readdir, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { BrowserProfile } from '../../shared/contracts'

export type LocalProfile = BrowserProfile & { path: string; root: string }
export function browserRoots(platform = process.platform, home = os.homedir(), env = process.env): Record<BrowserProfile['browser'], string[]> {
  if (platform === 'win32') return {
    chrome: [path.join(env.LOCALAPPDATA || path.join(home, 'AppData/Local'), 'Google/Chrome/User Data')],
    edge: [path.join(env.LOCALAPPDATA || path.join(home, 'AppData/Local'), 'Microsoft/Edge/User Data')],
    firefox: [path.join(env.APPDATA || path.join(home, 'AppData/Roaming'), 'Mozilla/Firefox/Profiles')],
  }
  if (platform === 'darwin') return {
    chrome: [path.join(home, 'Library/Application Support/Google/Chrome')], edge: [path.join(home, 'Library/Application Support/Microsoft Edge')], firefox: [path.join(home, 'Library/Application Support/Firefox/Profiles')],
  }
  const config = env.XDG_CONFIG_HOME || path.join(home, '.config')
  return { chrome: [path.join(config, 'google-chrome'), path.join(home, '.var/app/com.google.Chrome/config/google-chrome')], edge: [path.join(config, 'microsoft-edge')], firefox: [path.join(home, '.mozilla/firefox'), path.join(home, 'snap/firefox/common/.mozilla/firefox'), path.join(home, '.var/app/org.mozilla.firefox/.mozilla/firefox')] }
}
async function exists(file: string): Promise<boolean> { try { await access(file); return true } catch { return false } }

export async function discoverProfiles(roots = browserRoots()): Promise<LocalProfile[]> {
  const groups = await Promise.all(Object.entries(roots).flatMap(([name, folders]) => folders.map(async root => {
    const browser = name as BrowserProfile['browser']
    try {
      const directories = await readdir(root, { withFileTypes: true })
      let labels: Record<string, { name?: string }> = {}
      if (browser !== 'firefox') {
        try { labels = JSON.parse(await readFile(path.join(root, 'Local State'), 'utf8')).profile?.info_cache || {} } catch { /* A profile may not have a Local State yet. */ }
      }
      const profiles = await Promise.all(directories.filter(entry => entry.isDirectory() && (browser === 'firefox' || entry.name === 'Default' || /^Profile \d+$/.test(entry.name))).map(async entry => {
        const directory = path.join(root, entry.name)
        const available = browser === 'firefox' ? await exists(path.join(directory, 'cookies.sqlite')) : await exists(path.join(directory, 'Network/Cookies')) || await exists(path.join(directory, 'Cookies'))
        return { id: createHash('sha256').update(directory).digest('hex'), browser, label: `${browser === 'chrome' ? 'Chrome' : browser === 'edge' ? 'Edge' : 'Firefox'} / ${labels[entry.name]?.name || entry.name}`, available, path: directory, root }
      }))
      return profiles.filter(profile => browser !== 'firefox' || profile.available)
    } catch { return [] }
  })))
  return groups.flat()
}

export function publicProfiles(profiles: LocalProfile[]): BrowserProfile[] {
  return profiles.map(({ id, browser, label, available }) => ({ id, browser, label, available }))
}
