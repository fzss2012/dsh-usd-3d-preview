/**
 * The studio rig: renderer policy, image-based fill, lights, and the stage the
 * model stands on.
 *
 * A USD stage ships geometry and `UsdPreviewSurface` factors — never a lighting
 * rig. A default three scene therefore renders a "raw preview": flat diffuse, no
 * contact with a floor, no specular shape on car paint or brushed metal. This
 * module answers that with a studio: Khronos PBR Neutral tone mapping, a
 * `RoomEnvironment` PMREM, four `RectAreaLight`s (key/fill/top/rim) and one
 * shadow-casting directional key over a ground plane. The rig is scaled to
 * whatever size the stage measured:
 *
 *   renderer   sRGB output, NeutralToneMapping, PCFShadowMap, pixelRatio <= 2
 *   fill       one PMREM of a procedural room (intensity a fill, not the key)
 *   key        DirectionalLight 2.4, 2048² shadow map, ortho half-extent 1.6 radii
 *   soft       four RectAreaLights at the studio's 8.6/6.4/2.6/10 ratios
 *   stage      a matte disc, 5 radii across, fading out at the rim, at the base
 *
 * Everything below is created once per view and released by `dispose()`; nothing
 * here allocates per frame.
 *
 * ## Why the floor is a lit surface and not a `ShadowMaterial` plane
 *
 * A studio scene with a lit backdrop behind the model can stage on a shadow-only
 * plane. This viewport's canvas is transparent over the shell's near-black
 * surface, where a shadow-only plane has nothing to darken: a shadow is a
 * multiplicative darkening of an existing surface, and a transparent canvas
 * offers no surface at all. The studio therefore brings its own stage — a matte
 * disc that receives the shadow and fades out before the frame edge, so the
 * shell's surface still shows around the model.
 *
 * ## Calibration
 *
 * A rig tuned for pre-lit, textured assets is too hot for a default-albedo (0.8)
 * `UsdPreviewSurface` (what a Blender export produces): it squeezes the model
 * into the top of the tonal range, where no gradient is left to read. The
 * calibration here lowers the panel powers so a default-albedo surface keeps a
 * readable shading gradient instead of clipping into a white silhouette, while
 * keeping the four-panel character; `STUDIO` below is that calibration as data,
 * and the studio suite asserts the renderer and scene against it.
 *
 * ## Why RoomEnvironment rather than a hand-built gradient cyc
 *
 * The default environment path is `RoomEnvironment` +
 * `PMREMGenerator.fromScene`; a custom gradient sphere would need a per-asset
 * variant switch this viewport has no equivalent of. A room also beats a bare
 * gradient here: it puts real area-shaped highlights into the PMREM, which is
 * what makes glossy `UsdPreviewSurface` materials read as gloss instead of as a
 * uniform sheen. The cost is one bundled examples module and ~1 ms of PMREM
 * filtering per view, not per frame.
 *
 * ## What this rig does not do
 *
 * Material-level effects — injecting environment or light into a physical
 * material to fake glass, coat, fuzz or thickness — have nothing to act on: the
 * WASM engine has already flattened USD material inputs into
 * `MeshStandardMaterial`, which carries none of those channels. Rather than fake
 * them, this viewport stops at the rig it can substantiate. A screen-space AO
 * pass, an SVG studio backdrop and a DOM overlay would likewise belong to a
 * full-scene renderer with its own layout; this viewport keeps a transparent
 * canvas over the shell's own surface instead.
 *
 * @module dsh-usd-3d-preview/studio
 */
import * as THREE from 'three'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js'

/** Tone-mapping exposure: the studio's overall brightness. */
const EXPOSURE = 0.9
/**
 * How much of the image-based fill reaches the materials. An ambient term tuned
 * for pre-lit assets acts as the key on a default-albedo surface and flattens
 * the model; here it is deliberately only a fill. See "Calibration" above.
 */
