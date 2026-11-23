/**
 * Modeling-session archives: naming, manifest, commit records, snapshot choice.
 *
 * A human+agent modeling session (see the sibling `usd-brep` spec) archives
 * itself as a plain directory on local disk:
 *
 *   session.json                    session_id, archive_format_version,
 *                                   protocol_version, build { build_id, ... }
 *   commits/<20 digits>.json        one immutable record per successful commit;
 *                                   its `objects` array is the object summary
 *   snapshots/<rev>.usda            the committed model at that revision, a USD
 *                                   stage exported from the kernel (the commit
 *                                   writer pads the revision to 20 digits; a
 *                                   plain decimal name is read too)
 *   events.jsonl                    the runner's diagnostics (not read here)
 *
 * This module is the side-effect-free half of previewing one: it parses the
 * manifest, ranks the two revision-numbered folders, reads the newest commit's
 * object summary, and resolves the newest snapshot. The React body
 * (`SessionBody.jsx`) owns the bytes and the viewport; the sidebar delivers
 * those bytes either through the workspace Remote (a file opened by address) or
 * through a dropped folder's file table, so both doors reach here through the
 * same `source` interface:
 *
 *   source.key(relativePath)      the key/path this archive names `relativePath` by
 *   source.read(relativePath)     its bytes, or undefined when absent/unreadable
 *   source.list(relativePath)     `{ entries }` or `{ error }`
 *
 * Everything here is total: a missing folder, a corrupt record or an older
 * archive without snapshots becomes a warning on a resolved archive, never a
 * thrown error, because a preview that crashes on a valid old session is worse
 * than one that says what it could not find.
 *
 * @module dsh-usd-3d-preview/session
 */

/** The sidebar tab implementation id: the key its body registers under. */
export const SESSION_TAB_ID = 'dsh-usd-3d-preview/session'

/** The kind the session-archive tab opens as; unique across the profile. */
export const SESSION_TAB_KIND = 'usd-session'

/**
 * Address globs that recognize a session manifest at any path depth.
 *
 * The document-preview registry matches declared suffixes against the whole file
 * name with a leading dot, so it cannot claim the archive's exact `session.json`
 * (declaring `session.json` would only match `foo.session.json`, and declaring
 * `json` would take every other JSON file in a workspace). A sidebar tab type
 * matches globs instead, which is what makes one file name selectable without
 * claiming the others: the plain name matches at any depth, and the dotted form
 * also accepts an archive renamed to `my.session.json`.
 */
export const SESSION_TAB_PATTERNS = ['session.json', '*.session.json']

/** The manifest's file name; a directory holding one is treated as an archive root. */
export const SESSION_MANIFEST_NAME = 'session.json'

/** Directory holding one exported USD stage per committed revision. */
export const SNAPSHOT_DIRECTORY = 'snapshots'

/** Directory holding one immutable record per committed revision. */
export const COMMIT_DIRECTORY = 'commits'

/**
 * One snapshot file name: a decimal revision plus a USD container suffix.
 *
 * The archive's commit records use the spec's zero-padded 20-digit width, and a
 * snapshot written beside them uses the same padding. A plain decimal name is
 * accepted too — the snapshot export is a separate producer, and refusing an
 * archive over padding would hide a perfectly readable model.
 */
const SNAPSHOT_NAME = /^(\d{1,20})\.(usda|usdc|usd)$/i

/** One commit record file name: 20 digits plus `.json`. */
const COMMIT_NAME = /^(\d{20})\.json$/i

/**
 * Whether one file name is a session-archive manifest.
 *
 * Both spellings are accepted: the archive's own `session.json` (the exact name
 * the spec fixes) and a renamed `my.session.json` (the dotted form the sidebar
 * tab type also claims). A longer name that merely contains `session.json`
 * (`mysession.json`) is not one.
 * @param name - a file name or path, with either separator.
 * @returns true when the basename is `session.json`, in any case.
 */
export function isSessionArchiveName(name) {
  const text = String(name ?? '').replaceAll('\\', '/')
  const base = text.slice(text.lastIndexOf('/') + 1).toLowerCase()
  return base === SESSION_MANIFEST_NAME || base.endsWith(`.${SESSION_MANIFEST_NAME}`)
}

/**
 * Decode one small JSON file.
 * @param bytes - UTF-8 bytes.
 * @returns the decoded text, with a UTF-8 BOM tolerated.
 */
