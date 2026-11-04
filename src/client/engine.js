/**
 * OpenUSD assembly through the WASM engine (`@huggingface/usd-web-viewer`).
 *
 * three's own favorite is a parser: it reads a layer and hands the result to a
 * composer whose asset table nobody fills, so a composition-only layer composes
 * to nothing — and a crate layer's `references` list-op is not even decoded.
 * This module runs the real thing instead: `openusd` (pure Rust) compiled to
 * WebAssembly, composing the stage in a worker.
 *
 * The engine fetches its own layers over http(s), which is exactly what a
 * workspace file is not. So every file it may need is handed to it up front in
 * the `files` map, and everything it *reports* missing is fetched through the
 * injected reader and the load is repeated. The engine names the lookup key it
 * wanted (`local:///…`), so the second pass is exact rather than guessed.
 *
 * Both the worker script and the WASM binary travel in this bundle as base64 and
 * become blob URLs at first use: the plugin ships as one module-table entry, and
 * a host route for two extra files is not something a client plugin can assume.
 */
import { loadUsd } from '@huggingface/usd-web-viewer'
import { ENGINE_ASSETS } from './engine-assets.generated.js'

/** Warning codes whose path names a file this preview could supply. */
const FETCHABLE = new Set(['layer-missing', 'texture-failed'])

/** UTF-8 BOM: the three bytes Windows authors put in front of a text layer. */
const BOM = [0xEF, 0xBB, 0xBF]

/** Upper bound on compose passes; a chain deeper than this reports itself. */
export const MAX_PASSES = 8

/** A prim header: `def L2 "w0"`, `over ... `, `class ...`. */
const PRIM_HEADER = /(^|\n)([ \t]*)(def|over|class)\s+([A-Za-z_][\w]*)/g

/**
 * Retype an instancer authored under a custom prim type as `PointInstancer`.
 *
 * Some exporters write a run of repeated modules as a custom-typed prim whose
 * fields are exactly UsdGeomPointInstancer's:
 *
 *     def Grid "row" {
 *         point3f[] positions = [(0, 0, 0), (1.42, 0, 0), (3.02, 0, 0)]
 *         int[] protoIndices = [0, 1, 0]
 *         rel prototypes = [</root/row/Prototypes/proto>]
 *         float3[] scales = [(1.42, 1, 1), (1, 1, 1), (1.42, 1, 1)]
 *     }
 *
 * OpenUSD only instances the standard type, so such a prim composes as an empty
 * one: every placement disappears and all that is left is the prototype geometry
 * at the origin. The attributes already match the schema, so renaming the type is
 * enough to get the placements drawn — no custom schema plugin needed.
 *
 * A prim is rewritten only when its own block carries `protoIndices`, so
 * references and ordinary geometry are never touched.
 * @param text - one ASCII layer.
 * @returns the same text with custom instancer prim types renamed.
 */
export function retypeCustomInstancers(text) {
  if (!text.includes('protoIndices')) return text
  const edits = []
  PRIM_HEADER.lastIndex = 0
  let match
  while ((match = PRIM_HEADER.exec(text)) !== null) {
    const headerStart = match.index + match[1].length
    const type = match[4]
    if (type === 'PointInstancer') continue
    const open = text.indexOf('{', PRIM_HEADER.lastIndex)
    if (open < 0) break
    // The block ends where its braces balance; a prim nested in it must not leak.
    let depth = 0
    let close = -1
    for (let index = open; index < text.length; index += 1) {
      const char = text[index]
      if (char === '}') {
        depth -= 1
        if (depth === 0) { close = index; break }
      } else if (char === '{') depth += 1
    }
    if (close < 0) break
    if (!/\bprotoIndices\b/.test(text.slice(open, close))) continue
    const header = text.slice(headerStart, open)
    const typeAt = header.indexOf(type, match[3].length)
    if (typeAt < 0) continue
    edits.push({ start: headerStart + typeAt, end: headerStart + typeAt + type.length })
  }
  if (edits.length === 0) return text
  let out = text
  for (const edit of edits.reverse()) {
    out = `${out.slice(0, edit.start)}PointInstancer${out.slice(edit.end)}`
  }
  return out
}

/**
 * Drop a leading UTF-8 BOM.
 *
 * The engine's USDA reader is strict about the first byte (`Logos error`), while
 * every Windows authoring tool that writes `-Encoding utf8` emits a BOM. three's
 * parser hides this because `TextDecoder` strips it; the engine does not, so the
 * preview does it before the bytes reach the worker.
 * @param bytes - file bytes as read.
 * @returns the same view when there is no BOM, else a subarray.
 */
export function stripBom(bytes) {
  if (bytes === undefined || bytes === null) return bytes
  if (bytes.byteLength >= 3 && bytes[0] === BOM[0] && bytes[1] === BOM[1] && bytes[2] === BOM[2]) {
    return bytes.subarray(3)
  }
  return bytes
}