const ENVIRONMENT_INTENSITY = 0.2
/** Blur applied when the room is pre-filtered. */
const ENVIRONMENT_BLUR = 0.04
/** Intensity of the directional key — the only shadow caster. */
const KEY_INTENSITY = 2.4
/** Key-light distance from the model centre, in model radii. */
const KEY_DISTANCE = 4
/** Half-extent of the shadow camera's orthographic box, in model radii. */
const SHADOW_EXTENT = 1.6
/** Shadow map resolution per side. */
const SHADOW_MAP_SIZE = 2048
/** Depth bias: thin geometry must not shadow-acne. */
const SHADOW_BIAS = -5e-4
/**
 * Scale applied to the panels' relative powers.
 *
 * A panel's illuminance is intensity times solid angle, and these panels are
 * sized relative to the model's radius, so their solid angle is large. At the
 * untuned powers a white `UsdPreviewSurface` blows out to a flat white silhouette
 * with no shading gradient left to read — a torch, not a studio. The gain is the
 * calibration that keeps highlights legible on a default-albedo surface while
 * preserving the four-panel character; the studio suite keeps a white reference
 * surface on the stage and asserts its lit luminance band.
 */
const PANEL_GAIN = 0.22

/** Stage disc radius, in model radii. */
const STAGE_RADIUS = 5
/**
 * The stage's own colour: a neutral dark enough that it stays under the shell's
 * mid-tones, light enough that the key light's shadow has something to darken.
 */
const STAGE_COLOR = 0x2b3038
/**
 * The ground sits this fraction of a radius below the base. The grid shares the
 * same plane, and coplanar transparent lines and plane z-fight; a sub-pixel gap
 * is invisible and removes it.
 */
const GROUND_GAP = 0.002
/**
 * Direction from the model towards the key light: right and behind, 49 degrees
 * up. A key on the camera's own azimuth throws its contact shadow behind the
 * model, where the default view never sees it; from behind-right the shadow
 * falls towards the front-left of the stage instead, across the part of the
 * ground the camera actually looks at. That costs some coherence with the soft
 * key panel (which stays front-right, as a studio's key does) — a sharp light
 * from the right and a soft one from the front-right read fine, and the visible
 * contact is worth more than the last degree of rig consistency.
 */
const KEY_DIRECTION = new THREE.Vector3(0.85, 1, -0.3).normalize()
/**
 * The four soft panels: the studio's relative powers (8.6 / 6.4 / 2.6 / 10),
 * their size, and their offset from the model centre — the latter two in model
 * radii so the rig scales with whatever the stage measured. Panel area scaling
 * with r² is what keeps their illuminance scale-invariant.
 */
const AREA_LIGHTS = [
  { name: 'key', intensity: 8.6 * PANEL_GAIN, width: 2.2, height: 1.6, offset: [1.7, 2.1, 2.2] },
  { name: 'fill', intensity: 6.4 * PANEL_GAIN, width: 2.6, height: 1.8, offset: [-2.4, 1.0, 1.8] },
  { name: 'top', intensity: 2.6 * PANEL_GAIN, width: 2.4, height: 2.4, offset: [0, 3.0, 0] },
  { name: 'rim', intensity: 10 * PANEL_GAIN, width: 1.8, height: 1.2, offset: [-1.4, 1.8, -2.6] },
]

/**
 * Scene-graph names. The panels and the key light are different things and must
 * never share a name: `getObjectByName('studio-key')` has to be the light that
 * owns the shadow map, or a caller looking for the caster silently picks up a
 * RectAreaLight with no `.shadow`.
 */
const PANEL_NAME_PREFIX = 'studio-panel-'
const KEY_NAME = 'studio-key'
const GROUND_NAME = 'studio-ground'

/**
 * The rig's calibration, as data.
 *
 * Exported so the studio suite asserts the *policy* the view applied instead of
 * retyping the numbers: a deliberate retune changes these constants, the suite
 * follows them, and it still proves the renderer/scene really received them.
 * The panel powers are the studio's relative panel ratios; their absolute values
 * are `panelPower x panelGain` (see PANEL_GAIN).
 */
