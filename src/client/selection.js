/**
 * The selection highlight: the picked object, tinted in the shell's accent.
 *
 * Picking is how a user names a prim, and a name in a panel is easy to lose on a
 * busy stage — "which one did I just click?" is a question about the frame, not
 * about a list. This module answers it: the object under the cursor is drawn a
 * second time in the accent colour, over its own surface.
 *
 * ## Why a re-drawn copy rather than a changed material
 *
 * The assembled materials belong to the engine, which shares one
 * `MeshStandardMaterial` between every mesh a file gives the same appearance
 * to: writing `emissive` on it would highlight unselected geometry as well.
 * Cloning the material per selection would work, but the clone would then have to
 * be kept in step with everything the view does to materials (wireframe today,
 * whatever it learns next), and a clone that outlives its selection is a leak.
 * A copy of the geometry under one highlight material shares the engine's
 * buffers — no vertex is duplicated — and touches nothing the model owns.
 *
 * The copy is a **child of the object it highlights**, at the identity
 * transform. That is what makes it follow an articulated part: the body group
 * moves, the mesh moves, and the tint moves with it without this module knowing
 * that joints exist. It also means a hidden mesh (the collider toggle) hides its
 * own highlight instead of leaving a floating tint behind.
 *
 * The copy is deliberately anonymous — `name = 'selection'`, and
 * `userData.usdSelection` — because every part of this plugin that walks the graph
 * for prim paths keys off a node name starting with `/`. A copy that borrowed its
 * source's path would be listed in the prims panel as a second prim, and one that
 * borrowed a display name would make `collectPrimPaths` and the stats disagree
 * with what the file contains.
 *
 * The copy raycasts as nothing: a highlight must never be the thing a click
 * finds, or a second click on the same part would select the tint instead of the
 * geometry under it.
 *
 * ## What it is not
 *
 * A tint, not an outline. An inverted-hull outline needs thickness a flat quad
 * does not have, and edge extraction is a per-vertex pass over geometry this
 * viewport is deliberately not allowed to keep for large stages. The tint is
 * drawn at the object's own surface — the same depth, pulled forward a hair by a
 * polygon offset — so a selection that is behind something else stays behind it:
 * the highlight never claims an object is visible when it is occluded.
 *
 * Only drawable meshes are highlighted. A points or line prim is still named by
 * the pick; it has no surface to tint, and this module says so by returning
 * `false` rather than inventing one.
 *
 * @module dsh-usd-3d-preview/selection
 */

import * as THREE from 'three'

/** The accent a selection is tinted with — the shell's business blue, as RGB. */
const HIGHLIGHT_COLOR = 0x4d8dff

/**
 * How much of the accent covers the selected surface.
 *
 * A selection is an annotation, not a repaint: the object's own material has to
 * stay readable through it. High enough to be unmistakable on a white surface and
 * on a near-black one, low enough that a lit gradient still shows through.
 */
const HIGHLIGHT_OPACITY = 0.42

/**
 * Draw after the model and after the collision overlay.
 *
 * The overlay is transparent, so the renderer already draws it in the transparent
 * pass, last; this only orders it against the collider shell (2) and its edges
 * (3), which it would otherwise tie with.
 */
const HIGHLIGHT_RENDER_ORDER = 4

/**
 * @typedef {object} SelectionTarget
 * @property {THREE.Object3D} object - the mesh the pick hit.
 * @property {number} [instanceId] - which placement of an instanced batch was
 *   hit; absent for a plain mesh.
 */

/**
 * @typedef {object} SelectionHighlight
 * @property {(target: SelectionTarget | undefined) => boolean} set - highlight
 *   one target, replacing whatever was highlighted; `undefined` clears. Returns
 *   whether a highlight is now showing, which is `false` for a target this module
 *   cannot tint.
 * @property {() => void} clear - drop the highlight and restore the frame exactly.
 * @property {() => boolean} active - whether anything is highlighted.
 * @property {(on: boolean) => void} setWireframe - follow the viewport's wireframe
 *   mode, including for a highlight created after the mode was switched on.
 * @property {() => void} dispose - drop the highlight and release its material.
 */

/**
 * Build one view's selection highlight.
 *
 * One material is created on first use and reused for every selection, so
 * clicking from part to part compiles one program and allocates one material
 * rather than one per click.
 * @returns {SelectionHighlight} the highlight, owned by the view that created it.
 */
