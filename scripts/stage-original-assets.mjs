// Deploy step: stages the converted game pack into the web build output, writes
// the offline manifest for it, and writes the offline service worker with the
// pack version filled in. Run with `node` from the repository root.

import { createHash } from 'node:crypto';
import { copyFile, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const PACK_SOURCE = path.join('.local', 'original');
const SITE_ROOT = path.join('dist', 'client');
const STAGED_ROOT = path.join(SITE_ROOT, 'original');
const MANIFEST_OUTPUT = path.join(SITE_ROOT, 'offline-manifest.json');
const WORKER_TEMPLATE = path.join('public', 'sw.js');
const WORKER_OUTPUT = path.join(SITE_ROOT, 'sw.js');

const STAGED_EXTENSIONS = new Set(['.json', '.png', '.jpg', '.ogg', '.m4a']);
const SIZE_LIMIT_BYTES = 25 * 1024 * 1024;
const SKIPPED_NAMES = new Set(['sw.js', 'offline-manifest.json', '_headers']);
const VERSION_HEX_LENGTH = 20;
const VERSION_PLACEHOLDER = '__OFFLINE_VERSION__';

// Lists every non-directory entry below `directory`, descending into
// subdirectories in the order the directory listing returns them.
async function listEntries(directory) {
  const found = [];
  for (const dirent of await readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, dirent.name);
    if (dirent.isDirectory()) {
      found.push(...(await listEntries(fullPath)));
    } else {
      found.push({ fullPath, isFile: dirent.isFile() });
    }
  }
  return found;
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function stageOriginalAssets() {
  await stat(path.join(PACK_SOURCE, 'manifest.json'));

  let copied = 0;
  for (const { fullPath, isFile } of await listEntries(PACK_SOURCE)) {
    if (!isFile) continue;
    const relative = path.relative(PACK_SOURCE, fullPath);
    if (!STAGED_EXTENSIONS.has(path.extname(relative))) continue;

    const { size } = await stat(fullPath);
    if (size > SIZE_LIMIT_BYTES) {
      throw new Error(`Asset exceeds Workers file limit: ${relative}`);
    }
    await copyFile(fullPath, path.join(STAGED_ROOT, relative));
    copied += 1;
  }
  return copied;
}

async function writeOfflineFiles() {
  const entries = [];
  for (const { fullPath } of await listEntries(SITE_ROOT)) {
    const relative = path.relative(SITE_ROOT, fullPath);
    const baseName = path.basename(fullPath);
    if (baseName.startsWith('.') || SKIPPED_NAMES.has(baseName)) continue;

    const bytes = await readFile(fullPath);
    entries.push({
      url: relative === 'index.html' ? '/' : `/${relative}`,
      size: bytes.length,
      hash: sha256Hex(bytes),
    });
  }
  entries.sort((a, b) => a.url.localeCompare(b.url));

  const version = sha256Hex(JSON.stringify(entries)).slice(0, VERSION_HEX_LENGTH);
  await writeFile(MANIFEST_OUTPUT, JSON.stringify({ version, files: entries }));

  const template = await readFile(WORKER_TEMPLATE, 'utf8');
  await writeFile(WORKER_OUTPUT, template.replace(VERSION_PLACEHOLDER, version));

  return { entries, version };
}

const copiedCount = await stageOriginalAssets();
console.log(`Staged ${copiedCount} converted game assets for deployment.`);

const { entries, version } = await writeOfflineFiles();
const totalBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
const megabytes = (totalBytes / 1024 / 1024).toFixed(1);
console.log(`Offline pack: ${entries.length} files, ${megabytes} MB, ${version}`);
