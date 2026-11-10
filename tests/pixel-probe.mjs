/**
 * Screenshot analysis for the browser suites.
 *
 * The suites draw into a WebGL canvas through Playwright and then need numbers
 * about the resulting pixels: distinct colours, a luminance distribution, a
 * bounding box, or the difference between two frames. An earlier version of
 * these suites shelled out to a Python interpreter with Pillow/numpy for that;
 * this repository has no bundled runtime and should not require one.
 *
 * So the PNGs are decoded by the same Chromium that drew them: a blank probe
 * page loads the screenshot as an image, paints it into a 2D canvas, and the
 * canvas hands back the pixel buffer. The assertions stay in Node; only the
 * decoding is remote.
 *
 * All probes use the Rec.709 luminance coefficients (0.2126/0.7152/0.0722).
 *
 * Usage:
 *   const probe = await createPixelProbe(browser)
 *   probe.colours(shotPath)
 *   probe.diff(before, after, threshold)
 *   ...
 *   await probe.close()
 */
import { readFile } from 'node:fs/promises'

/**
 * Decode one data URL and return its RGBA pixels.
 * Defined as a top-level function (no closure) so Playwright can serialize it
 * into the probe page.
 * @param payload - the mode and image data URLs.
 * @returns the numbers the requested mode prints.
 */
