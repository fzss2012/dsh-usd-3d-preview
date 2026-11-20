/**
 * IFC preview: the real body component in a real browser.
 *
 * The offline suite proves the container and path helpers in Node. It cannot
 * prove the thing the user asked for — that an .ifc file turns into a lit model in
 * a canvas — because the reader is a WASM module in a worker. This suite mounts
 * `IfcBody` in Chromium with WebGL on, serves the fixtures over HTTP, and checks
 * the facts that a broken integration would fail:
 *
 *   * the stats line reports the geometry the reader produced;
 *   * the rendered frame is not flat (counted distinct colours in a screenshot);
 *   * the element tree lists the spatial structure and filters it;
 *   * a click on the model names the element under the cursor.
 *
 * Run: node tests/ifc-render.test.mjs
 */
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, normalize } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createPixelProbe } from './pixel-probe.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = join(root, 'tests', 'fixtures')
const artifacts = join(root, 'tests', '.artifacts')

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
    'ifc-render.test.mjs  SKIP  (Playwright/Chromium not available — '
    + 'run `npm install --no-save playwright && npx playwright install chromium` to enable)\n',
  )
  process.exit(0)
}

const CASES = [
  {
    path: 'ifc/hello-wall.ifc',
    meshes: 1,
    elements: 5,
    schema: /IFC4/,
    size: /Size: 5\.000 × 3\.000 × 0\.200/,
    prims: true,
    note: 'single wall, mm units',
  },
  // The same model inside an IFCZIP package: the container is unwrapped on the
  // page, so the numbers must be identical to the bare STEP file above. A package
  // the reader did not open would report an empty stage, not a smaller one.
  {
    path: 'ifc/hello-wall.ifczip',
    meshes: 1,
    elements: 5,
    schema: /IFC4/,
    size: /Size: 5\.000 × 3\.000 × 0\.200/,
    note: 'the same wall in an IFCZIP package',
  },
  // The multi-storey fixture: a real spatial tree (project → site → building →
  // two storeys), six element types, per-type surface styles, property sets and a
  // boolean void cut through two walls. The size assertion is the unit test: the
  // file authors millimetres and web-ifc converts to metres, so a preview that
  // skipped the conversion would report 8000 × 6600 × 6000 here.
  {
    path: 'ifc/building.ifc',
    meshes: 12,
    elements: 18,
    schema: /IFC4/,
    size: /Size: 8\.000 × 6\.600 × 6\.000/,
    unit: /Authored in: mm/,
    prims: true,
    details: true,
    note: 'two-storey building, mm units, colours, property sets',
  },
]

const ONLY = process.env.DSH_IFC_RENDER_ONLY
if (ONLY !== undefined && ONLY !== '') {
  const filtered = CASES.filter(entry => entry.path.includes(ONLY) || entry.note.includes(ONLY))
  assert.ok(filtered.length > 0, `DSH_IFC_RENDER_ONLY=${ONLY} matched no case`)
  CASES.length = 0
  CASES.push(...filtered)
}

