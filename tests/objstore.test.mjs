/**
 * Object-storage client suite: the address-open descriptor and the sidebar's
 * request helpers, offline.
 *
 * The browser suites prove the object-storage page end to end only against a
 * live gateway. This suite covers the half below that: the posix-path helpers
 * that map engine references to object keys, the list/search request shape and
 * its short-lived cache (including the abort case that must not poison another
 * caller), bucket-correct s3:// URIs, and the address-open descriptor for
 * s3:// and http(s) stages -- root bytes plus the readers the engine calls, the
 * host-route/gateway fallback, and the error mapping. fetch is stubbed, so no
 * network is touched.
 *
 * Run: node tests/objstore.test.mjs
 */
import assert from 'node:assert/strict'
import { baseName, dirOf, normalizePath, resolvePath, s3KeyOf } from '../src/client/remote.js'
import {
  encodeKey,
  fetchObjectBytes,
  formatBytes,
  formatDate,
  isUsdKey,
  listPrefix,
  publicAssetUrl,
  s3Uri,
  searchFiles,
} from '../src/client/objstore.js'

const lines = []
function say(line) {
  lines.push(line)
  process.stdout.write(line + '\n')
}

const savedFetch = globalThis.fetch
const decoder = new TextDecoder()

/** One 200 JSON response. */
const jsonResponse = body => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

/** One 200 byte response. */
const bytesResponse = text => new Response(new TextEncoder().encode(text), { status: 200 })

/** One empty error response. */
const errorResponse = status => new Response('', { status })

/** Decode a Uint8Array as UTF-8. */
const textOf = bytes => decoder.decode(bytes)

/**
 * Stub fetch for the duration of one callback; every request URL is recorded.
 * @param handler - answers one recorded request.
 * @param callback - the work to run against the stub.
 * @returns the callback's value.
 */
async function withFetch(handler, callback) {
  const requests = []
  globalThis.fetch = async (url, options) => {
    const request = { url: String(url), options }
    requests.push(request)
    return await handler(request)
  }
  try {
    return await callback(requests)
  } finally {
    globalThis.fetch = savedFetch
  }
}

/** Resolve after one macrotask, so an abort can race an in-flight request. */
const tick = () => new Promise(resolve => setTimeout(resolve, 5))

// ── path helpers: engine keys back to object keys ───────────────────────────

assert.equal(normalizePath('/a//b/./c/../d'), 'a/b/d', 'normalisation collapses duplicate and relative segments')
assert.equal(normalizePath('../../escape'), 'escape', 'a ".." above the root cannot escape the package')
assert.equal(dirOf('a/b/c.usda'), 'a/b', 'dirOf strips the final segment')
assert.equal(dirOf('c.usda'), '', 'a key without a separator has an empty directory')
assert.equal(baseName('a/b/c.usda'), 'c.usda', 'baseName keeps the final segment')
assert.equal(baseName('a/b/'), 'b', 'baseName ignores trailing separators')
assert.equal(resolvePath('a/b', 'c/d.usda'), 'a/b/c/d.usda', 'a relative reference resolves against its directory')
assert.equal(resolvePath('a/b', '../c.usda'), 'a/c.usda', 'a parent reference normalises')
assert.equal(resolvePath('a/b', '/root/c.usda'), 'root/c.usda', 'a package-absolute reference ignores the directory')
assert.equal(s3KeyOf('s3://bucket/a b/c.usda'), 'a b/c.usda', 'the s3 key survives spaces')
assert.equal(s3KeyOf('not-s3'), undefined, 'a non-s3 URI has no key')
say('objstore paths       normalisation, directory/base, relative resolution, s3 keys')

// ── formatting helpers ─────────────────────────────────────────────────────

