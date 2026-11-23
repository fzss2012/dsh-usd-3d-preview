/**
 * The prim details a selection panel shows: what a stage *declares* about one
 * prim, read back from the layer bytes the engine composed.
 *
 * ## Why this exists as a second reader
 *
 * The engine hands the viewport a three graph. That graph keeps what it needs to
 * draw — a mesh's name, geometry, material — and drops everything else: the
 * declared prim type, `kind`, `apiSchemas`, `customData`, the full attribute
 * table, relationships, and the composition arcs. A preview asks "which prim is
 * this, and what does the file say about it?"; the second half of that question is
 * only answerable from the bytes.
 *
 * The shape follows usdview's *Prim Metadata* and *Attributes* panes, because that
 * is the reference a USD user already has in their hands: declared type beside
 * each attribute name, the type and `kind` of the prim, and its relationships
 * listed as resolved target paths.
 *
 * ## What it is not
 *
 * Not a composition engine. A value shown is the one **strongest in the layers the
 * stage was composed from** — layers are merged in composition order and the first
 * opinion wins, which matches the "which layer did this come from?" reading
 * usdview gives you. It does not evaluate variants or resolve inherit chains.
 * Every layer that contributed is named, and so is the layer each attribute's value
 * came from, so an unexpected value still points at its source. A prim the layers do
 * not describe reports exactly that instead of an empty panel.
 *
 * ## Complete composition arcs
 *
 * A prim's composition is all six arc kinds LIVRPS names — sublayers, inherits,
 * variant sets, references, payloads and specializes — and the panel that claims
 * to show "the composition" has to carry all of them, not just the two that
 * re-root a path. The reader reports the references and payloads (with the layer
 * that authored each and the layer/prim it resolves to), the inherits and
 * specializes paths, the declared variant sets with their variant names, and the
 * authored variant selection. Layers are reported too, each with the arc it was
 * reached through (root, sublayer, reference, payload), so a value pulled from a
 * referenced file stays traceable to the arc that placed it there.
 *
 * Both containers are covered: the ASCII reader keeps the arcs it already scans,
 * and the crate path decodes the list-op value types three's parser skips
 * (`references`, `payload`, `inheritPaths`, `specializes`,
 * `variantSetNames`, `subLayers`). A container this reader cannot decode
 * faithfully is reported as unreadable rather than presented as declarations —
 * a shifted crate path table is a wrong answer, not a partial one.
 *
 * ## Composed paths
 *
 * One thing it *does* follow is the path. Composition re-roots a referenced or
 * payloaded layer: the viewport names a mesh by the path the stage composes, while
 * the layer that describes it wrote a different one (or none of the prefix). Asking
 * the layers for the composed path therefore finds nothing, which is why this reader
 * walks the arcs the layers themselves declare — `references`, `payload` and
 * `subLayers` — and reports both paths. That walk is not composition: it moves a
 * lookup, it does not merge opinions.
 *
 * ## Large arrays
 *
 * A 300k-point mesh reports `point3f[8]` plus a preview of its first elements.
 * The element count is read from the array's punctuation, not from its values, so
 * a solved robot's geometry layer costs one delimiter scan rather than a parse of
 * tens of megabytes.
 *
 * @module dsh-usd-3d-preview/details
 */
import { AsciiLayerReader, mergePrim } from './layer-text.js'

/** Crate containers start with this; anything else we read is ASCII text. */
const CRATE_MAGIC = 'PXR-USDC'

/** Spec types in a crate layer (crateDataTypes.h). */
const SPEC_ATTRIBUTE = 1
const SPEC_PRIM = 6
const SPEC_PSEUDO_ROOT = 7
const SPEC_RELATIONSHIP = 8

/** A crate `FieldSet` ends with this index (0xFFFFFFFF stored as int32). */
const FIELD_SET_END = -1

/** The crate `variability` enum's "uniform" value. */
const VARIABILITY_UNIFORM = 1

/** Crate quaternions are stored (i, j, k, real); USD text writes (real, i, j, k). */
const QUATERNION_TYPES = new Set(['quatf', 'quatd', 'quath'])

/**
 * Crate vector value-type enums whose inlined form packs int8 components.
 *
 * OpenUSD inlines a vector when every component fits an int8; three decodes
 * that for the float-vector enums only, so the double and half spellings are
 * recovered here (see crateInlinedVectorValues).
 */
const INLINE_VECTOR_DIMENSIONS = new Map([[19, 2], [21, 2], [23, 3], [25, 3], [27, 4], [29, 4]])

/** How many elements of a long array the panel previews. */
const PREVIEW_ELEMENTS = 4

/**
 * Attributes a USD reader looks for first, in usdview's order: the transform, then
 * visibility and purpose, then geometry and material declarations.
 *
 * This is presentation order only — an attribute not named here is still listed,
 * after these, under its own namespace.
 */
const LEADING_ATTRIBUTES = Object.freeze([
  'xformOpOrder', 'xformOp:transform', 'xformOp:translate', 'xformOp:orient',
  'xformOp:rotateXYZ', 'xformOp:rotateX', 'xformOp:rotateY', 'xformOp:rotateZ', 'xformOp:scale',
  'visibility', 'purpose', 'extent', 'doubleSided', 'orientation', 'subdivisionScheme',
  // Geometry: the arrays a mesh is made of, after its transform and its display
  // declarations — the same reading order usdview presents.
  'points', 'normals', 'faceVertexCounts', 'faceVertexIndices', 'material:binding',
])

/**
 * Namespaces that get a group of their own, in the order a reader scans them.
 *
 * A prim's attribute table is otherwise one list; these are the namespaces whose
 * meaning is a *category* to a USD reader (`physics:mass` is not "an attribute
 * called physics:mass", it is the mass).
 */
const NAMESPACES = Object.freeze(['xformOp', 'physics', 'simready', 'primvars', 'inputs', 'outputs', 'material', 'userProperties'])

/** The group an attribute belongs to, in the order the panel lists them. */
const GROUP_ORDER = Object.freeze(['Transform', 'Geometry', 'Physics', 'Materials', 'Other'])

/** Whether a byte array is a binary crate rather than an ASCII layer. */
function isCrateLayer(bytes) {
  if (bytes === undefined || bytes.byteLength < 8) return false
  for (let index = 0; index < 8; index += 1) {
    if (bytes[index] !== CRATE_MAGIC.charCodeAt(index)) return false
  }
  return true
}

/**
 * Whether a byte array can be read as text at all, judged by its first byte.
 *
 * A UTF-8 BOM counts as text: it is what a Windows editor writes by default, and a
 * `.usda` that starts with one is still an ASCII layer. Refusing it here is not a
 * harmless skip — the layer then contributes nothing to a prim, so a stage composed
 * from BOM-prefixed files reports that no layer describes any prim at all.
 * @param bytes - the layer's bytes.
 * @returns whether this looks like a text layer.
 */
function isTextLayer(bytes) {
  if (bytes === undefined || bytes.byteLength < 4) return false
  if (isCrateLayer(bytes)) return false
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return true
  return bytes[0] === 0x23 || bytes[0] === 0x20 || bytes[0] === 0x0A || bytes[0] === 0x0D || bytes[0] === 0x2F
}

/** Turn the engine's package (Blob per layer) into bytes, in composition order. */
async function layerBytesOf(sources) {
  const entries = []
  const collect = async (key, value) => {
    let bytes
    if (typeof value === 'string') bytes = new TextEncoder().encode(value)
    else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value)
    else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    else if (typeof Blob !== 'undefined' && value instanceof Blob) bytes = new Uint8Array(await value.arrayBuffer())
    if (bytes === undefined || bytes.byteLength === 0) return
    // The source value stays on the entry so a caller can tell two spellings of one
    // blob (the engine registers aliases) from two layers with the same content.
    entries.push({ key: String(key), bytes, source: value })
  }
  if (sources instanceof Map) {
    for (const [key, value] of sources) await collect(key, value)
  } else if (Array.isArray(sources)) {
    for (const entry of sources) {
      if (Array.isArray(entry) && entry.length >= 2) await collect(entry[0], entry[1])
    }
  } else if (typeof sources === 'object' && sources !== null) {
    for (const key of Object.keys(sources)) await collect(key, sources[key])
  }
  return entries
}

