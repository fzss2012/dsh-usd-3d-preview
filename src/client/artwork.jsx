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
