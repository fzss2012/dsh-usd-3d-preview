/**
 * Serialise an already-decoded layer record back to readable USDA source.
 *
 * ## Why this module exists
 *
 * The Text mode shows an ASCII layer's authored bytes verbatim: those bytes
 * *are* the source, so showing them is the honest answer. A crate layer
 * (.usdc, and the crate payload inside a .usdz) has no text to show — it is a
 * binary spec table — so the only truthful thing a text view can offer is a
 * reconstruction labelled as one. The records this plugin already decodes
 * (layer-text.js for ASCII, details.js for crates) carry everything shown here;
 * this module writes that same information back out in USDA's vocabulary instead
 * of inventing a second one.
 *
 * ## The honesty contract
 *
 * What comes out is a **reconstruction, not the authored source**, and the caller
 * is expected to label it as such (options.headerComment is where that label
 * goes — as comments after the magic line, because OpenUSD's parser requires
 * '#usda 1.0' to be line 1 and rejects a layer whose first line is a comment).
 * It cannot be otherwise: a decoded record keeps values and composition
 * arcs, but not the file's comments, whitespace, list-op ordering, time samples,
 * variant bodies, connect/spline relationship forms, or the order in which fields
 * were written. Rendering therefore loses information in both directions — some
 * authored statements cannot be written because the record dropped them, and some
 * written statements are canonicalisations ('bool' becomes true/false, arcs become
 * prepend) rather than what the file actually typed.
 *
 * ## The trade-offs this file makes
 *
 * - The prim tree is rebuilt from **path prefixes and insertion order**, not from
 *   the file's brace nesting — the record does not keep nesting, and a layer's
 *   insertion order is what a reader expects anyway (a parent is recorded before
 *   its children). A prim whose parent is not in the record is reported as a
 *   comment instead of being re-rooted, because re-rooting would silently change
 *   its identity; a path segment that names a variant selection
 *   (/root{modeling=simple}) cannot be spelled as a prim name at all and is
 *   skipped with a comment rather than emitted as nonsense.
 * - Composition arcs are written as prepend. The record keeps the resolved list of
 *   references/payloads, not which list op produced it, so prepend is the one
 *   spelling that preserves the list the record holds.
 * - An **empty relationship is omitted**: the reader records [] for a rel it saw
 *   but parsed no target paths from, and there is no safe way to spell "this
 *   relationship exists but has no targets" — 'rel name = []' is not a form USD
 *   text defines for relationships, and a bare 'rel name' would claim an authored
 *   declaration the record does not distinguish from a parse failure. Omitting it
 *   loses nothing a reader can act on.
 * - Values are formatted from the **declared type** when the record has one
 *   (details.js always does for a crate). A record without one gets a type
 *   inferred from the JavaScript value so the line stays parseable; that is a
 *   fallback, not a claim about the authored type.
 * - Every statement has to parse in **OpenUSD**, not only in this project's reader:
 *   modifiers are written custom-before-uniform (the reverse order is rejected by
 *   USD's parser), non-finite doubles are spelled inf / -inf / nan, and a
 *   customData dictionary entry carries an inferred value type because USD rejects
 *   an untyped entry. The record no longer holds the authored types, so these are
 *   documented inferences; a value a dictionary cannot hold (None) is written as a
 *   comment inside the block.
 * - The record may arrive already abbreviated: details.js cuts a long array to
 *   its first elements before this module ever sees it. What gets written is then
 *   a head, not the whole array, which is why the caller's label has to say so
 *   (the crate Text view does).
 * - Rendering must never throw: the Text mode is a viewer, and a value it cannot
 *   format degrades to String(value) or a comment rather than blanking the panel.
 *   Output is bounded by options.maxChars, and a cut rendering ends with an
 *   explicit truncation comment.
 *
 * Deliberately does not: compose layers, evaluate variants, resolve asset paths,
 * re-create comments, re-time-sample attributes, or write files. Crate values are
 * reconstructed from the same record the details panel reads, so a reader can
 * check the text view against the details panel and see one answer.
 *
 * @module dsh-usd-3d-preview/usda-text
 */
import { elementWidthOf } from './details.js'

/** Four spaces per depth: the indent the layers in this repository author. */
const INDENT = '    '

/** The line every USDA text layer starts with. */
const LAYER_HEADER = '#usda 1.0'

/** Appended as its own comment line when maxChars cuts the rendering short. */
const TRUNCATION_MARKER = '# … output truncated'

/** Output ceiling used when the caller names none: large enough for any panel view. */
const DEFAULT_MAX_CHARS = 2_000_000

/** Declared USD types whose values are whole numbers. */
const INTEGER_TYPES = new Set([
  'char', 'uchar', 'short', 'ushort', 'int', 'uint', 'long', 'ulong',
  'int8', 'uint8', 'int16', 'uint16', 'int32', 'uint32', 'int64', 'uint64',
])

/** Declared USD types whose values are decimal numbers. */
const FLOAT_TYPES = new Set(['half', 'float', 'double', 'timecode'])

/**
 * Integer bounds a typed customData entry has to respect.
 *
 * The dictionary grammar needs a value type, and OpenUSD rejects an out-of-range
 * integer literal, so an inferred "whole number" entry picks int/int64/uint64 by
 * the value's own magnitude. The BigInt forms are the exact comparisons; the
 * Number constants are only for the decimal spelling.
 */
