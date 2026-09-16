import { contextBridge, ipcRenderer } from 'electron'
import type { ClientState, DesktopApi } from '../../shared/contracts'
const api: DesktopApi = {
  command: (name, input) => ipcRenderer.invoke('desktop:command', name, input),
  subscribe: listener => {
    const handler = (_event: Electron.IpcRendererEvent, state: ClientState) => listener(state)
    ipcRenderer.on('desktop:state', handler)
    return () => { ipcRenderer.removeListener('desktop:state', handler) }
  },
}
contextBridge.exposeInMainWorld('desktopApi', api)
