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
 * injected readers and the load is repeated. The engine names the lookup key it
 * wanted (`local:///…`), so the second pass is exact rather than guessed.
 *
 * `s3://…` references need one extra step, because the engine has no `s3`
 * resolver: an ASCII layer's references are rewritten to package keys under
 * `__assets__/` before its bytes reach the engine, and the object bytes are
 * fetched through the injected asset reader (a signed host route, because a
 * browser cannot sign). That is what makes a stage whose geometry lives in
 * object storage assemble at all.
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

/** Package prefix every `s3://` layer is localized under. */
const LOCALIZED = '__assets__/'

/** One `s3://…` literal inside a layer's bytes, matched byte-wise (crate strings are raw). */
const ASSET_LITERAL = /s3:\/\/[\x20-\x7e]+/g

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
 * A no-op path of exactly `length` characters, relative to the current directory.
 *
 * Crate files store reference strings length-prefixed inside their string blob, so
 * a replacement must keep the byte count identical or every offset after it moves.
 * `./` pairs reach any even length; one trailing `.` covers the odd case. The last
 * character of the odd form is `.`, so appending `/<file>` still resolves inside
 * the same directory.
 * @param length - the exact character count required.
 * @returns the padding path, or undefined when the length cannot be expressed.
 */
function noopPath(length) {
  if (length < 1) return undefined
  if (length % 2 === 1) return `${'./'.repeat((length - 1) / 2)}.`
  // Even lengths cannot end in `.`, so they end in `/`; the caller then joins with
  // `/` and the resulting `//` collapses the same way `a//b` does everywhere else.
  return './'.repeat(length / 2)
}

/**
 * Rewrite `s3://` reference literals inside a binary crate layer, in memory.
 *
 * The engine has no `s3` resolver and refuses any non-http(s) layer URL, and a
 * crate's references are binary string tokens — neither layer text rewriting nor
 * an absolute key in the package can reach them. Equal-length substitution can:
 * the literal becomes a relative path of the same character count, which the
 * engine resolves inside the localized package, and the fetched bytes stay in
 * their original on-disk/cached form (this runs on a copy made to hand over).
 * @param bytes - the layer's bytes.
 * @param layerKey - the key the layer is registered under.
 * @returns the patched bytes (the input itself when nothing matched).
 */
