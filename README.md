# dsh-usd-3d-preview

**OpenUSD in the browser.** A document preview for `.usd` / `.usda` / `.usdc` / `.usdz`
that opens a USD stage in a side panel of the DeepSeek Harness
(DSH) and draws it in WebGL — orbit camera, three-point lighting, reference grid, and the
measured bounding-box size. No converter process, no upload, no native toolchain.

The important part is that **OpenUSD itself does the composition**: a pure-Rust build of
OpenUSD compiled to WebAssembly (`@huggingface/usd-web-viewer`, MIT) composes the stage in a
Web Worker — sublayers, references, payloads, variants, instancers — and three.js renders the
result. If the engine cannot load, the viewer falls back to three's own crate/ASCII parser and
says so in the panel.

It is one package in two halves: a **dsh bundle** and a **browser client plugin**.

```
dsh-usd-3d-preview
├─ lib/index.js            host half (ESM, empty — this package has no host logic)
├─ lib/client.js           browser half (classic-CJS module-table entry; three and the
│                          WASM engine are inlined, so the shell needs no extra seed word)
├─ src/                    the only source of truth: host/ + client/
├─ tests/                  three suites (including a real Chromium render) + fixtures
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

Measured by `npm test` (fixtures are committed; the render suite draws them in Chromium).

| Input | WASM engine (default) | Fallback (three) |
|---|---|---|
| `.usda` (ASCII stage) | ✅ native composition | ✅ parses |
| `.usd` (ASCII or crate) | ✅ container decided by the **first 8 bytes**, not the extension | ✅ |
| `.usdc` (binary crate) | ✅ native crate + composition arcs | ⚠️ reads geometry, but the crate's `references` list-op is not decoded |
| `.usdz` (zip package) | ✅ unzipped, root layer + textures together | ✅ |
| `subLayers = [@./x.usda@]` | ✅ (fixture: 3 layers / 2 meshes / 4 triangles) | ❌ not implemented |
| `prepend references = @../x.usd@` | ✅ composed after a workspace read-back | ✅ (ASCII only, and only the `prepend` spelling) |
| `UsdGeomPointInstancer` | ✅ every placement drawn; same prototype + material merges into one `InstancedMesh` (measured: 200 instances = 1 draw call), budget 100k instances | ❌ not implemented — only the prototype is drawn once, all placements are lost |
| Nested `PointInstancer` | ✅ recursively expanded: 2×3 = **6** quads, three levels 2×3×3 = **18**, positions and bounds correct | ❌ as above |
| Multi-level reference chains | ✅ the engine reports the layers it lacks → each is read back → recompose (up to 8 passes) | ✅ regex scan + BFS (24-layer cap) |
| `metersPerUnit` / `upAxis = "Z"` | ✅ normalised to Y-up / metres by the engine | ✅ handled by `USDComposer` |
| Materials / primvars / variant selection | ✅ `UsdPreviewSurface`, `OmniPBR`, glTF MDL (**MaterialX renders grey**, see limitations) | ✅ `UsdPreviewSurface`, OpenPBR, MaterialX image nodes |
| Skeletal animation (`UsdSkel`) | ❌ not supported by the engine; static frame | animations are parsed into `group.animations`, but the preview shows a static frame |

The stats line at the bottom of the panel reports **engine / layer count / warning count**, and
the warnings are listed by engine code (`layer-missing`, `composition`, `material-fallback`,
`texture-failed`, `prim-unsupported`, `instance-limit`, …). "Why is something missing?" is
answered by the panel instead of by guesswork. Meshes and triangles are counted **as drawn**:
an `InstancedMesh` is multiplied by its instance count and reported on its own "instances" line
(otherwise 200 placements would be reported as one mesh).

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
         │      └─ fallback: three USDCParser / USDAParser / USDComposer
         │
         └─ three.js WebGLRenderer (orbit controls, 3-point light, grid, bounds)
                │
                └─ readLayer(injected) → workspace Remote → sibling layer bytes
```

Everything that crosses a boundary is injected rather than imported: the body receives
`readLayer`, so the assembly is testable without a host and the workspace Remote remains the
only component that knows how to locate a sibling file. `index.jsx` registers three reversible
effects — the dictionaries, the preview definition, and the keyed body — through public client
services only (`documentPreviews`, `slots`, `locale`, `remote.workspaceFiles`).

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
`lib/client.js` ends up around 4.7 MiB (three ≈ 1.4 MiB + engine ≈ 2.2 MiB of WASM).

## Build and install

Requires **Node ≥ 20** and npm.

```bash
npm install            # three, esbuild, react, react-dom, @huggingface/usd-web-viewer
npm run build          # 1) embeds the worker + wasm into src/client/engine-assets.generated.js
                       # 2) writes lib/index.js and lib/client.js
npm test               # register + parse + render suites
node tests/probe.mjs arcs/root.usda    # optional: print engine/stats/warnings for one file
```

