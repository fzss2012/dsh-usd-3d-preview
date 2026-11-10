/**
 * What this package claims in the document-preview registry, plus the address
 * helpers the browser half needs to resolve referenced layers.
 *
 * Nothing here imports three: the registry definition is plain data so the
 * toolbar can rank it without pulling a renderer into the module graph.
 */

/** Implementation identity, used both as the `documentPreviews` id and as the keyed document-slot key. */
export const USD_PREVIEW_ID = 'dsh-usd-3d-preview/usd'

/** File suffixes this implementation renders, without a leading dot. */
export const USD_EXTENSIONS = ['usd', 'usda', 'usdc', 'usdz']

/**
 * Suffixes whose bytes are not readable text.
 *
 * `.usda` deliberately stays out: an ASCII crate is a legitimate plain-text
 * read, and declaring it binary would remove the text fallback from a file the
 * user may want to inspect as source. `.usd` is ambiguous by specification (it
 * may hold either crate), so it is declared binary — the bytes decide at
 * assembly time, but a plain-text read of a binary crate is never useful.
 */
export const BINARY_USD_EXTENSIONS = ['usd', 'usdc', 'usdz']

/**
 * The registry definition for this implementation.
 * @param title - locale-bound implementation label, read when the toolbar renders.
 * @returns metadata for complete USD files of any of the four suffixes.
 */
export function usdDefinition(title) {
  return {
    id: USD_PREVIEW_ID,
    extensions: USD_EXTENSIONS,
    binaryExtensions: BINARY_USD_EXTENSIONS,
    // The default ('extension') band outranks product implementations, so a
    // later builtin viewer for one of these suffixes cannot silently win it.
    priority: 'extension',
    title,
    // A crate, a package, or a layer with referenced siblings can only be
    // assembled from complete bytes (the Host's complete-read cap still applies
    // and reports itself).
    loading: 'bytes-complete',
    wrap: false,
  }
}

/**
 * The decoded last path segment of a file resource address.
 *
 * The whole address stays the content identity; only the displayed name is
 * shortened. Decoding is per segment, so a name carrying `#`, `?`, or a space
 * reads as itself.
 * @param address - a `dsh-resource://file/...` address.
 * @returns the decoded basename, or the address itself when it has none.
 */
export function usdFileName(address) {
  const withoutQuery = String(address).split('?')[0].split('#')[0]
  const name = withoutQuery.slice(withoutQuery.lastIndexOf('/') + 1)
  if (name === '') return String(address)
  try {
    return decodeURIComponent(name)
  } catch {
    // A malformed percent sequence is still a name; showing it raw beats refusing the address.
    return name
  }
}

/**
 * The session and path a `session`-scoped file address names.
 *
 * Only the `session` scope is understood: an `absolute` address has no session
 * to read sibling layers through, and reference resolution is best-effort — a
 * layer that cannot be located is reported by the composer as missing geometry,
 * which is the honest outcome for a file opened outside a workspace.
 * @param address - a `dsh-resource://file/...` address.
 * @returns the decoded session id and path, or undefined for any other shape.
 */
export function parseFileReference(address) {
  const withoutQuery = String(address).split('?')[0].split('#')[0]
  const prefix = 'dsh-resource://file/session/'
  if (!withoutQuery.startsWith(prefix)) return undefined
  const rest = withoutQuery.slice(prefix.length)
  const separator = rest.indexOf('/')
  if (separator <= 0 || separator === rest.length - 1) return undefined
  const decode = (value) => {
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return {
    sessionId: decode(rest.slice(0, separator)),
    path: rest.slice(separator + 1).split('/').map(decode).join('/'),
  }
}

/**
 * Join a referenced layer path onto the directory of the layer that named it.
 * @param path - the referencing layer's path.
 * @param reference - the `@…@` body as written in the layer.
 * @returns a posix path relative to the workspace root, with `.`/`..` resolved.
 */
export function siblingPath(path, reference) {
  const slash = path.lastIndexOf('/')
  return normalizePosix(`${slash < 0 ? '' : path.slice(0, slash + 1)}${reference}`)
}

/**
 * Resolve `.` and `..` in a posix path without touching the filesystem.
 * @param path - a possibly unnormalized posix path.
 * @returns the normalized path; leading `..` segments survive when they cannot resolve.
 */
export function normalizePosix(path) {
  const absolute = path.startsWith('/')
  const parts = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      const last = parts[parts.length - 1]
      if (parts.length > 0 && last !== '..') parts.pop()
      else if (!absolute) parts.push('..')
      continue
    }
    parts.push(segment)
  }
  return `${absolute ? '/' : ''}${parts.join('/')}`
}

