/**
 * Studio suite: the viewport's own lighting and rendering pipeline, in a real
 * browser.
 *
 * The render suite proves that a USD file turns into something drawn on screen.
 * It cannot prove the something is *staged*: a hemisphere light and a grid also
 * produce a non-flat frame. This suite mounts createView directly on a synthetic
 * model — three boxes and a sphere, no parser, no React — and checks the parts of
 * the pipeline a screenshot alone cannot name:
 *
 *   * the renderer's colour, tone-mapping and shadow policy, read from the live
 *     renderer object;
 *   * one pre-filtered environment, four rect-area panels, and a shadow-casting
 *     directional key whose orthographic box is fitted to the model's radius;
 *   * the stage floor: a matte transparent disc on the scene (not the model), at
 *     the model's base, and the key light's shadow visibly lands on it;
 *   * the on-demand loop: zero frames while idle, one per requestRender(), frames
 *     while auto-rotate runs, and frames only while an onFrame observer reports
 *     work — the cadence that keeps an articulated asset from burning the GPU;
 *   * a pulled frame draws the new state, shadow included, rather than a stale one;
 *   * destroy() leaves no canvas behind and a second view still draws.
 *
 * The last section screenshots the same model under the previous placeholder
 * rig and under the studio rig (studio-before.png / studio-after.png) and prints
 * the measured colour, shadow and framing numbers.
 *
 * Requires: Chromium through Playwright, and node_modules/three + esbuild
 * (devDependencies). Screenshot pixels are measured through `pixel-probe.mjs`,
 * which decodes the PNGs in the same Chromium — no Python runtime is required.
 * Without Playwright the suite reports SKIP and exits 0.
 *
 * Environment:
 *   PLAYWRIGHT_MODULE   path to Playwright when it is not resolvable here
 *
 * Run: node tests/studio.test.mjs
 */
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createPixelProbe } from './pixel-probe.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = join(root, 'tests', '.artifacts')

/** The stage the harness mounts into; also the comparison screenshots' size. */
const STAGE = { width: 900, height: 640 }
/** The page's background, matching the shell's own base surface. */
const BACKGROUND = '#14161a'

// ── the harness page, bundled for the browser ───────────────────────────────
const work = await mkdtemp(join(tmpdir(), 'dsh-usd-studio-'))
const bundle = join(work, 'studio-harness.js')
await build({
  entryPoints: [join(root, 'tests', 'studio.harness.js')],
  bundle: true,
  outfile: bundle,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  logLevel: 'warning',
})
const harness = await readFile(bundle)

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>usd studio harness</title>'
  + '<style>'
  + 'html, body { margin: 0; height: 100%; background: ' + BACKGROUND + '; }'
  // The stage mirrors the document seat: a positioned box the canvas fills.
  + '#host { position: relative; width: ' + STAGE.width + 'px; height: ' + STAGE.height + 'px; overflow: hidden; }'
  + '</style></head>'
  + '<body><div id="host"></div><script type="module" src="/harness.js"></script></body></html>'

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
const origin = 'http://127.0.0.1:' + server.address().port

// ── the pixel probes ────────────────────────────────────────────────────────
// The screenshots are decoded by `pixel-probe.mjs` in the same Chromium that
// drew them: distinct colours, luminance percentiles, bounding boxes and frame
// differences all arrive as plain numbers here, so the suite needs nothing
// beyond Playwright.

/** The probe is created with the browser, just below. */
let probe

/**
 * @param shot - the screenshot to measure.
 * @returns distinct colours, dominant share, mean luminance, clipped share.
 */
async function colourStats(shot) {
  const colours = await probe.colours(shot)
  return { ...colours, dominantShare: colours.dominant / colours.total }
}

/**
 * @param shot - a screenshot with the stage floor hidden, so the percentiles are
 *   the model's and not the floor's.
 * @param cutoff - luminance above which a pixel counts as the model.
 * @returns luminance percentiles, the clipped share, and the model pixel count.
 */
async function toneStats(shot, cutoff = 60) {
  return probe.tone(shot, cutoff)
}

/**
 * @param shot - a screenshot with the stage floor hidden.
 * @returns the model's pixel centroid and area.
 */
async function modelCentroid(shot) {
  return probe.centroid(shot, 60)
}

