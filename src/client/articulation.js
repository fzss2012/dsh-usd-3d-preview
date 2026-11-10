/**
 * Articulation: the moving parts a USD stage declares, read from its layer bytes.
 *
 * USD is not only geometry. A SimReady/inspection asset — a robot arm, an
 * appliance, a door — carries its kinematics as `UsdPhysics` prims: rigid bodies
 * (`PhysicsRigidBodyAPI`) and joints between them (`PhysicsRevoluteJoint`,
 * `PhysicsPrismaticJoint`, `PhysicsFixedJoint`) with an axis, travel limits and a
 * rest pose. The WASM engine composes geometry but discards those prims, so this
 * module reads them back out of the layer bytes the engine composed.
 *
 * This half only describes: it returns plain data and never touches a scene.
 * `kinematics.js` takes that description and drives an assembled root with it.
 *
 * There is no physics solver here on purpose: a preview only needs the authored
 * joint range, so a joint writes a rigid transform onto the body it drives and
 * the body meshes follow. That is the whole of "interactive" — no dynamics, no
 * collision response, no simulation step.
 *
 * ## Why the bytes, and which reader
 *
 * The engine hands back `sources`: the exact layer bytes the stage composed from,
 * keyed by package path (see `engine.js`). Two containers reach us:
 *
 *  - **ASCII** (`.usda`) is parsed here by a focused reader. Only prim type names,
 *    applied API schemas, relationships, a handful of attributes (`xformOp*`,
 *    `physics:*`, `simready:*`, `purpose`) and — for collision prims only — the
 *    mesh arrays are materialised; everything else is skipped syntactically, so
 *    a large scene costs a scan rather than an object graph.
 *
 *  - **crate** (`.usdc`) is decoded by three`'`s `USDCParser`, which already reads
 *    the binary token/string/field/path/spec tables correctly. One thing it does
 *    not decode is `apiSchemas`, a `TokenListOp`; that is read here from the same
 *    field table, because a prim`'`s type alone does not say whether it is a rigid
 *    body. Nothing else is taken from three beyond `specsByPath` and the raw section
 *    tables, and every read is guarded: an unreadable layer becomes a warning,
 *    never an exception.
 *
 * three logs "USDCParser: Unsupported …" for the list ops it skips (references,
 * payload, applied API schemas); those warnings are left on the console, because
 * they are true statements about what three did not decode and this module reads
 * the ones it needs out of the field table itself.
 *
 * A crate token table is LZ4-compressed, so a byte scan cannot rule one out.
 * Text layers are rejected by a plain `Physics` scan before any parsing; a crate is
 * decoded and then rejected on its token table.
 *
 * ## Rest pose and frames
 *
 * The assembled root is a flat Group whose meshes carry their stage-space world
 * matrix; its own transform is the upAxis/units conversion and is never touched.
 * Bodies get a Group per body prim under the root, at the body rest world
 * transform composed from the layer `xformOpOrder` chain. Meshes are re-parented
 * into those groups with the matrix that keeps their stage-space pose unchanged.
 * Joint motion is a rigid delta in the parent body frame:
 *
 *     childWorld = parentWorld * (F * M(value) * F^-1) * (parentRest^-1 * childRest)
 *
 * where `F` is the joint frame in the parent body space and `M` is a rotation about
 * the joint axis (revolute) or a translation along it (prismatic). At the rest
 * value the delta is the identity, so the bind pose is exactly the authored pose
 * at any hierarchy depth.
 *
 * ## Collision geometry
 *
 * SimReady collision hulls live in a referenced layer and carry
 * `purpose = "guide"`, which the engine correctly refuses to draw — so there is
 * nothing in the scene to show or hide. This module reads those hulls from the
 * bytes instead, and the controller in `kinematics.js` draws them as its own overlay:
 * translucent shells plus edges, hidden by default, built on first show so the
 * initial framing and the stats line only ever see model geometry. Collision
 * meshes the engine *does* draw are toggled in place instead.
 *
 * ## Known limits
 *
 *  - Composition is not reimplemented: each layer is read at its own root path,
 *    and a referenced layer's prims are matched to the stage by path suffix. A
 *    payload authored under a non-identity parent is placed by its own layer
 *    transform; a payload authored at identity is placed at the stage root.
 *  - Joint values are relative to `home` (the rest value). A stage whose geometry is
 *    authored at a different pose would be re-posed; USD physics carries no
 *    separate "current pose", so home is the honest choice.
 *  - `PhysicsSphericalJoint` and `PhysicsDistanceJoint` are reported as fixed (not
 *    drivable) rather than faked as one of the three supported kinds.
 *
 * ## Contract
 *
 * `readArticulation(sources)` is pure: bytes in, description out, `undefined` when the
 * stage declares no joints. `createArticulationController(root, articulation)` binds
 * that description to an assembled three root and returns the only mutable thing
 * in this module. The view never learns about joints; the component calls
 * `pick` from a click and `tick` from a frame.
 *
 * @module usd3d-preview/articulation
 */
import * as THREE from 'three'
import { USDCParser } from 'three/examples/jsm/loaders/usd/USDCParser.js'

/**
 * @typedef {object} ArticulationBody
 * @property {string} path - the body prim absolute path in the stage.
 * @property {string} name - its display name (the last path component).
 * @property {number[]} matrix - 16 numbers, column-major rest world transform in stage space.
 */

/**
 * @typedef {object} ArticulationJoint
 * @property {string} id - stable identity of the joint prim (its absolute path).
 * @property {string} path - the joint prim absolute path.
 * @property {'revolute' | 'prismatic' | 'fixed'} type - how the joint moves.
 * @property {string|null} body0 - the parent body prim path, `null` for a root joint.
 * @property {string|null} body1 - the driven body prim path.
 * @property {[number, number, number]} axis - the motion axis in the joint frame.
 * @property {[number, number, number]} pivot - the joint frame origin in stage space at rest.
 * @property {number[]} frame - 16 numbers, column-major joint frame in stage space at rest.
 * @property {number} lower - travel limit at the low end, in `unit`.
 * @property {number} upper - travel limit at the high end, in `unit`.
 * @property {'deg' | 'rad' | 'base'} unit - unit of `lower`, `upper`, `home` and `open`:
 *   degrees or radians for a revolute joint, stage linear units (`base`) for a prismatic one.
 * @property {number} home - the rest value of the joint.
 * @property {number} open - the joint value at the open end of its travel.
 * @property {'open' | 'close'} opens - which side of the travel `open` sits on: `open` when
 *   above `home`, `close` when below.
 */

/**
 * Authored collision geometry, expressed in stage space.
 *
 * It has to travel with the articulation because the scene does not contain it:
 * the engine drops `purpose = "guide"` prims, which is how SimReady authors its
 * convex hulls.
 * @typedef {object} ArticulationCollider
 * @property {string} path - the collision prim path, as authored in its layer.
 * @property {string|undefined} body - the body prim path it belongs to, when one matched.
 * @property {Float32Array} positions - flat xyz triangle vertices in stage space.
 * @property {Uint32Array} indices - triangle indices into `positions`.
 */

/**
 * One parent-to-child edge of the joint tree.
 * @typedef {object} ArticulationTreeEdge
 * @property {string} joint - the id of the joint that drives `child`.
 * @property {string|null} parent - the body it hangs off, `null` at a root.
 * @property {string} child - the body it drives.
 */

