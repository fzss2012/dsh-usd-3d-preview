/**
 * Host half: the routes the USD preview needs.
 *
 * Parsing and composition are entirely native — the WebAssembly OpenUSD engine
 * composes the stage in a Web Worker. The host half does the two things the page
 * cannot do itself:
 *
 *   GET  /api/usd-preview/health        whether an asset library is configured
 *   GET  /api/usd-preview/asset?uri=…   one signed `s3://…` object read
 *   GET  /api/usd-preview/list?prefix=  one signed directory listing
 *   GET  /api/usd-preview/search?…      one signed recursive search
 *   GET  /api/usd-preview/update        local checkout update status (read-only)
 *   POST /api/usd-preview/update        { action: "check" | "update" | "restart" }
 *   GET  /api/usd-preview/objstore/config   the saved object-storage connection (no secret)
 *   POST /api/usd-preview/objstore/config   { action: "save" | "clear" }: verify, then persist
 *
 * All are exact Fetch routes on the Connection service, so the browser-trust
 * fence (Host/Origin) and the session credential authenticate every request
 * before it reaches a handler; only the owner Peer can call them. The asset
 * routes are read-only. The update route is different in kind: it fast-forwards
 * this plugin's own git checkout from its configured upstream and rebuilds it
 * (see `update.js`) — it refuses a dirty working tree, never resets, and runs
 * only the fixed git/npm commands that module names. Both are owned here.
 *
 * The object-storage connection is the one writable piece of state: the sidebar
 * can save it (see `config.js`), and a save only lands after the candidate
 * connection has listed the bucket. `DSH_USD_S3_*` stays authoritative, so a
 * deployment's configuration is never shadowed from a browser, and the file is
 * read only when no environment library exists at all.
 */
import {
  clearObjectStoreConfig,
  normalizeObjectStoreConfig,
  objectStoreConfigPath,
  readObjectStoreConfig,
  safeObjectStoreConfig,
  storedLibrary,
  writeObjectStoreConfig,
} from './config.js'
import { createUpdateService, UpdateError } from './update.js'
import {
  AssetTooLargeError,
  LIST_MAX_KEYS,
  READ_TIMEOUT_MS,
  defaultAssetCacheDir,
  listPrefix,
  normalizeRootPrefix,
  objectUrl,
  probeLibrary,
  readAsset,
  resolvePrefix,
  searchFiles,
  storageLibrary,
} from './s3.js'

/** Exact Fetch-route paths on the shared /api channel. */
const ASSET_PATH = '/api/usd-preview/asset'
const HEALTH_PATH = '/api/usd-preview/health'
const LIST_PATH = '/api/usd-preview/list'
const SEARCH_PATH = '/api/usd-preview/search'
const UPDATE_PATH = '/api/usd-preview/update'
const CONFIG_PATH = '/api/usd-preview/objstore/config'

/** Plugin name shown by the loader. */
export const name = 'usd-3d-preview'

/**
 * Answer one request with JSON.
 * @param status - HTTP status code.
 * @param body - JSON-serializable body.
 * @returns the response for the Fetch route.
 */
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body, undefined, 2), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * Attach both read-only asset routes to the composition's Connection service.
 *
 * `ctx.inject` keeps the bundle entry loadable in a composition that has no
 * Connection carrier (the browser half still works there); when one is present
 * the routes are exact Fetch routes behind its trust/authentication policy.
 * @param ctx - host context.
 */
