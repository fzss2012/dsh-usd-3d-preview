# Sanitization report

| | |
|---|---|
| Release | `dsh-usd-3d-preview` 1.0.0, MIT |
| Date | 2026-11-04 |
| Source | a private installation of the same plugin (read-only during this work; not modified) |
| Target | this repository — 36 tracked files, one initial commit |
| Goal | publish the core capability (OpenUSD composition in the browser) with **no** internal asset-library, toolchain, or machine-path information |

## 1. What was kept

The capability the plugin exists for is untouched:

- composition through the WebAssembly OpenUSD engine (`@huggingface/usd-web-viewer`) in a Web
  Worker, with three's `USDCParser` / `USDComposer` as the fallback;
- the **read-back loop**: the engine reports the layers it could not find, the workspace reader
  supplies them, the stage is recomposed (up to 8 passes);
- composition arcs — sublayers, references, payloads, variants, nested and three-level
  `PointInstancer`;
- the UTF-8 BOM strip for ASCII layers, and the retyping of a custom-typed prim that carries
  `PointInstancer` fields (rewritten to be described generically — it is a useful
  compatibility behaviour, not an internal one);
- the viewport UI, both locale dictionaries, the registration contract, the build script, the
  three test suites, and all Blender-authored fixtures.

## 2. Removed or rewritten

| # | Item | Where it was | Change |
|---|---|---|---|
| 1 | Host asset route (`GET /usd-preview/asset`, plus a `/usd-preview/health` endpoint) | `src/host/index.js` | host half reduced to an empty plugin (25 lines); the package now has **no host logic** |
| 2 | Object-storage signing module: credential discovery from a desktop toolchain's config file, request signing, disk cache | a second file in `src/host/` | deleted |
| 3 | Client-side asset reader: the `readAsset` injection and the `fetch` of the host route | `src/client/index.jsx`, `src/client/UsdBody.jsx` | the body injects `readLayer` only; UI fallbacks moved to English |
| 4 | Asset-URI helpers (split, base directory, resolve against a layer URI) | `src/client/usd.js` | deleted (203 → 157 lines) |
| 5 | Layer URL localisation under a package prefix, equal-length patching of crate reference literals, alias registration for absolute URIs, prefetch of pending assets, and object-storage-shaped warning handling | `src/client/engine.js` | deleted; only the generic `layer-missing` / `texture-failed` loop remains (436 → 252 lines) |
| 6 | Build-time esbuild plugin that patched the engine's transport to route object-storage URLs to the host | `build.mjs` | removed (191 → 135 lines); the build is now a plain two-half bundle |
| 7 | Internal authoring-toolchain name and workflow narration (comments, docs, patch layer, tests) | `README.md`, `cordis.patch.yml`, `src/client/engine.js`, `tests/render.test.mjs` | rewritten neutrally; no internal tool name, product name, or workflow detail remains |
| 8 | Internal scene fixtures: an arrangement fixture named after the internal tool, a captured real scene, and a remote-reference fixture | `tests/fixtures/` | deleted; a neutral synthetic fixture (`tests/fixtures/instancer/custom-typed.usda`) keeps the same coverage |
| 9 | Machine-specific asset probe with absolute design-tree paths | `tests/real-assets.mjs` | deleted |
| 10 | Debug probes bound to one internal scene (absolute scene path, asset-route wiring) | `tests/_tree-probe.mjs`, `tests/_tree-entry.js` | deleted; `tests/probe.mjs` remains as a generic single-file probe |
| 11 | Internal measurements and experiment log in the README (internal scene layer/mesh counts, internal paths) | `README.md` | replaced by fixture-measured numbers and by a description of behaviour only |
| 12 | Host-route mention in the patch layer, and the install/rollback instructions that referenced the installed machine | `cordis.patch.yml`, `README.md` | rewritten as an open-source install/build guide |

The README also states the remaining behaviour explicitly: **"This plugin reads local workspace
files only … Cloud asset-library support (object storage buckets referenced from a stage) was
intentionally omitted from this open-source release; such references are reported as warnings
rather than resolved."**

