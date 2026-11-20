/**
 * The viewport for one IFC model.
 *
 * The counterpart of `UsdBody` for the other format this plugin opens. It shares
 * the parts that are actually common — `createView`'s orbit viewport, the studio
 * rig, the tokens, the prim tree and the selection tint — and replaces the parts
 * that are not: an IFC model is read by a schema-aware STEP reader in a worker,
 * its structure is a spatial tree of products rather than a prim graph, and what
 * a reader wants to know about an element is its property sets, not its
 * `apiSchemas`.
 *
 * ## What is drawn
 *
 * Every placed geometry the model carries, at world coordinates, in the colour its
 * `IfcSurfaceStyle` authored (or a neutral grey when it authored none). The graph
 * is flat and each mesh is named by its element path, which is what makes a click
 * name an element and what makes the tree and the viewport address the same thing.
 *
 * ## What is interactive
 *
 * Picking names the element under the cursor and tints it; the elements panel lists
 * the spatial tree, filters it, and selects from it; the details panel reads that
 * element's identity and its property sets back out of the model. IFC has no joint
 * schema this plugin can drive (unlike `UsdPhysics`), so there is no articulation
 * control here — the toolbar is the view controls and the two panels.
 *
 * A tree row is two controls, not one: a caret that folds and a label that selects.
 * That split is not decoration. A wall with an opening cut through it is both a
 * folder and an element — it has children and geometry — and a single click cannot
 * mean both "fold" and "select this", so one of the two would become unreachable.
 *
 * @module dsh-usd-3d-preview/IfcBody
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TreeChevron, TreeFolder, TreePrim } from './artwork.jsx'
import { loadIfc, stopIfcWorker } from './ifc-engine.js'
import { ifcLengthUnitLabel, ifcTypeLabel, ifcUnitDescription } from './ifc.js'
import {
  allFolderPaths, ancestorsOf, buildPrimTree, countPrimNodes, filterPrimTree, flattenPrimTree,
} from './prim-tree.js'
import { ACCENT, ACCENT_WASH, BASE, BORDER, ERROR, FONT, LABEL, LABEL_DIM, MONO, SURFACE } from './tokens.js'
import { usdFileName } from './usd.js'
import { createView } from './view.js'

const SHELL = {
  position: 'absolute',
  inset: 0,
  overflow: 'hidden',
  background: BASE,
  color: LABEL,
  fontFamily: FONT,
  fontSize: 12,
  outline: 'none',
}

const CANVAS = { position: 'absolute', inset: 0 }

const TOOLBAR = {
  position: 'absolute',
  top: 8,
  right: 8,
  display: 'flex',
  flexWrap: 'wrap',
  justifyContent: 'flex-end',
  maxWidth: 'calc(100% - 16px)',
  gap: 6,
  zIndex: 5,
}

const HINT = {
  position: 'absolute',
  left: 10,
  top: 10,
  zIndex: 2,
  maxWidth: '38%',
  padding: '2px 6px',
  borderRadius: 6,
  color: LABEL_DIM,
  background: SURFACE,
  pointerEvents: 'none',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const STATS = {
  position: 'absolute',
  left: 10,
  bottom: 10,
  zIndex: 2,
  padding: '3px 8px',
  borderRadius: 6,
  lineHeight: 1.6,
  color: LABEL_DIM,
  background: SURFACE,
  border: `1px solid ${BORDER}`,
  pointerEvents: 'none',
  whiteSpace: 'pre',
}

const CENTERED = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 24,
  textAlign: 'center',
  zIndex: 3,
}

const NOTICE = {
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: 12,
  zIndex: 3,
  margin: '0 auto',
  maxWidth: '82%',
  textAlign: 'center',
  color: LABEL_DIM,
  pointerEvents: 'none',
}

const PANEL = {
  position: 'absolute',
  left: 10,
  top: 40,
  zIndex: 4,
  width: 340,
  maxWidth: 'calc(100% - 20px)',
  maxHeight: '52%',
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  borderRadius: 8,
  border: '1px solid ' + BORDER,
  background: SURFACE,
  color: LABEL,
  fontSize: 11,
}

const DETAILS = {
  ...PANEL,
  left: 'auto',
  right: 10,
  top: 40,
  width: 360,
  maxWidth: 'calc(50% - 14px)',
  maxHeight: 'calc(100% - 90px)',
  zIndex: 5,
  boxShadow: '0 8px 26px rgba(0, 0, 0, 0.34)',
}

/** Rows the element tree renders at once; a large model names tens of thousands. */
const ROW_LIMIT = 500

