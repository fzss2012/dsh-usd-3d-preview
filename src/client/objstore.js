/**
 * Client-side helpers for the object-storage sidebar tab.
 *
 * Two backends answer the same shape, and the host half is preferred because it
 * needs no extra deployment:
 *
 *   1. the host half's own signed routes (`/api/usd-preview/list|search`), which
 *      list with the `DSH_USD_S3_*` credentials and never send one to the page;
 *   2. a deployment-provided gateway (`/usd-asset-api/list|search`), for a
 *      deployment that terminates the routes elsewhere.
 *
 * The gateway routes are read from the page's own origin by default, because
 * that is the only origin a deployment can be sure a browser may call. A
 * deployment that terminates them elsewhere names that origin once:
 *
 *   globalThis.__DSH_OBJSTORE_ASSET_ORIGIN__ = 'https://asset.example.com'
 *
 * The value is an origin only (no path, no trailing slash) and is read when this
 * module loads, so it must be set before the bundle runs.
 */
import { normalizePath } from './remote.js'
import {
  directObjectUrl,
  fetchDirectBytes,
  hasDirect,
  listDirect,
  searchDirect,
} from './directS3.js'

/** Absolute origin for the object-storage routes, or '' for the page's own. */
const ASSET_ORIGIN = (() => {
  const override = globalThis.__DSH_OBJSTORE_ASSET_ORIGIN__
  if (typeof override !== 'string') return ''
  return override.trim().replace(/\/+$/, '')
})()

/** Host route that lists with the configured credentials (preferred). */
const HOST_LIST = '/api/usd-preview/list'

/** Host route that searches with the configured credentials (preferred). */
const HOST_SEARCH = '/api/usd-preview/search'

/** Host route that reports whether an asset library is configured at all. */
const HOST_HEALTH = '/api/usd-preview/health'

/** Page path mapped to the gateway's directory listing. */
const API_LIST = '/usd-asset-api/list'

/** Page path mapped to the gateway's recursive search. */
const API_SEARCH = '/usd-asset-api/search'

/** Page path mapped to the gateway's object bytes. */
const ASSET_PREFIX = '/usd-asset/'

/** USD suffixes this sidebar can hand to the preview. */
const USD_SUFFIXES = new Set(['usd', 'usda', 'usdc', 'usdz'])

/** Resolved API origin; probed once per page. */
let basePromise

/**
 * Short-lived request caches.
 *
 * The sidebar tab can mount twice (React strict effect passes) and the search
 * box fires on every keystroke; sharing one promise per request keeps the
 * gateway from being asked the same question twice and keeps the list stable
 * while a prefix is revisited. A cached request is deliberately created without
 * any caller's abort signal: aborting one caller (an unmount, a fast keystroke)
 * must not reject the promise another caller is waiting on.
 */
const CACHE_TTL_MS = 10000
const CACHE_MAX_ENTRIES = 96
const listCache = new Map()
const searchCache = new Map()

/**
 * Reject with the caller's abort without cancelling the shared request.
 * @param promise - the shared (uncancellable) request.
 * @param signal - the caller's abort signal, when it passed one.
 * @returns the request's value, or an AbortError for an aborted caller.
 */
function withSignal(promise, signal) {
  if (signal === undefined || signal === null) return promise
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'))
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException('Aborted', 'AbortError'))
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

/**
 * One cached request: reuse a live entry, otherwise start a fresh request.
 * @param cache - the per-request-kind cache.
 * @param key - request identity.
 * @param factory - starts the request (no signals; see the cache note above).
 * @returns the shared promise.
 */
function cached(cache, key, factory) {
  const now = Date.now()
  const hit = cache.get(key)
  if (hit !== undefined && hit.expires > now) return hit.promise
  const promise = factory()
  cache.set(key, { promise, expires: now + CACHE_TTL_MS })
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key)
  })
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next()
    if (oldest.done === true) break
    cache.delete(oldest.value)
  }
  return promise
}

/** Encode one object key for a URL path, segment by segment. */
export function encodeKey(key) {
  return String(key).split('/').map(segment => encodeURIComponent(segment)).join('/')
}

