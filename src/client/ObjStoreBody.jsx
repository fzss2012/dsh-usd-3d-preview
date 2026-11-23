/**
 * Right-sidebar page body: browse the read-only object storage (asset bucket).
 *
 * The tab lists the asset library lazily -- through the host half's own signed
 * routes when a library is configured (`DSH_USD_S3_*`, or a connection saved from
 * this page), through a deployment gateway otherwise -- shows one directory at a
 * time with size/time, and can hand a USD stage straight to the existing USD
 * preview tab (same plugin, pending-drop handoff). Either way the page holds no
 * S3 credential: the host signs, the browser only ever sees JSON and bytes.
 *
 * Three details are this page's own:
 *
 *   - the directory it is in survives a tab switch (see `BROWSE`): switching
 *     sidebar tabs unmounts this body, and resetting a deep asset tree to the
 *     root on every visit makes it unreachable in practice;
 *   - a versioned asset (`<asset>/revisions/<id>/…`) is shown under its *short*
 *     path -- the key without the revision segment -- and when one listing holds
 *     several revisions of the same file, the newest one represents it;
 *   - the connection is a saved one (host half, on disk) unless this composition
 *     has no host route, in which case the panel falls back to a connection that
 *     lives in the page only.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  clearDirect,
  clearObjectStoreConfig,
  configureDirect,
  directConfig,
  directS3Uri,
  fetchObjectBytes,
  formatBytes,
  formatDate,
  hasDirect,
  hostLibrary,
  isUsdKey,
  listPrefix,
  loadObjectStoreConfig,
  publicAssetUrl,
  resetObjectStoreCaches,
  s3Uri,
  saveObjectStoreConfig,
  searchFiles,
  testDirect,
} from './objstore.js'
import { dirOf, normalizePath, resolvePath, s3KeyOf } from './remote.js'
import { collapseRevisions, isRevisionsFolder, revisionIdOf, shortKeyOf } from './revisions.js'
import { readS3Asset } from './s3open.js'
import {
  BASE, BORDER, ERROR, FONT, LABEL, LABEL_DIM, MONO, PRIMARY_FILL, PRIMARY_INK, SUCCESS, SURFACE, WASH,
} from './tokens.js'

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

const HEADER = {
  flex: '0 0 auto',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 8px',
  borderBottom: '1px solid ' + BORDER,
  background: SURFACE,
}

const TITLE = { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

const CRUMBS = {
  flex: '0 0 auto',
  display: 'flex',
  gap: 2,
  flexWrap: 'wrap',
  alignItems: 'center',
  padding: '4px 8px',
  borderBottom: '1px solid ' + BORDER,
  color: LABEL_DIM,
}

const CRUMB = {
  padding: '1px 5px',
  borderRadius: 4,
  border: 'none',
  background: 'transparent',
  color: LABEL_DIM,
  font: 'inherit',
  fontSize: 11,
  cursor: 'pointer',
}

const TOOLBAR = {
  flex: '0 0 auto',
  display: 'flex',
  gap: 6,
  alignItems: 'center',
  padding: '6px 8px',
  borderBottom: '1px solid ' + BORDER,
}

const FILTER = {
  flex: '1 1 auto',
  minWidth: 0,
  padding: '4px 8px',
  borderRadius: 6,
  border: '1px solid ' + BORDER,
  background: BASE,
  color: LABEL,
  font: 'inherit',
  fontSize: 11,
}

const LIST = { flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: '4px 6px' }

/**
 * One row: the name line (what it is, its version, its actions) and a metadata
 * line (where it lives, its size and time). One line cannot hold all of that in
 * a sidebar-width column without truncating the name to four characters.
 */
const ROW = {
  display: 'flex',
  flexDirection: 'column',
  gap: 1,
  minHeight: 24,
  padding: '3px 4px',
  borderRadius: 5,
}

const ROW_LINE = { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }

const ROW_DETAIL = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
  paddingLeft: 2,
  color: LABEL_DIM,
  fontSize: 10,
}

const ROW_MAIN = {
  flex: '1 1 auto',
  minWidth: 0,
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: 0,
  border: 'none',
  background: 'transparent',
  color: LABEL,
  font: 'inherit',
  textAlign: 'left',
  cursor: 'pointer',
}

const BADGE = {
  flex: '0 0 auto',
  minWidth: 26,
  padding: '0 3px',
  borderRadius: 3,
  fontSize: 9,
  lineHeight: '14px',
  textAlign: 'center',
  color: LABEL_DIM,
  background: WASH,
}

