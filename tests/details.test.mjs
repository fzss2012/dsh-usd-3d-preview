/**
 * The prim-details reader, in Node: what the stage *declares* about one prim.
 *
 * This is the half of the feature a screenshot cannot check: whether the panel's
 * table is the file's table. The rules this suite pins down are the ones a wrong
 * implementation would break silently:
 *
 *   * the declared type, `kind`, specifier and `apiSchemas` of a prim;
 *   * every authored attribute with its **declared** type (`point3f[]`, not
 *     "array"), its `custom` / `uniform` modifiers, and its value — including
 *     `custom` attributes a composed three graph never keeps;
 *   * relationships with their resolved target paths;
 *   * ASCII and crate agree on the same stage (the parity this repository already
 *     holds its parsers to);
 *   * a long array is summarised by its true element count and never fully
 *     materialised — the property that keeps a 90 MiB robot's layer cheap;
 *   * a prim no layer describes is reported as absent rather than as empty, and a
 *     stage with no layer bytes asks for none of this at all;
 *   * the panel's presentation rules: the leading attributes first, big arrays
 *     formatted as `[N values] …`.
 *
 * Run: node tests/details.test.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { USDCParser } from 'three/examples/jsm/loaders/usd/USDCParser.js'
import {
  elementWidthOf, formatValue, isTextLayer, orderAttributes, readPrimDetails,
} from '../src/client/details.js'
import { AsciiLayerReader } from '../src/client/layer-text.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = name => readFile(join(root, 'tests', 'fixtures', name))

const ascii = await fixture('sample.usda')
const crate = await fixture('sample.usdc')
const door = await fixture('joints/door.usda')

/** Read one prim out of one layer. */
function detailsOf(bytes, path, key = 'layer.usda') {
  return readPrimDetails(new Map([[key, bytes]]), path, { parseCrate: USDCParser })
}

/** The attribute record for one name, or undefined. */
function attribute(details, name) {
  return details.attributes.find(entry => entry.name === name)
}

// ── an ASCII prim, read back as declared ─────────────────────────────────────
{
  const details = await detailsOf(ascii, '/root/FixtureCube/Cube')
  assert.equal(details.present, true, 'the fixture prim must be found')
  assert.equal(details.path, '/root/FixtureCube/Cube')
  assert.equal(details.name, 'Cube', 'the display name is the last path component')
  assert.equal(details.specifier, 'def')
  assert.deepEqual(details.layers, ['layer.usda'], 'the reading layer is named')
  assert.equal(details.kind, '', 'the fixture does not author a kind')

  // The declared types, not the values' JavaScript types: a `point3f[]` is an
  // array of tuples here and one flat Float32Array in a crate, and the panel must
  // say the same thing about both.
  assert.equal(attribute(details, 'points').type, 'point3f[]')
  assert.equal(attribute(details, 'faceVertexCounts').type, 'int[]')
  assert.equal(attribute(details, 'subdivisionScheme').type, 'token')
  assert.equal(attribute(details, 'doubleSided').type, 'bool')
  assert.equal(attribute(details, 'primvars:st').type, 'texCoord2f[]')
  assert.equal(attribute(details, 'userProperties:blender:data_name').type, 'string')

  // A `custom` attribute is one the composed graph never keeps — it is exactly
  // what this panel exists to show.
  const custom = details.attributes.filter(entry => entry.custom === true).map(entry => entry.name)
  assert.ok(custom.includes('userProperties:blender:data_name'), 'custom attributes must be listed: ' + custom.join(', '))
  assert.equal(attribute(details, 'userProperties:blender:data_name').custom, true, 'a custom attribute is reported as custom')
  assert.equal(attribute(details, 'points').custom, false, 'a builtin attribute is not reported as custom')

  // A relationship is listed with its resolved target, not as a string.
  const binding = details.relationships.find(entry => entry.name === 'material:binding')
  assert.ok(binding !== undefined, 'the material binding must be listed')
  assert.deepEqual(binding.targets, ['/root/_materials/FixtureMaterial'])

  // apiSchemas come from the prim metadata, in authored order.
  assert.deepEqual(details.apiSchemas, ['MaterialBindingAPI'])
}

// ── a prim with no attributes at all is still described ─────────────────────
{
  const details = await detailsOf(ascii, '/root')
  assert.equal(details.present, true)
  assert.equal(details.type, 'Xform')
  assert.deepEqual(details.apiSchemas, ['ColorSpaceAPI'], 'a prepended schema on an Xform is kept')
  assert.ok(details.attributes.length >= 1, 'the prim authors at least its colorSpace token')
}

