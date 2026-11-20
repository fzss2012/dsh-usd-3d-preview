/**
 * The IFC reader worker.
 *
 * A STEP file is a schema-aware parse of tens of megabytes followed by geometry
 * kernel work per product, which on the page thread is a frozen sidebar. This
 * worker owns the web-ifc WASM module for the life of the page and answers two
 * requests: read a model, and describe one element.
 *
 * ## Why this file is a real module
 *
 * `build.mjs` bundles it (with web-ifc inlined) into `ifc-assets.generated.js`
 * as base64, so the page never fetches a second file and the worker never fetches
 * the WASM binary over the network — the engine ships inside the plugin bundle,
 * the same arrangement the USD engine uses.
 *
 * ## What it sends back
 *
 * Geometry, never objects: world-space `Float32Array` positions and normals plus
 * `Uint32Array` indices per placed geometry, transferred rather than copied. The
 * placement transform is applied here so the page's graph is flat — which is what
 * makes picking, framing and the stats line agree with what is drawn.
 *
 * ## Coordinates
 *
 * IFC is Z-up and three is Y-up. web-ifc's `flatTransformation` already folds that
 * rotation in (and the file's length unit with it), so applying the matrix is the
 * whole conversion — see {@link geometryOf}, which is where that fact is pinned.
 * The studio rig then sees the same Y-up frame a USD stage composes into and both
 * previews frame a model identically.
 *
 * @module dsh-usd-3d-preview/ifc-worker
 */
import {
  IfcAPI,
  IFCRELDEFINESBYPROPERTIES,
  IFCRELAGGREGATES,
  IFCRELCONTAINEDINSPATIALSTRUCTURE,
  IFCRELVOIDSELEMENT,
  IFCELEMENTQUANTITY,
  IFCOBJECTDEFINITION,
  IFCPROJECT,
  IFCPROPERTYSET,
  IFCSIUNIT,
  IFCUNITASSIGNMENT,
} from 'web-ifc'

/** The one IfcAPI this worker owns; the WASM module outlives every model. */
let apiPromise

/**
 * Instantiate the engine once per worker.
 *
 * The WASM binary arrives as a blob URL in `__DSH_IFC_WASM_URL__`, set by the
 * bootstrap (`ifc-worker-boot.js`) after it inflates the embedded payload, so no
 * network request is made. Single-threaded on purpose: the multi-threaded build
 * needs cross-origin isolation (COOP/COEP) that the shell's page does not set,
 * and it is not worth a deployment requirement for a preview.
 * @returns the initialised IfcAPI.
 */
function apiOf() {
  if (apiPromise === undefined) {
    apiPromise = (async () => {
      const instance = new IfcAPI()
      await instance.Init(() => globalThis.__DSH_IFC_WASM_URL__, true)
      return instance
    })()
  }
  return apiPromise
}

/**
 * One placed geometry, transformed into world space.
 *
 * ## The axis convention, which is not the one the IFC spec describes
 *
 * IFC is Z-up, and `PlacedGeometry.flatTransformation` is documented as the
 * placement matrix. It is more than that: web-ifc **already folds the Z-up → Y-up
 * rotation into it**, so applying it is the whole conversion and a second rotation
 * on top would lay the model on its side. That was this module's first bug — a
 * 5 × 3 × 0.2 m wall measured 5 × 0.2 × 3 — so the fact is pinned by the render
 * suite's size assertion rather than left to a comment.
 *
 * The matrix also carries the file's length unit (a millimetre model's 0.001
 * scale), which is why the page never sees a raw file unit either.
 * @param instance - the initialised IfcAPI.
 * @param modelID - the open model.
 * @param placement - one `PlacedGeometry` record.
 * @returns positions, normals and indices, or undefined for an empty item.
 */
