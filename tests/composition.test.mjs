/**
 * The stage composition reader, in Node: which layers a stage composed and the
 * arcs that placed each one there.
 *
 * This is the layer half of the new composition feature; the panel is checked in
 * the browser suite. What is pinned here are the rules a wrong walk would break
 * silently:
 *
 *   * sublayers, references and payloads all become child nodes, in arc order,
 *     with the arc that reached each one and the prim that declared it;
 *   * an arc whose target layer is not in the stage is counted as unresolved, not
 *     invented and not dropped;
 *   * the root is the opened file when the caller names it, even when the layer
 *     map lists a sibling first;
 *   * the engine's alias keys for one blob collapse to one layer, while two
 *     blobs with identical bytes stay two layers;
 *   * a crate composes the same tree as its ASCII twin;
 *   * a cycle stops the walk and is reported, and a chain past the depth bound is
 *     clipped with the truncation stated;
 *   * a layer that cannot be decoded is a node with its reason.
 *
 * Run: node tests/composition.test.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { USDCParser } from 'three/examples/jsm/loaders/usd/USDCParser.js'
import { MAX_COMPOSITION_DEPTH, readStageComposition } from '../src/client/composition.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = name => readFile(join(root, 'tests', 'fixtures', name))
const encoder = new TextEncoder()

/** The complete-arc fixture with every layer it names, under the keys a stage uses. */
async function fullSources(crate = false) {
  return new Map([
    [crate ? 'arcs/full.usdc' : 'arcs/full.usda', await fixture(crate ? 'arcs/full.usdc' : 'arcs/full.usda')],
    ['arcs/ref/body.usda', await fixture('arcs/ref/body.usda')],
    ['arcs/ref/other.usda', await fixture('arcs/ref/other.usda')],
    ['arcs/sub/base.usda', await fixture('arcs/sub/base.usda')],
    ['arcs/payload/heavy.usda', await fixture('arcs/payload/heavy.usda')],
  ])
}

// ── every arc kind becomes a node, with its provenance ─────────────────────
{
  const sources = await fullSources(false)
  const composition = await readStageComposition(sources, { rootKey: 'arcs/full.usda' })
  assert.equal(composition.rootKey, 'arcs/full.usda')
  assert.equal(composition.counts.layers, 7, 'root + two sublayers + three reference targets + one payload target')
  assert.equal(composition.counts.arcs, 6, 'the root layer authors two sublayers, two references and a payload; /root/unit adds one reference')
  assert.equal(composition.counts.resolved, 6)
  assert.equal(composition.counts.unresolved, 0)
  assert.deepEqual(composition.unreached, [])

  const nodes = composition.nodes
  assert.equal(nodes[0].role, 'root')
  assert.equal(nodes[0].depth, 0)
  assert.equal(nodes[0].from, null)
  assert.equal(nodes[0].primCount > 0, true, 'the root layer reports how many prims it authors')
  assert.equal(nodes[0].layerMeta.defaultPrim, 'root')
  assert.equal(nodes[0].layerMeta.upAxis, 'Y')

  // Sublayers compose at the same paths; they are children of the layer stack
  // before the prim arcs are listed.
  assert.equal(nodes[1].key, 'arcs/sub/base.usda')
  assert.equal(nodes[1].role, 'sublayer')
  assert.equal(nodes[1].depth, 1)
  assert.equal(nodes[1].from.layer, 'arcs/full.usda')
  assert.equal(nodes[1].from.asset, './sub/base.usda')

  const referenceNodes = nodes.filter(node => node.role === 'reference')
  assert.equal(referenceNodes.length, 3, 'two references on /root and one on /root/unit')
  const onRoot = referenceNodes.find(node => node.key === 'arcs/ref/other.usda' && node.from.prim === '/root')
  assert.ok(onRoot !== undefined, 'a reference node names the prim that declared it')
  assert.equal(onRoot.from.arcPrim, '/Other', 'the authored prim path inside the reference is kept')
  const payloadNode = nodes.find(node => node.role === 'payload')
  assert.equal(payloadNode.key, 'arcs/payload/heavy.usda')
  assert.equal(payloadNode.from.prim, '/root')
  assert.equal(payloadNode.from.arcPrim, '/Heavy')

  // The root's own arc list is complete: every arc it authored, resolved or not.
  const kinds = nodes[0].arcs.map(arc => arc.kind)
  assert.deepEqual(kinds, ['sublayer', 'sublayer', 'reference', 'reference', 'reference', 'payload'], 'one arc row per authored arc: two sublayers, the /root/unit reference, the two references and the payload on /root')
}

