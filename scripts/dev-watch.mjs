#!/usr/bin/env node
/**
 * Front-end hot reload for local development.
 *
 * DSH's client HMR stat-polls each graph row's client bundle and hot-swaps the
 * browser plugin when lib/client.js changes. The missing piece in a directory
 * install is a watcher that (1) rebuilds the bundle on source changes and
 * (2) lands it where the running Host actually reads it. This script is that
 * piece — no page refresh and no Host restart needed for client-side changes.
 *
 * Run: npm run dev:watch
 *
 * Environment:
 *   DSH_USD_INSTALL_DIR  directory the profile actually loads (defaults to the
 *                        conventional user bundle path on this machine). Point it
 *                        at this checkout for a link: install — then lib/ *is* the
 *                        install and nothing is copied. A path that does not exist
 *                        is refused at startup instead of failing on every rebuild.
 *   DSH_USD_DEBOUNCE_MS  rebuild debounce in milliseconds (default 250). Validated
 *                        below: a typo must not turn every filesystem event into
 *                        its own build.
 *
 * Note: changes to the host half (src/host/*) also rebuild lib/index.js, but
 * Node's ESM cache needs a Host restart to pick that up. The script says so
 * when it happens; front-end changes never need one.
 *
 * The watchers are deliberately not the obvious ones:
 *   - package.json and build.mjs are watched through the package root directory,
 *     not as files, because fs.watch on a single file dies after an atomic save
 *     (write temp + rename), which is how most editors write;
 *   - lib/ is never watched (it is this script's own output, and watching it
 *     would make every rebuild trigger the next one);
 *   - every watcher reports fs.watch's 'error' event instead of letting it end
 *     the process, and is re-armed when the path comes back.
 */
import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { copyFile, mkdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const installDir = resolve(process.env.DSH_USD_INSTALL_DIR || join(
  process.env.USERPROFILE || process.env.HOME || '.', '.dsh', 'bundles', 'usd-3d-preview',
))

/** Long enough to coalesce one editor save (temp write, rename, chmod) into a single build. */
const DEFAULT_DEBOUNCE_MS = 250
/** A minute is already far too slow to be a debounce; past it the value is a typo, not a choice. */
const MAX_DEBOUNCE_MS = 60_000
/** Wait before re-arming a watcher that reported an error: a rename can be transient. */
const WATCH_RETRY_MS = 1000
/** Consecutive errors on one path before giving up — a deleted source tree does not come back by itself. */
const MAX_WATCH_RETRIES = 5

const debounceMs = debounceFromEnv(process.env.DSH_USD_DEBOUNCE_MS)

const sourceDirs = [join(root, 'src', 'client'), join(root, 'src', 'host')]
/** Files in the package root that change the build itself; watched via the directory. */
const buildFiles = ['build.mjs', 'package.json']

let timer = undefined
let running = false
let queued = false
let stopped = false
let linkInstall = false

/** Live watchers, so a fatal error can release the ones still open and let the process exit. */
const watchers = new Set()
/** Pending re-arm timers, for the same reason: a scheduled re-arm must not outlive a shutdown. */
const retryTimers = new Set()

const stamp = () => new Date().toLocaleTimeString('en-GB', { hour12: false })

/**
 * Read DSH_USD_DEBOUNCE_MS, or explain why the value cannot be used.
 *
 * Number() turns anything non-numeric into NaN and setTimeout(NaN) into 0 ms, so
 * an unvalidated value degrades silently into "one build per filesystem event" —
 * exactly the stampede the debounce exists to prevent, and it looks like the
 * watcher working. Empty means unset (Number('') is 0, not NaN, so test it first).
 * @param {string | undefined} raw - the environment value as received.
 * @returns {number} a debounce in 0..MAX_DEBOUNCE_MS milliseconds.
 */
function debounceFromEnv(raw) {
  if (raw === undefined || raw.trim() === '') return DEFAULT_DEBOUNCE_MS
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > MAX_DEBOUNCE_MS) {
    process.stderr.write(
      'dev-watch: ignoring DSH_USD_DEBOUNCE_MS=' + JSON.stringify(raw)
      + ' (expected a number of milliseconds between 0 and ' + MAX_DEBOUNCE_MS
      + '); using ' + DEFAULT_DEBOUNCE_MS + ' ms\n',
    )
    return DEFAULT_DEBOUNCE_MS
  }
  return value
}

