# dsh-usd-3d-preview

**OpenUSD and IFC in the browser.** A document preview for `.usd` / `.usda` / `.usdc` /
`.usdz` and for `.ifc` / `.ifczip`, opening either kind of file in a side panel of the
DeepSeek Harness (DSH) and drawing it in WebGL with a studio-lit viewport — orbit camera, a
studio lighting rig with shadows, reference grid, and the measured bounding-box size.
Authored `UsdPhysics` joints and colliders make a USD stage **interactive**: click a part to
open or close it, drive the whole mechanism from a toolbar. An IFC model brings its own
schema instead: a spatial tree of products, their property sets, and the surface styles it
authored. Optional read-only object-storage support resolves `s3://` references through a
signed host route. No converter process, no upload, no native toolchain.

Two formats, two readers, one viewport. A **USD stage** is composed by OpenUSD itself — a
pure-Rust build compiled to WebAssembly (`@huggingface/usd-web-viewer`, MIT) resolves
sublayers, references, payloads, variants and instancers in a Web Worker. An **IFC model** is
a STEP physical file read by **web-ifc** (`web-ifc`, MPL-2.0), a schema-aware parser compiled
to WebAssembly, in a worker of its own. Both hand three.js a graph; both are drawn by the same
studio rig, picked by the same raycaster, and framed by the same camera code. What differs is
what the format *is*: a prim graph with composition arcs, or a spatial structure with property
sets — so each has its own inspector panel.

The important part is that **OpenUSD itself does the composition**: a pure-Rust build of
OpenUSD compiled to WebAssembly (`@huggingface/usd-web-viewer`, MIT) composes the stage in
a Web Worker — sublayers, references, payloads, variants, instancers — and three.js renders
the result. If the engine cannot load, the viewer falls back to three's own crate/ASCII parser
and says so in the panel.

A stage reaches the preview one of two ways: a **workspace file opened by address** (click a
`.usd` file in the Files tab) or an **external asset dropped onto the sidebar** (drag a file or a
folder from the desktop onto the right Sidebar). Nothing is uploaded and nothing is written to the
workspace in either case.

It is one package in two halves: a **dsh bundle** and a **browser client plugin**.

```
dsh-usd-3d-preview
├─ lib/index.js            host half (ESM; the trust-fenced asset/health/update routes)
├─ lib/client.js           browser half (classic-CJS module-table entry; three, both WASM
│                          engines, articulation/kinematics and the studio view are inlined)
├─ src/                    the only source of truth: host/ + client/
│    ├─ client/usd.js      USD definition + address helpers
│    ├─ client/ifc.js      IFC definition + container/path helpers (no engine imports)
│    ├─ client/ifc-worker.js       the STEP reader, bundled with web-ifc
│    ├─ client/ifc-worker-boot.js  the small script that inflates and starts it
│    ├─ client/ifc-engine.js       worker handle + the three graph it builds
│    └─ client/IfcBody.jsx         the IFC viewport and its element panel
├─ tests/                  sixteen suites (including real Chromium pixel tests) + fixtures
└─ cordis.patch.yml        bundle patch layer: one `ui-usd-3d-preview` entry
```

## Why this exists

Browser USD support has a gap that is easy to miss. three.js has shipped a real binary crate
reader (`USDCParser`) and a composer (`USDComposer`, which resolves references, variants,
primvars, `metersPerUnit`, and the Z-up→Y-up conversion) since **0.186**. Two things are still
missing:

1. `USDLoader.parse()` always hands the composer an **empty asset table**, so "a unit file that
   references a geometry file" parses to an empty stage;
2. `USDComposer` has **no `subLayers`, `inherits`, `specializes`, or `PointInstancer`**, and it
   does not decode the `references` list-op inside a crate (`Unsupported scalar type 35`).

A browser-only preview is therefore possible as long as something supplies both the missing
layers *and* the missing composition arcs. That is what this plugin does: the WASM engine
composes, and the plugin feeds it the bytes of every layer the stage names.

## Support matrix

Measured by `npm test` (fixtures are committed; the render suites draw them in Chromium).

### USD (`.usd` / `.usda` / `.usdc` / `.usdz`)

| Input | WASM engine (default) | Fallback (three) |
|---|---|---|
| `.usda` (ASCII stage) | ✅ native composition | ✅ parses |
| `.usd` (ASCII or crate) | ✅ container decided by the **first 8 bytes**, not the extension | ✅ |
| `.usdc` (binary crate) | ✅ native crate + composition arcs | ⚠️ reads geometry, but the crate's `references` list-op is not decoded |
| `.usdz` (zip package) | ✅ unzipped, root layer + textures together | ✅ |
| `subLayers = [@./x.usda@]` | ✅ (fixture: 3 layers / 2 meshes / 4 triangles) | ❌ not implemented |
| `prepend references = @../x.usd@` | ✅ composed after a workspace read-back | ✅ (ASCII only, and only the `prepend` spelling) |
| File opened from an absolute address | ✅ the engine composes the root and its `s3://` payloads; relative sibling layers have no Session reader and are reported as warnings | ⚠️ root geometry only |
| `UsdGeomPointInstancer` | ✅ every placement drawn; same prototype + material merges into one `InstancedMesh`, budget 100k instances | ❌ not implemented — only the prototype is drawn once |
| Nested `PointInstancer` | ✅ recursively expanded: 2×3 = **6** quads, three levels 2×3×3 = **18** | ❌ as above |
| Custom-typed instancer prims | ✅ a prim whose **own** fields are `PointInstancer`'s is retyped on the way in, at any nesting depth; a container that merely holds one is left alone | ❌ |
| Multi-level reference chains | ✅ the engine reports the layers it lacks → each is read back → recompose (up to 8 passes) | ✅ regex scan + BFS (24-layer cap) |
| `metersPerUnit` / `upAxis = "Z"` | ✅ normalised to Y-up / metres by the engine | ✅ handled by `USDComposer` |
| Materials / primvars / variant selection | ✅ `UsdPreviewSurface`, `OmniPBR`, glTF MDL (**MaterialX renders grey**, see limitations) | ✅ `UsdPreviewSurface`, OpenPBR, MaterialX image nodes |
| Skeletal animation (`UsdSkel`) | ❌ not supported by the engine; static frame | animations are parsed into `group.animations`, but the preview shows a static frame |

| Interactive / environment | WASM engine (default) | Fallback (three) |
|---|---|---|
| `UsdPhysics` joints (`PhysicsRevoluteJoint` / `PhysicsPrismaticJoint` / `PhysicsFixedJoint`) | ✅ read back from the composed layer bytes: body tree, axes, travel limits, home pose; click-to-toggle + All open / All close / Home | ❌ prim paths are lost in the fallback, no articulation |
| Prim details (declared type / kind / attributes / relationships) | ✅ read back from the same layer bytes the stage was composed from, ASCII and crate alike | ❌ no layer map is kept, so the panel reports that the declarations cannot be read back |
| Collider geometry (`purpose = "guide"` or `PhysicsCollisionAPI`) | ✅ rebuilt from the same bytes as an overlay + wireframe, hidden by default | ❌ |
| Studio rendering | ✅ Khronos PBR Neutral tone mapping, PMREM environment, 4 rect lights, 2048² shadows, lit ground disc, on-demand draw | ✅ same view |
| Selection highlight | ✅ the picked object is re-tinted in the accent under an instanced/parented copy; Esc, the panel's × or a background click clears it | ✅ same pick path — a stage the fallback composed is still clickable, but only names a prim when the engine kept the paths |
| `s3://` asset-layer references | ✅ ASCII layers localized + prefetched through the host route (object storage must be configured) | ❌ |
| Object-storage browser | ✅ the sidebar lists the configured bucket through the host's signed routes (`DSH_USD_S3_ROOT_PREFIX` confines it), searches recursively, and hands a stage to the preview | ❌ |

