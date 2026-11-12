/**
 * The external-asset path without a browser: what a drop collects, how a text
 * layer is normalised for the engine, and how the sidebar listener decides a
 * drag belongs to this preview.
 *
 * The DOM is faked at the two members the listener actually calls — listeners,
 * element attributes and the overlay element — so the capture-phase decision is
 * exercised for real rather than asserted against a mock of the module.
 *
 * Run: node tests/drop.test.mjs
 */
import assert from 'node:assert/strict'
import { SIDEBAR_PANEL_SELECTOR, watchSidebarDrops } from '../src/client/sidebar-drop.js'
import {
  acceptsDroppedAsset,
  collectDropped,
  defaultStage,
  dropKey,
  isUsdName,
  normalizeLayer,
  offerDropped,
  stageCandidates,
  subscribeDropped,
  takePendingDropped,
} from '../src/client/dropped.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

// ── names and keys ───────────────────────────────────────────────────────────
assert.equal(isUsdName('scene.usda'), true)
assert.equal(isUsdName('SCENE.USDZ'), true)
assert.equal(isUsdName('C:/asset/robot.usd'), true)
assert.equal(isUsdName('notes.txt'), false)
assert.equal(isUsdName('usdz'), false, 'a suffix needs its dot')

assert.equal(dropKey('./a/b.usda'), 'a/b.usda')
assert.equal(dropKey('pkg\\geom\\body.usda'), 'pkg/geom/body.usda')

// ── stage ordering: the shallowest layer is the one opened first ─────────────
const files = new Map([
  ['pkg/geom/body.usda', new Blob(['x'])],
  ['pkg/root.usda', new Blob(['x'])],
  ['pkg/Tex/a.png', new Blob(['x'])],
])
assert.deepEqual(stageCandidates(files), ['pkg/root.usda', 'pkg/geom/body.usda'])
// The referenced layer sits deeper than the root, so the root opens unasked.
assert.equal(defaultStage(stageCandidates(files)), 'pkg/root.usda')
// Two stages at the same depth are a choice, not a guess.
assert.equal(defaultStage(['a.usd', 'b.usd']), undefined)
assert.equal(defaultStage([]), undefined)

// ── a text layer loses its BOM and a custom instancer type ───────────────────
const custom = '#usda 1.0\ndef Grid "row" {\n    int[] protoIndices = [0]\n}\n'
const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode(custom)])
const normalised = await normalizeLayer('root.usda', new Blob([bom]))
const text = decoder.decode(new Uint8Array(await normalised.arrayBuffer()))
assert.equal(text.startsWith('\ufeff'), false, 'the BOM must be stripped before the engine reads the layer')
assert.ok(text.includes('def PointInstancer "row"'), 'a custom-typed instancer must be retyped')

// A package is bytes, not text: it must be handed over untouched.
const packageBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02])
const packageBlob = new Blob([packageBytes])
assert.equal(await normalizeLayer('scene.usdz', packageBlob), packageBlob)

// ── collection from a picker (no directory entries) ─────────────────────────
const stageFile = new File([encoder.encode('#usda 1.0\ndef Xform "root" {}\n')], 'root.usda', { type: 'text/plain' })
const textureFile = new File([new Uint8Array([1, 2, 3])], 'tex.png')
const collected = await collectDropped({ files: [stageFile, textureFile] })
assert.deepEqual([...collected.files.keys()], ['root.usda', 'tex.png'])
assert.deepEqual(collected.stages, ['root.usda'], 'only the stage is offered to open')

const emptyDrop = await collectDropped({ files: [] })
assert.equal(emptyDrop.stages.length, 0)

// ── what counts as this preview's drag ──────────────────────────────────────
const usdItem = { kind: 'file', getAsFile: () => stageFile }
const pdfItem = { kind: 'file', getAsFile: () => new File(['x'], 'doc.pdf') }
const folderItem = { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true, isFile: false, name: 'pkg' }) }
assert.equal(acceptsDroppedAsset({ items: [usdItem] }), true)
assert.equal(acceptsDroppedAsset({ items: [pdfItem] }), false, 'a PDF keeps the shell attachment path')
assert.equal(acceptsDroppedAsset({ items: [folderItem] }), true, 'a folder may hold a stage')
assert.equal(acceptsDroppedAsset(undefined), false)

// ── the pending hand-off ────────────────────────────────────────────────────
let notified = 0
const unsubscribe = subscribeDropped(() => { notified += 1 })
assert.equal(takePendingDropped(), undefined)
offerDropped({ files: new Map(), stages: [] })
assert.equal(notified, 1, 'the page tab observes every offered drop')
assert.deepEqual(takePendingDropped(), { files: new Map(), stages: [] })
assert.equal(takePendingDropped(), undefined, 'a drop is consumed once')
unsubscribe()

