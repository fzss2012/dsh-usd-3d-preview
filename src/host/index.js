/**
 * Host half: the one route the USD preview needs.
 *
 * Parsing and composition are entirely native — the WebAssembly OpenUSD engine
 * composes the stage in a Web Worker. What the browser cannot do is sign a
 * request to an S3-compatible object-storage service, so this half resolves
 * `s3://…` references on its behalf:
 *
 *   GET /api/usd-preview/health        whether an asset library is configured
 *   GET /api/usd-preview/asset?uri=…   one referenced object's bytes
 *
 * Both are exact Fetch routes on the Connection service, so the browser-trust
 * fence (Host/Origin) and the session credential authenticate every request
 * before it reaches this handler; only the owner Peer can read them. They are
 * read-only and owned here. Configuration is environment-only (see `s3.js`):
 * nothing is copied a second time, and no infrastructure is modified.
 */
import { AssetTooLargeError, READ_TIMEOUT_MS, defaultAssetCacheDir, readAsset, storageLibrary } from './s3.js'

/** Exact Fetch-route paths on the shared /api channel. */
const ASSET_PATH = '/api/usd-preview/asset'
const HEALTH_PATH = '/api/usd-preview/health'

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
  /** Resolved once: environment parsing must not run per request. */
  let libraryPromise

  const library = () => {
    if (libraryPromise === undefined) libraryPromise = storageLibrary()
    return libraryPromise
  }

  /**
   * Answer the health route: whether a library is configured, never its secrets.
   * @returns the JSON response.
   */
  const health = async () => {
    const resolved = await library()
    return jsonResponse(200, {
      ok: true,
      // Only the non-secret half is reported: the endpoint and where it came from.
      library: resolved === undefined
        ? null
        : { endpoint: resolved.endpoint, bucket: resolved.bucket, source: resolved.source },
    })
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
