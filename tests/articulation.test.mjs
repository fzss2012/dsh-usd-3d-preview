/**
 * Articulation suite: read the moving parts a USD stage declares, then drive
 * them, without a browser.
 *
 * Three things are actually under test, and each one has a failure mode that a
 * viewer would show rather than report:
 *
 *   * that kinematics survives the containers — an ASCII layer and a crate layer
 *     both have to yield the same bodies, joints, limits and rest transforms —
 *     and that a real articulated asset, when one is pointed at through
 *     `DSH_USD_TEST_SIMREADY`, reads and binds with the same contract;
 *   * that the controller binds without moving anything — a re-parented mesh
 *     whose stage-space matrix changed would jump on load, and one whose pivot
 *     was taken from the body origin instead of the joint frame would swing
 *     about the wrong point;
 *   * that interaction is reversible and independent — open/close, home,
 *     all-open/all-close, limit clamping, fixed joints, multi-part stages,
 *     colliders and pick hit/miss all have to end where they started, because
 *     the caller frees the geometry right after dispose.
 *
 * The interaction section is deliberately a state machine: every click is
 * followed by a pose assertion (not just "pixels changed"), every sequence has a
 * defined endpoint, and a fresh controller is bound for each scenario so one
 * scenario cannot hide a leak in another.
 *
 * Run: node tests/articulation.test.mjs
 */
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { readArticulation } from '../src/client/articulation.js'
import { createArticulationController } from '../src/client/kinematics.js'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, 'fixtures', 'joints')

/** Read one authored fixture into the sources map the engine would hand over. */
async function readFixture(name) {
  const bytes = new Uint8Array(await readFile(join(fixtures, name)))
  return readArticulation(new Map([[name, new Blob([bytes])]]))
}

/** A stage-space matrix for a pure translation. */
function translation(x, y, z) {
  return new THREE.Matrix4().makeTranslation(x, y, z).toArray()
}

/** A quad as the assembled scene would hold it (only the extent matters here). */
const QUAD = [-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5]

/** One flat mesh node named after its composed prim path. */
function meshNode(name, matrix = translation(0, 0, 0), points = QUAD) {
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3))
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial())
  mesh.name = name
  mesh.matrixAutoUpdate = false
  mesh.matrix.fromArray(matrix)
  return mesh
}

/**
 * A synthetic assembled root shaped like the engine's: a flat group whose
 * children carry their stage-space world matrix. `upAxis` rotates the root, as
 * the real one does for a Z-up stage, so a controller that ignored the
 * stage/root split would be caught here.
 */
function sceneOf(entries, options = {}) {
  const root = new THREE.Group()
  root.name = 'usd'
  if (options.zUp === true) root.rotation.x = -Math.PI / 2
  for (const entry of entries) root.add(meshNode(entry.name, entry.matrix, entry.points))
  root.updateMatrixWorld(true)
  return root
}

/** A node's pose in stage space: the coordinate system the articulation uses. */
function stageMatrixOf(root, node) {
  root.updateMatrixWorld(true)
  const inverse = new THREE.Matrix4().copy(root.matrixWorld).invert()
  return new THREE.Matrix4().multiplyMatrices(inverse, node.matrixWorld)
}

/** The stage-space point a node's local point ends up at. */
function stagePointOf(root, node, x, y, z) {
  return new THREE.Vector3(x, y, z).applyMatrix4(stageMatrixOf(root, node))
}

/** Find the body group the controller created for a prim path. */
function bodyGroup(root, path) {
  return root.children.find(child => child.name === path && child.isGroup === true)
}

function assertMatrixClose(actual, expected, epsilon, label) {
  for (let index = 0; index < 16; index += 1) {
    const delta = Math.abs(actual.elements[index] - expected.elements[index])
    assert.ok(delta <= epsilon, label + ': element ' + index + ' is ' + actual.elements[index] + ', expected ' + expected.elements[index])
  }
}

/** Run a controller until it settles, returning the elapsed milliseconds. */
function settle(parts, step = 16, limit = 20000) {
  let elapsed = 0
  while (parts.tick(step) === true) {
    elapsed += step
    assert.ok(elapsed <= limit, 'the animation never settled')
  }
  return elapsed
}

/** The eight corners of an axis-aligned box, for geometry that needs real extent. */
function boxPoints(minX, minY, minZ, maxX, maxY, maxZ) {
  const points = []
  for (const x of [minX, maxX]) {
    for (const y of [minY, maxY]) {
      for (const z of [minZ, maxZ]) points.push(x, y, z)
    }
  }
  return points
}

/** Every vertex of the named meshes, in stage space, at the current pose. */
function stageVertices(root, names) {
  root.updateMatrixWorld(true)
  const points = []
  for (const name of names) {
    const node = root.getObjectByName(name)
    assert.ok(node !== undefined, name + ': the mesh disappeared')
    const position = node.geometry.getAttribute('position')
    const matrix = stageMatrixOf(root, node)
    for (let index = 0; index < position.count; index += 1) {
      points.push(new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(matrix))
    }
  }
  return points
}

/** Assert every point is inside a plain { min, max } envelope. */
function assertInsideEnvelope(box, points, label) {
  for (const point of points) {
    const inside = point.x >= box.min[0] - 1e-6 && point.x <= box.max[0] + 1e-6
      && point.y >= box.min[1] - 1e-6 && point.y <= box.max[1] + 1e-6
      && point.z >= box.min[2] - 1e-6 && point.z <= box.max[2] + 1e-6
    assert.ok(inside, label + ': vertex ' + point.toArray().map(value => value.toFixed(4)).join(', ') + ' left the envelope')
  }
}

/** The meshes of the mixed fixture, at their authored rest transforms. */
const MIXED_MESHES = [
  { name: '/Mixed/Bodies/base/mount', matrix: translation(0, 0, 0), points: boxPoints(-0.15, 0, -0.15, 0.15, 0.2, 0.15) },
  { name: '/Mixed/Bodies/leaf/panel', matrix: translation(0, 1, 0), points: boxPoints(0, -0.5, -0.02, 0.9, 0.5, 0.02) },
  { name: '/Mixed/Bodies/tray/front', matrix: translation(1.5, 0.2, 0), points: boxPoints(-0.15, -0.15, -0.3, 0.15, 0.15, 0.3) },
  { name: '/Mixed/Bodies/plate/board', matrix: translation(0.6, 1.5, 0.6), points: boxPoints(-0.3, -0.25, -0.05, 0.3, 0.25, 0.05) },
]

/** A fresh mixed stage: one revolute leaf, one prismatic tray, one fixed plate. */
function makeMixedScene() {
  return sceneOf(MIXED_MESHES.map(entry => ({ ...entry })))
}

/** The meshes of the drawer fixture, at their authored rest transforms. */
const DRAWER_MESHES = [
  { name: '/Drawer/Bodies/carcass/shell', matrix: translation(0, 0, 0), points: boxPoints(-0.4, 0, -0.3, 0.6, 0.4, 0.3) },
  { name: '/Drawer/Bodies/tray/front', matrix: translation(0.05, 0.2, 0), points: boxPoints(0, -0.15, -0.25, 0.02, 0.15, 0.25) },
]

/** A fresh drawer stage. */
function makeDrawerScene() {
  return sceneOf(DRAWER_MESHES.map(entry => ({ ...entry })))
}

/** The meshes of the chain fixture, at their authored rest transforms. */
const CHAIN_MESHES = [
  { name: '/Chain/Bodies/base/plate', matrix: translation(0, 0, 0), points: boxPoints(-0.2, 0, -0.2, 0.2, 0.1, 0.2) },
  { name: '/Chain/Bodies/arm/beam', matrix: translation(1, 0, 0), points: boxPoints(0, -0.05, -0.05, 1, 0.05, 0.05) },
  { name: '/Chain/Bodies/hand/claw', matrix: translation(2, 0, 0), points: boxPoints(0, -0.05, -0.1, 0.2, 0.05, 0.1) },
]

/** A fresh chain stage. */
function makeChainScene() {
  return sceneOf(CHAIN_MESHES.map(entry => ({ ...entry })))
}

/** Stage-space matrix of a body group the controller created for a prim path. */
function bodyStageMatrix(root, path) {
  const group = bodyGroup(root, path)
  assert.ok(group !== undefined, path + ': no body group exists')
  return stageMatrixOf(root, group)
}

/** Assert every named body's mesh still sits at its recorded rest pose. */
function assertRestPose(root, restMatrices, epsilon, label) {
  root.updateMatrixWorld(true)
  for (const [name, expected] of restMatrices) {
    const node = root.getObjectByName(name)
    assert.ok(node !== undefined, label + ': ' + name + ' disappeared')
    assertMatrixClose(stageMatrixOf(root, node), expected, epsilon, label + ': ' + name + ': rest pose changed')
  }
}

/** Record every mesh's stage-space pose before a controller is bound. */
function snapshotStage(root) {
  root.updateMatrixWorld(true)
  const poses = new Map()
  root.traverse((node) => { if (node.isMesh === true) poses.set(node.name, stageMatrixOf(root, node)) })
  return poses
}

