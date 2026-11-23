/**
 * The modeling-session archive panel: one archived session, drawn with the
 * existing USD viewport.
 *
 * A session archive's newest `snapshots/<rev>.usda` is a USD stage like any
 * other, so this body does not carry a renderer of its own: it resolves which
 * snapshot is newest (see `session.js`), reads its bytes through the door the
 * document came through, and mounts `UsdBody` with those bytes. Composition
 * arcs, prim picking, the details/text/composition read-back panels and the
 * studio rig are therefore exactly the USD preview's, not a second copy of it.
 *
 * Two doors reach the same body, mirroring `UsdBody`:
 *
 *   * a `session.json` opened from the Files tab — the sidebar's tab type claims
 *     the file by name, and this body reads `session.json`, `snapshots/` and
 *     `commits/` through the injected workspace reader/listing (the same Remote
 *     the USD preview uses);
 *   * a session folder dropped on the sidebar — every file is already in the
 *     drop's table, so the snapshot and record are read from it by key.
 *
 * A small panel above the viewport always says what the archive records:
 * session id, the model revision and the newest commit's object summary. It also
 * states, in place of the viewport, why there is nothing to draw: an archive
 * written before snapshots existed, an empty `snapshots/` folder, or a snapshot
 * that cannot be read. None of those is an error state — only a `session.json`
 * that is not this archive's manifest is.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { isSessionArchiveName, resolveSessionArchive } from './session.js'
import { UsdBody } from './UsdBody.jsx'
import { parseFileReference } from './usd.js'
import { BASE, BORDER, ERROR, FONT, LABEL, LABEL_DIM, MONO, SURFACE } from './tokens.js'

const SHELL = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  background: BASE,
  color: LABEL,
  fontFamily: FONT,
  fontSize: 12,
}

const PANEL = {
  flex: '0 0 auto',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  padding: '6px 8px 7px',
  borderBottom: `1px solid ${BORDER}`,
  background: SURFACE,
  minWidth: 0,
}

const PANEL_HEAD = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 6,
  minWidth: 0,
}

const PANEL_TITLE = {
  flex: '0 0 auto',
  color: LABEL_DIM,
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
}

const PANEL_ID = {
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontFamily: MONO,
  fontSize: 11,
  color: LABEL,
}

const PANEL_STATS = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'baseline',
  gap: '1px 12px',
  minWidth: 0,
  lineHeight: 1.6,
}

const PANEL_LABEL = { color: LABEL_DIM, fontSize: 11 }
const PANEL_VALUE = { color: LABEL, fontFamily: MONO, fontSize: 11 }
const WARNING = { color: LABEL_DIM, fontSize: 11, lineHeight: 1.5 }
const WARNING_ERROR = { ...WARNING, color: ERROR }

const VIEWPORT = { position: 'relative', flex: '1 1 auto', minHeight: 0 }

const CENTERED = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
  textAlign: 'center',
}

const STATUS = { color: LABEL_DIM, lineHeight: 1.7, maxWidth: 440, wordBreak: 'break-word' }

/**
 * Dictionary lookup with a literal fallback: copy must never be the reason a
 * preview fails to render, and the harness mounts this body without a dictionary.
 * @param t - locale binding, possibly absent.
 * @param key - dictionary key.
 * @param fallback - template used when the dictionary has no entry.
 * @param params - interpolation values for either the entry or the fallback.
 * @returns the localized string, or the filled-in fallback.
 */
function labeled(t, key, fallback, params) {
  const fill = (template) => String(template).replace(/\{(\w+)\}/g, (_all, name) => String(params?.[name] ?? ''))
  if (typeof t === 'function') {
    try {
      const value = params === undefined ? t(key) : t(key, params)
      if (value !== undefined && value !== null && value !== key) return value
    } catch {
      // A missing namespace is a fallback, not a failure.
    }
  }
  return fill(fallback)
}

/** Join one archive root and a path inside it, without doubling the separator. */
function joinPosix(base, relative) {
  return base === '' ? relative : `${base}/${relative}`
}

/**
 * The archive byte source for a `session.json` opened by address.
 * @param reference - the session-scoped address parts.
 * @param readers - injected workspace readers.
 * @returns the source `resolveSessionArchive` consumes.
 */
function workspaceSource(reference, readers) {
  const slash = reference.path.lastIndexOf('/')
  const base = slash < 0 ? '' : reference.path.slice(0, slash)
  const pathOf = relative => joinPosix(base, relative)
  return {
    key: pathOf,
    read: async (relative, signal) => {
      const read = readers.readLayer
      if (typeof read !== 'function') return undefined
      return await read(reference.sessionId, pathOf(relative), signal)
    },
    list: async (relative, signal) => {
      const list = readers.listDirectory
      if (typeof list !== 'function') return { error: 'unsupported' }
      return await list(reference.sessionId, pathOf(relative), signal)
    },
  }
}

