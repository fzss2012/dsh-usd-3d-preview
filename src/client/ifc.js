/**
 * What this package claims for IFC, plus the container and naming helpers the
 * browser half needs before a model reaches the engine.
 *
 * Nothing here imports web-ifc or three: the registry definition is plain data,
 * container detection is eight bytes of header, and the path helpers are pure
 * string work. That keeps the whole module testable in Node and keeps the WASM
 * engine out of the module graph until an IFC file is actually opened.
 *
 * ## Why IFC is a second preview implementation, not a second suffix on the USD one
 *
 * The two formats share a viewport and nothing else. A USD file is composed by an
 * engine that resolves composition arcs; an IFC file is a STEP physical file
 * whose product structure is resolved by a schema-aware reader. Registering one
 * implementation for both would mean every USD code path carrying an "unless this
 * is IFC" branch, and the two panels answer different questions (a prim path and
 * its declarations; an express ID and its property sets). They share the
 * `createView` renderer, the studio rig and the tokens, which is the part that
 * is actually common.
 *
 * @module dsh-usd-3d-preview/ifc
 */

/** Implementation identity: the `documentPreviews` id and the keyed document-slot key. */
export const IFC_PREVIEW_ID = 'dsh-usd-3d-preview/ifc'

/** File suffixes this implementation renders, without a leading dot. */
export const IFC_EXTENSIONS = ['ifc', 'ifczip']

/**
 * Suffixes whose bytes are never readable text.
 *
 * An `.ifc` is a STEP physical file: ASCII, and legitimately readable as text —
 * so it is deliberately *not* declared binary, exactly like `.usda`. An
 * `.ifczip` is a zip package and always binary.
 */
export const BINARY_IFC_EXTENSIONS = ['ifczip']

/** The STEP physical file prologue every `.ifc` starts with. */
const STEP_MAGIC = 'ISO-10303-21'

/** Local-file zip signatures: local header, empty archive, spanned archive. */
const ZIP_MAGICS = [
  [0x50, 0x4B, 0x03, 0x04],
  [0x50, 0x4B, 0x05, 0x06],
  [0x50, 0x4B, 0x07, 0x08],
]

/** The `FILE_SCHEMA(('IFC4'));` line, whatever whitespace the author used. */
const FILE_SCHEMA = /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/

/** How much of a file is decoded to read its header. */
const HEADER_WINDOW = 8192

/**
 * The registry definition for this implementation.
 * @param title - locale-bound implementation label, read when the toolbar renders.
 * @returns metadata for complete IFC files of either suffix.
 */
export function ifcDefinition(title) {
  return {
    id: IFC_PREVIEW_ID,
    extensions: IFC_EXTENSIONS,
    binaryExtensions: BINARY_IFC_EXTENSIONS,
    // The outside-the-product band, so a later builtin viewer for .ifc cannot
    // silently take the suffix over.
    priority: 'extension',
    title,
    // A model is a single self-contained STEP file: the whole thing is needed
    // before the schema reader can resolve a product's placement.
    loading: 'bytes-complete',
    wrap: false,
  }
}

/**
 * Whether the buffer starts with one exact byte sequence.
 * @param bytes - complete file bytes.
 * @param magic - expected leading bytes.
 * @returns true when the prefix matches.
 */
function startsWithBytes(bytes, magic) {
  if (bytes.length < magic.length) return false
  for (let index = 0; index < magic.length; index += 1) {
    if (bytes[index] !== magic[index]) return false
  }
  return true
}

/**
 * Classify complete IFC bytes by their container.
 *
 * The extension is not consulted: an `.ifc` holding a zip is an IFCZIP whatever
 * it is called, and a STEP file renamed to `.ifczip` is still a STEP file. A
 * UTF-8 BOM in front of the prologue is tolerated, because a Windows authoring
 * tool that writes "UTF-8" emits one and the prologue is still the prologue.
 * @param bytes - complete file bytes.
 * @returns `ifc` for a STEP file, `ifczip` for a zip package, `undefined` for anything else.
 */
