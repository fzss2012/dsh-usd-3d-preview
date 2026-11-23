/**
 * Contract test for the built browser bundle — no browser, no dsh host.
 *
 * The shell is a plain-CJS module table: `window.__ModuleLoader__.load({id,
 * factory})` registers one factory, and the factory receives a `require` that
 * answers only from the platform seed words. This test reproduces exactly that
 * environment, so it fails for the same reasons the real boot would:
 *
 *   * the bundle is not valid JavaScript, or registers under the wrong id;
 *   * the factory needs a module the seed does not carry (an externals drift —
 *     bundling three is what keeps this list at `react` alone);
 *   * `apply` is missing, or a registration never reaches a public service.
 *
 * Run: node tests/register.test.mjs
 */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

/** The seed words the runtime answers without materializing another package. */
const SEED = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis'])

const noop = () => {}
const reactStub = {
  __esModule: true,
  createElement: () => null,
  useCallback: fn => fn,
  useEffect: noop,
  useRef: () => ({ current: null }),
  useState: value => [value, noop],
}
const jsxStub = { __esModule: true, jsx: () => null, jsxs: () => null, Fragment: 'Fragment' }

const requested = []
const requireStub = (spec) => {
  requested.push(spec)
  assert.ok(SEED.has(spec), `the factory required "${spec}", which the platform seed does not carry`)
  return spec === 'react' ? reactStub : jsxStub
}

let registration
globalThis.window = { __ModuleLoader__: { load: entry => { registration = entry } } }
const source = await readFile(join(root, 'lib/client.js'), 'utf8')
// Indirect eval: the bundle is a classic script that assigns through `window`.
;(0, eval)(source)

assert.ok(registration !== undefined, 'lib/client.js did not call window.__ModuleLoader__.load')
assert.equal(registration.id, manifest.name, 'the bundle must register under its package name')
assert.equal(typeof registration.factory, 'function', 'the registration carries no factory')

const client = registration.factory(requireStub)
assert.equal(typeof client.apply, 'function', 'the client half exports no apply()')
assert.deepEqual(
  [...new Set(requested)].sort(),
  ['react', 'react/jsx-runtime'],
  'unexpected external module requests',
)

/** A file larger than the Host's complete-read cap, for the windowed fallback. */
const LARGE = new Uint8Array(2 * 1024 * 1024 + 7)
for (let index = 0; index < LARGE.length; index += 1) LARGE[index] = index % 251