function geometryOf(instance, modelID, placement) {
  const geometry = instance.GetGeometry(modelID, placement.geometryExpressID)
  if (geometry === undefined || geometry === null) return undefined
  try {
    const vertexData = instance.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize())
    const indexData = instance.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize())
    if (vertexData.length === 0 || indexData.length === 0) return undefined
    const count = vertexData.length / 6
    const positions = new Float32Array(count * 3)
    const normals = new Float32Array(count * 3)
    // Column-major: m[0..3] is the first column. Applying it here is what makes
    // the page-side graph flat, so nothing there has to know a placement existed.
    const m = placement.flatTransformation
    for (let vertex = 0; vertex < count; vertex += 1) {
      const base = vertex * 6
      const x = vertexData[base]
      const y = vertexData[base + 1]
      const z = vertexData[base + 2]
      positions[vertex * 3] = m[0] * x + m[4] * y + m[8] * z + m[12]
      positions[vertex * 3 + 1] = m[1] * x + m[5] * y + m[9] * z + m[13]
      positions[vertex * 3 + 2] = m[2] * x + m[6] * y + m[10] * z + m[14]
      // A normal is a direction: rotate it, never translate it. IFC placements
      // are rigid, so no inverse-transpose is needed.
      const nx = vertexData[base + 3]
      const ny = vertexData[base + 4]
      const nz = vertexData[base + 5]
      normals[vertex * 3] = m[0] * nx + m[4] * ny + m[8] * nz
      normals[vertex * 3 + 1] = m[1] * nx + m[5] * ny + m[9] * nz
      normals[vertex * 3 + 2] = m[2] * nx + m[6] * ny + m[10] * nz
    }
    return { positions, normals, indices: new Uint32Array(indexData) }
  } finally {
    geometry.delete()
  }
}

/**
 * Read every product's geometry, in world space.
 * @param instance - the initialised IfcAPI.
 * @param modelID - the open model.
 * @returns the placed geometries and the counts the stats line reports.
 */
function readGeometry(instance, modelID) {
  const parts = []
  let triangles = 0
  let vertices = 0
  instance.StreamAllMeshes(modelID, (mesh) => {
    const placed = mesh.geometries
    for (let index = 0; index < placed.size(); index += 1) {
      const placement = placed.get(index)
      const read = geometryOf(instance, modelID, placement)
      if (read === undefined) continue
      const color = placement.color
      parts.push({
        expressID: mesh.expressID,
        positions: read.positions,
        normals: read.normals,
        indices: read.indices,
        color: [color.x, color.y, color.z],
        hasColor: placement.hasColor === true,
        opacity: typeof color.w === 'number' ? color.w : 1,
      })
      triangles += read.indices.length / 3
      vertices += read.positions.length / 3
    }
  })
  return { parts, triangles: Math.round(triangles), vertices }
}

/**
 * Read one line without inverse attributes.
 *
 * Inverses are what makes `GetLine` expensive on a large model: they walk the
 * whole reference index for the line. Every read here wants the line's own
 * attributes, so the flag stays off and the inverse lookups that are actually
 * needed (a property set's owning relation) go through the relation table.
 * @param instance - the initialised IfcAPI.
 * @param modelID - the open model.
 * @param expressID - the line to read.
 * @returns the line, or undefined when it cannot be read.
 */
function lineOf(instance, modelID, expressID) {
  try {
    return instance.GetLine(modelID, expressID, false)
  } catch {
    return undefined
  }
}

/** The IFC type name of one line, as web-ifc spells it. */
function typeNameOf(instance, line) {
  if (line === undefined || line === null) return 'IfcProduct'
  try {
    return instance.GetNameFromTypeCode(line.type)
  } catch {
    return 'IfcProduct'
  }
}

/** One `IfcLabel`-like value, or ''. */
function textOf(value) {
  return typeof value?.value === 'string' ? value.value : ''
}

/**
 * The IFC type name of one value wrapper (`IFCBOOLEAN`, `IFCREAL`, …).
 *
 * Unlike a select's `name`, this one is a plain string rather than a typed
 * wrapper, which is why it cannot go through {@link textOf}.
 * @param nominal - one property's `NominalValue`.
 * @returns the type name, or '' when the value carries none.
 */
function valueTypeOf(nominal) {
  return typeof nominal?.name === 'string' ? nominal.name : ''
}

/**
 * The spatial structure and the products inside it.
 *
 * IFC states containment two ways — an aggregation (`IfcRelAggregates`, used
 * between spatial elements) and a containment
 * (`IfcRelContainedInSpatialStructure`, used for products) — and a tree needs
 * both. The walk is driven from the relations rather than from each product's
 * `ContainedInStructure` inverse because the relations are the smaller set and
 * they carry the order the file authored.
 * @param instance - the initialised IfcAPI.
 * @param modelID - the open model.
 * @returns one record per element, each naming its parent's express ID.
 */