export function ifcFormatOf(bytes) {
  if (bytes === undefined || bytes === null || bytes.byteLength === undefined) return undefined
  if (ZIP_MAGICS.some(magic => startsWithBytes(bytes, magic))) return 'ifczip'
  let start = 0
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) start = 3
  // The prologue is the first thing in the file; only the leading bytes decide.
  const head = new TextDecoder().decode(bytes.subarray(start, Math.min(bytes.length, start + STEP_MAGIC.length)))
  return head === STEP_MAGIC ? 'ifc' : undefined
}

/**
 * Whether one file name carries an IFC model.
 * @param name - a file name, with or without its directory.
 * @returns true for `.ifc` and `.ifczip`, in any case.
 */
export function isIfcName(name) {
  const text = String(name ?? '')
  const dot = text.lastIndexOf('.')
  return dot >= 0 && IFC_EXTENSIONS.includes(text.slice(dot + 1).toLowerCase())
}

/**
 * The IFC schema an ASCII header declares.
 *
 * Reported rather than guessed: IFC2X3, IFC4 and IFC4X3 place different
 * attributes on the same product, so a panel that names the schema makes a
 * surprising property traceable to the file that wrote it.
 * @param text - the beginning of a STEP file (or all of it).
 * @returns the schema name, or undefined when the header carries none.
 */
export function ifcHeaderSchema(text) {
  const match = FILE_SCHEMA.exec(String(text ?? '').slice(0, HEADER_WINDOW))
  return match === null ? undefined : match[1].trim()
}

/**
 * Decode the beginning of a STEP file, for header reads.
 * @param bytes - complete or partial file bytes.
 * @returns the leading text, without a UTF-8 BOM.
 */
export function ifcHeaderText(bytes) {
  if (bytes === undefined || bytes === null || bytes.byteLength === undefined) return ''
  const view = bytes.subarray(0, Math.min(bytes.byteLength, HEADER_WINDOW))
  const start = view.length >= 3 && view[0] === 0xEF && view[1] === 0xBB && view[2] === 0xBF ? 3 : 0
  return new TextDecoder().decode(view.subarray(start))
}

/**
 * The root `.ifc` entry of an IFCZIP package.
 *
 * The archive is a plain zip holding one model plus optional property files, so
 * the root is the shallowest `.ifc` member — the same rule the drop path uses to
 * pick a stage out of a folder. A package with no model is reported rather than
 * silently composed as empty.
 * @param entries - the archive's members, keyed by name.
 * @returns the root member's name, or undefined when the package holds no model.
 */
export function ifczipRoot(entries) {
  const names = Object.keys(entries ?? {}).filter(name => isIfcName(name))
  if (names.length === 0) return undefined
  const depth = (name) => name.split('/').length
  names.sort((left, right) => depth(left) - depth(right) || left.localeCompare(right))
  return names[0]
}

/**
 * A length unit as the model declares it, spelled the way an IFC reader says it.
 *
 * web-ifc already converts every coordinate to metres before this plugin sees it
 * (its `applyLinearScalingFactor` default), so this label describes the *file's*
 * authored unit rather than the scene's — which is what makes "why is this 5 and
 * not 5000" answerable from the panel.
 * @param prefix - the SI prefix, e.g. `MILLI`, or '' for none.
 * @param name - the SI unit name, e.g. `METRE`.
 * @returns a short unit label, e.g. `mm`.
 */
