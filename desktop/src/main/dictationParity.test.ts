/** The desktop's dictation core is a VERBATIM copy of the portal's (one engine, one HUD,
 *  one shortcut everywhere). Edit the portal's src/dictation and copy the file here. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DESKTOP = join(__dirname, '../renderer/src/dictation')
const PORTAL = join(__dirname, '../../../orcha-cli/orcha_cli/templates/portal/frontend/src/dictation')
const FILES = ['prefs.ts', 'target.ts', 'audio.ts', 'engines.ts', 'controller.ts', 'shortcut.ts', 'DictationHost.tsx', 'dictation.css']

describe('desktop dictation = portal dictation', () => {
  it.each(FILES)('%s is identical to the portal copy', (f) => {
    expect(readFileSync(join(DESKTOP, f), 'utf8')).toBe(readFileSync(join(PORTAL, f), 'utf8'))
  })
})