const BIGINT32_MIN = BigInt('-2147483648')
const BIGINT32_MAX = BigInt('2147483647')
const BIGINT64_MIN = BigInt('-9223372036854775808')
const BIGINT64_MAX = BigInt('9223372036854775807')
const BIGINT64_UINT_MAX = BigInt('18446744073709551615')

/** Dictionary keys safe to write bare; anything else is quoted. */
const BARE_KEY = /^[A-Za-z_][A-Za-z0-9_:.]*$/

/** The two characters quoteString has to escape, named once rather than as literals. */
const BACKSLASH = String.fromCharCode(92)
const DOUBLE_QUOTE = '"'

// ── scalar formatting ───────────────────────────────────────────────────────

/** Whether a value is an array-like list rather than one value. */
function isListLike(value) {
  return Array.isArray(value) || ArrayBuffer.isView(value)
}

/** Whether a value is a plain record (a dictionary), not a list or array view. */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && isListLike(value) === false
}

/** Whether a declared type is an integer type. */
function isIntegerType(base) {
  return INTEGER_TYPES.has(base)
}

/** Whether a declared type is a decimal type. */
function isFloatType(base) {
  return FLOAT_TYPES.has(base)
}

/**
 * How many scalar components a fixed-width type has.
 *
 * elementWidthOf already knows the vector types (point3f is 3, quatd is 4); a
 * matrix is the one shape it treats as a single value, while text spells it as
 * its row-major components, so its width is recovered here.
 * @param base - a USD type name without the [] suffix.
 * @returns the component count, 1 for a scalar.
 */
function componentWidth(base) {
  if (typeof base !== 'string' || base === '') return 1
  if (base.startsWith('matrix') === true) {
    const match = /^matrix([234])d$/.exec(base)
    return match === null ? 16 : Number(match[1]) ** 2
  }
  return elementWidthOf(base)
}

/**
 * Format one number the way a decoded value should read back: integers stay
 * integer-looking and decimal noise is cut to six significant digits.
 *
 * Six digits is the same rule the details panel uses; it is what turns a float32's
 * 0.10000000149 into the authored 0.1. Negative zero is kept because it is a real
 * authored value in transform stacks.
 * @param value - the number.
 * @returns its USDA spelling, with inf / -inf / nan for the non-finite doubles.
 */
function formatNumber(value) {
  if (typeof value !== 'number') return formatFallback(value)
  if (Object.is(value, -0) === true) return '-0'
  // USDA's parser reads inf / -inf / nan; JavaScript's spellings would turn a
  // declared number into a token and make the statement invalid for usdcat.
  if (Number.isFinite(value) === false) return Number.isNaN(value) === true ? 'nan' : value > 0 ? 'inf' : '-inf'
  if (Number.isInteger(value) === true) return String(value)
  return String(Number(value.toPrecision(6)))
}

/**
 * Quote a string for USDA, escaping what the reader's lexer unescapes.
 *
 * Backslash and double quote are the two characters that would otherwise end or
 * corrupt the literal; newlines and tabs get the reader-supported escapes. Other
 * control characters are left as written — the record cannot tell an authored
 * control character from a decoding artefact, and inventing an escape the reader
 * does not understand would change the value.
 * @param value - the value to quote.
 * @returns the double-quoted literal.
 */
function quoteString(value) {
  const text = typeof value === 'string' ? value : String(value)
  let quoted = DOUBLE_QUOTE
  for (const char of text) {
    if (char === BACKSLASH) quoted += BACKSLASH + BACKSLASH
    else if (char === DOUBLE_QUOTE) quoted += BACKSLASH + DOUBLE_QUOTE
    else if (char === '\n') quoted += BACKSLASH + 'n'
    else if (char === '\t') quoted += BACKSLASH + 't'
    else quoted += char
  }
  return quoted + DOUBLE_QUOTE
}

/**
 * Spell an asset path as @…@, doubling an embedded @ the way USD escapes it.
 * @param value - the asset path.
 * @returns the asset literal.
 */
function quoteAsset(value) {
  const text = typeof value === 'string' ? value : String(value)
  return '@' + text.split('@').join('@@') + '@'
}

/** Format a dictionary key: bare when it is a plain identifier, quoted otherwise. */
function formatKey(key) {
  const text = typeof key === 'string' ? key : String(key)
  return BARE_KEY.test(text) === true ? text : quoteString(text)
}

/** Format a boolean from a decoded value (ASCII authors bool as 1/0). */
function formatBool(value) {
  if (typeof value === 'boolean') return value === true ? 'true' : 'false'
  if (typeof value === 'number') return value === 0 ? 'false' : 'true'
  if (typeof value === 'string') return value === 'false' || value === '0' ? 'false' : 'true'
  return Boolean(value) === true ? 'true' : 'false'
}

/** Format an integer from a decoded value; a fractional value is truncated. */
function formatInteger(value) {
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'boolean') return value === true ? '1' : '0'
  if (typeof value === 'number') {
    // A whole number at this magnitude prints in exponent form ("1e+21"), which is
    // a valid float but not a valid integer literal; BigInt gives decimal digits.
    if (Number.isFinite(value) === false) return '0'
    const whole = Math.trunc(value)
    try {
      return BigInt(whole).toString()
    } catch {
      return String(whole)
    }
  }
  return String(value)
}

// ── value formatting ────────────────────────────────────────────────────────