/**
 * How long the reader worker survives the last IFC viewport.
 *
 * Its WASM module is tens of megabytes of linear memory, so it must not outlive
 * the preview; but a remount — a resize, a second model in the same seat — would
 * pay the whole instantiation again if it were torn down immediately. A few
 * seconds distinguishes "closed" from "blinking".
 */
const WORKER_IDLE_MS = 8000

const PANEL_HEAD = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 8px',
  borderBottom: '1px solid ' + BORDER,
  color: LABEL_DIM,
}

const FILTER = {
  margin: '6px 8px 4px',
  padding: '3px 7px',
  borderRadius: 6,
  border: '1px solid ' + BORDER,
  background: BASE,
  color: LABEL,
  font: 'inherit',
  fontSize: 11,
}

const LIST = { flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: '0 4px 6px' }

const ICON = { flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 12, height: 12 }
const ROW_LABEL = { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }
const FOLDER_INK = { opacity: 0.75 }

const SECTION = { margin: '8px 8px 2px', color: LABEL_DIM, textTransform: 'uppercase', letterSpacing: '0.06em', fontSize: 10 }
const NOTE = { padding: '4px 8px', color: LABEL_DIM, lineHeight: 1.6 }
const FAILED = { ...NOTE, color: ERROR }
const PATH_BOX = {
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

/**
 * The button look the toolbar uses, so a toggled control reads without a class.
 * @param active - whether this control is currently on.
 * @returns the inline style.
 */
function buttonStyle(active) {
  return {
    padding: '3px 9px',
    borderRadius: 6,
    border: `1px solid ${active ? ACCENT : BORDER}`,
    background: SURFACE,
    color: active ? ACCENT : LABEL,
    font: 'inherit',
    fontSize: 11,
    cursor: 'pointer',
  }
}

/**
 * One tree row's style: a fixed caret gutter, then indentation for the depth.
 * @param active - whether this row is the picked or copied path.
 * @param depth - indentation level.
 * @returns the inline style.
 */
function rowStyle(active, depth = 0) {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 3,
    width: '100%',
    // The indentation is the hierarchy: the caret column is fixed so a folder and
    // its leaf children line up, and the depth is what gives the tree its shape.
    padding: '2px 6px 2px ' + (4 + depth * 13) + 'px',
    borderRadius: 5,
    background: active ? ACCENT_WASH : 'transparent',
    color: active ? ACCENT : LABEL,
    fontSize: 11,
    fontFamily: MONO,
    whiteSpace: 'nowrap',
  }
}

/**
 * Format one measured length without inventing a unit the model may not use.
 * @param value - a length in scene units (metres: web-ifc converts on the way in).
 * @returns a compact fixed-point string.
 */
function length(value) {
  if (!Number.isFinite(value)) return '—'
  if (value === 0) return '0'
  const magnitude = Math.abs(value)
  if (magnitude >= 1000 || magnitude < 0.01) return value.toExponential(2)
  return value.toFixed(magnitude >= 10 ? 1 : 3)
}

/**
 * The IFC model viewport.
 * @param props - the document body's standard props.
 * @param props.content - `{ kind: 'bytes', data }` with the complete file.
 * @param props.resourceAddress - the address the file was opened by.
 * @param props.t - the dictionary lookup, when the seat provided one.
 * @returns the viewport, or the loading/failure state that replaces it.
 */