/**
 * @typedef {object} Articulation
 * @property {string} kind - the declaration flavour that was found (`usdphysics`).
 * @property {string[]} roots - body prim paths that move no parent body.
 * @property {ArticulationBody[]} bodies - every rigid body, parent before child.
 * @property {ArticulationJoint[]} joints - every joint, in declaration order.
 * @property {ArticulationTreeEdge[]} tree - the joint tree, in declaration order.
 * @property {ArticulationCollider[]} colliders - authored collision geometry, when the stage marks any.
 * @property {string[]} warnings - what could not be read faithfully.
 */


// ── what a layer has to look like ──────────────────────────────────────────

/** Crate containers start with this; anything else we read is ASCII text. */
const CRATE_MAGIC = 'PXR-USDC'

/** Spec types in a crate layer (crateDataTypes.h). */
const SPEC_ATTRIBUTE = 1
const SPEC_PRIM = 6
const SPEC_RELATIONSHIP = 8

/** A crate `FieldSet` ends with this index (0xFFFFFFFF stored as int32). */
const FIELD_SET_END = -1

/** `TokenListOp`, the crate type three's parser deliberately skips. */
const TOKEN_LIST_OP = 32

/** Crate quaternions are stored (i, j, k, real); USD text writes (real, i, j, k). */
const QUATERNION_TYPES = new Set(['quatf', 'quatd', 'quath'])

/**
 * Crate value-type enums whose inlined form is a packed int8 tuple.
 *
 * OpenUSD inlines a vector when every component is exactly representable as
 * int8 (`crateValueInliners.h`), packing the components into the low 32 bits of
 * the value rep. three's `USDCParser` decodes that only for floating vectors;
 * a `double3 xformOp:translate` is common enough, and its inline form common
 * enough, that a raw payload read as a scalar would silently move a body to
 * (256, 0, 0). These are decoded from the raw rep below.
 */
const INLINE_VECTOR_DIMENSIONS = new Map([[19, 2], [21, 2], [23, 3], [25, 3], [27, 4], [29, 4]])

/** Crate bootstrapping: 8 magic bytes, 3 version bytes, 5 reserved, 8 TOC offset. */
const CRATE_VERSION_AT = 8
const CRATE_TOC_AT = 16

/** The only Physics prim types this module can drive. */
const JOINT_KINDS = new Map([
  ['PhysicsRevoluteJoint', 'revolute'],
  ['PhysicsPrismaticJoint', 'prismatic'],
  ['PhysicsFixedJoint', 'fixed'],
])

/** Applied API schemas that turn a prim into kinematic structure. */
const RIGID_BODY_API = 'PhysicsRigidBodyAPI'
const MASS_API = 'PhysicsMassAPI'
const COLLISION_API = 'PhysicsCollisionAPI'

/** Attributes kept from an ASCII layer; everything else is skipped syntactically. */
const PHYSICS_ATTRIBUTES = new Set([
  'physics:axis', 'physics:localPos0', 'physics:localPos1', 'physics:localRot0', 'physics:localRot1',
  'physics:lowerLimit', 'physics:upperLimit', 'physics:mass', 'physics:collisionEnabled',
  'physics:approximation', 'physics:excludeFromArticulation',
  'simready:unit', 'simready:home', 'simready:rest', 'simready:far', 'simready:role', 'simready:colliders',
  'purpose',
])
const GEOMETRY_ATTRIBUTES = new Set(['points', 'faceVertexCounts', 'faceVertexIndices'])

/** Statement modifiers that may precede a type or a relationship. */
const MODIFIERS = new Set(['custom', 'uniform', 'varying', 'optional', 'prepend', 'append', 'add', 'delete', 'reorder', 'config'])

/** Metadata keys whose values are not attributes and are consumed whole. */
const STATEMENT_KEYS = new Set([
  'inherits', 'specializes', 'references', 'payload', 'subLayers', 'nameChildren', 'variantSets',
  'doc', 'kind', 'customData', 'defaultPrim', 'metersPerUnit', 'upAxis', 'endTimeCode', 'startTimeCode',
  'timeCodesPerSecond', 'comment', 'fallbackPrimTypes', 'apiSchemas',
])

/** xformOp suffixes applied when a layer authors ops but no `xformOpOrder`. */
const FALLBACK_OP_ORDER = [
  'xformOp:translate', 'xformOp:orient', 'xformOp:rotateX', 'xformOp:rotateY', 'xformOp:rotateZ',
  'xformOp:scale', 'xformOp:transform',
]

/** A collider segment in a prim path, used when no API schema marks the prim. */
const COLLIDER_SEGMENT = 'collision'

// ── small value helpers ────────────────────────────────────────────────────

/** Whether a byte array is a binary crate rather than an ASCII layer. */
function isCrateLayer(bytes) {
  if (bytes === undefined || bytes.byteLength < CRATE_VERSION_AT) return false
  for (let index = 0; index < 8; index += 1) {
    if (bytes[index] !== CRATE_MAGIC.charCodeAt(index)) return false
  }
  return true
}

/** Whether a byte array can be read as text at all, judged by its first byte. */
function isTextLayer(bytes) {
  if (bytes === undefined || bytes.byteLength < 4) return false
  // A crate is the only binary container USD layers use; anything else that
  // starts with a printable byte is text we can at least scan.
  if (isCrateLayer(bytes)) return false
  return bytes[0] === 0x23 || bytes[0] === 0x20 || bytes[0] === 0x0A || bytes[0] === 0x0D || bytes[0] === 0x2F
}

/** Decode a text layer once, BOM already stripped by the engine but not by us. */
function decodeText(bytes) {
  return new TextDecoder().decode(bytes)
}

/** Read a number, falling back when the value is absent or not finite. */
function numberOr(value, fallback) {
  const number = typeof value === 'number' ? value : Number.NaN
  return Number.isFinite(number) ? number : fallback
}

/** Read a numeric list from an ASCII array, a crate typed array, or a scalar. */
function numberList(value) {
  if (value === undefined || value === null) return []
  if (typeof value === 'number') return [value]
  if (ArrayBuffer.isView(value) || Array.isArray(value)) {
    const out = new Array(value.length)
    for (let index = 0; index < value.length; index += 1) out[index] = Number(value[index])
    return out
  }
  return []
}

/** Read `n` numbers from a tuple, an array-like, or a single number. */
function numbers(value, count) {
  const list = numberList(value)
  const out = new Array(count).fill(0)
  for (let index = 0; index < count && index < list.length; index += 1) {
    if (Number.isFinite(list[index])) out[index] = list[index]
  }
  return out
}

/** The joint frame position from a point3f/point3d/default tuple. */
function positionOf(value) {
  const [x, y, z] = numbers(value, 3)
  return new THREE.Vector3(x, y, z)
}

/** The joint frame orientation from a quatf/quatd, stored (real, i, j, k). */
function orientationOf(value) {
  const list = numberList(value)
  if (list.length < 4) return new THREE.Quaternion()
  const quaternion = new THREE.Quaternion(list[1], list[2], list[3], list[0])
  const length = quaternion.length()
  if (!(length > 1e-9)) return new THREE.Quaternion()
  quaternion.x /= length
  quaternion.y /= length
  quaternion.z /= length
  quaternion.w /= length
  return quaternion
}

