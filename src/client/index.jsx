/**
 * Browser half: register `dsh-usd-3d-preview/usd` as a document preview.
 *
 * Two registrations, both through public paths only — the definition into
 * `ctx.documentPreviews`, the body into the keyed `sidebar.right.tab.document`
 * seat under the same id. Nothing here reaches into the text tab type that owns
 * the seat: the plain-text viewer claims every file address at the fallback
 * band, and this implementation outranks it for the four USD suffixes, so
 * clicking a `.usd` file in the Files tab lands here while every other file
 * keeps its existing renderer.
 *
 * The third thing this half owns is the reader a layer uses to reach the layers
 * it references. It is injected rather than imported: `loadUsd` takes a function,
 * so the assembly stays testable without a host, and the workspace Remote stays
 * the only thing that knows how to find a sibling file.
 *
 * `inject` names the runtime services this body cannot work without. The
 * document preview registry is one of them, and waiting for it is also what
 * keeps registration order irrelevant between this plugin and the product
 * renderers.
 */
import { UsdBody } from './UsdBody.jsx'
import { en, zh } from './locales.js'
import { parseFileReference, siblingPath, USD_PREVIEW_ID, usdDefinition } from './usd.js'

/** This package's copy namespace. */
const NS = 'usd3dPreview'

/** Required browser services: the slot registry, copy, the preview registry, and workspace bytes. */
export const inject = ['slots', 'locale', 'documentPreviews', 'remote', 'remote.workspaceFiles']

/**
 * Client plugin body: register the dictionaries, the suffix metadata, the
 * viewport, and the sibling-layer reader.
 * @param ctx - the client root context carrying slots, copy, the preview
 * registry, and the workspace Remote.
 */
export function apply(ctx) {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'usd-3d-preview: dictionaries')
  ctx.effect(
    () => ctx.documentPreviews.register(usdDefinition(() => t('title'))),
    'usd-3d-preview: registry definition',
  )
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
    name: 'sidebar.right.tab.document',
    key: USD_PREVIEW_ID,
    locale: NS,
    // One complete file read per referenced layer; the body decides which paths
    // those are, because it is the half that knows the opened file's address.
    inject: () => ({
      readLayer: async (sessionId, path, signal) => {
        // The Client Remote answers with a result envelope, never by rejecting:
        // the bytes live under `value`, and a failure is the honest "this layer
        // does not exist", which the engine reports as a missing layer.
        const result = await ctx.remote.workspaceFiles.readBytes(sessionId, path, {}, signal)
        return result.ok ? result.value.data : undefined
      },
    }),
  }, UsdBody)), 'usd-3d-preview: document body')
}

export { parseFileReference, siblingPath }