assert.equal(encodeKey('a b/c d.usda'), 'a%20b/c%20d.usda', 'each key segment is encoded, separators are not')
assert.equal(isUsdKey('model.USDA'), true, 'USD suffix detection is case-insensitive')
assert.equal(isUsdKey('texture.png'), false, 'a non-USD suffix is not a stage')
assert.equal(s3Uri('my-bucket', 'a/b.usda'), 's3://my-bucket/a/b.usda', 'the URI names the bucket the listing reported')
assert.equal(s3Uri('', 'x.usda'), 's3://asset/x.usda', 'an empty bucket falls back to the default')
assert.equal(publicAssetUrl('a b.usda'), '/usd-asset/a%20b.usda', 'the byte URL is page-relative by default')
assert.equal(formatBytes(0), '0 B')
assert.equal(formatBytes(1536), '1.5 KB')
assert.equal(formatBytes(12 * 1024 * 1024), '12 MB')
assert.equal(formatDate('not-a-date'), '', 'an unparsable timestamp is omitted')
assert.match(formatDate('2026-11-01T10:00:00Z'), /^2026-11-01 \d\d:\d\d$/, 'a valid timestamp is compact')
say('objstore format      key encoding, USD detection, bucket URIs, byte/date formatting')

// ── listing and search: URL shape, cache reuse ────────────────────────────

const listPayload = {
  bucket: 'asset',
  prefix: 'samples/',
  allowedPrefixes: ['samples/'],
  entries: [{
    key: 'samples/window.usda',
    name: 'window.usda',
    type: 'file',
    size: 130380,
    lastModified: '2026-11-01T10:00:00.000Z',
  }],
  truncated: false,
}

await withFetch(async ({ url }) => {
  if (url === '/usd-asset-api/list?prefix=') return jsonResponse({ entries: [] })
  if (url.startsWith('/usd-asset-api/list?')) return jsonResponse(listPayload)
  if (url.startsWith('/usd-asset-api/search?')) return jsonResponse({ entries: [], scanned: 3, truncated: false })
  return errorResponse(404)
}, async (requests) => {
  const first = await listPrefix('samples/')
  const second = await listPrefix('samples/')
  assert.deepEqual(first, listPayload, 'the listing JSON passes through unchanged')
  assert.deepEqual(second, listPayload, 'a second read inside the TTL is served from the cache')
  const listUrls = requests.filter(request => request.url.startsWith('/usd-asset-api/list?prefix=samples'))
  assert.equal(listUrls.length, 1, 'the prefix is requested once inside the cache window')
  assert.equal(listUrls[0].url, '/usd-asset-api/list?prefix=samples%2F', 'the prefix is URL-encoded')

  await searchFiles('samples/', 'window', true)
  await searchFiles('samples/', 'window', true)
  const searchUrls = requests
    .filter(request => request.url.startsWith('/usd-asset-api/search?'))
    .map(request => request.url)
  assert.equal(searchUrls.length, 1, 'the repeated search is served from the cache')
  assert.match(searchUrls[0], /q=window/, 'the query is forwarded')
  assert.match(searchUrls[0], /usd=1/, 'the USD-only flag is forwarded')
  assert.match(searchUrls[0], /limit=200/, 'the default limit is forwarded')
})
say('objstore requests    list/search URLs, cache reuse, all flags forwarded')

// A shared request must outlive one caller's abort: an unmount or a fast
// keystroke aborts only its own await, not the request another caller reuses.
await withFetch(async ({ url }) => {
  if (url === '/usd-asset-api/list?prefix=') return jsonResponse({ entries: [] })
  if (url.includes('prefix=race%2F')) {
    await tick()
    await tick()
    return jsonResponse({ ...listPayload, prefix: 'race/' })
  }
  return jsonResponse(listPayload)
}, async (requests) => {
  const caller = new AbortController()
  const aborted = listPrefix('race/', caller.signal)
  await tick()
  caller.abort()
  const outcome = await aborted.then(() => 'resolved', error => error.name)
  assert.equal(outcome, 'AbortError', 'the aborted caller rejects with an AbortError')
  const shared = await listPrefix('race/')
  assert.equal(shared.prefix, 'race/', 'a later caller still gets the request the aborted one started')
  assert.equal(
    requests.filter(request => request.url.includes('prefix=race%2F')).length,
    1,
    'the aborted caller does not force a second request',
  )
})
say('objstore cache       one aborted caller does not poison a shared request')

