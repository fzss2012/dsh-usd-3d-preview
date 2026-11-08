# dsh-usd-3d-preview

**OpenUSD in the browser.** A document preview for `.usd` / `.usda` / `.usdc` / `.usdz`
that opens a USD stage in a side panel of the DeepSeek Harness (DSH) and draws it in
WebGL with a studio-lit viewport — orbit camera, three-point lighting with shadows,
reference grid, and the measured bounding-box size. Authored `UsdPhysics` joints and
colliders make the stage **interactive**: click a part to open or close it, drive the
whole mechanism from a toolbar. Optional read-only object-storage support resolves
`s3://` references through a signed host route. No converter process, no upload, no
native toolchain.

The important part is that **OpenUSD itself does the composition**: a pure-Rust build of
OpenUSD compiled to WebAssembly (`@huggingface/usd-web-viewer`, MIT) composes the stage in
a Web Worker — sublayers, references, payloads, variants, instancers — and three.js renders
the result. If the engine cannot load, the viewer falls back to three's own crate/ASCII parser
and says so in the panel.

It is one package in two halves: a **dsh bundle** and a **browser client plugin**.

```
dsh-usd-3d-preview
├─ lib/index.js            host half (ESM; one read-only asset route when object storage is configured)
├─ lib/client.js           browser half (classic-CJS module-table entry; three, the WASM engine,
│                          articulation/kinematics and the studio view are inlined)
├─ src/                    the only source of truth: host/ + client/
├─ tests/                  seven suites (including real Chromium pixel tests) + fixtures
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

| Input | WASM engine (default) | Fallback (three) |
|---|---|---|
| `.usda` (ASCII stage) | ✅ native composition | ✅ parses |
| `.usd` (ASCII or crate) | ✅ container decided by the **first 8 bytes**, not the extension | ✅ |
| `.usdc` (binary crate) | ✅ native crate + composition arcs | ⚠️ reads geometry, but the crate's `references` list-op is not decoded |
| `.usdz` (zip package) | ✅ unzipped, root layer + textures together | ✅ |
| `subLayers = [@./x.usda@]` | ✅ (fixture: 3 layers / 2 meshes / 4 triangles) | ❌ not implemented |
| `prepend references = @../x.usd@` | ✅ composed after a workspace read-back | ✅ (ASCII only, and only the `prepend` spelling) |
| `UsdGeomPointInstancer` | ✅ every placement drawn; same prototype + material merges into one `InstancedMesh`, budget 100k instances | ❌ not implemented — only the prototype is drawn once |
| Nested `PointInstancer` | ✅ recursively expanded: 2×3 = **6** quads, three levels 2×3×3 = **18** | ❌ as above |
| Custom-typed instancer prims | ✅ a prim whose fields are exactly `PointInstancer`'s is retyped on the way in | ❌ |
| Multi-level reference chains | ✅ the engine reports the layers it lacks → each is read back → recompose (up to 8 passes) | ✅ regex scan + BFS (24-layer cap) |
| `metersPerUnit` / `upAxis = "Z"` | ✅ normalised to Y-up / metres by the engine | ✅ handled by `USDComposer` |
| Materials / primvars / variant selection | ✅ `UsdPreviewSurface`, `OmniPBR`, glTF MDL (**MaterialX renders grey**, see limitations) | ✅ `UsdPreviewSurface`, OpenPBR, MaterialX image nodes |
| Skeletal animation (`UsdSkel`) | ❌ not supported by the engine; static frame | animations are parsed into `group.animations`, but the preview shows a static frame |

| Interactive / environment | WASM engine (default) | Fallback (three) |
|---|---|---|
| `UsdPhysics` joints (`PhysicsRevoluteJoint` / `PhysicsPrismaticJoint` / `PhysicsFixedJoint`) | ✅ read back from the composed layer bytes: body tree, axes, travel limits, home pose; click-to-toggle + All open / All close / Home | ❌ prim paths are lost in the fallback, no articulation |
| Collider geometry (`purpose = "guide"` or `PhysicsCollisionAPI`) | ✅ rebuilt from the same bytes as an overlay + wireframe, hidden by default | ❌ |
| Studio rendering | ✅ Khronos PBR Neutral tone mapping, PMREM environment, 4 rect lights, 2048² shadows, lit ground disc, on-demand draw | ✅ same view |
| `s3://` asset-layer references | ✅ ASCII layers localized + prefetched through the host route (object storage must be configured) | ❌ |

