import { app, BrowserWindow, ipcMain, session, Tray, Menu, nativeImage, protocol } from 'electron'
import { cpSync, existsSync, createReadStream } from 'node:fs'
import path from 'node:path'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Controller } from './controller'
import { logger } from '../services/log'
import { i18n } from '../../shared/i18n'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
protocol.registerSchemesAsPrivileged([{ scheme: 'galaxy-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }])
const developmentUrl = !app.isPackaged ? process.env.VITE_DEV_SERVER_URL : undefined
const rendererUrl = developmentUrl || pathToFileURL(path.join(root, 'dist/index.html')).href
if (process.env.CLIENT_TEST_DATA && !app.isPackaged) app.setPath('userData', process.env.CLIENT_TEST_DATA)
// The client was 'bhwa233 Download Client' ('bhwa233-download-client' in development) before it was
// Galaxy Downloader, and Electron names its data directory after the app. The first start under the
// new name takes over the tasks, settings and sign-ins by copying the old directory; the old one is
// left as it was. Checked by the saved state rather than the directory, which Chromium creates itself.
const previous = (app.isPackaged ? ['bhwa233 Download Client', 'bhwa233-download-client'] : ['bhwa233-download-client', 'bhwa233 Download Client'])
  .map(name => path.join(app.getPath('appData'), name)).find(directory => existsSync(path.join(directory, 'state.json')))
if (!process.env.CLIENT_TEST_DATA && previous && !existsSync(path.join(app.getPath('userData'), 'state.json'))) cpSync(previous, app.getPath('userData'), { recursive: true })
const log = logger('app')
let window: BrowserWindow | null = null
let controller: Controller
let tray: Tray | undefined
let quitting = false
// Started by the command line when it found no client running: the window is made but not shown, and
// the tray or opening the app again brings it up.
const background = process.argv.includes('--background')
if (!app.requestSingleInstanceLock()) app.quit()
else {
  void app.whenReady().then(async () => {
    log.info(`启动 v${app.getVersion()} · ${process.platform}-${process.arch} · Electron ${process.versions.electron} · ${app.isPackaged ? '安装版' : '开发环境'} · 数据目录 ${app.getPath('userData')}`)
    controller = new Controller(() => window)
    protocol.handle('galaxy-media', async request => {
      try {
        const url = new URL(request.url)
        if (url.hostname !== 'processing' || !['GET', 'HEAD'].includes(request.method) || !/^\/[0-9a-f-]{36}$/.test(url.pathname)) return new Response(null, { status: 404 })
        // The URL carries a document id only. Main resolves the file selected by a native dialog or a recorded task.
        const file = controller.processingMedia(url.pathname.slice(1)), info = await stat(file)
        const types: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.aac': 'audio/aac' }
        const headers = new Headers({ 'Content-Type': types[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' })
        const range = request.headers.get('range')
        const match = range?.match(/^bytes=(\d*)-(\d*)$/)
        let start = 0, end = info.size - 1
        if (range) {
          if (!match || !match[1] && !match[2]) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } })
          start = match[1] ? Number(match[1]) : Math.max(0, info.size - Number(match[2]))
          end = match[1] && match[2] ? Math.min(end, Number(match[2])) : end
          if (!Number.isSafeInteger(start) || start > end || end < 0) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } })
          headers.set('Content-Range', `bytes ${start}-${end}/${info.size}`)
        }
        headers.set('Content-Length', String(end - start + 1))
        return new Response(request.method === 'HEAD' ? null : Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream<Uint8Array>, { status: range ? 206 : 200, headers })
      } catch { return new Response(null, { status: 404 }) }
    })
    ipcMain.handle('desktop:command', (event, name: unknown, input: unknown) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url.split('#')[0] !== rendererUrl.split('#')[0]) return { ok: false, message: i18n.t('desktop:errors.untrustedPage') }
      return controller.command(name, input)
    })
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    session.defaultSession.setPermissionCheckHandler(() => false)
    // macOS keeps its menu: the app menu lives in the system bar and carries the edit shortcuts.
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
    createWindow()
    const icon = nativeImage.createFromPath(path.join(app.getAppPath(), app.isPackaged ? 'dist/tray.png' : 'public/tray.png')).resize({ width: 22, height: 22 })
    if (!icon.isEmpty()) {
      tray = new Tray(icon)
      tray.setToolTip('Galaxy Downloader')
      const show = () => { if (!window) createWindow(); window?.show(); window?.focus() }
      // Built again whenever the language changes, so the menu follows the window's language.
      const menu = () => { if (tray && !tray.isDestroyed()) tray.setContextMenu(Menu.buildFromTemplate([{ label: i18n.t('desktop:tray.open'), click: show }, { label: i18n.t('desktop:tray.pauseAll'), click: () => { void controller.command('jobs:batch', { action: 'pause' }) } }, { type: 'separator' }, { label: i18n.t('desktop:tray.quit'), click: () => app.quit() }])) }
      menu()
      i18n.on('languageChanged', menu)
      tray.on('click', show)
    }
    await controller.initialize()
  }).catch(error => { log.error('启动失败', error); app.quit() })
}
function createWindow(): void {
  const iconPath = path.join(app.getAppPath(), app.isPackaged ? 'dist/tray.png' : 'public/tray.png')
  window = new BrowserWindow({ title: 'Galaxy Downloader', icon: iconPath, width: 1200, height: 850, minWidth: 900, minHeight: 650, backgroundColor: '#f7f8fa', show: !background, webPreferences: { preload: path.join(root, 'dist-electron/preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => { if (url !== rendererUrl) event.preventDefault() })
  window.webContents.on('will-attach-webview', event => event.preventDefault())
  window.on('close', event => { if (!quitting && tray && controller.state().settings.minimizeToTray) { event.preventDefault(); window?.hide() } })
  window.on('closed', () => { window = null })
  void window.loadURL(rendererUrl)
}
app.on('before-quit', () => { quitting = true; controller?.stop(); tray?.destroy() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (window) { window.show(); window.focus() } else if (controller) createWindow() })
app.on('second-instance', () => { window?.show(); window?.restore(); window?.focus() })