The stats line at the bottom of the panel reports **engine / layer count / warning count**, and
the warnings are listed by engine code (`layer-missing`, `composition`, `material-fallback`,
`texture-failed`, `prim-unsupported`, `instance-limit`, …). "Why is something missing?" is
answered by the panel instead of by guesswork. Meshes and triangles are counted **as drawn**:
an `InstancedMesh` is multiplied by its instance count and reported on its own "instances" line.
With an articulated asset the panel also reports the number of moving parts in
`data-usd-parts`, and the toolbar only appears when parts were actually read.

### IFC (`.ifc` / `.ifczip`)

| Input | What the preview does |
|---|---|
| `.ifc` (STEP physical file, ASCII) | ✅ read by **web-ifc** in a Web Worker: the schema (IFC2X3 / IFC4 / IFC4X3) is detected from the header and the model is parsed against it |
| `.ifczip` (zip package) | ✅ unzipped, root model taken as the shallowest `.ifc` member |
| Container detection | decided by the **leading bytes** (`ISO-10303-21`, or a zip signature), never by the extension — a UTF-8 BOM in front of the prologue is tolerated |
| Length unit | ✅ the file's authored unit (`mm`/`cm`/`m`/`ft`/…) is reported in the stats; web-ifc converts every coordinate to metres, so the model is drawn at its real size |
| Placement / `IfcLocalPlacement` chain | ✅ the full placement transform is applied in the worker, so the page receives world-space triangles |
| `IfcProduct` tree (`IfcRelAggregates` + `IfcRelContainedInSpatialStructure`) | ✅ the spatial structure is read from both relation kinds and shown as a filterable tree; a product no relation reaches is a root of its own rather than a lost row |
| Surface styles (`IfcSurfaceStyle` → `IfcColourRgb`) | ✅ drawn in the authored colour, shared per colour so a 5000-wall model compiles few programs; an unstyled model is drawn in a neutral grey rather than black |
| Property sets (`IfcPropertySet`, `IfcElementQuantity`) | ✅ listed per element in the details panel, with each property's declared IFC type |
| Picking / selection | ✅ a click names the element under the cursor (its tree path) and tints it |
| `IfcOpeningElement` / booleans | ✅ resolved by web-ifc's geometry kernel; the void is cut, not drawn |
| Drawable geometry only | ✅ a property-only exchange (no representations) reports that it has none instead of showing an empty stage |

The IFC stats line reports **schema / element count / mesh count / triangle count / size**, plus
the authored unit when it is not metres. The panel's element count is the number of objects the
spatial structure carries, in `data-ifc-elements`; the schema is in `data-ifc-schema`.

### Why IFC is a second preview implementation and not a suffix on the USD one

The two formats share a viewport and nothing else. A USD stage is *composed* by an engine that
resolves composition arcs; an IFC model is *parsed* by a schema-aware reader against a fixed
schema. One implementation for both would mean every USD path carrying an "unless this is IFC"
branch, and the two inspector panels answer different questions — a prim path and its authored
declarations, or an express ID and its property sets. What is genuinely common is kept common:
`createView` (camera, orbit, on-demand draw), `studio.js` (the lighting rig), `selection.js`
(the accent tint), `prim-tree.js` (the path hierarchy), and the token palette. Everything below
`assemble()` is per-format.

The element tree is the clearest example of the split. An IFC model's root is an
`IfcProject`, which is an **`IfcObjectDefinition` but not an `IfcProduct`** — so the walk is
driven from `IfcObjectDefinition`, and a structure walk that started from products would lose the
project and, with it, the whole site/building/storey chain. That is not a theoretical concern: it
is the bug the committed `building.ifc` fixture caught, and the offline suite pins the shape as
data so it cannot come back.

## Architecture

```
Files tab click                    drag a file/folder onto the sidebar
   │                                        │
   ├─ documentPreviews                      ├─ sidebarRightTabs 'usd-3d-preview' (page type)
   │     id: dsh-usd-3d-preview/usd          │     guide card + capture-phase drop listener
   │     extensions: usd usda usdc usdz     │
   │     loading: bytes-complete            │
   │                                        │
   └─ sidebar.right.tab.document             └─ sidebar.right.pane.tab (keyed body: UsdDropBody)
         (keyed body: UsdBody)                      │  drop zone / stage picker / header
         │                                          │
         └──────────────┬───────────────────────────┘
                        │
         ├─ assemble()  ─── WASM engine in a Web Worker ─── OpenUSD composition
         │      │                ▲
         │      │                └── files map (layer key → bytes) + 8 read-back passes
         │      │                    workspace path: 8 read-back passes through the Remote
         │      │                    dropped path:   one pass, all bytes already in the page
         │      ├─ articulation: UsdPhysics read back from the same layer bytes
         │      │     (src/client/articulation.js → src/client/kinematics.js)
         │      ├─ details: declared type / kind / apiSchemas / attributes / relationships
         │      │     for the selected prim (src/client/layer-text.js + details.js)
         │      └─ fallback: three USDCParser / USDAParser / USDComposer
         │
         ├─ createView()  (src/client/view.js)
         │     ├─ three.js WebGLRenderer + src/client/studio.js
         │     ├─ orbit controls, 3-point rect lights, shadows, ground, framing, on-demand draw
         │     └─ src/client/selection.js — the accent tint under the picked object
         │
         └─ injected readers: readLayer (workspace Remote) → sibling layer bytes
                              readAsset  (host route)      → s3:// object bytes
```

The IFC half is a second, smaller pipeline into the same viewport:

```
Files tab click (.ifc)             (an IFC model is one self-contained STEP file:
   │                                no siblings, no read-back loop, no reader)
   ├─ documentPreviews
   │     id: dsh-usd-3d-preview/ifc
   │     extensions: ifc ifczip
   │
   └─ sidebar.right.tab.document
         (keyed body: IfcBody)
                │
                ├─ loadIfc()  ─── Web Worker (src/client/ifc-worker.js) ─── web-ifc
                │      │                ▲
                │      │                └── inflates the engine + WASM from the bundle
                │      │                    (src/client/ifc-worker-boot.js → DecompressionStream)
                │      ├─ geometry: world-space triangles, placement applied in the worker,
                │      │     Z-up → Y-up, one BufferGeometry per placed geometry
                │      └─ structure: IfcRelAggregates + IfcRelContainedInSpatialStructure
                │            → flat records → src/client/ifc-engine.js structureToPaths()
                │
                └─ createView()  — the same view, rig, pick and selection tint as USD
```

Everything that crosses a boundary is injected rather than imported: the USD body receives
`readLayer` and `readAsset`, so the assembly is testable without a host and the workspace
Remote remains the only component that knows how to locate a sibling file. (The IFC body needs
no reader at all — a model is one file — which is why its registration injects nothing, and why
the offline suite asserts that absence.) `index.jsx` registers thirteen reversible effects —
the dictionaries, both preview definitions, both keyed document bodies, the sidebar page type
(with its guide card), its tab body, the sidebar drop watcher, the object-storage page type and
body, and the three update surfaces — through public client services only
(`documentPreviews`, `sidebarRightTabs`, `sidebarRight`, `slots`, `locale`,
`remote.workspaceFiles`).

### The read-back loop

The engine fetches its own layers over http(s), which a workspace file is not. So:

1. the opened file's bytes are registered in the engine's `files` map under its
   workspace-relative path;
2. the engine composes once and reports `layer-missing` / `texture-failed` warnings whose
   `path` is the exact key it looked up (`local:///…`);
3. each missing key is read through the workspace reader, added to the map, and the stage is
   recomposed — **up to 8 passes** (measured: a 2-hop reference chain converges in 2 passes).

The reader is `remote.workspaceFiles.readBytes`, and the Client Remote answers with a result
envelope (`{ ok: true, value }` / `{ ok: false, error }`) instead of rejecting. The injected
`readLayer` therefore returns `value.data` for an ok result and `undefined` for a failed one: a
layer the host cannot read is exactly the "missing layer" the engine already knows how to report,
so it stays a warning in the panel rather than an exception that blanks the stage.

