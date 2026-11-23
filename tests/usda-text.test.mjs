/**
 * The USDA reconstruction renderer, in Node: does a decoded layer survive a trip
 * back through text?
 *
 * The Text mode shows an ASCII layer verbatim, but for a crate it can only show a
 * reconstruction. That makes one property load-bearing: what the renderer emits
 * must be readable by the same reader that produced the record, with the
 * declarations intact — otherwise the panel would show text that describes a
 * different layer. This suite pins that, and the rules a wrong implementation
 * would break silently:
 *
 *   * every prim path survives, with its declared type, specifier and apiSchemas;
 *   * every attribute keeps its declared type and its custom/uniform modifiers,
 *     and a declared-only attribute stays declared with no value;
 *   * relationship target paths survive (and an empty target list is omitted);
 *   * layer metadata survives: defaultPrim, metersPerUnit, upAxis, doc, subLayers,
 *     and a layer without metadata gets no metadata block at all;
 *   * composition arcs survive: a reference read from the fixture, and a
 *     hand-built payload/inherits/specializes/variantSets/variants record;
 *   * crate-shaped values — a flat Float32Array for point3f[] and a Float64Array
 *     for double3 — are regrouped into tuples by their declared width;
 *   * the prim tree is rebuilt from path prefixes with four spaces per depth, and
 *     over/class specifiers are preserved;
 *   * quoting: a string with a quote, a backslash and a '#'; a token with spaces;
 *     an asset with spaces; a string with a newline;
 *   * empty layers, empty arrays, empty dictionaries, bools, ints and floats do
 *     not crash and read back acceptably;
 *   * maxChars bounds the output and ends a cut rendering with its marker;
 *   * rendering never throws;
 *   * the output is **OpenUSD-valid**, not merely readable here: '#usda 1.0' is
 *     line 1 (USD rejects a leading comment), both modifiers are written
 *     custom-before-uniform, non-finite doubles are spelled inf / -inf / nan, and
 *     customData entries are typed (checked end-to-end with usdcat).
 *
 * The variant selection map is asserted both ways: the record must read back with
 * the same map, and the rendered text must carry one assignment per set, because a
 * reader that scans statements line by line cannot recover a map written as one
 * line. Every piece of prim metadata below round-trips through the reader.
 *
 * Run: node tests/usda-text.test.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AsciiLayerReader } from '../src/client/layer-text.js'
import { renderUsdaLayer } from '../src/client/usda-text.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = name => readFile(join(root, 'tests', 'fixtures', name), 'utf8')

/** Keep every attribute value while reading: the round trip is about values too. */
const KEEP_ALL = () => true

/** The marker a bounded rendering must end with. */
const TRUNCATION_MARKER = '# … output truncated'

/** Read one layer the way the Text mode's source record was produced. */
function readLayer(text) {
  const reader = new AsciiLayerReader(text, { keep: KEEP_ALL })
  const prims = reader.read()
  return { meta: reader.meta, prims }
}

/** A minimal prim record, so each test states only the fields it is about. */
function primOf(path, type = 'Xform', specifier = 'def') {
  return {
    path,
    type,
    specifier,
    apiSchemas: [],
    attrs: {},
    attrTypes: {},
    attrFlags: {},
    rels: {},
    meta: { variantSets: [] },
  }
}

/** The attribute names a record carries, declared or materialised. */
function attributeNames(prim) {
  return [...new Set([...Object.keys(prim.attrTypes), ...Object.keys(prim.attrs)])].sort()
}

// ── the whole fixture round-trips ──────────────────────────────────────────

const sampleText = await fixture('sample.usda')
const sample = readLayer(sampleText)
const sampleRendered = renderUsdaLayer(
  { meta: sample.meta, prims: sample.prims },
  { headerComment: 'RECONSTRUCTED USDA RENDERING — not the authored source' },
)
const sampleAgain = readLayer(sampleRendered)

