/**
 * Host half: the one route the USD preview needs.
 *
 * Parsing and composition are entirely native — the WebAssembly OpenUSD engine
 * composes the stage in a Web Worker. What the browser cannot do is sign a
 * request to an S3-compatible object-storage service, so this half resolves
 * `s3://…` references on its behalf:
 *
 *   GET /usd-preview/health        whether an asset library is configured
 *   GET /usd-preview/asset?uri=…   one referenced object's bytes
 *
 * Both paths are read-only and owned here. Configuration is environment-only
 * (see `s3.js`): nothing is copied or stored a second time, and no
 * infrastructure is modified.
 */
import { defaultAssetCacheDir, readAsset, storageLibrary } from './s3.js'

/** Absolute route prefix this plugin claims. */
const ROUTE = '/usd-preview'

/** Request header a caller must send; it also forces a preflight cross-origin, which this route never answers. */
const CALLER_HEADER = 'x-dsh-usd-preview'

/** The webserver is the only service this half cannot work without. */
export const inject = ['webServer']

/** Plugin name shown by the loader. */
export const name = 'usd-3d-preview'

/**
 * Answer one request with JSON.
 * @param res - the response this route owns.
 * @param status - HTTP status code.
 * @param body - JSON-serializable body.
 */
function sendJson(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body, undefined, 2), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.byteLength),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/**
 * Attach the asset route to the composition's webserver.
 * @param ctx - host context carrying the webserver service.
 */
export function apply(ctx) {
  const cacheDir = defaultAssetCacheDir()
  /** Resolved once: environment parsing must not run per request. */
  let libraryPromise

  const library = () => {
    if (libraryPromise === undefined) libraryPromise = storageLibrary()
    return libraryPromise
  }

  const handler = async (req, res) => {
    const url = new URL(req.url ?? ROUTE, 'http://localhost')

    if (req.method === 'GET' && url.pathname === `${ROUTE}/health`) {
      const resolved = await library()
      sendJson(res, 200, {
        ok: true,
        // Only the non-secret half is reported: the endpoint and where it came from.
        library: resolved === undefined
          ? null
          : { endpoint: resolved.endpoint, bucket: resolved.bucket, source: resolved.source },
        cacheDir,
      })
      return
    }

    if (url.pathname !== `${ROUTE}/asset`) {
      sendJson(res, 404, { error: `unknown route: ${url.pathname}` })
      return
    }
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'only GET is allowed' })
      return
    }
    // A cross-origin page cannot set this header without a preflight, and no
    // preflight is answered here; a same-origin caller always can.
    if (req.headers[CALLER_HEADER] === undefined) {
      sendJson(res, 403, { error: `missing the ${CALLER_HEADER} request header` })
      return
    }

    const uri = url.searchParams.get('uri')
    if (uri === null || !uri.startsWith('s3://')) {
      sendJson(res, 400, { error: 'uri must be an s3:// reference' })
      return
    }
    const resolved = await library()
    if (resolved === undefined) {
      sendJson(res, 503, {
        error: 'no asset library is configured: set DSH_USD_S3_ENDPOINT, '
          + 'DSH_USD_S3_ACCESS_KEY and DSH_USD_S3_SECRET_KEY '
          + '(optionally DSH_USD_S3_BUCKET and DSH_USD_S3_REGION)',
      })
      return
    }

    try {
      const asset = await readAsset(resolved, uri, cacheDir)
      if (asset === undefined) {
        sendJson(res, 404, { error: `asset not found or not readable: ${uri}` })
        return
      }
      ctx.logger?.debug?.('[usd-3d-preview] asset %s (%s, %d B)', uri, asset.source, asset.data.byteLength)
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': String(asset.data.byteLength),
        'cache-control': 'no-store',
        'x-dsh-usd-preview-source': asset.source,
      })
      res.end(asset.data)
    } catch (error) {
      ctx.logger?.warn?.('[usd-3d-preview] asset %s failed: %s', uri, String(error?.message ?? error))
      if (!res.headersSent) sendJson(res, 500, { error: String(error?.message ?? error) })
      else res.destroy()
    }
  }

  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler }),
    'usd-3d-preview: asset route',
  )
  void library().then(
    (resolved) => {
      ctx.logger?.info?.(
        '[usd-3d-preview] asset route ready at %s (library=%s)',
        ROUTE,
        resolved === undefined ? 'none' : `${resolved.endpoint}/${resolved.bucket} from ${resolved.source}`,
      )
    },
    () => undefined,
  )
}
