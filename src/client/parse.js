/**
 * Native USD assembly: containers, referenced layers, composition, measurement.
 *
 * three has parsed ASCII USDA for years; since 0.186 it also ships a real binary
 * crate reader (`USDCParser`) and a composer that resolves references, variants,
 * primvars, materials, `metersPerUnit`, and the Z-up→Y-up conversion. That makes
 * a browser-only preview possible: no converter process, no round trip, and no
 * "the other tool must be installed" precondition.
 *
 * A USD file is rarely one file, though. A layer names other layers with
 * `@…@` references, and the composer resolves those against an in-memory asset
 * map. `USDLoader.parse` always hands it an empty map, so a `.usd` that
 * references its sibling geometry parses to nothing. Here the map is filled by
 * walking the reference graph and reading each named layer through the caller's
 * reader — in the sidebar that reader is the workspace Remote, so the siblings
 * are the real files sitting next to the one the user clicked.
 */
import * as THREE from 'three'
import { LoadingManager } from 'three'
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js'
import { USDAParser } from 'three/examples/jsm/loaders/usd/USDAParser.js'
import { USDCParser } from 'three/examples/jsm/loaders/usd/USDCParser.js'
import { USDComposer } from 'three/examples/jsm/loaders/usd/USDComposer.js'
import { layerBasePath, normalizePosix, referenceKey } from './usd.js'

/** `PXR-USDC`, the binary crate header. */
const CRATE_MAGIC = [0x50, 0x58, 0x52, 0x2D, 0x55, 0x53, 0x44, 0x43]

/** Local-file zip signatures: local header, empty archive, spanned archive. */
const ZIP_MAGICS = [
  [0x50, 0x4B, 0x03, 0x04],
  [0x50, 0x4B, 0x05, 0x06],
  [0x50, 0x4B, 0x07, 0x08],
]

/** Suffixes holding a USD layer inside a package or beside one. */
const LAYER_SUFFIXES = new Set(['usd', 'usda', 'usdc'])

/** Suffixes holding bytes the composer turns into textures. */
const IMAGE_SUFFIXES = new Set(['png', 'jpg', 'jpeg', 'avif', 'webp'])

/** One `@…@` asset reference, as written inside a layer. */
const ASSET_REFERENCE = /@([^@\n]+)@/g

/** Reference walk depth bound; a field nested deeper than this names no asset. */
const FIELD_DEPTH = 4

const textDecoder = new TextDecoder()

/**
 * Whether the buffer starts with one exact byte sequence.
 * @param bytes - complete file bytes.
 * @param magic - expected leading bytes.
 * @returns true when the prefix matches.
 */
function startsWith(bytes, magic) {
  if (bytes.length < magic.length) return false
  for (let index = 0; index < magic.length; index += 1) {
    if (bytes[index] !== magic[index]) return false
  }
  return true
}

/**
 * Classify complete USD bytes by their container.
 * @param bytes - complete file bytes.
 * @returns `usdc` for a crate, `usdz` for a package, `usda` for ASCII text.
 */
export function usdFormatOf(bytes) {
  if (startsWith(bytes, CRATE_MAGIC)) return 'usdc'
  if (ZIP_MAGICS.some(magic => startsWith(bytes, magic))) return 'usdz'
  return 'usda'
}

/** A detached ArrayBuffer view of exactly these bytes, as the crate reader expects. */
function exactBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

/** The lowercase extension of a layer or asset name. */
function suffixOf(name) {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  const dot = name.lastIndexOf('.')
  return dot > slash ? name.slice(dot + 1).toLowerCase() : ''
}

/**
 * Parse one USD layer, crate or ASCII, by its bytes.
 * @param bytes - complete layer bytes.
 * @returns the parser's `specsByPath` data, ready for the composer.
 */
function parseLayer(bytes) {
  if (startsWith(bytes, CRATE_MAGIC)) return new USDCParser().parseData(exactBuffer(bytes))
  return new USDAParser().parseData(textDecoder.decode(bytes))
}

