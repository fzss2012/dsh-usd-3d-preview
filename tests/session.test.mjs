/**
 * The modeling-session archive reader without a browser: naming, manifest
 * parsing, revision ranking, commit summaries, and the resolve that ties them
 * together against a fake archive source.
 *
 * The two doors into the real preview (a workspace Remote read and a dropped
 * folder) present the same `source` interface, so one fake source stands in for
 * both — including the failures that are the point of the reader: an older
 * archive without `snapshots/`, an empty folder, an unreadable folder, a corrupt
 * commit record, a snapshot that no longer reads.
 *
 * Run: node tests/session.test.mjs
 */
import assert from 'node:assert/strict'
import {
  canonicalRevision,
  isSessionArchiveName,
  newestCommitRecord,
  newestSnapshot,
  parseCommitRecord,
  parseSessionManifest,
  resolveSessionArchive,
  revisionOfCommitName,
  revisionOfSnapshotName,
  SESSION_TAB_PATTERNS,
  summarizeCommitRecord,
} from '../src/client/session.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * One archive source over an in-memory path → bytes table.
 *
 * `emptyDirectories` makes a folder exist but be empty; `unreadableDirectories`
 * makes its listing fail; `prefix` is the archive root inside the store, the way
 * a dropped folder's keys all start with the folder name.
 * @param files - archive-relative path to text or bytes.
 * @param options - directory shapes and the store prefix.
 * @returns the source `resolveSessionArchive` consumes.
 */
function sourceOf(files, { emptyDirectories = [], unreadableDirectories = [], prefix = '' } = {}) {
  const table = new Map()
  for (const [path, value] of Object.entries(files)) {
    table.set(`${prefix}${path}`, typeof value === 'string' ? encoder.encode(value) : value)
  }
  return {
    key: relative => `${prefix}${relative}`,
    async read(relative) {
      return table.get(`${prefix}${relative}`)
    },
    async list(relative) {
      if (unreadableDirectories.includes(relative)) return { error: 'io-failed' }
      if (emptyDirectories.includes(relative)) return { entries: [] }
      const prefixOfDirectory = `${prefix}${relative}/`
      const entries = new Map()
      let found = false
      for (const key of table.keys()) {
        if (!key.startsWith(prefixOfDirectory)) continue
        found = true
        const rest = key.slice(prefixOfDirectory.length)
        const slash = rest.indexOf('/')
        if (slash < 0) entries.set(rest, { name: rest, type: 'file' })
        else entries.set(rest.slice(0, slash), { name: rest.slice(0, slash), type: 'directory' })
      }
      if (!found) return { error: 'workspace-file/not-found' }
      return { entries: [...entries.values()] }
    },
  }
}

/** A valid manifest body in the archive writer's own shape, with per-case overrides. */
function manifest(overrides = {}) {
  return JSON.stringify({
    archive_format_version: 1,
    protocol_version: 1,
    session_id: 'session-7',
    created_at: '2026-11-23T00:00:00.000+00:00',
    headless: false,
    build: {
      app_version: '1.0.2',
      kernel_config: 'debug',
      kernel_build_id: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      kernel_module: '/opt/smlib/_omni_solid.so',
      archive_format_version: 1,
      protocol_version: 1,
      build_id: 'smlib-gui-1.0.2/kernel-debug-0123456789abcdef/archive-1/protocol-1',
    },
    ...overrides,
  })
}

/** One object entry for a commit record's summary. */
function objectEntry(counts, extra = {}) {
  return { id: 1, name: 'box', kind: 'brep', manifold: true, ...counts, ...extra }
}