Both the worker script and the `.wasm` binary travel inside `lib/client.js` as base64 and
become blob URLs at first use. This is deliberate: a client plugin ships as one module-table
entry and cannot assume a host route for two extra files. The USD engine alone costs ~3 MiB of
bundle size (three ≈ 1.4 MiB + engine ≈ 2.2 MiB of WASM + articulation/kinematics and the studio
view).

### The IFC engine, and why it is gzipped

The IFC reader has the same packaging problem with a bigger number: web-ifc's bundle is 3.5 MiB
minified and its WASM binary 1.6 MiB. Base64 of those raw bytes would add **6.8 MiB** to a
bundle that is already ~5.3 MiB. The shell serves a client plugin as one *uncompressed*
JavaScript file, so the bytes are gzipped before they are embedded — 0.4 MiB and 0.6 MiB — and
a 3 KiB bootstrap (`src/client/ifc-worker-boot.js`) inflates them in the worker with the
platform's own `DecompressionStream` before handing control to the engine. The finished bundle
is ≈ 6.9 MiB instead of ≈ 15.8 MiB.

The bootstrap also solves a race: `new Worker(url)` has no constructor argument, and the WASM
location must exist before the first `open`. So the page posts the two payloads as a
`configure` message and the bootstrap **queues** anything that arrives before the inflation
finishes, rather than dropping it. A message that vanished would look like a hung model.

One design consequence worth naming: the worker applies each product's placement transform and
the Z-up → Y-up rotation **before** the geometry crosses the boundary, so the page receives
world-space triangles and builds a flat graph. That is what makes the stats line, the raycaster
and the camera framing all agree with what is drawn, with no intermediate transform for any of
them to walk through.

## Interactive USD

USD is not only geometry: inspection and SimReady-style assets describe mechanisms in
`UsdPhysics` prims — rigid bodies (`PhysicsRigidBodyAPI`) connected by
`PhysicsRevoluteJoint` / `PhysicsPrismaticJoint` / `PhysicsFixedJoint`, with axes, travel
limits and a rest pose. **The WASM engine composes geometry but does not keep those prims**,
so `src/client/articulation.js` reads them back from the same layer bytes the engine used
(ASCII layers are parsed directly; crate layers go through three's field tables, with the
`apiSchemas` `TokenListOp` decoded by hand because the crate reader skips it by design).

The result is a body tree plus a joint table (type, axis, unit, `lower`/`upper`, `home`,
`body0`/`body1`) and the collider prims. `src/client/kinematics.js` then:

- parents each body's meshes under their own `Group`, preserving the world matrix (identity
  at rest); joints only write a rigid transform — **there is no physics engine and no
  dynamics**: forward kinematics + the authored limits are the whole interaction;
- click a part → the mesh's body → walk up the tree to the driving joint → move toward the
  other end of its travel. Animation is ~110°/s with smootherstep easing and a frame-rate
  independent `tick(deltaMs)`;
- the toolbar offers **All open / All close / Home**, and a collider wireframe overlay that
  is hidden by default (the button only appears when collider geometry was actually read);
- framing uses the union of the rest pose and the joint-travel extremes and is aspect-aware
  (portrait sidebar panels included), so opening a joint keeps the model inside the viewport.

Clicking works because the engine drops every vertex array after uploading it to the GPU
(to save memory), while three's `Mesh.raycast` needs the position/normal/uv attributes. For
stages with moving parts `parse.js` therefore restores three's no-op `onUploadCallback` and
keeps those arrays; static stages still get the engine's release.

## Studio rendering and on-demand drawing

`src/client/studio.js` builds a physical-looking viewport whose numbers scale with the model
radius, so a 3 cm part and a 30 m building share one lighting setup:

| Stage | What it does |
|---|---|
| Renderer | sRGB output, **`NeutralToneMapping`** (Khronos PBR Neutral, not ACES), exposure 0.9, `PCFShadowMap`, pixelRatio ≤ 2 |
| Environment | `RoomEnvironment` through `PMREMGenerator` as `scene.environment`, `environmentIntensity` 0.2 — low enough that engine-baked `MeshStandardMaterial` albedo keeps its form |
| Lights | 4 `RectAreaLight` (key/fill/top/rim) + 1 shadow-casting `DirectionalLight` (2048², orthographic box fitted to the radius), placed so the shadow falls to the front-left of the default view |
| Ground | a lit circular disc under the model (`CircleGeometry` 5r, `MeshStandardMaterial`, radial alpha map fading to transparent, `receiveShadow`) — a shadow-only transparent plane would be invisible against the dark panel background |
| Framing | 35° camera, 6% margin, `maxPolarAngle 0.495π`, damping 0.12; with moving parts the union of the rest pose and the joint-travel envelope |
| Drawing | **on demand**: idle means no frames; a new frame is drawn on input, resize, damping tail, auto-rotate, an on-frame request, or an explicit `requestRender()` |

`src/client/view.js` owns the camera, controller and on-demand loop; `UsdBody` only mounts it
and wires the pick callback. `view.onFrame` / `view.onPick` / `view.requestRender()` are the
tiny integration surface between the controller and the React body.

## S3-compatible asset library (`s3://` references)

Stages can keep their layers in object storage and reference them as `s3://bucket/key` in
USD. A browser cannot sign an S3 request, and the WASM engine has no `s3` resolver, so the
plugin splits the work:

1. **Host route (signed read).** `GET /api/usd-preview/asset?uri=s3://…` is an exact Fetch route
   on the DSH Connection service, so the browser-trust fence (Host/Origin) and the session
   credential admit the owner request before the host half signs a SigV4 GET with environment
   credentials and returns the bytes. One read is bounded — 64 MiB and a 30 s timeout (`413`
   when too large, generic `502` on an upstream failure). A small `GET /api/usd-preview/health`
   reports whether object storage is configured (endpoint/bucket only — never keys or local
   paths). Both routes are read-only and GET-only, and are not reachable outside the
   authenticated `/api` channel.
2. **Engine-side localization.** The engine only accepts its own package keys and rejects any
   non-http(s) layer URL, so an ASCII layer's `@s3://bucket/key@` references are rewritten to
   `@/__assets__/bucket/key@` before composition, and the object bytes are prefetched into the
   engine's `files` map under that key. Layers the engine still reports missing are fetched
   through the same loop and the stage is recomposed (up to 8 passes).

Configuration is **environment-only**; nothing is read from a config file and no credentials
are stored or logged:

| Variable | Meaning |
|---|---|
| `DSH_USD_S3_ENDPOINT` | base URL of the S3-compatible service (required, path-style addressing) |
| `DSH_USD_S3_ACCESS_KEY` | access key id (required) |
| `DSH_USD_S3_SECRET_KEY` | secret access key (required) |
| `DSH_USD_S3_BUCKET` | bucket the `s3://` URIs name (default `asset`) |
| `DSH_USD_S3_REGION` | SigV4 signing region (default `us-east-1`) |
| `DSH_USD_S3_ROOT_PREFIX` | key prefix the sidebar browser is confined to (default: the whole bucket) |

`DSH_USD_S3_ROOT_PREFIX` is what makes the object-storage tab usable against a bucket whose
listing is not public: set it to the directory you actually work in — `Component/`, `Component`
and `s3://asset/Component` are all accepted — and the sidebar opens there. The page can never
list outside that prefix, and `..` is refused rather than clamped, so the browser never reaches a
key the operator did not expose.

Object bytes are cached in `$DSH_HOME/cache/usd-assets/` (a bounded LRU in memory — 64
entries / 128 MiB — plus a best-effort disk copy; a read-only cache directory never breaks a
preview). When object storage is not
configured, `s3://` references simply appear in the warnings list as `layer-missing`.

Known limits of this path: only path-style S3-compatible endpoints are addressed; session
tokens (STS) are not supported; nothing about the bucket is modified; and a binary crate's
**internal** absolute `s3://` references cannot be rewritten as text, so a crate that
references object storage directly only composes when the opt-in equal-length crate patcher
is enabled (`globalThis.__DSH_USD_PATCH_CRATE_REFS__ = true`) or the asset is exported
self-contained.

