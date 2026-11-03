#!/usr/bin/env node
// Fail when a commit would contain original-game data or maintainer-local files.
// Generated assets belong under .local/ (served as /original), never in git.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

// A tracked file deleted from the working tree is absent from the next commit
// once the deletion is staged; it must not keep failing the pre-commit check.
const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(path => path && existsSync(path))

const forbidden = [
  [/^src\/game\/original-graphs\//, 'exported authored behavior graph'],
  [/^src\/game\/original-data-arrays\.json$/, 'extracted Data Array'],
  [/^docs\/.*-oracle\.json$/, 'generated behavior oracle'],
  [/^docs\/behavior-matrix\.md$/, 'generated behavior matrix'],
  [/^docs\/graph-coverage\.md$/, 'generated graph coverage'],
  [/^docs\/original-dll-recovery(-physics)?\.md$/, 'decompiled recovery listing'],
  [/^src\/harness\/behavior-matrix\.json$/, 'generated behavior matrix'],
  [/^tests\//, 'maintainer-local test'],
  [/^worker\//, 'maintainer-local worker'],
  [/^(wrangler\.jsonc|tsconfig\.worker\.json|worker-configuration\.d\.ts)$/, 'maintainer-local worker config'],
  [/^shareable\//, 'release copy'],
  [/^ballance-3d-stereo.*\.zip$/, 'release archive'],
  [/^public\/textures\//, 'extracted original texture'],
  [/^src\/assets\//, 'local asset'],
  [/^(?!vendor\/).*\.(nmo|cmo|dll|exe|iso)$/i, 'original game file'],
  [/^src\/game\/original-ui-data\.json$/, 'recovered UI text; load it from .local/original/ui-data.json'],
]

const errors = []
for (const path of tracked) {
  const match = forbidden.find(([pattern]) => pattern.test(path))
  if (match) errors.push(`${path}: ${match[1]}`)
}

if (errors.length > 0) {
  console.error('Repository hygiene check failed. Remove these from git:\n' + errors.map(error => `  ${error}`).join('\n'))
  process.exitCode = 1
} else {
  console.log(`Repository hygiene check passed (${tracked.length} tracked files).`)
}