/**
 * Pixel changes between two frames: how many, how strong, and in which
 * direction. The luminance pair is what separates "the shadow got drawn" (darker
 * with it on) from "something merely re-rendered".
 * @param before - the first screenshot.
 * @param after - the second screenshot.
 * @param threshold - summed RGB delta above which a pixel counts as changed.
 * @returns the changed pixels, their share, both luminance means, the centroid.
 */
async function diffStats(before, after, threshold = 12) {
  return probe.diff(before, after, threshold)
}

// ── Playwright, or an honest skip ───────────────────────────────────────────
/**
 * Resolve Playwright from the usual places, in order.
 * @returns the chromium launcher, or undefined when Playwright is not installed.
 */
async function loadPlaywright() {
  const { pathToFileURL } = await import('node:url')
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
    'studio.test.mjs  SKIP  (Playwright/Chromium not available — '
    + 'run `npm install --no-save playwright && npx playwright install chromium` to enable)\n',
  )
  process.exit(0)
}

// ── the browser ─────────────────────────────────────────────────────────────
await mkdir(artifacts, { recursive: true })
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
probe = await createPixelProbe(browser)
const pageErrors = []
const results = {}
try {
  const page = await browser.newPage({ viewport: { width: STAGE.width + 40, height: STAGE.height + 40 } })
  page.on('pageerror', error => pageErrors.push(error?.stack ?? String(error)))
  await page.goto(origin + '/')
  await page.waitForFunction(() => globalThis.__studio !== undefined)
  await page.evaluate(() => globalThis.__studio.mount())
  await page.waitForSelector('[data-usd-preview-canvas]', { timeout: 30_000 })
  // Long enough for the ResizeObserver's first frame and for the loop to settle.
  await page.waitForTimeout(400)
  const canvas = page.locator('[data-usd-preview-canvas]')
  const layout = await canvas.boundingBox()
  assert.ok(layout !== null && layout.width > 500 && layout.height > 400, 'the canvas is not laid out')

  // ── the pipeline, read back from the live three objects ──────────────────
  const studio = await page.evaluate(() => globalThis.__studio.report())
  results.studio = studio
  const renderer = studio.renderer
  const environment = studio.environment
  const model = studio.model
  const policy = studio.policy

  assert.equal(renderer.toneMapping, renderer.neutralToneMapping, 'tone mapping is not Khronos PBR Neutral')
  assert.equal(renderer.outputColorSpace, renderer.srgbColorSpace, 'output colour space is not sRGB')
  assert.equal(renderer.shadowMapEnabled, true, 'shadow map is disabled')
  assert.equal(renderer.shadowMapType, renderer.pcfShadowMap, 'shadow map is not PCF')
  assert.equal(renderer.shadowMapAutoUpdate, true, 'the shadow map would go stale under a moving part')
  assert.ok(renderer.pixelRatio >= 1 && renderer.pixelRatio <= 2, 'pixel ratio outside 1..2: ' + renderer.pixelRatio)
  assert.equal(renderer.exposure, policy.exposure, 'exposure is not the studio calibration: ' + renderer.exposure)
  assert.equal(studio.canvas.markers, 1, 'the canvas does not carry the [data-usd-preview-canvas] marker')

  assert.equal(environment.assigned, true, 'the scene has no environment')
  assert.equal(environment.isTexture, true, 'the environment is not a pre-filtered texture')
  // The image-based fill is a fill, not the key: a strong environment washes a
  // default-albedo (0.8) surface out to a mean near 212/255, which is the
  // flattening this suite measures. The value itself is the studio's business —
  // asserted against its declared policy, not retyped here, so a retune lands in
  // one place.
  assert.equal(environment.intensity, policy.environmentIntensity, 'environment intensity is not the studio calibration')

  assert.equal(studio.areaLights.length, 4, 'expected four rect-area panels, found ' + studio.areaLights.length)
  assert.deepEqual(
    studio.areaLights.map(light => light.name).sort(),
    ['studio-panel-fill', 'studio-panel-key', 'studio-panel-rim', 'studio-panel-top'],
    'the four panels are not panel-key/panel-fill/panel-panel-top/panel-rim',
  )
  // The panels' relative powers are the studio calibration (8.6/6.4/2.6/10 in
  // `STUDIO.panelPowers`); their absolute nits are calibrated down because the
  // radius-scaled panels subtend a much larger solid angle than that ratio
  // assumes. Ratios, not nits, are the transferable part of the recipe.
  const expectedPowers = policy.panelPowers.map(power => power * policy.panelGain).sort((a, b) => a - b)
  const powers = studio.areaLights.map(light => light.intensity).sort((a, b) => a - b)
  assert.deepEqual(
    powers.map(power => Number(power.toFixed(4))),
    expectedPowers.map(power => Number(power.toFixed(4))),
    'the panel powers are not the studio calibration',
  )

  assert.equal(studio.directionals.length, 1, 'there must be exactly one directional light')
  const key = studio.directionals[0]
  assert.equal(key.castShadow, true, 'the key light does not cast')
  assert.deepEqual(key.mapSize, [policy.shadowMapSize, policy.shadowMapSize], 'the shadow map size is not the calibration')
  assert.equal(key.bias, policy.shadowBias, 'shadow bias is not the calibration: ' + key.bias)
  assert.equal(key.intensity, policy.keyIntensity, 'the key light is not the studio calibration')
  // The frustum is fitted to the model, not to the world: a fixed multiple of the
  // framing radius, bracketing the light's own distance.
  const extent = model.radius * policy.shadowFrustum.extent
  assert.ok(Math.abs(key.frustum.left + extent) < 1e-6, 'the shadow box is not fitted to the model radius')
  assert.ok(Math.abs(key.frustum.top - extent) < 1e-6, 'the shadow box is not fitted to the model radius')
  assert.ok(Math.abs(key.frustum.near - model.radius * policy.shadowFrustum.near) < 1e-5, 'the shadow near plane is not radius-derived')
  assert.ok(Math.abs(key.frustum.far - model.radius * policy.shadowFrustum.far) < 1e-5, 'the shadow far plane is not radius-derived')

  // The stage is what the shadow lands on. A ShadowMaterial-only plane cannot do
  // that job here: the canvas is transparent over a near-black shell surface, so
  // it has nothing to darken (0 pixels changed on the real robot).
  assert.ok(studio.ground !== null, 'the scene has no stage floor')
  const ground = studio.ground
  assert.equal(ground.parentIsScene, true, 'the stage was parented under the model instead of the scene')
  assert.equal(ground.material, 'MeshStandardMaterial', 'the stage is not a lit surface: ' + ground.material)
  assert.equal(ground.transparent, true, 'the stage is not transparent (its rim must fade into the shell)')
  assert.equal(ground.hasAlphaMap, true, 'the stage has no radial fade')
  assert.equal(ground.roughness, 1, 'the stage is not matte')
  assert.equal(ground.receiveShadow, true, 'the stage does not receive shadows')
  assert.equal(ground.castShadow, false, 'the stage casts shadows')
  assert.ok(Math.abs(ground.rotationX + Math.PI / 2) < 1e-6, 'the stage is not laid flat')
  assert.ok(
    Math.abs(ground.radius - model.radius * policy.stageRadius) < 1e-4,
    'the stage radius is not the calibration: ' + ground.radius,
  )
  assert.ok(
    Math.abs(ground.y - model.base) <= model.radius * 0.01,
    'the stage sits at ' + ground.y + ', the model base is ' + model.base,
  )
  // The stage must not be mistaken for geometry: the host counts meshes by
  // traversing the model root, and the studio's floor lives outside it.
  assert.equal(model.meshes, 4, 'the model reports ' + model.meshes + ' meshes instead of 4')
  assert.equal(model.casting, 4, 'not every model mesh was armed to cast')
  assert.equal(model.receiving, 4, 'not every model mesh was armed to receive')

  // ── the cadence: idle, pull, request, spin, resize ────────────────────────
  const idle = await page.evaluate(async () => {
    const before = globalThis.__studio.frames()
    await new Promise(resolve => setTimeout(resolve, 500))
    return { before, after: globalThis.__studio.frames() }
  })
  assert.ok(
    idle.after - idle.before <= 1,
    'the loop kept drawing while idle: ' + (idle.after - idle.before) + ' frames in 500 ms',
  )
  results.idle = idle.after - idle.before

  const requested = await page.evaluate(async () => {
    const before = globalThis.__studio.frames()
    globalThis.__studio.requestRender()
    await globalThis.__studio.waitFrames(4)
    return { before, after: globalThis.__studio.frames() }
  })
  assert.ok(requested.after > requested.before, 'requestRender() drew nothing')
  assert.ok(
    requested.after - requested.before <= 3,
    'requestRender() kept drawing: ' + (requested.after - requested.before) + ' frames',
  )
  results.requested = requested.after - requested.before

  const pulled = await page.evaluate(async () => {
    const before = globalThis.__studio.frames()
    globalThis.__studio.animate(12, 0)
    await globalThis.__studio.waitFrames(20)
    return { before, after: globalThis.__studio.frames() }
  })
  assert.ok(
    pulled.after - pulled.before >= 10,
    'an observer that reported work drew only ' + (pulled.after - pulled.before) + ' frames',
  )
  results.pulled = pulled.after - pulled.before

  const afterPull = await page.evaluate(async () => {
    globalThis.__studio.stopAnimating()
    await new Promise(resolve => setTimeout(resolve, 400))
    const before = globalThis.__studio.frames()
    await new Promise(resolve => setTimeout(resolve, 500))
    return { before, after: globalThis.__studio.frames() }
  })
  assert.ok(
    afterPull.after - afterPull.before <= 1,
    'the loop kept drawing after the observer stopped pulling: ' + (afterPull.after - afterPull.before) + ' frames',
  )

  const spinning = await page.evaluate(async () => {
    const before = globalThis.__studio.frames()
    globalThis.__studio.setSpin(true)
    // Software rasterization costs ~0.5 s per frame here (the 2048x2048 shadow
    // pass dominates), so this samples a much longer window than a GPU would
    // need: what it proves is that auto-rotate keeps pulling frames, not the
    // frame rate.
    await new Promise(resolve => setTimeout(resolve, 2000))
    const spun = globalThis.__studio.frames()
    globalThis.__studio.setSpin(false)
    // Auto-rotate leaves inertia in the controls; the view keeps drawing until
    // the camera has actually stopped, which is the damping guarantee. A single
    // frame can take longer than a poll interval on a software rasterizer, so
    // "settled" here is four consecutive 250 ms polls with no new frame — a
    // window no still-moving damping tail can stay quiet through. The tail is
    // long in wall-clock time on a software rasterizer (the decay is per drawn
    // frame), hence the generous deadline.
    let last = -1
    let quiet = 0
    const deadline = performance.now() + 90_000
    while (quiet < 4 && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 250))
      const now = globalThis.__studio.frames()
      if (now === last) quiet += 1
      else { quiet = 0; last = now }
    }
    const settled = last
    await new Promise(resolve => setTimeout(resolve, 600))
    return { before, spun, settled, stopped: globalThis.__studio.frames() }
  })
  assert.ok(spinning.spun - spinning.before >= 2, 'auto-rotate did not keep drawing frames')
  assert.ok(
    spinning.stopped - spinning.settled <= 1,
    'the loop kept drawing after the camera settled: ' + (spinning.stopped - spinning.settled) + ' frames',
  )
  results.spinning = spinning.spun - spinning.before
  results.dampingTail = spinning.settled - spinning.spun

  const resized = await page.evaluate(async () => {
    const before = globalThis.__studio.frames()
    globalThis.__studio.resize(760, 520)
    await new Promise(resolve => setTimeout(resolve, 300))
    const next = document.querySelector('[data-usd-preview-canvas]')
    return {
      before,
      after: globalThis.__studio.frames(),
      client: [next.clientWidth, next.clientHeight],
      buffer: [next.width, next.height],
    }
  })
  assert.ok(resized.after > resized.before, 'a resize drew no frame')
  assert.deepEqual(resized.client, [760, 520], 'the canvas did not follow the container size')
  assert.ok(resized.buffer[0] >= 760 && resized.buffer[1] >= 520, 'the drawing buffer did not follow the resize')
  await page.evaluate(async (size) => {
    globalThis.__studio.resize(size.width, size.height)
    await new Promise(resolve => setTimeout(resolve, 300))
  }, STAGE)
  const restored = await canvas.evaluate(node => [node.clientWidth, node.clientHeight])
  assert.deepEqual(restored, [STAGE.width, STAGE.height], 'the stage did not return to its size')
  // Back to the framing pose, so the evidence screenshots are the canonical view
  // rather than wherever the cadence checks left the camera.
  await page.evaluate(async () => {
    globalThis.__studio.reset()
    await globalThis.__studio.settle()
  })

  // ── framing: the model alone, centred, with the framing margin ───────────
  const silhouetteShot = join(work, 'silhouette.png')
  await page.evaluate(async () => {
    // Everything the studio adds comes off, so only the model is measured.
    globalThis.__studio.setGridVisible(false)
    globalThis.__studio.setShadowCasting(false)
    globalThis.__studio.setFloorVisible(false)
    await globalThis.__studio.waitFrames(4)
  })
  await canvas.screenshot({ path: silhouetteShot })
  const silhouette = await probe.bbox(silhouetteShot, 6)
  const { left, top, right, bottom, width: frameWidth, height: frameHeight, pixels: silhouettePixels } = silhouette
  const fill = { x: (right - left + 1) / frameWidth, y: (bottom - top + 1) / frameHeight }
  const offset = {
    x: Math.abs((left + right) / 2 - frameWidth / 2) / frameWidth,
    y: Math.abs((top + bottom) / 2 - frameHeight / 2) / frameHeight,
  }
  const margin = {
    left: left / frameWidth,
    right: (frameWidth - right - 1) / frameWidth,
    top: top / frameHeight,
    bottom: (frameHeight - bottom - 1) / frameHeight,
  }
  results.framing = { fill, offset, margin, silhouettePixels }
  assert.ok(silhouettePixels > 5000, 'the model covers only ' + silhouettePixels + ' pixels')
  // A bounding-sphere framing puts a boxy model at roughly half the frame. The
  // bands are wide because this guards against gross errors (camera inside the
  // model, a 10x distance, an off-centre target), not against a few percent of
  // margin. The frame is always fully inside the canvas — a clipped model would
  // mean the camera was framed for something else.
  assert.ok(fill.y > 0.25 && fill.y < 0.9, 'the model fills ' + (fill.y * 100).toFixed(1) + '% of the frame height')
  assert.ok(fill.x > 0.25 && fill.x < 0.9, 'the model fills ' + (fill.x * 100).toFixed(1) + '% of the frame width')
  for (const [side, share] of Object.entries(margin)) {
    assert.ok(share > 0.05, 'the model is clipped at the ' + side + ' edge: ' + (share * 100).toFixed(1) + '% margin')
  }
  assert.ok(offset.x < 0.06, 'the model is off-centre horizontally by ' + (offset.x * 100).toFixed(1) + '%')
  // The silhouette of a model standing on the floor sits low: its near base
  // corner is the closest point to a camera looking down at 35 degrees, so it
  // projects further from the target than the far top corner does. The view
  // frames the bounding-box centre the same way, so this is the expected shape,
  // not a framing bug — hence the wider vertical band.
  assert.ok(offset.y < 0.15, 'the model is off-centre vertically by ' + (offset.y * 100).toFixed(1) + '%')
  await page.evaluate(async () => {
    globalThis.__studio.setGridVisible(true)
    globalThis.__studio.setShadowCasting(true)
    globalThis.__studio.setFloorVisible(true)
    await globalThis.__studio.waitFrames(4)
  })

  // ── the staged frame, and the contact shadow it draws ────────────────────
  const afterShot = join(artifacts, 'studio-after.png')
  await page.waitForTimeout(150)
  await canvas.screenshot({ path: afterShot })
  const after = await colourStats(afterShot)
  results.after = after
  assert.ok(after.distinct > 50, 'only ' + after.distinct + ' distinct colours — nothing was drawn')
  assert.ok(
    after.dominantShare < 0.98,
    (after.dominantShare * 100).toFixed(1) + '% of the frame is one colour — nothing was drawn',
  )
  assert.ok(after.clipped < 0.25, (after.clipped * 100).toFixed(1) + '% of the frame is blown out')

  // The tone the shipped fixtures are judged on: a default-albedo surface must
  // read as a mid-tone with highlights, not as a white silhouette. Measured on
  // the white reference box alone, with the floor hidden — both are lit surfaces
  // of their own and would otherwise outvote the surface being measured.
  await page.evaluate(async () => {
    globalThis.__studio.setFloorVisible(false)
    globalThis.__studio.setToneReference(true)
    await globalThis.__studio.waitFrames(3)
  })
  const toneShot = join(work, 'tone.png')
  await canvas.screenshot({ path: toneShot })
  await page.evaluate(async () => {
    globalThis.__studio.setToneReference(false)
    await globalThis.__studio.waitFrames(3)
  })
  const modelShot = join(work, 'model.png')
  await canvas.screenshot({ path: modelShot })
  await page.evaluate(async () => {
    globalThis.__studio.setFloorVisible(true)
    await globalThis.__studio.waitFrames(3)
  })
  const tone = await toneStats(toneShot)
  results.tone = tone
  assert.ok(tone.p50 >= 150 && tone.p50 <= 205, 'model mid-tone is ' + tone.p50 + ', outside 150..205')
  assert.ok(tone.p90 <= 235, 'model highlight tone is ' + tone.p90 + ', above 235')
  assert.ok(tone.clipped <= 0.005, 'clipped share is ' + (tone.clipped * 100).toFixed(2) + '%')

  // What the shadow pass costs: the same frame with the key light's castShadow
  // off skips the extra 2048x2048 render, which shows up in the frame counters.
  const cost = await page.evaluate(async () => {
    const mountMs = globalThis.__studio.mountTime()
    const withShadow = globalThis.__studio.frameInfo()
    globalThis.__studio.setShadowCasting(false)
    await globalThis.__studio.waitFrames(3)
    const withoutShadow = globalThis.__studio.frameInfo()
    globalThis.__studio.setShadowCasting(true)
    await globalThis.__studio.waitFrames(3)
    return { mountMs, withShadow, withoutShadow }
  })
  results.cost = cost
  assert.ok(
    cost.withShadow.triangles > cost.withoutShadow.triangles,
    'the shadow pass drew nothing: ' + cost.withShadow.triangles + ' vs ' + cost.withoutShadow.triangles + ' triangles',
  )
  assert.ok(cost.withShadow.calls > cost.withoutShadow.calls, 'the shadow pass issued no draw calls')

  const shadowOffShot = join(work, 'shadow-off.png')
  await page.evaluate(async () => {
    globalThis.__studio.setShadowCasting(false)
    await globalThis.__studio.waitFrames(4)
  })
  await canvas.screenshot({ path: shadowOffShot })
  // Threshold 2, not 12: the acceptance is that the contact shadow is visible on
  // the app's own surface, so it is measured with the loosest threshold that
  // still excludes render noise.
  const shadow = await diffStats(afterShot, shadowOffShot, 2)
  results.shadow = shadow
  const modelCentre = await modelCentroid(modelShot)
  results.modelCentre = modelCentre
  assert.ok(shadow.changed > 1000, 'toggling castShadow changed only ' + shadow.changed + ' pixels')
  assert.ok(
    shadow.centroidY > modelCentre.y,
    'the shadow centroid (' + shadow.centroidY + ') is not below the model centroid (' + modelCentre.y + ')',
  )
  assert.ok(
    shadow.lumaBefore < shadow.lumaAfter,
    'shadowed pixels are ' + shadow.lumaBefore + ' vs ' + shadow.lumaAfter + ' without — it brightens, so it is not a shadow',
  )
  await page.evaluate(async () => {
    globalThis.__studio.setShadowCasting(true)
    await globalThis.__studio.waitFrames(4)
  })

  // ── a pulled frame draws the new state, its shadow included ──────────────
  await page.evaluate(async () => {
    globalThis.__studio.animate(10, 0.09)
    await new Promise(resolve => setTimeout(resolve, 600))
    globalThis.__studio.stopAnimating()
  })
  const animatedShot = join(work, 'animated.png')
  await canvas.screenshot({ path: animatedShot })
  const moved = await diffStats(afterShot, animatedShot)
  results.moved = moved
  assert.ok(moved.changed > 2000, 'pulled frames drew only ' + moved.changed + ' changed pixels')

  // ── teardown, and a second view after it ────────────────────────────────
  const teardown = await page.evaluate(async () => {
    globalThis.__studio.unmount()
    const remaining = document.querySelectorAll('[data-usd-preview-canvas]').length
    globalThis.__studio.mount()
    await globalThis.__studio.waitFrames(6)
    return {
      remaining,
      markers: document.querySelectorAll('[data-usd-preview-canvas]').length,
      frames: globalThis.__studio.frames(),
    }
  })
  assert.equal(teardown.remaining, 0, 'destroy() left the canvas in the document')
  assert.equal(teardown.markers, 1, 'a second createView() did not mount its canvas')
  assert.ok(teardown.frames > 0, 'a second createView() drew nothing')
  await page.waitForTimeout(200)
  const recreateShot = join(work, 'recreate.png')
  await canvas.screenshot({ path: recreateShot })
  const recreate = await colourStats(recreateShot)
  results.recreate = recreate
  assert.ok(recreate.distinct > 50, 'the second view drew only ' + recreate.distinct + ' distinct colours')

  // ── a caller-supplied frame widens the camera, not the stage ─────────────
  // An articulated stage hands in the box its joints reach at both extremes, so
  // "open all" cannot swing the model out of the viewport. The model must sit
  // smaller in that frame, and the floor must stay where the model stands.
  const restCentre = model.min.map((value, axis) => (value + model.max[axis]) / 2)
  const spread = 1.6
  const reach = {
    min: model.min.map((value, axis) => restCentre[axis] + (value - restCentre[axis]) * spread),
    max: model.max.map((value, axis) => restCentre[axis] + (value - restCentre[axis]) * spread),
  }
  await page.evaluate(async (box) => {
    globalThis.__studio.unmount()
    globalThis.__studio.mount({ frame: box })
    await globalThis.__studio.waitFrames(6)
    await globalThis.__studio.settle()
    globalThis.__studio.setGridVisible(false)
    globalThis.__studio.setShadowCasting(false)
    globalThis.__studio.setFloorVisible(false)
    await globalThis.__studio.waitFrames(4)
  }, reach)
  const framedShot = join(work, 'framed.png')
  await canvas.screenshot({ path: framedShot })
  const framedReport = await page.evaluate(() => globalThis.__studio.report())
  const framedBox = await probe.bbox(framedShot, 6)
  const framedFill = {
    x: (framedBox.right - framedBox.left + 1) / framedBox.width,
    y: (framedBox.bottom - framedBox.top + 1) / framedBox.height,
  }
  results.framed = framedFill
  // A frame spread 1.6x wider puts the model at 1/1.6 of its previous share.
  const expected = results.framing.fill.y / spread
  assert.ok(
    Math.abs(framedFill.y - expected) < expected * 0.25,
    'the camera did not frame the supplied box: model fills ' + framedFill.y + ', expected ~' + expected,
  )
  assert.ok(
    Math.abs(framedReport.ground.y - framedReport.model.base) <= framedReport.model.radius * 0.01,
    'the stage moved off the rest base when the camera framed a wider box: ' + framedReport.ground.y,
  )
  assert.ok(
    Math.abs(framedReport.ground.radius - framedReport.model.radius * spread * policy.stageRadius) < 1e-3,
    'the stage did not scale with the supplied frame: ' + framedReport.ground.radius,
  )
  await page.evaluate(() => globalThis.__studio.unmount())

  // ── before/after: the same model under the previous placeholder rig ───────
  const beforeShot = join(artifacts, 'studio-before.png')
  await page.evaluate(async () => {
    globalThis.__studio.unmount()
    globalThis.__studio.mountLegacy()
    await globalThis.__studio.waitFrames(6)
  })
  await page.waitForTimeout(200)
  await canvas.screenshot({ path: beforeShot })
  const legacy = await page.evaluate(() => globalThis.__studio.report())
  const before = await colourStats(beforeShot)
  results.before = before
  results.legacy = legacy
  // The placeholder rig had no environment, no shadows, no tone mapping and no
  // ground at all; the studio frame is the one with a staged model on it.
  assert.equal(legacy.environment.assigned, false, 'the legacy rig grew an environment')
  assert.equal(legacy.ground, null, 'the legacy rig grew a ground plane')
  assert.equal(legacy.areaLights.length, 0, 'the legacy rig grew area lights')
  assert.equal(legacy.renderer.shadowMapEnabled, false, 'the legacy rig grew a shadow map')
  assert.notEqual(legacy.renderer.toneMapping, studio.renderer.neutralToneMapping, 'the legacy rig grew tone mapping')
  await page.evaluate(() => globalThis.__studio.unmount())

  assert.deepEqual(pageErrors, [], 'the page threw')
} finally {
  await probe.close().catch(() => undefined)
  await browser.close()
  await new Promise(resolve => server.close(resolve))
  await rm(work, { recursive: true, force: true })
}