/**
 * Whether one object key is a USD stage.
 * @param key - object key.
 * @returns true for .usd/.usda/.usdc/.usdz.
 */
export function isUsdKey(key) {
  const text = String(key)
  const dot = text.lastIndexOf('.')
  return dot >= 0 && USD_SUFFIXES.has(text.slice(dot + 1).toLowerCase())
}

/**
 * Whether the host half has an asset library configured.
 *
 * Probed once per page: a `library: null` answer means the signed routes will
 * only ever 503, so the page falls back to the deployment gateway instead of
 * asking a route that cannot answer. The probe is deliberately *not* cached on
 * failure -- a host configured later in the same page lifetime is picked up by
 * the next request rather than requiring a reload.
 * @returns true when the signed host routes can be used.
 */
export function hostLibrary() {
  if (basePromise === undefined) {
    basePromise = fetch(HOST_HEALTH)
      .then(async (response) => {
        if (!response.ok) return undefined
        const body = await response.json().catch(() => undefined)
        return body !== null && body !== undefined && body.library !== null && body.library !== undefined
          ? body.library
          : undefined
      })
      .catch(() => {
        // A failed probe must not poison the page for its whole lifetime.
        basePromise = undefined
        return undefined
      })
  }
  return basePromise
}

/** Host route that reads and writes the connection saved from the sidebar. */
const HOST_CONFIG = '/api/usd-preview/objstore/config'

/**
 * Forget every cached answer, so the page picks up a connection it just saved.
 *
 * The library probe is memoized for the page lifetime and the listing caches for
 * ten seconds; without this reset the page would keep answering from the backend
 * it had before the save.
 * @returns undefined.
 */
export function resetObjectStoreCaches() {
  basePromise = undefined
  listCache.clear()
  searchCache.clear()
}

/**
 * Read the connection the host has stored, and which backend it is using.
 *
 * `undefined` means this composition has no host route at all (no Connection
 * service), which is the same answer as "cannot persist": the page then keeps a
 * browser-direct connection instead. `config: null` means the route answered
 * and nothing is saved.
 * @returns `{ config, source }`, or undefined when the route is absent.
 */
export async function loadObjectStoreConfig() {
  let response
  try {
    response = await fetch(HOST_CONFIG)
  } catch {
    return undefined
  }
  if (response.status === 404 || response.status === 405 || response.status === 501) return undefined
  if (!response.ok) return undefined
  const body = await response.json().catch(() => undefined)
  if (body === null || body === undefined || body.ok !== true) return undefined
  return {
    config: body.config === null || body.config === undefined ? null : body.config,
    source: typeof body.source === 'string' ? body.source : null,
  }
}

/**
 * Persist one connection through the host half.
 *
 * The host validates it, verifies it with a real listing and only then writes,
 * so a returned config is one that could list the bucket. A failure throws an
 * Error whose message is stable ('objstore-config-invalid',
 * 'objstore-config-environment', 'objstore-config-unverified',
 * 'objstore-config-unsupported'); the route's own reason is on `error.reason`.
 * @param fields - endpoint, bucket, region, rootPrefix, accessKey and secretKey.
 * @returns `{ config, source }` — the stored, non-secret connection.
 */
export async function saveObjectStoreConfig(fields) {
  return await writeConnection({ action: 'save', ...fields })
}

/**
 * Forget the saved connection; same error contract as
 * {@link saveObjectStoreConfig}.
 * @returns `{ config: null, source: null }`.
 */
export async function clearObjectStoreConfig() {
  return await writeConnection({ action: 'clear' })
}

/**
 * POST one connection action and map the answer to a stable error message.
 * @param payload - the JSON body the route expects.
 * @returns `{ config, source }` on success.
 */
