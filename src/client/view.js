/**
 * The three.js viewport: renderer, studio rig, camera, controls, frame loop.
 *
 * `UsdBody` owns the React state — what was assembled, what failed, which toggle
 * is on — and this module owns everything mutable about the canvas. The split is
 * what lets the same view serve a USD root from either engine, and it keeps the
 * component's effects about *intent* (show the grid, reset the camera) instead of
 * about renderer plumbing.
 *
 * The view is created once per assembled root and destroyed with it: geometry,
 * materials and any GPU state that outlives the React tree would otherwise leak
 * for the life of the window.
 *
 * ## The object contract
 *
 * The root handed in is parented *as-is*. It may be a flat group whose children
 * carry baked world matrices (what the WASM engine produces), or a nested graph
 * (what the three fallback composes); the view measures it, frames it, and never
 * rewrites a transform of its own.
 *
 * ## Rendering cadence
 *
 * The canvas is drawn **on demand**, not on a permanent rAF loop, so a still
 * model costs no GPU time once it settles. A frame is guaranteed after:
 *
 *  - creation — drawn synchronously, before the browser paints anything;
 *  - every resize of the container;
 *  - every OrbitControls update that moves the camera, including the inertia
 *    tail after a drag: the loop keeps drawing until `update()` reports the
 *    camera has stopped, which is what "damping" means here;
 *  - while auto-rotate is on;
 *  - while an `onFrame` observer reports it has more work: an observer *pulls*
 *    frames. Registering one guarantees the first frame; returning `true` from
 *    the callback asks for the next. That is how an articulated-parts controller
 *    animates (it keeps reporting work while a joint is still travelling), and
 *    it is what keeps an articulated asset from burning frames once every joint
 *    has settled;
 *  - every `requestRender()` call, and the setters below issue one.
 *
 * ## Hooks
 *
 * Two registration points exist instead of a callback soup, so a consumer can
 * observe the view without the view knowing what it is:
 *
 *  - {@link View#onFrame} runs on every drawn frame with the elapsed milliseconds
 *    and returns `true` while it wants more;
 *  - {@link View#onPick} runs when a click taps the model rather than dragging it.
 *
 * Both return their own unsubscribe function; neither keeps the other alive.
 *
 * @module dsh-usd-3d-preview/view
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { configureRenderer, createStudio, enableObjectShadows } from './studio.js'

/**
 * @typedef {object} ViewOptions
 * @property {number} [fov] - vertical field of view in degrees; defaults to 35.
 * @property {string} [background] - CSS colour behind the canvas; transparent when absent.
 * @property {{ min: [number, number, number], max: [number, number, number] }} [frame] -
 *   a world-space box the camera should frame when the caller knows where the model
 *   will reach — an articulated stage's joints at both extremes, not just the rest
 *   pose. The stage floor still sits at the rest pose's base.
 */

/**
 * @typedef {object} View
 * @property {THREE.GridHelper} grid - the reference grid, for callers that toggle its visibility.
 * @property {() => void} reset - frame the model again from its initial direction.
 * @property {(on: boolean) => void} setSpin - start or stop the slow auto-rotate.
 * @property {(on: boolean) => void} setWireframe - draw every material as wireframe, or not.
 * @property {(on: boolean) => void} setGridVisible - show or hide the reference grid.
 * @property {() => void} requestRender - ask for one more frame.
 * @property {(callback: (deltaMs: number) => boolean | void) => () => void} onFrame - observe drawn frames; return true to pull another.
 * @property {(callback: (hits: THREE.Intersection[]) => void) => () => void} onPick - observe clicks on the model.
 * @property {THREE.WebGLRenderer} renderer - the view's renderer: read-only handle, the view drives it.
 * @property {THREE.Scene} scene - the view's scene: read-only handle, the view drives it.
 * @property {() => void} destroy - stop the loop and release the renderer and its canvas.
 */

/** Pixels of pointer travel still treated as a click rather than an orbit drag. */
const CLICK_SLOP = 5
/** Vertical field of view: wide enough for a room, tight enough to avoid distortion. */
const DEFAULT_FOV = 35
/**
 * Framing margin. A bounding sphere framed at `r / sin(fov/2)` exactly touches
 * the top and bottom edge; 6% more lets the silhouette breathe without shrinking
 * it into the middle of the panel.
 */
