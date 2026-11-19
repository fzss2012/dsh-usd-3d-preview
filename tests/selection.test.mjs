/**
 * The selection highlight, in Node: what the tint is made of, what it follows,
 * and — the part that matters most — what it gives back.
 *
 * A highlight is easy to draw and easy to leak: a copy parented under a mesh,
 * holding the engine's geometry and a material the view owns. The rules this
 * suite pins down are the ones that decide whether it is an annotation or a bug:
 *
 *   * the copy shares the source's geometry (no vertex is duplicated) and sits at
 *     the identity transform under the object it highlights, so a joint that moves
 *     that object moves the tint with it, for free;
 *   * it raycasts as nothing, so a second click finds the model and not the tint;
 *   * one placement of an instanced batch is tinted, not the whole batch;
 *   * a target with no surface (a group, a point cloud) is reported as *not*
 *     highlighted instead of drawing something invented;
 *   * clearing restores the exact object tree, and disposing releases the tint
 *     material without ever disposing the caller's geometry;
 *   * the wireframe mode reaches a highlight created after it was switched on.
 *
 * Run: node tests/selection.test.mjs
 */
import assert from 'node:assert/strict'
import * as THREE from 'three'
import { createSelectionHighlight } from '../src/client/selection.js'

/** A scene with one parented mesh, the shape the engine's roots have. */
function makeScene() {
  const scene = new THREE.Scene()
  const group = new THREE.Group()
  group.name = '/World/Body'
  const geometry = new THREE.BoxGeometry(1, 1, 1)
  const material = new THREE.MeshStandardMaterial({ color: 0x888888 })
  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = '/World/Body/Box'
  group.add(mesh)
  scene.add(group)
  scene.updateMatrixWorld(true)
  return { scene, group, mesh, geometry, material }
}

// ── one tint, parented to the object it highlights ───────────────────────────
{
  const { scene, group, mesh, geometry } = makeScene()
  const highlight = createSelectionHighlight()
  const childrenBefore = mesh.children.length

  const showing = highlight.set({ object: mesh })
  assert.equal(showing, true, 'a mesh must be highlightable')
  assert.equal(highlight.active(), true)

  const copy = mesh.children[mesh.children.length - 1]
  assert.equal(mesh.children.length, childrenBefore + 1, 'the tint is one child, added to the picked mesh')
  assert.equal(copy.isMesh, true, 'the tint is a mesh')
  assert.equal(copy.geometry, geometry, 'the tint shares the source geometry — no vertex is duplicated')
  assert.equal(copy.parent, mesh, 'the tint is parented to the object it highlights (that is what makes it follow a joint)')
  assert.equal(copy.name, 'selection', 'the copy names what it is: ' + copy.name)
  assert.equal(copy.userData.usdSelection, true, 'the copy is flagged so nothing mistakes it for a prim')
  assert.equal(copy.name.startsWith('/'), false, 'the copy must not look like a prim path: collectPrimPaths keys off the leading slash')
  assert.deepEqual(copy.position.toArray(), [0, 0, 0], 'the copy sits at the identity transform')
  assert.equal(copy.castShadow, false, 'a highlight must not cast a second shadow')
  assert.equal(copy.receiveShadow, false)
  assert.equal(copy.visible, true)
  // A box drawn by a one-sided material stays one-sided under the tint: no face
  // is invented where the model draws nothing.
  assert.equal(copy.material.side, THREE.FrontSide)

  // The material is a tint, not a repaint: transparent, no depth write, nudged
  // towards the camera so a coincident surface cannot z-fight, and not tone-mapped
  // (the accent is UI ink, and the studio's tone mapping would mute it).
  const tint = copy.material
  assert.equal(tint.isMeshBasicMaterial, true, 'the tint is unlit')
  assert.equal(tint.transparent, true)
  assert.ok(tint.opacity > 0.2 && tint.opacity < 0.7, 'the tint covers the surface without hiding it: ' + tint.opacity)
  assert.equal(tint.depthWrite, false, 'the tint must not write depth')
  assert.equal(tint.polygonOffset, true, 'the tint needs a depth nudge to beat z-fighting')
  assert.ok(tint.polygonOffsetFactor < 0, 'the nudge must pull the tint towards the camera')
  assert.equal(tint.toneMapped, false, 'the accent must not be tone-mapped')
  assert.ok(copy.renderOrder > 0, 'the tint draws after the model')
  assert.equal(copy.frustumCulled, false)

  // A second click must find the model through the tint.
  const raycaster = new THREE.Raycaster(new THREE.Vector3(0, 0, 5), new THREE.Vector3(0, 0, -1))
  const hits = raycaster.intersectObject(scene, true)
  assert.ok(hits.length > 0, 'the ray must still hit the model')
  assert.ok(
    hits.every(hit => hit.object !== copy),
    'the highlight must never be the object a pick finds',
  )

  // Moving the parent moves the tint with it, with no per-frame work.
  group.position.set(3, 0, 0)
  scene.updateMatrixWorld(true)
  assert.deepEqual(copy.getWorldPosition(new THREE.Vector3()).toArray(), [3, 0, 0], 'the tint followed its mesh')

  // Selecting again replaces the tint instead of stacking a second one.
  const other = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), new THREE.MeshStandardMaterial())
  other.name = '/World/Other'
  group.add(other)
  assert.equal(highlight.set({ object: other }), true)
  assert.equal(mesh.children.length, childrenBefore, 'the previous tint was taken out of the scene')
  assert.equal(other.children.length, 1, 'the new target carries the tint')
  assert.equal(highlight.active(), true)
  assert.equal(
    other.children[0].material, tint,
    'one material serves every selection: clicking from part to part compiles one program',
  )

  highlight.dispose()
  assert.equal(highlight.active(), false)
  assert.equal(other.children.length, 0, 'dispose takes the tint back out')
  assert.equal(mesh.children.length, childrenBefore)
  assert.equal(geometry.attributes.position !== undefined, true, 'dispose never touches the caller\'s geometry')
}