function decodeJson(bytes) {
  const text = new TextDecoder().decode(bytes)
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Whether a value is byte-like enough to decode.
 * @param value - any source result.
 * @returns true for a Uint8Array, an ArrayBuffer or a typed-array view.
 */
function isBytes(value) {
  return value instanceof Uint8Array
    || value instanceof ArrayBuffer
    || (ArrayBuffer.isView(value) === true && typeof value.byteLength === 'number')
}

/**
 * Normalise one byte-like value to a Uint8Array.
 * @param value - a value {@link isBytes} accepted.
 * @returns the bytes.
 */
function toBytes(value) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
}

/**
 * Throw the browser's cancellation error, the shape every caller here knows.
 * @param signal - the owning tab's signal.
 */
function throwIfAborted(signal) {
  if (signal?.aborted === true) throw new DOMException('aborted', 'AbortError')
}

/**
 * Canonical form of a zero-padded revision: its decimal digits without leading zeros.
 * @param digits - the digits from a revision file name, or a record's `model_rev`.
 * @returns the canonical decimal string.
 */
export function canonicalRevision(digits) {
  const text = String(digits ?? '').trim()
  const stripped = text.replace(/^0+/, '')
  return stripped === '' ? '0' : stripped
}

/**
 * The revision a snapshot file name declares.
 * @param name - a file name, with or without a directory.
 * @returns the canonical revision, or undefined when the name is not a snapshot.
 */
export function revisionOfSnapshotName(name) {
  const text = String(name ?? '')
  const base = text.slice(text.lastIndexOf('/') + 1)
  const match = SNAPSHOT_NAME.exec(base)
  return match === null ? undefined : canonicalRevision(match[1])
}

/**
 * The revision a commit record file name declares.
 * @param name - a file name, with or without a directory.
 * @returns the canonical revision, or undefined when the name is not a record.
 */
export function revisionOfCommitName(name) {
  const text = String(name ?? '')
  const base = text.slice(text.lastIndexOf('/') + 1)
  const match = COMMIT_NAME.exec(base)
  return match === null ? undefined : canonicalRevision(match[1])
}

/**
 * Rank one directory listing by revision, newest first.
 *
 * Only regular files matter: `type` is absent in a dropped file table's synthesized
 * listing, so an absent type is treated as a file and an explicit `directory`
 * as not one. Names that do not match the revision pattern are skipped, which
 * keeps temp files (`.tmp`, a partial write) and unrelated files out of the choice.
 * @param entries - the listed children.
 * @param revisionOf - name parser for this kind of entry.
 * @returns the matching entries, newest revision first.
 */
function rankRevisions(entries, revisionOf) {
  const ranked = []
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (entry === null || typeof entry !== 'object') continue
    if (entry.type === 'directory' || entry.type === 'other') continue
    const name = typeof entry.name === 'string' ? entry.name : ''
    const rev = revisionOf(name)
    if (rev === undefined) continue
    ranked.push({ rev, name, rank: BigInt(rev) })
  }
  return ranked.sort((left, right) => (left.rank === right.rank ? 0 : left.rank > right.rank ? -1 : 1))
}

/**
 * The newest snapshot in a `snapshots/` listing.
 * @param entries - the listed children.
 * @returns the newest snapshot, or undefined when the folder holds none.
 */
export function newestSnapshot(entries) {
  const [first] = rankRevisions(entries, revisionOfSnapshotName)
  return first === undefined ? undefined : { rev: first.rev, name: first.name }
}

/**
 * The newest commit record in a `commits/` listing.
 * @param entries - the listed children.
 * @returns the newest record, or undefined when the folder holds none.
 */
export function newestCommitRecord(entries) {
  const [first] = rankRevisions(entries, revisionOfCommitName)
  return first === undefined ? undefined : { rev: first.rev, name: first.name }
}

/**
 * Canonical manifest fields, the wire spellings they are authored under, and how
 * each is read.
 *
 * The archive writer names the archive version `archive_format_version` and
 * nests the build identity under `build` (a dict whose `build_id` is the string
 * replay compares). The shorter (`archive_version`, top-level `build_id`) and
 * camelCase spellings are accepted too: the manifest is a small hand-authored
 * file as often as it is a writer's output, and a reader that refuses an
 * otherwise complete archive over a synonym would hide the model.
 */