// Keep `mixed` reachable from the interaction sections that follow.

const lines = []
function say(line) {
  lines.push(line)
  process.stdout.write(line + '\n')
}

// ── fixtures: readArticulation ─────────────────────────────────────────────

const door = await readFixture('door.usda')
assert.ok(door !== undefined, 'door.usda: no articulation read')
assert.equal(door.kind, 'usdphysics')
assert.equal(door.bodies.length, 2, 'door.usda: expected frame + leaf')
assert.deepEqual(door.bodies.map(body => body.name), ['frame', 'leaf'], 'door.usda: body order')
assert.equal(door.joints.length, 1)
const hinge = door.joints[0]
assert.equal(hinge.type, 'revolute')
assert.equal(hinge.body0, '/Door/Bodies/frame')
assert.equal(hinge.body1, '/Door/Bodies/frame/leaf')
assert.equal(hinge.unit, 'deg')
assert.deepEqual([hinge.lower, hinge.upper], [-90, 90], 'door.usda: limits')
assert.deepEqual(hinge.axis, [0, 1, 0], 'door.usda: local axis')
assert.ok(Math.abs(hinge.pivot[0]) < 1e-9 && Math.abs(hinge.pivot[1] - 1) < 1e-9 && Math.abs(hinge.pivot[2]) < 1e-9, 'door.usda: pivot')
assert.equal(hinge.opens, 'open')
assert.equal(hinge.open, 90)
assert.deepEqual(door.roots, ['/Door/Bodies/frame'])
assert.deepEqual(door.tree, [{ joint: '/Door/hinge', parent: '/Door/Bodies/frame', child: '/Door/Bodies/frame/leaf' }])
assert.deepEqual(door.warnings, [], 'door.usda: warnings')
// The leaf body is the hinge body, so its rest transform is the authored offset.
assertMatrixClose(new THREE.Matrix4().fromArray(door.bodies[1].matrix), new THREE.Matrix4().makeTranslation(0, 1, 0), 1e-9, 'door.usda: leaf rest')
assert.equal(door.colliders.length, 1, 'door.usda: collision geometry')
assert.equal(door.colliders[0].body, '/Door/Bodies/frame/leaf')
assert.equal(door.colliders[0].indices.length / 3, 12, 'door.usda: a box hull is 12 triangles')
// Baked into stage space: the hull was authored under a body translated +1 Y.
const bakedHull = door.colliders[0].positions
assert.ok(Math.abs(bakedHull[1] - 0.5) < 1e-6, 'door.usda: collider was not baked into stage space (y ' + bakedHull[1] + ')')
say('fixture door.usda      2 bodies  1 revolute (-90..90 deg)  1 collider  0 warnings')

const drawer = await readFixture('drawer.usda')
assert.ok(drawer !== undefined, 'drawer.usda: no articulation read')
assert.deepEqual(drawer.bodies.map(body => body.name), ['carcass', 'tray'])
assert.equal(drawer.joints.length, 1)
const slide = drawer.joints[0]
assert.equal(slide.type, 'prismatic')
assert.equal(slide.unit, 'base')
assert.deepEqual([slide.lower, slide.upper], [0, 0.4], 'drawer.usda: linear limits')
assert.deepEqual(slide.axis, [1, 0, 0])
assert.equal(slide.opens, 'open')
assert.equal(slide.open, 0.4)
assert.equal(drawer.colliders.length, 0)
assert.deepEqual(drawer.warnings, [])
say('fixture drawer.usda    2 bodies  1 prismatic (0..0.4 base)  0 colliders  0 warnings')

const chain = await readFixture('chain.usda')
assert.ok(chain !== undefined, 'chain.usda: no articulation read')
assert.deepEqual(chain.bodies.map(body => body.name), ['base', 'arm', 'hand'], 'chain.usda: parent before child')
assert.equal(chain.joints.length, 2)
assert.deepEqual(chain.tree.map(edge => [edge.parent, edge.child]), [
  ['/Chain/Bodies/base', '/Chain/Bodies/arm'],
  ['/Chain/Bodies/arm', '/Chain/Bodies/hand'],
], 'chain.usda: tree edges')
assert.deepEqual(chain.roots, ['/Chain/Bodies/base'])
say('fixture chain.usda     3 bodies  2 revolute (nested)  0 colliders  0 warnings')

const bolted = await readFixture('bolted.usda')
assert.ok(bolted !== undefined, 'bolted.usda: no articulation read')
assert.equal(bolted.bodies.length, 3, 'bolted.usda: base + plate + unjointed body')
assert.equal(bolted.joints.length, 1)
assert.equal(bolted.joints[0].type, 'fixed')
assert.deepEqual([bolted.joints[0].lower, bolted.joints[0].upper], [0, 0], 'bolted.usda: a fixed joint has no travel')
assert.deepEqual(bolted.roots.sort(), ['/Bolted/Bodies/base', '/Bolted/Bodies/loose'], 'bolted.usda: two roots')
say('fixture bolted.usda    3 bodies  1 fixed (0 travel)  0 colliders  0 warnings')

// ── the static case: no physics at all ─────────────────────────────────────

assert.equal(await readFixture('static.usda'), undefined, 'static.usda: a stage without physics must read as undefined')
assert.equal(await readArticulation(new Map()), undefined, 'an empty source set must read as undefined')
assert.equal(await readArticulation(new Map([['x.usda', new Blob([new TextEncoder().encode('this is not USD')])]])), undefined, 'garbage must read as undefined')
assert.equal(await readArticulation(new Map([['x.usdc', new Blob([new Uint8Array([80, 88, 82, 45, 85, 83, 68, 67, 9, 9, 9, 9, 0, 0, 0, 0, 0, 0, 0, 0])])]])), undefined, 'a broken crate must read as undefined')
say('static stages          undefined  (no physics / empty / garbage / broken crate)')

// ── the controller, against a synthetic assembled scene ────────────────────

// The door scene: the post belongs to the fixed body, the panel to the leaf, and
// a PointInstancer batch that the engine would hand over as one InstancedMesh.
const doorScene = () => {
  const root = sceneOf([
    { name: '/Door/Bodies/frame/post', matrix: translation(0, 0, 0) },
    { name: '/Door/Bodies/frame/leaf/panel', matrix: translation(0, 1, 0) },
    { name: '/Door/Static/instanced', matrix: translation(3, 0, 0) },
  ], { zUp: true })
  const batch = new THREE.InstancedMesh(
    new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(QUAD, 3)),
    new THREE.MeshBasicMaterial(),
    2,
  )
  batch.name = '/Door/Bodies/frame/leaf/instanced'
  root.add(batch)
  root.updateMatrixWorld(true)
  return root
}

const restRoot = doorScene()
const restMatrices = new Map()
restRoot.traverse((node) => { if (node.isMesh === true) restMatrices.set(node.name, stageMatrixOf(restRoot, node)) })

const parts = createArticulationController(restRoot, door)
assert.ok(parts !== undefined, 'door: the controller refused to bind')
assert.equal(parts.movingParts, 1, 'door: movingParts')
assert.equal(parts.hasColliders, true, 'door: hasColliders')

// 1. Binding must not move anything: every mesh keeps its stage-space pose.
for (const [name, expected] of restMatrices) {
  const node = restRoot.getObjectByName(name)
  assert.ok(node !== undefined, name + ': the mesh disappeared')
  assertMatrixClose(stageMatrixOf(restRoot, node), expected, 1e-9, name + ': rest pose changed on bind')
}
// The batch has no per-instance prim path, so it is never re-parented.
const batchNode = restRoot.getObjectByName('/Door/Bodies/frame/leaf/instanced')
assert.equal(batchNode.parent, restRoot, 'the InstancedMesh batch was moved into a body')
// A mesh under no body stays static.
assert.equal(restRoot.getObjectByName('/Door/Static/instanced').parent, restRoot, 'an unowned mesh was re-parented')
const leafGroup = bodyGroup(restRoot, '/Door/Bodies/frame/leaf')
assert.ok(leafGroup !== undefined, 'door: no body group for the leaf')
assert.equal(leafGroup.parent, restRoot, 'the body group was not inserted under the root')
say('controller door bind   rest pose exact  body groups under root  batch + unowned mesh static')

// 2. Open: the leaf must swing about the hinge frame, not about its own origin.
parts.setAll(true)
assert.equal(parts.tick(0), true, 'tick must report motion right after setAll')
// 110 deg/s with a 0.6 s floor: 90 degrees needs 0.818 s.
assert.equal(parts.tick(400), true, 'the leaf settled too early')
parts.tick(400)
const openElapsed = settle(parts)
const panel = restRoot.getObjectByName('/Door/Bodies/frame/leaf/panel')
const corner = stagePointOf(restRoot, panel, 0.9, -0.5, 0)
assert.ok(Math.abs(corner.x) < 1e-6 && Math.abs(corner.y - 0.5) < 1e-6 && Math.abs(corner.z + 0.9) < 1e-6,
  'the panel corner landed at ' + corner.toArray().map(value => value.toFixed(4)).join(', ') + ' instead of (0, 0.5, -0.9)')
