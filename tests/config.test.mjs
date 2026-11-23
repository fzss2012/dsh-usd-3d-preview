/**
 * Host-half suite: the connection the sidebar saves, on disk, offline.
 *
 * The page's Connect panel used to keep its key pair in memory only. What makes
 * the saved version trustworthy is the order of operations in the route, so this
 * suite checks them one by one: validation before anything is written, a real
 * signed listing before the file is written, the environment outranking the file,
 * and a read route that never returns the secret or a local path. `fetch` is
 * stubbed and every file lives under a temporary `DSH_HOME`, so no network is
 * touched and no real configuration is read.
 *
 * Run: node tests/config.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CONFIG_VERSION,
  clearObjectStoreConfig,
  normalizeEndpoint,
  normalizeObjectStoreConfig,
  objectStoreConfigPath,
  readObjectStoreConfig,
  safeObjectStoreConfig,
  storedLibrary,
  writeObjectStoreConfig,
} from '../src/host/config.js'
import { probeLibrary } from '../src/host/s3.js'

const lines = []
function say(line) {
  lines.push(line)
  process.stdout.write(line + '\n')
}

const S3_VARIABLES = [
  'DSH_USD_S3_ENDPOINT',
  'DSH_USD_S3_BUCKET',
  'DSH_USD_S3_REGION',
  'DSH_USD_S3_ACCESS_KEY',
  'DSH_USD_S3_SECRET_KEY',
  'DSH_USD_S3_ROOT_PREFIX',
]

/**
 * Run one callback with `DSH_HOME` pointed at one directory and no S3 variables.
 * The path helpers read this at call time, so it has to stay set throughout.
 * @param home - the temporary home directory.
 * @param callback - the work to run.
 * @returns the callback's value.
 */
