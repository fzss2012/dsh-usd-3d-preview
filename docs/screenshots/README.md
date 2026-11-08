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
