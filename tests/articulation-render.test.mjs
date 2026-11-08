/**
 * Articulation render suite: joint interaction in a real browser, measured in
 * pixels and asserted through the DOM.
 *
 * The Node suite proves the kinematics with numbers. It cannot prove the thing
 * the user asked for — that clicking a part swings/slides it — because that path
 * runs through React, the view's raycast hook, the on-demand renderer and the
 * WebGL canvas. So this suite mounts the real `UsdBody` in Chromium, finds the
 * part under the cursor from the rendered pixels, clicks it, and checks both the
 * DOM state and the frames:
 *
 *   * `data-usd-parts` / `data-usd-colliders` report the authored structure;
 *   * a click on a part pulls draw calls and changes pixels; a click on empty
 *     space or a fixed body changes nothing;
 *   * Home restores the rest pose (pixel diff ~ 0), including mid-animation;
 *   * All open / All close change the button label and the frame, then restore;
 *   * the colliders toggle draws the collision overlay the engine never emitted;
 *   * separate parts are driven independently (the two-part mixed fixture);
 *   * rapid repeated clicks leave a consistent state and do not throw;
 *   * an idle articulated stage does not keep drawing frames.
 *
 * Every interaction step leaves a screenshot in `tests/.artifacts`, so the
 * evidence for a review is the sequence `articulation-<fixture>-stepNN-*.png`
 * for each fixture.
 *
 * Fixtures:
 *   joints/door.usda   one revolute joint, one collision hull
 *   joints/mixed.usda  revolute + prismatic drivable, fixed joint, one hull
 *   joints/chain.usda  two revolute joints in a parent/child chain
 *
 * A real articulated asset can be supplied through `DSH_USD_TEST_SIMREADY`
 * (path to a `.usdc` file); its whole directory is mounted so relative collision
 * layers resolve beside it, and the case is skipped when the variable is unset.
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
import { mkdir, mkdtemp, readdir, readFile, rm, unlink } from 'node:fs/promises'
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

/** What each case must report, and which interaction script proves it. */
const CASES = [
  {
    path: 'joints/door.usda',
    parts: 1,
    colliders: '1',
    interaction: 'revolute',
    note: 'one revolute joint',
  },
  {
    path: 'joints/mixed.usda',
    parts: 2,
    colliders: '1',
    interaction: 'mixed',
    note: 'revolute + prismatic + fixed',
  },
  {
    path: 'joints/chain.usda',
    parts: 2,
    colliders: '0',
    interaction: 'chain',
    note: 'two-joint chain',
  },
]
if (realAssetAvailable) {
  CASES.push({
    path: `real-asset/${basename(REAL_ASSET)}`,
    // A real asset's part count comes from its own authoring, so only require
    // that the interactive path found something drivable.
    partsAtLeast: 1,
    colliders: undefined,
    interaction: 'real',
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
// The evidence sequence is regenerated per run: stale step shots from an older
// run would make the numbering ambiguous.
for (const name of await readdir(artifacts)) {
  if (name.startsWith('articulation-')) await unlink(join(artifacts, name)).catch(() => undefined)
}
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
const probe = await createPixelProbe(browser)
/** A blank page that decodes screenshots for the luma/cluster analysis. */
const analysis = await browser.newPage({ viewport: { width: 120, height: 120 } })
await analysis.goto('about:blank')
const lines = []

// ── pixel helpers ──────────────────────────────────────────────────────────
/**
 * Decode one screenshot in Chromium and return the luma-mask point cloud as
 * k-means cluster centroids (in canvas fractions), ordered left to right.
 * The mask is the lit model; the grid and the shadow are far dimmer.
 * @param shot - screenshot path.
 * @param k - how many clusters to fit.
 * @returns {{x:number,y:number,pixels:number}[]} centroids with their mask size.
 */
async function maskClusters(shot, k) {
  const bytes = await readFile(shot)
  const dataUrl = `data:image/png;base64,${bytes.toString('base64')}`
  return analysis.evaluate(async ({ url, k }) => {
    const blob = await (await fetch(url)).blob()
    const bitmap = await createImageBitmap(blob)
    const width = bitmap.width
    const height = bitmap.height
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    context.drawImage(bitmap, 0, 0)
    const data = context.getImageData(0, 0, width, height).data
    const points = []
    for (let index = 0; index < data.length; index += 4) {
      const luma = 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2]
      if (luma <= 90) continue
      const pixel = index / 4
      points.push([pixel % width, Math.floor(pixel / width)])
    }
    if (points.length < 500) return []
    // Deterministic k-means: seed with the leftmost point, then the point
    // farthest from every seed so far, then plain Lloyd iterations.
    const centers = [points[0]]
    while (centers.length < k) {
      let best = points[0]
      let bestDistance = -1
      for (const point of points) {
        let nearest = Infinity
        for (const center of centers) {
          const dx = point[0] - center[0]
          const dy = point[1] - center[1]
          nearest = Math.min(nearest, dx * dx + dy * dy)
        }
        if (nearest > bestDistance) {
          bestDistance = nearest
          best = point
        }
      }
      centers.push(best)
    }
    const assign = () => {
      const sums = centers.map(() => [0, 0, 0])
      for (const point of points) {
        let best = 0
        let bestDistance = Infinity
        for (let index = 0; index < centers.length; index += 1) {
          const dx = point[0] - centers[index][0]
          const dy = point[1] - centers[index][1]
          const distance = dx * dx + dy * dy
          if (distance < bestDistance) {
            bestDistance = distance
            best = index
          }
        }
        sums[best][0] += point[0]
        sums[best][1] += point[1]
        sums[best][2] += 1
      }
      for (let index = 0; index < centers.length; index += 1) {
        if (sums[index][2] === 0) continue
        centers[index] = [sums[index][0] / sums[index][2], sums[index][1] / sums[index][2]]
      }
      return sums
    }
    let sums = assign()
    for (let iteration = 0; iteration < 12; iteration += 1) sums = assign()
    return centers
      .map((center, index) => ({
        x: Math.round((center[0] / width) * 10000) / 10000,
        y: Math.round((center[1] / height) * 10000) / 10000,
        pixels: sums[index][2],
      }))
      .filter(cluster => cluster.pixels >= 250)
      .sort((left, right) => left.x - right.x)
  }, { url: dataUrl, k })
}

/** Wait until the draw-call counter has been unchanged for two polls. */
async function waitSettled(page, timeoutMs = 15_000) {
  const started = Date.now()
  let last = await page.evaluate(() => globalThis.__draws)
  let quiet = 0
  while (Date.now() - started < timeoutMs) {
    await page.waitForTimeout(200)
    const now = await page.evaluate(() => globalThis.__draws)
    if (now === last) {
      quiet += 1
      if (quiet >= 2) return now
    } else {
      quiet = 0
      last = now
    }
  }
  throw new Error('the animation never settled')
}

/**
 * The document seat paints its toolbar, hint and stats above the canvas, so an
 * element screenshot would contain that text. Hide every non-canvas child for
 * the duration of a screenshot: what the pixels are then is only the 3D frame,
 * which is what the luma analysis and the evidence sequence are about.
 */
async function installOverlayHider(page) {
  await page.evaluate(() => {
    const style = document.createElement('style')
    style.id = 'usd-test-overlay-hider'
    style.textContent = ''
    document.head.appendChild(style)
  })
}

/** Hide the DOM overlays above the canvas, or bring them back. */
async function setOverlaysHidden(page, hidden) {
  await page.evaluate((hide) => {
    const style = document.getElementById('usd-test-overlay-hider')
    style.textContent = hide === true
      ? '[data-usd-preview] > div:not([data-usd-preview-stage]) { visibility: hidden !important }'
      : ''
  }, hidden)
}

/** The read-only per-case context: page, canvas box, screenshot names. */
function makeContext(page, path) {
  const canvas = page.locator('[data-usd-preview-canvas]')
  const prefix = path.replaceAll('/', '_')
  let step = 0
  /** screenshot the canvas and return its path, numbered for the evidence trail. */
  const snap = async (label) => {
    step += 1
    const file = join(artifacts, `articulation-${prefix}-step${String(step).padStart(2, '0')}-${label}.png`)
    await setOverlaysHidden(page, true)
    try {
      await canvas.screenshot({ path: file })
    } finally {
      await setOverlaysHidden(page, false)
    }
    return file
  }
  return { page, canvas, prefix, snap, draws: () => page.evaluate(() => globalThis.__draws) }
}

/**
 * Click one fractional canvas point and wait for the resulting animation.
 *
 * A pointer press/release repaints once even when it hits nothing, so "did this
 * click drive a joint" is decided by a fixed observation window: every joint has
 * a travel time of at least 0.6 s, so a real animation is still drawing frames a
 * second after the click, while a static repaint is over in one frame.
 * @returns whether a joint animation started, and the draws it pulled.
 */
async function clickAndWait(context, point, waitMs = 3000) {
  // One pointer repaint is a handful of draw calls; an animation lasts at least
  // 0.6 s of frames, so it keeps adding draw calls through the observation
  // window. This is a count, not a frame rate.
  const ANIMATION_DRAWS = 12
  const box = await context.canvas.boundingBox()
  const before = await context.draws()
  await context.page.mouse.click(box.x + box.width * point.x, box.y + box.height * point.y)
  await context.page.waitForTimeout(1000)
  const observed = (await context.draws()) - before
  const animated = observed >= ANIMATION_DRAWS
  if (animated === true) await waitSettled(context.page, waitMs)
  return { animated, pulled: (await context.draws()) - before }
}

/** Click a toolbar control by its data attribute. */
async function clickControl(context, attribute) {
  await context.page.locator(`[${attribute}]`).click()
}

/** The button text of the All open/All close toggle. */
async function allLabel(context) {
  return (await context.page.locator('[data-usd-parts-toggle]').innerText()).trim()
}

/** Wait until the All open/All close label is the expected word pair. */
async function waitAllLabel(context, expected) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await allLabel(context)) === expected) return
    await context.page.waitForTimeout(100)
  }
  assert.fail('the All open/All close button never read "' + expected + '"')
}

