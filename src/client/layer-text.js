/**
 * The ASCII (`.usda`) layer reader shared by the articulation reader and the
 * prim-details reader.
 *
 * USD text offers a full grammar; this module implements the subset that
 * describes stage structure — prims, their metadata, attributes, relationships —
 * and skips every value it does not need **without allocating it**. That is what
 * keeps a scene with hundreds of thousands of mesh points cheap to scan: a
 * `point3f[] points = [...]` array is recorded as a byte span, never as 300k
 * numbers, unless the caller asked for that attribute by name.
 *
 * ## What it records
 *
 * Layer level (`layer.meta`): `defaultPrim`, `metersPerUnit`, `upAxis`, `doc`,
 * `startTimeCode` / `endTimeCode`, `subLayers`.
 *
 * Per prim, keyed by its absolute stage path:
 *
 *   - `path`, `type`, `specifier` (`def` / `over` / `class`), `apiSchemas`;
 *   - `attrs` — values the caller's `keep` predicate asked for;
 *   - `attrTypes` / `attrFlags` — every attribute's declared type and its
 *     `custom` / `uniform` / `config` modifiers, recorded even when the value is
 *     not materialised;
 *   - `spans` — the byte range of every attribute value, so a later reader can
 *     parse one value without re-scanning the layer;
 *   - `rels` — relationship target paths;
 *   - `meta` — `kind`, `doc`, `comment`, `active`, `displayName`, `customData`,
 *     `assetInfo`, `instanceable`, the composition arcs (`references`,
 *     `payload`, `inherits`, `specializes`), the declared `variantSets` with
 *     their variant `variantNames`, and the authored `variants` selection map.
 *     The arcs are kept because a reader that shows composition needs all of
 *     them, not just the two that re-root a path.
 *
 * ## Why a hand-written lexer rather than a regex sweep
 *
 * The values this reader must skip contain the characters a regex would trip on:
 * `@asset@` paths that hold `#`, dictionaries with nested braces, strings with
 * escaped quotes. A small recursive lexer skips a value by matching its
 * delimiters, which is both exact and allocation-free.
 *
 * @module dsh-usd-3d-preview/layer-text
 */

/** Statement modifiers that may precede a type or a relationship. */
const MODIFIERS = new Set([
  'custom', 'uniform', 'varying', 'optional', 'prepend', 'append', 'add', 'delete', 'reorder', 'config',
])

/**
 * Metadata keys whose values are statements, not attributes. Each is either
 * recorded on `prim.meta` / `layer.meta` or consumed whole — never mistaken for
 * an attribute.
 */
const METADATA_KEYS = new Set([
  'inherits', 'specializes', 'references', 'payload', 'subLayers', 'nameChildren', 'variantSets',
  'variantSet', 'doc', 'comment', 'kind', 'customData', 'assetInfo', 'defaultPrim', 'metersPerUnit',
  'upAxis', 'endTimeCode', 'startTimeCode', 'timeCodesPerSecond', 'fallbackPrimTypes', 'apiSchemas',
  'displayName', 'active', 'instanceable', 'hidden', 'noLoadHint', 'properties', 'primChildren',
  'variants',
])

/**
 * Metadata keys that name another layer and re-root it.
 *
 * A reference or a payload composes the *referenced layer's default prim* (or the
 * prim path the arc names) under the prim that declares it, so the prim paths of
 * that layer change meaning at the arc. They are kept, in the one shape a reader
 * of composition can use: `{ asset, prim }`, where `prim` is the arc's own path
 * when it names one and undefined when it relies on the layer's `defaultPrim`.
 */
const ARC_KEYS = new Set(['references', 'payload'])

/** Which of those are worth keeping for a reader that shows a prim's properties. */
const KEPT_PRIM_METADATA = new Set([
  'kind', 'doc', 'comment', 'active', 'displayName', 'customData', 'assetInfo', 'instanceable',
  // A variant selection is a composition arc a reader has to see: "which variant
  // is this prim showing" is asked as often as "what does it reference", and the
  // selection is authored as metadata, not as an attribute.
  'variants',
])

/** Which layer-level metadata is kept. */
const KEPT_LAYER_METADATA = new Set([
  'defaultPrim', 'metersPerUnit', 'upAxis', 'doc', 'comment',
  'startTimeCode', 'endTimeCode', 'timeCodesPerSecond', 'subLayers',
])

