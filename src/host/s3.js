/**
 * Signed reads from an S3-compatible asset library.
 *
 * USD layers can point at geometry by object-storage URI (`s3://bucket/key`).
 * A browser cannot sign such a request, so this module does the one thing the
 * browser cannot: it signs a plain read-only GET.
 *
 * Configuration is environment-only, never a configuration file:
 *
 *   DSH_USD_S3_ENDPOINT    base URL of the S3-compatible service (required)
 *   DSH_USD_S3_BUCKET      bucket the `s3://` URIs name (default `asset`)
 *   DSH_USD_S3_REGION      signing region (default `us-east-1`)
 *   DSH_USD_S3_ACCESS_KEY  access key id (required)
 *   DSH_USD_S3_SECRET_KEY  secret access key (required)
 *
 * Everything here is a read: no upload, no policy change, no new account, and
 * the credentials are only ever held in memory for the lifetime of one signing.
 * One read is bounded in time and size, and the memo cache is bounded too, so a
 * stalled endpoint or an oversized object cannot take the host down with it.
 */
import { createHash, createHmac } from 'node:crypto'
import { readFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** The `s3://` URI form used inside USD asset paths. */
const S3_URI = /^s3:\/\/([^/]+)\/(.+)$/

/** Empty-body payload hash every SigV4 GET with no body signs. */
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex')

/** Largest object one asset read accepts: anything bigger is refused, never buffered. */
export const MAX_ASSET_BYTES = 64 * 1024 * 1024

/** Wall-clock budget for one signed read (fetch plus body), so a stalled endpoint cannot park a request. */
export const READ_TIMEOUT_MS = 30_000

/** Entries the in-process memo keeps; the least recently used one is evicted first. */
const MEMORY_MAX_ENTRIES = 64

/** Bytes the in-process memo keeps; the least recently used entries are evicted first. */
const MEMORY_MAX_BYTES = 128 * 1024 * 1024

/** One entry of the in-memory asset cache, keyed by `bucket/key`. */
const memory = new Map()

/** Bytes currently held by `memory`, so eviction does not need to re-sum it. */
let memoryBytes = 0

/** Read one memo entry and mark it most recently used. */
function memoryGet(memoryKey) {
  const entry = memory.get(memoryKey)
  if (entry === undefined) return undefined
  memory.delete(memoryKey)
  memory.set(memoryKey, entry)
  return entry
}

/** Store one memo entry, evicting least-recently-used entries to stay bounded. */
function memorySet(memoryKey, data) {
  const previous = memory.get(memoryKey)
  if (previous !== undefined) {
    memory.delete(memoryKey)
    memoryBytes -= previous.byteLength
  }
  if (data.byteLength > MEMORY_MAX_BYTES) return
  memory.set(memoryKey, data)
  memoryBytes += data.byteLength
  while (memory.size > MEMORY_MAX_ENTRIES || memoryBytes > MEMORY_MAX_BYTES) {
    const oldest = memory.keys().next()
    if (oldest.done === true) break
    const evicted = memory.get(oldest.value)
    memory.delete(oldest.value)
    if (evicted !== undefined) memoryBytes -= evicted.byteLength
  }
}

/** One asset read refused because the object is larger than the host accepts. */
export class AssetTooLargeError extends Error {
  /**
   * @param limit - the byte cap the object exceeded.
   */
  constructor(limit) {
    super(`asset is larger than the ${String(limit)} byte read limit`)
    this.name = 'AssetTooLargeError'
    this.code = 'asset-too-large'
    this.limit = limit
  }
}

/**
 * The asset library this deployment reads from, or undefined when unconfigured.
 *
 * Only the non-secret half needs to leave this module; the credentials stay here
 * and are used solely to sign one GET.
 * @returns the endpoint, bucket, region, credentials, and where they came from,
 * or undefined when any required variable is missing.
 */
export async function storageLibrary() {
  const endpoint = process.env.DSH_USD_S3_ENDPOINT?.trim()
  const accessKey = process.env.DSH_USD_S3_ACCESS_KEY?.trim()
  const secretKey = process.env.DSH_USD_S3_SECRET_KEY?.trim()
  if (!endpoint || !accessKey || !secretKey) return undefined
  return {
    endpoint: endpoint.replace(/\/+$/, ''),
    bucket: process.env.DSH_USD_S3_BUCKET?.trim() || 'asset',
    region: process.env.DSH_USD_S3_REGION?.trim() || 'us-east-1',
    accessKey,
    secretKey,
    source: 'environment',
  }
}

/** HMAC-SHA256 of one string with one key. */
function hmac(key, value) {
  return createHmac('sha256', key).update(value, 'utf8').digest()
}

/** Hex SHA-256 of one string. */
function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Percent-encode one S3 key segment the way SigV4 canonicalization requires.
 * @param segment - one path segment.
 * @returns the encoded segment.
 */
function encodeSegment(segment) {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  )
}

/**
 * Sign one S3 GET and return its request headers.
 * @param options - endpoint, region, credentials, bucket, and key.
 * @returns the absolute URL and the headers that authorize it.
 */
