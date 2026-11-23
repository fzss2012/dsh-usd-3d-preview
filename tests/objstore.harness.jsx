/**
 * Browser harness for the object-storage page.
 *
 * Mounts the real `UsdObjectStoreBody` against a stubbed host half: a mock bucket
 * with one plain file and one versioned asset (two revisions), the health and
 * saved-connection routes, and the listing/search routes the page calls. The
 * fixture is served from this module, so no object storage, no credentials and
 * no host server are involved — everything between "the tab mounts" and "a row
 * is clicked" is production code.
 *
 * ```js
 * __harness.calls      // every request the page made, in order
 * __harness.remount()  // unmount and mount again: what a tab switch does
 * ```
 */
import { createRoot } from 'react-dom/client'
import { UsdObjectStoreBody } from '../src/client/ObjStoreBody.jsx'

/** The revision the fixture prefers: the newest of the two. */
const NEWER = '9ca318d6465fbcedf001152cc312a340cef497a5291f29d8951998aa3f13827d'

/** The revision the page must not show while it shows the newest one. */
const OLDER = '0af13c2a7b9e4d6c8f5a1b3d2e4c6a8b0d2f4e6a8c0b2d4f6a8c0e2b4d6f8a0c'

const USD = /\.(usd|usda|usdc|usdz)$/i

/** Objects in the mock bucket. */
const OBJECTS = [
  { key: 'L0/CH/readme.txt', size: 40, lastModified: '2026-11-02T08:00:00.000Z' },
  { key: `L0/CH/revisions/${OLDER}/gate.usda`, size: 900, lastModified: '2026-11-01T10:00:00.000Z' },
  { key: `L0/CH/revisions/${NEWER}/gate.usda`, size: 1200, lastModified: '2026-11-02T10:00:00.000Z' },
  { key: `L0/CH/revisions/${NEWER}/tex/base.png`, size: 8000, lastModified: '2026-11-02T10:05:00.000Z' },
]

/** The saved connection the page starts from (never the secret). */
const STORED = {
  endpoint: 'https://s3.example.com',
  bucket: 'asset',
  region: 'us-east-1',
  rootPrefix: 'L0/',
  accessKey: 'AKIAEXAMPLE',
  hasSecret: true,
}

/** Immediate children of one prefix, folders first. */
function listingOf(prefix) {
  const folders = [...new Set(OBJECTS
    .filter(object => object.key.startsWith(prefix))
    .map((object) => {
      const rest = object.key.slice(prefix.length)
      const slash = rest.indexOf('/')
      return slash < 0 ? undefined : prefix + rest.slice(0, slash + 1)
    })
    .filter(key => key !== undefined))]
    .map(key => ({ key, name: key.slice(prefix.length, -1), type: 'folder', size: 0, lastModified: '' }))
  const files = OBJECTS
    .filter(object => object.key.startsWith(prefix) && !object.key.slice(prefix.length).includes('/'))
    .map(object => ({
      key: object.key,
      name: object.key.slice(prefix.length),
      type: 'file',
      size: object.size,
      lastModified: object.lastModified,
    }))
  return { bucket: 'asset', prefix, rootPrefix: 'L0/', allowedPrefixes: ['L0/'], entries: [...folders, ...files], truncated: false, continuationToken: null }
}

/** Recursive search below one prefix, the way the route answers it. */
function searchOf(prefix, query, usdOnly) {
  const needle = String(query ?? '').toLowerCase()
  const entries = OBJECTS
    .filter(object => object.key.startsWith(prefix))
    .filter(object => !usdOnly || USD.test(object.key))
    .filter(object => needle === '' || object.key.toLowerCase().includes(needle))
    .map(object => ({
      key: object.key,
      name: object.key.slice(object.key.lastIndexOf('/') + 1),
      type: 'file',
      size: object.size,
      lastModified: object.lastModified,
    }))
  return { entries, scanned: OBJECTS.length, truncated: false }
}

/**
 * Confine one page prefix to the root, the way the host's `resolvePrefix` does:
 * an empty prefix means the configured root, and everything else is a child.
 * @param value - the prefix the page asked for.
 * @returns the key prefix to list.
 */
function confined(value) {
  const segments = String(value ?? '').split('/').filter(part => part !== '' && part !== '.')
  return segments.length === 0 ? 'L0/' : segments.join('/') + '/'
}

/** One JSON response. */
function json(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/** The host half's answers, in one mock. */
const state = { config: STORED }
const calls = []
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : String(input?.url ?? input)
  calls.push({ url, method: init.method ?? 'GET', body: init.body })
  const parsed = new URL(url, 'https://page.test')
  if (parsed.pathname === '/api/usd-preview/health') {
    return json({
      ok: true,
      library: state.config === null
        ? null
        : { endpoint: state.config.endpoint, bucket: state.config.bucket, rootPrefix: state.config.rootPrefix, source: 'config-file' },
    })
  }
  if (parsed.pathname === '/api/usd-preview/objstore/config') {
    if ((init.method ?? 'GET') === 'POST') {
      const body = JSON.parse(String(init.body ?? '{}'))
      if (body.action === 'clear') {
        state.config = null
        return json({ ok: true, source: null, config: null })
      }
      state.config = { ...STORED, endpoint: body.endpoint, bucket: body.bucket, region: body.region, rootPrefix: body.rootPrefix, accessKey: body.accessKey }
      return json({ ok: true, source: 'config-file', config: state.config })
    }
    return json({ ok: true, source: state.config === null ? null : 'config-file', config: state.config })
  }
  if (parsed.pathname === '/api/usd-preview/list') {
    return json(listingOf(confined(parsed.searchParams.get('prefix') ?? '')))
  }
  if (parsed.pathname === '/api/usd-preview/search') {
    return json(searchOf(
      confined(parsed.searchParams.get('prefix') ?? ''),
      parsed.searchParams.get('q') ?? '',
      parsed.searchParams.get('usd') !== '0',
    ))
  }
  return new Response('', { status: 404 })
}

const host = document.getElementById('host')
let root

/** Mount the page body, the way the sidebar pane does. */
function mount() {
  root = createRoot(host)
  root.render(
    <UsdObjectStoreBody
      t={key => key}
      openDroppedStage={() => { globalThis.__harness.previewed = true }}
    />,
  )
}

globalThis.__harness = {
  calls,
  remount() {
    root.unmount()
    mount()
  },
}

mount()