// ── per-fixture interaction scripts ────────────────────────────────────────

/**
 * A single revolute joint: click open, click the part's new position to close,
 * Home (also mid-animation), All open/All close, colliders, and a blank click.
 */
async function runRevolute(context, state) {
  const { page, snap } = context
  const { closed, declaredParts, declaredColliders } = state
  let restoredChecks = 0
  const expectRestored = async (label) => {
    const shot = await snap(label)
    const delta = await probe.difference(closed, shot, 24)
    assert.ok(delta.changed < delta.total * 0.005,
      label + ': the rest pose was not restored (' + delta.changed + '/' + delta.total + ' pixels differ)')
    restoredChecks += 1
  }
  /** Click a point found from the current frame; return whether it animated. */
  const clickPart = async (sourceShot, label) => {
    const candidates = await probe.modelPoints(sourceShot, 90)
    assert.ok(candidates.length > 0, label + ': no lit model to click')
    for (const point of candidates) {
      const result = await clickAndWait(context, point)
      if (result.animated === true) return { point, pulled: result.pulled }
    }
    return undefined
  }

  // 1. click the part -> open, pixels change.
  const open = await clickPart(closed, 'door open')
  assert.ok(open !== undefined, 'doors: no candidate click on the model pulled an animation')
  const openShot = await snap('part-click-open')
  const opened = await probe.difference(closed, openShot, 24)
  assert.ok(opened.changed > opened.total * 0.002, 'door: the part click changed only ' + opened.changed + ' pixels')
  assert.ok(opened.peak > 40, 'door: the click frames are nearly identical (peak delta ' + opened.peak + ')')
  assert.ok(open.pulled >= 12, 'door: the click pulled only ' + open.pulled + ' draw calls')

  // 2. clicking the part in its new position closes it again.
  const closedAgain = await clickPart(openShot, 'door close')
  assert.ok(closedAgain !== undefined, 'door: no candidate click on the moved model pulled an animation')
  await expectRestored('part-click-close')

  // 3. Home restores the rest pose deterministically.
  const openedAgain = await clickPart(closed, 'door home setup')
  assert.ok(openedAgain !== undefined, 'door: the setup click did not open the part')
  await clickControl(context, 'data-usd-parts-home')
  await waitSettled(page)
  await expectRestored('home-restored')

  // 4. Home interrupts the swing mid-animation.
  const midOpen = await clickPart(closed, 'door home mid-animation setup')
  assert.ok(midOpen !== undefined, 'door: the mid-animation setup click did not open the part')
  await page.waitForTimeout(150)
  await clickControl(context, 'data-usd-parts-home')
  await waitSettled(page)
  await expectRestored('home-mid-animation')

  // 5. All open -> the label flips to Close all and the frame moves; All close
  //    flips it back and restores the rest pose.
  assert.equal(await allLabel(context), 'Open all', 'door: the initial All label is not "Open all"')
  await clickControl(context, 'data-usd-parts-toggle')
  await waitAllLabel(context, 'Close all')
  await waitSettled(page)
  const allOpenShot = await snap('all-open')
  const allOpen = await probe.difference(closed, allOpenShot, 24)
  assert.ok(allOpen.changed > allOpen.total * 0.002, 'door: All open changed only ' + allOpen.changed + ' pixels')
  await clickControl(context, 'data-usd-parts-toggle')
  await waitAllLabel(context, 'Open all')
  await waitSettled(page)
  await expectRestored('all-close')

  // 6. Colliders: the overlay is the only way the authored hull can be seen;
  //    toggling it off has to return to the same baseline.
  if (declaredColliders === '1') {
    await clickControl(context, 'data-usd-parts-colliders')
    await page.waitForTimeout(700)
    const colliderShot = await snap('colliders-on')
    const colliderDiff = await probe.difference(closed, colliderShot, 24)
    assert.ok(colliderDiff.changed > 100, 'door: the colliders toggle changed only ' + colliderDiff.changed + ' pixels')
    await clickControl(context, 'data-usd-parts-colliders')
    await page.waitForTimeout(700)
    await expectRestored('colliders-off')
    state.colliderDiff = colliderDiff
  }

  // 7. A blank click on the corner changes nothing: no draws, same pixels, same
  //    DOM structure.
  await waitSettled(page)
  const drawsBefore = await context.draws()
  const beforeBlank = await snap('blank-before')
  const box = await context.canvas.boundingBox()
  await page.mouse.click(box.x + 6, box.y + box.height - 6)
  await page.waitForTimeout(500)
  await waitSettled(page).catch(() => undefined)
  const blankPulled = (await context.draws()) - drawsBefore
  const afterBlank = await snap('blank-after')
  const blankDelta = await probe.difference(beforeBlank, afterBlank, 24)
  assert.ok(blankPulled < 12, 'door: a blank click kept drawing (' + blankPulled + ' draw calls)')
  assert.equal(blankDelta.changed, 0, 'door: a blank click changed ' + blankDelta.changed + ' pixels')
  assert.equal(Number(await page.locator('[data-usd-preview]').getAttribute('data-usd-parts')), declaredParts,
    'door: a blank click changed the reported part count')

  state.restoredChecks = restoredChecks
  state.allOpenChanged = allOpen.changed
  state.openChanged = opened.changed
  state.openPoint = open.point
}

