/**
 * The object-storage page, in a browser: location memory, short paths, and the
 * connection panel.
 *
 * The offline suites prove the request shapes and the revision helpers. What
 * they cannot prove is what a user sees: that switching tabs does not throw the
 * page back to the bucket root, that a versioned object is presented under its
 * short path with the newest revision behind it, and that the connection panel
 * is a form a person can read. The harness stubs the host half's routes, so this
 * suite needs no object storage, no credentials and no host server.
 *
 * Run: node tests/objstore-render.test.mjs
 */
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = join(root, 'tests', '.artifacts')

/** The two revisions the harness fixture carries; the newer one must win. */
const NEWER = '9ca318d6465fbcedf001152cc312a340cef497a5291f29d8951998aa3f13827d'
const OLDER = '0af13c2a7b9e4d6c8f5a1b3d2e4c6a8b0d2f4e6a8c0b2d4f6a8c0e2b4d6f8a0c'

/** Resolve Playwright from the usual places, in order. */
async function loadPlaywright() {
  const candidates = []
  if (process.env.PLAYWRIGHT_MODULE !== undefined) candidates.push(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href)
  candidates.push('playwright')
  candidates.push(pathToFileURL(join(root, 'node_modules', 'playwright', 'index.js')).href)
  for (const candidate of candidates) {
    try {
      const loaded = await import(candidate)
      const chromium = loaded.chromium ?? loaded.default?.chromium
      if (chromium !== undefined) return chromium
    } catch {
      // Not here; try the next location.
    }
  }
  return undefined
}

const chromium = await loadPlaywright()
if (chromium === undefined) {
  process.stdout.write(
    'objstore-render.test.mjs  SKIP  (Playwright/Chromium not available — '
    + 'run `npm install --no-save playwright && npx playwright install chromium` to enable)\n',
  )
  process.exit(0)
}