// ── a crate composes the same tree as its ASCII twin ───────────────────────
{
  const ascii = await readStageComposition(await fullSources(false), { rootKey: 'arcs/full.usda' })
  const crate = await readStageComposition(await fullSources(true), { rootKey: 'arcs/full.usdc', parseCrate: USDCParser })
  // The two containers list prims in different orders (a text reader registers a
  // child before its parent; the crate tables are parent-first), so the walk
  // reaches some sibling arcs in a different order. One composition, stated as an
  // order-independent set of nodes.
  const shape = composition => composition.nodes
    .map(node => [node.key.replace(/\.usdc$/, '.usda'), node.role, node.depth, node.from === null ? null : [node.from.prim, node.from.asset, node.from.arcPrim]])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
  assert.deepEqual(shape(crate), shape(ascii), 'the crate and ASCII fixtures describe one composition')
  assert.deepEqual(crate.counts, ascii.counts)
}

// ── an arc to a layer the stage does not hold is unresolved, not invented ──
{
  const composition = await readStageComposition(new Map([['arcs/full.usda', await fixture('arcs/full.usda')]]), { rootKey: 'arcs/full.usda' })
  assert.equal(composition.counts.layers, 1, 'no child node is invented for a missing layer')
  assert.equal(composition.counts.arcs, 6, 'two sublayers, the /root/unit reference, and the two references plus the payload on /root')
  assert.equal(composition.counts.resolved, 0)
  assert.equal(composition.counts.unresolved, 6)
  assert.equal(composition.nodes[0].arcs.every(arc => arc.targetLayer === ''), true, 'an unresolved arc names no target')
  assert.equal(composition.omittedArcs, 0)
}

// ── the opened file is the root, and aliases of one blob are one layer ─────
{
  const body = await fixture('arcs/ref/body.usda')
  // The engine registers one layer under two spellings (with and without the root
  // directory). Both entries share the blob, so the composition shows one layer.
  const shared = new Blob([new Uint8Array(body)])
  const sources = new Map([
    ['dir/root.usda', new Blob([encoder.encode('#usda 1.0\n(\n    defaultPrim = "root"\n    subLayers = [@./body.usda@]\n)\n\ndef Xform "root"\n{\n}\n')])],
    ['body.usda', shared],
    ['dir/body.usda', shared],
  ])
  const composition = await readStageComposition(sources, { rootKey: 'dir/root.usda' })
  assert.equal(composition.rootKey, 'dir/root.usda', 'the caller-named root wins over the map order')
  assert.equal(composition.nodes.length, 2, 'the aliased blob must not become a second layer')
  assert.equal(composition.nodes[1].key, 'body.usda', 'the first spelling of an aliased layer is kept')
  assert.equal(composition.unreached.length, 0)

  // Two distinct sources with identical bytes are still two layers.
  const twin = new Blob([new Uint8Array(body)])
  const twoBlobs = new Map([
    ['dir/root.usda', new Blob([encoder.encode('#usda 1.0\n(\n    defaultPrim = "root"\n    subLayers = [@./a.usda@, @./b.usda@]\n)\n\ndef Xform "root"\n{\n}\n')])],
    ['a.usda', new Blob([new Uint8Array(body)])],
    ['b.usda', twin],
  ])
  const twins = await readStageComposition(twoBlobs, { rootKey: 'dir/root.usda' })
  assert.equal(twins.nodes.length, 3, 'identical bytes from two sources remain two layers')
}