// ── ASCII and crate agree on the same stage ─────────────────────────────────
{
  const fromAscii = await detailsOf(ascii, '/root/FixtureCube/Cube', 'sample.usda')
  const fromCrate = await detailsOf(crate, '/root/FixtureCube/Cube', 'sample.usdc')
  assert.deepEqual(
    fromCrate.attributes.map(entry => entry.name),
    fromAscii.attributes.map(entry => entry.name),
    'both containers must list the same attributes in the same order',
  )
  for (const entry of fromAscii.attributes) {
    const other = attribute(fromCrate, entry.name)
    assert.ok(other !== undefined, 'crate is missing ' + entry.name)
    assert.equal(other.type, entry.type, entry.name + ': the declared type must not depend on the container')
    // Values are compared through the display form: a crate's Float32Array and an
    // ASCII tuple array are the same numbers, and the panel shows one string.
    assert.equal(other.value, entry.value, entry.name + ': the value must not depend on the container')
  }
  assert.deepEqual(fromCrate.apiSchemas, fromAscii.apiSchemas, 'applied schemas must agree across containers')
  assert.deepEqual(
    fromCrate.relationships.map(entry => [entry.name, entry.targets]),
    fromAscii.relationships.map(entry => [entry.name, entry.targets]),
  )
}

// ── a long array is counted, not parsed ────────────────────────────────────
{
  // The sphere's point array is far above the preview threshold in both
  // containers; the panel states its true size and shows only the head.
  const fromAscii = await detailsOf(ascii, '/root/FixtureSphere/Sphere')
  const fromCrate = await detailsOf(crate, '/root/FixtureSphere/Sphere')
  const pointsAscii = attribute(fromAscii, 'points')
  const pointsCrate = attribute(fromCrate, 'points')
  assert.ok(pointsAscii.arraySize > 100, 'the sphere must exercise the summarising path: ' + pointsAscii.arraySize)
  assert.equal(pointsCrate.arraySize, pointsAscii.arraySize, 'the element count must agree across containers')
  assert.match(pointsAscii.value, new RegExp(`^\\[${pointsAscii.arraySize} values\\] `), 'a long array reports its size: ' + pointsAscii.value.slice(0, 40))
  assert.match(pointsCrate.value, new RegExp(`^\\[${pointsCrate.arraySize} values\\] `))
  // The type still says what the elements are.
  assert.equal(pointsAscii.type, 'point3f[]')
}

// ── the reader summarises on the count, not on the byte size ───────────────
{
  // A tuple array whose elements are themselves tuples: the element count is the
  // number of tuples, not the number of numbers — the exact distinction a
  // comma-counting implementation gets wrong.
  const text = `#usda 1.0
def Mesh "M"
{
    float3[] v = [(1, 2, 3), (4, 5, 6), (7, 8, 9), (10, 11, 12), (13, 14, 15), (16, 17, 18)]
    int[] small = [1, 2]
    int[] empty = []
}
`
  const reader = new AsciiLayerReader(text, { keep: () => true, arrayHead: 2 })
  const prims = reader.read()
  const prim = prims.get('/M')
  assert.equal(prim.arraySizes.v, 6, 'the element count is the tuple count, not the component count')
  assert.deepEqual(prim.attrs.v, [[1, 2, 3], [4, 5, 6]], 'the head is a whole number of elements')
  assert.equal(prim.arraySizes.small, undefined, 'an array at or below the preview size is kept whole')
  assert.deepEqual(prim.attrs.small, [1, 2])
  assert.equal(prim.arraySizes.empty, undefined)
  assert.deepEqual(prim.attrs.empty, [], 'an empty array is empty, not missing')

  const details = await readPrimDetails(new Map([['t.usda', new TextEncoder().encode(text)]]), '/M')
  assert.equal(attribute(details, 'v').value, '[6 values] (1, 2, 3), (4, 5, 6), (7, 8, 9), (10, 11, 12), …')
  assert.equal(attribute(details, 'v').arraySize, 6)
}