// The leaf body itself only rotates: its origin is the hinge.
const leafMatrix = stageMatrixOf(restRoot, leafGroup)
assert.ok(Math.abs(leafMatrix.elements[13] - 1) < 1e-9, 'the hinge body left its pivot')
say('controller open        pivot-correct  corner (0, 0.5, -0.9)  settled after ' + (800 + openElapsed) + ' ms  tick()=false when idle')

// 3. Frame-rate independence: 50 small ticks and one big tick land identically.
const fastRoot = doorScene()
const fastParts = createArticulationController(fastRoot, door)
fastParts.setAll(true)
for (let step = 0; step < 50; step += 1) fastParts.tick(20)
const slowRoot = doorScene()
const slowParts = createArticulationController(slowRoot, door)
slowParts.setAll(true)
slowParts.tick(1000)
assertMatrixClose(
  stageMatrixOf(fastRoot, fastRoot.getObjectByName('/Door/Bodies/frame/leaf')),
  stageMatrixOf(slowRoot, slowRoot.getObjectByName('/Door/Bodies/frame/leaf')),
  1e-9,
  'twenty-millisecond ticks and one thousand-millisecond tick disagree',
)
fastParts.dispose()
slowParts.dispose()
say('controller timing      50 x 20 ms == 1 x 1000 ms (frame-rate independent)')

// 4. Close and home both come back to the rest pose exactly.
parts.setAll(false)
settle(parts)
const closed = stagePointOf(restRoot, panel, 0.9, -0.5, 0)
assert.ok(Math.abs(closed.x - 0.9) < 1e-6 && Math.abs(closed.y - 0.5) < 1e-6 && Math.abs(closed.z) < 1e-6,
  'close did not return the panel to its authored pose: ' + closed.toArray().map(value => value.toFixed(4)).join(', '))
parts.setAll(true)
parts.tick(200)
parts.home()
settle(parts)
for (const [name, expected] of restMatrices) {
  assertMatrixClose(stageMatrixOf(restRoot, restRoot.getObjectByName(name)), expected, 1e-6, name + ': home did not restore the rest pose')
}
say('controller close/home  rest pose restored to 1e-6')

// 5. pick(): the panel toggles its hinge; a mesh on the fixed body or on no body
//    must not move anything.
assert.equal(parts.pick([{ object: restRoot.getObjectByName('/Door/Static/instanced') }]), false, 'pick on an unowned mesh moved something')
assert.equal(parts.pick([{ object: restRoot.getObjectByName('/Door/Bodies/frame/post') }]), false, 'pick on a fixed body moved something')
assert.equal(parts.pick([]), false)
assert.equal(parts.pick([{ object: panel }]), true, 'pick on the leaf did not toggle the hinge')
settle(parts)
const opened = stagePointOf(restRoot, panel, 0.9, -0.5, 0)
assert.ok(Math.abs(opened.y - 0.5) < 1e-6 && Math.abs(opened.z + 0.9) < 1e-6, 'pick did not open the leaf: ' + opened.toArray().join(', '))
assert.equal(parts.pick([{ object: panel }]), true, 'the second pick did not toggle back')
settle(parts)
const reclosed = stagePointOf(restRoot, panel, 0.9, -0.5, 0)
assert.ok(Math.abs(reclosed.x - 0.9) < 1e-6 && Math.abs(reclosed.z) < 1e-6, 'the second pick did not close the leaf')
say('controller pick        toggles the driving joint, ignores fixed/unowned meshes')

// 6. Collision geometry: the engine never drew the hull (purpose=guide), so the
//    controller has to build it from the bytes, hidden until asked for.
const childrenBefore = restRoot.children.length
parts.setCollidersVisible(true)
const overlay = leafGroup.children.find(child => /collider/.test(child.name))
assert.ok(overlay !== undefined, 'show colliders built no overlay on the leaf')
assert.equal(overlay.visible, true, 'the overlay was not made visible')
assert.ok(restRoot.children.length > childrenBefore || overlay.parent === leafGroup, 'the overlay was not attached')
// It follows the body it belongs to: one point must land where the hull was authored.
const shell = overlay.children.find(child => child.isMesh === true)
const hullPoint = new THREE.Vector3().fromBufferAttribute(shell.geometry.getAttribute('position'), 0)
assert.ok(Math.abs(hullPoint.x) < 1e-6 && Math.abs(hullPoint.y - 0.5) < 1e-6 && Math.abs(hullPoint.z + 0.04) < 1e-6,
  'the overlay point is ' + hullPoint.toArray().map(value => value.toFixed(3)).join(', ') + ', expected (0, 0.5, -0.04)')
parts.setCollidersVisible(false)
assert.equal(overlay.visible, false, 'hide colliders left the overlay visible')
say('controller colliders   overlay built from bytes, body-attached, hidden by default')

// 7. dispose() puts every mesh back under the root with its matrix intact.
parts.dispose()
assert.equal(restRoot.children.length, 4, 'dispose left body groups behind: ' + restRoot.children.map(child => child.name).join(', '))
for (const [name, expected] of restMatrices) {
  const node = restRoot.getObjectByName(name)
  assertMatrixClose(stageMatrixOf(restRoot, node), expected, 1e-9, name + ': dispose did not restore the rest pose')
}
assert.equal(restRoot.getObjectByName('/Door/Bodies/frame/leaf'), undefined, 'dispose left a body group named after the body')
assert.equal(restRoot.getObjectByName('/Door/Bodies/frame/post').parent, restRoot, 'the post did not return to the root')
say('controller dispose     meshes back under root, rest pose exact, overlay released')

// ── the three-body chain drives two joints at once ─────────────────────────

const chainScene = sceneOf([
  { name: '/Chain/Bodies/base/plate', matrix: translation(0, 0, 0) },
  { name: '/Chain/Bodies/arm/beam', matrix: translation(1, 0, 0) },
  { name: '/Chain/Bodies/hand/claw', matrix: translation(2, 0, 0) },
])
const chainParts = createArticulationController(chainScene, chain)
assert.ok(chainParts !== undefined, 'chain: the controller refused to bind')
assert.equal(chainParts.movingParts, 2)
chainParts.setAll(true)
settle(chainParts)
const restWorld = new Map(chain.bodies.map(body => [body.path, new THREE.Matrix4().fromArray(body.matrix)]))
for (const joint of chain.joints) {
  const world0 = stageMatrixOf(chainScene, bodyGroup(chainScene, joint.body0))
  const world1 = stageMatrixOf(chainScene, bodyGroup(chainScene, joint.body1))
  const frame = new THREE.Matrix4().fromArray(joint.frame)
  const pivotRest = new THREE.Vector3().setFromMatrixPosition(frame)
  // The joint frame is shared: from either body's current pose it is the same
  // world point, which is what "the chain stayed connected" means numerically.
  const fromBody0 = pivotRest.clone().applyMatrix4(restWorld.get(joint.body0).clone().invert()).applyMatrix4(world0)
  const fromBody1 = pivotRest.clone().applyMatrix4(restWorld.get(joint.body1).clone().invert()).applyMatrix4(world1)
  assert.ok(fromBody0.distanceTo(fromBody1) < 1e-9, joint.path + ': the joint frames came apart')
}
const hand = stagePointOf(chainScene, chainScene.getObjectByName('/Chain/Bodies/hand/claw'), 0, 0, 0)
assert.ok(hand.distanceTo(new THREE.Vector3(2, 0, 0)) > 0.5, 'the hand did not move when the arm did')
chainParts.dispose()
say('controller chain        3 bodies / 2 joints, joint frames coincident to 1e-9, hand followed the arm')

// ── framing envelope: rest pose union the poses the controls reach ─────────

// A synthetic scene whose meshes carry the fixture's real extents, so the
// envelope can be checked against the geometry the door actually has.
const frameScene = sceneOf([
  { name: '/Door/Bodies/frame/post', matrix: translation(0, 0, 0), points: [-0.05, 0, -1.22, 0.05, 2, -1.18, 0, 0, 0] },
  { name: '/Door/Bodies/frame/leaf/panel', matrix: translation(0, 1, 0), points: [0, -0.5, -0.02, 0.9, 0.5, 0.02, 0, 0, 0] },
], { zUp: true })
const frameParts = createArticulationController(frameScene, door)
assert.ok(frameParts !== undefined, 'framing: the controller refused to bind')
const extremes = frameParts.extremeBounds()
assert.ok(extremes !== undefined, 'framing: a drivable stage returned no envelope')
assert.equal(Object.getPrototypeOf(extremes), Object.prototype, 'framing: the envelope must be a plain object')
assert.equal(Array.isArray(extremes.min) && extremes.min.length === 3, true, 'framing: min must be three plain numbers')
assert.equal(Array.isArray(extremes.max) && extremes.max.length === 3, true, 'framing: max must be three plain numbers')

