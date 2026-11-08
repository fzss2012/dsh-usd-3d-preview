/**
 * Kinematics: bind an articulation description to an assembled three root and
 * drive it.
 *
 * {@link readArticulation} in `articulation.js` answers *what the stage
 * declares* from layer bytes. This module answers *what it looks like when it
 * moves*, and it is the only mutable half: it re-parents the assembled meshes
 * into one group per body, writes the forward-kinematics pose there, and owns the
 * animation clock, the pick mapping and the collision overlay. Nothing here reads
 * a layer or knows a file path.
 *
 * The split is deliberate: bytes-to-description has no three objects and no
 * lifetime, so it is testable in Node against a pile of files; description-to-
 * scene has both, and every bug it can have is one a user can see. Keeping them
 * apart is what lets the reading half stay a pure function.
 *
 * ## Coordinates and ownership
 *
 * The assembled root is the stage's own coordinate system, and its transform is
 * the upAxis/units conversion: it is never touched. Body groups are children of
 * that root carrying stage-space matrices, so a mesh's matrix inside a group is
 * `bodyRestWorld^-1 * meshRestWorld`. The controller adds groups, the overlay and
 * animation state, and `dispose()` takes back exactly those: the caller owns the
 * meshes, their geometry and their materials, and frees them after dispose.
 *
 * @module usd3d-preview/kinematics
 */
import * as THREE from 'three'

/** How fast a part moves: a full travel should read clearly but not crawl. */
const ANIMATION = Object.freeze({
  degreesPerSecond: 110,
  rangesPerSecond: 0.8,
  minSeconds: 0.6,
})

/** The stage-path test the reader also uses; local so this module imports nothing. */
function isUnderPath(path, base) {
  return path === base || path.startsWith(base + '/')
}

/** Smootherstep easing: slow at both ends, smooth through the middle. */
function smootherstep(value) {
  const t = Math.min(1, Math.max(0, value))
  return t * t * t * (t * (t * 6 - 15) + 10)
}


/**
 * @typedef {object} ArticulationController
 * @property {number} movingParts - how many joints can be driven (fixed ones excluded).
 * @property {boolean} hasColliders - whether authored collision geometry was found.
 * @property {(deltaMs: number) => boolean} tick - advance the animation by one
 *   frame; `true` while anything is still moving, so an on-demand renderer knows
 *   whether to pull another frame. Animation state only advances here:
 *   `setAll`/`home` start a motion, a frame finishes it.
 * @property {(hits: import('three').Intersection[]) => boolean} pick - toggle whatever joint drives the deepest hit; true when one did.
 * @property {(open: boolean) => void} setAll - animate every drivable joint to its open or closed end.
 * @property {() => void} home - return every joint to its rest value.
 * @property {(visible: boolean) => void} setCollidersVisible - show or hide collision geometry.
 * @property {() => ({ min: [number, number, number], max: [number, number, number] } | undefined)} extremeBounds -
 *   the stage-space envelope to frame: the rest pose unioned with the poses the
 *   controls can reach; `undefined` when nothing is drivable.
 * @property {() => void} dispose - release what this controller added to the root.
 */


/** The accent collision overlays are painted in. */
const COLLIDER_COLOR = 0xff7a1a

/**
 * Crease angle for the hull wireframe.
 *
 * `EdgesGeometry` keeps only edges where the two triangles meet at more than
 * this angle, so a convex hull reads as a shape instead of as its triangulation:
 * the triangle edges inside a flat face disappear, leaving only the creases.
 */
const COLLIDER_CREASE_DEGREES = 15

/**
 * Bind an articulation description to an assembled root.
 * @param root - the assembled three root (mutated: bodies become groups).
 * @param articulation - what {@link readArticulation} read.
 * @returns the controller, or `undefined` when the stage has nothing to drive
 *   and no collision geometry to show.
 */
export function createArticulationController(root, articulation) {
  try {
    return bindArticulation(root, articulation)
  } catch (error) {
    // A stage that read cleanly but cannot be bound must still preview: the
    // geometry is the caller's and a missing controller only costs interaction.
    if (typeof console !== 'undefined') console.warn('usd preview: articulation could not be bound', error)
    return undefined
  }
}

