const { contextBridge, ipcRenderer } = require('electron')

const info = ipcRenderer.sendSync('ballance:shell-info')
const leia = info.leia ?? { available: false, active: false, weaveSize: { width: 0, height: 0 } }

contextBridge.exposeInMainWorld('ballanceShell', Object.freeze({
  platform: 'electron',
  version: info.version,
  leia: Object.freeze({
    available: leia.available === true,
    active: leia.active === true,
    weaveSize: Object.freeze({ width: leia.weaveSize.width, height: leia.weaveSize.height }),
  }),
  setLeia: (on) => ipcRenderer.invoke('ballance:set-leia', on === true),
  setScreenMode: (width, height) => ipcRenderer.invoke('ballance:set-screen-mode', width, height),
  quit: () => ipcRenderer.invoke('ballance:quit'),
}))