export function apply(ctx) {
  const cacheDir = defaultAssetCacheDir()
  /** Resolved once per save: environment parsing and a file read must not run per request. */
  let libraryPromise

  /**
   * The library every route signs with: the environment first, the saved
   * connection only when the deployment names none.
   * @returns the resolved library, or undefined when nothing is configured.
   */
  const resolveLibrary = async () => {
    const fromEnvironment = await storageLibrary()
    if (fromEnvironment !== undefined) return fromEnvironment
    return await storedLibrary()
  }

  const library = () => {
    if (libraryPromise === undefined) libraryPromise = resolveLibrary()
    return libraryPromise
  }

  /** Forget the memoized library, so the next route call resolves it again. */
  const resetLibrary = () => {
    libraryPromise = undefined
  }
  /** One update service per host process; it serializes its own updates. */
  const updates = createUpdateService({})

  /** Map an update failure to the JSON the panel understands. */
  const updateFailure = (error) => {
    if (error instanceof UpdateError) {
      const status = error.code === 'busy' || error.code === 'bad-branch' ? 409 : 200
      return jsonResponse(status, {
        ok: false,
        error: error.code,
        message: error.message,
        log: error.log ?? [],
      })
    }
    ctx.logger?.warn?.('[usd-3d-preview] update failed: %s', String(error?.message ?? error))
    return jsonResponse(500, { ok: false, error: 'update-failed', message: 'update failed' })
  }

  /** Answer the read-only status route; `?check=1` fetches the upstream first. */
  const updateStatus = async (request) => {
    try {
      const url = new URL(request.url)
      const result = url.searchParams.get('check') === '1' ? await updates.check() : await updates.status()
      return jsonResponse(200, result)
    } catch (error) {
      return updateFailure(error)
    }
  }

  /** Answer one explicit update action; every action is owner-initiated. */
  const updateAction = async (request) => {
    let body
    try {
      body = await request.json()
    } catch {
      return jsonResponse(400, { ok: false, error: 'invalid-json' })
    }
    const action = body !== null && typeof body === 'object' ? body.action : undefined
    if (action !== 'check' && action !== 'update' && action !== 'restart') {
      return jsonResponse(400, { ok: false, error: 'unknown-action' })
    }
    try {
      if (action === 'check') return jsonResponse(200, await updates.check())
      if (action === 'update') return jsonResponse(200, await updates.update())
      // Let this response leave before the service goes away.
      return jsonResponse(200, await updates.restart({ delayMs: 400 }))
    } catch (error) {
      return updateFailure(error)
    }
  }

  /** One Fetch route: GET is status, POST is an explicit action. */
  const updateRoute = async (request) => (
    request.method === 'POST' ? await updateAction(request) : await updateStatus(request)
  )

  /**
   * Answer the health route: whether a library is configured, never its secrets.
   * @returns the JSON response.
   */
  const health = async () => {
    const resolved = await library()
    return jsonResponse(200, {
      ok: true,
      // Only the non-secret half is reported: the endpoint, the bucket, the
      // prefix the browser is confined to, and where the configuration came
      // from. Never the credentials, never a local path.
      library: resolved === undefined
        ? null
        : {
          endpoint: resolved.endpoint,
          bucket: resolved.bucket,
          rootPrefix: resolved.rootPrefix,
          source: resolved.source,
        },
    })
  }

  /**
   * Answer one signed directory listing.
   *
   * The page's `prefix` is confined to `DSH_USD_S3_ROOT_PREFIX`, so the browser
   * can never list outside the asset root even though the host holds credentials
   * for the whole bucket.
   * @param request - authenticated Fetch request on the shared /api channel.
   * @returns the listing JSON, or a JSON error response.
   */
  const list = async (request) => {
    const resolved = await library()
    if (resolved === undefined) {
      return jsonResponse(503, {
        error: 'no asset library is configured: set DSH_USD_S3_ENDPOINT, '
          + 'DSH_USD_S3_ACCESS_KEY and DSH_USD_S3_SECRET_KEY '
          + '(optionally DSH_USD_S3_BUCKET, DSH_USD_S3_REGION and DSH_USD_S3_ROOT_PREFIX)',
      })
    }
    const url = new URL(request.url)
    const prefix = resolvePrefix(url.searchParams.get('prefix') ?? '', resolved.rootPrefix)
    if (prefix === undefined) {
      return jsonResponse(403, { error: 'prefix is outside the configured asset root' })
    }
    try {
      const result = await listPrefix(resolved, prefix, {
        maxKeys: url.searchParams.get('maxKeys') ?? undefined,
        continuationToken: url.searchParams.get('token') ?? undefined,
      })
      return jsonResponse(200, {
        bucket: resolved.bucket,
        prefix,
        allowedPrefixes: resolved.rootPrefix === '' ? [] : [resolved.rootPrefix],
        rootPrefix: resolved.rootPrefix,
        endpoint: resolved.endpoint,
        entries: result.entries.map(entry => (entry.type === 'folder'
          ? entry
          : { ...entry, url: objectUrl(resolved, entry.key) })),
        truncated: result.truncated,
        continuationToken: result.continuationToken ?? null,
      })
    } catch (error) {
      if (request.signal.aborted) return new Response(null, { status: 499 })
      ctx.logger?.warn?.('[usd-3d-preview] list %s failed: %s', prefix, String(error?.message ?? error))
      return jsonResponse(502, { error: 'listing failed' })
    }
  }

  /**
   * Answer one signed recursive search below the confined root.
   * @param request - authenticated Fetch request on the shared /api channel.
   * @returns the search JSON, or a JSON error response.
   */
  const search = async (request) => {
    const resolved = await library()
    if (resolved === undefined) {
      return jsonResponse(503, { error: 'no asset library is configured' })
    }
    const url = new URL(request.url)
    const prefix = resolvePrefix(url.searchParams.get('prefix') ?? '', resolved.rootPrefix)
    if (prefix === undefined) {
      return jsonResponse(403, { error: 'prefix is outside the configured asset root' })
    }
    try {
      const result = await searchFiles(resolved, prefix, {
        query: url.searchParams.get('q') ?? '',
        usdOnly: url.searchParams.get('usd') !== '0',
        limit: url.searchParams.get('limit') ?? undefined,
      })
      return jsonResponse(200, {
        bucket: resolved.bucket,
        prefix,
        entries: result.entries.map(entry => ({ ...entry, url: objectUrl(resolved, entry.key) })),
        scanned: result.scanned,
        truncated: result.truncated,
        limit: LIST_MAX_KEYS,
      })
    } catch (error) {
      if (request.signal.aborted) return new Response(null, { status: 499 })
      ctx.logger?.warn?.('[usd-3d-preview] search %s failed: %s', prefix, String(error?.message ?? error))
      return jsonResponse(502, { error: 'search failed' })
    }
  }

  /**
   * Answer one signed asset read.
   * @param request - authenticated Fetch request on the shared /api channel.
   * @returns the object bytes, or a JSON error response.
   */
  const asset = async (request) => {
    const url = new URL(request.url)
    const uri = url.searchParams.get('uri')
    if (uri === null || !uri.startsWith('s3://')) {
      return jsonResponse(400, { error: 'uri must be an s3:// reference' })
    }
    const resolved = await library()
    if (resolved === undefined) {
      return jsonResponse(503, {
        error: 'no asset library is configured: set DSH_USD_S3_ENDPOINT, '
          + 'DSH_USD_S3_ACCESS_KEY and DSH_USD_S3_SECRET_KEY '
          + '(optionally DSH_USD_S3_BUCKET and DSH_USD_S3_REGION)',
      })
    }

    try {
      const result = await readAsset(resolved, uri, cacheDir, {
        signal: request.signal,
        timeoutMs: READ_TIMEOUT_MS,
      })
      if (result === undefined) {
        return jsonResponse(404, { error: 'asset not found or not readable' })
      }
      ctx.logger?.debug?.('[usd-3d-preview] asset %s (%s, %d B)', uri, result.source, result.data.byteLength)
      return new Response(result.data, {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(result.data.byteLength),
          'cache-control': 'no-store',
          'x-dsh-usd-preview-source': result.source,
        },
      })
    } catch (error) {
      if (error?.name === 'AssetTooLargeError') {
        return jsonResponse(413, { error: 'asset is larger than the host read limit' })
      }
      // The caller went away; nobody is left to read a body.
      if (request.signal.aborted) return new Response(null, { status: 499 })
      ctx.logger?.warn?.('[usd-3d-preview] asset %s failed: %s', uri, String(error?.message ?? error))
      return jsonResponse(502, { error: 'asset read failed' })
    }
  }

  /**
   * Answer the sidebar's saved-connection route.
   *
   * GET reports the effective source and the non-secret half of what is stored;
   * POST validates, verifies and only then writes. The environment stays
   * authoritative, so a POST answers 409 while `DSH_USD_S3_*` names a library:
   * a browser must not replace what the deployment configured.
   * @param request - authenticated Fetch request on the shared /api channel.
   * @returns the JSON response.
   */
  const objectStoreConfig = async (request) => {
    if (request.method !== 'POST') {
      const resolved = await library()
      return jsonResponse(200, {
        ok: true,
        // What the routes sign with right now: 'environment', 'config-file' or null.
        source: resolved === undefined ? null : resolved.source,
        config: safeObjectStoreConfig(await readObjectStoreConfig()),
      })
    }
    let body
    try {
      body = await request.json()
    } catch {
      return jsonResponse(400, { ok: false, error: 'invalid-json' })
    }
    const action = body !== null && typeof body === 'object' ? body.action : undefined
    if (action !== 'save' && action !== 'clear') {
      return jsonResponse(400, { ok: false, error: 'unknown-action' })
    }
    if ((await storageLibrary()) !== undefined) {
      return jsonResponse(409, { ok: false, error: 'environment-config' })
    }
    if (action === 'clear') {
      await clearObjectStoreConfig()
      resetLibrary()
      ctx.logger?.info?.('[usd-3d-preview] object storage connection cleared')
      return jsonResponse(200, { ok: true, source: null, config: null })
    }
    const validated = normalizeObjectStoreConfig(body, await readObjectStoreConfig())
    if (validated.error !== undefined) {
      return jsonResponse(400, { ok: false, error: validated.error })
    }
    // A connection that cannot list the bucket would only ever show empty
    // folders, so it is verified first and never written on a failure.
    const probe = await probeLibrary(validated.config)
    if (probe.ok !== true) {
      ctx.logger?.warn?.('[usd-3d-preview] object storage connection refused (%s)', probe.reason)
      return jsonResponse(502, { ok: false, error: probe.reason })
    }
    const written = await writeObjectStoreConfig(validated.config)
    resetLibrary()
    ctx.logger?.info?.(
      '[usd-3d-preview] object storage connection saved to %s (%s/%s)',
      objectStoreConfigPath(), written.endpoint, written.bucket,
    )
    return jsonResponse(200, { ok: true, source: 'config-file', config: safeObjectStoreConfig(written) })
  }

  ctx.inject(['connection'], scope => {
    scope.effect(
      () => scope.connection.fetch.register({
        path: ASSET_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: asset,
      }),
      'usd-3d-preview: signed asset route',
    )
    scope.effect(
      () => scope.connection.fetch.register({
        path: HEALTH_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: health,
      }),
      'usd-3d-preview: asset library health route',
    )
    scope.effect(
      () => scope.connection.fetch.register({
        path: LIST_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: list,
      }),
      'usd-3d-preview: signed listing route',
    )
    scope.effect(
      () => scope.connection.fetch.register({
        path: SEARCH_PATH,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: search,
      }),
      'usd-3d-preview: signed search route',
    )
    scope.effect(
      () => scope.connection.fetch.register({
        path: UPDATE_PATH,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: updateRoute,
      }),
      'usd-3d-preview: local checkout update route',
    )
    scope.effect(
      () => scope.connection.fetch.register({
        path: CONFIG_PATH,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: objectStoreConfig,
      }),
      'usd-3d-preview: object storage connection route',
    )
    void library().then(
      (resolved) => {
        ctx.logger?.info?.(
          '[usd-3d-preview] asset routes ready at %s (library=%s)',
          ASSET_PATH,
          resolved === undefined ? 'none' : `${resolved.endpoint}/${resolved.bucket} from ${resolved.source}`,
        )
      },
      () => undefined,
    )
  })
}
