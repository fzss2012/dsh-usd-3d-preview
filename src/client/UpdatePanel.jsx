/**
 * The local-checkout update panel.
 *
 * It renders in two places: as a tab under Settings -> Plugins, and on this
 * bundle's own detail page in the Plugins panel (a badge when an update is
 * waiting, and the full panel below the page's content). Both read the same host
 * status and post the same explicit actions; no update starts without a click.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  applyUpdate,
  loadUpdateStatus,
  matchesUpdateSubject,
  restartUpdateHost,
  updateAvailable,
  updateState,
} from './update.js'

const LABEL = 'var(--dsw-alias-label-primary, #e6e8ec)'
const LABEL_DIM = 'var(--dsw-alias-label-secondary, #a9b0bd)'
const ACCENT = 'var(--dsw-alias-brand-primary, #4d8dff)'
const BORDER = 'var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.14))'
const SURFACE = 'var(--dsw-alias-bg-overlay, rgba(24, 26, 32, 0.86))'
const BASE = 'var(--dsw-alias-bg-base, #14161a)'
const ERROR = 'var(--dsw-alias-state-error-primary, #ff6b6b)'
const SUCCESS = 'var(--dsw-alias-state-success-primary, #43c780)'
const FONT = 'var(--dsw-font-ui, system-ui, sans-serif)'
const MONO = 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)'

const PANEL = {
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
  padding: 10,
  borderRadius: 8,
  border: '1px solid ' + BORDER,
  background: SURFACE,
  color: LABEL,
  fontFamily: FONT,
  fontSize: 12,
  maxWidth: 760,
}
const HEAD = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
const TITLE = { fontWeight: 600, fontSize: 13 }
const VERSION = { color: LABEL_DIM, fontFamily: MONO, fontSize: 11 }
const TAG = { padding: '0 6px', borderRadius: 4, fontSize: 10, lineHeight: '16px', background: ACCENT, color: '#fff' }
const INTRO = { color: LABEL_DIM, lineHeight: 1.6, fontSize: 11 }
const LINE = { display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 11, color: LABEL_DIM, minWidth: 0 }
const VALUE = { color: LABEL, fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const ROW = { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 2 }
const NOTE = { color: LABEL_DIM, fontSize: 11, lineHeight: 1.6 }
const LOG = {
  margin: 0,
  padding: 8,
  borderRadius: 6,
  border: '1px solid ' + BORDER,
  background: BASE,
  color: LABEL_DIM,
  fontFamily: MONO,
  fontSize: 10,
  lineHeight: 1.5,
  maxHeight: 150,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
}

/** Look one key up, falling back to literal English when t is absent. */
function label(t, key, fallback) {
  if (typeof t !== 'function') return fallback
  try {
    const value = t(key)
    return value === undefined || value === null || value === key ? fallback : value
  } catch {
    return fallback
  }
}

/** One button, styled like the rest of the plugin. */
function buttonStyle(primary) {
  return {
    padding: '2px 10px',
    borderRadius: 5,
    border: '1px solid ' + (primary ? ACCENT : BORDER),
    background: primary ? ACCENT : BASE,
    color: primary ? '#fff' : LABEL,
    font: 'inherit',
    fontSize: 11,
    cursor: 'pointer',
  }
}

/**
 * The shared status/action state. A checked status is deduplicated by
 * loadUpdateStatus, so the badge and the panel share one upstream fetch.
 * @returns state plus the check/update/restart actions.
 */