/**
 * The archive byte source for a dropped folder.
 *
 * Dropped files are keyed by their package-relative path, so the archive root is
 * the dropped folder itself and every lookup is one map read. A folder lists by
 * scanning the keys under the prefix; a key with a separator below it is an
 * intermediate directory, one without is a child file.
 * @param files - the drop's file table.
 * @param rootKey - the dropped `session.json` key.
 * @returns the source `resolveSessionArchive` consumes.
 */
function droppedSource(files, rootKey) {
  const text = String(rootKey ?? '')
  const slash = text.lastIndexOf('/')
  const base = slash < 0 ? '' : text.slice(0, slash)
  const keyOf = relative => joinPosix(base, relative)
  return {
    key: keyOf,
    read: async (relative) => {
      const blob = files.get(keyOf(relative))
      if (blob === undefined || blob === null || typeof blob.arrayBuffer !== 'function') return undefined
      return new Uint8Array(await blob.arrayBuffer())
    },
    list: async (relative) => {
      const prefix = `${keyOf(relative)}/`
      const entries = new Map()
      for (const [key, file] of files) {
        const name = String(key)
        if (!name.startsWith(prefix)) continue
        const rest = name.slice(prefix.length)
        if (rest === '') continue
        const separator = rest.indexOf('/')
        if (separator < 0) entries.set(rest, { name: rest, type: 'file', size: file?.size })
        else if (!entries.has(rest.slice(0, separator))) entries.set(rest.slice(0, separator), { name: rest.slice(0, separator), type: 'directory' })
      }
      return { entries: [...entries.values()] }
    },
  }
}

/** Warning codes whose message a reader should see in the error colour. */
const SERIOUS_WARNINGS = new Set(['commit-corrupt', 'commit-unreadable', 'snapshot-unreadable', 'snapshot-directory-unreadable', 'commit-directory-unreadable'])

/**
 * The sentence one resolution warning becomes.
 * @param warning - a `{ code, params }` warning from `resolveSessionArchive`.
 * @param t - locale binding.
 * @returns the localized sentence.
 */
function warningText(warning, t) {
  const params = warning.params ?? {}
  switch (warning.code) {
    case 'missing-fields':
      return labeled(t, 'sessionMissingFields', 'session.json is missing: {fields}', params)
    case 'no-snapshot-directory':
      return labeled(t, 'sessionNoSnapshotDirectory', 'This archive has no snapshots/ folder, so there is no rendered model to show.')
    case 'snapshot-directory-unreadable':
      return labeled(t, 'sessionSnapshotDirectoryUnreadable', 'The snapshots/ folder could not be read: {reason}', params)
    case 'no-snapshots':
      return labeled(t, 'sessionNoSnapshots', 'No rendered snapshot yet.')
    case 'snapshot-unreadable':
      return labeled(t, 'sessionSnapshotUnreadable', 'The snapshot for revision {rev} could not be read.', params)
    case 'no-commit-directory':
      return labeled(t, 'sessionNoCommitDirectory', 'This archive has no commits/ folder, so it carries no object summary.')
    case 'commit-directory-unreadable':
      return labeled(t, 'sessionCommitDirectoryUnreadable', 'The commits/ folder could not be read: {reason}', params)
    case 'no-commits':
      return labeled(t, 'sessionNoCommits', 'No commit records yet.')
    case 'commit-unreadable':
      return labeled(t, 'sessionCommitUnreadable', 'Commit record {rev} could not be read.', params)
    case 'commit-corrupt':
      return labeled(t, 'sessionCommitCorrupt', 'Commit record {rev} is not valid JSON, so the object summary is unavailable.', params)
    case 'commit-rev-mismatch':
      return labeled(t, 'sessionCommitRevMismatch', 'Commit record {rev} declares revision {recorded}.', params)
    case 'snapshot-older-than-commit':
      return labeled(t, 'sessionSnapshotOlder', 'Showing snapshot revision {snapshotRev}; the newest commit is revision {commitRev}.', params)
    case 'snapshot-newer-than-commit':
      return labeled(t, 'sessionSnapshotNewer', 'The newest snapshot is revision {snapshotRev}; the newest commit is revision {commitRev}.', params)
    default:
      return String(warning.code)
  }
}

/**
 * The sentence a failed resolution becomes.
 * @param failure - a `{ code, params }` failure.
 * @param t - locale binding.
 * @returns the localized sentence.
 */
