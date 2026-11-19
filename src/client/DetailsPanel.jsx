/**
 * The prim details panel: what the stage declares about the selected prim,
 * presented the way usdview's metadata and attribute panes present it.
 *
 * ## Why a panel rather than more rows in the prim tree
 *
 * The prim tree answers "what is in this stage". This panel answers "what *is*
 * this prim" — its type and kind, the API schemas applied to it, the attributes
 * it authors with their declared types, and the relationships it points at. Those
 * are different questions with different shapes: the first is a list of names, the
 * second is a table whose rows have a type and a value. Trying to serve both from
 * one panel is how a tree ends up as a wall of noise.
 *
 * ## The usdview correspondence
 *
 * A USD user arrives with usdview's vocabulary, so the panel uses it:
 *
 *   - the **prim header** names the path, its declared type and its `kind`;
 *   - **Applied Schemas** lists `apiSchemas` (usdview's "Applied API Schemas");
 *   - **Attributes** is a `type · name · value` table, with `custom` and `uniform`
 *     shown beside the name the way usdview's metadata column does;
 *   - **Relationships** lists the authored relationships with their resolved
 *     target paths;
 *   - **Composition** names the arcs the prim participates in (`inherits`,
 *     `specializes`, variant sets) and the layers that described it.
 *
 * The one deliberate difference: usdview shows the *composed* value, while this
 * panel shows **the value the strongest layer authored**, and names that layer.
 * Merging layers is the engine's job and doing it again here would be a second
 * opinion; naming the source is the honest version of the same answer.
 *
 * ## Large stages
 *
 * The panel is driven by an async read, so opening it never blocks the frame. A
 * value it could not read is stated rather than shown blank, and the layer list
 * makes a surprising value traceable to its file.
 *
 * @module dsh-usd-3d-preview/DetailsPanel
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { groupOf } from './details.js'
import { ACCENT, ACCENT_WASH, BASE, BORDER, ERROR, LABEL, LABEL_DIM, MONO, SURFACE } from './tokens.js'

const PANEL = {
  position: 'absolute',
  // The prims tree owns the left edge, so the details panel takes the right: the
  // two answer different questions and a reader may well want both on screen at
  // once (the tree to pick with, the table to read). Stacking them in one corner
  // would make opening the second hide the first.
  right: 10,
  top: 40,
  zIndex: 5,
  width: 360,
  maxWidth: 'calc(50% - 14px)',
  // Taller than the prims panel: a details table is the reason the reader opened
  // it, and a clipped attribute list is worse than a scrolled one.
  maxHeight: 'calc(100% - 90px)',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  borderRadius: 8,
  border: '1px solid ' + BORDER,
  background: SURFACE,
  color: LABEL,
  fontSize: 11,
  boxShadow: '0 8px 26px rgba(0, 0, 0, 0.34)',
}

const HEAD = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '5px 8px',
  borderBottom: '1px solid ' + BORDER,
  color: LABEL_DIM,
}

const TITLE = { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }

const CLOSE = {
  flex: '0 0 auto',
  padding: '1px 6px',
  borderRadius: 5,
  border: `1px solid ${BORDER}`,
  background: 'transparent',
  color: LABEL_DIM,
  font: 'inherit',
  fontSize: 11,
  lineHeight: 1.5,
  cursor: 'pointer',
}

const BODY = { flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: '4px 0 8px' }

const PATH = {
  margin: '0 8px 6px',
  padding: '3px 6px',
  borderRadius: 5,
  background: BASE,
  border: '1px solid ' + BORDER,
  color: ACCENT,
  fontFamily: MONO,
  fontSize: 11,
  wordBreak: 'break-all',
}

const SECTION = { margin: '8px 8px 2px', color: LABEL_DIM, textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10 }

const ROW = {
  display: 'grid',
  gridTemplateColumns: '92px minmax(0, 1fr)',
  gap: 6,
  padding: '1px 8px',
  alignItems: 'baseline',
}

const ROW_KEY = { color: LABEL_DIM, overflow: 'hidden', textOverflow: 'ellipsis' }
const ROW_VALUE = { minWidth: 0, wordBreak: 'break-word', fontFamily: MONO }

/** The attributes table: a declared type column, a name, and the value. */
const ATTR_ROW = {
  display: 'grid',
  gridTemplateColumns: '76px minmax(0, 1fr)',
  gap: 6,
  padding: '2px 8px',
  alignItems: 'baseline',
  borderTop: '1px solid transparent',
}

