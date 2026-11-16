/**
 * Opening a stage directly from an address: s3:// through the host signing route
 * (with a loopback gateway fallback) and http(s) by direct fetch.
 *
 * The page holds only the root layer's bytes; every other layer is read on
 * demand, so the returned descriptor carries the readers the engine calls while
 * it localizes references. The engine composes the stage through its own
 * multi-pass loader (the same one a workspace file uses), so relative layers,
 * sublayers and absolute s3:// references all resolve -- one layer read per
 * reference, and a missing layer stays a warning rather than a failed preview.
 */
import { USD_EXTENSIONS } from './usd.js'
import { baseName, dirOf, normalizePath, resolvePath } from './remote.js'

/** One canonical s3://bucket/key address. */
const S3_URI = /^s3:\/\/([^/]+)\/(.+)$/

/** Any absolute http(s) URL. */
const HTTP_URI = /^https?:\/\//i

/** Suffixes this preview opens. */
const USD_SUFFIXES = new Set(USD_EXTENSIONS)

/** Host route that signs one object read. */
const ASSET_ROUTE = '/api/usd-preview/asset'

/** Local read-only gateway that fronts the same bucket when the host has no library. */
const GATEWAY = 'http://127.0.0.1:9010'

/**
 * Whether the host half has a signed asset library configured.
 *
 * The health route answers 200 with library:null when DSH_USD_S3_* was not set
 * at process start; probing once avoids a guaranteed 503 on every open.
 * @returns true when the signed host route can be used.
 */
let libraryProbe
async function hostHasLibrary() {
  if (libraryProbe === undefined) {
    libraryProbe = fetch('/api/usd-preview/health')
      .then(async response => {
        if (!response.ok) return false
        const body = await response.json().catch(() => undefined)
        return body !== undefined && body !== null && body.library !== null && body.library !== undefined
      })
      .catch(() => false)
  }
  return libraryProbe
}

/**
 * Whether a URI addresses a USD stage in object storage.
 * @param uri - candidate s3:// URI.
 * @returns true for s3://bucket/*.usd|usda|usdc|usdz.
 */
export function isUsdS3Uri(uri) {
  const match = S3_URI.exec(String(uri ?? '').trim())
  if (match === null) return false
  const key = match[2]
  const dot = key.lastIndexOf('.')
  return dot >= 0 && USD_SUFFIXES.has(key.slice(dot + 1).toLowerCase())
}

/** Parse one http(s) URL whose path ends in a USD suffix. */
function parseHttp(uri) {
  const text = String(uri ?? '').trim()
  if (!HTTP_URI.test(text)) return undefined
  let url
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  let path
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    // A malformed percent escape is not a stage address; report it as such.
    return undefined
  }
  const dot = path.lastIndexOf('.')
  if (dot < 0 || !USD_SUFFIXES.has(path.slice(dot + 1).toLowerCase())) return undefined
  return { uri: text, key: normalizePath(path) }
}

/** Split a URI into its bucket and key, or undefined when it is not s3://. */
function parse(uri) {
  const match = S3_URI.exec(String(uri ?? '').trim())
  if (match === null) return undefined
  return { uri: String(uri).trim(), bucket: match[1], key: match[2] }
}

/**
 * Read one object's bytes, preferring the signed host route and falling back to
 * the workstation gateway. The fallback keeps direct opening usable on a host
 * whose DSH_USD_S3_* variables were not set at startup.
 * @param parsed - bucket/key pair from parse().
 * @param signal - abort signal from the owning tab.
 * @returns object bytes.
 */
async function readObject(parsed, signal) {
  if (await hostHasLibrary()) {
    const host = await fetch(ASSET_ROUTE + '?uri=' + encodeURIComponent(parsed.uri), { signal })
      .catch(() => undefined)
    if (host !== undefined && host.ok) {
      return new Uint8Array(await host.arrayBuffer())
    }
    if (host !== undefined && host.status === 404) throw new Error('s3-not-found')
    if (host !== undefined && host.status !== 503) throw new Error('s3-read-failed')
  }
  // 503 (or no library at all): read the same bucket through the workstation gateway.
  const keyPath = normalizePath(parsed.key).split('/').map(segment => encodeURIComponent(segment)).join('/')
  const local = await fetch(GATEWAY + '/asset/' + keyPath, { signal }).catch(() => undefined)
  if (local === undefined) throw new Error('s3-gateway-down')
  if (local.status === 404) throw new Error('s3-not-found')
  if (!local.ok) throw new Error('s3-read-failed')
  return new Uint8Array(await local.arrayBuffer())
}

/**
 * Read one object for the engine's localization pass; a failure is "missing
 * layer" so the engine keeps composing and reports it.
 * @param uri - an s3:// URI.
 * @param signal - abort signal.
 * @returns bytes, or undefined when the object cannot be read.
 */
export async function readS3Asset(uri, signal) {
  const parsed = parse(uri)
  if (parsed === undefined) return undefined
  try {
    return await readObject(parsed, signal)
  } catch (error) {
    // An aborted read is not a missing layer; the tab is going away.
    if (error?.name === 'AbortError' || signal?.aborted === true) throw error
    return undefined
  }
}