/** A USD physics axis token (`X`, `Y`, `Z`) or an authored vector. */
function axisOf(value) {
  if (typeof value === 'string') {
    const token = value.trim().toUpperCase()
    if (token === 'X') return new THREE.Vector3(1, 0, 0)
    if (token === 'Y') return new THREE.Vector3(0, 1, 0)
    if (token === 'Z') return new THREE.Vector3(0, 0, 1)
    return new THREE.Vector3(1, 0, 0)
  }
  const vector = positionOf(value)
  return vector.lengthSq() > 1e-12 ? vector.normalize() : new THREE.Vector3(1, 0, 0)
}

/** Column-major array of a matrix, as three serialises it. */
function matrixArray(matrix) {
  const out = new Array(16)
  for (let index = 0; index < 16; index += 1) out[index] = matrix.elements[index]
  return out
}

// ── transforms from xformOps ───────────────────────────────────────────────

/** The local transform a prim authors, or identity when it authors none. */
function localTransformOf(attrs) {
  const matrix = new THREE.Matrix4()
  const order = attrs.xformOpOrder
  if (Array.isArray(order) && order.length > 0) {
    for (const entry of order) {
      if (typeof entry !== 'string') continue
      const name = entry.trim()
      if (name === '') continue
      if (name === '!resetXformStack!') {
        matrix.identity()
        continue
      }
      applyXformOp(matrix, name, attrs)
    }
    return matrix
  }
  // USD ignores unordered xformOps, but a layer that authors them without an
  // order clearly means to move its prim; apply the conventional sequence once.
  for (const name of FALLBACK_OP_ORDER) {
    if (attrs[name] !== undefined) applyXformOp(matrix, name, attrs)
  }
  return matrix
}

/** Multiply one authored xformOp (optionally inverted) onto `matrix`. */
function applyXformOp(matrix, name, attrs) {
  const inverted = name.startsWith('!invert!')
  const op = inverted ? name.slice('!invert!'.length) : name
  const value = attrs[op]
  if (value === undefined || value === null) return
  const opMatrix = xformMatrixOf(op, value)
  if (opMatrix === undefined) return
  if (inverted) opMatrix.invert()
  matrix.multiply(opMatrix)
}

/** The matrix one xformOp stands for, or undefined when the op is unknown. */
function xformMatrixOf(op, value) {
  if (op === 'xformOp:transform') {
    const list = numberList(value)
    if (list.length < 16) return undefined
    // USD stores a matrix4d row by row; Matrix4.set takes the same order.
    return new THREE.Matrix4().set(
      list[0], list[1], list[2], list[3],
      list[4], list[5], list[6], list[7],
      list[8], list[9], list[10], list[11],
      list[12], list[13], list[14], list[15],
    )
  }
  if (op === 'xformOp:orient') {
    return new THREE.Matrix4().makeRotationFromQuaternion(orientationOf(value))
  }
  if (op === 'xformOp:translate') {
    const [x, y, z] = numbers(value, 3)
    return new THREE.Matrix4().makeTranslation(x, y, z)
  }
  if (op === 'xformOp:scale') {
    const [x, y, z] = numbers(value, 3)
    return new THREE.Matrix4().makeScale(x, y, z)
  }
  const rotate = /^xformOp:rotate([XYZ]{1,3})$/.exec(op)
  if (rotate !== null) {
    const order = rotate[1]
    if (order.length === 1) {
      const radians = THREE.MathUtils.degToRad(numberOr(numberList(value)[0], 0))
      return new THREE.Matrix4().makeRotationAxis(AXIS_OF[order], radians)
    }
    const angles = numberList(value)
    const matrix = new THREE.Matrix4()
    // USD composes rotateABC as Ra*Rb*Rc in row-vector convention, which is
    // Rc*Rb*Ra once transposed into the column-vector matrices three uses.
    for (let index = order.length - 1; index >= 0; index -= 1) {
      const axis = AXIS_OF[order[index]]
      const radians = THREE.MathUtils.degToRad(angles[index] ?? 0)
      matrix.multiply(new THREE.Matrix4().makeRotationAxis(axis, radians))
    }
    return matrix
  }
  return undefined
}

/** Unit axes for the single-axis rotate ops. */
const AXIS_OF = Object.freeze({
  X: new THREE.Vector3(1, 0, 0),
  Y: new THREE.Vector3(0, 1, 0),
  Z: new THREE.Vector3(0, 0, 1),
})

// ── collision geometry ─────────────────────────────────────────────────────

/** Whether a prim is authored collision geometry. */
function isColliderPrim(prim) {
  if (prim.attrs['physics:collisionEnabled'] === false) return false
  if (prim.apiSchemas.some(schema => schema === COLLISION_API || schema.startsWith(COLLISION_API + ':'))) return true
  // SimReady marks its hulls `purpose = "guide"`, which keeps them out of the
  // rendered stage; that is exactly the geometry this overlay exists for.
  if (prim.attrs.purpose === 'guide') return true
  return prim.path.split('/').includes(COLLIDER_SEGMENT)
}

/** Flatten `[(x, y, z), ...]` or an already flat typed array into a Float32Array. */
function flattenPoints(value) {
  if (value === undefined || value === null) return undefined
  if (ArrayBuffer.isView(value)) {
    if (value instanceof Float32Array && value.length % 3 === 0) return value.slice()
    const out = new Float32Array(value.length)
    for (let index = 0; index < value.length; index += 1) out[index] = Number(value[index])
    return out.length % 3 === 0 ? out : undefined
  }
  if (!Array.isArray(value) || value.length === 0) return undefined
  const out = new Float32Array(value.length * 3)
  for (let index = 0; index < value.length; index += 1) {
    const point = value[index]
    if (!Array.isArray(point) || point.length < 3) return undefined
    out[index * 3] = Number(point[0])
    out[index * 3 + 1] = Number(point[1])
    out[index * 3 + 2] = Number(point[2])
  }
  return out
}

/**
 * Turn authored mesh arrays into triangles.
 * @param positions - points, as authored (array of tuples or a flat array).
 * @param counts - `faceVertexCounts`, when the mesh is a polygon mesh.
 * @param indices - `faceVertexIndices`, the vertex index stream.
 * @returns flat positions and triangle indices, or undefined when unreadable.
 */
function triangulateMesh(positions, counts, indices) {
  const points = flattenPoints(positions)
  if (points === undefined || points.length < 9) return undefined
  const vertexCount = points.length / 3
  const indexList = numberList(indices).map(Number)
  const countList = numberList(counts).map(Number)
  const triangles = []
  if (indexList.length > 0) {
    let cursor = 0
    if (countList.length > 0) {
      for (const rawCount of countList) {
        const size = Math.floor(rawCount)
        if (size >= 3) {
          // A polygon becomes a fan; every authored face is convex in practice.
          const first = indexList[cursor]
          for (let step = 1; step + 1 < size; step += 1) {
            const second = indexList[cursor + step]
            const third = indexList[cursor + step + 1]
            if (second === undefined || third === undefined) break
            triangles.push(first, second, third)
          }
        }
        cursor += size
      }
    } else {
      for (let at = 0; at + 2 < indexList.length; at += 3) {
        triangles.push(indexList[at], indexList[at + 1], indexList[at + 2])
      }
    }
  } else {
    for (let at = 0; at + 2 < vertexCount; at += 3) triangles.push(at, at + 1, at + 2)
  }
  if (triangles.length === 0) return undefined
  const usable = []
  for (let at = 0; at < triangles.length; at += 1) {
    const index = triangles[at]
    usable.push(Number.isFinite(index) && index >= 0 && index < vertexCount ? index : 0)
  }
  return { positions: points, indices: new Uint32Array(usable) }
}

