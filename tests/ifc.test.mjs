/**
 * IFC container, path and structure helpers, offline — no browser, no worker.
 *
 * The reader itself is a WASM module in a worker, so what can be proven without a
 * browser is everything around it: that the container is decided by the bytes
 * rather than by the extension, that the element paths are stable and unambiguous,
 * and that the flat structure the worker reports turns into the tree the panels
 * draw. Those are exactly the parts a reader bug would not catch, and they are the
 * parts a refactor is most likely to break silently.
 *
 * Run: node tests/ifc.test.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BINARY_IFC_EXTENSIONS,
  IFC_EXTENSIONS,
  IFC_PREVIEW_ID,
  ifcDefinition,
  ifcFormatOf,
  ifcHeaderSchema,
  ifcHeaderText,
  ifcLengthUnitLabel,
  ifcPathOf,
  ifcPathSegment,
  ifcTypeLabel,
  ifcUnitDescription,
  ifczipRoot,
  isIfcName,
  uniqueSegment,
} from '../src/client/ifc.js'
import { stepBytesOf, structureToPaths } from '../src/client/ifc-engine.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fixtures = join(root, 'tests', 'fixtures')
const encoder = new TextEncoder()

/** One STEP prologue, as an .ifc file starts. */
const PROLOGUE = encoder.encode("ISO-10303-21;\nHEADER;\nFILE_SCHEMA(('IFC4'));\nENDSEC;\nDATA;\nENDSEC;\nEND-ISO-10303-21;\n")

// ── the registry definition ─────────────────────────────────────────────────
const definition = ifcDefinition(() => 'IFC 3D preview')
assert.equal(definition.id, IFC_PREVIEW_ID)
assert.equal(definition.id, 'dsh-usd-3d-preview/ifc', 'the id is the document-slot key')
assert.deepEqual([...definition.extensions], ['ifc', 'ifczip'])
assert.deepEqual([...definition.binaryExtensions], ['ifczip'])
for (const extension of definition.binaryExtensions) {
  assert.ok(definition.extensions.includes(extension), `binary suffix "${extension}" is not claimed`)
}
// An .ifc is ASCII STEP: declaring it binary would remove the text fallback from a
// file a user may legitimately want to read as source.
assert.equal(BINARY_IFC_EXTENSIONS.includes('ifc'), false, 'a STEP file must stay readable as text')
assert.notEqual(definition.priority, 'builtin', 'a product viewer must not silently take the suffix')
assert.equal(definition.loading, 'bytes-complete', 'a model is read whole, not streamed')
assert.equal(definition.wrap, false)
assert.equal(definition.title(), 'IFC 3D preview')
assert.deepEqual([...IFC_EXTENSIONS], ['ifc', 'ifczip'])

// ── container detection: the bytes decide, never the extension ──────────────
assert.equal(ifcFormatOf(PROLOGUE), 'ifc', 'a STEP prologue is an IFC file')
assert.equal(ifcFormatOf(encoder.encode('\uFEFF' + new TextDecoder().decode(PROLOGUE))), 'ifc', 'a UTF-8 BOM is tolerated')
// A zip package is an IFCZIP whatever it is called.
const zip = new Uint8Array([0x50, 0x4B, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00])
assert.equal(ifcFormatOf(zip), 'ifczip')
assert.equal(ifcFormatOf(new Uint8Array([0x50, 0x4B, 0x05, 0x06])), 'ifczip', 'an empty archive is still a zip')
// Anything else is not ours: a USD layer, a PDF, a JPEG, a text file.
assert.equal(ifcFormatOf(encoder.encode('#usda 1.0\n')), undefined, 'a USD layer is not an IFC file')
assert.equal(ifcFormatOf(encoder.encode('%PDF-1.7\n')), undefined)
assert.equal(ifcFormatOf(new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0])), undefined)
assert.equal(ifcFormatOf(encoder.encode('hello')), undefined)
assert.equal(ifcFormatOf(undefined), undefined)
assert.equal(ifcFormatOf(new Uint8Array(0)), undefined)

// ── names and suffixes ──────────────────────────────────────────────────────
assert.equal(isIfcName('model.ifc'), true)
assert.equal(isIfcName('MODEL.IFC'), true, 'the suffix is case-insensitive')
assert.equal(isIfcName('dir/model.ifczip'), true)
assert.equal(isIfcName('model.usda'), false)
assert.equal(isIfcName('ifc'), false, 'a name with no dot has no suffix')
assert.equal(isIfcName(''), false)

