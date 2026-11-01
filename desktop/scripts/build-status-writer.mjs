// Builds native/status-writer (GH #397) into resources/status-writer/<arch>/orcha-status-writer,
// one thin binary per electron-builder arch. electron-builder copies the one for the arch it
// is packing into Contents/MacOS (extraFiles), and the universal build lipos the two.
//
//   node scripts/build-status-writer.mjs           # build arm64 + x64
//   node scripts/build-status-writer.mjs --dry-run # print the swiftc commands, touch nothing
//
// Output is gitignored. Needs the Xcode command-line tools (swiftc).
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const desktopRoot = path.resolve(here, '..')
export const SOURCE = path.join(desktopRoot, 'native', 'status-writer', 'main.swift')
export const OUT_DIR = path.join(desktopRoot, 'resources', 'status-writer')
export const BINARY = 'orcha-status-writer'
// electron-builder arch name -> swift target triple (Electron 44 needs macOS 12+).
export const TARGETS = { arm64: 'arm64-apple-macos12.0', x64: 'x86_64-apple-macos12.0' }

export function swiftcCommands() {
  return Object.entries(TARGETS).map(([arch, target]) => ({
    arch,
    out: path.join(OUT_DIR, arch, BINARY),
    args: ['-O', '-target', target, '-framework', 'Security', SOURCE, '-o', path.join(OUT_DIR, arch, BINARY)]
  }))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const cmds = swiftcCommands()
  if (process.argv.includes('--dry-run')) {
    console.log(JSON.stringify(cmds, null, 2))
  } else {
    for (const c of cmds) {
      mkdirSync(path.dirname(c.out), { recursive: true })
      execFileSync('/usr/bin/xcrun', ['swiftc', ...c.args], { stdio: 'inherit' })
      console.log(`[status-writer] built ${path.relative(desktopRoot, c.out)}`)
    }
  }
}