### External assets (drag and drop)

`lib/client.js` also registers a page tab, `usd-3d-preview`, whose body
([`src/client/DropBody.jsx`](src/client/DropBody.jsx)) opens a stage that is not in the workspace:

1. the card appears in the sidebar guide (`USD 三维预览`, after Files and before Terminal) and
   opens the drop zone with one click;
2. a file drag anywhere over the right Sidebar panel is claimed in the capture phase
   ([`src/client/sidebar-drop.js`](src/client/sidebar-drop.js)) — dashed outline, `松开以在 USD
   预览中打开` hint — and on drop the page tab opens with the asset. Claiming it there is
   deliberate: the conversation's attachment drop listens on the same document and accepts drops
   across the whole page, so without the capture listener a stage dropped on the sidebar would
   attach itself to the next prompt instead;
3. a dropped **folder** brings the layers and textures the stage references (Chrome's entry API,
   walked recursively), so a SimReady/unit layout composes exactly as it does on disk;
4. one shallowest layer opens by itself; two stages at the same depth produce a picker instead of
   a guess; a folder with no USD file says so instead of silently doing nothing;
5. `.usdz` packages, `.usdc` crates and ASCII layers all take the same path, and the drop zone's
   *Choose file* / *Choose folder* buttons feed the same collection code.

Bytes stay in the page: no upload, no workspace write, no host route. The panel header names the
opened layer and *Open another asset* goes back to the zone. The only thing the browser needs is
the bundle — the same WASM engine composes the dropped stage. (A pasted address is different: it
does read through the read-only routes below.)

### Opening a stage by address

The same page tab accepts a pasted address instead of a drop, so an asset that already lives in
object storage or behind an HTTP endpoint needs no download step:

| Address | How it is read |
|---|---|
| `s3://bucket/key.usda` | root layer through the host signing route (`/api/usd-preview/asset`); when the host half has no `DSH_USD_S3_*` configured, a loopback gateway that fronts the same bucket is used instead |
| `https://host/path.usda` | the root layer is fetched directly — same-origin needs nothing, cross-origin needs `Access-Control-Allow-Origin` |

The root bytes are held by the page exactly like a dropped file, but the stage is composed through
the engine's multi-pass loader instead of the drop map: every reference the stage names is read on
demand with the pasted address as its base, and the stage is recomposed until nothing is missing.
Relative layers, sublayers and absolute `s3://` references therefore resolve; an unreadable layer
stays a warning rather than a failed preview. HTTP-referenced layers need the same CORS permission
as the root, and an `s3://` layer inside an address-opened stage uses the same signing route as
the root.

### Object storage browser

`lib/client.js` registers a second page tab, `usd-objstore`
([`src/client/ObjStoreBody.jsx`](src/client/ObjStoreBody.jsx)), whose guide card sits **before** the
USD preview card: browsing is the source, previewing is where one object ends up.

It has two backends, and picks one per page:

1. **The host half (no extra deployment).** When `DSH_USD_S3_*` is configured,
   `GET /api/usd-preview/list` and `GET /api/usd-preview/search` list with the host's own SigV4
   credentials — the same trust-fenced `/api` channel the signed asset read uses. The browser
   never holds a credential, and the listing works against a bucket that denies anonymous
   `ListBucket`, which is the common MinIO/S3 configuration: anonymous `GET` of an object may be
   allowed while listing is not.
2. **A deployment gateway.** When the host has no library, the page falls back to the
   `/usd-asset-api/*` routes below, for a deployment that terminates them elsewhere.

Either backend offers:

- a lazy directory tree with breadcrumbs, per-folder filtering and refresh;
- **recursive search** of the current prefix — USD-only by default (`.usd/.usda/.usdc/.usdz`), with
  an *All files* toggle, debounced, showing each match's folder, size and time;
- per row: **Preview** (hands the object to the USD preview tab through the same pending-drop
  channel the sidebar drag uses; referenced layers are then read through the readers below),
  copy `s3://` URI, copy https URL, open in browser.

The host routes need nothing beyond `DSH_USD_S3_*`. The gateway routes are **deployment-provided**:
this repository ships the page, not the gateway that terminates them, and they are only consulted
when the host has no library. The page calls them on its own origin by default:

| Page route | Meaning |
|---|---|
| `GET /usd-asset-api/list?prefix=` | immediate children of one prefix |
| `GET /usd-asset-api/search?prefix=&q=&usd=1&limit=200` | recursive file search below one prefix |
| `GET /usd-asset/<key>` | one object's bytes (Preview's root read and the relative-reference reader) |

All of them are read-only and GET-only. A previewed stage's absolute `s3://` references go through
the host signing route (`/api/usd-preview/asset`), with the gateway's byte route as fallback. The
JSON the page expects:

```jsonc
// GET /api/usd-preview/list  (and the gateway's /usd-asset-api/list)
{ "bucket": "asset", "prefix": "Component/", "rootPrefix": "Component/",
  "entries": [{ "key": "Component/window.usda", "name": "window.usda",
                "type": "file", "size": 130380, "lastModified": "2026-11-01T10:00:00Z" }],
  "truncated": false, "continuationToken": null }
// GET /api/usd-preview/search  (and the gateway's /usd-asset-api/search)
{ "entries": [ /* the same entry shape */ ], "scanned": 42, "truncated": false }
```

`type` is `"folder"` or `"file"`; a folder entry needs `key` and `name`. A deployment that
terminates the routes elsewhere (a portal host, a local dev port) names that origin once, before the
bundle runs, and that origin must answer CORS for the page:

```js
globalThis.__DSH_OBJSTORE_ASSET_ORIGIN__ = 'https://asset.example.com'
```

A `truncated` listing whose `continuationToken` is not null offers **Load more** in the footer. A
stock install with neither a configured library nor a gateway reports that the object-storage API is
not reachable; the USD preview itself does not depend on it.

## Prim paths

The viewport toolbar carries a **Prims · N** button. It opens a panel showing the geometry-bearing
prim paths the composed graph carries — `/WindowUnit/Geometry/Frame`, for instance — read from the
engine's own nodes (each mesh's `name` is its prim path; an instanced batch exposes
`userData.paths`). Paths are shown as a **hierarchy**: `/World/Geometry/Body` becomes an expandable
`World › Geometry › Body` tree, with folder and prim glyphs, natural numeric ordering
(`Wheel_2` before `Wheel_10`), and each row's short name; hovering a row reveals its full path.
Folders start expanded and a click collapses or reopens one; clicking a prim copies its full path.
Filtering keeps every match together with its ancestors and subtrees, and a very large tree is
clipped with the clip count stated in the panel.

Clicking the model names the prim under the cursor **and highlights it in the viewport**: the
clicked object is re-drawn in the shell's accent colour, over its own surface, so "which one did I
just click?" is answered by the frame and not only by the panel. The panel shows it as **Picked:**,
reveals its folders, highlights the matching row, and the closed-panel hint carries the same line.
**Escape**, the panel's × button, or a click on the background clears the highlight; the highlight
is a child of the picked mesh, so an articulated part keeps its tint while its own joint moves it,
and one placement of a `PointInstancer` is tinted rather than the whole batch. The tint never
intercepts a click (a second click on the same part selects the part again, not its tint) and never
writes depth, so a selected object that is behind another stays occluded. It follows the
**Wireframe** toggle, and clearing it leaves no visible trace — the browser suites assert the
changed share stays under 0.2% and the largest channel delta anywhere is within the rasterizer's
noise. [`docs/screenshots/selection-unselected.png`](docs/screenshots/selection-unselected.png) vs
[`selection-highlighted.png`](docs/screenshots/selection-highlighted.png) is the visual pair.
Naming a prim needs the vertex arrays three's raycaster reads, which the engine frees after
upload. They are kept for stages below a triangle budget (2 million by default; set `globalThis.__DSH_USD_PICK_TRIANGLE_BUDGET__` before
the bundle runs to change it), so a stage above the budget keeps the engine's release and its canvas
clicks do nothing — they do not throw. Retaining the arrays is real memory (roughly 40–100 bytes per
triangle, so tens to a couple of hundred MB at the ceiling), which is exactly what the budget bounds.