// ── object bytes ───────────────────────────────────────────────────────────

await withFetch(async ({ url }) => {
  if (url === '/usd-asset-api/list?prefix=') return jsonResponse({ entries: [] })
  if (url === '/usd-asset/a%20b/c%20d.usda') return bytesResponse('object-bytes')
  return errorResponse(404)
}, async () => {
  const data = await fetchObjectBytes('a b/c d.usda')
  assert.equal(textOf(data), 'object-bytes', 'the byte route encodes each key segment')
  await assert.rejects(
    () => fetchObjectBytes('missing.usda'),
    /objstore-not-found/,
    'a missing object is reported as not-found',
  )
})
say('objstore bytes       byte route and its error mapping')

// ── configured origin ──────────────────────────────────────────────────────

globalThis.__DSH_OBJSTORE_ASSET_ORIGIN__ = 'https://asset.example.com/'
try {
  const remoteOrigin = await import('../src/client/objstore.js?origin=override')
  assert.equal(remoteOrigin.publicAssetUrl('a b.usda'), 'https://asset.example.com/usd-asset/a%20b.usda',
    'the override makes byte URLs absolute')
  assert.equal(remoteOrigin.s3Uri('my-bucket', 'a/b.usda'), 's3://my-bucket/a/b.usda')
} finally {
  delete globalThis.__DSH_OBJSTORE_ASSET_ORIGIN__
}
say('objstore origin      the global override makes URLs absolute')

// ── address-open descriptor: s3:// through the host signing route ──────────

{
  const s3open = await import('../src/client/s3open.js?host=1')
  assert.equal(s3open.isUsdS3Uri('s3://asset/a.usda'), true)
  assert.equal(s3open.isUsdS3Uri('s3://asset/a.txt'), false)

  await withFetch(async ({ url }) => {
    if (url === '/api/usd-preview/health') return jsonResponse({ ok: true, library: { bucket: 'asset' } })
    if (url.startsWith('/api/usd-preview/asset?uri=')) {
      const uri = decodeURIComponent(url.slice('/api/usd-preview/asset?uri='.length))
      if (uri === 's3://asset/dir/root.usda') return bytesResponse('root-layer')
      if (uri === 's3://asset/dir/body.usda') return bytesResponse('dir-body')
      if (uri === 's3://asset/other.usda') return bytesResponse('asset-other')
      return errorResponse(404)
    }
    return errorResponse(404)
  }, async () => {
    const stage = await s3open.openStage('s3://asset/dir/root.usda')
    assert.equal(stage.kind, 's3', 'an s3:// address opens as an s3 stage')
    assert.equal(stage.label, 'root.usda', 'the header label is the file name')
    assert.equal(stage.rootKey, 'dir/root.usda', 'the root key is the object key')
    assert.equal(textOf(stage.rootBytes), 'root-layer', 'the root layer is read through the host route')
    assert.equal(textOf(await stage.read('body.usda')), 'dir-body',
      'a relative reference is read from the root directory')
    assert.equal(textOf(await stage.readAsset('s3://asset/other.usda')), 'asset-other',
      'an absolute s3:// reference is read through the signing route')
    assert.equal(await stage.read('missing.usda'), undefined,
      'an unreadable reference is a missing layer, not a throw')
    await assert.rejects(
      () => s3open.openStage('s3://asset/missing.usda'),
      /s3-not-found/,
      'a missing root answers s3-not-found',
    )
    await assert.rejects(
      () => s3open.openStage('s3://asset/not-a-stage.txt'),
      /s3-bad-uri/,
      'a non-USD object is refused',
    )
    assert.equal(textOf(await s3open.readS3Asset('s3://asset/other.usda')), 'asset-other')
    assert.equal(await s3open.readS3Asset('not-s3'), undefined, 'a non-s3 reference is not an asset read')
  })
}
say('objstore s3 open     root bytes, relative and absolute readers, error mapping')

