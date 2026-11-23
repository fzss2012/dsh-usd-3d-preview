/**
 * Browser harness for the session archive render test.
 *
 * It mounts the real `SessionBody` with the props the sidebar tab supplies for a
 * `session.json` opened from the Files tab: the file's address plus the injected
 * workspace readers. The test server answers those readers over HTTP, keyed the
 * same way the workspace Remote would be — `/fixture/<workspace path>` for bytes
 * and `/list?path=<folder>` for a directory listing.
 *
 * `t` is deliberately absent: the tab supplies it only when the dictionary is
 * registered, and the body must fall back to its literal English copy without it.
 *
 * `?drop=1` mounts the same body for a dropped folder instead: the test walks the
 * fixture archive through the server's listing endpoint and builds the file table
 * `collectDropped` would hand the page tab (keys are folder-relative paths), so
 * the snapshot and records are read without a Session.
 */
import { createRoot } from 'react-dom/client'
import { SessionBody } from '../src/client/SessionBody.jsx'

const params = new URLSearchParams(location.search)
const archive = params.get('archive') ?? 'session'
// A session-scoped address whose path is the archive's own manifest: the same
// shape the Files tab hands the tab type the preview claims.
const path = `${archive}/session.json`
const address = `dsh-resource://file/session/session-harness/${path}`

/**
 * Build the dropped-folder file table for one archive.
 * @param directory - the archive's root key.
 * @returns files keyed by folder-relative path, as `collectDropped` produces.
 */
async function droppedArchive(directory) {
  const files = new Map()
  const walk = async (folder) => {
    const response = await fetch(`/list?path=${encodeURIComponent(folder)}`)
    if (!response.ok) return
    const listing = await response.json()
    for (const entry of listing.entries) {
      const key = `${folder}/${entry.name}`
      if (entry.type === 'directory') {
        await walk(key)
        continue
      }
      const file = await fetch(`/fixture/${key}`)
      if (file.ok) files.set(key, new Blob([await file.arrayBuffer()]))
    }
  }
  await walk(directory)
  return files
}

if (params.get('drop') === '1') {
  const files = await droppedArchive(archive)
  globalThis.__harness = { archive, drop: true, keys: [...files.keys()].sort() }
  createRoot(document.getElementById('host')).render(
    <SessionBody droppedFiles={files} droppedRootKey={path} />,
  )
} else {
  globalThis.__harness = { archive, path, address }
  createRoot(document.getElementById('host')).render(
    <SessionBody
      resourceAddress={address}
      readLayer={async (_sessionId, layerPath, signal) => {
        const response = await fetch(`/fixture/${layerPath}`, { signal })
        if (!response.ok) return undefined
        return new Uint8Array(await response.arrayBuffer())
      }}
      listDirectory={async (_sessionId, directory, signal) => {
        const response = await fetch(`/list?path=${encodeURIComponent(directory)}`, { signal })
        if (!response.ok) return { error: 'workspace-file/not-found' }
        return await response.json()
      }}
    />,
  )
}