function readStructure(instance, modelID) {
  const nodes = []
  const seen = new Set()

  const push = (expressID, parentID) => {
    if (seen.has(expressID)) return
    seen.add(expressID)
    const line = lineOf(instance, modelID, expressID)
    nodes.push({
      expressID,
      parentID: parentID === undefined ? -1 : parentID,
      type: typeNameOf(instance, line),
      name: textOf(line?.Name),
      globalId: textOf(line?.GlobalId),
      objectType: textOf(line?.ObjectType),
    })
  }

  /** Children per parent, from both relation kinds. */
  const children = new Map()
  const hasParent = new Set()
  const link = (parentID, childID) => {
    if (typeof parentID !== 'number' || typeof childID !== 'number') return
    hasParent.add(childID)
    const list = children.get(parentID)
    if (list === undefined) children.set(parentID, [childID])
    else if (list.includes(childID) === false) list.push(childID)
  }
  const aggregates = instance.GetLineIDsWithType(modelID, IFCRELAGGREGATES)
  for (let index = 0; index < aggregates.size(); index += 1) {
    const relation = lineOf(instance, modelID, aggregates.get(index))
    if (relation === undefined) continue
    for (const child of relation.RelatedObjects ?? []) link(relation.RelatingObject?.value, child?.value)
  }
  const contains = instance.GetLineIDsWithType(modelID, IFCRELCONTAINEDINSPATIALSTRUCTURE)
  for (let index = 0; index < contains.size(); index += 1) {
    const relation = lineOf(instance, modelID, contains.get(index))
    if (relation === undefined) continue
    for (const child of relation.RelatedElements ?? []) link(relation.RelatingStructure?.value, child?.value)
  }
  // A void is a third kind of edge, and without it every `IfcOpeningElement` — a
  // product no aggregate or containment reaches — would land as a root beside the
  // project, which reads as a second building. `IfcRelVoidsElement` says the
  // opening is cut out of one element, so it is shown under that element.
  const voids = instance.GetLineIDsWithType(modelID, IFCRELVOIDSELEMENT)
  for (let index = 0; index < voids.size(); index += 1) {
    const relation = lineOf(instance, modelID, voids.get(index))
    if (relation === undefined) continue
    link(relation.RelatingBuildingElement?.value, relation.RelatedOpeningElement?.value)
  }

  // Every object the file declares is a node, whether or not a relation reaches
  // it: an unreferenced product still has geometry and must stay reachable.
  //
  // The type asked for is `IfcObjectDefinition`, not `IfcProduct`: the root of an
  // IFC model is an `IfcProject`, which is an object definition but *not* a
  // product. Walking from products alone therefore starts below the project and
  // loses it — and with it the site/building/storey chain, because the storeys are
  // reached through the project. `IfcObjectDefinition` covers `IfcProject`,
  // `IfcSite`, `IfcBuilding`, `IfcBuildingStorey`, `IfcGroup` and every
  // `IfcProduct` in one pass.
  const objects = instance.GetLineIDsWithType(modelID, IFCOBJECTDEFINITION, true)
  for (let index = 0; index < objects.size(); index += 1) {
    const expressID = objects.get(index)
    if (hasParent.has(expressID) === false) push(expressID, undefined)
  }
  // Depth-first, so a child is always emitted after its parent.
  const walk = (parentID) => {
    for (const child of children.get(parentID) ?? []) {
      if (seen.has(child)) continue
      push(child, parentID)
      walk(child)
    }
  }
  for (const node of [...nodes]) walk(node.expressID)
  return nodes
}

/**
 * The model's length unit, as authored.
 *
 * web-ifc already converts every coordinate to metres before this plugin sees it
 * (its `applyLinearScalingFactor` default), so this describes the *file's* unit
 * rather than the scene's — which is what makes "why is this 5 and not 5000"
 * answerable from the panel.
 * @param instance - the initialised IfcAPI.
 * @param modelID - the open model.
 * @returns the SI prefix and unit name, or undefined when the model declares none.
 */
