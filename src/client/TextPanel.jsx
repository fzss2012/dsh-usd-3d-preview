/**
 * The USDA text reader panel: the authored text of a layer, numbered, tokenised
 * and scrollable, with the layer it belongs to named above it.
 *
 * ## Why a panel rather than an editor
 *
 * The viewport answers what the stage looks like after composition; this panel
 * answers what one layer *says*. Those are different questions and the second is
 * the one an exporter bug, a broken brace or an unexpected `prepend references`
 * is debugged against. The panel is therefore a reader: line numbers, the shell's
 * own code palette, wrap and copy. It is deliberately not an editor, not a
 * composition browser and not a selection sync — it has no write path and never
 * touches the viewport, because looking at text must not change what is drawn.
 *
 * ## Bounded rendering
 *
 * The pure module hands back a preview whose line count, byte count and per-line
 * length are already capped; this component renders exactly those rows and never
 * re-decodes the layer. That is what keeps a 90 MiB one-line points array from
 * becoming 90 MiB of DOM: it arrives as one trimmed line and a truncation
 * notice. Every flex child carries `minWidth: 0`, so a long line scrolls inside
 * the body instead of widening the sidebar panel.
 *
 * ## Bytes arrive lazily
 *
 * A layer may be delivered as bytes the caller already holds or as a `load`
 * callback, because the USD body can keep several layers behind blobs and should
 * only read the one the reader selected. The read happens in an effect keyed by
 * the active layer, with the ordinary loading / ready / failed states; a stale
 * read is dropped on a layer switch rather than painted under the wrong name.
 *
 * ## What it deliberately does not do
 *
 * It does not decide which layers exist or what a role means — the caller hands
 * them in and gets a callout back. It does not unzip a package here (the caller
 * expands it, so a package's layers can each be shown), and it does not
 * reconstruct crate text; a crate without reconstructed bytes is stated as a
 * binary layer. Copying uses `navigator.clipboard` only: a browser that refuses
 * shows nothing copied rather than falling back to a selection hack.
 *
 * @module dsh-usd-3d-preview/TextPanel
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { previewLayer, usdaPreviewLines } from './text-view.js'
import { ACCENT, ACCENT_WASH, BORDER, ERROR, FONT, LABEL, LABEL_DIM, MONO, SURFACE } from './tokens.js'

/**
 * The shell's JSON-tree tokens are the shell's code colouring — keyword, number,
 * string, property and punctuation — so USDA is coloured with the palette the
 * surrounding UI already uses for code instead of inventing a second one. They
 * are read here rather than added to `tokens.js` (this module may not modify it).
 */
const SYNTAX_KEYWORD = 'var(--dsw-alias-json-tree-keyword, #99c8ff)'
const SYNTAX_NUMBER = 'var(--dsw-alias-json-tree-number, #99c8ff)'
const SYNTAX_STRING = 'var(--dsw-alias-json-tree-string, #f28b82)'
const SYNTAX_ASSET = 'var(--dsw-alias-json-tree-property, #5db0d7)'
const SYNTAX_PUNCT = 'var(--dsw-alias-json-tree-punctuation, #e8eaed)'

/** Token-to-style map: one colouring class per lexer kind, nothing invented. */
const TOKEN_STYLES = {
  comment: { color: LABEL_DIM, fontStyle: 'italic' },
  string: { color: SYNTAX_STRING },
  asset: { color: SYNTAX_ASSET },
  number: { color: SYNTAX_NUMBER },
  keyword: { color: SYNTAX_KEYWORD, fontWeight: 600 },
  identifier: { color: LABEL },
  punct: { color: SYNTAX_PUNCT },
  space: undefined,
}

/** Dictionary keys and English fallbacks for the layer roles the reader names. */
const ROLE_LABELS = {
  root: ['layerRoot', 'Root'],
  sublayer: ['layerSublayer', 'Sublayer'],
  reference: ['layerReference', 'Reference'],
  payload: ['layerPayload', 'Payload'],
  layer: ['layerLayer', 'Layer'],
}