const containsPoint = (box, point, epsilon = 1e-6) => (
  point.x >= box.min[0] - epsilon && point.x <= box.max[0] + epsilon
  && point.y >= box.min[1] - epsilon && point.y <= box.max[1] + epsilon
  && point.z >= box.min[2] - epsilon && point.z <= box.max[2] + epsilon
)
// The rest pose is inside, and so is the far corner of the open swing: framing
// the rest pose alone would push that corner out of the viewport.
assert.ok(containsPoint(extremes, new THREE.Vector3(0.9, 1.5, -0.02)), 'framing: the rest pose is not inside its own envelope')
assert.ok(containsPoint(extremes, new THREE.Vector3(0, 0.5, -0.9)), 'framing: the open pose is outside the envelope')
assert.ok(extremes.min[2] < -0.85, 'framing: the envelope ignored the swing into -Z (min z ' + extremes.min[2] + ')')
const envelopeStart = performance.now()
for (let run = 0; run < 200; run += 1) frameParts.extremeBounds()
const envelopeMicros = ((performance.now() - envelopeStart) * 1000) / 200
// Every vertex of the settled open pose is inside the envelope the controller
// advertises for it.
frameParts.setAll(true)
settle(frameParts)
frameScene.updateMatrixWorld(true)
for (const name of ['/Door/Bodies/frame/post', '/Door/Bodies/frame/leaf/panel']) {
  const node = frameScene.getObjectByName(name)
  const position = node.geometry.getAttribute('position')
  assert.ok(position !== null, 'framing: no vertex data on ' + name)
  for (let index = 0; index < position.count; index += 1) {
    const point = new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(stageMatrixOf(frameScene, node))
    assert.ok(containsPoint(extremes, point, 1e-6), 'framing: ' + name + ' vertex ' + index + ' left the envelope at the open pose')
  }
}
frameParts.dispose()
say('controller framing     rest + open poses inside the envelope, ' + envelopeMicros.toFixed(2) + ' us per call (1 joint)')

// A stage with collision geometry but no drivable joint has nothing to frame.
const colliderOnly = {
  ...bolted,
  colliders: [{
    path: '/Bolted/Bodies/base/floor',
    body: '/Bolted/Bodies/base',
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
  }],
}
const colliderScene = sceneOf([{ name: '/Bolted/Bodies/base/floor', matrix: translation(0, 0, 0) }])
const colliderParts = createArticulationController(colliderScene, colliderOnly)
assert.ok(colliderParts !== undefined, 'collider-only stage: the controller refused to bind')
assert.equal(colliderParts.movingParts, 0)
assert.equal(colliderParts.extremeBounds(), undefined, 'a stage with nothing drivable returned an envelope')
colliderParts.dispose()

// ── a fixed joint plus an unjointed body is not drivable ───────────────────

const boltedScene = sceneOf([
  { name: '/Bolted/Bodies/base/floor', matrix: translation(0, 0, 0) },
  { name: '/Bolted/Bodies/plate/panel', matrix: translation(0, 0.1, 0) },
  { name: '/Bolted/Bodies/loose/chip', matrix: translation(0.5, 0, 0) },
])
assert.equal(createArticulationController(boltedScene, bolted), undefined, 'a stage with no drivable joint and no colliders returned a controller')
say('controller bolted      undefined (nothing drivable, nothing to show)')

// ── tick throughput: an idle controller must cost nothing ──────────────────

const idleScene = doorScene()
const idleParts = createArticulationController(idleScene, door)
const started = performance.now()
for (let step = 0; step < 2000; step += 1) idleParts.tick(16)
const idleMicros = ((performance.now() - started) * 1000) / 2000
idleParts.setAll(true)
let frames = 0
const movingStart = performance.now()
while (idleParts.tick(16) === true && frames < 500) frames += 1
const frameMicros = ((performance.now() - movingStart) * 1000) / Math.max(1, frames)
idleParts.dispose()
say('controller cost        idle tick ' + idleMicros.toFixed(2) + ' us  moving tick ' + frameMicros.toFixed(1) + ' us  (' + frames + ' frames)')

// ── the mixed fixture: three joint types on one stage ──────────────────────

/** Assert a three-element vector is close to an expected one. */
function assertVectorClose(actual, expected, epsilon, label) {
  for (const axis of ['x', 'y', 'z']) {
    assert.ok(Math.abs(actual[axis] - expected[axis]) <= epsilon,
      label + ': ' + axis + ' is ' + actual[axis].toFixed(6) + ', expected ' + expected[axis])
  }
}

const mixed = await readFixture('mixed.usda')
assert.ok(mixed !== undefined, 'mixed.usda: no articulation read')
assert.equal(mixed.kind, 'usdphysics')
assert.deepEqual(mixed.bodies.map(body => body.name), ['base', 'leaf', 'tray', 'plate'], 'mixed.usda: body order')
assert.equal(mixed.joints.length, 3, 'mixed.usda: revolute + prismatic + fixed')
const [mixedHinge, mixedSlide, mixedBolt] = mixed.joints
assert.equal(mixedHinge.type, 'revolute', 'mixed.usda: hinge type')
assert.equal(mixedHinge.unit, 'deg')
// The authored open pose (simready:far = 120) is outside the travel limit and
// must come back clamped to the limit, not to the authored number.
assert.deepEqual([mixedHinge.lower, mixedHinge.upper], [-60, 60], 'mixed.usda: revolute limits')
assert.equal(mixedHinge.open, 60, 'mixed.usda: authored open pose is clamped to the revolute limit')
assert.equal(mixedHinge.opens, 'open')
assert.deepEqual(mixedHinge.axis, [0, 1, 0])
assert.ok(Math.abs(mixedHinge.pivot[0]) < 1e-9 && Math.abs(mixedHinge.pivot[1] - 1) < 1e-9 && Math.abs(mixedHinge.pivot[2]) < 1e-9,
  'mixed.usda: hinge pivot')
assert.equal(mixedHinge.body0, '/Mixed/Bodies/base')
assert.equal(mixedHinge.body1, '/Mixed/Bodies/leaf')
assert.equal(mixedSlide.type, 'prismatic', 'mixed.usda: slide type')
assert.equal(mixedSlide.unit, 'base')
assert.deepEqual([mixedSlide.lower, mixedSlide.upper], [0, 0.3], 'mixed.usda: linear limits')
assert.equal(mixedSlide.open, 0.3, 'mixed.usda: authored open pose is clamped to the prismatic limit')
assert.deepEqual(mixedSlide.axis, [1, 0, 0])
assert.deepEqual(mixedSlide.pivot.map(value => Number(value.toFixed(6))), [1.5, 0.2, 0], 'mixed.usda: slide pivot')
assert.equal(mixedBolt.type, 'fixed', 'mixed.usda: bolt type')
assert.deepEqual([mixedBolt.lower, mixedBolt.upper, mixedBolt.home, mixedBolt.open], [0, 0, 0, 0], 'mixed.usda: a fixed joint has no travel')
assert.deepEqual(mixed.roots, ['/Mixed/Bodies/base'], 'mixed.usda: one root')
assert.deepEqual(mixed.tree.map(edge => [edge.parent, edge.child]), [
  ['/Mixed/Bodies/base', '/Mixed/Bodies/leaf'],
  ['/Mixed/Bodies/base', '/Mixed/Bodies/tray'],
  ['/Mixed/Bodies/base', '/Mixed/Bodies/plate'],
], 'mixed.usda: tree edges')
assert.deepEqual(mixed.warnings, [], 'mixed.usda: warnings')
assert.equal(mixed.colliders.length, 1, 'mixed.usda: one authored collision hull')
assert.equal(mixed.colliders[0].body, '/Mixed/Bodies/leaf')
assert.equal(mixed.colliders[0].indices.length / 3, 12, 'mixed.usda: a box hull is 12 triangles')
assert.ok(Math.abs(mixed.colliders[0].positions[1] - 0.5) < 1e-6, 'mixed.usda: collider was not baked into stage space')
say('fixture mixed.usda    4 bodies  1 revolute + 1 prismatic + 1 fixed, open poses clamped to limits, 1 collider')

// ── mixed controller: two drivable parts, a fixed joint that never moves ───

const mixedRoot = makeMixedScene()
const mixedRest = snapshotStage(mixedRoot)
const mixedParts = createArticulationController(mixedRoot, mixed)
assert.ok(mixedParts !== undefined, 'mixed: the controller refused to bind')
assert.equal(mixedParts.movingParts, 2, 'mixed: two drivable joints (the fixed bolt is not one)')
assert.equal(mixedParts.hasColliders, true, 'mixed: hasColliders')
assertRestPose(mixedRoot, mixedRest, 1e-9, 'mixed bind')
const mixedLeaf = mixedRoot.getObjectByName('/Mixed/Bodies/leaf/panel')
const mixedTray = mixedRoot.getObjectByName('/Mixed/Bodies/tray/front')
const mixedPlate = mixedRoot.getObjectByName('/Mixed/Bodies/plate/board')
const mixedLeafBodyPose = () => bodyStageMatrix(mixedRoot, '/Mixed/Bodies/leaf')
const mixedTrayPose = () => bodyStageMatrix(mixedRoot, '/Mixed/Bodies/tray')
const mixedPlatePose = () => bodyStageMatrix(mixedRoot, '/Mixed/Bodies/plate')
const mixedLeafCorner = () => stagePointOf(mixedRoot, mixedLeaf, 0.9, -0.5, 0)
const mixedTrayOrigin = () => new THREE.Vector3().setFromMatrixPosition(mixedTrayPose())
const mixedPlateRest = mixedPlatePose().clone()
const mixedBaseRest = bodyStageMatrix(mixedRoot, '/Mixed/Bodies/base').clone()

