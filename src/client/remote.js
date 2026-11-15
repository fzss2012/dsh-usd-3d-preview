/**
 * Posix-shaped paths for stages opened by address (s3:// or http(s)).
 *
 * The engine composes an address-opened stage inside its package namespace, the
 * same way it composes a workspace file: the root layer is registered under
 * rootKey, and every reference is reported relative to the directory of the
 * layer that names it. These helpers keep that namespace in one canonical form,
 * so one engine-reported path maps back to the object key or URL the reader has
 * to fetch -- without ever escaping the package root.
 */

/**
 * Collapse "." and ".." segments and leading slashes into one posix key.
 * A ".." at the root is dropped, because the package has no directory above it.
 * @param path - a key, a relative path or a URL pathname.
 * @returns the normalized key ("" for the root).
 */
export function normalizePath(path) {
  const output = []
  for (const segment of String(path ?? '').split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      output.pop()
      continue
    }
    output.push(segment)
  }
  return output.join('/')
}

/**
 * Directory part of one posix key, without its trailing separator.
 * @param path - a key.
 * @returns the directory ("" when the key has no separator).
 */
export function dirOf(path) {
  const text = String(path ?? '')
  const slash = text.lastIndexOf('/')
  return slash < 0 ? '' : text.slice(0, slash)
}

/**
 * Final segment of one posix key or URL path.
 * @param path - a key or pathname.
 * @returns the last segment.
 */
export function baseName(path) {
  const text = String(path ?? '').replace(/\/+$/, '')
  const slash = text.lastIndexOf('/')
  return slash < 0 ? text : text.slice(slash + 1)
}

/**
 * Resolve one engine-reported layer path against a package directory.
 *
 * A path starting with "/" is package-absolute and is used as it is; anything
 * else is relative to the directory of the layer that named it.
 * @param baseDir - directory of the naming layer ("" for the package root).
 * @param path - the path the engine reported.
 * @returns the normalized package key.
 */
export function resolvePath(baseDir, path) {
  const text = String(path ?? '')
  if (text.startsWith('/')) return normalizePath(text)
  return normalizePath(`${baseDir}/${text}`)
}

/**
 * Object key of one s3://bucket/key URI.
 * @param uri - an s3:// URI.
 * @returns the normalized key, or undefined when the URI is not s3://.
 */
export function s3KeyOf(uri) {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(String(uri ?? '').trim())
  return match === null ? undefined : normalizePath(match[2])
}
