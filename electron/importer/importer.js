'use strict'

const api = window.ballanceImporter

const setupSection = document.getElementById('setup')
const progressSection = document.getElementById('progress')
const failureSection = document.getElementById('failure')
const folderInput = document.getElementById('game-folder')
const gameStatus = document.getElementById('game-status')
const chooseGameButton = document.getElementById('choose-game')
const importButton = document.getElementById('import')
const existingButton = document.getElementById('existing')
const cancelButton = document.getElementById('cancel')
const retryButton = document.getElementById('retry')
const stepName = document.getElementById('step-name')
const progressDetail = document.getElementById('progress-detail')
const bar = document.getElementById('bar')
const barFill = document.getElementById('bar-fill')
const failureMessage = document.getElementById('failure-message')
const logView = document.getElementById('log')

let gameFolder = ''
let busy = false

function setStatus(text, kind) {
  gameStatus.textContent = text
  gameStatus.className = kind ? `status ${kind}` : 'status'
}

function describeFolder(status) {
  if (!status.directory) {
    setStatus('Choose the folder that contains base.cmo and "3D Entities" or "3D_Entities".', '')
    return
  }
  const missing = []
  if (!status.base) missing.push('base.cmo')
  if (!status.entities) missing.push('"3D Entities" or "3D_Entities"')
  if (missing.length > 0) {
    setStatus(`This folder is not a Ballance installation: missing ${missing.join(' and ')}.`, 'warn')
    return
  }
  setStatus(`Found base.cmo and "${status.entities}".`, 'ok')
}

function setGameFolder(directory, status) {
  gameFolder = directory || ''
  folderInput.value = gameFolder
  folderInput.title = gameFolder
  describeFolder(status || { directory: gameFolder, base: false, entities: null })
  importButton.disabled = busy || !gameFolder || !status || !status.valid
}

function setBusy(value) {
  busy = value
  chooseGameButton.disabled = value
  existingButton.disabled = value
  importButton.disabled = value || !folderInput.value
  cancelButton.disabled = !value
}

function showSetup() {
  setupSection.hidden = false
  progressSection.hidden = true
  failureSection.hidden = true
  setBusy(false)
}

function showProgress() {
  setupSection.hidden = true
  failureSection.hidden = true
  progressSection.hidden = false
  barFill.style.width = '0%'
  bar.setAttribute('aria-valuenow', '0')
  stepName.textContent = 'Starting the import...'
  progressDetail.textContent = ''
  setBusy(true)
}

function updateProgress({ step, total, name }) {
  const percent = total > 0 ? Math.round((step / total) * 100) : 0
  barFill.style.width = `${percent}%`
  bar.setAttribute('aria-valuenow', String(percent))
  stepName.textContent = name
  progressDetail.textContent = `Step ${step} of ${total}`
}

function showFailure(message, tail) {
  setupSection.hidden = true
  progressSection.hidden = true
  failureSection.hidden = false
  failureMessage.textContent = message || 'The import failed.'
  logView.textContent = Array.isArray(tail) && tail.length > 0 ? tail.join('\n') : 'No log output.'
  setBusy(false)
}

async function chooseGameFolder() {
  try {
    const result = await api.chooseGameFolder()
    if (result && !result.canceled) setGameFolder(result.directory, result.status)
  } catch (error) {
    setStatus(error && error.message ? error.message : String(error), 'warn')
  }
}

async function startImport() {
  if (!gameFolder || busy) return
  showProgress()
  try {
    await api.start(gameFolder)
  } catch (error) {
    showFailure(error && error.message ? error.message : String(error), [])
  }
}

async function choosePack() {
  try {
    await api.choosePack()
  } catch (error) {
    showFailure(error && error.message ? error.message : String(error), [])
  }
}

chooseGameButton.addEventListener('click', chooseGameFolder)
importButton.addEventListener('click', startImport)
existingButton.addEventListener('click', choosePack)
cancelButton.addEventListener('click', () => {
  cancelButton.disabled = true
  progressDetail.textContent = 'Cancelling...'
  api.cancel().catch(error => showFailure(error && error.message ? error.message : String(error), []))
})
retryButton.addEventListener('click', showSetup)

api.onProgress(updateProgress)
api.onFailed(details => showFailure(details && details.message, details && details.tail))
api.onCancelled(() => {
  showSetup()
  setStatus('Import cancelled.', 'warn')
})

api.context().then(context => {
  setGameFolder(context.gameFolder, context.status)
  if (!context.gameFolder) {
    setStatus('Choose the folder that contains base.cmo and "3D Entities" or "3D_Entities".', '')
  }
}).catch(error => {
  setStatus(error && error.message ? error.message : String(error), 'warn')
})