const work = await mkdtemp(join(tmpdir(), 'dsh-objstore-'))
const bundle = join(work, 'harness.js')
await build({
  entryPoints: [join(root, 'tests', 'objstore.harness.jsx')],
  bundle: true,
  outfile: bundle,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
})
const harness = await readFile(bundle)

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>objstore harness</title>
<style>html,body,#host{margin:0;height:100%;width:100%;background:#14161a}</style></head>
<body><div id="host"></div><script type="module" src="/harness.js"></script></body></html>`

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
    return
  }
  if (url.pathname === '/harness.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
    res.end(harness)
    return
  }
  res.writeHead(404).end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

await mkdir(artifacts, { recursive: true })
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })

/** Open the harness in a sidebar-sized page and collect uncaught errors. */
async function open() {
  const page = await browser.newPage({ viewport: { width: 380, height: 760 } })
  const errors = []
  page.on('pageerror', error => errors.push(error?.stack ?? String(error)))
  await page.goto(origin)
  await page.locator('[data-usd-objstore]').waitFor({ timeout: 30_000 })
  return { page, errors }
}

/** The listing calls the page has made so far, as prefixes. */
async function listedPrefixes(page) {
  return await page.evaluate(() => globalThis.__harness.calls
    .filter(call => call.url.startsWith('/api/usd-preview/list'))
    .map((call) => {
      const query = call.url.slice(call.url.indexOf('?') + 1)
      return new URLSearchParams(query).get('prefix')
    }))
}

try {
  const { page, errors } = await open()
  const shell = page.locator('[data-usd-objstore]')
  const rows = page.locator('[data-usd-objstore-entry]')

  // ── the connection, as a status line rather than a disclaimer ─────────────
  await rows.first().waitFor({ timeout: 30_000 })
  const status = await shell.innerText()
  assert.match(status, /s3:\/\/asset/, `the connection names its bucket\n${status}`)
  assert.match(status, /s3\.example\.com/, `the connection names its endpoint\n${status}`)
  assert.doesNotMatch(status, /never written to disk|never uploaded|stay in this page only/i,
    'the old credential disclaimer must be gone')
  assert.equal(await page.locator('text=Connect to object storage').count(), 0,
    'a connected page opens on the listing, not on the form')

  // ── the directory is the column's, not one mount's ────────────────────────
  await page.locator('[data-usd-objstore-entry="L0/CH/"] button').click()
  await page.locator('[data-usd-objstore-entry="L0/CH/readme.txt"]').waitFor({ timeout: 30_000 })
  assert.equal(await page.locator('[data-usd-objstore-entry="L0/CH/revisions/"]').count(), 0,
    'short mode hides the version tree')
  await page.screenshot({ path: join(artifacts, 'objstore-short-paths.png') })

  // The same directory after an unmount/remount (what a tab switch does).
  await page.evaluate(() => globalThis.__harness.remount())
  await page.locator('[data-usd-objstore-entry="L0/CH/readme.txt"]').waitFor({ timeout: 30_000 })
  const prefixes = await listedPrefixes(page)
  assert.equal(prefixes[0], '', 'the first mount starts at the configured root')
  assert.equal(prefixes.filter(prefix => prefix === '').length, 1, 'a remount does not reopen the root')
  assert.equal(prefixes.at(-1), 'L0/CH/', 'a remount reopens the directory the page was in')
  assert.equal(await page.getByRole('button', { name: 'CH', exact: true }).count(), 1,
    'the breadcrumb still names the directory after a remount')

  // ── version paths on demand ───────────────────────────────────────────────
  await page.getByRole('button', { name: 'Short path' }).click()
  await page.locator('[data-usd-objstore-entry="L0/CH/revisions/"]').waitFor({ timeout: 30_000 })
  await page.locator('[data-usd-objstore-entry="L0/CH/revisions/"] button').click()
  await page.locator(`[data-usd-objstore-entry="L0/CH/revisions/${NEWER}/"]`).waitFor({ timeout: 30_000 })
  assert.equal(await rows.count(), 2, 'version mode lists both revisions as folders')
  await page.screenshot({ path: join(artifacts, 'objstore-version-paths.png') })

  // ── search: one object, its newest revision, its short path ───────────────
  // Switching to short paths inside a revision directory shows that revision's
  // files under the asset's own path; the breadcrumb leads back to the asset.
  await page.getByRole('button', { name: 'Version path' }).click()
  await page.getByRole('button', { name: 'CH', exact: true }).click()
  await page.locator('[data-usd-objstore-entry="L0/CH/readme.txt"]').waitFor({ timeout: 30_000 })
  const search = page.locator('input[aria-label="Search files"]')
  await search.fill('gate')
  await page.locator('[data-usd-objstore-entry]').first().waitFor({ timeout: 30_000 })
  await page.waitForFunction(() => document.querySelectorAll('[data-usd-objstore-entry]').length === 1)
  const match = page.locator('[data-usd-objstore-entry]').first()
  assert.equal(await match.getAttribute('data-usd-objstore-entry'), `L0/CH/revisions/${NEWER}/gate.usda`,
    'the newest revision represents the object')
  assert.equal(await page.locator(`[data-usd-objstore-entry="L0/CH/revisions/${OLDER}/gate.usda"]`).count(), 0,
    'an older revision is not offered as a second object')
  const matchText = await match.innerText()
  assert.match(matchText, /gate\.usda/, 'the short path keeps the file name')
  assert.match(matchText, /#9ca318d/, `the row names the revision it reads\n${matchText}`)
  assert.match(matchText, /L0\/CH/, `the folder hint is the short path\n${matchText}`)
  assert.doesNotMatch(matchText, /revisions/, 'the version segment is not shown')
  await page.screenshot({ path: join(artifacts, 'objstore-short-search.png') })

  await page.getByRole('button', { name: 'Short path' }).click()
  await page.waitForFunction(() => document.querySelectorAll('[data-usd-objstore-entry]').length === 2)
  assert.equal(await page.locator('[data-usd-objstore-entry]').count(), 2,
    'version mode lists every revision the search found')
  await page.getByRole('button', { name: 'Version path' }).click()
  await search.fill('')

  // ── the form: labelled fields, a prefilled edit, and a way out ────────────
  await page.getByRole('button', { name: 'Edit' }).click()
  await page.getByText('Connect to object storage').waitFor({ timeout: 30_000 })
  for (const field of ['Endpoint', 'Bucket', 'Region', 'Root prefix', 'Access Key', 'Secret Key']) {
    assert.equal(await page.getByText(field, { exact: true }).count(), 1, `the form labels ${field}`)
  }
  assert.equal(await page.locator('input[placeholder="saved"]').count(), 1,
    'a stored secret is offered as a placeholder, never as a value')
  assert.equal(await page.locator('input[value="https://s3.example.com"]').count(), 1,
    'editing starts from the stored endpoint')
  await page.screenshot({ path: join(artifacts, 'objstore-connect.png') })
  await page.getByRole('button', { name: 'Cancel' }).click()
  assert.equal(await page.getByText('Connect to object storage').count(), 0, 'cancel closes the form')

  await page.getByRole('button', { name: 'Disconnect' }).click()
  await page.getByText('Connect to object storage').waitFor({ timeout: 30_000 })
  const calls = await page.evaluate(() => globalThis.__harness.calls
    .filter(call => call.url.startsWith('/api/usd-preview/objstore/config') && call.method === 'POST'))
  assert.equal(calls.at(-1)?.method, 'POST', 'disconnect talks to the connection route')
  assert.equal(JSON.parse(calls.at(-1).body).action, 'clear', 'disconnect clears the saved connection')
  assert.match(await shell.innerText(), /Saved on this machine/,
    'the panel says where a connection made here is kept')

  assert.deepEqual(errors, [], 'the object-storage page threw')
  process.stdout.write('objstore page  OK  (status line, location memory, short/version paths, form)\n')
  await page.close()
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
}
process.stdout.write('objstore-render.test.mjs  OK\n')