function signGet({ endpoint, region, accessKey, secretKey, bucket, key }) {
  const url = new URL(`${endpoint}/${encodeSegment(bucket)}/${key.split('/').map(encodeSegment).join('/')}`)
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const scope = `${dateStamp}/${region}/s3/aws4_request`
  const canonicalRequest = [
    'GET',
    url.pathname,
    '',
    `host:${url.host}`,
    `x-amz-content-sha256:${EMPTY_SHA256}`,
    `x-amz-date:${amzDate}`,
    '',
    'host;x-amz-content-sha256;x-amz-date',
    EMPTY_SHA256,
  ].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n')
  const kDate = hmac(`AWS4${secretKey}`, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, 's3')
  const signature = createHmac('sha256', hmac(kService, 'aws4_request')).update(stringToSign, 'utf8').digest('hex')
  return {
    url: url.toString(),
    headers: {
      'x-amz-content-sha256': EMPTY_SHA256,
      'x-amz-date': amzDate,
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
    },
  }
}

/**
 * Whether one `s3://` URI names an object this deployment can read.
 * @param uri - a reference body such as `s3://bucket/path/layer.usd`.
 * @param library - the resolved asset library.
 * @returns the key to read, or undefined when the URI is outside the library.
 */
export function keyOf(uri, library) {
  const match = S3_URI.exec(uri)
  if (match === null) return undefined
  if (library !== undefined && match[1] !== library.bucket) return undefined
  const key = match[2]
  if (key === '' || key.split('/').some(segment => segment === '..' || segment === '.')) return undefined
  // The key is also a relative path under the disk cache, so characters that a
  // platform may read as a separator (backslash) or cannot represent at all are
  // refused here rather than being normalized later.
  if (/[\\\u0000-\u001f]/.test(key)) return undefined
  return key
}

/**
 * Read one asset object, from the disk cache when this key was read before.
 *
 * The read is bounded: the body is accumulated only up to `maxBytes` (a bigger
 * object refuses with {@link AssetTooLargeError}), the whole read aborts after
 * `timeoutMs`, a caller abort aborts it too, and the memory cache is bounded.
 * @param library - the resolved library.
 * @param uri - one `s3://` URI.
 * @param cacheDir - where the disk cache lives.
 * @param options - optional byte cap, timeout, and caller abort signal.
 * @returns the object bytes and where they came from, or undefined when the
 * object does not exist or the credentials may not read it.
 */
export async function readAsset(library, uri, cacheDir, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_ASSET_BYTES
  const timeoutMs = options.timeoutMs ?? READ_TIMEOUT_MS
  const key = keyOf(uri, library)
  if (key === undefined) return undefined
  const memoryKey = `${library.bucket}/${key}`
  const memo = memoryGet(memoryKey)
  if (memo !== undefined) return { data: memo, source: 'memory' }

  const cached = join(cacheDir, library.bucket, ...key.split('/'))
  const hit = await stat(cached).catch(() => undefined)
  if (hit !== undefined && hit.isFile() && hit.size > 0 && hit.size <= maxBytes) {
    const data = await readFile(cached)
    memorySet(memoryKey, data)
    return { data, source: 'cache' }
  }

  const { url, headers } = signGet({ ...library, key })
  const abort = new AbortController()
  const caller = options.signal
  /** @param {unknown} reason - why the read was aborted. */
  const forwardAbort = reason => abort.abort(reason)
  const onCallerAbort = () => forwardAbort(caller?.reason)
  if (caller !== undefined) {
    if (caller.aborted) onCallerAbort()
    else caller.addEventListener('abort', onCallerAbort, { once: true })
  }
  const timer = setTimeout(() => forwardAbort(new Error('asset read timed out')), timeoutMs)
  try {
    const response = await fetch(url, { headers, signal: abort.signal })
    if (response.status === 404 || response.status === 403) return undefined
    if (!response.ok) throw new Error(`asset read failed (HTTP ${response.status})`)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) throw new AssetTooLargeError(maxBytes)
    const chunks = []
    let total = 0
    if (response.body !== null) {
      const reader = response.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          total += value.byteLength
          if (total > maxBytes) {
            await reader.cancel().catch(() => undefined)
            throw new AssetTooLargeError(maxBytes)
          }
          chunks.push(Buffer.from(value))
        }
      } finally {
        reader.releaseLock()
      }
    }
    const data = Buffer.concat(chunks, total)
    memorySet(memoryKey, data)
    // The cache is best effort: a read-only cache directory must not break a preview.
    await mkdir(dirname(cached), { recursive: true }).then(
      () => writeFile(cached, data),
      () => undefined,
    ).catch(() => undefined)
    return { data, source: 'remote' }
  } finally {
    clearTimeout(timer)
    caller?.removeEventListener('abort', onCallerAbort)
  }
}

/**
 * The default asset cache directory: this deployment's own cache, next to the
 * rest of its state under `DSH_HOME` (or `~/.dsh`).
 * @returns an absolute directory path.
 */
export function defaultAssetCacheDir() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'cache', 'usd-assets')
}
