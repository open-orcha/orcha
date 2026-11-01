// Custom mac sign hook (electron-builder `mac.sign`, GH #397). Identical to
// electron-builder's own signing except for one file: Contents/MacOS/orcha-status-writer
// gets the MAIN app's entitlements (with the widget App Group) instead of
// entitlementsInherit, because it is the process that writes into the group container.
// Every other nested binary keeps the group-free inherit set.
const path = require('node:path')

const STATUS_WRITER = path.join('Contents', 'MacOS', 'orcha-status-writer')
const MAIN_ENTITLEMENTS = path.join(__dirname, '..', 'resources', 'entitlements.mac.plist')

function withStatusWriterEntitlements(optionsForFile) {
  return (filePath) => {
    const opts = optionsForFile ? optionsForFile(filePath) : {}
    return filePath.endsWith(path.sep + STATUS_WRITER) ? { ...opts, entitlements: MAIN_ENTITLEMENTS } : opts
  }
}

async function sign(opts) {
  const { sign: builderSign } = require('app-builder-lib/out/codeSign/macCodeSign')
  return builderSign({ ...opts, optionsForFile: withStatusWriterEntitlements(opts.optionsForFile) })
}

module.exports = sign
module.exports.default = sign
module.exports.withStatusWriterEntitlements = withStatusWriterEntitlements
module.exports.MAIN_ENTITLEMENTS = MAIN_ENTITLEMENTS
