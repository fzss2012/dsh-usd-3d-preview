/**
 * The viewport for one USD file, mounted as the keyed
 * `sidebar.right.tab.document` body of `dsh-usd-3d-preview/usd`.
 *
 * Everything is native: the bytes three parses are the bytes the sidebar
 * delivered, and any layer the file references is read back through the
 * workspace Remote and assembled in the same pass. There is no converter
 * process, no upload, and no second toolchain to install.
 *
 * three.js is a rendering dependency, not a state dependency: the assembled
 * graph lives in component state, everything mutable about the camera and the
 * renderer lives in a `View` object the effect owns and destroys. The body
 * declines to claim the shared scrollport (`scrollportRef`): an orbit canvas has
 * nothing to scroll, and claiming it would suppress the document body's own
 * scrollbar binding.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createArticulationController } from './kinematics.js'
import { assemble, disposeObject } from './parse.js'
import { absoluteFilePath, assetUriOf, parseFileReference, siblingPath, usdFileName } from './usd.js'
import { createView } from './view.js'

const LABEL = 'var(--dsw-alias-label-primary, #e6e8ec)'
const LABEL_DIM = 'var(--dsw-alias-label-secondary, #a9b0bd)'
const ACCENT = 'var(--dsw-alias-brand-primary, #4d8dff)'
const BORDER = 'var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.14))'
const SURFACE = 'var(--dsw-alias-bg-overlay, rgba(24, 26, 32, 0.86))'
const ERROR = 'var(--dsw-alias-state-error-primary, #ff6b6b)'

const SHELL = {
  position: 'absolute',
  inset: 0,
  overflow: 'hidden',
  background: 'var(--dsw-alias-bg-base, #14161a)',
  color: LABEL,
  fontFamily: 'var(--dsw-font-ui, system-ui, sans-serif)',
  fontSize: 12,
}

const CANVAS = { position: 'absolute', inset: 0 }

const TOOLBAR = {
  position: 'absolute',
  top: 8,
  right: 8,
  display: 'flex',
  gap: 6,
  zIndex: 2,
}

const HINT = {
  position: 'absolute',
  left: 10,
  top: 10,
  zIndex: 2,
  padding: '2px 6px',
  borderRadius: 6,
  color: LABEL_DIM,
  background: SURFACE,
  pointerEvents: 'none',
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

const WARNINGS = {
  position: 'absolute',
  right: 10,
  bottom: 10,
  zIndex: 2,
  maxWidth: '46%',
  maxHeight: '38%',
  padding: '3px 8px',
  borderRadius: 6,
  lineHeight: 1.6,
  color: LABEL_DIM,
  background: SURFACE,
  border: `1px solid ${BORDER}`,
  pointerEvents: 'auto',
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
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

/** The button's resting and toggled looks, so the switch reads without a class. */
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
 * Format one measured length without pretending to a unit the file may not use.
 * @param value - a length in scene units (USD meters unless the stage says otherwise).
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
 * Present one USD file as an interactive 3D viewport.
 *
 * Two sources reach the same viewport: the document body's standard props
 * (complete workspace bytes plus the injected reader for referenced layers), and
 * a dropped external stage (`droppedFiles` + `droppedRootKey`), whose bytes never
 * entered the workspace. Both assemble through the same WASM engine; only the
 * place the referenced layers come from differs.
 * @param props - the document body's standard props, or the dropped-stage pair.
 * @param props.droppedFiles - dropped files keyed by package-relative path.
 * @param props.droppedRootKey - the key of the dropped stage to open.
 * @returns the viewport, or the loading/failure state that replaces it.
 */
