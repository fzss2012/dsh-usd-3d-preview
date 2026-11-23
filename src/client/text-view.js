/**
 * The authored-text side of the preview: how a USD file's own text is bounded,
 * classified and tokenised for a reader panel.
 *
 * A stage is composed by the engine and drawn by three, and the panels beside
 * the viewport answer "what is in this stage" and "what does it declare about
 * this prim". A third question stays unanswerable that way: what does the file
 * *itself* say? An ASCII layer is the authoring surface a USD reader debugs
 * against — a brace that does not close, an array an exporter wrote, the
 * `prepend references` line that explains why a value is not where it was
 * expected to be. This module turns layer bytes into a bounded, tokenisable
 * model of that text, with no React and no DOM, so the classification rules can
 * be tested in Node.
 *
 * ## The container is decided by the bytes, never by a name
 *
 * A file opened from object storage or dropped from a desktop has a name that
 * may be wrong, missing or misleading; the first eight bytes cannot lie about a
 * crate, and a zip signature cannot lie about a package. The three containers
 * are therefore classified here exactly as the assembly path classifies them
 * (crate magic, zip magic, then an ASCII header), and a caller never has to
 * pass an extension down beside the bytes.
 *
 * ## Bounded by construction
 *
 * A solved robot's geometry layer can be tens of megabytes of one
 * `point3f[] points` array on a single line. Decoding that into a React tree
 * would freeze the tab long before anything scrolled, so the document is
 * previewed, not displayed whole: cut at a byte budget on a line boundary, then
 * at a line count, then trim every surviving overlong line. The full file's line
 * total is still reported, counted over the raw bytes — 0x0A cannot occur inside
 * a UTF-8 multi-byte sequence, so the count is exact while the 90 MiB string is
 * never materialised. The panel says "the first part", never "all of it".
 *
 * ## What it deliberately does not do
 *
 * It does not parse, validate or recompose USD: `layer-text.js` reads the
 * declarations and the OpenUSD engine composes the stage. It does not reconstruct
 * a crate's text — a binary container is reported as such, and turning decoded
 * crate records back into readable USDA is the serialiser's job. It also does not
 * open a `.usdz` as a document: a package is expanded into its layers, and each
 * layer is then previewed as text by this same code. The tokeniser is a
 * colouring lexer, not a grammar: it knows comments, strings, assets, numbers,
 * keywords and punctuation, and leaves everything else (including USD's rarer
 * `//` comment spelling) to the identifier fallback rather than guessing.
 *
 * @module dsh-usd-3d-preview/text-view
 */
import { unzipSync } from 'three/examples/jsm/libs/fflate.module.js'

/** Byte budget of one decoded preview: 2 MiB is already more text than a panel can show. */
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024

/** Line budget of one preview. */
export const DEFAULT_MAX_LINES = 4000

/** Characters kept per line; anything longer is cut and marked with an ellipsis. */
export const DEFAULT_MAX_LINE_CHARS = 2000

/** Uncompressed USD-layer bytes a package expansion keeps, unless overridden. */
const DEFAULT_MAX_PACKAGE_BYTES = 64 * 1024 * 1024

/** USD layer entries a package expansion keeps, unless overridden. */
const DEFAULT_MAX_PACKAGE_ENTRIES = 64

/** `PXR-USDC`, the binary crate header. */
const CRATE_MAGIC = [0x50, 0x58, 0x52, 0x2D, 0x55, 0x53, 0x44, 0x43]

/** The three local zip signatures: local header, empty archive, spanned archive. */
const ZIP_MAGICS = [
  [0x50, 0x4B, 0x03, 0x04],
  [0x50, 0x4B, 0x05, 0x06],
  [0x50, 0x4B, 0x07, 0x08],
]

/** A UTF-8 byte order mark, legal in front of a `.usda` written by a Windows editor. */
const UTF8_BOM = [0xEF, 0xBB, 0xBF]

/** Suffixes that carry a USD layer inside a package; matched case-insensitively. */
const LAYER_SUFFIXES = new Set(['usd', 'usda', 'usdc'])