/**
 * Collect every asset reference a layer names.
 *
 * Walks field values rather than named fields because USD spells the same idea
 * three ways — `references`, `payload`, `subLayers` — and exporter dialects vary
 * in which one they use.
 * @param data - one parsed layer.
 * @param found - set the reference bodies are added to.
 */
function collectReferences(data, found) {
  const specs = data?.specsByPath
  if (specs === undefined || specs === null) return
  for (const path of Object.keys(specs)) {
    const fields = specs[path]?.fields
    if (fields !== undefined && fields !== null) walk(fields, 0, found)
  }
}

/** Add every `@…@` body in one field value to the set. */
function walk(value, depth, found) {
  if (depth > FIELD_DEPTH) return
  if (typeof value === 'string') {
    // A fresh regex per value: `matchAll` shares `lastIndex` with the literal.
    for (const match of value.matchAll(new RegExp(ASSET_REFERENCE.source, 'g'))) found.add(match[1])
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, depth + 1, found)
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value)) walk(value[key], depth + 1, found)
  }
}

/**
 * Whether a reference names something other than a readable sibling file.
 * @param reference - the `@…@` body.
 * @returns true for URL schemes, prim paths, and absolute filesystem paths.
 */
function remoteReference(reference) {
  return /^[a-z][a-z0-9+.-]*:/i.test(reference) || reference.startsWith('#') || reference.startsWith('/')
}

/**
 * Assemble one USD file, plus whatever layers it references, into a three graph.
 *
 * @param options - assembly inputs.
 * @param options.bytes - complete bytes of the file the user opened.
 * @param options.readLayer - reads one referenced layer, relative to the opened
 * file's directory; resolves `undefined` when the layer does not exist.
 * @param options.maxLayers - bound on how many sibling layers are pulled in.
 * @returns the composed root, the container detected, and how many layers were assembled.
 */
export async function loadUsd({ bytes, readLayer, maxLayers = 24 }) {
  const format = usdFormatOf(bytes)
  const assets = {}
  const manager = new LoadingManager()

  // ── a package carries its own layers: no filesystem reads at all ──────────
  if (format === 'usdz') {
    const entries = unzipSync(bytes)
    const names = Object.keys(entries)
    if (names.length === 0) throw new Error('USDZ 包是空的')
    const rootName = names[0]
    let rootData
    for (const name of names) {
      const suffix = suffixOf(name)
      if (LAYER_SUFFIXES.has(suffix)) {
        const parsed = parseLayer(entries[name])
        assets[name] = parsed
        if (name === rootName) rootData = parsed
      } else if (IMAGE_SUFFIXES.has(suffix)) {
        // Raw bytes: the composer turns them into an object URL when a material needs one.
        assets[name] = entries[name]
      }
    }
    if (rootData === undefined) {
      throw new Error(`USDZ 包的第一个条目 "${rootName}" 不是 USD 图层（规范要求包内首个条目即根层）`)
    }
    const object = new USDComposer(manager).compose(rootData, assets, {}, layerBasePath(rootName))
    return { object, format, layers: names.length }
  }

  // ── a standalone layer: walk its reference graph through the caller ───────
  const rootData = parseLayer(bytes)
  const queue = [{ key: '', data: rootData }]
  const visited = new Set([''])
  let layers = 1

  while (queue.length > 0 && layers < maxLayers) {
    const current = queue.shift()
    const basePath = layerBasePath(current.key)
    const references = new Set()
    collectReferences(current.data, references)

    for (const reference of references) {
      if (remoteReference(reference)) continue
      const key = referenceKey(basePath, reference)
      if (key === '' || visited.has(key)) continue
      visited.add(key)

      // The sibling is named relative to the opened file's own directory, so the
      // normalized key is the path to ask for; the raw key is what the composer
      // will look up, and it is what nested references resolve from.
      const relative = normalizePosix(key)
      let sibling
      try {
        sibling = await readLayer(relative)
      } catch {
        // An unreadable sibling is a missing reference, not a broken preview.
        continue
      }
      if (sibling === undefined || sibling === null || sibling.byteLength === 0) continue

      const suffix = suffixOf(relative)
      const value = LAYER_SUFFIXES.has(suffix)
        ? parseLayer(sibling)
        : IMAGE_SUFFIXES.has(suffix) ? sibling : undefined
      if (value === undefined) continue

      assets[key] = value
      if (relative !== key) assets[relative] = value
      layers += 1
      if (LAYER_SUFFIXES.has(suffix)) queue.push({ key, data: value })
    }
  }

  const object = new USDComposer(manager).compose(rootData, assets, {}, '')
  return { object, format, layers }
}

