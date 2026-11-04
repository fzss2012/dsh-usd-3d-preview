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
 * The pixel check additionally needs Pillow; without it the stats and screenshot
 * assertions still run and the colour probe reports itself as skipped.
 *
 * Environment:
 *   PLAYWRIGHT_MODULE  path to a Playwright entry point, when it is not resolvable
 *                      from this package (a global install, for example)
 *   DSH_PYTHON         Python interpreter that has Pillow
 *   DSH_RENDER_ONLY    run only the cases whose path contains this string
 *
 * Run: node tests/render.test.mjs
 */
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

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
  // A global `npm i -g playwright` on Windows lands under %APPDATA%\npm.
  if (process.env.APPDATA !== undefined) {
    candidates.push(pathToFileURL(join(process.env.APPDATA, 'npm', 'node_modules', 'playwright', 'index.js')).href)
  }
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
]

// `DSH_RENDER_ONLY=instancer` runs just the matching cases; handy when debugging
// one drawing without re-running the whole set.
const ONLY = process.env.DSH_RENDER_ONLY
if (ONLY !== undefined && ONLY !== '') {
  const filtered = CASES.filter(entry => entry.path.includes(ONLY))
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
    const name = decodeURIComponent(url.pathname.slice('/fixture/'.length))
    const target = normalize(join(fixtures, name))
    // A path that escapes the fixtures directory is a bad request, not a read.
    if (!target.startsWith(fixtures)) {
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

// ── the pixel probe (optional) ──────────────────────────────────────────────
/**
 * Pick a Python interpreter that can import Pillow, if this machine has one.
 * @returns an argv prefix, or undefined when no interpreter works.
 */
function pythonWithPillow() {
  const candidates = []
  if (process.env.DSH_PYTHON !== undefined) candidates.push([process.env.DSH_PYTHON])
  candidates.push(['python'], ['python3'])
  const probe = 'import PIL, sys; sys.exit(0)'
  for (const candidate of candidates) {
    const check = spawnSync(candidate[0], ['-c', probe], { stdio: 'ignore' })
    if (check.status === 0) return candidate
  }
  return undefined
}

const COLORS = 'import sys\n'
  + 'from PIL import Image\n'
  + 'image = Image.open(sys.argv[1]).convert("RGB")\n'
  + 'colors = image.getcolors(maxcolors=1 << 24)\n'
  + 'print(len(colors), max(count for count, _ in colors), image.size[0] * image.size[1])\n'
const python = pythonWithPillow()
if (python === undefined) {
  process.stdout.write('pixel probe: no Pillow found — colour assertions will be skipped\n')
}

// ── the browser ─────────────────────────────────────────────────────────────
await mkdir(artifacts, { recursive: true })
const browser = await chromium.launch()
const results = []
try {
  for (const { path, meshes, match, note } of CASES) {
    const page = await browser.newPage({ viewport: { width: 900, height: 640 } })
    const consoleErrors = []
    page.on('pageerror', error => consoleErrors.push(error?.stack ?? String(error)))
    await page.goto(`${origin}/?path=${encodeURIComponent(path)}`)

    await page.waitForSelector('[data-usd-preview-canvas]', { timeout: 120_000 })
    await page.waitForSelector('[data-usd-stats]', { timeout: 30_000 })
    // Let the orbit loop paint at least one frame after the first resize.
    await page.waitForTimeout(1200)

    const stats = await page.locator('[data-usd-stats]').innerText()
    if (meshes !== undefined) {
      assert.match(stats, new RegExp(`Meshes: ${meshes}`), `${path}: unexpected stats\n${stats}`)
    } else {
      assert.ok(!/Meshes: 0/.test(stats), `${path}: nothing was composed\n${stats}`)
    }
    assert.match(stats, match, `${path}: unexpected layer/container report\n${stats}`)
    assert.ok(!/Triangles: 0/.test(stats), `${path}: no triangles were assembled\n${stats}`)

    const canvas = page.locator('[data-usd-preview-canvas]')
    const box = await canvas.boundingBox()
    assert.ok(box !== null && box.width > 100 && box.height > 100, `${path}: canvas is not laid out`)

    const shot = join(artifacts, `${path.replaceAll('/', '_')}.png`)
    await canvas.screenshot({ path: shot })

    assert.deepEqual(consoleErrors, [], `${path}: the page threw`)
    results.push({ path, note, stats, shot })
    await page.close()
  }
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
  await rm(work, { recursive: true, force: true })
}

// ── the frame is not a flat surface ─────────────────────────────────────────
for (const { path, note, stats, shot } of results) {
  let probe
  if (python !== undefined) {
    probe = spawnSync(python[0], ['-c', COLORS, shot], { encoding: 'utf8' })
  }
  if (python === undefined || probe.status !== 0) {
    process.stdout.write(`render  ${path.padEnd(24)} ${note.padEnd(22)} colours skipped  ${stats.replaceAll('\n', ' | ')}\n`)
    continue
  }
  const [distinct, dominant, total] = probe.stdout.trim().split(/\s+/).map(Number)
  // A viewport that failed to draw is one flat background colour. A lit model on
  // a grid is hundreds of shades; the dominant colour stays below everything.
  assert.ok(distinct > 50, `${path}: only ${distinct} distinct colours — nothing was drawn`)
  assert.ok(dominant < total * 0.98, `${path}: ${dominant}/${total} pixels are one colour — nothing was drawn`)
  process.stdout.write(
    `render  ${path.padEnd(24)} ${note.padEnd(22)} ${String(distinct).padStart(6)} colours  ${stats.replaceAll('\n', ' | ')}\n`,
  )
}

process.stdout.write(`render.test.mjs  OK  (${results.length} files drawn in Chromium, screenshots in tests/.artifacts)\n`)