// ── the schema the header declares ──────────────────────────────────────────
const headerText = ifcHeaderText(PROLOGUE)
assert.equal(ifcHeaderSchema(headerText), 'IFC4')
assert.equal(ifcHeaderSchema("FILE_SCHEMA(('IFC2X3'));"), 'IFC2X3')
assert.equal(ifcHeaderSchema("FILE_SCHEMA(( 'IFC4X3' ));"), 'IFC4X3', 'whitespace inside the header is not significant')
assert.equal(ifcHeaderSchema('no header here'), undefined)
// A BOM in front of the prologue must not hide the header.
assert.equal(ifcHeaderSchema(ifcHeaderText(encoder.encode('\uFEFFFILE_SCHEMA((\'IFC4\'));'))), 'IFC4')

// ── IFCZIP: the root model is the shallowest .ifc member ────────────────────
assert.equal(ifczipRoot({ 'model.ifc': 1 }), 'model.ifc')
assert.equal(ifczipRoot({ 'deep/model.ifc': 1, 'root.ifc': 1 }), 'root.ifc', 'the shallowest member is the root')
assert.equal(ifczipRoot({ 'b/model.ifc': 1, 'a/model.ifc': 1 }), 'a/model.ifc', 'a tie is broken by name, stably')
assert.equal(ifczipRoot({ 'readme.txt': 1 }), undefined, 'a package with no model is reported, not guessed')
assert.equal(ifczipRoot({}), undefined)

// ── units ───────────────────────────────────────────────────────────────────
assert.equal(ifcLengthUnitLabel('MILLI', 'METRE'), 'mm')
assert.equal(ifcLengthUnitLabel('', 'METRE'), 'm')
assert.equal(ifcLengthUnitLabel('CENTI', 'METRE'), 'cm')
assert.equal(ifcLengthUnitLabel('KILO', 'METRE'), 'km')
assert.equal(ifcLengthUnitLabel('', 'FOOT'), 'ft')
assert.equal(ifcLengthUnitLabel('', 'INCH'), 'in')
assert.equal(ifcLengthUnitLabel(undefined, undefined), '')
// Only a non-metre unit is worth a line in the stats: a metre model already reads
// in the numbers it shows.
assert.equal(ifcUnitDescription('m'), '')
assert.equal(ifcUnitDescription(''), '')
assert.equal(ifcUnitDescription('mm'), 'mm')

// ── path segments: a name that a path can hold ──────────────────────────────
assert.equal(ifcPathSegment('Wall', 57, 'IfcWall'), 'Wall')
assert.equal(ifcPathSegment('  Wall  ', 57, 'IfcWall'), 'Wall', 'a name is trimmed')
assert.equal(ifcPathSegment('Wall/1', 57, 'IfcWall'), 'Wall_1', 'a slash in a name cannot become a path level')
assert.equal(ifcPathSegment('', 57, 'IfcWall'), 'IfcWall #57', 'an unnamed product is still addressable')
assert.equal(ifcPathSegment(undefined, 57, undefined), 'IfcProduct #57')
assert.equal(ifcPathSegment('Level 1', 35, 'IfcBuildingStorey'), 'Level 1', 'a space survives')

// Two siblings with the same name are two products, and a tree that shows two
// identical leaves makes a click ambiguous.
const taken = new Set()
assert.equal(uniqueSegment('Wall', 57, taken), 'Wall')
assert.equal(uniqueSegment('Wall', 58, taken), 'Wall #58', 'a collision carries the express ID')
assert.equal(uniqueSegment('Wall', 59, taken), 'Wall #59')
assert.equal(uniqueSegment('Slab', 60, taken), 'Slab', 'a different name is unaffected')

// ── full paths ──────────────────────────────────────────────────────────────
assert.equal(ifcPathOf(['Site', 'Building', 'Level 1', 'Wall']), '/Site/Building/Level 1/Wall')
assert.equal(ifcPathOf([]), '/')
assert.equal(ifcPathOf(['Site', '', 'Wall']), '/Site/Wall', 'an empty segment is not a level')

// ── the type label ──────────────────────────────────────────────────────────
assert.equal(ifcTypeLabel('IfcWallStandardCase'), 'IfcWallStandardCase', 'the schema spelling is kept as-is')
assert.equal(ifcTypeLabel('  IfcWall  '), 'IfcWall', 'a padded name is trimmed')
// An all-caps type code has no word boundaries to recover, so it must not be
// "helpfully" lowercased into something that is neither the code nor the name.
assert.equal(ifcTypeLabel('IFCWALLSTANDARDCASE'), 'IFCWALLSTANDARDCASE')
assert.equal(ifcTypeLabel(''), '')
assert.equal(ifcTypeLabel(undefined), '')

