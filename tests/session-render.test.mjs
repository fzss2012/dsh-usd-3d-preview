/**
 * Render test: a modeling-session archive in a real browser.
 *
 * The offline suite proves the archive reader in Node. This suite proves the
 * claim the whole integration exists for: a `session.json` turns into the
 * ordinary USD viewport showing the archive's **newest** snapshot, with a panel
 * stating the session id, revision and newest commit's object summary — and an
 * older archive without `snapshots/` says so instead of failing.
 *
 * The harness mounts the real `SessionBody`; composition, the viewport, the
 * studio rig and the stats line are the USD preview's production code. The test
 * server stands in for the workspace Remote behind the same reader contract.
 *
 * Requirements: `npm install`, and Playwright with its Chromium downloaded (not
 * a package dependency because most of the suite is offline):
 *
 *     npm install --no-save playwright
 *     npx playwright install chromium
 *
 * Run: node tests/session-render.test.mjs
 */
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, normalize, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createPixelProbe } from './pixel-probe.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = join(root, 'tests', 'fixtures')
const artifacts = join(root, 'tests', '.artifacts')

/**
 * Resolve Playwright from the usual places, in order.
 * @returns the chromium launcher, or undefined when Playwright is not installed.
 */
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
    'session-render.test.mjs  SKIP  (Playwright/Chromium not available — '
    + 'run `npm install --no-save playwright && npx playwright install chromium` to enable)\n',
  )
  process.exit(0)
}