/** Format one component of a tuple: numbers, strings, nested lists or dictionaries. */
function formatComponent(value) {
  if (value === null || value === undefined) return 'None'
  if (typeof value === 'number') return formatNumber(value)
  if (typeof value === 'boolean') return value === true ? 'true' : 'false'
  if (typeof value === 'string') return quoteString(value)
  if (isListLike(value) === true) return formatTuple(Array.from(value))
  if (typeof value === 'object') return formatDictionaryInline(value)
  return String(value)
}

/** Format a parenthesised tuple: (a, b, c). */
function formatTuple(components) {
  return '(' + components.map(formatComponent).join(', ') + ')'
}

/**
 * Format a dictionary the way an attribute value spells it: { key = value, … }.
 *
 * This is the inline form the decoded-record contract asks for. OpenUSD itself
 * has no dictionary *attribute* value type (usdcat rejects the declaration), so a
 * real layer never reaches this path; it exists so a hand-built or partial record
 * still renders the form its contract names.
 */
function formatDictionaryInline(value) {
  if (isPlainObject(value) === false) return formatFallback(value)
  const keys = Object.keys(value)
  if (keys.length === 0) return '{}'
  return '{ ' + keys.map(key => formatKey(key) + ' = ' + formatDictionaryScalar(value[key])).join(', ') + ' }'
}

/** Format one dictionary entry's value: nested dictionaries stay dictionaries. */
function formatDictionaryScalar(value) {
  if (value === undefined) return 'None'
  if (value === null) return 'None'
  if (isListLike(value) === true) return formatFallback(value)
  if (isPlainObject(value) === true) return formatDictionaryInline(value)
  return formatFallback(value)
}

/**
 * Format a value whose declared type says nothing useful: take the JavaScript
 * shape, because guessing a USD type that the record does not carry would be a
 * claim about the file rather than a reading of it.
 * @param value - the decoded value.
 * @returns a parseable best-effort spelling.
 */
function formatFallback(value) {
  try {
    if (value === undefined) return ''
    if (value === null) return 'None'
    if (typeof value === 'boolean') return value === true ? 'true' : 'false'
    if (typeof value === 'number') return formatNumber(value)
    if (typeof value === 'string') return quoteString(value)
    if (isListLike(value) === true) return '[' + Array.from(value).map(entry => formatFallback(entry)).join(', ') + ']'
    if (isPlainObject(value) === true) return formatDictionaryInline(value)
    return String(value)
  } catch {
    // A value this renderer cannot describe must not take the whole text view
    // down with it; None is the one spelling every USD type accepts.
    return 'None'
  }
}

/** Format a list of scalars, regrouping a flat typed array into its declared elements. */
function formatList(value, base) {
  const entries = isListLike(value) === true ? Array.from(value) : [value]
  if (base.endsWith('[]') === true) return '[' + entries.map(entry => formatValue(entry, base)).join(', ') + ']'
  const width = componentWidth(base)
  if (width > 1) {
    if (entries.length > 0 && entries.every(entry => isListLike(entry))) {
      return '[' + entries.map(entry => formatTuple(Array.from(entry))).join(', ') + ']'
    }
    const flat = entries.length > 0 && entries.every(entry => typeof entry === 'number' || typeof entry === 'boolean')
    if (flat === true) {
      const elements = []
      for (let at = 0; at < entries.length; at += width) elements.push(formatTuple(entries.slice(at, at + width)))
      return '[' + elements.join(', ') + ']'
    }
    return '[' + entries.map(entry => formatTuple(isListLike(entry) === true ? Array.from(entry) : [entry])).join(', ') + ']'
  }
  return '[' + entries.map(entry => formatSingle(entry, base)).join(', ') + ']'
}

/**
 * Format a value whose declared type is a fixed-width numeric type (a vector, a
 * quaternion, a matrix) or a tuple-shaped array received for one.
 *
 * A crate keeps point3f[] as one flat Float32Array; the width comes from the
 * declared type, which is what lets the elements be regrouped here without the
 * crate decoder having to guess.
 */
function formatFixedWidth(value, width) {
  const entries = isListLike(value) === true ? Array.from(value) : [value]
  if (entries.length > 0 && entries.every(entry => isListLike(entry))) {
    return '[' + entries.map(entry => formatTuple(Array.from(entry))).join(', ') + ']'
  }
  if (entries.length === width) return formatTuple(entries)
  if (entries.length > width && entries.length % width === 0) {
    const elements = []
    for (let at = 0; at < entries.length; at += width) elements.push(formatTuple(entries.slice(at, at + width)))
    return '[' + elements.join(', ') + ']'
  }
  // Not a shape the declared type explains; keep every component rather than
  // dropping values the record carries.
  return formatTuple(entries)
}

/** Format one value of a non-list declared type. */
function formatSingle(value, base) {
  if (base === 'bool') return formatBool(value)
  if (base === 'string' || base === 'token') return quoteString(value)
  if (base === 'asset') return quoteAsset(value)
  if (base === 'dictionary') return formatDictionaryInline(value)
  if (isIntegerType(base) === true) return formatInteger(value)
  if (isFloatType(base) === true) return formatNumber(value)
  const width = componentWidth(base)
  if (width > 1) return formatFixedWidth(value, width)
  return formatFallback(value)
}

/** Format one value by its declared type; never throws. */
function formatValue(value, declaredType) {
  try {
    if (value === undefined) return ''
    if (value === null) return 'None'
    const type = typeof declaredType === 'string' ? declaredType : ''
    const list = type.endsWith('[]') === true
    const base = list === true ? type.slice(0, -2) : type
    return list === true ? formatList(value, base) : formatSingle(value, base)
  } catch {
    return formatFallback(value)
  }
}