function useUpdateState() {
  const [status, setStatus] = useState(null)
  const [phase, setPhase] = useState('loading')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)
  const [result, setResult] = useState(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const load = useCallback(async ({ check, force }) => {
    try {
      const next = await loadUpdateStatus({ check, force })
      if (!mounted.current) return
      setStatus(next)
      setPhase('ready')
      if (next.ok === false) setError(next)
    } catch (loadError) {
      if (!mounted.current) return
      setPhase('error')
      setError({ ok: false, error: 'update-unreachable', message: loadError instanceof Error ? loadError.message : String(loadError) })
    }
  }, [])

  useEffect(() => {
    void load({ check: true, force: false })
  }, [load])

  const check = useCallback(async () => {
    if (busy !== null) return
    setBusy('check')
    setError(null)
    try {
      await load({ check: true, force: true })
    } finally {
      if (mounted.current) setBusy(null)
    }
  }, [busy, load])

  const update = useCallback(async () => {
    if (busy !== null) return
    setBusy('update')
    setError(null)
    setResult(null)
    try {
      const outcome = await applyUpdate()
      if (!mounted.current) return
      if (outcome.ok === false) setError(outcome)
      else setResult(outcome)
      await load({ check: false, force: true })
    } catch (updateError) {
      if (mounted.current) setError({ ok: false, error: 'update-unreachable', message: updateError instanceof Error ? updateError.message : String(updateError) })
    } finally {
      if (mounted.current) setBusy(null)
    }
  }, [busy, load])

  const restart = useCallback(async () => {
    if (busy !== null) return
    setBusy('restart')
    setError(null)
    try {
      const outcome = await restartUpdateHost()
      if (!mounted.current) return
      if (outcome.ok === false) setError(outcome)
      else setResult((current) => ({ ...(current ?? {}), restart: outcome }))
    } catch (restartError) {
      if (mounted.current) setError({ ok: false, error: 'update-unreachable', message: restartError instanceof Error ? restartError.message : String(restartError) })
    } finally {
      if (mounted.current) setBusy(null)
    }
  }, [busy])

  return { status, phase, error, busy, result, check, update, restart }
}

/** One status line describing what the checkout is doing. */
function stateLine(t, status, stateWord) {
  if (stateWord === 'unavailable') return label(t, 'updateUnavailable', 'This install is not a git checkout (for example a published package), so it cannot update itself.')
  if (stateWord === 'dirty') return label(t, 'updateDirty', 'The working tree has uncommitted changes; the update will be refused.')
  if (stateWord === 'behind') {
    const latest = status?.latest === undefined ? '' : ' · ' + status.latest.head + ' ' + status.latest.subject
    return label(t, 'updateBehind', 'Behind upstream') + ': ' + status.behind + (status.upstream === undefined ? '' : ' (' + status.upstream + ')') + latest
  }
  if (stateWord === 'current') return label(t, 'updateUpToDate', 'Up to date with upstream.')
  return label(t, 'updateNotChecked', 'Not checked against upstream yet.')
}

/**
 * The full update panel.
 * @param props - slot props: t and any owner props (ignored here).
 * @returns the panel.
 */