// ── address-open descriptor: gateway fallback when the host is unconfigured ─

{
  const s3open = await import('../src/client/s3open.js?gateway=1')
  await withFetch(async ({ url }) => {
    if (url === '/api/usd-preview/health') return jsonResponse({ ok: true, library: null })
    if (url === 'http://127.0.0.1:9010/asset/dir/root.usda') return bytesResponse('gateway-root')
    if (url === 'http://127.0.0.1:9010/asset/dir/body.usda') return bytesResponse('gateway-body')
    return errorResponse(404)
  }, async () => {
    const stage = await s3open.openStage('s3://asset/dir/root.usda')
    assert.equal(textOf(stage.rootBytes), 'gateway-root', 'an unconfigured host falls back to the gateway')
    assert.equal(textOf(await stage.read('body.usda')), 'gateway-body', 'referenced layers use the same fallback')
    await assert.rejects(
      () => s3open.openStage('s3://asset/nothing.usda'),
      /s3-not-found/,
      'a gateway 404 is a missing object',
    )
  })
}
{
  const s3open = await import('../src/client/s3open.js?gateway-down=1')
  await withFetch(async () => {
    throw new TypeError('gateway is down')
  }, async () => {
    await assert.rejects(
      () => s3open.openStage('s3://asset/dir/root.usda'),
      /s3-gateway-down/,
      'neither the host route nor the gateway answering is reported',
    )
  })
}
say('objstore s3 fallback host unconfigured: gateway read, gateway missing, gateway down')

// ── address-open descriptor: http(s) roots ─────────────────────────────────

{
  const s3open = await import('../src/client/s3open.js?http=1')
  await withFetch(async ({ url }) => {
    if (url === 'https://example.test/dist/root.usda') return bytesResponse('http-root')
    if (url === 'https://example.test/dist/layers/body.usda') return bytesResponse('http-body')
    if (url === 'https://example.test/dist/missing.usda') return errorResponse(404)
    if (url === 'https://example.test/broken.usda') throw new TypeError('network down')
    return errorResponse(404)
  }, async () => {
    const stage = await s3open.openStage('https://example.test/dist/root.usda')
    assert.equal(stage.kind, 'http', 'an http(s) address opens as an http stage')
    assert.equal(stage.label, 'root.usda')
    assert.equal(stage.rootKey, 'dist/root.usda', 'the root key is the URL pathname')
    assert.equal(textOf(stage.rootBytes), 'http-root', 'the root layer is fetched directly')
    assert.equal(textOf(await stage.read('layers/body.usda')), 'http-body',
      'a relative reference resolves against the root URL directory')
    assert.equal(await stage.read('missing.usda'), undefined, 'a missing http layer stays a warning')
    await assert.rejects(
      () => s3open.openStage('https://example.test/missing.usda'),
      /http-not-found/,
      'an http 404 is reported',
    )
    await assert.rejects(
      () => s3open.openStage('https://example.test/broken.usda'),
      /http-fetch-failed/,
      'a network failure is reported',
    )
    await assert.rejects(
      () => s3open.openStage('https://example.test/%E0%A4%A.usda'),
      /stage-bad-uri/,
      'a malformed percent escape is a bad address, not a URIError',
    )
    await assert.rejects(
      () => s3open.openStage('not-an-address'),
      /stage-bad-uri/,
      'an unusable address is recognized',
    )
  })
}
say('objstore http open   root bytes, relative reader, 404/network/malformed mapping')

// ── host backend preference: signed routes first, gateway second ───────────

