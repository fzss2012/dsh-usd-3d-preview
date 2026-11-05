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
assert.deepEqual([...requested].sort(), ['react', 'react/jsx-runtime'], 'unexpected external module requests')

const seen = { effects: [], definitions: [], locales: [], injects: [], slots: [], reads: [] }
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
      async readBytes(sessionId, path) {
        seen.reads.push({ sessionId, path })
        // The Client Remote answers with a result envelope: the bytes are under
        // `value`, and a failure (the layer is absent) is a non-ok result.
        if (path === 'workspace/missing.usda') {
          return { ok: false, error: { code: 'workspace-file/not-found', message: 'no such file', details: { path } } }
        }
        return { ok: true, value: { data: new Uint8Array([1, 2, 3]), bytes: 3 } }
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
  effect: (callback, label) => {
    seen.effects.push(label)
    callback()
    return noop
  },
}

client.apply(ctx)

assert.deepEqual(client.inject, ['slots', 'locale', 'documentPreviews', 'remote', 'remote.workspaceFiles'])

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

assert.deepEqual(seen.injects, ['sidebar.right.tab.document'])
assert.equal(seen.slots.length, 1, 'the keyed document body is registered once')
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

assert.equal(seen.effects.length, 3, 'every registration is owned by a reversible effect')

process.stdout.write(`register.test.mjs  OK  (${seen.effects.length} effects, ${requested.length} module requests)\n`)