## Prim details

The **Details** button opens a panel that answers a different question than the prim tree: not "what
is in this stage" but "what does this file *declare* about this prim". It follows the selection, so
clicking a prim in the viewport — or picking one in the tree — fills it in. The presentation follows
**usdview**'s *Prim Metadata* and *Attributes* panes, so a USD reader's vocabulary works unchanged:

| Section | What it shows |
|---|---|
| Header | the prim path, its declared **type** (`Mesh`), its **kind**, and whether it is a `def` / `over` / `class` |
| Applied schemas | every `apiSchemas` entry, including namespaced ones (`PhysicsDriveAPI:angular`) |
| Composition | authored `inherits` / `specializes`, declared variant sets, `doc`, and the layers that described the prim |
| Attributes | a **`type` · `name` · value** table, grouped Transform / Geometry / Physics / Materials / Other, with `custom` and `uniform` shown beside the name, and — on a multi-layer stage — the layer each value was taken from |
| Relationships | authored relationships (`material:binding`, `physics:body0`, …) with their resolved target paths |

The values are the ones **the strongest layer authored**, and that layer is named: the panel's layer
list names every layer that described the prim, and on a multi-layer stage each attribute row carries
the layer its own value came from. Merging layers is the engine's job and doing it again here would be
a second opinion, while naming the source makes a surprising value traceable. Fields a composed three
graph simply does not keep are exactly what this panel exists to show — the declared type of every
attribute, `custom` attributes (`userProperties:blender:data_name`), applied API schemas,
`purpose = "guide"` on a collision hull.

A referenced or payloaded prim is **authored under a different path than the stage composes**, so the
reader walks the composition arcs the layers declare: a prim reached through `references` or `payload`
is looked for at the path that layer wrote, and the header names both (`/root/unit/body` composed,
`/root/body` authored). Sublayers compose at the same path and are simply added to the describing
layers. Without that walk every referenced asset answered "no layer describes that prim".

Two rules keep it honest on a large stage. A **long array is counted, not materialised**: the panel
reports `point3f[482]` and a preview of its first elements, deriving the count from the array's
punctuation rather than from its values, so a solved robot's ~90 MiB geometry layer costs one
delimiter scan instead of a parse. And a prim no layer describes is reported as absent, not as an
empty table. The three fallback composes no layer map, so it says the declarations cannot be read
back instead of guessing.

`src/client/layer-text.js` is the reader both this panel and the articulation read-back use — one
lexer for one grammar, so the two can never disagree about the same file. `src/client/details.js`
adds the crate path (three's `USDCParser` already decodes the field set; the details reader keeps the
per-attribute `typeName` / `variability` / `custom` it discards) and the presentation rules.
[`docs/screenshots/details-panel.png`](docs/screenshots/details-panel.png) is the captured panel, and
[`docs/screenshots/details-referenced.png`](docs/screenshots/details-referenced.png) is the same panel on a
prim a reference composed.

## Build and install

Requires **Node ≥ 20** and npm.

```bash
npm install            # three, esbuild, react, react-dom, @huggingface/usd-web-viewer, web-ifc
npm run build          # 1) embeds the worker + wasm into src/client/engine-assets.generated.js
                       # 2) writes lib/index.js and lib/client.js
npm test               # objstore + update + instancer + register + drop + prim-tree + selection + details + parse + s3 + articulation + studio + articulation-render + render
npm run update:local   # update this checkout from its upstream and rebuild (see below)
node tests/probe.mjs arcs/root.usda    # optional: print engine/stats/warnings for one file
```

`lib/` and `src/client/engine-assets.generated.js` are build products and are git-ignored:
clone → `npm install` → `npm run build` produces them. The build patches the viewer engine's
asset transport to route `s3:` URLs through the host route; if a future engine version moves
that function the build fails loudly instead of silently dropping object-storage support.

**Install from a built checkout, not from a git URL.** A package fetched straight from a git host
(or a release tarball) is packed from the committed files, and the committed files hold no `lib/`.
The host loader then cannot import `lib/index.js` and the browser is never offered `lib/client.js`,
so the bundle appears installed while the preview never registers. There is no registry publication
to fall back on, so the supported install is a local clone that has been built (`npm run build`)
and is linked into the profile — that is what `link:` below does.

### As a dsh bundle

The package is a bundle (`dsh.bundle.patch` → `cordis.patch.yml`) that inserts one loader entry,
`ui-usd-3d-preview`, plus a client half (`dsh.client`, platform `web`) that the host serves to
the browser. Add it to a profile:

```jsonc
// <profile>/package.json
"dependencies": { "dsh-usd-3d-preview": "link:C:/path/to/dsh-usd-3d-preview" },
"dsh": { "profile": { "bundles": [ /* … */, "dsh-usd-3d-preview" ] } }
```

The path is absolute (a Windows drive path and a POSIX path are both accepted). Install it through
the Plugin settings page or `dsh plugin install link:/path/to/dsh-usd-3d-preview`, which records the
same dependency and appends the bundle to `dsh.profile.bundles`.

Profiles are live: the manifest and the patch file are watched, so no app restart is needed to
pick the bundle up. The browser half hot-reloads; the host half goes through Node's ESM module
cache, so a host change needs an app restart. To switch the plugin off, disable it in
Settings → Plugins, or set `disabled: true` on the `ui-usd-3d-preview` entry in the patch layer.

### Front-end hot reload (development)

The Web shell ships a client HMR transport that stat-polls every plugin's
`lib/client.js` and hot-swaps the browser bundle when its mtime or size changes —
no page refresh and no app restart. For a directory install the missing piece is
a build watcher, which this checkout provides:

```bash
npm run dev:watch
```

It watches `src/client/`, `src/host/`, `build.mjs` and `package.json` (the last two
through the package directory, because a watcher bound to a single file stops
delivering events once an editor saves atomically), and on every change it
rebuilds. Where the result goes depends on how the plugin is installed, so the
script asks the profile first: it looks for a `node_modules/dsh-usd-3d-preview`
link under `$HOME/.dsh/profiles/*` and builds for whichever directory that link
resolves to. Two outcomes:

- **link install** — the profile points at this checkout, so `lib/` here *is* the
  install and nothing is copied: the rebuild is the hot reload.
- **copy install** — the profile points at a directory holding its own copy of the
  bundle (conventionally `$HOME/.dsh/bundles/usd-3d-preview`); the fresh `lib/*.js`
  is copied in.

`DSH_USD_INSTALL_DIR` overrides the lookup when a machine has more than one profile.
The resolved directory is validated once at startup — a path that does not exist is
refused instead of failing on every rebuild — and `DSH_USD_DEBOUNCE_MS` is validated
rather than turning a typo into a build per filesystem event. Host-half changes also
rewrite `lib/index.js`, but Node's ESM cache needs an app restart for those;
front-end edits never do.

### Updating a local checkout

Because the install is a `link:` to a built checkout, updating the plugin means: fast-forward
that checkout, reinstall dependencies only when `package.json` changed, rebuild `lib/`, and let
the two halves load. The repository ships that procedure once
([`scripts/update-local.mjs`](scripts/update-local.mjs), wrapping
[`src/host/update.js`](src/host/update.js)); the terminal and the Web UI both call it.

```bash
npm run update:local                          # update the current branch
npm run update:local -- --check               # fetch the upstream and report ahead/behind
npm run update:local -- --status              # local status only (no network)
npm run update:local -- --branch feat/example # try another branch locally
npm run update:local -- --restart             # restart the host after a host-half change
node scripts/update-local.mjs --json          # machine-readable (the update route uses it)
```