export function UsdBody(props) {
  const { content, resourceAddress, droppedFiles, droppedRootKey } = props
  const t = props.t
  const data = content !== undefined && content.kind === 'bytes' ? content.data : undefined
  const name = usdFileName(resourceAddress)
  const containerRef = useRef(null)
  const viewRef = useRef(null)
  // The reader is registration-scoped, not render-scoped: keeping it in a ref
  // stops a new function identity from re-assembling the file on every render.
  const readerRef = useRef(props.readLayer)
  readerRef.current = props.readLayer
  // The asset reader is what makes `s3://` references resolvable: the engine
  // names such a layer, the injected reader fetches it, the engine composes.
  const assetReaderRef = useRef(props.readAsset)
  assetReaderRef.current = props.readAsset
  const [parsed, setParsed] = useState(null)
  const [failure, setFailure] = useState(null)
  const [showGrid, setShowGrid] = useState(true)
  const [spin, setSpin] = useState(false)
  const [wireframe, setWireframe] = useState(false)
  // Which end of its travel the parts were last asked to reach: the controller
  // owns the animation, this only decides which word the button shows.
  const [partsOpen, setPartsOpen] = useState(false)
  const [colliders, setColliders] = useState(false)

  /**
   * Dictionary lookup with a literal fallback: copy must never be the reason a
   * viewport fails to render, so a missing namespace degrades to the English
   * default rather than to a bare key.
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

  useEffect(() => {
    if (data === undefined && droppedFiles === undefined) {
      setParsed(null)
      setFailure(null)
      return undefined
    }
    let cancelled = false
    const controller = new AbortController()
    setParsed(null)
    setFailure(null)
    // One macrotask, so the status line paints before a large layer blocks the thread.
    const timer = setTimeout(async () => {
      try {
        // A dropped stage is opened by bytes: the page holds every file, so the
        // engine composes from the drop's own map and no read is performed.
        if (droppedFiles !== undefined) {
          const rootKey = droppedRootKey ?? [...droppedFiles.keys()][0]
          const rootBlob = rootKey === undefined ? undefined : droppedFiles.get(rootKey)
          if (rootKey === undefined || rootBlob === undefined || rootBlob === null) {
            throw new Error('the dropped asset has no root layer')
          }
          const result = await assemble({
            rootKey,
            rootBytes: new Uint8Array(await rootBlob.arrayBuffer()),
            files: droppedFiles,
            signal: controller.signal,
          })
          if (cancelled) {
            if (result.dispose !== undefined) result.dispose()
            else disposeObject(result.object)
            return
          }
          setParsed(result)
          return
        }
        // A layer reaches its siblings by name; only the session it belongs to
        // knows where that name lives, and the address carries the session.
        const reference = parseFileReference(resourceAddress)
        // An `absolute` address has no Session to read siblings through, but it
        // still names a complete file the Host handed over. Composing that file
        // through the engine keeps PointInstancers and `s3://` payloads, which
        // three's fallback cannot draw; unresolved siblings become warnings.
        const absolutePath = absoluteFilePath(resourceAddress)
        const rootKey = reference?.path ?? absolutePath
        const readWorkspace = reference === undefined || readerRef.current === undefined
          ? async () => undefined
          : (path, signal) => readerRef.current(reference.sessionId, path, signal)
        // One reader for the engine: `s3://` keys are asset reads through the
        // injected callback, everything else is a workspace file. The engine
        // reports both kinds in the same "layer-missing" list, so they need one
        // door.
        const readFile = async (path, signal) => {
          const asset = assetUriOf(path)
          if (asset !== undefined && assetReaderRef.current !== undefined) {
            return assetReaderRef.current(asset.uri, signal)
          }
          return readWorkspace(path, signal)
        }
        // The engine resolves references against the opened file's own path, so
        // it is handed workspace paths; the three fallback keeps the older
        // "relative to the opened file's directory" reader.
        const readSibling = reference === undefined
          ? async () => undefined
          : (relative, signal) => readWorkspace(siblingPath(reference.path, relative), signal)
        const result = await assemble({
          rootKey,
          rootBytes: data,
          read: readFile,
          readSibling,
          // The engine localizes `s3://` references into its file package; this is
          // the read callback that fills them in.
          readAsset: assetReaderRef.current,
          signal: controller.signal,
        })
        if (cancelled) {
          if (result.dispose !== undefined) result.dispose()
          else disposeObject(result.object)
          return
        }
        // Bound before the view exists, so the first frame already shows the
        // bodies in their rest pose instead of re-parenting them a frame later.
        // A stage that declares parts but cannot be bound still previews: the
        // geometry is the file, the articulation is an extra.
        if (result.articulation !== undefined) {
          try {
            result.parts = createArticulationController(result.object, result.articulation)
          } catch (error) {
            result.articulationError = error instanceof Error ? error.message : String(error)
          }
        }
        setParsed(result)
      } catch (error) {
        if (cancelled) return
        setFailure(error instanceof Error ? error.message : String(error))
      }
    }, 0)
    return () => {
      cancelled = true
      controller.abort()
      clearTimeout(timer)
    }
  }, [data, resourceAddress, droppedFiles, droppedRootKey])

  useEffect(() => {
    const container = containerRef.current
    if (parsed === null || container === null) return undefined
    let view
    try {
      // An articulated stage is framed to cover the poses its joints reach, so
      // "Open all" cannot swing a part out of the viewport; a static stage passes
      // nothing and is framed by its own extent.
      view = createView(container, parsed.object, { frame: parsed.parts?.extremeBounds?.() })
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
      return undefined
    }
    viewRef.current = view
    // The view knows nothing about joints and the controller knows nothing about
    // rendering: each is connected here, by the half that owns both.
    const parts = parsed.parts
    // The tick answers "do you need another frame?", which is what keeps an
    // idle articulated asset idle instead of rendering forever.
    const stopFrame = parts === undefined
      ? undefined
      : view.onFrame(deltaMs => parts.tick(deltaMs) === true)
    const stopPick = parts === undefined
      ? undefined
      : view.onPick((hits) => { if (parts.pick(hits) === true) view.requestRender() })
    return () => {
      stopFrame?.()
      stopPick?.()
      viewRef.current = null
      view.destroy()
    }
  }, [parsed])

  // The graph is released with its viewport, whether or not one was ever built.
  useEffect(() => () => {
    if (parsed === null) return
    // Bodies first: the controller put meshes under groups it owns, and it must
    // take them back out before the geometry they share is freed.
    try {
      parsed.parts?.dispose?.()
    } catch {
      // A controller that cannot unwind must not keep the geometry alive too.
    }
    // The engine owns its textures as well as its geometry, so prefer its release.
    if (parsed.dispose !== undefined) parsed.dispose()
    else disposeObject(parsed.object)
  }, [parsed])

  useEffect(() => {
    const view = viewRef.current
    if (view !== null) view.setGridVisible(showGrid)
  }, [showGrid, parsed])
  useEffect(() => {
    viewRef.current?.setSpin(spin)
  }, [spin, parsed])
  useEffect(() => {
    viewRef.current?.setWireframe(wireframe)
  }, [wireframe, parsed])

  const reset = useCallback(() => { viewRef.current?.reset() }, [])

  const notices = []
  if (parsed !== null && parsed.stats.meshes === 0 && parsed.stats.points === 0) {
    // A crate that assembles to nothing is almost always a composition-only
    // layer, and the useful thing to say is why and what to open instead.
    notices.push(parsed.format === 'usdc'
      ? label('crateOnly', 'This crate layer carries no geometry of its own')
      : label('noGeometry', 'This USD file has no drawable geometry.'))
  }
  if (parsed !== null && parsed.stats.degenerate) {
    notices.push(label('degenerate', 'The geometry has a degenerate extent — an empty stage, or metadata only.'))
  }
  // Engine warnings are the honest "what could not be shown faithfully" list:
  // a missing layer, an unsupported prim, a material that fell back to grey.
  const engineWarnings = parsed?.warnings ?? []
  if (parsed?.engine === 'three' && parsed.engineError !== undefined) {
    const fallback = label('engineFallback', 'The WASM engine was unavailable; fell back to the three.js parser:')
    notices.push(`${fallback} ${parsed.engineError}`)
  }
  // A stage may declare moving parts the reader could not reconstruct. Saying so
  // is the difference between "static asset" and "we lost its kinematics".
  if (parsed?.articulationError !== undefined) {
    notices.push(`${label('articulationFailed', 'The moving parts could not be read')}: ${parsed.articulationError}`)
  }
  // The reader and the controller both report approximations (assumed limits,
  // unsupported joint kinds, ambiguous composed paths, static instance batches).
  // Dropping them would make a guessed pose look authored.
  const partWarnings = [...(parsed?.articulation?.warnings ?? []), ...(parsed?.parts?.warnings ?? [])]
  if (partWarnings.length > 0) {
    const heading = label('partWarnings', 'Moving parts')
    const shown = partWarnings.slice(0, 4).join('; ')
    const more = partWarnings.length > 4 ? ` (+${partWarnings.length - 4})` : ''
    notices.push(`${heading}: ${shown}${more}`)
  }

  const stats = parsed === null ? undefined : [
    `${label('format', 'Container')}: ${parsed.format}`,
    `${label('engine', 'Engine')}: ${parsed.engine === 'wasm' ? 'OpenUSD (WASM)' : 'three.js'}`,
    `${label('layers', 'Layers')}: ${parsed.layers}`,
    `${label('meshes', 'Meshes')}: ${parsed.stats.meshes}`,
    `${label('triangles', 'Triangles')}: ${parsed.stats.triangles}`,
    ...(parsed.stats.instances > 0 ? [`${label('instances', 'Instances')}: ${parsed.stats.instances}`] : []),
    `${label('size', 'Size')}: ${length(parsed.stats.size.x)} × ${length(parsed.stats.size.y)} × ${length(parsed.stats.size.z)}`,
    ...(engineWarnings.length === 0 ? [] : [`${label('warnings', 'Warnings')}: ${engineWarnings.length}`]),
  ].join('\n')

  // The articulated structure, when the stage declared one. A static stage has no
  // joints, so no control below may claim anything about parts.
  const parts = parsed?.parts ?? undefined
  const partsHint = parts === undefined
    ? undefined
    : `${parts.movingParts} ${label('movingParts', 'Moving parts')} · ${label('pickPart', 'Click a part to open or close it')}`

  return (
    <div
      style={SHELL}
      data-usd-preview
      data-usd-engine={parsed?.engine ?? ''}
      data-usd-engine-error={parsed?.engineError ?? ''}
      data-usd-parts={parts === undefined ? 0 : parts.movingParts}
      data-usd-colliders={parts?.hasColliders === true ? '1' : '0'}
    >
      <div ref={containerRef} style={CANVAS} data-usd-preview-stage />
      {failure !== null && (
        <div style={CENTERED} role="alert">
          <div>
            <div style={{ color: ERROR, fontWeight: 600 }}>{label('failed', 'This USD file could not be parsed.')}</div>
            <div style={{ marginTop: 6, color: LABEL_DIM, wordBreak: 'break-word' }}>{failure}</div>
          </div>
        </div>
      )}
      {failure === null && parsed === null && (
        <div style={CENTERED} role="status">
          <span style={{ color: LABEL_DIM }}>{label('loading', 'Parsing the USD file…')}</span>
        </div>
      )}
      {parsed !== null && (
        <>
          <div style={TOOLBAR}>
            {parts !== undefined && parts.movingParts > 0 && (
              <button
                type="button"
                style={buttonStyle(partsOpen)}
                data-usd-parts-toggle
                onClick={() => {
                  const open = !partsOpen
                  setPartsOpen(open)
                  parts.setAll(open)
                  viewRef.current?.requestRender()
                }}
              >
                {partsOpen ? label('closeAll', 'Close all') : label('openAll', 'Open all')}
              </button>
            )}
            {parts !== undefined && parts.movingParts > 0 && (
              <button
                type="button"
                style={buttonStyle(false)}
                data-usd-parts-home
                onClick={() => {
                  setPartsOpen(false)
                  parts.home()
                  viewRef.current?.requestRender()
                }}
              >
                {label('homeParts', 'Home parts')}
              </button>
            )}
            {parts !== undefined && parts.hasColliders && (
              <button
                type="button"
                style={buttonStyle(colliders)}
                data-usd-parts-colliders
                onClick={() => {
                  const visible = !colliders
                  setColliders(visible)
                  parts.setCollidersVisible(visible)
                  viewRef.current?.requestRender()
                }}
              >
                {label('colliders', 'Colliders')}
              </button>
            )}
            <button type="button" style={buttonStyle(false)} onClick={reset} data-usd-reset>
              {label('reset', 'Reset view')}
            </button>
            <button type="button" style={buttonStyle(showGrid)} onClick={() => { setShowGrid(value => !value) }}>
              {label('grid', 'Grid')}
            </button>
            <button type="button" style={buttonStyle(spin)} onClick={() => { setSpin(value => !value) }}>
              {label('spin', 'Auto-rotate')}
            </button>
            <button type="button" style={buttonStyle(wireframe)} onClick={() => { setWireframe(value => !value) }}>
              {label('wireframe', 'Wireframe')}
            </button>
          </div>
          <div style={HINT}>
            {label('help', 'Drag to orbit · wheel to zoom · right-drag to pan')}
            {partsHint === undefined ? '' : <div style={{ marginTop: 2 }} data-usd-parts-hint>{partsHint}</div>}
          </div>
          {stats !== undefined && <div style={STATS} data-usd-stats>{stats}</div>}
          {engineWarnings.length > 0 && (
            <div style={WARNINGS} data-usd-warnings>
              {engineWarnings.slice(0, 40).map((warning, index) => (
                <div key={`${warning.code}-${index}`} style={{ marginTop: index === 0 ? 0 : 4 }}>
                  <span style={{ color: ACCENT }}>{warning.code}</span>
                  {warning.path === undefined || warning.path === '' ? '' : ` · ${warning.path}`}
                  {warning.message === undefined || warning.message === '' ? '' : (
                    <div style={{ opacity: 0.75, paddingLeft: 8 }}>{warning.message}</div>
                  )}
                </div>
              ))}
              {engineWarnings.length > 40 && <div>…</div>}
            </div>
          )}
        </>
      )}
      {notices.map(text => <div key={text} style={NOTICE}>{text}</div>)}
    </div>
  )
}

