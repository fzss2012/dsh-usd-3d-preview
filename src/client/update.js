/**
 * Browser-side calls and small pure helpers for the local-checkout update panel.
 *
 * The host half owns the update (src/host/update.js): GET returns local status,
 * POST performs one explicit action. This module only shapes those calls and
 * answers the questions the panel asks of a status object. The panel appears in
 * two places: a Settings tab under Plugins, and the bundle's own detail page in
 * the Plugins panel, which is why the helpers here are shared.
 */

/** The one Fetch route the update panel uses. */
export const UPDATE_ROUTE = '/api/usd-preview/update'

/** Package name this panel speaks for; used to filter plugin detail subjects. */
export const PACKAGE_NAME = 'dsh-usd-3d-preview'

/** Slot ids owned by the update panel (one per surface). */
export const UPDATE_SETTINGS_TAB_ID = 'dsh-usd-3d-preview/update'
export const UPDATE_DETAIL_BADGE_ID = 'dsh-usd-3d-preview/update-badge'
export const UPDATE_DETAIL_SECTION_ID = 'dsh-usd-3d-preview/update-section'

/** A checked status is reused for this long, so badge + section share one fetch. */
const STATUS_TTL_MS = 15_000

let statusCache = { at: 0, value: undefined, promise: undefined }

/**
 * One JSON request to the update route.
 * @param init - method/body/signal for the request.
 * @returns the parsed JSON body (never throws on a structured failure).
 */
async function request(init = {}) {
  const response = await fetch(UPDATE_ROUTE, {
    method: init.method ?? 'GET',
    headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  })
  const body = await response.json().catch(() => undefined)
  if (body === undefined) {
    return { ok: false, error: 'update-http-' + response.status, message: 'the update route returned no JSON' }
  }
  if (body.ok === false && typeof body.message !== 'string') {
    return { ...body, message: 'update failed (' + (body.error ?? response.status) + ')' }
  }
  return body
}

/** Read the host's local status without touching the network. */
export async function readUpdateStatus(signal) {
  return await request({ signal })
}

/**
 * Load status for a panel; optionally fetch the upstream first.
 *
 * Two components can render together on the plugin detail page, so a checked
 * result is shared for a short time instead of fetching twice.
 * @param options - check: fetch the upstream first; force: ignore the cache.
 * @returns the status object.
 */
export async function loadUpdateStatus({ check = false, force = false, signal } = {}) {
  if (!check) return await readUpdateStatus(signal)
  const now = Date.now()
  if (!force && statusCache.value !== undefined && now - statusCache.at < STATUS_TTL_MS) {
    return statusCache.value
  }
  if (!force && statusCache.promise !== undefined) return await statusCache.promise
  const promise = (async () => {
    const value = await request({ method: 'POST', body: { action: 'check' }, signal })
    statusCache = { at: Date.now(), value, promise: undefined }
    return value
  })()
  statusCache = { ...statusCache, promise }
  promise.catch(() => {
    if (statusCache.promise === promise) statusCache = { at: 0, value: undefined, promise: undefined }
  })
  return await promise
}

/** Whether the status says an update is waiting upstream. */
export function updateAvailable(status) {
  return status !== null && status !== undefined
    && status.ok !== false
    && status.checked === true
    && Number(status.behind) > 0
}

/** Whether the subject names this plugin bundle (plugins.detail.* slots). */
export function matchesUpdateSubject(subject) {
  return subject !== null && subject !== undefined
    && subject.kind === 'bundle'
    && subject.pkg !== null && subject.pkg !== undefined
    && subject.pkg.name === PACKAGE_NAME
}

/**
 * One short state word for the panel; the copy itself stays in the component.
 * @param status - status object or null.
 * @returns "unavailable" | "dirty" | "behind" | "unchecked" | "current".
 */
export function updateState(status) {
  if (status === null || status === undefined) return 'unchecked'
  if (status.ok === false || status.available !== true) return 'unavailable'
  if (status.dirty === true) return 'dirty'
  if (status.checked === true && Number(status.behind) > 0) return 'behind'
  if (status.checked === true) return 'current'
  return 'unchecked'
}

/** Run the update action. */
export async function applyUpdate(signal) {
  statusCache = { at: 0, value: undefined, promise: undefined }
  return await request({ method: 'POST', body: { action: 'update' }, signal })
}

/** Ask the host service to restart (so a new host half is loaded). */
export async function restartUpdateHost(signal) {
  return await request({ method: 'POST', body: { action: 'restart' }, signal })
}
