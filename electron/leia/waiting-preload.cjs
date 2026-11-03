const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('ballanceLeiaWaiting', Object.freeze({
  returnToNormal: () => ipcRenderer.invoke('ballance:leia-return'),
  onStatus: (callback) => {
    if (typeof callback !== 'function') return
    ipcRenderer.on('ballance:leia-status', (_event, status) => callback(status))
  },
}))
