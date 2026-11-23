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
 *
 * Two modes read the same bytes instead of the composed graph. **Text** shows the
 * layers' own USDA source — the authored text for an ASCII layer, a labelled
 * reconstruction for a crate — because "what does the file say" is a different
 * question from "what is drawn". **Composition** shows the layer tree and every
 * arc that placed a layer in it. Both read lazily and only from the bytes the
 * assembly kept, so neither can turn a large stage into a stalled tab.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { TreeChevron, TreeFolder, TreePrim } from './artwork.jsx'
import { StageCompositionPanel } from './CompositionPanel.jsx'
import { PrimDetailsPanel } from './DetailsPanel.jsx'
import { createArticulationController } from './kinematics.js'
import { assemble, describeComposition, describeLayerText, describePrim, disposeObject } from './parse.js'
import { UsdTextPanel } from './TextPanel.jsx'
import {
  allFolderPaths, ancestorsOf, buildPrimTree, countPrimNodes, filterPrimTree, flattenPrimTree,
} from './prim-tree.js'
import { ACCENT, ACCENT_WASH, BASE, BORDER, ERROR, FONT, LABEL, LABEL_DIM, MONO, SURFACE } from './tokens.js'
import { absoluteFilePath, assetUriOf, parseFileReference, siblingPath, usdFileName } from './usd.js'
import { createView } from './view.js'

const SHELL = {
  position: 'absolute',
  inset: 0,
  overflow: 'hidden',
  background: BASE,
  color: LABEL,
  fontFamily: FONT,
  fontSize: 12,
  // The shell takes focus on a pointer press (see the Escape handler): a click on
  // the model has to be what "the keyboard is here now" means, or Escape would
  // keep going to whatever the user was typing in before.
  outline: 'none',
}

const CANVAS = { position: 'absolute', inset: 0 }

/**
 * The text view replaces the viewport completely, toolbar included: the reader is
 * looking at the file, and a row of viewport controls over the code would both
 * steal the top-right corner the panel's own close button needs and offer
 * controls that do nothing while reading. Leaving the mode is the panel's × or
 * Escape, the two affordances the other panels use.
 */
const TEXT_VIEW = {
  position: 'absolute',
  inset: 0,
  zIndex: 6,
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  background: BASE,
  color: LABEL,
  fontFamily: FONT,
  fontSize: 11,
}

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

const PRIMS = {
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

/** Rows the prims panel renders at once; a big instancer can name tens of thousands. */
const PRIM_ROW_LIMIT = 500

const PRIM_HEAD = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 8px',
  borderBottom: '1px solid ' + BORDER,
  color: LABEL_DIM,
}

const PRIM_FILTER = {
  margin: '6px 8px 4px',
  padding: '3px 7px',
  borderRadius: 6,
  border: '1px solid ' + BORDER,
  background: BASE,
  color: LABEL,
  font: 'inherit',
  fontSize: 11,
}

const PRIM_LIST = { flex: '1 1 auto', minHeight: 0, overflow: 'auto', padding: '0 4px 6px' }

const PRIM_PICKED = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  margin: '0 8px 4px',
  minWidth: 0,
  fontSize: 11,
}

const PRIM_MONO = MONO

/**
 * One tree row. The caret occupies a fixed gutter so a folder and its leaf
 * children line up; the indent gives the hierarchy its shape.
 * @param active - whether this row is the picked or copied path.
 * @param depth - indentation level.
 * @returns the inline style.
 */
function primRowStyle(active, depth = 0) {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 3,
    width: '100%',
    padding: '2px 6px 2px ' + (4 + depth * 13) + 'px',
    borderRadius: 5,
    border: 'none',
    background: active ? ACCENT_WASH : 'transparent',
    color: active ? ACCENT : LABEL,
    font: 'inherit',
    fontSize: 11,
    fontFamily: PRIM_MONO,
    textAlign: 'left',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  }
}

