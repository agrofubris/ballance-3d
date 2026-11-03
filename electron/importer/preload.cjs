'use strict'

const { contextBridge, ipcRenderer } = require('electron')

function listen(channel, callback) {
  const handler = (_event, data) => callback(data)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('ballanceImporter', Object.freeze({
  context: () => ipcRenderer.invoke('importer:context'),
  chooseGameFolder: () => ipcRenderer.invoke('importer:choose-game-folder'),
  choosePack: () => ipcRenderer.invoke('importer:choose-pack'),
  start: (gameFolder) => ipcRenderer.invoke('importer:start', gameFolder),
  cancel: () => ipcRenderer.invoke('importer:cancel'),
  onProgress: (callback) => listen('importer:progress', callback),
  onFailed: (callback) => listen('importer:failed', callback),
  onCancelled: (callback) => listen('importer:cancelled', callback),
}))
