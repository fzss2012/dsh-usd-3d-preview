/**
 * Artwork owned by this package.
 *
 * A client plugin may not add a seed word to the platform module table, so the
 * glyph the sidebar guide draws next to the preview is drawn here, from
 * primitives the browser already has: an isometric crate — the container the
 * preview opens — with the file's stage grid folded into it.
 */

/**
 * The USD preview glyph, drawn in the surrounding ink colour.
 * @param props - the guide artwork contract: a pixel size and an optional class.
 * @returns the icon, sized by the guide and coloured by `currentColor`.
 */
export function UsdPreviewGlyph({ size = 24, className }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M12 2.75 20.25 7.5v9L12 21.25 3.75 16.5v-9L12 2.75Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M3.75 7.5 12 12.25l8.25-4.75M12 12.25v9"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path
        d="M8.1 4.7 16.35 9.45"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.55"
      />
    </svg>
  )
}
/**
 * A chevron that rotates to show a folder's open state.
 * @param props - size and whether the folder is expanded.
 * @returns the chevron, coloured by currentColor.
 */
export function TreeChevron({ size = 12, open = false }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block', transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms ease' }}
    >
      <path d="M4 2.5 8 6l-4 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * A folder glyph for a node that has children.
 * @param props - size and whether the folder is open.
 * @returns the folder, coloured by currentColor.
 */
export function TreeFolder({ size = 13, open = false }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false" style={{ display: 'block' }}>
      {open === true
        ? <path d="M1.5 4.5h5l1.4 1.6h6.6v6.4H1.5V4.5Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
        : <path d="M1.5 4h4.8l1.4 1.6h7v7H1.5V4Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />}
    </svg>
  )
}

/**
 * A small cube glyph for a prim that carries geometry.
 * @param props - icon size.
 * @returns the cube, coloured by currentColor.
 */
export function TreePrim({ size = 12 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false" style={{ display: 'block' }}>
      <path d="M8 1.6 13.5 4.7v6.6L8 14.4 2.5 11.3V4.7L8 1.6Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
      <path d="M2.5 4.7 8 7.8l5.5-3.1M8 7.8v6.6" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" opacity="0.65" />
    </svg>
  )
}