// ── a prim no layer describes, and a stage with no bytes ───────────────────
{
  const missing = await detailsOf(ascii, '/root/NotThere')
  assert.equal(missing.present, false, 'a prim no layer describes is reported as absent, not as empty')
  assert.equal(missing.name, 'NotThere', 'the path still yields a name to show')
  assert.deepEqual(missing.attributes, [])
  assert.deepEqual(missing.layers, [])
}

// ── a crate-only stage: the declared types survive the binary container ────
{
  const details = await detailsOf(crate, '/root/_materials/FixtureMaterial/Principled_BSDF', 'sample.usdc')
  assert.equal(details.type, 'Shader')
  assert.equal(attribute(details, 'info:id').type, 'token')
  assert.equal(attribute(details, 'info:id').value, 'UsdPreviewSurface')
  assert.equal(attribute(details, 'inputs:difficulty'), undefined, 'the fixture has no such input')
  assert.equal(attribute(details, 'inputs:roughness').type, 'float')
  assert.equal(attribute(details, 'inputs:diffuseColor').type, 'color3f')
}

// ── physics declarations are what a SimReady reader looks for ─────────────
{
  const details = await detailsOf(door, '/Door/hinge', 'door.usda')
  assert.equal(details.type, 'PhysicsRevoluteJoint')
  assert.deepEqual(details.apiSchemas, ['PhysicsDriveAPI:angular'], 'a namespaced API schema is kept whole')
  assert.equal(attribute(details, 'physics:axis').type, 'token')
  assert.equal(attribute(details, 'physics:axis').value, 'Y')
  assert.equal(attribute(details, 'physics:lowerLimit').type, 'float')
  assert.equal(attribute(details, 'physics:lowerLimit').value, '-90')
  const body0 = details.relationships.find(entry => entry.name === 'physics:body0')
  assert.ok(body0 !== undefined, 'joint bodies are relationships')
  assert.deepEqual(body0.targets, ['/Door/Bodies/frame'])

  // The collider hull: its `purpose = "guide"` is the reason the engine never
  // draws it, and the details panel is where that becomes visible.
  const hull = await detailsOf(door, '/Door/Bodies/frame/leaf/collision/c0000')
  assert.equal(attribute(hull, 'purpose').value, 'guide')
  assert.ok(hull.apiSchemas.includes('PhysicsCollisionAPI'))
}

// ── presentation rules ─────────────────────────────────────────────────────
{
  // The leading attributes come first in usdview's order, then namespaced ones,
  // then everything else; names sort within a band.
  const ordered = orderAttributes(['zeta', 'physics:mass', 'points', 'xformOp:translate', 'alpha'])
  assert.equal(ordered[0], 'xformOp:translate', 'the transform leads, as it does in usdview: ' + ordered.join(', '))
  assert.ok(ordered.indexOf('points') < ordered.indexOf('physics:mass'), 'geometry before physics')
  assert.ok(ordered.indexOf('physics:mass') < ordered.indexOf('alpha'), 'namespaces before loose names')
  assert.deepEqual(orderAttributes(['b', 'a']), ['a', 'b'])

  assert.equal(elementWidthOf('point3f'), 3)
  assert.equal(elementWidthOf('texCoord2f'), 2)
  assert.equal(elementWidthOf('color4h'), 4)
  assert.equal(elementWidthOf('quatf'), 4)
  assert.equal(elementWidthOf('float'), 1)
  assert.equal(elementWidthOf('int[]'), 1, 'the suffix is not part of the width')
  assert.equal(elementWidthOf('matrix4d'), 1, 'a matrix is one value, not sixteen')

  assert.equal(formatValue([1, 2, 3], 'int[]'), '[1, 2, 3]')
  assert.equal(formatValue([1.5], 'float[]'), '[1.5]')
  assert.equal(formatValue([(1 / 3)], 'float[]'), '[0.333333]', 'a float32 is shown at authored precision')
  assert.equal(formatValue(null, 'token'), 'None')
  assert.equal(formatValue(true, 'bool'), 'true')
  assert.equal(formatValue([[0.5, 0.25]], 'texCoord2f[]'), '[(0.5, 0.25)]')
  assert.equal(formatValue(undefined, 'token'), 'token', 'a declared-but-unset attribute shows its type')
  assert.equal(formatValue([1, 2, 3, 4, 5], 'int[]', 4096), '[4096 values] 1, 2, 3, 4, …')
}