{
  const mod = await import('../src/client/objstore.js?backend=host')
  const listBody = { bucket: 'asset', prefix: '', rootPrefix: 'Component/', allowedPrefixes: ['Component/'],
    entries: [{ key: 'Component/a.usda', name: 'a.usda', type: 'file', size: 1 }], truncated: false }
  await withFetch(async ({ url }) => {
    if (url === '/api/usd-preview/health') return jsonResponse({ ok: true, library: { bucket: 'asset', endpoint: 'https://s3.example.com', rootPrefix: 'Component/' } })
    if (url.startsWith('/api/usd-preview/list?')) return jsonResponse(listBody)
    if (url.startsWith('/api/usd-preview/search?')) return jsonResponse({ entries: [], scanned: 1, truncated: false })
    return errorResponse(404)
  }, async (requests) => {
    const listing = await mod.listPrefix('')
    assert.equal(listing.rootPrefix, 'Component/', 'the host listing passes the configured root through')
    assert.equal(requests.filter(r => r.url.startsWith('/usd-asset-api/')).length, 0,
      'a configured host is used instead of the gateway')
    await mod.searchFiles('Component/', 'a', true)
    assert.equal(requests.filter(r => r.url.startsWith('/usd-asset-api/')).length, 0,
      'search uses the signed host route too')
  })
}
say('objstore backend      a configured host library bypasses the gateway')

{
  // No library configured: the gateway is the fallback, and a 403 there is a
  // permission answer rather than an unreachable one.
  const mod = await import('../src/client/objstore.js?backend=gateway')
  await withFetch(async ({ url }) => {
    if (url === '/api/usd-preview/health') return jsonResponse({ ok: true, library: null })
    if (url.startsWith('/usd-asset-api/list?')) return jsonResponse({ entries: [], bucket: 'asset' })
    return errorResponse(404)
  }, async (requests) => {
    await mod.listPrefix('samples/')
    assert.equal(requests.filter(r => r.url.startsWith('/usd-asset-api/list')).length, 1,
      'an unconfigured host falls back to the gateway listing')
  })
}
{
  const mod = await import('../src/client/objstore.js?backend=forbidden')
  await withFetch(async () => errorResponse(403), async () => {
    await assert.rejects(() => mod.listPrefix(''), /objstore-forbidden/, 'a 403 is reported as forbidden')
  })
}
{
  const mod = await import('../src/client/objstore.js?backend=none')
  await withFetch(async () => errorResponse(404), async () => {
    await assert.rejects(() => mod.listPrefix(''), /objstore-not-found/, 'a 404 is reported as not-found')
  })
}
say('objstore fallback     gateway used when the host has no library; 403/404 mapped')

// ── public URLs: a host-reported endpoint makes them absolute ──────────────

{
  const mod = await import('../src/client/objstore.js?urls=1')
  assert.equal(mod.publicAssetUrl('a b/c.usda'),
    '/usd-asset/a%20b/c%20d.usda'.replace('/c%20d', '/c'),
    'without a library the URL is the page-relative gateway route')
  assert.equal(mod.publicAssetUrl('a b/c d.usda', { endpoint: 'https://s3.example.com/', bucket: 'asset' }),
    'https://s3.example.com/asset/a%20b/c%20d.usda',
    'a host endpoint makes the URL absolute, without a double slash')
  assert.equal(mod.publicAssetUrl('x.usda', { endpoint: 'https://s3.example.com' }),
    'https://s3.example.com/asset/x.usda',
    'a missing bucket falls back to the default')
}
say('objstore public url   absolute from the host endpoint, page-relative otherwise')

// ── saved connection: the route contract, and the cache it invalidates ─────

{
  // A composition without the host half: the route is simply absent, and the
  // page is told so rather than being given an empty connection.
  const mod = await import('../src/client/objstore.js?config=absent')
  await withFetch(async () => errorResponse(404), async () => {
    assert.equal(await mod.loadObjectStoreConfig(), undefined, 'a missing route is reported as unsupported')
    await assert.rejects(
      () => mod.saveObjectStoreConfig({ endpoint: 'https://s3.example.com' }),
      /objstore-config-unsupported/,
      'saving through a missing route is refused, not silently dropped',
    )
  })
}

