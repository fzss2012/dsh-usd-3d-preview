/**
 * The USDA text-view module, in Node: container classification, bounded
 * previewing, package expansion and the colouring lexer.
 *
 * This is the half of the text mode a browser suite cannot check cheaply: the
 * rules that keep a huge layer from freezing the panel, and the lexer invariant
 * that what is rendered is exactly what the file wrote. The cases below pin, in
 * order:
 *
 *   * container detection from the leading bytes, BOM included, never from a name;
 *   * the three preview caps and their order — byte cut on a line boundary, line
 *     count, per-line trim — plus the honest full-file line total and omitted count;
 *   * the crate / package / unknown descriptors, and the "arbitrary bytes never
 *     throw" contract;
 *   * package expansion: archive order defines the root layer, only USD layers are
 *     kept, and both the entry count and the uncompressed byte budget bound it;
 *   * the line lexer: comments stop at strings and assets, escaped quotes survive,
 *     and **concatenating every token's text reproduces the input exactly**;
 *   * the line model: 1-based numbers, the trailing empty line a final newline
 *     produces, and the display cap.
 *
 * Run: node tests/text-view.test.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strToU8, zipSync } from 'three/examples/jsm/libs/fflate.module.js'
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINE_CHARS,
  DEFAULT_MAX_LINES,
  layerKindOf,
  packageLayers,
  previewLayer,
  tokenizeUsdaLine,
  usdaPreviewLines,
} from '../src/client/text-view.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = async name => new Uint8Array(await readFile(join(root, 'tests', 'fixtures', name)))

const ascii = await fixture('sample.usda')
const crate = await fixture('sample.usdc')
const pkg = await fixture('sample.usdz')

/**
 * A small deterministic generator, so an "arbitrary bytes" case cannot pass by
 * accident on one lucky sample.
 */
function pseudoRandomBytes(length, seed) {
  let state = seed >>> 0
  const bytes = new Uint8Array(length)
  for (let index = 0; index < length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    bytes[index] = state >>> 24
  }
  return bytes
}

/** Prepend a UTF-8 BOM to encoded text, the way a Windows editor writes it. */
function bomBytes(text) {
  const body = strToU8(text)
  const bytes = new Uint8Array(body.length + 3)
  bytes.set([0xEF, 0xBB, 0xBF])
  bytes.set(body, 3)
  return bytes
}

/** Reconstruct a tokenised line from its tokens. */
function reconstruct(tokens) {
  return tokens.map(token => token.text).join('')
}

// ── the declared defaults are the contract the panel is sized against ────────
{
  assert.equal(DEFAULT_MAX_BYTES, 2 * 1024 * 1024, 'the decoded-text budget is 2 MiB')
  assert.equal(DEFAULT_MAX_LINES, 4000, 'the line budget is 4000 rows')
  assert.equal(DEFAULT_MAX_LINE_CHARS, 2000, 'a rendered line is capped at 2000 characters')
}

// ── container classification comes from the bytes alone ─────────────────────
{
  assert.equal(layerKindOf(bomBytes('#usda 1.0\n')), 'usda', 'a BOM-prefixed ASCII layer is text')
  assert.equal(layerKindOf(strToU8('#usda 1.0\n')), 'usda', 'the header line is text')
  assert.equal(layerKindOf(strToU8('\n#usda 1.0\n')), 'usda', 'leading whitespace is text')
  assert.equal(layerKindOf(strToU8('  ')), 'usda', 'a whitespace-only prefix is still text')
  assert.equal(layerKindOf(strToU8('// a comment\n')), 'usda', 'a leading slash is text')
  assert.equal(layerKindOf(crate), 'crate', 'the PXR-USDC magic is a crate, whatever the name says')
  assert.equal(layerKindOf(pkg), 'usdz', 'a zip signature is a package')
  assert.equal(layerKindOf(new Uint8Array([0, 1, 2])), 'unknown', 'neither text nor a known magic is unknown')
  assert.equal(layerKindOf(new Uint8Array(0)), 'unknown', 'an empty file is not guessed at')
  assert.equal(layerKindOf(strToU8('def Xform "Body" {}')), 'unknown', 'a header-less body is deliberately not guessed at')
  // The same answer through the ArrayBuffer form the host may hand over.
  const buffer = ascii.buffer.slice(ascii.byteOffset, ascii.byteOffset + ascii.byteLength)
  assert.equal(layerKindOf(buffer), 'usda', 'an ArrayBuffer is just bytes')
  assert.equal(layerKindOf(undefined), 'unknown', 'a missing value is unknown rather than a throw')
}