function readLengthUnit(instance, modelID) {
  const projects = instance.GetLineIDsWithType(modelID, IFCPROJECT)
  if (projects.size() === 0) return undefined
  const project = lineOf(instance, modelID, projects.get(0))
  const assignmentID = project?.UnitsInContext?.value
  const assignments = typeof assignmentID === 'number'
    ? [{ value: assignmentID }]
    : instance.GetLineIDsWithType(modelID, IFCUNITASSIGNMENT).size() > 0
      ? [{ value: instance.GetLineIDsWithType(modelID, IFCUNITASSIGNMENT).get(0) }]
      : []
  for (const assignment of assignments) {
    const line = lineOf(instance, modelID, assignment.value)
    if (line === undefined) continue
    for (const unit of line.Units ?? []) {
      const unitLine = lineOf(instance, modelID, unit?.value)
      if (unitLine === undefined) continue
      if (textOf(unitLine.UnitType).toUpperCase() !== 'LENGTHUNIT') continue
      return { prefix: textOf(unitLine.Prefix), name: textOf(unitLine.Name) }
    }
  }
  // A model with no assignment still has a unit: IFC's default is metres.
  const siUnits = instance.GetLineIDsWithType(modelID, IFCSIUNIT)
  for (let index = 0; index < siUnits.size(); index += 1) {
    const unitLine = lineOf(instance, modelID, siUnits.get(index))
    if (unitLine === undefined) continue
    if (textOf(unitLine.UnitType).toUpperCase() !== 'LENGTHUNIT') continue
    return { prefix: textOf(unitLine.Prefix), name: textOf(unitLine.Name) }
  }
  return undefined
}

/**
 * One property value, formatted for a panel.
 *
 * The value is a typed wrapper — `{ type, value }` — and the type is what makes
 * `IFCBOOLEAN` readable as a boolean rather than as the string "true". A value
 * that carries neither is reported as absent rather than as "undefined".
 * @param nominal - the `NominalValue` wrapper.
 * @returns the formatted value, or '' when the property has none.
 */
function propertyValue(nominal) {
  if (nominal === undefined || nominal === null) return ''
  const value = nominal.value
  if (value === undefined || value === null) return ''
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  if (typeof value === 'string') return value
  // A nested `IfcPropertySingleValue` wrapper (a select of a select).
  if (typeof value?.value === 'boolean') return value.value ? 'true' : 'false'
  if (typeof value?.value === 'number') return String(value.value)
  if (typeof value?.value === 'string') return value.value
  return ''
}

/**
 * The property sets and quantities defined on one element.
 *
 * A property set reaches its element through `IfcRelDefinesByProperties`, whose
 * `RelatedObjects` is the element list and whose `RelatingPropertyDefinition`
 * is the set — so the relation table is scanned once per model and indexed by
 * element, rather than per element on demand.
 * @param instance - the initialised IfcAPI.
 * @param modelID - the open model.
 * @param expressID - the element to describe.
 * @returns the property sets, in the order the file authored them.
 */
function readProperties(instance, modelID, expressID) {
  const sets = []
  const relations = instance.GetLineIDsWithType(modelID, IFCRELDEFINESBYPROPERTIES)
  for (let index = 0; index < relations.size(); index += 1) {
    const relation = lineOf(instance, modelID, relations.get(index))
    if (relation === undefined) continue
    const related = relation.RelatedObjects ?? []
    if (related.some(entry => entry?.value === expressID) === false) continue
    const definitionID = relation.RelatingPropertyDefinition?.value
    if (typeof definitionID !== 'number') continue
    const definition = lineOf(instance, modelID, definitionID)
    if (definition === undefined) continue
    const type = typeNameOf(instance, definition)
    const name = textOf(definition.Name)
    if (type === 'IfcPropertySet') {
      const properties = []
      for (const property of definition.HasProperties ?? []) {
        const line = lineOf(instance, modelID, property?.value)
        if (line === undefined) continue
        properties.push({
          name: textOf(line.Name),
          // The *value's* IFC type (IFCBOOLEAN, IFCREAL, IFCLABEL, …) is what a
          // reader wants beside a property, and it is authored on the value
          // wrapper as a plain string: `GetNameFromTypeCode` cannot name these
          // type codes and answers a placeholder, so the wrapper's own name is
          // used instead.
          type: valueTypeOf(line.NominalValue) || typeNameOf(instance, line),
          value: propertyValue(line.NominalValue),
          unit: textOf(line.Unit),
        })
      }
      sets.push({ name, kind: 'property', properties })
      continue
    }
    // An element quantity set: the same shape, with a different value field.
    if (type === 'IfcElementQuantity' || type === 'IfcQuantitySet') {
      const properties = []
      for (const quantity of definition.Quantities ?? []) {
        const line = lineOf(instance, modelID, quantity?.value)
        if (line === undefined) continue
        const value = line.LengthValue ?? line.AreaValue ?? line.VolumeValue
          ?? line.CountValue ?? line.WeightValue ?? line.TimeValue
        properties.push({
          name: textOf(line.Name),
          type: typeNameOf(instance, line),
          value: typeof value === 'number' ? String(value) : '',
          unit: textOf(line.Unit),
        })
      }
      sets.push({ name, kind: 'quantity', properties })
    }
  }
  return sets
}