const NAME = { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

const META = { flex: '0 0 auto', color: LABEL_DIM, fontSize: 10, whiteSpace: 'nowrap' }

const ACTIONS = { flex: '0 0 auto', display: 'flex', gap: 3 }

const PATHHINT = {
  flex: '1 1 auto',
  minWidth: 0,
  color: LABEL_DIM,
  fontSize: 10,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const FOOT = {
  flex: '0 0 auto',
  padding: '3px 8px',
  borderTop: '1px solid ' + BORDER,
  color: LABEL_DIM,
  fontSize: 10,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
}

/** One connected library: a status dot, the bucket, where it lives, and its actions. */
const CONNECTION = {
  flex: '0 0 auto',
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '5px 8px',
  borderBottom: '1px solid ' + BORDER,
  background: SURFACE,
  minWidth: 0,
}

const CONNECTION_DOT = {
  flex: '0 0 auto',
  width: 6,
  height: 6,
  borderRadius: 3,
  background: SUCCESS,
}

const CONNECTION_NAME = {
  flex: '0 0 auto',
  maxWidth: '52%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontFamily: MONO,
  fontSize: 11,
}

const CONNECTION_META = {
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  color: LABEL_DIM,
  fontSize: 10,
}

/** The connect panel: labelled fields, one primary action, one way out. */
const CONNECT = {
  flex: '0 0 auto',
  padding: '8px 8px 10px',
  borderBottom: '1px solid ' + BORDER,
  background: SURFACE,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
}

const CONNECT_TITLE = { flex: '1 1 auto', color: LABEL, fontSize: 11, fontWeight: 600 }

const CONNECT_HEAD = { display: 'flex', alignItems: 'center', gap: 6 }

const FIELD = { display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 0', minWidth: 0 }

const FIELD_LABEL = { color: LABEL_DIM, fontSize: 9 }

const FIELD_ROW = { display: 'flex', gap: 6, alignItems: 'flex-end' }

const CONNECT_INPUT = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '4px 7px',
  borderRadius: 6,
  border: '1px solid ' + BORDER,
  background: BASE,
  color: LABEL,
  font: 'inherit',
  fontSize: 11,
}

const CONNECT_ACTIONS = { display: 'flex', gap: 6, alignItems: 'center' }

const CONNECT_NOTE = { color: LABEL_DIM, fontSize: 10, lineHeight: 1.4 }

const CONNECT_ERROR = { color: ERROR, fontSize: 10, lineHeight: 1.4 }

/** A revision marker next to a short path: the version the row actually reads. */
const REVISION = {
  flex: '0 0 auto',
  padding: '0 4px',
  borderRadius: 3,
  background: WASH,
  color: LABEL_DIM,
  fontFamily: MONO,
  fontSize: 9,
  lineHeight: '14px',
}

function smallButton(primary) {
  const filled = primary === true
  return {
    padding: '1px 6px',
    borderRadius: 4,
    border: '1px solid ' + (filled ? PRIMARY_FILL : BORDER),
    background: filled ? PRIMARY_FILL : SURFACE,
    color: filled ? PRIMARY_INK : LABEL,
    font: 'inherit',
    fontSize: 10,
    cursor: 'pointer',
  }
}

function badgeFor(entry) {
  if (entry.type === 'folder') return 'DIR'
  const name = String(entry.name || '')
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toUpperCase().slice(0, 4) : 'FILE'
}

/**
 * What the page remembers between mounts, in this page only.
 *
 * Switching sidebar tabs unmounts this body and the next mount starts from
 * nothing, which turns a deep asset tree into "back to the root" on every visit.
 * The remembered state is deliberately module-scoped (a tab switch is a remount,
 * not a reload) and deliberately small: where the user was, and how they prefer
 * to see paths and files. Nothing about it is a credential.
 */
const BROWSE = {
  prefix: '',
  usdOnly: true,
  shortPaths: true,
}

/** The payload a page shows before any listing answered. */
const EMPTY_PAYLOAD = {
  entries: [], allowedPrefixes: [], truncated: false, bucket: 'asset', rootPrefix: '', continuationToken: null,
}

/**
 * The form fields of one saved connection; the secret is never prefilled.
 * @param config - the stored connection's non-secret half.
 * @returns the six fields the panel edits.
 */
function formOf(config) {
  return {
    endpoint: typeof config.endpoint === 'string' ? config.endpoint : '',
    bucket: typeof config.bucket === 'string' ? config.bucket : '',
    region: typeof config.region === 'string' ? config.region : '',
    rootPrefix: typeof config.rootPrefix === 'string' ? config.rootPrefix : '',
    accessKey: typeof config.accessKey === 'string' ? config.accessKey : '',
    secretKey: '',
  }
}

/**
 * The label of one row: the short path in short mode, the entry's own name
 * otherwise. A version folder keeps its name, because it is what the versions
 * are listed under.
 * @param entry - one listing entry.
 * @param shortPaths - whether revision segments are hidden.
 * @returns the row label.
 */
function rowName(entry, shortPaths) {
  if (shortPaths !== true || isRevisionsFolder(entry)) return entry.name
  const trimmed = shortKeyOf(entry.key).replace(/\/+$/, '')
  const name = trimmed.slice(trimmed.lastIndexOf('/') + 1)
  return name === '' ? entry.name : name
}

/**
 * The path hint under a search result: the folder the object lives in, shown
 * without its revision segment in short mode.
 * @param entry - one search match.
 * @param shortPaths - whether revision segments are hidden.
 * @returns the directory of the displayed key.
 */
function rowPath(entry, shortPaths) {
  return dirOf(shortPaths === true ? shortKeyOf(entry.key) : entry.key)
}

/**
 * Translate a failed connection save into the panel's message key.
 * @param error - the Error the host route produced.
 * @returns the message key the panel renders.
 */
function connectErrorText(error) {
  const message = error instanceof Error ? error.message : String(error)
  const reason = error?.reason
  if (message === 'objstore-config-invalid') {
    if (reason === 'invalid-endpoint') return 'objstoreDirectBadEndpoint'
    if (reason === 'invalid-bucket') return 'objstoreDirectBadBucket'
    if (reason === 'missing-keys') return 'objstoreDirectMissingKeys'
    return 'objstoreDirectFailed'
  }
  if (message === 'objstore-config-environment') return 'objstoreEnvironmentLocked'
  if (message === 'objstore-config-unverified') {
    // A refused listing is a credential or policy answer; everything else is a
    // transport answer, and the user fixes them differently.
    if (reason === 'denied' || reason === 'missing-bucket') return 'objstoreVerifyDenied'
    return 'objstoreVerifyUnreachable'
  }
  return 'objstoreDirectFailed'
}

/**
 * The object-storage page body.
 * @param props - tab-body props: copy lookup t and the USD handoff.
 * @param props.t - locale lookup.
 * @param props.openDroppedStage - hands a pending drop to the USD preview tab.
 */
export function UsdObjectStoreBody(props) {
  const t = props.t
  const openDroppedStage = props.openDroppedStage
  // A tab switch is a remount, so the location starts from what the page
  // remembers rather than from the root (see BROWSE).
  const [prefix, setPrefix] = useState(() => BROWSE.prefix)
  const [payload, setPayload] = useState(EMPTY_PAYLOAD)
  /** The host's reported library (endpoint/bucket/rootPrefix), or undefined. */
  const [library, setLibrary] = useState(undefined)
  /** The connection the host has stored (non-secret half), or undefined. */
  const [stored, setStored] = useState(undefined)
  /** Which backend the host signs with: 'environment', 'config-file' or null. */
  const [configSource, setConfigSource] = useState(null)
  /** Whether this composition has the host's connection route at all. */
  const [configSupported, setConfigSupported] = useState(false)
  /** Browser-direct connection (non-secret half), or undefined. */
  const [direct, setDirect] = useState(() => directConfig())
  const [showConnect, setShowConnect] = useState(false)
  const [form, setForm] = useState(() => ({
    endpoint: 'https://s3.twinasset.art',
    bucket: 'asset',
    region: 'us-east-1',
    rootPrefix: 'L0/',
    accessKey: '',
    secretKey: '',
  }))
  const [connectBusy, setConnectBusy] = useState(false)
  const [connectError, setConnectError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('')
  const [busyKey, setBusyKey] = useState(null)
  const [copied, setCopied] = useState(null)
  const [usdOnly, setUsdOnly] = useState(() => BROWSE.usdOnly)
  const [shortPaths, setShortPaths] = useState(() => BROWSE.shortPaths)
  const [searchBusy, setSearchBusy] = useState(false)
  const [searchError, setSearchError] = useState(null)
  const [searchPayload, setSearchPayload] = useState({ entries: [], scanned: 0, truncated: false })
  const controllerRef = useRef(null)
  const searchRef = useRef(null)

  const label = useCallback((key, fallback) => {
    if (typeof t !== 'function') return fallback
    try {
      const value = t(key)
      return value === undefined || value === null || value === key ? fallback : value
    } catch {
      return fallback
    }
  }, [t])

  const setField = useCallback((name, value) => {
    setForm(current => ({ ...current, [name]: value }))
  }, [])

  const load = useCallback(async (nextPrefix, options = {}) => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    // "Load more" appends the next page; a navigation replaces the list.
    const append = options.append === true
    setLoading(true)
    setError(null)
    try {
      const data = await listPrefix(nextPrefix, controller.signal, options.token)
      if (controller.signal.aborted) return
      const entries = Array.isArray(data.entries) ? data.entries : []
      const nextToken = typeof data.continuationToken === 'string' ? data.continuationToken : null
      setPayload(current => ({
        entries: append ? [...current.entries, ...entries] : entries,
        allowedPrefixes: Array.isArray(data.allowedPrefixes) ? data.allowedPrefixes : [],
        truncated: data.truncated === true,
        bucket: typeof data.bucket === 'string' ? data.bucket : 'asset',
        rootPrefix: typeof data.rootPrefix === 'string' ? data.rootPrefix : '',
        continuationToken: nextToken,
      }))
      const shown = typeof data.prefix === 'string' ? data.prefix : nextPrefix
      setPrefix(shown)
      BROWSE.prefix = shown
    } catch (err) {
      if (controller.signal.aborted) return
      const message = err instanceof Error ? err.message : String(err)
      // A remembered directory can belong to a connection that has changed since
      // it was remembered; opening the root is more useful than a permission
      // error on a page the user did not navigate.
      if (options.restored === true && nextPrefix !== '' && message === 'objstore-forbidden') {
        void load('')
        return
      }
      setError(message)
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [])

  /**
   * Apply what the host half reports as the effective connection.
   * @param saved - the connection route's answer, or undefined when absent.
   * @param health - the library the health route reported, or undefined.
   */
  const adoptConnection = useCallback((saved, health) => {
    setConfigSupported(saved !== undefined)
    setStored(saved?.config ?? undefined)
    setConfigSource(saved?.source ?? null)
    setLibrary(health)
    if (saved?.config !== undefined && saved?.config !== null) {
      setForm(current => ({ ...current, ...formOf(saved.config) }))
    }
    setShowConnect(health === undefined && !hasDirect())
  }, [])

  /**
   * Probe the host half for the effective connection and its saved half, in one
   * pass: two independent routes, one page state.
   * @returns `{ saved, health }`.
   */
  const probeConnection = useCallback(async () => {
    const [health, saved] = await Promise.all([
      hostLibrary().catch(() => undefined),
      loadObjectStoreConfig().catch(() => undefined),
    ])
    return { health, saved }
  }, [])

  // Defined after `load` on purpose: `connect` calls it, and a useCallback's
  // dependency array is evaluated during render, so referencing `load` before its
  // declaration is a temporal-dead-zone ReferenceError, not a stale closure.
  const connect = useCallback(async () => {
    if (connectBusy) return
    setConnectBusy(true)
    setConnectError(null)
    try {
      // The stored connection is the product path: the host verifies it with a
      // real listing, writes it to disk and signs every later read, so nothing
      // but this one request ever carries the key pair.
      if (configSupported) {
        try {
          const saved = await saveObjectStoreConfig(form)
          clearDirect()
          resetObjectStoreCaches()
          setDirect(undefined)
          setStored(saved.config ?? undefined)
          setConfigSource(saved.source)
          setForm(current => ({ ...current, ...formOf(saved.config ?? {}) }))
          setLibrary(await hostLibrary().catch(() => undefined))
          setShowConnect(false)
          setFilter('')
          BROWSE.prefix = ''
          setPrefix('')
          void load('')
          return
        } catch (error) {
          if (error?.message !== 'objstore-config-unsupported') {
            setConnectError(connectErrorText(error))
            return
          }
          // The route went away (a composition without the host half): connect
          // straight from the page rather than claiming it cannot work.
        }
      }
      const result = configureDirect(form)
      if (typeof result === 'string') {
        setConnectError(result)
        return
      }
      await testDirect(undefined)
      setDirect(result)
      setShowConnect(false)
      setForm(current => ({ ...current, accessKey: '', secretKey: '' }))
      // Reload from the root of the newly configured connection.
      controllerRef.current?.abort()
      setFilter('')
      BROWSE.prefix = ''
      setPrefix('')
      void load('')
    } catch {
      clearDirect()
      setConnectError('objstoreDirectFailed')
    } finally {
      setConnectBusy(false)
    }
  }, [configSupported, connectBusy, form, load])

  const disconnect = useCallback(async () => {
    clearDirect()
    setDirect(undefined)
    setForm(current => ({ ...current, accessKey: '', secretKey: '' }))
    // Whether a library remains once what this page held is forgotten. The
    // fresh probe is the answer, not the state captured by this render: the
    // host may still hold an environment library the file only shadowed.
    let remaining = library
    if (configSupported && stored !== undefined) {
      await clearObjectStoreConfig().catch(() => undefined)
      resetObjectStoreCaches()
      const { health, saved } = await probeConnection()
      adoptConnection(saved, health)
      remaining = health
    }
    if (remaining !== undefined) {
      setShowConnect(false)
      void load(prefix)
      return
    }
    setStored(undefined)
    setConfigSource(null)
    setLibrary(undefined)
    setPayload(EMPTY_PAYLOAD)
    setPrefix('')
    BROWSE.prefix = ''
    setShowConnect(true)
  }, [adoptConnection, configSupported, library, load, prefix, probeConnection, stored])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { health, saved } = await probeConnection()
      if (cancelled) return
      adoptConnection(saved, health)
      // Open where the page was last time; a directory that a changed connection
      // no longer permits falls back to the root inside `load`.
      void load(BROWSE.prefix, { restored: true })
    })()
    return () => {
      cancelled = true
      controllerRef.current?.abort()
    }
  }, [adoptConnection, load, probeConnection])

  // Both display choices outlive a tab switch with the location they belong to.
  useEffect(() => {
    BROWSE.usdOnly = usdOnly
  }, [usdOnly])
  useEffect(() => {
    BROWSE.shortPaths = shortPaths
  }, [shortPaths])

  // Debounced recursive search: typing searches the whole current prefix, so a
  // stage can be found without knowing which sample directory holds it.
  useEffect(() => {
    const text = filter.trim()
    if (text === '') {
      searchRef.current?.abort()
      setSearchPayload({ entries: [], scanned: 0, truncated: false })
      setSearchError(null)
      setSearchBusy(false)
      return undefined
    }
    searchRef.current?.abort()
    const controller = new AbortController()
    searchRef.current = controller
    setSearchBusy(true)
    setSearchError(null)
    const timer = window.setTimeout(async () => {
      try {
        const data = await searchFiles(prefix, text, usdOnly, controller.signal)
        if (controller.signal.aborted) return
        setSearchPayload({
          entries: Array.isArray(data.entries) ? data.entries : [],
          scanned: Number.isFinite(data.scanned) ? data.scanned : 0,
          truncated: data.truncated === true,
        })
      } catch (err) {
        if (!controller.signal.aborted) setSearchError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!controller.signal.aborted) setSearchBusy(false)
      }
    }, 300)
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [filter, prefix, usdOnly])

  /** The path the page shows and navigates by: short unless versions are shown. */
  const shownPrefix = useMemo(
    () => (shortPaths ? shortKeyOf(prefix) : prefix),
    [prefix, shortPaths],
  )

  /** The revision the current directory sits in, when it sits in one. */
  const activeRevision = useMemo(() => revisionIdOf(prefix), [prefix])

  const breadcrumbs = useMemo(() => {
    const root = payload.rootPrefix
    // The listing never climbs above the configured root, so the first crumb is
    // the root directory itself, not the bucket: a deep root would otherwise be
    // unreachable from the page.
    const relative = root !== '' && shownPrefix.startsWith(root) ? shownPrefix.slice(root.length) : shownPrefix
    const parts = relative.split('/').filter(Boolean)
    const crumbs = [{ name: payload.bucket, prefix: root }]
    let acc = root
    for (const part of parts) {
      acc += part + '/'
      crumbs.push({ name: part, prefix: acc })
    }
    return crumbs
  }, [payload.bucket, payload.rootPrefix, shownPrefix])

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    if (needle === '') return payload.entries
    return payload.entries.filter(entry => entry.name.toLowerCase().includes(needle))
  }, [filter, payload.entries])

  const navigate = useCallback((nextPrefix) => {
    setFilter('')
    void load(nextPrefix)
  }, [load])

  /**
   * Layer reader for one previewed object: the engine reports a reference
   * relative to the naming layer, so try it under the object's own directory
   * first and fall back to the package spelling.
   * @param rootKey - the root object's key.
   * @returns a reader answering gateway bytes, or undefined for a missing layer.
   */
  const objectReader = useCallback((rootKey) => {
    const rootDir = dirOf(normalizePath(rootKey))
    return async (path, signal) => {
      const normalized = normalizePath(path)
      const candidates = [resolvePath(rootDir, normalized), normalized]
      if (rootDir !== '' && normalized.startsWith(rootDir + '/')) {
        candidates.push(normalized.slice(rootDir.length + 1))
      }
      for (const candidate of new Set(candidates)) {
        try {
          return await fetchObjectBytes(candidate, signal)
        } catch (error) {
          if (error?.name === 'AbortError' || signal?.aborted === true) throw error
        }
      }
      return undefined
    }
  }, [])

  /**
   * Absolute s3:// reader for a previewed object: the host signing route first,
   * then the gateway's public byte route, because the browser's bucket may not
   * be the host's configured one.
   * @param uri - an s3:// reference named by the stage.
   * @param signal - abort signal.
   * @returns bytes, or undefined for a missing layer.
   */
  const objectAssetReader = useCallback(async (uri, signal) => {
    const bytes = await readS3Asset(uri, signal)
    if (bytes !== undefined) return bytes
    const key = s3KeyOf(uri)
    if (key === undefined) return undefined
    try {
      return await fetchObjectBytes(key, signal)
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted === true) throw error
      return undefined
    }
  }, [])

  const openUsd = useCallback(async (entry) => {
    if (typeof openDroppedStage !== 'function') {
      // The USD preview tab is not mounted in this composition; say so instead of
      // leaving the button looking dead.
      setError('preview-unavailable')
      return
    }
    setBusyKey(entry.key)
    setError(null)
    try {
      const rootKey = normalizePath(entry.key)
      const rootBytes = await fetchObjectBytes(rootKey)
      openDroppedStage({
        remoteStage: {
          uri: (hasDirect() ? directS3Uri(rootKey) : undefined)
            ?? s3Uri(library?.bucket ?? payload.bucket, rootKey),
          kind: 's3',
          label: entry.name || rootKey,
          rootKey,
          rootBytes,
          read: objectReader(rootKey),
          readAsset: objectAssetReader,
        },
        models: [{ key: entry.name || rootKey, kind: 'usd' }],
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyKey(null)
    }
  }, [library?.bucket, openDroppedStage, objectAssetReader, objectReader, payload.bucket])

  const copy = useCallback(async (text, mark) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(mark)
      window.setTimeout(() => setCopied(current => (current === mark ? null : current)), 1500)
    } catch {
      setError('clipboard-unavailable')
    }
  }, [])

  const searchErrorText = searchError === null
    ? null
    : (searchError === 'objstore-unreachable'
      ? label('objstoreUnreachable', 'Object-storage API is not reachable')
      : label('objstoreError', 'Search failed') + ': ' + searchError)

  const searching = filter.trim() !== ''

  /**
   * The rows to render.
   *
   * In short mode a versioned asset is represented by its newest revision, and
   * the raw version tree is what that replaces: its folder is hidden -- unless
   * it is the only thing in the directory, where hiding it would hide the asset
   * itself.
   */
  const rows = useMemo(() => {
    const listed = searching ? searchPayload.entries : visible
    if (!shortPaths) return listed
    // Folders are navigation, not objects: two revisions of one asset are two
    // folders to walk into, so only files are collapsed onto their object.
    const folders = listed.filter(entry => entry.type === 'folder')
    const collapsed = [...folders, ...collapseRevisions(listed.filter(entry => entry.type !== 'folder'))]
    const withoutVersions = collapsed.filter(entry => !isRevisionsFolder(entry))
    return withoutVersions.length === 0 ? collapsed : withoutVersions
  }, [searching, searchPayload.entries, shortPaths, visible])

  const connection = direct ?? library
  const connected = connection !== undefined
  const endpointUrl = typeof connection?.endpoint === 'string' ? connection.endpoint : ''
  const connectionBucket = connection?.bucket ?? payload.bucket
  const connectionRoot = connection?.rootPrefix ?? payload.rootPrefix
  const connectionHost = useMemo(() => {
    if (endpointUrl === '') return ''
    try {
      return new URL(endpointUrl).host
    } catch {
      return endpointUrl
    }
  }, [endpointUrl])
  /** An environment library is the deployment's decision; the page cannot edit it. */
  const environmentLocked = direct === undefined && configSource === 'environment'
  const canEdit = !environmentLocked && (configSupported || direct !== undefined)

  const sourceLabel = library === undefined
    ? label('objstoreSourceGateway', 'deployment gateway')
    : configSource === 'environment'
      ? label('objstoreSourceEnvironment', 'deployment environment')
      : configSource === 'config-file'
        ? label('objstoreSourceFile', 'saved connection')
        : label('objstoreSourceHost', 'host signed route')

  const connectErrorLabel = connectError === null
    ? null
    : connectError === 'direct-bad-endpoint'
      ? label('objstoreDirectBadEndpoint', 'Endpoint must start with http(s)://')
      : connectError === 'direct-bad-bucket'
        ? label('objstoreDirectBadBucket', 'Bucket name contains invalid characters')
        : connectError === 'direct-missing-keys'
          ? label('objstoreDirectMissingKeys', 'Enter both the Access Key and Secret Key')
          : connectError === 'objstoreVerifyDenied'
            ? label('objstoreVerifyDenied', 'Connection refused: check the key pair and its read permission')
            : connectError === 'objstoreVerifyUnreachable'
              ? label('objstoreVerifyUnreachable', 'Cannot reach the service: check the endpoint and the network')
              : connectError === 'objstoreEnvironmentLocked'
                ? label('objstoreEnvironmentLocked', 'Configured by the deployment environment; the page cannot change it')
                : label('objstoreDirectFailed', 'Connection failed: check the endpoint and credentials')

  const errorText = error === null
    ? null
    : (error === 'objstore-unreachable'
      ? label('objstoreUnreachable', 'Object-storage API is not reachable')
      : error === 'objstore-forbidden'
        ? label('objstoreForbidden', 'This prefix is not exposed by the gateway')
        : error === 'clipboard-unavailable'
          ? label('objstoreClipboard', 'Clipboard is not available in this browser')
          : error === 'preview-unavailable'
            ? label('objstoreNoPreview', 'The USD preview tab is not available in this composition')
            : error === 'objstore-too-large'
              ? label('objstoreTooLarge', 'That object is larger than the preview accepts')
              : label('objstoreError', 'Read failed') + ': ' + error)

  // A search and an action can both have failed; neither may be hidden by the
  // other, so the list shows both lines while a query is active.
  const activeErrorText = searchErrorText === null
    ? errorText
    : (errorText === null ? searchErrorText : searchErrorText + '\n' + errorText)

  return (
    <div style={SHELL} data-usd-objstore>
      <div style={HEADER}>
        <span style={TITLE} title={'s3://' + connectionBucket + '/' + shownPrefix}>
          {label('objstoreTitle', 'Object storage')}
        </span>
        <button type="button" style={smallButton(false)} onClick={() => navigate(prefix)}>
          {label('objstoreRefresh', 'Refresh')}
        </button>
      </div>

      {connected ? (
        <div style={CONNECTION}>
          <span style={CONNECTION_DOT} />
          <span style={CONNECTION_NAME} title={endpointUrl}>{'s3://' + connectionBucket}</span>
          <span
            style={CONNECTION_META}
            title={connectionRoot === '' ? endpointUrl : endpointUrl + '/' + connectionRoot}
          >
            {connectionHost}
            {connectionRoot === '' ? '' : ' · ' + connectionRoot.replace(/\/$/, '')}
          </span>
          {canEdit ? (
            <button
              type="button"
              style={smallButton(false)}
              onClick={() => {
                setConnectError(null)
                setShowConnect(value => !value)
                const source = stored ?? direct
                if (source !== undefined) setForm(current => ({ ...current, ...formOf(source) }))
              }}
            >
              {label('objstoreEdit', 'Edit')}
            </button>
          ) : null}
          {canEdit ? (
            <button type="button" style={smallButton(false)} onClick={() => void disconnect()}>
              {label('objstoreDisconnect', 'Disconnect')}
            </button>
          ) : null}
        </div>
      ) : null}
      {showConnect ? (
        <div style={CONNECT}>
          <div style={CONNECT_HEAD}>
            <span style={CONNECT_TITLE}>{label('objstoreConnect', 'Connect to object storage')}</span>
            {connected ? (
              <button
                type="button"
                style={smallButton(false)}
                onClick={() => {
                  setShowConnect(false)
                  setConnectError(null)
                }}
              >
                {label('objstoreCancel', 'Cancel')}
              </button>
            ) : null}
          </div>
          <label style={FIELD}>
            <span style={FIELD_LABEL}>{label('objstoreEndpoint', 'Endpoint')}</span>
            <input
              style={CONNECT_INPUT}
              type="text"
              spellCheck={false}
              value={form.endpoint}
              placeholder="https://s3.example.com"
              onChange={event => setField('endpoint', event.target.value)}
            />
          </label>
          <div style={FIELD_ROW}>
            <label style={FIELD}>
              <span style={FIELD_LABEL}>{label('objstoreBucket', 'Bucket')}</span>
              <input
                style={CONNECT_INPUT}
                type="text"
                spellCheck={false}
                value={form.bucket}
                placeholder="asset"
                onChange={event => setField('bucket', event.target.value)}
              />
            </label>
            <label style={FIELD}>
              <span style={FIELD_LABEL}>{label('objstoreRegion', 'Region')}</span>
              <input
                style={CONNECT_INPUT}
                type="text"
                spellCheck={false}
                value={form.region}
                placeholder="us-east-1"
                onChange={event => setField('region', event.target.value)}
              />
            </label>
          </div>
          <label style={FIELD}>
            <span style={FIELD_LABEL}>{label('objstoreRoot', 'Root prefix')}</span>
            <input
              style={CONNECT_INPUT}
              type="text"
              spellCheck={false}
              value={form.rootPrefix}
              placeholder="L0/"
              onChange={event => setField('rootPrefix', event.target.value)}
            />
          </label>
          <div style={FIELD_ROW}>
            <label style={FIELD}>
              <span style={FIELD_LABEL}>{label('objstoreAccessKey', 'Access Key')}</span>
              <input
                style={CONNECT_INPUT}
                type="text"
                spellCheck={false}
                autoComplete="off"
                value={form.accessKey}
                onChange={event => setField('accessKey', event.target.value)}
              />
            </label>
            <label style={FIELD}>
              <span style={FIELD_LABEL}>{label('objstoreSecretKey', 'Secret Key')}</span>
              <input
                style={CONNECT_INPUT}
                type="password"
                spellCheck={false}
                autoComplete="off"
                value={form.secretKey}
                placeholder={stored?.hasSecret === true ? label('objstoreSecretSaved', 'saved') : ''}
                onKeyDown={event => { if (event.key === 'Enter') void connect() }}
                onChange={event => setField('secretKey', event.target.value)}
              />
            </label>
          </div>
          <div style={CONNECT_ACTIONS}>
            <button
              type="button"
              style={{ ...smallButton(true), flex: '1 1 auto', padding: '5px 8px', fontSize: 11 }}
              disabled={connectBusy}
              onClick={() => void connect()}
            >
              {connectBusy ? label('objstoreTesting', 'Verifying…') : label('objstoreConnectOk', 'Connect')}
            </button>
          </div>
          {connectErrorLabel === null ? null : <span style={CONNECT_ERROR}>{connectErrorLabel}</span>}
          <span style={CONNECT_NOTE}>
            {configSupported
              ? label('objstoreConnectSaved', 'Saved on this machine and used by the host to sign reads.')
              : label('objstoreConnectSession', 'Used for this page only.')}
          </span>
        </div>
      ) : null}

      <div style={CRUMBS}>
        {breadcrumbs.map((crumb, index) => (
          <span key={crumb.prefix} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            {index > 0 ? <span>/</span> : null}
            <button
              type="button"
              style={{ ...CRUMB, color: index === breadcrumbs.length - 1 ? LABEL : LABEL_DIM }}
              onClick={() => navigate(crumb.prefix)}
            >
              {crumb.name}
            </button>
          </span>
        ))}
        {shortPaths && activeRevision !== undefined ? (
          <span style={REVISION} title={activeRevision}>{'#' + activeRevision.slice(0, 7)}</span>
        ) : null}
      </div>

      <div style={TOOLBAR}>
        <input
          type="text"
          value={filter}
          spellCheck={false}
          onChange={event => setFilter(event.target.value)}
          placeholder={usdOnly
            ? label('objstoreSearchUsd', 'Search USD files (recursive)…')
            : label('objstoreSearchAll', 'Search files (recursive)…')}
          style={FILTER}
          aria-label={label('objstoreSearch', 'Search files')}
        />
        <button
          type="button"
          style={smallButton(usdOnly)}
          title={label('objstoreUsdOnly', 'Only USD files')}
          onClick={() => setUsdOnly(value => !value)}
        >
          {usdOnly ? 'USD' : label('objstoreAllFiles', 'All')}
        </button>
        <button
          type="button"
          style={smallButton(shortPaths)}
          title={shortPaths
            ? label('objstoreVersionPath', 'Show version paths')
            : label('objstoreShortPath', 'Show short paths')}
          onClick={() => setShortPaths(value => !value)}
        >
          {shortPaths ? label('objstoreShortPath', 'Short path') : label('objstoreVersionPath', 'Version path')}
        </button>
        {filter === '' ? null : (
          <button
            type="button"
            style={smallButton(false)}
            title={label('objstoreClear', 'Clear search')}
            onClick={() => setFilter('')}
          >
            ×
          </button>
        )}
      </div>

      <div style={LIST}>
        {(searching ? searchBusy : loading)
          ? <div style={{ padding: 8, color: LABEL_DIM }}>{searching ? label('objstoreSearching', 'Searching…') : label('objstoreLoading', 'Reading folder…')}</div>
          : null}
        {activeErrorText === null
          ? null
          : <div style={{ padding: 8, color: ERROR, whiteSpace: 'pre-wrap' }}>{activeErrorText}</div>}
        {!(searching ? searchBusy : loading) && activeErrorText === null && rows.length === 0
          ? <div style={{ padding: 8, color: LABEL_DIM }}>{searching ? label('objstoreNoMatch', 'No matching files') : label('objstoreEmpty', 'This folder has no visible objects')}</div>
          : null}

        {rows.map(entry => {
          const revision = shortPaths ? revisionIdOf(entry.key) : undefined
          return (
          <div key={entry.key} style={ROW} data-usd-objstore-entry={entry.key}>
            <div style={ROW_LINE}>
              <button
                type="button"
                style={ROW_MAIN}
                title={entry.key}
                onClick={() => {
                  if (entry.type === 'folder') navigate(entry.key + '/')
                  else if (isUsdKey(entry.key)) void openUsd(entry)
                  else window.open(publicAssetUrl(entry.key, library), '_blank', 'noopener')
                }}
              >
                <span style={BADGE}>{badgeFor(entry)}</span>
                <span style={NAME}>{rowName(entry, shortPaths)}</span>
                {revision === undefined
                  ? null
                  : <span style={REVISION} title={revision}>{'#' + revision.slice(0, 7)}</span>}
              </button>
            {entry.type === 'folder' ? null : (
              <span style={ACTIONS}>
                {isUsdKey(entry.key) ? (
                  <button
                    type="button"
                    style={smallButton(true)}
                    disabled={busyKey === entry.key}
                    title={label('objstorePreview', 'Open in USD preview')}
                    onClick={() => void openUsd(entry)}
                  >
                    {busyKey === entry.key ? '…' : label('objstorePreview', 'Preview')}
                  </button>
                ) : null}
                <button
                  type="button"
                  style={smallButton(false)}
                  title={s3Uri(library?.bucket ?? payload.bucket, entry.key)}
                  onClick={() => void copy(s3Uri(library?.bucket ?? payload.bucket, entry.key), 's3:' + entry.key)}
                >
                  {copied === 's3:' + entry.key ? '✓' : 's3'}
                </button>
                <button
                  type="button"
                  style={smallButton(false)}
                  title={publicAssetUrl(entry.key, library)}
                  onClick={() => void copy(publicAssetUrl(entry.key, library), 'http:' + entry.key)}
                >
                  {copied === 'http:' + entry.key ? '✓' : 'http'}
                </button>
                <button
                  type="button"
                  style={smallButton(false)}
                  title={label('objstoreOpen', 'Open in browser')}
                  onClick={() => window.open(publicAssetUrl(entry.key, library), '_blank', 'noopener')}
                >
                  ↗
                </button>
              </span>
            )}
            </div>
            {entry.type === 'folder' ? null : (
              <div style={ROW_DETAIL}>
                {searching ? <span style={PATHHINT}>{rowPath(entry, shortPaths)}</span> : null}
                <span style={META}>{formatBytes(entry.size)} · {formatDate(entry.lastModified)}</span>
              </div>
            )}
          </div>
          )
        })}
      </div>

      <div style={FOOT}>
        {searching
          ? label('objstoreResults', 'Matches') + ': ' + rows.length
            + ' · ' + label('objstoreScanned', 'scanned') + ' ' + searchPayload.scanned
            + ' · ' + (usdOnly ? label('objstoreUsdOnly', 'Only USD files') : label('objstoreAllFiles', 'all files'))
            + (searchPayload.truncated ? ' · ' + label('objstoreTruncated', 'listing truncated; refine the query') : '')
          : label('objstoreSource', 'Source') + ': ' + sourceLabel
            + ' · ' + rows.length + ' / ' + payload.entries.length + ' ' + label('objstoreItems', 'items')
            + (payload.truncated && payload.continuationToken !== null
              ? ' · ' + label('objstoreTruncated', 'listing truncated')
              : '')}
        {!searching && payload.truncated && payload.continuationToken !== null ? (
          <button
            type="button"
            style={{ ...smallButton(false), marginLeft: 6 }}
            disabled={loading}
            onClick={() => void load(prefix, { append: true, token: payload.continuationToken })}
          >
            {label('objstoreMore', 'Load more')}
          </button>
        ) : null}
      </div>
    </div>
  )
}