/** Bake a stage-space transform into a flat position array. */
function bakePositions(positions, matrix) {
  if (matrix === undefined) return positions
  const out = new Float32Array(positions.length)
  const point = new THREE.Vector3()
  for (let at = 0; at < positions.length; at += 3) {
    point.set(positions[at], positions[at + 1], positions[at + 2]).applyMatrix4(matrix)
    out[at] = point.x
    out[at + 1] = point.y
    out[at + 2] = point.z
  }
  return out
}

// ── ASCII layers ───────────────────────────────────────────────────────────

/**
 * A focused reader for one ASCII layer.
 *
 * USD text offers a full grammar; this reader implements the subset that
 * describes stage structure (prims, metadata, relationships, attributes) and
 * skips every value it does not need without allocating it. That is what keeps
 * a scene with hundreds of thousands of mesh points cheap to scan.
 */
class AsciiLayerReader {
  constructor(text) {
    this.text = text
    this.at = 0
    this.prims = new Map()
  }

  /** Skip whitespace, line comments and block comments. */
  skip() {
    const text = this.text
    for (;;) {
      const char = text[this.at]
      if (char === undefined) return
      if (char === ' ' || char === '\t' || char === '\r' || char === '\n') {
        this.at += 1
        continue
      }
      if (char === '#') {
        const end = text.indexOf('\n', this.at)
        this.at = end < 0 ? text.length : end + 1
        continue
      }
      if (char === '/' && text[this.at + 1] === '/') {
        const end = text.indexOf('\n', this.at)
        this.at = end < 0 ? text.length : end + 1
        continue
      }
      if (char === '/' && text[this.at + 1] === '*') {
        const end = text.indexOf('*/', this.at + 2)
        this.at = end < 0 ? text.length : end + 2
        continue
      }
      return
    }
  }

  /** Read one bare token: a keyword, a type name, an attribute name or a number. */
  word() {
    const text = this.text
    const start = this.at
    let at = start
    while (at < text.length) {
      const char = text[at]
      if (char === ' ' || char === '\t' || char === '\r' || char === '\n') break
      if (char === '{' || char === '}' || char === '(' || char === ')' || char === '[' || char === ']') break
      if (char === ',' || char === '=' || char === ';' || char === '"' || char === "'" || char === '#') break
      if (char === '<' || char === '>' || char === '@') break
      at += 1
    }
    this.at = at
    return text.slice(start, at)
  }

  /** Read a quoted string, including the triple-quoted form USD allows. */
  string() {
    const text = this.text
    const quote = text[this.at]
    const triple = quote.repeat(3)
    if (text.startsWith(triple, this.at)) {
      const end = text.indexOf(triple, this.at + 3)
      const value = text.slice(this.at + 3, end < 0 ? text.length : end)
      this.at = end < 0 ? text.length : end + 3
      return value
    }
    let at = this.at + 1
    let value = ''
    while (at < text.length) {
      const char = text[at]
      if (char === '\\' && at + 1 < text.length) {
        const next = text[at + 1]
        value += next === 'n' ? '\n' : next === 't' ? '\t' : next
        at += 2
        continue
      }
      if (char === quote) {
        at += 1
        break
      }
      value += char
      at += 1
    }
    this.at = at
    return value
  }

  /** Read `<path>`. */
  pathValue() {
    const text = this.text
    this.at += 1
    const end = text.indexOf('>', this.at)
    if (end < 0) {
      this.at = text.length
      return ''
    }
    const value = text.slice(this.at, end).trim()
    this.at = end + 1
    return value
  }

  /** Read an `@asset@` reference. */
  assetValue() {
    const text = this.text
    this.at += 1
    let value = ''
    while (this.at < text.length) {
      const char = text[this.at]
      if (char === '@') {
        if (text[this.at + 1] === '@') {
          value += '@'
          this.at += 2
          continue
        }
        this.at += 1
        return value
      }
      value += char
      this.at += 1
    }
    return value
  }

  /** Read a value, materialising it. */
  value() {
    this.skip()
    const char = this.text[this.at]
    if (char === undefined) return undefined
    if (char === '(') return this.tuple()
    if (char === '[') return this.array()
    if (char === '{') return this.dictionary()
    if (char === '"' || char === "'") return this.string()
    if (char === '<') return this.pathValue()
    if (char === '@') return this.assetValue()
    return this.atom()
  }

  /** Read a parenthesised tuple as an array of values. */
  tuple() {
    const out = []
    this.at += 1
    for (;;) {
      this.skip()
      const char = this.text[this.at]
      if (char === undefined) return out
      if (char === ')') {
        this.at += 1
        return out
      }
      if (char === ',') {
        this.at += 1
        continue
      }
      const before = this.at
      const value = this.value()
      if (value !== undefined) out.push(value)
      if (this.at === before) this.at += 1
    }
  }

  /** Read a bracketed array. */
  array() {
    const out = []
    this.at += 1
    for (;;) {
      this.skip()
      const char = this.text[this.at]
      if (char === undefined) return out
      if (char === ']') {
        this.at += 1
        return out
      }
      if (char === ',') {
        this.at += 1
        continue
      }
      const before = this.at
      const value = this.value()
      if (value !== undefined) out.push(value)
      if (this.at === before) this.at += 1
    }
  }

  /** Read a dictionary value; only the keys are kept. */
  dictionary() {
    const out = {}
    this.at += 1
    for (;;) {
      this.skip()
      const char = this.text[this.at]
      if (char === undefined) return out
      if (char === '}') {
        this.at += 1
        return out
      }
      if (char === ',') {
        this.at += 1
        continue
      }
      const before = this.at
      const key = char === '"' || char === "'" ? this.string() : this.word()
      this.skip()
      if (this.text[this.at] === '=' || this.text[this.at] === ':') this.at += 1
      out[key] = this.value()
      if (this.at === before) this.at += 1
    }
  }

  /** Read a bare atom: number, boolean, None, or a token. */
  atom() {
    const raw = this.word()
    if (raw === '') return undefined
    if (raw === 'true') return true
    if (raw === 'false') return false
    if (raw === 'None' || raw === 'none' || raw === 'null') return null
    if (/^[-+]?(\d|\.\d)/.test(raw)) {
      const number = Number(raw)
      if (Number.isFinite(number)) return number
    }
    return raw
  }

  /** Skip one value without materialising it. */
  skipValue() {
    this.skip()
    const text = this.text
    const char = text[this.at]
    if (char === undefined) return
    if (char === '(') return this.skipBalanced('(', ')')
    if (char === '[') return this.skipBalanced('[', ']')
    if (char === '{') return this.skipBalanced('{', '}')
    if (char === '"' || char === "'") {
      this.string()
      return
    }
    if (char === '<') {
      const end = text.indexOf('>', this.at)
      this.at = end < 0 ? text.length : end + 1
      return
    }
    if (char === '@') {
      this.assetValue()
      return
    }
    const before = this.at
    this.word()
    if (this.at === before) this.at += 1
  }

  /** Skip a balanced block, honouring strings and comments inside it. */
  skipBalanced(open, close) {
    const text = this.text
    let depth = 0
    while (this.at < text.length) {
      const char = text[this.at]
      if (char === '"' || char === "'") {
        this.string()
        continue
      }
      if (char === '#' && open !== '"') {
        const end = text.indexOf('\n', this.at)
        this.at = end < 0 ? text.length : end + 1
        continue
      }
      if (char === open) depth += 1
      else if (char === close) {
        depth -= 1
        if (depth === 0) {
          this.at += 1
          return
        }
      }
      this.at += 1
    }
  }