// ── attributes with no value keep their declared type ─────────────────────
{
  const text = `#usda 1.0
def Xform "X"
{
    uniform token foo
    custom string bar = "set"
}
`
  const details = await readPrimDetails(new Map([['t.usda', new TextEncoder().encode(text)]]), '/X')
  const foo = attribute(details, 'foo')
  assert.ok(foo !== undefined, 'an attribute with no value is still declared')
  assert.equal(foo.type, 'token')
  assert.equal(foo.uniform, true, 'its uniform modifier is kept')
  assert.equal(attribute(details, 'bar').custom, true)
}

// ── a prim a reference re-roots is found under its composed path ───────────
{
  // The viewport names a mesh by the path the *stage* composes; the layer that
  // describes it wrote a different one. This is the case that made the panel say
  // "no layer describes that prim" for every referenced asset.
  const unit = await fixture('refs/unit.usda')
  const geom = await fixture('refs/geom/body.usda')
  const sources = new Map([['unit.usda', unit], ['geom/body.usda', geom]])
  const composed = await readPrimDetails(sources, '/root/unit/body', { parseCrate: USDCParser })
  assert.equal(composed.present, true, 'a referenced prim must be found under its composed path')
  assert.equal(composed.type, 'Mesh', 'the composed prim keeps the referenced layer\'s type')
  assert.equal(composed.authoredPath, '/root/body', 'the layer\'s own path is reported beside the stage path')
  assert.deepEqual(composed.layers, ['geom/body.usda'], 'the referenced layer is the one that describes it')
  // The layer that wrote the value is named per attribute, not per prim.
  for (const entry of composed.attributes) {
    assert.equal(entry.layer, 'geom/body.usda', entry.name + ' must be attributed to the layer that wrote it')
  }
  // The referencing prim itself is still described by its own layer.
  const wrapper = await readPrimDetails(sources, '/root/unit', { parseCrate: USDCParser })
  assert.equal(wrapper.present, true)
  assert.equal(wrapper.authoredPath, '/root/unit')
  assert.equal(wrapper.layers.includes('unit.usda'), true, 'the referencing layer describes its own prim')
  // A path no arc explains is not invented.
  const absent = await readPrimDetails(sources, '/root/body', { parseCrate: USDCParser })
  assert.equal(absent.present, false, 'the referenced layer is not reachable by its own path at stage scope')
}

// ── a sublayer composes at the same path, and is still a describing layer ───
{
  const root = await fixture('arcs/root.usda')
  const base = await fixture('arcs/sub/base.usda')
  const body = await fixture('arcs/ref/body.usda')
  const sources = new Map([['arcs/root.usda', root], ['arcs/sub/base.usda', base], ['arcs/ref/body.usda', body]])
  const floor = await readPrimDetails(sources, '/base/floor', { parseCrate: USDCParser })
  assert.equal(floor.present, true, 'a prim from a sublayer must be found')
  assert.deepEqual(floor.layers, ['arcs/sub/base.usda'], 'the sublayer is named as the describing layer')
  assert.equal(floor.type, 'Mesh')
  const referenced = await readPrimDetails(sources, '/root/unit/body', { parseCrate: USDCParser })
  assert.equal(referenced.present, true, 'a reference under a sublayered stage resolves too')
  assert.equal(referenced.authoredPath, '/root/body')
  assert.deepEqual(referenced.layers, ['arcs/ref/body.usda'])
}

// ── a UTF-8 BOM is a text layer, not an unreadable one ──────────────────────
{
  // A BOM is what a Windows editor writes by default. Refusing the layer it
  // prefixes does not fail loudly — it silently empties every prim.
  const text = '\uFEFF#usda 1.0\n(\n    defaultPrim = "root"\n)\n\ndef Mesh "M"\n{\n    float radius = 2\n}\n'
  const bytes = new TextEncoder().encode(text)
  assert.equal(isTextLayer(bytes), true, 'a BOM-prefixed layer is still a text layer')
  const details = await readPrimDetails(new Map([['bom.usda', bytes]]), '/M')
  assert.equal(details.present, true, 'a BOM must not hide the prims behind it')
  assert.equal(attribute(details, 'radius').value, '2')
}

// ── the declared kind survives the round trip ──────────────────────────────
{
  // The header advertises "kind", so it has to be read: a reader that hard-coded
  // an empty string would pass every other assertion in this file.
  const text = '#usda 1.0\ndef Xform "A" (\n    kind = "component"\n)\n{\n}\ndef Xform "B"\n{\n}\n'
  const sources = new Map([['k.usda', new TextEncoder().encode(text)]])
  const withKind = await readPrimDetails(sources, '/A')
  const without = await readPrimDetails(sources, '/B')
  assert.equal(withKind.kind, 'component', 'the authored kind must be reported')
  assert.equal(without.kind, '', 'a prim with no kind reports none')
}