/** The little state icon at the front of a tree row. */
const PRIM_ICON = { flex: '0 0 auto', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 12, height: 12 }
/** The label that carries the name and tolerates overflow. */
const PRIM_LABEL = { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }
/** Ancestor folders are dimmer than the prim that actually carries geometry. */
const PRIM_FOLDER_INK = { opacity: 0.75 }

/** Collect every prim path the composed three graph carries. */
function collectPrimPaths(object) {
  const paths = new Set()
  object.traverse((node) => {
    if (typeof node.name === 'string' && node.name.startsWith('/')) paths.add(node.name)
    const instanced = node.userData?.paths
    if (Array.isArray(instanced)) {
      for (const path of instanced) {
        if (typeof path === 'string' && path.startsWith('/')) paths.add(path)
      }
    }
  })
  return [...paths].sort((left, right) => left.localeCompare(right))
}

/**
 * The bytes of one layer source, whatever shape the assembly kept it in.
 *
 * The engine keeps Blobs, a dropped file is a File (a Blob), an address-opened
 * stage hands over a Uint8Array, and a test hands over bytes directly. One
 * reader for all four keeps the text panel from needing to know which door the
 * stage came through.
 * @param value - one layer source from the assembly.
 * @returns its bytes, or undefined when the value carries none.
 */
async function toLayerBytes(value) {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return new TextEncoder().encode(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value) === true) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  if (typeof value.arrayBuffer === 'function') return new Uint8Array(await value.arrayBuffer())
  return undefined
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
 * @param props.remoteStage - an address-opened stage (root bytes + layer readers).
 * @returns the viewport, or the loading/failure state that replaces it.
 */
