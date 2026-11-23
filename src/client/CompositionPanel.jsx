/**
 * The stage composition panel: which layers the preview composed and through
 * which arcs.
 *
 * ## Why a modal rather than another side panel
 *
 * The prims tree and the details panel are two edges of the viewport because they
 * are read together, one for picking and one for reading. The composition is not
 * that kind of panel: it answers "where did this whole stage come from", a
 * question asked before or after inspecting prims, not beside them. It therefore
 * takes the centre of the viewport for a moment, with the model still visible
 * behind it, so opening it does not rearrange the two panels a reader is using.
 *
 * ## What it shows
 *
 * One row per composed layer, in the order the arcs reached it, indented by arc
 * depth. A row carries the arc that placed it there (a sublayer, a reference or
 * a payload), the layer's metadata, and the arcs that did not resolve or that
 * closed a cycle; layers the composition kept without an arc are listed under
 * "sources". Nothing is computed here: the panel renders what the composition
 * reader found in the layer bytes, and says so when the stage kept no bytes.
 *
 * @module dsh-usd-3d-preview/CompositionPanel
 */
import { useCallback, useEffect, useState } from 'react'
import { ACCENT, BORDER, ERROR, LABEL, LABEL_DIM, MONO, SURFACE } from './tokens.js'

const BACKDROP = {
  position: 'absolute',
  inset: 0,
  zIndex: 7,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 20,
  background: 'rgba(0, 0, 0, 0.34)',
}

const PANEL = {
  width: 'min(760px, 100%)',
  maxHeight: 'calc(100% - 60px)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  borderRadius: 8,
  border: '1px solid ' + BORDER,
  background: SURFACE,
  color: LABEL,
  fontSize: 11,
  boxShadow: '0 12px 34px rgba(0, 0, 0, 0.42)',
}

const HEAD = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '6px 10px',
  borderBottom: '1px solid ' + BORDER,
  color: LABEL_DIM,
}

