/**
 * Browser-direct S3 suite: prefix confinement, endpoint normalization and the
 * SIGV4 signature over Web Crypto, offline.
 *
 * The module under test is the exact code the sidebar runs. fetch is stubbed and
 * an independent verifier recomputes the signature from the received request,
 * so a header that merely *looks* like SigV4 cannot pass.
 *
 * Run: node tests/directS3.test.mjs
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash, createHmac } from 'node:crypto'

const {
  configureDirect,
  clearDirect,
  confinedPrefix,
  directConfig,
  directObjectUrl,
  directS3Uri,
  encodeKey,
  hasDirect,
  isUsdKey,
  listDirect,
  normalizeEndpoint,
  normalizePrefix,
  searchDirect,
  fetchDirectBytes,
} = await import('../src/client/directS3.js')

const lines = []
function say(line) {
  lines.push(line)
  process.stdout.write(line + '\n')
}

// ── normalization + confinement ──────────────────────────────────────────────

assert.equal(normalizeEndpoint(' https://s3.example.com/ '), 'https://s3.example.com', 'endpoint trims and drops the slash')
assert.equal(normalizeEndpoint('ftp://s3.example.com'), undefined, 'a non-http scheme is refused')
assert.equal(normalizeEndpoint('not a url'), undefined, 'garbage is refused')
assert.equal(normalizePrefix('Component'), 'Component/', 'a bare prefix gains its slash')
assert.equal(normalizePrefix('/L0/shared/'), 'L0/shared/', 'leading/trailing slashes normalize')
assert.equal(normalizePrefix('s3://asset/L0'), 'L0/', 'a full URI is accepted')
assert.equal(normalizePrefix('a\\b'), 'a/b/', 'backslashes are separators')
assert.equal(normalizePrefix('../etc'), '', 'a traversal falls back to the bucket root')
assert.equal(confinedPrefix('', 'L0/'), 'L0/', 'an empty prefix is the root')
assert.equal(confinedPrefix('L0/CH', 'L0/'), 'L0/CH/', 'a child prefix is accepted')
assert.equal(confinedPrefix('L0', 'L0/'), 'L0/', 'the root without its slash is the root')
assert.equal(confinedPrefix('Other/', 'L0/'), undefined, 'a sibling prefix is refused')
assert.equal(confinedPrefix('../secret', 'L0/'), undefined, 'a traversal is refused')
assert.equal(confinedPrefix('', ''), '', 'an unset root allows the bucket root')
say('direct paths        endpoint/prefix normalization and root confinement')

assert.equal(encodeKey('a b/c d.usda'), 'a%20b/c%20d.usda', 'key segments are encoded separately')
assert.equal(isUsdKey('model.USDA'), true, 'USD detection is case-insensitive')
assert.equal(isUsdKey('texture.png'), false)
say('direct format       key encoding and USD suffix detection')

// ── configure: secrets never leak into the safe config ──────────────────────

assert.equal(configureDirect({ endpoint: 'nope', bucket: 'asset', accessKey: 'a', secretKey: 'b' }), 'direct-bad-endpoint')
assert.equal(configureDirect({ endpoint: 'https://s3.example.com', bucket: 'bad name!', accessKey: 'a', secretKey: 'b' }), 'direct-bad-bucket')
assert.equal(configureDirect({ endpoint: 'https://s3.example.com', bucket: 'asset', accessKey: '', secretKey: '' }), 'direct-missing-keys')
const safe = configureDirect({
  endpoint: 'https://s3.example.com/',
  bucket: 'asset',
  region: 'us-east-1',
  rootPrefix: 'L0/',
  accessKey: 'AKIATEST',
  secretKey: 'supersecret',
})
assert.equal(hasDirect(), true)
assert.deepEqual(safe, {
  endpoint: 'https://s3.example.com', bucket: 'asset', region: 'us-east-1', rootPrefix: 'L0/',
}, 'the safe config carries no credential')
assert.ok(!JSON.stringify(safe).includes('supersecret'), 'the secret is not serializable from the config')
assert.equal(directObjectUrl('a b.usda'), 'https://s3.example.com/asset/a%20b.usda')
assert.equal(directS3Uri('L0/a.usda'), 's3://asset/L0/a.usda')
assert.deepEqual(directConfig(), safe)
say('direct configure    validation, non-secret config, URLs')

// ── signed list against a local server, verified independently ─────────────

const enc = value => encodeURIComponent(value)
  .replace(/[!'()*]/g, character => '%' + character.charCodeAt(0).toString(16).toUpperCase())
const hmacKey = (key, value) => createHmac('sha256', key).update(value, 'utf8').digest()
const sha256 = value => createHash('sha256').update(value, 'utf8').digest('hex')

const verdicts = []
const requests = []
const server = createServer((request, response) => {
  const [pathPart, queryPart] = String(request.url).split('?')
  const canonicalQuery = [...new URLSearchParams(queryPart ?? '').entries()]
    .map(([name, value]) => [enc(name), enc(value)])
    .sort((left, right) => (left[0] === right[0]
      ? (left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0)
      : (left[0] < right[0] ? -1 : 1)))
    .map(([name, value]) => name + '=' + value).join('&')
  const amzDate = request.headers['x-amz-date']
  const payloadHash = request.headers['x-amz-content-sha256']
  const canonical = ['GET', pathPart, canonicalQuery, 'host:' + request.headers.host,
    'x-amz-content-sha256:' + payloadHash, 'x-amz-date:' + amzDate, '',
    'host;x-amz-content-sha256;x-amz-date', payloadHash].join('\n')
  const dateStamp = amzDate.slice(0, 8)
  const scope = dateStamp + '/us-east-1/s3/aws4_request'
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')
  const signing = hmacKey(hmacKey(hmacKey(hmacKey('AWS4supersecret', dateStamp), 'us-east-1'), 's3'), 'aws4_request')
  const expected = createHmac('sha256', signing).update(stringToSign, 'utf8').digest('hex')
  const received = /Signature=([0-9a-f]+)/.exec(request.headers.authorization)?.[1]
  verdicts.push(received === expected)
  requests.push({ pathPart, queryPart, auth: request.headers.authorization })

  if (String(queryPart).includes('list-type=2')) {
    response.writeHead(200, { 'content-type': 'application/xml' })
    // The first call is a directory list (has delimiter and a page token); the
    // recursive search has no delimiter and must terminate after one page.
    const recursive = !String(queryPart).includes('delimiter')
    response.end(recursive
      ? `<?xml version="1.0"?><ListBucketResult>
          <IsTruncated>false</IsTruncated>
          <Contents><Key>L0/a.usda</Key><Size>120</Size></Contents>
        </ListBucketResult>`
      : `<?xml version="1.0"?><ListBucketResult>
          <IsTruncated>true</IsTruncated><NextContinuationToken>tok/2</NextContinuationToken>
          <Contents><Key>L0/a&amp;b.usda</Key><Size>120</Size><LastModified>2026-11-01T10:00:00Z</LastModified></Contents>
          <Contents><Key>L0/</Key><Size>0</Size></Contents>
          <CommonPrefixes><Prefix>L0/CH/</Prefix></CommonPrefixes>
        </ListBucketResult>`)
    return
  }
  response.writeHead(200, { 'content-type': 'application/octet-stream' })
  response.end('object-bytes')
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const realFetch = globalThis.fetch
globalThis.fetch = realFetch
const endpoint = 'http://127.0.0.1:' + String(server.address().port)
configureDirect({
  endpoint, bucket: 'asset', region: 'us-east-1', rootPrefix: 'L0/',
  accessKey: 'AKIATEST', secretKey: 'supersecret',
})

try {
  const listing = await listDirect('L0/', '')
  assert.equal(listing.entries.length, 2, 'the directory marker is not an entry')
  assert.equal(listing.entries[0].type, 'folder', 'folders sort first')
  assert.equal(listing.entries[0].name, 'CH')
  assert.equal(listing.entries[1].key, 'L0/a&b.usda', 'the XML entity is decoded')
  assert.equal(listing.entries[1].size, 120)
  assert.equal(listing.truncated, true)
  assert.equal(listing.continuationToken, 'tok/2')
  assert.equal(listing.direct, true)
  assert.match(requests[0].queryPart, /list-type=2/, 'a ListObjectsV2 request was sent')
  assert.match(requests[0].queryPart, /delimiter=%2F/, 'the delimiter is present')

  await searchDirect('L0/', '', true, 20)
  const bytes = await fetchDirectBytes('L0/a.usda')
  assert.equal(new TextDecoder().decode(bytes), 'object-bytes', 'a signed GET returns object bytes')

  await assert.rejects(() => listDirect('Other/', ''), /direct-forbidden-prefix/, 'an escaped prefix is refused before any request')
} finally {
  globalThis.fetch = realFetch
  await new Promise(resolve => server.close(resolve))
  clearDirect()
}

assert.equal(verdicts.length, 3, 'three signed requests reached the server')
assert.deepEqual(verdicts, [true, true, true], 'Web Crypto SIGV4 verifies against an independent derivation')
say('direct signature   Web Crypto SIGV4 verifies (list, search, object GET)')

clearDirect()
assert.equal(hasDirect(), false, 'clearDirect forgets the connection')
process.stdout.write('directS3.test.mjs  OK\n')