const MANIFEST_FIELDS = [
  { key: 'sessionId', wire: 'session_id', aliases: ['session_id', 'sessionId'], read: manifestIdentifier },
  { key: 'archiveVersion', wire: 'archive_format_version', aliases: ['archive_format_version', 'archive_version', 'archiveFormatVersion'], read: manifestVersion },
  { key: 'protocolVersion', wire: 'protocol_version', aliases: ['protocol_version', 'protocolVersion'], read: manifestVersion },
  { key: 'buildId', wire: 'build', aliases: ['build', 'build_id', 'buildId'], read: manifestBuild },
]

/**
 * Read one identifier value.
 * @param value - the authored value.
 * @returns the trimmed string, or undefined when the value cannot be used.
 */
function manifestIdentifier(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : undefined
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' ? undefined : text
}

/**
 * Read one version value.
 *
 * A version is a number in JSON by convention; the string spelling is accepted
 * because the archive's writer is Python and either is a legitimate choice.
 * @param value - the authored value.
 * @returns the string form, or undefined when the value cannot be used.
 */
function manifestVersion(value) {
  return manifestIdentifier(value)
}

/**
 * Read the build identity: the flat `build_id` string, or the writer's `build`
 * dict, whose `build_id` is the combined identifier and whose parts name the
 * app and kernel build.
 * @param value - the authored value.
 * @returns a displayable build identifier, or undefined when none is usable.
 */
function manifestBuild(value) {
  const flat = manifestIdentifier(value)
  if (flat !== undefined) return flat
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const id = manifestIdentifier(value.build_id) ?? manifestIdentifier(value.buildId)
  if (id !== undefined) return id
  // A build dict without the combined identifier still records which build it
  // was: the app version and kernel configuration are the readable parts.
  const app = manifestIdentifier(value.app_version) ?? manifestIdentifier(value.appVersion)
  const kernel = manifestIdentifier(value.kernel_config) ?? manifestIdentifier(value.kernelConfig)
  const parts = [app, kernel === undefined ? undefined : `kernel-${kernel}`].filter(part => part !== undefined)
  return parts.length === 0 ? undefined : parts.join(' ')
}

/**
 * Parse an archive manifest.
 *
 * The four fields the spec names are all read tolerantly: snake_case and
 * camelCase spellings both work, a version may be a JSON number or a string, and
 * a missing or empty field is reported rather than fatal — an archive whose
 * writer omitted `build_id` still has a snapshot worth showing.
 * @param text - the decoded `session.json` body.
 * @returns the fields, the wire names of the missing ones, or an error code.
 */
export function parseSessionManifest(text) {
  let value
  try {
    value = JSON.parse(String(text ?? ''))
  } catch {
    return { error: 'invalid-json' }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'not-object' }
  }
  const fields = {}
  const missing = []
  for (const field of MANIFEST_FIELDS) {
    const name = field.aliases.find(alias => Object.hasOwn(value, alias))
    const normalized = name === undefined ? undefined : field.read(value[name])
    if (normalized === undefined) {
      missing.push(field.wire)
      continue
    }
    fields[field.key] = normalized
  }
  // A JSON object that carries none of the manifest's fields is not this
  // archive's manifest: showing a session panel for it would claim a document
  // this preview does not understand.
  if (missing.length === MANIFEST_FIELDS.length) return { error: 'not-session-archive' }
  return { fields, missing }
}

/**
 * The object entries one commit record summarizes.
 *
 * The spec names an "operation-after summary" without fixing its shape, so the
 * reader accepts the shapes a Python writer naturally emits: a `summary` object
 * holding `objects` (a list) or `object` (one entry), the same lists at the
 * record's top level, and a summary that is itself one object's counts.
 * @param record - the parsed commit record.
 * @returns the object entries it carries; empty when it carries none.
 */
function commitObjectEntries(record) {
  const summary = record.summary !== null && typeof record.summary === 'object' && !Array.isArray(record.summary)
    ? record.summary
    : undefined
  const candidates = [summary?.objects, summary?.object, record.objects]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.filter(entry => entry !== null && typeof entry === 'object')
    if (candidate !== null && typeof candidate === 'object') return [candidate]
  }
  if (summary !== undefined && hasTopologyCounts(summary)) return [summary]
  if (hasTopologyCounts(record)) return [record]
  return []
}

/**
 * Whether one object entry carries any topology count.
 * @param entry - one object entry.
 * @returns true when `faces`, `edges` or `vertices` is a finite number.
 */
function hasTopologyCounts(entry) {
  return ['faces', 'edges', 'vertices'].some(key => Number.isFinite(entry?.[key]))
}

/**
 * The uniform value of one numeric count over every entry.
 * @param entries - the object entries.
 * @param key - the count's field name.
 * @returns the total when every entry declares it, else null.
 */