export function UsdBody(props) {
  const { content, resourceAddress, droppedFiles, droppedRootKey, remoteStage } = props
  const t = props.t
  const data = content !== undefined && content.kind === 'bytes' ? content.data : undefined
  const name = usdFileName(resourceAddress)
  // The key the assembly composed the opened file under. References resolve
  // relative to it, and both read-back panels (text and composition) start their
  // walk there instead of at whatever the layer map happens to list first.
  const openedKey = useMemo(() => {
    if (droppedRootKey !== undefined && droppedRootKey !== null) return String(droppedRootKey)
    if (remoteStage !== undefined) return String(remoteStage.rootKey)
    if (droppedFiles !== undefined && typeof droppedFiles.keys === 'function') {
      const first = [...droppedFiles.keys()][0]
      if (first !== undefined) return String(first)
    }
    const reference = parseFileReference(resourceAddress)
    if (reference !== undefined) return reference.path
    const absolute = absoluteFilePath(resourceAddress)
    return absolute === undefined ? undefined : absolute
  }, [droppedRootKey, remoteStage, droppedFiles, resourceAddress])
  const shellRef = useRef(null)
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
  // Prim paths are the asset's addressable structure: the panel lists every one
  // the composed graph carries, and a click on the model selects its own.
  const [primsOpen, setPrimsOpen] = useState(false)
  const [primFilter, setPrimFilter] = useState('')
  // Folders the reader has opened. Everything starts expanded when the panel is
  // first shown; a collapse only hides a subtree, it never changes the data.
  const [collapsedFolders, setCollapsedFolders] = useState(() => new Set())
  const [picked, setPicked] = useState(null)
  const [copiedPath, setCopiedPath] = useState(null)
  // The details panel answers a different question than the prim tree — "what does
  // the file declare about this prim" — so it is its own panel with its own state
  // rather than more rows in a list of names.
  const [detailsOpen, setDetailsOpen] = useState(false)
  // The text view and the composition panel read the same layer bytes instead of
  // the composed graph; each is its own mode, toggled from the toolbar.
  const [textOpen, setTextOpen] = useState(false)
  const [textLayerKey, setTextLayerKey] = useState(null)
  const [compositionOpen, setCompositionOpen] = useState(false)

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
    if (data === undefined && droppedFiles === undefined && remoteStage === undefined) {
      setParsed(null)
      setFailure(null)
      return undefined
    }
    let cancelled = false
    const controller = new AbortController()
    setParsed(null)
    setFailure(null)
    // A new assembly is a new scene: the old selection named an object that no
    // longer exists, and the view that carried its tint is about to be destroyed.
    setPicked(null)
    // One macrotask, so the status line paints before a large layer blocks the thread.
    const timer = setTimeout(async () => {
      /** Bind moving parts before the view exists, so the first frame is posed. */
      const adopt = (result) => {
        if (result.articulation !== undefined) {
          try {
            result.parts = createArticulationController(result.object, result.articulation)
          } catch (error) {
            result.articulationError = error instanceof Error ? error.message : String(error)
          }
        }
        return result
      }
      try {
        // An address-opened stage keeps its layers remote: the root bytes are
        // already in the page and the engine calls the readers for every
        // reference it composes, exactly like a workspace file. Relative layers,
        // sublayers and absolute s3:// payloads therefore resolve normally.
        if (remoteStage !== undefined) {
          const result = await assemble({
            rootKey: remoteStage.rootKey,
            rootBytes: remoteStage.rootBytes,
            read: remoteStage.read,
            readAsset: remoteStage.readAsset ?? assetReaderRef.current,
            signal: controller.signal,
          })
          if (cancelled) {
            if (result.dispose !== undefined) result.dispose()
            else disposeObject(result.object)
            return
          }
          setParsed(adopt(result))
          return
        }
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
        // A stage that declares parts but cannot be bound still previews: the
        // geometry is the file, the articulation is an extra (see adopt()).
        setParsed(adopt(result))
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
  }, [data, resourceAddress, droppedFiles, droppedRootKey, remoteStage])

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
    // Picking serves two purposes: an articulated stage opens the clicked part,
    // a static one names it. Both are the same click, and both highlight what was
    // hit: a name in the panel is easy to lose on a busy stage. A stage above the
    // picking budget kept the engine's post-upload release, so its vertex arrays
    // are gone and three's raycaster would throw on them: no handler, no click.
    const stopPick = parsed.pickable === true
      ? view.onPick((hits) => {
        if (parts !== undefined && parts.pick(hits) === true) view.requestRender()
        const hit = hits[0]
        const object = hit?.object
        const name = object === undefined
          ? undefined
          : (object.isInstancedMesh === true && Array.isArray(object.userData?.paths)
            ? object.userData.paths[hit.instanceId]
            : object.name)
        // A click is one selection: whatever the pick landed on replaces the
        // previous tint and the previous name together. Two cases show nothing —
        // empty space (no hit), and a prim with no surface to tint (points,
        // lines) — and both clear what was there rather than leaving a stale
        // tint behind. The name is only drawn for an engine-composed stage, whose
        // meshes are named by prim path; the three fallback keeps the last path
        // segment, so there the click tints but names nothing.
        view.setSelection(hit)
        setPicked(typeof name === 'string' && name.startsWith('/') ? name : null)
      })
      : undefined
    return () => {
      stopFrame?.()
      stopPick?.()
      viewRef.current = null
      view.destroy()
    }
  }, [parsed])

  // One way to undo a selection, whatever the reason: the panel's × button, the
  // Escape key and a click on the background all land here. The tint and the name
  // are one selection, so they always go together.
  const clearSelection = useCallback(() => {
    viewRef.current?.clearSelection()
    setPicked(null)
  }, [])

  // The details reader is bound to the assembly, not to the selection: it reads
  // the layer bytes that produced this stage, and a stage with no bytes (the
  // three fallback) answers "cannot read back" instead of reading a stale one.
  //
  // It has to be memoized on the assembly, because the panel re-reads whenever the
  // reader it was handed changes — and a fresh arrow function on every render would
  // mean a full re-decode of every layer each time this component draws, which is
  // once per keystroke in the prim filter. The reader is a fact about `parsed`, so
  // `parsed` is its whole dependency list.
  const primReader = useMemo(
    () => (parsed === null ? undefined : path => describePrim(parsed, path)),
    [parsed],
  )
  // Every layer byte the read-back modes may show: the opened file's bytes first,
  // then the engine's package map (which already holds every referenced layer),
  // then the dropped files. Aliases of one blob share an object, so identity is
  // what keeps one row per layer.
  const layerSources = useMemo(() => {
    const entries = []
    const seen = new Set()
    const seenKeys = new Set()
    const add = (key, value) => {
      if (key === undefined || key === null || value === undefined || value === null) return
      const name = String(key)
      // Two spellings of one blob are one layer; so are the root bytes and the
      // same root registered in the engine's package map. A key names a layer, so
      // the first value under a key wins.
      if (seen.has(value) === true || seenKeys.has(name) === true) return
      seen.add(value)
      seenKeys.add(name)
      entries.push({ key: name, value })
    }
    // The engine's package map is the fullest record when it exists: it holds the
    // root bytes under the opened key *and* every layer the stage read.
    if (parsed !== null && parsed.sources instanceof Map) {
      for (const [key, value] of parsed.sources) add(key, value)
    }
    if (droppedFiles instanceof Map) {
      for (const [key, value] of droppedFiles) add(key, value)
    }
    if (openedKey !== undefined && data !== undefined) add(openedKey, data)
    if (remoteStage !== undefined && remoteStage.rootBytes !== undefined) add(remoteStage.rootKey, remoteStage.rootBytes)
    return entries
  }, [parsed, droppedFiles, data, openedKey, remoteStage])

  // The text view's rows: the opened file first (a reader opens the layer they
  // chose), then the composed layers in key order. Bytes are read when a layer is
  // picked, never for the whole stage up front — a solved robot's geometry layer
  // is tens of megabytes and no reader opened the text view for it.
  const textLayers = useMemo(() => {
    const layers = []
    const seen = new Set()
    const add = (entry, role) => {
      if (entry === undefined || seen.has(entry.value) === true) return
      seen.add(entry.value)
      layers.push({
        key: entry.key,
        name: usdFileName(entry.key),
        role,
        load: () => toLayerBytes(entry.value),
      })
    }
    const root = layerSources.find(entry => entry.key === openedKey)
    add(root ?? layerSources[0], 'root')
    for (const entry of layerSources) {
      if (entry === root || entry === layerSources[0]) continue
      add(entry, 'layer')
    }
    return layers
  }, [layerSources, openedKey])

  // A text layer named by a previous assembly may not exist in this one; the mode
  // always opens on a layer that is there.
  useEffect(() => {
    if (textLayers.length === 0) {
      if (textLayerKey !== null) setTextLayerKey(null)
      return
    }
    if (textLayerKey !== null && textLayers.some(layer => layer.key === textLayerKey)) return
    setTextLayerKey(textLayers[0].key)
  }, [textLayers, textLayerKey])

  // The composition panel's reader is a fact about the assembly, not the click:
  // memoizing it keeps the panel from re-walking every layer on each parent draw.
  const compositionReader = useMemo(
    () => (parsed === null ? undefined : () => describeComposition(parsed, openedKey)),
    [parsed, openedKey],
  )
  // Detail hint keys mirror usdview's pane names so a USD reader's vocabulary
  // works here: Type / Kind / Applied schemas / Attributes / Relationships. The
  // two panels sit on opposite edges, so opening one does not hide the other —
  // picking in the tree and reading the table is the ordinary way to use them.
  const openDetails = useCallback(() => {
    setDetailsOpen(true)
    setPrimsOpen(true)
  }, [])

  // Clicking a prim in the tree is the other way to ask "what is this?" — the
  // details panel follows the selection, so it stays in step with what the tree
  // says is picked instead of being a second, independent cursor.
  const selectFromTree = useCallback((path) => {
    setPicked(path)
    // A tree row is a name, not a surface: there is nothing in the frame to tint,
    // and a tint left over from an earlier click would point at a different prim.
    viewRef.current?.clearSelection()
  }, [])

  // Esc clears the selection. The listener is on the document rather than on the
  // canvas because a canvas that lost focus to a toolbar button would otherwise
  // swallow the key, and because the selection is the panel's state, not the
  // canvas's. Three things keep it from stealing a key that belongs elsewhere: an
  // IME composition (Escape cancels the composition — a Chinese input would
  // otherwise lose both), a text field (the prim filter), and focus that is
  // demonstrably in another part of the page. Focus that is nowhere — the state
  // after clicking the canvas — is this panel's.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const onKeyDown = (event) => {
      if (event.key !== 'Escape' || event.defaultPrevented === true || event.isComposing === true) return
      const target = event.target
      const tag = typeof target?.tagName === 'string' ? target.tagName.toLowerCase() : ''
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable === true) return
      const shell = shellRef.current
      const focusElsewhere = shell !== null && target !== undefined && target !== null
        && target !== document.body && target !== document.documentElement
        && shell.contains(target) === false
      if (focusElsewhere === true) return
      // A mode that took over the viewport gets the first Escape: it is the bigger
      // thing on screen, and a second press still reaches the selection.
      if (textOpen === true) {
        setTextOpen(false)
        return
      }
      if (compositionOpen === true) {
        setCompositionOpen(false)
        return
      }
      clearSelection()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [clearSelection, textOpen, compositionOpen])

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

  const primPaths = useMemo(() => (parsed === null ? [] : collectPrimPaths(parsed.object)), [parsed])
  const primTree = useMemo(() => buildPrimTree(primPaths), [primPaths])
  const primCount = useMemo(() => countPrimNodes(primTree), [primTree])
  const filtered = useMemo(() => filterPrimTree(primTree, primFilter), [primTree, primFilter])
  // Filtering shows every match with its ancestors and subtrees fully open;
  // without a filter the reader's own collapse choices decide what is visible.
  const visibleTree = filtered.tree
  const expandedFolders = useMemo(() => {
    if (filtered.active === true) return allFolderPaths(visibleTree)
    const all = allFolderPaths(primTree)
    for (const path of collapsedFolders) all.delete(path)
    return all
  }, [filtered.active, visibleTree, primTree, collapsedFolders])
  const primRows = useMemo(
    () => flattenPrimTree(visibleTree, expandedFolders, { limit: PRIM_ROW_LIMIT, forcedOpen: filtered.active }),
    [visibleTree, expandedFolders, filtered.active],
  )
  const shownCount = useMemo(() => countPrimNodes(visibleTree), [visibleTree])

  const toggleFolder = useCallback((path) => {
    setCollapsedFolders(current => {
      const next = new Set(current)
      // The set stores collapsed folders; clicking a folder toggles membership.
      if (next.has(path) === true) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  // When a prim is picked on the model, reveal it in the tree by opening every
  // folder on the way to it. Its ancestors were collapsed only by the reader.
  useEffect(() => {
    if (picked === null) return
    const ancestors = ancestorsOf(picked)
    if (ancestors.length === 0) return
    setCollapsedFolders(current => {
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
      window.setTimeout(() => setCopiedPath(current => (current === path ? null : current)), 1500)
    } catch {
      setCopiedPath(null)
    }
  }, [])

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
      ref={shellRef}
      style={SHELL}
      // Focusable but not in the tab order: a pointer press on the canvas takes
      // focus, so Escape afterwards belongs to this viewport rather than to
      // whatever the user was typing in before clicking the model. A press that
      // lands on one of the panel's own controls leaves focus to that control.
      tabIndex={-1}
      onPointerDown={(event) => {
        const target = event.target
        const tag = typeof target?.tagName === 'string' ? target.tagName.toLowerCase() : ''
        if (tag === 'input' || tag === 'textarea' || tag === 'button' || tag === 'a' || target?.isContentEditable === true) return
        shellRef.current?.focus({ preventScroll: true })
      }}
      data-usd-preview
      data-usd-engine={parsed?.engine ?? ''}
      data-usd-engine-error={parsed?.engineError ?? ''}
      data-usd-parts={parts === undefined ? 0 : parts.movingParts}
      data-usd-colliders={parts?.hasColliders === true ? '1' : '0'}
      data-usd-pickable={parsed?.pickable === true ? '1' : '0'}
      data-usd-selected={picked ?? ''}
      data-usd-text-mode={textOpen ? '1' : '0'}
      data-usd-composition-open={compositionOpen ? '1' : '0'}
      data-usd-layers={textLayers.length}
    >
      <div ref={containerRef} style={CANVAS} data-usd-preview-stage />
      {textOpen && (
        <div style={TEXT_VIEW} data-usd-text-view>
          <UsdTextPanel
            layers={textLayers}
            activeKey={textLayerKey}
            onSelect={setTextLayerKey}
            onClose={() => setTextOpen(false)}
            describeLayer={describeLayerText}
            t={t}
          />
        </div>
      )}
      {failure !== null && (
        <div style={CENTERED} role="alert">
          <div>
            <div style={{ color: ERROR, fontWeight: 600 }}>{label('failed', 'This USD file could not be parsed.')}</div>
            <div style={{ marginTop: 6, color: LABEL_DIM, wordBreak: 'break-word' }}>{failure}</div>
            <div style={{ marginTop: 10 }}>
              <button
                type="button"
                style={buttonStyle(textOpen)}
                data-usd-text-toggle
                title={label('textHint', "Show the layers' own USDA text")}
                onClick={() => setTextOpen(value => !value)}
              >
                {label('textMode', 'Text')}
              </button>
            </div>
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
            <button
              type="button"
              style={buttonStyle(primsOpen)}
              data-usd-prims-toggle
              title={label('primsHint', 'Show the prim paths this stage carries')}
              onClick={() => {
                setPrimsOpen(value => !value)
              }}
            >
              {label('prims', 'Prims')} · {primCount}
            </button>
            <button
              type="button"
              style={buttonStyle(detailsOpen)}
              data-usd-details-toggle
              title={label('detailsHint', 'Show what the stage declares about the selected prim')}
              onClick={() => (detailsOpen === true ? setDetailsOpen(false) : openDetails())}
            >
              {label('details', 'Details')}
            </button>
            <button
              type="button"
              style={buttonStyle(textOpen)}
              data-usd-text-toggle
              title={label('textHint', "Show the layers' own USDA text")}
              onClick={() => setTextOpen(value => !value)}
            >
              {label('textMode', 'Text')}
            </button>
            <button
              type="button"
              style={buttonStyle(compositionOpen)}
              data-usd-composition-toggle
              title={label('compositionHint', 'Show the layer stack and the arcs that composed it')}
              onClick={() => setCompositionOpen(value => !value)}
            >
              {label('composition', 'Composition')}
            </button>
          </div>
          {!primsOpen && !textOpen && <div style={HINT}>
            {label('help', 'Drag to orbit · wheel to zoom · right-drag to pan')}
            {partsHint === undefined ? '' : <div style={{ marginTop: 2 }} data-usd-parts-hint>{partsHint}</div>}
            {picked === null ? '' : (
              // The hint carries the same selection the panel does, and the same
              // way out of it: with the prims panel closed there would otherwise
              // be a tint with no affordance to clear it.
              <div style={{ marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }} data-usd-picked>
                <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {label('picked', 'Picked')}: <span style={{ fontFamily: PRIM_MONO }}>{picked}</span>
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
          </div>}
          {!textOpen && primsOpen && (
            <div style={PRIMS} data-usd-prims>
              <div style={PRIM_HEAD}>
                <span style={{ flex: '1 1 auto' }}>
                  {label('prims', 'Prims')} · {shownCount}/{primCount}
                </span>
                <span style={{ opacity: 0.7 }}>{label('primsClick', 'click to copy')}</span>
              </div>
              {picked === null ? null : (
                <div style={PRIM_PICKED} data-usd-picked>
                  <span style={{ flex: '0 0 auto', color: LABEL_DIM }}>{label('picked', 'Picked')}:</span>
                  <button
                    type="button"
                    style={{ ...primRowStyle(true), width: 'auto', flex: '1 1 auto', padding: '1px 4px' }}
                    title={picked}
                    onClick={() => void copyPath(picked)}
                  >
                    {copiedPath === picked ? '✓ ' : ''}{picked}
                  </button>
                  <button
                    type="button"
                    data-usd-picked-clear
                    title={label('clearSelection', 'Clear the selection (Esc)')}
                    aria-label={label('clearSelection', 'Clear the selection (Esc)')}
                    onClick={clearSelection}
                    style={{
                      flex: '0 0 auto',
                      padding: '1px 5px',
                      borderRadius: 5,
                      border: `1px solid ${BORDER}`,
                      background: 'transparent',
                      color: LABEL_DIM,
                      font: 'inherit',
                      fontSize: 11,
                      cursor: 'pointer',
                    }}
                  >
                    ×
                  </button>
                </div>
              )}
              <input
                type="text"
                value={primFilter}
                spellCheck={false}
                onChange={event => setPrimFilter(event.target.value)}
                placeholder={label('primsFilter', 'Filter prim paths…')}
                style={PRIM_FILTER}
                aria-label={label('primsFilter', 'Filter prim paths')}
              />
              <div style={PRIM_LIST}>
                {primRows.rows.length === 0
                  ? <div style={{ padding: '2px 6px', color: LABEL_DIM }}>{label('primsEmpty', 'No prim paths in this stage')}</div>
                  : primRows.rows.map(({ node, depth }) => {
                    const folder = node.children.size > 0
                    const open = expandedFolders.has(node.path) === true
                    const active = picked === node.path || copiedPath === node.path
                    return (
                      <button
                        key={node.path}
                        type="button"
                        data-usd-prim-row
                        data-usd-prim-path={node.path}
                        data-usd-prim-folder={folder === true ? '1' : undefined}
                        data-depth={depth}
                        aria-expanded={folder === true ? open : undefined}
                        style={primRowStyle(active, depth)}
                        title={node.path}
                        onClick={() => {
                          if (folder === true) {
                            toggleFolder(node.path)
                            return
                          }
                          // A leaf row is a prim the stage carries: selecting it
                          // names it in the details panel, and copies it — the
                          // copy is what the panel replaced as the row's action,
                          // so both stay available.
                          selectFromTree(node.path)
                          void copyPath(node.path)
                        }}
                      >
                        <span style={PRIM_ICON}>
                          {folder === true
                            ? <TreeChevron open={filtered.active === true || open} />
                            : null}
                        </span>
                        <span style={PRIM_ICON}>
                          {folder === true
                            ? <span style={PRIM_FOLDER_INK}><TreeFolder open={filtered.active === true || open} /></span>
                            : <TreePrim />}
                        </span>
                        <span style={PRIM_LABEL}>{copiedPath === node.path ? '✓ ' : ''}{node.name}</span>
                      </button>
                    )
                  })}
                {primRows.truncated && (
                  <div style={{ padding: '2px 6px', color: LABEL_DIM }}>
                    {label('primsLimited', 'list clipped to the first')} {PRIM_ROW_LIMIT} / {primRows.total}
                  </div>
                )}
              </div>
            </div>
          )}
          {!textOpen && detailsOpen && (
            <PrimDetailsPanel
              path={picked}
              read={primReader}
              onClose={() => setDetailsOpen(false)}
              t={t}
            />
          )}
          {compositionOpen && (
            <StageCompositionPanel
              read={compositionReader}
              onClose={() => setCompositionOpen(false)}
              t={t}
            />
          )}
          {!textOpen && stats !== undefined && <div style={STATS} data-usd-stats>{stats}</div>}
          {!textOpen && engineWarnings.length > 0 && (
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