The stats line at the bottom of the panel reports **engine / layer count / warning count**, and
the warnings are listed by engine code (`layer-missing`, `composition`, `material-fallback`,
`texture-failed`, `prim-unsupported`, `instance-limit`, …). "Why is something missing?" is
answered by the panel instead of by guesswork. Meshes and triangles are counted **as drawn**:
an `InstancedMesh` is multiplied by its instance count and reported on its own "instances" line.
With an articulated asset the panel also reports the number of moving parts in
`data-usd-parts`, and the toolbar only appears when parts were actually read.

## Architecture

```
Files tab click
   │
   ├─ documentPreviews  ← definition registered by src/client/usd.js
   │     id: dsh-usd-3d-preview/usd   extensions: usd usda usdc usdz   loading: bytes-complete
   │
   └─ sidebar.right.tab.document (keyed body: UsdBody)
         │
         ├─ assemble()  ─── WASM engine in a Web Worker ─── OpenUSD composition
         │      │                ▲
         │      │                └── files map (layer key → bytes) + 8 read-back passes
         │      ├─ articulation: UsdPhysics read back from the same layer bytes
         │      │     (src/client/articulation.js → src/client/kinematics.js)
         │      └─ fallback: three USDCParser / USDAParser / USDComposer
         │
         ├─ createView()  (src/client/view.js)
         │     ├─ three.js WebGLRenderer + src/client/studio.js
         │     └─ orbit controls, 3-point rect lights, shadows, ground, framing, on-demand draw
         │
         └─ injected readers: readLayer (workspace Remote) → sibling layer bytes
                              readAsset  (host route)      → s3:// object bytes
```

Everything that crosses a boundary is injected rather than imported: the body receives
`readLayer` and `readAsset`, so the assembly is testable without a host and the workspace
Remote remains the only component that knows how to locate a sibling file. `index.jsx`
registers three reversible effects — the dictionaries, the preview definition, and the keyed
body — through public client services only (`documentPreviews`, `slots`, `locale`, `remote`).

### The read-back loop

The engine fetches its own layers over http(s), which a workspace file is not. So:

1. the opened file's bytes are registered in the engine's `files` map under its
   workspace-relative path;
2. the engine composes once and reports `layer-missing` / `texture-failed` warnings whose
   `path` is the exact key it looked up (`local:///…`);
3. each missing key is read through the workspace reader, added to the map, and the stage is
   recomposed — **up to 8 passes** (measured: a 2-hop reference chain converges in 2 passes).

Both the worker script and the `.wasm` binary travel inside `lib/client.js` as base64 and
become blob URLs at first use. This is deliberate: a client plugin ships as one module-table
entry and cannot assume a host route for two extra files. It costs ~3 MiB of bundle size, and
`lib/client.js` ends up around 5.0 MiB (three ≈ 1.4 MiB + engine ≈ 2.2 MiB of WASM +
articulation/kinematics and the studio view).

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
- framing uses the union of the rest pose and the joint-travel extremes, so opening a joint
  never pushes parts out of the viewport.

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

1. **Host route (signed read).** `GET /usd-preview/asset?uri=s3://…` on the host half signs a
   SigV4 GET with credentials from the environment and streams the bytes back; a small
   `GET /usd-preview/health` reports whether object storage is configured (endpoint/bucket
   only — never keys). Both routes are read-only, same-origin, and guarded by a custom
   request header that a cross-origin page cannot send without a preflight.
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