{
  // The magic line must be first — OpenUSD's parser rejects an ASCII layer whose
  // first line is a comment ('not a valid usda layer' in usdcat) — and the
  // caller's label is a set of comments directly after it.
  assert.ok(
    sampleRendered.startsWith('#usda 1.0\n# RECONSTRUCTED USDA RENDERING — not the authored source\n'),
    'the magic must be line 1, with the reconstructed-text label after it',
  )
  assert.equal(sampleRendered.split('\n')[0], '#usda 1.0', 'no header comment may precede the magic line')

  // The prim tree's identity, order included: siblings are written in record
  // insertion order, so a layer read again must list the same paths in the same
  // order as the record it came from.
  assert.deepEqual([...sampleAgain.prims.keys()], [...sample.prims.keys()], 'every prim path must survive in the record order')

  for (const [path, prim] of sample.prims) {
    const again = sampleAgain.prims.get(path)
    assert.ok(again !== undefined, 'the rendered layer must still declare ' + path)
    assert.equal(again.type, prim.type, path + ': the declared prim type must survive')
    assert.equal(again.specifier, prim.specifier, path + ': def/over/class must survive')
    assert.deepEqual(again.apiSchemas, prim.apiSchemas, path + ': applied API schemas must survive')

    assert.deepEqual(attributeNames(again), attributeNames(prim), path + ': the attribute name set must survive')
    for (const name of Object.keys(prim.attrTypes)) {
      assert.equal(again.attrTypes[name], prim.attrTypes[name], path + '.' + name + ': the declared type must survive')
    }
    for (const name of attributeNames(prim)) {
      const source = prim.attrFlags[name] ?? {}
      const other = again.attrFlags[name] ?? {}
      assert.equal(other.custom === true, source.custom === true, path + '.' + name + ': custom must survive')
      assert.equal(other.uniform === true, source.uniform === true, path + '.' + name + ': uniform must survive')
    }

    // A relationship with targets must survive with exactly those targets; the
    // reader records [] for a rel it saw but could not resolve, and the renderer
    // deliberately omits those (there is no safe way to spell an empty target
    // list), so they are excluded from the expectation rather than lost silently.
    const expectedRels = {}
    for (const name of Object.keys(prim.rels)) {
      if (prim.rels[name].length === 0) continue
      expectedRels[name] = prim.rels[name]
    }
    assert.deepEqual(Object.keys(again.rels).sort(), Object.keys(expectedRels).sort(), path + ': relationship names must survive')
    for (const name of Object.keys(expectedRels)) {
      assert.deepEqual(again.rels[name], expectedRels[name], path + '.' + name + ': relationship targets must survive')
    }
  }

  // Layer metadata survives as authored.
  assert.equal(sampleAgain.meta.defaultPrim, 'root', 'defaultPrim must survive')
  assert.equal(sampleAgain.meta.metersPerUnit, 1, 'metersPerUnit must survive')
  assert.equal(sampleAgain.meta.upAxis, 'Z', 'upAxis must survive')
  assert.equal(sampleAgain.meta.doc, 'Blender v5.2.1 LTS', 'the layer doc must survive')

  // Spot values: a tuple array, a bool authored as 1, and a token.
  const cubeSource = sample.prims.get('/root/FixtureCube/Cube')
  const cubeAgain = sampleAgain.prims.get('/root/FixtureCube/Cube')
  assert.deepEqual(cubeAgain.attrs.points, cubeSource.attrs.points, 'point3f[] points must read back as the same tuples')
  assert.equal(Boolean(cubeSource.attrs.doubleSided), true, 'the ASCII fixture authors doubleSided as 1')
  assert.equal(cubeAgain.attrs.doubleSided, true, 'the reconstruction writes bools canonically (true), not as 1')
  assert.equal(cubeAgain.attrTypes.doubleSided, 'bool', 'the bool declared type is kept')
  assert.equal(sampleAgain.prims.get('/root').attrs['colorSpace:name'], 'lin_rec709_scene', 'a token value must read back')
  const materialAgain = sampleAgain.prims.get('/root/_materials/FixtureMaterial')
  assert.equal(materialAgain.attrs['colorSpace:name'], 'lin_rec709_scene', 'a token on a nested prim must read back')
  assert.ok(sampleRendered.includes('uniform token colorSpace:name = "lin_rec709_scene"'), 'a uniform token stays uniform')

  // A relationship target from the fixture survives verbatim.
  const binding = sample.prims.get('/root/FixtureCube/Cube').rels['material:binding']
  assert.deepEqual(binding, ['/root/_materials/FixtureMaterial'], 'the fixture binding is the expected target')
  assert.deepEqual(sampleAgain.prims.get('/root/FixtureCube/Cube').rels['material:binding'], binding, 'the relationship target must survive')
  assert.ok(sampleRendered.includes('rel material:binding = </root/_materials/FixtureMaterial>'), 'a single target is written bare')

  // Body order: attributes, then relationships, then child prims — the order a
  // USD reader scans, and the order the task's contract fixes.
  const cubeAttributeAt = sampleRendered.indexOf('uniform bool doubleSided = true')
  const cubeRelationAt = sampleRendered.indexOf('rel material:binding = </root/_materials/FixtureMaterial>')
  assert.ok(cubeAttributeAt >= 0 && cubeRelationAt > cubeAttributeAt, 'relationships are written after the prim attributes')
  const shaderAt = sampleRendered.indexOf('def Shader "Principled_BSDF"')
  assert.ok(shaderAt > sampleRendered.indexOf('token outputs:surface.connect'), 'child prims are written after the parent body')
}

