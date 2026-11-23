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
assert.equal(hostRoutes.size, 6, 'the host half registered the asset, health, list, search, update and connection routes')

/** Files to draw, and the geometry each must report. */
const CASES = [
  { path: 'sample.usdz', meshes: 2, match: /Layers: 1/, note: 'package' },
  { path: 'sample.usda', meshes: 2, match: /Container: usda/, note: 'ASCII + prims', prims: true, flat: true },
  // The crate fixture is the parity case for the details panel: the same stage in
  // a binary container must list the same attributes with the same declared types.
  { path: 'sample.usdc', meshes: 2, match: /Container: usdc/, note: 'binary crate', prims: true },
  // One quad in a second layer: the case where the bytes alone are not enough.
  // It is also the details panel's composed-path case: the mesh the click names is
  // /root/unit/body, while the layer that describes it wrote /root/body.
  { path: 'refs/unit.usda', meshes: 1, match: /Layers: 2/, note: 'reference chain', prims: true, composed: true },
  // subLayers + reference: an arc three's composer does not implement at all.
  { path: 'arcs/root.usda', meshes: 2, match: /Layers: 3/, note: 'sublayer + reference', prims: true },
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
  // Custom types at two nesting levels, with the inner instancer behind a custom
  // group: 2 outer placements x 3 inner quads = 6 quads. A retype pass that
  // promoted the group (or missed the nested instancer) draws 0 or 3.
  { path: 'instancer/custom-nested.usda', absolute: true, meshes: 6, match: /Layers: 1/, note: 'custom nested instancer' },
  // The same library shape with the inner instancer inside a payload: the root
  // places /root/Mod/row twice, and each payload row places the quad twice, so
  // four quads are drawn and the second layer must have been fetched and retyped.
  { path: 'instancer/payload/root.usda', meshes: 4, match: /Layers: 2/, note: 'custom instancer behind payload' },
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
    const { path, root: caseRoot, absolute, meshes, parts, partsAtLeast, toggle, colliders, pick, prims, composed, flat, match, note, warnings } = entry
    const page = await browser.newPage({ viewport: { width: 900, height: 640 } })
    const consoleErrors = []
    page.on('pageerror', error => consoleErrors.push(error?.stack ?? String(error)))
    const query = `?path=${encodeURIComponent(path)}${caseRoot === undefined ? '' : `&root=${encodeURIComponent(caseRoot)}`}${absolute === true ? '&absolute=1' : ''}`
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

    // A stage under the picking budget keeps its CPU arrays, so the canvas can
    // name the prim under the cursor; every committed fixture is under it.
    assert.equal(
      await page.locator('[data-usd-preview]').getAttribute('data-usd-pickable'),
      '1',
      `${path}: a stage under the picking budget must stay pickable`,
    )

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
    if (prims === true) {
      // The panel lists the geometry-bearing prim paths, filters them, and a
      // click on the model names the prim under the cursor. This is the guard
      // for the pick registration: with no handler a click names nothing, and
      // with a handler on released arrays the page throws instead.
      const primsToggle = page.locator('[data-usd-prims-toggle]')
      const primsText = await primsToggle.innerText()
      const primCount = Number((/Prims\s*·\s*(\d+)/.exec(primsText) || [])[1])
      assert.ok(Number.isFinite(primCount) && primCount >= 2, `${path}: expected prim paths, got ${primsText}`)
      await primsToggle.click()
      const panel = page.locator('[data-usd-prims]')
      await panel.waitFor()
      const rows = panel.locator('[data-usd-prim-row]')
      const rowCount = await rows.count()
      assert.ok(rowCount >= 2 && rowCount <= primCount, `${path}: the tree must show rows within the prim count, got ${rowCount}/${primCount}`)
      // Every row carries its full path as data, and names in the tree are the
      // last segment of that path rather than the whole repeated prefix.
      const firstPath = await rows.nth(0).getAttribute('data-usd-prim-path')
      assert.ok(firstPath !== null && firstPath.startsWith('/'), `${path}: a row must carry a prim path, got ${firstPath}`)
      const firstName = (await rows.nth(0).innerText()).replace('✓', '').trim()
      assert.equal(firstName, firstPath.split('/').filter(Boolean).pop(), `${path}: a row shows its segment name`)
      const filter = panel.locator('input')
      await filter.fill(firstPath.split('/').filter(Boolean).pop())
      await page.waitForTimeout(250)
      assert.ok(await rows.count() >= 1, `${path}: the filter must keep a match`)
      // Filtering exposes every match with its ancestors and subtrees open.
      const filteredPaths = await rows.evaluateAll(nodes => nodes.map(n => n.getAttribute('data-usd-prim-path')))
      assert.ok(filteredPaths.every(p => p === null || p.toLowerCase().includes(firstPath.split('/').filter(Boolean).pop().toLowerCase()) || firstPath.toLowerCase().includes(p.toLowerCase())), `${path}: the filter must keep ancestors with their matches`)
      await filter.fill('')
      await page.waitForTimeout(250)
      // A folder row toggles its children; a leaf row copies its path. This is
      // checked with the filter off: a filtered tree forces every match open.
      const folder = panel.locator('[data-usd-prim-folder="1"]')
      if (await folder.count() > 0) {
        const before = await rows.count()
        await folder.first().click()
        await page.waitForTimeout(120)
        const after = await rows.count()
        assert.ok(after < before || after > before, `${path}: collapsing a folder must change the visible rows`)
        await folder.first().click()
        await page.waitForTimeout(120)
      }

      // ── clicking the model selects, and Escape clears ───────────────────
      // This is the user-facing contract in pixels: the click that names a prim
      // also tints it, and the animation shows which one. The selection is read
      // back from `data-usd-selected` and from the frame itself.
      const unselectedShot = join(artifacts, `${path.replaceAll('/', '_')}-selected-none.png`)
      await canvas.screenshot({ path: unselectedShot })
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await page.waitForTimeout(1000)
      const pickedCount = await page.locator('[data-usd-picked]').count()
      const picked = pickedCount === 0 ? '' : await page.locator('[data-usd-picked]').first().innerText()
      assert.match(picked, /\//, `${path}: a canvas click must name the picked prim (got "${picked}")`)
      const selectedPath = await page.locator('[data-usd-preview]').getAttribute('data-usd-selected')
      assert.ok(
        selectedPath !== null && selectedPath.startsWith('/'),
        `${path}: a click did not report a selected prim path, got "${selectedPath}"`,
      )
      const selectedShot = join(artifacts, `${path.replaceAll('/', '_')}-selected-highlight.png`)
      await canvas.screenshot({ path: selectedShot })
      const highlight = await probe.difference(unselectedShot, selectedShot, 12)
      assert.ok(highlight.changed > 200, `${path}: selecting a prim changed only ${highlight.changed} pixels`)
      assert.ok(
        (highlight.blueAfter - highlight.redAfter) > (highlight.blueBefore - highlight.redBefore) + 10,
        `${path}: the selection is not tinted towards the accent (blue-red `
          + `${(highlight.blueBefore - highlight.redBefore).toFixed(1)} -> ${(highlight.blueAfter - highlight.redAfter).toFixed(1)})`,
      )
      caseShot.selection = { path: selectedPath, highlighted: highlight.changed }

      // Escape clears the tint and the name together, and the frame returns to
      // exactly the unselected one.
      await page.keyboard.press('Escape')
      await page.waitForTimeout(600)
      assert.equal(
        await page.locator('[data-usd-preview]').getAttribute('data-usd-selected'),
        '',
        `${path}: Escape left a prim selected`,
      )
      assert.equal(await page.locator('[data-usd-picked]').count(), 0, `${path}: Escape left the picked name in the panel`)
      const clearedShot = join(artifacts, `${path.replaceAll('/', '_')}-selected-cleared.png`)
      await canvas.screenshot({ path: clearedShot })
      const cleared = await probe.difference(unselectedShot, clearedShot, 12)
      assert.ok(
        cleared.changed < cleared.total * 0.002,
        `${path}: Escape did not restore the frame (${cleared.changed} pixels differ)`,
      )
      // The tighter statement: no pixel moved by more than the renderer's own
      // noise. `peak` is the largest per-channel delta anywhere in the frame, and
      // a tint that failed to clear shows up in the tens — the software
      // rasterizer's antialiasing jitter is one or two. A count of changed pixels
      // alone would either miss a faint leftover tint or trip on that jitter.
      assert.ok(
        cleared.peak <= 8,
        `${path}: clearing the selection left a visible trace (peak channel delta ${cleared.peak})`,
      )

      // The panel's × is the same undo for a pointer: it is the only affordance
      // left once the prims panel is closed (the hint carries it too), so it is
      // clicked here rather than assumed to work because the handler is shared.
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await page.waitForTimeout(800)
      assert.ok(
        (await page.locator('[data-usd-preview]').getAttribute('data-usd-selected')) !== '',
        `${path}: the × check ran without a selection`,
      )
      await panel.locator('[data-usd-picked-clear]').click()
      await page.waitForTimeout(600)
      assert.equal(
        await page.locator('[data-usd-preview]').getAttribute('data-usd-selected'),
        '',
        `${path}: the panel's × button left the prim selected`,
      )
      const buttonShot = join(artifacts, `${path.replaceAll('/', '_')}-selected-cleared-by-button.png`)
      await canvas.screenshot({ path: buttonShot })
      const buttonDelta = await probe.difference(unselectedShot, buttonShot, 12)
      assert.ok(
        buttonDelta.changed < buttonDelta.total * 0.002,
        `${path}: the × button did not restore the frame (${buttonDelta.changed} pixels differ)`,
      )
      assert.ok(
        buttonDelta.peak <= 8,
        `${path}: the × button left a visible trace (peak channel delta ${buttonDelta.peak})`,
      )

      // ── the details panel reads what the file declares ──────────────────
      // The remaining assertion in this case is about *content*, which pixels
      // cannot check: the panel has to show the prim's declared type, its
      // attributes with declared types, and its relationships — from the layer
      // bytes, which is the whole reason it is a second reader.
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await page.waitForTimeout(800)
      const detailsPath = await page.locator('[data-usd-preview]').getAttribute('data-usd-selected')
      await page.locator('[data-usd-details-toggle]').click()
      const details = page.locator('[data-usd-details]')
      await details.waitFor({ timeout: 15_000 })
      // The panel is async: it reads the layers off the main thread's queue.
      await page.waitForTimeout(900)
      const detailsText = await details.innerText()
      assert.ok(
        detailsText.includes(detailsPath),
        `${path}: the details panel does not name the selected prim (${detailsPath})\n${detailsText.slice(0, 400)}`,
      )
      // The prim that was clicked is a mesh in every fixture: its declared type
      // and its geometry attributes must be stated.
      const detailAttributes = await details.locator('[data-usd-detail-attr]').count()
      assert.ok(detailAttributes > 0, `${path}: the details panel listed no attributes\n${detailsText.slice(0, 400)}`)
      const attributeNames = await details.locator('[data-usd-detail-attr]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-usd-detail-attr')))
      const known = ['points', 'faceVertexCounts', 'faceVertexIndices', 'extent', 'xformOp:translate', 'xformOp:scale', 'primvars:st']
      assert.ok(
        attributeNames.some(name => known.includes(name)),
        `${path}: the details panel listed none of the mesh's own attributes: ${attributeNames.join(', ')}`,
      )
      // A declared type is printed beside each attribute: `point3f[]`, `int[]`,
      // not "object" or an empty cell.
      if (attributeNames.includes('points')) {
        const pointsRow = details.locator('[data-usd-detail-attr="points"]')
        const pointsText = await pointsRow.innerText()
        assert.match(pointsText, /point3f\[\]/, `${path}: the points attribute does not show its declared type: ${pointsText}`)
        const pointsValue = await pointsRow.locator('[data-usd-detail-value]').innerText()
        assert.ok(pointsValue.length > 0 && pointsValue !== '—', `${path}: the points attribute has no value`)
      }
      // The layer the values came from is named, so a surprising value is traceable.
      // It is not always the opened file: a prim a reference composes is described
      // by the referenced layer, which is the case this assertion must allow for.
      assert.match(detailsText, /\.usd[acz]?\b/, `${path}: the details panel does not name its layer\n${detailsText.slice(0, 400)}`)
      // A prim reached through a reference is authored under a path the stage does
      // not use, and the panel names both — that is the fact this feature exists to
      // make visible. `refs/unit.usda` is the deterministic case: its only mesh
      // belongs to the referenced layer, so the click always lands on one.
      if (composed === true) {
        const authored = details.locator('[data-usd-detail-authored]')
        assert.equal(await authored.count(), 1, `${path}: the details panel does not say where the referenced prim is authored\n${detailsText.slice(0, 400)}`)
        const authoredPath = (await authored.innerText()).trim()
        assert.ok(authoredPath.startsWith('/'), `${path}: the authored path must be a prim path, got "${authoredPath}"`)
        assert.notEqual(authoredPath, detailsPath, `${path}: the authored path must differ from the composed one`)
        caseShot.authored = authoredPath
      } else if (flat === true) {
        assert.equal(
          await details.locator('[data-usd-detail-authored]').count(),
          0,
          `${path}: a prim authored at its own stage path must not repeat it`,
        )
      }
      caseShot.details = { attributes: detailAttributes, names: attributeNames.slice(0, 8) }
      const detailsShot = join(artifacts, `${path.replaceAll('/', '_')}-details.png`)
      await page.screenshot({ path: detailsShot })
      await details.locator('[data-usd-details-close]').click()
      assert.equal(await page.locator('[data-usd-details]').count(), 0, `${path}: the panel's × did not close it`)

      caseShot.prims = { count: primCount, picked, selection: selectedPath, cleared: cleared.changed }
    }

    // ── text mode: the layer's own USDA text, not the drawn graph ────────────
    // The button is in the toolbar; what it opens is read from the layer bytes
    // rather than from the assembled graph, so a crate's reconstruction and an
    // ASCII layer's authored text are the two cases this pins.
    if (prims === true) {
      await page.locator('[data-usd-text-toggle]').click()
      const textView = page.locator('[data-usd-text]')
      await textView.waitFor({ timeout: 15_000 })
      await page.waitForFunction(() => {
        const node = document.querySelector('[data-usd-text]')
        return node !== null && (node.getAttribute('data-usd-text-kind') ?? '') !== ''
      }, undefined, { timeout: 20_000 })
      const textKind = await textView.getAttribute('data-usd-text-kind')
      assert.equal(textKind, 'text', `${path}: the text mode must render text, got "${textKind}"`)
      const textRows = await page.locator('[data-usd-text-line]').count()
      assert.ok(textRows > 0, `${path}: the text mode rendered no lines`)
      const textBody = await textView.innerText()
      assert.ok(textBody.includes('#usda 1.0'), `${path}: the USDA header is missing from the text view\n${textBody.slice(0, 300)}`)
      const textShot = join(artifacts, `${path.replaceAll('/', '_')}-text.png`)
      await page.screenshot({ path: textShot })
      caseShot.text = { kind: textKind, rows: textRows, shot: textShot }
      // The text view covers the toolbar by design, so its own × is the way back.
      await page.locator('[data-usd-text-close]').click()
      await page.waitForTimeout(250)
      assert.equal(await page.locator('[data-usd-text]').count(), 0, `${path}: the text panel's × did not close the text view`)

      // ── composition: the layer stack and the arcs that composed it ────────
      const engine = await page.locator('[data-usd-preview]').getAttribute('data-usd-engine')
      await page.locator('[data-usd-composition-toggle]').click()
      const composition = page.locator('[data-usd-composition]')
      await composition.waitFor({ timeout: 15_000 })
      await page.waitForTimeout(600)
      const compositionText = await composition.innerText()
      const compositionNodes = await page.locator('[data-usd-composition-node]').count()
      if (engine === 'wasm') {
        assert.ok(compositionNodes >= 1, `${path}: the composition panel listed no layers`)
        assert.match(compositionText, /root layer/, `${path}: the composition panel does not name the root layer\n${compositionText.slice(0, 300)}`)
        if (path.startsWith('arcs/')) {
          assert.ok(compositionNodes >= 3, `${path}: expected root + sublayer + reference nodes, got ${compositionNodes}\n${compositionText.slice(0, 400)}`)
          assert.match(compositionText, /sublayer/, `${path}: the sublayer arc is missing from the panel`)
          assert.match(compositionText, /reference/, `${path}: the reference arc is missing from the panel`)
        }
      } else {
        assert.match(compositionText, /cannot be read back/i, `${path}: a fallback-composed stage must say why the composition is unavailable`)
      }
      const compositionShot = join(artifacts, `${path.replaceAll('/', '_')}-composition.png`)
      await page.screenshot({ path: compositionShot })
      caseShot.composition = { nodes: compositionNodes, shot: compositionShot }
      await page.locator('[data-usd-composition-close]').click()
      assert.equal(await page.locator('[data-usd-composition]').count(), 0, `${path}: the composition panel's × did not close it`)
      assert.deepEqual(consoleErrors, [], `${path}: the read-back modes threw`)
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
