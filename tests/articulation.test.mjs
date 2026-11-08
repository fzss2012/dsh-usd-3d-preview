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
 *   * that interaction is reversible — open/close, home, pick and dispose all
 *     have to end where they started, because the caller frees the geometry
 *     right after dispose.
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
