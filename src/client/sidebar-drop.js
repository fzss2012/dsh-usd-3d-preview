/**
 * Dropping an external asset on the right Sidebar.
 *
 * A USD file that lives nowhere in the workspace cannot be opened by address, so
 * it is opened by bytes: the drop is collected in the page, handed to the page
 * tab that shows external assets, and assembled from those bytes alone.
 *
 * The listener is capture-phase on purpose. The conversation's attachment drop
 * listens on the same document and accepts drops across the whole page; a stage
 * dropped over the sidebar must open in the preview instead of attaching itself
 * to the next prompt. Capture runs before that listener, and stopping the event
 * there is what makes the sidebar the drop's owner.
 */
import { acceptsDroppedAsset, collectDropped, offerDropped, takePendingDropped } from './dropped.js'

/** The panel element the right Sidebar mounts; a drop anywhere inside it is ours. */
export const SIDEBAR_PANEL_SELECTOR = '[data-sidebar-right-panel]'

/** Marks the panel while a stage is being dragged over it. */
const ACTIVE_ATTRIBUTE = 'data-usd-drop-active'

/** The attribute the style rule reads the overlay copy from. */
const HINT_ATTRIBUTE = 'data-usd-drop-hint'

const STYLE_ID = 'dsh-usd-3d-preview-drop-style'

const STYLE = `${SIDEBAR_PANEL_SELECTOR}[${ACTIVE_ATTRIBUTE}="true"]{outline:2px dashed var(--dsw-alias-brand-primary,#4d8dff);outline-offset:-2px}`

/**
 * The sidebar panel a drag event is over.
 * @param event - a drag event.
 * @returns the panel element, or undefined outside the sidebar.
 */
function panelOf(event) {
  const path = typeof event.composedPath === 'function' ? event.composedPath() : []
  for (const node of path) {
    if (node === null || typeof node !== 'object') continue
    if (node.nodeType !== 1 || typeof node.matches !== 'function') continue
    if (node.matches(SIDEBAR_PANEL_SELECTOR)) return node
  }
  return undefined
}

/**
 * Install the flock of listeners that make the sidebar a drop target for stages.
 * @param options - what to open and what to say while dragging.
 * @param options.openTab - opens the preview page tab; may throw without a session.
 * @param options.hintText - localized overlay copy.
 * @param options.document - the document to listen on (injectable for tests).
 * @returns the disposer that removes every listener it added.
 */
export function watchSidebarDrops({ openTab, hintText, document: doc = globalThis.document, window: win = globalThis.window }) {
  if (doc === undefined || doc === null) return () => {}
  let active
  let hint

  const addStyle = () => {
    if (doc.getElementById(STYLE_ID) !== null) return
    const style = doc.createElement('style')
    style.id = STYLE_ID
    style.textContent = STYLE
    doc.head?.appendChild(style)
  }

  const release = () => {
    if (active !== undefined) {
      active.removeAttribute(ACTIVE_ATTRIBUTE)
      active.removeAttribute(HINT_ATTRIBUTE)
      active = undefined
    }
    if (hint !== undefined) {
      hint.remove()
      hint = undefined
    }
  }

  const show = (panel) => {
    addStyle()
    active = panel
    panel.setAttribute(ACTIVE_ATTRIBUTE, 'true')
    panel.setAttribute(HINT_ATTRIBUTE, hintText())
    hint = doc.createElement('div')
    hint.textContent = hintText()
    Object.assign(hint.style, {
      position: 'fixed',
      top: '64px',
      right: '24px',
      zIndex: '2147483000',
      padding: '6px 10px',
      borderRadius: '8px',
      fontSize: '12px',
      pointerEvents: 'none',
      color: 'var(--dsw-alias-label-primary, #e6e8ec)',
      background: 'var(--dsw-alias-bg-overlay, rgba(24, 26, 32, 0.86))',
      border: '1px solid var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.14))',
    })
    doc.body?.appendChild(hint)
  }

  const onDrag = (event) => {
    if (!acceptsDroppedAsset(event.dataTransfer)) {
      release()
      return
    }
    const panel = panelOf(event)
    if (panel === undefined) {
      release()
      return
    }
    // Claim the drop: preventDefault makes it droppable, and stopping the event
    // keeps the conversation's page-wide attachment drop from claiming it too.
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer !== null && event.dataTransfer !== undefined) {
      event.dataTransfer.dropEffect = 'copy'
    }
    if (active !== panel) {
      release()
      show(panel)
    }
  }

  const onDragLeave = (event) => {
    if (active === undefined) return
    if (panelOf(event) === undefined) release()
  }

  const onDrop = (event) => {
    if (!acceptsDroppedAsset(event.dataTransfer)) return
    const panel = panelOf(event)
    if (panel === undefined) return
    event.preventDefault()
    event.stopPropagation()
    release()
    void collectDropped(event.dataTransfer)
      .then((drop) => {
        offerDropped(drop)
        try {
          openTab()
        } catch {
          // No Session on screen: the drop cannot be opened, so it must not wait.
          takePendingDropped()
        }
      })
      .catch(() => {
        // A malformed drop belongs to the browser, not to an exception in the shell.
      })
  }

  const onDragEnd = () => release()

  doc.addEventListener('dragenter', onDrag, true)
  doc.addEventListener('dragover', onDrag, true)
  doc.addEventListener('dragleave', onDragLeave, true)
  doc.addEventListener('drop', onDrop, true)
  win?.addEventListener?.('dragend', onDragEnd)
  win?.addEventListener?.('blur', onDragEnd)
  return () => {
    doc.removeEventListener('dragenter', onDrag, true)
    doc.removeEventListener('dragover', onDrag, true)
    doc.removeEventListener('dragleave', onDragLeave, true)
    doc.removeEventListener('drop', onDrop, true)
    win?.removeEventListener?.('dragend', onDragEnd)
    win?.removeEventListener?.('blur', onDragEnd)
    release()
    doc.getElementById(STYLE_ID)?.remove()
  }
}
