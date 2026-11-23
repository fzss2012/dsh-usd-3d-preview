/**
 * External assets dropped on the right Sidebar.
 *
 * A drop hands the page `File` objects, not workspace paths: nothing is uploaded,
 * nothing is written to the workspace, and the preview reads the bytes in the
 * browser. The WASM engine already accepts exactly that shape — a map of
 * package-relative paths to blobs, with the root layer's key as the address — so
 * the drop path reuses the same composition the workspace path uses, with
 * references, sublayers and textures resolved from the dropped files.
 *
 * An IFC model is the other thing a drop can carry. It is one self-contained
 * STEP file rather than a set of layers, so it needs no composition: the drop
 * lists it beside the USD stages and the page tab opens the chosen one by bytes.
 *
 * Chrome reports dropped directories only through the entry API, and reports at
 * most 100 children per `readEntries` call, so collection is a recursive walk
 * that keeps reading until a directory is empty.
 */
import { retypeCustomInstancers, stripBom } from './engine.js'
import { isIfcName } from './ifc.js'
import { isSessionArchiveName } from './session.js'
import { USD_EXTENSIONS } from './usd.js'

/** Suffixes this preview opens. */
const USD_SUFFIXES = new Set(USD_EXTENSIONS)

/** Above this size a text layer is handed to the engine untouched. */
const MAX_TEXT_LAYER = 32 * 1024 * 1024

const decoder = new TextDecoder()
const encoder = new TextEncoder()

/**
 * Whether one file name carries a USD stage.
 * @param name - a dropped file's name, with or without its directory.
 * @returns true for `.usd`, `.usda`, `.usdc`, `.usdz`, in any case.
 */
export function isUsdName(name) {
  const dot = String(name).lastIndexOf('.')
  return dot >= 0 && USD_SUFFIXES.has(String(name).slice(dot + 1).toLowerCase())
}

/**
 * Whether one file name is a model this preview opens by bytes.
 *
 * A USD layer is composed from the files beside it; an IFC model is read whole
 * from its one file; a `session.json` names a modeling-session archive whose
 * newest snapshot is composed from the folder beside it. All three reach the
 * page the same way, so the drop offers them and the page tab decides which
 * reader opens the one that was chosen.
 * @param name - a dropped file's name, with or without its directory.
 * @returns true for a USD layer, an IFC model or a session archive manifest, in any case.
 */
export function isModelName(name) {
  return isUsdName(name) || isIfcName(name) || isSessionArchiveName(name)
}

/**
 * Which reader opens a dropped key.
 * @param key - a dropped file's package-relative key.
 * @returns `session` for an archive manifest, `ifc` for a model, `usd` for a layer.
 */
export function modelKindOf(key) {
  if (isSessionArchiveName(key)) return 'session'
  return isIfcName(key) ? 'ifc' : 'usd'
}

/**
 * Normalise a dropped path to the package-relative key the engine looks up.
 * @param path - a `File.webkitRelativePath` or a plain name.
 * @returns the key, with `\` separators folded and a leading `./` dropped.
 */
export function dropKey(path) {
  const slashed = String(path).replaceAll('\\', '/')
  return slashed.startsWith('./') ? slashed.slice(2) : slashed
}

/** Join one directory prefix and a child name into one key. */
function childKey(prefix, name) {
  return dropKey(`${prefix}${name}`)
}

/** Segments of one key, so the shallowest stage is the one opened first. */
function depthOf(key) {
  return key.split('/').length
}

/** Ordering of the three readers when a drop carries several kinds at one depth. */
const KIND_ORDER = { session: 0, usd: 1, ifc: 2 }

/**
 * The models a drop can open, shallowest first.
 *
 * A folder that holds one root layer next to the layers it references (the
 * usual SimReady/unit layout) yields the root first and the referenced layers
 * after it, while a folder with several independent items yields all of them in
 * a stable order for the picker. Two models at one depth keep the archive
 * manifest first, then USD, then IFC: a session archive's `session.json` sits
 * above the snapshot folder it describes, and a mixed folder is a USD asset far
 * more often than the reverse.
 * @param files - collected files by key.
 * @returns the models, each with the reader that opens it, ordered by depth,
 * then kind, then name.
 */
export function modelCandidates(files) {
  return [...files.keys()]
    .filter(isModelName)
    .map(key => ({ key, kind: modelKindOf(key) }))
    .sort((left, right) => depthOf(left.key) - depthOf(right.key)
      || KIND_ORDER[left.kind] - KIND_ORDER[right.kind]
      || left.key.localeCompare(right.key))
}

/**
 * The model a drop opens without asking.
 *
 * A folder that holds one model beside the layers it references needs no picker:
 * referenced layers sit deeper than the root, so the unique shallowest entry is
 * the one to open — which is also why a session folder opens its `session.json`
 * (the snapshots and records beneath it are never candidates of their own). Two
 * models at that depth are two independent models, and the page asks which one
 * to open instead of guessing.
 * @param models - candidates in the order {@link modelCandidates} produced.
 * @returns the key to open, or undefined when the drop needs a choice.
 */
export function defaultModel(models) {
  if (models.length === 0) return undefined
  const depth = depthOf(models[0].key)
  const shallow = models.filter(model => depthOf(model.key) === depth)
  return shallow.length === 1 ? shallow[0].key : undefined
}