async function withHome(home, callback) {
  const saved = new Map([['DSH_HOME', process.env.DSH_HOME], ...S3_VARIABLES.map(name => [name, process.env[name]])])
  try {
    process.env.DSH_HOME = home
    for (const name of S3_VARIABLES) delete process.env[name]
    return await callback()
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

/**
 * Run one callback with the S3 environment variables set to a fixed map.
 * @param values - the variables to set; everything else is cleared.
 * @param callback - the work to run.
 * @returns the callback's value.
 */
async function withEnvironment(values, callback) {
  const saved = new Map(S3_VARIABLES.map(name => [name, process.env[name]]))
  try {
    for (const name of S3_VARIABLES) {
      if (values[name] === undefined) delete process.env[name]
      else process.env[name] = values[name]
    }
    return await callback()
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

/** One sample connection, exactly as the panel submits it. */
const SAMPLE = {
  endpoint: 'https://s3.example.com/',
  bucket: 'asset',
  region: 'us-east-1',
  rootPrefix: 'L0/',
  accessKey: 'AKIAEXAMPLE',
  secretKey: 'supersecret',
}

// ── validation: one shape, stable error codes ───────────────────────────────

assert.equal(normalizeEndpoint('https://s3.example.com/'), 'https://s3.example.com', 'a trailing slash is dropped')
assert.equal(normalizeEndpoint(' http://127.0.0.1:9000 '), 'http://127.0.0.1:9000', 'a plain http endpoint is accepted')
assert.equal(normalizeEndpoint('ftp://s3.example.com'), undefined, 'a non-http scheme is refused')
assert.equal(normalizeEndpoint('not a url'), undefined, 'garbage is refused')
assert.equal(normalizeEndpoint(undefined), undefined, 'a missing endpoint is refused')

{
  const good = normalizeObjectStoreConfig(SAMPLE, undefined)
  assert.deepEqual(good.config, {
    version: CONFIG_VERSION,
    endpoint: 'https://s3.example.com',
    bucket: 'asset',
    region: 'us-east-1',
    rootPrefix: 'L0/',
    accessKey: 'AKIAEXAMPLE',
    secretKey: 'supersecret',
  }, 'a complete connection is normalized into the stored shape')

  assert.equal(normalizeObjectStoreConfig({ ...SAMPLE, endpoint: 'nope' }).error, 'invalid-endpoint')
  assert.equal(normalizeObjectStoreConfig({ ...SAMPLE, bucket: 'bad name!' }).error, 'invalid-bucket')
  assert.equal(normalizeObjectStoreConfig({ ...SAMPLE, accessKey: '' }).error, 'missing-keys')
  assert.equal(normalizeObjectStoreConfig({ ...SAMPLE, secretKey: '' }).error, 'missing-keys', 'an empty secret without a stored one is refused')

  const edited = normalizeObjectStoreConfig(
    { ...SAMPLE, bucket: 'other', secretKey: '' },
    { ...good.config },
  )
  assert.equal(edited.config.bucket, 'other', 'an edit applies the new bucket')
  assert.equal(edited.config.secretKey, 'supersecret', 'a blank secret keeps the stored one')

  const defaults = normalizeObjectStoreConfig(
    { endpoint: 'https://s3.example.com', accessKey: 'a', secretKey: 'b', rootPrefix: 's3://asset/Component' },
    undefined,
  ).config
  assert.equal(defaults.bucket, 'asset', 'a missing bucket falls back to the default')
  assert.equal(defaults.region, 'us-east-1', 'a missing region falls back to the default')
  assert.equal(defaults.rootPrefix, 'Component/', 'the root prefix is normalized like the environment one')

  assert.deepEqual(safeObjectStoreConfig(good.config), {
    endpoint: 'https://s3.example.com',
    bucket: 'asset',
    region: 'us-east-1',
    rootPrefix: 'L0/',
    accessKey: 'AKIAEXAMPLE',
    hasSecret: true,
  }, 'the page-facing shape carries no secret')
  assert.equal(safeObjectStoreConfig(undefined), null, 'nothing stored is reported as null')
}
say('config validation    endpoint/bucket/keys, secret reuse, defaults, safe shape')

// ── the file: round trip, permissions, tolerance ────────────────────────────

const home = await mkdtemp(join(tmpdir(), 'dsh-usd-config-'))
try {
  await withHome(home, async () => {
    const path = objectStoreConfigPath()
    assert.ok(path.startsWith(home), 'the file lives under DSH_HOME')
    assert.equal(await readObjectStoreConfig(), undefined, 'a missing file is an unconfigured library')
    assert.equal(await storedLibrary(), undefined, 'and it resolves no library')

    const { config } = normalizeObjectStoreConfig(SAMPLE, undefined)
    await writeObjectStoreConfig(config)
    assert.equal(existsSync(path), true, 'the connection is written')
    const stored = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(stored.endpoint, 'https://s3.example.com')
    assert.equal(stored.secretKey, 'supersecret', 'the secret is what the host signs with, so it is stored')
    if (process.platform !== 'win32') {
      const mode = (await stat(path)).mode & 0o777
      assert.equal(mode, 0o600, 'the file holds a secret, so it is owner-read/write only')
    }

    const reread = await readObjectStoreConfig()
    assert.deepEqual(reread, config, 'what was written is read back')
    const library = await storedLibrary()
    assert.equal(library.source, 'config-file', 'the stored connection reports where it came from')
    assert.equal(library.bucket, 'asset')

    // A malformed or incomplete file is "nothing configured", never a half library.
    await writeFile(path, '{ this is not json')
    assert.equal(await readObjectStoreConfig(), undefined, 'malformed JSON is ignored')
    await writeFile(path, JSON.stringify({ endpoint: 'https://s3.example.com', bucket: 'asset' }))
    assert.equal(await readObjectStoreConfig(), undefined, 'a file without credentials is ignored')

    await clearObjectStoreConfig()
    assert.equal(existsSync(path), false, 'clearing removes the file')
    await clearObjectStoreConfig()
    assert.equal(await readObjectStoreConfig(), undefined, 'clearing twice is not an error')
  })
} finally {
  await rm(home, { recursive: true, force: true })
}
say('config file          write, read back, 0600, malformed tolerance, idempotent clear')

// ── the probe: what a candidate connection has to answer ────────────────────

{
  const savedFetch = globalThis.fetch
  const library = { endpoint: 'https://s3.example.com', bucket: 'asset', region: 'us-east-1', accessKey: 'a', secretKey: 'b', rootPrefix: 'L0/' }
  try {
    const seen = []
    globalThis.fetch = async (url, options) => {
      seen.push({ url: String(url), authorization: options?.headers?.authorization })
      return new Response('<ListBucketResult/>', { status: 200 })
    }
    assert.deepEqual(await probeLibrary(library), { ok: true }, 'a listing that answers admits the connection')
    assert.match(seen[0].url, /list-type=2/, 'the probe is a ListObjectsV2 request')
    assert.match(seen[0].url, /prefix=L0%2F/, 'the probe lists the configured root')
    assert.match(seen[0].authorization, /^AWS4-HMAC-SHA256 Credential=a\//, 'the probe is signed with the candidate credentials')

    globalThis.fetch = async () => new Response('', { status: 403 })
    assert.deepEqual(await probeLibrary(library), { ok: false, reason: 'denied' }, 'a 403 is a credential answer')
    globalThis.fetch = async () => new Response('', { status: 404 })
    assert.deepEqual(await probeLibrary(library), { ok: false, reason: 'missing-bucket' }, 'a 404 is a missing bucket')
    globalThis.fetch = async () => new Response('', { status: 500 })
    assert.deepEqual(await probeLibrary(library), { ok: false, reason: 'unreachable' }, 'a server error is a transport answer')
    globalThis.fetch = async () => { throw new TypeError('network down') }
    assert.deepEqual(await probeLibrary(library), { ok: false, reason: 'unreachable' }, 'a network failure is a transport answer too')
  } finally {
    globalThis.fetch = savedFetch
  }
}
say('config probe         signed ListObjectsV2, 403/404/5xx/network mapped')

// ── the route: verify first, write second, environment wins ─────────────────

/**
 * Build one host half against a fake Connection service and a tiny request
 * client. A fresh module instance per call, because the routes resolve the
 * library once.
 * @param tag - unique import tag, so each call gets its own module instance.
 * @returns a request function for the registered routes.
 */
async function mountRoute(tag) {
  const routes = new Map()
  const context = {
    effect: callback => callback(),
    logger: { info() {}, warn() {}, debug() {} },
  }
  const hostHalf = await import(new URL(`../lib/index.js?config-test-${tag}`, import.meta.url).href)
  context.inject = (_dependencies, callback) => callback(context)
  context.connection = {
    fetch: {
      register(route) {
        routes.set(route.path, route)
        return () => undefined
      },
    },
  }
  hostHalf.apply(context, undefined)
  const route = routes.get('/api/usd-preview/objstore/config')
  assert.ok(route !== undefined, 'the connection route is mounted on the /api channel')
  assert.deepEqual(route.methods, ['GET', 'POST'], 'it reads the stored connection and takes explicit actions')
  return async function request(pathname, options = {}) {
    const url = new URL(pathname, 'http://127.0.0.1')
    const handler = routes.get(url.pathname)
    assert.ok(handler !== undefined, `no route registered for ${url.pathname}`)
    const init = { method: options.method ?? 'GET', headers: options.headers ?? {} }
    if (options.body !== undefined) init.body = JSON.stringify(options.body)
    const response = await handler.fetch(new Request(url, init))
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()).toString('utf8'),
    }
  }
}

const routeHome = await mkdtemp(join(tmpdir(), 'dsh-usd-config-route-'))
const savedFetch = globalThis.fetch
try {
  await withHome(routeHome, async () => {
    const request = await mountRoute('save')

    const empty = await request('/api/usd-preview/objstore/config')
    assert.equal(empty.status, 200)
    assert.deepEqual(JSON.parse(empty.body), { ok: true, source: null, config: null },
      'an empty home answers the route without inventing a connection')

    globalThis.fetch = async () => new Response('<ListBucketResult/>', { status: 200 })
    const saved = await request('/api/usd-preview/objstore/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { action: 'save', ...SAMPLE },
    })
    assert.equal(saved.status, 200, 'a verified connection is accepted')
    const savedBody = JSON.parse(saved.body)
    assert.equal(savedBody.ok, true)
    assert.equal(savedBody.source, 'config-file')
    assert.equal(savedBody.config.hasSecret, true, 'the page learns that a secret is stored')
    assert.ok(!saved.body.includes('supersecret'), 'the response never carries the secret')
    assert.ok(!saved.body.includes(routeHome), 'the response never carries a local path')
    assert.equal((await readObjectStoreConfig()).secretKey, 'supersecret', 'the file has the secret the route did not return')

    // The route reset the memoized library, so the other routes now sign with it.
    const health = await request('/api/usd-preview/health')
    assert.deepEqual(JSON.parse(health.body).library, {
      endpoint: 'https://s3.example.com',
      bucket: 'asset',
      rootPrefix: 'L0/',
      source: 'config-file',
    }, 'health reports the saved connection as the effective library')

    globalThis.fetch = async () => new Response(
      '<?xml version="1.0"?><ListBucketResult><IsTruncated>false</IsTruncated>'
      + '<Contents><Key>L0/window.usda</Key><Size>12</Size></Contents></ListBucketResult>',
      { status: 200 },
    )
    const listing = await request('/api/usd-preview/list?prefix=L0%2F')
    assert.equal(listing.status, 200, 'the listing route signs with the saved connection')
    assert.equal(JSON.parse(listing.body).entries[0].key, 'L0/window.usda')

    // Verification runs before the write: a refused listing must not create a file.
    await clearObjectStoreConfig()
    globalThis.fetch = async () => new Response('', { status: 403 })
    const refused = await request('/api/usd-preview/objstore/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { action: 'save', ...SAMPLE },
    })
    assert.equal(refused.status, 502, 'a connection that cannot list is refused')
    assert.equal(JSON.parse(refused.body).error, 'denied', 'and the reason says why')
    assert.equal(existsSync(objectStoreConfigPath()), false, 'nothing is written for a refused connection')

    const invalid = await request('/api/usd-preview/objstore/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { action: 'save', ...SAMPLE, endpoint: 'nope' },
    })
    assert.equal(invalid.status, 400, 'an invalid endpoint is a bad request')
    assert.equal(JSON.parse(invalid.body).error, 'invalid-endpoint')

    const unknown = await request('/api/usd-preview/objstore/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { action: 'delete' },
    })
    assert.equal(unknown.status, 400, 'an unknown action is refused')

    globalThis.fetch = async () => new Response('<ListBucketResult/>', { status: 200 })
    await request('/api/usd-preview/objstore/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { action: 'save', ...SAMPLE },
    })
    assert.equal(existsSync(objectStoreConfigPath()), true, 'a verified save lands')
    const cleared = await request('/api/usd-preview/objstore/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: { action: 'clear' },
    })
    assert.equal(cleared.status, 200)
    assert.deepEqual(JSON.parse(cleared.body), { ok: true, source: null, config: null })
    assert.equal(existsSync(objectStoreConfigPath()), false, 'clear removes the file')
    const healthAfter = await request('/api/usd-preview/health')
    assert.equal(JSON.parse(healthAfter.body).library, null, 'and the host stops reporting a library')
  })

  // The environment is authoritative: a page save must not replace it.
  // (The home wrapper clears the S3 variables, so the environment wrapper is the
  // inner one: the outer call would otherwise delete what the inner one sets.)
  await withHome(routeHome, async () => {
    await withEnvironment({
      DSH_USD_S3_ENDPOINT: 'https://env.example.com',
      DSH_USD_S3_ACCESS_KEY: 'AKIAENV',
      DSH_USD_S3_SECRET_KEY: 'envsecret',
    }, async () => {
      const request = await mountRoute('environment')
      globalThis.fetch = async () => new Response('<ListBucketResult/>', { status: 200 })
      const locked = await request('/api/usd-preview/objstore/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: { action: 'save', ...SAMPLE },
      })
      assert.equal(locked.status, 409, 'a page save is refused while the environment names a library')
      assert.equal(JSON.parse(locked.body).error, 'environment-config')
      assert.equal(existsSync(objectStoreConfigPath()), false, 'and it writes nothing')

      const health = await request('/api/usd-preview/health')
      assert.equal(JSON.parse(health.body).library.source, 'environment', 'the environment library stays effective')
    })
  })
} finally {
  globalThis.fetch = savedFetch
  await rm(routeHome, { recursive: true, force: true })
}
say('config route         verify-then-write, 400/409/502, clear, environment precedence')

process.stdout.write('config.test.mjs  OK\n')