/**
 * Read one dropped layer for the three fallback parser.
 *
 * The fallback asks for a path relative to the opened file's directory; a dropped
 * file is keyed by its path in the drop (which, for a picked folder, starts with
 * the folder's name). Both spellings are tried so the same drop works whichever
 * side of the composer asks.
 * @param files - dropped files keyed by package-relative path.
 * @param rootKey - the opened stage's key.
 * @returns a reader answering the layer's bytes, or undefined when absent.
 */
function droppedLayerReader(files, rootKey) {
  const slash = rootKey.lastIndexOf('/')
  const base = slash < 0 ? '' : rootKey.slice(0, slash + 1)
  return async (path) => {
    const normalized = normalizePosix(path)
    const blob = files.get(path)
      ?? files.get(normalized)
      ?? (base === '' ? undefined : files.get(`${base}${normalized}`))
    if (blob === undefined) return undefined
    return new Uint8Array(await blob.arrayBuffer())
  }
}

/**
 * Assemble one USD file for the preview, preferring the WASM OpenUSD engine.
 *
 * three's parsers are the fallback, not the default: they compose only what the
 * caller already loaded, and a crate layer's `references` list-op does not
 * survive their decoder. The engine composes the stage itself, reports the files
 * it wanted, and gets reloaded once those are supplied (see `engine.js`).
 *
 * @param options - assembly inputs.
 * @param options.rootKey - workspace-relative path of the opened file, when known.
 * @param options.rootBytes - the opened file's bytes.
 * @param options.read - reads one workspace-relative path (engine path).
 * @param options.readSibling - reads a path relative to the opened file's directory (three path).
 * @param options.files - the dropped files, keyed by package-relative path; when
 * present the stage is composed from them alone and no read is performed.
 * @param options.signal - aborts the load.
 * @param options.maxLayers - bound for the three fallback's reference walk.
 * @returns the graph, which engine produced it, the measured stats, and warnings.
 */
