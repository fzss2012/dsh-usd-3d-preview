/**
 * Browser harness for the render test.
 *
 * It mounts the real `UsdBody` with the props the document seat supplies — the
 * complete bytes, the resource address, and the injected layer reader — against
 * a test server that serves the fixtures. Everything between "bytes arrive" and
 * "pixels are drawn" is therefore production code; only the shell around it (the
 * slot system, and React scheduling by the conversation view) is replaced.
 *
 * `t` is deliberately absent: the seat supplies it only when the dictionary is
 * registered, and the body must fall back to its literal English copy without it.
 *
 * The asset reader is the host route's browser-side half. The test server wires
 * the real host handler, so an `s3://` reference would be signed and read from
 * the configured asset library exactly as the app would do it; when no library is
 * configured the route answers 503 and the engine reports the layer as missing,
 * which is the same fallback the app shows.
 */
import { createRoot } from 'react-dom/client'
import { UsdBody } from '../src/client/UsdBody.jsx'

const params = new URLSearchParams(location.search)
const path = params.get('path') ?? 'sample.usdz'
// `?root=` fakes the way the app addresses a file: a session-scoped address whose
// path is the absolute file path, so the engine's root key carries a directory.
const rootPath = params.get('root') ?? path
// `?engine=three` exercises the fallback path without touching the source.
if (params.get('engine') === 'three') globalThis.__DSH_USD_ENGINE__ = 'three'
const response = await fetch(`/fixture/${path}`)
if (!response.ok) throw new Error(`fixture ${path}: HTTP ${response.status}`)
const data = new Uint8Array(await response.arrayBuffer())

globalThis.__harness = { path, rootPath, bytes: data.byteLength }

createRoot(document.getElementById('host')).render(
  <UsdBody
    content={{ kind: 'bytes', data }}
    resourceAddress={`dsh-resource://file/session/session-harness/${rootPath}`}
    // The app's reader goes through the workspace Remote; here the same
    // contract is answered by the fixture server, keyed the same way.
    readLayer={async (_sessionId, layerPath, signal) => {
      const layer = await fetch(`/fixture/${layerPath}`, { signal })
      if (!layer.ok) return undefined
      return new Uint8Array(await layer.arrayBuffer())
    }}
    // The asset reader is the host route's browser-side half; the test server
    // wires the real host handler, so an `s3://` reference is signed and read
    // from the same asset library the app would use.
    readAsset={async (uri, signal) => {
      const response = await fetch(`/usd-preview/asset?uri=${encodeURIComponent(uri)}`, {
        headers: { 'x-dsh-usd-preview': 'asset' },
        signal,
      })
      if (!response.ok) return undefined
      return new Uint8Array(await response.arrayBuffer())
    }}
  />,
)