/**
 * The directory the USD composer will prepend to a layer's own references.
 *
 * Mirrors `USDComposer._getBasePath`, because a layer is registered under the
 * exact key its referencing layer looked up: that key is what decides where the
 * next level's references resolve from.
 * @param key - the layer's registered key.
 * @returns the directory without a trailing slash, or the empty string at the root.
 */
export function layerBasePath(key) {
  const slash = key.lastIndexOf('/')
  return slash >= 0 ? key.slice(0, slash) : ''
}

/**
 * The exact key the composer will look up for one reference inside one layer.
 *
 * Mirrors `USDComposer._resolveFilePath` with the layer's own base path: a
 * leading `./` is stripped, and the base is prepended only when it is non-empty.
 * @param basePath - the referencing layer's base path.
 * @param reference - the `@…@` body as written.
 * @returns the lookup key.
 */
export function referenceKey(basePath, reference) {
  const clean = reference.startsWith('./') ? reference.slice(2) : reference
  return basePath === '' ? clean : `${basePath}/${clean}`
}

/** An `s3://bucket/key` reference body, tolerating OpenUSD's collapsed `s3:/bucket/key` spelling. */
const ASSET_URI = /^s3:\/{1,2}([^/]+)\/(.+)$/

/**
 * Split one object-storage reference.
 * @param reference - the `@…@` body as written in a layer.
 * @returns the bucket, the key, and the canonical URI, or undefined for a non-asset reference.
 */
export function assetUriOf(reference) {
  const match = ASSET_URI.exec(reference)
  if (match === null) return undefined
  const bucket = match[1]
  const key = match[2]
  if (key === '') return undefined
  return { bucket, key, uri: `s3://${bucket}/${key}` }
}

/**
 * The directory one asset URI lives in, with a trailing slash.
 * @param uri - a canonical `s3://bucket/key` URI.
 * @returns the directory prefix.
 */
export function assetBaseOf(uri) {
  const slash = uri.lastIndexOf('/')
  return slash <= 's3://'.length ? `s3://${uri.slice('s3://'.length)}/` : uri.slice(0, slash + 1)
}

/**
 * Resolve a reference written inside an asset layer against that layer's directory.
 *
 * An asset layer is located by URI, not by a workspace path, so its relative
 * references resolve in the same URI space instead of against the workspace.
 * @param base - the referencing layer's asset base (see {@link assetBaseOf}).
 * @param reference - the `@…@` body as written.
 * @returns the canonical absolute URI.
 */
export function resolveAssetReference(base, reference) {
  const clean = reference.startsWith('./') ? reference.slice(2) : reference
  const prefix = 's3://'
  const afterScheme = base.startsWith(prefix) ? base.slice(prefix.length) : base
  const bucketEnd = afterScheme.indexOf('/')
  const bucket = bucketEnd < 0 ? afterScheme : afterScheme.slice(0, bucketEnd)
  const directory = bucketEnd < 0 ? '' : afterScheme.slice(bucketEnd + 1)
  return `s3://${bucket}/${normalizePosix(`${directory}${clean}`)}`
}