/**
 * Reader the engine calls for a layer path it resolved against an s3 root.
 *
 * The engine reports a reference relative to the naming layer's directory; the
 * candidates cover the spellings it may produce (with and without the root
 * directory prefix) so one read is enough whichever way the reference was
 * written.
 * @param bucket - bucket of the opened stage.
 * @param rootDir - directory part of the opened stage's key.
 * @returns a reader answering object bytes, or undefined for a missing layer.
 */
function s3LayerReader(bucket, rootDir) {
  return async (path, signal) => {
    const text = String(path ?? '')
    if (S3_URI.test(text)) return await readS3Asset(text, signal)
    const normalized = normalizePath(text)
    const candidates = []
    if (normalized.startsWith(`${bucket}/`)) candidates.push(`s3://${normalized}`)
    candidates.push(`s3://${bucket}/${normalized}`)
    if (rootDir !== '') candidates.push(`s3://${bucket}/${resolvePath(rootDir, normalized)}`)
    for (const candidate of new Set(candidates)) {
      const bytes = await readS3Asset(candidate, signal)
      if (bytes !== undefined) return bytes
    }
    return undefined
  }
}

/**
 * Reader the engine calls for a layer path it resolved against an http(s) root.
 *
 * The reference may be an absolute URL, or a path relative to the root layer's
 * directory; both are fetched directly. Cross-origin layers need the server to
 * allow the page's origin, the same requirement as opening the root.
 * @param rootUri - the opened stage's absolute URL.
 * @returns a reader answering layer bytes, or undefined for a missing layer.
 */
function httpLayerReader(rootUri) {
  const rootUrl = new URL(rootUri)
  const baseUrl = new URL('.', rootUrl)
  const rootDir = dirOf(normalizePath(rootUrl.pathname))
  return async (path, signal) => {
    const text = String(path ?? '')
    const candidates = []
    if (HTTP_URI.test(text)) {
      candidates.push(text)
    } else {
      const normalized = normalizePath(text)
      if (rootDir !== '' && normalized.startsWith(`${rootDir}/`)) {
        candidates.push(new URL(normalized.slice(rootDir.length + 1), baseUrl).href)
      }
      candidates.push(new URL(normalized, baseUrl).href)
    }
    for (const candidate of new Set(candidates)) {
      try {
        const response = await fetch(candidate, { signal, mode: 'cors' })
        if (response.ok) return new Uint8Array(await response.arrayBuffer())
        if (response.status !== 404) continue
      } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted === true) throw error
        continue
      }
    }
    return undefined
  }
}

/**
 * Open one s3:// URI as the root stage: root bytes plus the readers the engine
 * uses for the layers it names.
 * @param uri - s3://bucket/key.usda address to open.
 * @param signal - abort signal from the owning tab.
 * @returns the address descriptor: root key/bytes and readers.
 */
async function openS3Stage(uri, signal) {
  const parsed = parse(uri)
  if (parsed === undefined || !isUsdS3Uri(parsed.uri)) throw new Error('s3-bad-uri')
  const rootBytes = await readObject(parsed, signal)
  const rootKey = normalizePath(parsed.key)
  return {
    uri: parsed.uri,
    kind: 's3',
    label: baseName(rootKey),
    rootKey,
    rootBytes,
    read: s3LayerReader(parsed.bucket, dirOf(rootKey)),
    readAsset: readS3Asset,
  }
}

/**
 * Open one absolute http(s) URL as the root stage.
 *
 * The URL must be CORS-readable from the page (same-origin needs no CORS).
 * @param parsed - http(s) URL from parseHttp().
 * @param signal - abort signal from the owning tab.
 * @returns the address descriptor: root key/bytes and readers.
 */
async function openHttpStage(parsed, signal) {
  const response = await fetch(parsed.uri, { signal, mode: 'cors' }).catch(() => undefined)
  if (response === undefined) throw new Error('http-fetch-failed')
  if (response.status === 404) throw new Error('http-not-found')
  if (!response.ok) throw new Error('http-fetch-failed')
  const rootBytes = new Uint8Array(await response.arrayBuffer())
  // The root key carries the URL pathname so relative references resolve from
  // the object's directory; the query string is only part of the root fetch.
  const rootKey = normalizePath(new URL(parsed.uri).pathname)
  return {
    uri: parsed.uri,
    kind: 'http',
    label: baseName(rootKey),
    rootKey,
    rootBytes,
    read: httpLayerReader(parsed.uri),
    readAsset: readS3Asset,
  }
}

/**
 * Open either an s3:// URI or an absolute http(s) URL as the root stage.
 * @param uri - stage address the user pasted.
 * @param signal - abort signal from the owning tab.
 * @returns the address descriptor: root bytes plus the layer readers.
 */
export async function openStage(uri, signal) {
  const text = String(uri ?? '').trim()
  if (S3_URI.test(text)) return await openS3Stage(text, signal)
  const http = parseHttp(text)
  if (http !== undefined) return await openHttpStage(http, signal)
  throw new Error('stage-bad-uri')
}