/**
 * Describe one element: the identity a reader scans for, and what is defined on it.
 *
 * The named fields are the ones the panel draws, and deliberately not every field
 * the line carries: a raw dump of the schema's attribute list is mostly
 * `ObjectPlacement = #42` and `Representation = #56` — references a reader cannot
 * act on — so the four attributes that say *what this element is* are surfaced and
 * the rest is left to the model checker that needs it.
 * @param instance - the initialised IfcAPI.
 * @param modelID - the open model.
 * @param expressID - the element to describe.
 * @returns the element record, or undefined when the line does not exist.
 */
function readElement(instance, modelID, expressID) {
  const line = lineOf(instance, modelID, expressID)
  if (line === undefined) return undefined
  return {
    expressID,
    type: typeNameOf(instance, line),
    name: textOf(line.Name),
    globalId: textOf(line.GlobalId),
    description: textOf(line.Description),
    objectType: textOf(line.ObjectType),
    predefinedType: textOf(line.PredefinedType),
    tag: textOf(line.Tag),
    properties: readProperties(instance, modelID, expressID),
  }
}

/**
 * Answer one request.
 * @param request - the message the page sent.
 * @returns the reply, or a structured failure.
 */
async function handle(request) {
  const instance = await apiOf()
  if (request.kind === 'open') {
    const modelID = instance.OpenModel(new Uint8Array(request.bytes), {
      // Recentre the model on its own footprint: a survey coordinate in the
      // millions of metres puts the camera past the far plane and the frame goes
      // black. This only shifts the origin, so every product stays in place
      // relative to its neighbours.
      COORDINATE_TO_ORIGIN: true,
    })
    if (typeof modelID !== 'number' || modelID < 0) {
      return { ok: false, error: 'the model could not be opened (is it a valid IFC file?)' }
    }
    try {
      const geometry = readGeometry(instance, modelID)
      const structure = request.options?.structure === false ? [] : readStructure(instance, modelID)
      const unit = readLengthUnit(instance, modelID)
      return {
        ok: true,
        modelID,
        schema: instance.GetModelSchema(modelID),
        unit: unit ?? null,
        parts: geometry.parts,
        structure,
        counts: { triangles: geometry.triangles, vertices: geometry.vertices },
      }
    } catch (error) {
      try { instance.CloseModel(modelID) } catch { /* already gone */ }
      return { ok: false, error: String(error?.message ?? error) }
    }
  }
  if (request.kind === 'element') {
    try {
      return { ok: true, element: readElement(instance, request.modelID, request.expressID) ?? null }
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) }
    }
  }
  if (request.kind === 'close') {
    try { instance.CloseModel(request.modelID) } catch { /* already gone */ }
    return { ok: true }
  }
  return { ok: false, error: 'unknown request: ' + String(request.kind) }
}

self.onmessage = (event) => {
  const request = event.data
  if (request === null || typeof request !== 'object') return
  handle(request).then((reply) => {
    if (reply.ok !== true) {
      self.postMessage({ id: request.id, ok: false, error: reply.error })
      return
    }
    // The buffers move rather than copy: a building's geometry is tens of
    // megabytes and structured-cloning it would double the peak.
    const transfers = []
    for (const part of reply.parts ?? []) {
      transfers.push(part.positions.buffer, part.normals.buffer, part.indices.buffer)
    }
    self.postMessage({ id: request.id, ...reply }, transfers)
  }, (error) => {
    self.postMessage({ id: request.id, ok: false, error: String(error?.message ?? error) })
  })
}
