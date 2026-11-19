# Visual evidence: 2.0.0 upgrade

Before/after captures for the `2.0.0` feature upgrade (interactive USD, studio
rendering, view refactor). All captures are real Chromium/WebGL renders of the
actual `UsdBody` panel, produced from the same test harness, fixtures, viewport
(900 × 640), theme and UI state — only the checkout under capture differs.

- **Before — baseline 1.0.0**, commit `028f90467ecd92b22f6c7d9794d0a15568d0a0e6`
  (`main` before this change). The render harness and fixtures are that checkout's
  own.
- **After — 2.0.0 branch**, the head of the pull request branch at capture time.

Captured with the committed dev helper (requires Playwright + Chromium):

```bash
node tests/capture.mjs --repo <checkout> --out <dir> --prefix <before|after> \
  --fixtures arcs/root.usda,sample.usda,instancer/nested.usda
```

| Scenario (`tests/fixtures/…`) | Before (1.0.0) | After (2.0.0) |
|---|---|---|
| `arcs/root.usda` — sublayer + reference composition arc | `before-arcs-root.png` | `after-arcs-root.png` |
| `sample.usda` — Blender scene, 972 triangles | `before-sample.png` | `after-sample.png` |
| `instancer/nested.usda` — nested PointInstancer | `before-instancer-nested.png` | `after-instancer-nested.png` |

`after-articulated-closed.png` / `after-articulated-open.png` show the new
interactive path on `joints/door.usda` (one `UsdPhysicsRevoluteJoint`): the parts
toolbar, the click hint, and the door leaf before/after "Open all". The 1.0.0
baseline has no articulated UI, so this scenario has no before counterpart; it is
documented as **After-only** evidence.

The panel differences visible in the before/after pairs are the studio lighting
(tone mapping, real shadows, lit ground disc), the on-demand view framing, and the
reworked toolbar; composition results (layer/mesh/triangle/size stats) are
unchanged for every scenario.

## Joint-interaction demos (GIF)

The test suites assert the interaction in code; these GIFs are the human-readable
counterpart, recorded from the real panel in Chromium with the same render
harness. Each caption names the stage of the scripted interaction.

- `articulation-demo.gif` — `joints/mixed.usda`: one stage with a revolute hinge,
  a prismatic slide and a fixed bolt. Steps: rest pose → All open → Home → click
  the hinged panel → click the sliding tray → collider overlay on/off → Home.
  This is the "more detailed joint interaction" evidence: the two drivable parts
  move independently, the fixed part follows its parent instead of being driven,
  and the collider geometry is an overlay that can be toggled.
- `articulation-demo-prismatic.gif` — `joints/mixed.usda`, clicking only the
  sliding tray: rest → All open → Home → click the sliding tray (the prismatic
  travel) → colliders on/off → Home. The dedicated `joints/drawer.usda` fixture
  is what the kinematics suite exercises, but its tray sits inside a closed
  carcass and draws no visible travel from outside; the mixed stage's tray stands
  apart on the stage, so it is the honest visual counterpart for the prismatic
  joint.

The software rasterizer used in this environment paints only a few frames per
second, so the motion is deliberately step-captioned rather than relying on a
smooth high-fps recording; the rendered panels themselves are the real
application component. The rasterizer can also paint more frames than a review
loop should carry, so `record-demo.mjs` keeps an even sample of at most
`--max-frames` frames across the whole script (first and last included) and every
captioned stage survives the cap.

Reproduce (requires Playwright + Chromium and two small encoders, not package
dependencies):

```bash
npm install --no-save playwright gifenc jpeg-js
npx playwright install chromium
node tests/record-demo.mjs --fixture joints/mixed.usda \
  --clicks "0.40,0.42;0.57,0.75" --out docs/screenshots/articulation-demo.gif
node tests/record-demo.mjs --fixture joints/mixed.usda \
  --clicks "0.57,0.75" --max-frames 48 \
  --out docs/screenshots/articulation-demo-prismatic.gif
```

## Selection highlight

A pair for the click-to-select feature, copied from the `render` suite's artifacts for the
`sample.usda` case (`tests/.artifacts/sample.usda-selected-none.png` and
`…-selected-highlight.png`). Re-run `node tests/run.mjs` and copy those two files over these
when the panel's chrome changes — the pair is a screenshot of the whole stage, so a toolbar
button added later makes an old pair stale.

| Scenario | File |
|---|---|
| `sample.usda`, nothing selected | `selection-unselected.png` |
| `sample.usda`, `/root/FixtureCube/Cube` clicked | `selection-highlighted.png` |

The two frames differ only by the tint: a click on the model selects the prim under
the cursor, and the panel names it (`Picked: /root/FixtureCube/Cube`). Clearing the
selection — Escape or the panel's × — leaves no visible trace: the suites assert the
changed share is under 0.2% and the largest per-channel delta anywhere in the frame
is at most 8, which is the software rasterizer's own antialiasing jitter (a leftover
tint shows up in the tens). The `studio` suite asserts the same thing on a synthetic
model, and `tests/selection.test.mjs` covers the object-tree side without a browser.

## Prim details panel

`details-panel.png` — `sample.usda`, `/root/FixtureCube/Cube` clicked, **Details**
opened. It is the panel's own screenshot (the whole 900 × 640 stage, so the prims
tree and the viewport are visible around it), captured by the `render` suite; the
crate fixture (`sample.usdc`) produces the same table from the same stage, which is
the ASCII/crate parity `tests/details.test.mjs` asserts attribute by attribute.

What the capture is evidence for, none of which a pixel diff can state: the declared
type of the prim (`Mesh`) and of each attribute (`float3[]`, `point3f[]`, `int[]`,
`texCoord2f[]`), the `uniform` modifiers, `Applied schemas` from `apiSchemas`, the
geometry attribute list, and the layer list the values came from. A long array is a count
plus a head (`point3f[] [8 values] (-1, -1, -1), …, …`) — the property that makes the
panel cheap on a solved robot's geometry layer. On a multi-layer stage each attribute row
also carries its own source layer, and a prim composed through a reference names both the
path the stage composes and the path the layer authored; the `render` suite's `refs/unit.usda`
and `arcs/root.usda` cases are what exercise that (`…-details.png` in `tests/.artifacts`).

`details-referenced.png` is that second case: `refs/unit.usda` with the referenced mesh
clicked, so the header names `/root/unit/body` (composed) and `/root/body` (authored), and
the layer list names the referenced layer rather than the file that was opened.