async function writeConnection(payload) {
  const response = await fetch(HOST_CONFIG, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (response.status === 404 || response.status === 405 || response.status === 501) {
    throw new Error('objstore-config-unsupported')
  }
  const body = await response.json().catch(() => undefined)
  if (response.ok && body !== null && body !== undefined && body.ok === true) {
    return {
      config: body.config === null || body.config === undefined ? null : body.config,
      source: typeof body.source === 'string' ? body.source : null,
    }
  }
  const error = new Error(mapConnectionStatus(response.status))
  if (typeof body?.error === 'string') error.reason = body.error
  throw error
}

/**
 * Map a failed connection-route status to the panel's message key.
 * @param status - the HTTP status the route answered.
 * @returns the stable message key.
 */
function mapConnectionStatus(status) {
  if (status === 400) return 'objstore-config-invalid'
  if (status === 409) return 'objstore-config-environment'
  if (status === 502) return 'objstore-config-unverified'
  return 'objstore-config-http-' + status
}

/** Request one JSON document from one absolute-or-same-origin path. */
async function getJson(path, signal) {
  const response = await fetch(path, signal === undefined ? undefined : { signal })
  if (response.status === 401 || response.status === 403) throw new Error('objstore-forbidden')
  if (response.status === 404) throw new Error('objstore-not-found')
  if (response.status === 503) throw new Error('objstore-unreachable')
  if (!response.ok) throw new Error('objstore-http-' + response.status)
  return await response.json()
}

/**
 * List the immediate children of one prefix.
 *
 * The signed host route answers first; the deployment gateway is used when the
 * host has no library configured or the route is absent (a stock install with no
 * gateway answers neither, and the page reports one honest error).
 * @param prefix - directory prefix ('' for the configured root).
 * @param signal - caller abort signal (does not cancel the shared request).
 * @param continuationToken - page token from a previous truncated listing.
 * @returns { bucket, prefix, rootPrefix, entries, truncated, continuationToken }.
 */
export async function listPrefix(prefix, signal, continuationToken) {
  const text = String(prefix ?? '')
  const token = typeof continuationToken === 'string' ? continuationToken : ''
  return await withSignal(
    cached(listCache, text + '\u0000' + token, async () => {
      if (hasDirect()) return await listDirect(text, token, undefined)
      const library = await hostLibrary()
      if (library !== undefined) {
        const params = new URLSearchParams({ prefix: text })
        if (token !== '') params.set('token', token)
        return await getJson(HOST_LIST + '?' + params.toString())
      }
      return await getJson(ASSET_ORIGIN + API_LIST + '?prefix=' + encodeURIComponent(text))
    }),
    signal,
  )
}

/**
 * Recursively search files below one prefix.
 * @param prefix - search root ('' searches the whole configured root).
 * @param query - case-insensitive substring; '' returns every file.
 * @param usdOnly - restrict matches to .usd/.usda/.usdc/.usdz.
 * @param signal - caller abort signal (does not cancel the shared request).
 * @param limit - maximum matches (default 200).
 * @returns { entries, scanned, truncated }.
 */
export async function searchFiles(prefix, query, usdOnly, signal, limit = 200) {
  const params = new URLSearchParams({
    prefix: prefix ?? '',
    q: query ?? '',
    usd: usdOnly === false ? '0' : '1',
    limit: String(limit),
  })
  const path = params.toString()
  return await withSignal(cached(searchCache, path, async () => {
    if (hasDirect()) return await searchDirect(prefix ?? '', query ?? '', usdOnly !== false, limit, undefined)
    const library = await hostLibrary()
    if (library !== undefined) return await getJson(HOST_SEARCH + '?' + path)
    return await getJson(ASSET_ORIGIN + API_SEARCH + '?' + path)
  }), signal)
}

/** Largest object the sidebar will buffer into the page (the host cap, mirrored). */
export const MAX_PAGE_OBJECT_BYTES = 64 * 1024 * 1024

/** Wall-clock budget for one object read from the page. */
export const OBJECT_TIMEOUT_MS = 30_000

/**
 * Read one object's bytes, bounded in size and time.
 *
 * The signed host route is tried first (it also memoizes and disk-caches); the
 * deployment gateway's public byte route is the fallback for a bucket the host
 * cannot sign, which is exactly the case where the browser's bucket differs from
 * the host's configured one.
 * @param key - object key.
 * @param signal - caller abort signal.
 * @returns object bytes.
 */
export async function fetchObjectBytes(key, signal) {
  if (hasDirect()) {
    try {
      return await fetchDirectBytes(key, signal)
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted === true) throw error
      if (error?.message === 'direct-not-found') throw new Error('objstore-not-found')
      if (error?.message === 'direct-too-large') throw new Error('objstore-too-large')
      if (error?.message === 'direct-forbidden') throw new Error('objstore-forbidden')
      // A CORS or network failure falls through to the host/gateway.
    }
  }
  const library = await hostLibrary()
  if (library !== undefined) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('object read timed out')), OBJECT_TIMEOUT_MS)
    const forward = () => controller.abort(signal?.reason)
    if (signal !== undefined) {
      if (signal.aborted) forward()
      else signal.addEventListener('abort', forward, { once: true })
    }
    try {
      const uri = s3Uri(library.bucket, key)
      const response = await fetch('/api/usd-preview/asset?uri=' + encodeURIComponent(uri), {
        signal: controller.signal,
      })
      if (response.ok) {
        const declared = Number(response.headers.get('content-length'))
        if (Number.isFinite(declared) && declared > MAX_PAGE_OBJECT_BYTES) throw new Error('objstore-too-large')
        const buffer = new Uint8Array(await response.arrayBuffer())
        if (buffer.byteLength > MAX_PAGE_OBJECT_BYTES) throw new Error('objstore-too-large')
        return buffer
      }
      if (response.status === 404) throw new Error('objstore-not-found')
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted === true) throw error
      if (error?.message === 'objstore-too-large' || error?.message === 'objstore-not-found') throw error
      // Any other host failure falls through to the gateway.
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', forward)
    }
  }
  const response = await fetch(ASSET_ORIGIN + ASSET_PREFIX + encodeKey(key), { signal })
  if (response.status === 404) throw new Error('objstore-not-found')
  if (!response.ok) throw new Error('objstore-http-' + response.status)
  return new Uint8Array(await response.arrayBuffer())
}