Object bytes are cached in `$DSH_HOME/cache/usd-assets/` (memory + disk), and the cache is
best-effort: a read-only cache directory never breaks a preview. When object storage is not
configured, `s3://` references simply appear in the warnings list as `layer-missing`.

Known limits of this path: only path-style S3-compatible endpoints are addressed; session
tokens (STS) are not supported; nothing about the bucket is modified; and a binary crate's
**internal** absolute `s3://` references cannot be rewritten as text, so a crate that
references object storage directly only composes when the opt-in equal-length crate patcher
is enabled (`globalThis.__DSH_USD_PATCH_CRATE_REFS__ = true`) or the asset is exported
self-contained.

## Build and install

Requires **Node ≥ 20** and npm.

```bash
npm install            # three, esbuild, react, react-dom, @huggingface/usd-web-viewer
npm run build          # 1) embeds the worker + wasm into src/client/engine-assets.generated.js
                       # 2) writes lib/index.js and lib/client.js
npm test               # register + parse + articulation + s3 + studio + articulation-render + render
node tests/probe.mjs arcs/root.usda    # optional: print engine/stats/warnings for one file
```

`lib/` and `src/client/engine-assets.generated.js` are build products and are git-ignored:
clone → `npm install` → `npm run build` produces them. The build patches the viewer engine's
asset transport to route `s3:` URLs through the host route; if a future engine version moves
that function the build fails loudly instead of silently dropping object-storage support.

### As a dsh bundle

The package is a bundle (`dsh.bundle.patch` → `cordis.patch.yml`) that inserts one loader entry,
`ui-usd-3d-preview`, plus a client half (`dsh.client`, platform `web`) that the host serves to
the browser. Add it to a profile:

```jsonc
// <profile>/package.json
"dependencies": { "dsh-usd-3d-preview": "link:C:/path/to/dsh-usd-3d-preview" },
"dsh": { "profile": { "bundles": [ /* … */, "dsh-usd-3d-preview" ] } }
```

Profiles are live: the manifest and the patch file are watched, so no app restart is needed to
pick the bundle up. The browser half hot-reloads; the host half goes through Node's ESM module
cache, so a host change (the asset route) needs an app restart. To switch the plugin off,
disable it in Settings → Plugins, or set `disabled: true` on the `ui-usd-3d-preview` entry in
the patch layer.

## Tests

| Suite | What it proves |
|---|---|
| `register` | evaluates `lib/client.js` under the shell's `window.__ModuleLoader__` contract in Node: registration id, `apply`/`inject`, **the only external module requested is react**, the definition id equals the body key, and the injected `readLayer` really goes through the workspace Remote |
| `parse` | magic-number dispatch for all four containers; **ASCII and crate must produce the same geometry** (2 meshes / 972 triangles / identical extent); a reference chain assembles when given a reader and stays honestly empty without one; address and path helpers |
| `articulation` | joint read-back and kinematics, **no browser needed**: five authored joint fixtures (door / drawer / three-link chain / fixed-only / no physics) go through `readArticulation`; the controller is validated on a synthetic scene (world matrices unchanged before/after binding, travel inside the limits, home to 1e-6, picking hits the right joint and ignores fixed joints, collider toggle, dispose restores) |
| `s3` | host-side asset-library logic offline: environment-only configuration, `keyOf` validation, SigV4 request shape, memory/disk cache, 404 handling — no network and no real credentials |
| `studio` | **real Chromium + WebGL**: mounts `createView` and asserts neutral tone mapping, sRGB, PCF shadows, PMREM environment, four rect lights, the lit ground disc and the on-demand frame rhythm (0 frames while idle) |
| `articulation-render` | **real Chromium + WebGL**: `UsdBody` mounts an articulated fixture, then clicks are resolved against the rendered pixels (only a click that changes the canvas counts): toggling a part changes the frame, Home restores it, colliders add their overlay, and idle draws nothing |
| `render` | **real Chromium + WebGL**: `UsdBody` mounted with real props (including both injected readers) over the committed fixtures — package, ASCII, crate, reference chain, **sublayer + reference**, instancer, nested instancer, custom-typed instancer, articulated fixture — each must draw a non-flat frame and the stats must name the OpenUSD (WASM) engine. Screenshots land in `tests/.artifacts/` |

