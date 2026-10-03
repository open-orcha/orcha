import { useCallback, useEffect, useState } from 'react'
import { Box, Database, Loader2, Network, Package, RefreshCw } from 'lucide-react'
import { Button } from '../ui/Button'
import ErrorNotice from '../components/ErrorNotice'
import AgentWorktreesStorage from './AgentWorktreesStorage'
import { formatBytes } from '../host/removeProject'
import type { StorageItem, StorageItemKind, StorageReport } from '../../../shared/types'

const GROUPS: Array<{ kind: StorageItemKind; label: string; Icon: typeof Box }> = [
  { kind: 'image', label: 'Portal images', Icon: Package },
  { kind: 'container', label: 'Finished agent sandboxes', Icon: Box },
  { kind: 'network', label: 'Networks', Icon: Network },
  { kind: 'volume', label: 'Project data', Icon: Database }
]

const itemKey = (i: StorageItem): string => `${i.kind}:${i.name}`

/** Sum of the sizes docker reported (null when none were). */
export function totalSize(items: readonly StorageItem[]): number | null {
  return items.reduce<number | null>((t, i) => (i.size === null ? t : (t ?? 0) + i.size), null)
}

/** Settings › Storage — "Clean up unused Embodent data": leftovers of projects that no longer
 *  have a stack (portal images, finished sandboxes, networks, data volumes) with sizes, a
 *  Remove per item and "Remove all". Project data is never part of "Remove all": each volume
 *  needs its own explicit confirmation. */
export default function StorageSettings() {
  const api = window.orchaDesktop
  const [report, setReport] = useState<StorageReport | null>(null)
  const [scanError, setScanError] = useState<unknown>(null)
  const [scanning, setScanning] = useState(false)
  const [working, setWorking] = useState<Set<string>>(new Set())
  const [failed, setFailed] = useState<Record<string, unknown>>({})
  const [confirming, setConfirming] = useState<string | null>(null)
  const [bulk, setBulk] = useState(false)

  const scan = useCallback(async () => {
    if (!api.storageScan) return
    setScanning(true)
    setScanError(null)
    try {
      setReport(await api.storageScan())
    } catch (err) {
      setScanError(err)
    } finally {
      setScanning(false)
    }
  }, [api])
  useEffect(() => {
    void scan()
  }, [scan])

  const removeOne = async (item: StorageItem): Promise<boolean> => {
    if (!api.storageRemove) return false
    const key = itemKey(item)
    setWorking((w) => new Set(w).add(key))
    setFailed((f) => ({ ...f, [key]: undefined }))
    try {
      await api.storageRemove({ kind: item.kind, name: item.name, ...(item.kind === 'volume' ? { confirm: item.name } : {}) })
      return true
    } catch (err) {
      setFailed((f) => ({ ...f, [key]: err }))
      return false
    } finally {
      setWorking((w) => {
        const n = new Set(w)
        n.delete(key)
        return n
      })
    }
  }

  const items = report?.items ?? []
  const bulkItems = items.filter((i) => i.kind !== 'volume')
  const bulkSize = formatBytes(totalSize(bulkItems))

  return (
    <section data-testid="settings-storage">
      <h2 className="text-[24px] font-semibold tracking-[-0.01em] text-text">Storage</h2>
      <p className="mb-6 mt-1 text-[13px] text-text-3">
        Clean up unused Embodent data: what projects that are no longer in Embodent left behind in Docker. Projects you
        still have are never listed.
      </p>

      <AgentWorktreesStorage />

      <div className="mb-4 flex items-center gap-2">
        <Button
          variant="secondary"
          disabled={bulk || scanning || bulkItems.length === 0}
          data-testid="storage-remove-all"
          onClick={async () => {
            setBulk(true)
            for (const i of bulkItems) await removeOne(i)
            setBulk(false)
            await scan()
          }}
        >
          {bulk ? 'Removing…' : `Remove all${bulkSize ? ` · ${bulkSize}` : ''}`}
        </Button>
        <Button variant="ghost" onClick={() => void scan()} disabled={scanning || bulk} aria-label="Scan again">
          <RefreshCw className={scanning ? 'animate-spin' : ''} /> Scan again
        </Button>
        {items.some((i) => i.kind === 'volume') && (
          <span className="text-[12px] text-text-3">Project data is never removed by “Remove all”.</span>
        )}
      </div>

      {scanError != null && (
        <div className="mb-4 rounded-md border border-border px-3 py-2">
          <ErrorNotice error={scanError} prefix="Couldn’t check Docker" wrap />
        </div>
      )}
      {!report && scanning && (
        <p className="flex items-center gap-2 text-[13px] text-text-3" role="status">
          <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Looking for leftovers…
        </p>
      )}
      {report && items.length === 0 && (
        <p className="rounded-[10px] border border-border px-4 py-6 text-center text-[13px] text-text-3" data-testid="storage-empty">
          Nothing to clean up.
        </p>
      )}

      <div className="flex flex-col gap-6">
        {GROUPS.map(({ kind, label, Icon }) => {
          const group = items.filter((i) => i.kind === kind)
          if (group.length === 0) return null
          const size = formatBytes(totalSize(group))
          return (
            <div key={kind}>
              <div className="mb-1.5 flex items-center gap-2 text-[12px] font-medium text-text-3">
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                {label}
                {size && <span className="tabular-nums">· {size}</span>}
              </div>
              <ul className="divide-y divide-border rounded-[10px] border border-border" aria-label={label}>
                {group.map((item) => {
                  const key = itemKey(item)
                  const busy = working.has(key)
                  const itemSize = formatBytes(item.size)
                  return (
                    <li key={key} className="px-4 py-2.5" data-testid={`storage-item-${key}`}>
                      <div className="flex items-center gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-mono text-[12.5px] text-text">{item.name}</div>
                          <div className="text-[12px] text-text-3">{item.note}</div>
                        </div>
                        {itemSize && <span className="shrink-0 text-[12px] tabular-nums text-text-2">{itemSize}</span>}
                        {item.kind === 'volume' ? (
                          confirming !== key && (
                            <Button variant="outline" size="sm" disabled={busy || bulk} onClick={() => setConfirming(key)}>
                              Delete…
                            </Button>
                          )
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={busy || bulk}
                            onClick={async () => {
                              if (await removeOne(item)) await scan()
                            }}
                          >
                            {busy ? 'Removing…' : 'Remove'}
                          </Button>
                        )}
                      </div>
                      {confirming === key && (
                        <div className="mt-2 flex items-center gap-2 rounded-md border border-border bg-bg/40 px-3 py-2 text-[12.5px]" role="group" aria-label={`Confirm deleting ${item.name}`}>
                          <span className="min-w-0 flex-1 text-text-2">
                            Permanently delete this project’s tasks, agents and history?
                          </span>
                          <Button variant="ghost" size="sm" onClick={() => setConfirming(null)} disabled={busy}>
                            Cancel
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            disabled={busy}
                            onClick={async () => {
                              if (await removeOne(item)) {
                                setConfirming(null)
                                await scan()
                              }
                            }}
                          >
                            {busy ? 'Deleting…' : 'Delete data'}
                          </Button>
                        </div>
                      )}
                      {failed[key] != null && (
                        <ErrorNotice className="mt-1.5" error={failed[key]} prefix="Couldn’t remove" compact wrap />
                      )}
                    </li>
                  )
                })}
              </ul>
            </div>
          )
        })}
      </div>
    </section>
  )
}
