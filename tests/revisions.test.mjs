/**
 * Asset-revision suite: revision paths in the S3 asset store, offline.
 *
 * A listing shows an object at its normal key and its history below
 * `revisions/<id>/`; this suite covers the pure helpers that parse those keys,
 * map them back to the object's short key, and collapse a listing so a revision
 * is not offered as a second object. No store client, no network and no DOM.
 *
 * Run: node tests/revisions.test.mjs
 */
import assert from 'node:assert/strict'
import {
  collapseRevisions,
  isRevisionKey,
  isRevisionsFolder,
  REVISIONS_SEGMENT,
  revisionIdOf,
  revisionOf,
  shortKeyOf,
} from '../src/client/revisions.js'

const lines = []
function say(line) {
  lines.push(line)
  process.stdout.write(line + '\n')
}

/** One listing entry, shaped like the store client's. */
const entryOf = (key, lastModified = '', type = 'file') => ({ key, name: key, type, size: 0, lastModified })

// ---- plain keys and the word used as a name -------------------------------

assert.equal(REVISIONS_SEGMENT, 'revisions', 'the segment constant is the folder name')
assert.equal(revisionOf('L0/X/c.usda'), undefined, 'a plain key has no revision')
assert.equal(revisionIdOf('L0/X/c.usda'), undefined, 'a plain key has no revision id')
assert.equal(isRevisionKey('L0/X/c.usda'), false, 'a plain key is not a revision key')
assert.equal(shortKeyOf('L0/X/c.usda'), 'L0/X/c.usda', 'a plain key is its own short key')
assert.equal(isRevisionKey('L0/revisions.usda'), false, 'the word used as a file name is not a segment')
assert.equal(shortKeyOf('L0/revisions.usda'), 'L0/revisions.usda', 'a name keeps its key')
assert.equal(isRevisionKey('L0/X/revisions/'), false, 'a revisions folder with no id has no pair')
assert.equal(revisionOf('L0/X/revisions/'), undefined, 'a revisions folder with no id has no pair')
assert.equal(shortKeyOf('L0/X/revisions/'), 'L0/X/revisions/', 'a revisions folder keeps its key')
say('revisions keys       plain, "revisions" as a name, bare folder without an id')

// ---- revision keys: directory, id and remainder ---------------------------

assert.deepEqual(revisionOf('L0/X/revisions/9ca/c.usda'),
  { dir: 'L0/X', revision: '9ca', rest: 'c.usda' },
  'a nested revision key splits into its three parts')
assert.equal(revisionIdOf('L0/X/revisions/9ca/c.usda'), '9ca', 'the id is the single segment below revisions')
assert.equal(isRevisionKey('L0/X/revisions/9ca/c.usda'), true, 'a nested revision key is a revision key')
assert.deepEqual(revisionOf('L0/X/revisions/9ca/'),
  { dir: 'L0/X', revision: '9ca', rest: '' },
  'a revision folder has no remainder')
assert.deepEqual(revisionOf('L0/X/revisions/9ca'),
  { dir: 'L0/X', revision: '9ca', rest: '' },
  'a key that ends at the id has no remainder')
assert.deepEqual(revisionOf('L0/X/revisions/9ca/shots/s010/layer.usda'),
  { dir: 'L0/X', revision: '9ca', rest: 'shots/s010/layer.usda' },
  'a deep remainder survives whole')
assert.deepEqual(revisionOf('revisions/9ca/c.usda'),
  { dir: '', revision: '9ca', rest: 'c.usda' },
  'a revision pair at the root has an empty directory')
assert.deepEqual(revisionOf('a/revisions/x/revisions/y.usda'),
  { dir: 'a', revision: 'x', rest: 'revisions/y.usda' },
  'only the first pair counts')
say('revisions parse      directory, id, remainder, first pair only')

// ---- short keys: the object behind a revision -----------------------------

assert.equal(shortKeyOf('L0/X/revisions/9ca/c.usda'), 'L0/X/c.usda', 'the pair is dropped from the key')
assert.equal(shortKeyOf('L0/X/revisions/9ca/shots/s010/layer.usda'),
  'L0/X/shots/s010/layer.usda',
  'a deep remainder keeps its short key')
assert.equal(shortKeyOf('L0/X/revisions/9ca/'), 'L0/X/', 'a revision folder keeps one trailing slash')
assert.equal(shortKeyOf('L0/X/revisions/9ca'), 'L0/X', 'a key without a trailing slash gains none')
assert.equal(shortKeyOf('revisions/9ca/c.usda'), 'c.usda', 'a root pair leaves no leading slash')
assert.equal(shortKeyOf('a/revisions/x/revisions/y.usda'), 'a', 'every pair is dropped, so the result is stable')
for (const key of [
  'L0/X/c.usda',
  'L0/X/revisions/9ca/c.usda',
  'L0/X/revisions/9ca/',
  'L0/X/revisions/',
  'a/revisions/x/revisions/y.usda',
]) {
  const once = shortKeyOf(key)
  assert.equal(shortKeyOf(once), once, 'shortKeyOf is idempotent for ' + key)
}
say('revisions short key  pair dropped, trailing slash kept, idempotent')

