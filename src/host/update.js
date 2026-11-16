/**
 * Local checkout update service: fast-forward this plugin's clone, install
 * dependencies when they changed, rebuild lib/, and (optionally) restart the
 * host that serves it.
 *
 * One implementation is shared by the terminal entry point
 * (scripts/update-local.mjs) and the host update routes, so "update" means the
 * same thing however it is started. The rules are deliberately narrow:
 *
 *   - only a git checkout is updated; an installed/published copy reports
 *     "not-a-git-checkout" and changes nothing;
 *   - a dirty working tree is refused, so user edits are never overwritten;
 *   - the update is a fast-forward of the checkout's own upstream (the CLI may
 *     check out one named branch first); no reset, no force, no rebase;
 *   - every command is spawned with a fixed argv (no shell interpolation),
 *     and only git/npm commands this module names are run;
 *   - GET status is read-only; the fetch that answers "is there an update" is a
 *     POST action, and a restart is a separate explicit POST action.
 *
 * The host half that serves this module keeps its old code in Node's ESM cache,
 * so an update that changes lib/index.js reports restartRequired; the browser
 * half is reloaded by the DSH client HMR once lib/client.js changes.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Terminal entry point shared with the CLI (informational: is it present?). */
export const UPDATE_SCRIPT = 'scripts/update-local.mjs'

/** The built host half; a change here needs a host restart. */
export const HOST_BUNDLE = 'lib/index.js'

/** One command's wall-clock budget. npm install may legitimately take minutes. */
const DEFAULT_TIMEOUT_MS = 120_000

/** Build/install budget: generous, because a cold npm install is slow. */
const BUILD_TIMEOUT_MS = 10 * 60 * 1000

/** Output kept per command; enough for the error message shown in the UI. */
const OUTPUT_LIMIT = 200_000

/** Error carrying a stable machine-readable code for the route/UI. */
export class UpdateError extends Error {
  /**
   * @param code - stable code such as "dirty-worktree".
   * @param message - human-readable message.
   * @param options - optional command log attached to the error.
   */
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'UpdateError'
    this.code = code
    if (options.log !== undefined) this.log = options.log
  }
}

/**
 * The checkout root this module lives in.
 *
 * The module runs from two places: src/host/update.js in the source tree, and
 * lib/index.js once bundled into the host half. Walking up to the nearest
 * directory that holds both package.json and the bundle patch covers both, and
 * also tolerates the package being vendored under a different folder name.
 * @returns the absolute package root.
 */
export function defaultRepoRoot() {
  const start = dirname(fileURLToPath(import.meta.url))
  let current = start
  for (let depth = 0; depth < 5; depth += 1) {
    if (existsSync(join(current, 'package.json')) && existsSync(join(current, 'cordis.patch.yml'))) return current
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return start
}

/** Spawn one command and collect its output; never rejects. */
export function createCommandRunner({ spawnImpl = spawn } = {}) {
  return (command, args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    const append = (text, current) => (current.length >= OUTPUT_LIMIT ? current : current + text)
    let child
    try {
      child = spawnImpl(command, args, { cwd, windowsHide: true })
    } catch (error) {
      resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error), timedOut: false })
      return
    }
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 5000).unref?.()
      }, timeoutMs)
      : undefined
    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { stdout = append(String(chunk), stdout) })
    child.stderr?.on('data', (chunk) => { stderr = append(String(chunk), stderr) })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: -1, stdout, stderr: stderr + String(error?.message ?? error), timedOut: false })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout, stderr, timedOut })
    })
  })
}

/** Last lines of one command's output, for an error message or a UI log. */
export function tailLines(text, maxLines = 12) {
  const lines = String(text ?? '').trim().split(/\r?\n/).filter(line => line !== '')
  return lines.slice(Math.max(0, lines.length - maxLines))
}

/** SHA-256 of one file, or undefined when it does not exist. */
async function hashFile(path) {
  try {
    return createHash('sha256').update(await readFile(path)).digest('hex')
  } catch {
    return undefined
  }
}

