/**
 * Right-sidebar page body: browse the read-only object storage (asset bucket).
 *
 * The tab lists the gateway's exposed prefixes lazily, shows one directory at a
 * time with size/time, and can hand a USD stage straight to the existing USD
 * preview tab (same plugin, pending-drop handoff). Links and bytes go through
 * the same-origin / gateway routes, so no S3 credential reaches the page.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchObjectBytes,
  formatBytes,
  formatDate,
  isUsdKey,
  listPrefix,
  publicAssetUrl,
  s3Uri,
  searchFiles,
} from './objstore.js'
import { dirOf, normalizePath, resolvePath, s3KeyOf } from './remote.js'
import { readS3Asset } from './s3open.js'

const LABEL = 'var(--dsw-alias-label-primary, #e6e8ec)'
const LABEL_DIM = 'var(--dsw-alias-label-secondary, #a9b0bd)'
const ACCENT = 'var(--dsw-alias-brand-primary, #4d8dff)'
const BORDER = 'var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.14))'
const SURFACE = 'var(--dsw-alias-bg-overlay, rgba(24, 26, 32, 0.86))'
const BASE = 'var(--dsw-alias-bg-base, #14161a)'
const ERROR = 'var(--dsw-alias-state-error-primary, #ff6b6b)'
const FONT = 'var(--dsw-font-ui, system-ui, sans-serif)'

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

const ROW = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minHeight: 24,
  padding: '2px 4px',
  borderRadius: 5,
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
  background: 'rgba(255,255,255,0.06)',
}

const NAME = { flex: '0 0 auto', maxWidth: '52%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

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

function smallButton(primary) {
  return {
    padding: '1px 6px',
    borderRadius: 4,
    border: '1px solid ' + (primary ? ACCENT : BORDER),
    background: primary ? ACCENT : SURFACE,
    color: primary ? '#fff' : LABEL,
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
 * The object-storage page body.
 * @param props - tab-body props: copy lookup t and the USD handoff.
 * @param props.t - locale lookup.
 * @param props.openDroppedStage - hands a pending drop to the USD preview tab.
 */