## 3. Leak audit

### 3.1 The required pattern, over every tracked file

The internal tokens are written below in **bracket-escaped** form — `B[D]` instead of the literal
two letters, `s[3]:[/][/]` instead of the URI prefix, and so on. That is deliberate: this report
is itself part of the repository, so spelling a token out would make the audit fail on the
report. A character class matches exactly the same text, so the command below is the required
pattern, unchanged in meaning:

```text
$ git grep -I -n -E 'B[D]|asset[l]ib|M[i]nio|s[3]:[/][/]|Y:\\proj[e]cts|G:\\Isaac[Ll]ab|content[-]ops|淘[丁]|极[佳]'
$ echo $LASTEXITCODE
1                        # git grep exit 1 = no match, i.e. 0 hits
```

Per token, same tree, same options (`-I` skips the binary fixtures `sample.usdc` / `sample.usdz`):

| Token | Hits |
|---|---|
| `B[D]` — internal toolchain name | **0** |
| `asset[l]ib` — its asset-library descriptor | **0** |
| `M[i]nio` — the object-storage server | **0** |
| `s[3]:[/][/]` — object-storage URI prefix | **0** |
| `Y:\\proj[e]cts` — internal project root | **0** |
| `G:\\Isaac[Ll]ab` — internal design-asset root | **0** |
| `content[-]ops` — internal content repository name | **0** |
| `淘[丁]` — internal Chinese brand name 1 | **0** |
| `极[佳]` — internal Chinese brand name 2 | **0** |

### 3.2 Wider risk scan

Beyond the required pattern, the tracked tree was scanned case-insensitively for the internal
tool name as a whole word and as an executable name, the internal product name, the descriptor
file name, the object-storage client name and scheme prefix, Windows drive letters, the local
user name, two internal project ids, and the CJK brand names above. **All zero.** There is no
remote URL, no credential reference, no absolute machine path, and no mention of the removed
asset library beyond the generic English sentence quoted in §2.

### 3.3 Two deliberate exclusions from the audit set

- **Binary fixtures** (`tests/fixtures/sample.usdc`, `sample.usdz`) are Blender output; byte
  sequences in a binary blob are not information, and `git grep -I` correctly skips them.
- **`package-lock.json` is not committed.** A regenerated lockfile contains base64 SHA-512
  integrity strings, and one of them happens to contain the upper-case letters `B` and `D` next
  to each other. It is not a leak, but it would produce a spurious hit for anyone running the
  audit on a working copy, and it is not part of the published package (`files` in
  `package.json`) either. `npm install` regenerates it locally; `node_modules/`, `lib/`, the
  generated engine-assets module, and `tests/.artifacts/` are likewise ignored.

## 4. Build and test evidence

Toolchain on the verification machine: Node **v24.14.0**, npm **11.9.0**, git **2.51.0**.

### 4.1 Install and build

```text
$ npm install
added 9 packages in 12s

$ npm run build
engine-assets.generated.js  regenerated (43966bb8571e2b78)
lib/index.js  0.2 KiB
lib/client.js  4751.2 KiB

$ npm run build            # idempotency check: the engine digest is content-addressed
engine-assets.generated.js  unchanged (43966bb8571e2b78)
lib/index.js  0.2 KiB
lib/client.js  4751.2 KiB
```

### 4.2 `npm test` — all three suites pass

