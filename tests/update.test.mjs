/**
 * Update suite: the local-checkout updater offline.
 *
 * The browser suites cannot start a real update (it would rewrite the checkout
 * under them), so this suite covers the updater the way the s3 suite covers the
 * host: with an injected command runner for the exact output parsing and refusal
 * rules, plus one real local-git integration (a bare origin and a clone, no
 * network) that proves fast-forward + rebuild + host-change detection end to
 * end. The host routes are mounted through a fake Connection Fetch surface, as
 * in s3.test.mjs, so the registration contract is checked too.
 *
 * Run: node tests/update.test.mjs
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createUpdateService, needsShell, parseAheadBehind, tailLines, defaultRepoRoot } from '../src/host/update.js'

const lines = []
function say(line) {
  lines.push(line)
  process.stdout.write(line + '\n')
}

const work = await mkdtemp(join(tmpdir(), 'dsh-update-suite-'))

/** Spawn one command for the integration fixture; throws on a non-zero exit. */
function runChecked(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', code => (code === 0
      ? resolve(stdout.trim())
      : reject(new Error(command + ' ' + args.join(' ') + ': ' + stderr))))
  })
}

/** Write one file, creating its directory. */
async function write(file, text) {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, text)
}

try {
  // ── pure helpers ─────────────────────────────────────────────────────────
  assert.deepEqual(parseAheadBehind('0\t3'), { ahead: 0, behind: 3 }, 'left-right counts parse')
  assert.deepEqual(parseAheadBehind(''), { ahead: 0, behind: 0 }, 'empty counts are zero')
  assert.deepEqual(tailLines('a\nb\nc\nd', 2), ['c', 'd'], 'tailLines keeps the last lines')
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  assert.equal(defaultRepoRoot(), repoRoot, 'the default root is the package checkout')
  // The Windows shim rule, pinned without spawning anything: Node refuses a
  // .cmd/.bat without a shell (CVE-2024-27980), and that is the whole reason the
  // update can run npm on Windows at all.
  assert.equal(needsShell('npm.cmd', 'win32'), true, 'a Windows .cmd shim needs a shell')
  assert.equal(needsShell('NPM.CMD', 'win32'), true, 'the shim is matched case-insensitively')
  assert.equal(needsShell('run.bat', 'win32'), true, 'a .bat needs a shell too')
  assert.equal(needsShell('git', 'win32'), false, 'an .exe is spawned directly on Windows')
  assert.equal(needsShell('npm', 'darwin'), false, 'POSIX never needs a shell')
  say('update helpers       ahead/behind parsing, output tails, default root, Windows shim rule')

  // ── fake runner: exact status parsing and the refusal rules ─────────────
  const fakeRoot = join(work, 'fake-root')
  await mkdir(join(fakeRoot, '.git'), { recursive: true })
  await mkdir(join(fakeRoot, 'node_modules'), { recursive: true })
  await mkdir(join(fakeRoot, 'lib'), { recursive: true })
  await writeFile(join(fakeRoot, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.2.3' }))
  await writeFile(join(fakeRoot, 'lib/index.js'), 'host-v1')

  /** One canned command runner for the fake checkout. */
  function fakeRunner(overrides = {}) {
    return async (command, args) => {
      const key = command + ' ' + args.join(' ')
      for (const [prefix, handler] of Object.entries(overrides)) {
        if (key.startsWith(prefix)) return await handler(command, args)
      }
      if (key === 'git --version') return { code: 0, stdout: 'git version 2.0', stderr: '', timedOut: false }
      if (key === 'git rev-parse --abbrev-ref HEAD') return { code: 0, stdout: 'main\n', stderr: '', timedOut: false }
      if (key === 'git rev-parse --short HEAD') return { code: 0, stdout: 'abc1234\n', stderr: '', timedOut: false }
      if (key === 'git rev-parse HEAD') return { code: 0, stdout: 'abc1234567890\n', stderr: '', timedOut: false }
      if (key === 'git status --porcelain') return { code: 0, stdout: '', stderr: '', timedOut: false }
      if (key.startsWith('git rev-parse --abbrev-ref --symbolic-full-name')) return { code: 0, stdout: 'origin/main\n', stderr: '', timedOut: false }
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    }
  }

  {
    const service = createUpdateService({ root: fakeRoot, run: fakeRunner(), platform: 'darwin' })
    const status = await service.status()
    assert.equal(status.available, true, 'a git checkout is updatable')
    assert.equal(status.version, '1.2.3')
    assert.equal(status.branch, 'main')
    assert.equal(status.head, 'abc1234')
    assert.equal(status.dirty, false)
    assert.equal(status.upstream, 'origin/main')
    assert.equal(status.canUpdate, true)
    assert.equal(status.checked, false, 'status does not fetch the upstream')
    assert.equal(status.restartAvailable, false, 'a non-Linux host reports no service restart')
  }
  {
    const dirtyRunner = fakeRunner({
      'git status --porcelain': async () => ({ code: 0, stdout: ' M README.md\n', stderr: '', timedOut: false }),
    })
    const service = createUpdateService({ root: fakeRoot, run: dirtyRunner, platform: 'darwin' })
    const status = await service.status()
    assert.equal(status.dirty, true)
    assert.equal(status.canUpdate, false, 'a dirty tree is not updatable')
    await assert.rejects(() => service.update(), /uncommitted changes/, 'the update refuses a dirty tree')
    const error = await service.update().then(() => undefined, cause => cause)
    assert.equal(error.code, 'dirty-worktree')
  }
  {
    const detachedRunner = fakeRunner({
      'git rev-parse --abbrev-ref HEAD': async () => ({ code: 0, stdout: 'HEAD\n', stderr: '', timedOut: false }),
    })
    const service = createUpdateService({ root: fakeRoot, run: detachedRunner, platform: 'darwin' })
    const status = await service.status()
    assert.equal(status.detached, true)
    assert.equal(status.canUpdate, false, 'a detached HEAD is not updatable')
    await assert.rejects(() => service.update(), /detached HEAD/)
  }
  {
    const plainRoot = join(work, 'plain-root')
    await mkdir(plainRoot, { recursive: true })
    await writeFile(join(plainRoot, 'package.json'), JSON.stringify({ name: 'published', version: '9.9.9' }))
    const service = createUpdateService({ root: plainRoot, run: fakeRunner(), platform: 'darwin' })
    const status = await service.status()
    assert.equal(status.available, false)
    assert.equal(status.reason, 'not-a-git-checkout')
    const error = await service.update().then(() => undefined, cause => cause)
    assert.equal(error.code, 'not-a-git-checkout', 'an installed copy cannot update itself')
  }
  say('update status        checkout parsing, dirty/detached/not-a-checkout refusals')

  // ── fake runner: update flow, check counts, busy, restart ────────────────
  {
    const service = createUpdateService({ root: fakeRoot, run: fakeRunner(), platform: 'darwin' })
    const result = await service.update()
    assert.equal(result.ok, true)
    assert.equal(result.changed, false, 'an already-current merge reports no change')
    assert.deepEqual(result.steps.map(step => step.name), ['fetch', 'merge', 'install', 'build'])
    assert.equal(result.steps[2].skipped, true, 'package.json unchanged skips npm install')
    assert.equal(result.hostChanged, false)
    assert.equal(result.restartRequired, false)
  }
  {
    const service = createUpdateService({
      root: fakeRoot,
      platform: 'darwin',
      run: fakeRunner({
        'git rev-list --left-right --count': async () => ({ code: 0, stdout: '1\t2\n', stderr: '', timedOut: false }),
        'git log -1': async () => ({ code: 0, stdout: 'def5678\x00fixture commit\n', stderr: '', timedOut: false }),
      }),
    })
    const checked = await service.check()
    assert.equal(checked.checked, true)
    assert.equal(checked.behind, 2)
    assert.equal(checked.ahead, 1)
    assert.deepEqual(checked.latest, { head: 'def5678', subject: 'fixture commit' })
  }
  {
    // The update holds its lock while a command is in flight.
    let releaseFetch
    const gate = new Promise(resolve => { releaseFetch = resolve })
    const slowRunner = fakeRunner({
      'git fetch': async () => { await gate; return { code: 0, stdout: '', stderr: '', timedOut: false } },
    })
    const service = createUpdateService({ root: fakeRoot, run: slowRunner, platform: 'darwin' })
    const first = service.update()
    await new Promise(resolve => setTimeout(resolve, 20))
    const second = await service.update().then(() => undefined, cause => cause)
    assert.equal(second.code, 'busy', 'a second update while one runs is refused')
    releaseFetch()
    await first
  }
  {
    const detached = []
    const service = createUpdateService({
      root: fakeRoot,
      platform: 'linux',
      run: fakeRunner({
        'systemctl --user cat': async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
      }),
      spawnDetached: (command, args) => detached.push({ command, args }),
    })
    const restarted = await service.restart()
    assert.equal(restarted.ok, true)
    assert.equal(restarted.restarting, true)
    assert.deepEqual(detached, [{ command: 'systemctl', args: ['--user', 'restart', 'dsh-web.service'] }])
  }
  say('update flow          no-op merge, check counts, lock/busy, restart command')

  // ── real local-git integration: bare origin + clone, no network ─────────
  {
    const origin = join(work, 'origin.git')
    await runChecked('git', ['init', '--bare', '--initial-branch=main', origin], work)
    const seed = join(work, 'seed')
    await runChecked('git', ['clone', origin, seed], work)
    await write(join(seed, '.gitignore'), 'node_modules/\nlib/\n')
    await write(join(seed, 'package.json'), JSON.stringify({
      name: 'update-fixture',
      version: '1.0.0',
      scripts: { build: 'node build.mjs' },
    }))
    await write(join(seed, 'build.mjs'), [
      "import { mkdir, writeFile } from 'node:fs/promises'",
      "await mkdir('lib', { recursive: true })",
      "await writeFile('lib/index.js', 'host-v1')",
      '',
    ].join('\n'))
    await runChecked('git', ['add', '-A'], seed)
    await runChecked('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'v1'], seed)
    await runChecked('git', ['push', '-u', 'origin', 'main'], seed)

    const clone = join(work, 'clone')
    await runChecked('git', ['clone', origin, clone], work)
    // Both are ignored by the fixture's .gitignore, so the tree stays clean.
    await mkdir(join(clone, 'node_modules'), { recursive: true })
    await write(join(clone, 'lib/index.js'), 'host-v1')

    // One more upstream commit: source changes, so the next build writes a
    // different host bundle.
    await writeFile(join(seed, 'build.mjs'), [
      "import { mkdir, writeFile } from 'node:fs/promises'",
      "await mkdir('lib', { recursive: true })",
      "await writeFile('lib/index.js', 'host-v2')",
      '',
    ].join('\n'))
    await runChecked('git', ['add', '-A'], seed)
    await runChecked('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.com', 'commit', '-m', 'v2'], seed)
    await runChecked('git', ['push', 'origin', 'main'], seed)

    // The host's own platform, not a pinned one: this case really runs npm, and
    // Windows spells it "npm.cmd" — a command Node refuses to spawn without a
    // shell. Pinning 'darwin' here tested a command line this machine never uses,
    // and hid exactly that failure.
    const service = createUpdateService({ root: clone, platform: process.platform })
    const checked = await service.check()
    assert.equal(checked.checked, true, 'the local origin is reachable')
    assert.equal(checked.behind, 1, 'the clone is one commit behind')
    assert.equal(checked.latest.subject, 'v2')
    const result = await service.update()
    assert.equal(result.ok, true)
    assert.equal(result.changed, true, 'the fast-forward moved HEAD')
    assert.equal(result.hostChanged, true, 'the build rewrote lib/index.js')
    assert.equal(result.restartRequired, true)
    assert.equal(result.steps.find(step => step.name === 'install').skipped, true)
    assert.equal((await readFile(join(clone, 'lib/index.js'), 'utf8')), 'host-v2')
    const head = await runChecked('git', ['rev-parse', 'HEAD'], clone)
    const originHead = await runChecked('git', ['rev-parse', 'HEAD'], seed)
    assert.equal(head, originHead, 'the clone matches the upstream head')
    // A second update is a clean no-op.
    const again = await service.update()
    assert.equal(again.changed, false)
    say('update integration  local git: check behind, fast-forward, rebuild, host-change, idempotent rerun')
  }

  // ── host routes: registered behind the Connection Fetch service ─────────
  {
    const routes = new Map()
    const effects = []
    const hostContext = {
      effect: callback => { effects.push(callback); return callback() },
      logger: { info() {}, warn() {}, debug() {} },
      inject: (_dependencies, callback) => { callback(hostContext); },
      connection: {
        fetch: {
          register(route) {
            routes.set(route.path, route)
            return async () => undefined
          },
        },
      },
    }
    const hostHalf = await import('../src/host/index.js')
    hostHalf.apply(hostContext)
    assert.equal(routes.size, 3, 'asset, health and update routes are registered')
    const updateRoute = routes.get('/api/usd-preview/update')
    assert.ok(updateRoute !== undefined, 'the update route is registered')
    assert.deepEqual(updateRoute.methods, ['GET', 'POST'], 'the update route takes status reads and explicit actions')
    const invalidJson = await updateRoute.fetch(new Request('http://localhost/api/usd-preview/update', {
      method: 'POST',
      body: 'not json',
      headers: { 'content-type': 'application/json' },
    }))
    assert.equal(invalidJson.status, 400, 'a malformed body is refused')
    assert.equal((await invalidJson.json()).error, 'invalid-json')
    const unknownAction = await updateRoute.fetch(new Request('http://localhost/api/usd-preview/update', {
      method: 'POST',
      body: JSON.stringify({ action: 'something-else' }),
      headers: { 'content-type': 'application/json' },
    }))
    assert.equal(unknownAction.status, 400, 'an unknown action is refused')
    assert.equal((await unknownAction.json()).error, 'unknown-action')
    say('update routes        GET/POST registration, malformed body and unknown action refused')
  }

  say('update.test.mjs  OK')
} finally {
  await rm(work, { recursive: true, force: true })
}