// ── what changed, in numbers ────────────────────────────────────────────────
const studio = results.studio
const before = results.before
const after = results.after
const shadow = results.shadow
const tone = results.tone
const framing = results.framing
const moved = results.moved
const percent = value => (value * 100).toFixed(1) + '%'
const row = (label, text) => process.stdout.write(label.padEnd(10) + ' ' + text + '\n')
row('renderer', 'NeutralToneMapping ' + studio.renderer.toneMapping
  + ', sRGB ' + studio.renderer.outputColorSpace
  + ', PCFShadowMap ' + studio.renderer.shadowMapType
  + ' (autoUpdate ' + studio.renderer.shadowMapAutoUpdate + ')'
  + ', pixelRatio ' + studio.renderer.pixelRatio
  + ', exposure ' + studio.renderer.exposure)
row('rig', 'area lights ' + studio.areaLights.map(light => light.intensity.toFixed(2)).join('/')
  + ', environment ' + studio.environment.intensity
  + ', shadow 2048x2048 bias ' + studio.directionals[0].bias)
row('stage', 'model r=' + studio.model.radius.toFixed(2) + ' base=' + studio.model.base.toFixed(3)
  + ', stage ' + (studio.ground.radius * 2).toFixed(2) + ' across (' + studio.ground.material + ' rough '
  + studio.ground.roughness + ', fades out) at y=' + studio.ground.y.toFixed(4))