function failureText(failure, t) {
  const params = failure.params ?? {}
  switch (failure.code) {
    case 'manifest-missing':
      return labeled(t, 'sessionManifestMissing', 'This archive has no readable session.json.')
    case 'invalid-json':
      return labeled(t, 'sessionManifestInvalid', 'session.json is not valid JSON, so this file cannot be read as a modeling-session archive.')
    case 'not-object':
      return labeled(t, 'sessionManifestNotObject', 'session.json does not hold a JSON object.')
    case 'not-session-archive':
      return labeled(t, 'sessionNotArchive', 'This file is not a modeling-session archive: session.json carries none of session_id, archive_version, protocol_version or build_id.')
    case 'unsupported-address':
      return labeled(t, 'sessionUnsupportedAddress', 'Open this archive from a workspace folder, or drop the folder, so its snapshots can be read.')
    default:
      return labeled(t, 'sessionUnexpected', 'This session archive could not be previewed: {message}', params)
  }
}

/**
 * The panel above the viewport: session id, revision and object summary.
 * @param props.archive - the resolved archive.
 * @param props.t - locale binding.
 * @returns the header strip.
 */
function SessionPanel({ archive, t }) {
  const manifest = archive.manifest ?? {}
  const summary = archive.summary
  const versions = [manifest.archiveVersion === undefined ? undefined : `archive v${manifest.archiveVersion}`,
    manifest.protocolVersion === undefined ? undefined : `protocol v${manifest.protocolVersion}`,
    manifest.buildId === undefined ? undefined : `build ${manifest.buildId}`].filter(value => value !== undefined).join(' · ')
  const counts = [
    ['sessionFaces', 'faces', summary?.faces],
    ['sessionEdges', 'edges', summary?.edges],
    ['sessionVertices', 'vertices', summary?.vertices],
    ['sessionVolume', 'volume', summary?.volume],
  ].filter(([, , value]) => typeof value === 'number')
  return (
    <div
      style={PANEL}
      data-session-panel
      data-session-id={manifest.sessionId ?? ''}
      data-session-model-rev={archive.modelRev ?? ''}
      data-session-snapshot-rev={archive.snapshot?.rev ?? ''}
      data-session-objects={typeof summary?.objects === 'number' ? summary.objects : ''}
      data-session-warnings={archive.warnings.length}
      title={versions === '' ? undefined : versions}
    >
      <div style={PANEL_HEAD}>
        <span style={PANEL_TITLE}>{labeled(t, 'sessionTitle', 'Modeling session')}</span>
        <span style={PANEL_ID} data-session-session-id title={manifest.sessionId}>{manifest.sessionId ?? labeled(t, 'sessionUnknown', 'unknown session')}</span>
      </div>
      <div style={PANEL_STATS}>
        <span><span style={PANEL_LABEL}>{labeled(t, 'sessionModelRev', 'model_rev')}</span> <span style={PANEL_VALUE} data-session-model-rev-value>{archive.modelRev ?? '—'}</span></span>
        <span><span style={PANEL_LABEL}>{labeled(t, 'sessionObjects', 'objects')}</span> <span style={PANEL_VALUE} data-session-objects-value title={summary?.kinds?.length ? summary.kinds.join(' · ') : undefined}>{typeof summary?.objects === 'number' ? summary.objects : '—'}</span></span>
        {counts.map(([key, fallback, value]) => (
          <span key={key} data-session-count={key}>
            <span style={PANEL_LABEL}>{labeled(t, key, fallback)}</span> <span style={PANEL_VALUE}>{value}</span>
          </span>
        ))}
      </div>
      {archive.warnings.map((warning, index) => (
        <div
          key={`${warning.code}-${index}`}
          style={SERIOUS_WARNINGS.has(warning.code) ? WARNING_ERROR : WARNING}
          data-session-warning={warning.code}
        >
          {warningText(warning, t)}
        </div>
      ))}
    </div>
  )
}

/**
 * The session-archive body.
 * @param props - the resource address, or the dropped-folder pair.
 * @param props.resourceAddress - the `session.json`'s address; its scope names the reader.
 * @param props.droppedFiles - dropped files keyed by package-relative path.
 * @param props.droppedRootKey - the dropped `session.json`'s key.
 * @param props.readLayer - injected workspace bytes reader.
 * @param props.readAsset - injected `s3://` asset reader, passed through to the viewport.
 * @param props.listDirectory - injected workspace directory lister.
 * @param props.t - locale binding.
 * @returns the session panel and its viewport, or the reason it has neither.
 */