// ── crate decoding ─────────────────────────────────────────────────────────

/**
 * The declared type and modifiers of every attribute in a crate layer.
 *
 * three's parser resolves a spec's field set into plain fields — `typeName`,
 * `variability`, `custom`, `default`, `targetPaths` — so this reads them off the
 * already-decoded specs rather than walking the field table itself. What it adds
 * is that it keeps them per *attribute*: three composes geometry from the
 * `default` values and never looks at an attribute's declared type.
 * @param specs - the parser's `specsByPath`.
 * @returns property path to `{ typeName, custom, uniform }`.
 */
function crateAttributeFields(specs) {
  const out = new Map()
  for (const path of Object.keys(specs)) {
    const spec = specs[path]
    if (spec === undefined || spec.specType !== SPEC_ATTRIBUTE) continue
    const fields = spec.fields ?? {}
    out.set(path, {
      typeName: typeof fields.typeName === 'string' ? fields.typeName : '',
      custom: fields.custom === true,
      uniform: fields.variability === VARIABILITY_UNIFORM,
    })
  }
  return out
}

/** Recover the applied API schemas of every prim (three skips the list op). */
function crateApiSchemas(parser) {
  try {
    const TOKEN_LIST_OP = 32
    const paths = parser.paths
    const specs = parser.specs
    const fields = parser.fields
    const fieldSets = parser.fieldSets
    const tokens = parser.tokens
    const buffer = parser.buffer
    if (!Array.isArray(specs) || !Array.isArray(fields) || !Array.isArray(fieldSets)) return new Map()
    if (!(buffer instanceof ArrayBuffer) || !Array.isArray(tokens)) return new Map()
    const view = new DataView(buffer)
    const out = new Map()
    const LIST_FLAGS = [0x02, 0x04, 0x20, 0x40, 0x08, 0x10]
    for (const spec of specs) {
      if (spec.specType !== SPEC_PRIM) continue
      const path = paths[spec.pathIndex]
      if (typeof path !== 'string' || path === '') continue
      let at = spec.fieldSetIndex
      for (let guard = 0; guard < 4096; guard += 1) {
        const fieldIndex = fieldSets[at]
        if (fieldIndex === undefined || fieldIndex === FIELD_SET_END || fieldIndex === 0xFFFFFFFF) break
        at += 1
        const field = fields[fieldIndex]
        if (field === undefined) break
        if (tokens[field.tokenIndex] !== 'apiSchemas') continue
        const rep = field.valueRep
        if (rep === undefined || rep.typeEnum !== TOKEN_LIST_OP || rep.isInlined === true) break
        const start = rep.payload
        if (!(start > 0) || start >= view.byteLength) break
        const flags = view.getUint8(start)
        let cursor = start + 1
        const schemas = []
        for (const mask of LIST_FLAGS) {
          if ((flags & mask) === 0) continue
          if (cursor + 8 > view.byteLength) break
          const count = Number(view.getBigUint64(cursor, true))
          cursor += 8
          for (let step = 0; step < count; step += 1) {
            if (cursor + 4 > view.byteLength) break
            const token = tokens[view.getUint32(cursor, true)]
            cursor += 4
            if (typeof token === 'string' && token !== '') schemas.push(token)
          }
        }
        out.set(path, schemas)
        break
      }
    }
    return out
  } catch {
    return new Map()
  }
}

/**
 * Decode inlined vector defaults that three's parser hands back as a scalar.
 *
 * OpenUSD writes a vector inline when every component is exactly representable
 * as int8; three decodes that for its float-vector enum values but not for the
 * double and half ones, so a `double3 xformOp:translate` arrives as the raw
 * 32-bit payload (often just the x component). The declared type says the value
 * is a vector and the rep packs the components as int8, so they are recovered
 * here. Every attribute is scanned, because any vector attribute can be
 * authored in its inline form — not just the transform ops a rig needs.
 * @param parser - the parser instance after its parseData call.
 * @returns a map of property path to the decoded component array.
 */
function crateInlinedVectorValues(parser) {
  const out = new Map()
  try {
    const { paths, specs, fields, fieldSets, tokens } = parser
    if (!Array.isArray(paths) || !Array.isArray(specs)) return out
    if (!Array.isArray(fields) || !Array.isArray(fieldSets) || !Array.isArray(tokens)) return out
    for (const spec of specs) {
      if (spec.specType !== SPEC_ATTRIBUTE) continue
      const path = paths[spec.pathIndex]
      if (typeof path !== 'string' || path === '') continue
      let at = spec.fieldSetIndex
      for (let guard = 0; guard < 4096; guard += 1) {
        const fieldIndex = fieldSets[at]
        if (fieldIndex === undefined || fieldIndex === FIELD_SET_END || fieldIndex === 0xFFFFFFFF) break
        at += 1
        const field = fields[fieldIndex]
        if (field === undefined) break
        if (tokens[field.tokenIndex] !== 'default') continue
        const rep = field.valueRep
        if (rep === undefined || rep.isInlined !== true) break
        const dimension = INLINE_VECTOR_DIMENSIONS.get(rep.typeEnum)
        if (dimension === undefined) break
        const components = new Array(dimension)
        for (let index = 0; index < dimension; index += 1) {
          const byte = (rep.lo >>> (8 * index)) & 0xFF
          components[index] = byte > 0x7F ? byte - 0x100 : byte
        }
        out.set(path, components)
        break
      }
    }
  } catch {
    // A container this build decodes differently keeps three's values; the
    // panel still states the declared type beside them.
  }
  return out
}

/** The `specifier` enum of a crate prim spec, spelled the way a layer writes it. */
function specifierOf(value) {
  if (value === 1) return 'over'
  if (value === 2) return 'class'
  return 'def'
}

/** The prim-level metadata a crate spec carries. */
function crateMeta(fields) {
  const meta = { variantSets: [] }
  if (fields.active === false) meta.active = false
  if (fields.instanceable === true) meta.instanceable = true
  if (typeof fields.documentation === 'string' && fields.documentation !== '') meta.doc = fields.documentation
  if (typeof fields.displayName === 'string' && fields.displayName !== '') meta.displayName = fields.displayName
  if (fields.customData !== null && typeof fields.customData === 'object') meta.customData = fields.customData
  return meta
}

/** Reorder a crate quaternion to the USD text convention (real, i, j, k). */
function crateQuaternion(value) {
  if (!Array.isArray(value) && !ArrayBuffer.isView(value)) return value
  if (value.length < 4) return value
  return [value[3], value[0], value[1], value[2]]
}

/**
 * Decode one crate layer into the prim records the panel reads.
 * @param bytes - the layer's bytes.
 * @param USDCParser - the crate parser class (injected, so this module stays
 *   loadable in a context that has no USD loader).
 * @returns the prim map, or undefined when the container cannot be decoded.
 */