row('cost', 'createView ' + results.cost.mountMs.toFixed(1) + ' ms (PMREM + first compile); '
  + 'frame ' + results.cost.withShadow.calls + ' calls / ' + results.cost.withShadow.triangles + ' tris with the shadow pass, '
  + results.cost.withoutShadow.calls + ' / ' + results.cost.withoutShadow.triangles + ' without')
row('cadence', 'idle ' + results.idle + ' frames/500 ms, requestRender ' + results.requested
  + ', observer pull ' + results.pulled + ', auto-rotate ' + results.spinning + ' frames/2000 ms'
  + ', damping tail ' + results.dampingTail + ' frames')
row('pixels', 'studio ' + after.distinct + ' colours, dominant ' + percent(after.dominantShare)
  + ', mean luma ' + after.meanLuma + ', clipped ' + percent(after.clipped))
row('pixels', 'legacy ' + before.distinct + ' colours, dominant ' + percent(before.dominantShare)
  + ', mean luma ' + before.meanLuma + ', clipped ' + percent(before.clipped))
row('shadow', 'castShadow on/off changes ' + shadow.changed + ' px (' + percent(shadow.share) + ')'
  + ', mean luma ' + shadow.lumaBefore + ' vs ' + shadow.lumaAfter
  + ', mean RGB delta ' + shadow.meanDelta
  + ', centroid ' + shadow.centroidX + ',' + shadow.centroidY)