// ── composition arcs: the fixture's prepend reference and subLayers ────────

{
  const arcs = readLayer(await fixture('arcs/root.usda'))
  const unit = arcs.prims.get('/root/unit')
  assert.deepEqual(arcs.meta.subLayers, ['./sub/base.usda'], 'the fixture layer declares one sublayer')
  assert.deepEqual(unit.meta.references, [{ asset: './ref/body.usda', prim: undefined }], 'the fixture prim prepends one reference')

  const rendered = renderUsdaLayer({ meta: arcs.meta, prims: arcs.prims })
  assert.ok(rendered.includes('subLayers = [@./sub/base.usda@]'), 'sublayers are written as @asset@ entries')
  assert.ok(rendered.includes('prepend references = @./ref/body.usda@'), 'a single reference is written bare')

  const again = readLayer(rendered)
  assert.deepEqual(again.meta.subLayers, arcs.meta.subLayers, 'sublayers must survive the round trip')
  assert.deepEqual(again.prims.get('/root/unit').meta.references, unit.meta.references, 'a reference arc must survive as { asset, prim }')
}

// ── composition arcs: a hand-built record with every arc and a prim path ───

{
  const prim = primOf('/root')
  prim.apiSchemas = ['MyAPI', 'OtherAPI']
  prim.meta = {
    kind: 'component',
    doc: 'arc fixture',
    variantSets: ['modeling', 'look'],
    variants: { modeling: 'simple', look: 'red' },
    inherits: ['/Base'],
    specializes: ['/SpecialA', '/SpecialB'],
    payload: [{ asset: './payload.usda', prim: '/Arm' }],
    references: [{ asset: './ref.usda' }, { asset: './other.usda', prim: '/Body' }],
  }
  const record = { meta: { defaultPrim: 'root' }, prims: new Map([['/root', prim]]) }
  const rendered = renderUsdaLayer(record)

  // Fixed order: the contract names it, and a reader scanning the block relies on
  // it being stable from layer to layer.
  const order = ['kind =', 'prepend apiSchemas =', 'doc =', 'customData =', 'variantSets =', 'variants =', 'inherits =', 'specializes =', 'prepend references =', 'prepend payload =']
  let at = -1
  for (const needle of order) {
    const found = rendered.indexOf(needle)
    if (needle === 'customData =') continue
    assert.ok(found > at, 'metadata must be written in the documented order; ' + needle + ' is out of place')
    at = found
  }

  assert.ok(rendered.includes('prepend references = [@./ref.usda@, @./other.usda@</Body>]'), 'a reference list is written as a list with prim paths')
  assert.ok(rendered.includes('prepend payload = @./payload.usda@</Arm>'), 'a payload with a prim path keeps it')
  assert.ok(rendered.includes('inherits = </Base>'), 'one inherits path is written bare')
  assert.ok(rendered.includes('specializes = [</SpecialA>, </SpecialB>]'), 'several specializes paths are written as a list')
  assert.ok(rendered.includes('variantSets = ["modeling", "look"]'), 'declared variant sets are written as a list')

  const again = readLayer(rendered).prims.get('/root')
  // The reader spells every arc { asset, prim }, with prim undefined when the arc
  // names none; the hand-built record states only what it means, so normalise it.
  const arcsAsRead = arcs => arcs.map(arc => ({ asset: arc.asset, prim: arc.prim }))
  assert.deepEqual(again.meta.references, arcsAsRead(prim.meta.references), 'references must survive as { asset, prim }')
  assert.deepEqual(again.meta.payload, arcsAsRead(prim.meta.payload), 'payload must survive as { asset, prim }')
  assert.deepEqual(again.meta.inherits, prim.meta.inherits, 'inherits must survive as paths')
  assert.deepEqual(again.meta.specializes, prim.meta.specializes, 'specializes must survive as paths')
  assert.deepEqual(again.meta.variantSets, prim.meta.variantSets, 'variant set names must survive')
  assert.equal(again.meta.kind, 'component', 'kind must survive')
  assert.equal(again.meta.doc, 'arc fixture', 'doc must survive')
  assert.deepEqual(again.apiSchemas, ['MyAPI', 'OtherAPI'], 'apiSchemas must survive')

  // The variant selection map survives as a map, and is written one assignment
  // per line: the text form and the read-back form are pinned together so a
  // future writer cannot satisfy one and break the other.
  assert.deepEqual(again.meta.variants, prim.meta.variants, 'the variant selection map must read back')
  assert.ok(rendered.includes('    variants = {'), 'the variants dictionary starts on its own metadata line')
  assert.ok(rendered.includes('        string modeling = "simple"'), 'a variant selection is one typed assignment per line')
  assert.ok(rendered.includes('        string look = "red"'), 'every variant set gets its own line')
}

