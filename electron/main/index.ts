import { app, BrowserWindow, ipcMain, session, Tray, Menu, nativeImage } from 'electron'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Controller } from './controller'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
const developmentUrl = !app.isPackaged ? process.env.VITE_DEV_SERVER_URL : undefined
const rendererUrl = developmentUrl || pathToFileURL(path.join(root, 'dist/index.html')).href
if (process.env.CLIENT_TEST_DATA && !app.isPackaged) app.setPath('userData', process.env.CLIENT_TEST_DATA)
let window: BrowserWindow | null = null
let controller: Controller
let tray: Tray | undefined
let quitting = false
if (!app.requestSingleInstanceLock()) app.quit()
else {
  void app.whenReady().then(async () => {
    controller = new Controller(() => window)
    ipcMain.handle('desktop:command', (event, name: unknown, input: unknown) => {
      if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url.split('#')[0] !== rendererUrl.split('#')[0]) return { ok: false, message: '不可信的页面' }
      return controller.command(name, input)
    })
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    session.defaultSession.setPermissionCheckHandler(() => false)
    createWindow()
    const icon = nativeImage.createFromPath(path.join(app.getAppPath(), app.isPackaged ? 'dist/tray.png' : 'public/tray.png')).resize({ width: 22, height: 22 })
    if (!icon.isEmpty()) {
      tray = new Tray(icon)
      tray.setToolTip('Galaxy Downloader')
      const show = () => { if (!window) createWindow(); window?.show(); window?.focus() }
      tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开 Galaxy', click: show }, { label: '暂停全部', click: () => { void controller.command('jobs:batch', { action: 'pause' }) } }, { type: 'separator' }, { label: '退出', click: () => app.quit() }]))
      tray.on('click', show)
    }
    await controller.initialize()
  }).catch(error => { console.error('Client startup failed:', error); app.quit() })
}
function createWindow(): void {
  window = new BrowserWindow({ title: 'Galaxy Downloader', width: 1200, height: 850, minWidth: 900, minHeight: 650, backgroundColor: '#f7f8fa', webPreferences: { preload: path.join(root, 'dist-electron/preload/index.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } })
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