async function analyze(payload) {
  const { mode, options, a, b } = payload

  /** @returns {Promise<{width:number, height:number, data:Uint8ClampedArray}>} */
  async function load(dataUrl) {
    const response = await fetch(dataUrl)
    const blob = await response.blob()
    const bitmap = await createImageBitmap(blob)
    const width = bitmap.width
    const height = bitmap.height
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d', { willReadFrequently: true })
    context.drawImage(bitmap, 0, 0)
    const image = context.getImageData(0, 0, width, height)
    if (typeof bitmap.close === 'function') bitmap.close()
    return { width, height, data: image.data }
  }

  /** Rec.709 luma of the pixel at index i. */
  const luma = (data, i) => 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]

  /** Distinct RGB values, dominant count, total, mean luma and clipped share. */
  function colours(image) {
    const { data } = image
    const total = data.length / 4
    const counts = new Map()
    let lumaSum = 0
    let clipped = 0
    for (let i = 0; i < data.length; i += 4) {
      const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
      counts.set(key, (counts.get(key) ?? 0) + 1)
      const value = luma(data, i)
      lumaSum += value
      if (value >= 250) clipped += 1
    }
    let dominant = 0
    for (const count of counts.values()) if (count > dominant) dominant = count
    return {
      distinct: counts.size,
      dominant,
      total,
      meanLuma: Math.round((lumaSum / total) * 100) / 100,
      clipped: Math.round((clipped / total) * 100000) / 100000,
    }
  }

  /** Percentiles of the pixels above the cutoff, plus the overall clipped share. */
  function tone(image, cutoff) {
    const { data } = image
    const values = []
    let clipped = 0
    for (let i = 0; i < data.length; i += 4) {
      const value = luma(data, i)
      if (value >= 250) clipped += 1
      if (value > cutoff) values.push(value)
    }
    if (values.length === 0) return { p10: 0, p50: 0, p90: 0, p99: 0, clipped: 0, pixels: 0 }
    values.sort((left, right) => left - right)
    const at = share => values[Math.min(values.length - 1, Math.max(0, Math.round(share * (values.length - 1))))]
    const round = value => Math.round(value * 10) / 10
    return {
      p10: round(at(0.1)),
      p50: round(at(0.5)),
      p90: round(at(0.9)),
      p99: round(at(0.99)),
      clipped: Math.round((clipped / (data.length / 4)) * 100000) / 100000,
      pixels: values.length,
    }
  }

  /** Centroid and count of the pixels above a luminance cutoff. */
  function centroid(image, cutoff) {
    const { width, data } = image
    let xSum = 0
    let ySum = 0
    let count = 0
    for (let i = 0; i < data.length; i += 4) {
      if (luma(data, i) <= cutoff) continue
      const pixel = i / 4
      xSum += pixel % width
      ySum += Math.floor(pixel / width)
      count += 1
    }
    if (count === 0) return { x: 0, y: 0, pixels: 0 }
    return {
      x: Math.round((xSum / count) * 10) / 10,
      y: Math.round((ySum / count) * 10) / 10,
      pixels: count,
    }
  }

  /** Bounding box of the pixels that differ from the page background. */
  function bbox(image, threshold) {
    const { width, height, data } = image
    const background = [0x14, 0x16, 0x1a]
    let left = width
    let top = height
    let right = -1
    let bottom = -1
    let pixels = 0
    for (let i = 0; i < data.length; i += 4) {
      const differs = Math.abs(data[i] - background[0]) > threshold
        || Math.abs(data[i + 1] - background[1]) > threshold
        || Math.abs(data[i + 2] - background[2]) > threshold
      if (!differs) continue
      const pixel = i / 4
      const x = pixel % width
      const y = Math.floor(pixel / width)
      if (x < left) left = x
      if (x > right) right = x
      if (y < top) top = y
      if (y > bottom) bottom = y
      pixels += 1
    }
    if (right < 0) return { left: 0, top: 0, right: 0, bottom: 0, width, height, pixels: 0 }
    return { left, top, right, bottom, width, height, pixels }
  }

  /** Difference between two frames: changed count, mean delta, luma, centroid. */
  function diff(first, second, threshold) {
    const total = first.width * first.height
    const size = total * 4
    let changed = 0
    let deltaSum = 0
    let lumaFirst = 0
    let lumaSecond = 0
    let xSum = 0
    let ySum = 0
    for (let i = 0; i < size; i += 4) {
      const delta = Math.abs(first.data[i] - second.data[i])
        + Math.abs(first.data[i + 1] - second.data[i + 1])
        + Math.abs(first.data[i + 2] - second.data[i + 2])
      deltaSum += delta
      if (delta <= threshold) continue
      changed += 1
      lumaFirst += luma(first.data, i)
      lumaSecond += luma(second.data, i)
      const pixel = i / 4
      xSum += pixel % first.width
      ySum += Math.floor(pixel / first.width)
    }
    const round = value => Math.round(value * 100) / 100
    return {
      changed,
      total,
      share: changed / total,
      meanDelta: round(deltaSum / total),
      lumaBefore: changed === 0 ? 0 : round(lumaFirst / changed),
      lumaAfter: changed === 0 ? 0 : round(lumaSecond / changed),
      centroidX: changed === 0 ? 0 : Math.round((xSum / changed) * 10) / 10,
      centroidY: changed === 0 ? 0 : Math.round((ySum / changed) * 10) / 10,
    }
  }

  /** Changed pixels with summed delta above the threshold, plus per-frame colour counts. */
  function difference(first, second, threshold) {
    const stats = diff(first, second, threshold)
    const coloursFirst = new Set()
    const coloursSecond = new Set()
    for (let i = 0; i < first.data.length; i += 4) {
      coloursFirst.add((first.data[i] << 16) | (first.data[i + 1] << 8) | first.data[i + 2])
      coloursSecond.add((second.data[i] << 16) | (second.data[i + 1] << 8) | second.data[i + 2])
    }
    let peak = 0
    for (let i = 0; i < first.data.length; i += 4) {
      const delta = Math.max(
        Math.abs(first.data[i] - second.data[i]),
        Math.abs(first.data[i + 1] - second.data[i + 1]),
        Math.abs(first.data[i + 2] - second.data[i + 2]),
      )
      if (delta > peak) peak = delta
    }
    return { ...stats, peak, colorsA: coloursFirst.size, colorsB: coloursSecond.size }
  }

  /** Changed pixels where the per-channel maximum delta exceeds the threshold. */
  function simpleDifference(first, second, threshold) {
    let changed = 0
    for (let i = 0; i < first.data.length; i += 4) {
      const delta = Math.max(
        Math.abs(first.data[i] - second.data[i]),
        Math.abs(first.data[i + 1] - second.data[i + 1]),
        Math.abs(first.data[i + 2] - second.data[i + 2]),
      )
      if (delta > threshold) changed += 1
    }
    return { changed, total: first.width * first.height }
  }

  /** Luma-mask click candidates: centroid first, then samples through the mask. */
  function modelPoints(image, cutoff) {
    const { width, height, data } = image
    const xs = []
    const ys = []
    for (let i = 0; i < data.length; i += 4) {
      if (luma(data, i) <= cutoff) continue
      const pixel = i / 4
      xs.push(pixel % width)
      ys.push(Math.floor(pixel / width))
    }
    if (xs.length < 500) return []
    let xSum = 0
    let ySum = 0
    for (let index = 0; index < xs.length; index += 1) {
      xSum += xs[index]
      ySum += ys[index]
    }
    const points = [[xSum / xs.length / width, ySum / ys.length / height]]
    for (const fraction of [0.2, 0.35, 0.5, 0.65, 0.8]) {
      const index = Math.floor(fraction * (xs.length - 1))
      points.push([xs[index] / width, ys[index] / height])
    }
    return points.map(([x, y]) => ({ x: Math.round(x * 10000) / 10000, y: Math.round(y * 10000) / 10000 }))
  }

  const first = a === undefined ? undefined : await load(a)
  const second = b === undefined ? undefined : await load(b)
  switch (mode) {
    case 'colours': return colours(first)
    case 'tone': return tone(first, options.cutoff ?? 60)
    case 'centroid': return centroid(first, options.cutoff ?? 60)
    case 'bbox': return bbox(first, options.threshold ?? 6)
    case 'diff': return diff(first, second, options.threshold ?? 12)
    case 'difference': return difference(first, second, options.threshold ?? 12)
    case 'simple-diff': return simpleDifference(first, second, options.threshold ?? 2)
    case 'model-points': return modelPoints(first, options.cutoff ?? 90)
    default: throw new Error('unknown pixel probe mode: ' + mode)
  }
}