const FRAME_MARGIN = 1.06
/**
 * The half-angle the framing sphere has to fit.
 *
 * `fov` is the *vertical* field of view, so a container narrower than it is
 * tall clips the model horizontally first even though the vertical angle looks
 * generous. The usable half-angle is the smaller of the two.
 * @param fovDegrees - the vertical field of view, in degrees.
 * @param aspect - container width / height.
 * @returns the half-angle, in radians, the sphere must fit inside.
 */
function fitHalfAngle(fovDegrees, aspect) {
  const vertical = (fovDegrees * Math.PI) / 360
  const horizontal = Math.atan(Math.tan(vertical) * aspect)
  return Math.min(vertical, horizontal)
}

/** Starting camera direction: front-right and slightly above, the usual hero angle. */
const VIEW_DIRECTION = new THREE.Vector3(1, 0.62, 1).normalize()
/** Orbit limits: the camera may not go under the floor the studio puts the model on. */
const MAX_POLAR_ANGLE = Math.PI * 0.495
/** Damping ratio of the orbit inertia. */
const DAMPING_FACTOR = 0.12
/** Auto-rotate speed in the OrbitControls unit (one revolution in 30 s at 2). */
const AUTO_ROTATE_SPEED = 1.2

/**
 * Build the orbit viewport for one assembled root.
 * @param container - the positioned element the canvas fills.
 * @param object - the assembled root, parented by this call.
 * @param options - field of view and background.
 * @returns the live view, with its own teardown.
 */