  /** Consume an `[]` array type suffix when one is present. */
  arraySuffix() {
    this.skip()
    if (this.text[this.at] !== '[') return false
    let at = this.at + 1
    while (at < this.text.length && this.text[at] !== ']') at += 1
    this.at = at + 1
    return true
  }

  /** Read one layer: header, layer metadata, then the prim tree. */
  read() {
    this.skip()
    if (this.text.startsWith('#usda', this.at)) {
      const end = this.text.indexOf('\n', this.at)
      this.at = end < 0 ? this.text.length : end + 1
    }
    this.body('', undefined)
    return this.prims
  }

  /** Read prims and attributes until the current block closes (or the file ends). */
  body(parentPath, prim) {
    for (;;) {
      this.skip()
      const text = this.text
      if (this.at >= text.length) return
      const char = text[this.at]
      if (char === '}') {
        this.at += 1
        return
      }
      if (char === '(') {
        this.metadata(prim)
        continue
      }
      if (char === ';' || char === ',') {
        this.at += 1
        continue
      }
      if (char === '"' || char === "'") {
        // A bare string is metadata this reader does not model.
        this.string()
        continue
      }
      const before = this.at
      const word = this.word()
      if (word === '') {
        this.at += 1
        continue
      }
      if (word === 'def' || word === 'over' || word === 'class') {
        this.prim(word, parentPath)
        continue
      }
      if (word === 'rel') {
        this.relationship(prim)
        continue
      }
      if (word === 'variantSet' || word === 'variantSets') {
        this.skipVariantSet()
        continue
      }
      if (MODIFIERS.has(word)) continue
      if (STATEMENT_KEYS.has(word)) {
        this.skipAssignment()
        continue
      }
      this.attribute(prim, word)
      if (this.at === before) this.at += 1
    }
  }

  /** Consume a `variantSet` block; variants are a composition state the preview resolves elsewhere. */
  skipVariantSet() {
    this.skip()
    if (this.text[this.at] === '"' || this.text[this.at] === "'") this.string()
    this.skip()
    if (this.text[this.at] === '=') this.at += 1
    this.skip()
    if (this.text[this.at] === '{') this.skipBalanced('{', '}')
    else this.skipValue()
  }

  /** Consume `= value` when one follows the key just read. */
  skipAssignment() {
    this.skip()
    const char = this.text[this.at]
    if (char === '=') {
      this.at += 1
      this.skipValue()
      return
    }
    if (char === '(' || char === '{' || char === '[' || char === '"' || char === "'" || char === '<' || char === '@') {
      this.skipValue()
    }
  }

  /** Read a prim header and body, registering the prim under its absolute path. */
  prim(specifier, parentPath) {
    this.skip()
    let type = ''
    let name = ''
    const char = this.text[this.at]
    if (char === '"' || char === "'") {
      name = this.string()
    } else {
      type = this.word()
      this.skip()
      const after = this.text[this.at]
      if (after === '"' || after === "'") name = this.string()
    }
    if (name === '') name = type === '' ? 'Prim' : type
    const path = parentPath === '' ? '/' + name : parentPath + '/' + name
    const prim = {
      path,
      type,
      apiSchemas: [],
      attrs: Object.create(null),
      rels: Object.create(null),
      spans: Object.create(null),
      text: this.text,
    }
    this.skip()
    if (this.text[this.at] === '(') this.metadata(prim)
    this.skip()
    if (this.text[this.at] === '{') {
      this.at += 1
      this.body(path, prim)
    }
    const existing = this.prims.get(path)
    if (existing === undefined) this.prims.set(path, prim)
    else mergePrim(existing, prim, specifier)
  }

  /** Read prim metadata: `apiSchemas` is kept, everything else is consumed. */
  metadata(prim) {
    this.at += 1
    for (;;) {
      this.skip()
      const text = this.text
      if (this.at >= text.length) return
      const char = text[this.at]
      if (char === ')') {
        this.at += 1
        return
      }
      if (char === ',') {
        this.at += 1
        continue
      }
      if (char === '(' || char === '{' || char === '[') {
        this.skipValue()
        continue
      }
      const before = this.at
      const word = this.word()
      if (word === '') {
        this.at += 1
        if (this.at === before) return
        continue
      }
      if (MODIFIERS.has(word)) continue
      if (word === 'apiSchemas') {
        this.skip()
        if (text[this.at] === '=') {
          this.at += 1
          const value = this.value()
          if (prim !== undefined && Array.isArray(value)) {
            for (const entry of value) {
              if (typeof entry === 'string' && entry !== '') prim.apiSchemas.push(entry)
            }
          }
        }
        continue
      }
      this.skipAssignment()
    }
  }

  /** Read a relationship: `rel name = <path>` or a list of paths. */
  relationship(prim) {
    this.skip()
    const name = this.word()
    this.skip()
    if (this.text[this.at] !== '=') {
      this.skipValue()
      return
    }
    this.at += 1
    const value = this.value()
    if (prim === undefined || name === '') return
    const targets = []
    const collect = (entry) => {
      if (typeof entry === 'string' && entry.startsWith('/')) targets.push(entry)
    }
    if (Array.isArray(value)) value.forEach(collect)
    else collect(value)
    prim.rels[name] = targets
  }

  /**
   * Read an attribute statement. The type token has already been consumed;
   * `type` is empty for the typeless form list-op modifiers allow.
   */
  attribute(prim, type) {
    this.skip()
    if (this.arraySuffix()) this.skip()
    let name = this.word()
    this.skip()
    if (this.text[this.at] !== '=') {
      // A typeless form: the word just read was the name after all.
      this.skipValue()
      return
    }
    this.at += 1
    if (prim === undefined || name === '') {
      this.skipValue()
      return
    }
    this.attributeValue(prim, name)
  }

  /** Keep the attributes this module needs; record geometry spans for later. */
  attributeValue(prim, name) {
    if (GEOMETRY_ATTRIBUTES.has(name)) {
      const start = this.at
      this.skipValue()
      prim.spans[name] = [start, this.at]
      return
    }
    const wanted = PHYSICS_ATTRIBUTES.has(name) || name.startsWith('xformOp') || name.startsWith('simready:')
    if (!wanted) {
      this.skipValue()
      return
    }
    prim.attrs[name] = this.value()
  }
}

/** Merge a later spec of the same prim path into the earlier one. */
function mergePrim(into, from, specifier) {
  if (specifier !== 'over' && into.type === '' && from.type !== '') into.type = from.type
  for (const schema of from.apiSchemas) {
    if (!into.apiSchemas.includes(schema)) into.apiSchemas.push(schema)
  }
  for (const key of Object.keys(from.attrs)) {
    if (into.attrs[key] === undefined) into.attrs[key] = from.attrs[key]
  }
  for (const key of Object.keys(from.rels)) {
    if (into.rels[key] === undefined) into.rels[key] = from.rels[key]
  }
  for (const key of Object.keys(from.spans)) {
    if (into.spans[key] === undefined) into.spans[key] = from.spans[key]
  }
}

// ── crate layers ───────────────────────────────────────────────────────────

/**
 * Decode the inlined vector defaults that three's parser returns as a scalar.
 *
 * OpenUSD writes a vector inline when every component is exactly representable
 * as int8; three then hands back the raw 32-bit payload instead of an array.
 * Only specs of attributes this module consumes are read (`default` field,
 * inlined vector value type); everything else keeps three's decoding.
 * @param parser - the parser instance that already decoded the section tables.
 * @returns a map of property path to the decoded component array.
 */
