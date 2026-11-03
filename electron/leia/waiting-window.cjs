'use strict'

const { BrowserWindow } = require('electron')
const path = require('node:path')

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; }
  body {
    display: grid; place-content: center; gap: 10px; padding: 18px;
    box-sizing: border-box; background: #17191c; color: #f5eedc;
    font-family: 'Trebuchet MS', Arial, sans-serif; text-align: center;
  }
  .title { margin: 0; font-size: 17px; letter-spacing: .04em; }
  p { margin: 0; font-size: 14px; }
  #fps, #error { font-size: 12px; color: #b9b2a2; overflow-wrap: anywhere; }
  #error[hidden] { display: none; }
  button {
    justify-self: center; padding: 9px 16px; font: inherit; color: #151914; cursor: pointer;
    border: 2px ridge #ac9562; background: linear-gradient(#e9cc83, #a8742c);
  }
</style>
</head>
<body>
  <p class="title">Leia SR mode</p>
  <p id="state">Waiting for the presenter</p>
  <p id="fps">0.0 frames/s</p>
  <p id="error" hidden></p>
  <button id="return" type="button">Return to normal mode</button>
  <script>
    const state = document.getElementById('state')
    const fps = document.getElementById('fps')
    const error = document.getElementById('error')
    const describe = (status) => {
      if (!status) return 'Waiting for the presenter'
      if (status.helperMissing || status.reason === 'helper-missing') return 'Presenter not found'
      if (status.reason === 'helper-failed') return 'Presenter stopped'
      if (status.helperRunning) {
        if (status.mode === 'weaving') return 'Presenter running — weaving on the SR display'
        if (status.mode === 'raw-sbs') return 'Presenter running — raw side-by-side fallback'
        return 'Presenter running'
      }
      if (status.reason === 'helper-restarting') return 'Restarting the presenter…'
      if (status.reason === 'closed-by-user') return 'Presenter closed'
      if (typeof status.reason === 'string' && status.reason.startsWith('helper-exited')) return 'Presenter stopped'
      return 'Waiting for the presenter'
    }
    const render = (status) => {
      state.textContent = describe(status)
      fps.textContent = status && Number.isFinite(status.fps) ? status.fps.toFixed(1) + ' frames/s' : '0.0 frames/s'
      if (status && status.lastError) {
        error.hidden = false
        error.textContent = status.lastError
      } else {
        error.hidden = true
        error.textContent = ''
      }
    }
    window.ballanceLeiaWaiting.onStatus(render)
    document.getElementById('return').addEventListener('click', () => {
      window.ballanceLeiaWaiting.returnToNormal().catch(() => {})
    })
  </script>
</body>
</html>`

/** The only visible window in Leia mode besides the presenter. */
function createLeiaWaitingWindow({ onReturn }) {
  const win = new BrowserWindow({
    width: 520,
    height: 240,
    useContentSize: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'Ballance',
    backgroundColor: '#17191c',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'waiting-preload.cjs'),
    },
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.on('will-redirect', (event) => event.preventDefault())
  win.once('ready-to-show', () => win.show())
  if (typeof onReturn === 'function') {
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      if (input.key === 'Escape') {
        event.preventDefault()
        onReturn()
      }
    })
  }
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`)
  return win
}

module.exports = { createLeiaWaitingWindow }