// ── a text preview strips the BOM and reports the whole file's line total ───
{
  const bytes = bomBytes('#usda 1.0\n')
  const preview = previewLayer(bytes)
  assert.equal(preview.kind, 'text')
  assert.equal(preview.container, 'usda')
  assert.equal(preview.totalBytes, bytes.length, 'totalBytes counts the file, BOM included')
  assert.equal(preview.text, '#usda 1.0\n', 'the decoded text is the file without the BOM')
  assert.equal(preview.text.startsWith('\ufeff'), false, 'the BOM is stripped, not rendered')
  assert.equal(preview.lineCount, 2, 'the trailing newline is a final empty line')
  assert.equal(preview.truncated, false, 'a small file is not truncated')
  assert.equal(preview.omittedLines, 0)
  assert.equal(preview.longLinesTrimmed, 0)
}

// ── the byte cap cuts on a line boundary, never in the middle of a line ────
{
  const source = '#usda 1.0\nline two\nline three\n'
  const bytes = strToU8(source)
  // The budget ends after the first newline: the longest prefix that ends on a
  // boundary is "#usda 1.0", so the half-line "line t" must not appear.
  const preview = previewLayer(bytes, { maxBytes: 10 })
  assert.equal(preview.text, '#usda 1.0', 'the cut lands on the line boundary: ' + JSON.stringify(preview.text))
  assert.equal(preview.lineCount, 4, 'the line total is counted over the whole file, not the decoded prefix')
  assert.equal(preview.omittedLines, 3, 'every line below the cut counts as omitted')
  assert.equal(preview.truncated, true, 'a byte cut is a truncation')
}

// ── the line cap applies after decoding ─────────────────────────────────────
{
  const bytes = strToU8('#usda 1.0\na\nb\nc\n')
  const preview = previewLayer(bytes, { maxLines: 2 })
  assert.equal(preview.text, '#usda 1.0\na', 'only the first cap lines are kept')
  assert.equal(preview.lineCount, 5, 'the full line total is still reported')
  assert.equal(preview.omittedLines, 3, 'the cap counts the lines it did not show')
  assert.equal(preview.truncated, true)
}

// ── an overlong line is trimmed with an ellipsis and counted ───────────────
{
  // One 5000-character line stands in for the real case: an exporter's one-line
  // points array, where a full decode would be nine figures of characters.
  const bytes = strToU8('#usda 1.0 ' + 'x'.repeat(5000))
  const preview = previewLayer(bytes, { maxLineChars: 100 })
  assert.equal(preview.text.length, 102, 'the trimmed line keeps the cap plus the marker')
  assert.equal(preview.text.endsWith(' …'), true, 'a trimmed line is visibly cut')
  assert.equal(preview.longLinesTrimmed, 1, 'the trim is counted')
  assert.equal(preview.lineCount, 1, 'the full line count is still exact')
  assert.equal(preview.omittedLines, 0, 'trimming characters omits no line')
  assert.equal(preview.truncated, true, 'trimmed characters are truncation too')
}

// ── binary and package descriptors carry the reason, not a guess ───────────
{
  assert.deepEqual(previewLayer(crate), {
    kind: 'binary', container: 'crate', totalBytes: crate.length, reason: 'crate',
  }, 'a crate is reported as binary crate')
  assert.deepEqual(previewLayer(pkg), {
    kind: 'package', container: 'usdz', totalBytes: pkg.length, reason: 'package',
  }, 'a package is reported as a package')
  assert.deepEqual(previewLayer(new Uint8Array([0, 1, 2])), {
    kind: 'binary', container: 'unknown', totalBytes: 3, reason: 'unknown',
  }, 'unrecognised bytes are reported as unknown binary')
  assert.deepEqual(previewLayer(new Uint8Array(0)), {
    kind: 'binary', container: 'unknown', totalBytes: 0, reason: 'unknown',
  }, 'an empty file is unknown binary with zero bytes')
  // A caller that passes no options object at all still gets a valid preview.
  const preview = previewLayer(strToU8('#usda 1.0\n'), null)
  assert.equal(preview.kind, 'text', 'a null options object means the defaults')
}