```text
──── register ────
register.test.mjs  OK  (3 effects, 2 module requests)

──── parse ────
assemble sample.usda   130380 B  usda  2 meshes  972 tris  3.20x2.00x2.00  49 ms
assemble sample.usd    130380 B  usda  2 meshes  972 tris  3.20x2.00x2.00  23 ms
assemble sample.usdc    39249 B  usdc  2 meshes  972 tris  3.20x2.00x2.00  11 ms
assemble sample.usdz    39415 B  usdz  2 meshes  972 tris  3.20x2.00x2.00   4 ms
parse.test.mjs  OK  (4 containers, ASCII/crate parity, reference chain, helpers)

──── render ────
render  sample.usdz              package                   963 colours  Container: usdz | Engine: OpenUSD (WASM) | Layers: 1 | Meshes: 2 | Triangles: 972 | Size: 3.200 × 2.000 × 2.000
render  sample.usda              ASCII                     963 colours  Container: usda | Engine: OpenUSD (WASM) | Layers: 1 | Meshes: 2 | Triangles: 972 | Size: 3.200 × 2.000 × 2.000
render  sample.usdc              binary crate              963 colours  Container: usdc | Engine: OpenUSD (WASM) | Layers: 1 | Meshes: 2 | Triangles: 972 | Size: 3.200 × 2.000 × 2.000
render  refs/unit.usda           reference chain           269 colours  Container: usda | Engine: OpenUSD (WASM) | Layers: 2 | Meshes: 1 | Triangles: 2 | Size: 1.000 × 1.000 × 0
render  arcs/root.usda           sublayer + reference      365 colours  Container: usda | Engine: OpenUSD (WASM) | Layers: 3 | Meshes: 2 | Triangles: 4 | Size: 4.000 × 1.000 × 2.000
render  instancer/root.usda      PointInstancer            281 colours  Container: usda | Engine: OpenUSD (WASM) | Layers: 1 | Meshes: 4 | Triangles: 8 | Size: 7.000 × 1.000 × 0
render  instancer/nested.usda    nested instancer          275 colours  Container: usda | Engine: OpenUSD (WASM) | Layers: 1 | Meshes: 6 | Triangles: 12 | Instances: 6 | Size: 15.0 × 1.000 × 0
render  instancer/trideep.usda   three-level instancer     269 colours  Container: usda | Engine: OpenUSD (WASM) | Layers: 1 | Meshes: 18 | Triangles: 36 | Instances: 18 | Size: 33.0 × 1.000 × 0
render  instancer/custom-typed.usda custom-typed instancer 250 colours  Container: usda | Engine: OpenUSD (WASM) | Layers: 1 | Meshes: 4 | Triangles: 8 | Size: 1.000 × 7.000 × 0
render.test.mjs  OK  (9 files drawn in Chromium, screenshots in tests/.artifacts)

all 3 suites passed
```

The suite was run twice in a row; both runs were green. The render suite resolves Playwright from
`node_modules`, `PLAYWRIGHT_MODULE`, or a global npm install, and prints `SKIP` plus exit 0 when
no browser is available (the offline suites still run).

## 5. Known gaps

1. **Cloud asset-library support is gone.** Stages whose geometry is stored in an object-storage
   bucket no longer resolve; those references appear in the warnings list as `layer-missing`
   instead of being fetched. Bringing the capability back would need a public, credential-free
   read path and a documented descriptor format — it was removed rather than generalised.
2. **The host half is empty.** There is no host route and no host-side test any more. Any future
   host feature must be routed and tested separately; `src/host/index.js` exists only because a
   dsh bundle needs a host entry and `dsh.client` is what makes the browser half reachable.
3. **Coverage that only the internal fixtures provided is narrowed.** The absolute-root
   read-back case (a session address whose path is absolute, so the engine's root key carries a
   directory) and an unreachable-reference case are no longer exercised by a committed fixture;
   the path helpers themselves are still unit-tested, and an unreadable reference is still
   asserted to assemble to an empty stage.
4. **The custom-typed instancer case is now covered by a synthetic fixture**
   (`instancer/custom-typed.usda`) instead of a real exporter's file. The retyping heuristic is
   unchanged and generic, but its real-world trigger is no longer represented in the repository.
5. **No lockfile is committed** (see §3.3). `npm install` resolves the dependency ranges in
   `package.json`; two installs on different days can therefore resolve different transitive
   versions of the build tools.
6. **The render suite needs an environment** — Playwright + Chromium, and optionally Pillow for
   the colour probe. Without them the suite skips loudly rather than failing, which is good for
   contributors but means CI must install them explicitly to get real coverage.

## 6. Reproducing this checkout

```bash
npm install
npm run build
npm test
```

No remote is configured and nothing was pushed; the repository ships as a local initial commit.
