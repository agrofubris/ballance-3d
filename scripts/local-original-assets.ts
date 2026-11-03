// Development-server plugin that serves the local IVP module and the converted
// original game pack straight from their local folders. Nothing is copied and
// the plugin has no build-time behaviour.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Plugin } from 'vite';

const IVP_ROOT = path.resolve('.local', 'ivp-simulation');
const ORIGINAL_ROOT = path.resolve('.local', 'original');

const IVP_CONTENT_TYPES = new Map<string, string>([
  ['/ivp-simulation.mjs', 'text/javascript'],
  ['/ivp-simulation.wasm', 'application/wasm'],
]);

const ORIGINAL_CONTENT_TYPES = new Map<string, string>([
  ['.json', 'application/json'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.ogg', 'audio/ogg'],
  ['.m4a', 'audio/mp4'],
  ['.txt', 'text/plain; charset=windows-1252'],
  ['.avi', 'video/x-msvideo'],
  ['.tdb', 'application/octet-stream'],
  ['.bmp', 'image/bmp'],
  ['.wav', 'audio/wav'],
]);

const FALLBACK_CONTENT_TYPE = 'application/octet-stream';
const IVP_MISSING_TEXT = 'Build the local IVP module first';

// The URL path with any query string removed. Mounted middleware sees the
// path relative to its mount point.
function requestPath(req: IncomingMessage): string {
  const url = req.url ?? '/';
  const queryStart = url.indexOf('?');
  return queryStart === -1 ? url : url.slice(0, queryStart);
}

function refuse(res: ServerResponse): void {
  res.statusCode = 404;
  res.end();
}

function streamFile(res: ServerResponse, filePath: string, contentType: string): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', contentType);
  const stream = createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

async function isRegularFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function serveIvp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const requested = requestPath(req);
  const contentType = IVP_CONTENT_TYPES.get(requested);
  if (!contentType) {
    refuse(res);
    return;
  }

  const filePath = path.join(IVP_ROOT, requested.slice(1));
  if (!(await isRegularFile(filePath))) {
    res.statusCode = 404;
    res.end(IVP_MISSING_TEXT);
    return;
  }
  streamFile(res, filePath, contentType);
}

async function serveOriginal(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath(req));
  } catch {
    refuse(res);
    return;
  }

  // The leading '.' keeps an absolute-looking request path under the root.
  const filePath = path.resolve(ORIGINAL_ROOT, `.${decoded}`);
  if (!filePath.startsWith(ORIGINAL_ROOT + path.sep)) {
    refuse(res);
    return;
  }
  if (!(await isRegularFile(filePath))) {
    refuse(res);
    return;
  }

  const contentType = ORIGINAL_CONTENT_TYPES.get(path.extname(filePath)) ?? FALLBACK_CONTENT_TYPE;
  streamFile(res, filePath, contentType);
}

export function localOriginalAssets(): Plugin {
  return {
    name: 'local-original-game-assets',
    configureServer(server) {
      server.middlewares.use('/ivp', (req, res) => {
        void serveIvp(req, res);
      });
      server.middlewares.use('/original', (req, res) => {
        void serveOriginal(req, res);
      });
    },
  };
}
