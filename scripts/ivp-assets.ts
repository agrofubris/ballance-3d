// Build-time support for the IVP physics module. Reads the locally built loader
// and WebAssembly binary, checks their provenance, and for production builds
// emits them into the client bundle under a content-addressed directory.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';

const LOADER_NAME = 'ivp-simulation.mjs';
const MODULE_NAME = 'ivp-simulation.wasm';
const DEFAULT_DIRECTORY = path.join('.local', 'ivp-simulation');
const DEV_LOADER_URL = '/ivp/ivp-simulation.mjs';
const DEFINE_KEY = 'import.meta.env.VITE_IVP_MODULE_URL';
const BUNDLE_PREFIX = 'ivp';
const DIGEST_LENGTH = 20;

const REQUIRED_REVISION = '7579664996e68040dd0158081b04f612e6a2d515';
const BUILD_MISMATCH_MESSAGE =
  'Build the verified IVP SDK using scripts/build-ivp-simulation.py before building the game';
const WASM_MAGIC_AND_VERSION = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

interface IvpBuildMetadata {
  revision?: unknown;
  floatingPointContraction?: unknown;
}

interface IvpAssetFile {
  name: string;
  source: Buffer;
  fileName: string;
}

interface IvpAssets {
  files: IvpAssetFile[];
  url: string;
}

export async function readIvpAssets(directory: string = path.resolve(DEFAULT_DIRECTORY)): Promise<IvpAssets> {
  const loaderSource = await readFile(path.join(directory, LOADER_NAME));
  const moduleSource = await readFile(path.join(directory, MODULE_NAME));

  const metadata = JSON.parse(await readFile(path.join(directory, 'build.json'), 'utf8')) as
    | IvpBuildMetadata
    | null;
  if (metadata?.revision !== REQUIRED_REVISION || metadata?.floatingPointContraction !== false) {
    throw new Error(BUILD_MISMATCH_MESSAGE);
  }

  if (!moduleSource.subarray(0, WASM_MAGIC_AND_VERSION.length).equals(WASM_MAGIC_AND_VERSION)) {
    throw new Error('Invalid IVP WebAssembly binary');
  }

  const files = [
    { name: LOADER_NAME, source: loaderSource },
    { name: MODULE_NAME, source: moduleSource },
  ];

  // Name and bytes of each file feed the digest, so either change yields a new URL.
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.name, 'utf8');
    hash.update(file.source);
  }
  const digest = hash.digest('hex').slice(0, DIGEST_LENGTH);

  return {
    files: files.map((file) => ({
      ...file,
      fileName: `${BUNDLE_PREFIX}/${digest}/${file.name}`,
    })),
    url: `/${BUNDLE_PREFIX}/${digest}/${LOADER_NAME}`,
  };
}

export async function ivpAssets(command: 'build' | 'serve'): Promise<Plugin> {
  const assets = command === 'build' ? await readIvpAssets() : undefined;
  const loaderUrl = assets ? assets.url : DEV_LOADER_URL;

  return {
    name: 'original-ivp-production-assets',
    applyToEnvironment: (environment) => environment.name === 'client',
    config: () => ({
      define: { [DEFINE_KEY]: JSON.stringify(loaderUrl) },
    }),
    generateBundle() {
      if (!assets) return;
      for (const file of assets.files) {
        this.emitFile({ type: 'asset', fileName: file.fileName, source: file.source });
      }
    },
  };
}