// ── crate-shaped values: flat typed arrays regrouped by declared width ─────

{
  const prim = primOf('/Geometry', 'Mesh')
  const matrix = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
  const otherMatrix = matrix.map(value => value + 16)
  prim.attrs = {
    points: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]),
    translate: new Float64Array([1.5, 2.25, 3]),
    color: new Float32Array([0.5, 0.25, 0.75]),
    opacity: 0.123456789,
    xform: matrix,
    xforms: [matrix, otherMatrix],
  }
  prim.attrTypes = {
    points: 'point3f[]',
    translate: 'double3',
    color: 'color3f',
    opacity: 'float',
    xform: 'matrix4d',
    xforms: 'matrix4d[]',
  }
  const rendered = renderUsdaLayer({ meta: {}, prims: new Map([['/Geometry', prim]]) })

  // A crate keeps point3f[] as one flat Float32Array; the declared width is what
  // turns it back into the tuples the text grammar wants.
  assert.ok(rendered.includes('point3f[] points = [(0, 0, 0), (1, 0, 0), (1, 1, 0)]'), 'a flat point3f[] must regroup into tuples')
  assert.ok(rendered.includes('double3 translate = (1.5, 2.25, 3)'), 'a flat double3 must become one tuple')
  assert.ok(rendered.includes('color3f color = (0.5, 0.25, 0.75)'), 'a flat color3f must become one tuple')
  assert.ok(rendered.includes('float opacity = 0.123457'), 'a decimal is written to six significant digits, not float noise')
  assert.ok(rendered.includes('matrix4d xform = (' + matrix.join(', ') + ')'), 'a matrix is written as its 16 components')
  assert.ok(
    rendered.includes('matrix4d[] xforms = [(' + matrix.join(', ') + '), (' + otherMatrix.join(', ') + ')]'),
    'a list of matrices writes each matrix as its own tuple',
  )

  const again = readLayer(rendered).prims.get('/Geometry')
  assert.deepEqual(again.attrs.points, [[0, 0, 0], [1, 0, 0], [1, 1, 0]], 'the regrouped tuple values must read back')
  assert.deepEqual(again.attrs.translate, [1.5, 2.25, 3], 'the double3 components must read back as the original numbers')
  assert.deepEqual(again.attrs.color, [0.5, 0.25, 0.75], 'the color3f components must read back as the original numbers')
  assert.equal(again.attrs.opacity, Number(0.123456789.toPrecision(6)), 'the compact decimal must read back as the rounded number')
  assert.deepEqual(again.attrs.xform, matrix, 'the matrix components must read back in order')
  assert.deepEqual(again.attrs.xforms, [matrix, otherMatrix], 'each matrix element must read back as its own tuple')
}

// ── hierarchy, indentation, and over/class specifiers ──────────────────────