/** Every public service the client half touches, recorded for the assertions below. */
const seen = {
  effects: [], definitions: [], locales: [], injects: [], slots: [],
  reads: [], windows: [], stats: [], listings: [], types: [], opened: [],
}
const ctx = {
  locale: {
    bind: () => key => (key === 'title' ? 'USD 三维预览' : key),
    register: (ns, dictionaries) => {
      seen.locales.push({ ns, dictionaries })
      return noop
    },
  },
  documentPreviews: {
    register: (definition) => {
      seen.definitions.push(definition)
      return noop
    },
  },
  remote: {
    workspaceFiles: {
      async readBytes(sessionId, path, options) {
        seen.reads.push({ sessionId, path })
        // The Client Remote answers with a result envelope: the bytes are under
        // `value`, and a failure (the layer is absent) is a non-ok result.
        if (path === 'workspace/missing.usda') {
          return { ok: false, error: { code: 'workspace-file/not-found', message: 'no such file', details: { path } } }
        }
        if (path === 'workspace/large.usd') {
          const range = options?.range
          if (range === undefined) {
            return {
              ok: false,
              error: { code: 'workspace-file/too-large', message: 'over the complete-read cap', details: { path, limit: 32 * 1024 * 1024 } },
            }
          }
          // This Host's window cap is 1 MiB; a window above it is refused.
          if (range.length > 1024 * 1024) {
            return { ok: false, error: { code: 'workspace-file/too-large', message: 'over the window cap', details: { path, limit: 1024 * 1024 } } }
          }
          seen.windows.push({ offset: range.offset, length: range.length })
          return {
            ok: true,
            value: {
              data: LARGE.slice(range.offset, Math.min(LARGE.length, range.offset + range.length)),
              offset: range.offset,
              bytes: LARGE.length,
            },
          }
        }
        return { ok: true, value: { data: new Uint8Array([1, 2, 3]), bytes: 3 } }
      },
      async stat(sessionId, path) {
        seen.stats.push({ sessionId, path })
        return {
          ok: true,
          value: { absolutePath: '/workspace/' + path, version: 'v1', bytes: path === 'workspace/large.usd' ? LARGE.length : 3 },
        }
      },
      // The session preview lists an archive's folders before reading them; a
      // missing folder is a non-ok result, never a throw.
      async list(sessionId, path) {
        seen.listings.push({ sessionId, path })
        if (path.endsWith('/missing')) {
          return { ok: false, error: { code: 'workspace-file/not-found', message: 'no such directory', details: { path } } }
        }
        return {
          ok: true,
          value: {
            path,
            entries: [
              { name: '00000000000000000002.usda', type: 'file', size: 3 },
              { name: '00000000000000000001.usda', type: 'file', size: 3 },
            ],
            truncated: false,
          },
        }
      },
    },
  },
  slots: {
    inject: (name, callback) => {
      seen.injects.push(name)
      callback()
      return noop
    },
    register: (options, component) => {
      seen.slots.push({ options, component })
      return noop
    },
  },
  sidebarRightTabs: {
    register: (definition) => {
      seen.types.push(definition)
      return noop
    },
  },
  sidebarRight: {
    openTab: (kind) => {
      seen.opened.push(kind)
    },
  },
  effect: (callback, label) => {
    seen.effects.push(label)
    callback()
    return noop
  },
}

client.apply(ctx)

assert.deepEqual(client.inject, [
  'slots',
  'locale',
  'documentPreviews',
  'remote',
  'remote.workspaceFiles',
  'sidebarRightTabs',
  'sidebarRight',
])

// Two formats, two definitions: a USD stage is composed by an engine that resolves
// composition arcs, an IFC model is a STEP file read by a schema-aware reader.
// They share the viewport, not the reader.
assert.equal(seen.definitions.length, 2, 'the USD and IFC definitions are registered once each')
const definition = seen.definitions.find(entry => entry.id === 'dsh-usd-3d-preview/usd')
assert.ok(definition !== undefined, 'the USD definition is registered')
assert.deepEqual([...definition.extensions], ['usd', 'usda', 'usdc', 'usdz'])
assert.deepEqual([...definition.binaryExtensions], ['usd', 'usdc', 'usdz'])
for (const extension of definition.binaryExtensions) {
  assert.ok(definition.extensions.includes(extension), `binary suffix "${extension}" is not claimed`)
}
// Ranking in `matchingDocumentPreviews`: builtin is rank 0, everything else rank 1,
// higher rank wins. The product's own viewers must not silently take these suffixes.
assert.notEqual(definition.priority, 'builtin')
assert.equal(definition.loading, 'bytes-complete')
assert.equal(definition.wrap, false)
assert.equal(definition.title(), 'USD 三维预览')
// A validator that only accepts extensions cannot know a plain-text read is useless
// for a crate; the definition must say so itself.
assert.equal(typeof definition.title, 'function')