/** Run build.mjs, then land the fresh bundle where the profile reads it. */
async function rebuild() {
  if (running === true) { queued = true; return }
  running = true
  try {
    process.stdout.write('[' + stamp() + '] rebuilding…\n')
    // A link install builds straight into the installed files, so the only way to
    // notice that the host half changed is to remember it before the build; the
    // copy branch below compares the two files instead.
    const hostSource = join(root, 'lib', 'index.js')
    const hostBefore = linkInstall === true ? await readFile(hostSource).catch(() => undefined) : undefined
    const ok = await new Promise((done) => {
      const child = spawn(process.execPath, [join(root, 'build.mjs')], { cwd: root, stdio: 'inherit' })
      child.on('close', code => done(code === 0))
      child.on('error', () => done(false))
    })
    // A failed build is a normal part of editing: report it and keep watching.
    if (ok !== true) { process.stderr.write('[' + stamp() + '] build failed; still watching\n'); return }

    const clientSource = join(root, 'lib', 'client.js')
    let hostChanged = false
    let sizeKiB
    if (linkInstall === true) {
      // Same file before and after: nothing to copy, and sameFile() below would
      // compare it with itself and always answer "unchanged".
      const hostAfter = await readFile(hostSource).catch(() => undefined)
      hostChanged = hostBefore === undefined || hostAfter === undefined || !hostBefore.equals(hostAfter)
      sizeKiB = ((await stat(clientSource)).size / 1024).toFixed(0)
    } else {
      const clientTarget = join(installDir, 'lib', 'client.js')
      await copyFile(clientSource, clientTarget)
      const hostTarget = join(installDir, 'lib', 'index.js')
      hostChanged = !await sameFile(hostSource, hostTarget)
      if (hostChanged === true) await copyFile(hostSource, hostTarget)
      sizeKiB = ((await stat(clientTarget)).size / 1024).toFixed(0)
    }

    const summary = linkInstall === true
      ? 'rebuilt client bundle (' + sizeKiB + ' KiB) in lib/ — link install, so this is the hot reload'
      : 'hot-reloaded client bundle (' + sizeKiB + ' KiB)'
    process.stdout.write(
      '[' + stamp() + '] ' + summary
      + (hostChanged === true ? ' — host half changed: restart DSH Web for it' : '') + '\n',
    )
  } catch (error) {
    process.stderr.write('[' + stamp() + '] ' + String(error) + '\n')
  } finally {
    running = false
    if (queued === true) { queued = false; schedule() }
  }
}

/** @returns {Promise<boolean>} whether two files have identical size and content. */
async function sameFile(a, b) {
  try {
    const [sa, sb] = await Promise.all([stat(a), stat(b)])
    if (sa.size !== sb.size) return false
    const [ba, bb] = await Promise.all([readFile(a), readFile(b)])
    return ba.equals(bb)
  } catch { return false }
}

/** Debounce a rebuild request; a save burst restarts the timer instead of stacking builds. */
function schedule() {
  if (stopped === true) return
  if (timer !== undefined) clearTimeout(timer)
  timer = setTimeout(() => { timer = undefined; void rebuild() }, debounceMs)
}

/** realpath where the path exists (this resolves junctions and symlinks), resolve otherwise. */
async function canonical(path) {
  return realpath(path).catch(() => resolve(path))
}