/** xformOp suffixes applied when a layer authors ops but no `xformOpOrder`. */
export const FALLBACK_OP_ORDER = Object.freeze([
  'xformOp:translate', 'xformOp:orient', 'xformOp:rotateX', 'xformOp:rotateY', 'xformOp:rotateZ',
  'xformOp:scale', 'xformOp:transform',
])

/** A fresh prim record: every field present, so consumers need no guards. */
function newPrim(path, type, specifier, text) {
  return {
    path,
    type,
    specifier,
    apiSchemas: [],
    attrs: Object.create(null),
    attrTypes: Object.create(null),
    attrFlags: Object.create(null),
    arraySizes: Object.create(null),
    rels: Object.create(null),
    spans: Object.create(null),
    meta: { variantSets: [] },
    text,
  }
}

/**
 * A focused reader for one ASCII layer.
 *
 * The default `keep` predicate materialises nothing eagerly — every value stays
 * available through its span — which is the right default for a reader that only
 * wants structure. The articulation reader passes the attribute names it needs,
 * so its physics values land in `attrs` in the same pass.
 */
export class AsciiLayerReader {
  /**
   * @param text - the layer's decoded text.
   * @param options - what to keep while scanning.
   * @param options.keep - whether one attribute's value should be materialised
   *   into `prim.attrs` (default: never; the span is still recorded).
   * @param options.arrayHead - when set, an array attribute longer than this many
   *   elements is not materialised: its element count is recorded in
   *   `prim.arraySizes[name]` and `prim.attrs[name]` keeps only its first
   *   `arrayHead` elements. A details panel wants "point3f[8], starting (…)" and
   *   never the 300k numbers of a solved robot's geometry layer.
   */
  constructor(text, options = {}) {
    // A UTF-8 BOM is legal at the start of a `.usda` and is what a Windows editor
    // writes by default. Left in place it defeats every "starts with #usda" test
    // below — the header block is then read as a prim's metadata and the layer
    // ends up with no `defaultPrim` at all, which silently breaks arc resolution.
    this.text = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text
    this.at = 0
    this.prims = new Map()
    this.keep = typeof options.keep === 'function' ? options.keep : () => false
    this.arrayHead = Number.isInteger(options.arrayHead) && options.arrayHead > 0 ? options.arrayHead : 0
    /** Layer-level metadata (the header block before the first prim). */
    this.meta = Object.create(null)
    /** Modifiers seen since the last statement, claimed by the next one. */
    this.modifiers = []
  }