const PANEL = {
  height: '100%',
  minHeight: 0,
  minWidth: 0,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  background: SURFACE,
  color: LABEL,
  fontSize: 11,
  fontFamily: FONT,
  boxSizing: 'border-box',
}

const HEAD = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
  padding: '5px 8px',
  borderBottom: '1px solid ' + BORDER,
  color: LABEL_DIM,
}

const TITLE = { flex: '0 0 auto', minWidth: 0, color: LABEL_DIM }

const ACTIVE_NAME = {
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontFamily: MONO,
  color: LABEL,
}

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

const PICKER = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  minWidth: 0,
  padding: '3px 8px',
  borderBottom: '1px solid ' + BORDER,
  overflowX: 'auto',
  overflowY: 'hidden',
}

const CHIP = {
  flex: '0 0 auto',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  minWidth: 0,
  maxWidth: 190,
  padding: '0 6px',
  borderRadius: 5,
  border: '1px solid ' + BORDER,
  background: 'transparent',
  color: LABEL_DIM,
  font: 'inherit',
  fontSize: 10,
  lineHeight: 1.7,
  cursor: 'pointer',
}

const CHIP_ON = {
  ...CHIP,
  borderColor: ACCENT,
  background: ACCENT_WASH,
  color: ACCENT,
}

const BADGE = {
  flex: '0 0 auto',
  padding: '0 3px',
  borderRadius: 3,
  border: '1px solid ' + BORDER,
  color: 'inherit',
  fontSize: 9,
  lineHeight: 1.6,
  letterSpacing: '0.04em',
  textTransform: 'uppercase',
}

const CHIP_NAME = {
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontFamily: MONO,
}

const TOOLBAR = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  minWidth: 0,
  padding: '3px 8px',
  borderBottom: '1px solid ' + BORDER,
  color: LABEL_DIM,
  fontSize: 10,
}

const STAT = {
  flex: '1 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontFamily: MONO,
}

const BUTTON = {
  flex: '0 0 auto',
  padding: '0 6px',
  borderRadius: 5,
  border: '1px solid ' + BORDER,
  background: 'transparent',
  color: LABEL_DIM,
  font: 'inherit',
  fontSize: 10,
  lineHeight: 1.6,
  cursor: 'pointer',
}

const BUTTON_ON = {
  ...BUTTON,
  borderColor: ACCENT,
  background: ACCENT_WASH,
  color: ACCENT,
}

const BUTTON_OFF = { ...BUTTON, opacity: 0.5, cursor: 'default' }

const NOTICE = {
  flex: '0 0 auto',
  padding: '3px 8px',
  borderBottom: '1px solid ' + BORDER,
  color: LABEL_DIM,
  fontSize: 10,
}

const BODY = { flex: '1 1 auto', minHeight: 0, minWidth: 0, overflow: 'auto' }

const ROWS = { minWidth: 0, padding: '4px 0 10px' }

const ROW = {
  display: 'flex',
  alignItems: 'flex-start',
  minWidth: 0,
  padding: '0 8px',
  lineHeight: 1.55,
}

const GUTTER = {
  flex: '0 0 auto',
  paddingRight: 8,
  color: LABEL_DIM,
  textAlign: 'right',
  userSelect: 'none',
  fontVariantNumeric: 'tabular-nums',
  opacity: 0.75,
}

const CODE = {
  flex: '1 1 auto',
  minWidth: 0,
  whiteSpace: 'pre',
  color: LABEL,
  fontFamily: MONO,
  fontSize: 11,
}

const CODE_WRAP = { ...CODE, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }

const NOTE = { padding: '8px', color: LABEL_DIM, lineHeight: 1.6 }

const FAILED = { ...NOTE, color: ERROR }

/**
 * A byte count for the toolbar, in the compact form a stats line uses.
 * @param count - the byte count.
 * @returns a short human-readable size, or an em dash for an unusable number.
 */
function formatBytes(count) {
  if (typeof count !== 'number' || Number.isFinite(count) !== true || count < 0) return '—'
  if (count < 1024) return count + ' B'
  if (count < 1024 * 1024) return (count / 1024).toFixed(1) + ' KB'
  return (count / (1024 * 1024)).toFixed(1) + ' MB'
}