/**
 * The mixed fixture: find the distinct parts from the pixel mask, prove each is
 * independently drivable, then exercise All open / All close, Home, colliders,
 * blank clicks and rapid repeated clicks. A fixed-joint body is in the scene;
 * a click on it must do nothing.
 */
async function runMixed(context, state) {
  const { page, snap } = context
  const { closed, declaredParts, declaredColliders } = state
  const hint = await page.locator('[data-usd-parts-hint]').innerText()
  assert.match(hint, new RegExp(declaredParts + ' Moving parts'), 'mixed: the parts hint does not report the drivable joints')

  // 1. Segment the lit model into clusters: the revolute leaf, the prismatic
  //    tray, the fixed plate and the small base are spatially separated.
  const clusters = await maskClusters(closed, 4)
  assert.ok(clusters.length >= 2, 'mixed: the closed frame yielded only ' + clusters.length + ' model cluster(s)')
  const drivable = []
  const staticClicks = []
  for (const cluster of clusters) {
    const result = await clickAndWait(context, { x: cluster.x, y: cluster.y })
    if (result.animated === true) {
      const shot = await snap('cluster-open')
      const delta = await probe.difference(closed, shot, 24)
      drivable.push({ point: { x: cluster.x, y: cluster.y }, shot, delta, pulled: result.pulled })
      // Put it back before classifying the next cluster, so every picture below
      // compares against the same baseline.
      await clickControl(context, 'data-usd-parts-home')
      await waitSettled(page)
      const restore = await probe.difference(closed, await snap('cluster-restored'), 24)
      assert.ok(restore.changed < restore.total * 0.005, 'mixed: Home after a cluster click did not restore the rest pose')
    } else {
      const shot = await snap('cluster-static')
      const delta = await probe.difference(closed, shot, 24)
      staticClicks.push({ point: { x: cluster.x, y: cluster.y }, delta, pulled: result.pulled })
    }
  }
  // Distinct parts: two clusters may land on the same large part.
  const distinct = []
  for (const candidate of drivable) {
    const samePart = distinct.find(entry => {
      const delta = entry.delta
      const distance = Math.hypot(delta.centroidX - candidate.delta.centroidX, delta.centroidY - candidate.delta.centroidY)
      return distance < 80
    })
    if (samePart === undefined) distinct.push(candidate)
  }
  assert.ok(distinct.length >= 2, 'mixed: found only ' + distinct.length + ' independently drivable part(s) from ' + drivable.length + ' drivable cluster(s)')
  for (const entry of distinct) {
    assert.ok(entry.delta.changed > Math.max(200, entry.delta.total * 0.001),
      'mixed: a part click changed only ' + entry.delta.changed + ' pixels')
    assert.ok(entry.pulled >= 12, 'mixed: a part click pulled only ' + entry.pulled + ' draw calls')
  }
  // The fixed-joint body has to be clickable but inert: at least one cluster is
  // static, changes no pixels and pulls no draws.
  assert.ok(staticClicks.length >= 1, 'mixed: no static model cluster was found (the fixed joint was not exercised)')
  for (const entry of staticClicks) {
    assert.ok(entry.pulled < 12, 'mixed: a click on a static body kept drawing (' + entry.pulled + ' draw calls)')
    assert.equal(entry.delta.changed, 0, 'mixed: a click on a static body changed ' + entry.delta.changed + ' pixels')
  }
  const [partA, partB] = distinct
  const partDistance = Math.hypot(partA.delta.centroidX - partB.delta.centroidX, partA.delta.centroidY - partB.delta.centroidY)
  assert.ok(partDistance > 60, 'mixed: the two drivable parts were not spatially distinct (' + partDistance.toFixed(1) + ' px apart)')
  state.partDistance = partDistance

  // 2. Independence: open A, then B on top of it. B's own frame change has to be
  //    the same as when B was opened from the rest pose — A's state cannot leak.
  assert.equal(await allLabel(context), 'Open all', 'mixed: the initial All label is not "Open all"')
  const aClick = await clickAndWait(context, partA.point)
  assert.equal(aClick.animated, true, 'mixed: part A stopped animating')
  const aShot = await snap('part-a-open')
  const aDelta = await probe.difference(closed, aShot, 24)
  assert.ok(aDelta.changed > Math.max(200, aDelta.total * 0.001), 'mixed: opening part A changed only ' + aDelta.changed + ' pixels')
  const bOnA = await clickAndWait(context, partB.point)
  assert.equal(bOnA.animated, true, 'mixed: part B stopped animating')
  const abShot = await snap('part-a-b-open')
  const bOnADelta = await probe.difference(aShot, abShot, 24)
  assert.ok(bOnADelta.changed > Math.max(200, bOnADelta.total * 0.001), 'mixed: opening part B changed only ' + bOnADelta.changed + ' pixels')
  const bCentroid = Math.hypot(
    bOnADelta.centroidX - partB.delta.centroidX,
    bOnADelta.centroidY - partB.delta.centroidY,
  )
  assert.ok(bCentroid < 60, 'mixed: part B moved to a different region when A was open (' + bCentroid.toFixed(1) + ' px)')
  const bRatio = bOnADelta.changed / partB.delta.changed
  assert.ok(bRatio > 0.5 && bRatio < 2, 'mixed: part B changed ' + bRatio.toFixed(2) + 'x as many pixels when A was open')
  const bothOpenShot = abShot

  // 3. Home restores the whole stage after both parts were driven.
  await clickControl(context, 'data-usd-parts-home')
  await waitSettled(page)
  const restoredShot = await snap('home-after-both')
  const restored = await probe.difference(closed, restoredShot, 24)
  assert.ok(restored.changed < restored.total * 0.005,
    'mixed: Home after both parts did not restore the rest pose (' + restored.changed + ' pixels)')

  // 4. All open / All close: label flips and the frame follows it.
  await clickControl(context, 'data-usd-parts-toggle')
  await waitAllLabel(context, 'Close all')
  await waitSettled(page)
  const allOpenShot = await snap('all-open')
  const allOpen = await probe.difference(closed, allOpenShot, 24)
  assert.ok(allOpen.changed > allOpen.total * 0.002, 'mixed: All open changed only ' + allOpen.changed + ' pixels')
  await clickControl(context, 'data-usd-parts-toggle')
  await waitAllLabel(context, 'Open all')
  await waitSettled(page)
  const allClosedShot = await snap('all-close')
  const allClosed = await probe.difference(closed, allClosedShot, 24)
  assert.ok(allClosed.changed < allClosed.total * 0.005, 'mixed: All close did not restore the rest pose')

  // 5. Rapid repeated clicks on one part: five toggles without waiting; after a
  //    Home the stage has to be exactly where it started and the page has to be
  //    quiet (no unhandled error, no runaway animation).
  const box = await context.canvas.boundingBox()
  for (let click = 0; click < 5; click += 1) {
    await page.mouse.click(box.x + box.width * partB.point.x, box.y + box.height * partB.point.y)
    await page.waitForTimeout(120)
  }
  await waitSettled(page)
  const rapidShot = await snap('rapid-clicks')
  void rapidShot
  await clickControl(context, 'data-usd-parts-home')
  await waitSettled(page)
  const rapidRestored = await probe.difference(closed, await snap('rapid-home-restored'), 24)
  assert.ok(rapidRestored.changed < rapidRestored.total * 0.005,
    'mixed: five rapid clicks were not reversible (' + rapidRestored.changed + ' pixels differ after Home)')

  // 6. Colliders: on changes the frame, off restores the baseline.
  if (declaredColliders === '1') {
    await clickControl(context, 'data-usd-parts-colliders')
    await page.waitForTimeout(700)
    const colliderShot = await snap('colliders-on')
    const colliderDiff = await probe.difference(closed, colliderShot, 24)
    assert.ok(colliderDiff.changed > 100, 'mixed: the colliders toggle changed only ' + colliderDiff.changed + ' pixels')
    await clickControl(context, 'data-usd-parts-colliders')
    await page.waitForTimeout(700)
    const colliderRestored = await probe.difference(closed, await snap('colliders-off'), 24)
    assert.ok(colliderRestored.changed < colliderRestored.total * 0.005, 'mixed: turning colliders off did not restore the frame')
    state.colliderDiff = colliderDiff
  }

  // 7. A blank click changes nothing.
  await waitSettled(page)
  const drawsBefore = await context.draws()
  const blankBefore = await snap('blank-before')
  await page.mouse.click(box.x + 6, box.y + box.height - 6)
  await page.waitForTimeout(500)
  await waitSettled(page).catch(() => undefined)
  const blankPulled = (await context.draws()) - drawsBefore
  const blankDelta = await probe.difference(blankBefore, await snap('blank-after'), 24)
  assert.ok(blankPulled < 12, 'mixed: a blank click kept drawing (' + blankPulled + ' draw calls)')
  assert.equal(blankDelta.changed, 0, 'mixed: a blank click changed ' + blankDelta.changed + ' pixels')
  assert.equal(Number(await page.locator('[data-usd-preview]').getAttribute('data-usd-parts')), declaredParts,
    'mixed: a blank click changed the reported part count')

  state.parts = distinct.length
  state.bothOpenChanged = allOpen.changed
  state.aChanged = aDelta.changed
  state.bChanged = partB.delta.changed
  state.abShot = bothOpenShot
}

