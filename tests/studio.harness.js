/**
 * Browser harness for the studio suite.
 *
 * It mounts `createView` directly on a synthetic model — no USD parsing, no React,
 * no engine — so the only thing under test is the viewport's own pipeline:
 * renderer settings, environment, lights, contact ground, framing, and the
 * on-demand frame loop. Everything the suite asserts is read back from the live
 * three objects through `window.__studio`, and the pixels are screenshotted from
 * the same canvas the app draws into.
 *
 * The page also keeps the previous placeholder rig (hemisphere + three
 * directionals + grid, no tone mapping, no shadows, no environment) as a frozen
 * baseline. It exists only so the before/after screenshots compare the same
 * model under both rigs; the app never builds it.
 */
import * as THREE from 'three'
import { STUDIO } from '../src/client/studio.js'
import { createView } from '../src/client/view.js'

const host = document.getElementById('host')

/** The model currently on the stage. */
let model = null
/** The mounted view, whichever rig produced it. */
let mounted = null
/** How long the last createView() call took, including environment and compile. */
let mountMs = 0

/**
 * The synthetic model: three boxes and a sphere, all resting on y = 0 so the
 * studio's contact ground has a real base to sit at. The materials mix roughness,
 * metalness and hue on purpose — a flat white box would hide tone mapping and
 * image-based fill differences in the pixel checks.
 * @returns the assembled model group.
 */
function buildModel() {
  const rough = new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.5, metalness: 0 })
  const gloss = new THREE.MeshStandardMaterial({ color: 0x2f6fd0, roughness: 0.25, metalness: 0.65 })
  const matte = new THREE.MeshStandardMaterial({ color: 0xd06a2f, roughness: 0.75, metalness: 0 })
  const group = new THREE.Group()
  /** A box whose base sits on y = 0. */
  const box = (width, height, depth, x, z, material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material)
    mesh.position.set(x, height / 2, z)
    group.add(mesh)
  }
  box(1.2, 1, 1.2, -1.1, 0.2, rough)
  box(0.8, 1.8, 0.8, 0.9, -0.9, gloss)
  box(1.6, 0.35, 0.9, 0.4, 1.1, matte)
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(0.55, 48, 32), gloss)
  sphere.position.set(-0.2, 0.55, -1.4)
  group.add(sphere)
  return group
}

/**
 * Release a model the harness built. The view never disposes the caller's root,
 * so the page owns this — the same split the app relies on.
 * @param root - the model to release.
 */
function disposeModel(root) {
  const released = new Set()
  root.traverse((node) => {
    if (node.isMesh !== true) return
    if (released.has(node.geometry) === false) {
      released.add(node.geometry)
      node.geometry.dispose()
    }
    const materials = Array.isArray(node.material) ? node.material : [node.material]
    for (const material of materials) {
      if (material === undefined || material === null || released.has(material)) continue
      released.add(material)
      material.dispose()
    }
  })
}

/** The key light that owns the shadow map, whichever rig is mounted. */
function shadowKey() {
  let key = null
  mounted.view.scene.traverse((node) => {
    if (key === null && node.isDirectionalLight === true) key = node
  })
  return key
}

/** Measure the staged model the same way the view does, for the suite to compare. */
function modelFrame() {
  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  return {
    min: box.min.toArray(),
    max: box.max.toArray(),
    size: size.toArray(),
    center: box.getCenter(new THREE.Vector3()).toArray(),
    base: box.min.y,
    radius: Math.max(size.length() * 0.5, 1e-4),
  }
}

/**
 * The previous placeholder rig, frozen for the before/after evidence: hemisphere
 * plus three directionals plus grid, no tone mapping, no shadows, no environment.
 * It draws one frame — nothing in it animates, so the comparison only needs the
 * still the old loop would have produced.
 * @returns the legacy view handle.
 */
function mountLegacy() {
  const width = Math.max(host.clientWidth, 1)
  const height = Math.max(host.clientHeight, 1)
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio || 1, 2))
  renderer.setSize(width, height, false)
  const canvas = renderer.domElement
  canvas.style.display = 'block'
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.dataset.usdPreviewCanvas = ''
  host.appendChild(canvas)

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(45, width / height, 0.01, 1e6)
  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x2b2f38, 1.5))
  const key = new THREE.DirectionalLight(0xffffff, 2.4)
  key.position.set(4, 7, 6)
  scene.add(key)
  const fill = new THREE.DirectionalLight(0xffffff, 1)
  fill.position.set(-6, -3, -5)
  scene.add(fill)
  const rim = new THREE.DirectionalLight(0xffffff, 0.8)
  rim.position.set(-2, 4, -7)
  scene.add(rim)

  const box = new THREE.Box3().setFromObject(model)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const radius = Math.max(size.length() * 0.5, 1e-4)
  const grid = new THREE.GridHelper(radius * 4, 24, 0x7c8698, 0x4a5162)
  grid.position.set(center.x, box.min.y, center.z)
  grid.material.transparent = true
  grid.material.opacity = 0.35
  scene.add(grid)
  scene.add(model)

  const distance = radius / Math.sin((camera.fov * Math.PI) / 360)
  camera.position.copy(center).addScaledVector(new THREE.Vector3(1, 0.62, 1).normalize(), distance * 1.2)
  camera.near = Math.max(distance / 5000, 1e-4)
  camera.far = distance * 200
  camera.updateProjectionMatrix()
  camera.lookAt(center)
  renderer.render(scene, camera)
  return {
    renderer,
    scene,
    destroy() {
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
    },
  }
}

