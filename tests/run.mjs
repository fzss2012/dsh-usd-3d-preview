/**
 * Run every test file in order and report.
 *
 * They are separate processes on purpose: `register` needs a `window` global to
 * evaluate the browser bundle, `parse` wants a clean three module graph, and the
 * browser suites each launch their own Chromium and must not share a page with
 * the offline suites.
 *
 * A suite that reports `SKIP` — the browser suites do that when Playwright is
 * not installed — is a failure here unless DSH_ALLOW_BROWSER_SKIP=1. A green
 * "all suites passed" line must mean the suites actually ran; silently skipping
 * the visual/behavioural suites is what this runner exists to prevent.
 *
 * Run: node tests/run.mjs   (or `npm test`)
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const SUITES = ['register', 'drop', 'parse', 's3', 'articulation', 'studio', 'articulation-render', 'render']
const ALLOW_SKIP = process.env.DSH_ALLOW_BROWSER_SKIP === '1'

/** Run one suite, teeing its output and reporting whether it skipped. */
function suite(name) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, `${name}.test.mjs`)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    const tee = (chunk, stream) => {
      output += chunk
      stream.write(chunk)
    }
    child.stdout.on('data', chunk => tee(chunk, process.stdout))
    child.stderr.on('data', chunk => tee(chunk, process.stderr))
    child.on('close', code => resolve({ code: code ?? 1, skipped: /\bSKIP\b/.test(output) }))
  })
}

const failed = []
const skipped = []
for (const name of SUITES) {
  process.stdout.write(`\n──── ${name} ────\n`)
  const result = await suite(name)
  if (result.code !== 0) failed.push(`${name} (exit ${result.code})`)
  else if (result.skipped) skipped.push(name)
}

if (failed.length > 0) {
  process.stderr.write(`\nFAILED: ${failed.join(', ')}\n`)
  process.exit(1)
}
if (skipped.length > 0 && !ALLOW_SKIP) {
  process.stderr.write(
    `\nFAILED: browser suites skipped: ${skipped.join(', ')}. `
    + 'Install Playwright + Chromium (see README), or set DSH_ALLOW_BROWSER_SKIP=1 to run the offline suites only.\n',
  )
  process.exit(1)
}
if (skipped.length > 0) {
  process.stdout.write(`\n${SUITES.length - skipped.length} suites passed; ${skipped.length} skipped (${skipped.join(', ')})\n`)
} else {
  process.stdout.write(`\nall ${SUITES.length} suites passed\n`)
}