/**
 * @typedef {object} PixelProbe
 * @property {(path: string) => Promise<object>} colours - distinct/dominant/mean luma.
 * @property {(path: string, cutoff?: number) => Promise<object>} tone - luma percentiles.
 * @property {(path: string, cutoff?: number) => Promise<object>} centroid - luma centroid.
 * @property {(path: string, threshold?: number) => Promise<object>} bbox - non-background box.
 * @property {(first: string, second: string, threshold?: number) => Promise<object>} diff - change stats.
 * @property {(first: string, second: string, threshold?: number) => Promise<object>} difference - change stats plus colour counts and peak.
 * @property {(first: string, second: string, threshold?: number) => Promise<{changed:number,total:number}>} changedPixels - per-channel change count.
 * @property {(path: string, cutoff?: number) => Promise<Array<{x:number,y:number}>>} modelPoints - click candidates in fractions.
 * @property {() => Promise<void>} close - release the probe page.
 */

const dataUrlCache = new Map()

/** Read one screenshot as a PNG data URL, cached by path and size. */
async function dataUrl(path) {
  const bytes = await readFile(path)
  const key = `${path}:${bytes.byteLength}`
  const cached = dataUrlCache.get(key)
  if (cached !== undefined) return cached
  const url = `data:image/png;base64,${bytes.toString('base64')}`
  dataUrlCache.set(key, url)
  return url
}

/**
 * Open one blank page in Chromium and use it to decode screenshots.
 * @param browser - the Playwright browser the suites already launched.
 * @returns the probe, or undefined when the page cannot be created.
 */
export async function createPixelProbe(browser) {
  const page = await browser.newPage()
  await page.goto('about:blank')

  /** Run one probe over the given screenshots. */
  async function run(mode, firstPath, secondPath, options = {}) {
    const payload = {
      mode,
      options,
      a: firstPath === undefined ? undefined : await dataUrl(firstPath),
      b: secondPath === undefined ? undefined : await dataUrl(secondPath),
    }
    return page.evaluate(analyze, payload)
  }

  return {
    colours: path => run('colours', path),
    tone: (path, cutoff = 60) => run('tone', path, undefined, { cutoff }),
    centroid: (path, cutoff = 60) => run('centroid', path, undefined, { cutoff }),
    bbox: (path, threshold = 6) => run('bbox', path, undefined, { threshold }),
    diff: (first, second, threshold = 12) => run('diff', first, second, { threshold }),
    difference: (first, second, threshold = 12) => run('difference', first, second, { threshold }),
    changedPixels: (first, second, threshold = 2) => run('simple-diff', first, second, { threshold }),
    modelPoints: (path, cutoff = 90) => run('model-points', path, undefined, { cutoff }),
    async close() { await page.close() },
  }
}