// ── an unreached source is stated, not silently dropped ────────────────────
{
  const sources = new Map([
    ['arcs/root.usda', await fixture('arcs/root.usda')],
    ['arcs/sub/base.usda', await fixture('arcs/sub/base.usda')],
    ['arcs/ref/body.usda', await fixture('arcs/ref/body.usda')],
    ['arcs/extra/notes.usda', encoder.encode('#usda 1.0\ndef Xform "N"\n{\n}\n')],
  ])
  const composition = await readStageComposition(sources, { rootKey: 'arcs/root.usda' })
  assert.equal(composition.unreached.length, 1)
  assert.equal(composition.unreached[0].key, 'arcs/extra/notes.usda')
  assert.equal(composition.unreached[0].format, 'usda')
  assert.match(composition.unreached[0].reason, /not reached/)
}

// ── a cycle stops the walk; a deep chain is clipped with the bound stated ──
{
  const a = encoder.encode('#usda 1.0\n(\n    defaultPrim = "a"\n)\n\ndef Xform "a" (\n    prepend references = @./b.usda@\n)\n{\n}\n')
  const b = encoder.encode('#usda 1.0\n(\n    defaultPrim = "b"\n)\n\ndef Xform "b" (\n    prepend references = @./a.usda@\n)\n{\n}\n')
  const cycle = await readStageComposition(new Map([['a.usda', a], ['b.usda', b]]), { rootKey: 'a.usda' })
  assert.equal(cycle.nodes.length, 2, 'a cycle adds no third node')
  const cycleArc = cycle.nodes[1].arcs.find(arc => arc.truthy === undefined && arc.cycle === true)
  assert.ok(cycleArc !== undefined, 'the closing arc is reported as a cycle')
  assert.equal(cycleArc.targetLayer, 'a.usda')

  // A sublayer chain longer than the walk follows: the bound is reported, not
  // silently applied.
  const chain = new Map()
  const layers = MAX_COMPOSITION_DEPTH + 3
  for (let index = 0; index < layers; index += 1) {
    const next = index + 1 < layers ? '    subLayers = [@./l' + (index + 1) + '.usda@]\n' : ''
    chain.set('l' + index + '.usda', encoder.encode('#usda 1.0\n(\n    defaultPrim = "p"\n' + next + ')\n\ndef Xform "p"\n{\n}\n'))
  }
  const clipped = await readStageComposition(chain, { rootKey: 'l0.usda' })
  assert.equal(clipped.nodes.length, MAX_COMPOSITION_DEPTH + 1, 'the walk stops at the depth bound')
  assert.equal(clipped.truncated, true, 'clipping is stated')
  assert.equal(clipped.nodes.at(-1).key, 'l' + MAX_COMPOSITION_DEPTH + '.usda')
}

// ── a container this reader cannot decode is a node with a reason ──────────
{
  const composition = await readStageComposition(new Map([['scene.usdz', await fixture('sample.usdz')]]), { rootKey: 'scene.usdz' })
  assert.equal(composition.nodes.length, 1)
  assert.equal(composition.nodes[0].role, 'root')
  assert.equal(composition.nodes[0].format, 'usdz')
  assert.match(composition.nodes[0].unreadable, /usdz package/)
  assert.equal(composition.counts.arcs, 0, 'an unreadable layer contributes no arcs')
}

// ── no layers at all is an empty composition, not an error ─────────────────
{
  const empty = await readStageComposition(new Map(), {})
  assert.equal(empty.rootKey, '')
  assert.deepEqual(empty.nodes, [])
  assert.deepEqual(empty.unreached, [])
  assert.deepEqual(empty.counts, { layers: 0, arcs: 0, resolved: 0, unresolved: 0 })
}

process.stdout.write('composition.test.mjs  OK  (layer tree, LIVRPS arcs, alias dedupe, unresolved arcs, cycles, bounds, unreadable layers)\n')