{
  const record = {
    meta: { upAxis: 'Y' },
    prims: new Map([
      ['/World', primOf('/World')],
      ['/World/Geometry', primOf('/World/Geometry', 'Scope')],
      ['/World/Geometry/Body', primOf('/World/Geometry/Body', 'Mesh')],
      ['/Faded', primOf('/Faded', '', 'over')],
      ['/Prototype', primOf('/Prototype', 'Xform', 'class')],
    ]),
  }
  const rendered = renderUsdaLayer(record)
  const lines = rendered.split('\n')

  // Four spaces per depth, and a parent's body opens before its child's line.
  assert.ok(lines.includes('def Xform "World"'), 'a root prim is written at depth 0')
  assert.ok(lines.includes('    def Scope "Geometry"'), 'a child prim is indented one level (4 spaces)')
  assert.ok(lines.includes('        def Mesh "Body"'), 'a grandchild prim is indented two levels (8 spaces)')
  assert.ok(lines.includes('over "Faded"'), 'an over with no type is written without a type token')
  assert.ok(lines.includes('class Xform "Prototype"'), 'a class specifier is preserved')
  // The innermost body closes at its own depth, then the parent's brace, then the
  // root's: the nesting, not just the indentation, has to be rebuilt from paths.
  const bodyAt = lines.indexOf('        def Mesh "Body"')
  assert.deepEqual(
    lines.slice(bodyAt, bodyAt + 4),
    ['        def Mesh "Body"', '        {', '        }', '    }'],
    'a grandchild body must close before its parent body',
  )
  assert.equal(lines[lines.length - 1], '}', 'the last prim closes its own brace at depth 0')

  const again = readLayer(rendered)
  // The shared reader registers a prim after reading its body, so its map is in
  // post-order; the tree below the roots is what this assertion is about.
  assert.deepEqual(
    [...again.prims.keys()],
    ['/World/Geometry/Body', '/World/Geometry', '/World', '/Faded', '/Prototype'],
    'the nested prim paths must read back at the tree depths they were written',
  )
  assert.ok(again.prims.has('/World/Geometry/Body'), 'the grandchild is a real prim, not a flat path')
  assert.equal(again.prims.get('/World/Geometry/Body').type, 'Mesh', 'a grandchild keeps its type')
  assert.equal(again.prims.get('/Faded').specifier, 'over', 'over must read back as over')
  assert.equal(again.prims.get('/Faded').type, '', 'an over prim authors no type')
  assert.equal(again.prims.get('/Prototype').specifier, 'class', 'class must read back as class')
}

// ── quoting: quotes, backslashes, hashes, spaces and newlines ──────────────

{
  const trick = primOf('/Quoted', 'Scope')
  trick.attrs = {
    comment: 'he said "hi" \\ and # tag',
    token: 'a token with spaces',
    assetPath: './my asset with spaces.usda',
    multiline: 'line one\nline two',
  }
  trick.attrTypes = { comment: 'string', token: 'token', assetPath: 'asset', multiline: 'string' }
  const rendered = renderUsdaLayer({ meta: {}, prims: new Map([['/Quoted', trick]]) })

  assert.ok(rendered.includes('\\"hi\\"'), 'a double quote inside a string must be backslash-escaped')
  assert.ok(rendered.includes('# tag'), 'a hash inside a quoted string is a literal, not a comment start')
  assert.ok(rendered.includes('@./my asset with spaces.usda@'), 'an asset is written with @ delimiters, spaces untouched')
  assert.ok(rendered.includes('\\n'), 'a newline inside a string must be escaped')

  const again = readLayer(rendered).prims.get('/Quoted')
  assert.equal(again.attrs.comment, 'he said "hi" \\ and # tag', 'quote, backslash and hash must read back exactly')
  assert.equal(again.attrs.token, 'a token with spaces', 'a token with spaces must read back exactly')
  assert.equal(again.attrs.assetPath, './my asset with spaces.usda', 'an asset path with spaces must read back exactly')
  assert.equal(again.attrs.multiline, 'line one\nline two', 'an escaped newline must read back as a newline')
}

// ── a declared-only attribute: type but no value ───────────────────────────

{
  const shader = primOf('/Shader', 'Shader')
  shader.attrTypes = { 'outputs:surface': 'token' }
  shader.attrFlags = { 'outputs:surface': { uniform: true } }
  const rendered = renderUsdaLayer({ meta: {}, prims: new Map([['/Shader', shader]]) })

  assert.ok(rendered.includes('\n    uniform token outputs:surface\n'), 'a declared-only attribute is written with no = and keeps its modifiers')
  assert.equal(rendered.includes('outputs:surface ='), false, 'a declared-only attribute must not gain an invented value')

  const again = readLayer(rendered).prims.get('/Shader')
  assert.equal(again.attrTypes['outputs:surface'], 'token', 'the declared type must survive')
  assert.equal(again.attrs['outputs:surface'], undefined, 'the attribute must stay declared without a value')
  assert.equal(again.attrFlags['outputs:surface']?.uniform === true, true, 'uniform must survive on a declared-only attribute')
}

// ── empty layers, and layers with no metadata ─────────────────────────────