// ── the flat structure becomes a tree ───────────────────────────────────────
// The shape the worker reports: one record per element, naming its parent.
const structure = [
  { expressID: 31, parentID: -1, type: 'IfcSite', name: 'Site', globalId: 'g31', objectType: '' },
  { expressID: 33, parentID: 31, type: 'IfcBuilding', name: 'Building', globalId: 'g33', objectType: '' },
  { expressID: 35, parentID: 33, type: 'IfcBuildingStorey', name: 'Level 1', globalId: 'g35', objectType: '' },
  { expressID: 57, parentID: 35, type: 'IfcWallStandardCase', name: 'Wall', globalId: 'g57', objectType: '' },
  { expressID: 58, parentID: 35, type: 'IfcWallStandardCase', name: 'Wall', globalId: 'g58', objectType: '' },
  { expressID: 60, parentID: 35, type: 'IfcSlab', name: '', globalId: 'g60', objectType: 'Floor' },
]
const built = structureToPaths(structure)
assert.equal(built.rows.length, structure.length, 'every element gets a row')
assert.equal(built.paths.get(31), '/Site')
assert.equal(built.paths.get(33), '/Site/Building')
assert.equal(built.paths.get(35), '/Site/Building/Level 1')
assert.equal(built.paths.get(57), '/Site/Building/Level 1/Wall')
assert.equal(built.paths.get(58), '/Site/Building/Level 1/Wall #58', 'a sibling collision is disambiguated')
assert.equal(built.paths.get(60), '/Site/Building/Level 1/IfcSlab #60', 'an unnamed element is named by type and id')
// The rows carry the same facts the tree needs, plus the type for the details panel.
const wall = built.rows.find(row => row.expressID === 57)
assert.equal(wall.type, 'IfcWallStandardCase')
assert.equal(wall.globalId, 'g57')
assert.equal(wall.path, built.paths.get(57))

// A node whose parent is missing is a root of its own rather than disappearing: an
// unreferenced product still has geometry on screen.
const orphaned = structureToPaths([
  { expressID: 1, parentID: -1, type: 'IfcSite', name: 'Site', globalId: '', objectType: '' },
  { expressID: 9, parentID: 404, type: 'IfcWall', name: 'Loose', globalId: '', objectType: '' },
])
assert.equal(orphaned.paths.get(9), '/Loose', 'an orphan is a root, not a lost row')

// A cycle in the relation graph is malformed data, not a reason to hang.
const cyclic = structureToPaths([
  { expressID: 1, parentID: 2, type: 'IfcSite', name: 'A', globalId: '', objectType: '' },
  { expressID: 2, parentID: 1, type: 'IfcBuilding', name: 'B', globalId: '', objectType: '' },
])
assert.equal(cyclic.rows.length, 2, 'a cycle still produces one row per element')
assert.ok(cyclic.paths.get(1).startsWith('/') && cyclic.paths.get(2).startsWith('/'), 'a cycle still produces paths')

// The root of an IFC model is an `IfcProject`, which is an `IfcObjectDefinition`
// but NOT an `IfcProduct`. A structure walk driven from products alone therefore
// starts below the project and loses the whole site/building/storey chain — which
// is exactly the bug the committed `building.ifc` fixture caught, so the shape is
// pinned here as data too.
const withProject = structureToPaths([
  { expressID: 20, parentID: -1, type: 'IfcProject', name: 'Hello Wall', globalId: 'g20', objectType: '' },
  { expressID: 31, parentID: 20, type: 'IfcSite', name: 'Site', globalId: 'g31', objectType: '' },
  { expressID: 35, parentID: 31, type: 'IfcBuildingStorey', name: 'Level 0', globalId: 'g35', objectType: '' },
  { expressID: 222, parentID: 35, type: 'IfcWallStandardCase', name: 'South Wall', globalId: 'g222', objectType: '' },
])
assert.equal(withProject.paths.get(20), '/Hello Wall', 'the project is the root of the tree')
assert.equal(withProject.paths.get(35), '/Hello Wall/Site/Level 0', 'the storey keeps its full ancestry')
assert.equal(withProject.paths.get(222), '/Hello Wall/Site/Level 0/South Wall')

// ── the committed fixtures ──────────────────────────────────────────────────
const helloWall = new Uint8Array(await readFile(join(fixtures, 'ifc', 'hello-wall.ifc')))
assert.equal(ifcFormatOf(helloWall), 'ifc', 'the committed fixture is a STEP file')
assert.equal(ifcHeaderSchema(ifcHeaderText(helloWall)), 'IFC4', 'the committed fixture declares IFC4')
assert.ok(helloWall.byteLength > 1000, 'the committed fixture is a real file')