export function createSelectionHighlight() {
  /** The tint material, created on first use and shared by every highlighted copy. */
  let material = null
  /** Whether the viewport is drawing wireframe; a later copy must honour it. */
  let wireframe = false
  /** The copies currently in the scene, and the objects they were parented to. */
  let overlays = []
  /** A matrix the instanced path reads one placement into. */
  const placement = new THREE.Matrix4()

  /**
   * The tint material, created once per view.
   * @returns the shared highlight material.
   */
  const ensureMaterial = () => {
    if (material !== null) return material
    material = new THREE.MeshBasicMaterial({
      color: HIGHLIGHT_COLOR,
      transparent: true,
      opacity: HIGHLIGHT_OPACITY,
      // The copy sits exactly on the surface it highlights: it must not write
      // depth (the model's own depth already decided what is in front), and it
      // is nudged towards the camera so a coincident triangle cannot z-fight.
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      // The accent is UI ink, not a lit material: the studio's tone mapping would
      // mute it against the panel's dark surface.
      toneMapped: false,
      // Draw where the source draws: a one-sided stage hides its back faces, and
      // its highlight has to disappear with them. `set()` mirrors the source
      // material's own `side` onto this shared material for that reason.
      side: THREE.FrontSide,
      wireframe,
    })
    return material
  }

  /**
   * Copy the source material's face policy onto the shared tint.
   *
   * A two-sided asset shows its back faces, so its highlight has to as well; a
   * one-sided one must not gain a tint where it draws nothing. This is the only
   * property the tint takes from the model, and it is written on the shared
   * material because only one selection exists at a time.
   * @param source - the object being highlighted.
   */
  const mirrorFacePolicy = (source) => {
    // A multi-material mesh is several geometries under one node; the first
    // material's side is what the node draws its faces with.
    const sourceMaterial = Array.isArray(source.material) ? source.material[0] : source.material
    const side = sourceMaterial?.side
    if (side === undefined || side === null) return
    ensureMaterial().side = side
  }

  /**
   * Build the copy that tints one target.
   *
   * An instanced batch is copied as a one-instance batch carrying the hit
   * placement's matrix, so a click on one wheel of an instancer highlights that
   * wheel rather than all of them.
   * @param target - what was hit.
   * @returns the copy, or undefined when this target has no surface to tint.
   */
  const copyOf = (target) => {
    const object = target?.object
    if (object === undefined || object === null) return undefined
    if (object.isInstancedMesh === true) {
      const instance = target.instanceId
      // Without a placement the batch cannot be tinted honestly: copying the
      // prototype would highlight geometry at the origin that was never hit.
      if (!Number.isInteger(instance) || instance < 0 || instance >= (object.count ?? 0)) return undefined
      const copy = new THREE.InstancedMesh(object.geometry, ensureMaterial(), 1)
      object.getMatrixAt(instance, placement)
      copy.setMatrixAt(0, placement)
      copy.instanceMatrix.needsUpdate = true
      return copy
    }
    if (object.isMesh === true) return new THREE.Mesh(object.geometry, ensureMaterial())
    return undefined
  }

  /**
   * Take every copy back out of the scene.
   *
   * The geometry is the source mesh's and is never disposed here — this module
   * does not own it. A one-instance batch does own the placement buffer three
   * created for it, so that copy is disposed.
   */
  const clear = () => {
    for (const { copy, parent } of overlays) {
      parent.remove(copy)
      if (copy.isInstancedMesh === true) copy.dispose()
    }
    overlays = []
  }

  return {
    set(target) {
      clear()
      const copy = copyOf(target)
      if (copy === undefined) return false
      const source = target.object
      mirrorFacePolicy(source)
      // The copy is deliberately *not* named after the prim it highlights, and it
      // carries a flag instead. Every consumer that walks the graph for prim paths
      // keys off a name starting with "/" (see `collectPrimPaths`), and a copy
      // that borrowed its source's path would be listed as a second prim.
      copy.name = 'selection'
      copy.userData.usdSelection = true
      copy.renderOrder = HIGHLIGHT_RENDER_ORDER
      // The copy shares the source's geometry at the identity transform, so its
      // bounds are the source's; skipping the cull only ever costs one draw call.
      copy.frustumCulled = false
      // A click must find the model, never the tint drawn on top of it.
      copy.raycast = () => {}
      source.add(copy)
      overlays.push({ copy, parent: source })
      return true
    },
    clear,
    active() {
      return overlays.length > 0
    },
    setWireframe(on) {
      wireframe = on === true
      if (material !== null) material.wireframe = wireframe
    },
    dispose() {
      clear()
      if (material !== null) {
        material.dispose()
        material = null
      }
    },
  }
}
