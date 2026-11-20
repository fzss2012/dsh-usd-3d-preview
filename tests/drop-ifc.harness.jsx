/**
 * Browser harness for the external-asset drop path.
 *
 * Mounts the real `UsdDropBody` with a pending drop built from files the test
 * server serves — exactly what the sidebar listener offers after a drag. The
 * component that has always rendered a dropped USD stage decides the reader for
 * an IFC model, reads the file's bytes and mounts `IfcBody`, so everything
 * between "the drop arrived" and "pixels are drawn" is production code.
 */
import { createRoot } from 'react-dom/client'
import { UsdDropBody } from '../src/client/DropBody.jsx'
import { modelCandidates, offerDropped } from '../src/client/dropped.js'

const params = new URLSearchParams(location.search)
const paths = (params.get('paths') ?? 'ifc/hello-wall.ifc')
  .split(',')
  .filter(path => path !== '')
const files = new Map()
for (const path of paths) {
  const response = await fetch(`/fixture/${path}`)
  if (!response.ok) throw new Error(`fixture ${path}: HTTP ${response.status}`)
  const name = path.slice(path.lastIndexOf('/') + 1)
  files.set(name, new File([await response.arrayBuffer()], name))
}

// `drop=empty` is the drop the picker refused: files arrived, no model among them.
offerDropped({
  files,
  models: params.get('drop') === 'empty' ? [] : modelCandidates(files),
})
globalThis.__harness = { paths, files: files.size }

createRoot(document.getElementById('host')).render(<UsdDropBody />)
