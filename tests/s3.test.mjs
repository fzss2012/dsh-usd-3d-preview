/**
 * Host-half suite: environment configuration, key validation, and the signed
 * asset read, offline.
 *
 * The browser suites prove the `s3://` path end to end only when a real asset
 * library is configured; this suite covers the half below that: the environment
 * variables that describe the library, the URI validation that keeps a layer out
 * of arbitrary keys, the SigV4-signed GET, the memory and disk caches, and the
 * not-found/forbidden/error mapping the route reports. `fetch` is stubbed, so no
 * network is touched and no credentials are real.
 *
 * Run: node tests/s3.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_ASSET_BYTES, storageLibrary, keyOf, readAsset, defaultAssetCacheDir } from '../src/host/s3.js'

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
]

/** Run a callback with the S3 environment variables set to a fixed map. */
async function withEnvironment(values, callback) {
  const saved = new Map(S3_VARIABLES.map(name => [name, process.env[name]]))
  try {
    for (const name of S3_VARIABLES) {
      if (values[name] === undefined) delete process.env[name]
      else process.env[name] = values[name]
    }
    return await callback()
  } finally {
    for (const name of S3_VARIABLES) {
      const value = saved.get(name)
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

// ── environment configuration ───────────────────────────────────────────────

await withEnvironment({}, async () => {
  assert.equal(await storageLibrary(), undefined, 'an unconfigured library must resolve to undefined')
})
await withEnvironment({ DSH_USD_S3_ENDPOINT: 'https://s3.example.com' }, async () => {
  assert.equal(await storageLibrary(), undefined, 'an endpoint without credentials must resolve to undefined')
})
await withEnvironment({
  DSH_USD_S3_ENDPOINT: 'https://s3.example.com/',
  DSH_USD_S3_ACCESS_KEY: 'AKIAEXAMPLE',
  DSH_USD_S3_SECRET_KEY: 'secret',
}, async () => {
  const library = await storageLibrary()
  assert.ok(library !== undefined, 'a complete environment must resolve a library')
  assert.equal(library.endpoint, 'https://s3.example.com', 'the endpoint keeps no trailing slash')
  assert.equal(library.bucket, 'asset', 'the bucket defaults to "asset"')
  assert.equal(library.region, 'us-east-1', 'the region defaults to us-east-1')
  assert.equal(library.accessKey, 'AKIAEXAMPLE')
  assert.equal(library.secretKey, 'secret')
  assert.equal(library.source, 'environment', 'the credentials are reported as coming from the environment')
  say('environment            complete DSH_USD_S3_* resolves; defaults bucket=asset region=us-east-1')
})
await withEnvironment({
  DSH_USD_S3_ENDPOINT: '  https://s3.example.com  ',
  DSH_USD_S3_BUCKET: '  geometry  ',
  DSH_USD_S3_REGION: '  eu-west-2  ',
  DSH_USD_S3_ACCESS_KEY: ' key ',
  DSH_USD_S3_SECRET_KEY: ' secret ',
}, async () => {
  const library = await storageLibrary()
  assert.equal(library.endpoint, 'https://s3.example.com', 'the endpoint is trimmed')
  assert.equal(library.bucket, 'geometry', 'the bucket is trimmed')
  assert.equal(library.region, 'eu-west-2', 'the region is trimmed')
  assert.equal(library.accessKey, 'key')
  assert.equal(library.secretKey, 'secret')
  say('environment            values are trimmed; bucket/region overrides honoured')
})

// ── key validation ──────────────────────────────────────────────────────────

const library = {
  endpoint: 'https://s3.example.com',
  bucket: 'asset',
  region: 'us-east-1',
  accessKey: 'AKIAEXAMPLE',
  secretKey: 'secret',
}
assert.equal(keyOf('s3://asset/L1/unit.usda', library), 'L1/unit.usda', 'a matching bucket yields its key')
assert.equal(keyOf('s3://other/L1/unit.usda', library), undefined, 'a foreign bucket yields no key')
assert.equal(keyOf('s3://asset/L1/unit.usda', undefined), 'L1/unit.usda', 'without a configured bucket any s3 key is usable')
assert.equal(keyOf('https://example.com/unit.usda', library), undefined, 'a non-s3 URI yields no key')
assert.equal(keyOf('s3://asset/', library), undefined, 'an empty key is refused')
assert.equal(keyOf('s3://asset/a/../b.usda', library), undefined, 'a parent segment is refused')
assert.equal(keyOf('s3://asset/a/./b.usda', library), undefined, 'a current-directory segment is refused')
assert.equal(keyOf('s3://asset/a\\b.usda', library), undefined, 'a backslash is refused (it is a path separator on some platforms)')
assert.equal(keyOf('s3://asset/a\u0000b.usda', library), undefined, 'a control character is refused')
say('key validation         bucket match, traversal/backslash/control refusal')

// ── default cache directory ─────────────────────────────────────────────────

const savedHome = process.env.DSH_HOME
try {
  process.env.DSH_HOME = '/tmp/dsh-home-example'
  assert.equal(defaultAssetCacheDir(), join('/tmp/dsh-home-example', 'cache', 'usd-assets'))
  delete process.env.DSH_HOME
  assert.equal(defaultAssetCacheDir(), join(homedir(), '.dsh', 'cache', 'usd-assets'))
} finally {
  if (savedHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = savedHome
}
say('cache directory        DSH_HOME/cache/usd-assets, else ~/.dsh/cache/usd-assets')

// ── readAsset: signed GET, memory and disk caches, status mapping ───────────

const cacheDir = await mkdtemp(join(tmpdir(), 'dsh-usd-s3-'))
const realFetch = globalThis.fetch
const payload = new TextEncoder().encode('#usda 1.0\n')
const requests = []
/** Stub fetch for one read: record the request and answer with a Response. */
function stubFetch(response) {
  requests.length = 0
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options })
    return response()
  }
}

try {
  stubFetch(() => new Response(payload, { status: 200 }))
  const first = await readAsset(library, 's3://asset/scene/unit.usda', cacheDir)
  assert.ok(first !== undefined, 'a 200 response yields the object bytes')
  assert.equal(first.source, 'remote', 'the first read comes from the remote service')
  assert.deepEqual(new Uint8Array(first.data), payload, 'the bytes are returned verbatim')
  assert.equal(requests.length, 1, 'a cold read issues one request')
  assert.equal(requests[0].url, 'https://s3.example.com/asset/scene/unit.usda', 'the URL joins endpoint, bucket and key')
  assert.equal(requests[0].options.headers['x-amz-content-sha256'].length, 64, 'the empty payload is signed')
  assert.match(requests[0].options.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\//, 'the GET is SigV4-signed')
  assert.match(requests[0].options.headers.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date/, 'the signed headers are named')
  assert.match(requests[0].options.headers['x-amz-date'], /^\d{8}T\d{6}Z$/, 'the request carries an amz date')

  // Cached bytes are on disk under cacheDir/<bucket>/<key>, and a fresh module
  // instance (no memory cache) reads them back without touching the network.
  assert.deepEqual(new Uint8Array(await readFile(join(cacheDir, 'asset', 'scene', 'unit.usda'))), payload)
  const cold = await import(new URL('../src/host/s3.js?disk-cache-only', import.meta.url).href)
  const fromDisk = await cold.readAsset(library, 's3://asset/scene/unit.usda', cacheDir)
  assert.ok(fromDisk !== undefined, 'the disk cache answers the second read')
  assert.equal(fromDisk.source, 'cache', 'a warm disk cache is reported as cache')
  assert.deepEqual(new Uint8Array(fromDisk.data), payload)

  // The in-process memo answers before the disk is even touched.
  stubFetch(() => { throw new Error('the memory cache must not fetch') })
  const again = await readAsset(library, 's3://asset/scene/unit.usda', cacheDir)
  assert.equal(again.source, 'memory', 'the second read in the same process comes from memory')
} finally {
  globalThis.fetch = realFetch
}

// Status mapping: a missing or forbidden object is "no bytes", anything else throws.
stubFetch(() => new Response('', { status: 404 }))
assert.equal(await readAsset(library, 's3://asset/scene/missing.usda', cacheDir), undefined, '404 yields undefined')
stubFetch(() => new Response('', { status: 403 }))
assert.equal(await readAsset(library, 's3://asset/scene/forbidden.usda', cacheDir), undefined, '403 yields undefined')
stubFetch(() => new Response('', { status: 500 }))
await assert.rejects(
  readAsset(library, 's3://asset/scene/broken.usda', cacheDir),
  /asset read failed \(HTTP 500\)/,
  'a server error rejects without buffering a body',
)
// One object above the byte cap refuses before its body is buffered.
stubFetch(() => new Response('', { status: 200, headers: { 'content-length': String(MAX_ASSET_BYTES + 1) } }))
await assert.rejects(
  readAsset(library, 's3://asset/scene/huge.usda', cacheDir),
  error => error?.name === 'AssetTooLargeError',
  'an object above the byte cap is refused, not buffered',
)

// A URI outside the configured bucket resolves to undefined before any fetch.
stubFetch(() => { throw new Error('an unreadable URI must not fetch') })
assert.equal(await readAsset(library, 's3://other/scene/unit.usda', cacheDir), undefined)
globalThis.fetch = realFetch
say('readAsset              signed GET, disk/memory caches, 404/403 -> undefined, 500 -> throws')


await rm(cacheDir, { recursive: true, force: true })

// ── the host route: exact Fetch routes on the /api trust fence ──────────────

/**
 * Build one host half against a fake Connection service and return a tiny
 * request client. A fresh module instance per call, because the routes resolve
 * the library once. The fake exposes only `connection.fetch.register`, so an
 * implementation that still needs a raw web route cannot mount at all.
 */
async function mountRoute({ tag, home }) {
  const savedHome = process.env.DSH_HOME
  if (home !== undefined) process.env.DSH_HOME = home
  const routes = new Map()
  const context = {
    effect: callback => callback(),
    logger: { info() {}, warn() {}, debug() {} },
  }
  try {
    const hostHalf = await import(new URL(`../lib/index.js?route-test-${tag}`, import.meta.url).href)
    context.inject = (_dependencies, callback) => callback(context)
    context.connection = {
      fetch: {
        register(route) {
          routes.set(route.path, route)
          return async () => undefined
        },
      },
    }
    hostHalf.apply(context, undefined)
  } finally {
    if (savedHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = savedHome
  }
  assert.equal(routes.size, 2, 'the host half registered two routes')
  assert.ok(routes.has('/api/usd-preview/asset'), 'the asset route lives on the /api trust-fenced channel')
  assert.ok(routes.has('/api/usd-preview/health'), 'the health route lives on the /api trust-fenced channel')
  for (const route of routes.values()) {
    assert.deepEqual(route.methods, ['GET'], 'the host routes are read-only')
    assert.equal(route.requestBody, 'buffered', 'a GET route buffers no request body')
    assert.equal(typeof route.fetch, 'function', 'the route is a Fetch handler')
  }
  /** Send one fake Fetch request through a registered route and collect its answer. */
  return async function request(pathname, { method = 'GET', headers = {} } = {}) {
    const url = new URL(pathname, 'http://127.0.0.1')
    const handler = routes.get(url.pathname)
    assert.ok(handler !== undefined, `no route registered for ${url.pathname}`)
    const response = await handler.fetch(new Request(url, { method, headers }))
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()).toString('utf8'),
    }
  }
}

// Unconfigured: health says so, and URI validation answers before any read.
await withEnvironment({}, async () => {
  const routeHome = await mkdtemp(join(tmpdir(), 'dsh-usd-route-'))
  const request = await mountRoute({ tag: 'unconfigured', home: routeHome })
  try {
    const health = await request('/api/usd-preview/health')
    assert.equal(health.status, 200, 'health answers without a configured library')
    const body = JSON.parse(health.body)
    assert.equal(body.ok, true)
    assert.equal(body.library, null, 'health reports no library when the environment is empty')
    assert.ok(!('cacheDir' in body), 'health never reports an absolute machine path')

    const noUri = await request('/api/usd-preview/asset')
    assert.equal(noUri.status, 400, 'the asset route requires a URI')
    const notS3 = await request('/api/usd-preview/asset?uri=' + encodeURIComponent('https://example.com/a.usda'))
    assert.equal(notS3.status, 400, 'the asset route only accepts s3:// URIs')
    const unconfigured = await request('/api/usd-preview/asset?uri=' + encodeURIComponent('s3://asset/a.usda'))
    assert.equal(unconfigured.status, 503, 'an unconfigured library answers 503')
    assert.match(JSON.parse(unconfigured.body).error, /DSH_USD_S3_ENDPOINT/, 'the 503 names the variables to set')
    say('host route             /api Fetch routes, health, 400 URI, 503 unconfigured, no cacheDir leak')
  } finally {
    await rm(routeHome, { recursive: true, force: true })
  }
})

// Configured: health reports the non-secret half and the asset route serves the
// signed read through the stubbed fetch.
await withEnvironment({
  DSH_USD_S3_ENDPOINT: 'https://s3.example.com',
  DSH_USD_S3_ACCESS_KEY: 'AKIAEXAMPLE',
  DSH_USD_S3_SECRET_KEY: 'secret',
}, async () => {
  const routeHome = await mkdtemp(join(tmpdir(), 'dsh-usd-route-'))
  const routeCache = join(routeHome, 'cache', 'usd-assets')
  const request = await mountRoute({ tag: 'configured', home: routeHome })
  const savedFetch = globalThis.fetch
  try {
    const health = await request('/api/usd-preview/health')
    const healthBody = JSON.parse(health.body)
    assert.deepEqual(healthBody.library, {
      endpoint: 'https://s3.example.com',
      bucket: 'asset',
      source: 'environment',
    }, 'health reports the endpoint/bucket/source but never the credentials')

    globalThis.fetch = async () => new Response(new TextEncoder().encode('#usda 1.0\n'), { status: 200 })
    const asset = await request('/api/usd-preview/asset?uri=' + encodeURIComponent('s3://asset/a/b.usda'))
    assert.equal(asset.status, 200, 'a configured library serves the asset')
    assert.equal(asset.headers['content-type'], 'application/octet-stream')
    assert.equal(asset.body, '#usda 1.0\n', 'the route returns the object bytes')
    assert.equal(asset.headers['x-dsh-usd-preview-source'], 'remote', 'the response reports where the bytes came from')
    assert.deepEqual(new Uint8Array(await readFile(join(routeCache, 'asset', 'a', 'b.usda'))), new TextEncoder().encode('#usda 1.0\n'))

    globalThis.fetch = async () => new Response('', {
      status: 200,
      headers: { 'content-length': String(MAX_ASSET_BYTES + 1) },
    })
    const huge = await request('/api/usd-preview/asset?uri=' + encodeURIComponent('s3://asset/a/huge.usda'))
    assert.equal(huge.status, 413, 'an object above the byte cap answers 413 instead of buffering')

    globalThis.fetch = async () => new Response('', { status: 500 })
    const broken = await request('/api/usd-preview/asset?uri=' + encodeURIComponent('s3://asset/a/broken.usda'))
    assert.equal(broken.status, 502, 'an upstream failure answers 502')
    assert.equal(JSON.parse(broken.body).error, 'asset read failed', 'an upstream failure never leaks the internal error')
    say('host route asset       signed read served end to end, 413 cap, 502 upstream, no error leak')
  } finally {
    globalThis.fetch = savedFetch
    await rm(routeHome, { recursive: true, force: true })
  }
})

say('s3.test.mjs  OK')
