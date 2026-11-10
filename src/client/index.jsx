/**
 * Browser half: two ways to open USD, and the composition they share.
 *
 * 1. A workspace file — `dsh-usd-3d-preview/usd` in `ctx.documentPreviews`, with
 *    the viewport in the keyed `sidebar.right.tab.document` seat. The Files tab
 *    opens it by address, and referenced layers are read back through the
 *    workspace Remote.
 * 2. An external asset — a page tab of its own (`usd-3d-preview`) with a drop
 *    zone, reachable from the sidebar guide and by dropping a stage anywhere
 *    over the sidebar. Its files never enter the workspace: the page holds the
 *    bytes and the WASM engine composes from them (see `DropBody.jsx`).
 *
 * Both paths end in the same `UsdBody`, so composition, statistics and warnings
 * are identical whichever door the stage came through.
 *
 * The service list names only what the halves cannot work without: the preview
 * registry for the workspace path, the sidebar registries for the page tab, and
 * the workspace Remote for referenced layers. The drop path needs no host
 * service at all.
 */
import { UsdPreviewGlyph } from './artwork.jsx'
import { UsdDropBody } from './DropBody.jsx'
import { watchSidebarDrops } from './sidebar-drop.js'
import { UsdBody } from './UsdBody.jsx'
import { en, zh } from './locales.js'
import {
  parseFileReference,
  siblingPath,
  USD_PREVIEW_ID,
  USD_TAB_ID,
  USD_TAB_KIND,
  usdDefinition,
} from './usd.js'

/** This package's copy namespace. */
const NS = 'usd3dPreview'

/**
 * Required browser services: the slot registry, copy, the preview registry, the
 * workspace bytes, and the right sidebar's tab registry and navigation.
 */
export const inject = [
  'slots',
  'locale',
  'documentPreviews',
  'remote',
  'remote.workspaceFiles',
  'sidebarRightTabs',
  'sidebarRight',
]

/**
 * Client plugin body: register the dictionaries, both USD entry points, and the
 * sibling-layer reader.
 * @param ctx - the client root context carrying slots, copy, the preview
 * registry, the sidebar registries, and the workspace Remote.
 */
export function apply(ctx) {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'usd-3d-preview: dictionaries')

  // ── workspace files: a document preview by address ─────────────────────────
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

  // ── external assets: a page tab opened by dropping a stage ─────────────────
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: USD_TAB_ID,
    kind: USD_TAB_KIND,
    // A page type: it recognizes no address and is opened by kind. The band is
    // the outside-the-product one, so a product type cannot take the kind over.
    priority: 'extension',
    title: () => t('title'),
    guide: [{
      id: 'open',
      // After Files (10) and before Terminal (20): the doors out of the column
      // stay together, ordered by how often they are the reason to open it.
      order: 15,
      title: () => t('title'),
      description: () => t('dropGuide'),
      icon: UsdPreviewGlyph,
    }],
  }), 'usd-3d-preview: sidebar tab type')

  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: USD_TAB_ID,
    locale: NS,
  }, UsdDropBody)), 'usd-3d-preview: sidebar tab body')

  // A stage dragged from the desktop onto the sidebar opens here, even while the
  // tab is closed; the offered drop is what the page tab reads when it mounts.
  ctx.effect(() => watchSidebarDrops({
    openTab: () => ctx.sidebarRight.openTab(USD_TAB_KIND),
    hintText: () => t('dropOverlay'),
  }), 'usd-3d-preview: sidebar drop')
}

export { parseFileReference, siblingPath }