{
  assert.equal(renderUsdaLayer({ meta: {}, prims: new Map() }), '#usda 1.0', 'an empty layer is just the header')
  assert.equal(renderUsdaLayer({ prims: [] }), '#usda 1.0', 'a record without meta is just the header')
  // The label goes after the magic line, never before it: OpenUSD only honours
  // '#usda' as the very first characters of the layer.
  assert.equal(
    renderUsdaLayer({ meta: {}, prims: new Map() }, { headerComment: ['first line', 'second line'] }),
    '#usda 1.0\n# first line\n# second line',
    'headerComment lines follow the magic line',
  )

  const noMeta = renderUsdaLayer({ meta: {}, prims: new Map([['/A', primOf('/A')]]) })
  assert.ok(noMeta.startsWith('#usda 1.0\n\n'), 'a layer without metadata keeps the header and one blank line')
  assert.equal(noMeta.includes('defaultPrim'), false, 'a layer without metadata gets no metadata block')
  assert.equal(noMeta.includes('\n(\n'), false, 'a layer without metadata must not open a header block')

  const withMeta = renderUsdaLayer({
    meta: {
      defaultPrim: 'root',
      metersPerUnit: 0.01,
      upAxis: 'A',
      startTimeCode: 1,
      endTimeCode: 24,
      timeCodesPerSecond: 24,
      doc: 'header test',
      subLayers: ['./a.usda', './b.usda'],
    },
    prims: new Map(),
  })
  // Fixed field order, numbers as numbers, strings quoted, sublayers a list.
  const expected = [
    '#usda 1.0',
    '(',
    '    defaultPrim = "root"',
    '    metersPerUnit = 0.01',
    '    upAxis = "A"',
    '    startTimeCode = 1',
    '    endTimeCode = 24',
    '    timeCodesPerSecond = 24',
    '    doc = "header test"',
    '    subLayers = [@./a.usda@, @./b.usda@]',
    ')',
  ].join('\n')
  assert.equal(withMeta, expected, 'the layer metadata block must be written in the documented order')
}

// ── maxChars: the output is bounded and says so ────────────────────────────

{
  const big = primOf('/Big', 'Mesh')
  for (let index = 0; index < 200; index += 1) {
    big.attrs['point' + index] = [index, index + 1, index + 2]
    big.attrTypes['point' + index] = 'float3'
  }
  const record = { meta: {}, prims: new Map([['/Big', big]]) }
  const full = renderUsdaLayer(record)
  assert.equal(full.includes(TRUNCATION_MARKER), false, 'an unbounded rendering is not marked truncated')
  assert.ok(full.length > 400, 'the fixture rendering must be longer than the bound')

  const bounded = renderUsdaLayer(record, { maxChars: 400 })
  assert.ok(bounded.length <= 400, 'maxChars must bound the returned string, got ' + bounded.length)
  assert.ok(bounded.endsWith(TRUNCATION_MARKER), 'a cut rendering must end with the truncation marker')
  assert.ok(bounded.startsWith('#usda 1.0'), 'the header survives truncation')
  assert.ok(bounded.length < full.length, 'the bound must actually cut the output')
}

// ── odd but legal values do not crash and read back acceptably ─────────────

