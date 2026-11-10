/**
 * Render test: the real body component in a real browser, no converter process.
 *
 * The offline suite proves assembly in Node. It cannot prove the thing the user
 * actually asked for — that a USD file turns into a lit, orbiting model in a
 * canvas — so this test mounts `UsdBody` in Chromium with WebGL on, serves the
 * fixtures over HTTP, and checks two independent facts per file:
 *
 *   * the stats line reports the geometry that was assembled;
 *   * the rendered frame is not a flat surface — measured by screenshotting the
 *     canvas and counting how many distinct colours survived.
 *
 * The reference case matters most: it is the one where the bytes alone are not
 * enough and the injected reader has to reach a second file.
 *
 * Requirements: `npm install` (react, react-dom, esbuild, three), and Playwright
 * with its Chromium downloaded. Playwright is not a dependency of this package
 * because most of the work is offline; install it with
 *
 *     npm install --no-save playwright
 *     npx playwright install chromium
 *
 * When Playwright cannot be loaded the suite reports SKIP and exits 0, so
 * `npm test` still covers the offline contracts on a machine without a browser.
 * Screenshot pixels are measured through `pixel-probe.mjs`, which decodes the
 * PNG in the same Chromium — no Python runtime is required.
 *
 * Environment:
 *   PLAYWRIGHT_MODULE       path to a Playwright entry point, when it is not
 *                           resolvable from this package (a global install)
 *   DSH_USD_TEST_SCENE      path to a real composed scene to draw (opt-in)
 *   DSH_USD_TEST_SCENE_ROOT optional session root for that scene, so the engine's
 *                           root key carries a directory with localized refs
 *   DSH_USD_TEST_SIMREADY   path to a real articulated `.usdc` asset (opt-in)
 *   DSH_RENDER_ONLY         run only the cases whose path contains this string
 *
 * Run: node tests/render.test.mjs
 */
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
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
  // A local install is the normal case here; the global one is a fallback.
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
    'render.test.mjs  SKIP  (Playwright/Chromium not available — '
    + 'run `npm install --no-save playwright && npx playwright install chromium` to enable)\n',
  )
  process.exit(0)
}

// ── optional real assets, gated by generic environment variables ────────────
/**
 * A file served under a virtual prefix: either a real composed scene, or a real
 * articulated asset. `asset.usdc` references its sibling collision layer by
 * relative name, so the whole directory is mounted.
 */
const MOUNTS = []
/** Register one env-gated file, when this machine has it. */
function mountFromEnv(prefix, envName) {
  const file = process.env[envName]
  if (file === undefined || file === '' || existsSync(file) === false) return undefined
  const mount = { prefix, file, directory: dirname(file) }
  MOUNTS.push(mount)
  return mount
}
const realScene = mountFromEnv('real/', 'DSH_USD_TEST_SCENE')
const simready = mountFromEnv('simready/', 'DSH_USD_TEST_SIMREADY')

// ── the host half's asset routes, wired to this test's server ───────────────
const hostRoutes = new Map()
const hostHalf = await import(new URL('../lib/index.js', import.meta.url).href).catch((error) => {
  throw new Error('lib/index.js missing — run `npm run build` first: ' + error.message)
})
/** Fake Connection service: only the exact Fetch-route surface the host half uses. */
const hostContext = {
  effect: callback => callback(),
  logger: { info() {}, warn() {}, debug() {} },
  inject: (_dependencies, callback) => callback(hostContext),
  connection: {
    fetch: {
      register(route) {
        hostRoutes.set(route.path, route)
        return async () => undefined
      },
    },
  },
}
hostHalf.apply(hostContext, undefined)
assert.equal(hostRoutes.size, 2, 'the host half registered both trust-fenced asset routes')

