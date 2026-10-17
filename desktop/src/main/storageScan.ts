/** Settings › Storage — "Clean up unused Embodent data".
 *
 *  Lists Embodent leftovers whose compose project no longer has ANY container (running or
 *  stopped): project portal images, data volumes, default networks, and stopped `orcha-run-*`
 *  sandbox containers. A resource is only a candidate when its name has Embodent's exact shape
 *  AND (for volumes/networks) its compose label names that same project — shared images
 *  (`postgres:16`, `orcha-test/stub-runner`), dangling `<none>` layers and other tools'
 *  resources are never listed. Removal re-validates against a fresh scan, so the renderer can
 *  only ever remove something the scan itself offered. Electron-free — storageScan.test.ts. */
import type { StorageItem, StorageItemKind, StorageReport } from '../shared/types'
import {
  IMAGES_FORMAT,
  LABELED_FORMAT,
  PS_FORMAT,
  SAFE_PROJECT,
  SANDBOX_NAME,
  parseContainers,
  parseDiskSizes,
  parseImages,
  parseLabeled,
  type ContainerInfo,
  type DiskSizes,
  type ImageInfo,
  type LabeledName
} from './projectCleanup'
import { dockerFailure } from './removeEngine'

const PORTAL_IMAGE = /^(orcha-[A-Za-z0-9][A-Za-z0-9_-]*)-portal$/
const DEFAULT_NET = /^(orcha-[A-Za-z0-9][A-Za-z0-9_-]*)_default$/
const STOPPED = new Set(['exited', 'created', 'dead'])

export interface KeptData {
  /** Folder of a project removed with "keep data" (from the app's kept-data ledger). */
  folder: string
  /** That folder still holds the project (re-adding it re-attaches the data). */
  present: boolean
}

export interface StorageInputs {
  containers: ContainerInfo[]
  images: ImageInfo[]
  volumes: LabeledName[]
  networks: LabeledName[]
  sizes: DiskSizes
  kept: Record<string, KeptData>
}

/** Pure: the leftovers, given docker's listings. */
export function findLeftovers(inp: StorageInputs): StorageReport {
  const inUse = new Set(inp.containers.map((c) => c.project).filter(Boolean))
  const items: StorageItem[] = []
  for (const img of inp.images) {
    if (img.repository.includes('/') || !img.tag || img.tag === '<none>') continue
    const m = PORTAL_IMAGE.exec(img.repository)
    if (!m || inUse.has(m[1])) continue
    const name = `${img.repository}:${img.tag}`
    items.push({
      kind: 'image',
      name,
      project: m[1],
      size: inp.sizes.images.get(name) ?? null,
      note: 'Portal image of a project that is no longer in Embodent. It is rebuilt if you add the project again.'
    })
  }
  for (const v of inp.volumes) {
    if (!SAFE_PROJECT.test(v.project) || !v.name.startsWith(`${v.project}_`) || inUse.has(v.project)) continue
    const kept = inp.kept[v.project]
    items.push({
      kind: 'volume',
      name: v.name,
      project: v.project,
      size: inp.sizes.volumes.get(v.name) ?? null,
      note:
        kept && kept.present
          ? `Data kept when this project was removed. Adding ${kept.folder} again brings it back. Deleting it is permanent.`
          : 'Project data (tasks, agents, history) with no project left. Deleting it is permanent.'
    })
  }
  for (const n of inp.networks) {
    const m = DEFAULT_NET.exec(n.name)
    if (!m || n.project !== m[1] || inUse.has(m[1])) continue
    items.push({ kind: 'network', name: n.name, project: m[1], size: null, note: 'Network of a project that is no longer in Embodent.' })
  }
  for (const c of inp.containers) {
    if (!SANDBOX_NAME.test(c.name) || c.managed !== '1' || !STOPPED.has(c.state)) continue
    const owner = c.networks.map((n) => DEFAULT_NET.exec(n)?.[1]).find((p): p is string => !!p) ?? null
    if (owner && inUse.has(owner)) continue
    items.push({
      kind: 'container',
      name: c.name,
      project: owner,
      size: null,
      note: owner ? 'Finished agent sandbox of a project that is no longer in Embodent.' : 'Finished agent sandbox whose project is gone.'
    })
  }
  return { items, inUse: [...inUse].filter((p) => p.startsWith('orcha-')).sort() }
}

export interface StorageDeps {
  docker(args: string[]): Promise<{ stdout: string }>
  kept(): Record<string, KeptData>
}

export async function scanStorage(deps: StorageDeps): Promise<StorageReport> {
  let ps: string, imgs: string, vols: string, nets: string
  try {
    ;[ps, imgs, vols, nets] = (
      await Promise.all([
        deps.docker(['ps', '-a', '--no-trunc', '--format', PS_FORMAT]),
        deps.docker(['images', '--format', IMAGES_FORMAT]),
        deps.docker(['volume', 'ls', '--format', LABELED_FORMAT]),
        deps.docker(['network', 'ls', '--format', LABELED_FORMAT])
      ])
    ).map((r) => r.stdout)
  } catch (err) {
    throw dockerFailure(err)
  }
  let sizes = parseDiskSizes('')
  try {
    sizes = parseDiskSizes((await deps.docker(['system', 'df', '-v', '--format', '{{json .}}'])).stdout)
  } catch {
    // sizes are optional
  }
  return findLeftovers({
    containers: parseContainers(ps),
    images: parseImages(imgs),
    volumes: parseLabeled(vols),
    networks: parseLabeled(nets),
    sizes,
    kept: deps.kept()
  })
}

/** The exact docker argv that removes one leftover (no -f anywhere: in-use things refuse). */
export function removalArgs(kind: StorageItemKind, name: string): string[] {
  if (kind === 'image') return ['image', 'rm', name]
  if (kind === 'volume') return ['volume', 'rm', name]
  if (kind === 'network') return ['network', 'rm', name]
  return ['rm', '-v', name] // a stopped sandbox, with its own anonymous volumes
}

/** Remove one leftover the CURRENT scan offers. A volume needs `confirm` equal to its name. */
export async function removeLeftover(
  raw: unknown,
  deps: StorageDeps
): Promise<{ kind: StorageItemKind; name: string; project: string | null }> {
  const r = (raw ?? {}) as { kind?: unknown; name?: unknown; confirm?: unknown }
  const kinds: StorageItemKind[] = ['image', 'volume', 'network', 'container']
  if (!kinds.includes(r.kind as StorageItemKind) || typeof r.name !== 'string') throw { code: 'INVALID_STORAGE_ITEM' } as const
  const kind = r.kind as StorageItemKind
  const report = await scanStorage(deps)
  const item = report.items.find((i) => i.kind === kind && i.name === r.name)
  if (!item) throw { code: 'INVALID_STORAGE_ITEM' } as const
  if (kind === 'volume' && r.confirm !== item.name) throw { code: 'INVALID_STORAGE_ITEM' } as const
  try {
    await deps.docker(removalArgs(kind, item.name))
  } catch (err) {
    throw dockerFailure(err)
  }
  return { kind, name: item.name, project: item.project }
}