/**
 * Infer a declared type for a record that did not carry one.
 *
 * Every record this plugin decodes does carry attrTypes; this fallback exists so
 * a hand-built or partial record still renders a parseable line instead of a
 * type-less statement. 'string' covers tokens and assets too — the one thing a
 * JavaScript string cannot tell us is which of USD's three string-like types it
 * was.
 * @param value - the decoded value.
 * @returns a usable USD type name.
 */
function inferDeclaredType(value) {
  if (typeof value === 'boolean') return 'bool'
  if (typeof value === 'number') return Number.isInteger(value) === true ? 'int' : 'float'
  if (typeof value === 'string') return 'string'
  if (value === null || value === undefined) return 'string'
  if (isListLike(value) === true) {
    const entries = Array.from(value)
    if (entries.length === 0) return 'float[]'
    if (entries.every(entry => isListLike(entry))) {
      const inner = Array.from(entries[0])
      const width = inner.length >= 2 && inner.length <= 4 ? inner.length : ''
      return 'float' + width + '[]'
    }
    if (entries.every(entry => typeof entry === 'string')) return 'string[]'
    if (entries.every(entry => typeof entry === 'boolean')) return 'bool[]'
    return 'float[]'
  }
  if (isPlainObject(value) === true) return 'dictionary'
  return 'string'
}

// ── metadata formatting ─────────────────────────────────────────────────────

/** The <path> form of one or more target paths: single or list. */
function pathsText(paths) {
  const rendered = paths.filter(path => typeof path === 'string' && path !== '').map(path => '<' + path + '>')
  if (rendered.length === 0) return ''
  return rendered.length === 1 ? rendered[0] : '[' + rendered.join(', ') + ']'
}

/** Read one composition-arc metadata value as a list of { asset, prim }. */
function arcsOf(meta, key) {
  const value = meta[key]
  if (Array.isArray(value)) return value
  if (isPlainObject(value) === true) return [value]
  return []
}

/**
 * The @asset@ (plus optional <primPath>) form of a reference or payload list.
 *
 * A single arc stays bare — @./body.usda@</Arm> is how USD authors it — and a
 * list becomes [@a@, @b@</Arm>]. Entries that no longer name an asset are
 * skipped: spelling @@ would be a different, empty asset rather than the one the
 * record lost.
 */
function arcsText(arcs) {
  const rendered = []
  for (const entry of arcs) {
    const arc = typeof entry === 'string' ? { asset: entry } : entry
    if (isPlainObject(arc) === false) continue
    if (typeof arc.asset !== 'string' || arc.asset === '') continue
    const prim = typeof arc.prim === 'string' && arc.prim !== '' ? '<' + arc.prim + '>' : ''
    rendered.push(quoteAsset(arc.asset) + prim)
  }
  if (rendered.length === 0) return ''
  return rendered.length === 1 ? rendered[0] : '[' + rendered.join(', ') + ']'
}

/**
 * A JSON-ish string for a customData value the dictionary grammar cannot spell.
 *
 * Arrays of dictionaries, mixed arrays and other shapes have no USD dictionary
 * value type; keeping their JSON text under a string entry preserves what the
 * record had instead of dropping it, and every USD parser reads a string.
 * @param value - the value with no representable dictionary form.
 * @returns its JSON text, or its string form when JSON cannot express it.
 */
function dictionaryTextFallback(value) {
  try {
    const json = JSON.stringify(value)
    if (typeof json === 'string') return json
  } catch {
    // BigInt and cycles have no JSON form; the plain string form is the next best.
  }
  try {
    return String(value)
  } catch {
    return ''
  }
}

/**
 * The int / int64 / uint64 type and decimal text for one whole value.
 *
 * Out-of-range magnitudes return undefined rather than a literal OpenUSD's parser
 * would reject; the caller falls back to a double or a string for those.
 * @param value - a number or BigInt known to be whole.
 * @returns { type, text }, or undefined when no integer type holds it.
 */