const ATTR_NAME = { color: LABEL, wordBreak: 'break-all', fontFamily: MONO }
const ATTR_TYPE = { color: LABEL_DIM, fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis' }
const ATTR_VALUE = {
  gridColumn: '1 / -1',
  color: LABEL_DIM,
  fontFamily: MONO,
  wordBreak: 'break-all',
  paddingLeft: 4,
  borderLeft: `1px solid ${BORDER}`,
  marginLeft: 2,
}

const FLAG = {
  display: 'inline-block',
  marginLeft: 4,
  padding: '0 3px',
  borderRadius: 3,
  border: `1px solid ${BORDER}`,
  color: LABEL_DIM,
  fontSize: 9,
  verticalAlign: 'middle',
}

/**
 * The layer one value came from, beside the name.
 *
 * Only drawn when the prim was described by more than one layer: on a single-layer
 * stage every row would repeat the same path, which is noise, and the aggregate
 * layer list below already names it once.
 */
const LAYER_FLAG = {
  display: 'inline-block',
  marginLeft: 4,
  color: ACCENT,
  fontFamily: MONO,
  fontSize: 9,
  opacity: 0.8,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  maxWidth: '100%',
  verticalAlign: 'middle',
}

const CHIP = {
  display: 'inline-block',
  margin: '0 4px 3px 0',
  padding: '0 5px',
  borderRadius: 4,
  border: `1px solid ${BORDER}`,
  background: ACCENT_WASH,
  color: ACCENT,
  fontFamily: MONO,
  fontSize: 10,
}

const NOTE = { padding: '4px 8px', color: LABEL_DIM, lineHeight: 1.6 }
const FAILED = { ...NOTE, color: ERROR }

/**
 * One labeled row of prim metadata.
 * @param props.label - the row's key.
 * @param props.children - the value, already formatted.
 * @returns the row.
 */
function Row({ label, children }) {
  return (
    <div style={ROW}>
      <span style={ROW_KEY}>{label}</span>
      <span style={ROW_VALUE}>{children}</span>
    </div>
  )
}

/**
 * One attribute row: declared type, name with its modifiers, and the value.
 * @param props.attribute - one {@link DetailAttribute}.
 * @returns the row.
 */
function AttributeRow({ attribute, showLayer }) {
  return (
    <div style={ATTR_ROW} data-usd-detail-attr={attribute.name}>
      <span style={ATTR_TYPE} title={attribute.type}>{attribute.type === '' ? '—' : attribute.type}</span>
      <span style={ATTR_NAME}>
        {attribute.name}
        {attribute.custom === true && <span style={FLAG}>custom</span>}
        {attribute.uniform === true && <span style={FLAG}>uniform</span>}
        {showLayer === true && attribute.layer !== '' && (
          <span style={LAYER_FLAG} data-usd-detail-attr-layer={attribute.layer} title={attribute.layer}>{attribute.layer}</span>
        )}
      </span>
      <span style={ATTR_VALUE} data-usd-detail-value>{attribute.value === '' ? '—' : attribute.value}</span>
    </div>
  )
}

/**
 * The details panel body.
 *
 * The component owns only the read's state; what to read and what it means is the
 * caller's (a USD prim path), and the reader is injected so the panel stays
 * testable without a host.
 * @param props.path - the prim path to describe, or null for "nothing selected".
 * @param props.read - reads one prim's details: `(path) => Promise<details|undefined>`.
 * @param props.onClose - closes the panel.
 * @param props.t - the dictionary lookup, when the seat provided one.
 * @param props.labels - fallback copy for the headings.
 * @returns the panel, or a "select a prim" note when nothing is selected.
 */
export function PrimDetailsPanel({ path, read, onClose, t }) {
  const [state, setState] = useState({ status: 'idle', details: undefined, error: '' })

  const label = useCallback((key, fallback) => {
    if (typeof t !== 'function') return fallback
    try {
      const value = t(key)
      return value === undefined || value === null || value === key ? fallback : value
    } catch {
      return fallback
    }
  }, [t])

  // Read on every path change: the panel is opened for one prim, so a stale table
  // would be a table about a different prim than the one the header names.
  useEffect(() => {
    if (path === null || path === undefined || typeof read !== 'function') {
      setState({ status: 'idle', details: undefined, error: '' })
      return undefined
    }
    let cancelled = false
    setState(current => ({ status: 'loading', details: current.details?.path === path ? current.details : undefined, error: '' }))
    Promise.resolve()
      .then(() => read(path))
      .then((details) => {
        if (cancelled) return
        setState({ status: details === undefined ? 'unsupported' : 'ready', details, error: '' })
      }, (error) => {
        if (cancelled) return
        setState({ status: 'failed', details: undefined, error: error instanceof Error ? error.message : String(error) })
      })
    return () => { cancelled = true }
  }, [path, read])

  const details = state.details
  // Group the attributes the way a reader scans them, keeping the reader's order
  // inside each group rather than re-sorting by name.
  const grouped = useMemo(() => {
    if (details === undefined || details.attributes.length === 0) return []
    const groups = new Map()
    for (const attribute of details.attributes) {
      const list = groups.get(groupOf(attribute.name)) ?? []
      list.push(attribute)
      groups.set(groupOf(attribute.name), list)
    }
    return [...groups.entries()]
  }, [details])

  return (
    <div style={PANEL} data-usd-details>
      <div style={HEAD}>
        <span style={TITLE}>{label('details', 'Prim details')}</span>
        <button type="button" style={CLOSE} data-usd-details-close onClick={onClose} aria-label={label('closeDetails', 'Close the details panel')}>×</button>
      </div>
      <div style={BODY}>
        {path === null || path === undefined ? (
          <div style={NOTE}>{label('detailsEmpty', 'Click a prim in the viewport to see what the stage declares about it.')}</div>
        ) : state.status === 'loading' ? (
          <div style={NOTE}>{label('detailsLoading', 'Reading the layers…')}</div>
        ) : state.status === 'failed' ? (
          <div style={FAILED}>{label('detailsFailed', 'The prim could not be read')}: {state.error}</div>
        ) : state.status === 'unsupported' ? (
          <div style={NOTE}>{label('detailsUnsupported', 'This stage was composed without keeping its layer bytes, so its declarations cannot be read back.')}</div>
        ) : details === undefined || details.present !== true ? (
          <div style={NOTE}>{label('detailsMissing', 'No layer in this stage describes that prim.')}</div>
        ) : (
          <>
            <div style={PATH} title={details.path}>{details.path}</div>
            {details.authoredPath === details.path ? null : (
              // A referenced or payloaded prim is authored under a different path
              // than the one the stage composes; naming both is what keeps a
              // surprising value traceable to the line that wrote it.
              <Row label={label('detailAuthored', 'Authored as')}>
                <span data-usd-detail-authored>{details.authoredPath}</span>
              </Row>
            )}
            <Row label={label('detailType', 'Type')}>{details.type === '' ? '—' : details.type}</Row>
            <Row label={label('detailKind', 'Kind')}>{details.kind === '' ? '—' : details.kind}</Row>
            {details.specifier === '' ? null : <Row label={label('detailSpecifier', 'Specifier')}>{details.specifier}</Row>}
            {details.apiSchemas.length === 0 ? null : (
              <>
                <div style={SECTION}>{label('detailApiSchemas', 'Applied schemas')}</div>
                <div style={{ padding: '0 8px' }}>
                  {details.apiSchemas.map(schema => <span key={schema} style={CHIP} data-usd-detail-schema={schema}>{schema}</span>)}
                </div>
              </>
            )}
            {details.variantSets.length === 0 ? null : (
              <Row label={label('detailVariants', 'Variant sets')}>{details.variantSets.join(', ')}</Row>
            )}
            {details.inherits.length === 0 ? null : (
              <Row label={label('detailInherits', 'Inherits')}>{details.inherits.join(', ')}</Row>
            )}
            {details.specializes.length === 0 ? null : (
              <Row label={label('detailSpecializes', 'Specializes')}>{details.specializes.join(', ')}</Row>
            )}
            {details.doc === '' ? null : (
              <Row label={label('detailDoc', 'Doc')}>{details.doc}</Row>
            )}
            {grouped.map(([group, attributes]) => (
              <div key={group}>
                <div style={SECTION} data-usd-detail-group={group}>{group} · {attributes.length}</div>
                {attributes.map(attribute => (
                  <AttributeRow key={attribute.name} attribute={attribute} showLayer={details.layers.length > 1} />
                ))}
              </div>
            ))}
            {details.relationships.length === 0 ? null : (
              <>
                <div style={SECTION}>{label('detailRelationships', 'Relationships')} · {details.relationships.length}</div>
                {details.relationships.map(relationship => (
                  <div style={ROW} key={relationship.name} data-usd-detail-rel={relationship.name}>
                    <span style={ROW_KEY} title={relationship.name}>{relationship.name}</span>
                    <span style={ROW_VALUE}>{relationship.targets.length === 0 ? '—' : relationship.targets.join(', ')}</span>
                  </div>
                ))}
              </>
            )}
            <div style={SECTION}>{label('detailLayers', 'Layers')} · {details.layers.length}</div>
            <div style={{ padding: '0 8px', color: LABEL_DIM, fontFamily: MONO, wordBreak: 'break-all' }}>
              {details.layers.join('\n')}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