/**
 * A two-joint chain: All open drives both joints (and the downstream hand through
 * the tree), Home restores; a single click also drives a chain joint.
 */
async function runChain(context, state) {
  const { page, snap } = context
  const { closed, declaredParts } = state
  const restored = async (label) => {
    const delta = await probe.difference(closed, await snap(label), 24)
    assert.ok(delta.changed < delta.total * 0.005, 'chain: ' + label + ' did not restore the rest pose')
    return delta
  }

  assert.equal(await allLabel(context), 'Open all', 'chain: the initial All label is not "Open all"')
  await clickControl(context, 'data-usd-parts-toggle')
  await waitAllLabel(context, 'Close all')
  await waitSettled(page)
  const allOpenShot = await snap('all-open')
  const allOpen = await probe.difference(closed, allOpenShot, 24)
  assert.ok(allOpen.changed > allOpen.total * 0.002, 'chain: All open changed only ' + allOpen.changed + ' pixels')
  await clickControl(context, 'data-usd-parts-toggle')
  await waitAllLabel(context, 'Open all')
  await waitSettled(page)
  await restored('all-close')

  // A single click on a link drives its joint, and Home puts the chain back.
  const candidates = await probe.modelPoints(closed, 90)
  assert.ok(candidates.length > 0, 'chain: no lit model to click')
  let clicked = false
  for (const point of candidates) {
    const result = await clickAndWait(context, point)
    if (result.animated === true) {
      clicked = true
      break
    }
    await clickControl(context, 'data-usd-parts-home')
    await page.waitForTimeout(200)
  }
  assert.equal(clicked, true, 'chain: no candidate click on the chain pulled an animation')
  const oneShot = await snap('link-click-open')
  const one = await probe.difference(closed, oneShot, 24)
  assert.ok(one.changed > Math.max(200, one.total * 0.001), 'chain: one link click changed only ' + one.changed + ' pixels')
  await clickControl(context, 'data-usd-parts-home')
  await waitSettled(page)
  await restored('home-restored')
  state.allOpenChanged = allOpen.changed
  state.oneChanged = one.changed
  state.parts = declaredParts
}

