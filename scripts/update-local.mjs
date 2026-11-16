#!/usr/bin/env node
/**
 * Update this plugin's local checkout from its own upstream and rebuild it.
 *
 * This is the terminal entry point to the same logic the Settings / Plugins
 * update panel uses (src/host/update.js), so a checkout, a CI machine and the
 * browser button all follow one procedure:
 *
 *   fast-forward  ->  npm install (only if package.json changed)  ->  npm run build
 *
 * Examples:
 *   npm run update:local                  update the current branch
 *   npm run update:local -- --check       fetch and report how far behind it is
 *   node scripts/update-local.mjs --status
 *   node scripts/update-local.mjs --update --branch feat/objstore-s3-prims
 *   node scripts/update-local.mjs --update --restart   restart the host service if lib/index.js changed
 *   node scripts/update-local.mjs --check --json       machine-readable output
 *
 * Exit code 0 on success (including "already up to date"), 1 on a refused or
 * failed update. A dirty working tree is refused; the update never resets.
 *
 * The DeepSeek Harness browser half is reloaded by the DSH client HMR after
 * lib/client.js changes; a change to lib/index.js needs a host restart (systemd
 * user service on Linux, or restart however this deployment was started).
 */
import { createUpdateService, UpdateError, defaultRepoRoot } from '../src/host/update.js'

/** Print one section header. */
const heading = (text) => process.stdout.write('\n' + text + '\n')

/** Human-readable status lines shared by --status and --check. */
function printStatus(status, { checked = false } = {}) {
  if (status.available !== true) {
    heading('dsh-usd-3d-preview: not an updatable checkout')
    console.log('  root:    ' + status.root)
    console.log('  version: ' + status.version)
    console.log('  reason:  ' + (status.reason ?? 'unknown') + ' (an installed package cannot update itself)')
    console.log('  update from a git checkout with: npm run update:local')
    return
  }
  heading('dsh-usd-3d-preview ' + status.version + ' (' + (status.branch ?? 'detached') + ')')
  console.log('  root:     ' + status.root)
  console.log('  commit:   ' + status.head)
  console.log('  upstream: ' + (status.upstream ?? 'none'))
  if (checked && status.checked) {
    console.log('  state:    ' + status.behind + ' behind, ' + status.ahead + ' ahead of ' + status.upstream)
    if (status.latest !== undefined) console.log('  latest:   ' + status.latest.head + ' ' + status.latest.subject)
  } else if (status.upstream === undefined) {
    console.log('  state:    no upstream branch configured; nothing to fast-forward from')
  } else if (status.fetchError !== undefined) {
    console.log('  fetch:    failed: ' + status.fetchError)
  } else {
    console.log('  state:    not checked (pass --check to fetch the upstream)')
  }
  if (status.dirty) console.log('  warning:  working tree has ' + status.changes + ' uncommitted change(s); an update will be refused')
  console.log('  restart:  ' + (status.restartAvailable ? status.service + ' (available)' : 'no user service detected; restart the host manually'))
}

/** Print one completed update. */
function printUpdate(result) {
  heading('updated ' + result.from.version + ' -> ' + result.to.version + ' (' + (result.to.branch ?? 'detached') + ')')
  console.log('  commit:   ' + result.from.head + ' -> ' + result.to.head)
  for (const step of result.steps) {
    const detail = step.detail === undefined ? '' : ' (' + step.detail + ')'
    console.log('  ' + (step.skipped ? 'skip' : 'ok  ') + '      ' + step.name + detail)
  }
  console.log('  host:     ' + (result.hostChanged ? 'lib/index.js changed: a host restart is needed' : 'lib/index.js unchanged: no restart needed'))
  if (result.restart !== undefined) {
    console.log('  restart:  ' + (result.restart.ok ? 'requested (' + result.restart.service + ')' : 'not requested: ' + (result.restart.hint ?? result.restart.error)))
  } else if (result.restartRequired) {
    console.log('  restart:  run npm run update:local -- --restart, or restart the host manually')
  }
  console.log('\nclient bundle rebuilt; the DSH client HMR reloads it, or refresh the browser tab.')
}

/** Parse the small CLI surface; no third-party dependency. */
function parseArguments(argv) {
  const options = { action: 'update', branch: undefined, restart: false, json: false, root: undefined, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--status') options.action = 'status'
    else if (argument === '--check') options.action = 'check'
    else if (argument === '--update') options.action = 'update'
    else if (argument === '--branch') { options.branch = argv[index + 1]; index += 1 }
    else if (argument === '--root') { options.root = argv[index + 1]; index += 1 }
    else if (argument === '--restart') options.restart = true
    else if (argument === '--json') options.json = true
    else if (argument === '--help' || argument === '-h') options.help = true
    else throw new UpdateError('bad-argument', 'unknown argument: ' + argument)
  }
  return options
}

/** Run the requested action and print its result. */
async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (options.help) {
    process.stdout.write([
      'Update the dsh-usd-3d-preview local checkout.',
      '',
      'Usage: node scripts/update-local.mjs [--status | --check | --update] [options]',
      '',
      '  --status          read-only local status (branch, commit, dirty, upstream)',
      '  --check           fetch the upstream and report ahead/behind',
      '  --update          fast-forward, install deps if needed, rebuild (default)',
      '  --branch <name>   check out this branch first (for trying a PR branch)',
      '  --restart         restart the host service when lib/index.js changed',
      '  --json            print one JSON result instead of text',
      '  --root <path>     update this checkout instead of the script repository',
      '',
    ].join('\n'))
    return 0
  }
  const root = options.root === undefined ? defaultRepoRoot() : options.root
  const service = createUpdateService({ root })
  const result = options.action === 'status'
    ? await service.status()
    : options.action === 'check'
      ? await service.check()
      : await service.update({ branch: options.branch, restart: options.restart })
  if (options.json) {
    process.stdout.write(JSON.stringify(result) + '\n')
  } else if (options.action === 'update') {
    printUpdate(result)
  } else {
    printStatus(result, { checked: options.action === 'check' })
  }
  return 0
}

try {
  const code = await main()
  process.exitCode = code
} catch (error) {
  if (process.argv.includes('--json')) {
    const failure = error instanceof UpdateError
      ? { ok: false, error: error.code, message: error.message, log: error.log ?? [] }
      : { ok: false, error: 'update-failed', message: String(error?.message ?? error), log: [] }
    process.stdout.write(JSON.stringify(failure) + '\n')
  } else if (error instanceof UpdateError) {
    process.stderr.write('update failed: ' + error.message + ' (' + error.code + ')\n')
    for (const line of error.log ?? []) process.stderr.write('  ' + line + '\n')
  } else {
    process.stderr.write('update failed: ' + String(error?.stack ?? error) + '\n')
  }
  process.exitCode = 1
}