function readCratePrims(bytes, USDCParser, options = {}) {
  const withAttributes = options.withAttributes !== false
  const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer
  const parser = new USDCParser()
  parser.parseData(buffer)
  // The path table decides every declaration below: a shifted table is not a
  // reason to guess. Both checks read the parser's own decoded state, so a layer
  // this build cannot decode is reported rather than shown as garbage.
  if (cratePathsTrustworthy(parser) === false) return undefined
  const arcs = crateArcs(parser)
  if (arcs.ok === false) return undefined
  const specs = parser.specsByPath ?? {}
  const meta = crateLayerMeta(specs)
  if (arcs.subLayers.length > 0) meta.subLayers = [...arcs.subLayers]
  const apiSchemas = crateApiSchemas(parser)
  const attributeFields = crateAttributeFields(specs)
  // Attribute values are not needed for a composition-only decode, and the
  // inlined-vector repair scans every attribute spec.
  const inlinedVectors = withAttributes === false ? new Map() : crateInlinedVectorValues(parser)
  const prims = new Map()
  const properties = []
  for (const path of Object.keys(specs)) {
    const spec = specs[path]
    if (spec === undefined) continue
    if (spec.specType === SPEC_PRIM) {
      const fields = spec.fields ?? {}
      prims.set(path, {
        path,
        type: typeof fields.typeName === 'string' ? fields.typeName : '',
        specifier: specifierOf(fields.specifier),
        apiSchemas: apiSchemas.get(path) ?? [],
        attrs: Object.create(null),
        attrTypes: Object.create(null),
        attrFlags: Object.create(null),
        arraySizes: Object.create(null),
        rels: Object.create(null),
        spans: Object.create(null),
        meta: crateMeta(fields),
        text: undefined,
      })
    } else if (spec.specType === SPEC_ATTRIBUTE || spec.specType === SPEC_RELATIONSHIP) {
      properties.push(path)
    }
  }
  // The arcs three's parser skips are attached to the same prim records the
  // details reader consumes, so an ASCII layer and a crate produce one record
  // shape: every consumer of an arc stays container-agnostic.
  for (const [path, arcsOfPrim] of arcs.prims) {
    const prim = prims.get(path)
    if (prim === undefined) continue
    if (arcsOfPrim.references !== undefined) prim.meta.references = arcsOfPrim.references
    if (arcsOfPrim.payload !== undefined) prim.meta.payload = arcsOfPrim.payload
    if (arcsOfPrim.inherits !== undefined) prim.meta.inherits = arcsOfPrim.inherits
    if (arcsOfPrim.specializes !== undefined) prim.meta.specializes = arcsOfPrim.specializes
    if (arcsOfPrim.variantSets !== undefined) prim.meta.variantSets = [...arcsOfPrim.variantSets]
    if (arcsOfPrim.variants !== undefined) prim.meta.variants = arcsOfPrim.variants
  }
  for (const path of properties) {
    const cut = path.lastIndexOf('.')
    if (cut <= path.lastIndexOf('/')) continue
    const owner = prims.get(path.slice(0, cut))
    if (owner === undefined) continue
    const name = path.slice(cut + 1)
    const spec = specs[path]
    const fields = spec.fields ?? {}
    if (spec.specType === SPEC_RELATIONSHIP) {
      if (withAttributes === false) continue
      const targets = Array.isArray(fields.targetPaths) ? fields.targetPaths : []
      owner.rels[name] = targets.filter(target => typeof target === 'string' && target.startsWith('/'))
      continue
    }
    // A composition read wants the prims and their arcs, not a solved robot's
    // million-point arrays: the declared types are cheap to keep, the values are
    // what cost memory, so the caller decides whether to materialise them.
    if (withAttributes === false) {
      const declaredOnly = attributeFields.get(path) ?? {}
      const declaredName = typeof declaredOnly.typeName === 'string'
        ? declaredOnly.typeName
        : (typeof fields.typeName === 'string' ? fields.typeName : '')
      if (declaredName !== '') owner.attrTypes[name] = declaredName
      continue
    }
    const declared = attributeFields.get(path) ?? {}
    // three spells an attribute's declared type the way the layer does, arity
    // included: `point3f[]`, `color3f`, `float`. A crate stores a `point3f[]` as a
    // flat Float32Array and a `color3f` as a 3-element array, so "the value is an
    // array" is not what decides arity — the declared type is.
    const rawType = typeof declared.typeName === 'string' && declared.typeName !== ''
      ? declared.typeName
      : (typeof fields.typeName === 'string' ? fields.typeName : '')
    // An inlined vector arrives as its raw scalar payload; the repaired component
    // array is what the declared fixed-width type promises.
    const repaired = inlinedVectors.get(path)
    const value = repaired !== undefined && typeof fields.default === 'number' ? repaired : fields.default
    const declaredType = rawType
    if (declaredType !== '') owner.attrTypes[name] = declaredType
    const flags = {}
    if (declared.custom === true) flags.custom = true
    if (declared.uniform === true) flags.uniform = true
    if (Object.keys(flags).length > 0) owner.attrFlags[name] = flags
    if (value === undefined) continue
    const isArray = isListValue(value)
    if (isArray === false) {
      owner.attrs[name] = value
      continue
    }
    const isList = rawType.endsWith('[]') === true
    const elementType = isList === true ? rawType.slice(0, -2) : rawType
    if (QUATERNION_TYPES.has(elementType) === true && value.length >= 4 && isList === false) {
      owner.attrs[name] = crateQuaternion(value)
      continue
    }
    // A declared list is counted by its element width; a fixed-width value
    // (`color3f`, `point3d`) is one value made of components.
    const width = elementWidthOf(elementType)
    const arity = isList === true ? width : 1
    const elements = arity > 1 ? Math.floor(value.length / arity) : value.length
    // A long list is shown as its element count plus a head cut on an element
    // boundary, so the preview never shows half a vector.
    if (isList === true && elements > PREVIEW_ELEMENTS) {
      owner.attrs[name] = arity > 1 ? headOf(value, arity) : Array.from(value).slice(0, PREVIEW_ELEMENTS)
      owner.arraySizes[name] = elements
      continue
    }
    owner.attrs[name] = arity > 1 && value.length % arity === 0 ? asTuples(value, arity) : Array.from(value)
  }
  return { prims, meta }
}

/**
 * The layer-level metadata a crate carries on its pseudo-root spec.
 *
 * A crate has no header block the way a text layer does: the pseudo-root spec
 * (`specType` 7, path `/`) holds exactly the fields a `.usda` writes between
 * its `#usda` line and the first prim, and `defaultPrim` among them is what a reference
 * to this layer resolves through — the same fact the text reader keeps on
 * `layer.meta`. three's parser already decodes those fields; this names the
 * four the details reader uses.
 * @param specs - the parser's `specsByPath`.
 * @returns the layer metadata, empty when the crate carries none.
 */
function crateLayerMeta(specs) {
  const fields = specs[SPEC_PSEUDO_ROOT]?.fields ?? specs['/']?.fields ?? {}
  const meta = {}
  if (typeof fields.defaultPrim === 'string' && fields.defaultPrim !== '') meta.defaultPrim = fields.defaultPrim
  if (typeof fields.documentation === 'string' && fields.documentation !== '') meta.doc = fields.documentation
  if (typeof fields.metersPerUnit === 'number') meta.metersPerUnit = fields.metersPerUnit
  if (typeof fields.upAxis === 'string') meta.upAxis = fields.upAxis
  if (typeof fields.startTimeCode === 'number') meta.startTimeCode = fields.startTimeCode
  if (typeof fields.endTimeCode === 'number') meta.endTimeCode = fields.endTimeCode
  if (typeof fields.timeCodesPerSecond === 'number') meta.timeCodesPerSecond = fields.timeCodesPerSecond
  return meta
}

// ── crate composition arcs ─────────────────────────────────────────────────
//
// three's crate parser decodes what composition needs to draw — prims, paths,
// attributes — and deliberately skips the list-op value types (references,
// payload, inheritPaths, specializes, variantSetNames, subLayers) with a console
// warning, because a renderer does not need to know which layer an opinion came
// from. A composition reader does: those fields *are* the arcs. They are
// decoded from the raw value reps here, following the crate format's list-op
// layout: a flags byte, then the present lists in serialization order, each a
// uint64 count followed by fixed-size items. Reading the field table rather than
// re-parsing the bytes keeps one parse per layer.

/** Crate value-type enums for the list-ops this reader decodes (crateDataTypes.h). */
const TYPE_STRING_LIST_OP = 33
const TYPE_PATH_LIST_OP = 34
const TYPE_REFERENCE_LIST_OP = 35
const TYPE_STRING_VECTOR = 50
const TYPE_PAYLOAD_LIST_OP = 55

/** List-op flags in the order the format writes them: explicit, added, prepended, appended, deleted, ordered. */
const LIST_OP_LISTS = Object.freeze([0x02, 0x04, 0x20, 0x40, 0x08, 0x10])

/** A crate field name to the spelling a USDA layer uses, when the two differ. */
const CRATE_ARC_FIELDS = Object.freeze({
  references: 'references',
  payload: 'payload',
  inheritPaths: 'inherits',
  specializes: 'specializes',
  variantSetNames: 'variantSets',
  variantSelection: 'variants',
})

