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
  reads: [], windows: [], stats: [], types: [], opened: [],
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

assert.equal(seen.definitions.length, 1, 'exactly one document preview definition is registered')
const definition = seen.definitions[0]
assert.equal(definition.id, 'dsh-usd-3d-preview/usd')
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

assert.deepEqual(seen.injects, ['sidebar.right.tab.document', 'sidebar.right.pane.tab'])
assert.equal(seen.slots.length, 2, 'the document body and the sidebar page body are registered once each')
const [body] = seen.slots
assert.equal(body.options.name, 'sidebar.right.tab.document')
assert.equal(body.options.key, definition.id, 'the body key must equal the definition id')
assert.equal(body.options.locale, 'usd3dPreview')
assert.equal(typeof body.component, 'function', 'the body must be a component')

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
assert.equal(seen.types.length, 1, 'exactly one sidebar tab type is registered')
const [type] = seen.types
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

const pageBody = seen.slots.find(slot => slot.options.name === 'sidebar.right.pane.tab')
assert.ok(pageBody !== undefined, 'the sidebar page body is not registered')
assert.equal(pageBody.options.key, type.id, 'the tab body key must equal the type id')
assert.equal(pageBody.options.locale, 'usd3dPreview')
assert.equal(typeof pageBody.component, 'function')

assert.equal(seen.effects.length, 6, 'every registration is owned by a reversible effect')

process.stdout.write(`register.test.mjs  OK  (${seen.effects.length} effects, ${requested.length} module requests)\n`)