// ── a stage with no layer bytes is a distinct answer from a missing prim ────
{
  // The panel draws three different things for these: "cannot be read back"
  // (undefined), "no layer describes it" (present: false) and a table.
  const empty = await readPrimDetails(new Map(), '/a/b')
  assert.equal(empty.present, false, 'no layers means no prim, not an error')
  assert.deepEqual(empty.layers, [])
  assert.deepEqual(empty.attributes, [])
  const unreadable = await readPrimDetails(new Map([['x.usda', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])]]), '/a/b')
  assert.equal(unreadable.present, false, 'a layer this reader cannot decode contributes nothing')
}

// ── complete composition arcs: references, payloads, inherits, specializes,
//    variant sets, and the layer each arc came from ───────────────────────────
{
  const root = await fixture('arcs/full.usda')
  const body = await fixture('arcs/ref/body.usda')
  const other = await fixture('arcs/ref/other.usda')
  const base = await fixture('arcs/sub/base.usda')
  const heavy = await fixture('arcs/payload/heavy.usda')
  const sources = new Map([
    ['arcs/full.usda', root],
    ['arcs/ref/body.usda', body],
    ['arcs/ref/other.usda', other],
    ['arcs/sub/base.usda', base],
    ['arcs/payload/heavy.usda', heavy],
  ])
  const details = await readPrimDetails(sources, '/root', { parseCrate: USDCParser })
  assert.equal(details.present, true)

  // References: one names no prim (it composes the layer's defaultPrim) and one
  // names </Other>; both name the layer that actually held the target.
  assert.deepEqual(
    details.references.map(arc => [arc.kind, arc.asset, arc.prim, arc.targetLayer, arc.targetPrim]),
    [
      ['reference', './ref/body.usda', '', 'arcs/ref/body.usda', '/root'],
      ['reference', './ref/other.usda', '/Other', 'arcs/ref/other.usda', '/Other'],
    ],
    'every reference, its composed prim and its resolved layer must be reported',
  )
  assert.deepEqual(
    details.payloads.map(arc => [arc.kind, arc.asset, arc.prim, arc.targetLayer, arc.targetPrim]),
    [['payload', './payload/heavy.usda', '/Heavy', 'arcs/payload/heavy.usda', '/Heavy']],
    'a payload is an arc too, with its own list',
  )
  assert.equal(details.references[0].layer, 'arcs/full.usda', 'the layer that authored an arc is named')
  assert.deepEqual(details.inherits, ['/Base'])
  assert.deepEqual(details.specializes, ['/Special'])

  // Variant sets carry both their declared variants and the authored selection —
  // the two things a reader needs to know which variant the stage is showing.
  assert.deepEqual(details.variantSets, ['modeling', 'look'])
  assert.deepEqual(details.variantNames, { modeling: ['simple', 'fancy'], look: ['red', 'blue'] })
  assert.deepEqual(details.variantSelections, { modeling: 'simple', look: 'red' })

  // Every describing layer is named with the arc that reached it: the root, the
  // reference target, the other reference target and the payload target all
  // describe this prim through different arcs.
  const arcsByKind = details.layerArcs.map(arc => [arc.key, arc.kind])
  assert.deepEqual(arcsByKind, [
    ['arcs/full.usda', 'root'],
    ['arcs/ref/body.usda', 'reference'],
    ['arcs/ref/other.usda', 'reference'],
    ['arcs/payload/heavy.usda', 'payload'],
  ], 'a layer list without provenance cannot answer which arc placed a layer: ' + JSON.stringify(arcsByKind))
  const referenceArc = details.layerArcs.find(arc => arc.kind === 'reference')
  assert.equal(referenceArc.from, 'arcs/full.usda')
  assert.equal(referenceArc.fromPath, '/root')
  assert.equal(referenceArc.asset, './ref/body.usda')

  // A prim inside the referenced layer is found under its composed path, and its
  // describing layer says so through the reference arc.
  const unitBody = await readPrimDetails(sources, '/root/unit/body', { parseCrate: USDCParser })
  assert.equal(unitBody.present, true, 'a prim under a reference is found by its composed path')
  assert.deepEqual(unitBody.layers, ['arcs/ref/body.usda'])
  assert.deepEqual(unitBody.layerArcs.map(arc => [arc.kind, arc.fromPath]), [['reference', '/root/unit']])
}

