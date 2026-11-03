// Offline pack service worker for the web build. The deploy step writes a
// copy of this file with the pack version filled in (see scripts/stage-original-assets.mjs).
// Classic script: no imports, no exports.

const PACK_VERSION = '__OFFLINE_VERSION__';
const CACHE_PREFIX = 'ballance-flight-';
const CURRENT_CACHE = CACHE_PREFIX + PACK_VERSION;
const READY_KEY = '/__ballance_offline_ready__';
const MANIFEST_PATH = '/offline-manifest.json';
const REQUEST_TIMEOUT_MS = 30000;
const WORKER_COUNT = 4;

const BUSY_TEXT = 'A download is already running. Keep that tab open.';
const MANIFEST_TEXT = 'Download list unavailable. Reconnect and try again.';
const STALE_TEXT = 'An update is ready. Reload, then save again.';
const CHANGED_TEXT = 'The game changed during download. Reload and retry.';
const QUOTA_TEXT = 'Not enough storage. Free some space and retry.';
const INTERRUPTED_TEXT = 'Download interrupted. Reconnect and retry.';

let downloadRunning = false;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const port = event.ports && event.ports[0];
  if (!port) return;
  const message = event.data || {};

  if (message.type === 'STATUS') {
    event.waitUntil(replyStatus(port));
  } else if (message.type === 'SAVE') {
    if (downloadRunning) {
      port.postMessage({ type: 'ERROR', message: BUSY_TEXT });
      return;
    }
    event.waitUntil(runSave(port));
  }
});

async function replyStatus(port) {
  const cache = await caches.open(CURRENT_CACHE);
  const marker = await cache.match(READY_KEY);
  port.postMessage({ type: marker ? 'READY' : 'EMPTY' });
}

async function runSave(port) {
  downloadRunning = true;
  try {
    await downloadPack(port);
  } catch (failure) {
    port.postMessage({ type: 'ERROR', message: describeFailure(failure) });
  } finally {
    downloadRunning = false;
  }
}

function describeFailure(failure) {
  if (failure && failure.name === 'QuotaExceededError') return QUOTA_TEXT;
  if (failure && failure.message) return failure.message;
  return INTERRUPTED_TEXT;
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function sha256Hex(buffer) {
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function downloadPack(port) {
  const manifestResponse = await fetchWithTimeout(MANIFEST_PATH);
  if (!manifestResponse.ok) throw new Error(MANIFEST_TEXT);
  const manifest = await manifestResponse.json();
  if (manifest.version !== PACK_VERSION) throw new Error(STALE_TEXT);

  const cache = await caches.open(CURRENT_CACHE);
  await cache.delete(READY_KEY);

  const entries = manifest.files;
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  let done = 0;
  let nextEntry = 0;

  const runWorker = async () => {
    while (nextEntry < entries.length) {
      const entry = entries[nextEntry];
      nextEntry += 1;
      await storeEntry(cache, entry);
      done += entry.size;
      port.postMessage({ type: 'PROGRESS', done, total });
    }
  };

  const workers = [];
  for (let index = 0; index < WORKER_COUNT; index += 1) {
    workers.push(runWorker());
  }
  const outcomes = await Promise.allSettled(workers);
  const firstFailure = outcomes.find((outcome) => outcome.status === 'rejected');
  if (firstFailure) throw firstFailure.reason;

  await cache.put(READY_KEY, new Response(JSON.stringify({ version: PACK_VERSION, files: entries.length })));
  port.postMessage({ type: 'READY' });
}

async function storeEntry(cache, entry) {
  if (await cache.match(entry.url)) return;

  const response = await fetchWithTimeout(entry.url);
  if (!response.ok) throw new Error(`Could not download ${entry.url}. Reconnect and retry.`);

  const copy = response.clone();
  const digest = await sha256Hex(await response.arrayBuffer());
  if (digest !== entry.hash) throw new Error(CHANGED_TEXT);
  await cache.put(entry.url, copy);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  const handled = request.method === 'GET'
    && url.origin === self.location.origin
    && url.pathname !== MANIFEST_PATH;
  if (!handled) return;

  event.respondWith(answerRequest(request, url));
});

async function answerRequest(request, url) {
  const key = request.mode === 'navigate' ? '/' : url.pathname;
  const saved = await findSavedResponse(key);
  if (saved) return applyRange(request, saved);
  return fetch(request);
}

async function findSavedResponse(key) {
  const names = await caches.keys();
  const otherNames = names
    .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CURRENT_CACHE)
    .reverse();

  for (const name of [CURRENT_CACHE, ...otherNames]) {
    const cache = await caches.open(name);
    if (!(await cache.match(READY_KEY))) continue;
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  return undefined;
}

function rangeFailure(size, withContentRange) {
  const headers = new Headers();
  if (withContentRange) headers.set('Content-Range', `bytes */${size}`);
  return new Response(null, { status: 416, headers });
}

async function applyRange(request, response) {
  const rangeHeader = request.headers.get('Range');
  if (rangeHeader === null) return response;

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) return rangeFailure(0, false);

  const startText = match[1];
  const endText = match[2];
  const body = await response.arrayBuffer();
  const size = body.byteLength;

  let start;
  if (startText !== '') {
    start = Number(startText);
  } else if (endText !== '') {
    start = Math.max(0, size - Number(endText));
  } else {
    start = size;
  }

  let end = size - 1;
  if (startText !== '' && endText !== '') {
    end = Math.min(Number(endText), size - 1);
  }

  if (start > end || start >= size || size === 0) {
    return rangeFailure(size, true);
  }

  const headers = new Headers(response.headers);
  headers.delete('Content-Encoding');
  headers.set('Content-Range', `bytes ${start}-${end}/${size}`);
  headers.set('Content-Length', String(end - start + 1));
  headers.set('Accept-Ranges', 'bytes');
  return new Response(body.slice(start, end + 1), { status: 206, headers });
}