Rules: the working tree must be clean; the update is a `git merge --ff-only` of the checkout's
own upstream (never a reset, force, or rebase); only `git`, `npm install --no-audit --no-fund`
(when `package.json` changed or `node_modules` is missing) and `npm run build` are spawned, with
fixed argv. On Windows `npm` is a `.cmd` shim, which Node refuses to spawn without a shell
(CVE-2024-27980), so that one command is quoted and handed to `cmd.exe` — every other command is
still a plain argv spawn with no shell. A published/installed copy without `.git` reports
"not a git checkout" and changes nothing. `--restart` uses the systemd user service named by
`DSH_WEB_SERVICE` (default `dsh-web.service`) on Linux, and prints the manual command elsewhere;
restarting disconnects the open Web UI.

The same procedure has two surfaces in the Web UI: **Settings → Plugins → Update**, and this
bundle's own detail page in the Plugins panel (an **Update available** badge plus a section with
*Check for updates*, *Update and rebuild* and, when the host half changed, *Restart DSH Web*).
Both read `GET /api/usd-preview/update` and post `{ "action": "check" | "update" | "restart" }`
to the same trust-fenced route as the asset reads — owner-only, and no update starts without a
click. The browser half hot-reloads after the rebuild; a `lib/index.js` change needs the host
restart shown in the panel. The first installation of this feature on an older checkout needs one
terminal update plus a host restart, because the route is itself part of the new host half.

## Tests

| Suite | What it proves |
|---|---|
| `register` | evaluates `lib/client.js` under the shell's `window.__ModuleLoader__` contract in Node: registration id, `apply`/`inject`, **the only external module requested is react**, the definition id equals the body key, and the injected `readLayer` really goes through the workspace Remote |
| `instancer` | the custom-type rewrite in isolation: a prim whose **own** fields carry `protoIndices` and `prototypes`/`positions` is promoted, a custom group around an instancer is not, and a prim with only part of the signature stays untouched — the container case is what protects a nested custom-instancer library |
| `drop` | the external-asset path without a browser: name/key helpers, stage candidates and the auto-open rule, BOM + custom-instancer normalisation of a dropped text layer, package bytes passed through untouched, picker collection, and the capture-phase sidebar listener against a faked document (USD drag claimed + highlighted, PDF drag left to the shell, drop handed to the page tab, listeners removed on dispose) |
| `prim-tree` | the prim-path hierarchy in isolation: natural numeric ordering, tree building with copyable ancestor folders, ancestor-preserving filtering, bounded flattening with an honest total, and picked-path ancestor reveal |
| `details` | the prim-details reader in isolation, no browser: declared types (`point3f[]`, `int[]`, `token`, never a JavaScript type), `custom` / `uniform` modifiers, `kind` and `apiSchemas`, relationships with resolved targets, **ASCII and crate agreeing on every attribute of the same stage**, a long array summarised by its true element count instead of materialised (and counted as elements, not components), a declared-but-unset attribute keeping its type, **a prim a `references` arc re-roots found under its composed path with its authored path reported**, a `subLayers` layer contributing at the same path, a UTF-8 BOM staying a text layer, the no-layer-bytes / no-such-prim answers staying distinct, and the panel's ordering and value-formatting rules |
| `selection` | the selection highlight in isolation, no browser: one tint copy parented to the picked mesh and sharing its geometry (so a joint carries it and no vertex is duplicated), the copy refusing to be raycast, one placement of an instanced batch tinted rather than the batch, groups/points/lines refused instead of invented, the wireframe mode reaching a tint created after it, the source's face policy mirrored onto the tint both ways (`DoubleSide` kept, `FrontSide` taken back off the shared material), and `dispose()` releasing only its own material — never the caller's geometry |
| `parse` | magic-number dispatch for all four containers; **ASCII and crate must produce the same geometry** (2 meshes / 972 triangles / identical extent); a reference chain assembles when given a reader and stays honestly empty without one; address and path helpers |
| `ifc` | the IFC container and structure helpers, **no browser and no WASM**: the registry definition (a STEP file stays text-readable, only `.ifczip` is binary, no suffix claimed twice), container detection from the leading bytes (STEP prologue, BOM tolerated, zip signatures, and a `.ifc`-named non-STEP file correctly rejected), `FILE_SCHEMA` parsing, the IFCZIP root rule, unit labels (`MILLI`+`METRE` → `mm`, and no unit line for a metre model), path segments that survive a slash or a control character in a name, sibling disambiguation by express ID, and **the flat worker structure turned into a tree** — including the case the committed fixture caught: an `IfcProject` is an `IfcObjectDefinition` but not an `IfcProduct`, so a walk from products alone loses the whole site/building/storey chain |
| `articulation` | joint read-back and kinematics, **no browser needed**: authored joint fixtures (door / drawer / three-link chain / fixed-only / mixed / no physics) go through `readArticulation`; an ASCII↔crate parity fixture (`mixed.usdc`, inlined `Vec3d` decoding) and a referenced-asset fixture (composed paths matched under `/World/Robot`, lookalikes stay static) pin the binary-container and composition cases; the controller is validated on a synthetic scene (world matrices unchanged before/after binding, travel inside the limits, home to 1e-6, picking hits the right joint and ignores fixed joints, collider toggle, dispose restores); diagnostics are reported to the caller |
| `s3` | host-side asset-library logic offline: environment-only configuration (including `DSH_USD_S3_ROOT_PREFIX` normalization and confinement — siblings and `..` refused, not clamped), `keyOf` validation, SigV4 request shape, bounded memory/disk cache, 404, 413 and generic 502 semantics, `ListObjectsV2` parsing (folders from `CommonPrefixes`, XML entities, continuation tokens), recursive search, a listing signature verified against an independent SigV4 derivation, and the asset/health/list/search routes mounted through the Connection Fetch-route surface (the fake offers no raw webserver) — no network and no real credentials |
| `objstore` | the object-storage page's client contract without a browser: key encoding/USD detection/formatting, list+search URL building, the 10 s request cache (a shared request outlives one caller's abort and is reused), bucket-correct `s3://` URIs, backend selection (a configured host bypasses the gateway; an unconfigured one falls back to it), public URLs derived from the host endpoint, and the address-open descriptor — `s3://`/http(s) root bytes plus readers, host-route and gateway fallbacks, and the error mapping (bad URI, 404, malformed escapes) |
| `update` | the local-checkout updater offline: ahead/behind parsing, dirty/detached/not-a-checkout refusals, check/update/restart actions, the single-update lock, restart command construction, a **real local-git integration** (bare origin + clone: fast-forward, package.json-aware install skip, rebuild, host-change detection, idempotent rerun), and the update route's GET/POST registration with malformed-body/unknown-action refusal |
| `studio` | **real Chromium + WebGL**: mounts `createView` and asserts neutral tone mapping, sRGB, PCF shadows, PMREM environment, four rect lights, the lit ground disc, the on-demand frame rhythm (no continuous rAF — at most a settling frame while idle), aspect-aware framing in both landscape and portrait stages, that a throwing frame observer stops the loop instead of hot-looping, and the selection highlight: one copy at the picked mesh's world position, its pixels visibly shifted towards the accent, and clearing it returning the frame to the unselected image |
| `articulation-render` | **real Chromium + WebGL**: `UsdBody` mounts an articulated fixture, then clicks are resolved against the rendered pixels (only a click that changes the canvas counts): toggling a part changes the frame and selects the part, Home restores it, the tint travels with the part it marks, Escape and a background click deselect, colliders add their overlay, and idle draws nothing |
| `render` | **real Chromium + WebGL**: `UsdBody` mounted with real props (including both injected readers) over the committed fixtures — package, ASCII, crate, reference chain, **sublayer + reference**, instancer, nested instancer, custom-typed instancer, **custom nested instancer**, **custom instancer behind a payload**, articulated fixture — each must draw a non-flat frame, stay pickable, and the stats must name the OpenUSD (WASM) engine; a prim-panel case checks the path list, its filter and that a canvas click names the picked prim. Screenshots land in `tests/.artifacts/` |
| `ifc-render` | **real Chromium + WebGL**: `IfcBody` mounts the committed IFC fixtures and the whole pipeline is production code — the worker boot, the gzip inflation, web-ifc, the graph. Each case must draw a non-flat frame (a thousand-plus distinct colours), report its schema and its measured extent, and list its spatial tree. Two assertions carry most of the weight: the **size** (`5.000 × 3.000 × 0.200` for a wall the file authors in millimetres, `8.000 × 6.600 × 6.000` for the two-storey building) proves the placement matrix was applied exactly once — a second Z-up→Y-up rotation lays the model on its side, which is how that bug was found; and the **details panel** proves a property set reaches the element through `IfcRelDefinesByProperties` with its declared `IFCBOOLEAN` type, and that a wall carrying a void is both foldable and selectable |

