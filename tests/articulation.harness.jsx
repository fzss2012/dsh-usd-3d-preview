/**
 * Browser harness for the articulation render test.
 *
 * It mounts the real `UsdBody` with the props the document seat supplies, so
 * everything between "a click lands on the canvas" and "the part swings" is
 * production code: the view's pick hook, the controller the component creates,
 * its tick loop, and the on-demand renderer the tick return value drives.
 *
 * It also counts WebGL draw calls. That is the cheapest honest evidence that
 * rendering is on demand: an idle articulated asset draws nothing, and the
 * frames between a click and the settled pose are pulled by `tick() === true`.
 */
import { createRoot } from 'react-dom/client'
import { UsdBody } from '../src/client/UsdBody.jsx'

globalThis.__draws = 0
const proto = globalThis.WebGL2RenderingContext?.prototype ?? globalThis.WebGLRenderingContext?.prototype
if (proto !== undefined) {
  for (const name of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced']) {
    const original = proto[name]
    if (typeof original !== 'function') continue
    proto[name] = function counted(...args) {
      globalThis.__draws += 1
      return original.apply(this, args)
    }
  }
}

const params = new URLSearchParams(location.search)
const path = params.get('path') ?? 'joints/door.usda'
const response = await fetch('/fixture/' + path)
if (!response.ok) throw new Error('fixture ' + path + ': HTTP ' + response.status)
const data = new Uint8Array(await response.arrayBuffer())

globalThis.__harness = { path, bytes: data.byteLength }

createRoot(document.getElementById('host')).render(
  <UsdBody
    content={{ kind: 'bytes', data }}
    resourceAddress={'dsh-resource://file/session/session-articulation/' + path}
    // A referenced layer is resolved through the same contract the app uses;
    // here the fixture server answers it.
    readLayer={async (_sessionId, layerPath, signal) => {
      const layer = await fetch('/fixture/' + layerPath, { signal })
      return layer.ok ? new Uint8Array(await layer.arrayBuffer()) : undefined
    }}
  />,
)