export function createView(container, object, options = {}) {
  const width = Math.max(container.clientWidth, 1)
  const height = Math.max(container.clientHeight, 1)

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  configureRenderer(renderer)
  renderer.setSize(width, height, false)
  const canvas = renderer.domElement
  canvas.style.display = 'block'
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.touchAction = 'none'
  // Tests and the document seat select the canvas by this marker.
  canvas.dataset.usdPreviewCanvas = ''
  container.appendChild(canvas)

  const scene = new THREE.Scene()
  if (options.background !== undefined) scene.background = new THREE.Color(options.background)
  const perspective = new THREE.PerspectiveCamera(options.fov ?? DEFAULT_FOV, width / height, 0.01, 1e6)

  // The measured rest pose is where the model *stands*: the stage floor's height
  // comes from it and must not move when the camera frames a wider box.
  const restBox = new THREE.Box3().setFromObject(object)
  const base = restBox.isEmpty() ? 0 : restBox.min.y

  // What the camera and the rig are sized to. A caller that knows where the model
  // will reach hands in that box instead (an articulated stage at both joint
  // extremes); otherwise the rest pose is the answer. Framing the union of both
  // extremes is what keeps an "open all" pose from swinging the model out of the
  // viewport.
  const framing = options.frame === undefined
    ? restBox
    : new THREE.Box3(
      new THREE.Vector3().fromArray(options.frame.min),
      new THREE.Vector3().fromArray(options.frame.max),
    )
  const empty = framing.isEmpty()
  const size = empty ? new THREE.Vector3(1, 1, 1) : framing.getSize(new THREE.Vector3())
  const center = empty ? new THREE.Vector3() : framing.getCenter(new THREE.Vector3())
  const radius = Math.max(size.length() * 0.5, 1e-4)

  const studio = createStudio(scene, renderer, { center, radius, base })
  // One traversal, before the first frame: nothing in the assembled graph casts
  // or receives shadows unless the studio asks it to.
  enableObjectShadows(object)

  const grid = new THREE.GridHelper(radius * 4, 24, 0x7c8698, 0x4a5162)
  grid.position.set(center.x, base, center.z)
  grid.material.transparent = true
  grid.material.opacity = 0.35
  scene.add(grid)
  scene.add(object)

  const controls = new OrbitControls(perspective, canvas)
  controls.enableDamping = true
  controls.dampingFactor = DAMPING_FACTOR
  controls.screenSpacePanning = true
  controls.autoRotateSpeed = AUTO_ROTATE_SPEED
  controls.maxPolarAngle = MAX_POLAR_ANGLE
  controls.minDistance = radius * 0.6

  // Distance at which the bounding sphere fits the frame, with the margin on top;
  // every other camera bound is derived from it so a small part and a large
  // building orbit sensibly (near = distance/100, far = 100×). The half-angle is
  // the smaller of the vertical and horizontal ones: a portrait panel (a
  // right-sidebar document tab) would otherwise clip the model at the sides.
  const distance = (radius / Math.sin(fitHalfAngle(perspective.fov, perspective.aspect))) * FRAME_MARGIN
  controls.maxDistance = distance * 4

  /** @type {Set<(deltaMs: number) => void>} */
  const frameCallbacks = new Set()
  /** @type {Set<(hits: THREE.Intersection[]) => void>} */
  const pickCallbacks = new Set()

  // ── on-demand frame loop ──────────────────────────────────────────────────
  /** A frame is owed by an explicit request rather than by motion. */
  let pendingFrame = true
  /** A pointer gesture is in flight: OrbitControls needs `update()` frames. */
  let interacting = false
  /** The loop is armed with `setAnimationLoop`. */
  let running = false
  /** Timestamp of the previous drawn frame; 0 means "this is the first one". */
  let lastTime = 0
  /** Guards a call made after teardown (React cleanup order is not a contract). */
  let destroyed = false

  /**
   * Draw one frame.
   *
   * Observers run before the controls and the render, so a joint the controller
   * writes on this frame is drawn on this frame.
   * @param deltaMs - time since the previous frame, in milliseconds.
   * @returns whether anything wants the next frame: an observer that reported
   *   work, or OrbitControls still settling the camera.
   */
  function drawFrame(deltaMs) {
    let wanted = false
    // A returning `true` is a pull: the observer says it has another frame's
    // worth of work, which is the whole animation contract (see onFrame).
    for (const callback of frameCallbacks) {
      if (callback(deltaMs) === true) wanted = true
    }
    // `deltaTime` in seconds keeps auto-rotate frame-rate independent.
    const moved = controls.update(deltaMs / 1000)
    renderer.render(scene, perspective)
    return wanted || moved
  }

  /** Draw a frame outside the loop, unscheduled: creation and resize. */
  function drawNow() {
    pendingFrame = false
    lastTime = 0
    // An observer may do work on this frame too; if it pulls, the loop takes over.
    if (drawFrameContained(0) === true) requestRender()
  }

  function startLoop() {
    if (running || destroyed) return
    running = true
    lastTime = 0
    renderer.setAnimationLoop(loop)
  }

  function stopLoop() {
    if (!running) return
    running = false
    lastTime = 0
    renderer.setAnimationLoop(null)
  }

  /**
   * Report a frame that threw, and stop the loop instead of re-throwing it every
   * rAF.
   *
   * Three's animation loop has already scheduled the next frame when the
   * callback runs, so an uncaught throw inside an observer or `renderer.render`
   * would repeat forever: it breaks the "idle costs nothing" contract and leaves
   * `running` true, so `requestRender()` could never restart the loop. Stopping
   * here lets the next explicit request (a toolbar action, a resize, a fresh
   * observer) start a clean loop.
   * @param error - what the frame threw.
   */
  function failLoop(error) {
    stopLoop()
    console.error('[dsh-usd-3d-preview] frame stopped after an error:', error)
  }

  /**
   * Draw one frame, containing a throwing observer or renderer.
   * @param deltaMs - time since the previous frame, in milliseconds.
   * @returns {@link drawFrame}'s answer, or undefined when the frame threw (the
   *   loop is already stopped and must not keep drawing).
   */
  function drawFrameContained(deltaMs) {
    try {
      return drawFrame(deltaMs)
    } catch (error) {
      failLoop(error)
      return undefined
    }
  }

  /**
   * The loop body. It stops itself as soon as nothing owns the next frame, so an
   * idle viewport leaves the GPU alone.
   * @param time - the rAF timestamp in milliseconds.
   */
  function loop(time) {
    const deltaMs = lastTime === 0 ? 0 : Math.max(0, time - lastTime)
    lastTime = time
    pendingFrame = false
    const pulled = drawFrameContained(deltaMs)
    // A thrown frame is contained and already stopped; drawing on would just
    // throw again on the next rAF.
    if (pulled === undefined) return
    // Keep drawing while: someone asked again, a gesture is live, an observer
    // pulled another frame, the camera is still settling after a drag, or
    // auto-rotate is on. The first condition that fails ends the loop — a static
    // stage with an idle observer therefore costs nothing.
    const keep = pendingFrame || interacting || pulled || controls.autoRotate
    if (!keep) stopLoop()
  }

  /** Ask for one more frame; the view settles again as soon as it is drawn. */
  function requestRender() {
    if (destroyed) return
    pendingFrame = true
    startLoop()
  }

  /** Frame the model again from the initial direction. */
  function reset() {
    perspective.position.copy(center).addScaledVector(VIEW_DIRECTION, distance)
    perspective.near = distance / 100
    perspective.far = distance * 100
    perspective.updateProjectionMatrix()
    controls.target.copy(center)
    controls.update()
    requestRender()
  }

  reset()
  drawNow()

  // OrbitControls dispatches `change` when its own handlers (and our loop) move
  // the camera; that is the viewport's "input happened, draw" signal.
  const onControlsChange = () => requestRender()
  const onControlsStart = () => {
    interacting = true
    requestRender()
  }
  const onControlsEnd = () => { interacting = false }
  controls.addEventListener('change', onControlsChange)
  controls.addEventListener('start', onControlsStart)
  controls.addEventListener('end', onControlsEnd)

  function resize() {
    const nextWidth = Math.max(container.clientWidth, 1)
    const nextHeight = Math.max(container.clientHeight, 1)
    renderer.setSize(nextWidth, nextHeight, false)
    perspective.aspect = nextWidth / nextHeight
    perspective.updateProjectionMatrix()
    // A resize always ends with a frame at the new size, whether or not the loop
    // is running: the last frame the user saw is now the wrong shape.
    drawNow()
  }
  const observer = new ResizeObserver(resize)
  observer.observe(container)

  const raycaster = new THREE.Raycaster()
  const pointer = new THREE.Vector2()
  let pressX = 0
  let pressY = 0

  const onPointerDown = (event) => {
    pressX = event.clientX
    pressY = event.clientY
  }
  const onPointerUp = (event) => {
    if (event.button !== 0) return
    // An orbit drag is not a click: the model moves under the cursor, so a tap
    // that travelled further than the slop selects nothing.
    if (Math.abs(event.clientX - pressX) > CLICK_SLOP || Math.abs(event.clientY - pressY) > CLICK_SLOP) return
    if (pickCallbacks.size === 0) return
    const rect = canvas.getBoundingClientRect()
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(pointer, perspective)
    pickCallbacks.forEach(callback => callback(raycaster.intersectObject(object, true)))
  }
  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointerup', onPointerUp)

  return {
    grid,
    reset,
    setSpin(on) {
      controls.autoRotate = on === true
      requestRender()
    },
    setWireframe(on) {
      object.traverse((node) => {
        const material = node.material
        if (Array.isArray(material)) {
          for (const entry of material) if (entry !== undefined && entry !== null) entry.wireframe = on === true
        } else if (material !== undefined && material !== null) {
          material.wireframe = on === true
        }
      })
      requestRender()
    },
    setGridVisible(on) {
      grid.visible = on === true
      requestRender()
    },
    requestRender,
    onFrame(callback) {
      frameCallbacks.add(callback)
      // Joining guarantees a first frame even for an observer that starts idle;
      // from there it re-arms the loop one frame at a time by returning true.
      // Unsubscribing lets the loop settle on its next frame.
      requestRender()
      return () => frameCallbacks.delete(callback)
    },
    onPick(callback) {
      pickCallbacks.add(callback)
      return () => pickCallbacks.delete(callback)
    },
    renderer,
    scene,
    destroy() {
      destroyed = true
      stopLoop()
      observer.disconnect()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointerup', onPointerUp)
      controls.removeEventListener('change', onControlsChange)
      controls.removeEventListener('start', onControlsStart)
      controls.removeEventListener('end', onControlsEnd)
      frameCallbacks.clear()
      pickCallbacks.clear()
      controls.dispose()
      // The rig releases what it added (environment target, lights, ground); the
      // grid is the view's own.
      studio.dispose()
      grid.geometry.dispose()
      grid.material.dispose()
      // The model and its geometry belong to the caller, which releases them with
      // the assembled root; detaching is all this view may do.
      scene.remove(object)
      renderer.dispose()
      // Free the GPU context now instead of when the browser recycles it: a
      // sidebar that opens file after file would otherwise hit the per-page
      // context cap and start losing the oldest canvas.
      renderer.forceContextLoss()
      canvas.remove()
    },
  }
}