// ── a crate declares the same arcs, decoded from the binary tables ─────────
{
  const crateFull = await fixture('arcs/full.usdc')
  const asciiFull = await fixture('arcs/full.usda')
  const sources = new Map([
    ['arcs/full.usdc', crateFull],
    ['arcs/ref/body.usda', await fixture('arcs/ref/body.usda')],
    ['arcs/ref/other.usda', await fixture('arcs/ref/other.usda')],
    ['arcs/sub/base.usda', await fixture('arcs/sub/base.usda')],
    ['arcs/payload/heavy.usda', await fixture('arcs/payload/heavy.usda')],
  ])
  const fromCrate = await readPrimDetails(sources, '/root', { parseCrate: USDCParser })
  assert.equal(fromCrate.present, true)
  assert.deepEqual(
    fromCrate.references.map(arc => [arc.asset, arc.prim, arc.targetLayer]),
    [
      ['./ref/body.usda', '', 'arcs/ref/body.usda'],
      ['./ref/other.usda', '/Other', 'arcs/ref/other.usda'],
    ],
    'the reference list-op three skips must be decoded from the crate',
  )
  assert.deepEqual(fromCrate.payloads.map(arc => [arc.asset, arc.prim]), [['./payload/heavy.usda', '/Heavy']])
  assert.deepEqual(fromCrate.inherits, ['/Base'], 'the crate field inheritPaths is spelled inherits to a reader')
  assert.deepEqual(fromCrate.specializes, ['/Special'])
  assert.deepEqual(fromCrate.variantSets, ['modeling', 'look'], 'variantSetNames is a string list-op')
  assert.deepEqual(fromCrate.variantSelections, { modeling: 'simple', look: 'red' }, 'the variant selection map survives')
  assert.deepEqual(fromCrate.variantNames, {}, 'a crate names its sets but this fixture declares no variant specs to enumerate')

  // The same stage in the two containers answers the same arcs.
  const fromAscii = await readPrimDetails(new Map([...sources].map(([key, value]) => [key.replace('full.usdc', 'full.usda'), value])), '/root', { parseCrate: USDCParser })
  assert.deepEqual(fromCrate.references.map(arc => [arc.asset, arc.prim, arc.targetLayer]), fromAscii.references.map(arc => [arc.asset, arc.prim, arc.targetLayer]))
  assert.deepEqual(fromCrate.payloads.map(arc => arc.asset), fromAscii.payloads.map(arc => arc.asset))
  assert.deepEqual(fromCrate.inherits, fromAscii.inherits)
  assert.deepEqual(fromCrate.specializes, fromAscii.specializes)

  // The crate's inlined double3 must read as the authored vector, not as its raw
  // 32-bit payload — the value the details panel and the text view both show.
  const unit = await readPrimDetails(sources, '/root/unit', { parseCrate: USDCParser })
  const translate = unit.attributes.find(entry => entry.name === 'xformOp:translate')
  assert.ok(translate !== undefined)
  assert.equal(translate.value, '[3, 0, 0]', 'an inlined crate vector is decoded to its components')

  // A layer the reader cannot decode is reported as such, not silently skipped.
  const packageOnly = await readPrimDetails(new Map([['sample.usdz', await fixture('sample.usdz')]]), '/root')
  assert.equal(packageOnly.present, false)
  assert.equal(packageOnly.unreadableLayers.length, 1, 'the package itself is the unreadable layer')
  assert.match(packageOnly.unreadableLayers[0].reason, /usdz package/)
}

// ── an authored arc the stage never composed is stated, not invented ───────
{
  const orphan = await readPrimDetails(new Map([['arcs/full.usda', await fixture('arcs/full.usda')]]), '/root')
  assert.equal(orphan.references[0].targetLayer, '', 'a reference to a layer outside the stage resolves to nothing')
  assert.equal(orphan.references[1].targetPrim, '/Other', 'the authored prim path is still reported')
  assert.equal(orphan.payloads[0].targetLayer, '')
}

process.stdout.write('details.test.mjs  OK  (typed attributes, schemas, relationships, ASCII/crate parity, array summaries, complete composition arcs)\n')