export function ifcLengthUnitLabel(prefix, name) {
  const upperPrefix = String(prefix ?? '').toUpperCase()
  const upperName = String(name ?? '').toUpperCase()
  const symbol = upperName === 'METRE' ? 'm' : upperName === 'FOOT' ? 'ft' : upperName === 'INCH' ? 'in' : upperName.toLowerCase()
  const scale = {
    EXA: 'E', PETA: 'P', TERA: 'T', GIGA: 'G', MEGA: 'M', KILO: 'k',
    HECTO: 'h', DECA: 'da', DECI: 'd', CENTI: 'c', MILLI: 'm', MICRO: 'µ',
    NANO: 'n', PICO: 'p', FEMTO: 'f', ATTO: 'a',
  }[upperPrefix]
  return scale === undefined ? symbol : scale + symbol
}

/**
 * How one unit scale reads in the stats line.
 *
 * A metre-unit file needs no sentence ("the numbers already are metres"); any
 * other unit is the one fact a reader cannot derive from the model itself, so it
 * is stated with the factor the geometry was multiplied by.
 * @param label - the authored unit, from {@link ifcLengthUnitLabel}.
 * @returns a short description, or '' when the model already counts in metres.
 */
export function ifcUnitDescription(label) {
  const text = String(label ?? '')
  if (text === '' || text === 'm') return ''
  return text
}

/** Characters that cannot appear in one path segment. */
const UNSAFE_SEGMENT = /[\u0000-\u001f/\\]/g

/**
 * One path segment for a spatial structure or a product.
 *
 * The element tree is the same tree the USD preview draws, so a segment has to
 * survive `buildPrimTree`'s `/` split. An IFC name may legitimately contain a
 * slash ("Wall/1"), a control character, or nothing at all, so it is folded to
 * something a path can hold — and the express ID is what makes the result
 * unambiguous even when two products share a name.
 * @param name - the product's `Name` attribute, possibly empty.
 * @param expressID - the product's express ID.
 * @param fallback - what to call it when it has no name at all, e.g. `IfcWall`.
 * @returns a non-empty segment without a slash.
 */
export function ifcPathSegment(name, expressID, fallback) {
  const cleaned = String(name ?? '').replace(UNSAFE_SEGMENT, '_').trim()
  if (cleaned !== '') return cleaned
  const type = String(fallback ?? 'IfcProduct').trim() || 'IfcProduct'
  return `${type} #${expressID}`
}

/**
 * The full path of one product, from the model root down.
 * @param segments - the path segments, outermost first.
 * @returns an absolute slash path, e.g. `/Site/Building/Level 1/Wall`.
 */
export function ifcPathOf(segments) {
  const parts = (segments ?? []).filter(segment => typeof segment === 'string' && segment !== '')
  return `/${parts.join('/')}`
}

/**
 * Make one segment unique among its siblings.
 *
 * Two walls called "Wall" under one storey are two products, and a tree that
 * shows two identical leaves makes a click ambiguous. Only the collision is
 * disambiguated: the first keeps its name, later ones carry their express ID.
 * @param segment - the candidate segment from {@link ifcPathSegment}.
 * @param expressID - the product's express ID.
 * @param taken - the segments already used by its siblings (mutated).
 * @returns the segment to use.
 */
export function uniqueSegment(segment, expressID, taken) {
  const base = segment
  if (taken.has(base) === false) {
    taken.add(base)
    return base
  }
  const labelled = `${base} #${expressID}`
  taken.add(labelled)
  return labelled
}

/**
 * The IFC type name to display for one element.
 *
 * web-ifc's `GetNameFromTypeCode` already answers the schema spelling
 * (`IfcWallStandardCase`), which is the name a model checker uses and therefore
 * the one the panel keeps. This helper exists to make that contract explicit
 * rather than to reformat: an all-caps type code cannot be split back into words
 * (`IFCWALLSTANDARDCASE` has no word boundaries to recover), so it is passed
 * through as-is instead of being mangled into `Ifcwallstandardcase`.
 * @param ifcType - the type name web-ifc reports.
 * @returns the name to display, or '' for an empty one.
 */
export function ifcTypeLabel(ifcType) {
  return String(ifcType ?? '').trim()
}
