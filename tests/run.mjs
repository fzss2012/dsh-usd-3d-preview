/**
 * Run every test file in order and report.
 *
 * They are separate processes on purpose: `register` needs a `window` global to
 * evaluate the browser bundle, `parse` wants a clean three module graph, and the
 * browser suites each launch their own Chromium and must not share a page with
 * the offline suites.
 *
 * Run: node tests/run.mjs   (or `npm test`)
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SUITES = ['register', 'parse', 's3', 'articulation', 'studio', 'articulation-render', 'render']

/** Run one suite, inheriting stdio so its own reporting stays visible. */
function suite(name) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, `${name}.test.mjs`)], { stdio: 'inherit' })
    child.on('close', code => resolve(code ?? 1))
  })
}

const failed = []
for (const name of SUITES) {
  process.stdout.write(`\n──── ${name} ────\n`)
  const code = await suite(name)
  if (code !== 0) failed.push(`${name} (exit ${code})`)
}

if (failed.length > 0) {
  process.stderr.write(`\nFAILED: ${failed.join(', ')}\n`)
  process.exit(1)
}
process.stdout.write(`\nall ${SUITES.length} suites passed\n`)
