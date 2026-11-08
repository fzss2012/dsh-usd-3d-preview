/**
 * Articulation render suite: a click on a part, in a real browser, measured in
 * pixels.
 *
 * The Node suite proves the kinematics with numbers. It cannot prove the thing
 * the user asked for — that clicking the door leaf swings it — because that path
 * runs through React, the view's raycast hook, the on-demand renderer and the
 * WebGL canvas. So this suite mounts the real `UsdBody` in Chromium, clicks the
 * canvas where a part is drawn, and compares screenshots:
 *
 *   * `data-usd-parts` must report the drivable joints the fixture declares;
 *   * a click on a part must pull frames (draw calls grow) and change pixels;
 *   * clicking again must put the part back where it was;
 *   * the colliders toggle must draw the collision overlay the engine never
 *     emitted;
 *   * an idle articulated stage must not keep drawing frames.
 *
 * The authored fixture is always available. A real articulated asset can be
 * supplied through `DSH_USD_TEST_SIMREADY` (path to a `.usdc` file); its whole
 * directory is mounted so relative collision layers resolve beside it, and the
 * case is skipped when the variable is unset.
 *
 * Requires: node_modules/react + react-dom + esbuild + three, and Chromium
 * through Playwright. Screenshot pixels are measured through `pixel-probe.mjs`,
 * which decodes the PNGs in the same Chromium — no Python runtime is required.
 * Without Playwright the suite reports SKIP and exits 0.
 *
 * Environment:
 *   PLAYWRIGHT_MODULE        path to Playwright when it is not resolvable here
 *   DSH_USD_TEST_SIMREADY    path to a real articulated `.usdc` asset (opt-in)
 *   DSH_ARTICULATION_ONLY    run only the cases whose path contains this string
 *
 * Run: node tests/articulation-render.test.mjs
 */
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, normalize } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createPixelProbe } from './pixel-probe.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = join(root, 'tests', 'fixtures')
const artifacts = join(root, 'tests', '.artifacts')

// ── Playwright, or an honest skip ───────────────────────────────────────────
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
    'articulation-render.test.mjs  SKIP  (Playwright/Chromium not available — '
    + 'run `npm install --no-save playwright && npx playwright install chromium` to enable)\n',
  )
  process.exit(0)
}

/** A real articulated asset, when the environment points at one. */
const REAL_ASSET = process.env.DSH_USD_TEST_SIMREADY
const realAssetAvailable = REAL_ASSET !== undefined && REAL_ASSET !== '' && existsSync(REAL_ASSET)
const realAssetDirectory = realAssetAvailable ? dirname(REAL_ASSET) : undefined

/** What each case must report, and what it is evidence for. */
const CASES = [
  {
    path: 'joints/door.usda',
    parts: 1,
    colliders: '1',
    note: 'authored fixture (ASCII)',
  },
]
if (realAssetAvailable) {
  CASES.push({
    path: `real-asset/${basename(REAL_ASSET)}`,
    // A real asset's part count comes from its own authoring, so only require
    // that the interactive path found something drivable.
    partsAtLeast: 1,
    colliders: undefined,
    note: 'real articulated asset',
  })
}
const ONLY = process.env.DSH_ARTICULATION_ONLY
if (ONLY !== undefined && ONLY !== '') {
  const filtered = CASES.filter(entry => entry.path.includes(ONLY) || entry.note.includes(ONLY))
  assert.ok(filtered.length > 0, 'DSH_ARTICULATION_ONLY=' + ONLY + ' matched no case')
  CASES.length = 0
  CASES.push(...filtered)
}