The browser suites need Playwright + Chromium. Without a browser they print `SKIP`, and `npm test`
fails instead of reporting a false green — set `DSH_ALLOW_BROWSER_SKIP=1` to run the offline suites
only (the CI workflow installs Playwright, so skips never pass there):

```bash
npm install --no-save playwright
npx playwright install chromium
npm test
```

Optional real-asset suites are gated by environment variables and skip when unset:
`DSH_USD_TEST_SIMREADY` (a local articulated `.usdc` asset) and `DSH_USD_TEST_SCENE` (a local
stage whose layers resolve through the S3 object storage configured above;
`DSH_USD_TEST_SCENE_ROOT` optionally overrides the addressed root). The browser tests decode
and compare screenshots through a Chromium pixel probe (`tests/pixel-probe.mjs`), so no
Python/Pillow is needed.

Panel screenshots for a release or review can be captured from the same harness with
`node tests/capture.mjs` — see [docs/screenshots/README.md](docs/screenshots/README.md).
`node tests/record-demo.mjs` records a captioned GIF of the scripted joint interaction
(requires the two small encoders listed there; the committed GIFs are in `docs/screenshots/`).

Fixtures: `tests/fixtures/sample.{usda,usd,usdc,usdz}` are four containers of one scene
exported by Blender (`tests/make-fixtures.py` regenerates them); `refs/unit.usda →
refs/geom/body.usda` is a reference chain; `arcs/root.usda → sub/base.usda + ref/body.usda`
is a sublayer + reference combination that three's composer cannot do at all;
`joints/*.usda` are hand-authored `UsdPhysics` stages; `instancer/custom-nested.usda`
is a custom-typed instancer library whose prototypes are custom instancers reached
through external prim paths; `instancer/payload/root.usda` is the same shape with
the inner instancer and its prototype inside a payload layer (2 layers, 4 quads);
`remote/root.usda` is an object-storage reference example.

The IFC fixtures are hand-authored STEP files, so the suite needs no exporter and no CAD
toolchain: `ifc/hello-wall.ifc` is one wall (5 × 3 × 0.2 m, authored in millimetres);
`ifc/building.ifc` is a two-storey building with a real spatial tree
(project → site → building → two storeys → 11 elements), six element types, six surface
styles, three property sets and two boolean voids cut through two walls (12 placed
geometries / 180 triangles, 8 × 6.6 × 6 m); `ifc/not-ifc.ifc` is plain prose behind an
`.ifc` name, which is the negative case the preview's failure state exists for.

## Limitations

### IFC

- **An IFC model is read whole, in memory.** There is no streaming parse: the file's bytes and
  its geometry both live in the worker until the tab closes. A very large model is therefore
  bounded by the browser's heap, not by the Host's read caps — the same trade a dropped USD
  asset makes, for the same reason.
- **There is no IFC by drop yet.** A model opens from the Files tab by address, which is what
  the document-preview registry offers. The sidebar drop zone still belongs to USD; an IFC file
  dropped there reports that it carries no stage.
- **The colour is a surface style, not a material.** IFC's `IfcSurfaceStyle` carries a colour
  and (optionally) a transparency; it has no roughness, metalness or texture channels this
  viewport reads, so every surface is drawn with one fixed roughness. A model whose appearance
  comes from a texture map renders in its style colour instead.
- **The element tree is the product structure, not the geometry.** A prim with no
  `IfcProduct` subtype (a property template, a style) has no row; an element whose
  representation the kernel could not build still gets a row and simply draws nothing. The tree
  also folds an `IfcOpeningElement` under the element it voids, which is the third relation kind
  the reader follows — an opening is a product no aggregate or containment reaches.
- **Property sets are read per element, one relation scan at a time.** `IfcRelDefinesByProperties`
  is walked for the element being described; a model with tens of thousands of relations makes
  the first click on an element slower than the rest. Nothing is cached across elements.
- **No `IfcSpatialStructureElement`-aware filtering and no quantities beyond the set.** The panel
  lists property and quantity sets; it does not compute areas, volumes or takeoffs, and it does
  not resolve a type's `IfcPropertySet` through `IfcRelDefinesByType` — only the sets defined
  directly on the occurrence.
- **The IFC reader ships inside the plugin bundle.** web-ifc is bundled and gzipped into
  `lib/client.js` (≈1.0 MiB compressed), which is the price of a client plugin having no host
  route to assume for a second script and a WASM binary. The finished bundle is ≈6.9 MiB.

### USD

- **MaterialX materials render grey.** The engine only understands `UsdPreviewSurface`,
  `OmniPBR`, and glTF MDL; a MaterialX-only asset hits the `material-fallback` warning.
- **Skeletal animation does not play.** Both paths show a static frame.
- **Interactive parts only exist on the WASM path.** The three fallback loses prim paths and
  crate `references`, so it never builds an articulation — the panel will not pretend.
- **Only three joint types, and no physics engine.** `PhysicsRevoluteJoint` /
  `PhysicsPrismaticJoint` / `PhysicsFixedJoint`; `drive`, `mimic` and articulation-root
  solving semantics are not simulated — motion is forward kinematics + authored limits. A
  joint authored as a full turn (±360°) is clamped to the authored end of its travel.
- **Colliders are a geometric overlay, not collision.** Only `purpose = "guide"` or
  `PhysicsCollisionAPI` meshes are drawn as a shell + wireframe; there is no collision
  detection and no capsule/box approximation.
- **Composed articulated assets assume an identity placement.** Bodies are read from the
  layer-local prim paths; a referenced asset is matched when its body chain appears contiguously
  inside the composed mesh path (`/World/Robot/root/Bodies/leaf` matches `/root/Bodies/leaf`,
  lookalikes never match). The referencing prim's own transform is ignored, and two references
  of the same articulated asset share one rest pose (the layer merge keeps the first definition),
  so only the primary instance is driven correctly.
- **Articulated stages keep one copy of the vertex arrays** (position / normal / uv) so that
  raycast picking works; static stages still release them.
- **The selection highlight is a tint, not an outline, and it is not a picking tool.** There is no
  hover state, no marquee, no multi-select and no "select all descendants of this prim": a click
  selects exactly the mesh (or the one `PointInstancer` placement) it landed on. It is also bounded
  by what can be picked at all — a stage above the picking budget keeps the engine's vertex-array
  release, so its canvas selects nothing. A selected object that is hidden (the collider toggle) is
  not drawn and neither is its tint, which is deliberate: the tint never claims an object is visible
  when the model itself does not draw it.
- **The details panel is a re-read of the layers, not a composed query.** It shows the value the
  strongest layer of the composed stage authored and names that layer; it does not evaluate variants,
  resolve `inherits` chains, or apply one layer's opinion over another's field by field — that is the
  engine's composition, and doing it again here would be a second opinion. It does follow `references`,
  `payload` and `subLayers` far enough to find the layer that authored a composed prim (see *Prim
  details* above), but it does not re-compose what it finds there. The three fallback keeps no layer
  map and reports that instead of showing nothing.
