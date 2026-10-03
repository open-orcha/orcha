import { describe, it, expect, vi } from 'vitest'
import { findLeftovers, removalArgs, removeLeftover, scanStorage, type StorageDeps } from './storageScan'
import { parseContainers, parseDiskSizes, parseImages, parseLabeled } from './projectCleanup'

// Live stacks: orcha-acme-web (running) and orcha-helpdesk (stopped — still has containers).
// Gone: orcha-acme (shares a prefix with orcha-acme-web!) and orcha-ehr.
const PS = [
  'orcha-acme-web-portal-1\trunning\torcha-acme-web\t\t\torcha-acme-web_default',
  'orcha-helpdesk-db-1\texited\torcha-helpdesk\t\t\torcha-helpdesk_default',
  'orcha-run-aaaaaaaaaaaa\texited\t\t1\tcid-x\torcha-acme_default',
  'orcha-run-bbbbbbbbbbbb\texited\t\t1\tcid-y\torcha-acme-web_default',
  'orcha-run-cccccccccccc\trunning\t\t1\tcid-z\torcha-acme_default',
  'orcha-run-dddddddddddd\texited\t\t1\t\t',
  'orcha-run-eeeeeeeeeeee\texited\t\t\t\torcha-acme_default',
  'supabase_db_x\trunning\tfleet\t\t\tsupabase_network'
].join('\n')
const IMAGES = [
  'orcha-acme-portal\tlatest\ti1',
  'orcha-acme-web-portal\tlatest\ti2',
  'orcha-helpdesk-portal\tlatest\ti3',
  'orcha-ehr-portal\tlatest\ti4',
  'postgres\t16\ti5',
  'orcha-test/stub-runner\tlatest\ti6',
  '<none>\t<none>\ti7'
].join('\n')
const VOLUMES = [
  'orcha-acme_pgdata\torcha-acme',
  'orcha-acme-web_pgdata\torcha-acme-web',
  'orcha-ehr_pgdata\torcha-ehr',
  'orcha-fake_pgdata\t',
  'quantal-preview_pgdata\tquantal-preview',
  'supabase_db_x\tfleet'
].join('\n')
const NETWORKS = ['bridge\t', 'orcha-acme_default\torcha-acme', 'orcha-acme-web_default\torcha-acme-web', 'orcha-ehr_default\torcha-other'].join('\n')
const DF = JSON.stringify({
  Images: [{ Repository: 'orcha-acme-portal', Tag: 'latest', UniqueSize: '11.3MB', Size: '341MB' }],
  Volumes: [{ Name: 'orcha-acme_pgdata', Size: '66.8MB' }]
})

function fakeDocker() {
  const calls: string[][] = []
  const docker = vi.fn(async (args: string[]) => {
    calls.push(args)
    if (args[0] === 'ps') return { stdout: PS }
    if (args[0] === 'images') return { stdout: IMAGES }
    if (args[0] === 'volume' && args[1] === 'ls') return { stdout: VOLUMES }
    if (args[0] === 'network' && args[1] === 'ls') return { stdout: NETWORKS }
    if (args[0] === 'system') return { stdout: DF }
    return { stdout: '' }
  })
  return { docker, calls }
}

const inputs = (kept = {}) => ({
  containers: parseContainers(PS),
  images: parseImages(IMAGES),
  volumes: parseLabeled(VOLUMES),
  networks: parseLabeled(NETWORKS),
  sizes: parseDiskSizes(DF),
  kept
})