// ── the tint follows the source's face policy, both ways ────────────────────
{
  // The default scene is one-sided, so asserting FrontSide there proves nothing:
  // a mirrorFacePolicy() that did nothing would pass. This pair is what makes the
  // claim real — a two-sided asset must keep its back faces under the tint, and a
  // one-sided one must not gain a tint where it draws nothing.
  const highlight = createSelectionHighlight()
  const twoSided = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x888888, side: THREE.DoubleSide }),
  )
  twoSided.name = '/World/Shell'
  assert.equal(highlight.set({ object: twoSided }), true)
  const tinted = twoSided.children[twoSided.children.length - 1]
  assert.equal(tinted.material.side, THREE.DoubleSide, 'a two-sided source keeps its back faces under the tint')

  const oneSided = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x888888, side: THREE.FrontSide }),
  )
  oneSided.name = '/World/Plate'
  assert.equal(highlight.set({ object: oneSided }), true)
  assert.equal(
    oneSided.children[oneSided.children.length - 1].material.side,
    THREE.FrontSide,
    'selecting a one-sided source must take the two-sided policy back off the shared tint',
  )
  highlight.dispose()
}

// ── clearing restores the tree exactly ──────────────────────────────────────
{
  const { mesh } = makeScene()
  const highlight = createSelectionHighlight()
  highlight.set({ object: mesh })
  highlight.clear()
  assert.equal(mesh.children.length, 0, 'clear() restores the exact object tree')
  assert.equal(highlight.active(), false)
  // Clearing twice is not an error, and neither is clearing nothing.
  highlight.clear()
  assert.equal(highlight.set(undefined), false, 'clearing through set(undefined) reports "nothing is highlighted"')
  assert.equal(highlight.active(), false)
  highlight.dispose()
}