  /** Skip whitespace, line comments and block comments. */
  skip() {
    const text = this.text
    for (;;) {
      const char = text[this.at]
      if (char === undefined) return
      if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
        this.at += 1
        continue
      }
      if (char === '#') {
        const end = text.indexOf('\n', this.at)
        this.at = end < 0 ? text.length : end + 1
        continue
      }
      if (char === '/' && text[this.at + 1] === '/') {
        const end = text.indexOf('\n', this.at)
        this.at = end < 0 ? text.length : end + 1
        continue
      }
      if (char === '/' && text[this.at + 1] === '*') {
        const end = text.indexOf('*/', this.at + 2)
        this.at = end < 0 ? text.length : end + 2
        continue
      }
      return
    }
  }

  /** Read one bare token: a keyword, a type name, an attribute name or a number. */
  word() {
    const text = this.text
    const start = this.at
    let at = start
    while (at < text.length) {
      const char = text[at]
      if (char === ' ' || char === '\t' || char === '\r' || char === '\n') break
      if (char === '{' || char === '}' || char === '(' || char === ')' || char === '[' || char === ']') break
      if (char === ',' || char === '=' || char === ';' || char === '"' || char === "'" || char === '#') break
      if (char === '<' || char === '>' || char === '@') break
      at += 1
    }
    this.at = at
    return text.slice(start, at)
  }

  /** Read a quoted string, including the triple-quoted form USD allows. */
  string() {
    const text = this.text
    const quote = text[this.at]
    const triple = quote.repeat(3)
    if (text.startsWith(triple, this.at)) {
      const end = text.indexOf(triple, this.at + 3)
      const value = text.slice(this.at + 3, end < 0 ? text.length : end)
      this.at = end < 0 ? text.length : end + 3
      return value
    }
    let at = this.at + 1
    let value = ''
    while (at < text.length) {
      const char = text[at]
      if (char === '\\' && at + 1 < text.length) {
        const next = text[at + 1]
        value += next === 'n' ? '\n' : next === 't' ? '\t' : next
        at += 2
        continue
      }
      if (char === quote) {
        at += 1
        break
      }
      value += char
      at += 1
    }
    this.at = at
    return value
  }

  /** Read `<path>`. */
  pathValue() {
    const text = this.text
    this.at += 1
    const end = text.indexOf('>', this.at)
    if (end < 0) {
      this.at = text.length
      return ''
    }
    const value = text.slice(this.at, end).trim()
    this.at = end + 1
    return value
  }

  /** Read an `@asset@` reference. */
  assetValue() {
    const text = this.text
    this.at += 1
    let value = ''
    while (this.at < text.length) {
      const char = text[this.at]
      if (char === '@') {
        if (text[this.at + 1] === '@') {
          value += '@'
          this.at += 2
          continue
        }
        this.at += 1
        return value
      }
      value += char
      this.at += 1
    }
    return value
  }

  /** Read a value, materialising it. */
  value() {
    this.skip()
    const char = this.text[this.at]
    if (char === undefined) return undefined
    if (char === '(') return this.tuple()
    if (char === '[') return this.array()
    if (char === '{') return this.dictionary()
    if (char === '"' || char === "'") return this.string()
    if (char === '<') return this.pathValue()
    if (char === '@') return this.assetValue()
    return this.atom()
  }

  /** Read a parenthesised tuple as an array of values. */
  tuple() {
    const out = []
    this.at += 1
    for (;;) {
      this.skip()
      const char = this.text[this.at]
      if (char === undefined) return out
      if (char === ')') {
        this.at += 1
        return out
      }
      if (char === ',') {
        this.at += 1
        continue
      }
      const before = this.at
      const value = this.value()
      if (value !== undefined) out.push(value)
      if (this.at === before) this.at += 1
    }
  }

  /** Read a bracketed array. */
  array() {
    const out = []
    this.at += 1
    for (;;) {
      this.skip()
      const char = this.text[this.at]
      if (char === undefined) return out
      if (char === ']') {
        this.at += 1
        return out
      }
      if (char === ',') {
        this.at += 1
        continue
      }
      const before = this.at
      const value = this.value()
      if (value !== undefined) out.push(value)
      if (this.at === before) this.at += 1
    }
  }

  /** Read a dictionary: keys to values, nested as written. */
  dictionary() {
    const out = {}
    this.at += 1
    for (;;) {
      this.skip()
      const char = this.text[this.at]
      if (char === undefined) return out
      if (char === '}') {
        this.at += 1
        return out
      }
      if (char === ',') {
        this.at += 1
        continue
      }
      const before = this.at
      const key = char === '"' || char === "'" ? this.string() : this.word()
      this.skip()
      if (this.text[this.at] === '=' || this.text[this.at] === ':') this.at += 1
      out[key] = this.value()
      if (this.at === before) this.at += 1
    }
  }

  /** Read a bare atom: number, boolean, None, or a token. */
  atom() {
    const raw = this.word()
    if (raw === '') return undefined
    if (raw === 'true') return true
    if (raw === 'false') return false
    if (raw === 'None' || raw === 'none' || raw === 'null') return null
    if (/^[-+]?(\d|\.\d)/.test(raw)) {
      const number = Number(raw)
      if (Number.isFinite(number)) return number
    }
    return raw
  }

  /** Skip one value without materialising it. */
  skipValue() {
    this.skip()
    const text = this.text
    const char = text[this.at]
    if (char === undefined) return
    if (char === '(') return this.skipBalanced('(', ')')
    if (char === '[') return this.skipBalanced('[', ']')
    if (char === '{') return this.skipBalanced('{', '}')
    if (char === '"' || char === "'") {
      this.string()
      return
    }
    if (char === '<') {
      const end = text.indexOf('>', this.at)
      this.at = end < 0 ? text.length : end + 1
      return
    }
    if (char === '@') {
      this.assetValue()
      return
    }
    const before = this.at
    this.word()
    if (this.at === before) this.at += 1
  }

  /** Skip a balanced block, honouring strings and comments inside it. */
  skipBalanced(open, close) {
    const text = this.text
    let depth = 0
    while (this.at < text.length) {
      const char = text[this.at]
      if (char === '"' || char === "'") {
        this.string()
        continue
      }
      if (char === '#' && open !== '"') {
        const end = text.indexOf('\n', this.at)
        this.at = end < 0 ? text.length : end + 1
        continue
      }
      if (char === open) depth += 1
      else if (char === close) {
        depth -= 1
        if (depth === 0) {
          this.at += 1
          return
        }
      }
      this.at += 1
    }
  }

  /** Consume an `[]` array type suffix when one is present. */
  arraySuffix() {
    this.skip()
    if (this.text[this.at] !== '[') return false
    let at = this.at + 1
    while (at < this.text.length && this.text[at] !== ']') at += 1
    this.at = at + 1
    return true
  }

  /**
   * Claim the modifiers banked since the last statement.
   *
   * `custom`, `uniform` and friends are read before the reader knows whether the
   * statement is an attribute, a relationship or a metadata key — so they are
   * banked and consumed by whichever of those comes next.
   * @returns an object with the modifiers that applied, or undefined for none.
   */
  takeModifiers() {
    if (this.modifiers.length === 0) return undefined
    const flags = {}
    for (const modifier of this.modifiers) flags[modifier] = true
    this.modifiers = []
    return flags
  }

  /** Read one layer: header, layer metadata, then the prim tree. */
  read() {
    this.skip()
    if (this.text.startsWith('#usda', this.at)) {
      const end = this.text.indexOf('\n', this.at)
      this.at = end < 0 ? this.text.length : end + 1
    }
    // The header block is layer metadata (`metersPerUnit`, `defaultPrim`, …).
    this.skip()
    if (this.text[this.at] === '(') {
      this.layerMetadata()
      this.skip()
    }
    this.body('', undefined)
    return this.prims
  }

  /** Read the layer header: same shape as a prim's metadata, kept per key. */
  layerMetadata() {
    this.at += 1
    for (;;) {
      this.skip()
      if (this.at >= this.text.length) return
      const char = this.text[this.at]
      if (char === ')') {
        this.at += 1
        return
      }
      if (char === ',' || char === ';') {
        this.at += 1
        continue
      }
      const before = this.at
      const word = this.word()
      if (word === '') {
        this.at += 1
        if (this.at === before) return
        continue
      }
      if (MODIFIERS.has(word)) continue
      this.metadataValue(this.meta, word, KEPT_LAYER_METADATA.has(word))
    }
  }

  /** Read prims and attributes until the current block closes (or the file ends). */
  body(parentPath, prim) {
    for (;;) {
      this.skip()
      const text = this.text
      if (this.at >= text.length) return
      const char = text[this.at]
      if (char === '}') {
        this.at += 1
        return
      }
      if (char === '(') {
        this.primMetadata(prim)
        continue
      }
      if (char === ';' || char === ',') {
        this.at += 1
        continue
      }
      if (char === '"' || char === "'") {
        // A bare string is metadata this reader does not model.
        this.string()
        continue
      }
      const before = this.at
      const word = this.word()
      if (word === '') {
        this.at += 1
        continue
      }
      if (word === 'def' || word === 'over' || word === 'class') {
        this.prim(word, parentPath)
        continue
      }
      // `variantSet "name" = { … }` declares a variant set, which USD spells with
      // a bare `variantSet` keyword (not an assignment) and a quoted name.
      if (word === 'variantSet' || word === 'variantSets') {
        this.variantSet(prim)
        continue
      }
      if (MODIFIERS.has(word)) {
        this.modifiers.push(word)
        continue
      }
      if (word === 'rel') {
        this.relationship(prim)
        continue
      }
      if (METADATA_KEYS.has(word)) {
        this.metadataValue(prim?.meta, word, prim !== undefined && KEPT_PRIM_METADATA.has(word))
        if (word === 'apiSchemas' && prim !== undefined) {
          const schemas = prim.meta.__apiSchemas
          if (Array.isArray(schemas)) {
            for (const entry of schemas) {
              if (typeof entry === 'string' && entry !== '' && !prim.apiSchemas.includes(entry)) prim.apiSchemas.push(entry)
            }
            delete prim.meta.__apiSchemas
          }
        }
        continue
      }
      this.attribute(prim, word)
      if (this.at === before) this.at += 1
    }
  }

  /**
   * Read one metadata statement into `into`.
   *
   * A metadata statement has no `;` terminator, so its value is exactly one
   * value — which is why the ordinary value parser is exact for every USD
   * metadata form (`kind = "component"`, `customData = {…}`, `references = @…@`).
   * @param into - the record to write into (a prim's `meta` or the layer's).
   * @param key - the metadata key just read.
   * @param keep - whether the value is wanted; otherwise it is only consumed.
   */
  metadataValue(into, key, keep) {
    this.modifiers = []
    this.skip()
    if (this.text[this.at] !== '=') {
      // Not an assignment: consume whatever follows rather than misreading it as
      // an attribute of the next statement.
      this.skipValue()
      return
    }
    this.at += 1
    // A reference or a payload is read by its own parser, before the generic one
    // turns "@./x.usda@" into a bare asset path and loses the list op and the prim
    // path beside it.
    if (ARC_KEYS.has(key) === true) {
      const arcs = this.arcValue()
      if (into !== undefined && into !== null && arcs.length > 0) into[key] = arcs
      return
    }
    // A variant selection is a dictionary of set to authored variant — the
    // generic dictionary reader would take its optional type annotation
    // ("string") for a key, so it is read by its own parser.
    if (key === 'variants') {
      const selection = this.variantSelectionMap()
      if (into !== undefined && into !== null && Object.keys(selection).length > 0) into.variants = selection
      return
    }
    const value = this.value()
    if (into === undefined || into === null) return
    if (key === 'variantSets' && Array.isArray(value)) {
      const sets = into.variantSets ?? (into.variantSets = [])
      for (const entry of value) if (typeof entry === 'string' && entry !== '') sets.push(entry)
      return
    }
    if (key === 'apiSchemas') {
      into.__apiSchemas = Array.isArray(value) ? value : []
      return
    }
    if (key === 'inherits' || key === 'specializes') {
      const list = Array.isArray(value) ? value : [value]
      const paths = list.filter(entry => typeof entry === 'string' && entry.startsWith('/'))
      if (paths.length > 0) into[key] = paths
      return
    }
    if (keep === true) into[key] = value
  }

  /**
   * Read a `references` / `payload` value as the arcs it declares.
   *
   * USD spells an arc in four shapes, and all four appear in real files:
   *
   *   references = @./body.usda@                       one asset, no prim path
   *   references = @./body.usda@</Arm>                 one asset, one prim path
   *   references = [@./a.usda@, @./b.usda@</X>]        a list of assets
   *   references = [
   *       @./body.usda@ (offset = 2; scale = 4)        an asset with arc metadata
   *   ]
   *
   * The generic value parser handles the first two by accident and the last two not
   * at all, which is why this reads the form directly: one asset path, an optional
   * `<primPath>`, and an optional `(…)` metadata block that is skipped whole.
   * The cursor is left after the last thing read, so the caller's loop resumes at the
   * same place the generic parser would have left it.
   * @returns the arcs, each `{ asset, prim }`; `prim` is undefined when the arc
   *   names none (it then composes the referenced layer's `defaultPrim`).
   */
  arcValue() {
    this.skip()
    const arcs = []
    const readOne = () => {
      this.skip()
      if (this.text[this.at] !== '@') return false
      const asset = this.assetValue()
      let prim
      this.skip()
      if (this.text[this.at] === '<') {
        prim = this.pathValue()
        if (prim !== undefined && prim.startsWith('/') === false) prim = undefined
      }
      this.skip()
      if (this.text[this.at] === '(') this.skipBalanced('(', ')')
      if (asset === '') return false
      arcs.push({ asset, prim })
      return true
    }
    this.skip()
    if (this.text[this.at] === '[') {
      this.at += 1
      for (;;) {
        this.skip()
        const char = this.text[this.at]
        if (char === undefined) break
        if (char === ']') {
          this.at += 1
          break
        }
        if (char === ',') {
          this.at += 1
          continue
        }
        const before = this.at
        if (readOne() === false && this.at === before) this.at += 1
      }
      return arcs
    }
    readOne()
    return arcs
  }

  /** Read a prim header and body, registering the prim under its absolute path. */
  prim(specifier, parentPath) {
    this.skip()
    let type = ''
    let name = ''
    const char = this.text[this.at]
    if (char === '"' || char === "'") {
      name = this.string()
    } else {
      type = this.word()
      this.skip()
      const after = this.text[this.at]
      if (after === '"' || after === "'") name = this.string()
    }
    if (name === '') name = type === '' ? 'Prim' : type
    const path = parentPath === '' ? '/' + name : parentPath + '/' + name
    const prim = newPrim(path, type, specifier, this.text)
    this.modifiers = []
    this.skip()
    if (this.text[this.at] === '(') this.primMetadata(prim)
    this.skip()
    if (this.text[this.at] === '{') {
      this.at += 1
      this.body(path, prim)
    }
    const existing = this.prims.get(path)
    if (existing === undefined) this.prims.set(path, prim)
    else mergePrim(existing, prim, specifier)
  }

  /** Read prim metadata: `apiSchemas` and the kept keys, everything else consumed. */
  primMetadata(prim) {
    this.at += 1
    for (;;) {
      this.skip()
      if (this.at >= this.text.length) return
      const char = this.text[this.at]
      if (char === ')') {
        this.at += 1
        return
      }
      if (char === ',' || char === ';') {
        this.at += 1
        continue
      }
      if (char === '(' || char === '{' || char === '[') {
        this.skipValue()
        continue
      }
      const before = this.at
      const word = this.word()
      if (word === '') {
        this.at += 1
        if (this.at === before) return
        continue
      }
      if (MODIFIERS.has(word)) continue
      this.metadataValue(prim?.meta, word, prim !== undefined && KEPT_PRIM_METADATA.has(word))
      if (word === 'apiSchemas' && prim !== undefined) {
        const schemas = prim.meta.__apiSchemas
        if (Array.isArray(schemas)) {
          for (const entry of schemas) {
            if (typeof entry === 'string' && entry !== '' && !prim.apiSchemas.includes(entry)) prim.apiSchemas.push(entry)
          }
          delete prim.meta.__apiSchemas
        }
      }
    }
  }

  /**
   * Read a `variantSet` block: its name and the variant names it declares.
   *
   * The variants themselves are composed (the engine resolves them), but the
   * *names* are the arc's shape and are what a composition reader shows: a set
   * with no visible variants and a set of four cannot be told apart otherwise.
   * The block's contents are skipped as balanced braces, so a variant's own
   * prims and nested variant sets never disturb the outer scan.
   * @param prim - the prim the set is declared under, or undefined before the first prim.
   */
  variantSet(prim) {
    this.skip()
    const name = this.text[this.at] === '"' || this.text[this.at] === "'" ? this.string() : this.word()
    this.skip()
    if (this.text[this.at] === '=') this.at += 1
    this.skip()
    let variants
    if (this.text[this.at] === '{') variants = this.variantNames()
    else this.skipValue()
    if (prim !== undefined && typeof name === 'string' && name !== '') {
      const sets = prim.meta.variantSets ?? (prim.meta.variantSets = [])
      if (!sets.includes(name)) sets.push(name)
      if (Array.isArray(variants) && variants.length > 0) {
        const declared = prim.meta.variantNames ?? (prim.meta.variantNames = {})
        const known = declared[name] ?? (declared[name] = [])
        for (const variant of variants) if (!known.includes(variant)) known.push(variant)
      }
    }
    this.modifiers = []
  }

  /**
   * Read a `variants` metadata value: set to authored variant, as a map.
   *
   * USD spells it as a dictionary whose keys carry an explicit type annotation —
   * `{ string modeling = "simple" string look = "red" }` — which is why the
   * generic dictionary parser is not used here: it would store "string" as the
   * first key.
   * @returns the selection map, empty when the value is not a dictionary.
   */
  variantSelectionMap() {
    this.skip()
    const out = {}
    if (this.text[this.at] !== '{') {
      this.skipValue()
      return out
    }
    this.at += 1
    for (;;) {
      this.skip()
      const char = this.text[this.at]
      if (char === undefined) return out
      if (char === '}') {
        this.at += 1
        return out
      }
      if (char === ',' || char === ';') {
        this.at += 1
        continue
      }
      const before = this.at
      let key = this.text[this.at] === '"' || this.text[this.at] === "'" ? this.string() : this.word()
      // The optional type annotation sits between the brace and the first key of
      // each entry (`string` for a selection map).
      if (key === 'string' || key === 'token') {
        this.skip()
        key = this.text[this.at] === '"' || this.text[this.at] === "'" ? this.string() : this.word()
      }
      this.skip()
      if (this.text[this.at] === '=' || this.text[this.at] === ':') this.at += 1
      this.skip()
      let value
      if (this.text[this.at] === '"' || this.text[this.at] === "'") value = this.string()
      else {
        value = this.word()
        if (value === '') value = undefined
      }
      if (typeof key === 'string' && key !== '' && typeof value === 'string' && value !== '') out[key] = value
      if (this.at === before) this.at += 1
    }
  }

  /**
   * Read the names a `variantSet` block declares, consuming the block.
   *
   * A variant name is a quoted string followed by its own block (and optionally
   * a metadata block); each is skipped whole, so only depth-one names are
   * collected. Anything unexpected is skipped rather than misread as a name —
   * a malformed block must cost the variant list, not the rest of the layer.
   * @returns the variant names in authored order.
   */
  variantNames() {
    const names = []
    this.at += 1
    for (;;) {
      this.skip()
      const char = this.text[this.at]
      if (char === undefined) return names
      if (char === '}') {
        this.at += 1
        return names
      }
      if (char === ',' || char === ';') {
        this.at += 1
        continue
      }
      const before = this.at
      if (char === '"' || char === "'") {
        const name = this.string()
        if (name !== '' && !names.includes(name)) names.push(name)
        this.skip()
        if (this.text[this.at] === '(') this.skipBalanced('(', ')')
        this.skip()
        if (this.text[this.at] === '{') this.skipBalanced('{', '}')
        else this.skipValue()
        continue
      }
      // Anything else inside a variant set is not a variant declaration; the
      // generic value skipper keeps the scan inside the brace.
      this.skipValue()
      if (this.at === before) this.at += 1
    }
  }

  /** Read a relationship: `rel name = <path>` or a list of paths. */
  relationship(prim) {
    const flags = this.takeModifiers()
    void flags
    this.skip()
    const name = this.word()
    this.skip()
    if (this.text[this.at] !== '=') {
      this.skipValue()
      return
    }
    this.at += 1
    const value = this.value()
    if (prim === undefined || name === '') return
    const targets = []
    const collect = (entry) => {
      if (typeof entry === 'string' && entry.startsWith('/')) targets.push(entry)
    }
    if (Array.isArray(value)) value.forEach(collect)
    else collect(value)
    prim.rels[name] = targets
  }

  /**
   * Read an attribute statement. The type token has already been consumed;
   * `type` is empty for a `custom`/`uniform` form where the word read was a
   * modifier rather than a type.
   */
  attribute(prim, type) {
    this.skip()
    const array = this.arraySuffix()
    this.skip()
    const name = this.word()
    this.skip()
    const declaredType = array ? `${type}[]` : type
    if (this.text[this.at] !== '=') {
      // A declared-but-unset attribute (`uniform token outputs:surface`, which is
      // how a Shader declares its output): the statement ends here. Skipping a
      // value would walk past the prim's closing brace and land every following
      // prim inside this one — the failure mode that read a stage's second mesh as
      // a child of its material.
      if (prim !== undefined && name !== '') {
        const flags = this.takeModifiers()
        prim.attrTypes[name] = declaredType === '' ? 'token' : declaredType
        if (flags !== undefined) prim.attrFlags[name] = flags
      } else {
        this.modifiers = []
      }
      return
    }
    this.at += 1
    if (prim === undefined || name === '') {
      this.skipValue()
      return
    }
    this.attributeValue(prim, name, declaredType)
  }

  /**
   * Record one attribute: value only when asked for, span and declared type
   * always, so a later reader can parse the value without re-scanning the layer.
   *
   * With `arrayHead` set and an array longer than it, the value is summarised:
   * its length goes to `arraySizes` and `attrs` keeps only the head. The count is
   * exact — it comes from the commas at depth 1, so a tuple element's own commas
   * (depth 2) do not count — and no element past the head is ever parsed.
   */
  attributeValue(prim, name, declaredType) {
    const flags = this.takeModifiers()
    const start = this.at
    if (this.arrayHead > 0 && declaredType.endsWith('[]') === true && this.arrayLength() > this.arrayHead) {
      const summary = this.arrayHeadAndLength()
      prim.spans[name] = [start, this.at]
      if (declaredType !== '') prim.attrTypes[name] = declaredType
      if (flags !== undefined) prim.attrFlags[name] = flags
      if (summary === undefined) return
      prim.attrs[name] = summary.head
      prim.arraySizes[name] = summary.length
      return
    }
    if (this.keep(name, declaredType) === true) prim.attrs[name] = this.value()
    else this.skipValue()
    prim.spans[name] = [start, this.at]
    if (declaredType !== '') prim.attrTypes[name] = declaredType
    if (flags !== undefined) prim.attrFlags[name] = flags
  }

  /**
   * Count the elements of the array at the cursor without parsing them.
   *
   * An element is one comma-separated slot at depth 1; a tuple element's own
   * commas sit at depth 2 and so do not count. `[]` is zero elements and `[a]` is
   * one, which is what `[](,)+` alone would get wrong.
   * @returns the element count, or 0 when the cursor is not on an array.
   */
  arrayLength() {
    const text = this.text
    let at = this.at
    while (at < text.length && /\s/.test(text[at]) === true) at += 1
    if (text[at] !== '[') return 0
    let depth = 0
    let commas = 0
    let content = false
    while (at < text.length) {
      const char = text[at]
      if (char === '"' || char === "'") {
        content = content || depth === 1
        at += 1
        while (at < text.length && text[at] !== char) {
          if (text[at] === '\\') at += 1
          at += 1
        }
      } else if (char === '#' || (char === '/' && text[at + 1] === '/')) {
        const end = text.indexOf('\n', at)
        at = end < 0 ? text.length : end
        continue
      } else if (char === '/' && text[at + 1] === '*') {
        const end = text.indexOf('*/', at + 2)
        at = end < 0 ? text.length : end + 1
      } else if (char === '[' || char === '(') {
        depth += 1
        if (depth > 1) content = true
      } else if (char === ']' || char === ')') {
        depth -= 1
        if (depth === 0) break
      } else if (depth === 1) {
        if (char === ',') commas += 1
        else if (/\s/.test(char) === false) content = true
      }
      at += 1
    }
    if (content === false) return 0
    return commas + 1
  }

  /**
   * Parse only the head of a long array, plus its true length.
   *
   * The cursor must be on the opening bracket; it ends just past the closing one.
   * @returns `{ length, head }`, or undefined when the array cannot be read.
   */
  arrayHeadAndLength() {
    const length = this.arrayLength()
    const saved = this.at
    this.skip()
    let head = []
    if (this.text[this.at] === '[') {
      this.at += 1
      while (head.length < this.arrayHead) {
        this.skip()
        if (this.at >= this.text.length || this.text[this.at] === ']') break
        if (this.text[this.at] === ',') {
          this.at += 1
          continue
        }
        const before = this.at
        const value = this.value()
        if (value !== undefined) head.push(value)
        if (this.at === before) this.at += 1
      }
    }
    // Walk to the end of the array from where the head parse stopped.
    this.at = saved
    this.skipValue()
    return { length, head }
  }
}