/** Whether a file's bytes are ASCII USD, so a text-level fix applies to them. */
async function isAsciiLayer(file) {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer())
  let start = 0
  if (head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) start = 3
  // `#u`: the USDA magic. A crate and a package are recognised by their own.
  return head[start] === 0x23 && head[start + 1] === 0x75
}

/**
 * Normalise one dropped layer the way the workspace path normalises a read.
 *
 * The engine's ASCII reader is strict about a UTF-8 BOM and only instances the
 * standard `PointInstancer` type, so a text layer is stripped and retyped before
 * it reaches the worker. Crate and package bytes are passed through untouched,
 * and an over-large text layer is left to the engine rather than copied on the
 * page thread.
 * @param key - the layer's package-relative key.
 * @param file - the dropped file.
 * @returns the blob the engine should read.
 */
export async function normalizeLayer(key, file) {
  if (!isUsdName(key) || file.size > MAX_TEXT_LAYER) return file
  try {
    if (!(await isAsciiLayer(file))) return file
    const bytes = stripBom(new Uint8Array(await file.arrayBuffer()))
    const text = retypeCustomInstancers(decoder.decode(bytes))
    return new Blob([encoder.encode(text)], { type: 'text/plain' })
  } catch {
    // An unreadable file is a missing layer the engine reports, not a failed drop.
    return file
  }
}

/** One entry's file, or undefined when the browser refuses it (a removed file). */
function fileOf(entry) {
  return new Promise((resolve) => {
    entry.file((file) => resolve(file), () => resolve(undefined))
  })
}

/** One directory reader page; the API returns at most 100 entries per call. */
function childrenOf(reader) {
  return new Promise((resolve) => {
    reader.readEntries((entries) => resolve(entries), () => resolve([]))
  })
}

/** Collect one dropped entry, recursing through directories. */
async function walkEntry(entry, prefix, files) {
  if (entry.isFile === true) {
    const file = await fileOf(entry)
    if (file !== undefined && file !== null) files.set(childKey(prefix, entry.name), file)
    return
  }
  if (entry.isDirectory !== true) return
  const reader = entry.createReader()
  const nestedPrefix = childKey(prefix, `${entry.name}/`)
  for (;;) {
    const children = await childrenOf(reader)
    if (children.length === 0) break
    for (const child of children) await walkEntry(child, nestedPrefix, files)
  }
}

/**
 * Collect every file a drop carries into the engine's file map.
 * @param dataTransfer - the drop's data transfer (or a `{ files }` stand-in from
 * a picker).
 * @returns the files by package-relative key and the models among them.
 */
export async function collectDropped(dataTransfer) {
  const files = new Map()
  const entries = []
  for (const item of dataTransfer?.items ?? []) {
    if (item.kind !== 'file') continue
    const entry = item.webkitGetAsEntry?.()
    if (entry !== undefined && entry !== null) entries.push(entry)
  }
  if (entries.length > 0) {
    for (const entry of entries) await walkEntry(entry, '', files)
  } else {
    for (const file of dataTransfer?.files ?? []) {
      const path = file.webkitRelativePath === undefined || file.webkitRelativePath === ''
        ? file.name
        : file.webkitRelativePath
      if (path !== undefined && path !== '') files.set(dropKey(path), file)
    }
  }
  for (const [key, file] of [...files]) {
    const normalized = await normalizeLayer(key, file)
    if (normalized !== file) files.set(key, normalized)
  }
  return { files, models: modelCandidates(files) }
}

/**
 * Whether a drag carries something this preview opens.
 *
 * Runs on every `dragover` over the sidebar, so it stays allocation-light and
 * answers from the entry API: a directory may hold a stage or a model, and a USD
 * or IFC name is one. Anything else (a PDF, an image, a URL) keeps the shell's
 * attachment behaviour.
 * @param dataTransfer - the drag's data transfer.
 * @returns true when the drop belongs to this preview.
 */
export function acceptsDroppedAsset(dataTransfer) {
  if (dataTransfer === null || dataTransfer === undefined) return false
  for (const item of dataTransfer.items ?? []) {
    if (item.kind !== 'file') continue
    const entry = item.webkitGetAsEntry?.()
    if (entry !== undefined && entry !== null) {
      if (entry.isDirectory === true) return true
      if (isModelName(entry.name)) return true
      continue
    }
    const file = item.getAsFile?.()
    if (file !== undefined && file !== null && isModelName(file.name)) return true
  }
  return false
}

/** The one drop waiting for the page tab that renders it. */
let pending
const listeners = new Set()

/**
 * Hand one collected drop to the page tab, mounting or updating it.
 * @param drop - files and stage candidates.
 */
export function offerDropped(drop) {
  pending = drop
  for (const listener of [...listeners]) listener()
}

/**
 * Take the drop that was waiting, clearing it.
 * @returns the drop, or undefined when nothing is pending.
 */
export function takePendingDropped() {
  const drop = pending
  pending = undefined
  return drop
}

/**
 * Observe offered drops.
 * @param listener - called after every offer.
 * @returns its disposer.
 */
export function subscribeDropped(listener) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