// The multi-storey fixture: a real spatial tree, several element types, colours,
// property sets and a mm unit — the case the render suite draws.
const building = new Uint8Array(await readFile(join(fixtures, 'ifc', 'building.ifc')))
assert.equal(ifcFormatOf(building), 'ifc', 'the building fixture is a STEP file')
assert.equal(ifcHeaderSchema(ifcHeaderText(building)), 'IFC4')
// The unit is what makes "why is the slab 8 wide" answerable: the file is in mm
// and web-ifc converts on the way in.
assert.ok(/IFCSIUNIT\(\*,\.LENGTHUNIT\.,\.MILLI\.,\.METRE\.\)/.test(ifcHeaderText(building) + new TextDecoder().decode(building)), 'the building fixture authors millimetres')

// A file that is not an IFC at all must be reported as such rather than parsed:
// this is the negative case the preview's failure state is for.
const notIfc = new Uint8Array(await readFile(join(fixtures, 'ifc', 'not-ifc.ifc')))
assert.equal(ifcFormatOf(notIfc), undefined, 'a non-STEP file with an .ifc name is not an IFC model')
// The extension alone is never the answer, which is why the preview sniffs bytes.
assert.equal(isIfcName('not-ifc.ifc'), true, 'the name looks like an IFC file; only the bytes decide')

// ── stepBytesOf: the container is unwrapped on the page, not in the worker ───
// A STEP file passes through untouched: the worker is handed exactly the bytes
// the Host delivered, so nothing is copied for the common case.
assert.equal(stepBytesOf(helloWall), helloWall, 'a STEP file is handed over as-is')
// A package is unwrapped, and the root model is the shallowest .ifc member.
const zipped = zipOf({ 'readme.txt': encoder.encode('notes'), 'model.ifc': helloWall })
const unwrapped = stepBytesOf(zipped)
assert.ok(unwrapped instanceof Uint8Array)
assert.deepEqual([...unwrapped.subarray(0, 12)], [...helloWall.subarray(0, 12)], 'the root model comes out')
assert.equal(unwrapped.byteLength, helloWall.byteLength)
// A package holding no model is reported rather than handed on as bytes.
assert.throws(
  () => stepBytesOf(zipOf({ 'readme.txt': encoder.encode('notes') })),
  /holds no \.ifc model/,
  'an IFCZIP with no model must be refused',
)
// A file that is neither is refused with a message a reader can act on — and the
// refusal names the declared schema when the header has one, because that is what
// makes "wrong container" distinguishable from "corrupt file".
assert.throws(() => stepBytesOf(notIfc), /not an IFC model/, 'prose behind an .ifc name is refused')
assert.throws(
  () => stepBytesOf(encoder.encode("%PDF-1.7\nFILE_SCHEMA(('IFC4'));\n")),
  /not a STEP file, although its header declares IFC4/,
  'a header that declares a schema on a non-STEP file is reported honestly',
)

process.stdout.write('ifc.test.mjs  OK  (container, paths, structure, units, fixtures, packages)\n')

/**
 * Build a zip archive from a name → bytes map.
 *
 * The test writes its own archive rather than committing a binary fixture, so the
 * IFCZIP case is readable in the diff and does not need a zip tool to regenerate.
 * @param entries - file name to contents.
 * @returns the archive bytes.
 */
function zipOf(entries) {
  const locals = []
  const central = []
  let offset = 0
  for (const [name, data] of Object.entries(entries)) {
    const nameBytes = encoder.encode(name)
    const crc = crc32(data)
    const local = new Uint8Array(30 + nameBytes.length + data.length)
    const localView = new DataView(local.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(6, 0, true)
    localView.setUint16(8, 0, true) // stored, no compression
    localView.setUint32(14, crc, true)
    localView.setUint32(18, data.length, true)
    localView.setUint32(22, data.length, true)
    localView.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    local.set(data, 30 + nameBytes.length)
    locals.push(local)

    const entry = new Uint8Array(46 + nameBytes.length)
    const entryView = new DataView(entry.buffer)
    entryView.setUint32(0, 0x02014b50, true)
    entryView.setUint16(4, 20, true)
    entryView.setUint16(6, 20, true)
    entryView.setUint32(16, crc, true)
    entryView.setUint32(20, data.length, true)
    entryView.setUint32(24, data.length, true)
    entryView.setUint16(28, nameBytes.length, true)
    entryView.setUint32(42, offset, true)
    entry.set(nameBytes, 46)
    central.push(entry)
    offset += local.length
  }
  const centralSize = central.reduce((sum, entry) => sum + entry.length, 0)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, central.length, true)
  endView.setUint16(10, central.length, true)
  endView.setUint32(12, centralSize, true)
  endView.setUint32(16, offset, true)
  const parts = [...locals, ...central, end]
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) { out.set(part, at); at += part.length }
  return out
}

/** The CRC-32 a stored zip entry carries. */
function crc32(bytes) {
  let crc = 0xFFFFFFFF
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1))
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}