// ── what a session manifest is called ───────────────────────────────────────
assert.equal(isSessionArchiveName('session.json'), true)
assert.equal(isSessionArchiveName('SESSION.JSON'), true, 'the name check is case-insensitive')
assert.equal(isSessionArchiveName('archives/robot/session.json'), true, 'the basename is what counts')
assert.equal(isSessionArchiveName('robot.session.json'), true, 'a renamed manifest still opens the archive')
assert.equal(isSessionArchiveName('sessions.json'), false)
assert.equal(isSessionArchiveName('mysession.json'), false)
assert.equal(isSessionArchiveName('session.json.bak'), false)
assert.equal(isSessionArchiveName('session.json5'), false)
assert.deepEqual([...SESSION_TAB_PATTERNS], ['session.json', '*.session.json'])

// ── revision file names ─────────────────────────────────────────────────────
assert.equal(revisionOfSnapshotName('00000000000000000003.usda'), '3')
assert.equal(revisionOfSnapshotName('snapshots/00000000000000000003.USDC'), '3')
assert.equal(revisionOfSnapshotName('00000000000000000003.usd'), '3')
// The commit writer pads to the spec's 20 digits; a snapshot exported by a
// separate producer may write the plain revision, so both are read.
assert.equal(revisionOfSnapshotName('3.usda'), '3')
assert.equal(revisionOfSnapshotName('00000000000000000003.tmp'), undefined)
assert.equal(revisionOfSnapshotName('00000000000000000003.usda.tmp'), undefined)
assert.equal(revisionOfCommitName('00000000000000000012.json'), '12')
assert.equal(revisionOfCommitName('00000000000000000012.usda'), undefined)
assert.equal(revisionOfCommitName('12.json'), undefined)
assert.equal(canonicalRevision('00000000000000000000'), '0')
assert.equal(canonicalRevision('00000000000000000042'), '42')
assert.equal(canonicalRevision(7), '7')

// A new revision number is not the newest by name length: ranking is numeric.
assert.deepEqual(newestSnapshot([
  { name: '00000000000000000002.usda', type: 'file' },
  { name: '00000000000000000010.usda', type: 'file' },
  { name: '00000000000000000009.usda', type: 'file' },
  { name: '00000000000000000020.usda', type: 'directory' },
  { name: 'notes.tmp', type: 'file' },
]), { rev: '10', name: '00000000000000000010.usda' })
assert.deepEqual(newestSnapshot([
  { name: '1.usda', type: 'file' },
  { name: '00000000000000000002.usda', type: 'file' },
]), { rev: '2', name: '00000000000000000002.usda' }, 'padded and plain revision names rank together')
assert.equal(newestSnapshot([]), undefined)
assert.deepEqual(newestCommitRecord([
  { name: '00000000000000000001.json', type: 'file' },
  { name: '00000000000000000011.json', type: 'file' },
]), { rev: '11', name: '00000000000000000011.json' })

// ── the manifest ────────────────────────────────────────────────────────────
const buildId = 'smlib-gui-1.0.2/kernel-debug-0123456789abcdef/archive-1/protocol-1'
assert.deepEqual(parseSessionManifest(manifest()), {
  fields: { sessionId: 'session-7', archiveVersion: '1', protocolVersion: '1', buildId },
  missing: [],
})
// The writer may spell the versions as JSON numbers or strings; both are read.
assert.deepEqual(parseSessionManifest(JSON.stringify({
  session_id: 's', archive_format_version: '2', protocol_version: 3, build_id: 'b',
})).fields, { sessionId: 's', archiveVersion: '2', protocolVersion: '3', buildId: 'b' })
// The shorter and camelCase spellings are this archive's manifest too: a small
// hand-authored manifest should not need the writer's exact field names.
assert.deepEqual(parseSessionManifest(JSON.stringify({
  sessionId: 's', archiveFormatVersion: 1, protocolVersion: 1, buildId: 'b',
})).fields, { sessionId: 's', archiveVersion: '1', protocolVersion: '1', buildId: 'b' })
assert.deepEqual(parseSessionManifest(JSON.stringify({
  session_id: 's', archive_version: 1, protocol_version: 1, build_id: 'b',
})).fields, { sessionId: 's', archiveVersion: '1', protocolVersion: '1', buildId: 'b' })
// A build dict without the combined identifier still names the build.
assert.equal(parseSessionManifest(JSON.stringify({
  session_id: 's', archive_format_version: 1, protocol_version: 1,
  build: { app_version: '1.0.2', kernel_config: 'debug' },
})).fields.buildId, '1.0.2 kernel-debug')
// A missing field is reported by its wire spelling, never fatal.
const missingBuild = parseSessionManifest(manifest({ build: undefined }))
assert.deepEqual(missingBuild.missing, ['build'])
assert.equal(missingBuild.fields.sessionId, 'session-7')
assert.deepEqual(parseSessionManifest(manifest({ session_id: '   ' })).missing, ['session_id'])
// Not a manifest at all.
assert.deepEqual(parseSessionManifest('not json'), { error: 'invalid-json' })
assert.deepEqual(parseSessionManifest('[1, 2]'), { error: 'not-object' })
assert.deepEqual(parseSessionManifest('null'), { error: 'not-object' })
assert.deepEqual(parseSessionManifest('{"hello": "world"}'), { error: 'not-session-archive' })