// ── the harness page, bundled for the browser ───────────────────────────────
const work = await mkdtemp(join(tmpdir(), 'dsh-usd-session-render-'))
const bundle = join(work, 'harness.js')
await build({
  entryPoints: [join(root, 'tests', 'session.harness.jsx')],
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

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>usd session harness</title>
<style>html,body,#host{margin:0;height:100%;width:100%;background:#14161a}</style></head>
<body><div id="host"></div><script type="module" src="/harness.js"></script></body></html>`

/** Resolve one fixture path, refusing anything outside the fixtures directory. */
function fixturePath(name) {
  const target = normalize(join(fixtures, name))
  return target === fixtures || target.startsWith(fixtures + sep) ? target : undefined
}

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
  if (url.pathname === '/list') {
    const name = url.searchParams.get('path') ?? ''
    const target = fixturePath(name)
    if (target === undefined) {
      res.writeHead(400).end()
      return
    }
    void readdir(target, { withFileTypes: true }).then((children) => {
      const entries = children.map(child => ({
        name: child.name,
        type: child.isDirectory() ? 'directory' : 'file',
      }))
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ path: name, entries, truncated: false }))
    }, () => { res.writeHead(404).end() })
    return
  }
  if (url.pathname.startsWith('/fixture/')) {
    const name = decodeURIComponent(url.pathname.slice('/fixture/'.length))
    const target = fixturePath(name)
    if (target === undefined) {
      res.writeHead(400).end()
      return
    }
    void readFile(target).then((bytes) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength) })
      res.end(bytes)
    }, () => { res.writeHead(404).end() })
    return
  }
  res.writeHead(404).end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`
process.stdout.write(`harness ${origin}\n`)

// ── the browser ─────────────────────────────────────────────────────────────
await mkdir(artifacts, { recursive: true })
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
const probe = await createPixelProbe(browser)
const results = []
try {
  // ── the newest snapshot of a full archive ─────────────────────────────────
  const page = await browser.newPage({ viewport: { width: 900, height: 640 } })
  const pageErrors = []
  page.on('pageerror', error => pageErrors.push(error?.stack ?? String(error)))
  await page.goto(`${origin}/?archive=session`)
  await page.locator('[data-session-panel]').waitFor({ timeout: 60_000 })
  await page.locator('[data-usd-stats]').waitFor({ timeout: 120_000 })
  await page.waitForTimeout(1200)

  assert.equal(await page.locator('[data-session-archive]').getAttribute('data-session-state'), 'ready')
  const panel = page.locator('[data-session-panel]')
  assert.equal(await panel.getAttribute('data-session-id'), 'fixture-session')
  assert.equal(await panel.getAttribute('data-session-model-rev'), '2', 'the newest commit revision is the model revision')
  assert.equal(await panel.getAttribute('data-session-snapshot-rev'), '2', 'the newest snapshot is what is drawn')
  assert.equal(await panel.getAttribute('data-session-objects'), '2', 'the summary counts the newest commit\'s objects')
  assert.equal(await panel.getAttribute('data-session-warnings'), '0')
  const panelTitle = await panel.getAttribute('title')
  assert.match(panelTitle, /archive v1/, `the panel tooltip must name the archive format:\n${panelTitle}`)
  assert.match(panelTitle, /protocol v1/)
  assert.match(panelTitle, /smlib-gui-1\.0\.2/, `the panel tooltip must carry the build identity:\n${panelTitle}`)
  const panelText = await panel.innerText()
  assert.match(panelText, /modeling session/i, `the panel must name itself without a dictionary:\n${panelText}`)
  assert.match(panelText, /fixture-session/)
  assert.match(panelText, /model_rev/)
  assert.match(panelText, /objects/)
  // The counts come from the newest commit record: rev 2 declares two objects.
  assert.match(panelText, /faces\s*8/, `the panel must show the summary's face count:\n${panelText}`)
  assert.match(panelText, /vertices\s*13/)

  // The snapshot is drawn by the existing viewport, from the newest snapshot:
  // rev 1 holds one mesh, rev 2 two, so "Meshes: 2" is the revision choice made
  // visible in the stats line.
  const stats = await page.locator('[data-usd-stats]').innerText()
  assert.match(stats, /Meshes: 2/, `the newest snapshot must be assembled\n${stats}`)
  assert.match(stats, /Engine: OpenUSD/, `the snapshot must compose through the WASM engine\n${stats}`)
  assert.match(stats, /Container: usda/)
  assert.ok(await page.locator('[data-usd-preview]').count() === 1, 'the viewport body is mounted')

  const canvas = page.locator('[data-usd-preview-canvas]')
  const box = await canvas.boundingBox()
  assert.ok(box !== null && box.width > 100 && box.height > 100, 'the snapshot canvas is laid out')
  const shot = join(artifacts, 'session-archive.png')
  await page.screenshot({ path: shot })
  results.push({ name: 'session', stats, shot })
  assert.deepEqual(pageErrors, [], 'the session preview threw')
  await page.close()

  // ── the same archive as a dropped folder ──────────────────────────────────
  // No Session and no reader: the snapshot and record must come from the drop's
  // own file table, keyed by the folder-relative paths collectDropped produces.
  const dropped = await browser.newPage({ viewport: { width: 900, height: 640 } })
  const droppedErrors = []
  dropped.on('pageerror', error => droppedErrors.push(error?.stack ?? String(error)))
  await dropped.goto(`${origin}/?archive=session&drop=1`)
  await dropped.locator('[data-session-panel]').waitFor({ timeout: 60_000 })
  await dropped.locator('[data-usd-stats]').waitFor({ timeout: 120_000 })
  await dropped.waitForTimeout(1200)
  assert.equal(await dropped.locator('[data-session-archive]').getAttribute('data-session-state'), 'ready')
  const droppedPanel = dropped.locator('[data-session-panel]')
  assert.equal(await droppedPanel.getAttribute('data-session-id'), 'fixture-session')
  assert.equal(await droppedPanel.getAttribute('data-session-model-rev'), '2')
  assert.equal(await droppedPanel.getAttribute('data-session-objects'), '2')
  const droppedKeys = await dropped.evaluate(() => globalThis.__harness.keys)
  assert.ok(droppedKeys.includes('session/session.json'), `the drop table carries the manifest: ${droppedKeys.join(', ')}`)
  assert.ok(droppedKeys.includes('session/snapshots/00000000000000000002.usda'), 'the drop table carries every snapshot')
  assert.ok(droppedKeys.includes('session/commits/00000000000000000002.json'), 'the drop table carries every record')
  const droppedStats = await dropped.locator('[data-usd-stats]').innerText()
  assert.match(droppedStats, /Meshes: 2/, `the dropped archive must draw its newest snapshot\n${droppedStats}`)
  const droppedShot = join(artifacts, 'session-archive-dropped.png')
  await dropped.screenshot({ path: droppedShot })
  results.push({ name: 'session-dropped', stats: droppedStats, shot: droppedShot })
  assert.deepEqual(droppedErrors, [], 'the dropped archive threw')
  await dropped.close()

  // ── an older archive: no snapshots folder ─────────────────────────────────
  const older = await browser.newPage({ viewport: { width: 900, height: 640 } })
  const olderErrors = []
  older.on('pageerror', error => olderErrors.push(error?.stack ?? String(error)))
  await older.goto(`${origin}/?archive=session-nosnap`)
  await older.locator('[data-session-panel]').waitFor({ timeout: 60_000 })
  await older.waitForTimeout(400)
  assert.equal(await older.locator('[data-session-archive]').getAttribute('data-session-state'), 'no-snapshot')
  const olderPanel = older.locator('[data-session-panel]')
  assert.equal(await olderPanel.getAttribute('data-session-id'), 'older-session')
  assert.equal(await olderPanel.getAttribute('data-session-model-rev'), '1')
  assert.equal(await olderPanel.getAttribute('data-session-objects'), '1')
  assert.equal(await olderPanel.getAttribute('data-session-warnings'), '1')
  const olderText = await olderPanel.innerText()
  assert.match(olderText, /snapshots\//, `the warning must name the missing folder:\n${olderText}`)
  assert.equal(await older.locator('[data-usd-stats]').count(), 0, 'there is no viewport without a snapshot')
  assert.equal(await older.locator('[data-session-no-snapshot]').count(), 1, 'the empty state explains itself')
  const olderShot = join(artifacts, 'session-archive-no-snapshot.png')
  await older.screenshot({ path: olderShot })
  results.push({ name: 'session-nosnap', stats: olderText, shot: olderShot })
  assert.deepEqual(olderErrors, [], 'the older archive threw')
  await older.close()

  // ── the frame is not a flat surface ───────────────────────────────────────
  // A viewport that failed to draw is one flat background colour. The full
  // archive's snapshot must be a lit, shaded model on the grid, like every USD
  // preview this body reuses.
  const full = results.find(entry => entry.name === 'session')
  const colours = await probe.colours(full.shot)
  assert.ok(colours.distinct > 50, `only ${colours.distinct} distinct colours — nothing was drawn`)
  assert.ok(colours.dominant < colours.total * 0.98, `${colours.dominant}/${colours.total} pixels are one colour — nothing was drawn`)
  process.stdout.write(
    `session  full archive  ${String(colours.distinct).padStart(6)} colours  ${full.stats.replaceAll('\n', ' | ')}\n`,
  )
  process.stdout.write(`session  older archive ${results.find(entry => entry.name === 'session-nosnap').stats.replaceAll('\n', ' | ')}\n`)
  process.stdout.write('session-render.test.mjs  OK  (newest snapshot drawn from the workspace and from a dropped folder, panel summary read, older archive explained)\n')
} finally {
  await probe.close().catch(() => undefined)
  await browser.close()
  await new Promise(resolve => server.close(resolve))
  await rm(work, { recursive: true, force: true })
}
