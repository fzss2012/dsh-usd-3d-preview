/**
 * Client-side helpers for the object-storage sidebar tab.
 *
 * The routes below are served by whatever terminates the asset library (see the
 * README): an nginx location, a gateway, or the host half itself. They are read
 * from the page's own origin by default, because that is the only origin a
 * deployment can be sure a browser may call. A deployment that terminates the
 * routes elsewhere — a portal host, a local dev port — names that origin once:
 *
 *   globalThis.__DSH_OBJSTORE_ASSET_ORIGIN__ = 'https://asset.example.com'
 *
 * The value is an origin only (no path, no trailing slash) and is read when this
 * module loads, so it must be set before the bundle runs.
 */

/** Absolute origin for the object-storage routes, or '' for the page's own. */
const ASSET_ORIGIN = (() => {
  const override = globalThis.__DSH_OBJSTORE_ASSET_ORIGIN__
  if (typeof override !== 'string') return ''
  return override.trim().replace(/\/+$/, '')
})()

/** nginx -> gateway mapping for directory listings. */
const API_LIST = '/usd-asset-api/list'

/** nginx -> gateway mapping for one object's metadata. */
const API_STAT = '/usd-asset-api/stat'

/** nginx -> gateway mapping for object bytes. */
const ASSET_PREFIX = '/usd-asset/'

/** USD suffixes this sidebar can hand to the preview. */
const USD_SUFFIXES = new Set(['usd', 'usda', 'usdc', 'usdz'])

/** Resolved API origin; probed once per page. */
let basePromise

/** Short-lived request caches.

 * The sidebar tab can mount twice (React strict effect passes) and the search
 * box fires on every keystroke; sharing one promise per request keeps the
 * gateway from being asked the same question twice and keeps the list stable
 * while a prefix is revisited.
 */
const CACHE_TTL_MS = 10000
const listCache = new Map()
const searchCache = new Map()

function cached(cache, key, factory) {
  const now = Date.now()
  const hit = cache.get(key)
  if (hit !== undefined && hit.expires > now) return hit.promise
  const promise = factory()
  cache.set(key, { promise, expires: now + CACHE_TTL_MS })
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key)
  })
  if (cache.size > 64) {
    for (const [entryKey, entry] of cache) {
      if (entry.expires <= now) cache.delete(entryKey)
    }
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
 * Resolve the origin that serves the object-storage API.
 *
 * The configured origin when one was named, the page's own origin otherwise.
 * The probe is cached so the tab asks once per page.
 * @returns origin string ('' for same-origin), or undefined when nothing answers.
 */
export function apiOrigin() {
  if (basePromise === undefined) {
    basePromise = (async () => {
      try {
        const response = await fetch(ASSET_ORIGIN + API_LIST + '?prefix=')
        if (response.ok) return ASSET_ORIGIN
      } catch {
        // fall through to undefined: the caller reports one honest error
      }
      return undefined
    })()
  }
  return basePromise
}

/** Request one JSON document from the gateway through the API origin. */
async function getJson(path, signal) {
  const base = await apiOrigin()
  if (base === undefined) throw new Error('objstore-unreachable')
  const response = await fetch(base + path, { signal })
  if (response.status === 403) throw new Error('objstore-forbidden')
  if (response.status === 404) throw new Error('objstore-not-found')
  if (!response.ok) throw new Error('objstore-http-' + response.status)
  return await response.json()
}

/**
 * List the immediate children of one prefix.
 * @param prefix - directory prefix ('' for the allowed roots).
 * @param signal - abort signal.
 * @returns { bucket, prefix, allowedPrefixes, entries, truncated }.
 */
export async function listPrefix(prefix, signal) {
  return await cached(listCache, String(prefix ?? ''), () =>
    getJson(API_LIST + '?prefix=' + encodeURIComponent(prefix ?? ''), signal))
}

/**
 * Recursively search files below one prefix.
 * @param prefix - search root ('' searches all exposed roots).
 * @param query - case-insensitive substring; '' returns every file.
 * @param usdOnly - restrict matches to .usd/.usda/.usdc/.usdz.
 * @param signal - abort signal.
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
  const path = '/usd-asset-api/search?' + params.toString()
  return await cached(searchCache, path, () => getJson(path, signal))
}

/**
 * Read one object's metadata.
 * @param key - object key.
 * @param signal - abort signal.
 */
export async function statKey(key, signal) {
  return await getJson(API_STAT + '?key=' + encodeURIComponent(key), signal)
}

/**
 * Read one object's bytes through the public read-only route.
 * @param key - object key.
 * @param signal - abort signal.
 * @returns object bytes.
 */
export async function fetchObjectBytes(key, signal) {
  const base = await apiOrigin()
  if (base === undefined) throw new Error('objstore-unreachable')
  const response = await fetch(base + ASSET_PREFIX + encodeKey(key), { signal })
  if (!response.ok) throw new Error('objstore-http-' + response.status)
  return new Uint8Array(await response.arrayBuffer())
}

/** Absolute or same-origin URL for one object's bytes. */
export function publicAssetUrl(key) {
  return ASSET_ORIGIN + ASSET_PREFIX + encodeKey(key)
}

/** Canonical s3:// URI for one object. */
export function s3Uri(key) {
  return 's3://asset/' + key
}

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