/**
 * URL for one object's bytes as the browser may open it.
 *
 * A signed read cannot be a plain link (it needs the session credential and a
 * signature), so a link uses the endpoint the host reported, which is the URL a
 * public-read asset library serves anyway.
 * @param key - object key.
 * @param library - the host's reported library, when it has one.
 * @returns an absolute URL, or the gateway's page-relative route.
 */
export function publicAssetUrl(key, library) {
  if (hasDirect()) {
    const url = directObjectUrl(key)
    if (url !== undefined) return url
  }
  if (library !== undefined && typeof library.endpoint === 'string' && library.endpoint !== '') {
    const bucket = typeof library.bucket === 'string' && library.bucket !== '' ? library.bucket : 'asset'
    return library.endpoint.replace(/\/+$/, '') + '/' + encodeKey(bucket) + '/' + encodeKey(key)
  }
  return ASSET_ORIGIN + ASSET_PREFIX + encodeKey(key)
}

/**
 * Canonical s3:// URI for one object.
 * @param bucket - the bucket the listing API reported (the gateway's own bucket).
 * @param key - object key.
 * @returns the URI a pasted address or an s3:// reference can name.
 */
export function s3Uri(bucket, key) {
  const name = String(bucket ?? '').trim() || 'asset'
  return 's3://' + name + '/' + normalizePath(key)
}

/** Re-export the browser-direct connection helpers for the sidebar UI. */
export {
  clearDirect,
  configureDirect,
  directConfig,
  directS3Uri,
  hasDirect,
  testDirect,
} from './directS3.js'

/** Human-friendly byte count. */
export function formatBytes(value) {
  const n = Number(value) || 0
  if (n < 1024) return n + ' B'
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = n
  let unit = -1
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return size.toFixed(size >= 10 ? 0 : 1) + ' ' + units[unit]
}

/** Compact local date/time from an ISO timestamp. */
export function formatDate(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const pad = number => (number < 10 ? '0' + number : String(number))
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
    + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}