const ifcDefinition = seen.definitions.find(entry => entry.id === 'dsh-usd-3d-preview/ifc')
assert.ok(ifcDefinition !== undefined, 'the IFC definition is registered')
assert.deepEqual([...ifcDefinition.extensions], ['ifc', 'ifczip'])
// A STEP file is ASCII and must stay readable as text; only the zip package is binary.
assert.deepEqual([...ifcDefinition.binaryExtensions], ['ifczip'])
assert.notEqual(ifcDefinition.priority, 'builtin')
assert.equal(ifcDefinition.loading, 'bytes-complete')
assert.equal(ifcDefinition.wrap, false)
assert.equal(typeof ifcDefinition.title, 'function')
// The stub dictionary echoes an unknown key, so this is the key the definition
// asked for: the IFC title is its own string, not the USD one.
assert.equal(ifcDefinition.title(), 'ifcTitle', 'the IFC title is its own dictionary key')
assert.notEqual(ifcDefinition.title(), definition.title(), 'the two previews must not share a title')
// The two definitions must not collide on a suffix, or the ranking would decide
// which reader a file gets.
for (const extension of ifcDefinition.extensions) {
  assert.equal(definition.extensions.includes(extension), false, `suffix "${extension}" is claimed twice`)
}

assert.deepEqual(seen.injects, [
  'sidebar.right.tab.document',
  'sidebar.right.tab.document',
  'sidebar.right.pane.tab',
  'sidebar.right.pane.tab',
  'sidebar.right.pane.tab',
  'settings.plugins.tab',
  'plugins.detail.badge',
  'plugins.detail.section',
])
assert.equal(seen.slots.length, 8, 'two document bodies, three page bodies and the three update surfaces are registered once each')
const bodies = seen.slots.filter(slot => slot.options.name === 'sidebar.right.tab.document')
assert.equal(bodies.length, 2, 'each format owns one keyed document body')
const body = bodies.find(slot => slot.options.key === definition.id)
assert.ok(body !== undefined, 'the USD document body is not registered')
assert.equal(body.options.locale, 'usd3dPreview')
assert.equal(typeof body.component, 'function', 'the body must be a component')

// The IFC body is a plain keyed body: it reads no sibling layer, because a model
// is one self-contained STEP file. It therefore injects nothing at all — and that
// absence is the contract, not an oversight.
const ifcBody = bodies.find(slot => slot.options.key === ifcDefinition.id)
assert.ok(ifcBody !== undefined, 'the IFC document body is not registered')
assert.equal(ifcBody.options.key, ifcDefinition.id, 'the body key must equal the definition id')
assert.equal(ifcBody.options.locale, 'usd3dPreview')
assert.equal(typeof ifcBody.component, 'function')
assert.equal(ifcBody.options.inject, undefined, 'an IFC model needs no injected reader')

// The layer reader is the one thing the body cannot supply itself: it must come
// from the registration, must be async, and must go through the workspace Remote.
assert.equal(typeof body.options.inject, 'function', 'the body registration injects nothing')
const injected = body.options.inject('session-1', undefined)
assert.equal(typeof injected.readLayer, 'function', 'no readLayer was injected')
const layerBytes = await injected.readLayer('session-1', 'workspace/geom/body.usda', undefined)
assert.deepEqual(seen.reads, [{ sessionId: 'session-1', path: 'workspace/geom/body.usda' }])
assert.ok(layerBytes instanceof Uint8Array, 'the reader must unwrap the Remote result to bytes')
assert.deepEqual([...layerBytes], [1, 2, 3], 'the reader must return the bytes, not the result envelope')
// A read the Host refuses is a layer the engine reports as missing, not a throw.
assert.equal(
  await injected.readLayer('session-1', 'workspace/missing.usda', undefined),
  undefined,
  'a failed Remote read must resolve undefined',
)

// A Host that refuses a complete read above its cap must not lose the layer:
// the reader stats it and reassembles it from byte windows. This is what makes
// a real solved robot (a ~92 MiB geometry layer) previewable at all.
const largeLayer = await injected.readLayer('session-1', 'workspace/large.usd', undefined)
assert.ok(largeLayer instanceof Uint8Array, 'the windowed fallback must return bytes')
assert.equal(largeLayer.length, LARGE.length, 'the windowed fallback must assemble the whole layer')
let checksum = 0
for (const byte of largeLayer) checksum = (checksum + byte) >>> 0
assert.equal(checksum, LARGE.reduce((sum, byte) => (sum + byte) >>> 0, 0), 'the assembled bytes must match')
assert.equal(seen.stats.length, 1, 'the windowed fallback must stat the layer once')
assert.ok(seen.windows.length >= 3, 'the layer must arrive in several windows')
assert.ok(seen.windows.every(window => window.length <= 1024 * 1024), 'a window must respect the Host cap')