/** Whether a branch name is a plain ref this module is willing to check out. */
function isSafeBranchName(name) {
  return typeof name === 'string'
    && name.length > 0
    && name.length <= 200
    && /^[A-Za-z0-9._/-]+$/.test(name)
    && !name.includes('..')
    && !name.startsWith('/')
    && !name.endsWith('/')
}

/** Read one package.json version, or "?" when it is absent/unparsable. */
async function packageVersion(root) {
  try {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    return typeof manifest.version === 'string' ? manifest.version : '?'
  } catch {
    return '?'
  }
}

/** Line parser for "git rev-list --left-right --count A...B" output. */
export function parseAheadBehind(stdout) {
  const [ahead, behind] = String(stdout ?? '').trim().split(/\s+/).map(value => Number(value))
  return {
    ahead: Number.isFinite(ahead) ? ahead : 0,
    behind: Number.isFinite(behind) ? behind : 0,
  }
}

/** Schedule a detached command without keeping the caller alive. */
function spawnDetachedDefault(command, args) {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}

/**
 * Build one update service bound to a checkout.
 *
 * The command runner is injectable so the service can be tested without
 * touching git, npm or a real checkout; the terminal entry point and the host
 * routes use the default spawn runner.
 * @param options - root, command runner, platform, service name, detached spawner.
 * @returns the service: status(), check(), update(), restart().
 */
