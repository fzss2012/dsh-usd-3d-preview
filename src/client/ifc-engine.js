/**
 * The IFC model reader, page side: a worker handle, and the three graph built
 * from what the worker read.
 *
 * The worker (`ifc-worker.js`) owns web-ifc and does the parse; this module owns
 * the boundary. Three things happen here and nowhere else:
 *
 *  1. **The graph.** One flat `Group` per model, one `Mesh` per placed geometry,
 *     each named by the element path it belongs to. A flat graph is what makes the
 *     stats line, the picking and the framing agree: every triangle the file
 *     contributed is drawn once, at world coordinates, with no intermediate
 *     transform for a raycast to walk through. The world coordinates are already
 *     Y-up and already in metres — web-ifc's placement matrix carries both — so
 *     nothing here converts an axis or a unit.
 *
 *  2. **Materials.** IFC carries a colour per surface style, not a full material.
 *     A model with no styles at all is common (an export with "no materials"
 *     ticked), so a neutral grey is the fallback rather than black: an unlit black
 *     building reads as a failed load. Materials are shared per colour so a model
 *     with 5000 walls compiles one program, not 5000.
 *
 *  3. **The element tree.** The worker reports the spatial structure flat, with
 *     parent express IDs; this module turns it into paths, which is the address
 *     every other panel in this plugin already speaks (the prim tree, the details
 *     panel, the selection).
 *
 * @module dsh-usd-3d-preview/ifc-engine
 */
import * as THREE from 'three'
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js'
import { IFC_ASSETS } from './ifc-assets.generated.js'
import {
  ifcFormatOf, ifcHeaderSchema, ifcHeaderText, ifcPathOf, ifcPathSegment, ifczipRoot, uniqueSegment,
} from './ifc.js'

/** The neutral a model with no surface styles is drawn in. */
const DEFAULT_COLOR = 0xc8ccd4

/** Roughness of every IFC surface: a building is masonry, glass and paint alike. */
const SURFACE_ROUGHNESS = 0.72

/** Metalness of every IFC surface; IFC has no metalness channel to read. */
const SURFACE_METALNESS = 0.02

/** Blob URL for the worker script, created once per page. */
let workerUrl

/** The one worker this page owns, and its request counter. */
let worker
let requestId = 0
const pending = new Map()

/**
 * The worker's bootstrap, as a blob URL.
 *
 * The engine bundle and the WASM binary are embedded in `IFC_ASSETS` as
 * gzip-compressed base64 — a client plugin ships as one module-table entry, and
 * raw base64 of 5 MiB would nearly double the bundle. The bootstrap is the small
 * script that `new Worker` takes; it inflates the two payloads and starts the
 * engine, which then installs its own message handler.
 * @returns the blob URL the Worker constructor takes.
 */
function engineWorkerUrl() {
  if (workerUrl !== undefined) return workerUrl
  if (IFC_ASSETS.boot === '' || IFC_ASSETS.engine === '' || IFC_ASSETS.wasm === '') {
    throw new Error('the IFC engine assets were not embedded at build time (run `npm run build`)')
  }
  const binary = atob(IFC_ASSETS.boot)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  workerUrl = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }))
  return workerUrl
}

/**
 * The page's worker, started on first use.
 *
 * The configure message carries the two compressed payloads; the bootstrap queues
 * anything that arrives before it has finished inflating them, so the `open`
 * request below cannot race the boot.
 * @returns the running worker.
 */
function engineWorker() {
  if (worker !== undefined) return worker
  worker = new Worker(engineWorkerUrl())
  worker.postMessage({ kind: 'configure', engine: IFC_ASSETS.engine, wasm: IFC_ASSETS.wasm })
  worker.addEventListener('message', (event) => {
    const reply = event.data
    if (reply === null || typeof reply !== 'object') return
    const entry = pending.get(reply.id)
    if (entry === undefined) return
    pending.delete(reply.id)
    if (reply.ok !== true) entry.reject(new Error(String(reply.error ?? 'the IFC reader failed')))
    else entry.resolve(reply)
  })
  worker.addEventListener('error', (event) => {
    const failure = new Error('the IFC worker stopped: ' + String(event?.message ?? 'unknown error'))
    for (const entry of pending.values()) entry.reject(failure)
    pending.clear()
    // A worker that threw is not reusable: the next open starts a fresh one.
    try { worker?.terminate() } catch { /* already gone */ }
    worker = undefined
  })
  return worker
}

/**
 * Send one request and wait for its reply.
 * @param message - the request body.
 * @param transfer - buffers to move rather than copy.
 * @returns the worker's reply.
 */