// A session archive is not a document-preview implementation: the registry
// matches suffixes against `.<suffix>`, so it cannot claim the exact name
// `session.json` without also taking every JSON file (or missing it entirely).
// It is a sidebar tab type with a file-name glob instead, which selects the one
// name and leaves the rest alone.
const sessionType = seen.types.find(entry => entry.id === 'dsh-usd-3d-preview/session')
assert.ok(sessionType !== undefined, 'the session archive tab type is registered')
assert.equal(sessionType.kind, 'usd-session')
assert.equal(sessionType.priority, 'extension', 'an outside type outranks the document preview fallback')
assert.deepEqual([...sessionType.patterns], ['session.json', '*.session.json'])
assert.equal(sessionType.canOpen('dsh-resource://file/session/s/arch/session.json'), true)
assert.equal(sessionType.canOpen('dsh-resource://file/session/s/arch/notes.json'), false, 'a neighbour JSON file is not an archive')
assert.equal(sessionType.canOpen('dsh-resource://file/absolute/home/me/session.json'), false, 'an absolute address has no Session to list through')
assert.equal(sessionType.title('dsh-resource://file/session/s/arch/session.json'), 'session.json')
const sessionBody = seen.slots.find(slot => slot.options.key === 'dsh-usd-3d-preview/session')
assert.ok(sessionBody !== undefined, 'the session archive body is registered')
assert.equal(sessionBody.options.name, 'sidebar.right.pane.tab')
assert.equal(sessionBody.options.locale, 'usd3dPreview')
assert.equal(typeof sessionBody.component, 'function')
assert.equal(typeof sessionBody.options.inject, 'function', 'the archive needs the workspace readers')
const sessionInjected = sessionBody.options.inject('session-1', undefined)
assert.equal(typeof sessionInjected.readLayer, 'function')
assert.equal(typeof sessionInjected.readAsset, 'function')
assert.equal(typeof sessionInjected.listDirectory, 'function')
const listing = await sessionInjected.listDirectory('session-1', 'arch/snapshots', undefined)
assert.equal(listing.entries.length, 2, 'the listing is unwrapped to its entries')
assert.deepEqual(seen.listings, [{ sessionId: 'session-1', path: 'arch/snapshots' }])
assert.deepEqual(
  await sessionInjected.listDirectory('session-1', 'arch/missing', undefined),
  { error: 'workspace-file/not-found' },
  'a missing folder is reported, not thrown',
)

assert.equal(seen.locales.length, 1)
const [dictionary] = seen.locales
assert.equal(dictionary.ns, 'usd3dPreview')
assert.deepEqual(
  Object.keys(dictionary.dictionaries.zh).sort(),
  Object.keys(dictionary.dictionaries.en).sort(),
  'the Chinese and English dictionaries must share one key set',
)
for (const value of Object.values(dictionary.dictionaries.en)) {
  assert.equal(typeof value, 'string')
}

// The external-asset entry point: a page tab type with a guide card, a body for
// that tab, and the drop watcher that opens it from a drag over the sidebar.
assert.equal(seen.types.length, 3, 'the session archive, the USD preview and the object-storage page types are registered')
const type = seen.types.find(entry => entry.kind === 'usd-3d-preview')
const objType = seen.types.find(entry => entry.kind === 'usd-objstore')
assert.ok(type !== undefined && objType !== undefined, 'both page types are registered')
assert.equal(type.id, 'dsh-usd-3d-preview/panel')
assert.equal(type.kind, 'usd-3d-preview')
assert.equal(type.priority, 'extension', 'an outside type must not lose the kind to a product type')
assert.equal(type.patterns, undefined, 'a page type recognizes no resource address')
assert.equal(type.title(), 'USD 三维预览')
assert.equal(type.guide.length, 1, 'the guide contributes one entry box')
assert.equal(type.guide[0].id, 'open')
assert.equal(typeof type.guide[0].title, 'function')
assert.equal(typeof type.guide[0].description, 'function')
assert.equal(typeof type.guide[0].icon, 'function', 'the guide entry carries its own artwork')
assert.equal(typeof type.guide[0].order, 'number')

