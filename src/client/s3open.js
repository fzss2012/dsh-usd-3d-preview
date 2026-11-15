/**
 * Direct s3:// opening for the external-asset tab.
 *
 * The previewer's object-storage support was reference-only: a stage could name
 * s3://bucket/key layers, but there was no way to open such a URI itself.
 * This module closes that gap through the same host signing route the reference
 * path uses (/api/usd-preview/asset), so no S3 credential ever reaches the page.
 * When the host has no asset library configured (the DSH_USD_S3_* variables are
 * absent), a local read-only gateway on 127.0.0.1:9010 is used instead.
 */
import { USD_EXTENSIONS } from './usd.js'

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
  const path = decodeURIComponent(url.pathname)
  const dot = path.lastIndexOf('.')
  if (dot < 0 || !USD_SUFFIXES.has(path.slice(dot + 1).toLowerCase())) return undefined
  return { uri: text, key: path.replace(/^\/+/, '') }
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
  // 503: the host route exists but no asset library is configured.
  const keyPath = parsed.key.split('/').map(segment => encodeURIComponent(segment)).join('/')
  const local = await fetch(GATEWAY + '/asset/' + keyPath, { signal }).catch(() => undefined)
  if (local === undefined) throw new Error('s3-gateway-down')
  if (local.status === 404) throw new Error('s3-not-found')
  if (!local.ok) throw new Error('s3-read-failed')
  return new Uint8Array(await local.arrayBuffer())
}

/**
 * Read one s3:// reference for the WASM engine's localization pass.
 * @param uri - the reference named by a layer.
 * @param signal - abort signal.
 * @returns bytes, or undefined when the read failed (the engine reports it).
 */
/** Whether an absolute http(s) URL names a USD stage. */
export function isUsdHttpUri(uri) {
  return parseHttp(uri) !== undefined
}

/**
 * Open an absolute http(s) URL as the root stage.
 *
 * The URL must be CORS-readable from the page (the asset-library nginx adds
 * Access-Control-Allow-Origin: *). Same-origin URLs need no CORS at all.
 * @param parsed - http(s) URL from parseHttp().
 * @param signal - abort signal from the owning tab.
 * @returns the engine's dropped-file shape.
 */
async function openHttpStage(parsed, signal) {
  const response = await fetch(parsed.uri, { signal, mode: 'cors' }).catch(() => undefined)
  if (response === undefined) throw new Error('http-fetch-failed')
  if (response.status === 404) throw new Error('http-not-found')
  if (!response.ok) throw new Error('http-fetch-failed')
  const bytes = new Uint8Array(await response.arrayBuffer())
  return {
    uri: parsed.uri,
    rootKey: parsed.key,
    files: new Map([[parsed.key, new Blob([bytes], { type: 'application/octet-stream' })]]),
    stages: [parsed.key],
  }
}

/**
 * Open either an s3:// URI or an absolute http(s) URL as the root stage.
 * @param uri - stage address the user pasted.
 * @param signal - abort signal from the owning tab.
 * @returns the engine's dropped-file shape.
 */
export async function openStage(uri, signal) {
  const text = String(uri ?? '').trim()
  if (S3_URI.test(text)) return await openS3Stage(text, signal)
  const http = parseHttp(text)
  if (http !== undefined) return await openHttpStage(http, signal)
  throw new Error('stage-bad-uri')
}

export async function readS3Asset(uri, signal) {
  const parsed = parse(uri)
  if (parsed === undefined) return undefined
  try {
    return await readObject(parsed, signal)
  } catch {
    return undefined
  }
}

/**
 * Open an s3:// URI as the root stage of the external-asset tab.
 *
 * The bytes are held by the page exactly like a dropped file, so the caller
 * reuses UsdBody without a second code path; internal s3:// references are
 * still resolved through readS3Asset.
 * @param uri - s3://bucket/key.usda address to open.
 * @param signal - abort signal from the owning tab.
 * @returns the engine's dropped-file shape: files, stages and the root key.
 */
export async function openS3Stage(uri, signal) {
  const parsed = parse(uri)
  if (parsed === undefined || !isUsdS3Uri(parsed.uri)) throw new Error('s3-bad-uri')
  const bytes = await readObject(parsed, signal)
  const rootKey = parsed.key
  return {
    uri: parsed.uri,
    rootKey,
    files: new Map([[rootKey, new Blob([bytes], { type: 'application/octet-stream' })]]),
    stages: [rootKey],
  }
}
