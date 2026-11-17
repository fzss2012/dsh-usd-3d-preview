/**
 * The plugin's palette: the shell's design tokens under this package's names.
 *
 * Every surface in this plugin is inline-styled React, so there is no CSS
 * cascade to inherit a look from — the colours and faces are read here instead.
 * Keeping them in one module is what makes the mapping auditable: a wrong token
 * name resolves to nothing (and silently falls back), so the mapping has to be
 * verifiable in a single place against the shell's own token sheet
 * (`dsh-client-ui-theme/src/styles/design-platform.css`).
 *
 * ## Why the accent is not `--dsw-alias-brand-primary`
 *
 * `--dsw-alias-brand-primary` is the shell's **ink**, not an accent: it is
 * black in the light palette (rgb(15,17,21)) and *near-white* in the dark one
 * (rgb(249,250,251)). A button filled with it and labelled with a hardcoded
 * `#fff` is therefore a white slab with invisible text in the dark theme —
 * which is exactly what a primary action used to be here.
 *
 * Accent colour (icons, toggled borders, links, drop outlines) is
 * `--dsw-alias-state-business-primary`, the shell's own blue: deepseek-500
 * in light, deepseek-400 in dark.
 *
 * A **filled primary action** uses the same pair every primary button in the
 * shell uses — `--dsw-alias-button-primary-fill` for the fill and
 * `--dsw-alias-label-primary-foreground` for the label on it. That pair is
 * ~18:1 in both palettes; the blue pairs that look plausible instead measure
 * 4.23:1 (info-fill + white, light) and 2.33:1 (info-fill + white, dark), so
 * they are not used for text.
 *
 * ## Why not `--dsw-font-ui` / `--dsw-font-mono`
 *
 * The shell defines neither. It ships `--dsw-font-family` (the UI face,
 * already composed from the user's font setting) and `--ds-font-family-code`
 * (the code face). Referencing the non-existent names left every panel on the
 * browser's default font.
 *
 * ## About the fallbacks
 *
 * The shell always defines these tokens, so the fallbacks apply only where the
 * token sheet is absent (a bare page, a harness, a foreign host). They keep the
 * plugin's long-standing near-black presentation, which is what the viewport,
 * the studio comments and the visual suites are all written against; picking the
 * light values instead would flip every surface to white exactly in the case the
 * plugin is least able to check it.
 *
 * @module dsh-usd-3d-preview/tokens
 */

/** Primary text. */
export const LABEL = 'var(--dsw-alias-label-primary, #e6e8ec)'

/** Secondary text: hints, metadata, footers. */
export const LABEL_DIM = 'var(--dsw-alias-label-secondary, #a9b0bd)'

/** Accent for icons, active toggles and outlines — never for a fill carrying text. */
export const ACCENT = 'var(--dsw-alias-state-business-primary, #4d8dff)'

/** Fill of a filled primary action; pair with {@link PRIMARY_INK}. */
export const PRIMARY_FILL = 'var(--dsw-alias-button-primary-fill, #e6e8ec)'

/** The label on {@link PRIMARY_FILL}; readable on it in both palettes. */
export const PRIMARY_INK = 'var(--dsw-alias-label-primary-foreground, #14161a)'

/** Subtle divider. */
export const BORDER = 'var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.14))'

/** Stronger divider, for the dashed drop-zone edge. */
export const BORDER_STRONG = 'var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.24))'

/** Raised surface: headers, overlays, secondary button fills. */
export const SURFACE = 'var(--dsw-alias-bg-overlay, rgba(24, 26, 32, 0.86))'

/** The panel behind everything. */
export const BASE = 'var(--dsw-alias-bg-base, #14161a)'

/** Upraised content surface, one step above {@link BASE}. */
export const LAYER = 'var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.03))'

/** Error text. */
export const ERROR = 'var(--dsw-alias-state-error-primary, #ff6b6b)'

/** Success text. */
export const SUCCESS = 'var(--dsw-alias-state-success-primary, #43c780)'

/** A faint neutral wash, for badges and inert surfaces. */
export const WASH = 'var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08))'

/**
 * The accent wash behind a selected row. Derived from {@link ACCENT} rather than
 * hardcoded, so it follows the palette instead of staying dark-theme blue.
 */
export const ACCENT_WASH = 'color-mix(in srgb, var(--dsw-alias-state-business-primary, #4176e6) 16%, transparent)'

/** The UI face, including the user's font setting. */
export const FONT = 'var(--dsw-font-family, system-ui, sans-serif)'

/** The code face. */
export const MONO = 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)'