function crateInlinedAttributeValues(parser) {
  const out = new Map()
  try {
    const paths = parser.paths
    const specs = parser.specs
    const fields = parser.fields
    const fieldSets = parser.fieldSets
    const tokens = parser.tokens
    if (!Array.isArray(specs) || !Array.isArray(fields) || !Array.isArray(fieldSets)) return out
    if (!Array.isArray(paths) || !Array.isArray(tokens)) return out
    for (const spec of specs) {
      if (spec.specType !== SPEC_ATTRIBUTE) continue
      const path = paths[spec.pathIndex]
      if (typeof path !== 'string' || path === '') continue
      const name = path.slice(path.lastIndexOf('.') + 1)
      if (name.startsWith('xformOp') === false && name.startsWith('physics:') === false && name.startsWith('simready:') === false) continue
      let at = spec.fieldSetIndex
      for (let guard = 0; guard < 4096; guard += 1) {
        const fieldIndex = fieldSets[at]
        if (fieldIndex === undefined || fieldIndex === FIELD_SET_END || fieldIndex === 0xFFFFFFFF) break
        at += 1
        const field = fields[fieldIndex]
        if (field === undefined) break
        if (tokens[field.tokenIndex] !== 'default') continue
        const rep = field.valueRep
        if (rep === undefined || rep.isInlined !== true) break
        const dimension = INLINE_VECTOR_DIMENSIONS.get(rep.typeEnum)
        if (dimension === undefined) break
        const components = new Array(dimension)
        for (let index = 0; index < dimension; index += 1) {
          const byte = (rep.lo >>> (8 * index)) & 0xFF
          components[index] = byte > 0x7F ? byte - 0x100 : byte
        }
        out.set(path, components)
        break
      }
    }
  } catch {
    // A container this build decodes differently keeps three's values.
  }
  return out
}

/**
 * Decode the `apiSchemas` list of every prim spec in a crate layer.
 *
 * three's parser skips list ops on purpose (`TokenListOp` is "not needed for
 * geometry loading"), but `apiSchemas` is how a prim says it is a rigid body.
 * The value is a flags byte followed by the present lists, each a uint64 count
 * and that many uint32 token indices; the flag order is fixed by the format.
 * @param parser - the parser instance that already decoded the section tables.
 * @returns prim path to applied API schema names, or undefined when unreadable.
 */
function crateApiSchemas(parser) {
  try {
    const paths = parser.paths
    const specs = parser.specs
    const fields = parser.fields
    const fieldSets = parser.fieldSets
    const tokens = parser.tokens
    const buffer = parser.buffer
    if (Array.isArray(specs) === false || Array.isArray(fields) === false) return undefined
    if (fieldSets === undefined || tokens === undefined) return undefined
    if (!(buffer instanceof ArrayBuffer)) return undefined
    const view = new DataView(buffer)
    const out = new Map()
    const LIST_FLAGS = [0x02, 0x04, 0x20, 0x40, 0x08, 0x10]
    for (const spec of specs) {
      if (spec.specType !== SPEC_PRIM) continue
      const path = paths[spec.pathIndex]
      if (typeof path !== 'string' || path === '') continue
      let at = spec.fieldSetIndex
      for (let guard = 0; guard < 4096; guard += 1) {
        const fieldIndex = fieldSets[at]
        if (fieldIndex === undefined || fieldIndex === FIELD_SET_END || fieldIndex === 0xFFFFFFFF) break
        at += 1
        const field = fields[fieldIndex]
        if (field === undefined) break
        if (tokens[field.tokenIndex] !== 'apiSchemas') continue
        const rep = field.valueRep
        if (rep === undefined || rep.typeEnum !== TOKEN_LIST_OP || rep.isInlined === true) break
        const start = rep.payload
        if (!(start > 0) || start >= view.byteLength) break
        const flags = view.getUint8(start)
        let cursor = start + 1
        const schemas = []
        for (const mask of LIST_FLAGS) {
          if ((flags & mask) === 0) continue
          if (cursor + 8 > view.byteLength) break
          const count = Number(view.getBigUint64(cursor, true))
          cursor += 8
          for (let step = 0; step < count; step += 1) {
            if (cursor + 4 > view.byteLength) break
            const token = tokens[view.getUint32(cursor, true)]
            cursor += 4
            if (typeof token === 'string' && token !== '') schemas.push(token)
          }
        }
        out.set(path, schemas)
        break
      }
    }
    return out
  } catch {
    // A container this build of three decodes differently is not fatal: bodies
    // are still found through joint relationships and physics:mass.
    return undefined
  }
}

/** Reorder a crate quaternion to the USD text convention (real, i, j, k). */
function crateQuaternion(value) {
  const list = numberList(value)
  if (list.length < 4) return value
  return [list[3], list[0], list[1], list[2]]
}

/**
 * Decode one crate layer into the same prim map an ASCII layer produces.
 * @param bytes - the layer's bytes.
 * @returns the prim map, or undefined when the container cannot be decoded.
 */
function readCrateLayer(bytes) {
  const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer
  const parser = new USDCParser()
  // three logs "USDCParser: Unsupported …" for the list ops it skips (references,
  // payload, applied API schemas). Those warnings are left alone: they are true
  // statements about what three did not decode, and this module reads the ones
  // it needs straight out of the field table below.
  parser.parseData(buffer)
  const tokens = parser.tokens ?? []
  // A static crate costs a full container decode (its token table is LZ4), but
  // building 100k spec objects for a stage with no Physics prim is waste.
  if (tokens.some(token => typeof token === 'string' && (token.startsWith('Physics') || token.startsWith('physics:'))) === false) {
    return new Map()
  }
  const specs = parser.specsByPath ?? {}
  const apiSchemas = crateApiSchemas(parser)
  const inlinedValues = crateInlinedAttributeValues(parser)
  const prims = new Map()
  const propertyPaths = []
  for (const path of Object.keys(specs)) {
    const spec = specs[path]
    if (spec === undefined) continue
    if (spec.specType === SPEC_PRIM) {
      const fields = spec.fields ?? {}
      prims.set(path, {
        path,
        type: typeof fields.typeName === 'string' ? fields.typeName : '',
        apiSchemas: apiSchemas === undefined ? [] : (apiSchemas.get(path) ?? []),
        attrs: Object.create(null),
        rels: Object.create(null),
        spans: Object.create(null),
        text: undefined,
      })
    } else if (spec.specType === SPEC_ATTRIBUTE || spec.specType === SPEC_RELATIONSHIP) {
      propertyPaths.push(path)
    }
  }
  for (const path of propertyPaths) {
    const cut = path.lastIndexOf('.')
    if (cut <= path.lastIndexOf('/')) continue
    const owner = prims.get(path.slice(0, cut))
    if (owner === undefined) continue
    const name = path.slice(cut + 1)
    const spec = specs[path]
    const fields = spec.fields ?? {}
    if (spec.specType === SPEC_RELATIONSHIP) {
      const targets = Array.isArray(fields.targetPaths) ? fields.targetPaths : []
      owner.rels[name] = targets.filter(target => typeof target === 'string' && target.startsWith('/'))
    } else if (spec.specType === SPEC_ATTRIBUTE) {
      // An inlined vector was handed back as its raw payload by three; use the
      // decoded components instead of letting a scalar be read as a transform.
      const repaired = inlinedValues.get(path)
      if (repaired !== undefined) {
        owner.attrs[name] = repaired
      } else if (fields.default !== undefined && fields.default !== null) {
        // Keep one quaternion convention downstream: the crate stores the
        // imaginary part first, the text format the real part.
        owner.attrs[name] = QUATERNION_TYPES.has(fields.typeName) === true
          ? crateQuaternion(fields.default)
          : fields.default
      }
    }
  }
  return { prims, warnings: [] }
}

