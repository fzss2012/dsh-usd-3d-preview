/**
 * Single-file probe: what did the engine actually say about one fixture?
 *
 * The render test asserts a few numbers; when a file «loads but looks wrong» this
 * prints everything the viewport knows — the engine that ran, the pass log, the
 * measured stats, and every warning the engine reported — without touching the
 * source or the suite.
 *
 *   node tests/probe.mjs arcs/root.usda
 *   node tests/probe.mjs instancer/nested.usda three     # force the fallback
 *
 * Not part of `npm test`; it needs Playwright, same as the render suite.
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = join(root, 'tests', 'fixtures')
const path = process.argv[2] ?? 'arcs/root.usda'
const engineArg = process.argv[3] ?? ''

const bundle = await build({
  entryPoints: [join(root, 'tests/render.harness.jsx')],
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'chrome120',
  jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'warning',
})
const harness = bundle.outputFiles[0].text

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>html,body,#host{margin:0;height:100%;width:100%;background:#14161a}</style></head>
<body><div id="host"></div><script type="module" src="/harness.js"></script></body></html>`

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(PAGE) }
  if (url.pathname === '/harness.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); return res.end(harness) }
  if (url.pathname.startsWith('/fixture/')) {
    const name = decodeURIComponent(url.pathname.slice(9))
    const target = normalize(join(fixtures, name))
    if (!target.startsWith(normalize(fixtures))) return res.writeHead(400).end()
    return void readFile(target).then(b => { res.writeHead(200); res.end(b) }, () => res.writeHead(404).end())
  }
  res.writeHead(404).end()
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const origin = `http://127.0.0.1:${server.address().port}`

/** Resolve Playwright from an explicit path, the package, or a global install. */
async function loadChromium() {
  const candidates = []
  if (process.env.PLAYWRIGHT_MODULE !== undefined) candidates.push(pathToFileURL(process.env.PLAYWRIGHT_MODULE).href)
  candidates.push('playwright')
  if (process.env.APPDATA !== undefined) {
    candidates.push(pathToFileURL(join(process.env.APPDATA, 'npm', 'node_modules', 'playwright', 'index.js')).href)
  }
  for (const candidate of candidates) {
    try {
      const loaded = await import(candidate)
      const chromium = loaded.chromium ?? loaded.default?.chromium
      if (chromium !== undefined) return chromium
    } catch {
      // Try the next location.
    }
  }
  throw new Error('Playwright not found — npm install --no-save playwright')
}

const chromium = await loadChromium()
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 900, height: 640 } })
page.on('console', m => process.stdout.write(`[console.${m.type()}] ${m.text()}\n`))
page.on('pageerror', e => process.stdout.write(`[pageerror] ${e}\n`))
await page.goto(`${origin}/?path=${encodeURIComponent(path)}${engineArg === 'three' ? '&engine=three' : ''}`)
await page.waitForSelector('[data-usd-stats]', { timeout: 120_000 })
const engine = await page.locator('[data-usd-preview]').getAttribute('data-usd-engine')
const error = await page.locator('[data-usd-preview]').getAttribute('data-usd-engine-error')
const stats = await page.locator('[data-usd-stats]').innerText()
const warnings = await page.locator('[data-usd-warnings]').count() === 0
  ? ''
  : await page.locator('[data-usd-warnings]').innerText()
process.stdout.write(`engine=${engine}\nengineError=${error}\n--- stats ---\n${stats}\n--- warnings ---\n${warnings}\n`)
await browser.close()
await new Promise(r => server.close(r))