function integerEntry(value) {
  try {
    const exact = typeof value === 'bigint' ? value : BigInt(Math.trunc(value))
    if (exact >= BIGINT32_MIN && exact <= BIGINT32_MAX) return { type: 'int', text: exact.toString() }
    if (exact >= BIGINT64_MIN && exact <= BIGINT64_MAX) return { type: 'int64', text: exact.toString() }
    if (exact > BIGINT64_MAX && exact <= BIGINT64_UINT_MAX) return { type: 'uint64', text: exact.toString() }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * The type and literal for a list-shaped customData entry.
 *
 * Every dictionary value needs a type keyword, so the element type is inferred
 * from the JavaScript elements: an empty list gets the neutral string[], a
 * uniform numeric tuple gets double<width>[] (a registered USD type), and a shape
 * with no list type becomes a string holding the JSON text.
 * @param value - an array-like dictionary entry value.
 * @returns { type, text }.
 */
function typedDictionaryList(value) {
  const entries = Array.from(value)
  if (entries.length === 0) return { type: 'string[]', text: '[]' }
  if (entries.every(entry => typeof entry === 'boolean')) return { type: 'bool[]', text: formatValue(value, 'bool[]') }
  if (entries.every(entry => typeof entry === 'string')) return { type: 'string[]', text: formatValue(value, 'string[]') }
  if (entries.every(entry => typeof entry === 'number' || typeof entry === 'bigint')) {
    return { type: 'double[]', text: formatValue(value, 'double[]') }
  }
  if (entries.every(entry => isListLike(entry) === true)) {
    const width = Array.from(entries[0]).length
    const uniform = width >= 2 && width <= 4 && entries.every(entry => {
      const components = Array.from(entry)
      return components.length === width && components.every(component => typeof component === 'number')
    })
    if (uniform === true) {
      const type = 'double' + width + '[]'
      return { type, text: formatValue(entries, type) }
    }
  }
  return { type: 'string', text: quoteString(dictionaryTextFallback(value)) }
}

/**
 * Format one customData value as a typed dictionary entry.
 *
 * The dictionary grammar requires a value-type keyword (usdcat: "Unrecognized
 * value typename"), and the decoded record no longer carries the authored type, so
 * the type is inferred from the JavaScript value. That is a documented best effort,
 * not a claim about the file: a whole number becomes int/int64/uint64 by magnitude,
 * a decimal becomes double, and a shape with no dictionary value type becomes a
 * string holding its JSON text. Nested dictionaries are handled by the caller,
 * which keeps the "dictionary" keyword the grammar requires for them.
 * @param value - the dictionary entry value.
 * @returns { type, text }, or undefined for a value USD dictionaries cannot hold.
 */
function typedDictionaryEntry(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'boolean') return { type: 'bool', text: value === true ? 'true' : 'false' }
  if (typeof value === 'bigint') {
    const integer = integerEntry(value)
    return integer !== undefined ? integer : { type: 'string', text: quoteString(value.toString()) }
  }
  if (typeof value === 'number') {
    if (Number.isFinite(value) === false) return { type: 'double', text: formatNumber(value) }
    if (Number.isInteger(value) === true) {
      const integer = integerEntry(value)
      if (integer !== undefined) return integer
    }
    return { type: 'double', text: formatNumber(value) }
  }
  if (typeof value === 'string') return { type: 'string', text: quoteString(value) }
  if (isListLike(value) === true) return typedDictionaryList(value)
  return { type: 'string', text: quoteString(dictionaryTextFallback(value)) }
}

/**
 * Append a dictionary's entries as indented lines, one per entry.
 *
 * Nested dictionaries stay nested blocks instead of one long line, because
 * customData is the one metadata field a human actually reads; they keep the
 * "dictionary" keyword the metadata grammar requires. Scalar entries carry an
 * inferred value type (see typedDictionaryEntry) because OpenUSD rejects an untyped
 * dictionary entry. None has no dictionary spelling at all, so such an entry is
 * reported as a comment inside the block rather than dropped in silence or written
 * as a string that claims a type the record does not have.
 */
function appendDictionaryEntries(dictionary, indent, lines) {
  for (const key of Object.keys(dictionary)) {
    const entry = dictionary[key]
    if (isPlainObject(entry) === true) {
      if (Object.keys(entry).length === 0) {
        lines.push(indent + 'dictionary ' + formatKey(key) + ' = {}')
        continue
      }
      lines.push(indent + 'dictionary ' + formatKey(key) + ' = {')
      appendDictionaryEntries(entry, indent + INDENT, lines)
      lines.push(indent + '}')
      continue
    }
    const typed = typedDictionaryEntry(entry)
    if (typed === undefined) {
      lines.push(indent + '# skipped ' + formatKey(key) + ' = None: a dictionary value cannot be None')
      continue
    }
    lines.push(indent + typed.type + ' ' + formatKey(key) + ' = ' + typed.text)
  }
}

/** The customData = { … } block, one entry per line, at the given indent. */
function customDataLines(value, indent) {
  const lines = [indent + 'customData = {']
  appendDictionaryEntries(value, indent + INDENT, lines)
  lines.push(indent + '}')
  return lines
}

/** The variants = { string set = "selection" … } block, one assignment per line. */
function variantsLines(variants, indent) {
  const lines = [indent + 'variants = {']
  for (const name of Object.keys(variants)) {
    lines.push(indent + INDENT + 'string ' + formatKey(name) + ' = ' + quoteString(variants[name]))
  }
  lines.push(indent + '}')
  return lines
}

/**
 * The layer metadata block's lines, in the fixed order a reader expects:
 * defaultPrim, units, time range, doc, then sublayers.
 *
 * Only the fields the decoded record preserves are written; the order is the one
 * a USD reader scans rather than the record's insertion order, so the output is
 * stable from layer to layer.
 * @param meta - the record's layer metadata.
 * @returns indented lines, empty when the layer has no metadata.
 */
function layerMetadataLines(meta) {
  const lines = []
  if (isPlainObject(meta) === false) return lines
  const indent = INDENT
  if (typeof meta.defaultPrim === 'string' && meta.defaultPrim !== '') {
    lines.push(indent + 'defaultPrim = ' + quoteString(meta.defaultPrim))
  }
  if (typeof meta.metersPerUnit === 'number') lines.push(indent + 'metersPerUnit = ' + formatNumber(meta.metersPerUnit))
  if (typeof meta.upAxis === 'string' && meta.upAxis !== '') lines.push(indent + 'upAxis = ' + quoteString(meta.upAxis))
  if (typeof meta.startTimeCode === 'number') lines.push(indent + 'startTimeCode = ' + formatNumber(meta.startTimeCode))
  if (typeof meta.endTimeCode === 'number') lines.push(indent + 'endTimeCode = ' + formatNumber(meta.endTimeCode))
  if (typeof meta.timeCodesPerSecond === 'number') {
    lines.push(indent + 'timeCodesPerSecond = ' + formatNumber(meta.timeCodesPerSecond))
  }
  if (typeof meta.doc === 'string') lines.push(indent + 'doc = ' + quoteString(meta.doc))
  const subLayers = Array.isArray(meta.subLayers)
    ? meta.subLayers.map(entry => (typeof entry === 'string' ? entry : entry?.asset)).filter(asset => typeof asset === 'string' && asset !== '')
    : []
  if (subLayers.length > 0) lines.push(indent + 'subLayers = [' + subLayers.map(quoteAsset).join(', ') + ']')
  return lines
}

/**
 * A prim's metadata block lines, in the fixed order the contract names: kind,
 * apiSchemas, doc, active, instanceable, customData, variantSets, variants,
 * inherits, specializes, then the two composition arcs.
 *
 * active is written only when false and instanceable only when true: those are
 * the values that change composition, and writing the defaults would claim
 * authored statements the record's canonical form does not distinguish. ASCII
 * may author either as 1/0 rather than true/false, so the numeric forms are read
 * as the booleans they mean.
 * @param prim - the prim record.
 * @param depth - the prim's tree depth, used for indentation.
 * @returns indented lines, empty when the prim authors no reconstructed metadata.
 */
function primMetadataLines(prim, depth) {
  const indent = INDENT.repeat(depth + 1)
  const meta = isPlainObject(prim.meta) === true ? prim.meta : {}
  const lines = []
  if (typeof meta.kind === 'string' && meta.kind !== '') lines.push(indent + 'kind = ' + quoteString(meta.kind))
  const schemas = Array.isArray(prim.apiSchemas)
    ? prim.apiSchemas.filter(schema => typeof schema === 'string' && schema !== '')
    : []
  if (schemas.length > 0) lines.push(indent + 'prepend apiSchemas = [' + schemas.map(quoteString).join(', ') + ']')
  if (typeof meta.doc === 'string') lines.push(indent + 'doc = ' + quoteString(meta.doc))
  if (meta.active === false || meta.active === 0) lines.push(indent + 'active = false')
  if (meta.instanceable === true || meta.instanceable === 1) lines.push(indent + 'instanceable = true')
  if (isPlainObject(meta.customData) === true && Object.keys(meta.customData).length > 0) {
    lines.push(...customDataLines(meta.customData, indent))
  }
  const variantSets = Array.isArray(meta.variantSets)
    ? meta.variantSets.filter(name => typeof name === 'string' && name !== '')
    : []
  if (variantSets.length > 0) lines.push(indent + 'variantSets = [' + variantSets.map(quoteString).join(', ') + ']')
  if (isPlainObject(meta.variants) === true && Object.keys(meta.variants).length > 0) {
    lines.push(...variantsLines(meta.variants, indent))
  }
  const inherits = Array.isArray(meta.inherits) ? meta.inherits : []
  const inheritsText = pathsText(inherits)
  if (inheritsText !== '') lines.push(indent + 'inherits = ' + inheritsText)
  const specializes = Array.isArray(meta.specializes) ? meta.specializes : []
  const specializesText = pathsText(specializes)
  if (specializesText !== '') lines.push(indent + 'specializes = ' + specializesText)
  const references = arcsText(arcsOf(meta, 'references'))
  if (references !== '') lines.push(indent + 'prepend references = ' + references)
  const payload = arcsText(arcsOf(meta, 'payload'))
  if (payload !== '') lines.push(indent + 'prepend payload = ' + payload)
  return lines
}

// ── prim body formatting ────────────────────────────────────────────────────

/**
 * A prim's attribute lines: the union of its declared types and its materialised
 * values, declared types first so the authored order is kept.
 *
 * An attribute with a declared type but no value is written as a declaration with
 * no '=' — that is exactly how a Shader declares an output, and inventing a value
 * would change the file's meaning.
 */
function attributeLines(prim, depth) {
  const indent = INDENT.repeat(depth + 1)
  const attrs = isPlainObject(prim.attrs) === true ? prim.attrs : {}
  const attrTypes = isPlainObject(prim.attrTypes) === true ? prim.attrTypes : {}
  const attrFlags = isPlainObject(prim.attrFlags) === true ? prim.attrFlags : {}
  const names = []
  const seen = new Set()
  for (const name of Object.keys(attrTypes)) {
    if (typeof name === 'string' && name !== '' && seen.has(name) === false) {
      seen.add(name)
      names.push(name)
    }
  }
  for (const name of Object.keys(attrs)) {
    if (typeof name === 'string' && name !== '' && seen.has(name) === false) {
      seen.add(name)
      names.push(name)
    }
  }
  const lines = []
  for (const name of names) {
    const declared = typeof attrTypes[name] === 'string' ? attrTypes[name] : ''
    const value = attrs[name]
    const hasValue = Object.prototype.hasOwnProperty.call(attrs, name) === true && value !== undefined
    const type = declared !== '' ? declared : inferDeclaredType(value)
    const flags = isPlainObject(attrFlags[name]) === true ? attrFlags[name] : {}
    // Only ownership/variability modifiers are reconstructed: config, prepend and
    // the other list ops are not recoverable from a decoded value. OpenUSD's parser
    // accepts only custom-before-uniform ('uniform custom string x' fails with
    // "Expected }"); the record does not keep the authored order, so this is the
    // one valid spelling both modifiers can take together.
    const prefix = (flags.custom === true ? 'custom ' : '') + (flags.uniform === true ? 'uniform ' : '')
    const head = indent + prefix + type + ' ' + name
    lines.push(hasValue === true ? head + ' = ' + formatValue(value, declared) : head)
  }
  return lines
}

/**
 * A prim's relationship lines. Relationships with no target paths are omitted for
 * the reason the module comment gives: the record cannot spell an empty target
 * list safely, and a bare 'rel name' would overclaim an authored declaration.
 */
function relationshipLines(prim, depth) {
  const indent = INDENT.repeat(depth + 1)
  const rels = isPlainObject(prim.rels) === true ? prim.rels : {}
  const lines = []
  for (const name of Object.keys(rels)) {
    if (typeof name !== 'string' || name === '') continue
    const raw = rels[name]
    const targets = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []).filter(target => typeof target === 'string' && target !== '')
    if (targets.length === 0) continue
    const value = targets.length === 1 ? '<' + targets[0] + '>' : '[' + targets.map(target => '<' + target + '>').join(', ') + ']'
    lines.push(indent + 'rel ' + name + ' = ' + value)
  }
  return lines
}

