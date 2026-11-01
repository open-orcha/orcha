// Custom mac sign hook (electron-builder `mac.sign`, GH #397). Identical to
// electron-builder's own signing except for one file: Contents/MacOS/orcha-status-writer
// gets the MAIN app's entitlements (with the widget App Group) instead of
// entitlementsInherit, because it is the process that writes into the group container.
// Every other nested binary keeps the group-free inherit set.
const { execFileSync } = require('node:child_process')
const { existsSync } = require('node:fs')
const path = require('node:path')

const STATUS_WRITER = path.join('Contents', 'MacOS', 'orcha-status-writer')
const MAIN_ENTITLEMENTS = path.join(__dirname, '..', 'resources', 'entitlements.mac.plist')

function withStatusWriterEntitlements(optionsForFile) {
  return (filePath) => {
    const opts = optionsForFile ? optionsForFile(filePath) : {}
    return filePath.endsWith(path.sep + STATUS_WRITER) ? { ...opts, entitlements: MAIN_ENTITLEMENTS } : opts
  }
}

// osx-sign signs Contents/MacOS/<app> before Contents/MacOS/orcha-status-writer, and codesign
// refuses the main executable while a sibling in Contents/MacOS is unsigned. The universal
// merge leaves the helper's x64 slice unsigned, so give it a preliminary signature first.
// osx-sign replaces it with the real one (group entitlements, runtime, timestamp) later.
function presignStatusWriter(opts, run = execFileSync) {
  const helper = path.join(opts.app, STATUS_WRITER)
  if (!opts.identity || !existsSync(helper)) return false
  const args = ['--force', '--sign', opts.identity, '--timestamp=none']
  if (opts.keychain) args.push('--keychain', opts.keychain)
  run('/usr/bin/codesign', [...args, helper], { stdio: 'pipe' })
  return true
}

async function sign(opts) {
  const { sign: builderSign } = require('app-builder-lib/out/codeSign/macCodeSign')
  presignStatusWriter(opts)
  return builderSign({ ...opts, optionsForFile: withStatusWriterEntitlements(opts.optionsForFile) })
}

module.exports = sign
module.exports.default = sign
module.exports.withStatusWriterEntitlements = withStatusWriterEntitlements
module.exports.presignStatusWriter = presignStatusWriter
module.exports.MAIN_ENTITLEMENTS = MAIN_ENTITLEMENTS
