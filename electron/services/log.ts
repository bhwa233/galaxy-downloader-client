import { app } from 'electron'
import log from 'electron-log/main'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

// One log for the whole main process, written to userData/logs/main.log and rotated at 5 MB into
// main.old.log. Each module logs under its own scope so a line says where it came from. 'info' is
// the story of what the client did; 'debug' - the 详细日志 switch - adds every request, every wait and
// the head of every reply, which is what a risk-control refusal can only be told apart by.
log.transports.file.maxSize = 5 * 1024 * 1024
log.transports.file.level = 'info'
log.transports.console.level = app?.isPackaged ? 'warn' : 'debug'
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}]{scope} {text}'
// Outside Electron - the unit tests - nothing is written: they would land in the user's own log.
if (!process.versions.electron) { log.transports.file.level = false; log.transports.console.level = false }

// Keys whose values are a credential wherever they appear: a header, a query parameter, a cookie.
const SECRET = 'cookie|set-cookie|authorization|token|access_token|access_key|password|sessdata|bili_jct|csrf|csrf_token|refresh_token'

// Unlike redact() in engine.ts, the query survives: wbi signatures, cursors and page numbers are the
// thing being debugged. Only the values of credential-bearing keys are taken out.
export function sanitize(text: string): string {
  return text
    .replace(new RegExp(`([?&;\\s"']|^)(${SECRET})=([^&;\\s"']*)`, 'gi'), '$1$2=[redacted]')
    .replace(new RegExp(`("?(?:${SECRET})"?\\s*[:]\\s*)("[^"]*"|[^\\r\\n,}]+)`, 'gi'), '$1[redacted]')
}

log.hooks.push(message => ({
  ...message,
  data: message.data.map(part => part instanceof Error ? sanitize(part.stack || String(part)) : typeof part === 'string' ? sanitize(part) : part),
}))
log.errorHandler.startCatching({ showDialog: false })

export function logger(scope: string) { return log.scope(scope) }

export function setVerbose(on: boolean): void { log.transports.file.level = on ? 'debug' : 'info' }

export function logDirectory(): string { return path.dirname(log.transports.file.getFile().path) }

// The end of the current file, for the diagnostics export. Already sanitized when it was written.
export async function recentLog(lines = 2000): Promise<string[]> {
  try { return (await readFile(log.transports.file.getFile().path, 'utf8')).split(/\r?\n/).slice(-lines) }
  catch { return [] }
}

// A reply's first characters on one line, for a warning that has to show what came back instead.
export function head(body: string, length = 300): string { return body.slice(0, length).replace(/\s+/g, ' ').trim() }
