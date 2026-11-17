/**
 * The prim-path tree: structure, ordering, filtering and bounded flattening.
 *
 * The panel turned from a flat list into a hierarchy; these are the pure rules
 * behind it, so a wrong sort or a filter that loses an ancestor is caught in
 * Node without a browser.
 *
 * Run: node tests/prim-tree.test.mjs
 */
import assert from 'node:assert/strict'
import {
  allFolderPaths, ancestorsOf, buildPrimTree, comparePrimNames, countPrimNodes, filterPrimTree, flattenPrimTree,
} from '../src/client/prim-tree.js'

// ── natural ordering ─────────────────────────────────────────────────────────
assert.ok(comparePrimNames('link_2', 'link_10') < 0, 'numeric segments sort by value')
assert.ok(comparePrimNames('link_10', 'link_2') > 0)
assert.ok(comparePrimNames('alpha', 'beta') < 0)
assert.equal(comparePrimNames('same', 'same'), 0)
assert.ok(comparePrimNames('body', 'body_2') < 0, 'a shorter name sorts first')

// ── tree building ────────────────────────────────────────────────────────────
const paths = [
  '/World/Geometry/Wheel_10',
  '/World/Geometry/Wheel_2',
  '/World/Geometry/Body',
  '/World/Rig/Arm/Hand',
  '/Stage',
  'not-a-path',
]
const tree = buildPrimTree(paths)
assert.deepEqual([...tree.children.keys()], ['Stage', 'World'], 'top-level folders sort naturally')
const world = tree.children.get('World')
assert.deepEqual([...world.children.keys()], ['Geometry', 'Rig'])
const geometry = world.children.get('Geometry')
assert.deepEqual([...geometry.children.keys()], ['Body', 'Wheel_2', 'Wheel_10'])
assert.equal(geometry.children.get('Wheel_2').prim, true)
assert.equal(world.prim, true, 'an ancestor of a collected prim is copyable too')
assert.equal(countPrimNodes(tree), 9, 'folder nodes and leaves are all counted')

// ── flattening ───────────────────────────────────────────────────────────────
const folders = allFolderPaths(tree)
assert.deepEqual([...folders], ['/World', '/World/Geometry', '/World/Rig', '/World/Rig/Arm'])
const all = flattenPrimTree(tree, folders)
assert.equal(all.rows.length, countPrimNodes(tree), 'everything visible when all folders are open')
assert.equal(all.rows[0].node.path, '/Stage')
assert.equal(all.rows.find(row => row.node.path === '/World/Rig/Arm/Hand').depth, 3)
assert.equal(all.truncated, false)
const collapsed = flattenPrimTree(tree, new Set())
assert.deepEqual(collapsed.rows.map(row => row.node.path), ['/Stage', '/World'], 'collapsed tree shows only top level')
assert.equal(collapsed.total, countPrimNodes(tree), 'the total still counts hidden rows')
const bounded = flattenPrimTree(tree, folders, { limit: 2 })
assert.equal(bounded.rows.length, 2)
assert.equal(bounded.total, countPrimNodes(tree))
assert.equal(bounded.truncated, true)

// ── filtering ────────────────────────────────────────────────────────────────
const hand = filterPrimTree(tree, 'hand')
assert.equal(hand.active, true)
const handRows = flattenPrimTree(hand.tree, new Set(), { forcedOpen: true })
assert.deepEqual(handRows.rows.map(row => row.node.path), ['/World', '/World/Rig', '/World/Rig/Arm', '/World/Rig/Arm/Hand'], 'a match keeps its ancestors and loses its siblings')
const none = filterPrimTree(tree, 'does-not-exist')
assert.equal(flattenPrimTree(none.tree, new Set()).rows.length, 0)
assert.equal(filterPrimTree(tree, '   ').active, false, 'blank filter is inactive')

// ── ancestors ────────────────────────────────────────────────────────────────
assert.deepEqual(ancestorsOf('/World/Rig/Arm/Hand'), ['/World', '/World/Rig', '/World/Rig/Arm'])
assert.deepEqual(ancestorsOf('/Stage'), [])
assert.deepEqual(ancestorsOf(null), [])

process.stdout.write('prim-tree.test.mjs  OK  (build, count, flatten, filter, ancestors)\n')