/** Merge a later spec of the same prim path into the earlier one. */
export function mergePrim(into, from, specifier) {
  if (specifier !== 'over' && into.type === '' && from.type !== '') into.type = from.type
  for (const schema of from.apiSchemas) {
    if (!into.apiSchemas.includes(schema)) into.apiSchemas.push(schema)
  }
  for (const key of Object.keys(from.attrs)) {
    if (into.attrs[key] === undefined) into.attrs[key] = from.attrs[key]
  }
  for (const key of Object.keys(from.attrTypes)) {
    if (into.attrTypes[key] === undefined) into.attrTypes[key] = from.attrTypes[key]
  }
  for (const key of Object.keys(from.attrFlags)) {
    if (into.attrFlags[key] === undefined) into.attrFlags[key] = from.attrFlags[key]
  }
  for (const key of Object.keys(from.rels)) {
    if (into.rels[key] === undefined) into.rels[key] = from.rels[key]
  }
  for (const key of Object.keys(from.spans)) {
    if (into.spans[key] === undefined) into.spans[key] = from.spans[key]
  }
  for (const key of Object.keys(from.arraySizes)) {
    if (into.arraySizes[key] === undefined) into.arraySizes[key] = from.arraySizes[key]
  }
  for (const key of Object.keys(from.meta)) {
    if (key === 'variantSets') {
      for (const set of from.meta.variantSets) {
        if (!into.meta.variantSets.includes(set)) into.meta.variantSets.push(set)
      }
      continue
    }
    // Declared variant names are facts about the arc, so every layer's
    // declarations are kept rather than only the strongest layer's: a weaker
    // layer naming a variant the stronger one forgot is still part of the
    // composition, and dropping it would make the panel claim a set is empty.
    if (key === 'variantNames') {
      const intoNames = into.meta.variantNames ?? (into.meta.variantNames = {})
      for (const [set, names] of Object.entries(from.meta.variantNames)) {
        const known = intoNames[set] ?? (intoNames[set] = [])
        for (const name of names) if (!known.includes(name)) known.push(name)
      }
      continue
    }
    if (into.meta[key] === undefined) into.meta[key] = from.meta[key]
  }
}

/**
 * Read one attribute value out of a layer, given the prim that recorded its span.
 *
 * The span is what lets a details panel show a 300k-point array's size without
 * ever materialising it: the caller decides, per attribute, whether to parse.
 * @param reader - a reader positioned anywhere; only `at` is used.
 * @param span - `[start, end]` as recorded in `prim.spans`.
 * @returns the parsed value, or undefined when the span is unusable.
 */
export function valueAtSpan(reader, span) {
  if (!Array.isArray(span) || span.length < 2) return undefined
  const saved = reader.at
  reader.at = span[0]
  const value = reader.value()
  reader.at = saved
  return value
}