`lib/` and `src/client/engine-assets.generated.js` are build products and are git-ignored:
clone → `npm install` → `npm run build` produces them.

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
pick the bundle up. The browser half hot-reloads; the host half (empty here) goes through Node's
ESM module cache. To switch the plugin off, disable it in Settings → Plugins, or set
`disabled: true` on the `ui-usd-3d-preview` entry in the patch layer.

## Limitations

- **MaterialX materials render grey.** The engine only understands `UsdPreviewSurface`,
  `OmniPBR`, and glTF MDL; a MaterialX-only asset hits the `material-fallback` warning. (The
  three fallback can texture MaterialX image nodes, but that path has no composition arcs.)
- **Skeletal animation does not play.** Both paths show a static frame.
- **32 MiB per file read.** That is the host's `workspaceFiles.readBytes` `maxFileBytes`
  default, and referenced layers share it. It is a host setting, not something this plugin can
  change; an over-limit file reports an explicit read failure rather than an empty stage.
- **References must be workspace-relative paths.** `@https://…@`, drive-letter absolute paths,
  and files outside the workspace cannot be read; the engine reports them as `layer-missing`
  and they appear in the warnings list.
- **ASCII reference spelling in the fallback path.** The three fallback only understands
  `prepend references = @…@`; the engine follows the USD spec and accepts bare `references =`.
- **Texture channel packing** (roughness/metalness) is left to the engine/three respectively.
  `.exr` textures are not supported (PNG/JPEG/WebP only).
- **A wrong `rel prototypes` path is silent.** A malformed prototype path makes the inner
  instancer under-draw without a `composition` warning, so when instances are missing, check the
  prototype path first (`</root/…/Prototypes/…>` must be the **composed absolute** path).
- **A UTF-8 BOM breaks the engine's ASCII reader** (`Logos error`). The plugin strips the first
  three bytes before handing bytes over; `tests/fixtures/arcs/root.usda` is deliberately
  BOM-prefixed as a regression fixture.

## Tests

| Suite | What it proves |
|---|---|
| `register` | evaluates `lib/client.js` under the shell's `window.__ModuleLoader__` contract in Node: registration id, `apply`/`inject`, **the only external module requested is react**, the definition id equals the body key, and the injected `readLayer` really goes through the workspace Remote |
| `parse` | magic-number dispatch for all four containers; **ASCII and crate must produce the same geometry** (2 meshes / 972 triangles / identical extent); a reference chain assembles when given a reader and stays honestly empty without one; address and path helpers |
| `render` | **real Chromium + WebGL**: `UsdBody` mounted with real props (including the injected reader) over nine fixtures — package, ASCII, crate, reference chain, **sublayer + reference**, instancer, nested instancer, three-level instancer, custom-typed instancer — each must draw a non-flat frame, and the stats must name the OpenUSD (WASM) engine. Screenshots land in `tests/.artifacts/` |

The render suite needs Playwright, which is intentionally not a package dependency (most of the
work is offline):

```bash
npm install --no-save playwright
npx playwright install chromium
npm test
```

Without Playwright the suite prints `SKIP` and exits 0 — the `register` and `parse` suites still
run and must pass. The canvas colour probe additionally needs Pillow; without it the stats and
screenshot assertions still run and the colour check reports itself as skipped.

Fixtures: `tests/fixtures/sample.{usda,usd,usdc,usdz}` are four containers of one scene exported
by Blender (`tests/make-fixtures.py` regenerates them); `refs/unit.usda → refs/geom/body.usda` is
a reference chain; `arcs/root.usda → sub/base.usda + ref/body.usda` is a sublayer + reference
combination that three's composer cannot do at all.

## Scope

This plugin reads **local workspace files only**. It mounts a preview for four file extensions
inside the DSH workspace and nothing else: no network access of its own, no uploads, no
credentials, no host route, and no configuration. Cloud asset-library support (object storage
buckets referenced from a stage) was intentionally omitted from this open-source release; such
references are reported as warnings rather than resolved.

## License

MIT — see [LICENSE](LICENSE).

## 中文简介

在 DeepSeek Harness 的右侧文档面板里直接预览 `.usd` / `.usda` / `.usdc` / `.usdz`：
组合（sublayer / reference / payload / variant / PointInstancer…）由 WebAssembly 版 OpenUSD
在 Web Worker 里完成，three.js 负责渲染；引擎不可用时自动回退到 three 的解析器并在面板上写明。
被引用图层经工作区 Remote 读回后重新组合，最多 8 轮。本开源版本只读取本地工作区文件，
云端资产库支持已移除（相关引用会出现在提示列表里，而不是被解析）。构建：`npm install &&
npm run build && npm test`。