function totalCount(entries, key) {
  let total = 0
  for (const entry of entries) {
    const value = entry?.[key]
    if (!Number.isFinite(value)) return null
    total += value
  }
  return total
}

/**
 * The uniform value of one per-object flag over every entry.
 * @param entries - the object entries.
 * @param key - the flag's field name.
 * @returns true/false when at least one entry declares it and all agree, else null.
 */
function uniformFlag(entries, key) {
  let seen
  for (const entry of entries) {
    if (typeof entry?.[key] !== 'boolean') continue
    if (seen !== undefined && seen !== entry[key]) return null
    seen = entry[key]
  }
  return seen === undefined ? null : seen
}

/**
 * Summarise the objects a commit record reports.
 *
 * A count is reported only when every object entry declares it: a partial sum
 * would read as the model's own total. The object count itself always survives,
 * because it is the one number the panel can state from a list alone.
 * @param record - the parsed commit record.
 * @returns the summary, or undefined when the record carries no object data.
 */
export function summarizeCommitRecord(record) {
  const entries = commitObjectEntries(record)
  if (entries.length > 0) {
    const kinds = []
    for (const entry of entries) {
      if (typeof entry?.kind === 'string' && entry.kind !== '' && !kinds.includes(entry.kind)) kinds.push(entry.kind)
    }
    return {
      objects: entries.length,
      faces: totalCount(entries, 'faces'),
      edges: totalCount(entries, 'edges'),
      vertices: totalCount(entries, 'vertices'),
      manifold: uniformFlag(entries, 'manifold'),
      volume: totalCount(entries, 'volume'),
      kinds,
    }
  }
  // A record with no summary object may still name the IDs it touched, which is
  // the minimum "what did this commit change" answer the panel can give.
  const ids = [record.object_ids, record.objectIds].find(value => Array.isArray(value))
  if (ids !== undefined) {
    return { objects: ids.length, faces: null, edges: null, vertices: null, manifold: null, volume: null, kinds: [] }
  }
  return undefined
}

/**
 * Parse one immutable commit record.
 * @param text - the decoded record body.
 * @returns the record's revision and summary, or an error code.
 */
export function parseCommitRecord(text) {
  let value
  try {
    value = JSON.parse(String(text ?? ''))
  } catch {
    return { error: 'invalid-json' }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { error: 'not-object' }
  }
  const declared = [value.model_rev, value.modelRev].find(candidate => candidate !== undefined)
  const modelRev = declared === undefined
    ? undefined
    : (typeof declared === 'number' && Number.isFinite(declared) ? String(declared) : canonicalRevision(declared))
  return { modelRev, summary: summarizeCommitRecord(value) }
}

/**
 * List one archive folder, turning an unreadable one into a reported failure.
 * @param source - the archive byte source.
 * @param directory - the folder, relative to the archive root.
 * @param signal - the owning tab's signal.
 * @returns the entries, or the error code the listing reported.
 */
async function listDirectory(source, directory, signal) {
  throwIfAborted(signal)
  try {
    const listing = await source.list(directory, signal)
    throwIfAborted(signal)
    if (listing === undefined || listing === null) return { error: 'missing' }
    if (listing.error !== undefined) return { error: String(listing.error) }
    return { entries: Array.isArray(listing.entries) ? listing.entries : [] }
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted === true) throw error
    return { error: String(error?.code ?? 'read-failed') }
  }
}

/**
 * Read one archive file, turning an unreadable one into `undefined`.
 * @param source - the archive byte source.
 * @param relative - the file, relative to the archive root.
 * @param signal - the owning tab's signal.
 * @returns the bytes, or undefined when the file is absent or unreadable.
 */
async function readFile(source, relative, signal) {
  throwIfAborted(signal)
  try {
    const value = await source.read(relative, signal)
    throwIfAborted(signal)
    return isBytes(value) && value.byteLength > 0 ? toBytes(value) : undefined
  } catch (error) {
    if (error?.name === 'AbortError' || signal?.aborted === true) throw error
    return undefined
  }
}

/**
 * Resolve one session archive: manifest, newest snapshot, newest commit record.
 *
 * Never throws for archive problems: a corrupt manifest is a failed resolution
 * (`state: 'failed'`) because there is no archive to describe, while every other
 * problem — an older archive with no `snapshots/`, an empty folder, a record that
 * does not parse — is a warning on a `ready` resolution whose other parts still
 * render. That split is what lets an archive written before snapshots existed
 * still show its session id, revision and object summary.
 * @param options - resolution inputs.
 * @param options.source - archive byte source (workspace Remote or a dropped table).
 * @param options.sessionBytes - the manifest bytes when the document owner already read them.
 * @param options.signal - the owning tab's signal.
 * @returns the resolved archive.
 */