// Both drivable joints reach their clamped limits; the fixed body does not move.
mixedParts.setAll(true)
assert.equal(mixedParts.tick(0), true, 'mixed: tick must report motion right after all-open')
const mixedOpenElapsed = settle(mixedParts)
const mixedCorner = mixedLeafCorner()
assert.ok(Math.abs(mixedCorner.x - 0.45) < 1e-6 && Math.abs(mixedCorner.y - 0.5) < 1e-6 && Math.abs(mixedCorner.z + 0.779422863) < 1e-6,
  'mixed: the revolute panel corner is ' + mixedCorner.toArray().map(value => value.toFixed(4)).join(', ') + ', expected (0.45, 0.5, -0.7794)')
assertVectorClose(mixedTrayOrigin(), new THREE.Vector3(1.8, 0.2, 0), 1e-6, 'mixed: the prismatic tray origin')
assertMatrixClose(mixedPlatePose(), mixedPlateRest, 1e-9, 'mixed: the fixed-joint body moved on all-open')
assertMatrixClose(bodyStageMatrix(mixedRoot, '/Mixed/Bodies/base'), mixedBaseRest, 1e-9, 'mixed: the root body moved on all-open')
// 0.3 / 0.4 = 0.75 of the travel at 0.8 travel/s = 1250 ms; the hinge is faster.
assert.ok(mixedOpenElapsed >= 1200 && mixedOpenElapsed <= 1400, 'mixed: all-open settled after ' + mixedOpenElapsed + ' ms')
// Already at both limits: asking again is a no-op rather than a drift.
mixedParts.setAll(true)
assert.equal(mixedParts.tick(16), false, 'mixed: a stage already at its limits still reported motion')
say('controller mixed open   revolute 60 deg (clamped from 120), prismatic +0.3 (clamped from 0.6), fixed body still')

mixedParts.setAll(false)
settle(mixedParts)
assertRestPose(mixedRoot, mixedRest, 1e-9, 'mixed close')
say('controller mixed close  both drivable parts back at the authored pose to 1e-9')

// All open / All close alternation, twice, each endpoint asserted.
for (let cycle = 0; cycle < 2; cycle += 1) {
  mixedParts.setAll(true)
  settle(mixedParts)
  assertVectorClose(mixedLeafCorner(), new THREE.Vector3(0.45, 0.5, -0.779422863), 1e-6, 'mixed: all-open cycle ' + cycle)
  mixedParts.setAll(false)
  settle(mixedParts)
  assertRestPose(mixedRoot, mixedRest, 1e-9, 'mixed: all-close cycle ' + cycle)
}
say('controller mixed all    All open/All close x2 alternation, each endpoint exact')

// Home interrupts both joints mid-travel.
mixedParts.setAll(true)
mixedParts.tick(250)
mixedParts.tick(250)
const mixedMidCorner = mixedLeafCorner()
const mixedMidTray = mixedTrayOrigin()
assert.ok(mixedMidCorner.z < -1e-3 && mixedMidCorner.z > -0.779422863, 'mixed: the hinge was not mid-swing')
assert.ok(mixedMidTray.x > 1.5 + 1e-3 && mixedMidTray.x < 1.8, 'mixed: the tray was not mid-slide')
assert.equal(mixedParts.tick(0), true, 'mixed: tick at a mid-animation clock must still report motion')
mixedParts.home()
settle(mixedParts)
assertRestPose(mixedRoot, mixedRest, 1e-6, 'mixed home mid-animation')
assert.equal(mixedParts.tick(1000), false, 'mixed: tick after home reported motion')
say('controller mixed home   mid-travel reset of both joints, rest pose to 1e-6')

// Picking drives exactly one joint, and the other stays where it was.
assert.equal(mixedParts.pick([]), false)
assert.equal(mixedParts.pick(undefined), false)
assert.equal(mixedParts.pick([{ object: mixedPlate }]), false, 'mixed: pick on the fixed-joint body moved something')
assert.equal(mixedParts.pick([{ object: mixedRoot.getObjectByName('/Mixed/Bodies/base/mount') }]), false, 'mixed: pick on the root body moved something')
assert.equal(mixedParts.pick([{ object: mixedRoot }]), false, 'mixed: pick on a group moved something')
assert.equal(mixedParts.pick([{ object: mixedLeaf }]), true, 'mixed: pick on the leaf did not toggle the hinge')
settle(mixedParts)
assertVectorClose(mixedLeafCorner(), new THREE.Vector3(0.45, 0.5, -0.779422863), 1e-6, 'mixed: pick opened the leaf')
assertVectorClose(mixedTrayOrigin(), new THREE.Vector3(1.5, 0.2, 0), 1e-6, 'mixed: opening the leaf moved the tray')
const mixedLeafOpenPose = mixedLeafBodyPose().clone()
assert.equal(mixedParts.pick([{ object: mixedTray }]), true, 'mixed: pick on the tray did not toggle the slide')
settle(mixedParts)
assertVectorClose(mixedTrayOrigin(), new THREE.Vector3(1.8, 0.2, 0), 1e-6, 'mixed: pick opened the tray')
assertMatrixClose(mixedLeafBodyPose(), mixedLeafOpenPose, 1e-9, 'mixed: opening the tray moved the already-open leaf')
assert.equal(mixedParts.pick([{ object: mixedLeaf }]), true, 'mixed: the second leaf pick did not close it')
settle(mixedParts)
assertVectorClose(mixedLeafCorner(), new THREE.Vector3(0.9, 0.5, 0), 1e-6, 'mixed: the leaf did not close')
assertVectorClose(mixedTrayOrigin(), new THREE.Vector3(1.8, 0.2, 0), 1e-6, 'mixed: closing the leaf moved the open tray')
mixedParts.home()
settle(mixedParts)
assertRestPose(mixedRoot, mixedRest, 1e-6, 'mixed pick sequence home')
say('controller mixed pick   leaf and tray drive independently; fixed-joint body and root are no-ops')
mixedParts.dispose()

// ── colliders: on/on/off/on/off is idempotent and dispose releases ─────────

const colliderRoot = makeMixedScene()
const colliderRest = snapshotStage(colliderRoot)
const mixedColliderParts = createArticulationController(colliderRoot, mixed)
assert.ok(mixedColliderParts !== undefined, 'colliders: the controller refused to bind')
assert.equal(mixedColliderParts.hasColliders, true)
assertRestPose(colliderRoot, colliderRest, 1e-9, 'colliders bind')
const colliderLeafGroup = bodyGroup(colliderRoot, '/Mixed/Bodies/leaf')
const overlayGroups = () => colliderLeafGroup.children.filter(child => /\(collider\)$/.test(child.name))
assert.equal(overlayGroups().length, 0, 'colliders: an overlay exists before it was asked for')
mixedColliderParts.setCollidersVisible(true)
assert.equal(overlayGroups().length, 1, 'colliders: show built ' + overlayGroups().length + ' overlays instead of one')
const mixedOverlay = overlayGroups()[0]
assert.equal(mixedOverlay.visible, true, 'colliders: the overlay was not made visible')
const mixedOverlayShell = mixedOverlay.children.find(child => child.isMesh === true)
assert.ok(mixedOverlayShell !== undefined, 'colliders: the overlay has no shell mesh')
const mixedHullPoint = new THREE.Vector3().fromBufferAttribute(mixedOverlayShell.geometry.getAttribute('position'), 0)
assert.ok(Math.abs(mixedHullPoint.x) < 1e-6 && Math.abs(mixedHullPoint.y - 0.5) < 1e-6 && Math.abs(mixedHullPoint.z + 0.04) < 1e-6,
  'colliders: the overlay point is ' + mixedHullPoint.toArray().map(value => value.toFixed(3)).join(', ') + ', expected (0, 0.5, -0.04)')
// Showing twice must not duplicate or rebuild the overlay.
mixedColliderParts.setCollidersVisible(true)
assert.equal(overlayGroups().length, 1, 'colliders: showing twice built a duplicate overlay')
assert.equal(overlayGroups()[0], mixedOverlay, 'colliders: the second show rebuilt the overlay')
mixedColliderParts.setCollidersVisible(false)
assert.equal(mixedOverlay.visible, false, 'colliders: hiding left the overlay visible')
mixedColliderParts.setCollidersVisible(true)
assert.equal(overlayGroups()[0], mixedOverlay, 'colliders: re-showing rebuilt the overlay')
assert.equal(mixedOverlay.visible, true, 'colliders: re-showing did not make the overlay visible')
mixedColliderParts.setCollidersVisible(false)
mixedColliderParts.dispose()
assert.equal(colliderRoot.children.length, 4, 'colliders: dispose left body groups behind')
assert.equal(colliderLeafGroup.parent, null, 'colliders: dispose left the body group parented')
assert.equal(mixedOverlay.parent, null, 'colliders: dispose left the overlay parented')
say('controller colliders   one body-attached overlay, on/on/off/on/off idempotent, dispose releases it')