/**
 * The gutter width for a row count, in `ch` so it follows the mono face: one
 * spare character keeps the last number off the code when digits are added.
 * @param count - number of rows (or the highest line number).
 * @returns a CSS width.
 */
function gutterWidthOf(count) {
  return (String(count < 1 ? 1 : count).length + 1) + 'ch'
}

/**
 * The full name of a layer, falling back to its key when a display name was not
 * given.
 * @param layer - one layer entry.
 * @returns the name to show and to title the chip with.
 */
function nameOf(layer) {
  if (typeof layer.name === 'string' && layer.name !== '') return layer.name
  return layer.key === undefined ? '' : String(layer.key)
}

/**
 * The last path component of a layer name: the header keeps the full name, the
 * picker's chip must stay narrow enough that several fit on one row.
 * @param layer - one layer entry.
 * @returns the short name.
 */
function shortNameOf(layer) {
  const name = nameOf(layer)
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  return slash < 0 ? name : name.slice(slash + 1)
}

/**
 * The toolbar's line/byte summary for one preview.
 * @param preview - the resolved preview, or undefined before the bytes arrive.
 * @param label - the dictionary lookup.
 * @returns the summary string.
 */
function statOf(preview, label) {
  if (preview === undefined) return '—'
  const bytes = formatBytes(preview.totalBytes)
  if (preview.kind !== 'text') return bytes
  return preview.lineCount + ' ' + label('textLines', 'lines') + ' · ' + bytes
}

/** Whether a resolved layer value holds bytes the preview can classify. */
function isBytes(value) {
  try {
    return value instanceof ArrayBuffer || ArrayBuffer.isView(value)
  } catch {
    return false
  }
}

/**
 * A thrown value as a message for the failure note.
 * @param error - whatever the load rejected with.
 * @returns a non-throwing human-readable message.
 */
function describeError(error) {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return ''
  }
}

/**
 * Classify one layer's bytes into the panel's render state.
 *
 * `previewLayer` is already total, but the panel still owns the try/catch: a
 * malformed layer must render the failure state, never unmount the panel.
 * @param bytes - the resolved layer bytes.
 * @returns `{ status, preview, error }`.
 */
function stateOf(bytes, describe) {
  if (isBytes(bytes) !== true) return { status: 'empty', preview: undefined, error: '' }
  try {
    return { status: 'ready', preview: describe(bytes), error: '' }
  } catch (error) {
    return { status: 'failed', preview: undefined, error: describeError(error) }
  }
}

/**
 * The active layer's name, or an empty string when there is no layer to name.
 * @param layer - the active layer entry, or undefined.
 * @returns the string key the state is keyed by.
 */
function keyOf(layer) {
  if (layer === undefined || layer.key === undefined || layer.key === null) return ''
  return String(layer.key)
}

/**
 * A toolbar button's style for its on/off and enabled state.
 * @param on - whether the button's mode is active.
 * @param enabled - whether the button can act.
 * @returns the inline style.
 */
function buttonStyle(on, enabled) {
  if (enabled !== true) return BUTTON_OFF
  return on === true ? BUTTON_ON : BUTTON
}

/**
 * The USDA text reader.
 *
 * The component owns only presentation and the lazy read of the active layer;
 * which layers exist, what their roles mean, and what happens when the reader
 * switches layers are the caller's decisions.
 * @param props.layers - layer entries `{ key, name, role, bytes?, load? }`; a
 *   byte-less entry with `load` is read when it becomes active.
 * @param props.activeKey - the layer to show; falls back to the first entry.
 * @param props.onSelect - called with a layer key when the reader picks a chip.
 * @param props.onClose - closes the text view.
 * @param props.describeLayer - turns one layer's bytes into the preview this panel
 *   paints; defaults to the authored-text reader, and a caller that can also
 *   reconstruct a binary container's text passes its own (see parse.js).
 * @param props.t - the dictionary lookup, when the seat provided one.
 * @returns the panel.
 */