/** @returns {Promise<boolean>} whether two paths name the same directory, symlink and case included. */
async function isSamePath(a, b) {
  const [left, right] = await Promise.all([canonical(a), canonical(b)])
  // Windows paths are case-insensitive and fs.realpath returns the on-disk case.
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * Decide where the built bundle has to land, and refuse to start when that cannot work.
 *
 * Two installs exist in the wild:
 *   copy install  the profile holds its own copy of the bundle (the default path
 *                 under the user profile), so the fresh lib/*.js must be copied in;
 *   link install  the profile depends on `link:<this checkout>` and reads lib/ right
 *                 here, so there is nothing to copy and a copy would be a no-op that
 *                 still claimed a hot reload had happened.
 *
 * Getting this wrong is silent in the worst way: with a missing directory every
 * copyFile throws ENOENT inside the per-rebuild try/catch, which prints an error
 * that looks like any other and leaves the profile on the old bundle forever. So
 * the directory is validated once, here, before anything is watched.
 * @returns {Promise<{ link: boolean } | undefined>} undefined when the problem was already explained.
 */
async function checkInstallDir() {
  const link = await isSamePath(installDir, root)
  const info = await stat(installDir).catch(() => undefined)
  if (info === undefined || info.isDirectory() !== true) {
    process.stderr.write(
      'dev-watch: install directory ' + (info === undefined ? 'does not exist: ' : 'is not a directory: ') + installDir + '\n'
      + '  Nothing was watched: every rebuild would fail to copy the bundle into it.\n'
      + '  Point DSH_USD_INSTALL_DIR at the directory your profile actually loads:\n'
      + '    copy install  DSH_USD_INSTALL_DIR=<profile>/node_modules/dsh-usd-3d-preview\n'
      + '    link install  DSH_USD_INSTALL_DIR=' + root + '\n',
    )
    return undefined
  }
  if (link !== true) {
    // The layout the loader expects is <install>/lib/*.js; creating the one
    // directory is not a guess about content, it is the shape the copy needs.
    await mkdir(join(installDir, 'lib'), { recursive: true })
  }
  return { link }
}

/** Stop watching everything, so the process can exit on its own. */
function stopWatching() {
  stopped = true
  if (timer !== undefined) { clearTimeout(timer); timer = undefined }
  for (const retry of retryTimers) clearTimeout(retry)
  retryTimers.clear()
  for (const watcher of watchers) {
    try { watcher.close() } catch { /* the handle is already gone */ }
  }
  watchers.clear()
}

/**
 * Watch one path and keep the watch alive across the errors fs.watch reports.
 *
 * fs.watch emits 'error' when what it watches is torn away underneath it
 * (a deleted directory, a handle closed elsewhere). Unhandled, that event ends
 * the process with a bare stack trace and the developer learns nothing, so it is
 * reported and the watcher is re-armed: most such errors are a rename still in
 * flight, and the re-arm succeeds a second later. MAX_WATCH_RETRIES consecutive
 * failures mean the path is not coming back, and idling with no watchers would be
 * worse than stopping — say so and exit non-zero. Any event resets the counter,
 * so only a genuinely broken path ever exhausts it.
 *
 * The 'error' event alone is not enough, which is the subtle part. Deleting a
 * watched directory on Windows does not raise it at all: the handle keeps
 * reporting rename events for a path that is gone. Every one of those events
 * restarts the debounce, so a vanished directory does not merely stop working —
 * it freezes the whole watcher in a livelock and no rebuild ever runs again.
 * When the event stream goes quiet, the path is therefore checked: still there
 * (or only just re-appeared) and nothing needs to happen; gone and the failure
 * path above takes over, which re-arms it if the directory was a transient
 * rename and gives up loudly if it was deleted.
 * @param {string} path - file or directory to watch.
 * @param {object} options - fs.watch options.
 * @param {(event: string, filename: string | undefined) => void} onEvent - change callback.
 */
function watchPath(path, options, onEvent) {
  let attempts = 0
  let checkTimer = undefined
  let current = undefined

  const fail = (reason) => {
    // A shutdown already in progress must not be re-reported as a fresh failure.
    if (stopped === true) return
    attempts += 1
    process.stderr.write('[' + stamp() + '] watch error on ' + path + ': ' + reason + '\n')
    if (attempts >= MAX_WATCH_RETRIES) {
      process.stderr.write(
        '[' + stamp() + '] giving up on ' + path + ' after ' + attempts
        + ' consecutive failures — recreate the path and start dev:watch again\n',
      )
      stopWatching()
      process.exitCode = 1
      return
    }
    process.stderr.write('[' + stamp() + '] re-arming in ' + WATCH_RETRY_MS + ' ms\n')
    const retry = setTimeout(() => { retryTimers.delete(retry); arm() }, WATCH_RETRY_MS)
    retryTimers.add(retry)
  }

  /** Retire the handle we hold; null means "no watcher is armed right now". */
  const closeCurrent = () => {
    if (checkTimer !== undefined) { clearTimeout(checkTimer); checkTimer = undefined }
    if (current === undefined) return
    watchers.delete(current)
    try { current.close() } catch { /* the handle is already gone */ }
    current = undefined
  }

  /** Once the event stream has been quiet for one debounce: is the path still there? */
  const checkAlive = async () => {
    checkTimer = undefined
    if (stopped === true || current === undefined) return
    const info = await stat(path).catch(() => undefined)
    if (info !== undefined) return
    // Gone. Retire the dead handle now rather than wait for an 'error' event that
    // some platforms never send for a deleted directory.
    closeCurrent()
    fail('path is gone (deleted or renamed away)')
  }

  const arm = () => {
    if (stopped === true) return
    closeCurrent()
    let watcher
    try {
      watcher = watch(path, options, (event, filename) => {
        // A live event means the path answered: whatever made the last attempt
        // fail has resolved, so the retry budget starts over.
        attempts = 0
        onEvent(event, filename)
        // Coalesced: one pending liveness check per burst of events.
        if (checkTimer === undefined) {
          checkTimer = setTimeout(() => { void checkAlive() }, Math.max(debounceMs, 50))
        }
      })
    } catch (error) {
      // watch() throws synchronously when the path is already gone, which is the
      // same situation as an 'error' event and is handled the same way.
      fail(String(error))
      return
    }
    current = watcher
    watchers.add(watcher)
    watcher.on('error', (error) => {
      // A handle we have already retired must not report for its replacement.
      if (watcher !== current) return
      closeCurrent()
      fail(String(error))
    })
  }

  arm()
}

/** Validate the setup, print what is watched, and arm every watcher. */
async function main() {
  const install = await checkInstallDir()
  if (install === undefined) return 1
  linkInstall = install.link

  for (const dir of sourceDirs) {
    watchPath(dir, { recursive: true }, (_event, filename) => { if (filename !== undefined) schedule() })
    process.stdout.write('watching ' + dir + '\n')
  }
  // The package root, not the two files: an atomic save replaces the file, and a
  // watcher bound to the old inode/file handle stops delivering events after that.
  watchPath(root, { recursive: false }, (_event, filename) => {
    // A recursive-less directory watch reports basenames; some platforms hand back
    // a relative path instead, so take the basename and filter on that.
    if (filename !== undefined && buildFiles.includes(basename(filename))) schedule()
  })
  process.stdout.write('watching ' + root + ' (' + buildFiles.join(', ') + ')\n')
  process.stdout.write('install: ' + installDir + (linkInstall === true
    ? ' — link install: the profile reads this lib/, so the rebuild alone is the hot reload'
    : ' — rebuilt bundles are copied into its lib/') + '\n')
  process.stdout.write('debounce: ' + debounceMs + ' ms\n')
  process.stdout.write('edit a client source file to rebuild and hot-reload the plugin\n')
  return 0
}

try {
  process.exitCode = await main()
} catch (error) {
  // A watcher script that dies with a bare stack trace says nothing about which
  // part of the setup broke; name it and let the exit code carry the failure.
  process.stderr.write('dev-watch: ' + String(error?.stack ?? error) + '\n')
  process.exitCode = 1
}