export function UsdObjectStoreBody(props) {
  const t = props.t
  const openDroppedStage = props.openDroppedStage
  const [prefix, setPrefix] = useState('')
  const [payload, setPayload] = useState({ entries: [], allowedPrefixes: [], truncated: false, bucket: 'asset' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('')
  const [busyKey, setBusyKey] = useState(null)
  const [copied, setCopied] = useState(null)
  const [usdOnly, setUsdOnly] = useState(true)
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

  const load = useCallback(async (nextPrefix) => {
    controllerRef.current?.abort()
    const controller = new AbortController()
    controllerRef.current = controller
    setLoading(true)
    setError(null)
    try {
      const data = await listPrefix(nextPrefix, controller.signal)
      if (controller.signal.aborted) return
      setPayload({
        entries: Array.isArray(data.entries) ? data.entries : [],
        allowedPrefixes: Array.isArray(data.allowedPrefixes) ? data.allowedPrefixes : [],
        truncated: data.truncated === true,
        bucket: typeof data.bucket === 'string' ? data.bucket : 'asset',
      })
      setPrefix(typeof data.prefix === 'string' ? data.prefix : nextPrefix)
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (!controller.signal.aborted) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load('')
    return () => controllerRef.current?.abort()
  }, [load])

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

  const breadcrumbs = useMemo(() => {
    const parts = prefix.split('/').filter(Boolean)
    const crumbs = [{ name: payload.bucket, prefix: '' }]
    let acc = ''
    for (const part of parts) {
      acc += part + '/'
      crumbs.push({ name: part, prefix: acc })
    }
    return crumbs
  }, [payload.bucket, prefix])

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
    if (typeof openDroppedStage !== 'function') return
    setBusyKey(entry.key)
    setError(null)
    try {
      const rootKey = normalizePath(entry.key)
      const rootBytes = await fetchObjectBytes(rootKey)
      openDroppedStage({
        remoteStage: {
          uri: s3Uri(payload.bucket, rootKey),
          kind: 's3',
          label: entry.name || rootKey,
          rootKey,
          rootBytes,
          read: objectReader(rootKey),
          readAsset: objectAssetReader,
        },
        stages: [entry.name || rootKey],
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusyKey(null)
    }
  }, [openDroppedStage, objectAssetReader, objectReader, payload.bucket])

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
  const rows = searching ? searchPayload.entries : visible

  const errorText = error === null
    ? null
    : (error === 'objstore-unreachable'
      ? label('objstoreUnreachable', 'Object-storage API is not reachable')
      : error === 'objstore-forbidden'
        ? label('objstoreForbidden', 'This prefix is not exposed by the gateway')
        : error === 'clipboard-unavailable'
          ? label('objstoreClipboard', 'Clipboard is not available in this browser')
          : label('objstoreError', 'Read failed') + ': ' + error)

  // A search and an action can both have failed; neither may be hidden by the
  // other, so the list shows both lines while a query is active.
  const activeErrorText = searchErrorText === null
    ? errorText
    : (errorText === null ? searchErrorText : searchErrorText + '\n' + errorText)

  return (
    <div style={SHELL} data-usd-objstore>
      <div style={HEADER}>
        <span style={TITLE} title={'s3://' + payload.bucket + '/' + prefix}>
          {label('objstoreTitle', 'Object storage')} · {payload.bucket}
        </span>
        <button type="button" style={smallButton(false)} onClick={() => navigate(prefix)}>
          {label('objstoreRefresh', 'Refresh')}
        </button>
      </div>

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

        {rows.map(entry => (
          <div key={entry.key} style={ROW} data-usd-objstore-entry={entry.key}>
            <button
              type="button"
              style={ROW_MAIN}
              title={entry.key}
              onClick={() => {
                if (entry.type === 'folder') navigate(entry.key + '/')
                else if (isUsdKey(entry.key)) void openUsd(entry)
                else window.open(publicAssetUrl(entry.key), '_blank', 'noopener')
              }}
            >
              <span style={BADGE}>{badgeFor(entry)}</span>
              <span style={NAME}>{entry.name}</span>
              {searching
                ? <span style={PATHHINT}>{entry.key.slice(0, Math.max(0, entry.key.length - entry.name.length - 1))}</span>
                : null}
            </button>
            {entry.type === 'folder'
              ? null
              : <span style={META}>{formatBytes(entry.size)} · {formatDate(entry.lastModified)}</span>}
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
                  title={s3Uri(payload.bucket, entry.key)}
                  onClick={() => void copy(s3Uri(payload.bucket, entry.key), 's3:' + entry.key)}
                >
                  {copied === 's3:' + entry.key ? '✓' : 's3'}
                </button>
                <button
                  type="button"
                  style={smallButton(false)}
                  title={publicAssetUrl(entry.key)}
                  onClick={() => void copy(publicAssetUrl(entry.key), 'http:' + entry.key)}
                >
                  {copied === 'http:' + entry.key ? '✓' : 'http'}
                </button>
                <button
                  type="button"
                  style={smallButton(false)}
                  title={label('objstoreOpen', 'Open in browser')}
                  onClick={() => window.open(publicAssetUrl(entry.key), '_blank', 'noopener')}
                >
                  ↗
                </button>
              </span>
            )}
          </div>
        ))}
      </div>

      <div style={FOOT}>
        {searching
          ? label('objstoreResults', 'Matches') + ': ' + searchPayload.entries.length
            + ' · ' + label('objstoreScanned', 'scanned') + ' ' + searchPayload.scanned
            + ' · ' + (usdOnly ? label('objstoreUsdOnly', 'Only USD files') : label('objstoreAllFiles', 'all files'))
            + (searchPayload.truncated ? ' · ' + label('objstoreTruncated', 'listing truncated; refine the query') : '')
          : label('objstoreAllowed', 'Exposed prefixes') + ': ' + (payload.allowedPrefixes.join(', ') || '—')
            + ' · ' + rows.length + ' / ' + payload.entries.length + ' ' + label('objstoreItems', 'items')
            + (payload.truncated ? ' · ' + label('objstoreTruncated', 'listing truncated; refine the prefix') : '')}
      </div>
    </div>
  )
}