// ── commit records and their object summary ─────────────────────────────────
// The writer publishes one flat record per commit: model_rev, object_ids, and a
// top-level `objects` array of per-object summaries.
const twoObjects = JSON.stringify({
  model_rev: 2,
  previous_model_rev: 1,
  object_ids: [1, 2],
  objects: [
    objectEntry({ faces: 7, edges: 15, vertices: 10, volume: 996.5 }),
    objectEntry({ faces: 1, edges: 2, vertices: 3, volume: 4.18 }, { id: 2, name: 'sphere' }),
  ],
})
const record = parseCommitRecord(twoObjects)
assert.equal(record.modelRev, '2')
assert.deepEqual(record.summary, {
  objects: 2, faces: 8, edges: 17, vertices: 13, manifold: true, volume: 1000.68, kinds: ['brep'],
})
// A summary that carries one object's counts directly is one object.
assert.deepEqual(summarizeCommitRecord({ summary: { faces: 6, edges: 12, vertices: 8, manifold: true } }), {
  objects: 1, faces: 6, edges: 12, vertices: 8, manifold: true, volume: null, kinds: [],
})
// A nested `summary.objects` list is tolerated as well, for a hand-authored record.
assert.equal(summarizeCommitRecord({ summary: { objects: [objectEntry({ faces: 6 }), objectEntry({ faces: 1 }, { id: 2 })] } }).objects, 2)
// A record with only the IDs it touched still counts the objects.
assert.equal(summarizeCommitRecord({ object_ids: [1, 2, 3] }).objects, 3)
assert.equal(summarizeCommitRecord({}), undefined)
// A partial count is never reported as a total; the object count still is.
assert.deepEqual(summarizeCommitRecord({ summary: { objects: [
  objectEntry({ faces: 6 }),
  objectEntry({ edges: 12 }, { id: 2 }),
] } }), { objects: 2, faces: null, edges: null, vertices: null, manifold: true, volume: null, kinds: ['brep'] })
// Disagreeing manifold flags are not a claim.
assert.equal(summarizeCommitRecord({ summary: { objects: [
  objectEntry({ manifold: true }),
  objectEntry({ manifold: false }, { id: 2 }),
] } }).manifold, null)
// Corrupt records are reported, not thrown.
assert.deepEqual(parseCommitRecord('{'), { error: 'invalid-json' })
assert.deepEqual(parseCommitRecord('[]'), { error: 'not-object' })