const pageBodies = seen.slots.filter(slot => slot.options.name === 'sidebar.right.pane.tab')
assert.equal(pageBodies.length, 3, 'each page type owns one sidebar page body')
const pageBody = pageBodies.find(slot => slot.options.key === type.id)
assert.ok(pageBody !== undefined, 'the sidebar page body is not registered')
assert.equal(pageBody.options.key, type.id, 'the tab body key must equal the type id')
assert.equal(pageBody.options.locale, 'usd3dPreview')
assert.equal(typeof pageBody.component, 'function')

// The object-storage browser: its own page type and body, ordered before the
// preview so a stage can be found and opened in one place.
assert.equal(objType.id, 'dsh-usd-3d-preview/objstore')
assert.equal(objType.kind, 'usd-objstore')
assert.equal(objType.priority, 'extension', 'the browser must not lose its kind to a product type')
assert.equal(objType.patterns, undefined, 'a page type recognizes no resource address')
assert.equal(typeof objType.title, 'function')
assert.equal(objType.guide.length, 1)
assert.equal(typeof objType.guide[0].title, 'function')
assert.equal(typeof objType.guide[0].description, 'function')
assert.equal(typeof objType.guide[0].order, 'number')
assert.ok(objType.guide[0].order < type.guide[0].order, 'browsing is offered before previewing')

const objBody = pageBodies.find(slot => slot.options.key === objType.id)
assert.ok(objBody !== undefined, 'the object-storage page body is not registered')
assert.equal(objBody.options.locale, 'usd3dPreview')
assert.equal(typeof objBody.component, 'function')
assert.equal(typeof objBody.options.inject, 'function', 'the browser injects the USD handoff')
const handoff = objBody.options.inject()
assert.equal(typeof handoff.openDroppedStage, 'function', 'the browser needs a way to open a stage it found')

// The local-checkout updater contributes three surfaces: a Settings tab under
// Plugins and a badge + section on this bundle's own Plugins detail page.
const updateTab = seen.slots.find(slot => slot.options.name === 'settings.plugins.tab')
assert.ok(updateTab !== undefined, 'the update Settings tab is registered')
assert.equal(updateTab.options.id, 'dsh-usd-3d-preview/update')
assert.equal(updateTab.options.locale, 'usd3dPreview')
assert.equal(typeof updateTab.options.label, 'function', 'the tab has a localized label')
assert.equal(typeof updateTab.component, 'function')
const updateBadge = seen.slots.find(slot => slot.options.name === 'plugins.detail.badge')
assert.ok(updateBadge !== undefined, 'the update badge is registered on the plugin detail page')
assert.equal(updateBadge.options.id, 'dsh-usd-3d-preview/update-badge')
assert.equal(typeof updateBadge.component, 'function')
const updateSection = seen.slots.find(slot => slot.options.name === 'plugins.detail.section')
assert.ok(updateSection !== undefined, 'the update section is registered on the plugin detail page')
assert.equal(updateSection.options.id, 'dsh-usd-3d-preview/update-section')
assert.equal(typeof updateSection.component, 'function')

// Every registration is owned by a reversible effect; the IFC preview adds two
// (its document-preview definition and its keyed document body) and the session
// archive adds its tab type and its body.
assert.equal(seen.effects.length, 15, 'every registration is owned by a reversible effect')

process.stdout.write(`register.test.mjs  OK  (${seen.effects.length} effects, ${requested.length} module requests)\n`)