// ── arbitrary bytes never throw: the panel must always get a state ────────
{
  for (let seed = 1; seed <= 120; seed += 1) {
    const bytes = pseudoRandomBytes(seed, seed * 7919)
    assert.ok(['usda', 'crate', 'usdz', 'unknown'].includes(layerKindOf(bytes)), 'every byte run classifies')
    const preview = previewLayer(bytes)
    assert.ok(preview.kind === 'text' || preview.kind === 'binary' || preview.kind === 'package', 'every preview has a kind')
    if (preview.kind === 'text') {
      assert.equal(typeof preview.text, 'string', 'a text preview always has string text')
      assert.ok(preview.lineCount >= 1, 'a text preview always has a line total')
      assert.ok(preview.omittedLines >= 0, 'omitted lines is never negative')
      assert.equal(preview.totalBytes, bytes.length, 'the byte total is the input length')
    }
    packageLayers(bytes)
  }
  // Text-looking prefixes with arbitrary (possibly invalid UTF-8) bodies: the
  // decode must replace bad sequences rather than throw.
  for (let seed = 1; seed <= 40; seed += 1) {
    const body = pseudoRandomBytes(seed * 13, seed)
    const bytes = new Uint8Array(body.length + 10)
    bytes.set(strToU8('#usda 1.0\n'))
    bytes.set(body, 10)
    const preview = previewLayer(bytes)
    assert.equal(typeof preview.text, 'string', 'invalid UTF-8 decodes with replacement characters')
  }
}

// ── a real package: the first layer in archive order is the root ───────────
{
  const expanded = packageLayers(pkg)
  assert.equal(expanded.rootKey, 'sample.usdc', 'the fixture package\'s root is its first layer')
  assert.equal(expanded.layers.length, 1, 'the fixture package holds exactly one layer')
  assert.equal(expanded.layers[0].key, 'sample.usdc')
  assert.deepEqual(expanded.layers[0].bytes, crate, 'the expanded layer bytes are the crate fixture bytes')
  assert.equal(expanded.omitted, 0)
}

// ── a non-zip, and a broken zip, are "nothing to expand" rather than throws ─
{
  assert.deepEqual(packageLayers(strToU8('#usda 1.0\n')), {
    rootKey: undefined, layers: [], omitted: 0,
  }, 'ASCII bytes are not a package')
  const broken = new Uint8Array([0x50, 0x4B, 0x03, 0x04, 0, 0, 0, 0])
  const expanded = packageLayers(broken)
  assert.deepEqual(expanded, { rootKey: undefined, layers: [], omitted: 0 }, 'a corrupt archive expands to nothing')
  assert.deepEqual(packageLayers(new Uint8Array(0)), { rootKey: undefined, layers: [], omitted: 0 })
}

// ── an in-memory package keeps only USD layers, in archive order ───────────
{
  const zipped = zipSync({
    'root.usda': strToU8('#usda 1.0\n'),
    'textures/albedo.png': strToU8([0x89, 0x50, 0x4E, 0x47]),
    'sub/geometry.USDA': strToU8('#usda 1.0\n\ndef Xform "G" {}\n'),
    'notes.txt': strToU8('not a layer'),
  })
  const expanded = packageLayers(zipped)
  assert.equal(expanded.rootKey, 'root.usda', 'the root is the first layer entry, not the first entry')
  assert.deepEqual(
    expanded.layers.map(layer => layer.key),
    ['root.usda', 'sub/geometry.USDA'],
    'only layer entries are kept and their archive order is preserved (suffix matched case-insensitively)',
  )
  assert.deepEqual(expanded.layers[0].bytes, strToU8('#usda 1.0\n'), 'the layer bytes come out as written')
  assert.deepEqual(expanded.layers[1].bytes, strToU8('#usda 1.0\n\ndef Xform "G" {}\n'))
  assert.equal(expanded.omitted, 0, 'textures and notes are not layer candidates, so they are not "omitted"')
}

