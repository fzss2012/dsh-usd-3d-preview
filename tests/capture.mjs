/**
 * Capture screenshots of the USD preview panel for release / review evidence.
 *
 * Dev-only helper. It bundles the checkout's own render harness, serves its
 * committed fixtures over HTTP, mounts the real `UsdBody` in Chromium and writes
 * one PNG per fixture. The same command run against an older checkout produces
 * the "before" side of a visual comparison when the viewport and fixtures match.
 *
 * Requires Playwright and a Chromium build (not package dependencies):
 *
 *   npm install --no-save playwright
 *   npx playwright install chromium
 *
 * Usage:
 *
 *   node tests/capture.mjs --repo . --out /tmp/shots/after --prefix after \
 *     --fixtures arcs/root.usda,sample.usda,instancer/nested.usda,joints/door.usda
 *
 * Options:
 *   --repo     checkout to capture (default: current directory)
 *   --out      output directory (default: /tmp/shots)
 *   --prefix   file-name prefix (default: shot)
 *   --fixtures comma-separated fixture paths under tests/fixtures
 *   --wait     milliseconds to settle before the first capture (default 1600)
 *   --parts    also click the "Open all" toolbar button when the stage has parts,
 *              and capture a `-opened` frame
 *   --click    also click the canvas centre and capture a `-clicked` frame
 */
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, normalize, resolve, sep } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright'

/** Read one `--name value` argument. */
function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

const repo = resolve(arg('repo', '.'))
const out = resolve(arg('out', '/tmp/shots'))
const prefix = arg('prefix', 'shot')
const fixtures = arg('fixtures', 'arcs/root.usda').split(',').map(entry => entry.trim()).filter(Boolean)
const viewport = { width: 900, height: 640 }
const waitMs = Number(arg('wait', '1600'))

const work = await mkdtemp(join(tmpdir(), 'usd-capture-'))
const bundlePath = join(work, 'harness.js')
const fixtureRoot = join(repo, 'tests', 'fixtures')

await build({
  entryPoints: [join(repo, 'tests', 'render.harness.jsx')],
  bundle: true,
  outfile: bundlePath,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'warning',
})
const harness = await readFile(bundlePath)

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>usd capture</title>'
  + '<style>html,body,#host{margin:0;height:100%;width:100%;background:#14161a;overflow:hidden}</style>'
  + '</head><body><div id="host"></div><script type="module" src="/harness.js"></script></body></html>'

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
    const target = normalize(join(fixtureRoot, name))
    if (target !== fixtureRoot && !target.startsWith(fixtureRoot + sep)) {
      res.writeHead(400).end()
      return
    }
    void readFile(target).then(
      (bytes) => {
        res.writeHead(200, {
          'content-type': 'application/octet-stream',
          'content-length': String(bytes.byteLength),
        })
        res.end(bytes)
      },
      () => { res.writeHead(404).end() },
    )
    return
  }
  res.writeHead(404).end()
})
await new Promise(ready => server.listen(0, '127.0.0.1', ready))
const origin = `http://127.0.0.1:${server.address().port}`
await mkdir(out, { recursive: true })

const browser = await chromium.launch()
const errors = []
try {
  for (const fixture of fixtures) {
    const page = await browser.newPage({ viewport })
    page.on('pageerror', error => errors.push(`${fixture}: ${error?.stack ?? error}`))
    await page.goto(`${origin}/?path=${encodeURIComponent(fixture)}`)
    await page.waitForSelector('[data-usd-preview-canvas]', { timeout: 120_000 })
    await page.waitForSelector('[data-usd-stats]', { timeout: 30_000 })
    await page.waitForTimeout(waitMs)

    const name = `${prefix}-${fixture.replaceAll('/', '_').replaceAll('.', '-')}.png`
    const shot = join(out, name)
    await page.locator('#host').screenshot({ path: shot })
    const stats = await page.locator('[data-usd-stats]').innerText()
    process.stdout.write(`capture ${fixture} -> ${shot}\n  ${stats.replaceAll('\n', ' | ')}\n`)

    if (process.argv.includes('--parts')) {
      const toggle = page.locator('[data-usd-parts-toggle]')
      if (await toggle.count() > 0) {
        await toggle.first().click()
        await page.waitForTimeout(1500)
        const openedShot = join(out, name.replace(/\.png$/, '-opened.png'))
        await page.locator('#host').screenshot({ path: openedShot })
        process.stdout.write(`parts ${fixture} -> ${openedShot}\n`)
      }
    }

    if (process.argv.includes('--click')) {
      const box = await page.locator('[data-usd-preview-canvas]').boundingBox()
      if (box !== null) {
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
        await page.waitForTimeout(1200)
        const clickedShot = join(out, name.replace(/\.png$/, '-clicked.png'))
        await page.locator('#host').screenshot({ path: clickedShot })
        process.stdout.write(`click ${fixture} -> ${clickedShot}\n`)
      }
    }
    await page.close()
  }
} finally {
  await browser.close()
  await new Promise(resolveClose => server.close(resolveClose))
  await rm(work, { recursive: true, force: true })
}
if (errors.length > 0) {
  process.stderr.write(`page errors:\n${errors.join('\n')}\n`)
  process.exit(1)
}