export const STUDIO = Object.freeze({
  exposure: EXPOSURE,
  environmentIntensity: ENVIRONMENT_INTENSITY,
  keyIntensity: KEY_INTENSITY,
  panelPowers: Object.freeze(AREA_LIGHTS.map(light => light.intensity / PANEL_GAIN)),
  panelGain: PANEL_GAIN,
  shadowMapSize: SHADOW_MAP_SIZE,
  shadowBias: SHADOW_BIAS,
  shadowFrustum: Object.freeze({ extent: SHADOW_EXTENT, near: 0.5, far: KEY_DISTANCE * 2 }),
  stageRadius: STAGE_RADIUS,
})

/**
 * Whether the rect-area light lookup tables exist in this page's three build.
 *
 * `RectAreaLightUniformsLib.init()` installs four shared data textures into the
 * renderer's uniform library. It is global state, so it runs once per page and is
 * never undone: a second viewport in the same window would otherwise re-create
 * (and the first one to die would free) textures the other one is still using.
 */
let rectAreaLightTables = false

/**
 * @typedef {object} StudioFrame
 * @property {THREE.Vector3} center - the model's bounding-box centre.
 * @property {number} radius - half the bounding-box diagonal; the rig's unit.
 * @property {number} base - the model's lowest point, where the ground goes.
 */

/**
 * @typedef {object} StudioRig
 * @property {() => void} dispose - remove and release everything the rig added.
 */

/**
 * Apply the renderer settings the studio is graded in.
 *
 * Set once, before the first render: colour management and tone mapping are
 * baked into every compiled program, so changing them later silently recompiles
 * the whole scene.
 * @param renderer - the WebGL renderer the view created.
 */
export function configureRenderer(renderer) {
  // A device-pixel-ratio above 2 triples the fragment cost for no visible gain
  // on a preview canvas, so it is capped here.
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  // Khronos PBR Neutral, not ACES: it preserves the material's own hue and
  // leaves whites white, which is what a preview of authored colours needs.
  renderer.toneMapping = THREE.NeutralToneMapping
  renderer.toneMappingExposure = EXPOSURE
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
}

/**
 * Arm the assembled model to cast and receive the studio's shadow.
 *
 * Idempotent by construction (it writes booleans), so a view can call it on every
 * root it is handed without tracking state. `InstancedMesh` is a mesh and gets
 * the same flags; the prototype geometry is shared, so this stays O(nodes).
 * @param root - the assembled model.
 */
export function enableObjectShadows(root) {
  root.traverse((node) => {
    if (node.isMesh !== true) return
    node.castShadow = true
    node.receiveShadow = true
  })
}

/**
 * Build the stage's radial fade: a small greyscale canvas, white in the middle
 * and black at the rim.
 *
 * A canvas gradient rather than a shader: one 128² texture, uploaded once, keeps
 * the floor a plain `MeshStandardMaterial` that receives shadows instead of
 * another injected shader.
 * @returns the alpha map; the caller owns and disposes it.
 */
function createStageAlpha() {
  const size = 128
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const context = canvas.getContext('2d')
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2)
  // `alphaMap` samples the green channel: white is opaque, black is gone.
  gradient.addColorStop(0, 'rgb(255,255,255)')
  gradient.addColorStop(0.6, 'rgb(214,214,214)')
  gradient.addColorStop(1, 'rgb(0,0,0)')
  context.fillStyle = gradient
  context.fillRect(0, 0, size, size)
  // Not a colour map, so it must not be sRGB-decoded.
  return new THREE.CanvasTexture(canvas)
}

/**
 * Stage a scene: image-based fill, four soft panels, a shadow-casting key, and the
 * stage floor the model stands on.
 * @param scene - the scene the view renders.
 * @param renderer - the renderer the environment is pre-filtered on.
 * @param frame - the measured model frame the rig is scaled to.
 * @returns the rig, with the teardown that releases it.
 */