// ── a target with no surface is refused, not invented ───────────────────────
{
  const { scene, group, mesh } = makeScene()
  const highlight = createSelectionHighlight()
  const points = new THREE.Points(new THREE.BufferGeometry(), new THREE.PointsMaterial())
  points.name = '/World/Dust'
  scene.add(points)
  const line = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial())
  line.name = '/World/Edge'
  scene.add(line)

  assert.equal(highlight.set(undefined), false, 'an empty pick (the background) highlights nothing')
  assert.equal(highlight.set({ object: group }), false, 'a group is not a surface')
  assert.equal(highlight.set({ object: points }), false, 'a point cloud has no surface to tint')
  assert.equal(highlight.set({ object: line }), false, 'a line has no surface to tint')
  assert.equal(highlight.set({ object: null }), false)
  assert.equal(highlight.set({}), false)
  assert.equal(highlight.active(), false)
  assert.equal(group.children.length, 1, 'a refused target left the tree alone (the group still holds only its mesh)')
  assert.equal(mesh.children.length, 0)
  assert.equal(points.children.length, 0)
  assert.equal(line.children.length, 0)

  // A mesh highlighted earlier is dropped when the next click has no surface:
  // "select the background" clears, it does not keep the old tint.
  assert.equal(highlight.set({ object: mesh }), true)
  assert.equal(highlight.set({ object: points }), false)
  assert.equal(highlight.active(), false, 'a refused target cleared the previous selection')
  assert.equal(mesh.children.length, 0)
  highlight.dispose()
}

// ── one placement of an instanced batch ─────────────────────────────────────
{
  const scene = new THREE.Scene()
  const geometry = new THREE.BoxGeometry(1, 1, 1)
  const instanced = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial(), 3)
  instanced.name = '/World/Wheels'
  const matrix = new THREE.Matrix4()
  for (let index = 0; index < 3; index += 1) {
    instanced.setMatrixAt(index, matrix.makeTranslation(index * 2, 0, 0))
  }
  instanced.instanceMatrix.needsUpdate = true
  scene.add(instanced)
  scene.updateMatrixWorld(true)

  const highlight = createSelectionHighlight()
  assert.equal(highlight.set({ object: instanced }), false, 'an instanced batch without a placement cannot be tinted honestly')
  assert.equal(instanced.children.length, 0)

  assert.equal(highlight.set({ object: instanced, instanceId: 1 }), true)
  const copy = instanced.children[instanced.children.length - 1]
  assert.equal(copy.isInstancedMesh, true, 'the tint of a batch is a one-instance batch')
  assert.equal(copy.count, 1, 'exactly one placement is tinted')
  assert.equal(copy.geometry, geometry, 'the placement tint shares the prototype geometry')
  const expected = new THREE.Matrix4()
  instanced.getMatrixAt(1, expected)
  const drawn = new THREE.Matrix4()
  copy.getMatrixAt(0, drawn)
  assert.deepEqual(
    drawn.elements.map(value => Math.round(value * 1e6) / 1e6),
    expected.elements.map(value => Math.round(value * 1e6) / 1e6),
    'the tint carries the clicked placement, not the prototype',
  )
  // The placement is drawn relative to the batch, so the tint's own transform stays
  // the identity; the offset lives in the instance matrix asserted above.
  scene.updateMatrixWorld(true)
  const copyPosition = copy.getWorldPosition(new THREE.Vector3())
  assert.deepEqual(copyPosition.toArray(), [0, 0, 0], 'the tint copy is at the batch origin, as a batch child must be')
  const placementOffset = new THREE.Vector3().setFromMatrixPosition(drawn)
  assert.deepEqual(placementOffset.toArray(), [2, 0, 0], 'the clicked placement carries the instance offset')

  // Out of range, fractional and missing placements are refused.
  assert.equal(highlight.set({ object: instanced, instanceId: 3 }), false, 'an out-of-range placement is refused')
  assert.equal(highlight.set({ object: instanced, instanceId: 0.5 }), false, 'a fractional placement is refused')
  assert.equal(highlight.set({ object: instanced, instanceId: -1 }), false, 'a negative placement is refused')

  highlight.dispose()
  assert.equal(instanced.children.length, 0)
  assert.equal(geometry.attributes.position !== undefined, true, 'the prototype geometry survives dispose')
}

