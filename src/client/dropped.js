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
 * Chrome reports dropped directories only through the entry API, and reports at
 * most 100 children per `readEntries` call, so collection is a recursive walk
 * that keeps reading until a directory is empty.
 */
import { retypeCustomInstancers, stripBom } from './engine.js'
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

/**
 * The stages a drop can open, shallowest first.
 *
 * A folder that holds one root layer next to the layers it references (the
 * usual SimReady/unit layout) yields the root first and the referenced layers
 * after it, while a folder with several independent stages yields all of them in
 * a stable order for the picker.
 * @param files - collected files by key.
 * @returns the keys of the USD layers, ordered by depth then name.
 */
export function stageCandidates(files) {
  return [...files.keys()]
    .filter(isUsdName)
    .sort((left, right) => depthOf(left) - depthOf(right) || left.localeCompare(right))
}

/**
 * The stage a drop opens without asking.
 *
 * A folder that holds one stage beside the layers it references needs no picker:
 * referenced layers sit deeper than the root, so the unique shallowest layer is
 * the stage. Two layers at that depth are two independent stages, and the page
 * asks which one to open instead of guessing.
 * @param stages - candidates in the order {@link stageCandidates} produced.
 * @returns the layer to open, or undefined when the drop needs a choice.
 */
export function defaultStage(stages) {
  if (stages.length === 0) return undefined
  const depth = stages[0].split('/').length
  const shallow = stages.filter(stage => stage.split('/').length === depth)
  return shallow.length === 1 ? shallow[0] : undefined
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
 * @returns the files by package-relative key and the stages among them.
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
  return { files, stages: stageCandidates(files) }
}

/**
 * Whether a drag carries something this preview opens.
 *
 * Runs on every `dragover` over the sidebar, so it stays allocation-light and
 * answers from the entry API: a directory may hold a stage, and a USD name is a
 * stage. Anything else (a PDF, an image, a URL) keeps the shell's attachment
 * behaviour.
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
      if (isUsdName(entry.name)) return true
      continue
    }
    const file = item.getAsFile?.()
    if (file !== undefined && file !== null && isUsdName(file.name)) return true
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