{
  const odd = primOf('/Odd', 'Scope')
  odd.attrTypes = {
    boolValue: 'bool',
    intValue: 'int',
    floatValue: 'float',
    emptyList: 'int[]',
    emptyDict: 'dictionary',
    nullValue: 'token',
    dictValue: 'dictionary',
    pairs: 'float2[]',
    posInf: 'float',
    negInf: 'float',
    notANumber: 'float',
    largeInt: 'int64',
  }
  odd.attrs = {
    boolValue: true,
    intValue: 42,
    floatValue: 0.5,
    emptyList: [],
    emptyDict: {},
    nullValue: null,
    dictValue: { count: 2, name: 'x' },
    pairs: [[1, 2], [3, 4]],
    posInf: Infinity,
    negInf: -Infinity,
    notANumber: NaN,
    largeInt: 9007199254740993,
  }
  odd.rels = { targets: ['/A', '/B'], nothing: [] }
  odd.meta = {
    variantSets: ['modeling'],
    variants: { modeling: 'simple' },
    customData: {
      flags: { generated: true },
      count: 2,
      name: 'x',
      ratio: 0.5,
      samples: [1, 2, 3],
      labels: ['a', 'b'],
      points: [[0, 0, 0], [1, 1, 1]],
      missing: null,
    },
  }
  const record = { meta: { upAxis: 42, subLayers: [null, './kept.usda'] }, prims: new Map([['/Odd', odd]]) }

  let rendered = ''
  assert.doesNotThrow(() => {
    rendered = renderUsdaLayer(record)
  }, 'a record with odd values must not throw')
  assert.equal(typeof rendered, 'string', 'rendering must always return text')

  const again = readLayer(rendered)
  const prim = again.prims.get('/Odd')
  assert.equal(prim.attrs.boolValue, true, 'a bool reads back')
  assert.equal(prim.attrs.intValue, 42, 'an int reads back')
  assert.equal(prim.attrs.floatValue, 0.5, 'a float reads back')
  assert.deepEqual(prim.attrs.emptyList, [], 'an empty list reads back as an empty list')
  assert.deepEqual(prim.attrs.emptyDict, {}, 'an empty dictionary reads back as an empty dictionary')
  assert.equal(prim.attrs.nullValue, null, 'None reads back as null')
  assert.deepEqual(prim.attrs.dictValue, { count: 2, name: 'x' }, 'a dictionary value reads back')
  assert.deepEqual(prim.attrs.pairs, [[1, 2], [3, 4]], 'tuple elements read back as tuples')
  assert.deepEqual(prim.rels.targets, ['/A', '/B'], 'non-empty relationships read back')
  assert.deepEqual(Object.keys(prim.rels), ['targets'], 'an empty relationship is omitted, not written as an invalid form')
  assert.deepEqual(again.meta.subLayers, ['./kept.usda'], 'invalid sublayer entries are dropped, not rendered as null assets')
  assert.deepEqual(prim.meta.variantSets, ['modeling'], 'variant set names read back')

  // Non-finite doubles need USDA's own spellings: Infinity/NaN are not literals to
  // OpenUSD's parser, so a reconstructed layer carrying them would be invalid.
  assert.ok(rendered.includes('    float posInf = inf'), 'positive infinity is spelled inf')
  assert.ok(rendered.includes('    float negInf = -inf'), 'negative infinity is spelled -inf')
  assert.ok(rendered.includes('    float notANumber = nan'), 'NaN is spelled nan')
  assert.ok(rendered.includes('    int64 largeInt = ' + String(9007199254740993)), 'a large whole number keeps decimal digits, not an exponent')

  // customData is a metadata dictionary, so OpenUSD needs each entry typed and
  // nested dictionaries marked with the dictionary keyword; a None has no spelling
  // there and is reported as a comment instead of silently vanishing.
  assert.ok(rendered.includes('    customData = {'), 'customData opens a dictionary block')
  assert.ok(rendered.includes('        dictionary flags = {'), 'a nested dictionary keeps the dictionary keyword')
  assert.ok(rendered.includes('            bool generated = true'), 'an inferred bool entry is typed')
  assert.ok(rendered.includes('        int count = 2'), 'an inferred whole-number entry is int')
  assert.ok(rendered.includes('        string name = "x"'), 'an inferred string entry is typed')
  assert.ok(rendered.includes('        double ratio = 0.5'), 'an inferred decimal entry is double')
  assert.ok(rendered.includes('        double[] samples = [1, 2, 3]'), 'a numeric list entry is typed double[]')
  assert.ok(rendered.includes('        string[] labels = ["a", "b"]'), 'a string list entry is typed string[]')
  assert.ok(rendered.includes('        double3[] points = [(0, 0, 0), (1, 1, 1)]'), 'a tuple list entry is typed double3[]')
  assert.ok(
    rendered.includes('        # skipped missing = None: a dictionary value cannot be None'),
    'a None dictionary entry is reported as a comment inside the block',
  )

  // A record whose shape defeats the renderer still yields text, never a throw.
  const hostile = {
    meta: { doc: 7 },
    prims: new Map([['/Hostile', { path: '/Hostile', type: 9, apiSchemas: [null, 3], attrs: { weird: { deep: { deeper: { deepest: 1 } } } }, attrTypes: { weird: 'dictionary' }, rels: { r: 5 }, meta: { kind: 3, customData: { list: [1, 2] } } }]]),
  }
  let hostileText = ''
  assert.doesNotThrow(() => {
    hostileText = renderUsdaLayer(hostile)
  }, 'an unexpected record shape must not throw')
  assert.ok(hostileText.startsWith('#usda 1.0'), 'a hostile record still renders the header first')

  const cyclic = { name: 'loop' }
  cyclic.self = cyclic
  assert.doesNotThrow(() => {
    renderUsdaLayer({ meta: {}, prims: new Map([['/Cycle', { path: '/Cycle', type: 'Scope', attrs: { value: cyclic }, attrTypes: { value: 'dictionary' }, meta: {} }]]) })
  }, 'a cyclic dictionary must not recurse the renderer to death')
}