/** The body of {@link createArticulationController}; may throw, the export cannot. */
function bindArticulation(root, articulation) {
  if (root === undefined || root === null || root.isObject3D !== true) return undefined
  if (articulation === undefined || articulation === null) return undefined
  const bodies = Array.isArray(articulation.bodies) ? articulation.bodies : []
  const joints = Array.isArray(articulation.joints) ? articulation.joints : []
  const colliderData = Array.isArray(articulation.colliders) ? articulation.colliders : []
  if (bodies.length === 0) return undefined

  const bodyIndexByPath = new Map()
  bodies.forEach((body, index) => bodyIndexByPath.set(body.path, index))
  const restWorld = bodies.map(body => new THREE.Matrix4().fromArray(body.matrix))
  const restWorldInverse = restWorld.map(matrix => matrix.clone().invert())

  // A fixed joint transmits motion but is not something a click can drive, and
  // a joint whose open pose equals its rest pose has no travel to show.
  const drivable = joints.map(joint => joint.type !== 'fixed' && Math.abs(joint.open - joint.home) > 1e-9)
  const movingParts = drivable.filter(Boolean).length
  const hasColliders = colliderData.length > 0
  if (movingParts === 0 && hasColliders === false) return undefined

  // ── snapshot the assembled scene, then re-parent it ─────────────────────
  root.updateMatrixWorld(true)
  const rootInverse = new THREE.Matrix4().copy(root.matrixWorld).invert()
  const meshes = []
  root.traverse((node) => { if (node.isMesh === true) meshes.push(node) })

  /** The deepest body whose prim path contains `path`, or -1. */
  const findBody = (path) => {
    if (typeof path !== 'string' || path === '') return -1
    let at = path
    for (let guard = 0; guard < 256; guard += 1) {
      const index = bodyIndexByPath.get(at)
      if (index !== undefined) return index
      const cut = at.lastIndexOf('/')
      if (cut <= 0) return -1
      at = at.slice(0, cut)
    }
    return -1
  }

  const groups = bodies.map((body, index) => {
    const group = new THREE.Group()
    group.name = body.path
    group.matrixAutoUpdate = false
    group.matrix.copy(restWorld[index])
    group.matrixWorldNeedsUpdate = true
    group.userData.usdBody = body.path
    root.add(group)
    return group
  })

  const bodyOfMesh = new Map()
  const moved = []
  for (const mesh of meshes) {
    const index = findBody(typeof mesh.name === 'string' ? mesh.name : '')
    if (index < 0) continue
    // A PointInstancer batch keeps only the instancer's own prim path, so
    // "every instance belongs to one body" cannot be established; leaving the
    // batch static is the only honest choice (documented in the header).
    if (mesh.isInstancedMesh === true) continue
    const stageWorld = new THREE.Matrix4().multiplyMatrices(rootInverse, mesh.matrixWorld)
    const local = new THREE.Matrix4().multiplyMatrices(restWorldInverse[index], stageWorld)
    moved.push({ mesh, matrix: mesh.matrix.clone(), autoUpdate: mesh.matrixAutoUpdate })
    mesh.matrixAutoUpdate = false
    mesh.matrix.copy(local)
    mesh.matrixWorldNeedsUpdate = true
    groups[index].add(mesh)
    bodyOfMesh.set(mesh, index)
  }

  // Body-local bounding boxes, taken once: the framing envelope needs an extent,
  // not vertex data, and the engine already hands each geometry a tight box.
  const localBoxes = bodies.map(() => new THREE.Box3())
  const boxScratch = new THREE.Box3()
  for (const [mesh, index] of bodyOfMesh) {
    const geometry = mesh.geometry
    if (geometry === undefined || geometry === null) continue
    if (geometry.boundingBox === null || geometry.boundingBox === undefined) {
      const position = geometry.attributes === undefined ? undefined : geometry.attributes.position
      // A released vertex array cannot be scanned; the mesh simply contributes
      // nothing rather than a wrong box.
      if (position === undefined || position === null || position.array === null) continue
      geometry.computeBoundingBox()
    }
    if (geometry.boundingBox === null || geometry.boundingBox === undefined) continue
    localBoxes[index].union(boxScratch.copy(geometry.boundingBox).applyMatrix4(mesh.matrix))
  }

  // ── the joint tree, in parent-before-child order ────────────────────────
  /** child body index -> { joint index, parent body index or undefined }. */
  const parentEdge = new Map()
  for (let index = 0; index < joints.length; index += 1) {
    const joint = joints[index]
    if (joint.body1 === null || joint.body1 === undefined) continue
    const child = bodyIndexByPath.get(joint.body1)
    if (child === undefined || parentEdge.has(child)) continue
    const parent = joint.body0 === null || joint.body0 === undefined
      ? undefined
      : bodyIndexByPath.get(joint.body0)
    parentEdge.set(child, { joint: index, parent })
  }
  const childEdges = new Map()
  const roots = []
  bodies.forEach((body, index) => { if (parentEdge.has(index) === false) roots.push(index) })
  for (const [child, edge] of parentEdge) {
    const list = childEdges.get(edge.parent) ?? []
    list.push(child)
    childEdges.set(edge.parent, list)
  }
  const order = []
  const seen = new Set()
  const queue = [...roots]
  while (queue.length > 0) {
    const index = queue.shift()
    if (seen.has(index)) continue
    seen.add(index)
    order.push(index)
    for (const child of childEdges.get(index) ?? []) queue.push(child)
  }
  bodies.forEach((body, index) => { if (seen.has(index) === false) order.push(index) })

  // ── per-joint math, precomputed once ────────────────────────────────────
  const frameWorld = joints.map(joint => new THREE.Matrix4().fromArray(
    Array.isArray(joint.frame) && joint.frame.length === 16 ? joint.frame : new THREE.Matrix4().elements,
  ))
  const axisLocal = joints.map(joint => {
    const [x, y, z] = Array.isArray(joint.axis) ? joint.axis : [1, 0, 0]
    const axis = new THREE.Vector3(x ?? 1, y ?? 0, z ?? 0)
    return axis.lengthSq() > 1e-12 ? axis.normalize() : new THREE.Vector3(1, 0, 0)
  })
  /** Joint frame expressed in the parent body's space, and its inverse. */
  const basis = joints.map((joint, index) => {
    const body0 = joint.body0 === null || joint.body0 === undefined ? undefined : bodyIndexByPath.get(joint.body0)
    const base = body0 === undefined ? new THREE.Matrix4() : restWorldInverse[body0]
    return new THREE.Matrix4().multiplyMatrices(base, frameWorld[index])
  })
  const basisInverse = basis.map(matrix => matrix.clone().invert())
  const restRelative = new Map()
  for (const [child, edge] of parentEdge) {
    if (edge.parent === undefined) continue
    restRelative.set(child, new THREE.Matrix4().multiplyMatrices(restWorldInverse[edge.parent], restWorld[child]))
  }

  // ── animation state ────────────────────────────────────────────────────
  const values = new Float64Array(joints.length)
  const from = new Float64Array(joints.length)
  const goal = new Float64Array(joints.length)
  const startedAt = new Float64Array(joints.length)
  const durations = new Float64Array(joints.length)
  const active = new Uint8Array(joints.length)
  for (let index = 0; index < joints.length; index += 1) values[index] = joints[index].home
  let clock = 0

  /** Seconds a joint needs to cover `delta` at the controller speeds. */
  const durationOf = (joint, delta) => {
    const span = Math.abs(joint.upper - joint.lower)
    let seconds
    if (joint.type === 'revolute') {
      const degrees = Math.abs(joint.unit === 'rad' ? THREE.MathUtils.radToDeg(delta) : delta)
      seconds = degrees / ANIMATION.degreesPerSecond
    } else {
      // "0.8 of the travel per second", the prismatic speed.
      seconds = (span > 1e-9 ? Math.abs(delta) / span : 1) / ANIMATION.rangesPerSecond
    }
    return Math.max(ANIMATION.minSeconds, seconds)
  }

  /** Aim one joint at a value; returns whether that is a move at all. */
  const startMotion = (index, to) => {
    const joint = joints[index]
    const value = THREE.MathUtils.clamp(to, joint.lower, joint.upper)
    goal[index] = value
    if (Math.abs(value - values[index]) <= 1e-9) {
      active[index] = 0
      return false
    }
    from[index] = values[index]
    startedAt[index] = clock
    // tick() is handed milliseconds; the speeds are authored in seconds.
    durations[index] = durationOf(joint, value - values[index]) * 1000
    active[index] = 1
    return true
  }

  // Scratch matrices: a frame may run at 120 Hz for seconds, so nothing here
  // allocates per tick.
  const deltaScratch = new THREE.Matrix4()
  const poseScratch = new THREE.Matrix4()
  const world = restWorld.map(matrix => matrix.clone())

  /** Rigid delta one joint value writes onto the driven body. */
  const writeDelta = (index, value, matrix) => {
    const joint = joints[index]
    const travel = value - joint.home
    if (joint.type === 'revolute') {
      const radians = joint.unit === 'rad' ? travel : THREE.MathUtils.degToRad(travel)
      matrix.makeRotationAxis(axisLocal[index], radians)
    } else if (joint.type === 'prismatic') {
      const axis = axisLocal[index]
      matrix.makeTranslation(axis.x * travel, axis.y * travel, axis.z * travel)
    } else {
      matrix.identity()
    }
    return matrix.multiplyMatrices(basis[index], matrix).multiply(basisInverse[index])
  }

  /**
   * World matrix of every body for one pose, with no side effects: the frame
   * loop, the envelope and any future gizmo share this one forward-kinematics
   * pass.
   * @param pose - one joint value per joint.
   * @param target - matrices to write, indexed like `bodies`.
   */
  const computeWorlds = (pose, target) => {
    for (const index of order) {
      const edge = parentEdge.get(index)
      if (edge === undefined || edge.parent === undefined) {
        target[index].copy(restWorld[index])
      } else {
        writeDelta(edge.joint, pose[edge.joint], deltaScratch)
        poseScratch.multiplyMatrices(target[edge.parent], deltaScratch)
        const relative = restRelative.get(index)
        if (relative === undefined) target[index].copy(poseScratch)
        else target[index].multiplyMatrices(poseScratch, relative)
      }
    }
  }

  /** Recompose the current pose and push it into the body groups. */
  const applyPose = () => {
    computeWorlds(values, world)
    for (const index of order) {
      groups[index].matrix.copy(world[index])
      groups[index].matrixWorldNeedsUpdate = true
    }
  }

  // ── collision geometry ─────────────────────────────────────────────────
  const colliderPaths = colliderData.map(collider => collider.path)
  const colliderMeshes = []
  for (const mesh of meshes) {
    const path = typeof mesh.name === 'string' ? mesh.name : ''
    if (path === '') continue
    if (colliderPaths.some(candidate => isUnderPath(path, candidate))) colliderMeshes.push(mesh)
  }
  const overlayColliders = colliderData.filter(collider => (
    meshes.every(mesh => isUnderPath(typeof mesh.name === 'string' ? mesh.name : '', collider.path) === false)
  ))
  // Collision overlays start hidden; hiding the model's only geometry would
  // draw nothing, so that case starts visible.
  let collidersVisible = colliderMeshes.length > 0 && colliderMeshes.length === meshes.length
  const colliderVisibility = colliderMeshes.map(mesh => mesh.visible)
  for (const mesh of colliderMeshes) mesh.visible = collidersVisible

  const overlayRoots = []
  const overlayGeometries = []
  const overlayMaterials = []
  let overlayBuilt = false
  const buildOverlay = () => {
    if (overlayBuilt) return
    overlayBuilt = true
    const shellMaterial = new THREE.MeshBasicMaterial({
      color: COLLIDER_COLOR,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    const edgeMaterial = new THREE.LineBasicMaterial({ color: COLLIDER_COLOR, transparent: true, opacity: 0.9 })
    overlayMaterials.push(shellMaterial, edgeMaterial)
    for (const collider of overlayColliders) {
      if (collider.positions.length < 9 || collider.indices.length < 3) continue
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.BufferAttribute(collider.positions, 3))
      geometry.setIndex(new THREE.BufferAttribute(collider.indices, 1))
      const shell = new THREE.Mesh(geometry, shellMaterial)
      shell.name = collider.path
      shell.renderOrder = 2
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, COLLIDER_CREASE_DEGREES), edgeMaterial)
      edges.name = collider.path + ' (edges)'
      edges.renderOrder = 3
      const group = new THREE.Group()
      group.name = collider.path + ' (collider)'
      group.add(shell)
      group.add(edges)
      const bodyIndex = collider.body === undefined ? undefined : bodyIndexByPath.get(collider.body)
      if (bodyIndex === undefined) {
        root.add(group)
      } else {
        // Positions are already in stage space; the body group carries the
        // stage-space pose, so the local matrix is its inverse.
        group.matrix.copy(restWorldInverse[bodyIndex])
        group.matrixAutoUpdate = false
        groups[bodyIndex].add(group)
      }
      group.visible = collidersVisible
      overlayRoots.push(group)
      overlayGeometries.push(geometry, edges.geometry)
    }
  }

  /**
   * The stage-space envelope a viewport should frame: every pose the controls can
   * command, not just the rest pose.
   *
   * Framing the rest pose alone is wrong for an articulated stage — "open all"
   * swings a part out of frame. The authored limits are not the right extremes
   * either: a revolute joint may author ±360°, and a full turn lands back on the
   * rest pose, so posing "both limits" would miss the 90° pose that leaves the
   * screen. What this viewport can command is home or open per joint, so the
   * envelope enumerates exactly those corners (up to eight drivable joints, the
   * whole 2^n set; past that, the rest pose, all-open and one-at-a-time), plus
   * three samples of each joint's own arc so the swept middle is covered too.
   * @returns {({ min: [number, number, number], max: [number, number, number] } | undefined)}
   *   a plain stage-space box (no three types, so the view keeps its own), or
   *   undefined when nothing is drivable.
   */
  const extremeBounds = () => {
    const drivableJoints = []
    for (let index = 0; index < joints.length; index += 1) if (drivable[index]) drivableJoints.push(index)
    if (drivableJoints.length === 0) return undefined
    if (localBoxes.every(box => box.isEmpty())) return undefined
    const pose = new Float64Array(joints.length)
    for (let index = 0; index < joints.length; index += 1) pose[index] = joints[index].home
    const poseWorld = restWorld.map(() => new THREE.Matrix4())
    const bounds = new THREE.Box3()
    const unionPose = () => {
      computeWorlds(pose, poseWorld)
      for (let index = 0; index < bodies.length; index += 1) {
        const box = localBoxes[index]
        if (box.isEmpty()) continue
        bounds.union(boxScratch.copy(box).applyMatrix4(poseWorld[index]))
      }
    }
    const reset = () => {
      for (let index = 0; index < joints.length; index += 1) pose[index] = joints[index].home
    }
    if (drivableJoints.length <= 8) {
      const corners = 1 << drivableJoints.length
      for (let mask = 0; mask < corners; mask += 1) {
        for (let slot = 0; slot < drivableJoints.length; slot += 1) {
          const index = drivableJoints[slot]
          pose[index] = (mask & (1 << slot)) !== 0 ? joints[index].open : joints[index].home
        }
        unionPose()
      }
      reset()
    } else {
      unionPose()
      for (const index of drivableJoints) {
        pose[index] = joints[index].open
        unionPose()
        pose[index] = joints[index].home
      }
      for (const index of drivableJoints) pose[index] = joints[index].open
      unionPose()
      reset()
    }
    // The corners are where the controls stop; the arc between them is what the
    // animation draws, and a rotating link can leave a corner hull.
    const ARC_SAMPLES = [0.25, 0.5, 0.75]
    for (const index of drivableJoints) {
      const joint = joints[index]
      for (const fraction of ARC_SAMPLES) {
        pose[index] = joint.home + (joint.open - joint.home) * fraction
        unionPose()
      }
      pose[index] = joint.home
    }
    return {
      min: [bounds.min.x, bounds.min.y, bounds.min.z],
      max: [bounds.max.x, bounds.max.y, bounds.max.z],
    }
  }

  // ── the controller surface ─────────────────────────────────────────────
  const tick = (deltaMs) => {
    if (Number.isFinite(deltaMs) && deltaMs > 0) clock += deltaMs
    let changed = false
    let moving = false
    for (let index = 0; index < joints.length; index += 1) {
      if (active[index] === 0) continue
      const total = durations[index]
      const progress = total <= 0 ? 1 : Math.min(1, (clock - startedAt[index]) / total)
      const next = from[index] + (goal[index] - from[index]) * smootherstep(progress)
      if (Math.abs(next - values[index]) > 1e-12) {
        values[index] = next
        changed = true
      }
      if (progress >= 1) {
        values[index] = goal[index]
        active[index] = 0
        changed = true
      } else {
        moving = true
      }
    }
    if (changed) applyPose()
    return moving
  }

  const toggle = (index) => {
    const joint = joints[index]
    const nearerOpen = Math.abs(values[index] - joint.open) <= Math.abs(values[index] - joint.home)
    return startMotion(index, nearerOpen ? joint.home : joint.open)
  }

  const pick = (hits) => {
    if (Array.isArray(hits) === false || hits.length === 0) return false
    let bodyIndex = -1
    for (const hit of hits) {
      let node = hit === null || hit === undefined ? undefined : hit.object
      for (let guard = 0; guard < 64 && node !== undefined && node !== null; guard += 1) {
        const known = bodyOfMesh.get(node)
        if (known !== undefined) {
          bodyIndex = known
          break
        }
        const tagged = node.userData === undefined ? undefined : node.userData.usdBody
        if (typeof tagged === 'string') {
          const found = bodyIndexByPath.get(tagged)
          if (found !== undefined) {
            bodyIndex = found
            break
          }
        }
        node = node.parent
      }
      if (bodyIndex >= 0) break
    }
    if (bodyIndex < 0) return false
    // A body can be driven indirectly (a panel bolted to a wrist): walk up the
    // tree until a drivable joint is found.
    let at = bodyIndex
    for (let guard = 0; guard <= bodies.length; guard += 1) {
      const edge = parentEdge.get(at)
      if (edge === undefined) return false
      if (drivable[edge.joint]) return toggle(edge.joint)
      if (edge.parent === undefined) return false
      at = edge.parent
    }
    return false
  }

  const setAll = (open) => {
    for (let index = 0; index < joints.length; index += 1) {
      if (drivable[index] === false) continue
      startMotion(index, open === true ? joints[index].open : joints[index].home)
    }
  }

  const home = () => {
    for (let index = 0; index < joints.length; index += 1) {
      if (drivable[index] === false) continue
      startMotion(index, joints[index].home)
    }
  }

  const setCollidersVisible = (visible) => {
    collidersVisible = visible === true
    if (collidersVisible) buildOverlay()
    for (const group of overlayRoots) group.visible = collidersVisible
    for (const mesh of colliderMeshes) mesh.visible = collidersVisible
  }

  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    // Bodies first: the controller moved the caller's meshes, and the caller
    // frees the geometry right after, so every mesh has to be back in place.
    for (const record of moved) {
      const mesh = record.mesh
      if (mesh.parent !== null && mesh.parent !== undefined) mesh.parent.remove(mesh)
      root.add(mesh)
      mesh.matrix.copy(record.matrix)
      mesh.matrixAutoUpdate = record.autoUpdate
      mesh.matrixWorldNeedsUpdate = true
    }
    colliderMeshes.forEach((mesh, index) => { mesh.visible = colliderVisibility[index] })
    for (const group of groups) {
      if (group.parent !== null && group.parent !== undefined) group.parent.remove(group)
    }
    for (const group of overlayRoots) {
      if (group.parent !== null && group.parent !== undefined) group.parent.remove(group)
    }
    for (const geometry of overlayGeometries) geometry.dispose()
    for (const material of overlayMaterials) material.dispose()
    bodyOfMesh.clear()
  }

  return {
    movingParts,
    hasColliders,
    tick,
    pick,
    setAll,
    home,
    setCollidersVisible,
    extremeBounds,
    dispose,
  }
}