// ── the door: an open/close/open state machine on one revolute joint ───────

const doorStateRoot = doorScene()
const doorStateRest = snapshotStage(doorStateRoot)
const doorParts = createArticulationController(doorStateRoot, door)
assert.ok(doorParts !== undefined, 'door state: the controller refused to bind')
const doorPanel = doorStateRoot.getObjectByName('/Door/Bodies/frame/leaf/panel')
const doorCorner = () => stagePointOf(doorStateRoot, doorPanel, 0.9, -0.5, 0)
assertVectorClose(doorCorner(), new THREE.Vector3(0.9, 0.5, 0), 1e-6, 'door state: rest corner')

// open -> close -> open, every endpoint asserted.
for (const [expected, label] of [
  [new THREE.Vector3(0, 0.5, -0.9), 'open'],
  [new THREE.Vector3(0.9, 0.5, 0), 'close'],
  [new THREE.Vector3(0, 0.5, -0.9), 'open again'],
]) {
  assert.equal(doorParts.pick([{ object: doorPanel }]), true, 'door state: pick for ' + label + ' changed nothing')
  settle(doorParts)
  assertVectorClose(doorCorner(), expected, 1e-6, 'door state: ' + label)
}
say('controller door click   open -> close -> open, corner (0, 0.5, -0.9) <-> (0.9, 0.5, 0) exact')

// All open / All close alternation.
for (let cycle = 0; cycle < 2; cycle += 1) {
  doorParts.setAll(true)
  settle(doorParts)
  assertVectorClose(doorCorner(), new THREE.Vector3(0, 0.5, -0.9), 1e-6, 'door state: all-open cycle ' + cycle)
  doorParts.setAll(false)
  settle(doorParts)
  assertRestPose(doorStateRoot, doorStateRest, 1e-9, 'door state: all-close cycle ' + cycle)
}
say('controller door all     All open/All close x2 alternation, each endpoint exact')

// Home interrupts the swing; the joint has to land exactly on the authored pose.
assert.equal(doorParts.pick([{ object: doorPanel }]), true)
doorParts.tick(300)
const doorMidCorner = doorCorner()
assert.ok(doorMidCorner.z < -1e-3 && doorMidCorner.z > -0.9, 'door state: the leaf was not mid-swing')
doorParts.home()
settle(doorParts)
assertRestPose(doorStateRoot, doorStateRest, 1e-6, 'door state: home mid-swing')
say('controller door home    mid-swing reset to the authored pose (1e-6)')

// A click at the travel limit reverses toward home instead of overshooting.
assert.equal(hinge.open, hinge.upper, 'door state: the fixture open pose should sit on the upper limit')
doorParts.setAll(true)
settle(doorParts)
assert.ok(Math.abs(doorCorner().z + 0.9) < 1e-9, 'door state: the open endpoint is not exactly the authored limit')
assert.equal(doorParts.pick([{ object: doorPanel }]), true, 'door state: a click at the limit started no motion')
settle(doorParts)
assertVectorClose(doorCorner(), new THREE.Vector3(0.9, 0.5, 0), 1e-6, 'door state: the click at the limit overshot')
say('controller door limit   settled on 90 deg exactly, a click at the limit reverses (no overshoot)')

// Timing boundary: the whole swing is the authored 110 deg/s (818 ms), and a
// non-positive delta neither advances the clock nor changes the pose.
assertRestPose(doorStateRoot, doorStateRest, 1e-6, 'door state: before timing')
assert.equal(doorParts.pick([{ object: doorPanel }]), true)
let swingMs = 0
while (doorParts.tick(16) === true) {
  swingMs += 16
  assert.ok(swingMs <= 2000, 'door state: the swing never settled')
}
assert.ok(swingMs >= 800 && swingMs <= 850, 'door state: the 90 deg swing took ' + swingMs + ' ms of 16 ms ticks')
// A non-positive delta must not move the animation clock.
assert.equal(doorParts.pick([{ object: doorPanel }]), true)
doorParts.tick(100)
const beforeNegative = doorCorner()
assert.equal(doorParts.tick(-100), true, 'door state: a negative delta stopped reporting motion')
assertVectorClose(doorCorner(), beforeNegative, 1e-12, 'door state: a negative delta advanced the pose')
doorParts.home()
settle(doorParts)
assertRestPose(doorStateRoot, doorStateRest, 1e-6, 'door state: after timing')
say('controller door timing  a full 90 deg swing is ' + swingMs + ' ms of 16 ms ticks; delta <= 0 does not advance')

// Rapid picks: five toggles with no tick between them all target the open pose
// (the value has not moved yet), then a Home has to restore the rest pose.
for (let click = 0; click < 5; click += 1) assert.equal(doorParts.pick([{ object: doorPanel }]), true)
settle(doorParts)
assertVectorClose(doorCorner(), new THREE.Vector3(0, 0.5, -0.9), 1e-6, 'door state: rapid picks did not settle open')
doorParts.home()
settle(doorParts)
assertRestPose(doorStateRoot, doorStateRest, 1e-6, 'door state: home after rapid picks')
say('controller door rapid   5 picks without ticks settle open, home restores the rest pose')

// Closing is frame-rate independent too: 50 x 20 ms and one 1000 ms tick land
// on the same body pose.
const closeFastRoot = doorScene()
const closeFastParts = createArticulationController(closeFastRoot, door)
closeFastParts.setAll(true)
settle(closeFastParts)
closeFastParts.setAll(false)
for (let step = 0; step < 50; step += 1) closeFastParts.tick(20)
const closeSlowRoot = doorScene()
const closeSlowParts = createArticulationController(closeSlowRoot, door)
closeSlowParts.setAll(true)
settle(closeSlowParts)
closeSlowParts.setAll(false)
closeSlowParts.tick(1000)
assertMatrixClose(
  stageMatrixOf(closeFastRoot, closeFastRoot.getObjectByName('/Door/Bodies/frame/leaf')),
  stageMatrixOf(closeSlowRoot, closeSlowRoot.getObjectByName('/Door/Bodies/frame/leaf')),
  1e-9,
  'door close: twenty-millisecond ticks and one thousand-millisecond tick disagree',
)
closeFastParts.dispose()
closeSlowParts.dispose()
doorParts.dispose()
say('controller door close   50 x 20 ms == 1 x 1000 ms (frame-rate independent in both directions)')

// ── the drawer: prismatic travel, reverse and limits ──────────────────────

const drawerStateRoot = makeDrawerScene()
const drawerStateRest = snapshotStage(drawerStateRoot)
const drawerParts = createArticulationController(drawerStateRoot, drawer)
assert.ok(drawerParts !== undefined, 'drawer: the controller refused to bind')
assert.equal(drawerParts.movingParts, 1, 'drawer: movingParts')
const drawerTray = drawerStateRoot.getObjectByName('/Drawer/Bodies/tray/front')
const drawerTrayOrigin = () => new THREE.Vector3().setFromMatrixPosition(bodyStageMatrix(drawerStateRoot, '/Drawer/Bodies/tray'))
const drawerCarcassRest = bodyStageMatrix(drawerStateRoot, '/Drawer/Bodies/carcass').clone()
assert.equal(slide.open, slide.upper, 'drawer: the fixture open pose should sit on the upper limit')

assert.equal(drawerParts.pick([{ object: drawerTray }]), true, 'drawer: pick on the tray did not toggle the slide')
settle(drawerParts)
assertVectorClose(drawerTrayOrigin(), new THREE.Vector3(0.45, 0.2, 0), 1e-6, 'drawer: the open tray origin')
assertMatrixClose(bodyStageMatrix(drawerStateRoot, '/Drawer/Bodies/carcass'), drawerCarcassRest, 1e-9, 'drawer: the fixed carcass moved')
assert.equal(drawerParts.tick(16), false, 'drawer: tick after settling reported motion')
assert.equal(drawerParts.pick([{ object: drawerTray }]), true, 'drawer: the second pick did not toggle back')
settle(drawerParts)
assertRestPose(drawerStateRoot, drawerStateRest, 1e-9, 'drawer reverse')
say('controller drawer       prismatic +0.4 exactly to its limit, reverse click returns to rest, carcass still')

// Home interrupts the slide.
assert.equal(drawerParts.pick([{ object: drawerTray }]), true)
drawerParts.tick(300)
assert.ok(drawerTrayOrigin().x > 0.05 + 1e-3 && drawerTrayOrigin().x < 0.45, 'drawer: the tray was not mid-slide')
drawerParts.home()
settle(drawerParts)
assertRestPose(drawerStateRoot, drawerStateRest, 1e-6, 'drawer home mid-slide')
say('controller drawer home  mid-slide reset to the authored pose (1e-6)')