export function createStudio(scene, renderer, frame) {
  const { center, radius, base } = frame

  // ── image-based fill ──────────────────────────────────────────────────────
  // One pre-filtered environment for the whole view: `scene.environment` is
  // sampled by every PBR material, so this is one texture + one small cube pass
  // instead of a per-material light probe.
  if (rectAreaLightTables !== true) {
    RectAreaLightUniformsLib.init()
    rectAreaLightTables = true
  }
  const room = new RoomEnvironment()
  const generator = new THREE.PMREMGenerator(renderer)
  const environment = generator.fromScene(room, ENVIRONMENT_BLUR)
  // The generator's internal render targets and shaders are per-instance work
  // space; only the result is kept, so the generator goes away immediately.
  generator.dispose()
  room.dispose()
  scene.environment = environment.texture
  scene.environmentIntensity = ENVIRONMENT_INTENSITY

  // ── key light: the one shadow caster ─────────────────────────────────────
  // RectAreaLights cannot cast shadows in three, so the shadow the eye reads as
  // "contact" comes from a matched directional light. Its box is fitted to the
  // model's radius rather than to the world, so a small part and a large
  // building get the same shadow-map resolution per model.
  const key = new THREE.DirectionalLight(0xffffff, KEY_INTENSITY)
  key.name = KEY_NAME
  key.position.copy(center).addScaledVector(KEY_DIRECTION, radius * KEY_DISTANCE)
  key.target.position.copy(center)
  key.castShadow = true
  const extent = radius * SHADOW_EXTENT
  key.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE)
  key.shadow.bias = SHADOW_BIAS
  key.shadow.camera.left = -extent
  key.shadow.camera.right = extent
  key.shadow.camera.top = extent
  key.shadow.camera.bottom = -extent
  // The light sits KEY_DISTANCE radii away; the frustum brackets the model and
  // the part of the ground its shadow can reach.
  key.shadow.camera.near = radius * 0.5
  key.shadow.camera.far = radius * (KEY_DISTANCE * 2)
  key.shadow.camera.updateProjectionMatrix()
  scene.add(key, key.target)

  // ── soft panels ───────────────────────────────────────────────────────────
  const panels = AREA_LIGHTS.map(({ name, intensity, width, height, offset }) => {
    const light = new THREE.RectAreaLight(0xffffff, intensity, radius * width, radius * height)
    light.name = PANEL_NAME_PREFIX + name
    light.position.set(center.x + offset[0] * radius, center.y + offset[1] * radius, center.z + offset[2] * radius)
    // A RectAreaLight emits along its local -Z, which is what `lookAt` aims at
    // the target for a light.
    light.lookAt(center)
    return light
  })
  scene.add(...panels)

  // ── stage floor ───────────────────────────────────────────────────────────
  // A shadow-only plane needs a lit backdrop behind it to darken. This canvas is
  // transparent over the shell's near-black surface, so a shadow-only plane has
  // nothing to darken and the contact shadow would be invisible. The studio
  // therefore brings its own stage: a matte disc that fades out at the rim, so
  // the shadow lands on a visible surface while the shell's surface still reads
  // at the frame edges. It lives on the scene, never under the model, because
  // the host measures the model's extent and mesh count by traversing the root.
  const stageTexture = createStageAlpha()
  const groundGeometry = new THREE.CircleGeometry(radius * STAGE_RADIUS, 96)
  const groundMaterial = new THREE.MeshStandardMaterial({
    color: STAGE_COLOR,
    roughness: 1,
    metalness: 0,
    transparent: true,
    alphaMap: stageTexture,
    // A transparent floor must not occlude the grid lines lying on it.
    depthWrite: false,
  })
  const ground = new THREE.Mesh(groundGeometry, groundMaterial)
  ground.name = GROUND_NAME
  ground.rotation.x = -Math.PI / 2
  ground.position.set(center.x, base - radius * GROUND_GAP, center.z)
  ground.receiveShadow = true
  scene.add(ground)

  return {
    dispose() {
      scene.remove(key, key.target, ...panels, ground)
      // The shared LTC tables are global state (see `rectAreaLightTables`) and are
      // deliberately left alone; a light holds no other GPU resource.
      key.shadow.dispose()
      groundGeometry.dispose()
      groundMaterial.dispose()
      stageTexture.dispose()
      scene.environment = null
      environment.dispose()
    },
  }
}
