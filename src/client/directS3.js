/**
 * Browser-side S3-compatible object storage access (SIGV4 over CORS).
 *
 * The sidebar can talk to an S3-compatible service *directly*, without a host
 * library, a gateway, or an environment variable: the user supplies an endpoint,
 * a bucket, and a key pair in the tab, and this module signs each read-only GET
 * with Web Crypto. Nothing is uploaded, nothing else is modified, and the
 * credentials never leave the page -- they live in a module-scoped variable for
 * the lifetime of the tab and are never written to disk, localStorage, or a log.
 *
 * This only works when the endpoint answers CORS for the page, including the
 * signed headers. MinIO does by default (Access-Control-Allow-Origin: * and an
 * OPTIONS answer that allows authorization/x-amz-date/x-amz-content-sha256).
 * A service that cannot be reached from the browser falls back to the host half's
 * signed routes, which is what objstore.js decides.
 */
const encoder = new TextEncoder()

/** Empty-body payload hash every signed GET carries. */
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

/** Largest object the page will buffer: the host's cap, mirrored. */
export const DIRECT_MAX_BYTES = 64 * 1024 * 1024

/** Wall-clock budget for one direct request. */
export const DIRECT_TIMEOUT_MS = 30_000

/** Suffixes a search keeps by default. */
const USD_KEY = /\.(usd|usda|usdc|usdz)$/i

/** The one live configuration; never serialized and never logged. */
let current

/**
 * Normalize an endpoint: no trailing slash, no path.
 * @param value - the endpoint the user typed.
 * @returns the normalized URL, or undefined when it is not http(s).
 */
export function normalizeEndpoint(value) {
  try {
    const url = new URL(String(value ?? '').trim())
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url.href.replace(/\/+$/, '')
  } catch {
    return undefined
  }
}

/**
 * Normalize a key prefix to the form the API uses: no leading slash, exactly one
 * trailing slash, "" for the whole bucket.
 * @param value - the configured prefix.
 * @returns the normalized prefix ("" when it means the bucket root).
 */
export function normalizePrefix(value) {
  if (typeof value !== 'string') return ''
  let text = value.trim()
  const uri = /^s3:\/\/[^/]+\/?(.*)$/i.exec(text)
  if (uri !== null) text = uri[1]
  const segments = text.replaceAll('\\', '/').split('/').filter(part => part !== '' && part !== '.')
  if (segments.length === 0 || segments.includes('..')) return ''
  return segments.join('/') + '/'
}

/**
 * Confine one requested prefix to the configured root.
 * @param value - the page's prefix.
 * @param rootPrefix - the configured root.
 * @returns the key prefix, or undefined when it would escape the root.
 */
export function confinedPrefix(value, rootPrefix) {
  const root = normalizePrefix(rootPrefix)
  const text = typeof value === 'string' ? value.trim() : ''
  const segments = text.replaceAll('\\', '/').split('/').filter(part => part !== '' && part !== '.')
  if (segments.includes('..')) return undefined
  if (segments.length === 0) return root
  const prefix = segments.join('/') + '/'
  if (prefix.startsWith(root)) return prefix
  // The page names the root without its trailing slash ("L0" for root "L0/").
  if (root !== '' && root === prefix) return root
  return undefined
}

/**
 * Store the connection the page entered.
 *
 * The secret is kept only in this module's closure. The returned object is the
 * non-secret half the UI may render and the readers may pass around.
 * @param options - endpoint, bucket, region, keys and the optional root prefix.
 * @returns the safe configuration, or an error message string.
 */
export function configureDirect(options = {}) {
  const endpoint = normalizeEndpoint(options.endpoint)
  if (endpoint === undefined) return 'direct-bad-endpoint'
  const bucket = String(options.bucket ?? '').trim() || 'asset'
  if (!/^[A-Za-z0-9._-]+$/.test(bucket)) return 'direct-bad-bucket'
  const accessKey = String(options.accessKey ?? '').trim()
  const secretKey = String(options.secretKey ?? '').trim()
  if (accessKey === '' || secretKey === '') return 'direct-missing-keys'
  const region = String(options.region ?? '').trim() || 'us-east-1'
  current = {
    endpoint,
    bucket,
    region,
    accessKey,
    secretKey,
    rootPrefix: normalizePrefix(options.rootPrefix),
  }
  return directConfig()
}

/** Forget the connection, including its credentials. */
export function clearDirect() {
  current = undefined
}

/** The non-secret half of the live connection, or undefined. */
export function directConfig() {
  if (current === undefined) return undefined
  const { endpoint, bucket, region, rootPrefix } = current
  return { endpoint, bucket, region, rootPrefix }
}

/** Whether a direct connection has been configured. */
export function hasDirect() {
  return current !== undefined
}

/** AWS-flavoured percent encoding for one canonical query component. */
function encodeAws(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, character => (
    '%' + character.charCodeAt(0).toString(16).toUpperCase()
  ))
}