// All open / All close alternation and frame-rate independence.
for (let cycle = 0; cycle < 2; cycle += 1) {
  drawerParts.setAll(true)
  settle(drawerParts)
  assertVectorClose(drawerTrayOrigin(), new THREE.Vector3(0.45, 0.2, 0), 1e-6, 'drawer: all-open cycle ' + cycle)
  assert.equal(drawerParts.tick(16), false, 'drawer: already at the limit still reported motion')
  drawerParts.setAll(false)
  settle(drawerParts)
  assertRestPose(drawerStateRoot, drawerStateRest, 1e-9, 'drawer: all-close cycle ' + cycle)
}
const drawerFastRoot = makeDrawerScene()
const drawerFastParts = createArticulationController(drawerFastRoot, drawer)
drawerFastParts.setAll(true)
for (let step = 0; step < 50; step += 1) drawerFastParts.tick(20)
const drawerSlowRoot = makeDrawerScene()
const drawerSlowParts = createArticulationController(drawerSlowRoot, drawer)
drawerSlowParts.setAll(true)
drawerSlowParts.tick(1000)
assertMatrixClose(
  stageMatrixOf(drawerFastRoot, drawerFastRoot.getObjectByName('/Drawer/Bodies/tray')),
  stageMatrixOf(drawerSlowRoot, drawerSlowRoot.getObjectByName('/Drawer/Bodies/tray')),
  1e-9,
  'drawer: twenty-millisecond ticks and one thousand-millisecond tick disagree',
)
drawerFastParts.dispose()
drawerSlowParts.dispose()
drawerParts.dispose()
say('controller drawer all   All open/All close x2 alternation, 50 x 20 ms == 1 x 1000 ms')

// ── the chain: per-joint independence and forward kinematics ──────────────

const chainStateRoot = makeChainScene()
const chainStateRest = snapshotStage(chainStateRoot)
const chainStateParts = createArticulationController(chainStateRoot, chain)
assert.ok(chainStateParts !== undefined, 'chain state: the controller refused to bind')
assert.equal(chainStateParts.movingParts, 2, 'chain state: movingParts')
const chainArmMesh = chainStateRoot.getObjectByName('/Chain/Bodies/arm/beam')
const chainHandMesh = chainStateRoot.getObjectByName('/Chain/Bodies/hand/claw')
const chainArmPose = () => bodyStageMatrix(chainStateRoot, '/Chain/Bodies/arm')
const chainHandPose = () => bodyStageMatrix(chainStateRoot, '/Chain/Bodies/hand')
const chainHandOrigin = () => new THREE.Vector3().setFromMatrixPosition(chainHandPose())
const chainHandRest = chainHandOrigin().clone()
// The hand joint's pivot sits on the hand body origin, so driving that joint
// moves the hand's geometry, not its origin: pose checks use a claw corner.
const chainHandCorner = () => stagePointOf(chainStateRoot, chainHandMesh, 0.2, 0.05, 0.1)
const chainHandCornerRest = chainHandCorner().clone()
const chainArmRest = chainArmPose().clone()
const chainBaseRest = bodyStageMatrix(chainStateRoot, '/Chain/Bodies/base').clone()

// The downstream joint drives only the hand: the arm stays exactly at rest.
assert.equal(chainStateParts.pick([{ object: chainHandMesh }]), true, 'chain state: pick on the hand did not toggle its joint')
settle(chainStateParts)
assert.ok(chainHandCorner().distanceTo(chainHandCornerRest) > 0.1, 'chain state: the hand did not move when its own joint was driven')
assertMatrixClose(chainArmPose(), chainArmRest, 1e-9, 'chain state: driving the hand moved the arm')
chainStateParts.home()
settle(chainStateParts)

// The upstream joint drives the arm, and the hand follows through the tree.
assert.equal(chainStateParts.pick([{ object: chainArmMesh }]), true, 'chain state: pick on the arm did not toggle its joint')
settle(chainStateParts)
const chainHandAfterArm = chainHandOrigin().clone()
assert.ok(chainHandAfterArm.distanceTo(chainHandRest) > 0.3, 'chain state: the hand did not follow the arm')
assertMatrixClose(bodyStageMatrix(chainStateRoot, '/Chain/Bodies/base'), chainBaseRest, 1e-9, 'chain state: upstream drive moved the base')
// The joint frames are shared: from either body they describe the same point.
for (const joint of chain.joints) {
  const body0 = stageMatrixOf(chainStateRoot, bodyGroup(chainStateRoot, joint.body0))
  const body1 = stageMatrixOf(chainStateRoot, bodyGroup(chainStateRoot, joint.body1))
  const frame = new THREE.Matrix4().fromArray(joint.frame)
  const pivotRest = new THREE.Vector3().setFromMatrixPosition(frame)
  const restRelative = new THREE.Matrix4().fromArray(chain.bodies.find(body => body.path === joint.body0).matrix)
  void restRelative
  const fromBody0 = pivotRest.clone().applyMatrix4(new THREE.Matrix4().fromArray(chain.bodies.find(body => body.path === joint.body0).matrix).invert()).applyMatrix4(body0)
  const fromBody1 = pivotRest.clone().applyMatrix4(new THREE.Matrix4().fromArray(chain.bodies.find(body => body.path === joint.body1).matrix).invert()).applyMatrix4(body1)
  assert.ok(fromBody0.distanceTo(fromBody1) < 1e-9, joint.path + ': the joint frames came apart under the arm drive')
}
// Driving the hand while the arm is open moves the hand and leaves the arm alone.
const chainArmOpenPose = chainArmPose().clone()
const chainHandAfterArmOnly = chainHandOrigin().clone()
const chainHandCornerAfterArm = chainHandCorner().clone()
assert.equal(chainStateParts.pick([{ object: chainHandMesh }]), true, 'chain state: pick on the open hand did not toggle')
settle(chainStateParts)
assertMatrixClose(chainArmPose(), chainArmOpenPose, 1e-9, 'chain state: driving the hand moved the open arm')
assert.ok(chainHandCorner().distanceTo(chainHandCornerAfterArm) > 0.1, 'chain state: the hand did not move under the combination')
// Closing the hand restores only the hand's own travel, leaving the arm open.
assert.equal(chainStateParts.pick([{ object: chainHandMesh }]), true)
settle(chainStateParts)
assertMatrixClose(chainArmPose(), chainArmOpenPose, 1e-9, 'chain state: closing the hand moved the arm')
assert.ok(chainHandCorner().distanceTo(chainHandCornerAfterArm) < 1e-6, 'chain state: closing the hand did not return it to the arm-only pose')
chainStateParts.home()
settle(chainStateParts)
assertRestPose(chainStateRoot, chainStateRest, 1e-6, 'chain state: home after independent drives')
say('controller chain joints arm and hand drive independently, upstream motion reaches the hand (FK), frames coincident')

// Both joints at once moves the hand further than either alone.
chainStateParts.setAll(true)
settle(chainStateParts)
// The hand joint's pivot is the hand body origin, so a claw corner (not the
// origin) is what distinguishes "arm only" from "both joints driven".
const chainHandBothCorner = chainHandCorner().clone()
assert.ok(
  chainHandBothCorner.distanceTo(chainHandCornerRest) > chainHandCornerAfterArm.distanceTo(chainHandCornerRest),
  'chain state: driving both joints moved the hand no further than the arm alone',
)
for (const joint of chain.joints) {
  const body0 = stageMatrixOf(chainStateRoot, bodyGroup(chainStateRoot, joint.body0))
  const body1 = stageMatrixOf(chainStateRoot, bodyGroup(chainStateRoot, joint.body1))
  const frame = new THREE.Matrix4().fromArray(joint.frame)
  const pivotRest = new THREE.Vector3().setFromMatrixPosition(frame)
  const fromBody0 = pivotRest.clone().applyMatrix4(new THREE.Matrix4().fromArray(chain.bodies.find(body => body.path === joint.body0).matrix).invert()).applyMatrix4(body0)
  const fromBody1 = pivotRest.clone().applyMatrix4(new THREE.Matrix4().fromArray(chain.bodies.find(body => body.path === joint.body1).matrix).invert()).applyMatrix4(body1)
  assert.ok(fromBody0.distanceTo(fromBody1) < 1e-9, joint.path + ': the joint frames came apart when both joints were driven')
}
chainStateParts.setAll(false)
settle(chainStateParts)
assertRestPose(chainStateRoot, chainStateRest, 1e-9, 'chain state: all-close')
chainStateParts.dispose()
say('controller chain all    both joints driven at once, frames coincident, all-close rest to 1e-9')

// ── envelope: every pose the mixed controls can command stays inside ───────