export function UsdTextPanel({ layers, activeKey, onSelect, onClose, describeLayer, t }) {
  const label = useCallback((key, fallback) => {
    if (typeof t !== 'function') return fallback
    try {
      const value = t(key)
      return value === undefined || value === null || value === key ? fallback : value
    } catch {
      return fallback
    }
  }, [t])

  const list = (Array.isArray(layers) ? layers : []).filter(layer => layer !== null && typeof layer === 'object')
  const match = activeKey === undefined || activeKey === null
    ? undefined
    : list.find(layer => layer.key === activeKey)
  const active = match !== undefined ? match : list[0]
  const activeLayerKey = keyOf(active)

  // The state is keyed by the layer it describes: a read still in flight for the
  // previous layer can finish after a switch, and this is what stops its result
  // being painted under the new layer's name.
  const [state, setState] = useState({ key: '', status: 'loading', preview: undefined, error: '' })
  const [wrap, setWrap] = useState(false)
  // The "Copied" label is keyed by when a copy succeeded rather than by a plain
  // boolean, so copying twice re-arms the 1.5 s timer instead of leaving the
  // first timer to reset it early.
  const [copiedAt, setCopiedAt] = useState(0)

  useEffect(() => {
    // A new layer means "copied" no longer describes what the button would copy.
    setCopiedAt(0)
    if (active === undefined) {
      setState({ key: activeLayerKey, status: 'empty', preview: undefined, error: '' })
      return undefined
    }
    let cancelled = false
    const describe = typeof describeLayer === 'function' ? describeLayer : previewLayer
    const settle = (bytes) => {
      if (cancelled) return
      setState({ key: activeLayerKey, ...stateOf(bytes, describe) })
    }
    const fail = (error) => {
      if (cancelled) return
      setState({ key: activeLayerKey, status: 'failed', preview: undefined, error: describeError(error) })
    }
    const cached = active.bytes
    if (typeof active.load === 'function') {
      setState({ key: activeLayerKey, status: 'loading', preview: undefined, error: '' })
      Promise.resolve()
        .then(() => active.load())
        .then((bytes) => {
          // A load that resolves to nothing is a layer with nothing to show;
          // otherwise already-resolved bytes are the fallback the caller kept.
          if (isBytes(bytes) === true) settle(bytes)
          else settle(cached)
        }, (error) => {
          if (isBytes(cached) === true) settle(cached)
          else fail(error)
        })
      return () => { cancelled = true }
    }
    if (isBytes(cached) === true) {
      settle(cached)
      return undefined
    }
    setState({ key: activeLayerKey, status: 'empty', preview: undefined, error: '' })
    return undefined
    // The load callback's identity is deliberately not a dependency: callers build
    // the layer list inline, so a fresh closure per render would restart the read
    // (and flash the loading state) on every parent update.
  }, [activeLayerKey, active === undefined ? undefined : active.bytes, describeLayer])

  useEffect(() => {
    if (copiedAt === 0) return undefined
    const timer = setTimeout(() => setCopiedAt(0), 1500)
    return () => clearTimeout(timer)
  }, [copiedAt])

  const settled = state.key === activeLayerKey
  const status = settled ? state.status : 'loading'
  const preview = settled ? state.preview : undefined
  const error = settled ? state.error : ''

  const layout = useMemo(() => usdaPreviewLines(preview), [preview])

  const handleCopy = useCallback(() => {
    // A failed copy says nothing: the label simply does not change.
    if (preview === undefined || preview.kind !== 'text') {
      setCopiedAt(0)
      return
    }
    const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard
    if (clipboard === undefined || typeof clipboard.writeText !== 'function') {
      setCopiedAt(0)
      return
    }
    try {
      Promise.resolve(clipboard.writeText(preview.text)).then(() => setCopiedAt(Date.now()), () => setCopiedAt(0))
    } catch {
      setCopiedAt(0)
    }
  }, [preview])

  const hasText = status === 'ready' && preview !== undefined && preview.kind === 'text' && preview.text !== ''
  const isEmpty = status === 'ready' && preview !== undefined
    && (preview.totalBytes === 0 || (preview.kind === 'text' && preview.text === ''))
  const truncated = preview !== undefined && preview.kind === 'text'
    && (preview.truncated === true || layout.omitted > 0)
  const codeStyle = wrap === true ? CODE_WRAP : CODE
  const gutterStyle = { ...GUTTER, width: gutterWidthOf(layout.rows.length === 0 ? 1 : layout.rows[layout.rows.length - 1].number) }

  const body = (() => {
    if (status === 'loading') {
      return <div style={NOTE}>{label('textLoading', 'Reading the layer…')}</div>
    }
    if (status === 'failed') {
      return <div style={FAILED}>{label('textFailed', 'The layer could not be shown')}{error === '' ? '' : ': ' + error}</div>
    }
    if (status === 'empty' || preview === undefined || isEmpty === true) {
      return <div style={NOTE}>{label('textEmpty', 'This layer is empty.')}</div>
    }
    if (preview.kind === 'binary' && preview.container === 'crate') {
      return <div style={NOTE}>{label('textBinaryCrate', 'This is a binary crate layer: it holds no USDA text.')}</div>
    }
    if (preview.kind === 'package') {
      return <div style={NOTE}>{label('textBinaryPackage', 'This is a .usdz package: its layers live inside the archive.')}</div>
    }
    if (preview.kind !== 'text') {
      return <div style={FAILED}>{label('textFailed', 'The layer could not be shown')}: {preview.reason}</div>
    }
    return (
      <div style={ROWS} data-usd-text-rows>
        {layout.rows.map(row => (
          <div style={ROW} key={row.number} data-usd-text-line={row.number}>
            <span style={gutterStyle} aria-hidden="true">{row.number}</span>
            <span style={codeStyle} data-usd-text-code>
              {row.tokens.map((token, index) => (
                <span key={index} style={TOKEN_STYLES[token.kind]}>{token.text}</span>
              ))}
            </span>
          </div>
        ))}
      </div>
    )
  })()

  return (
    <div
      style={PANEL}
      data-usd-text
      data-usd-text-kind={preview === undefined ? undefined : preview.kind}
      data-usd-text-layer={active === undefined ? undefined : active.key}
    >
      <div style={HEAD}>
        <span style={TITLE}>{label('textTitle', 'USDA text')}</span>
        {active === undefined ? null : <span style={ACTIVE_NAME} title={nameOf(active)}>{nameOf(active)}</span>}
        <button
          type="button"
          style={CLOSE}
          data-usd-text-close
          onClick={onClose}
          aria-label={label('textClose', 'Close the text view')}
        >×</button>
      </div>
      {list.length > 1 ? (
        <div style={PICKER}>
          {list.map((layer) => {
            const chipActive = active !== undefined && (layer === active || layer.key === active.key)
            const role = ROLE_LABELS[layer.role] ?? ROLE_LABELS.layer
            return (
              <button
                key={String(layer.key)}
                type="button"
                style={chipActive ? CHIP_ON : CHIP}
                data-usd-text-layer-chip
                data-usd-text-layer-key={layer.key}
                title={nameOf(layer)}
                onClick={() => { if (chipActive !== true && typeof onSelect === 'function') onSelect(layer.key) }}
              >
                <span style={BADGE}>{label(role[0], role[1])}</span>
                <span style={CHIP_NAME}>{shortNameOf(layer)}</span>
              </button>
            )
          })}
        </div>
      ) : null}
      <div style={TOOLBAR}>
        <span style={STAT} data-usd-text-stat title={statOf(preview, label)}>{statOf(preview, label)}</span>
        <button
          type="button"
          style={buttonStyle(wrap, hasText)}
          data-usd-text-wrap
          aria-pressed={wrap === true}
          disabled={hasText !== true}
          onClick={() => setWrap(value => value !== true)}
        >{label('textWrap', 'Wrap')}</button>
        <button
          type="button"
          style={buttonStyle(copiedAt !== 0, hasText)}
          data-usd-text-copy
          disabled={hasText !== true}
          onClick={handleCopy}
        >{copiedAt !== 0 ? label('textCopied', 'Copied') : label('textCopy', 'Copy')}</button>
      </div>
      {truncated === true ? (
        <div style={NOTICE}>{label('textTruncated', 'Showing the first part of a larger layer.')}</div>
      ) : null}
      <div style={BODY}>{body}</div>
    </div>
  )
}
