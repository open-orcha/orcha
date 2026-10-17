// GH #258 sidecar build script: the pinned interpreter, the launcher, the dry-run
// mode, and the npm hooks that keep the runtime out of the universal build.
import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { LAUNCHER, PYTHON_BUILDS, PYTHON_VERSION, RUNTIME_DIR, buildPlan } from './build-orcha-runtime.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktopRoot = path.resolve(here, '..')
const script = path.join(here, 'build-orcha-runtime.mjs')

describe('build-orcha-runtime pinning', () => {
  it('pins exactly one arm64 python-build-standalone install_only build by release + sha256', () => {
    expect(Object.keys(PYTHON_BUILDS)).toEqual(['arm64'])
    const { url, sha256 } = PYTHON_BUILDS.arm64
    expect(url).toMatch(
      /^https:\/\/github\.com\/astral-sh\/python-build-standalone\/releases\/download\/\d{8}\/cpython-3\.\d+\.\d+%2B\d{8}-aarch64-apple-darwin-install_only\.tar\.gz$/
    )
    expect(url).toContain(`cpython-${PYTHON_VERSION}.`)
    expect(sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses an arch with no pinned build instead of guessing', () => {
    expect(() => buildPlan('x64')).toThrow(/no pinned python-build-standalone build for arch 'x64'/)
  })

  it('--dry-run prints the plan and builds nothing', () => {
    const out = execFileSync(process.execPath, [script, '--dry-run'], { encoding: 'utf8' })
    const plan = JSON.parse(out)
    expect(plan).toEqual({ ...buildPlan('arm64') })
    expect(plan.dest).toBe(RUNTIME_DIR)
    expect(plan.dest).toBe(path.join(desktopRoot, 'resources', 'orcha-runtime'))
    expect(plan.cli).toBe(path.join(desktopRoot, '..', 'orcha-cli'))
  })
})

describe('bin/orcha launcher', () => {
  it('is the relocatable sh launcher from the plan', () => {
    expect(LAUNCHER).toBe(
      '#!/bin/sh\n' +
        'HERE="$(cd "$(dirname "$0")/.." && pwd)"\n' +
        'export PYTHONNOUSERSITE=1 PYTHONDONTWRITEBYTECODE=1 ORCHA_SIDECAR=1\n' +
        'exec "$HERE/bin/python3" -m orcha_cli "$@"\n'
    )
  })

  it('runs the python3 next to it with the sidecar env, wherever the runtime lives', () => {
    const root = path.join(mkdtempSync(path.join(os.tmpdir(), 'orcha rt ')), 'orcha-runtime')
    mkdirSync(path.join(root, 'bin'), { recursive: true })
    const fakePython = path.join(root, 'bin', 'python3')
    writeFileSync(
      fakePython,
      '#!/bin/sh\necho "$0|$*|$PYTHONNOUSERSITE$PYTHONDONTWRITEBYTECODE$ORCHA_SIDECAR"\n'
    )
    chmodSync(fakePython, 0o755)
    const launcher = path.join(root, 'bin', 'orcha')
    writeFileSync(launcher, LAUNCHER)
    chmodSync(launcher, 0o755)
    const out = execFileSync(launcher, ['--version', 'a b'], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin' }
    })
    expect(out.trim()).toBe(`${fakePython}|-m orcha_cli --version a b|111`)
  })
})

describe('packaging hooks', () => {
  const pkg = JSON.parse(readFileSync(path.join(desktopRoot, 'package.json'), 'utf8'))
  const builderYml = readFileSync(path.join(desktopRoot, 'electron-builder.yml'), 'utf8')

  it('builds the runtime for the arm64 dist and clears it for the universal dist', () => {
    expect(pkg.scripts['predist:mac:arm64']).toMatch(/node scripts\/build-orcha-runtime\.mjs$/)
    expect(pkg.scripts['predist:mac']).toMatch(/node scripts\/build-orcha-runtime\.mjs --clean$/)
  })

  it('ships the runtime at Contents/Resources/orcha-runtime', () => {
    expect(builderYml).toMatch(/- from: resources\/orcha-runtime\n\s+to: orcha-runtime\n/)
    expect(builderYml).toMatch(/hardenedRuntime: true/)
    expect(builderYml).toMatch(/notarize: true/)
  })
})