const envelopeRoot = makeMixedScene()
const envelopeParts = createArticulationController(envelopeRoot, mixed)
assert.ok(envelopeParts !== undefined, 'envelope: the controller refused to bind')
const mixedEnvelope = envelopeParts.extremeBounds()
assert.ok(mixedEnvelope !== undefined, 'envelope: a drivable stage returned no envelope')
assert.equal(Object.getPrototypeOf(mixedEnvelope), Object.prototype, 'envelope: the envelope must be a plain object')
assert.equal(Array.isArray(mixedEnvelope.min) && mixedEnvelope.min.length === 3, true, 'envelope: min must be three plain numbers')
assert.equal(Array.isArray(mixedEnvelope.max) && mixedEnvelope.max.length === 3, true, 'envelope: max must be three plain numbers')
// The revolute swing must reach -Z and the prismatic travel +X.
assert.ok(mixedEnvelope.min[2] <= -0.78, 'envelope: the revolute swing into -Z is missing (min z ' + mixedEnvelope.min[2] + ')')
assert.ok(mixedEnvelope.max[0] >= 1.94, 'envelope: the prismatic travel is missing (max x ' + mixedEnvelope.max[0] + ')')
assert.ok(mixedEnvelope.max[1] >= 1.7, 'envelope: the upper fixed body is missing (max y ' + mixedEnvelope.max[1] + ')')
const mixedVertexNames = MIXED_MESHES.map(entry => entry.name)
const insideMixed = label => assertInsideEnvelope(mixedEnvelope, stageVertices(envelopeRoot, mixedVertexNames), label)
insideMixed('envelope: rest pose')
assert.equal(envelopeParts.pick([{ object: envelopeRoot.getObjectByName('/Mixed/Bodies/leaf/panel') }]), true)
settle(envelopeParts)
insideMixed('envelope: leaf open')
envelopeParts.home()
settle(envelopeParts)
assert.equal(envelopeParts.pick([{ object: envelopeRoot.getObjectByName('/Mixed/Bodies/tray/front') }]), true)
settle(envelopeParts)
insideMixed('envelope: tray open')
envelopeParts.setAll(true)
settle(envelopeParts)
insideMixed('envelope: both open')
envelopeParts.setAll(false)
settle(envelopeParts)
envelopeParts.setAll(true)
envelopeParts.tick(250)
envelopeParts.tick(250)
insideMixed('envelope: mid-arc')
envelopeParts.home()
settle(envelopeParts)
envelopeParts.dispose()
say('controller envelope     rest + each single joint + both open + mid-arc inside extremeBounds (min z <= -0.78, max x >= 1.94)')

// ── pick hit/miss matrix ──────────────────────────────────────────────────

const pickRoot = doorScene()
const pickParts = createArticulationController(pickRoot, door)
assert.ok(pickParts !== undefined, 'pick matrix: the controller refused to bind')
assert.equal(pickParts.pick([]), false, 'pick matrix: an empty hit list reported a toggle')
assert.equal(pickParts.pick(undefined), false, 'pick matrix: an undefined hit list reported a toggle')
assert.equal(pickParts.pick([null, undefined]), false, 'pick matrix: null hits reported a toggle')
assert.equal(pickParts.pick([{ object: null }]), false, 'pick matrix: a null object reported a toggle')
assert.equal(pickParts.pick([{ object: pickRoot }]), false, 'pick matrix: a group with no body reported a toggle')
assert.equal(pickParts.pick([{ object: pickRoot.getObjectByName('/Door/Bodies/frame/post') }]), false, 'pick matrix: the fixed frame reported a toggle')
assert.equal(pickParts.pick([{ object: pickRoot.getObjectByName('/Door/Static/instanced') }]), false, 'pick matrix: an unowned mesh reported a toggle')
assert.equal(pickParts.pick([{ object: pickRoot.getObjectByName('/Door/Bodies/frame/leaf/instanced') }]), false, 'pick matrix: an InstancedMesh batch reported a toggle')
assert.equal(pickParts.pick([{ object: pickRoot.getObjectByName('/Door/Bodies/frame/leaf/panel') }]), true, 'pick matrix: the drivable leaf reported nothing')
settle(pickParts)
pickParts.dispose()
say('controller pick matrix  empty/null/group/fixed/unowned/instanced -> false, drivable leaf -> true')

// ── a real articulated asset, when the environment points at one ───────────

// The authored fixtures above are enough to prove the parser and the controller,
// but they are committed, hand-written layers. This opt-in case runs the same
// contract over a real exported `.usdc` asset: set DSH_USD_TEST_SIMREADY to the
// asset file (a sibling `colliders.usdc` next to it is supplied automatically).
// Without the variable the section reports itself skipped and the suite still
// covers everything the committed fixtures can prove.
const realAssetFile = process.env.DSH_USD_TEST_SIMREADY
if (realAssetFile === undefined || realAssetFile === '' || existsSync(realAssetFile) === false) {
  say('real asset             skipped (set DSH_USD_TEST_SIMREADY to a real articulated .usdc asset to enable)')
} else {
  const sources = new Map()
  sources.set(basename(realAssetFile), new Blob([new Uint8Array(await readFile(realAssetFile))]))
  const colliderFile = join(dirname(realAssetFile), 'colliders.usdc')
  if (existsSync(colliderFile)) sources.set(basename(colliderFile), new Blob([new Uint8Array(await readFile(colliderFile))]))
  const assetStarted = Date.now()
  const asset = await readArticulation(sources)
  const assetMs = Date.now() - assetStarted
  assert.ok(asset !== undefined, 'the real asset read as undefined')
  assert.ok(asset.bodies.length > 0, 'the real asset declared no rigid bodies')
  assert.ok(asset.joints.length > 0, 'the real asset declared no joints')
  assert.equal(
    asset.tree.length,
    asset.bodies.length - asset.roots.length,
    'every body but a root must be attached to the tree by a joint',
  )
  const bodyPaths = new Set(asset.bodies.map(body => body.path))
  for (const joint of asset.joints) {
    assert.ok(bodyPaths.has(joint.body0), joint.path + ': body0 is not a declared body')
    assert.ok(bodyPaths.has(joint.body1), joint.path + ': body1 is not a declared body')
  }
  assert.deepEqual(asset.warnings, [], 'the real asset produced warnings')
  say('real asset             ' + asset.bodies.length + ' bodies  ' + asset.joints.length
    + ' joints  ' + asset.tree.length + ' tree edges  ' + asset.colliders.length
    + ' colliders  (' + assetMs + ' ms, ' + sources.size + ' layers)')

  // The controller has to bind the real graph too: three meshes under every body.
  const assetRoot = new THREE.Group()
  assetRoot.name = 'usd'
  let meshCount = 0
  for (const body of asset.bodies) {
    for (let index = 0; index < 3; index += 1) {
      assetRoot.add(meshNode(body.path + '/lo/m00' + index, translation(index * 0.1, 0, 0)))
      meshCount += 1
    }
  }
  assetRoot.updateMatrixWorld(true)
  const assetParts = createArticulationController(assetRoot, asset)
  assert.ok(assetParts !== undefined, 'the real articulation did not bind')
  assert.ok(assetParts.movingParts >= 1, 'the real articulation reported no moving parts')
  const restPositions = []
  assetRoot.updateMatrixWorld(true)
  assetRoot.traverse((node) => {
    if (node.isMesh === true) restPositions.push(new THREE.Vector3().setFromMatrixPosition(node.matrixWorld))
  })
  const realExtremes = assetParts.extremeBounds()
  assert.ok(realExtremes !== undefined, 'the real articulation returned no framing envelope')
  const inEnvelope = (point) => (
    point.x >= realExtremes.min[0] - 1e-6 && point.x <= realExtremes.max[0] + 1e-6
    && point.y >= realExtremes.min[1] - 1e-6 && point.y <= realExtremes.max[1] + 1e-6
    && point.z >= realExtremes.min[2] - 1e-6 && point.z <= realExtremes.max[2] + 1e-6
  )
  for (const point of restPositions) assert.ok(inEnvelope(point), 'the rest pose left the framing envelope')
  assetParts.setAll(true)
  const settleFrames = settle(assetParts, 16)
  assetRoot.updateMatrixWorld(true)
  const openedOutside = []
  assetRoot.traverse((node) => {
    if (node.isMesh !== true) return
    const point = new THREE.Vector3().setFromMatrixPosition(node.matrixWorld)
    if (inEnvelope(point) === false) openedOutside.push(node.name)
  })
  assert.deepEqual(openedOutside, [], 'the open pose left the framing envelope')
  if (assetParts.hasColliders === true) {
    assetParts.setCollidersVisible(true)
    const hulls = []
    assetRoot.traverse((node) => { if (node.isGroup === true && /\(collider\)/.test(node.name) === true) hulls.push(node) })
    assert.ok(hulls.length > 0, 'hasColliders was true but no collision overlay was built')
    const underBodies = hulls.every(hull => asset.bodies.some(body => body.path === hull.parent.name))
    assert.equal(underBodies, true, 'a collision overlay was not attached to its body group')
    assetParts.setCollidersVisible(false)
  }
  assetParts.dispose()
  assert.equal(assetRoot.children.length, meshCount, 'dispose left the real scene dirty')
  say('real asset controller  ' + assetParts.movingParts + ' moving parts  ' + meshCount
    + ' meshes under ' + asset.bodies.length + ' bodies  settled ' + settleFrames + ' ms')
}

say('articulation.test.mjs  OK')
