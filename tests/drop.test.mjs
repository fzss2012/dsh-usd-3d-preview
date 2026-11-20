/**
 * The external-asset path without a browser: what a drop collects, which reader
 * opens each model it carries, how a text layer is normalised for the engine, and
 * how the sidebar listener decides a drag belongs to this preview.
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
  defaultModel,
  dropKey,
  isModelName,
  isUsdName,
  modelCandidates,
  modelKindOf,
  normalizeLayer,
  offerDropped,
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

// An IFC model is the other format the same door opens: one file, other reader.
assert.equal(isModelName('model.ifc'), true)
assert.equal(isModelName('MODEL.IFCZIP'), true, 'the suffix check is case-insensitive')
assert.equal(isModelName('root.usda'), true)
assert.equal(isModelName('record.json'), false)
assert.equal(modelKindOf('pkg/model.ifc'), 'ifc')
assert.equal(modelKindOf('pkg/model.ifczip'), 'ifc')
assert.equal(modelKindOf('pkg/root.usda'), 'usd')

assert.equal(dropKey('./a/b.usda'), 'a/b.usda')
assert.equal(dropKey('pkg\\geom\\body.usda'), 'pkg/geom/body.usda')

// ── model ordering: the shallowest model is the one opened first ────────────
const files = new Map([
  ['pkg/geom/body.usda', new Blob(['x'])],
  ['pkg/root.usda', new Blob(['x'])],
  ['pkg/Tex/a.png', new Blob(['x'])],
])
assert.deepEqual(modelCandidates(files), [
  { key: 'pkg/root.usda', kind: 'usd' },
  { key: 'pkg/geom/body.usda', kind: 'usd' },
])
// The referenced layer sits deeper than the root, so the root opens unasked.
assert.equal(defaultModel(modelCandidates(files)), 'pkg/root.usda')

// A model dropped beside a USD asset is offered too, and the ordering stays
// stable: depth first, then the USD layer before the model at the same depth.
const mixed = new Map([
  ...files,
  ['pkg/model.ifc', new Blob(['x'])],
])
assert.deepEqual(modelCandidates(mixed), [
  { key: 'pkg/root.usda', kind: 'usd' },
  { key: 'pkg/model.ifc', kind: 'ifc' },
  { key: 'pkg/geom/body.usda', kind: 'usd' },
])
// Two models at the shallowest depth are a choice, not a guess.
assert.equal(defaultModel(modelCandidates(mixed)), undefined)
assert.equal(defaultModel([{ key: 'a.usd', kind: 'usd' }, { key: 'b.usd', kind: 'usd' }]), undefined)
assert.equal(defaultModel([{ key: 'a.ifc', kind: 'ifc' }]), 'a.ifc')
assert.equal(defaultModel([]), undefined)

// ── a text layer loses its BOM and a custom instancer type ───────────────────
// The signature is PointInstancer's own: `protoIndices` plus a placement
// (`positions`) or the `prototypes` relationship. A prim carrying only
// `protoIndices` is not an instancer, which is what keeps a custom grouping prim
// from being promoted and hiding the hierarchy under it (see instancer.test.mjs).
const custom = '#usda 1.0\ndef Grid "row" {\n    int[] protoIndices = [0]\n    point3f[] positions = [(0, 0, 0)]\n}\n'
const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode(custom)])
const normalised = await normalizeLayer('root.usda', new Blob([bom]))
const text = decoder.decode(new Uint8Array(await normalised.arrayBuffer()))
assert.equal(text.startsWith('\ufeff'), false, 'the BOM must be stripped before the engine reads the layer')
assert.ok(text.includes('def PointInstancer "row"'), 'a custom-typed instancer must be retyped')

// A package is bytes, not text: it must be handed over untouched.
const packageBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x01, 0x02])
const packageBlob = new Blob([packageBytes])
assert.equal(await normalizeLayer('scene.usdz', packageBlob), packageBlob)

// An IFC model is not a text layer to rewrite: the schema reader gets its bytes
// as they were dropped, even though a STEP file is ASCII.
const ifcBlob = new Blob([encoder.encode('ISO-10303-21;\nHEADER;\nFILE_SCHEMA((\'IFC4\'));\n')])
assert.equal(await normalizeLayer('model.ifc', ifcBlob), ifcBlob)

// ── collection from a picker (no directory entries) ─────────────────────────
const stageFile = new File([encoder.encode('#usda 1.0\ndef Xform "root" {}\n')], 'root.usda', { type: 'text/plain' })
const modelFile = new File([encoder.encode('ISO-10303-21;\nHEADER;\n')], 'model.ifc', { type: 'text/plain' })
const textureFile = new File([new Uint8Array([1, 2, 3])], 'tex.png')
const collected = await collectDropped({ files: [stageFile, modelFile, textureFile] })
assert.deepEqual([...collected.files.keys()], ['root.usda', 'model.ifc', 'tex.png'])
assert.deepEqual(collected.models, [
  { key: 'root.usda', kind: 'usd' },
  { key: 'model.ifc', kind: 'ifc' },
], 'the stage and the model are offered to open, the texture is not')

const emptyDrop = await collectDropped({ files: [] })
assert.equal(emptyDrop.models.length, 0)

// ── what counts as this preview's drag ──────────────────────────────────────
const usdItem = { kind: 'file', getAsFile: () => stageFile }
const ifcItem = { kind: 'file', getAsFile: () => modelFile }
const pdfItem = { kind: 'file', getAsFile: () => new File(['x'], 'doc.pdf') }
const folderItem = { kind: 'file', webkitGetAsEntry: () => ({ isDirectory: true, isFile: false, name: 'pkg' }) }
assert.equal(acceptsDroppedAsset({ items: [usdItem] }), true)
assert.equal(acceptsDroppedAsset({ items: [ifcItem] }), true, 'an IFC model is this preview\'s drop too')
assert.equal(acceptsDroppedAsset({ items: [pdfItem] }), false, 'a PDF keeps the shell attachment path')
assert.equal(acceptsDroppedAsset({ items: [folderItem] }), true, 'a folder may hold a stage or a model')
assert.equal(acceptsDroppedAsset(undefined), false)

// ── the pending hand-off ────────────────────────────────────────────────────
let notified = 0
const unsubscribe = subscribeDropped(() => { notified += 1 })
assert.equal(takePendingDropped(), undefined)
offerDropped({ files: new Map(), models: [] })
assert.equal(notified, 1, 'the page tab observes every offered drop')
assert.deepEqual(takePendingDropped(), { files: new Map(), models: [] })
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
assert.deepEqual(offered.models, [{ key: 'root.usda', kind: 'usd' }])

// A model dragged over the panel is claimed the same way and opens the same tab:
// the sidebar is the drop's owner for both formats, and the page tab decides
// which reader mounts.
const ifcTransfer = { items: [ifcItem], files: [modelFile] }
const ifcOver = dragEvent(ifcTransfer, [panel, doc.body])
doc.emit('dragover', ifcOver)
assert.equal(ifcOver.defaultPrevented, true, 'a dropped IFC model must not become a chat attachment')
assert.equal(panel.getAttribute('data-usd-drop-active'), 'true')
const ifcDrop = dragEvent(ifcTransfer, [panel, doc.body])
doc.emit('drop', ifcDrop)
assert.equal(ifcDrop.defaultPrevented, true)
await tick()
assert.deepEqual(opened, ['usd', 'usd'], 'the same external-asset tab opens for a model')
const ifcOffered = takePendingDropped()
assert.ok(ifcOffered !== undefined, 'the dropped model reaches the page tab')
assert.deepEqual(ifcOffered.models, [{ key: 'model.ifc', kind: 'ifc' }])
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

process.stdout.write('drop.test.mjs  OK  (collection, model kinds, normalisation, sidebar drop ownership)\n')
