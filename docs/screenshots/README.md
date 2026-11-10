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