/** Files to draw, and the geometry each must report. */
const CASES = [
  { path: 'sample.usdz', meshes: 2, match: /Layers: 1/, note: 'package' },
  { path: 'sample.usda', meshes: 2, match: /Container: usda/, note: 'ASCII' },
  { path: 'sample.usdc', meshes: 2, match: /Container: usdc/, note: 'binary crate' },
  // One quad in a second layer: the case where the bytes alone are not enough.
  { path: 'refs/unit.usda', meshes: 1, match: /Layers: 2/, note: 'reference chain' },
  // subLayers + reference: an arc three's composer does not implement at all.
  { path: 'arcs/root.usda', meshes: 2, match: /Layers: 3/, note: 'sublayer + reference' },
  // PointInstancer: four placements of one prototype; three's composer has no
  // PointInstancer at all, so only the engine path can draw these.
  { path: 'instancer/root.usda', meshes: 4, match: /Layers: 1/, note: 'PointInstancer' },
  // Nested: 2 outer placements, each an instancer of 3 quads -> 6 drawn.
  { path: 'instancer/nested.usda', meshes: 6, match: /Layers: 1/, note: 'nested instancer' },
  // Three levels of instancing: 2 x 3 x 3 = 18 quads.
  { path: 'instancer/trideep.usda', meshes: 18, match: /Layers: 1/, note: 'three-level instancer' },
  // A prim carrying PointInstancer fields under a custom type name: retyping it
  // on the way in is what makes the four placements appear. Without it the prim
  // composes empty and the reported extent collapses to 1 x 0 x 0.
  { path: 'instancer/custom-typed.usda', match: /Size: 1\.000 × 7\.000/, note: 'custom-typed instancer' },
  // The interactive path, on an authored fixture: one revolute joint whose leaf
  // mesh is offset from its body origin, so a controller that rotated about the
  // wrong point would move it visibly wrong rather than subtly.
  {
    path: 'joints/door.usda',
    meshes: 2,
    parts: 1,
    toggle: true,
    colliders: true,
    pick: true,
    match: /Container: usda/,
    note: 'articulated fixture',
  },
]
if (simready !== undefined) {
  CASES.push({
    path: `simready/${basename(simready.file)}`,
    partsAtLeast: 1,
    match: /Engine: OpenUSD/,
    note: 'real articulated asset',
  })
}
if (realScene !== undefined) {
  CASES.push({
    path: `real/${basename(realScene.file)}`,
    match: /Engine: OpenUSD/,
    warnings: true,
    note: 'real composed scene',
  })
  const sceneRoot = process.env.DSH_USD_TEST_SCENE_ROOT
  if (sceneRoot !== undefined && sceneRoot !== '') {
    // The session address carries a directory, so localized references resolve
    // under it — the case the app's own file addressing produces.
    CASES.push({
      path: `real/${basename(realScene.file)}`,
      root: sceneRoot,
      match: /Engine: OpenUSD/,
      note: 'real composed scene (absolute root)',
    })
  }
}

// `DSH_RENDER_ONLY=real` runs just the matching cases; handy when debugging one
// scene without re-drawing the fixtures.
const ONLY = process.env.DSH_RENDER_ONLY
if (ONLY !== undefined && ONLY !== '') {
  const filtered = CASES.filter(entry => entry.path.includes(ONLY) || entry.note.includes(ONLY))
  assert.ok(filtered.length > 0, `DSH_RENDER_ONLY=${ONLY} matched no case`)
  CASES.length = 0
  CASES.push(...filtered)
}

