/**
 * Host half: intentionally empty.
 *
 * Everything this plugin does happens in the browser — the USD stage is composed
 * by a WebAssembly build of OpenUSD inside a Web Worker and drawn by three.js in
 * the document panel. The host has nothing to add: no route, no service, no
 * configuration.
 *
 * The package still ships a host half because that is how a dsh bundle is
 * discovered: the loader imports this entry, and the `dsh.client` field in
 * `package.json` is what makes the host serve `lib/client.js` to the browser at
 * all. Keeping the entry minimal also keeps the client plugin installable in a
 * profile whose runtime has no web server.
 */

/** Plugin name shown by the loader. */
export const name = 'usd-3d-preview'

/**
 * Attach nothing.
 *
 * Declared so the loader sees the plugin as applied; there is no service to
 * inject and no effect to own.
 */
export function apply() {}
