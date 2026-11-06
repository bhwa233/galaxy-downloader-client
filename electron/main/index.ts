import { app, BrowserWindow, ipcMain, session, Tray, Menu, nativeImage } from 'electron'
import { cpSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Controller } from './controller'
import { logger } from '../services/log'
import { i18n } from '../../shared/i18n'
import { configureNativeNotifications } from '../services/notifications'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
const developmentUrl = !app.isPackaged ? process.env.VITE_DEV_SERVER_URL : undefined
const rendererUrl = developmentUrl || pathToFileURL(path.join(root, 'dist/index.html')).href
configureNativeNotifications()
if (process.env.CLIENT_TEST_DATA && !app.isPackaged) app.setPath('userData', process.env.CLIENT_TEST_DATA)
// Acquire the process lock before reading or migrating user data. Only its owner starts services.
const primaryInstance = app.requestSingleInstanceLock()
const log = logger('app')
let window: BrowserWindow | null = null
let controller: Controller
let tray: Tray | undefined
let quitting = false
let shutdown: Promise<void> | undefined
let shutdownFinished = false
let activationRequested = false
// Started by the command line when it found no client running: the window is made but not shown, and
// the tray or opening the app again brings it up.
const background = process.argv.includes('--background')
if (!primaryInstance) app.quit()
else {
  app.on('second-instance', showWindow)
  app.on('activate', showWindow)
  // The old profile is copied only by the primary instance on its first start under the new name.
  const previous = (app.isPackaged ? ['bhwa233 Download Client', 'bhwa233-download-client'] : ['bhwa233-download-client', 'bhwa233 Download Client'])
    .map(name => path.join(app.getPath('appData'), name)).find(directory => existsSync(path.join(directory, 'state.json')))
  if (!process.env.CLIENT_TEST_DATA && previous && !existsSync(path.join(app.getPath('userData'), 'state.json'))) cpSync(previous, app.getPath('userData'), { recursive: true })
  void app.whenReady().then(async () => {
    log.info(`启动 v${app.getVersion()} · ${process.platform}-${process.arch} · Electron ${process.versions.electron} · ${app.isPackaged ? '安装版' : '开发环境'} · 数据目录 ${app.getPath('userData')}`)
    controller = new Controller(() => window, showWindow)
    ipcMain.handle('desktop:command', (event, name: unknown, input: unknown) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url.split('#')[0] !== rendererUrl.split('#')[0]) return { ok: false, message: i18n.t('desktop:errors.untrustedPage') }
      return controller.command(name, input)
    })
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    session.defaultSession.setPermissionCheckHandler(() => false)
    // macOS keeps its menu: the app menu lives in the system bar and carries the edit shortcuts.
    if (process.platform !== 'darwin') Menu.setApplicationMenu(null)
    createWindow()
    if (activationRequested) showWindow()
    const icon = nativeImage.createFromPath(path.join(app.getAppPath(), app.isPackaged ? 'dist/tray.png' : 'public/tray.png')).resize({ width: 22, height: 22 })
    if (!icon.isEmpty()) {
      tray = new Tray(icon)
      tray.setToolTip('Galaxy Downloader')
      const show = showWindow
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
  if (window && !window.isDestroyed()) return
  const iconPath = path.join(app.getAppPath(), app.isPackaged ? 'dist/tray.png' : 'public/tray.png')
  const created = new BrowserWindow({ title: 'Galaxy Downloader', icon: iconPath, width: 1200, height: 850, minWidth: 900, minHeight: 650, backgroundColor: '#f7f8fa', show: !background, webPreferences: { preload: path.join(root, 'dist-electron/preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
  window = created
  created.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  created.webContents.on('will-navigate', (event, url) => { if (url !== rendererUrl) event.preventDefault() })
  created.webContents.on('will-attach-webview', event => event.preventDefault())
  created.on('close', event => { if (!quitting && tray && controller.state().settings.minimizeToTray) { event.preventDefault(); created.hide() } })
  created.on('closed', () => { if (window === created) window = null })
  void created.loadURL(rendererUrl)
}
function showWindow(): void {
  if (!app.isReady() || !controller) { activationRequested = true; return }
  activationRequested = false
  if (!window) createWindow()
  if (window?.isMinimized()) window.restore()
  window?.show()
  window?.focus()
}
app.on('before-quit', event => {
  quitting = true; tray?.destroy()
  if (!controller || shutdownFinished) return
  event.preventDefault()
  // Keep main alive until cancelled workers exit and remove their private files.
  shutdown ||= controller.stop().catch(error => { log.warn('Shutdown cleanup failed', error) }).finally(() => { shutdownFinished = true; app.quit() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