// ── the harness page, bundled for the browser ───────────────────────────────
const work = await mkdtemp(join(tmpdir(), 'dsh-usd-render-'))
const bundle = join(work, 'harness.js')
await build({
  entryPoints: [join(root, 'tests', 'render.harness.jsx')],
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

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>usd render harness</title>
<style>html,body,#host{margin:0;height:100%;width:100%;background:#14161a}</style></head>
<body><div id="host"></div><script type="module" src="/harness.js"></script></body></html>`

/**
 * Resolve one `/fixture/<name>` request: the committed fixtures, or an env-gated
 * mounted file/directory under its virtual prefix.
 * @returns the absolute path, or undefined when the request is outside the mounts.
 */
function fixturePath(name) {
  for (const mount of MOUNTS) {
    if (name === mount.prefix + basename(mount.file)) return mount.file
    if (name.startsWith(mount.prefix)) {
      const target = normalize(join(mount.directory, name.slice(mount.prefix.length)))
      return target.startsWith(mount.directory) ? target : undefined
    }
  }
  const target = normalize(join(fixtures, name))
  return target.startsWith(fixtures) ? target : undefined
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  // The asset routes are the real host handlers: signing, config resolution, cache.
  if (url.pathname.startsWith('/api/usd-preview')) {
    const route = hostRoutes.get(url.pathname)
    if (route === undefined) {
      res.writeHead(404).end()
      return
    }
    const request = new Request(new URL(req.url ?? '/', 'http://127.0.0.1'), {
      method: req.method ?? 'GET',
      headers: req.headers,
    })
    void route.fetch(request).then(async (response) => {
      res.writeHead(response.status, Object.fromEntries(response.headers))
      res.end(Buffer.from(await response.arrayBuffer()))
    }, () => {
      res.writeHead(500).end()
    })
    return
  }
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
  for (const entry of CASES) {
    const { path, root: caseRoot, meshes, parts, partsAtLeast, toggle, colliders, pick, match, note, warnings } = entry
    const page = await browser.newPage({ viewport: { width: 900, height: 640 } })
    const consoleErrors = []
    page.on('pageerror', error => consoleErrors.push(error?.stack ?? String(error)))
    const query = `?path=${encodeURIComponent(path)}${caseRoot === undefined ? '' : `&root=${encodeURIComponent(caseRoot)}`}`
    await page.goto(`${origin}/${query}`)

    await page.waitForSelector('[data-usd-preview-canvas]', { timeout: 120_000 })
    await page.waitForSelector('[data-usd-stats]', { timeout: 30_000 })
    // Let the orbit loop paint at least one frame after the first resize.
    await page.waitForTimeout(1200)

    const stats = await page.locator('[data-usd-stats]').innerText()
    if (meshes !== undefined) {
      assert.match(stats, new RegExp(`Meshes: ${meshes}`), `${path}: unexpected stats\n${stats}`)
    } else {
      // A real composed scene has an unknown count; it must simply have geometry.
      assert.ok(!/Meshes: 0/.test(stats), `${path}: nothing was composed\n${stats}`)
    }
    assert.match(stats, match, `${path}: unexpected layer/container report\n${stats}`)
    assert.ok(!/Triangles: 0/.test(stats), `${path}: no triangles were assembled\n${stats}`)

    const canvas = page.locator('[data-usd-preview-canvas]')
    const box = await canvas.boundingBox()
    assert.ok(box !== null && box.width > 100 && box.height > 100, `${path}: canvas is not laid out`)

    const shot = join(artifacts, `${path.replaceAll('/', '_')}.png`)
    await canvas.screenshot({ path: shot })

    // The real scene's warnings name the layers the engine could not resolve;
    // they are the only record of why an `s3://` read did or did not happen.
    if (warnings === true) {
      const text = await page.locator('[data-usd-warnings]').innerText().catch(() => '')
      process.stdout.write(`real-scene warnings:\n${text}\n`)
    }

    // The interactive path reports its drivable joints on the shell, so a stage
    // that lost its kinematics (or gained ones it should not have) fails here.
    if (parts !== undefined) {
      const reported = Number(await page.locator('[data-usd-preview]').getAttribute('data-usd-parts'))
      assert.equal(reported, parts, `${path}: expected ${parts} drivable part(s), got ${reported}\n${stats}`)
    }
    if (partsAtLeast !== undefined) {
      const reported = Number(await page.locator('[data-usd-preview]').getAttribute('data-usd-parts'))
      assert.ok(reported >= partsAtLeast, `${path}: expected at least ${partsAtLeast} drivable part(s), got ${reported}\n${stats}`)
    }

    assert.deepEqual(consoleErrors, [], `${path}: the page threw`)
    const caseShot = { path, note, stats, shot }
    if (toggle === true) {
      // Open every part and prove the frame changed: the button alone proves the
      // control exists, the pixels prove the kinematics reached the GPU.
      const closed = join(artifacts, `${path.replaceAll('/', '_')}-closed.png`)
      await canvas.screenshot({ path: closed })
      await page.locator('[data-usd-parts-toggle]').click()
      await page.waitForTimeout(1500)
      const open = join(artifacts, `${path.replaceAll('/', '_')}-open.png`)
      await canvas.screenshot({ path: open })
      caseShot.toggle = { closed, open }
    }
    if (colliders === true) {
      const hasColliders = await page.locator('[data-usd-preview]').getAttribute('data-usd-colliders')
      if (hasColliders === '1') {
        // Collision hulls are authoring-only geometry the engine never draws, so
        // they exist only if the controller rebuilt them from the layer bytes. A
        // pixel difference is the proof that overlay reached the screen.
        const off = join(artifacts, `${path.replaceAll('/', '_')}-colliders-off.png`)
        await canvas.screenshot({ path: off })
        await page.locator('[data-usd-parts-colliders]').click()
        await page.waitForTimeout(800)
        const on = join(artifacts, `${path.replaceAll('/', '_')}-colliders-on.png`)
        await canvas.screenshot({ path: on })
        caseShot.colliders = { off, on }
      }
    }
    if (pick === true) {
      // Clicking the middle of the frame must move the part under the cursor.
      // This is the regression guard for the engine's post-upload array release:
      // with the vertex arrays gone, the hit test throws inside the canvas
      // listener and nothing happens at all.
      const before = join(artifacts, `${path.replaceAll('/', '_')}-pick-before.png`)
      await canvas.screenshot({ path: before })
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await page.waitForTimeout(1200)
      const after = join(artifacts, `${path.replaceAll('/', '_')}-pick-after.png`)
      await canvas.screenshot({ path: after })
      caseShot.pick = { before, after }
    }
    results.push(caseShot)
    await page.close()
  }

  // ── the frame is not a flat surface ───────────────────────────────────────
  for (const { path, note, stats, shot } of results) {
    const colours = await probe.colours(shot)
    // A viewport that failed to draw is one flat background colour. A lit model on
    // a grid is hundreds of shades; the dominant colour stays below everything.
    assert.ok(colours.distinct > 50, `${path}: only ${colours.distinct} distinct colours — nothing was drawn`)
    assert.ok(
      colours.dominant < colours.total * 0.98,
      `${path}: ${colours.dominant}/${colours.total} pixels are one colour — nothing was drawn`,
    )
    process.stdout.write(
      `render  ${path.padEnd(26)} ${note.padEnd(24)} ${String(colours.distinct).padStart(6)} colours  ${stats.replaceAll('\n', ' | ')}\n`,
    )
  }

  // ── opening every part must move pixels ───────────────────────────────────
  // The button existing proves the control is wired; only a frame difference
  // proves the joint actually drove geometry on the GPU.
  for (const { path, toggle, colliders, pick } of results) {
    if (toggle !== undefined) {
      const changed = (await probe.changedPixels(toggle.closed, toggle.open)).changed
      assert.ok(changed > 200, `${path}: opening every part changed only ${changed} pixels`)
      process.stdout.write(`              toggle     ${path.padEnd(26)} ${String(changed).padStart(6)} px moved by "Open all"\n`)
    }
    if (colliders !== undefined) {
      const changed = (await probe.changedPixels(colliders.off, colliders.on)).changed
      assert.ok(changed > 100, `${path}: showing colliders changed only ${changed} pixels`)
      process.stdout.write(`              colliders  ${path.padEnd(26)} ${String(changed).padStart(6)} px added by "Colliders"\n`)
    }
    if (pick !== undefined) {
      const changed = (await probe.changedPixels(pick.before, pick.after)).changed
      assert.ok(changed > 200, `${path}: clicking the middle of the frame changed only ${changed} pixels — the hit test did not reach a part`)
      process.stdout.write(`              pick       ${path.padEnd(26)} ${String(changed).padStart(6)} px moved by a click\n`)
    }
  }
} finally {
  await probe.close().catch(() => undefined)
  await browser.close()
  await new Promise(resolve => server.close(resolve))
  await rm(work, { recursive: true, force: true })
}

process.stdout.write(`render.test.mjs  OK  (${results.length} files drawn in Chromium, screenshots in tests/.artifacts)\n`)