// ---- the revisions folder itself ------------------------------------------

assert.equal(isRevisionsFolder(entryOf('L0/X/revisions/', '', 'folder')), true, 'a revisions folder is one')
assert.equal(isRevisionsFolder(entryOf('revisions/', '', 'folder')), true, 'a root revisions folder is one')
assert.equal(isRevisionsFolder(entryOf('L0/X/revisions/9ca/', '', 'folder')), false,
  'a revision below it is not the revisions folder')
assert.equal(isRevisionsFolder(entryOf('L0/X/revisions/', '2026-11-01T00:00:00.000Z')), false,
  'an object keyed like the folder is not a folder')
assert.equal(isRevisionsFolder(entryOf('L0/X/revisions.usda', '', 'folder')), false,
  'the word as a file name is not the folder')
assert.equal(isRevisionsFolder(entryOf('L0/X/', '', 'folder')), false, 'a parent folder is not one')
say('revisions folders    only a folder whose last segment is "revisions"')

// ---- collapse: one entry per short key ------------------------------------

const empty = []
const collapsedEmpty = collapseRevisions(empty)
assert.deepEqual(collapsedEmpty, [], 'an empty listing collapses to nothing')
assert.notEqual(collapsedEmpty, empty, 'the result is a new array')

{
  const entries = [
    entryOf('L0/X/revisions/aaa/c.usda', '2026-11-01T00:00:00.000Z'),
    entryOf('L0/X/revisions/bbb/c.usda', '2026-11-20T00:00:00.000Z'),
    entryOf('L0/X/revisions/ccc/c.usda', '2026-11-10T00:00:00.000Z'),
  ]
  const collapsed = collapseRevisions(entries)
  assert.equal(collapsed.length, 1, 'three revisions of one object collapse to one entry')
  assert.equal(collapsed[0], entries[1], 'the newest revision wins')
}
{
  const entries = [
    entryOf('L0/X/revisions/first/c.usda', '2026-11-20T00:00:00.000Z'),
    entryOf('L0/X/revisions/second/c.usda', '2026-11-20T00:00:00.000Z'),
  ]
  assert.equal(collapseRevisions(entries)[0], entries[0], 'a tie keeps the first seen')
}
{
  const entries = [
    entryOf('L0/X/revisions/aaa/c.usda', '2026-11-01T00:00:00.000Z'),
    entryOf('L0/X/revisions/bbb/c.usda', ''),
  ]
  assert.equal(collapseRevisions(entries)[0], entries[0], 'an unparsable time never wins over a parsable one')
}
{
  const entries = [
    entryOf('L0/X/revisions/aaa/c.usda', ''),
    entryOf('L0/X/revisions/bbb/c.usda', ''),
  ]
  assert.equal(collapseRevisions(entries)[0], entries[0], 'with no time at all the first seen wins')
}
{
  const entries = [
    entryOf('L0/X/revisions/aaa/c.usda', '2026-11-20T00:00:00.000Z'),
    entryOf('L0/X/c.usda', '2026-11-01T00:00:00.000Z'),
  ]
  const collapsed = collapseRevisions(entries)
  assert.equal(collapsed.length, 1, 'a revision of a listed object is not a second object')
  assert.equal(collapsed[0], entries[1], 'the real entry beats a newer revision')
}
{
  const entries = [
    entryOf('L0/X/c.usda', '2026-11-01T00:00:00.000Z'),
    entryOf('L0/X/revisions/aaa/c.usda', '2026-11-20T00:00:00.000Z'),
  ]
  assert.equal(collapseRevisions(entries)[0], entries[0], 'the real entry wins in either order')
}
{
  const entries = [
    entryOf('L0/Y/revisions/aaa/b.usda', '2026-11-01T00:00:00.000Z'),
    entryOf('L0/X/c.usda', '2026-11-01T00:00:00.000Z'),
    entryOf('L0/Y/revisions/bbb/b.usda', '2026-11-20T00:00:00.000Z'),
  ]
  const collapsed = collapseRevisions(entries)
  assert.equal(collapsed.length, 2, 'two objects and their revisions collapse to two entries')
  assert.equal(collapsed[0], entries[2], 'a replacement keeps the position of the first occurrence')
  assert.equal(collapsed[1], entries[1], 'an unrelated object keeps its own position')
  assert.equal(entries.length, 3, 'the input is left alone')
}
say('revisions collapse   newest wins, ties and plain entries win, order kept')

process.stdout.write('revisions.test.mjs  OK\n')