export function IfcBody(props) {
  const { content, resourceAddress } = props
  const t = props.t
  const data = content !== undefined && content.kind === 'bytes' ? content.data : undefined
  const name = resourceAddress === undefined ? undefined : usdFileName(resourceAddress)
  const shellRef = useRef(null)
  const containerRef = useRef(null)
  const viewRef = useRef(null)
  const [parsed, setParsed] = useState(null)
  const [failure, setFailure] = useState(null)
  const [showGrid, setShowGrid] = useState(true)
  const [spin, setSpin] = useState(false)
  const [wireframe, setWireframe] = useState(false)
  const [elementsOpen, setElementsOpen] = useState(false)
  const [elementFilter, setElementFilter] = useState('')
  const [collapsedFolders, setCollapsedFolders] = useState(() => new Set())
  const [picked, setPicked] = useState(null)
  const [copiedPath, setCopiedPath] = useState(null)
  const [detailsOpen, setDetailsOpen] = useState(false)

  /**
   * Dictionary lookup with a literal fallback: copy must never be the reason a
   * viewport fails to render.
   */
  const label = useCallback((key, fallback) => {
    if (typeof t !== 'function') return fallback
    try {
      const value = t(key)
      return value === undefined || value === null || value === key ? fallback : value
    } catch {
      return fallback
    }
  }, [t])

  // ── read the model ────────────────────────────────────────────────────────
  useEffect(() => {
    if (data === undefined) {
      setParsed(null)
      // An `.ifc` is a STEP text file, so this definition deliberately does not
      // declare it binary — but the reader needs complete bytes, and the seat can
      // only guarantee them when it honoured `loading: 'bytes-complete'`. A text
      // read therefore means the shell gave us something this preview cannot use,
      // and saying so beats a blank panel.
      setFailure(content !== undefined && content.kind !== 'bytes'
        ? 'this IFC model was opened as text; the preview needs the complete file bytes'
        : null)
      return undefined
    }
    let cancelled = false
    const controller = new AbortController()
    setParsed(null)
    setFailure(null)
    setPicked(null)
    // One macrotask, so the status line paints before the worker starts a parse
    // that will keep the page's message queue busy for a while.
    const timer = setTimeout(async () => {
      try {
        const result = await loadIfc({ bytes: data })
        if (cancelled === true) {
          result.dispose()
          return
        }
        setParsed(result)
      } catch (error) {
        if (cancelled === true) return
        setFailure(error instanceof Error ? error.message : String(error))
      }
    }, 0)
    return () => {
      cancelled = true
      controller.abort()
      clearTimeout(timer)
    }
  }, [data, content])

  // ── the viewport ──────────────────────────────────────────────────────────
  useEffect(() => {
    const container = containerRef.current
    if (parsed === null || container === null) return undefined
    let view
    try {
      view = createView(container, parsed.object)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
      return undefined
    }
    viewRef.current = view
    const stopPick = view.onPick((hits) => {
      const hit = hits[0]
      view.setSelection(hit)
      const object = hit?.object
      const path = typeof object?.name === 'string' && object.name.startsWith('/') ? object.name : null
      setPicked(path)
    })
    return () => {
      stopPick()
      viewRef.current = null
      view.destroy()
    }
  }, [parsed])

  const clearSelection = useCallback(() => {
    viewRef.current?.clearSelection()
    setPicked(null)
  }, [])

  // Escape clears the selection, unless the key belongs to a text field or an IME.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const onKeyDown = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented === true || event.isComposing === true) return
      const target = event.target
      const tag = typeof target?.tagName === 'string' ? target.tagName.toLowerCase() : ''
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable === true) return
      clearSelection()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [clearSelection])

  // The model is released with its viewport, whether or not one was ever built.
  // The worker's WASM module is released too, but only after a grace period: a
  // tab that is being remounted (a resize, a second file in the same seat) would
  // otherwise pay the whole instantiation cost again, and that cost is a 1.6 MiB
  // binary plus its start-up. A short delay tells "closed" from "blinking".
  useEffect(() => () => {
    parsed?.dispose?.()
    const timer = setTimeout(() => { stopIfcWorker() }, WORKER_IDLE_MS)
    return () => clearTimeout(timer)
  }, [parsed])

  useEffect(() => { viewRef.current?.setGridVisible(showGrid) }, [showGrid, parsed])
  useEffect(() => { viewRef.current?.setSpin(spin) }, [spin, parsed])
  useEffect(() => { viewRef.current?.setWireframe(wireframe) }, [wireframe, parsed])

  const reset = useCallback(() => { viewRef.current?.reset() }, [])

  // ── the element tree ──────────────────────────────────────────────────────
  const elementPaths = useMemo(() => (parsed === null ? [] : parsed.rows.map(row => row.path)), [parsed])
  const tree = useMemo(() => buildPrimTree(elementPaths), [elementPaths])
  const nodeCount = useMemo(() => countPrimNodes(tree), [tree])
  const filtered = useMemo(() => filterPrimTree(tree, elementFilter), [tree, elementFilter])
  const expandedFolders = useMemo(() => {
    if (filtered.active === true) return allFolderPaths(filtered.tree)
    const all = allFolderPaths(tree)
    for (const path of collapsedFolders) all.delete(path)
    return all
  }, [filtered.active, filtered.tree, tree, collapsedFolders])
  const rows = useMemo(
    () => flattenPrimTree(filtered.tree, expandedFolders, { limit: ROW_LIMIT, forcedOpen: filtered.active }),
    [filtered.tree, expandedFolders, filtered.active],
  )
  const shownCount = useMemo(() => countPrimNodes(filtered.tree), [filtered.tree])

  const toggleFolder = useCallback((path) => {
    setCollapsedFolders((current) => {
      const next = new Set(current)
      if (next.has(path) === true) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  // A click on the model reveals its row by opening every folder on the way down.
  useEffect(() => {
    if (picked === null) return
    const ancestors = ancestorsOf(picked)
    if (ancestors.length === 0) return
    setCollapsedFolders((current) => {
      const next = new Set(current)
      let changed = false
      for (const path of ancestors) {
        if (next.delete(path) === true) changed = true
      }
      return changed === true ? next : current
    })
  }, [picked])

  const copyPath = useCallback(async (path) => {
    try {
      await navigator.clipboard.writeText(path)
      setCopiedPath(path)
      window.setTimeout(() => setCopiedPath((current) => (current === path ? null : current)), 1500)
    } catch {
      setCopiedPath(null)
    }
  }, [])

  const selectFromTree = useCallback((path) => {
    setPicked(path)
    // A tree row is a name, not a surface: there is nothing to tint, and a tint
    // left over from an earlier click would point at a different element.
    viewRef.current?.clearSelection()
  }, [])

  // The details reader: a path in, the model's record for that element out. The
  // lookup lives here because the rows are this component's, and the panel is
  // handed a reader rather than a model so it stays testable on its own.
  const detailsReader = useMemo(() => {
    if (parsed === null) return undefined
    return async (path) => {
      const row = parsed.rows.find(entry => entry.path === path)
      if (row === undefined) return undefined
      return await parsed.describe(row.expressID)
    }
  }, [parsed])

  const notices = []
  if (parsed !== null && parsed.stats.meshes === 0) {
    // A property-only exchange is a legitimate IFC file with no representations at
    // all; saying so is the difference between "this model has no geometry" and
    // "the preview lost it".
    notices.push(label('ifcNoGeometry', 'This model carries no drawable geometry — a property-only exchange is common.'))
  } else if (parsed !== null && parsed.stats.degenerate) {
    // Geometry that came through but measures as nothing: a flat or empty extent
    // means every triangle is degenerate, which a reader should know rather than
    // see as a blank viewport.
    notices.push(label('degenerate', 'The geometry has a degenerate extent — an empty stage, or metadata only.'))
  }

  const unitLabel = parsed?.unit === undefined
    ? ''
    : ifcLengthUnitLabel(parsed.unit.prefix, parsed.unit.name)
  const stats = parsed === null ? undefined : [
    `${label('format', 'Container')}: ${parsed.format}`,
    `${label('ifcSchema', 'Schema')}: ${parsed.schema ?? '—'}`,
    `${label('elements', 'Elements')}: ${parsed.rows.length}`,
    `${label('meshes', 'Meshes')}: ${parsed.stats.meshes}`,
    `${label('triangles', 'Triangles')}: ${parsed.stats.triangles}`,
    `${label('size', 'Size')}: ${length(parsed.stats.size.x)} × ${length(parsed.stats.size.y)} × ${length(parsed.stats.size.z)}`,
    ...(ifcUnitDescription(unitLabel) === '' ? [] : [`${label('ifcUnit', 'Authored in')}: ${unitLabel}`]),
  ].join('\n')

  return (
    <div
      ref={shellRef}
      style={SHELL}
      tabIndex={-1}
      data-usd-preview
      data-ifc-preview
      data-usd-engine="web-ifc"
      data-usd-pickable={parsed === null ? '0' : '1'}
      data-usd-selected={picked ?? ''}
      data-ifc-schema={parsed?.schema ?? ''}
      data-ifc-elements={parsed === null ? 0 : parsed.rows.length}
      onPointerDown={(event) => {
        const target = event.target
        const tag = typeof target?.tagName === 'string' ? target.tagName.toLowerCase() : ''
        if (tag === 'input' || tag === 'textarea' || tag === 'button' || tag === 'a' || target?.isContentEditable === true) return
        shellRef.current?.focus({ preventScroll: true })
      }}
    >
      <div ref={containerRef} style={CANVAS} data-usd-preview-stage />
      {failure !== null && (
        <div style={CENTERED} role="alert">
          <div>
            <div style={{ color: ERROR, fontWeight: 600 }}>{label('ifcFailed', 'This IFC file could not be read.')}</div>
            <div style={{ marginTop: 6, color: LABEL_DIM, wordBreak: 'break-word' }}>{failure}</div>
          </div>
        </div>
      )}
      {failure === null && parsed === null && (
        <div style={CENTERED} role="status">
          <span style={{ color: LABEL_DIM }}>{label('ifcLoading', 'Reading the IFC model…')}</span>
        </div>
      )}
      {parsed !== null && (
        <>
          <div style={TOOLBAR}>
            <button type="button" style={buttonStyle(false)} onClick={reset} data-usd-reset>
              {label('reset', 'Reset view')}
            </button>
            <button type="button" style={buttonStyle(showGrid)} onClick={() => { setShowGrid((value) => !value) }}>
              {label('grid', 'Grid')}
            </button>
            <button type="button" style={buttonStyle(spin)} onClick={() => { setSpin((value) => !value) }}>
              {label('spin', 'Auto-rotate')}
            </button>
            <button type="button" style={buttonStyle(wireframe)} onClick={() => { setWireframe((value) => !value) }}>
              {label('wireframe', 'Wireframe')}
            </button>
            <button
              type="button"
              style={buttonStyle(elementsOpen)}
              data-usd-prims-toggle
              data-ifc-elements-toggle
              title={label('ifcElementsHint', 'Show the spatial structure this model carries')}
              onClick={() => { setElementsOpen((value) => !value) }}
            >
              {label('ifcElements', 'Elements')} · {nodeCount}
            </button>
            <button
              type="button"
              style={buttonStyle(detailsOpen)}
              data-usd-details-toggle
              data-ifc-details-toggle
              title={label('ifcDetailsHint', 'Show what the model declares about the selected element')}
              onClick={() => (detailsOpen === true ? setDetailsOpen(false) : setDetailsOpen(true))}
            >
              {label('details', 'Details')}
            </button>
          </div>
          {!elementsOpen && (
            <div style={HINT}>
              {label('help', 'Drag to orbit · wheel to zoom · right-drag to pan')}
              {name === undefined ? '' : <div style={{ marginTop: 2 }} data-ifc-name>{name}</div>}
              {picked === null ? '' : (
                <div style={{ marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }} data-usd-picked>
                  <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {label('picked', 'Picked')}: <span style={{ fontFamily: MONO }}>{picked}</span>
                  </span>
                  <button
                    type="button"
                    data-usd-picked-clear
                    title={label('clearSelection', 'Clear the selection (Esc)')}
                    aria-label={label('clearSelection', 'Clear the selection (Esc)')}
                    onClick={clearSelection}
                    style={{
                      flex: '0 0 auto',
                      padding: '0 4px',
                      borderRadius: 4,
                      border: `1px solid ${BORDER}`,
                      background: 'transparent',
                      color: LABEL_DIM,
                      font: 'inherit',
                      fontSize: 11,
                      lineHeight: 1.4,
                      cursor: 'pointer',
                      pointerEvents: 'auto',
                    }}
                  >
                    ×
                  </button>
                </div>
              )}
            </div>
          )}
          {elementsOpen && (
            <div style={PANEL} data-usd-prims data-ifc-element-tree>
              <div style={PANEL_HEAD}>
                <span style={{ flex: '1 1 auto' }}>
                  {label('ifcElements', 'Elements')} · {shownCount}/{nodeCount}
                </span>
                <span style={{ opacity: 0.7 }}>{label('primsClick', 'click to copy')}</span>
              </div>
              <input
                type="text"
                value={elementFilter}
                spellCheck={false}
                onChange={(event) => setElementFilter(event.target.value)}
                placeholder={label('ifcFilter', 'Filter elements…')}
                style={FILTER}
                aria-label={label('ifcFilter', 'Filter elements')}
              />
              <div style={LIST}>
                {rows.rows.length === 0
                  ? <div style={{ padding: '2px 6px', color: LABEL_DIM }}>{label('primsEmpty', 'No elements in this model')}</div>
                  : rows.rows.map(({ node, depth }) => {
                    const folder = node.children.size > 0
                    const open = expandedFolders.has(node.path) === true
                    const active = picked === node.path || copiedPath === node.path
                    return (
                      <div key={node.path} style={rowStyle(active, depth)} data-usd-prim-row data-ifc-element-row data-usd-prim-path={node.path} data-usd-prim-folder={folder === true ? '1' : undefined} data-depth={depth}>
                        {/* The caret is its own control. A row can be both a folder and
                            an element — a wall with an opening cut through it has
                            children *and* geometry — so folding and selecting have to
                            be two separate clicks, or one of them becomes unreachable. */}
                        <button
                          type="button"
                          data-ifc-row-caret
                          aria-label={open ? 'collapse' : 'expand'}
                          aria-expanded={folder === true ? open : undefined}
                          onClick={() => { if (folder === true) toggleFolder(node.path) }}
                          style={{
                            flex: '0 0 auto',
                            width: 14,
                            height: 14,
                            padding: 0,
                            border: 'none',
                            background: 'transparent',
                            color: 'inherit',
                            cursor: folder === true ? 'pointer' : 'default',
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          {folder === true ? <TreeChevron open={filtered.active === true || open} /> : null}
                        </button>
                        <span style={ICON}>
                          {folder === true
                            ? <span style={FOLDER_INK}><TreeFolder open={filtered.active === true || open} /></span>
                            : <TreePrim />}
                        </span>
                        <button
                          type="button"
                          data-ifc-row-label
                          style={{
                            flex: '1 1 auto',
                            minWidth: 0,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            padding: 0,
                            border: 'none',
                            background: 'transparent',
                            color: 'inherit',
                            font: 'inherit',
                            textAlign: 'left',
                            cursor: 'pointer',
                            whiteSpace: 'nowrap',
                          }}
                          title={node.path}
                          onClick={() => {
                            selectFromTree(node.path)
                            void copyPath(node.path)
                          }}
                        >
                          {copiedPath === node.path ? '✓ ' : ''}{node.name}
                        </button>
                      </div>
                    )
                  })}
                {rows.truncated && (
                  <div style={{ padding: '2px 6px', color: LABEL_DIM }}>
                    {label('primsLimited', 'list clipped to the first')} {ROW_LIMIT} / {rows.total}
                  </div>
                )}
              </div>
            </div>
          )}
          {detailsOpen && (
            <IfcDetailsPanel
              path={picked}
              read={detailsReader}
              onClose={() => setDetailsOpen(false)}
              label={label}
            />
          )}
          {stats !== undefined && <div style={STATS} data-usd-stats data-ifc-stats>{stats}</div>}
        </>
      )}
      {notices.map(text => <div key={text} style={NOTICE}>{text}</div>)}
    </div>
  )
}

/**
 * What the model declares about one element.
 *
 * The counterpart of `PrimDetailsPanel`, and different in the way the two formats
 * differ: a USD prim is read from the layers that composed it, while an IFC
 * element is a line in one STEP file with property sets attached to it by a
 * relation. The reader is injected, so the panel is testable without a model.
 * @param props.path - the element path to describe, or null for nothing selected.
 * @param props.read - reads one element's record.
 * @param props.onClose - closes the panel.
 * @param props.label - the dictionary lookup.
 * @returns the panel.
 */
function IfcDetailsPanel({ path, read, onClose, label }) {
  const [state, setState] = useState({ status: 'idle', element: undefined, error: '' })

  useEffect(() => {
    if (path === null || path === undefined || typeof read !== 'function') {
      setState({ status: 'idle', element: undefined, error: '' })
      return undefined
    }
    let cancelled = false
    setState({ status: 'loading', element: undefined, error: '' })
    Promise.resolve()
      .then(() => read(path))
      .then((element) => {
        if (cancelled === true) return
        setState({ status: element === undefined ? 'missing' : 'ready', element, error: '' })
      }, (error) => {
        if (cancelled === true) return
        setState({ status: 'failed', element: undefined, error: error instanceof Error ? error.message : String(error) })
      })
    return () => { cancelled = true }
  }, [path, read])

  const element = state.element
  return (
    <div style={DETAILS} data-usd-details data-ifc-details>
      <div style={PANEL_HEAD}>
        <span style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label('ifcElementDetails', 'Element details')}
        </span>
        <button
          type="button"
          data-usd-details-close
          onClick={onClose}
          aria-label={label('closeDetails', 'Close the details panel')}
          style={{
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
          }}
        >
          ×
        </button>
      </div>
      <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: '4px 0 8px' }}>
        {path === null || path === undefined ? (
          <div style={NOTE}>{label('ifcDetailsEmpty', 'Click an element in the viewport and this panel lists what the model declares about it.')}</div>
        ) : state.status === 'failed' ? (
          <div style={FAILED}>{label('ifcDetailsFailed', 'The element could not be read')}: {state.error}</div>
        ) : state.status === 'missing' ? (
          <div style={NOTE}>{label('ifcDetailsMissing', 'The model does not describe that element.')}</div>
        ) : state.status !== 'ready' || element === undefined ? (
          // 'idle' is the state on the render before the effect has run, so it has
          // to be treated as loading — falling through to the table would read a
          // property of an element that has not been fetched yet.
          <div style={NOTE}>{label('detailsLoading', 'Reading the layers…')}</div>
        ) : (
          <>
            <div style={PATH_BOX} title={path}>{path}</div>
            <Row label={label('detailType', 'Type')}>{ifcTypeLabel(element.type) === '' ? '—' : ifcTypeLabel(element.type)}</Row>
            <Row label={label('ifcGlobalId', 'GlobalId')}>{element.globalId === '' ? '—' : element.globalId}</Row>
            {element.objectType === '' ? null : <Row label={label('ifcObjectType', 'Object type')}>{element.objectType}</Row>}
            {element.predefinedType === '' ? null : <Row label={label('ifcPredefinedType', 'Predefined')}>{element.predefinedType}</Row>}
            {element.tag === '' ? null : <Row label={label('ifcTag', 'Tag')}>{element.tag}</Row>}
            {element.description === '' ? null : <Row label={label('ifcDescription', 'Description')}>{element.description}</Row>}
            {(element.properties ?? []).map(set => (
              <div key={set.name}>
                <div style={SECTION} data-ifc-property-set={set.name}>{set.name} · {set.properties.length}</div>
                {set.properties.map(property => (
                  <div
                    key={property.name}
                    data-ifc-property={property.name}
                    style={{ display: 'grid', gridTemplateColumns: '76px minmax(0, 1fr)', gap: 6, padding: '2px 8px', alignItems: 'baseline' }}
                  >
                    <span style={{ color: LABEL_DIM, fontFamily: MONO, overflow: 'hidden', textOverflow: 'ellipsis' }} title={property.type}>
                      {property.type.replace(/^Ifc/, '')}
                    </span>
                    <span style={{ color: LABEL, fontFamily: MONO, wordBreak: 'break-all' }}>
                      {property.name}
                      <span style={{ color: LABEL_DIM, paddingLeft: 6 }} data-ifc-property-value>
                        {property.value === '' ? '—' : property.value}
                      </span>
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * One labeled row of element metadata.
 * @param props.label - the row's key.
 * @param props.children - the value, already formatted.
 * @returns the row.
 */
function Row({ label, children }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '92px minmax(0, 1fr)', gap: 6, padding: '1px 8px', alignItems: 'baseline' }}>
      <span style={{ color: LABEL_DIM, overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}</span>
      <span style={{ minWidth: 0, wordBreak: 'break-word', fontFamily: MONO }}>{children}</span>
    </div>
  )
}