function request(message, transfer = []) {
  const running = engineWorker()
  requestId += 1
  const id = requestId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    running.postMessage({ id, ...message }, transfer)
  })
}

/**
 * The colour one placed geometry is drawn in.
 * @param part - one placed geometry from the worker.
 * @returns a packed colour.
 */
function colorOf(part) {
  if (part.hasColor !== true) return DEFAULT_COLOR
  const [r, g, b] = part.color
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return DEFAULT_COLOR
  // web-ifc reports 0..1 floats; the values are already linear-sRGB, which is what
  // three's material colour expects, so they are used as-is rather than converted.
  return new THREE.Color(
    Math.min(Math.max(r, 0), 1),
    Math.min(Math.max(g, 0), 1),
    Math.min(Math.max(b, 0), 1),
  )
}

/**
 * Build the element paths from the worker's flat structure.
 *
 * The worker reports each node's parent express ID; a path needs the chain, so
 * the records are indexed first and then walked from the roots down. A node whose
 * parent is missing becomes a root of its own rather than disappearing: an
 * unreferenced product still has geometry on screen, and a tree that omits it
 * would make a click on it name nothing.
 * @param structure - the worker's flat records.
 * @returns the path per express ID, and the tree rows in emission order.
 */
export function structureToPaths(structure) {
  const byID = new Map()
  for (const node of structure ?? []) byID.set(node.expressID, node)
  const segments = new Map()
  const paths = new Map()
  const rows = []
  const visiting = new Set()

  /**
   * Resolve one node's segment and path, depth-first.
   * @param node - the record to resolve.
   * @returns the path.
   */
  const resolve = (node) => {
    const known = paths.get(node.expressID)
    if (known !== undefined) return known
    // A cycle in the relation graph is malformed data, not a reason to hang.
    if (visiting.has(node.expressID) === true) {
      const self = ifcPathSegment(node.name, node.expressID, node.type)
      paths.set(node.expressID, ifcPathOf([self]))
      return paths.get(node.expressID)
    }
    visiting.add(node.expressID)
    const parent = byID.get(node.parentID)
    const parentPath = parent === undefined ? '' : resolve(parent)
    visiting.delete(node.expressID)
    const siblings = segments.get(parentPath) ?? new Set()
    segments.set(parentPath, siblings)
    const segment = uniqueSegment(
      ifcPathSegment(node.name, node.expressID, node.type),
      node.expressID,
      siblings,
    )
    const path = parentPath + '/' + segment
    paths.set(node.expressID, path)
    return path
  }

  for (const node of structure ?? []) {
    const path = resolve(node)
    rows.push({
      expressID: node.expressID,
      parentID: node.parentID,
      type: node.type,
      name: node.name,
      globalId: node.globalId,
      objectType: node.objectType,
      path,
    })
  }
  return { paths, rows }
}

/**
 * One shared material per appearance, so a large model compiles few programs.
 * @param cache - the per-model material cache.
 * @param part - the placed geometry the material is for.
 * @returns the material to draw it with.
 */
function materialOf(cache, part) {
  const color = colorOf(part)
  const transparent = Number.isFinite(part.opacity) && part.opacity < 0.99
  const key = `${color.getHexString()}|${transparent ? part.opacity.toFixed(2) : '1'}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  const material = new THREE.MeshStandardMaterial({
    color,
    roughness: SURFACE_ROUGHNESS,
    metalness: SURFACE_METALNESS,
    // IFC geometry is authored as closed solids with outward normals, so a
    // one-sided material is correct and halves the fill for interior faces.
    side: THREE.FrontSide,
    transparent,
    opacity: transparent ? part.opacity : 1,
    depthWrite: transparent === false,
  })
  cache.set(key, material)
  return material
}

/**
 * Turn one worker reply into the three graph the viewport draws.
 * @param reply - the worker's `open` reply.
 * @returns the root, the element rows, and the material cache that owns them.
 */
function buildGraph(reply) {
  const root = new THREE.Group()
  root.name = 'ifc-model'
  const { paths, rows } = structureToPaths(reply.structure)
  const cache = new Map()
  // One mesh per placed geometry, named by its element's path: the prim panel,
  // the details panel and the selection all address objects by that name, so an
  // element with two representation items shows up as two meshes under one path
  // rather than as one mesh with a merged buffer (which would make a click on
  // either half name the same element anyway, but lose the per-item geometry).
  const byExpress = new Map()
  for (const row of rows) {
    const list = byExpress.get(row.expressID) ?? []
    list.push(row)
    byExpress.set(row.expressID, list)
  }
  for (const part of reply.parts) {
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(part.positions, 3))
    geometry.setAttribute('normal', new THREE.BufferAttribute(part.normals, 3))
    geometry.setIndex(new THREE.BufferAttribute(part.indices, 1))
    const material = materialOf(cache, part)
    const mesh = new THREE.Mesh(geometry, material)
    const path = paths.get(part.expressID)
    mesh.name = path ?? `/IfcProduct #${part.expressID}`
    mesh.userData.ifcExpressID = part.expressID
    root.add(mesh)
  }
  return { root, rows, paths, materials: cache }
}