/** USDA keywords, coloured apart from identifiers. */
const KEYWORDS = new Set([
  'def', 'over', 'class', 'reorder', 'uniform', 'custom', 'varying', 'config',
  'prepend', 'append', 'add', 'delete', 'rel', 'variantSet', 'None', 'true', 'false',
])

/** The punctuation a USDA line is built from; each character is its own token. */
const PUNCTUATION = new Set('{}()[]=,;<>.:'.split(''))

/** Integer or float spelling with an optional exponent, anchored at the lexer cursor. */
const NUMBER = /[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y

const textDecoder = new TextDecoder()

/**
 * A Uint8Array view over the caller's bytes, or undefined for anything else.
 *
 * Accepting any array-buffer view (not only Uint8Array) costs nothing and means
 * the host's `Buffer`, a `DataView` from a reader, and the browser's
 * `Uint8Array` all work without a copy. A detached buffer is a value this module
 * cannot read, so it resolves to undefined rather than raising.
 * @param bytes - the file bytes as the caller holds them.
 * @returns a byte view, or undefined when the value holds no readable bytes.
 */
function viewOf(bytes) {
  try {
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes)
    if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Whether a byte view starts with one exact sequence at an offset.
 * @param view - the bytes to test.
 * @param offset - where the sequence should start.
 * @param magic - the expected bytes.
 * @returns true when the prefix matches.
 */
function startsWithAt(view, offset, magic) {
  if (offset + magic.length > view.length) return false
  for (let index = 0; index < magic.length; index += 1) {
    if (view[offset + index] !== magic[index]) return false
  }
  return true
}

/**
 * The caller's options object, or an empty one.
 * @param options - whatever the caller passed.
 * @returns an object safe to read caps from.
 */
function optionsOf(options) {
  return options !== null && typeof options === 'object' ? options : {}
}

/**
 * A positive integer option, or its default.
 *
 * Caps are clamped rather than trusted: a caller passing 0, a negative number or
 * NaN is asking for the default, not for a preview that renders nothing. A
 * fractional value is not a byte or line count either.
 * @param value - the option as passed.
 * @param fallback - the value to use when the option is not a positive integer.
 * @returns the usable cap.
 */
function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

/**
 * Classify complete USD bytes by container, from the bytes alone.
 *
 * A crate is identified by its `PXR-USDC` magic and a package by a zip
 * signature before anything is looked at as text, so a binary layer whose first
 * printable byte happens to be `#` cannot be mistaken for ASCII. BOM-prefixed
 * text is the one tolerated deviation: a Windows editor writes it in front of a
 * `.usda` and the bytes after it are still the header line.
 * @param bytes - the file bytes (Uint8Array, ArrayBuffer or any buffer view).
 * @returns `'usda'`, `'crate'`, `'usdz'` or `'unknown'`; never throws.
 */
export function layerKindOf(bytes) {
  const view = viewOf(bytes)
  if (view === undefined) return 'unknown'
  if (startsWithAt(view, 0, CRATE_MAGIC)) return 'crate'
  if (ZIP_MAGICS.some(magic => startsWithAt(view, 0, magic))) return 'usdz'
  let start = 0
  if (startsWithAt(view, 0, UTF8_BOM)) start = UTF8_BOM.length
  if (start >= view.length) return 'unknown'
  const first = view[start]
  // The authored header (or a comment, or indentation before either) is the only
  // text signature worth trusting. A layer body that starts with `def` would
  // also be printable text, but a header-less layer is rare enough that guessing
  // at it would classify arbitrary binary bytes whose first byte is 0x64 as text.
  if (first === 0x23 || first === 0x2F) return 'usda'
  if (first === 0x20 || first === 0x09 || first === 0x0A || first === 0x0D || first === 0x0B || first === 0x0C) return 'usda'
  return 'unknown'
}

/**
 * Build one bounded, renderable view of a layer's authored text.
 *
 * Synchronous and total: arbitrary bytes produce a binary or package descriptor
 * rather than an exception, because the panel's state must never depend on a
 * file being valid. The caps apply in the order they matter for cost — bytes
 * first (decode budget), then lines, then per-line characters (render budget) —
 * and the line total is counted over the whole file so the panel can say how
 * much it is not showing.
 * @param bytes - the layer bytes (Uint8Array, ArrayBuffer or any buffer view).
 * @param options - caps.
 * @param options.maxBytes - decoded prefix budget; defaults to {@link DEFAULT_MAX_BYTES}.
 * @param options.maxLines - decoded line budget; defaults to {@link DEFAULT_MAX_LINES}.
 * @param options.maxLineChars - characters kept per line; defaults to {@link DEFAULT_MAX_LINE_CHARS}.
 * @returns `{ kind: 'text', ... }` for ASCII, otherwise the binary/package descriptor.
 */
export function previewLayer(bytes, options = {}) {
  const view = viewOf(bytes)
  const totalBytes = view === undefined ? 0 : view.length
  const container = layerKindOf(view)
  if (container === 'crate') return { kind: 'binary', container: 'crate', totalBytes, reason: 'crate' }
  if (container === 'usdz') return { kind: 'package', container: 'usdz', totalBytes, reason: 'package' }
  if (container === 'unknown' || view === undefined) return { kind: 'binary', container: 'unknown', totalBytes, reason: 'unknown' }

  const settings = optionsOf(options)
  const maxBytes = positiveInt(settings.maxBytes, DEFAULT_MAX_BYTES)
  const maxLines = positiveInt(settings.maxLines, DEFAULT_MAX_LINES)
  const maxLineChars = positiveInt(settings.maxLineChars, DEFAULT_MAX_LINE_CHARS)
  const start = startsWithAt(view, 0, UTF8_BOM) ? UTF8_BOM.length : 0

  // Count the whole file's newlines over its raw bytes, not over decoded text:
  // 0x0A cannot occur as a UTF-8 continuation byte, so this is the exact number
  // of line breaks while only the capped prefix below is ever decoded.
  let newlines = 0
  for (let at = start; at < view.length; at += 1) {
    if (view[at] === 0x0A) newlines += 1
  }
  const lineCount = newlines + 1

  const available = view.length - start
  let end = start + Math.min(available, maxBytes)
  const byteCut = end < view.length
  if (byteCut) {
    // Prefer to end the decode on a line boundary, so the last shown line is one
    // the file actually wrote instead of half of one. A single line larger than
    // the whole budget (an exporter's one-line points array) has no boundary;
    // its prefix is decoded below and then cut by the per-line cap.
    for (let at = end - 1; at >= start; at -= 1) {
      if (view[at] === 0x0A) {
        end = at
        break
      }
    }
  }
  // TextDecoder replaces a truncated trailing UTF-8 sequence rather than
  // throwing: a byte cut inside a multi-byte character must not fail the panel.
  const decoded = textDecoder.decode(view.subarray(start, Math.max(start, end)))
  const rawLines = decoded.split('\n')
  const shownLines = rawLines.length > maxLines ? rawLines.slice(0, maxLines) : rawLines
  let longLinesTrimmed = 0
  const lines = shownLines.map((line) => {
    if (line.length <= maxLineChars) return line
    longLinesTrimmed += 1
    return line.slice(0, maxLineChars) + ' …'
  })
  const omittedLines = Math.max(0, lineCount - lines.length)
  return {
    kind: 'text',
    container: 'usda',
    totalBytes,
    text: lines.join('\n'),
    lineCount,
    truncated: byteCut || omittedLines > 0 || longLinesTrimmed > 0,
    omittedLines,
    longLinesTrimmed,
  }
}

/**
 * Whether an archive entry name carries a USD layer suffix.
 * @param name - the zip entry's name.
 * @returns true for `.usd`, `.usda` and `.usdc`, in any case.
 */
function isLayerName(name) {
  const dot = name.lastIndexOf('.')
  if (dot < 0) return false
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  if (dot < slash) return false
  return LAYER_SUFFIXES.has(name.slice(dot + 1).toLowerCase())
}

/**
 * Expand a `.usdz` package's USD layers in memory.
 *
 * The USDZ spec puts the root layer first in the archive, so the root is named
 * here by archive order rather than by suffix preference: a package that starts
 * with `sample.usdc` is read as exactly that layer. Only layer entries are
 * decompressed — textures and the rest of the archive are filtered out before
 * inflation — and both the number of layers kept and the uncompressed bytes they
 * may occupy are capped, so a zip bomb or a package holding a hundred layers
 * cannot exhaust the page while the panel is opening. `maxTotalBytes` is checked
 * against the header's uncompressed size, which is why the filter bounds the
 * work rather than merely the retained bytes.
 *
 * A kept set is not guaranteed to include the root: if the root layer alone is
 * larger than the byte cap it is named by `rootKey` but not returned, and
 * `omitted` counts it. Texture members are never "omitted" — they were not
 * layer candidates.
 * @param bytes - the package bytes.
 * @param options - caps.
 * @param options.maxTotalBytes - uncompressed USD-layer bytes kept; default 64 MiB.
 * @param options.maxEntries - USD layer entries kept; default 64.
 * @returns `{ rootKey, layers, omitted }`, with layers in archive order.
 */
export function packageLayers(bytes, options = {}) {
  const view = viewOf(bytes)
  const nothing = { rootKey: undefined, layers: [], omitted: 0 }
  if (view === undefined || layerKindOf(view) !== 'usdz') return nothing
  const settings = optionsOf(options)
  const maxTotalBytes = positiveInt(settings.maxTotalBytes, DEFAULT_MAX_PACKAGE_BYTES)
  const maxEntries = positiveInt(settings.maxEntries, DEFAULT_MAX_PACKAGE_ENTRIES)
  let rootKey
  let keptBytes = 0
  let omitted = 0
  const keptNames = []
  const seen = new Set()
  let entries
  try {
    entries = unzipSync(view, {
      filter(file) {
        const name = typeof file.name === 'string' ? file.name : ''
        if (!isLayerName(name)) return false
        if (rootKey === undefined) rootKey = name
        if (seen.has(name)) return false
        // Guard the header value: a malformed entry must not make the budget
        // arithmetic NaN and let every later entry through.
        const size = Number.isFinite(file.originalSize) ? file.originalSize : 0
        if (keptNames.length >= maxEntries || keptBytes + size > maxTotalBytes) {
          omitted += 1
          return false
        }
        seen.add(name)
        keptNames.push(name)
        keptBytes += size
        return true
      },
    })
  } catch {
    // A truncated or corrupt archive is bytes this module cannot read, not a
    // failure the panel should surface as a broken layer.
    return nothing
  }
  const layers = []
  for (const key of keptNames) {
    if (Object.prototype.hasOwnProperty.call(entries, key)) layers.push({ key, bytes: entries[key] })
  }
  return { rootKey, layers, omitted }
}

/**
 * Whether a character code is USDA whitespace, including the line breaks a
 * multi-line caller may hand the single-line lexer.
 * @param code - the UTF-16 code unit.
 * @returns true for space, tab, carriage return, line feed, vertical tab, form feed.
 */
function isSpaceCode(code) {
  return code === 0x20 || code === 0x09 || code === 0x0A || code === 0x0D || code === 0x0B || code === 0x0C
}

/**
 * Whether a character code can start an identifier.
 *
 * Non-ASCII code units are treated as word content rather than as unknown
 * fallbacks: a comment or a doc string may hold any language, and splitting it
 * into one token per character would make the panel needlessly slow.
 * @param code - the UTF-16 code unit.
 * @returns true for ASCII letters, underscore and non-ASCII code units.
 */
function isWordStartCode(code) {
  return (code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A) || code === 0x5F || code >= 0x80
}

/**
 * Whether a character code may continue an identifier.
 * @param code - the UTF-16 code unit.
 * @returns true for an identifier start or an ASCII digit.
 */
function isWordCode(code) {
  return isWordStartCode(code) || (code >= 0x30 && code <= 0x39)
}

/**
 * Tokenise one USDA line for colouring.
 *
 * The panel's only hard invariant is that concatenating every token's text gives
 * the input back exactly: no character may be dropped, merged away or invented,
 * so the rendered line is the file's line and not a cleaned-up approximation.
 * That is why every unmatched character still becomes a one-character
 * `identifier` token instead of being skipped. `#` starts a comment to the end
 * of the line except inside a double-quoted string or an `@asset@` path;
 * strings keep their quotes and honours backslash escapes; assets keep the
 * `@` delimiters; keyword, number and punctuation tokens are the colouring
 * classes the panel maps to the shell's own code palette. The lexer is not a
 * parser: it does not validate a line, and it deliberately ignores USD's
 * alternative `//` comment spelling, which the fallback keeps intact.
 * @param line - the line to tokenise.
 * @returns the tokens in order, each `{ text, kind }`; never throws.
 */
export function tokenizeUsdaLine(line) {
  const text = typeof line === 'string' ? line : ''
  const tokens = []
  let at = 0
  while (at < text.length) {
    const code = text.charCodeAt(at)

    // Whitespace runs are their own tokens, so a wrap-off render keeps the
    // authored indentation and joining the tokens needs no separator.
    if (isSpaceCode(code)) {
      const start = at
      while (at < text.length && isSpaceCode(text.charCodeAt(at))) at += 1
      tokens.push({ text: text.slice(start, at), kind: 'space' })
      continue
    }

    if (code === 0x23) {
      tokens.push({ text: text.slice(at), kind: 'comment' })
      at = text.length
      continue
    }

    if (code === 0x22) {
      const start = at
      at += 1
      while (at < text.length) {
        const current = text.charCodeAt(at)
        if (current === 0x5C) {
          // A backslash escapes the next character, including a quote; a trailing
          // backslash simply consumes the rest of the line.
          at += 2
          continue
        }
        at += 1
        if (current === 0x22) break
      }
      tokens.push({ text: text.slice(start, Math.min(at, text.length)), kind: 'string' })
      continue
    }

    if (code === 0x40) {
      // An @asset@ path is one token even when it contains '#' ('#' is a comment
      // only outside a string or an asset path). An unterminated asset keeps the
      // rest of the line, which is what the file wrote.
      const start = at
      const close = text.indexOf('@', at + 1)
      at = close < 0 ? text.length : close + 1
      tokens.push({ text: text.slice(start, at), kind: 'asset' })
      continue
    }

    NUMBER.lastIndex = at
    const number = NUMBER.exec(text)
    if (number !== null) {
      tokens.push({ text: number[0], kind: 'number' })
      at = NUMBER.lastIndex
      continue
    }

    if (PUNCTUATION.has(text[at])) {
      tokens.push({ text: text[at], kind: 'punct' })
      at += 1
      continue
    }

    if (isWordStartCode(code)) {
      const start = at
      at += 1
      while (at < text.length && isWordCode(text.charCodeAt(at))) at += 1
      const word = text.slice(start, at)
      tokens.push({ text: word, kind: KEYWORDS.has(word) ? 'keyword' : 'identifier' })
      continue
    }

    // The total-lexer fallback: every remaining character still becomes a token,
    // so the reconstruction invariant holds for characters this lexer has no
    // class for.
    tokens.push({ text: text[at], kind: 'identifier' })
    at += 1
  }
  return tokens
}

/**
 * Lay out a text preview as numbered rows ready for rendering.
 *
 * The split is deliberately plain `split('\n')`: a file that ends in a newline
 * therefore ends in one trailing empty row, which is what a line-numbered reader
 * shows and what keeps row N on line N. The preview already bounds the number of
 * decodable lines, so `maxLines` here only trims the display further; the caller
 * can pass a smaller number without re-reading anything.
 * @param preview - the result of {@link previewLayer}.
 * @param options - layout options.
 * @param options.maxLines - rows to show; default the preview's own line count.
 * @returns `{ rows: [{ number, text, tokens }], omitted }` with 1-based numbers.
 */
export function usdaPreviewLines(preview, options = {}) {
  // Only a text preview has lines to number; a crate/package descriptor (or a
  // missing preview while a lazy read is in flight) has no rows at all rather
  // than one misleading empty row.
  if (preview === null || typeof preview !== 'object' || preview.kind !== 'text' || typeof preview.text !== 'string') {
    return { rows: [], omitted: 0 }
  }
  const lines = preview.text.split('\n')
  const settings = optionsOf(options)
  const maxLines = positiveInt(settings.maxLines, lines.length)
  const shown = lines.length > maxLines ? lines.slice(0, maxLines) : lines
  const rows = shown.map((line, index) => ({
    number: index + 1,
    text: line,
    tokens: tokenizeUsdaLine(line),
  }))
  return { rows, omitted: lines.length - rows.length }
}
