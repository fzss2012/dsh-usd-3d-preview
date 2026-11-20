/**
 * The external-asset drop path: a model dragged onto the sidebar, in a browser.
 *
 * The offline suite proves what a drop collects and which reader each model
 * gets. It cannot prove the thing that makes the feature real — that a dropped
 * `.ifc` reaches a rendered viewport — because the reader is a WASM module in a
 * worker. This suite mounts the real `UsdDropBody` with a pending drop, serves
 * the committed fixtures over HTTP, and checks the facts a broken integration
 * would fail:
 *
 *   * a dropped model mounts the IFC viewport and reports the geometry the
 *     reader produced (the drop path must not fall back to the USD body);
 *   * a drop carrying several models asks which one to open, and the chosen
 *     entry mounts its own reader;
 *   * a drop with no model at all says so instead of rendering an empty frame;
 *   * a file named `.ifc` that is not a model reaches the failure state rather
 *     than hanging the tab.
 *
 * Run: node tests/drop-ifc-render.test.mjs
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
    'drop-ifc-render.test.mjs  SKIP  (Playwright/Chromium not available — '
    + 'run `npm install --no-save playwright && npx playwright install chromium` to enable)\n',
  )
  process.exit(0)
}

const work = await mkdtemp(join(tmpdir(), 'dsh-drop-ifc-'))
const bundle = join(work, 'harness.js')
await build({
  entryPoints: [join(root, 'tests', 'drop-ifc.harness.jsx')],
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

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>drop harness</title>
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

/** Open the harness with one query and return the page and its collected errors. */
async function open(query) {
  const page = await browser.newPage({ viewport: { width: 900, height: 640 } })
  const errors = []
  page.on('pageerror', error => errors.push(error?.stack ?? String(error)))
  await page.goto(`${origin}/?${query}`)
  return { page, errors }
}

try {
  // ── one dropped model: the viewport, not the USD body ─────────────────────
  {
    const { page, errors } = await open('paths=ifc/hello-wall.ifc')
    await page.waitForSelector('[data-ifc-preview]', { timeout: 120_000 })
    await page.waitForSelector('[data-ifc-stats]', { timeout: 120_000 })
    await page.waitForTimeout(1200)
    assert.equal(await page.locator('[data-ifc-preview]').getAttribute('data-usd-engine'), 'web-ifc')
    assert.equal(Number(await page.locator('[data-ifc-preview]').getAttribute('data-ifc-elements')), 5)
    const stats = await page.locator('[data-ifc-stats]').innerText()
    assert.match(stats, /Meshes: 1/, `a dropped model must reach the IFC reader\n${stats}`)
    assert.match(stats, /IFC4/, `the schema must be reported\n${stats}`)
    assert.match(stats, /5\.000 × 3\.000 × 0\.200/, `the extent must be measured in metres\n${stats}`)
    assert.deepEqual(await page.locator('[data-drop-picker]').count(), 0, 'one model needs no picker')

    const canvas = page.locator('[data-usd-preview-canvas]')
    const box = await canvas.boundingBox()
    assert.ok(box !== null && box.width > 100 && box.height > 100, 'the dropped model canvas is not laid out')
    const shot = join(artifacts, 'drop-ifc-hello-wall.png')
    await canvas.screenshot({ path: shot })
    const colours = await probe.colours(shot)
    const distinct = Number(colours?.colors ?? colours?.distinct ?? colours?.count ?? 0)
    assert.ok(distinct > 12, `the dropped model frame is flat (${distinct} distinct colours)`)
    assert.deepEqual(errors, [], 'the dropped model threw')
    process.stdout.write(`dropped hello-wall.ifc  OK  ${stats.replaceAll('\n', ' · ')}  colours=${distinct}\n`)
    await page.close()
  }

  // ── two models: the picker, and the chosen one opens its own reader ───────
  {
    const { page, errors } = await open('paths=ifc/hello-wall.ifc,ifc/building.ifc')
    const picker = page.locator('[data-drop-picker]')
    await picker.waitFor({ timeout: 30_000 })
    const choices = picker.locator('[data-drop-model]')
    assert.equal(await choices.count(), 2, 'a two-model drop must offer both')
    assert.equal(await choices.first().getAttribute('data-drop-kind'), 'ifc')
    await page.locator('[data-drop-model="building.ifc"]').click()
    await page.waitForSelector('[data-ifc-preview]', { timeout: 120_000 })
    await page.waitForTimeout(1200)
    assert.equal(Number(await page.locator('[data-ifc-preview]').getAttribute('data-ifc-elements')), 18)
    const stats = await page.locator('[data-ifc-stats]').innerText()
    assert.match(stats, /Meshes: 12/, `the chosen model must be the one read\n${stats}`)
    assert.match(stats, /8\.000 × 6\.600 × 6\.000/, `the chosen model keeps its own extent\n${stats}`)
    assert.deepEqual(errors, [], 'the picker path threw')
    process.stdout.write(`dropped two models  OK  picked building.ifc  ${stats.replaceAll('\n', ' · ')}\n`)
    await page.close()
  }

  // ── a drop with no model: the zone says so ────────────────────────────────
  {
    const { page, errors } = await open('paths=ifc/hello-wall.ifc&drop=empty')
    const zone = page.locator('[data-drop-zone]')
    await zone.waitFor({ timeout: 30_000 })
    const text = await zone.innerText()
    assert.match(text, /no USD asset or IFC model/i, `a model-less drop must say what it wanted\n${text}`)
    assert.equal(await page.locator('[data-ifc-preview]').count(), 0, 'nothing must be mounted for a model-less drop')
    assert.deepEqual(errors, [], 'the empty drop threw')
    process.stdout.write('drop with no model  OK  (zone reports it)\n')
    await page.close()
  }

  // ── an `.ifc` name that is not a model: the failure state, not a hang ─────
  {
    const { page, errors } = await open('paths=ifc/not-ifc.ifc')
    const alert = page.locator('[role="alert"]')
    await alert.waitFor({ timeout: 120_000 })
    assert.match(await alert.innerText(), /could not be read/i, 'a non-model must reach the failure state')
    assert.deepEqual(errors, [], 'a rejected model must not throw')
    process.stdout.write('dropped not-ifc.ifc  OK  (failure state)\n')
    await page.close()
  }
} finally {
  await browser.close()
  await new Promise(resolve => server.close(resolve))
}
process.stdout.write('drop-ifc-render.test.mjs  OK\n')