// ── the prim tree ───────────────────────────────────────────────────────────

/** Normalise record.prims (a Map or an array) into insertion-ordered prim entries. */
function primEntries(prims) {
  const entries = []
  const add = (path, prim) => {
    if (isPlainObject(prim) === false) return
    const name = typeof prim.path === 'string' && prim.path !== '' ? prim.path : typeof path === 'string' ? path : ''
    if (name === '' || name.charAt(0) !== '/') return
    entries.push({ path: name, prim })
  }
  if (prims instanceof Map) {
    for (const [path, prim] of prims) add(path, prim)
  } else if (Array.isArray(prims)) {
    for (const prim of prims) add(isPlainObject(prim) === true ? prim.path : undefined, prim)
  } else if (isPlainObject(prims) === true) {
    for (const path of Object.keys(prims)) add(path, prims[path])
  }
  return entries
}

/**
 * Build the tree from path prefixes and insertion order.
 *
 * A prim whose parent path is not itself recorded cannot be nested under a prim
 * the record does not have, and rendering it at the top level would change its
 * path, so it is reported instead of being moved. Its recorded descendants are
 * reported too: they are in the record, but nothing in it gives them a parent
 * chain to hang from.
 * @param entries - the normalised prim entries.
 * @returns the roots and every node no root reaches.
 */