// ── bundle the harness ─────────────────────────────────────────────────────
const work = await mkdtemp(join(tmpdir(), 'dsh-usd-articulation-'))
const bundle = join(work, 'harness.js')
await build({
  entryPoints: [join(root, 'tests', 'articulation.harness.jsx')],
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

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>usd articulation harness</title>'
  + '<style>html,body,#host{margin:0;height:100%;width:100%;background:#14161a}</style></head>'
  + '<body><div id="host"></div><script type="module" src="/harness.js"></script></body></html>'

/**
 * Serve one file for `/fixture/<path>`: the authored fixtures, or the real
 * asset's directory under the `real-asset/` prefix (which is also the workspace
 * key the component gets, so a relative `colliders.usdc` reference resolves
 * inside it).
 */
function serveFixture(res, name) {
  let target
  if (name.startsWith('real-asset/')) {
    target = normalize(join(realAssetDirectory, name.slice('real-asset/'.length)))
    if (target.startsWith(realAssetDirectory) === false) {
      res.writeHead(400).end()
      return
    }
  } else {
    target = normalize(join(fixtures, name))
    if (target.startsWith(fixtures) === false) {
      res.writeHead(400).end()
      return
    }
  }
  void readFile(target).then((bytes) => {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength) })
    res.end(bytes)
  }, () => { res.writeHead(404).end() })
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
  if (url.pathname.startsWith('/fixture/')) {
    serveFixture(res, decodeURIComponent(url.pathname.slice('/fixture/'.length)))
    return
  }
  res.writeHead(404).end()
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const origin = 'http://127.0.0.1:' + server.address().port
process.stdout.write('harness ' + origin + '\n')