/**
 * The STEP bytes of one model, unwrapping an IFCZIP package.
 *
 * An `.ifczip` is a plain zip holding one model beside optional property files,
 * so the archive is opened here — on the page, where three's `fflate` is already
 * bundled for `.usdz` — and the worker is handed the STEP bytes alone. Doing it
 * in the worker would mean shipping a second unzip implementation there for a
 * container that is a packaging detail rather than a schema.
 * @param bytes - the file as the Host delivered it.
 * @returns the model's STEP bytes.
 */
export function stepBytesOf(bytes) {
  const format = ifcFormatOf(bytes)
  if (format === undefined) {
    // The header is read only to make the message useful: a file that starts with
    // something else is refused here rather than handed to a schema reader that
    // would fail with a kernel error a reader cannot act on.
    const declared = ifcHeaderSchema(ifcHeaderText(bytes))
    throw new Error(declared === undefined
      ? 'this file is not an IFC model (a STEP file starts with ISO-10303-21)'
      : `this file is not a STEP file, although its header declares ${declared}`)
  }
  if (format === 'ifc') return bytes
  const entries = unzipSync(bytes)
  const root = ifczipRoot(entries)
  if (root === undefined) {
    throw new Error('this IFCZIP package holds no .ifc model')
  }
  return entries[root]
}

/**
 * Read one IFC file into a drawable model.
 *
 * @param options - what to read.
 * @param options.bytes - the complete file bytes (a STEP file or an IFCZIP package).
 * @param options.structure - read the element tree as well; defaults to true.
 * @returns the graph, the element rows, the reported counts, and a disposer.
 */
export async function loadIfc({ bytes, structure = true }) {
  const step = stepBytesOf(bytes)
  const reply = await request({ kind: 'open', bytes: step, options: { structure } }, [])
  const built = buildGraph(reply)
  const counts = reply.counts ?? { triangles: 0, vertices: 0 }
  // Measured here, from the graph, rather than reported by the worker: the box
  // has to describe what is actually drawn, and a model whose geometry the reader
  // skipped must measure as empty instead of as the size the file claims.
  const box = new THREE.Box3().setFromObject(built.root)
  const size = box.isEmpty() ? new THREE.Vector3() : box.getSize(new THREE.Vector3())
  const finite = Number.isFinite(size.x) && Number.isFinite(size.y) && Number.isFinite(size.z)
    && (size.x > 0 || size.y > 0 || size.z > 0)
  let disposed = false
  return {
    object: built.root,
    rows: built.rows,
    paths: built.paths,
    schema: reply.schema,
    // The container the file arrived in, not the one the reader wanted: a package
    // is unwrapped before it reaches the worker, so the stats line would otherwise
    // claim an .ifczip was a plain STEP file.
    format: ifcFormatOf(bytes) ?? 'ifc',
    unit: reply.unit ?? undefined,
    stats: {
      meshes: reply.parts.length,
      triangles: counts.triangles,
      vertices: counts.vertices,
      size: { x: size.x, y: size.y, z: size.z },
      // Reported rather than hidden: an empty or non-finite extent is the one
      // honest signal that a model assembled into nothing.
      degenerate: !finite,
    },
    /** Read one element's own attributes and its property sets. */
    async describe(expressID) {
      const answer = await request({ kind: 'element', modelID: reply.modelID, expressID })
      return answer.element ?? undefined
    },
    /** Release the model in the worker and every GPU resource the graph owns. */
    dispose() {
      if (disposed === true) return
      disposed = true
      for (const material of built.materials.values()) material.dispose()
      built.root.traverse((node) => { node.geometry?.dispose?.() })
      void request({ kind: 'close', modelID: reply.modelID }).catch(() => undefined)
    },
  }
}

/**
 * Stop the page's worker, releasing its WASM module.
 *
 * Called when the last IFC tab closes: a WASM module holds tens of megabytes of
 * linear memory, and a preview that is not open should not keep it.
 * @returns nothing; a worker that was never started is not an error.
 */
export function stopIfcWorker() {
  if (worker === undefined) return
  try { worker.terminate() } catch { /* already gone */ }
  worker = undefined
  for (const entry of pending.values()) entry.reject(new Error('the IFC reader was stopped'))
  pending.clear()
}