export function patchCrateReferences(bytes, layerKey) {
  if (bytes === undefined || bytes.byteLength < 16) return bytes
  // Latin-1 round trip: one char per byte, so an equal-length substitution keeps
  // every byte offset in the crate valid. Only printable ASCII is ever replaced.
  let text = ''
  for (let index = 0; index < bytes.byteLength; index += 1) text += String.fromCharCode(bytes[index])
  if (!text.includes('s3://')) return bytes
  const dir = layerKey.includes('/') ? layerKey.slice(0, layerKey.lastIndexOf('/')) : ''
  let patched = text
  let changed = false
  for (const literal of new Set(text.match(ASSET_LITERAL) ?? [])) {
    // A literal naming a file (extension present) points at that file; anything
    // else is the directory the engine appends a file name to.
    const isFile = /\.(usd|usda|usdc|usdz|png|jpg|jpeg|webp)$/i.test(literal)
    const target = `${LOCALIZED}${literal.slice('s3://'.length)}`
    let replacement
    if (isFile) {
      const targetDir = target.includes('/') ? target.slice(0, target.lastIndexOf('/')) : ''
      const relative = targetDir === dir ? target.slice(target.lastIndexOf('/') + 1) : undefined
      if (relative !== undefined && relative.length <= literal.length) {
        const pad = noopPath(literal.length - relative.length) ?? ''
        replacement = pad.length + relative.length === literal.length ? `${pad}${relative}` : undefined
      }
    } else if (target === dir) {
      // A same-directory prefix only needs a no-op path of the right length.
      replacement = noopPath(literal.length)
    }
    if (replacement === undefined || replacement.length !== literal.length) continue
    patched = patched.split(literal).join(replacement)
    changed = true
  }
  if (!changed) return bytes
  const out = new Uint8Array(patched.length)
  for (let index = 0; index < patched.length; index += 1) out[index] = patched.charCodeAt(index) & 0xFF
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
 * @returns the path, or undefined for a URL the preview cannot supply.
 */
export function warningKey(warning) {
  const raw = String(warning?.path ?? '')
  // A resolved-but-missing layer comes back as `local:///…`, URL-encoded and, when
  // the root key carried a directory, prefixed with it. What identifies the asset
  // is the `__assets__/` segment, wherever it starts.
  const local = /^local:\/\/\/(.*)$/.exec(raw)
  if (local !== null) {
    let body
    try {
      body = decodeURIComponent(local[1])
    } catch {
      body = local[1]
    }
    const localized = body.indexOf(LOCALIZED)
    if (localized >= 0) return body.slice(localized)
    return body
  }
  // Object-storage references arrive as the URI the layer wrote, with the double
  // slash collapsed by path resolution (`s3:/bucket/…`). Hand back the canonical
  // form: the injected reader recognises it and the host route can sign the read.
  const asset = /^s3:\/{1,2}([^/]+)\/(.+)$/.exec(raw)
  if (asset !== null) return `s3://${asset[1]}/${asset[2]}`
  // A relative key is already usable; anything with another scheme is not ours to fetch.
  if (raw === '' || /^[a-z][a-z0-9+.-]*:/i.test(raw)) return undefined
  return raw
}

/**
 * Compose one USD file with the WASM engine, resolving referenced layers through
 * `read`/`readAsset` and repeating the load until the engine stops reporting
 * missing files.
 *
 * `s3://` references get the localization step described in the module comment:
 * the bytes are fetched through `readAsset`, registered under `__assets__/`, and
 * an ASCII layer's references are rewritten to that package key. It is a
 * separate reader from `read` because an object-storage read needs a signed host
 * route while a workspace read does not.
 *
 * @param options - assembly inputs.
 * @param options.rootKey - the opened file's workspace-relative path; references
 *   inside it resolve against this key exactly as they do on disk.
 * @param options.rootBytes - the opened file's bytes (already read by the sidebar).
 * @param options.read - reads one workspace-relative path; resolves undefined when
 *   the file does not exist or is empty.
 * @param options.readAsset - reads one `s3://` reference through the host route.
 * @param options.signal - aborts the load and any fetch in flight.
 * @returns the composed graph, what the engine measured, the pass log, and the
 * layer bytes it was composed from.
 */
export async function loadWithEngine({ rootKey, rootBytes, read, readAsset, signal }) {
  const { wasmUrl, workerUrl } = engineUrls()
  const files = new Map()
  /** `s3://` URIs named by a layer that has not been fetched yet. */
  const pending = new Set()
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
   * An ASCII layer is normalized on the way in: the BOM is dropped, its `s3://`
   * references are localized (and remembered as pending), and a prim that
   * carries PointInstancer fields under a custom type is retyped (see
   * {@link retypeCustomInstancers}). Crate bytes are handed over untouched,
   * except for the opt-in reference patching described below.
   * @param key - the key the engine will look the layer up under.
   * @param bytes - the layer's bytes.
   */
  const addLayer = (key, bytes) => {
    const stripped = stripBom(bytes)
    const isText = stripped !== undefined && stripped !== null && stripped.byteLength > 5
      && stripped[0] === 0x23 && stripped[1] === 0x75 // `#u`, the USDA magic
    if (!isText) {
      // A crate's references are binary string tokens. Equal-length substitution
      // can reach them, but the same literal also occurs inside non-asset strings
      // (a path table entry was corrupted in testing), so it stays opt-in until
      // the token table is parsed exactly:
      //   globalThis.__DSH_USD_PATCH_CRATE_REFS__ = true
      const patchable = globalThis.__DSH_USD_PATCH_CRATE_REFS__ === true
      files.set(key, new Blob([patchable ? patchCrateReferences(stripped, key) : stripped]))
      return
    }
    const text = new TextDecoder().decode(stripped)
    // A package-absolute reference (`/__assets__/…`) is what makes this work from
    // a nested layer too: a relative one would resolve against that layer's own
    // directory and miss the package key.
    const rewritten = text.replace(/@s3:\/\/([^@\r\n]+)@/g, (_all, rest) => {
      pending.add(`s3://${rest}`)
      return `@/${LOCALIZED}${rest}@`
    })
    const localized = retypeCustomInstancers(rewritten)
    files.set(key, new Blob([new TextEncoder().encode(localized)]))
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

  /** Fetch every pending asset into the package, following text layers one level. */
  const fetchPending = async () => {
    let fetched = 0
    while (pending.size > 0 && fetched < 128) {
      const uri = pending.values().next().value
      pending.delete(uri)
      if (readAsset === undefined) continue
      let bytes
      try {
        bytes = await readAsset(uri)
      } catch {
        bytes = undefined
      }
      if (bytes === undefined || bytes === null || bytes.byteLength === 0) continue
      const key = `${LOCALIZED}${uri.slice('s3://'.length)}`
      if (files.has(key)) continue
      registerLayer(key, bytes)
      fetched += 1
    }
    return fetched
  }

  /**
   * Register one asset layer under every package key the engine might resolve an
   * absolute `s3://` reference to.
   *
   * A crate's references cannot be rewritten (its string tables are LZ4 streams),
   * and the engine refuses to *fetch* a non-http(s) layer. It can still use one
   * that is already present in the package — the only unknown is how it spells the
   * key. Registering the plausible spellings is cheap and makes the resolution
   * question an empirical one instead of a dead end.
   * @param uri - the canonical `s3://bucket/key` reference.
   * @param bytes - the layer's bytes.
   */
  const registerAssetAliases = (uri, bytes) => {
    const rest = uri.slice('s3://'.length)
    const bucketSlash = rest.indexOf('/')
    const bucket = bucketSlash < 0 ? rest : rest.slice(0, bucketSlash)
    const keyPath = bucketSlash < 0 ? '' : rest.slice(bucketSlash + 1)
    const bases = [
      `${bucket}/${keyPath}`,
      `/${bucket}/${keyPath}`,
      `${LOCALIZED}${bucket}/${keyPath}`,
      `/${LOCALIZED}${bucket}/${keyPath}`,
      uri,
      `s3:/${bucket}/${keyPath}`,
    ]
    for (const base of bases) {
      for (const candidate of rootDir === '' ? [base] : [base, `${rootDir}/${base}`]) {
        if (files.has(candidate)) continue
        if (candidate === base) registerLayer(base, bytes)
        else files.set(candidate, files.get(base))
      }
    }
  }

  addLayer(rootKey, rootBytes)
  await fetchPending()

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
      const asset = /^s3:\/{1,2}([^/]+)\/(.+)$/.exec(key)
      if (key.startsWith(LOCALIZED) || key.startsWith(`/${LOCALIZED}`)) {
        // A localized reference: the package key names the asset to read.
        if (readAsset === undefined) continue
        try {
          bytes = await readAsset(`s3://${key.replace(/^\/+/, '').slice(LOCALIZED.length)}`)
        } catch {
          bytes = undefined
        }
      } else if (asset !== null) {
        // An absolute reference from inside a crate: fetch it and offer it under
        // every spelling the engine could be looking for.
        if (readAsset === undefined) continue
        try {
          bytes = await readAsset(`s3://${asset[1]}/${asset[2]}`)
        } catch {
          bytes = undefined
        }
        if (bytes !== undefined && bytes !== null && bytes.byteLength > 0) {
          registerAssetAliases(`s3://${asset[1]}/${asset[2]}`, bytes)
          await fetchPending()
          fetched.push(key)
        }
        continue
      } else {
        try {
          bytes = await read(key)
        } catch {
          bytes = undefined
        }
      }
      if (bytes === undefined || bytes === null || bytes.byteLength === 0) continue
      registerLayer(key, bytes)
      await fetchPending()
      fetched.push(key)
    }
    passes.push({ pass, warnings: result.info.warnings.length, fetched })
    if (fetched.length === 0) break
  }

  // The bytes the stage was composed from, not just the graph: articulation lives
  // in prims the engine drops, so the reader that reconstructs it needs the same
  // layers. The map is handed over as-is (blobs, not copies) and read lazily.
  const sources = new Map(files)
  return { ...result, passes, engine: 'wasm', sources }
}
