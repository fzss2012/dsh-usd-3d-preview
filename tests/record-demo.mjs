/**
 * Record a short GIF of the interactive articulation (UsdPhysics) path.
 *
 * Dev-only helper for review evidence. It bundles the checkout's own render
 * harness, serves its fixtures, mounts the real `UsdBody` in Chromium, performs a
 * scripted interaction (All open → Home → click a part → colliders on/off) and
 * encodes the captured frames into one animated GIF.
 *
 * Frames are collected through the Chrome DevTools Protocol screencast (the
 * browser pushes compositor frames as they are painted) rather than screenshot
 * polling, so the joint animation is captured at the pace it actually renders.
 *
 * Requires Playwright + Chromium and two small encoders (not package
 * dependencies):
 *
 *   npm install --no-save playwright gifenc jpeg-js
 *   npx playwright install chromium
 *
 * Usage:
 *
 *   node tests/record-demo.mjs --fixture joints/door.usda \
 *     --out docs/screenshots/articulation-demo.gif
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, normalize, resolve, sep } from 'node:path'
import { build } from 'esbuild'
import gifenc from 'gifenc'
import jpeg from 'jpeg-js'
import { chromium } from 'playwright'

const { GIFEncoder, applyPalette, quantize } = gifenc

/** Read one `--name value` argument. */
function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

const repo = resolve(arg('repo', '.'))
const fixture = arg('fixture', 'joints/door.usda')
const out = resolve(arg('out', 'docs/screenshots/articulation-demo.gif'))
const viewport = { width: 900, height: 640 }
const maxFrames = Number(arg('max-frames', '180'))
const clicks = arg('clicks', '0.44,0.47').split(';').map(entry => entry.split(',').map(Number)).filter(pair => pair.length === 2 && pair.every(Number.isFinite))

const work = await mkdtemp(join(tmpdir(), 'usd-record-'))
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

const PAGE = '<!doctype html><html><head><meta charset="utf-8"><title>usd demo</title>'
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

const browser = await chromium.launch()
const frames = []
let page
try {
  page = await browser.newPage({ viewport })
  await page.goto(`${origin}/?path=${encodeURIComponent(fixture)}`)
  await page.waitForSelector('[data-usd-preview-canvas]', { timeout: 120_000 })
  await page.waitForSelector('[data-usd-stats]', { timeout: 30_000 })
  await page.waitForTimeout(1400)

  const movingParts = Number(await page.locator('[data-usd-parts]').first().getAttribute('data-usd-parts'))
  if (!Number.isFinite(movingParts) || movingParts < 1) {
    throw new Error(`${fixture} has no moving parts (data-usd-parts=${movingParts}); pick an articulated fixture`)
  }

  // Caption overlay: the software rasterizer paints only a few frames per second,
  // so each stage of the interaction is labelled instead of relying on motion blur.
  await page.evaluate(() => {
    const caption = document.createElement('div')
    caption.id = 'demo-caption'
    caption.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);'
      + 'padding:8px 18px;border-radius:999px;background:rgba(10,12,16,.78);color:#e8ecf4;'
      + 'font:600 18px/1.3 system-ui,sans-serif;letter-spacing:.2px;z-index:9999;pointer-events:none'
    document.body.appendChild(caption)
  })
  const caption = async (text) => page.evaluate((value) => {
    const element = document.getElementById('demo-caption')
    if (element !== null) element.textContent = value
  }, text)

  // The screencast pushes a JPEG per painted frame; ack each one or the stream stalls.
  const client = await page.context().newCDPSession(page)
  client.on('Page.screencastFrame', (frame) => {
    frames.push({ data: frame.data, timestamp: frame.metadata?.timestamp ?? Date.now() / 1000 })
    client.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined)
  })
  await client.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 90,
    maxWidth: viewport.width,
    maxHeight: viewport.height,
    everyNthFrame: 1,
  })

  // 1. rest pose.
  await caption('1/6 · rest pose')
  await page.waitForTimeout(700)

  // 2. All open: one full travel of the authored joint.
  await caption('2/6 · All open')
  await page.locator('[data-usd-parts-toggle]').click()
  await page.waitForTimeout(1400)

  // 3. Home: back to the authored rest pose.
  await caption('3/6 · Home')
  await page.locator('[data-usd-parts-home]').click()
  await page.waitForTimeout(1400)

  // 4. Click the authored part(s) themselves; each point drives its own joint.
  const box = await page.locator('[data-usd-preview-canvas]').boundingBox()
  if (box === null) throw new Error('canvas is not laid out')
  for (let index = 0; index < clicks.length; index += 1) {
    await caption(clicks.length === 1 ? '4/6 · click the part' : `4/6 · click part ${index + 1}/${clicks.length}`)
    await page.mouse.click(box.x + box.width * clicks[index][0], box.y + box.height * clicks[index][1])
    await page.waitForTimeout(1400)
  }

  // 5. Collider overlay on, then off again (the button only exists when the
  //    stage authored collider geometry).
  const colliderButton = page.locator('[data-usd-parts-colliders]')
  if (await colliderButton.count() > 0) {
    await caption('5/6 · colliders on')
    await colliderButton.click()
    await page.waitForTimeout(700)
    await caption('5/6 · colliders off')
    await colliderButton.click()
    await page.waitForTimeout(400)
  } else {
    await caption('5/6 · no collider geometry authored')
    await page.waitForTimeout(600)
  }

  // 6. Finish back at the authored rest pose.
  await caption('6/6 · Home')
  await page.locator('[data-usd-parts-home]').click()
  await page.waitForTimeout(1400)

  await client.send('Page.stopScreencast')
} finally {
  await browser.close()
  await new Promise(resolveClose => server.close(resolveClose))
  await rm(work, { recursive: true, force: true })
}

if (frames.length < 5) throw new Error(`screencast produced only ${frames.length} frames`)
if (frames.length > maxFrames) {
  // Keep the tail (the newest frames) only when the capture overran the budget.
  frames.splice(0, frames.length - maxFrames)
}
const times = frames.map(frame => frame.timestamp)
const start = times[0]

const gif = GIFEncoder()
let previous = -1
for (let index = 0; index < frames.length; index += 1) {
  const decoded = jpeg.decode(Buffer.from(frames[index].data, 'base64'), { useTArray: true })
  // Screencast output is already viewport-sized; guard against a scaled stream.
  if (decoded.width !== viewport.width || decoded.height !== viewport.height) {
    throw new Error(`unexpected screencast frame size ${decoded.width}x${decoded.height}`)
  }
  const delayMs = index + 1 < frames.length
    ? Math.max(40, Math.min(400, Math.round((times[index + 1] - times[index]) * 1000)))
    : 400
  previous = index
  const palette = quantize(decoded.data, 256, { format: 'rgb565' })
  const paletteIndex = applyPalette(decoded.data, palette, 'rgb444')
  gif.writeFrame(paletteIndex, viewport.width, viewport.height, { palette, delay: delayMs })
}
gif.finish()
const bytes = gif.bytes()
await mkdir(dirname(out), { recursive: true })
await writeFile(out, bytes)
process.stdout.write(`gif ${out}  ${(bytes.byteLength / 1024 / 1024).toFixed(2)} MiB  ${previous + 1} frames\n`)
