/**
 * Native USD assembly, in Node, over real exporter output and a real reference chain.
 *
 * The fixtures are Blender's own exports of one scene in all four containers, so
 * a regression here means a real file stopped opening. Three things are actually
 * under test:
 *
 *   * container dispatch, which is bytes-only: `.usd` holds either encoding by
 *     specification, and the crate reader and the ASCII parser are not
 *     interchangeable;
 *   * that a binary crate assembles into the SAME geometry as its ASCII twin —
 *     the property that makes a browser-only preview possible at all;
 *   * that a layer referencing another layer is only as good as the reader it is
 *     given, which is why the failure case is asserted next to the success.
 *
 * Run: node tests/parse.test.mjs   (regenerate fixtures with tests/make-fixtures.py)
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadUsd, measureObject, usdFormatOf } from '../src/client/parse.js'
import {
  layerBasePath, normalizePosix, parseFileReference, referenceKey, siblingPath,
  USD_EXTENSIONS, usdDefinition, usdFileName,
} from '../src/client/usd.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

/**
 * A reader over the fixtures directory, shaped exactly like the one the client
 * half injects: paths are relative to the opened file's own directory.
 * @param base - directory the opened file lives in.
 * @returns the reader `loadUsd` expects.
 */
function readerAt(base) {
  return async (relative) => {
    try {
      const bytes = new Uint8Array(await readFile(join(base, relative)))
      return bytes.byteLength === 0 ? undefined : bytes
    } catch {
      return undefined
    }
  }
}

/** Container each fixture must be detected as, by bytes alone. */
const CASES = [
  ['sample.usda', 'usda'],
  ['sample.usd', 'usda'],
  ['sample.usdc', 'usdc'],
  ['sample.usdz', 'usdz'],
]

const measured = new Map()
for (const [name, expectedFormat] of CASES) {
  const bytes = new Uint8Array(await readFile(join(fixtures, name)))
  assert.ok(bytes.byteLength > 0, `${name} is empty`)
  assert.equal(usdFormatOf(bytes), expectedFormat, `${name} was misclassified`)

  const started = Date.now()
  const { object, format, layers } = await loadUsd({ bytes, readLayer: readerAt(fixtures) })
  assert.equal(format, expectedFormat, `${name} assembled through the wrong container branch`)

  const stats = measureObject(object)
  assert.ok(stats.meshes >= 2, `${name}: expected the cube and the sphere, saw ${stats.meshes} mesh(es)`)
  assert.ok(stats.triangles > 0, `${name}: no triangles`)
  assert.equal(stats.degenerate, false, `${name}: assembled to a degenerate extent`)
  for (const axis of ['x', 'y', 'z']) {
    assert.ok(stats.size[axis] > 0, `${name}: extent collapsed on ${axis}`)
  }
  assert.ok(stats.size.x > stats.size.y, `${name}: the X offset did not survive assembly`)
  assert.ok(layers >= 1, `${name}: reported no layers`)

  measured.set(name, stats)
  process.stdout.write(
    `assemble ${name.padEnd(12)} ${String(bytes.byteLength).padStart(7)} B  ${format}  `
    + `${stats.meshes} meshes  ${stats.triangles} tris  `
    + `${stats.size.x.toFixed(2)}x${stats.size.y.toFixed(2)}x${stats.size.z.toFixed(2)}  `
    + `${Date.now() - started} ms\n`,
  )
}

// The whole point of a native crate reader: the binary container must produce
// what the ASCII one produces, not a plausible-looking subset.
const ascii = measured.get('sample.usda')
for (const name of ['sample.usd', 'sample.usdc', 'sample.usdz']) {
  const stats = measured.get(name)
  assert.deepEqual(stats.size, ascii.size, `${name}: extent differs from the ASCII twin`)
  assert.equal(stats.meshes, ascii.meshes, `${name}: mesh count differs from the ASCII twin`)
  assert.equal(stats.triangles, ascii.triangles, `${name}: triangle count differs from the ASCII twin`)
}

// ── a layer that references another layer ───────────────────────────────────
const unitBytes = new Uint8Array(await readFile(join(fixtures, 'refs', 'unit.usda')))
const resolved = await loadUsd({ bytes: unitBytes, readLayer: readerAt(join(fixtures, 'refs')) })
const resolvedStats = measureObject(resolved.object)
assert.equal(resolved.layers, 2, 'the referenced layer was not assembled')
assert.equal(resolvedStats.meshes, 1, 'the referenced mesh did not arrive')
assert.equal(resolvedStats.triangles, 2, 'the referenced mesh lost its triangles')

// The same bytes with no reader must assemble to nothing: that is the honest
// outcome when the reference cannot be located, and the body reports it as an
// empty stage rather than inventing geometry.
const orphaned = await loadUsd({ bytes: unitBytes, readLayer: async () => undefined })
assert.equal(measureObject(orphaned.object).meshes, 0, 'an unreadable reference produced geometry')

// ── address and path helpers ────────────────────────────────────────────────
assert.deepEqual(
  parseFileReference('dsh-resource://file/session/session-1/workspace/models/robot%20arm.usdz'),
  { sessionId: 'session-1', path: 'workspace/models/robot arm.usdz' },
)
assert.equal(parseFileReference('dsh-resource://file/absolute/C:/x/y.usd'), undefined)
assert.equal(parseFileReference('dsh-resource://file/session/only-a-session'), undefined)

assert.equal(siblingPath('workspace/models/robot.usdz', './geom/body.usda'), 'workspace/models/geom/body.usda')
assert.equal(siblingPath('workspace/models/robot.usdz', '../shared/body.usda'), 'workspace/shared/body.usda')
assert.equal(siblingPath('robot.usdz', 'body.usda'), 'body.usda')
assert.equal(normalizePosix('a/./b/../c//d'), 'a/c/d')
assert.equal(layerBasePath('a/b/c.usd'), 'a/b')
assert.equal(layerBasePath('c.usd'), '')
assert.equal(referenceKey('', './a.usd'), 'a.usd')
assert.equal(referenceKey('sub', '../a.usd'), 'sub/../a.usd')

// Garbage must not throw: an empty stage is reported, not swallowed.
const garbage = await loadUsd({ bytes: new TextEncoder().encode('this is not USD at all'), readLayer: async () => undefined })
assert.equal(measureObject(garbage.object).meshes, 0)
assert.equal(measureObject(garbage.object).degenerate, true)

// The registry inputs.
const definition = usdDefinition(() => 'title')
assert.deepEqual([...definition.extensions], [...USD_EXTENSIONS])
assert.notEqual(definition.priority, 'builtin')
assert.equal(definition.loading, 'bytes-complete')
assert.equal(usdFileName('dsh-resource://file/session/s-1/a.usda?rev=2#top'), 'a.usda')

process.stdout.write(
  `parse.test.mjs  OK  (${CASES.length} containers, ASCII/crate parity, reference chain, helpers)\n`,
)