row('tone', 'model p10/p50/p90/p99 ' + tone.p10 + '/' + tone.p50 + '/' + tone.p90 + '/' + tone.p99
  + ', clipped ' + percent(tone.clipped) + ', ' + tone.pixels + ' model px')
row('shadow', 'centroid y ' + shadow.centroidY + ' vs model centroid y ' + results.modelCentre.y
  + ' (' + results.modelCentre.pixels + ' model px)')
row('pulled', 'a moving part changes ' + moved.changed + ' px (' + percent(moved.share) + ') on pulled frames')
row('framing', 'model fills ' + percent(framing.fill.x) + ' x ' + percent(framing.fill.y) + ' of the frame'
  + ', centre offset ' + percent(framing.offset.x) + ' x ' + percent(framing.offset.y)
  + ', margins l/r/t/b ' + percent(framing.margin.left) + '/' + percent(framing.margin.right)
  + '/' + percent(framing.margin.top) + '/' + percent(framing.margin.bottom))
row('framed', 'a 1.6x reach box puts the model at ' + percent(results.framed.y) + ' of frame height (was '
  + percent(framing.fill.y) + '), stage still at the rest base')
row('teardown', 'canvas removed, second view drew ' + results.recreate.distinct + ' colours')

process.stdout.write('\nstudio.test.mjs  OK  (screenshots in tests/.artifacts: studio-before.png, studio-after.png)\n')
