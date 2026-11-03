#!/usr/bin/env node
// Test entry point for both audiences.
//
// The maintainer test suite lives in the local-only tests/ directory, which is
// intentionally not tracked. The public package therefore has no tests, and a
// deliberate absence must not look like a broken checkout:
//   npm test              -> explicit notice, exit 0 when no tests are present
//   npm run test:local    -> requires the local suite, exit 1 when it is absent
// When tests/ exists both commands run the suite.
import { existsSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const requireLocal = process.argv.includes('--require-local')
const tests = existsSync('tests') ? readdirSync('tests').filter(name => name.endsWith('.test.ts')) : []
if (tests.length === 0) {
  if (requireLocal) {
    console.error('No local tests found: tests/ is missing or contains no *.test.ts files.')
    console.error('npm run test:local requires the maintainer suite, which is not part of the public source package.')
    process.exit(1)
  }
  console.log('No test suite is shipped in this public source package.')
  console.log('The maintainer tests live in the local-only tests/ directory, which is intentionally not tracked.')
  console.log('Public verification for this repository is `npm run lint` and `npm run build`; see README.md.')
  process.exit(0)
}
const result = spawnSync(process.execPath, ['--test', ...tests.map(name => `tests/${name}`)], { stdio: 'inherit' })
process.exit(result.status ?? 1)