// ── the entry cap and the byte budget bound the expansion ─────────────────
{
  const zipped = zipSync({
    'a.usda': strToU8('a'.repeat(20)),
    'b.usda': strToU8('b'.repeat(20)),
    'c.usda': strToU8('c'.repeat(20)),
  })
  const byEntries = packageLayers(zipped, { maxEntries: 2 })
  assert.deepEqual(byEntries.layers.map(layer => layer.key), ['a.usda', 'b.usda'], 'the entry cap keeps the first layers')
  assert.equal(byEntries.omitted, 1, 'the entry cap counts what it skipped')
  assert.equal(byEntries.rootKey, 'a.usda', 'the root is still named')

  const byBytes = packageLayers(zipped, { maxTotalBytes: 20 })
  assert.deepEqual(byBytes.layers.map(layer => layer.key), ['a.usda'], 'the byte budget stops after the first full layer')
  assert.equal(byBytes.omitted, 2, 'every layer the budget skipped is counted')
  assert.equal(byBytes.rootKey, 'a.usda', 'the root is named even when the budget stops the expansion')

  // The root layer itself can exceed the budget: it is named but never returned,
  // and that is reported instead of being silently swallowed.
  const rootTooBig = packageLayers(zipped, { maxTotalBytes: 5 })
  assert.equal(rootTooBig.rootKey, 'a.usda', 'the root is named from the archive, budget or not')
  assert.deepEqual(rootTooBig.layers, [], 'the budget keeps nothing it cannot afford')
  assert.equal(rootTooBig.omitted, 3, 'all three layers were over the budget')
}

// ── the lexer's colouring classes ──────────────────────────────────────────
{
  assert.deepEqual(tokenizeUsdaLine(''), [], 'an empty line has no tokens')
  assert.deepEqual(tokenizeUsdaLine('  \t '), [{ text: '  \t ', kind: 'space' }], 'a whitespace run is one token')
  assert.deepEqual(tokenizeUsdaLine('#usda 1.0'), [{ text: '#usda 1.0', kind: 'comment' }], 'a # comment runs to end of line')

  // '#' is a comment only outside a string or an asset path.
  assert.deepEqual(tokenizeUsdaLine('"a # b"'), [{ text: '"a # b"', kind: 'string' }], 'a # inside a string is not a comment')
  assert.deepEqual(tokenizeUsdaLine('@textures/a#b.png@'), [{ text: '@textures/a#b.png@', kind: 'asset' }], 'a # inside an asset path is not a comment')

  // Quotes are part of the string token, and a backslash escapes the quote.
  const escaped = tokenizeUsdaLine('"he said \\"hi\\""')
  assert.equal(escaped.length, 1, 'an escaped quote does not end the string')
  assert.equal(escaped[0].kind, 'string')
  assert.equal(escaped[0].text, '"he said \\"hi\\""', 'the string token keeps its escaped spelling')
  assert.equal(reconstruct(escaped), '"he said \\"hi\\""')

  // Keywords, identifiers, strings and punctuation in one statement.
  const defined = tokenizeUsdaLine('def Xform "World" {')
  assert.deepEqual(
    defined.map(token => token.kind),
    ['keyword', 'space', 'identifier', 'space', 'string', 'space', 'punct'],
    'def is a keyword, the prim name an identifier, the name a string, the brace punctuation',
  )
  assert.equal(reconstruct(defined), 'def Xform "World" {', 'the line reconstructs exactly')
  assert.equal(defined[4].text, '"World"', 'a string token keeps its quotes')

  for (const keyword of ['def', 'over', 'class', 'reorder', 'uniform', 'custom', 'varying', 'config', 'prepend', 'append', 'add', 'delete', 'rel', 'variantSet', 'None', 'true', 'false']) {
    assert.deepEqual(tokenizeUsdaLine(keyword), [{ text: keyword, kind: 'keyword' }], keyword + ' is a keyword')
  }
  assert.deepEqual(tokenizeUsdaLine('defaultPrim'), [{ text: 'defaultPrim', kind: 'identifier' }], 'a longer word is not a keyword')

  for (const spelling of ['0', '1', '-2', '+3', '3.5', '1e-3', '1.5E+2', '.5', '1.']) {
    assert.deepEqual(tokenizeUsdaLine(spelling), [{ text: spelling, kind: 'number' }], spelling + ' is one number token')
  }

  const punct = tokenizeUsdaLine('{}()[]=,;<>.:')
  assert.equal(punct.length, 13, 'every punctuation character is its own token')
  assert.ok(punct.every(token => token.kind === 'punct'), 'all of them are punctuation')
  assert.equal(reconstruct(punct), '{}()[]=,;<>.:', 'the punctuation sequence reconstructs exactly')

  // A statement mixing all classes keeps the space tokens the file wrote.
  const statement = tokenizeUsdaLine('  custom float3[] points = [(1, -2.5e+1, 3)] # the mesh')
  assert.equal(reconstruct(statement), '  custom float3[] points = [(1, -2.5e+1, 3)] # the mesh')
  assert.ok(statement.some(token => token.kind === 'comment'), 'the trailing comment is one token')
  assert.equal(statement[0].kind, 'space', 'the leading indentation is a space token')

  // Unterminated forms must still be total: they consume the rest of the line.
  assert.deepEqual(tokenizeUsdaLine('"unterminated'), [{ text: '"unterminated', kind: 'string' }], 'an unterminated string is a string token')
  assert.deepEqual(tokenizeUsdaLine('@unterminated'), [{ text: '@unterminated', kind: 'asset' }], 'an unterminated asset is an asset token')
  assert.deepEqual(tokenizeUsdaLine('@a@ # tail'), [
    { text: '@a@', kind: 'asset' }, { text: ' ', kind: 'space' }, { text: '# tail', kind: 'comment' },
  ], 'an asset ends at its closing @')

  assert.deepEqual(tokenizeUsdaLine(42), [], 'a non-string is not a line, and does not throw')
}