export function createUpdateService({
  root = defaultRepoRoot(),
  run = createCommandRunner(),
  platform = process.platform,
  env = process.env,
  service = env.DSH_WEB_SERVICE || 'dsh-web.service',
  spawnDetached = spawnDetachedDefault,
} = {}) {
  const npmCommand = platform === 'win32' ? 'npm.cmd' : 'npm'
  const scriptPath = join(root, UPDATE_SCRIPT)
  const hostBundlePath = join(root, HOST_BUNDLE)

  /** Log of the running update; also attached to thrown errors. */
  const log = []
  const record = (line) => {
    log.push(line)
    if (log.length > 200) log.shift()
  }

  /** Run one command and fail with a stable code; log the command and error tail. */
  const runCommand = async (command, args, { cwd = root, timeoutMs = DEFAULT_TIMEOUT_MS, code, label } = {}) => {
    record('$ ' + [command, ...args].join(' '))
    const result = await run(command, args, { cwd, timeoutMs, env })
    if (result.timedOut) {
      const detail = tailLines(result.stderr || result.stdout)
      for (const line of detail) record(line)
      throw new UpdateError('command-timeout', (label ?? command) + ' timed out', { log: [...log] })
    }
    if (result.code !== 0) {
      const detail = tailLines(result.stderr || result.stdout)
      for (const line of detail) record(line)
      throw new UpdateError(code ?? 'command-failed', (label ?? command) + ' failed (exit ' + result.code + ')', { log: [...log] })
    }
    return result
  }

  /** Run one git command and return its trimmed stdout. */
  const git = async (args, options = {}) => {
    const result = await runCommand('git', args, { timeoutMs: 60_000, ...options })
    return result.stdout.trim()
  }

  /** Run one git command that may fail; returns {ok, stdout, stderr} instead. */
  const tryGit = async (args, options = {}) => {
    const result = await run('git', [...args], { cwd: root, timeoutMs: 30_000, env, ...options })
    return { ok: result.code === 0 && !result.timedOut, stdout: result.stdout.trim(), stderr: result.stderr }
  }

  let restartProbe
  /** Whether this host has a user service the update can restart (probed once). */
  const canRestart = async () => {
    if (platform !== 'linux') return false
    if (restartProbe === undefined) {
      restartProbe = (async () => {
        const result = await run('systemctl', ['--user', 'cat', service], { cwd: root, timeoutMs: 5000, env })
        return result.code === 0 && !result.timedOut
      })()
    }
    return await restartProbe
  }

  /** Local status only: no network, no working-tree change. */
  const status = async () => {
    const version = await packageVersion(root)
    const restartAvailable = await canRestart()
    if (!existsSync(join(root, '.git'))) {
      return {
        ok: true,
        available: false,
        reason: 'not-a-git-checkout',
        root,
        version,
        platform,
        service,
        restartAvailable,
        scriptPresent: existsSync(scriptPath),
      }
    }
    const gitAvailable = await tryGit(['--version'])
    if (!gitAvailable.ok) {
      return {
        ok: true,
        available: false,
        reason: 'git-unavailable',
        root,
        version,
        platform,
        service,
        restartAvailable,
        scriptPresent: existsSync(scriptPath),
      }
    }
    const branchText = await tryGit(['rev-parse', '--abbrev-ref', 'HEAD'])
    if (!branchText.ok) {
      return {
        ok: true,
        available: false,
        reason: 'not-a-git-checkout',
        root,
        version,
        platform,
        service,
        restartAvailable,
        scriptPresent: existsSync(scriptPath),
      }
    }
    const branchName = branchText.stdout
    const detached = branchName === 'HEAD'
    const head = await git(['rev-parse', '--short', 'HEAD'])
    const headFull = await git(['rev-parse', 'HEAD'])
    const dirtyText = await git(['status', '--porcelain'])
    const dirty = dirtyText !== ''
    const upstreamText = await tryGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    const upstream = upstreamText.ok && upstreamText.stdout !== '' ? upstreamText.stdout : undefined
    return {
      ok: true,
      available: true,
      root,
      version,
      branch: detached ? undefined : branchName,
      detached,
      head,
      headFull,
      dirty,
      changes: dirty ? dirtyText.split(/\r?\n/).length : 0,
      upstream,
      ahead: undefined,
      behind: undefined,
      checked: false,
      latest: undefined,
      canUpdate: !detached && upstream !== undefined && !dirty,
      scriptPresent: existsSync(scriptPath),
      hostBundlePresent: existsSync(hostBundlePath),
      platform,
      service,
      restartAvailable,
    }
  }

  /**
   * Fetch the upstream and report how far this checkout is behind it.
   * @returns status with checked/ahead/behind/latest filled in.
   */
  const check = async () => {
    const before = await status()
    if (before.available !== true) return before
    if (before.upstream === undefined) return { ...before, checked: false }
    const fetched = await tryGit(['fetch', '--quiet', '--prune'], { timeoutMs: 60_000 })
    if (!fetched.ok) {
      return {
        ...before,
        checked: false,
        fetchError: tailLines(fetched.stderr).join(' '),
      }
    }
    const counts = await tryGit(['rev-list', '--left-right', '--count', 'HEAD...@{u}'])
    if (!counts.ok) return { ...before, checked: false }
    const { ahead, behind } = parseAheadBehind(counts.stdout)
    const latestLog = await tryGit(['log', '-1', '--format=%h%x00%s', '@{u}'])
    let latest
    if (latestLog.ok && latestLog.stdout !== '') {
      const [hash, subject] = latestLog.stdout.split('\x00')
      latest = { head: hash, subject: subject ?? '' }
    }
    const after = await status()
    return { ...after, checked: true, ahead, behind, latest, canUpdate: after.canUpdate }
  }

  /** Serializes updates: one at a time, and a second caller gets "busy". */
  let updating = false

  /**
   * Fast-forward the checkout, install dependencies when needed, rebuild lib/,
   * and optionally restart the host.
   * @param options - branch to check out first, and whether to restart.
   * @returns before/after identity, the steps taken, and restart advice.
   */
  const update = async ({ branch, restart = false } = {}) => {
    if (updating) throw new UpdateError('busy', 'an update is already running')
    if (branch !== undefined && !isSafeBranchName(branch)) throw new UpdateError('bad-branch', 'invalid branch name')
    updating = true
    log.length = 0
    const hostHashBefore = await hashFile(hostBundlePath)
    try {
      const before = await status()
      if (before.available !== true) throw new UpdateError(before.reason ?? 'not-a-git-checkout', 'this installation cannot be updated in place')
      if (before.detached) throw new UpdateError('detached-head', 'the checkout is on a detached HEAD')
      if (before.dirty) throw new UpdateError('dirty-worktree', 'the working tree has uncommitted changes', { log: [...log] })
      if (before.upstream === undefined && branch === undefined) throw new UpdateError('no-upstream', 'the current branch has no upstream to fast-forward from')

      let currentBranch = before.branch
      if (branch !== undefined) {
        const exists = await tryGit(['show-ref', '--verify', '--quiet', 'refs/heads/' + branch])
        if (!exists.ok) {
          await runCommand('git', ['checkout', '-b', branch, '--track', 'origin/' + branch], { code: 'checkout-failed', label: 'git checkout ' + branch })
        } else if (currentBranch !== branch) {
          await runCommand('git', ['checkout', branch], { code: 'checkout-failed', label: 'git checkout ' + branch })
        }
        currentBranch = branch
      }

      await runCommand('git', ['fetch', '--quiet', '--prune'], { timeoutMs: 120_000, code: 'fetch-failed', label: 'git fetch' })
      const target = branch !== undefined ? 'origin/' + branch : '@{u}'
      const beforeHash = await git(['rev-parse', 'HEAD'])
      await runCommand('git', ['merge', '--ff-only', target], { code: 'not-fast-forwardable', label: 'git merge --ff-only ' + target })
      const afterHash = await git(['rev-parse', 'HEAD'])
      const changed = afterHash !== beforeHash
      const steps = [{ name: 'fetch', ok: true }, { name: 'merge', ok: true, changed, detail: currentBranch }]
      record('$ git merge -> ' + afterHash.slice(0, 7))

      const dependencyDiff = await git(['diff', '--name-only', beforeHash, afterHash, '--', 'package.json'])
      const dependenciesChanged = dependencyDiff !== ''
      const nodeModulesPresent = existsSync(join(root, 'node_modules'))
      if (dependenciesChanged || !nodeModulesPresent) {
        await runCommand(npmCommand, ['install', '--no-audit', '--no-fund'], { timeoutMs: BUILD_TIMEOUT_MS, code: 'install-failed', label: 'npm install' })
        steps.push({ name: 'install', ok: true, detail: dependenciesChanged ? 'package.json changed' : 'node_modules missing' })
      } else {
        steps.push({ name: 'install', ok: true, skipped: true, detail: 'package.json unchanged' })
      }

      await runCommand(npmCommand, ['run', 'build'], { timeoutMs: BUILD_TIMEOUT_MS, code: 'build-failed', label: 'npm run build' })
      steps.push({ name: 'build', ok: true })

      const hostHashAfter = await hashFile(hostBundlePath)
      const hostChanged = hostHashBefore !== hostHashAfter
      const after = await status()
      const restartResult = restart ? await restartNow() : undefined
      return {
        ok: true,
        root,
        from: { version: before.version, head: before.head, branch: before.branch },
        to: { version: after.version, head: after.head, branch: after.branch },
        changed,
        steps,
        hostChanged,
        restartRequired: hostChanged,
        restart: restartResult,
        log: [...log],
      }
    } catch (error) {
      if (error instanceof UpdateError) error.log = error.log ?? [...log]
      throw error
    } finally {
      updating = false
    }
  }

  /** Ask the host's user service to restart, so a new host half is loaded. */
  const restartNow = async ({ delayMs = 0 } = {}) => {
    if (!(await canRestart())) {
      return {
        ok: false,
        error: 'restart-unavailable',
        service,
        hint: 'restart the DeepSeek Harness host manually (for example: systemctl --user restart ' + service + ')',
      }
    }
    const fire = () => spawnDetached('systemctl', ['--user', 'restart', service])
    if (delayMs > 0) {
      const timer = setTimeout(fire, delayMs)
      timer.unref?.()
    } else {
      fire()
    }
    return { ok: true, restarting: true, service, delayed: delayMs > 0 }
  }

  return { root, status, check, update, restart: restartNow }
}
