// Builds the bundled Orcha runtime ("sidecar") that ships inside the app at
// Contents/Resources/orcha-runtime (GH #258, plan D3 / PR 16): a relocatable
// python-build-standalone interpreter + the orcha CLI and its dependencies, plus a
// bin/orcha launcher. The app does not use it yet — this build exists to prove the
// ~100 nested Mach-O files sign and notarize (plan risk R10).
//
//   node scripts/build-orcha-runtime.mjs            # build for arm64 (the only target so far)
//   node scripts/build-orcha-runtime.mjs --dry-run  # print the pinned plan as JSON, touch nothing
//   node scripts/build-orcha-runtime.mjs --clean    # remove resources/orcha-runtime
//
// Output (gitignored): desktop/resources/orcha-runtime/. Intel is deliberately absent
// (arm64 first, Q-D); add an entry to PYTHON_BUILDS when that is decided.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktopRoot = path.resolve(here, '..')
const repoRoot = path.resolve(desktopRoot, '..')
export const RUNTIME_DIR = path.join(desktopRoot, 'resources', 'orcha-runtime')
const CLI_DIR = path.join(repoRoot, 'orcha-cli')

// Pinned interpreter: python-build-standalone release 20261003, CPython 3.12.15,
// install_only flavour. Bump the URL and the sha256 together (the sha256 is the one
// the release's SHA256SUMS lists for this file).
export const PYTHON_VERSION = '3.12'
export const PYTHON_BUILDS = {
  arm64: {
    url:
      'https://github.com/astral-sh/python-build-standalone/releases/download/20261003/' +
      'cpython-3.12.15%2B20261003-aarch64-apple-darwin-install_only.tar.gz',
    sha256: '316a463172740e71d8dca1f2730784e325f3f720941137b5d674d5801a632213'
  }
}

// The launcher the app (and a user's ~/.local/bin/orcha link, later) execs. It finds
// the interpreter relative to itself, so the runtime works wherever the app lives.
export const LAUNCHER = `#!/bin/sh
HERE="$(cd "$(dirname "$0")/.." && pwd)"
export PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1 ORCHA_SIDECAR=1
exec "$HERE/bin/python3" -m orcha_cli "$@"
`

// Standard-library parts the runtime never uses. tkinter also drags in the Tcl/Tk
// dylibs, which would only add Mach-O files to sign.
const STDLIB_STRIP = ['test', 'tkinter', 'idlelib', 'ensurepip', 'turtledemo', 'turtle.py']
// Console scripts for the stripped modules.
const BIN_STRIP = ['idle3', `idle${PYTHON_VERSION}`, 'pip', 'pip3', `pip${PYTHON_VERSION}`]
// pip (~12 MB) only installs the CLI at build time; nothing in the app runs it, and the
// bundled `orcha update` defers to an app update. psycopg_binary stays: `orcha
// migrate-runtime` (Move this project off Docker) reads the old Postgres with it.
const SITE_STRIP = /^pip(-.*\.dist-info)?$/

function parseArgs(argv) {
  const args = { arch: 'arm64', dryRun: false, clean: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--clean') args.clean = true
    else if (a === '--arch') args.arch = argv[++i]
    else throw new Error(`unknown argument: ${a}`)
  }
  return args
}

export function buildPlan(arch = 'arm64') {
  const build = PYTHON_BUILDS[arch]
  if (!build) throw new Error(`no pinned python-build-standalone build for arch '${arch}'`)
  return { arch, url: build.url, sha256: build.sha256, dest: RUNTIME_DIR, cli: CLI_DIR, launcher: LAUNCHER }
}

function log(msg) {
  console.log(`[build-orcha-runtime] ${msg}`)
}

