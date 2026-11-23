/**
 * The stage-level composition: every layer the preview composed and the arcs that
 * placed it there.
 *
 * ## Why this is a second reader
 *
 * The prim details panel answers "what does the file declare about this prim".
 * This module answers a different question the same bytes can answer: "where did
 * this stage come from". On a composed asset that question comes up first — which
 * file carries the geometry, which arc brought it in, which arc resolved to
 * nothing — and a layer count in the statistics line is not an answer.
 *
 * Nothing here composes anything. The engine already composed the stage; this
 * walks the arcs the layers themselves declare and names them, exactly as the
 * details reader walks them to find a prim's authored path. The walk is bounded
 * in depth and breadth: a pathological reference graph costs a panel row, not a
 * hung tab.
 *
 * ## Coverage
 *
 * The arcs a layer declares are read from the same decoded records the details
 * panel uses — sublayers, prim references, payloads, inherits, specializes and
 * variant sets — so a text layer and a crate are described alike. A layer whose
 * declarations cannot be decoded is a node with a reason rather than a hole: an
 * unreadable crate must not read as "this layer has no arcs".
 *
 * @module dsh-usd-3d-preview/composition
 */
import { compositionArcsOf, decodeLayerBytes, isCrateLayer, isPackageLayer, isTextLayer, layerBytesOf, layerForArc } from './details.js'

/** Nodes the panel draws at once; a stage with hundreds of reference placements is clipped. */
export const MAX_COMPOSITION_NODES = 200

/** How deep the walk follows nested arcs; a reference chain beyond this is reported. */
export const MAX_COMPOSITION_DEPTH = 8

/** Arcs one layer expands into child nodes; the rest are counted, not drawn. */
const MAX_CHILDREN_PER_NODE = 64

/** The last path segment of a layer key, for display. */
function baseNameOf(key) {
  const name = String(key).split('/').filter(Boolean).pop()
  return name === undefined || name === '' ? String(key) : name
}

/**
 * Collapse the engine's alias keys for one blob.
 *
 * The engine registers a layer under every spelling it may be resolved by — the
 * key its referencing layer used, the same key re-prefixed with the root
 * directory, an object-storage alias. They are one layer, so the composition
 * must show one layer; the first spelling is the one its referencing layer
 * wrote. Two entries with the same primitive bytes are still two layers and are
 * kept apart.
 * @param entries - the collected layer entries.
 * @returns one entry per source object, in first-seen order.
 */
function uniqueEntries(entries) {
  const seen = new Set()
  const out = []
  for (const entry of entries) {
    const source = entry.source
    if (source !== undefined && source !== null && typeof source === 'object') {
      if (seen.has(source)) continue
      seen.add(source)
    }
    out.push(entry)
  }
  return out
}

/** The container kind of one layer, by its bytes. */
function containerOf(bytes) {
  if (isCrateLayer(bytes) === true) return 'crate'
  if (isTextLayer(bytes) === true) return 'usda'
  if (isPackageLayer(bytes) === true) return 'usdz'
  return 'unknown'
}

/**
 * The layer metadata the panel shows beside a layer row.
 * @param meta - one decoded layer's metadata.
 * @returns a normalized copy, with absent fields as '' or 0.
 */
function layerMetaOf(meta) {
  const source = meta ?? {}
  const numberOr = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
  return {
    defaultPrim: typeof source.defaultPrim === 'string' ? source.defaultPrim : '',
    upAxis: typeof source.upAxis === 'string' ? source.upAxis : '',
    metersPerUnit: numberOr(source.metersPerUnit),
    doc: typeof source.doc === 'string' ? source.doc : '',
    startTimeCode: numberOr(source.startTimeCode),
    endTimeCode: numberOr(source.endTimeCode),
    timeCodesPerSecond: numberOr(source.timeCodesPerSecond),
    subLayers: Array.isArray(source.subLayers)
      ? source.subLayers.filter(entry => typeof entry === 'string' && entry !== '')
      : [],
  }
}

/**
 * Pick the root layer: the opened file when the caller names it, otherwise the
 * first layer the composition kept.
 * @param entries - the unique layer entries.
 * @param requested - the root key the assembly knows, when it knows one.
 * @returns the chosen key, or undefined when there are no layers.
 */
function rootOf(entries, requested) {
  if (entries.length === 0) return undefined
  if (typeof requested === 'string' && requested !== '') {
    for (const entry of entries) if (entry.key === requested) return entry.key
    const clean = requested.replace(/^\/+/, '')
    for (const entry of entries) {
      if (entry.key.replace(/^\/+/, '') === clean) return entry.key
      if (entry.key.endsWith('/' + clean) === true) return entry.key
    }
  }
  return entries[0].key
}

/**
 * Read the complete composition of one assembled stage.
 *
 * @param sources - the layers the stage was composed from, keyed by package path
 *   (a Map of Blob/bytes, as engine.js hands them over), or any equivalent
 *   iterable of [key, bytes]. For a dropped stage this is the dropped file map.
 * @param options - reader options.
 * @param options.rootKey - the opened file's key, so the tree starts at the file
 *   the user chose rather than at whatever the map happens to list first.
 * @param options.parseCrate - the crate parser class, injected by the browser
 *   half exactly as for readPrimDetails.
 * @returns the root key, one flat node array (depth + parent make the tree), the
 *   sources no arc reached, and the counts the panel's header states.
 */