// ── resolving a whole archive ───────────────────────────────────────────────
const fullArchive = {
  'session.json': manifest(),
  'snapshots/00000000000000000001.usda': '#usda 1.0\n# revision one\n',
  'snapshots/00000000000000000002.usda': '#usda 1.0\n# revision two\n',
  'commits/00000000000000000001.json': JSON.stringify({ model_rev: 1, objects: [objectEntry({ faces: 6, edges: 12, vertices: 8, volume: 1000 })] }),
  'commits/00000000000000000002.json': twoObjects,
}
const resolved = await resolveSessionArchive({ source: sourceOf(fullArchive) })
assert.equal(resolved.state, 'ready')
assert.equal(resolved.manifest.sessionId, 'session-7')
assert.deepEqual(resolved.missingFields, [])
assert.deepEqual(resolved.warnings, [])
assert.equal(resolved.snapshot.rev, '2', 'the newest snapshot is the one to draw')
assert.equal(resolved.snapshot.path, 'snapshots/00000000000000000002.usda')
assert.match(decoder.decode(resolved.snapshot.bytes), /revision two/)
assert.equal(resolved.commit.rev, '2')
assert.equal(resolved.commit.path, 'commits/00000000000000000002.json')
assert.equal(resolved.modelRev, '2')
assert.equal(resolved.summary.objects, 2)

// A dropped folder's keys carry the folder prefix; the snapshot path carries it
// too, because the viewport looks the stage up by that key.
const prefixed = await resolveSessionArchive({ source: sourceOf(fullArchive, { prefix: 'archive/' }) })
assert.equal(prefixed.snapshot.path, 'archive/snapshots/00000000000000000002.usda')
assert.equal(prefixed.commit.path, 'archive/commits/00000000000000000002.json')

// An archive written before snapshots existed: the session, revision and object
// summary still resolve; there is just nothing to draw.
const older = await resolveSessionArchive({ source: sourceOf({
  'session.json': manifest(),
  'commits/00000000000000000001.json': JSON.stringify({ model_rev: 1, summary: { objects: [objectEntry({ faces: 6, edges: 12, vertices: 8 })] } }),
}) })
assert.equal(older.state, 'ready')
assert.equal(older.snapshot, undefined)
assert.equal(older.modelRev, '1')
assert.equal(older.summary.objects, 1)
assert.deepEqual(older.warnings.map(warning => warning.code), ['no-snapshot-directory'])

// A snapshots folder with nothing rendered in it yet.
const empty = await resolveSessionArchive({ source: sourceOf({ 'session.json': manifest(), 'commits/00000000000000000001.json': '{"model_rev": 1}' }, { emptyDirectories: ['snapshots'] }) })
assert.equal(empty.snapshot, undefined)
assert.deepEqual(empty.warnings.map(warning => warning.code), ['no-snapshots'])

// A folder that cannot be listed at all says so instead of claiming it is absent.
const unreadableFolder = await resolveSessionArchive({ source: sourceOf({ 'session.json': manifest(), 'commits/00000000000000000001.json': '{"model_rev": 1}' }, { unreadableDirectories: ['snapshots'] }) })
assert.deepEqual(unreadableFolder.warnings.map(warning => warning.code), ['snapshot-directory-unreadable'])
assert.equal(unreadableFolder.warnings[0].params.reason, 'io-failed')

// A listed snapshot that no longer reads: the panel still describes the archive.
const unreadableSnapshot = await resolveSessionArchive({
  source: (() => {
    const source = sourceOf({ 'session.json': manifest(), 'snapshots/00000000000000000002.usda': 'x', 'commits/00000000000000000001.json': '{"model_rev": 1}' })
    return { ...source, read: async relative => (relative === 'snapshots/00000000000000000002.usda' ? undefined : source.read(relative)) }
  })(),
})
assert.equal(unreadableSnapshot.state, 'ready')
assert.equal(unreadableSnapshot.snapshot, undefined)
assert.deepEqual(unreadableSnapshot.warnings.map(warning => warning.code), ['snapshot-unreadable'])
assert.equal(unreadableSnapshot.warnings[0].params.rev, '2')