function buildPrimTree(entries) {
  const nodes = new Map()
  for (const entry of entries) {
    if (nodes.has(entry.path) === true) continue
    nodes.set(entry.path, { path: entry.path, prim: entry.prim, children: [] })
  }
  const roots = []
  for (const node of nodes.values()) {
    const cut = node.path.lastIndexOf('/')
    if (cut <= 0) {
      roots.push(node)
      continue
    }
    const parent = nodes.get(node.path.slice(0, cut))
    if (parent === undefined) continue
    parent.children.push(node)
  }
  const reachable = new Set()
  const stack = [...roots]
  while (stack.length > 0) {
    const node = stack.pop()
    if (reachable.has(node) === true) continue
    reachable.add(node)
    for (const child of node.children) stack.push(child)
  }
  const unreachable = []
  for (const node of nodes.values()) {
    if (reachable.has(node) === false) unreachable.push(node)
  }
  return { roots, unreachable }
}

/** Whether a prim path goes through a variant selection, which no prim can be named by. */
function hasVariantSelection(path) {
  return path.split('/').some(segment => segment.includes('{'))
}

// ── output with a hard size ceiling ────────────────────────────────────────

/**
 * A line writer that stops at a character budget instead of building an unbounded
 * string first.
 *
 * Rendering is the last step of a preview read, so the budget has to be enforced
 * while writing: a layer with a few million points would otherwise materialise the
 * whole text just to cut it. The truncation marker's own room is reserved up
 * front, which is what keeps the returned string within maxChars.
 */
class Output {
  /**
   * @param budget - characters available for content.
   * @param maxChars - the caller's ceiling, marker included.
   */
  constructor(budget, maxChars) {
    this.lines = []
    this.chars = 0
    this.budget = budget
    this.maxChars = maxChars
    this.truncated = false
  }

  /** Append one line; returns false once the budget is exhausted. */
  push(line) {
    if (this.truncated === true) return false
    const text = typeof line === 'string' ? line : String(line)
    const added = (this.lines.length === 0 ? 0 : 1) + text.length
    if (this.chars + added > this.budget) {
      this.truncated = true
      return false
    }
    this.lines.push(text)
    this.chars += added
    return true
  }

  /** The finished string, with the truncation comment when the budget was hit. */
  text() {
    const body = this.lines.join('\n')
    if (this.truncated === false) return body
    const truncated = body === '' ? TRUNCATION_MARKER : body + '\n' + TRUNCATION_MARKER
    if (truncated.length <= this.maxChars) return truncated
    return truncated.slice(0, Math.max(0, this.maxChars))
  }
}

/** Resolve the caller's character ceiling, rejecting junk in favour of the default. */
function normaliseMaxChars(value) {
  return typeof value === 'number' && Number.isFinite(value) === true && value > 0 ? Math.floor(value) : DEFAULT_MAX_CHARS
}

/** The caller's label lines, each prefixed '# '; they follow the magic line. */
function headerCommentLines(headerComment) {
  const raw = []
  const add = (entry) => {
    if (typeof entry === 'string') {
      raw.push(...entry.split(/\r?\n/))
      return
    }
    if (entry !== undefined && entry !== null) raw.push(String(entry))
  }
  if (Array.isArray(headerComment)) headerComment.forEach(add)
  else add(headerComment)
  const lines = []
  for (const line of raw) {
    const text = line.replace(/\s+$/, '')
    if (text === '') continue
    lines.push('# ' + text)
  }
  return lines
}

