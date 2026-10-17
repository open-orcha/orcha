import { describe, it, expect, vi } from 'vitest'
import { classifyVerdiktLink, openVerdiktLink, VERDIKT_BUNDLE_ID } from './verdiktLinks'

const O = 'http://localhost:8610'

describe('classifyVerdiktLink', () => {
  it('recognises the portal hand-off routes', () => {
    expect(classifyVerdiktLink(`${O}/api/tasks/t1/verdikt/open`, O)).toBe('open')
    expect(classifyVerdiktLink(`${O}/api/tasks/t1/verdikt/open?run=r9`, O)).toBe('open')
    expect(classifyVerdiktLink(`${O}/api/containers/c1/verdikt/open`, O)).toBe('open')
    expect(classifyVerdiktLink(`${O}/api/tasks/t1/verdikt/runs/r1/report`, O)).toBe('report')
    expect(classifyVerdiktLink(`${O}/api/tasks/t1/verdikt/runs/r1/preview`, O)).toBe('preview')
  })

  it('leaves everything else alone (in-view pages, inline artifacts, other origins, junk)', () => {
    expect(classifyVerdiktLink(`${O}/tasks?task=t1`, O)).toBeNull()
    expect(classifyVerdiktLink(`${O}/api/tasks/t1/verdikt/runs/r1/artifact?path=a.png`, O)).toBeNull()
    expect(classifyVerdiktLink(`${O}/api/tasks/t1/verdikt/runs/r1/preview/log`, O)).toBeNull()
    expect(classifyVerdiktLink(`http://localhost:9999/api/tasks/t1/verdikt/open`, O)).toBeNull()
    expect(classifyVerdiktLink('not a url', O)).toBeNull()
  })
})

describe('openVerdiktLink', () => {
  const url = `${O}/api/tasks/t1/verdikt/open?run=r1`
  const deps = (installed: boolean, platform: NodeJS.Platform = 'darwin') => ({
    openExternal: vi.fn().mockResolvedValue(undefined),
    launchApp: vi.fn().mockResolvedValue(installed),
    platform
  })

  it('"Open in Verdikt" launches the installed Verdikt app and does not open a browser', async () => {
    const d = deps(true)
    await expect(openVerdiktLink('open', url, d)).resolves.toBe('app')
    expect(d.launchApp).toHaveBeenCalledWith(VERDIKT_BUNDLE_ID)
    expect(d.openExternal).not.toHaveBeenCalled()
  })

  it('falls back to the default browser when the app is not installed', async () => {
    const d = deps(false)
    await expect(openVerdiktLink('open', url, d)).resolves.toBe('browser')
    expect(d.openExternal).toHaveBeenCalledWith(url)
  })

  it('reports and previews always go to the browser (exact pages the app cannot open)', async () => {
    for (const kind of ['report', 'preview'] as const) {
      const d = deps(true)
      await expect(openVerdiktLink(kind, url, d)).resolves.toBe('browser')
      expect(d.launchApp).not.toHaveBeenCalled()
    }
  })

  it('off macOS there is no app to launch: browser', async () => {
    const d = deps(true, 'linux')
    await expect(openVerdiktLink('open', url, d)).resolves.toBe('browser')
    expect(d.launchApp).not.toHaveBeenCalled()
  })
})
