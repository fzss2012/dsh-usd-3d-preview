/**
 * Custom-typed instancer detection, in Node.
 *
 * The WASM engine only instances `UsdGeomPointInstancer`, so an exporter that
 * writes the same fields under a custom type is retyped on the way in. The
 * rewrite must be per-prim: a grouping prim that merely contains an instancer is
 * not one, and promoting it would make a spec-conforming renderer skip every
 * child under it. These cases pin the distinction, including the nested library
 * shape a building exporter writes (custom instancer -> custom instancer behind
 * a custom group).
 *
 * Run: node tests/instancer.test.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { retypeCustomInstancers } from '../src/client/engine.js'

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

/** Count the prim headers that name the standard type after the rewrite. */
function standardCount(text) {
  return (text.match(/\bdef PointInstancer\b/g) ?? []).length
}

// ── the committed nested fixture ───────────────────────────────────────────
const nested = await readFile(join(fixtures, 'instancer', 'custom-nested.usda'), 'utf8')
const rewritten = retypeCustomInstancers(nested)
assert.match(rewritten, /def PointInstancer "row"/, 'the inner custom instancer was not retyped')
assert.match(rewritten, /def PointInstancer "wall"/, 'the outer custom instancer was not retyped')
assert.match(rewritten, /def Library "library"/, 'the grouping prim was promoted to PointInstancer')
assert.match(rewritten, /def Leaf "leaf"/, 'a custom-typed prototype was promoted without instancer fields')
assert.equal(standardCount(rewritten), 2, 'exactly the two instancer prims may be rewritten')
assert.match(rewritten, /rel prototypes = \[ <\/root\/library\/row> \]/, 'prototypes were altered')

// ── a container whose child is an instancer stays a container ──────────────
const container = `#usda 1.0
def Xform "root"
{
    def Group "group"
    {
        # A custom instancer nested one level down.
        def Row "row"
        {
            int[] protoIndices = [0, 0]
            point3f[] positions = [(0, 0, 0), (2, 0, 0)]
            rel prototypes = [ </root/leaf> ]
        }
    }
}
`
const containerOut = retypeCustomInstancers(container)
assert.match(containerOut, /def Group "group"/, 'a group containing an instancer was retyped')
assert.match(containerOut, /def PointInstancer "row"/, 'the nested instancer was not retyped')
assert.equal(standardCount(containerOut), 1)

// ── ordinary prims, and prims with only part of the signature ───────────────
const partial = `#usda 1.0
def Xform "root"
{
    def Grid "no-indices"
    {
        point3f[] positions = [(0, 0, 0)]
        rel prototypes = [ </root/proto> ]
    }

    def Grid "no-placement"
    {
        int[] protoIndices = [0]
    }

    def PointInstancer "already-standard"
    {
        int[] protoIndices = [0]
        rel prototypes = [ </root/proto> ]
    }
}
`
const partialOut = retypeCustomInstancers(partial)
assert.match(partialOut, /def Grid "no-indices"/, 'a prim without protoIndices was retyped')
assert.match(partialOut, /def Grid "no-placement"/, 'a prim without a prototype/placement was retyped')
assert.match(partialOut, /def PointInstancer "already-standard"/, 'the standard type was rewritten')
assert.equal(standardCount(partialOut), 1, 'only the already-standard instancer may remain')

// ── a text layer with no instancer at all is returned untouched ────────────
const plain = '#usda 1.0\ndef Xform "root" { }\n'
assert.equal(retypeCustomInstancers(plain), plain, 'a layer without protoIndices was modified')

process.stdout.write(
  'instancer.test.mjs  OK  (custom nested retype, container safety, partial signatures)\n',
)