The browser suites need Playwright + Chromium; without a browser they print `SKIP` and exit 0,
so the offline suites still run everywhere:

```bash
npm install --no-save playwright
npx playwright install chromium
npm test
```

Optional real-asset suites are gated by environment variables and skip when unset:
`DSH_USD_TEST_SIMREADY` (a local articulated `.usdc` asset) and `DSH_USD_TEST_SCENE` (a local
stage whose layers resolve through the S3 object storage configured above;
`DSH_USD_TEST_SCENE_ROOT` optionally overrides the addressed root). The browser tests decode
and compare screenshots in-process (`tests/pixel-probe.mjs`), so no Python/Pillow is needed.

Panel screenshots for a release or review can be captured from the same harness with
`node tests/capture.mjs` — see [docs/screenshots/README.md](docs/screenshots/README.md).

Fixtures: `tests/fixtures/sample.{usda,usd,usdc,usdz}` are four containers of one scene
exported by Blender (`tests/make-fixtures.py` regenerates them); `refs/unit.usda →
refs/geom/body.usda` is a reference chain; `arcs/root.usda → sub/base.usda + ref/body.usda`
is a sublayer + reference combination that three's composer cannot do at all;
`joints/*.usda` are hand-authored `UsdPhysics` stages; `remote/root.usda` is an
object-storage reference example.

## Limitations

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
- **Articulated stages keep one copy of the vertex arrays** (position / normal / uv) so that
  raycast picking works; static stages still release them.
- **32 MiB per file read.** That is the host's `workspaceFiles.readBytes` `maxFileBytes`
  default, and referenced layers share it. It is a host setting, not something this plugin
  can change; an over-limit file reports an explicit read failure rather than an empty stage.
- **Workspace references must be workspace-relative paths.** `@https://…@`, drive-letter
  absolute paths, and files outside the workspace cannot be read; the engine reports them as
  `layer-missing` and they appear in the warnings list.
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
- **Object storage needs explicit configuration** (see above): environment-only, path-style,
  no STS session tokens, read-only, and crate-internal absolute `s3://` references need the
  opt-in crate patcher.
- **The engine transport patch is version-coupled.** The build rewrites one function of
  `@huggingface/usd-web-viewer`; upgrading the engine may require updating the anchor in
  `build.mjs` (the build fails loudly when it does).

## Scope

This plugin reads **local workspace files** and, when explicitly configured through
`DSH_USD_S3_*` environment variables, **read-only objects from an S3-compatible object
storage**. It mounts a preview for four file extensions inside the DSH workspace: no
uploads, no network access of its own, no credentials stored in the package, no
configuration files, and no host route other than the read-only asset route above.

## License

MIT — see [LICENSE](LICENSE).

## 中文简介

在 DeepSeek Harness 的右侧文档面板里直接预览 `.usd` / `.usda` / `.usdc` / `.usdz`：
组合（sublayer / reference / payload / variant / PointInstancer…）由 WebAssembly 版 OpenUSD
在 Web Worker 里完成，three.js 负责渲染；引擎不可用时自动回退到 three 的解析器并在面板上写明。
被引用图层经工作区 Remote 读回后重新组合，最多 8 轮；带 `UsdPhysics` 关节的资产可交互
（点击部件开合、全部打开/收起/复位、碰撞体线框，纯前向运动学，无物理引擎）；影棚布光 + 按需绘制。
可选支持 `s3://` 对象存储引用：由宿主半边用 `DSH_USD_S3_*` 环境变量配置的凭据做只读 SigV4
签名读取，浏览器侧把 ASCII 图层的 `s3://` 引用本地化到引擎包键后组合。构建：
`npm install && npm run build && npm test`。