export async function assemble({ rootKey, rootBytes, read, readSibling, files, signal, maxLayers = 24 }) {
  const format = usdFormatOf(rootBytes)
  // Escape hatch for a broken engine, without a setting or a rebuild:
  //   globalThis.__DSH_USD_ENGINE__ = 'three'
  const engineAllowed = globalThis.__DSH_USD_ENGINE__ !== 'three'
  // A dropped or picked stage: every file is already in the page, so the engine
  // resolves the stage's own references from the map instead of a read-back loop.
  if (engineAllowed && files !== undefined && rootKey !== undefined) {
    try {
      const { loadWithFiles } = await import('./engine.js')
      const result = await loadWithFiles({ files, rootKey, signal })
      return {
        object: result.root,
        engine: 'wasm',
        format,
        layers: result.info.stats.layers,
        passes: result.passes,
        warnings: result.info.warnings.map(warning => ({ ...warning })),
        stats: measureObject(result.root),
        dispose: result.dispose,
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      const fallback = await loadUsd({ bytes: rootBytes, readLayer: droppedLayerReader(files, rootKey), maxLayers })
      return {
        object: fallback.object,
        engine: 'three',
        engineError: error instanceof Error ? error.message : String(error),
        format,
        layers: fallback.layers,
        passes: [],
        warnings: [],
        stats: measureObject(fallback.object),
      }
    }
  }
  if (engineAllowed && rootKey !== undefined && typeof read === 'function') {
    try {
      const { loadWithEngine } = await import('./engine.js')
      const result = await loadWithEngine({ rootKey, rootBytes, read, signal })
      return {
        object: result.root,
        engine: 'wasm',
        format,
        layers: result.info.stats.layers,
        passes: result.passes,
        warnings: result.info.warnings.map(warning => ({ ...warning })),
        stats: measureObject(result.root),
        // The engine owns textures too, so its own release is the complete one.
        dispose: result.dispose,
      }
    } catch (error) {
      if (error?.name === 'AbortError') throw error
      // A missing engine must not cost the user a preview: fall through to three.
      const fallback = await loadUsd({ bytes: rootBytes, readLayer: readSibling, maxLayers })
      return {
        object: fallback.object,
        engine: 'three',
        engineError: error instanceof Error ? error.message : String(error),
        format,
        layers: fallback.layers,
        passes: [],
        warnings: [],
        stats: measureObject(fallback.object),
      }
    }
  }

  const fallback = await loadUsd({ bytes: rootBytes, readLayer: readSibling, maxLayers })
  return {
    object: fallback.object,
    engine: 'three',
    format,
    layers: fallback.layers,
    passes: [],
    warnings: [],
    stats: measureObject(fallback.object),
  }
}

/**
 * Count what the viewport will draw and measure the extent, in scene units.
 * @param object - any three root produced by this module.
 * @returns drawable counts, the axis-aligned extent, and whether the extent is usable.
 */
export function measureObject(object) {
  let meshes = 0
  let triangles = 0
  let points = 0
  let lines = 0
  let instances = 0
  object.traverse((node) => {
    const geometry = node.geometry
    if (geometry === undefined || geometry === null) return
    if (node.isPoints === true) {
      points += geometry.getAttribute('position')?.count ?? 0
      return
    }
    if (node.isLine === true) {
      lines += 1
      return
    }
    if (node.isMesh !== true) return
    // A PointInstancer arrives as one `InstancedMesh` drawing the prototype N
    // times: counting it once would report 1 mesh where 200 quads are drawn.
    // The engine documents its own budget the same way ("counted once per
    // instance"), so the stats line follows suit.
    const drawn = node.isInstancedMesh === true ? (node.count ?? 1) : 1
    const position = geometry.getAttribute('position')?.count ?? 0
    const perInstance = geometry.index !== null && geometry.index !== undefined
      ? geometry.index.count / 3
      : position / 3
    meshes += drawn
    triangles += perInstance * drawn
    if (drawn > 1) instances += drawn
  })
  const box = new THREE.Box3().setFromObject(object)
  const size = box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3())
  const finite = Number.isFinite(size.x) && Number.isFinite(size.y) && Number.isFinite(size.z)
    && (size.x > 0 || size.y > 0 || size.z > 0)
  return {
    meshes,
    triangles: Math.round(triangles),
    points,
    lines,
    instances,
    size: { x: size.x, y: size.y, z: size.z },
    // Reported rather than hidden: an empty or non-finite extent is the one
    // honest signal that a layer assembled into nothing.
    degenerate: !finite,
  }
}

/**
 * Release every geometry and material a parsed root owns.
 *
 * Viewers come and go per tab; without this a user paging through models keeps
 * every buffer alive on the GPU for the life of the window.
 * @param object - any three root produced by this module.
 */
export function disposeObject(object) {
  object.traverse((node) => {
    node.geometry?.dispose?.()
    const material = node.material
    if (Array.isArray(material)) {
      for (const entry of material) entry?.dispose?.()
    } else {
      material?.dispose?.()
    }
  })
}
