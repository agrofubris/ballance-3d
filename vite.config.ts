import { existsSync } from 'node:fs'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import {ivpAssets} from './scripts/ivp-assets.ts'
import {localOriginalAssets} from './scripts/local-original-assets.ts'

// Development serves the local pack directly; the deploy script stages it after building.
// `vite build --mode rapier` leaves the unlicensed IVP module out of the bundle: the
// game then asks for an optional module at /ivp/ivp-simulation.mjs (the desktop app
// serves a player-built one from its IVP folder) and uses Rapier when there is none.
// The Cloudflare deploy plugin needs the maintainer's local wrangler.jsonc.
export default defineConfig(async ({command, mode})=>({
  plugins: [
    react(),
    ...(mode === 'rapier' ? [] : [await ivpAssets(command)]),
    localOriginalAssets(),
    ...(existsSync('wrangler.jsonc') ? [(await import('@cloudflare/vite-plugin')).cloudflare()] : []),
  ],
  // The Cloudflare plugin writes the client to dist/client; keep that layout without it.
  ...(existsSync('wrangler.jsonc') ? {} : { build: { outDir: 'dist/client' } }),
  ...(mode === 'rapier' ? { define: { 'import.meta.env.VITE_IVP_MODULE_URL': JSON.stringify('/ivp/ivp-simulation.mjs') } } : {}),
  // `.local/` holds the game pack, tools and unpacked tester builds (with their
  // own HTML entries); watching or dependency-scanning it reloads pages and can
  // stop the dev server.
  server: { watch: { ignored: ['**/.local/**'] } },
  optimizeDeps: { entries: ['harness.html', 'index.html'] },
}))