describe('findLeftovers', () => {
  const r = findLeftovers(inputs())
  const names = (kind: string) => r.items.filter((i) => i.kind === kind).map((i) => i.name)

  it('lists portal images of gone projects only — never a live (or stopped) stack’s, never shared images', () => {
    expect(names('image')).toEqual(['orcha-acme-portal:latest', 'orcha-ehr-portal:latest'])
  })

  it('volumes need the exact orcha project label AND the <project>_ name', () => {
    expect(names('volume')).toEqual(['orcha-acme_pgdata', 'orcha-ehr_pgdata'])
  })

  it('networks need name = <label project>_default', () => {
    expect(names('network')).toEqual(['orcha-acme_default'])
  })

  it('stopped sandboxes of gone projects (or of no known project); never running ones or a live project’s', () => {
    expect(names('container')).toEqual(['orcha-run-aaaaaaaaaaaa', 'orcha-run-dddddddddddd'])
  })

  it('reports sizes docker gave and the projects in use', () => {
    expect(r.items.find((i) => i.name === 'orcha-acme-portal:latest')?.size).toBe(11_300_000)
    expect(r.items.find((i) => i.name === 'orcha-acme_pgdata')?.size).toBe(66_800_000)
    expect(r.inUse).toEqual(['orcha-acme-web', 'orcha-helpdesk'])
  })

  it('a volume kept by "Remove from Embodent" says how to bring it back', () => {
    const k = findLeftovers(inputs({ 'orcha-acme': { folder: '/Users/me/acme', present: true } }))
    expect(k.items.find((i) => i.name === 'orcha-acme_pgdata')?.note).toMatch(/Adding \/Users\/me\/acme again brings it back/)
  })
})

describe('removeLeftover', () => {
  const deps = (): StorageDeps & { calls: string[][] } => {
    const d = fakeDocker()
    return { docker: d.docker, kept: () => ({}), calls: d.calls }
  }
  const removals = (calls: string[][]) => calls.filter((c) => c.includes('rm'))

  it('removes an offered image with `image rm` (no -f)', async () => {
    const d = deps()
    await removeLeftover({ kind: 'image', name: 'orcha-acme-portal:latest' }, d)
    expect(removals(d.calls)).toEqual([['image', 'rm', 'orcha-acme-portal:latest']])
  })

  it('refuses anything the current scan does not offer (a live project’s image, shared images)', async () => {
    for (const name of ['orcha-acme-web-portal:latest', 'postgres:16', 'orcha-test/stub-runner:latest']) {
      const d = deps()
      await expect(removeLeftover({ kind: 'image', name }, d)).rejects.toEqual({ code: 'INVALID_STORAGE_ITEM' })
      expect(removals(d.calls)).toEqual([])
    }
  })

  it('a volume needs confirm = its exact name', async () => {
    const d = deps()
    await expect(removeLeftover({ kind: 'volume', name: 'orcha-acme_pgdata' }, d)).rejects.toEqual({ code: 'INVALID_STORAGE_ITEM' })
    await expect(removeLeftover({ kind: 'volume', name: 'orcha-acme_pgdata', confirm: 'orcha-acme' }, d)).rejects.toEqual({ code: 'INVALID_STORAGE_ITEM' })
    expect(removals(d.calls)).toEqual([])
    await removeLeftover({ kind: 'volume', name: 'orcha-acme_pgdata', confirm: 'orcha-acme_pgdata' }, d)
    expect(removals(d.calls)).toEqual([['volume', 'rm', 'orcha-acme_pgdata']])
  })

  it('rejects malformed requests', async () => {
    await expect(removeLeftover({ kind: 'everything', name: '*' }, deps())).rejects.toEqual({ code: 'INVALID_STORAGE_ITEM' })
    await expect(removeLeftover(null, deps())).rejects.toEqual({ code: 'INVALID_STORAGE_ITEM' })
  })

  it('argv per kind', () => {
    expect(removalArgs('container', 'orcha-run-aaaaaaaaaaaa')).toEqual(['rm', '-v', 'orcha-run-aaaaaaaaaaaa'])
    expect(removalArgs('network', 'orcha-acme_default')).toEqual(['network', 'rm', 'orcha-acme_default'])
  })

  it('scan: Docker down → DOCKER_UNAVAILABLE', async () => {
    const docker = vi.fn().mockRejectedValue({ stderr: 'Cannot connect to the Docker daemon' })
    await expect(scanStorage({ docker, kept: () => ({}) })).rejects.toEqual({ code: 'DOCKER_UNAVAILABLE' })
  })
})