/** Decode base64 to bytes without a second copy of the string. */
function fromBase64(text) {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** Blob URLs for the worker and the WASM binary, created once per page. */
let urls
function engineUrls() {
  if (urls === undefined) {
    if (ENGINE_ASSETS.worker === '' || ENGINE_ASSETS.wasm === '') {
      throw new Error('the USD engine assets were not embedded at build time (run `npm run build`)')
    }
    urls = {
      workerUrl: URL.createObjectURL(new Blob([fromBase64(ENGINE_ASSETS.worker)], { type: 'text/javascript' })),
      wasmUrl: URL.createObjectURL(new Blob([fromBase64(ENGINE_ASSETS.wasm)], { type: 'application/wasm' })),
    }
  }
  return urls
}

/**
 * The package-relative path an engine warning names, if it names one at all.
 * @param warning - one `LoadWarning` from the engine.
 * @returns the path, or undefined for a URL the workspace cannot supply.
 */
export function warningKey(warning) {
  const raw = String(warning?.path ?? '')
  // A resolved-but-missing layer comes back as `local:///…`, URL-encoded.
  const local = /^local:\/\/\/(.*)$/.exec(raw)
  if (local !== null) {
    try {
      return decodeURIComponent(local[1])
    } catch {
      return local[1]
    }
  }
  // A relative key is already usable; anything with another scheme is not ours
  // to fetch — this preview reads local workspace files only.
  if (raw === '' || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return undefined
  return raw
}

/**
 * Compose one USD file with the WASM engine, resolving referenced layers through
 * `read` and repeating the load until the engine stops reporting missing files.
 *
 * @param options - assembly inputs.
 * @param options.rootKey - the opened file's workspace-relative path; references
 *   inside it resolve against this key exactly as they do on disk.
 * @param options.rootBytes - the opened file's bytes (already read by the sidebar).
 * @param options.read - reads one workspace-relative path; resolves undefined when
 *   the file does not exist or is empty.
 * @param options.signal - aborts the load and any read in flight.
 * @returns the composed graph, what the engine measured, and the pass log.
 */
export async function loadWithEngine({ rootKey, rootBytes, read, signal }) {
  const { wasmUrl, workerUrl } = engineUrls()
  const files = new Map()
  const passes = []
  let result
  let disposed
  /** The directory the root key lives in; an absolute key makes refs need it. */
  const rootDir = typeof rootKey === 'string' && rootKey.includes('/')
    ? rootKey.slice(0, rootKey.lastIndexOf('/'))
    : ''

  /**
   * Add one layer's bytes under its key.
   *
   * An ASCII layer is normalised on the way in: the BOM is dropped, and a prim
   * that carries PointInstancer fields under a custom type is retyped (see
   * {@link retypeCustomInstancers}). Crate bytes are handed over untouched.
   * @param key - the key the engine will look the layer up under.
   * @param bytes - the layer's bytes.
   */
  const addLayer = (key, bytes) => {
    const stripped = stripBom(bytes)
    const isText = stripped !== undefined && stripped !== null && stripped.byteLength > 5
      && stripped[0] === 0x23 && stripped[1] === 0x75 // `#u`, the USDA magic
    if (!isText) {
      files.set(key, new Blob([stripped]))
      return
    }
    const text = new TextDecoder().decode(stripped)
    files.set(key, new Blob([new TextEncoder().encode(retypeCustomInstancers(text))]))
  }

  /** Register one layer under every key the engine may resolve it to. */
  const registerLayer = (key, bytes) => {
    addLayer(key, bytes)
    // The root key may carry a directory, and an engine that resolves an absolute
    // reference against the root's directory will look under it. Registering both
    // spellings costs nothing and removes that ambiguity.
    if (rootDir !== '') {
      const prefixed = `${rootDir}/${key}`
      if (!files.has(prefixed)) files.set(prefixed, files.get(key))
    }
  }

  addLayer(rootKey, rootBytes)

  for (let pass = 1; pass <= MAX_PASSES; pass += 1) {
    if (signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
    result = await loadUsd(rootKey, { files, textures: 'preview', wasmUrl, workerUrl, signal })
    // Every pass replaces the previous graph; only the last one is handed back.
    if (disposed !== undefined) disposed()
    disposed = result.dispose

    const missing = []
    for (const warning of result.info.warnings) {
      if (!FETCHABLE.has(warning.code)) continue
      const key = warningKey(warning)
      if (key !== undefined && !files.has(key)) missing.push(key)
    }
    const unique = [...new Set(missing)]
    if (unique.length === 0) {
      passes.push({ pass, warnings: result.info.warnings.length, fetched: [] })
      break
    }

    const fetched = []
    for (const key of unique) {
      let bytes
      try {
        bytes = await read(key)
      } catch {
        bytes = undefined
      }
      if (bytes === undefined || bytes === null || bytes.byteLength === 0) continue
      registerLayer(key, bytes)
      fetched.push(key)
    }
    passes.push({ pass, warnings: result.info.warnings.length, fetched })
    if (fetched.length === 0) break
  }

  return { ...result, passes, engine: 'wasm' }
}