/** A real asset: only generic structural interaction evidence (unknown authoring). */
async function runRealAsset(context, state) {
  const { page, snap } = context
  const { closed, declaredParts } = state
  assert.ok(declaredParts >= 1, 'real asset: no drivable part was reported')
  await clickControl(context, 'data-usd-parts-toggle')
  await waitAllLabel(context, 'Close all')
  await waitSettled(page)
  const allOpen = await probe.difference(closed, await snap('all-open'), 24)
  assert.ok(allOpen.changed > 0, 'real asset: All open changed no pixels')
  await clickControl(context, 'data-usd-parts-home')
  await waitSettled(page)
  const restored = await probe.difference(closed, await snap('home-restored'), 24)
  assert.ok(restored.changed < restored.total * 0.01, 'real asset: Home did not restore the rest pose')
  state.parts = declaredParts
}

const SCRIPTS = { revolute: runRevolute, mixed: runMixed, chain: runChain, real: runRealAsset }

// ── the run ────────────────────────────────────────────────────────────────
try {
  for (const entry of CASES) {
    const { path, parts, partsAtLeast, colliders, interaction, note } = entry
    const page = await browser.newPage({ viewport: { width: 900, height: 640 } })
    const pageErrors = []
    page.on('pageerror', error => pageErrors.push(error?.stack ?? String(error)))
    page.on('console', (message) => { if (message.type() === 'error') pageErrors.push('console: ' + message.text()) })
    await page.goto(origin + '/?path=' + encodeURIComponent(path))
    await page.waitForSelector('[data-usd-preview-canvas]', { timeout: 180_000 })
    await page.waitForSelector('[data-usd-stats]', { timeout: 60_000 })
    await page.waitForTimeout(1200)
    await installOverlayHider(page)

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
    const drawsNow = () => page.evaluate(() => globalThis.__draws)

    // An idle articulated stage must not keep the GPU busy.
    const idleStart = await drawsNow()
    await page.waitForTimeout(500)
    const idleFrames = (await drawsNow()) - idleStart
    assert.ok(idleFrames <= 2, path + ': an idle articulated stage kept drawing (' + idleFrames + ' draw calls in 500 ms)')

    const context = makeContext(page, path)
    const closed = await context.snap('closed-state')
    const state = { closed, declaredParts, declaredColliders, idleFrames }
    await SCRIPTS[interaction](context, state)

    assert.deepEqual(pageErrors, [], path + ': the page threw')
    await page.close()

    lines.push(
      'render ' + path.padEnd(22) + note.padEnd(24) + 'parts ' + declaredParts
      + '  colliders ' + declaredColliders
      + '  idle ' + idleFrames + ' draws/500ms'
      + (state.openChanged === undefined ? '' : '  click ' + state.openChanged + ' px')
      + (state.colliderDiff === undefined ? '' : '  colliders ' + state.colliderDiff.changed + ' px')
      + (state.aChanged === undefined ? '' : '  parts A/B ' + state.aChanged + '/' + state.bChanged + ' px')
      + (state.partDistance === undefined ? '' : '  apart ' + state.partDistance.toFixed(0) + ' px')
      + (state.allOpenChanged === undefined ? '' : '  all-open ' + state.allOpenChanged + ' px')
      + (state.oneChanged === undefined ? '' : '  link click ' + state.oneChanged + ' px'),
    )
  }
} finally {
  await analysis.close().catch(() => undefined)
  await probe.close().catch(() => undefined)
  await browser.close()
  await new Promise(resolve => server.close(resolve))
  await rm(work, { recursive: true, force: true })
}

for (const line of lines) process.stdout.write(line + '\n')
process.stdout.write('articulation-render.test.mjs  OK  (' + lines.length + ' articulated stages clicked in Chromium, step screenshots in tests/.artifacts)\n')
