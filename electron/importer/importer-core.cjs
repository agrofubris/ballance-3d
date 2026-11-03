'use strict'

const { existsSync, statSync } = require('node:fs')
const path = require('node:path')

const STEP_PATTERN = /^STEP (\d+)\/(\d+) (.+)$/

const defaultIo = {
  isFile(candidate) {
    try {
      return statSync(candidate).isFile()
    } catch {
      return false
    }
  },
  isDirectory(candidate) {
    try {
      return statSync(candidate).isDirectory()
    } catch {
      return false
    }
  },
}

function parseStepLine(line) {
  if (typeof line !== 'string') return null
  const match = STEP_PATTERN.exec(line.trimEnd())
  if (!match) return null
  const step = Number(match[1])
  const total = Number(match[2])
  const name = match[3].trim()
  if (!Number.isInteger(step) || !Number.isInteger(total) || step < 1 || total < 1 || step > total || !name) return null
  return { step, total, name }
}

function gameFolderStatus(directory, io = defaultIo) {
  if (typeof directory !== 'string' || directory.length === 0) {
    return { valid: false, directory: '', base: false, entities: null }
  }
  const base = io.isFile(path.join(directory, 'base.cmo'))
  const entities = ['3D Entities', '3D_Entities'].find(name => io.isDirectory(path.join(directory, name))) ?? null
  return { valid: base && entities !== null, directory, base, entities }
}

function parseRegistryValues(text, names) {
  if (typeof text !== 'string') return []
  const wanted = new Set(names)
  const found = []
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s+([^=\s]+)\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/.exec(line)
    if (match && wanted.has(match[1])) found.push(match[2])
  }
  return found
}

function parseUninstallLocations(text, displayName = 'ballance') {
  if (typeof text !== 'string') return []
  const wanted = displayName.toLocaleLowerCase()
  const locations = []
  let block = []
  const flush = () => {
    let matches = false
    let location = ''
    for (const line of block) {
      const name = /^\s+(DisplayName)\s+REG_SZ\s+(.+?)\s*$/.exec(line)
      if (name) matches = name[2].toLocaleLowerCase().includes(wanted)
      const install = /^\s+(?:InstallLocation|InstallPath|GamePath)\s+REG_(?:SZ|EXPAND_SZ)\s+(.+?)\s*$/.exec(line)
      if (install) location = install[1]
    }
    if (matches && location) locations.push(location)
    block = []
  }
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('HKEY_')) {
      flush()
      block = [line]
    } else if (block.length > 0) {
      block.push(line)
    }
  }
  flush()
  return locations
}

function packagedCandidates(resourcesPath, ...parts) {
  const candidates = []
  if (typeof resourcesPath === 'string' && resourcesPath.length > 0) {
    candidates.push(path.join(resourcesPath, 'importer', ...parts))
  }
  return candidates
}

function resolveTools({ resourcesPath, repoRoot, exists = existsSync } = {}) {
  const first = (candidates, fallback) => candidates.find(candidate => exists(candidate)) ?? fallback
  const python = first([
    ...packagedCandidates(resourcesPath, 'python', 'python.exe'),
    ...packagedCandidates(resourcesPath, 'python.exe'),
  ], path.join(repoRoot, '.tools', 'python-3.12.10-embed-amd64', 'python.exe'))
  const library = first([
    ...packagedCandidates(resourcesPath, 'bmap', 'BMap.dll'),
    ...packagedCandidates(resourcesPath, 'BMap.dll'),
  ], path.join(repoRoot, 'vendor', 'bmap-win-x64', 'BMap.dll'))
  const dumpChunks = first([
    ...packagedCandidates(resourcesPath, 'dump-chunks.exe'),
    ...packagedCandidates(resourcesPath, 'dump-chunks', 'dump-chunks.exe'),
  ], path.join(repoRoot, 'vendor', 'bmap-win-x64', 'dump-chunks.exe'))
  const packedScripts = packagedCandidates(resourcesPath, 'scripts')[0]
  const scripts = typeof packedScripts === 'string' && exists(packedScripts)
    ? packedScripts
    : path.join(repoRoot, 'scripts')
  return {
    python,
    library,
    dumpChunks,
    scripts,
    prepare: path.join(scripts, 'prepare-original.py'),
  }
}

function missingTools(tools, exists = existsSync) {
  return [
    ['Python', tools.python],
    ['BMap library', tools.library],
    ['dump-chunks', tools.dumpChunks],
    ['prepare-original.py', tools.prepare],
  ].filter(([, file]) => !exists(file)).map(([name, file]) => `${name} (${file})`)
}

function buildImportArguments({ prepare, gameFolder, library, dumpChunks, output, work }) {
  return [
    prepare,
    '--game', gameFolder,
    '--library', library,
    '--dump-chunks', dumpChunks,
    '--output', output,
    '--work', work,
    '--no-ffmpeg',
  ]
}

module.exports = {
  buildImportArguments,
  gameFolderStatus,
  missingTools,
  parseRegistryValues,
  parseStepLine,
  parseUninstallLocations,
  resolveTools,
}