/**
 * A reader bound to one parsed crate layer's tables.
 *
 * The arc payloads are byte offsets into the same buffer three parsed, and the
 * items are indices into the already-decoded token/string/path tables — so one
 * object with the DataView and those three tables is all the decoders need.
 * @param parser - the parser instance after its parseData call.
 * @returns the context, or undefined when the tables are not readable.
 */
function crateArcContext(parser) {
  const view = parser.buffer instanceof ArrayBuffer ? new DataView(parser.buffer) : undefined
  if (view === undefined) return undefined
  const { tokens, strings, paths } = parser
  if (!Array.isArray(tokens) || !Array.isArray(strings) || !Array.isArray(paths)) return undefined
  return { view, tokens, strings, paths }
}

/** The string a crate string index names (its string table stores token indices). */
function crateString(ctx, stringIndex) {
  const tokenIndex = ctx.strings[stringIndex]
  return typeof tokenIndex === 'number' ? (ctx.tokens[tokenIndex] ?? '') : ''
}

/**
 * Read one list-op value into its elements.
 *
 * Walks the flags byte and every list it announces, in the serialization order
 * the format fixes; each item reader advances the cursor and may decline an
 * element (value undefined) while still moving the cursor, which keeps a
 * malformed item from desynchronising the ones after it.
 * @param ctx - the crate tables.
 * @param start - byte offset of the list-op payload.
 * @param readItem - a function of (ctx, cursor) returning { cursor, value }.
 * @returns the values in flag order; empty when the value cannot be read.
 */
function readCrateListOp(ctx, start, readItem) {
  const { view } = ctx
  let cursor = start
  const out = []
  if (!(start >= 0) || start >= view.byteLength) return out
  const flags = view.getUint8(cursor)
  cursor += 1
  for (const mask of LIST_OP_LISTS) {
    if ((flags & mask) === 0) continue
    if (cursor + 8 > view.byteLength) return out
    const count = Number(view.getBigUint64(cursor, true))
    cursor += 8
    for (let index = 0; index < count; index += 1) {
      const item = readItem(ctx, cursor)
      if (item === undefined || item.cursor <= cursor) return out
      cursor = item.cursor
      if (item.value !== undefined) out.push(item.value)
    }
  }
  return out
}

/** One path index of a path list-op (inherits, specializes). */
function readCratePathItem(ctx, cursor) {
  if (cursor + 4 > ctx.view.byteLength) return undefined
  const index = ctx.view.getUint32(cursor, true)
  const path = ctx.paths[index]
  return { cursor: cursor + 4, value: typeof path === 'string' && path !== '' ? path : undefined }
}

/** One string index of a string list-op (variantSetNames). */
function readCrateStringItem(ctx, cursor) {
  if (cursor + 4 > ctx.view.byteLength) return undefined
  const index = ctx.view.getUint32(cursor, true)
  const value = crateString(ctx, index)
  return { cursor: cursor + 4, value: value === '' ? undefined : value }
}

/**
 * Skip a crate VtDictionary value, returning the cursor past it.
 *
 * Every entry is a key token index followed by an int64 offset to the value's
 * rep; the rep sits at that offset and the next entry starts just past it. The
 * values themselves are never needed for an arc (only their presence), so they
 * are stepped over rather than decoded.
 * @param ctx - the crate tables.
 * @param cursor - byte offset of the dictionary's element count.
 * @returns the cursor past the dictionary, or undefined when it cannot be walked.
 */
function skipCrateDictionary(ctx, cursor) {
  const { view } = ctx
  if (cursor + 8 > view.byteLength) return undefined
  const entries = Number(view.getBigUint64(cursor, true))
  cursor += 8
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 12 > view.byteLength) return undefined
    cursor += 4
    const relative = Number(view.getBigInt64(cursor, true))
    cursor += relative + 8
    if (cursor < 0 || cursor > view.byteLength) return undefined
  }
  return cursor
}

/** One SdfReference of a reference list-op. */
function readCrateReferenceItem(ctx, cursor) {
  const { view } = ctx
  if (cursor + 8 > view.byteLength) return undefined
  const assetIndex = view.getUint32(cursor, true)
  const pathIndex = view.getUint32(cursor + 4, true)
  cursor += 8
  // SdfLayerOffset: offset and scale doubles.
  if (cursor + 16 > view.byteLength) return undefined
  cursor += 16
  cursor = skipCrateDictionary(ctx, cursor)
  if (cursor === undefined) return undefined
  const asset = crateString(ctx, assetIndex)
  const primPath = ctx.paths[pathIndex]
  const value = asset === ''
    ? undefined
    : { asset, prim: typeof primPath === 'string' && primPath !== '' ? primPath : undefined }
  return { cursor, value }
}

/** One SdfPayload of a payload list-op (crate 0.8+ always writes its layer offset). */
function readCratePayloadItem(ctx, cursor) {
  const { view } = ctx
  if (cursor + 8 > view.byteLength) return undefined
  const assetIndex = view.getUint32(cursor, true)
  const pathIndex = view.getUint32(cursor + 4, true)
  cursor += 8
  if (cursor + 16 > view.byteLength) return undefined
  cursor += 16
  const asset = crateString(ctx, assetIndex)
  const primPath = ctx.paths[pathIndex]
  const value = asset === ''
    ? undefined
    : { asset, prim: typeof primPath === 'string' && primPath !== '' ? primPath : undefined }
  return { cursor, value }
}

/**
 * Whether a crate layer's path table decoded into paths this reader can trust.
 *
 * three trusts the first path count in the file, but the format can encode a
 * different number of paths than the table holds ("we do not write out the empty
 * path"), so a crate containing variant specs can come back with every path
 * shifted: prim names become metadata tokens, several specs collide on the empty
 * path, and every table built from them is nonsense. Rather than present that as
 * declarations, the layer is reported as unreadable — the honest answer.
 * @param parser - the parser instance after its parseData call.
 * @returns whether the prim paths are well-formed and unique.
 */
