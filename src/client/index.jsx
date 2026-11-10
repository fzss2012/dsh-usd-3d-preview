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
 * The third thing this half owns is the readers a layer uses to reach the layers
 * it references. They are injected rather than imported: `loadUsd` takes
 * functions, so the assembly stays testable without a host, and the workspace
 * Remote stays the only thing that knows how to find a sibling file. `s3://…`
 * references go through this plugin's own host route instead, which signs them
 * against S3-compatible object storage configured by environment variables — the
 * browser cannot sign, and an unsigned read of that bucket is a 403.
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

/** One byte window for a layer above the Host's complete-read cap. */
const READ_WINDOW_BYTES = 2 * 1024 * 1024

/** Ceiling for the windowed fallback, so a corrupt stat cannot grow without bound. */
const READ_WINDOW_LIMIT_BYTES = 512 * 1024 * 1024

/**
 * Read one referenced layer in byte windows when the Host refuses a complete read.
 *
 * The Host caps a complete read at `workspaceFiles.maxFileBytes` (32 MiB by
 * default) and one window at `maxBytes` (2 MiB by default); the window is halved
 * when a deployment configures a smaller cap. One `stat` call supplies the size.
 * Dropping the layer instead would compose an empty stage — a SimReady robot's
 * geometry layer is commonly ~90 MiB.
 * @param ctx - the client root context carrying the workspace Remote.
 * @param sessionId - the Session whose workspace resolves the path.
 * @param path - workspace path of the layer.
 * @param signal - owning tab lifetime.
 * @returns the assembled bytes, or undefined when the layer cannot be read.
 */
async function readInWindows(ctx, sessionId, path, signal) {
  const remote = ctx.remote?.workspaceFiles
  if (remote === undefined || typeof remote.stat !== 'function') return undefined
  const stat = await remote.stat(sessionId, path, signal)
  if (stat.ok !== true) return undefined
  const total = stat.value?.bytes
  if (!Number.isSafeInteger(total) || total <= 0 || total > READ_WINDOW_LIMIT_BYTES) return undefined
  const bytes = new Uint8Array(total)
  let offset = 0
  let window = READ_WINDOW_BYTES
  while (offset < total) {
    const length = Math.min(window, total - offset)
    const part = await remote.readBytes(
      sessionId, path, { range: { offset, length } }, signal,
    )
    if (part.ok !== true) {
      // Only a window above the deployment cap is worth retrying smaller.
      if (part.error?.code === 'workspace-file/too-large' && window > 64 * 1024) {
        window = Math.floor(window / 2)
        continue
      }
      return undefined
    }
    const chunk = part.value?.data
    if (chunk === undefined || chunk.byteLength === 0) return undefined
    const take = Math.min(chunk.byteLength, total - offset)
    bytes.set(chunk.subarray(0, take), offset)
    offset += take
  }
  return bytes
}

/**
 * Client plugin body: register the dictionaries, the suffix metadata, the
 * viewport, and the sibling-layer/asset readers.
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
        if (result.ok) return result.value.data
        // A solved asset's geometry layer is commonly far above the Host's
        // complete-read cap (default 32 MiB; a SimReady robot's is ~92 MiB).
        // The Host still serves byte windows, so reassemble the layer instead
        // of dropping it and composing an empty stage.
        if (result.error?.code !== 'workspace-file/too-large') return undefined
        return await readInWindows(ctx, sessionId, path, signal)
      },
      // `s3://…` references are served by the host half, which signs the read
      // against the S3-compatible object storage configured through the
      // DSH_USD_S3_* environment variables. The browser cannot sign, and an
      // unsigned read of that bucket is a 403. The route is an exact Fetch route
      // on the shared /api channel, so the same-origin session credential and
      // the Host/Origin trust fence apply before the host signs anything.
      readAsset: async (uri, signal) => {
        const response = await fetch(`/api/usd-preview/asset?uri=${encodeURIComponent(uri)}`, { signal })
        if (!response.ok) return undefined
        return new Uint8Array(await response.arrayBuffer())
      },
    }),
  }, UsdBody)), 'usd-3d-preview: document body')
}

export { parseFileReference, siblingPath }