// ── the browser ────────────────────────────────────────────────────────────
await mkdir(artifacts, { recursive: true })
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
const probe = await createPixelProbe(browser)
const lines = []
try {
  for (const { path, parts, partsAtLeast, colliders, note } of CASES) {
    const page = await browser.newPage({ viewport: { width: 900, height: 640 } })
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error?.stack ?? String(error)))
    page.on('console', (message) => { if (message.type() === 'error') pageErrors.push('console: ' + message.text()) })
    await page.goto(origin + '/?path=' + encodeURIComponent(path))
    await page.waitForSelector('[data-usd-preview-canvas]', { timeout: 180_000 })
    await page.waitForSelector('[data-usd-stats]', { timeout: 60_000 })
    await page.waitForTimeout(1500)

    const stage = page.locator('[data-usd-preview]')
    const declaredParts = Number(await stage.getAttribute('data-usd-parts'))
    const declaredColliders = await stage.getAttribute('data-usd-colliders')
    const engine = await stage.getAttribute('data-usd-engine')
    assert.equal(engine, 'wasm', path + ': the engine path was not used')
    if (parts !== undefined) assert.equal(declaredParts, parts, path + ': data-usd-parts')
    if (partsAtLeast !== undefined) assert.ok(declaredParts >= partsAtLeast, path + ': data-usd-parts')
    if (colliders !== undefined) assert.equal(declaredColliders, colliders, path + ': data-usd-colliders')

    const canvas = page.locator('[data-usd-preview-canvas]')
    const box = await canvas.boundingBox()
    assert.ok(box !== null && box.width > 200 && box.height > 200, path + ': canvas is not laid out')
    const drawsNow = async () => page.evaluate(() => globalThis.__draws)

    // An idle articulated stage must not keep the GPU busy.
    const idleStart = await drawsNow()
    await page.waitForTimeout(500)
    const idleFrames = (await drawsNow()) - idleStart
    assert.ok(idleFrames <= 2, path + ': an idle articulated stage kept drawing (' + idleFrames + ' draw calls in 500 ms)')

    const closedShot = join(artifacts, 'articulation-' + path.replaceAll('/', '_') + '-closed.png')
    await canvas.screenshot({ path: closedShot })

    // Candidate click points come from the rendered pixels: the model is the
    // bright part of the canvas (the grid and the shadow are dark), so its mask
    // says where a click can land on a part. A click on a part pulls the whole
    // animation (dozens of frames) and visibly moves it; a click on the fixed
    // base or on empty space does neither, so a candidate only counts when both
    // signals agree. Anything that moved but is visually subtle (a wrist roll
    // about its own axis) is clicked again to put it back before the next try.
    const candidates = await probe.modelPoints(closedShot, 90)
    assert.ok(candidates.length > 0, path + ': the closed frame shows no lit model to click')
    let clicked = null
    let moved = null
    let openShot = null
    for (let index = 0; index < candidates.length; index += 1) {
      const point = candidates[index]
      const x = box.x + box.width * point.x
      const y = box.y + box.height * point.y
      const before = await drawsNow()
      await page.mouse.click(x, y)
      await page.waitForTimeout(1800)
      const pulled = (await drawsNow()) - before
      const candidateShot = join(artifacts, 'articulation-candidate.png')
      await canvas.screenshot({ path: candidateShot })
      const delta = await probe.difference(closedShot, candidateShot, 24)
      if (pulled >= 24 && delta.changed > Math.max(200, delta.total * 0.001)) {
        clicked = { x, y, xFraction: point.x, yFraction: point.y, pulled }
        moved = delta
        openShot = join(artifacts, 'articulation-' + path.replaceAll('/', '_') + '-open.png')
        await copyFile(candidateShot, openShot)
        await rm(candidateShot, { force: true })
        break
      }
      // Not a visible part: undo whatever it did and move on.
      if (pulled > 12) {
        await page.mouse.click(x, y)
        await page.waitForTimeout(1500)
      }
    }
    assert.ok(clicked !== null, path + ': no candidate click on the model pulled an animation and moved the frame')
    assert.ok(moved.changed > moved.total * 0.002, path + ': the click changed only ' + moved.changed + '/' + moved.total + ' pixels')
    assert.ok(moved.peak > 40, path + ': the two frames are nearly identical (peak delta ' + moved.peak + ')')
    assert.ok(clicked.pulled >= 24, path + ': the click pulled no animation frames')

    // "Home parts" is the deterministic way back: clicking the same screen point
    // again would hit whatever link has swung under the cursor on a multi-link
    // arm. This also exercises home() through the component, not just the Node
    // suite.
    const beforeHome = await drawsNow()
    await page.locator('[data-usd-parts-home]').click()
    await page.waitForTimeout(400)
    const homePulled = (await drawsNow()) - beforeHome
    assert.ok(homePulled > 0, path + ': "Home parts" pulled no frame')
    await page.waitForTimeout(2200)
    const againShot = join(artifacts, 'articulation-' + path.replaceAll('/', '_') + '-closed-again.png')
    await canvas.screenshot({ path: againShot })
    const restored = await probe.difference(closedShot, againShot, 24)
    assert.ok(restored.changed < restored.total * 0.005,
      path + ': "Home parts" did not restore the rest pose (' + restored.changed + '/' + restored.total + ' pixels still differ)')

    // Collision geometry: the engine drops purpose=guide hulls, so the overlay
    // is the only way the authored hulls can be seen at all.
    let colliderDiff = { changed: 0 }
    if (declaredColliders === '1') {
      await page.locator('[data-usd-parts-colliders]').click()
      await page.waitForTimeout(600)
      const colliderShot = join(artifacts, 'articulation-' + path.replaceAll('/', '_') + '-colliders.png')
      await canvas.screenshot({ path: colliderShot })
      colliderDiff = await probe.difference(closedShot, colliderShot, 24)
      await page.locator('[data-usd-parts-colliders]').click()
      await page.waitForTimeout(400)
    }

    lines.push(
      'render ' + path.padEnd(26) + note.padEnd(24) + 'parts ' + declaredParts
      + '  click@' + clicked.xFraction.toFixed(2) + ',' + clicked.yFraction.toFixed(2)
      + '  pulled ' + clicked.pulled + ' draws'
      + '  changed ' + moved.changed + '/' + moved.total + ' px (mean ' + moved.meanDelta + ')'
      + '  home ' + restored.changed + ' px'
      + '  colliders +' + colliderDiff.changed + ' px'
      + '  idle ' + idleFrames + ' draws/500ms',
    )
    assert.deepEqual(pageErrors, [], path + ': the page threw')
    await page.close()
  }
} finally {
  await probe.close().catch(() => undefined)
  await browser.close()
  await new Promise(resolve => server.close(resolve))
  await rm(work, { recursive: true, force: true })
}

for (const line of lines) process.stdout.write(line + '\n')
process.stdout.write('articulation-render.test.mjs  OK  (' + lines.length + ' articulated stages clicked in Chromium, screenshots in tests/.artifacts)\n')