async function sha256Of(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

async function download(url, sha256) {
  const cacheDir = path.join(os.tmpdir(), 'orcha-runtime-cache')
  await mkdir(cacheDir, { recursive: true })
  const file = path.join(cacheDir, decodeURIComponent(path.basename(new URL(url).pathname)))
  if (existsSync(file) && (await sha256Of(file)) === sha256) {
    log(`using cached ${file}`)
    return file
  }
  log(`downloading ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`)
  await writeFile(file, Buffer.from(await res.arrayBuffer()))
  const got = await sha256Of(file)
  if (got !== sha256) {
    await rm(file, { force: true })
    throw new Error(`sha256 mismatch for ${url}: expected ${sha256}, got ${got}`)
  }
  return file
}

function run(cmd, args) {
  execFileSync(cmd, args, { stdio: 'inherit' })
}

// pip writes console scripts (uvicorn, fastapi, orcha, …) with an absolute shebang to
// the build-time interpreter path; they would be broken inside the app. Drop them —
// bin/orcha is replaced by the relocatable launcher below.
function removeBuildPathScripts(binDir, buildRoot) {
  for (const name of readdirSync(binDir)) {
    const p = path.join(binDir, name)
    if (!statSync(p).isFile()) continue
    const head = readFileSync(p).subarray(0, 512).toString('latin1')
    if (head.startsWith('#!') && head.split('\n', 1)[0].includes(buildRoot)) {
      execFileSync('rm', ['-f', p])
    }
  }
}

async function build(plan) {
  if (!existsSync(path.join(plan.cli, 'pyproject.toml'))) {
    throw new Error(`orcha-cli not found at ${plan.cli}`)
  }
  const tarball = await download(plan.url, plan.sha256)
  const staging = await mkdtemp(path.join(os.tmpdir(), 'orcha-runtime-'))
  try {
    log(`unpacking into ${staging}`)
    run('tar', ['-xzf', tarball, '-C', staging])
    const root = path.join(staging, 'python')
    const py = path.join(root, 'bin', 'python3')
    log('installing orcha-cli and its dependencies')
    run(py, [
      '-m', 'pip', 'install', '--no-compile', '--disable-pip-version-check',
      '--no-warn-script-location', '--no-cache-dir', plan.cli
    ])
    const stdlib = path.join(root, 'lib', `python${PYTHON_VERSION}`)
    for (const name of STDLIB_STRIP) await rm(path.join(stdlib, name), { recursive: true, force: true })
    for (const name of readdirSync(path.join(stdlib, 'lib-dynload'))) {
      if (name.startsWith('_tkinter')) await rm(path.join(stdlib, 'lib-dynload', name), { force: true })
    }
    for (const name of readdirSync(path.join(root, 'lib'))) {
      if (/^(tcl|tk|itcl|thread)\d|^lib(tcl|tk)\d/.test(name)) {
        await rm(path.join(root, 'lib', name), { recursive: true, force: true })
      }
    }
    // unchecked-hash: the .pyc files stay valid however the bundle's mtimes change
    // (copying, signing), and the launcher forbids writing new ones into the app.
    log('byte-compiling site-packages')
    run(py, [
      '-m', 'compileall', '-q', '-j0', '--invalidation-mode', 'unchecked-hash',
      path.join(stdlib, 'site-packages')
    ])
    const binDir = path.join(root, 'bin')
    removeBuildPathScripts(binDir, staging)
    for (const name of BIN_STRIP) await rm(path.join(binDir, name), { force: true })
    const site = path.join(stdlib, 'site-packages')
    for (const name of readdirSync(site)) {
      if (SITE_STRIP.test(name)) await rm(path.join(site, name), { recursive: true, force: true })
    }
    const launcher = path.join(binDir, 'orcha')
    await writeFile(launcher, plan.launcher)
    await chmod(launcher, 0o755)
    await rm(plan.dest, { recursive: true, force: true })
    await mkdir(path.dirname(plan.dest), { recursive: true })
    run('mv', [root, plan.dest])
    log(`runtime ready at ${plan.dest}`)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2))
  if (args.clean) {
    await rm(RUNTIME_DIR, { recursive: true, force: true })
    log(`removed ${RUNTIME_DIR}`)
  } else if (args.dryRun) {
    console.log(JSON.stringify(buildPlan(args.arch), null, 2))
  } else {
    await build(buildPlan(args.arch))
  }
}