// ── wireframe reaches a highlight created after it was switched on ──────────
{
  const { mesh } = makeScene()
  const highlight = createSelectionHighlight()
  highlight.setWireframe(true)
  highlight.set({ object: mesh })
  const copy = mesh.children[mesh.children.length - 1]
  assert.equal(copy.material.wireframe, true, 'a highlight created in wireframe mode is drawn as wireframe')
  highlight.setWireframe(false)
  assert.equal(copy.material.wireframe, false, 'leaving wireframe mode reaches the live highlight')
  highlight.setWireframe(true)
  assert.equal(highlight.set({ object: mesh }), true)
  assert.equal(mesh.children[mesh.children.length - 1].material.wireframe, true, 'the mode survives a re-selection')
  highlight.dispose()
}

// ── dispose releases the material it owns, and only that ────────────────────
{
  const { mesh, geometry, material } = makeScene()
  const highlight = createSelectionHighlight()
  highlight.set({ object: mesh })
  const copy = mesh.children[mesh.children.length - 1]
  const tint = copy.material

  let tintDisposals = 0
  const tintDispose = tint.dispose.bind(tint)
  tint.dispose = () => { tintDisposals += 1; tintDispose() }
  let geometryDisposals = 0
  const geometryDispose = geometry.dispose.bind(geometry)
  geometry.dispose = () => { geometryDisposals += 1; geometryDispose() }
  let materialDisposals = 0
  const modelDispose = material.dispose.bind(material)
  material.dispose = () => { materialDisposals += 1; modelDispose() }

  highlight.dispose()
  assert.equal(tintDisposals, 1, 'the view\'s tint material is released exactly once')
  assert.equal(geometryDisposals, 0, 'the caller\'s geometry is never disposed by the highlight')
  assert.equal(materialDisposals, 0, 'the model\'s material is never disposed by the highlight')
  assert.equal(mesh.children.length, 0)

  // A disposed highlight can be reused: the view builds a new material on the
  // next selection rather than handing out a released one.
  assert.equal(highlight.set({ object: mesh }), true)
  const second = mesh.children[mesh.children.length - 1]
  assert.notEqual(second.material, tint, 'a re-selection after dispose builds a fresh material')
  highlight.dispose()
}

// ── an instanced tint releases its own placement buffer, not the prototype ──
{
  const scene = new THREE.Scene()
  const geometry = new THREE.BoxGeometry(1, 1, 1)
  const instanced = new THREE.InstancedMesh(geometry, new THREE.MeshStandardMaterial(), 2)
  instanced.name = '/World/Parts'
  instanced.setMatrixAt(0, new THREE.Matrix4())
  instanced.setMatrixAt(1, new THREE.Matrix4().makeTranslation(1, 0, 0))
  instanced.instanceMatrix.needsUpdate = true
  scene.add(instanced)

  const highlight = createSelectionHighlight()
  highlight.set({ object: instanced, instanceId: 1 })
  const copy = instanced.children[0]
  let copyDisposals = 0
  const copyDispose = copy.dispose.bind(copy)
  copy.dispose = () => { copyDisposals += 1; copyDispose() }
  let geometryDisposals = 0
  const geometryDispose = geometry.dispose.bind(geometry)
  geometry.dispose = () => { geometryDisposals += 1; geometryDispose() }

  highlight.clear()
  assert.equal(copyDisposals, 1, 'clearing a placement tint releases its instance buffer')
  assert.equal(geometryDisposals, 0, 'the prototype geometry is the batch\'s, not the tint\'s')
  highlight.dispose()
}

process.stdout.write('selection.test.mjs  OK  (one tint, follows its mesh, one placement, refused surfaces, clean release)\n')
