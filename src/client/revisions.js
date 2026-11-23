/**
 * Revision paths in the S3 asset store, as pure helpers.
 *
 * An asset object keeps its history below a `revisions` folder: the object
 * itself is listed at its normal key (`L0/X/c.usda`), while each published
 * revision sits under a folder named after the revision id
 * (`L0/X/revisions/9ca/c.usda`). A raw listing therefore shows a revisions
 * folder next to every object that has history, and a picker that renders those
 * entries would offer every revision as a second object.
 *
 * These helpers are the side-effect-free half of that layout: they parse a key
 * into its directory, revision id and remainder, map a revision key back to the
 * short key that names the object, and collapse a listing so one object appears
 * once. Nothing here reads state, touches the DOM or calls a store; the sidebar
 * runs these over the entries it already listed.
 */

/** Path segment that marks a revision folder. */
export const REVISIONS_SEGMENT = 'revisions'

/**
 * Locate the first revision pair in one key.
 *
 * The pair is a segment `revisions` followed by a non-empty segment, so a folder
 * with no revision below it (`a/revisions/`) and the word used as a file name
 * (`a/revisions.usda`) are not pairs. Only the first pair counts, which leaves
 * anything deeper in the remainder.
 * @param key - one object key.
 * @returns the pair's directory, id and remainder, or undefined without one.
 */
function matchRevision(key) {
  const text = String(key ?? '')
  let cursor = 0
  while (cursor < text.length) {
    const slash = text.indexOf('/', cursor)
    const stop = slash < 0 ? text.length : slash
    if (text.slice(cursor, stop) === REVISIONS_SEGMENT) {
      const idStart = stop + 1
      const idSlash = text.indexOf('/', idStart)
      const idStop = idSlash < 0 ? text.length : idSlash
      if (slash >= 0 && idStop > idStart) {
        return {
          dir: text.slice(0, cursor).replace(/\/+$/, ''),
          revision: text.slice(idStart, idStop),
          rest: idSlash < 0 ? '' : text.slice(idStop + 1),
        }
      }
    }
    if (slash < 0) break
    cursor = slash + 1
  }
  return undefined
}

/**
 * Parse one key into its revision parts.
 * @param key - one object key.
 * @returns { dir, revision, rest }, or undefined when the key has no pair.
 */
export function revisionOf(key) {
  const match = matchRevision(key)
  if (match === undefined) return undefined
  return { dir: match.dir, revision: match.revision, rest: match.rest }
}

/**
 * Revision id of one key.
 * @param key - one object key.
 * @returns the id below `revisions`, or undefined when the key has no pair.
 */
export function revisionIdOf(key) {
  const match = matchRevision(key)
  return match === undefined ? undefined : match.revision
}

/**
 * Whether one key belongs to a revision.
 * @param key - one object key.
 * @returns true when the key carries a `revisions`/`<id>` pair.
 */
export function isRevisionKey(key) {
  return matchRevision(key) !== undefined
}

/**
 * Short key of one key: the object it names, without its revision pair.
 *
 * The pair and the separator before it are dropped, and a trailing separator is
 * kept when the input ended with one, so a revision folder and the object inside
 * it map to the same shape. Every pair is dropped, which leaves the result
 * stable under repetition (the short key of a short key is itself).
 * @param key - one object key.
 * @returns the short key (the key itself when it has no pair).
 */
export function shortKeyOf(key) {
  let text = String(key ?? '')
  for (;;) {
    const match = matchRevision(text)
    if (match === undefined) return text
    if (match.rest === '') {
      text = match.dir + (text.endsWith('/') ? '/' : '')
      continue
    }
    text = match.dir === '' ? match.rest : match.dir + '/' + match.rest
  }
}

/**
 * Whether one listing entry is a revision folder.
 * @param entry - one listing entry, as the sidebar renders it.
 * @returns true for a folder whose last non-empty key segment is `revisions`.
 */
export function isRevisionsFolder(entry) {
  if (entry?.type !== 'folder') return false
  const segments = String(entry.key ?? '').split('/')
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index] !== '') return segments[index] === REVISIONS_SEGMENT
  }
  return false
}

/**
 * Modified time of one entry, when it parses.
 * @param entry - one listing entry.
 * @returns the time in milliseconds, or undefined for a missing/unparsable one.
 */
function modifiedTimeOf(entry) {
  const time = Date.parse(String(entry?.lastModified ?? ''))
  return Number.isNaN(time) ? undefined : time
}

/**
 * Collapse revision entries of one listing onto the objects they revise.
 *
 * A revision of an object that is already listed is history, not a second
 * object: one short key keeps a single entry, and the newest revision wins by
 * last-modified time. A plain entry is its own short key, so it always beats a
 * revision of the same object, and an unparsable time never beats a parsable
 * one. The result keeps the order in which each short key first appeared.
 * @param entries - the listing entries to collapse.
 * @returns a new array with at most one entry per short key.
 */
export function collapseRevisions(entries) {
  const chosen = new Map()
  for (const entry of entries ?? []) {
    const revision = isRevisionKey(entry?.key)
    const short = shortKeyOf(entry?.key)
    const current = chosen.get(short)
    if (current === undefined) {
      chosen.set(short, { entry, revision, time: revision ? modifiedTimeOf(entry) : undefined })
      continue
    }
    if (!revision) {
      if (current.revision) chosen.set(short, { entry, revision: false, time: undefined })
      continue
    }
    if (!current.revision) continue
    const time = modifiedTimeOf(entry)
    if (time === undefined) continue
    if (current.time === undefined || time > current.time) chosen.set(short, { entry, revision: true, time })
  }
  return Array.from(chosen.values(), slot => slot.entry)
}