function cratePathsTrustworthy(parser) {
  try {
    const { paths, specs } = parser
    if (!Array.isArray(paths) || !Array.isArray(specs)) return false
    const seen = new Set()
    for (const spec of specs) {
      if (spec.specType !== SPEC_PRIM) continue
      const path = paths[spec.pathIndex]
      if (typeof path !== 'string') return false
      if (path === '' || path === '/') continue
      if (!path.startsWith('/')) return false
      for (const segment of path.slice(1).split('/')) {
        if (segment === '' || /[\s.{}@#]/.test(segment)) return false
      }
      if (seen.has(path)) return false
      seen.add(path)
    }
    return true
  } catch {
    return false
  }
}

/**
 * The composition arcs a crate layer declares, decoded from its field table.
 *
 * Returns the same shape an ASCII layer puts on each prim's meta — the
 * composition module must not care which container authored an arc — plus the
 * layer-level subLayers list that re-roots nothing but stacks more layers.
 * A layer whose path table is corrupt yields a not-ok result rather than a
 * half-decoded arc list.
 * @param parser - the parser instance after its parseData call.
 * @returns an object with ok, a prim path to meta map, and the subLayers list.
 */
function crateArcs(parser) {
  const ctx = crateArcContext(parser)
  if (ctx === undefined || cratePathsTrustworthy(parser) === false) return { ok: false, prims: new Map(), subLayers: [] }
  const prims = new Map()
  const subLayers = []
  // The parser's spec array carries the raw table indexes; the decoded fields live
  // in its specsByPath map. Both are needed: list ops come from the raw tables,
  // and the variant selection map is one of the values three already decoded.
  const decoded = parser.specsByPath ?? {}
  try {
    for (const spec of parser.specs) {
      const path = parser.paths[spec.pathIndex]
      if (spec.specType === SPEC_PSEUDO_ROOT) {
        // The pseudo-root stores the layer stack as a StringVector: a count then
        // one string-table index per sublayer. Its decoded value is never used —
        // three leaves the unsupported type null — so the raw field rep is read.
        let at = spec.fieldSetIndex
        for (let guard = 0; guard < 4096; guard += 1) {
          const fieldIndex = parser.fieldSets[at]
          if (fieldIndex === undefined || fieldIndex === FIELD_SET_END || fieldIndex === 0xFFFFFFFF) break
          at += 1
          const field = parser.fields[fieldIndex]
          if (field === undefined) break
          if (parser.tokens[field.tokenIndex] !== 'subLayers') continue
          const rep = field.valueRep
          if (rep === undefined || rep.typeEnum !== TYPE_STRING_VECTOR) break
          const start = rep.payload
          if (!(start > 0) || start >= ctx.view.byteLength) break
          let cursor = start
          const count = Number(ctx.view.getBigUint64(cursor, true))
          cursor += 8
          for (let index = 0; index < count; index += 1) {
            if (cursor + 4 > ctx.view.byteLength) break
            const value = crateString(ctx, ctx.view.getUint32(cursor, true))
            cursor += 4
            if (value !== '') subLayers.push(value)
          }
          break
        }
        continue
      }
      if (spec.specType !== SPEC_PRIM || typeof path !== 'string' || path === '') continue
      const arcs = {}
      let at = spec.fieldSetIndex
      for (let guard = 0; guard < 4096; guard += 1) {
        const fieldIndex = parser.fieldSets[at]
        if (fieldIndex === undefined || fieldIndex === FIELD_SET_END || fieldIndex === 0xFFFFFFFF) break
        at += 1
        const field = parser.fields[fieldIndex]
        if (field === undefined) break
        const name = parser.tokens[field.tokenIndex]
        const key = CRATE_ARC_FIELDS[name]
        if (key === undefined) continue
        const rep = field.valueRep
        if (rep === undefined || rep.isInlined === true) continue
        // The value type decides the layout, so a field read through the wrong
        // enum is skipped instead of misparsed; the field name then only says
        // which arc key the decoded list belongs to.
        let values
        if (key === 'variants') {
          const selection = decoded[path]?.fields?.variantSelection
          values = selection !== null && typeof selection === 'object'
            ? Object.fromEntries(Object.entries(selection).filter(([, value]) => typeof value === 'string' && value !== ''))
            : undefined
        } else if (rep.typeEnum === TYPE_REFERENCE_LIST_OP) {
          values = readCrateListOp(ctx, rep.payload, readCrateReferenceItem)
        } else if (rep.typeEnum === TYPE_PAYLOAD_LIST_OP) {
          values = readCrateListOp(ctx, rep.payload, readCratePayloadItem)
        } else if (rep.typeEnum === TYPE_PATH_LIST_OP) {
          values = readCrateListOp(ctx, rep.payload, readCratePathItem)
        } else if (rep.typeEnum === TYPE_STRING_LIST_OP) {
          values = readCrateListOp(ctx, rep.payload, readCrateStringItem)
        }
        if (values === undefined) continue
        if (Array.isArray(values) && values.length === 0) continue
        if (key === 'variants' && Object.keys(values).length === 0) continue
        arcs[key] = values
      }
      if (Object.keys(arcs).length > 0) prims.set(path, arcs)
    }
  } catch {
    return { ok: false, prims: new Map(), subLayers: [] }
  }
  return { ok: true, prims, subLayers }
}

/** Whether a crate default is a list of values (rather than one value). */
function isListValue(value) {
  return Array.isArray(value) || ArrayBuffer.isView(value)
}

/** The first `PREVIEW_ELEMENTS` elements of a flat list, cut on element boundaries. */
function headOf(value, dimension) {
  const head = []
  const limit = Math.min(value.length, PREVIEW_ELEMENTS * dimension)
  for (let at = 0; at + dimension <= limit; at += dimension) {
    const component = Array.from(value.subarray === undefined ? value.slice(at, at + dimension) : value.subarray(at, at + dimension))
    head.push(dimension === 1 ? component[0] : component)
  }
  return head
}

/** A flat list regrouped into `dimension`-component elements. */
function asTuples(value, dimension) {
  const out = []
  for (let at = 0; at + dimension <= value.length; at += dimension) {
    const component = Array.from(value.subarray === undefined ? value.slice(at, at + dimension) : value.subarray(at, at + dimension))
    out.push(dimension === 1 ? component[0] : component)
  }
  return out
}

/**
 * How many scalar components one element of a declared type has.
 *
 * USD spells a vector type two ways: `<base><width><precision>` — `point3f`,
 * `texCoord2f`, `color4h`, `normal3d` — and the shorthand `<base><width>` with no
 * precision, `float3` / `double3` / `half2`. A matrix is one value rather than its
 * components, and a type with no digit (`float`, `int`, `token`, `quatf`) is a
 * scalar or is handled separately.
 * @param type - a USD type name, without the `[]` suffix.
 * @returns the component count, 1 for a scalar.
 */
export function elementWidthOf(type) {
  if (typeof type !== 'string' || type === '') return 1
  const base = type.endsWith('[]') === true ? type.slice(0, -2) : type
  if (QUATERNION_TYPES.has(base) === true) return 4
  if (base.startsWith('matrix') === true) return 1
  // `point3f` / `float3`: the width digit is followed by a precision or by the end.
  const suffixed = /[2-4]([fdh])$/.exec(base)
  if (suffixed !== null) return Number(base[suffixed.index])
  const bare = /[2-4]$/.exec(base)
  if (bare !== null) return Number(base[bare.index])
  return 1
}

// ── assembling one prim's details ──────────────────────────────────────────

/**
 * The group one attribute belongs to, using usdview's vocabulary.
 *
 * The groups are the namespaces a USD reader thinks in — the transform stack, the
 * geometry a mesh is made of, the physics a SimReady asset declares, the shader
 * inputs a material carries — and everything else falls back to its own namespace
 * or to "Other" rather than being flattened into one long list.
 * @param name - the attribute's full name.
 * @returns one of {@link GROUP_ORDER}.
 */
export function groupOf(name) {
  if (name.startsWith('xformOp')) return 'Transform'
  if (name.startsWith('physics:') || name.startsWith('simready:')) return 'Physics'
  if (name.startsWith('inputs:') || name.startsWith('outputs:') || name.startsWith('material:')) return 'Materials'
  if (name === 'points' || name === 'normals' || name === 'extent' || name === 'faceVertexCounts'
    || name === 'faceVertexIndices' || name.startsWith('primvars:') || name === 'orientation'
    || name === 'doubleSided' || name === 'subdivisionScheme' || name === 'purpose' || name === 'visibility') {
    return 'Geometry'
  }
  // Everything else — including a prim whose attributes are all in one custom
  // namespace (`userProperties:…`) — is one group rather than a list of one-row
  // groups. The named namespaces above are what a reader thinks in; a namespace not
  // in that list is a name, not a category.
  return 'Other'
}

/**
 * Order attributes the way a reader scans them: the leading names first, then the
 * namespaced ones, then everything else — each alphabetically within its band.
 * @param names - the attribute names to order.
 * @returns the ordered names.
 */
export function orderAttributes(names) {
  const rank = (name) => {
    const leading = LEADING_ATTRIBUTES.indexOf(name)
    if (leading >= 0) return leading
    const namespace = NAMESPACES.findIndex(prefix => name.startsWith(prefix + ':') || name === prefix)
    if (namespace >= 0) return LEADING_ATTRIBUTES.length + namespace
    return LEADING_ATTRIBUTES.length + NAMESPACES.length
  }
  return [...names].sort((left, right) => {
    const difference = rank(left) - rank(right)
    return difference !== 0 ? difference : left.localeCompare(right)
  })
}
/**
 * Coerce one value to its declared type.
 *
 * ASCII writes `uniform bool doubleSided = 1`, which is legal USD, while a crate
 * stores the same attribute as a boolean. Coercing on the declared type is what
 * lets the panel show one thing for one file whichever container it arrived in.
 * @param value - the value as read from the layer.
 * @param declaredType - its declared USD type.
 * @returns the value in the shape its type implies.
 */
function coerceValue(value, declaredType) {
  if (declaredType !== 'bool' || value === undefined) return value
  if (Array.isArray(value)) return value.map(entry => (typeof entry === 'number' ? entry !== 0 : entry))
  return typeof value === 'number' ? value !== 0 : value
}

/**
 * Format one attribute value the way usdview's value column does: compact, with a
 * large array reduced to its declared size and a preview.
 * @param value - the (possibly partial) value.
 * @param declaredType - its declared USD type, when known.
 * @param size - the true element count when the value was truncated.
 * @returns a display string.
 */
export function formatValue(value, declaredType, size) {
  const formatScalar = (entry) => {
    if (entry === null) return 'None'
    if (typeof entry === 'boolean') return entry === true ? 'true' : 'false'
    if (typeof entry === 'number') {
      // A float32 goes through a binary representation; 6 significant digits is
      // what reads as "the authored value" rather than as float noise.
      return Number.isInteger(entry) ? String(entry) : String(Number(entry.toPrecision(6)))
    }
    if (typeof entry === 'string') return entry
    if (entry === undefined) return ''
    return String(entry)
  }
  /**
   * One value, formatted for the value column.
   *
   * A `bool` reaches here already coerced (see `coerceValue`); everything else is
   * formatted as its type implies.
   */
  const formatEntry = entry => (Array.isArray(entry) ? `(${entry.map(formatScalar).join(', ')})` : formatScalar(entry))
  const isList = entry => Array.isArray(entry) || ArrayBuffer.isView(entry)
  if (size !== undefined) {
    // A truncated array arrives already reduced to its head; its true length is
    // all that is left to state.
    const head = isList(value) ? [...value].slice(0, PREVIEW_ELEMENTS) : []
    return `[${size} values] ${head.map(formatEntry).join(', ')}${size > head.length ? ', …' : ''}`
  }
  if (value === undefined) return declaredType === undefined ? '' : declaredType
  if (isList(value)) return `[${[...value].map(formatEntry).join(', ')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value)
    if (keys.length === 0) return '{}'
    return `{ ${keys.map((key) => {
      const inner = value[key]
      const shown = typeof inner === 'object' && inner !== null
        ? (Array.isArray(inner) ? `[${inner.map(formatEntry).join(', ')}]` : '{ … }')
        : formatScalar(inner)
      return `${key} = ${shown}`
    }).join(', ')} }`
  }
  return formatScalar(value)
}

/**
 * @typedef {object} DetailAttribute
 * @property {string} name - the attribute's full name.
 * @property {string} type - its declared USD type (`float3[]`), '' when unknown.
 * @property {string} value - the display string.
 * @property {boolean} custom - whether the layer declares it `custom`.
 * @property {boolean} uniform - whether it is declared `uniform`.
 * @property {number} [arraySize] - element count, for a truncated array.
 * @property {string} layer - the package key of the layer the value came from.
 */

/**
 * @typedef {object} DetailRelationship
 * @property {string} name - the relationship's full name.
 * @property {string[]} targets - the target prim paths.
 * @property {string} layer - where it was declared.
 */

/**
 * @typedef {object} DetailArc
 * @property {'reference'|'payload'} kind - which arc this is.
 * @property {string} asset - the `@…@` body as authored.
 * @property {string} prim - the arc's own prim path, '' when it relies on the
 *   referenced layer's `defaultPrim`.
 * @property {string} layer - the layer that authored the arc.
 * @property {string} targetLayer - the composed layer the asset resolves to,
 *   '' when this stage did not compose it.
 * @property {string} targetPrim - the prim the arc composes (the arc path, or
 *   the referenced layer's `defaultPrim` when the arc names none).
 */

/**
 * @typedef {object} DetailLayerArc
 * @property {string} key - the layer's package key.
 * @property {'root'|'sublayer'|'reference'|'payload'} kind - how it is reached.
 * @property {string} from - the layer that named it ('' for the root).
 * @property {string} fromPath - the prim that declared the arc, for references
 *   and payloads.
 * @property {string} asset - the arc's `@…@` body, for references and payloads.
 * @property {string} prim - the arc's authored prim path, when it named one.
 */

/**
 * @typedef {object} PrimDetails
 * @property {string} path - the prim's absolute stage path.
 * @property {string} name - its display name (the last path component).
 * @property {string} type - its declared prim type (`Mesh`).
 * @property {string} specifier - `def` / `over` / `class`.
 * @property {string} kind - the authored `kind`, '' when none.
 * @property {string[]} apiSchemas - every applied API schema.
 * @property {string[]} variantSets - variant sets the prim declares.
 * @property {Record<string, string[]>} variantNames - set to declared variants,
 *   when the layers spell them.
 * @property {Record<string, string>} variantSelections - set to selected variant.
 * @property {string[]} inherits - authored inherits paths.
 * @property {string[]} specializes - authored specializes paths.
 * @property {DetailArc[]} references - authored references, with resolution.
 * @property {DetailArc[]} payloads - authored payloads, with resolution.
 * @property {string} doc - the authored `doc`, '' when none.
 * @property {Record<string, unknown>} customData - the authored custom data.
 * @property {DetailAttribute[]} attributes - every attribute, ordered for reading.
 * @property {DetailRelationship[]} relationships - every relationship and its targets.
 * @property {string[]} layers - the package keys of every layer that described it.
 * @property {DetailLayerArc[]} layerArcs - how each of those layers is reached, in
 *   the same order as `layers`.
 * @property {{key: string, reason: string}[]} unreadableLayers - layers that were
 *   present but whose declarations could not be decoded.
 * @property {boolean} present - whether the layers described this prim at all.
 */

/**
 * Read one prim's declared details out of the layer bytes a stage was composed
 * from.
 *
 * @param sources - the layers the stage was composed from, keyed by package path
 *   (a Map of Blob/bytes, as `engine.js` hands them over), or any equivalent
 *   iterable of `[key, bytes]`.
 * @param path - the prim path to describe.
 * @param options - reader options.
 * @param options.parseCrate - the crate parser class; the browser half injects
 *   three's `USDCParser` so this module has no USD loader of its own.
 * @returns the details, with `present: false` when no layer described the prim.
 */
export async function readPrimDetails(sources, path, options = {}) {
  const entries = await layerBytesOf(sources)
  // Decode every layer once, then resolve the requested stage path against each
  // one's own authored paths: composition re-roots a referenced layer, so the
  // path the viewport names a prim by is not the path the layer wrote.
  //
  // A layer that cannot be decoded is named rather than dropped silently: "the
  // crate could not be read back" and "no layer describes that prim" are
  // different answers, and only the panel can state the first honestly.
  const layers = []
  const unreadableLayers = []
  for (const entry of entries) {
    let decoded
    try {
      decoded = decodeLayerBytes(entry.bytes, options.parseCrate, { withAttributes: true })
    } catch {
      unreadableLayers.push({ key: entry.key, reason: 'the container could not be read' })
      continue
    }
    if (decoded === undefined) {
      unreadableLayers.push({ key: entry.key, reason: 'the container could not be read' })
      continue
    }
    if (typeof decoded.unreadable === 'string') {
      unreadableLayers.push({ key: entry.key, reason: decoded.unreadable })
      continue
    }
    layers.push({ key: entry.key, prims: decoded.prims, meta: decoded.meta ?? {} })
  }
  const resolved = resolveAuthoredPath(layers, path)
  const prim = {
    merged: undefined,
    layers: [],
    layerArcs: [],
    arcOrigins: new Map(),
    authored: path,
    attributes: new Map(),
  }
  let oversizedPrim
  for (const { entry, authored, via } of resolved) {
    const found = entry.prims.get(authored)
    if (found === undefined) continue
    prim.layers.push(entry.key)
    prim.layerArcs.push({
      key: entry.key,
      kind: typeof via?.kind === 'string' ? via.kind : 'root',
      from: typeof via?.from === 'string' ? via.from : '',
      fromPath: typeof via?.fromPath === 'string' ? via.fromPath : '',
      asset: typeof via?.asset === 'string' ? via.asset : '',
      prim: typeof via?.prim === 'string' ? via.prim : '',
    })
    if (prim.merged === undefined) {
      prim.merged = clonePrim(found)
      prim.authored = authored
    } else {
      mergePrim(prim.merged, found, found.specifier)
    }
    // Which layer each value came from: the first layer to author an attribute is
    // the one the merged value is taken from (see `mergePrim`), so the name recorded
    // here is the name of the layer that actually wrote what the panel shows.
    for (const name of Object.keys(found.attrs)) {
      if (!prim.attributes.has(name)) prim.attributes.set(name, entry.key)
    }
    for (const name of Object.keys(found.attrTypes)) {
      if (!prim.attributes.has(name)) prim.attributes.set(name, entry.key)
    }
    for (const name of Object.keys(found.rels)) {
      if (!prim.attributes.has(name)) prim.attributes.set(name, entry.key)
    }
    // Merging keeps the first layer's opinion for an arc, exactly as it does for
    // an attribute; naming that layer is what keeps the panel's rows traceable.
    for (const key of ['references', 'payload', 'inherits', 'specializes']) {
      const value = found.meta[key]
      if (Array.isArray(value) && value.length > 0 && prim.arcOrigins.has(key) === false) prim.arcOrigins.set(key, entry.key)
    }
    if (Array.isArray(found.meta.variantSets) && found.meta.variantSets.length > 0 && prim.arcOrigins.has('variantSets') === false) {
      prim.arcOrigins.set('variantSets', entry.key)
    }
    if (found.meta.variants !== undefined && found.meta.variants !== null
      && Object.keys(found.meta.variants).length > 0 && prim.arcOrigins.has('variants') === false) {
      prim.arcOrigins.set('variants', entry.key)
    }
    if (found.arraySizes !== undefined && Object.keys(found.arraySizes).length > 0) {
      oversizedPrim = { ...oversizedPrim, ...found.arraySizes }
    }
  }
  if (prim.merged === undefined) {
    return {
      path,
      authoredPath: path,
      name: path.split('/').filter(Boolean).pop() ?? '',
      type: '',
      specifier: '',
      kind: '',
      apiSchemas: [],
      variantSets: [],
      variantNames: {},
      variantSelections: {},
      inherits: [],
      specializes: [],
      references: [],
      payloads: [],
      doc: '',
      customData: {},
      attributes: [],
      relationships: [],
      layers: [],
      layerArcs: [],
      unreadableLayers,
      present: false,
    }
  }
  const merged = prim.merged
  const sizes = { ...(oversizedPrim ?? {}) }
  for (const [name, size] of Object.entries(merged.arraySizes)) sizes[name] = size
  const attributes = orderAttributes(Object.keys(merged.attrTypes).length > 0
    ? [...new Set([...Object.keys(merged.attrTypes), ...Object.keys(merged.attrs)])]
    : Object.keys(merged.attrs)).map((name) => {
    const flags = merged.attrFlags[name] ?? {}
    const size = sizes[name]
    const declared = merged.attrTypes[name] ?? ''
    return {
      name,
      type: declared,
      value: formatValue(coerceValue(merged.attrs[name], declared), declared, size),
      custom: flags.custom === true,
      uniform: flags.uniform === true,
      ...(size === undefined ? {} : { arraySize: size }),
      layer: prim.attributes.get(name) ?? prim.layers[0],
    }
  })
  const relationships = Object.keys(merged.rels).sort().map(name => ({
    name,
    targets: merged.rels[name],
    layer: prim.attributes.get(name) ?? prim.layers[0],
  }))
  // Resolve each authored arc against the layers this stage actually composed, so
  // a row can say both where the arc points and whether that layer was read. An
  // unresolved target is not a guess: it is exactly what the stage is missing.
  const byKey = new Map(layers.map(layer => [layer.key, layer]))
  const resolveArcs = (kind, list, origin) => {
    if (!Array.isArray(list)) return []
    return list.map((arc) => {
      const asset = typeof arc?.asset === 'string' ? arc.asset : ''
      const target = asset === '' ? undefined : layerForArc(byKey, origin, asset)
      const defaultPrim = target !== undefined && typeof target.meta?.defaultPrim === 'string' ? target.meta.defaultPrim : ''
      const arcPrim = typeof arc?.prim === 'string' ? arc.prim : ''
      const targetPrim = arcPrim !== '' ? arcPrim : (defaultPrim === '' ? '' : '/' + defaultPrim)
      return { kind, asset, prim: arcPrim, layer: origin, targetLayer: target?.key ?? '', targetPrim }
    })
  }
  const arcOrigin = key => prim.arcOrigins.get(key) ?? prim.layers[0]
  const variantSelections = merged.meta.variants !== null && typeof merged.meta.variants === 'object'
    ? Object.fromEntries(Object.entries(merged.meta.variants).filter(([, value]) => typeof value === 'string' && value !== ''))
    : {}
  const variantNames = {}
  if (merged.meta.variantNames !== null && typeof merged.meta.variantNames === 'object') {
    for (const [set, names] of Object.entries(merged.meta.variantNames)) {
      const kept = Array.isArray(names) ? names.filter(name => typeof name === 'string' && name !== '') : []
      if (kept.length > 0) variantNames[set] = kept
    }
  }
  return {
    path,
    // The path the layer itself authored, which differs from the stage path
    // whenever a reference or a payload re-roots the prim. The panel names both,
    // because "which prim is this" and "where is it written" are different facts.
    authoredPath: prim.authored,
    name: path.split('/').filter(Boolean).pop() ?? '',
    type: merged.type,
    specifier: merged.specifier,
    kind: typeof merged.meta.kind === 'string' ? merged.meta.kind : '',
    apiSchemas: [...merged.apiSchemas],
    variantSets: [...(merged.meta.variantSets ?? [])],
    variantNames,
    variantSelections,
    inherits: [...(merged.meta.inherits ?? [])],
    specializes: [...(merged.meta.specializes ?? [])],
    references: resolveArcs('reference', merged.meta.references, arcOrigin('references')),
    payloads: resolveArcs('payload', merged.meta.payload, arcOrigin('payload')),
    doc: typeof merged.meta.doc === 'string' ? merged.meta.doc : '',
    customData: merged.meta.customData ?? {},
    attributes,
    relationships,
    layers: [...prim.layers],
    layerArcs: [...prim.layerArcs],
    unreadableLayers,
    present: true,
  }
}

/**
 * Resolve a composed stage path to the path each layer actually authored.
 *
 * Composition re-roots a referenced or payloaded asset: the viewport names a mesh
 * by the path the *stage* composes (`/World/Robot/Bodies/base/post`), while the layer
 * that describes it wrote `/Arm/Bodies/base/post` — or, for a payload, no prefix
 * at all. Asking the layers for the composed path finds nothing, which is what made
 * the panel answer "no layer describes this prim" for every referenced asset.
 *
 * This walks the composition the same way the stage does, from the root layer down:
 * a layer names a prim, and any prim of that layer whose metadata references or
 * payloads another layer re-roots the rest of the path onto it. The walk is
 * depth-first over the arcs the layers themselves declare, which is why it needs
 * the default prim of the referenced layer — the arc composes that prim, not the
 * layer's root.
 *
 * A path no arc explains resolves to itself, so a plain single-layer stage (and
 * every fixture that has no arcs) is unaffected.
 * @param layers - the decoded layers: `key`, `prims`, `meta`.
 * @param path - the composed stage path to resolve.
 * @returns one `{ entry, authored }` per layer that can describe the prim.
 */
function resolveAuthoredPath(layers, path) {
  const byKey = new Map(layers.map(layer => [layer.key, layer]))
  const root = layers[0]
  const out = []
  if (root === undefined) return out
  // A (layer, path-in-that-layer) pair, not a layer: one asset referenced twice is
  // the same layer reached at two places, and each place re-roots it differently.
  // The `via` record is how the layer is reached, so the panel can name the arc a
  // row came through instead of printing a flat list of files.
  const visited = new Set()
  const queue = [{ layer: root, prefix: '', authored: path, via: { kind: 'root' } }]
  while (queue.length > 0) {
    const current = queue.shift()
    const id = current.layer.key + '|' + current.authored
    if (visited.has(id) === true) continue
    visited.add(id)
    out.push({ entry: current.layer, authored: current.authored, via: current.via })
    // A sublayer composes at the *same* path as the layer that lists it: it
    // re-roots nothing, so the very same authored path is asked of it.
    for (const sub of subLayersOf(current.layer, byKey)) {
      queue.push({ layer: sub, prefix: current.prefix, authored: current.authored, via: { kind: 'sublayer', from: current.layer.key } })
    }
    // A reference or a payload composes the referenced layer's prim *under* the
    // arc's own prim, so the rest of the composed path is looked for there.
    for (const [authored, prim] of current.layer.prims) {
      const arcs = compositionArcsOf(prim)
      if (arcs.length === 0) continue
      const arcAuthoredPath = joinPath(current.prefix, authored)
      const inside = current.authored === arcAuthoredPath || current.authored.startsWith(arcAuthoredPath + '/')
      if (inside === false) continue
      const rest = current.authored.slice(arcAuthoredPath.length)
      for (const arc of arcs) {
        const target = layerForArc(byKey, current.layer.key, arc.asset)
        if (target === undefined) continue
        // The prim the arc composes: the arc's own prim path when it names one,
        // the referenced layer's `defaultPrim` otherwise — the default prim is the
        // whole reason a reference does not have to spell a path.
        const targetPrim = arc.prim !== undefined
          ? arc.prim
          : (typeof target.meta.defaultPrim === 'string' && target.meta.defaultPrim !== '' ? '/' + target.meta.defaultPrim : '')
        if (targetPrim === '') continue
        // A reference may name the referenced layer's absolute root; the rest of
        // the composed path then starts at that root rather than under it.
        const authoredInTarget = targetPrim === '/' ? (rest === '' ? '/' : rest) : targetPrim + rest
        queue.push({
          layer: target,
          prefix: arcAuthoredPath,
          authored: authoredInTarget,
          via: { kind: arc.kind, from: current.layer.key, fromPath: arcAuthoredPath, asset: arc.asset, prim: arc.prim },
        })
      }
    }
  }
  return out
}

/**
 * The decoded layers one layer lists in `subLayers`.
 *
 * A sublayer does not re-root anything — it composes at the same prim paths — so it
 * is not an arc that moves a path, but it is still a layer that can describe the
 * prim, which is what the caller is collecting.
 * @param layer - the layer whose header is being read.
 * @param byKey - every decoded layer, keyed by package path.
 * @returns the sublayers this stage composed, in the order the header lists them.
 */
function subLayersOf(layer, byKey) {
  const listed = layer.meta?.subLayers
  if (!Array.isArray(listed)) return []
  const out = []
  for (const entry of listed) {
    const asset = typeof entry === 'string' ? entry : (typeof entry?.asset === 'string' ? entry.asset : '')
    if (asset === '') continue
    const target = layerForArc(byKey, layer.key, asset)
    if (target !== undefined) out.push(target)
  }
  return out
}

/**
 * The composition arcs one prim declares.
 *
 * `references` and `payload` are kept by the text reader as a list of
 * `{ asset, prim }` because they are what re-roots a layer.
 * @param prim - one prim record.
 * @returns the arcs, empty when the prim references nothing.
 */
function compositionArcsOf(prim) {
  const arcs = []
  for (const [kind, list] of [['reference', prim.meta?.references], ['payload', prim.meta?.payload]]) {
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      if (typeof entry?.asset === 'string' && entry.asset !== '') {
        arcs.push({ kind, asset: entry.asset, prim: typeof entry.prim === 'string' ? entry.prim : undefined })
      }
    }
  }
  return arcs
}

/** Join a stage prefix with a layer-authored prim path. */
function joinPath(prefix, path) {
  if (prefix === '') return path
  if (path === '/') return prefix
  return prefix + path
}

/**
 * The decoded layer an arc's asset names.
 *
 * The engine registers a referenced layer under the key its referencing layer
 * looked it up by — the referencing layer's directory plus the reference body,
 * which is the rule `referenceKey` in `usd.js` implements for the three fallback.
 * An exact miss falls back to a path-suffix match, because an absolute address or an
 * `s3://` alias can register the same bytes under a spelling the arc cannot predict.
 * @param byKey - every decoded layer, keyed by package path.
 * @param layerKey - the referencing layer's key.
 * @param asset - the `@…@` body as written.
 * @returns the layer, or undefined when the stage never composed it.
 */
function layerForArc(byKey, layerKey, asset) {
  const slash = layerKey.lastIndexOf('/')
  const base = slash < 0 ? '' : layerKey.slice(0, slash + 1)
  const clean = asset.startsWith('./') ? asset.slice(2) : asset
  const exact = byKey.get(base + clean)
  if (exact !== undefined) return exact
  for (const [key, layer] of byKey) {
    if (key === clean || key.endsWith('/' + clean) === true) return layer
  }
  return undefined
}

/** A prim record this module may merge into without touching the layer's own. */
function clonePrim(prim) {
  const meta = { ...prim.meta, variantSets: [...prim.meta.variantSets] }
  // The arcs are merged by mutating the target record, so their arrays and maps
  // are copies: a merge must never write through into the layer it read.
  if (Array.isArray(prim.meta.references)) meta.references = prim.meta.references.map(arc => ({ ...arc }))
  if (Array.isArray(prim.meta.payload)) meta.payload = prim.meta.payload.map(arc => ({ ...arc }))
  if (Array.isArray(prim.meta.inherits)) meta.inherits = [...prim.meta.inherits]
  if (Array.isArray(prim.meta.specializes)) meta.specializes = [...prim.meta.specializes]
  if (prim.meta.variants !== undefined && prim.meta.variants !== null) meta.variants = { ...prim.meta.variants }
  if (prim.meta.variantNames !== undefined && prim.meta.variantNames !== null) {
    meta.variantNames = Object.fromEntries(Object.entries(prim.meta.variantNames).map(([set, names]) => [set, [...names]]))
  }
  return {
    ...prim,
    apiSchemas: [...prim.apiSchemas],
    attrs: { ...prim.attrs },
    attrTypes: { ...prim.attrTypes },
    attrFlags: { ...prim.attrFlags },
    arraySizes: { ...prim.arraySizes },
    rels: { ...prim.rels },
    spans: { ...prim.spans },
    meta,
  }
}

/**
 * Decode one layer's bytes into prim records.
 * @param bytes - the layer's bytes.
 * @param parseCrate - the crate parser class, when the caller has one.
 * @returns the prim map, or undefined for a container this reader cannot decode.
 */
function decodeLayerBytes(bytes, parseCrate, options = {}) {
  if (isCrateLayer(bytes) === true) {
    if (typeof parseCrate !== 'function') return { unreadable: 'crate layer: no crate parser is available in this context' }
    const decoded = readCratePrims(bytes, parseCrate, options)
    if (decoded === undefined) return { unreadable: 'crate layer: this container could not be decoded faithfully' }
    return decoded
  }
  if (isTextLayer(bytes) === false) {
    return {
      unreadable: isPackageLayer(bytes) === true
        ? 'usdz package: its layers live inside the archive'
        : 'unrecognized container: neither an ASCII layer nor a crate',
    }
  }
  const text = new TextDecoder().decode(bytes)
  const withAttributes = options.withAttributes !== false
  const reader = new AsciiLayerReader(text, {
    keep: withAttributes ? () => true : () => false,
    arrayHead: PREVIEW_ELEMENTS,
  })
  return { prims: reader.read(), meta: reader.meta }
}

/**
 * Whether bytes are a zip package (a .usdz), by its leading signature.
 * @param bytes - the layer's bytes.
 * @returns whether this is a zip archive rather than a layer.
 */
function isPackageLayer(bytes) {
  if (bytes === undefined || bytes.byteLength < 4) return false
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4B) return false
  return (bytes[2] === 0x03 && bytes[3] === 0x04)
    || (bytes[2] === 0x05 && bytes[3] === 0x06)
    || (bytes[2] === 0x07 && bytes[3] === 0x08)
}

export {
  PREVIEW_ELEMENTS,
  LEADING_ATTRIBUTES,
  NAMESPACES,
  GROUP_ORDER,
  isCrateLayer,
  isTextLayer,
  isPackageLayer,
  layerBytesOf,
  decodeLayerBytes,
  layerForArc,
  joinPath,
  subLayersOf,
  compositionArcsOf,
}