// ── reading a stage ────────────────────────────────────────────────────────

/** Turn the engine's package (Blob per layer) into bytes, in composition order. */
async function layerBytesOf(sources) {
  const entries = []
  const collect = async (key, value) => {
    let bytes
    if (typeof value === 'string') bytes = new TextEncoder().encode(value)
    else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value)
    else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    else if (typeof Blob !== 'undefined' && value instanceof Blob) bytes = new Uint8Array(await value.arrayBuffer())
    if (bytes === undefined || bytes.byteLength === 0) return
    entries.push({ key: String(key), bytes })
  }
  if (sources instanceof Map) {
    for (const [key, value] of sources) await collect(key, value)
  } else if (Array.isArray(sources)) {
    for (const entry of sources) {
      if (Array.isArray(entry) && entry.length >= 2) await collect(entry[0], entry[1])
    }
  } else if (typeof sources === 'object') {
    for (const key of Object.keys(sources)) await collect(key, sources[key])
  }
  return entries
}

/**
 * Decode one source layer into prims, skipping layers that cannot contain
 * kinematics before parsing them.
 * @returns the prim map and the text it came from (undefined for a crate).
 */
function decodeLayer(bytes) {
  if (isCrateLayer(bytes)) {
    const decoded = readCrateLayer(bytes)
    return { prims: decoded.prims, text: undefined, warnings: decoded.warnings }
  }
  if (!isTextLayer(bytes)) return undefined
  const text = decodeText(bytes)
  // Cheapest rejection there is: a text layer without the word cannot declare
  // a joint. Crates cannot be rejected this way (their token table is LZ2/LZ4).
  if (text.includes('Physics') === false && text.includes('physics:') === false) return undefined
  return { prims: new AsciiLayerReader(text).read(), text, warnings: [] }
}

/** Read the collision arrays a prim carries, from the crate values or its text span. */
function colliderGeometryOf(prim) {
  if (prim.attrs.points !== undefined) {
    return triangulateMesh(prim.attrs.points, prim.attrs.faceVertexCounts, prim.attrs.faceVertexIndices)
  }
  const text = prim.text
  if (typeof text !== 'string' || prim.spans === undefined || prim.spans.points === undefined) return undefined
  const reader = new AsciiLayerReader(text)
  const read = (name) => {
    const span = prim.spans[name]
    if (span === undefined) return undefined
    reader.at = span[0]
    return reader.value()
  }
  return triangulateMesh(read('points'), read('faceVertexCounts'), read('faceVertexIndices'))
}

/** Find the body a collision prim belongs to, allowing for a layer-root change. */
function matchBody(path, bodyPaths) {
  let at = path
  for (let guard = 0; guard < 64; guard += 1) {
    if (bodyPaths.has(at)) return at
    for (const body of bodyPaths) {
      // A payload composed under a body re-roots the referenced layer: its
      // `/Bodies/b00/collision/c0` is the stage's `/Asset/Bodies/b00/collision/c0`.
      if (at.length > 1 && body.endsWith(at)) return body
    }
    const cut = at.lastIndexOf('/')
    if (cut <= 0) return undefined
    at = at.slice(0, cut)
  }
  return undefined
}

/**
 * Read the articulated structure a set of USD layers declares.
 * @param sources - the layers the stage was composed from, keyed by package path
 *   (a Map of Blob/bytes, as `engine.js` hands them over), or any equivalent
 *   iterable of `[key, bytes]`.
 * @returns the articulation, or `undefined` when the stage declares none.
 */
export async function readArticulation(sources, onWarning) {
  try {
    return await readArticulationOf(sources, onWarning)
  } catch (error) {
    // A total function: a stage this reader cannot make sense of is "no
    // articulation", not an error the viewport has to explain. The caller that
    // wants to know why passes `onWarning` and gets the reason instead of a
    // silent static stage.
    if (typeof onWarning === 'function') {
      onWarning(`the articulated structure could not be read: ${error instanceof Error ? error.message : String(error)}`)
    }
    return undefined
  }
}