// ── rendering ───────────────────────────────────────────────────────────────

/** Emit one prim: its parenthesised metadata, its body, then its children. */
function renderPrim(node, depth, writer) {
  if (writer.truncated === true) return
  const indent = INDENT.repeat(depth)
  if (hasVariantSelection(node.path) === true) {
    writer.push(indent + '# skipped ' + node.path + ': a variant selection path is not a prim name (its subtree is omitted too)')
    return
  }
  const prim = node.prim
  const type = typeof prim.type === 'string' ? prim.type : ''
  const name = node.path.slice(node.path.lastIndexOf('/') + 1)
  const specifier = prim.specifier === 'over' || prim.specifier === 'class' ? prim.specifier : 'def'
  if (writer.lines.length > 0 && writer.lines[writer.lines.length - 1] !== '') writer.push('')
  if (writer.truncated === true) return
  const header = indent + specifier + ' ' + (type === '' ? '' : type + ' ') + quoteString(name)
  const metadata = primMetadataLines(prim, depth)
  if (metadata.length === 0) {
    if (writer.push(header) === false) return
  } else {
    if (writer.push(header + ' (') === false) return
    for (const line of metadata) {
      if (writer.push(line) === false) return
    }
    if (writer.push(indent + ')') === false) return
  }
  if (writer.push(indent + '{') === false) return
  for (const line of attributeLines(prim, depth)) {
    if (writer.push(line) === false) return
  }
  for (const line of relationshipLines(prim, depth)) {
    if (writer.push(line) === false) return
  }
  for (const child of node.children) {
    if (writer.truncated === true) return
    renderPrim(child, depth + 1, writer)
  }
  writer.push(indent + '}')
}

/**
 * Render one decoded layer record as USDA text.
 *
 * The record is exactly what the shared readers produce: { meta, prims } where
 * prims is a Map (or array) of prim records keyed by absolute path. The result is
 * a **reconstruction** — see the module comment for what it can and cannot
 * represent — meant to be shown under a caller-supplied label, never mistaken for
 * the authored file.
 *
 * The function never throws: a record it cannot make sense of still renders a
 * labelled comment so a text view keeps its shape instead of blanking.
 *
 * @param record - { meta, prims } as decoded by layer-text.js / details.js.
 * @param options - rendering options.
 * @param options.headerComment - comment line(s) placed after #usda 1.0 and
 *   before the metadata block; the caller puts its "reconstructed" label here.
 *   They cannot precede the magic line: OpenUSD rejects an ASCII layer whose
 *   first line is a comment ('not a valid usda layer' from usdcat).
 * @param options.maxChars - hard ceiling on the returned string (default 2 MB);
 *   a cut rendering ends with a truncation comment.
 * @returns the rendered USDA source.
 */
export function renderUsdaLayer(record, options = {}) {
  try {
    return renderRecord(record, options)
  } catch (error) {
    // The last-resort contract: a layer the renderer cannot understand must still
    // produce text, because the alternative is a blank Text mode. The note says
    // what failed rather than pretending the layer is empty.
    const maxChars = normaliseMaxChars(options === null || options === undefined ? undefined : options.maxChars)
    const note = error instanceof Error ? error.message : String(error)
    const fallback = LAYER_HEADER + '\n# … this layer could not be reconstructed: ' + note.replace(/\s+/g, ' ')
    return fallback.length <= maxChars ? fallback : fallback.slice(0, maxChars)
  }
}

/**
 * The body of renderUsdaLayer, separated so the exported entry point can hold the
 * never-throw contract without wrapping every helper.
 * @param record - the layer record.
 * @param options - the rendering options.
 * @returns the rendered USDA source.
 */
function renderRecord(record, options) {
  const settings = isPlainObject(options) === true ? options : {}
  const maxChars = normaliseMaxChars(settings.maxChars)
  const reserve = TRUNCATION_MARKER.length + 1
  const writer = new Output(maxChars > reserve ? maxChars - reserve : 0, maxChars)
  // The magic line comes first: OpenUSD's ASCII parser anchors on '#usda' at the
  // very start of the file, so a comment there makes the layer invalid to every
  // USD tool even though this project's own reader would skip it. Comments are
  // legal immediately after it, which is where the caller's label goes.
  writer.push(LAYER_HEADER)
  for (const line of headerCommentLines(settings.headerComment)) writer.push(line)
  const layer = isPlainObject(record) === true ? record : {}
  const meta = isPlainObject(layer.meta) === true ? layer.meta : {}
  const metadata = layerMetadataLines(meta)
  if (metadata.length > 0) {
    writer.push('(')
    for (const line of metadata) {
      if (writer.push(line) === false) return writer.text()
    }
    writer.push(')')
  }
  const tree = buildPrimTree(primEntries(layer.prims))
  if (tree.roots.length > 0 || tree.unreachable.length > 0) writer.push('')
  for (const root of tree.roots) {
    if (writer.truncated === true) break
    renderPrim(root, 0, writer)
  }
  for (const node of tree.unreachable) {
    if (writer.truncated === true) break
    if (writer.lines.length > 0 && writer.lines[writer.lines.length - 1] !== '') writer.push('')
    writer.push('# skipped ' + node.path + ': its parent chain is not in the record, so nesting it would change its path')
  }
  return writer.text()
}