export async function resolveSessionArchive({ source, sessionBytes, signal }) {
  const warnings = []
  let manifestBytes = isBytes(sessionBytes) ? toBytes(sessionBytes) : undefined
  if (manifestBytes === undefined) manifestBytes = await readFile(source, SESSION_MANIFEST_NAME, signal)
  if (manifestBytes === undefined) return { state: 'failed', error: 'manifest-missing', warnings }

  const manifest = parseSessionManifest(decodeJson(manifestBytes))
  if (manifest.error !== undefined) return { state: 'failed', error: manifest.error, warnings }
  if (manifest.missing.length > 0) {
    warnings.push({ code: 'missing-fields', params: { fields: manifest.missing.join(', ') } })
  }

  // ── the snapshot to draw ──────────────────────────────────────────────────
  let snapshot
  const snapshots = await listDirectory(source, SNAPSHOT_DIRECTORY, signal)
  if (snapshots.error !== undefined) {
    // A directory that is not there is the normal shape of an archive written
    // before snapshots existed; anything else is a read failure worth naming.
    warnings.push(snapshots.error === 'missing' || snapshots.error === 'workspace-file/not-found'
      ? { code: 'no-snapshot-directory' }
      : { code: 'snapshot-directory-unreadable', params: { reason: snapshots.error } })
  } else {
    const newest = newestSnapshot(snapshots.entries)
    if (newest === undefined) {
      warnings.push({ code: 'no-snapshots' })
    } else {
      const relative = `${SNAPSHOT_DIRECTORY}/${newest.name}`
      const bytes = await readFile(source, relative, signal)
      if (bytes === undefined) {
        warnings.push({ code: 'snapshot-unreadable', params: { rev: newest.rev } })
      } else {
        snapshot = { rev: newest.rev, name: newest.name, path: source.key(relative), bytes }
      }
    }
  }

  // ── the newest commit record, for the object summary ──────────────────────
  let commit
  const commits = await listDirectory(source, COMMIT_DIRECTORY, signal)
  if (commits.error !== undefined) {
    warnings.push(commits.error === 'missing' || commits.error === 'workspace-file/not-found'
      ? { code: 'no-commit-directory' }
      : { code: 'commit-directory-unreadable', params: { reason: commits.error } })
  } else {
    const newest = newestCommitRecord(commits.entries)
    if (newest === undefined) {
      warnings.push({ code: 'no-commits' })
    } else {
      const relative = `${COMMIT_DIRECTORY}/${newest.name}`
      const bytes = await readFile(source, relative, signal)
      if (bytes === undefined) {
        warnings.push({ code: 'commit-unreadable', params: { rev: newest.rev } })
      } else {
        const record = parseCommitRecord(decodeJson(bytes))
        if (record.error !== undefined) {
          warnings.push({ code: 'commit-corrupt', params: { rev: newest.rev } })
        } else {
          commit = { rev: newest.rev, name: newest.name, path: source.key(relative), modelRev: record.modelRev, summary: record.summary }
          if (record.modelRev !== undefined && canonicalRevision(record.modelRev) !== newest.rev) {
            warnings.push({ code: 'commit-rev-mismatch', params: { rev: newest.rev, recorded: record.modelRev } })
          }
        }
      }
    }
  }

  // The snapshot is what is drawn; the commit is what the session recorded. They
  // advance together unless a snapshot export lags, and saying so keeps the panel
  // from implying the viewport is the newest state of the model.
  if (snapshot !== undefined && commit !== undefined && snapshot.rev !== commit.rev) {
    warnings.push({
      code: BigInt(snapshot.rev) > BigInt(commit.rev) ? 'snapshot-newer-than-commit' : 'snapshot-older-than-commit',
      params: { snapshotRev: snapshot.rev, commitRev: commit.rev },
    })
  }

  return {
    state: 'ready',
    manifest: manifest.fields,
    missingFields: manifest.missing,
    snapshot,
    commit,
    // The revision the session is at: the newest recorded commit. A snapshot can
    // exist without one (a record was pruned, or only snapshots were copied), so
    // it is the fallback rather than the definition.
    modelRev: commit?.rev ?? snapshot?.rev,
    summary: commit?.summary,
    warnings,
  }
}