/** The body of {@link readArticulation}; may throw, the export cannot. */
async function readArticulationOf(sources, onWarning) {
  const entries = await layerBytesOf(sources)
  if (entries.length === 0) return undefined

  const warnings = []
  /** Record one approximation/limitation, and hand it to a caller that listens. */
  const warn = (message) => {
    warnings[warnings.length] = message
    if (typeof onWarning === 'function') onWarning(message)
  }
  /** path -> { prim, text }: first definition wins, like a stronger layer. */
  const merged = new Map()
  for (const entry of entries) {
    let layer
    try {
      layer = decodeLayer(entry.bytes)
    } catch (error) {
      warn(`layer ${entry.key} could not be decoded: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }
    if (layer === undefined) continue
    for (const warning of layer.warnings ?? []) warn(warning)
    for (const [path, prim] of layer.prims) {
      const existing = merged.get(path)
      if (existing === undefined) merged.set(path, { prim, text: layer.text })
      else mergePrim(existing.prim, prim, 'def')
    }
  }
  if (merged.size === 0) return undefined

  // ── world transforms, composed from the layer's xformOp chain ────────────
  const worldMemo = new Map()
  /** The stage-space rest transform of one prim path (identity when unknown). */
  const worldOfPath = (path) => {
    if (worldMemo.has(path)) return worldMemo.get(path)
    const chain = []
    let base
    let at = path
    for (let guard = 0; guard < 512; guard += 1) {
      const known = worldMemo.get(at)
      if (known !== undefined) {
        base = known.clone()
        break
      }
      chain.push(at)
      const cut = at.lastIndexOf('/')
      if (cut <= 0) {
        base = new THREE.Matrix4()
        break
      }
      at = at.slice(0, cut)
    }
    if (base === undefined) base = new THREE.Matrix4()
    for (let index = chain.length - 1; index >= 0; index -= 1) {
      const entry = merged.get(chain[index])
      if (entry !== undefined) base.multiply(localTransformOf(entry.prim.attrs))
      worldMemo.set(chain[index], base.clone())
    }
    const result = worldMemo.get(path) ?? new THREE.Matrix4()
    return result
  }

  // ── joints ──────────────────────────────────────────────────────────────
  const jointPrims = []
  for (const entry of merged.values()) {
    const prim = entry.prim
    if (typeof prim.type !== 'string' || prim.type === '') continue
    const kind = JOINT_KINDS.get(prim.type)
    if (kind !== undefined) {
      jointPrims.push({ prim, kind })
      continue
    }
    if (prim.type.startsWith('Physics') && prim.type.endsWith('Joint')) {
      // Spherical and distance joints have no single authored axis to drive.
      warn(`${prim.path} is a ${prim.type}, which this preview cannot drive; treated as fixed`)
      jointPrims.push({ prim, kind: 'fixed' })
    }
  }
  if (jointPrims.length === 0) return undefined

  // ── bodies ──────────────────────────────────────────────────────────────
  const bodyPaths = new Set()
  for (const { prim } of jointPrims) {
    for (const name of ['physics:body0', 'physics:body1']) {
      for (const target of prim.rels[name] ?? []) bodyPaths.add(target)
    }
  }
  for (const entry of merged.values()) {
    const prim = entry.prim
    const rigid = prim.apiSchemas.some(schema => schema === RIGID_BODY_API || schema.startsWith(RIGID_BODY_API + ':'))
    const massy = prim.apiSchemas.some(schema => schema === MASS_API || schema.startsWith(MASS_API + ':'))
      || prim.attrs['physics:mass'] !== undefined
    if (rigid || massy) bodyPaths.add(prim.path)
  }

  const bodies = []
  for (const path of bodyPaths) {
    const entry = merged.get(path)
    if (entry === undefined) {
      warn(`joint targets ${path}, which no composed layer defines; placed at the stage origin`)
    }
    const world = worldOfPath(path)
    bodies.push({ path, name: path.slice(path.lastIndexOf('/') + 1), matrix: matrixArray(world) })
  }

  // ── joints, in declaration order ────────────────────────────────────────
  const joints = []
  const tree = []
  let assumedLimits = 0
  const identity = new THREE.Matrix4()
  const one = new THREE.Vector3(1, 1, 1)
  for (const { prim, kind } of jointPrims) {
    const body0 = (prim.rels['physics:body0'] ?? [])[0] ?? null
    const body1 = (prim.rels['physics:body1'] ?? [])[0] ?? null
    if (body1 === null && body0 === null) {
      warn(`${prim.path} names no rigid body; skipped`)
      continue
    }
    const world0 = body0 === null ? identity : worldOfPath(body0)
    const world1 = body1 === null ? identity : worldOfPath(body1)
    const unit = kind === 'revolute'
      ? (prim.attrs['simready:unit'] === 'rad' ? 'rad' : 'deg')
      : 'base'

    // The joint frame belongs to both bodies; the body0 side is the one the
    // primary axis and the travel limits are expressed in.
    const local = new THREE.Matrix4()
    const authoredPos = prim.attrs['physics:localPos0']
    const authoredRot = prim.attrs['physics:localRot0']
    const otherPos = prim.attrs['physics:localPos1']
    const otherRot = prim.attrs['physics:localRot1']
    if (authoredPos !== undefined || authoredRot !== undefined) {
      local.compose(positionOf(authoredPos), orientationOf(authoredRot), one)
    } else if (otherPos !== undefined || otherRot !== undefined) {
      const fromBody1 = new THREE.Matrix4().compose(positionOf(otherPos), orientationOf(otherRot), one)
      local.copy(world0).invert().multiply(world1).multiply(fromBody1)
    }
    const frameWorld = new THREE.Matrix4().multiplyMatrices(world0, local)
    const pivot = new THREE.Vector3().setFromMatrixPosition(frameWorld)
    const authoredAxis = prim.attrs['physics:axis']
    const axis = axisOf(authoredAxis)
    if (kind !== 'fixed') {
      const token = typeof authoredAxis === 'string' ? authoredAxis.trim().toUpperCase() : undefined
      if (authoredAxis === undefined || (token !== undefined && token !== 'X' && token !== 'Y' && token !== 'Z')) {
        warn(`${prim.path} authors no usable physics:axis; its travel is driven about +X`)
      }
    }

    const home = numberOr(prim.attrs['simready:rest'], numberOr(prim.attrs['simready:home'], 0))
    let lower = numberOr(prim.attrs['physics:lowerLimit'], Number.NaN)
    let upper = numberOr(prim.attrs['physics:upperLimit'], Number.NaN)
    if (kind === 'fixed') {
      // A fixed joint transmits its parent's motion but has no travel of its own.
      lower = home
      upper = home
    } else if (Number.isFinite(lower) === false && Number.isFinite(upper) === false) {
      assumedLimits += 1
      const span = kind === 'prismatic' ? 0.25 : (unit === 'rad' ? Math.PI / 2 : 90)
      lower = kind === 'prismatic' ? home : home - span
      upper = home + span
    } else {
      if (Number.isFinite(lower) === false) lower = Math.min(upper, home)
      if (Number.isFinite(upper) === false) upper = Math.max(lower, home)
    }
    if (lower > upper) {
      const swap = lower
      lower = upper
      upper = swap
    }
    // `simready:far` is the pose the asset author marks as "open"; without it the
    // end away from home is the honest default.
    const far = numberOr(prim.attrs['simready:far'], Number.NaN)
    let open
    if (kind === 'fixed') open = home
    else if (Number.isFinite(far) && Math.abs(far - home) > 1e-9) open = THREE.MathUtils.clamp(far, lower, upper)
    else open = upper > home ? upper : lower
    if (Math.abs(open - home) <= 1e-9 && kind !== 'fixed') {
      open = Math.abs(upper - home) > 1e-9 ? upper : lower
    }

    joints.push({
      id: prim.path,
      path: prim.path,
      type: kind,
      body0,
      body1,
      axis: [axis.x, axis.y, axis.z],
      pivot: [pivot.x, pivot.y, pivot.z],
      frame: matrixArray(frameWorld),
      lower,
      upper,
      unit,
      home,
      open,
      opens: open >= home ? 'open' : 'close',
    })
    if (body1 !== null) tree.push({ joint: prim.path, parent: body0, child: body1 })
  }
  if (joints.length === 0) return undefined
  if (assumedLimits > 0) {
    warn(`${assumedLimits} joint(s) authored no travel limits; a symmetric default range was assumed`)
  }

  // ── tree order and roots ────────────────────────────────────────────────
  const children = new Map()
  const hasParent = new Set()
  for (const edge of tree) {
    // A joint with no body0 hangs its child off the stage, so that child is a
    // root: SimReady spells that as a `root_joint` with only a body1.
    if (edge.parent !== null) hasParent.add(edge.child)
    const key = edge.parent ?? ''
    const list = children.get(key) ?? []
    list.push(edge.child)
    children.set(key, list)
  }
  const bodyByPath = new Map(bodies.map(body => [body.path, body]))
  const roots = bodies.filter(body => hasParent.has(body.path) === false).map(body => body.path)
  const ordered = []
  const seen = new Set()
  const queue = [...roots]
  while (queue.length > 0) {
    const path = queue.shift()
    if (seen.has(path)) continue
    seen.add(path)
    const body = bodyByPath.get(path)
    if (body !== undefined) ordered.push(body)
    for (const child of children.get(path) ?? []) queue.push(child)
  }
  for (const body of bodies) if (seen.has(body.path) === false) ordered.push(body)

  // ── authored collision geometry ─────────────────────────────────────────
  const colliders = []
  for (const entry of merged.values()) {
    const prim = entry.prim
    if (isColliderPrim(prim) === false) continue
    const geometry = colliderGeometryOf(prim)
    if (geometry === undefined) continue
    const world = worldOfPath(prim.path)
    colliders.push({
      path: prim.path,
      body: matchBody(prim.path, bodyPaths),
      positions: bakePositions(geometry.positions, world),
      indices: geometry.indices,
    })
  }

  return {
    kind: 'usdphysics',
    roots,
    bodies: ordered,
    joints,
    tree,
    colliders,
    warnings,
  }
}

// The controller lives in kinematics.js: reading a stage and driving a scene have
// different inputs, lifetimes and tests, so they are separate modules with a
// one-way dependency (kinematics imports this one, never the reverse).