// ── the reconstruction invariant over deliberately awkward lines ───────────
{
  const lines = [
    '',
    ' ',
    '\t\t',
    '{}()[]=,;<>.:',
    '#usda 1.0',
    '# only a comment',
    'def Xform "World" {',
    '  float3[] points = [(1, 2, 3), (4, 5, 6)]',
    'rel material:binding = </root/_materials/M>',
    '@./tex.png@',
    '"a\\"b" and more',
    '@unterminated',
    '"unterminated',
    'x = -1.5e+3;',
    'odd chars \\ / * ? ! $ % & "',
    "'single quoted'",
    '\r',
    'a\u0000b',
    '\u6c49\u5b57 = 1',
    'trailing backslash \\',
  ]
  for (const line of lines) {
    const tokens = tokenizeUsdaLine(line)
    assert.equal(reconstruct(tokens), line, 'tokens must reproduce the input exactly: ' + JSON.stringify(line))
    assert.ok(tokens.every(token => token.text.length > 0), 'no token may be empty: ' + JSON.stringify(line))
  }
}

// ── random lines also reconstruct, and never throw ─────────────────────────
{
  const pool = 'ab_09 #"\\@{}()[]=,;<>.:+-eE\t\r\u6c49\u0000'
  for (let seed = 1; seed <= 300; seed += 1) {
    let line = ''
    const bytes = pseudoRandomBytes(seed % 40, seed)
    for (const byte of bytes) line += pool[byte % pool.length]
    const tokens = tokenizeUsdaLine(line)
    assert.equal(reconstruct(tokens), line, 'a random line still reconstructs: ' + JSON.stringify(line))
    assert.ok(tokens.every(token => token.text.length > 0), 'no token may be empty')
  }
}

// ── the line model is 1-based and keeps the trailing empty line ───────────
{
  const bytes = strToU8('#usda 1.0\ndef Xform "A" {\n}\n')
  const preview = previewLayer(bytes)
  const layout = usdaPreviewLines(preview)
  assert.equal(layout.rows.length, 4, 'the trailing newline yields a fourth, empty row')
  assert.deepEqual(layout.rows.map(row => row.number), [1, 2, 3, 4], 'row numbers are 1-based')
  assert.equal(layout.rows[0].text, '#usda 1.0')
  assert.equal(layout.rows[1].tokens[0].kind, 'keyword', 'each row carries its tokenised text')
  assert.equal(layout.rows[3].text, '', 'the final row is empty because the file ends in a newline')
  assert.deepEqual(layout.rows[3].tokens, [], 'an empty row has no tokens')
  assert.equal(layout.omitted, 0, 'nothing is omitted when the cap is not reached')

  const clipped = usdaPreviewLines(preview, { maxLines: 2 })
  assert.equal(clipped.rows.length, 2, 'the display cap trims the rows')
  assert.equal(clipped.omitted, 2, 'the display cap counts what it did not show')
  assert.deepEqual(clipped.rows.map(row => row.number), [1, 2])

  // A non-text preview has no lines to lay out.
  assert.deepEqual(usdaPreviewLines(previewLayer(crate)), { rows: [], omitted: 0 }, 'a crate has no text rows')
  assert.deepEqual(usdaPreviewLines(undefined), { rows: [], omitted: 0 }, 'a missing preview has no rows')
}