// The newest commit record is corrupt: the snapshot still draws, without a summary.
const corruptCommit = await resolveSessionArchive({ source: sourceOf({
  ...fullArchive,
  'commits/00000000000000000002.json': '{"model_rev": 2,',
}) })
assert.equal(corruptCommit.state, 'ready')
assert.equal(corruptCommit.snapshot.rev, '2')
assert.equal(corruptCommit.commit, undefined)
assert.equal(corruptCommit.modelRev, '2', 'the snapshot revision is the fallback when no record reads')
assert.deepEqual(corruptCommit.warnings.map(warning => warning.code), ['commit-corrupt'])
assert.equal(corruptCommit.warnings[0].params.rev, '2')

// A record whose declared revision does not match its file name is reported.
const mismatched = await resolveSessionArchive({ source: sourceOf({
  ...fullArchive,
  'commits/00000000000000000002.json': JSON.stringify({ model_rev: 3, objects: [objectEntry({ faces: 6 })] }),
}) })
assert.deepEqual(mismatched.warnings.map(warning => warning.code), ['commit-rev-mismatch'])
assert.equal(mismatched.warnings[0].params.recorded, '3')

// A snapshot that lags the newest commit is drawn, and the panel says the
// viewport is behind the recorded model rather than implying it is current.
const lags = await resolveSessionArchive({ source: sourceOf({
  ...fullArchive,
  'commits/00000000000000000003.json': JSON.stringify({ model_rev: 3 }),
}) })
assert.equal(lags.snapshot.rev, '2')
assert.equal(lags.modelRev, '3')
assert.deepEqual(lags.warnings.map(warning => warning.code), ['snapshot-older-than-commit'])
assert.equal(lags.warnings[0].params.snapshotRev, '2')
assert.equal(lags.warnings[0].params.commitRev, '3')

// The other direction — a snapshot beyond the newest record — is reported too.
const ahead = await resolveSessionArchive({ source: sourceOf({
  ...fullArchive,
  'snapshots/00000000000000000003.usda': '#usda revision three',
}) })
assert.equal(ahead.snapshot.rev, '3')
assert.equal(ahead.modelRev, '2')
assert.deepEqual(ahead.warnings.map(warning => warning.code), ['snapshot-newer-than-commit'])

// Missing archive folders are warnings, never failures: the rest still resolves.
const noCommits = await resolveSessionArchive({ source: sourceOf({
  'session.json': manifest(),
  'snapshots/00000000000000000002.usda': '#usda 1.0\n',
}) })
assert.equal(noCommits.state, 'ready')
assert.equal(noCommits.modelRev, '2')
assert.equal(noCommits.summary, undefined)
assert.deepEqual(noCommits.warnings.map(warning => warning.code), ['no-commit-directory'])

// A manifest with an omitted field still resolves, and the panel can say which.
const incomplete = await resolveSessionArchive({ source: sourceOf({
  'session.json': manifest({ build: undefined, protocol_version: undefined }),
  ...Object.fromEntries(Object.entries(fullArchive).filter(([path]) => path !== 'session.json')),
}) })
assert.equal(incomplete.state, 'ready')
assert.deepEqual(incomplete.warnings.map(warning => warning.code), ['missing-fields'])
assert.equal(incomplete.warnings[0].params.fields, 'protocol_version, build')

// Nothing to resolve at all: no manifest is the one failed state.
assert.deepEqual(await resolveSessionArchive({ source: sourceOf({}) }), { state: 'failed', error: 'manifest-missing', warnings: [] })
assert.deepEqual(await resolveSessionArchive({ source: sourceOf({ 'session.json': 'nope' }) }), { state: 'failed', error: 'invalid-json', warnings: [] })
assert.deepEqual(await resolveSessionArchive({ source: sourceOf({ 'session.json': '[]' }) }), { state: 'failed', error: 'not-object', warnings: [] })
assert.deepEqual(await resolveSessionArchive({ source: sourceOf({ 'session.json': '{"hello": "world"}' }) }), { state: 'failed', error: 'not-session-archive', warnings: [] })

process.stdout.write('session.test.mjs  OK  (manifest, revisions, commit summary, archive resolution)\n')