// ── an orphan and a variant-selection path are commented, not invented ────

{
  const record = {
    meta: {},
    prims: new Map([
      ['/Loose', primOf('/Loose', 'Scope')],
      ['/MissingParent/Child', primOf('/MissingParent/Child', 'Mesh')],
      ['/MissingParent/Child/Leaf', primOf('/MissingParent/Child/Leaf', 'Mesh')],
      ['/root{v=simple}', primOf('/root{v=simple}', 'Scope')],
      ['/root{v=simple}/mesh', primOf('/root{v=simple}/mesh', 'Mesh')],
    ]),
  }
  const rendered = renderUsdaLayer(record)
  assert.ok(rendered.includes('# skipped /MissingParent/Child: its parent chain is not in the record'), 'an orphan is reported, not silently re-rooted')
  assert.ok(rendered.includes('# skipped /MissingParent/Child/Leaf: its parent chain is not in the record'), 'a recorded descendant of an orphan is reported too')
  assert.ok(rendered.includes('# skipped /root{v=simple}: a variant selection path is not a prim name'), 'a variant-selection path is skipped with a comment')
  assert.equal(rendered.includes('/root{v=simple}/mesh'), false, 'the subtree under a variant selection is omitted with it')
  assert.ok(rendered.includes('def Scope "Loose"'), 'a normal root prim still renders beside them')

  const again = readLayer(rendered)
  assert.deepEqual([...again.prims.keys()], ['/Loose'], 'neither an orphan nor a variant path may become a prim of a different path')
}

// ── attribute order, empty metadata, and the two prim-container shapes ─────

{
  const ordered = primOf('/Ordered', 'Scope')
  ordered.attrTypes = { first: 'int', second: 'int' }
  ordered.attrs = { second: 2, first: 1, extra: 3 }
  ordered.attrFlags = { first: { uniform: true }, second: { custom: true, uniform: true } }
  ordered.meta = { active: 0, instanceable: 1, customData: {} }
  const rendered = renderUsdaLayer({ meta: {}, prims: new Map([['/Ordered', ordered]]) })
  const lines = rendered.split('\n')

  const firstAt = lines.indexOf('    uniform int first = 1')
  // OpenUSD's parser accepts only custom-before-uniform; the reverse order is a
  // syntax error ('Expected }'), so the reconstruction must not write it.
  const secondAt = lines.indexOf('    custom uniform int second = 2')
  const extraAt = lines.indexOf('    int extra = 3')
  assert.ok(firstAt >= 0, 'a declared attribute is written with its type and modifiers')
  assert.ok(secondAt > firstAt, 'declared attributes are written in attrTypes order, not record order')
  assert.equal(lines.includes('    uniform custom int second = 2'), false, 'uniform before custom must never be emitted')
  assert.ok(extraAt > secondAt, 'an attribute with no declared type follows the declared ones')
  assert.ok(lines.includes('    active = false'), 'an ASCII active = 0 is reconstructed as the false it means')
  assert.ok(lines.includes('    instanceable = true'), 'an ASCII instanceable = 1 is reconstructed as the true it means')
  assert.equal(rendered.includes('customData'), false, 'an empty customData dictionary is omitted')

  // Both modifiers on one attribute round-trip through the reader.
  const flagsBack = readLayer(rendered).prims.get('/Ordered').attrFlags
  assert.equal(flagsBack.first.uniform === true, true, 'uniform survives')
  assert.equal(flagsBack.second.custom === true, true, 'custom survives')
  assert.equal(flagsBack.second.uniform === true, true, 'custom + uniform both survive')

  // A PrimRecord[] record is the same layer as the Map form.
  const mapRendered = renderUsdaLayer({ meta: {}, prims: new Map([['/A', primOf('/A')]]) })
  const arrayRendered = renderUsdaLayer({ meta: {}, prims: [primOf('/A')] })
  assert.equal(arrayRendered, mapRendered, 'a PrimRecord[] record renders exactly like the Map form')
}

console.log('usda-text: all pinned behaviours pass')