export function UsdUpdatePanel(props) {
  const t = props.t
  const state = useUpdateState()
  const { status, busy, error, result } = state
  const currentState = updateState(status)
  const behind = updateAvailable(status)
  const canUpdate = status !== null && status.available === true && status.detached !== true
    && status.dirty !== true && status.upstream !== undefined
  const restartRequired = result !== null && result.restartRequired === true && (result.restart === undefined || result.restart.ok !== true)
  const log = (result !== null && Array.isArray(result.log)) ? result.log.slice(-12) : []

  const confirmRestart = () => {
    if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true
    return window.confirm(label(t, 'updateRestartConfirm', 'Restarting disconnects this page. Continue?'))
  }

  return (
    <div style={PANEL} data-usd-update data-usd-update-state={currentState}>
      <div style={HEAD}>
        <span style={TITLE}>{label(t, 'updateTitle', 'Local plugin update')}</span>
        {status !== null && typeof status.version === 'string' ? <span style={VERSION}>v{status.version}</span> : null}
        {behind ? <span style={TAG}>{label(t, 'updateBadge', 'Update available')}</span> : null}
      </div>
      <div style={INTRO}>
        {label(t, 'updateIntro', 'Fast-forward this plugin’s checkout from its upstream, rebuild it, and load the new client bundle. Only a clean checkout can update.')}
      </div>
      {status !== null && status.available === true ? (
        <>
          <div style={LINE}>
            <span>{label(t, 'updateBranch', 'Branch')}</span>
            <span style={VALUE}>{status.branch ?? '—'}</span>
            <span>{label(t, 'updateCommit', 'Commit')}</span>
            <span style={VALUE}>{status.head ?? '—'}</span>
          </div>
          <div style={LINE}>
            <span>{label(t, 'updateCheckout', 'Checkout')}</span>
            <span style={VALUE} title={status.root}>{status.root}</span>
          </div>
        </>
      ) : null}
      <div style={{ ...NOTE, color: behind || currentState === 'behind' ? ACCENT : LABEL_DIM }}>{stateLine(t, status, currentState)}</div>
      <div style={ROW}>
        <button type="button" style={buttonStyle(false)} disabled={busy !== null} onClick={() => void state.check()}>
          {busy === 'check' ? label(t, 'updateChecking', 'Checking…') : label(t, 'updateCheck', 'Check for updates')}
        </button>
        <button type="button" style={buttonStyle(true)} disabled={busy !== null || !canUpdate} onClick={() => void state.update()}>
          {busy === 'update' ? label(t, 'updateBusy', 'Updating…') : label(t, 'updateNow', 'Update and rebuild')}
        </button>
        {restartRequired && status !== null && status.restartAvailable === true ? (
          <button
            type="button"
            style={buttonStyle(false)}
            disabled={busy !== null}
            onClick={() => { if (confirmRestart()) void state.restart() }}
          >
            {busy === 'restart' ? label(t, 'updateRestarting', 'Restarting…') : label(t, 'updateRestart', 'Restart DSH Web')}
          </button>
        ) : null}
      </div>
      {restartRequired ? (
        <div style={{ ...NOTE, color: ERROR }}>{label(t, 'updateRestartNeeded', 'lib/index.js changed: the host half needs a restart to load.')}</div>
      ) : null}
      {error !== null ? (
        <div style={{ ...NOTE, color: ERROR, whiteSpace: 'pre-wrap' }}>
          {label(t, 'updateFailed', 'Update failed')}: {error.message ?? error.error ?? 'unknown error'}
        </div>
      ) : null}
      {result !== null && result.ok === true && result.from !== undefined ? (
        <div style={{ ...NOTE, color: SUCCESS }}>
          {label(t, 'updateDone', 'Update complete')}: v{result.from.version} → v{result.to.version} ({result.from.head} → {result.to.head})
          {' · '}{(result.steps ?? []).map(step => step.name).join(' → ')}
        </div>
      ) : null}
      {result !== null && result.ok === true && result.from === undefined && result.restart !== undefined ? (
        <div style={{ ...NOTE, color: SUCCESS }}>
          {label(t, 'updateRestarting', 'Restarting…')} {result.restart.service ?? ''}
        </div>
      ) : null}
      {log.length > 0 ? <pre style={LOG} data-usd-update-log>{log.join('\n')}</pre> : null}
      {currentState === 'unavailable' ? (
        <div style={{ ...NOTE, fontFamily: MONO }}>{label(t, 'updateHint', 'Update from a git checkout with: npm run update:local')}</div>
      ) : null}
      {result !== null && result.ok === true && result.hostChanged !== true ? (
        <div style={NOTE}>{label(t, 'updateHostHint', 'The client bundle is hot-reloaded; refresh the page if it does not update.')}</div>
      ) : null}
    </div>
  )
}

/**
 * Settings -> Plugins tab entry: the same panel, with its own settings heading.
 * @param props - slot props (t).
 * @returns the settings tab content.
 */
export function UsdUpdateSettingsTab(props) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <UsdUpdatePanel t={props.t} />
    </div>
  )
}

/** The matched badge body; only mounted for this bundle, so it owns the fetch. */
function UpdateBadgeBody(props) {
  const t = props.t
  const state = useUpdateState()
  if (updateAvailable(state.status) !== true) return null
  const behind = Number(state.status.behind)
  return (
    <span style={TAG} data-usd-update-badge>
      {label(t, 'updateBadge', 'Update available')}{Number.isFinite(behind) && behind > 0 ? ' · ' + behind : ''}
    </span>
  )
}

/**
 * Plugins detail-page badge: shows only when this bundle has an update waiting.
 * @param props - subject plus t.
 * @returns a tag, or null for another bundle / no update.
 */
export function UsdUpdateBadge(props) {
  if (matchesUpdateSubject(props.subject) !== true) return null
  return <UpdateBadgeBody t={props.t} />
}

/**
 * Plugins detail-page section: the full panel for this bundle, nothing for others.
 * @param props - subject plus t.
 * @returns the section, or null.
 */
export function UsdUpdateSection(props) {
  if (matchesUpdateSubject(props.subject) !== true) return null
  return <UsdUpdatePanel t={props.t} />
}