// ── the sidebar listener ────────────────────────────────────────────────────
/** A minimal element: attributes, style and removal are all the listener uses. */
function fakeElement(name) {
  const attributes = new Map()
  const element = {
    name,
    nodeType: 1,
    style: {},
    textContent: '',
    id: '',
    children: [],
    setAttribute(key, value) { attributes.set(key, String(value)) },
    removeAttribute(key) { attributes.delete(key) },
    getAttribute(key) { return attributes.get(key) },
    hasAttribute(key) { return attributes.has(key) },
    matches(selector) { return selector === SIDEBAR_PANEL_SELECTOR && name === 'panel' },
    appendChild(child) {
      child.parent = this
      this.children.push(child)
    },
    remove() {
      this.removed = true
      if (this.parent !== undefined) this.parent.children = this.parent.children.filter(child => child !== this)
    },
  }
  return element
}

function fakeDocument() {
  const listeners = new Map()
  const panel = fakeElement('panel')
  const head = fakeElement('head')
  const body = fakeElement('body')
  const ids = new Map()
  const doc = {
    head,
    body,
    addEventListener(type, callback) {
      const set = listeners.get(type) ?? new Set()
      set.add(callback)
      listeners.set(type, set)
    },
    removeEventListener(type, callback) {
      listeners.get(type)?.delete(callback)
    },
    getElementById(id) { return ids.get(id) ?? null },
    createElement(tag) {
      if (tag === 'style') {
        const style = fakeElement('style')
        ids.set('dsh-usd-3d-preview-drop-style', style)
        return style
      }
      return fakeElement(tag)
    },
    emit(type, event) {
      for (const callback of listeners.get(type) ?? []) callback(event)
    },
    listenerCount(type) { return listeners.get(type)?.size ?? 0 },
  }
  return { doc, panel, body }
}

function dragEvent(dataTransfer, path) {
  const event = {
    dataTransfer,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { event.defaultPrevented = true },
    stopPropagation() { event.propagationStopped = true },
    composedPath: () => path,
  }
  return event
}

const { doc, panel, body } = fakeDocument()
const opened = []
const stop = watchSidebarDrops({
  openTab: () => opened.push('usd'),
  hintText: () => 'drop to open',
  document: doc,
  window: { addEventListener() {}, removeEventListener() {} },
})

// A USD drag over the panel is claimed, highlighted, and survives as a drop.
const transfer = { items: [usdItem], files: [stageFile] }
const over = dragEvent(transfer, [panel, doc.body])
doc.emit('dragover', over)
assert.equal(over.defaultPrevented, true, 'the sidebar must accept the drop')
assert.equal(over.propagationStopped, true, 'the composer must not also claim the drag')
assert.equal(panel.getAttribute('data-usd-drop-active'), 'true')
assert.equal(panel.getAttribute('data-usd-drop-hint'), 'drop to open')
assert.equal(body.children.length, 1, 'the drag shows one overlay hint')

const drop = dragEvent(transfer, [panel, doc.body])
doc.emit('drop', drop)
assert.equal(drop.defaultPrevented, true)
assert.equal(drop.propagationStopped, true)
await tick()
assert.deepEqual(opened, ['usd'], 'the drop opens the preview page tab')
const offered = takePendingDropped()
assert.ok(offered !== undefined, 'the dropped files are handed to the page tab')
assert.deepEqual(offered.stages, ['root.usda'])
assert.equal(panel.hasAttribute('data-usd-drop-active'), false, 'the highlight ends with the drop')
assert.equal(body.children.length, 0, 'the overlay hint is removed with the drop')

// A drag the preview does not open is left to the shell untouched.
const pdfOver = dragEvent({ items: [pdfItem], files: [new File(['x'], 'doc.pdf')] }, [panel, doc.body])
doc.emit('dragover', pdfOver)
assert.equal(pdfOver.defaultPrevented, false)
assert.equal(pdfOver.propagationStopped, false)
assert.equal(panel.hasAttribute('data-usd-drop-active'), false)

// A drag over a different part of the page is not the sidebar's business.
const outside = dragEvent(transfer, [doc.head])
doc.emit('dragover', outside)
assert.equal(outside.defaultPrevented, false)

stop()
assert.equal(doc.listenerCount('drop'), 0, 'the effect owns every listener it installed')
assert.equal(doc.listenerCount('dragover'), 0)
assert.equal(panel.hasAttribute('data-usd-drop-active'), false)

process.stdout.write('drop.test.mjs  OK  (collection, normalisation, sidebar drop ownership)\n')