export async function readStageComposition(sources, options = {}) {
  const entries = uniqueEntries(await layerBytesOf(sources))
  const byKey = new Map()
  const records = new Map()
  for (const entry of entries) {
    const format = containerOf(entry.bytes)
    let decoded
    try {
      // The panel names prims and arcs; it never shows a value, so the attribute
      // values are not materialised. On a solved robot that is the difference
      // between reading a layer and parsing ninety megabytes of points.
      decoded = decodeLayerBytes(entry.bytes, options.parseCrate, { withAttributes: false })
    } catch {
      decoded = { unreadable: 'the container could not be read' }
    }
    const record = {
      key: entry.key,
      name: baseNameOf(entry.key),
      format,
      prims: decoded !== undefined && decoded !== null && decoded.prims instanceof Map ? decoded.prims : new Map(),
      meta: layerMetaOf(decoded?.meta),
      unreadable: typeof decoded?.unreadable === 'string'
        ? decoded.unreadable
        : (decoded === undefined || decoded === null ? 'the container could not be read' : undefined),
    }
    records.set(entry.key, record)
    byKey.set(entry.key, record)
  }

  const rootKey = rootOf(entries, options.rootKey)
  if (rootKey === undefined) {
    return { rootKey: '', nodes: [], unreached: [], counts: { layers: 0, arcs: 0, resolved: 0, unresolved: 0 }, omittedArcs: 0, truncated: false }
  }

  /** One node of the composition tree. */
  const nodes = []
  const addNode = (node) => {
    const index = nodes.length
    nodes.push({ id: index, ...node })
    return index
  }
  const rootRecord = records.get(rootKey)
  const rootIndex = addNode({
    key: rootKey,
    name: baseNameOf(rootKey),
    role: 'root',
    parent: null,
    depth: 0,
    from: null,
    format: rootRecord?.format ?? 'unknown',
    primCount: rootRecord?.prims.size ?? 0,
    layerMeta: rootRecord?.meta,
    unreadable: rootRecord?.unreadable,
    arcs: [],
  })

  const reached = new Set([rootKey])
  const queue = [{ index: rootIndex, ancestors: [rootKey] }]
  let omittedArcs = 0
  let arcCount = 0
  let resolvedCount = 0

  while (queue.length > 0 && nodes.length < MAX_COMPOSITION_NODES) {
    const current = queue.shift()
    const node = nodes[current.index]
    const record = records.get(node.key)
    if (record === undefined || typeof record.unreadable === 'string') continue
    if (node.depth >= MAX_COMPOSITION_DEPTH) {
      // The bound is stated, not silently applied: the arcs this layer declares
      // are counted as omitted so the panel can say the tree was clipped.
      let remaining = record.meta.subLayers.length
      for (const prim of record.prims.values()) remaining += compositionArcsOf(prim).length
      if (remaining > 0) omittedArcs += remaining
      continue
    }
    let children = 0

    /** Add one arc to the layer's list and one child node when it resolves. */
    const expand = (arc) => {
      arcCount += 1
      node.arcs.push(arc)
      if (arc.targetLayer === '') return
      resolvedCount += 1
      if (nodes.length >= MAX_COMPOSITION_NODES || children >= MAX_CHILDREN_PER_NODE) {
        omittedArcs += 1
        return
      }
      // A cycle is an arc, but not a new layer: the walk stops here instead of
      // recursing forever.
      if (current.ancestors.includes(arc.targetLayer)) {
        arc.cycle = true
        return
      }
      const target = records.get(arc.targetLayer)
      const childIndex = addNode({
        key: arc.targetLayer,
        name: baseNameOf(arc.targetLayer),
        role: arc.kind,
        parent: current.index,
        depth: node.depth + 1,
        from: {
          layer: record.key,
          prim: arc.prim,
          asset: arc.asset,
          arcPrim: arc.arcPrim,
          kind: arc.kind,
        },
        format: target?.format ?? 'unknown',
        primCount: target?.prims.size ?? 0,
        layerMeta: target?.meta,
        unreadable: target?.unreadable,
        arcs: [],
      })
      reached.add(arc.targetLayer)
      queue.push({ index: childIndex, ancestors: [...current.ancestors, arc.targetLayer] })
      children += 1
    }

    // The local layer stack first: a sublayer composes at the same paths, and the
    // panel reads the layer stack before the prim arcs that follow it.
    for (const asset of record.meta.subLayers) {
      const target = layerForArc(byKey, record.key, asset)
      expand({ kind: 'sublayer', prim: '', asset, arcPrim: '', targetLayer: target?.key ?? '' })
    }
    for (const [primPath, prim] of record.prims) {
      for (const arc of compositionArcsOf(prim)) {
        const target = layerForArc(byKey, record.key, arc.asset)
        expand({
          kind: arc.kind,
          prim: primPath,
          asset: arc.asset,
          arcPrim: arc.prim ?? '',
          targetLayer: target?.key ?? '',
        })
      }
    }
  }

  // A layer the composition kept but no arc explains — an engine alias, a
  // package member, a texture the loader also registered — is stated rather
  // than silently left out of the count.
  const unreached = []
  for (const entry of entries) {
    if (reached.has(entry.key)) continue
    const record = records.get(entry.key)
    unreached.push({
      key: entry.key,
      name: baseNameOf(entry.key),
      format: record?.format ?? 'unknown',
      reason: record?.format === 'unknown' ? 'not a USD layer' : 'not reached through any arc in this stage',
    })
  }

  return {
    rootKey,
    nodes,
    unreached,
    counts: {
      layers: nodes.length,
      arcs: arcCount,
      resolved: resolvedCount,
      unresolved: arcCount - resolvedCount,
    },
    omittedArcs,
    truncated: nodes.length >= MAX_COMPOSITION_NODES || omittedArcs > 0,
  }
}
