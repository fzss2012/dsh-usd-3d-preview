/**
 * The IFC worker's bootstrap.
 *
 * `new Worker(url)` needs a real script, so the engine cannot be shipped
 * gzipped-and-inlined in the same file that starts the worker. This file is that
 * small script: it receives the engine bundle and the WASM binary as
 * gzip-compressed base64, decompresses both with the platform's own
 * `DecompressionStream`, and hands control to the engine.
 *
 * ## Why gzip at all
 *
 * A client plugin ships as one module-table entry and the shell serves it as one
 * JavaScript file, so anything embedded in it travels uncompressed. web-ifc's
 * bundle is 3.5 MiB minified and its WASM binary 1.6 MiB; base64 of the raw bytes
 * is 6.8 MiB added to a bundle that is already 5.3 MiB. Gzipped they are 0.4 MiB
 * and 0.6 MiB, which is the difference between "this plugin is large" and "this
 * plugin is a download". `DecompressionStream` is a platform primitive
 * (Chrome 80+, and this bundle targets chrome120), so the cost is one
 * asynchronous step on first use and nothing at all afterwards.
 *
 * ## The handshake
 *
 * The page posts `{ kind: 'configure', engine, wasm }` first, then its real
 * requests. Anything that arrives before the decompression finishes is queued
 * rather than dropped: the page is allowed to post an `open` immediately after
 * starting the worker, and a message that vanished would look like a hung model.
 * @module dsh-usd-3d-preview/ifc-worker-boot
 */

/** Requests that arrived before the engine finished loading. */
const queued = []

/** The decompression in flight, or undefined before the first message. */
let booting

/**
 * Decode one gzip-compressed base64 string to bytes.
 * @param text - base64 text of a gzip stream.
 * @returns the decompressed bytes.
 */
async function gunzipBase64(text) {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * Decompress the engine and the WASM binary, then hand control to the engine.
 *
 * `importScripts` runs the engine bundle synchronously, and that bundle installs
 * its own `self.onmessage` — which is what retires this bootstrap.
 * @param config - the page's configure message.
 */
async function boot(config) {
  const [engine, wasm] = await Promise.all([
    gunzipBase64(config.engine),
    gunzipBase64(config.wasm),
  ])
  // web-ifc reads its WASM location through `locateFile`, and a blob URL is the
  // cheapest thing to hand it: the bytes are already in memory, so nothing is
  // fetched twice and no origin or CORS question arises.
  globalThis.__DSH_IFC_WASM_URL__ = URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }))
  const engineUrl = URL.createObjectURL(new Blob([engine], { type: 'text/javascript' }))
  try {
    importScripts(engineUrl)
  } finally {
    URL.revokeObjectURL(engineUrl)
  }
  if (typeof self.onmessage !== 'function') {
    throw new Error('the IFC engine bundle installed no message handler')
  }
  for (const message of queued.splice(0)) self.onmessage({ data: message })
}

self.onmessage = (event) => {
  const data = event.data
  if (data !== null && typeof data === 'object' && data.kind === 'configure') {
    booting = boot(data)
    // A failed boot must not become an unhandled rejection: the page reports the
    // failure when its first request is answered, which is where it can be shown.
    booting.catch(() => undefined)
    return
  }
  if (booting === undefined) {
    queued.push(data)
    return
  }
  // Re-read `self.onmessage` on every delivery: after the boot it is the engine's
  // handler, and this bootstrap must not keep answering in its place.
  booting.then(
    () => self.onmessage({ data }),
    (error) => self.postMessage({
      id: data?.id,
      ok: false,
      error: 'the IFC engine could not start: ' + String(error?.message ?? error),
    }),
  )
}