- **One read per referenced layer, byte-windowed above the Host cap.** The Host refuses a
  complete read above `workspaceFiles.maxFileBytes` (default 32 MiB) and one window above
  `maxBytes` (default 2 MiB). The reader asks for the complete layer first and, when the Host
  refuses it as too large, reassembles the layer from byte windows instead of dropping it —
  a solved SimReady robot's geometry layer is commonly ~90 MiB and would otherwise compose an
  empty stage. The fallback costs one Remote round-trip per window (and one `stat`), so a very
  large layer loads slower; raising `maxFileBytes` on the Host is still the cheapest option.
- **A dropped asset is read by the browser.** Its size is bounded by memory rather than the
  Host's read caps; the engine still enforces its own `maxLayerBytes` / `maxTextureBytes` /
  `maxTriangles` limits.
- **A dropped stage is a page tab, not a document.** It has no resource address, so the layout
  cannot restore it after a reload and it never appears in the Files-tab history; dropping the
  asset again reopens it.
- **References must resolve inside what was opened.** For a workspace file the reference must be
  a workspace-relative path: `@https://…@`, drive-letter absolute paths, and files outside the
  workspace cannot be read. A dropped asset resolves against the dropped file or folder instead,
  so dropping only the root layer of a referenced unit reports its siblings as `layer-missing`,
  exactly as if they had not been carried. Either way the engine reports the missing key and the
  panel lists it.
- **ASCII reference spelling in the fallback path.** The three fallback only understands
  `prepend references = @…@`; the engine follows the USD spec and accepts bare `references =`.
- **Texture channel packing** (roughness/metalness) is left to the engine/three respectively.
  `.exr` textures are not supported (PNG/JPEG/WebP only).
- **A wrong `rel prototypes` path is silent.** A malformed prototype path makes the inner
  instancer under-draw without a `composition` warning; check the **composed absolute** path
  first.
- **A UTF-8 BOM breaks the engine's ASCII reader** (`Logos error`). The plugin strips the first
  three bytes before handing bytes over; `tests/fixtures/arcs/root.usda` is deliberately
  BOM-prefixed as a regression fixture.
- **An absolute-address stage has no sibling reader.** A `dsh-resource://file/absolute/…`
  address carries no Session, so the engine can compose the opened layer and its `s3://`
  payloads but relative workspace references stay missing (and appear as warnings). Files
  opened through a Session address keep their workspace reader.
- **Object storage needs explicit configuration** (see above): environment-only, path-style,
  no STS session tokens, read-only, and crate-internal absolute `s3://` references need the
  opt-in crate patcher.
- **The engine transport patch is version-coupled.** The build rewrites one function of
  `@huggingface/usd-web-viewer`; upgrading the engine may require updating the anchor in
  `build.mjs` (the build fails loudly when it does).

## Scope

This plugin reads **local bytes only** — workspace files through the host's Remote, and files
the user drops on the sidebar through the browser's own file API — plus, when explicitly
configured through `DSH_USD_S3_*` environment variables, **read-only objects from an
S3-compatible object storage**. It mounts previews for six file extensions
(`.usd`/`.usda`/`.usdc`/`.usdz` and `.ifc`/`.ifczip`) and a drop entry for the USD four, and
nothing else: no uploads, no workspace writes, no credentials stored in the package, and no
configuration files.

Both engines run in the browser: the USD stage is composed by a WebAssembly OpenUSD, and the IFC
model is parsed by a WebAssembly web-ifc. Neither sends the file anywhere, and the IFC reader
needs no host route at all — a model is one self-contained STEP file.

Its host routes are all owner-only exact Fetch routes on the authenticated `/api` channel: the
read-only asset and health routes above, and the local-update route. The update route is the one
route that mutates the installation rather than reading data: on an explicit click it
fast-forwards this plugin's own checkout from its configured upstream (a network fetch of that
git remote), installs dependencies when `package.json` changed, and rebuilds `lib/`. It refuses
a dirty or detached checkout, never resets or force-updates, and runs only the fixed commands
named above. A published/installed copy without a `.git` directory cannot update itself.

## License

MIT — see [LICENSE](LICENSE).

## 中文简介

在 DeepSeek Harness 的右侧文档面板里直接预览 `.usd` / `.usda` / `.usdc` / `.usdz` 以及
`.ifc` / `.ifczip`：
组合（sublayer / reference / payload / variant / PointInstancer…）由 WebAssembly 版 OpenUSD
在 Web Worker 里完成，three.js 负责渲染；引擎不可用时自动回退到 three 的解析器并在面板上写明。
被引用图层经工作区 Remote 读回后重新组合，最多 8 轮；带 `UsdPhysics` 关节的资产可交互
（点击部件开合、全部打开/收起/复位、碰撞体线框，纯前向运动学，无物理引擎）；影棚布光 + 按需绘制。
点击模型会**高亮**点中的物体：在原网格上叠一层强调色着色，面板同时显示它的 prim 路径；
**Esc**、面板上的 ×、或点击空白处都能取消高亮，取消后画面与未选中时逐像素一致；
高亮跟随部件本身的关节运动，`PointInstancer` 只高亮被点中的那一个实例，且高亮本身不会挡住下一次点击。
「详情」面板按 usdview 的 Prim Metadata / Attributes 版面展示选中 prim 的声明：类型与 kind、
已应用的 API Schema、逐条属性的**声明类型**与值（含 `custom` / `uniform` 标记）、关系的关系路径，
以及该 prim 来自哪些图层（多层时逐条属性标注取值来自哪一层）；被 `references` / `payload` 重新挂载的
prim 会按图层里真实书写的路径回读，并同时标出组合后的路径与原路径；超长数组只报元素个数与前几项
（`point3f[482] (…)`），因此读取大资产的几何图层也是一次分隔符扫描，不会把整层解析进内存。
外部资产（桌面上的文件或文件夹）可以直接拖到右侧边栏打开：侧边栏「开始」页有「USD 三维预览」
入口卡片，拖拽落在侧边栏面板上即会打开预览标签页，文件夹会连同被引用的图层和贴图一起读取；
字节只在浏览器内处理，不上传、不写入工作区。
**IFC 模型**是同一套视口的第二个格式：STEP 文件由 web-ifc（WebAssembly）在独立的 Worker 里解析，
被 gzip 压缩后随客户端 bundle 一起下发（首次使用时用 `DecompressionStream` 解压，因此 bundle 只多约
1.0 MiB 而不是 6.8 MiB）。每个构件的摆放矩阵在 Worker 里就乘好（web-ifc 的 `flatTransformation`
本身已经包含 Z-up→Y-up 与长度单位换算），页面拿到的是世界坐标三角形，因此统计、拾取与取景三者一致。
面板显示 schema（IFC2X3 / IFC4 / IFC4X3）、构件数、网格数、三角面数与实测尺寸，非米制时另外标出
建模单位。「构件」面板按 `IfcRelAggregates` 与 `IfcRelContainedInSpatialStructure` 展示空间结构
（project → site → building → storey → 构件），可折叠、可过滤、可点击选中；`IfcOpeningElement`
会挂在它掏空的那个构件下面（`IfcRelVoidsElement` 是读取器跟踪的第三种关系）。点中构件后「详情」
面板按属性集列出该构件的 `IfcPropertySet` / `IfcElementQuantity`，每条属性带它的 IFC 值类型
（`IFCBOOLEAN` / `IFCREAL` / `IFCLABEL`…）。表面颜色取自 `IfcSurfaceStyle` 的 `IfcColourRgb`，
按颜色共享材质；没有样式的模型用中性灰而不是纯黑。
可选支持 `s3://` 对象存储引用：由宿主半边用 `DSH_USD_S3_*` 环境变量配置的凭据做只读 SigV4
签名读取，浏览器侧把 ASCII 图层的 `s3://` 引用本地化到引擎包键后组合。构建：
`npm install && npm run build && npm test`。本地 checkout 可用 `npm run update:local`（或 Web UI 的
Settings → Plugins「插件更新」页 / 插件详情页）一键更新：快进上游、按需安装依赖、重建 `lib/`；
若 `lib/index.js` 变化则重启宿主，其余情况客户端 bundle 由 HMR 自动热加载。
