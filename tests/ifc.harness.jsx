/**
 * Browser harness for the IFC preview.
 *
 * Mounts the real `IfcBody` with the props the document seat supplies — the
 * complete bytes and the resource address — against a test server that serves the
 * fixtures. Everything between "bytes arrive" and "pixels are drawn" is therefore
 * production code.
 */
import { createRoot } from 'react-dom/client'
import { IfcBody } from '../src/client/IfcBody.jsx'

const params = new URLSearchParams(location.search)
const path = params.get('path') ?? 'ifc/hello-wall.ifc'
const response = await fetch(`/fixture/${path}`)
if (!response.ok) throw new Error(`fixture ${path}: HTTP ${response.status}`)
const data = new Uint8Array(await response.arrayBuffer())
const address = `dsh-resource://file/session/session-harness/${path}`

globalThis.__harness = { path, bytes: data.byteLength }

createRoot(document.getElementById('host')).render(
  <IfcBody content={{ kind: 'bytes', data }} resourceAddress={address} />,
)