const TITLE = { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

const CLOSE = {
  flex: '0 0 auto',
  padding: '1px 6px',
  borderRadius: 5,
  border: '1px solid ' + BORDER,
  background: 'transparent',
  color: LABEL_DIM,
  font: 'inherit',
  fontSize: 11,
  lineHeight: 1.5,
  cursor: 'pointer',
}

const BODY = { flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: '6px 0 10px' }

const SUMMARY = { padding: '0 12px 6px', color: LABEL_DIM, display: 'flex', flexWrap: 'wrap', gap: 10 }

const NODE = {
  padding: '3px 12px 5px',
  borderTop: '1px solid transparent',
}

const NODE_HEAD = { display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 6, minWidth: 0 }

const NODE_NAME = { fontFamily: MONO, color: LABEL, wordBreak: 'break-all' }

const NODE_META = { fontFamily: MONO, color: LABEL_DIM, fontSize: 10 }

const ROLE = {
  display: 'inline-block',
  padding: '0 5px',
  borderRadius: 4,
  border: '1px solid ' + BORDER,
  color: ACCENT,
  fontFamily: MONO,
  fontSize: 10,
}

const FROM = { margin: '2px 0 0', color: LABEL_DIM, fontFamily: MONO, fontSize: 10, wordBreak: 'break-all' }

const FROM_ASSET = { color: ACCENT }

const PROBLEM = { margin: '2px 0 0', color: ERROR, fontFamily: MONO, fontSize: 10, wordBreak: 'break-all' }

const SECTION = { margin: '12px 12px 4px', color: LABEL_DIM, textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10 }

const META_ROW = { padding: '0 12px', fontFamily: MONO, color: LABEL_DIM, fontSize: 10, wordBreak: 'break-all' }

const NOTE = { padding: '4px 12px', color: LABEL_DIM, lineHeight: 1.6 }
const FAILED = { ...NOTE, color: ERROR }

/** The last path segment of a layer key. */
function baseNameOf(key) {
  const name = String(key).split('/').filter(Boolean).pop()
  return name === undefined || name === '' ? String(key) : name
}

/**
 * One arc kind in a reader's words.
 * @param kind - root, sublayer, reference or payload.
 * @param label - the dictionary lookup.
 * @returns the label.
 */
function roleLabel(kind, label) {
  if (kind === 'root') return label('layerRoot', 'root layer')
  if (kind === 'sublayer') return label('layerSublayer', 'sublayer')
  if (kind === 'payload') return label('layerPayload', 'payload')
  return label('layerReference', 'reference')
}

/**
 * The panel body: one row per composed layer plus the sources no arc reached.
 * @param props.composition - the read result (see composition.js).
 * @param props.label - the dictionary lookup.
 * @returns the rows.
 */
function CompositionBody({ composition, label }) {
  const { nodes, unreached, counts, omittedArcs, truncated } = composition
  return (
    <>
      <div style={SUMMARY} data-usd-composition-summary>
        <span>{counts.layers} {label('compositionLayers', 'layers')}</span>
        <span>{counts.arcs} {label('compositionArcs', 'arcs')}</span>
        {counts.unresolved === 0 ? null : <span style={{ color: ERROR }}>{counts.unresolved} {label('compositionUnresolved', 'unresolved')}</span>}
      </div>
      {nodes.map((node) => {
        const problems = node.arcs.filter(arc => arc.targetLayer === '' || arc.cycle === true)
        return (
          <div
            key={node.id}
            style={{ ...NODE, paddingLeft: 12 + node.depth * 16 }}
            data-usd-composition-node={node.key}
            data-usd-composition-role={node.role}
            data-usd-composition-depth={node.depth}
          >
            <div style={NODE_HEAD}>
              <span style={ROLE}>{roleLabel(node.role, label)}</span>
              <span style={NODE_NAME}>{node.name}</span>
              <span style={NODE_META}>{node.format}</span>
              {node.primCount === 0 ? null : <span style={NODE_META}>{node.primCount} {label('compositionPrims', 'prims')}</span>}
              {node.unreadable === undefined ? null : <span style={PROBLEM}>{node.unreadable}</span>}
            </div>
            {node.from === null ? null : (
              <div style={FROM} data-usd-composition-from>
                {roleLabel(node.from.kind, label)} <span style={FROM_ASSET}>@{node.from.asset}@</span>
                {node.from.arcPrim === '' ? '' : '<' + node.from.arcPrim + '>'}
                {node.from.prim === '' ? '' : ' · ' + label('compositionFromPrim', 'from') + ' ' + node.from.prim}
                {' · ' + label('compositionFromLayer', 'in') + ' ' + baseNameOf(node.from.layer)}
              </div>
            )}
            {node.depth === 0 && node.layerMeta !== undefined ? (
              <div style={META_ROW} data-usd-composition-meta>
                {node.layerMeta.defaultPrim === '' ? '' : label('compositionDefaultPrim', 'defaultPrim') + ' ' + node.layerMeta.defaultPrim + ' · '}
                {node.layerMeta.upAxis === '' ? '' : label('compositionUpAxis', 'upAxis') + ' ' + node.layerMeta.upAxis + ' · '}
                {node.layerMeta.metersPerUnit === undefined ? '' : label('compositionMeters', 'metersPerUnit') + ' ' + node.layerMeta.metersPerUnit + ' · '}
                {node.layerMeta.startTimeCode === undefined ? '' : label('compositionTime', 'time') + ' ' + node.layerMeta.startTimeCode + '–' + (node.layerMeta.endTimeCode ?? '')}
              </div>
            ) : null}
            {problems.map((arc, index) => (
              <div key={index} style={PROBLEM} data-usd-composition-problem={arc.asset}>
                {roleLabel(arc.kind, label)} <span style={{ color: ACCENT }}>@{arc.asset}@</span>
                {arc.arcPrim === '' ? '' : '<' + arc.arcPrim + '>'}
                {arc.prim === '' ? '' : ' · ' + arc.prim}
                {' — ' + (arc.cycle === true ? label('compositionCycle', 'cycle') : label('compositionNotComposed', 'not composed by this stage'))}
              </div>
            ))}
          </div>
        )
      })}
      {truncated ? (
        <div style={NOTE} data-usd-composition-truncated>{label('compositionTruncated', 'The composition is larger than this panel draws; the rest is counted, not listed.')}</div>
      ) : null}
      {omittedArcs > 0 ? (
        <div style={NOTE}>{omittedArcs} {label('compositionOmitted', 'arcs past the row limit were counted, not drawn.')}</div>
      ) : null}
      {unreached.length === 0 ? null : (
        <>
          <div style={SECTION}>{label('compositionUnreached', 'Sources with no arc')} · {unreached.length}</div>
          {unreached.map(entry => (
            <div key={entry.key} style={META_ROW} data-usd-composition-unreached={entry.key}>
              {entry.name} <span style={{ color: LABEL_DIM }}>· {entry.format} · {entry.reason}</span>
            </div>
          ))}
        </>
      )}
    </>
  )
}

/**
 * The composition panel.
 * @param props.read - reads the composition; undefined means the stage kept no
 *   layer bytes to read.
 * @param props.onClose - closes the panel.
 * @param props.t - the dictionary lookup, when the seat provided one.
 * @returns the modal panel.
 */
export function StageCompositionPanel({ read, onClose, t }) {
  const [state, setState] = useState({ status: 'loading', composition: undefined, error: '' })

  const label = useCallback((key, fallback) => {
    if (typeof t !== 'function') return fallback
    try {
      const value = t(key)
      return value === undefined || value === null || value === key ? fallback : value
    } catch {
      return fallback
    }
  }, [t])

  useEffect(() => {
    if (typeof read !== 'function') {
      setState({ status: 'unsupported', composition: undefined, error: '' })
      return undefined
    }
    let cancelled = false
    setState({ status: 'loading', composition: undefined, error: '' })
    Promise.resolve()
      .then(() => read())
      .then((composition) => {
        if (cancelled) return
        setState(composition === undefined
          ? { status: 'unsupported', composition: undefined, error: '' }
          : { status: 'ready', composition, error: '' })
      }, (error) => {
        if (cancelled) return
        setState({ status: 'failed', composition: undefined, error: error instanceof Error ? error.message : String(error) })
      })
    return () => { cancelled = true }
  }, [read])

  const composition = state.composition
  return (
    <div
      style={BACKDROP}
      data-usd-composition
      onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}
    >
      <div style={PANEL} onPointerDown={event => event.stopPropagation()}>
        <div style={HEAD}>
          <span style={TITLE}>{label('composition', 'Composition')}</span>
          {composition === undefined ? null : (
            <span style={{ color: LABEL_DIM, fontFamily: MONO, fontSize: 10 }}>{baseNameOf(composition.rootKey)}</span>
          )}
          <button type="button" style={CLOSE} data-usd-composition-close onClick={onClose} aria-label={label('compositionClose', 'Close the composition panel')}>×</button>
        </div>
        <div style={BODY}>
          {state.status === 'loading' ? <div style={NOTE}>{label('compositionLoading', 'Reading the layer stack…')}</div>
            : state.status === 'failed' ? <div style={FAILED}>{label('compositionFailed', 'The composition could not be read')}: {state.error}</div>
              : state.status === 'unsupported' ? <div style={NOTE}>{label('compositionUnsupported', 'This stage was composed without keeping its layer bytes, so its arcs cannot be read back.')}</div>
                : <CompositionBody composition={composition} label={label} />}
        </div>
      </div>
    </div>
  )
}