export function SessionBody(props) {
  const { resourceAddress, droppedFiles, droppedRootKey, readLayer, readAsset, listDirectory } = props
  const t = props.t
  const workspace = useMemo(() => parseFileReference(resourceAddress), [resourceAddress])
  // The readers are registration-scoped, not render-scoped: a ref keeps a new
  // function identity from resolving the archive again on every paint.
  const readersRef = useRef({ readLayer, readAsset, listDirectory })
  readersRef.current = { readLayer, readAsset, listDirectory }
  const [archive, setArchive] = useState(null)
  const [failure, setFailure] = useState(null)

  useEffect(() => {
    if (droppedFiles === undefined && resourceAddress === undefined) {
      setArchive(null)
      setFailure(null)
      return undefined
    }
    let cancelled = false
    const controller = new AbortController()
    setArchive(null)
    setFailure(null)
    // One macrotask, so the loading line paints before a large snapshot blocks the thread.
    const timer = setTimeout(async () => {
      try {
        let source
        if (droppedFiles !== undefined) {
          const rootKey = droppedRootKey ?? [...droppedFiles.keys()].find(key => isSessionArchiveName(key))
          if (rootKey === undefined) {
            if (!cancelled) setFailure({ code: 'not-session-archive' })
            return
          }
          source = droppedSource(droppedFiles, rootKey)
        } else {
          if (workspace === undefined) {
            if (!cancelled) setFailure({ code: 'unsupported-address' })
            return
          }
          source = workspaceSource(workspace, readersRef.current)
        }
        const resolved = await resolveSessionArchive({ source, signal: controller.signal })
        if (!cancelled) setArchive(resolved)
      } catch (error) {
        if (cancelled || error?.name === 'AbortError') return
        setFailure({ code: 'unexpected', params: { message: error instanceof Error ? error.message : String(error) } })
      }
    }, 0)
    return () => {
      cancelled = true
      controller.abort()
      clearTimeout(timer)
    }
  }, [resourceAddress, workspace, droppedFiles, droppedRootKey])

  // The snapshot is a USD stage: the viewport is the existing body, handed the
  // snapshot bytes and a reader that resolves its references the same way the
  // file that named the snapshot would. The readers are read through the ref, so
  // a new function identity from a parent render cannot make UsdBody compose the
  // snapshot again.
  const remoteStage = useMemo(() => {
    const snapshot = archive?.snapshot
    if (snapshot === undefined || workspace === undefined) return undefined
    return {
      rootKey: snapshot.path,
      rootBytes: snapshot.bytes,
      read: (path, signal) => {
        const read = readersRef.current.readLayer
        return typeof read === 'function' ? read(workspace.sessionId, path, signal) : Promise.resolve(undefined)
      },
      readAsset: typeof readersRef.current.readAsset === 'function' ? readersRef.current.readAsset : undefined,
    }
  }, [archive, workspace])

  const snapshot = archive?.snapshot
  const state = failure !== null ? 'failed' : archive === null ? 'loading' : archive.state === 'failed' ? 'failed' : snapshot === undefined ? 'no-snapshot' : 'ready'

  return (
    <div style={SHELL} data-session-archive data-session-state={state}>
      {archive !== null && archive.state === 'ready' && <SessionPanel archive={archive} t={t} />}
      <div style={VIEWPORT} data-session-viewport>
        {failure !== null && (
          <div style={CENTERED} role="alert" data-session-error>
            <span style={STATUS}>{failureText(failure, t)}</span>
          </div>
        )}
        {failure === null && archive !== null && archive.state === 'failed' && (
          <div style={CENTERED} role="alert" data-session-error={archive.error}>
            <span style={STATUS}>{failureText({ code: archive.error }, t)}</span>
          </div>
        )}
        {failure === null && archive === null && (
          <div style={CENTERED} role="status">
            <span style={STATUS}>{labeled(t, 'sessionLoading', 'Reading the session archive…')}</span>
          </div>
        )}
        {failure === null && archive !== null && archive.state === 'ready' && snapshot !== undefined && (
          droppedFiles !== undefined
            ? <UsdBody t={t} droppedFiles={droppedFiles} droppedRootKey={snapshot.path} />
            : <UsdBody t={t} remoteStage={remoteStage} />
        )}
        {failure === null && archive !== null && archive.state === 'ready' && snapshot === undefined && (
          <div style={CENTERED} role="status" data-session-no-snapshot>
            <span style={STATUS}>{labeled(t, 'sessionNoSnapshot', 'No rendered snapshot to show yet — the session panel above lists what the archive records.')}</span>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The sidebar tab body for one session archive addressed by a file URL.
 *
 * The tab type (registered in `index.jsx`) claims a `session.json` by name; the
 * seat hands the body its tab reader, whose `contentId` is the file's address.
 * `SessionBody` resolves the archive from that address through the injected
 * readers, so this wrapper exists only to name the address and the copy.
 * @param props - the page-tab body props.
 * @returns the session archive body.
 */
export function SessionTabBody(props) {
  const { useTabInfo, t, readLayer, readAsset, listDirectory } = props
  const { tab } = useTabInfo()
  return (
    <SessionBody
      t={t}
      resourceAddress={tab.contentId}
      readLayer={readLayer}
      readAsset={readAsset}
      listDirectory={listDirectory}
    />
  )
}