globalThis.__studio = {
  /** three itself, so the suite names constants instead of hard-coding enum values. */
  THREE,

  /**
   * Mount the studio view on a fresh synthetic model.
   * @param options - passed straight to createView; `frame` exercises the
   *   articulated-stage path where the camera frames more than the rest pose.
   */
  mount(options = {}) {
    model = buildModel()
    const started = performance.now()
    const view = createView(host, model, options)
    mountMs = performance.now() - started
    mounted = { kind: 'studio', view, model }
  },

  /** Mount the frozen placeholder rig on a fresh synthetic model. */
  mountLegacy() {
    model = buildModel()
    mounted = { kind: 'legacy', view: mountLegacy(), model }
  },

  /** Tear the current view down, and the model with it. */
  unmount() {
    if (mounted === null) return
    mounted.view.destroy()
    disposeModel(mounted.model)
    mounted = null
    model = null
  },

  /** Everything the suite asserts about the mounted pipeline. */
  report() {
    const renderer = mounted.view.renderer
    const scene = mounted.view.scene
    const areaLights = []
    const directionals = []
    let ground = null
    scene.traverse((node) => {
      if (node.isRectAreaLight === true) {
        areaLights.push({ name: node.name, intensity: node.intensity, width: node.width, height: node.height })
      }
      if (node.isDirectionalLight === true) {
        directionals.push({
          name: node.name,
          intensity: node.intensity,
          castShadow: node.castShadow,
          mapSize: [node.shadow.mapSize.x, node.shadow.mapSize.y],
          bias: node.shadow.bias,
          frustum: {
            left: node.shadow.camera.left,
            right: node.shadow.camera.right,
            top: node.shadow.camera.top,
            bottom: node.shadow.camera.bottom,
            near: node.shadow.camera.near,
            far: node.shadow.camera.far,
          },
        })
      }
      // The stage floor is "the mesh under the model called studio-ground". It is
      // looked up by name and not by material type so the suite keeps working if
      // the floor's material changes: what it must be is a surface the shadow
      // lands on, not a particular material.
      if (node.isMesh === true && node.name === 'studio-ground') {
        ground = {
          parentIsScene: node.parent === scene,
          material: node.material.type,
          transparent: node.material.transparent === true,
          hasAlphaMap: node.material.alphaMap !== undefined && node.material.alphaMap !== null,
          roughness: node.material.roughness,
          receiveShadow: node.receiveShadow,
          castShadow: node.castShadow,
          y: node.position.y,
          rotationX: node.rotation.x,
          radius: node.geometry.parameters.radius,
        }
      }
    })

    let meshes = 0
    let casting = 0
    let receiving = 0
    let instances = 0
    model.traverse((node) => {
      if (node.isMesh !== true) return
      meshes += 1
      if (node.castShadow === true) casting += 1
      if (node.receiveShadow === true) receiving += 1
      if (node.isInstancedMesh === true) instances += node.count
    })

    const canvas = renderer.domElement
    return {
      kind: mounted.kind,
      // The rig's declared calibration: the suite asserts the live renderer and
      // scene against this, so a deliberate retune cannot turn the suite red.
      policy: STUDIO,
      renderer: {
        toneMapping: renderer.toneMapping,
        neutralToneMapping: THREE.NeutralToneMapping,
        exposure: renderer.toneMappingExposure,
        outputColorSpace: renderer.outputColorSpace,
        srgbColorSpace: THREE.SRGBColorSpace,
        shadowMapEnabled: renderer.shadowMap.enabled,
        // With on-demand drawing, a stale shadow map would be visible under a
        // moving part; this is the flag that decides whether every drawn frame
        // re-renders it.
        shadowMapAutoUpdate: renderer.shadowMap.autoUpdate,
        shadowMapType: renderer.shadowMap.type,
        pcfShadowMap: THREE.PCFShadowMap,
        pixelRatio: renderer.getPixelRatio(),
        devicePixelRatio: globalThis.devicePixelRatio || 1,
        frames: renderer.info.render.frame,
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
      },
      environment: {
        assigned: scene.environment !== null && scene.environment !== undefined,
        isTexture: scene.environment !== null && scene.environment !== undefined && scene.environment.isTexture === true,
        intensity: scene.environmentIntensity,
      },
      areaLights,
      directionals,
      ground,
      model: {
        ...modelFrame(),
        meshes,
        casting,
        receiving,
        instances,
      },
      canvas: {
        markers: document.querySelectorAll('[data-usd-preview-canvas]').length,
        size: [canvas.width, canvas.height],
        clientSize: [canvas.clientWidth, canvas.clientHeight],
      },
    }
  },

  /** Turn the studio's shadow rendering on or off, for the contact-shadow diff. */
  setShadowCasting(on) {
    const key = shadowKey()
    if (key !== null) key.castShadow = on === true
    mounted.view.requestRender()
  },

  /** Hide or show the reference grid (the framing probe measures the model alone). */
  setGridVisible(on) {
    mounted.view.setGridVisible(on === true)
  },

  /**
   * Show only the white reference box.
   *
   * The tone calibration is about a *default-albedo* surface — what the shipped
   * USD fixtures are made of — so it is measured on one, not on the blue and
   * orange meshes that exist for the colour and shadow checks.
   */
  setToneReference(on) {
    mounted.model.children.forEach((child, index) => {
      child.visible = on !== true || index === 0
    })
    mounted.view.requestRender()
  },

  /**
   * Hide or show the studio's stage floor. It is the one scene object the view
   * publishes by name, so a probe that needs the model *alone* can take it out.
   */
  setFloorVisible(on) {
    const floor = mounted.view.scene.getObjectByName('studio-ground')
    if (floor !== undefined) floor.visible = on === true
    mounted.view.requestRender()
  },

  /** Ask for one frame the way the app's toolbar does. */
  requestRender() {
    mounted.view.requestRender()
  },

  /** Cumulative drawn-frame counter, for the on-demand cadence checks. */
  frames() {
    return mounted.view.renderer.info.render.frame
  },

  /**
   * What the last drawn frame cost: draw calls and triangles, shadow pass
   * included. Comparing it with the shadow switched off measures the pass.
   */
  frameInfo() {
    const info = mounted.view.renderer.info
    return { calls: info.render.calls, triangles: info.render.triangles, frame: info.render.frame }
  },

  /** Milliseconds the last createView() took: environment pre-filter plus compile. */
  mountTime() {
    return mountMs
  },

  /** Turn auto-rotate on or off, for the auto-rotate cadence check. */
  setSpin(on) {
    mounted.view.setSpin(on === true)
  },

  /**
   * Drive a part the way the articulation controller drives a joint: an `onFrame`
   * observer that moves geometry and returns `true` while it still has work.
   *
   * The view only redraws while an observer pulls, so the shadow under the moving
   * part is correct only if pulled frames really re-render — which is exactly what
   * the suite screenshots before and after.
   * @param frames - how many frames the observer reports work for.
   * @param lift - how far the part moves per frame, in world units.
   */
  animate(frames, lift) {
    const part = mounted.model.children[1]
    let left = frames
    this.__stopAnimating = mounted.view.onFrame(() => {
      if (left <= 0) return false
      part.position.y += lift
      left -= 1
      return true
    })
  },

  /** Stop the animation observer, letting the loop settle. */
  stopAnimating() {
    this.__stopAnimating?.()
    this.__stopAnimating = undefined
  },

  /**
   * Register an `onFrame` observer that throws, to prove a bad observer cannot
   * wedge the on-demand loop into re-throwing on every rAF.
   */
  throwOnNextFrame() {
    this.__throwStop = mounted.view.onFrame(() => { throw new Error('observer boom') })
  },

  /** Remove the throwing observer, if one is registered. */
  stopThrowing() {
    this.__throwStop?.()
    this.__throwStop = undefined
  },

  /** Return the camera to its framing pose, the way the toolbar's reset does. */
  reset() {
    mounted.view.reset()
  },

  /**
   * Wait until the on-demand loop has settled.
   *
   * The damping tail is the point: after a drag or after auto-rotate stops, the
   * camera keeps moving for a few frames, and that is exactly the interval the
   * view promises to keep drawing.
   * @param timeoutMs - give up after this long.
   * @returns the frame count once two consecutive polls saw no new frame.
   */
  async settle(timeoutMs = 4000) {
    const deadline = performance.now() + timeoutMs
    let last = mounted.view.renderer.info.render.frame
    while (performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 120))
      const now = mounted.view.renderer.info.render.frame
      if (now === last) return now
      last = now
    }
    return last
  },

  /** Resize the stage element, the way the sidebar's layout does. */
  resize(width, height) {
    host.style.width = `${width}px`
    host.style.height = `${height}px`
  },

  /** Wait for the browser to publish n more animation frames. */
  waitFrames(count) {
    return new Promise((resolve) => {
      let left = count
      const step = () => {
        left -= 1
        if (left <= 0) resolve()
        else requestAnimationFrame(step)
      }
      requestAnimationFrame(step)
    })
  },
}