/** HMAC-SHA256 with Web Crypto. */
async function hmacBytes(keyBytes, value) {
  const key = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  )
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(value)))
}

/** Lowercase hex of one byte array. */
function hex(bytes) {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

/** SHA-256 hex of one string. */
async function sha256Hex(value) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))))
}

/** Encode each key segment for a URL path, leaving the separators. */
export function encodeKey(key) {
  return String(key).split('/').map(encodeAws).join('/')
}

/**
 * Sign one read-only GET and fetch it.
 * @param config - the live connection.
 * @param url - the absolute URL to read.
 * @param signal - caller abort signal.
 * @returns the response.
 */
async function signedGet(config, url, signal) {
  const target = new URL(url)
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '')
  const dateStamp = amzDate.slice(0, 8)
  const scope = dateStamp + '/' + config.region + '/s3/aws4_request'
  const query = [...target.searchParams.entries()]
    .map(([name, value]) => [encodeAws(name), encodeAws(value)])
    .sort((left, right) => (left[0] === right[0]
      ? (left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0)
      : (left[0] < right[0] ? -1 : 1)))
    .map(([name, value]) => name + '=' + value)
    .join('&')
  const canonical = [
    'GET',
    target.pathname,
    query,
    'host:' + target.host,
    'x-amz-content-sha256:' + EMPTY_SHA256,
    'x-amz-date:' + amzDate,
    '',
    'host;x-amz-content-sha256;x-amz-date',
    EMPTY_SHA256,
  ].join('\n')
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonical)].join('\n')
  const kDate = await hmacBytes(encoder.encode('AWS4' + config.secretKey), dateStamp)
  const kRegion = await hmacBytes(kDate, config.region)
  const kService = await hmacBytes(kRegion, 's3')
  const kSigning = await hmacBytes(kService, 'aws4_request')
  const signature = hex(await hmacBytes(kSigning, stringToSign))
  return await fetch(target.href, {
    signal,
    headers: {
      'x-amz-content-sha256': EMPTY_SHA256,
      'x-amz-date': amzDate,
      authorization: 'AWS4-HMAC-SHA256 Credential=' + config.accessKey + '/' + scope
        + ', SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=' + signature,
    },
  })
}

/** One signed GET with a caller-independent timeout. */
async function request(pathAndQuery, signal) {
  if (current === undefined) throw new Error('direct-not-configured')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('direct-timeout')), DIRECT_TIMEOUT_MS)
  const forward = () => controller.abort(signal?.reason)
  if (signal !== undefined) {
    if (signal.aborted) forward()
    else signal.addEventListener('abort', forward, { once: true })
  }
  try {
    return await signedGet(current, current.endpoint + pathAndQuery, controller.signal)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
}

/** Read one XML element body, or undefined. */
function tagOf(xml, name) {
  const match = new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>').exec(xml)
  return match === null ? undefined : match[1]
}