{
  const mod = await import('../src/client/objstore.js?config=stored')
  const stored = {
    endpoint: 'https://s3.example.com', bucket: 'asset', region: 'us-east-1',
    rootPrefix: 'L0/', accessKey: 'AKIAEXAMPLE', hasSecret: true,
  }
  const posted = []
  await withFetch(async ({ url, options }) => {
    if (url === '/api/usd-preview/health') return jsonResponse({ ok: true, library: { bucket: 'asset', endpoint: 'https://s3.example.com', rootPrefix: 'L0/' } })
    if (url === '/api/usd-preview/objstore/config' && options?.method === 'POST') {
      posted.push(JSON.parse(options.body))
      const body = JSON.parse(options.body)
      return jsonResponse(body.action === 'clear'
        ? { ok: true, source: null, config: null }
        : { ok: true, source: 'config-file', config: stored })
    }
    if (url === '/api/usd-preview/objstore/config') return jsonResponse({ ok: true, source: 'config-file', config: stored })
    if (url.startsWith('/api/usd-preview/list?')) return jsonResponse({ bucket: 'asset', prefix: 'L0/', entries: [], truncated: false })
    return errorResponse(404)
  }, async (requests) => {
    const read = await mod.loadObjectStoreConfig()
    assert.deepEqual(read, { config: stored, source: 'config-file' }, 'the stored connection and its source are reported')
    assert.ok(!JSON.stringify(read).includes('supersecret'), 'the read shape carries no secret')

    const saved = await mod.saveObjectStoreConfig({
      endpoint: 'https://s3.example.com', bucket: 'asset', region: 'us-east-1',
      rootPrefix: 'L0/', accessKey: 'AKIAEXAMPLE', secretKey: 'supersecret',
    })
    assert.deepEqual(saved, { config: stored, source: 'config-file' })
    assert.deepEqual(posted[0], {
      action: 'save', endpoint: 'https://s3.example.com', bucket: 'asset', region: 'us-east-1',
      rootPrefix: 'L0/', accessKey: 'AKIAEXAMPLE', secretKey: 'supersecret',
    }, 'every field the panel collects reaches the route')

    const cleared = await mod.clearObjectStoreConfig()
    assert.deepEqual(cleared, { config: null, source: null }, 'clearing answers with nothing stored')
    assert.equal(posted[1].action, 'clear')

    // The listing cache is what a just-saved connection must not be served from.
    await mod.listPrefix('L0/')
    await mod.listPrefix('L0/')
    assert.equal(requests.filter(request => request.url.startsWith('/api/usd-preview/list')).length, 1,
      'a repeated listing inside the cache window is shared')
    mod.resetObjectStoreCaches()
    await mod.listPrefix('L0/')
    assert.equal(requests.filter(request => request.url.startsWith('/api/usd-preview/list')).length, 2,
      'after a save the next listing is asked again instead of being served from the old backend')
  })
}

{
  const mod = await import('../src/client/objstore.js?config=errors')
  const cases = [
    [400, 'invalid-bucket', 'objstore-config-invalid'],
    [409, 'environment-config', 'objstore-config-environment'],
    [502, 'denied', 'objstore-config-unverified'],
    [502, 'unreachable', 'objstore-config-unverified'],
    [500, 'boom', 'objstore-config-http-500'],
  ]
  for (const [status, error, message] of cases) {
    await withFetch(async () => new Response(JSON.stringify({ ok: false, error }), {
      status,
      headers: { 'content-type': 'application/json' },
    }), async () => {
      const failure = await mod.saveObjectStoreConfig({ endpoint: 'https://s3.example.com' })
        .then(() => undefined, caught => caught)
      assert.ok(failure !== undefined, `HTTP ${status} is reported as a failure`)
      assert.equal(failure.message, message, `HTTP ${status} maps to ${message}`)
      if (status !== 500) assert.equal(failure.reason, error, 'the route reason survives for the panel')
    })
  }
}
say('objstore connection  saved connection read/save/clear, missing route, error mapping, cache reset')

process.stdout.write('objstore.test.mjs  OK  (paths, request cache, address descriptor, saved connection)\n')
