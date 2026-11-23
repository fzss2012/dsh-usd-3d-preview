/**
 * The object-storage connection the sidebar saves, on disk.
 *
 * The Connect panel used to keep an endpoint, a bucket and a key pair in the
 * page only, so every reload started from nothing and the same connection had to
 * be typed again. This module is the file side of that panel: one JSON document
 * under the deployment's state directory, read at startup and rewritten when the
 * page saves a connection.
 *
 *   ${DSH_HOME:-~/.dsh}/usd-3d-preview/object-store.json   (mode 0600)
 *
 * The file holds a secret access key, so it is created owner-read/write only and
 * is never logged or reported back to the page: the page's read route returns the
 * non-secret half (`hasSecret` instead of the secret) and never an absolute path.
 *
 * Environment variables stay authoritative. `DSH_USD_S3_*` describes what the
 * *deployment* reads; this file only fills the gap when the deployment names no
 * library at all, so an operator cannot be silently overridden from a browser.
 */
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { normalizeRootPrefix } from './s3.js'

/** Shape version of the file, so a future change can recognize what it reads. */
export const CONFIG_VERSION = 1

/** A bucket name this plugin will sign for: no slash, no whitespace, no escapes. */
const BUCKET_PATTERN = /^[A-Za-z0-9._-]+$/

/**
 * Normalize an endpoint the user typed: absolute, http(s), no trailing slash.
 * @param value - the endpoint field.
 * @returns the normalized URL, or undefined when it is not an http(s) address.
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
 * Where the saved connection lives.
 * @returns an absolute path under `DSH_HOME` (or `~/.dsh`).
 */
export function objectStoreConfigPath() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'usd-3d-preview', 'object-store.json')
}

/**
 * Validate one submitted connection into the shape this module stores.
 *
 * A secret left blank keeps the one already on disk, so editing a bucket or a
 * prefix does not require retyping the key. Everything else is required: a
 * connection without both halves of the key pair cannot sign anything.
 * @param input - the page's submitted fields.
 * @param existing - the connection currently on disk, when there is one.
 * @returns `{ config }` on success, or `{ error }` with a stable code
 * ('invalid-endpoint' | 'invalid-bucket' | 'missing-keys').
 */
export function normalizeObjectStoreConfig(input, existing) {
  const raw = input !== null && typeof input === 'object' ? input : {}
  const endpoint = normalizeEndpoint(raw.endpoint)
  if (endpoint === undefined) return { error: 'invalid-endpoint' }
  const bucket = String(raw.bucket ?? '').trim() || 'asset'
  if (!BUCKET_PATTERN.test(bucket)) return { error: 'invalid-bucket' }
  const region = String(raw.region ?? '').trim() || 'us-east-1'
  const accessKey = String(raw.accessKey ?? '').trim()
  const typedSecret = String(raw.secretKey ?? '').trim()
  const secretKey = typedSecret !== '' ? typedSecret : String(existing?.secretKey ?? '')
  if (accessKey === '' || secretKey === '') return { error: 'missing-keys' }
  return {
    config: {
      version: CONFIG_VERSION,
      endpoint,
      bucket,
      region,
      rootPrefix: normalizeRootPrefix(raw.rootPrefix),
      accessKey,
      secretKey,
    },
  }
}

/**
 * The connection saved on disk, if any.
 *
 * A missing file, an unreadable one and a malformed one are the same answer:
 * nothing is configured. A partial file must never become a half library.
 * @returns the stored connection, or undefined.
 */
export async function readObjectStoreConfig() {
  let text
  try {
    text = await readFile(objectStoreConfigPath(), 'utf8')
  } catch {
    return undefined
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const { config } = normalizeObjectStoreConfig(parsed, undefined)
  return config
}

/**
 * The stored connection as a library the signing helpers accept.
 * @returns a library with `source: 'config-file'`, or undefined when unset.
 */
export async function storedLibrary() {
  const config = await readObjectStoreConfig()
  if (config === undefined) return undefined
  const { endpoint, bucket, region, accessKey, secretKey, rootPrefix } = config
  return { endpoint, bucket, region, accessKey, secretKey, rootPrefix, source: 'config-file' }
}

/**
 * Persist one validated connection.
 *
 * Written through a temporary file and renamed into place, so a crash or a full
 * disk cannot leave a truncated file that reads as "misconfigured". The mode is
 * set on the temporary file (the rename keeps it) and re-asserted afterwards,
 * because a permissive umask must not widen a file that holds a secret.
 * @param config - a config from {@link normalizeObjectStoreConfig}.
 * @returns the connection that was written.
 */
export async function writeObjectStoreConfig(config) {
  const path = objectStoreConfigPath()
  await mkdir(dirname(path), { recursive: true })
  const temporary = path + '.tmp'
  await writeFile(temporary, JSON.stringify(config, undefined, 2) + '\n', { encoding: 'utf8', mode: 0o600 })
  await rename(temporary, path)
  await chmod(path, 0o600).catch(() => undefined)
  return config
}

/**
 * Forget the saved connection.
 *
 * A missing file is the state this is asked for, so it is not an error.
 * @returns undefined.
 */
export async function clearObjectStoreConfig() {
  await unlink(objectStoreConfigPath()).catch(() => undefined)
  return undefined
}

/**
 * The non-secret half of one stored connection, for the page.
 * @param config - the stored connection, or undefined.
 * @returns the fields the page may render, or null when nothing is stored.
 */
export function safeObjectStoreConfig(config) {
  if (config === undefined || config === null) return null
  const { endpoint, bucket, region, rootPrefix, accessKey, secretKey } = config
  return {
    endpoint,
    bucket,
    region,
    rootPrefix,
    accessKey,
    hasSecret: typeof secretKey === 'string' && secretKey !== '',
  }
}