/** Decode the entities an S3 key can carry. */
function unescapeXml(text) {
  return text
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

/** Whether one key names a USD stage. */
export function isUsdKey(key) {
  return USD_KEY.test(String(key))
}

/**
 * List the immediate children of one prefix.
 * @param prefix - the key prefix.
 * @param token - continuation token from a previous page.
 * @param signal - caller abort signal.
 * @returns the page-shaped listing the sidebar renders.
 */
export async function listDirect(prefix, token, signal) {
  const config = current
  if (config === undefined) throw new Error('direct-not-configured')
  const keyPrefix = confinedPrefix(prefix, config.rootPrefix)
  if (keyPrefix === undefined) throw new Error('direct-forbidden-prefix')
  void config
  const params = new URLSearchParams({
    'list-type': '2',
    delimiter: '/',
    prefix: keyPrefix,
    'max-keys': '500',
  })
  if (typeof token === 'string' && token !== '') params.set('continuation-token', token)
  const response = await request('/' + config.bucket + '/?' + params.toString(), signal)
  if (response.status === 403) throw new Error('direct-forbidden')
  if (response.status === 404) throw new Error('direct-not-found')
  if (!response.ok) throw new Error('direct-http-' + response.status)
  const xml = await response.text()

  const entries = []
  const contents = /<Contents>([\s\S]*?)<\/Contents>/g
  for (let match = contents.exec(xml); match !== null; match = contents.exec(xml)) {
    const raw = tagOf(match[1], 'Key')
    if (raw === undefined) continue
    const key = unescapeXml(raw)
    if (key === keyPrefix || key.endsWith('/')) continue
    const size = Number(tagOf(match[1], 'Size'))
    entries.push({
      key,
      name: key.slice(keyPrefix.length),
      type: 'file',
      size: Number.isFinite(size) ? size : 0,
      lastModified: tagOf(match[1], 'LastModified') ?? '',
    })
  }
  const prefixes = /<CommonPrefixes>([\s\S]*?)<\/CommonPrefixes>/g
  for (let match = prefixes.exec(xml); match !== null; match = prefixes.exec(xml)) {
    const raw = tagOf(match[1], 'Prefix')
    if (raw === undefined) continue
    const key = unescapeXml(raw)
    if (key === keyPrefix || !key.endsWith('/')) continue
    entries.push({ key, name: key.slice(keyPrefix.length, -1), type: 'folder', size: 0, lastModified: '' })
  }
  entries.sort((left, right) => {
    if (left.type !== right.type) return left.type === 'folder' ? -1 : 1
    return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
  })
  const truncated = tagOf(xml, 'IsTruncated') === 'true'
  const next = tagOf(xml, 'NextContinuationToken')
  return {
    bucket: config.bucket,
    prefix: keyPrefix,
    rootPrefix: config.rootPrefix,
    allowedPrefixes: config.rootPrefix === '' ? [] : [config.rootPrefix],
    entries,
    truncated,
    continuationToken: truncated && next !== undefined ? unescapeXml(next) : null,
    direct: true,
  }
}

/**
 * Recursively search below one prefix by walking the listing.
 * @param prefix - search root.
 * @param query - case-insensitive substring.
 * @param usdOnly - keep only USD suffixes.
 * @param limit - maximum matches.
 * @param signal - caller abort signal.
 * @returns { entries, scanned, truncated }.
 */
export async function searchDirect(prefix, query, usdOnly, limit, signal) {
  const config = current
  if (config === undefined) throw new Error('direct-not-configured')
  const root = confinedPrefix(prefix, config.rootPrefix)
  if (root === undefined) throw new Error('direct-forbidden-prefix')
  void config
  const needle = String(query ?? '').trim().toLowerCase()
  const max = Math.min(Number(limit) > 0 ? Math.trunc(Number(limit)) : 200, 1000)
  const entries = []
  let scanned = 0
  let truncated = false
  let token = ''
  for (let page = 0; page < 20; page += 1) {
    const params = new URLSearchParams({ 'list-type': '2', prefix: root, 'max-keys': '1000' })
    if (token !== '') params.set('continuation-token', token)
    const response = await request('/' + config.bucket + '/?' + params.toString(), signal)
    if (response.status === 403) throw new Error('direct-forbidden')
    if (response.status === 404) throw new Error('direct-not-found')
    if (!response.ok) throw new Error('direct-http-' + response.status)
    const xml = await response.text()
    const contents = /<Contents>([\s\S]*?)<\/Contents>/g
    for (let match = contents.exec(xml); match !== null; match = contents.exec(xml)) {
      const raw = tagOf(match[1], 'Key')
      if (raw === undefined) continue
      const key = unescapeXml(raw)
      if (key.endsWith('/')) continue
      scanned += 1
      if (usdOnly !== false && !USD_KEY.test(key)) continue
      if (needle !== '' && !key.toLowerCase().includes(needle)) continue
      if (entries.length >= max) { truncated = true; break }
      const size = Number(tagOf(match[1], 'Size'))
      entries.push({
        key,
        name: key.slice(key.lastIndexOf('/') + 1),
        type: 'file',
        size: Number.isFinite(size) ? size : 0,
        lastModified: tagOf(match[1], 'LastModified') ?? '',
      })
    }
    if (truncated) break
    const more = tagOf(xml, 'IsTruncated') === 'true'
    const next = tagOf(xml, 'NextContinuationToken')
    if (!more || next === undefined) break
    token = unescapeXml(next)
    if (page === 19) truncated = true
  }
  entries.sort((left, right) => left.key.localeCompare(right.key, undefined, { numeric: true, sensitivity: 'base' }))
  return { entries, scanned, truncated }
}

/**
 * Read one object's bytes with a signed GET.
 * @param key - object key.
 * @param signal - caller abort signal.
 * @returns the bytes.
 */
export async function fetchDirectBytes(key, signal) {
  if (current === undefined) throw new Error('direct-not-configured')
  const response = await request('/' + current.bucket + '/' + encodeKey(key), signal)
  if (response.status === 404) throw new Error('direct-not-found')
  if (response.status === 403) throw new Error('direct-forbidden')
  if (!response.ok) throw new Error('direct-http-' + response.status)
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > DIRECT_MAX_BYTES) throw new Error('direct-too-large')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > DIRECT_MAX_BYTES) throw new Error('direct-too-large')
  return bytes
}

/** Absolute URL of one object (no signature; needs anonymous read). */
export function directObjectUrl(key) {
  if (current === undefined) return undefined
  return current.endpoint + '/' + current.bucket + '/' + encodeKey(key)
}

/** Canonical s3:// URI of one object on this connection. */
export function directS3Uri(key) {
  if (current === undefined) return undefined
  return 's3://' + current.bucket + '/' + String(key).replace(/^\/+/, '')
}

/**
 * Verify the connection with a one-object listing.
 * @param signal - caller abort signal.
 * @returns the safe configuration when accepted.
 */
export async function testDirect(signal) {
  await listDirect('', '', signal)
  return directConfig()
}