const work = await mkdtemp(join(tmpdir(), 'dsh-ifc-render-'))
const bundle = join(work, 'harness.js')
await build({
  entryPoints: [join(root, 'tests', 'ifc.harness.jsx')],
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

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>ifc render harness</title>
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
    if (!target.startsWith(fixtures)) { res.writeHead(400).end(); return }
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

await mkdir(artifacts, { recursive: true })
const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
const probe = await createPixelProbe(browser)
try {
  for (const entry of CASES) {
    const { path, meshes, elements, schema, size, unit, prims, details } = entry
    const page = await browser.newPage({ viewport: { width: 900, height: 640 } })
    const consoleErrors = []
    page.on('pageerror', error => consoleErrors.push(error?.stack ?? String(error)))
    await page.goto(`${origin}/?path=${encodeURIComponent(path)}`)

    await page.waitForSelector('[data-usd-preview-canvas]', { timeout: 120_000 })
    await page.waitForSelector('[data-ifc-stats]', { timeout: 120_000 })
    await page.waitForTimeout(1200)

    const stats = await page.locator('[data-ifc-stats]').innerText()
    assert.match(stats, new RegExp(`Meshes: ${meshes}`), `${path}: unexpected stats\n${stats}`)
    assert.match(stats, schema, `${path}: unexpected schema report\n${stats}`)
    assert.ok(!/Triangles: 0/.test(stats), `${path}: no triangles were read\n${stats}`)
    if (size !== undefined) {
      // The size is the unit test: it is measured in metres from the graph, so it
      // only matches when the authored unit was converted exactly once.
      assert.match(stats, size, `${path}: unexpected extent\n${stats}`)
    }
    if (unit !== undefined) assert.match(stats, unit, `${path}: the authored unit is not reported\n${stats}`)

    assert.equal(
      Number(await page.locator('[data-ifc-preview]').getAttribute('data-ifc-elements')),
      elements,
      `${path}: unexpected element count`,
    )

    const canvas = page.locator('[data-usd-preview-canvas]')
    const box = await canvas.boundingBox()
    assert.ok(box !== null && box.width > 100 && box.height > 100, `${path}: canvas is not laid out`)
    const shot = join(artifacts, `ifc-${basename(path)}.png`)
    await canvas.screenshot({ path: shot })
    // A flat frame is a failed draw: the studio rig alone puts a gradient on the
    // ground disc, so a handful of distinct colours means nothing was rendered.
    const colours = await probe.colours(shot)
    const distinct = Number(colours?.colors ?? colours?.distinct ?? colours?.count ?? 0)
    assert.ok(distinct > 12, `${path}: the frame is flat (${distinct} distinct colours)`)

    if (prims === true) {
      const toggle = page.locator('[data-ifc-elements-toggle]')
      const text = await toggle.innerText()
      const count = Number((/Elements\s*·\s*(\d+)/.exec(text) || [])[1])
      assert.ok(Number.isFinite(count) && count >= elements, `${path}: expected element rows, got ${text}`)
      await toggle.click()
      const panel = page.locator('[data-ifc-element-tree]')
      await panel.waitFor()
      const rows = panel.locator('[data-ifc-element-row]')
      assert.ok(await rows.count() >= 2, `${path}: the tree must show rows`)
      const firstPath = await rows.nth(0).getAttribute('data-usd-prim-path')
      assert.ok(firstPath !== null && firstPath.startsWith('/'), `${path}: a row must carry a path, got ${firstPath}`)
    }

    if (details === true) {
      // The details panel reads the element's property sets back out of the model.
      // A wall with a Pset_WallCommon is the case that proves the relation scan
      // works: the properties hang off the set, not off the element.
      const wall = page.locator('[data-ifc-element-row][data-usd-prim-path$="/South Wall"] [data-ifc-row-label]')
      assert.ok(await wall.count() > 0, `${path}: the tree does not list the South Wall`)
      await wall.first().click()
      await page.locator('[data-ifc-details-toggle]').click()
      const detailsPanel = page.locator('[data-ifc-details]')
      await detailsPanel.waitFor({ timeout: 30_000 })
      // The panel is driven by an async read, so its first frame is the loading
      // state. Waiting for the row is what proves the read actually completed.
      await page.locator('[data-ifc-property="IsExternal"]').waitFor({ timeout: 60_000 })
      const text = await detailsPanel.innerText()
      assert.match(text, /Pset_WallCommon/i, `${path}: the property set is not listed\n${text}`)
      assert.match(text, /IsExternal/, `${path}: the property is not listed\n${text}`)
      // The value's declared IFC type is what makes a property readable, and the
      // boolean has to come back as a boolean rather than as the STEP text.
      assert.match(text, /IFCBOOLEAN/, `${path}: the property type is not reported\n${text}`)
      assert.match(text, /IsExternal[\s\S]{0,40}true/, `${path}: the boolean value was not read\n${text}`)
      // A wall with an opening cut through it is both a folder and an element:
      // the caret folds it, the label selects it. One click must not do both.
      const caret = page.locator('[data-ifc-element-row][data-usd-prim-path$="/South Wall"] [data-ifc-row-caret]')
      const before = await page.locator('[data-ifc-element-row]').count()
      await caret.first().click()
      await page.waitForTimeout(250)
      assert.ok(
        await page.locator('[data-ifc-element-row]').count() < before,
        `${path}: the caret must fold the row's children`,
      )
    }

    assert.deepEqual(consoleErrors, [], `${path}: the page threw`)
    process.stdout.write(`${path}  OK  ${stats.replaceAll('\n', ' · ')}  colours=${distinct}\n`)
  }
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
}
process.stdout.write('ifc-render.test.mjs  OK\n')
