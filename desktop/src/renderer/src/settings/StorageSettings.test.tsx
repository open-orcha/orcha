// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import StorageSettings, { totalSize } from './StorageSettings'
import type { StorageReport } from '../../../shared/types'

const REPORT: StorageReport = {
  inUse: ['orcha-acme-web'],
  items: [
    { kind: 'image', name: 'orcha-ehr-portal:latest', project: 'orcha-ehr', size: 14_600_000, note: 'Portal image of a project that is no longer in Embodent.' },
    { kind: 'image', name: 'orcha-demo-portal:latest', project: 'orcha-demo', size: 11_300_000, note: 'Portal image of a project that is no longer in Embodent.' },
    { kind: 'network', name: 'orcha-ehr_default', project: 'orcha-ehr', size: null, note: 'Network of a project that is no longer in Embodent.' },
    { kind: 'volume', name: 'orcha-ehr_pgdata', project: 'orcha-ehr', size: 67_590_000, note: 'Project data with no project left. Deleting it is permanent.' }
  ]
}

let api: { storageScan: ReturnType<typeof vi.fn>; storageRemove: ReturnType<typeof vi.fn> }
beforeEach(() => {
  api = { storageScan: vi.fn().mockResolvedValue(REPORT), storageRemove: vi.fn().mockResolvedValue(undefined) }
  window.orchaDesktop = api as unknown as typeof window.orchaDesktop
})

describe('Settings › Storage', () => {
  it('lists leftovers by kind with sizes', async () => {
    render(<StorageSettings />)
    expect(await screen.findByText('orcha-ehr-portal:latest')).toBeInTheDocument()
    expect(screen.getByRole('list', { name: 'Portal images' })).toHaveTextContent('14.6 MB')
    expect(screen.getByRole('list', { name: 'Project data' })).toHaveTextContent('67.6 MB')
    expect(screen.getByRole('list', { name: 'Networks' })).toHaveTextContent('orcha-ehr_default')
  })

  it('Remove on one item removes exactly it, then rescans', async () => {
    render(<StorageSettings />)
    const row = await screen.findByTestId('storage-item-image:orcha-demo-portal:latest')
    await userEvent.click(within(row).getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(api.storageRemove).toHaveBeenCalledWith({ kind: 'image', name: 'orcha-demo-portal:latest' }))
    await waitFor(() => expect(api.storageScan).toHaveBeenCalledTimes(2))
  })

  it('"Remove all" never includes project data (volumes)', async () => {
    render(<StorageSettings />)
    const all = await screen.findByTestId('storage-remove-all')
    expect(all).toHaveTextContent('Remove all · 25.9 MB')
    await userEvent.click(all)
    await waitFor(() => expect(api.storageRemove).toHaveBeenCalledTimes(3))
    expect(api.storageRemove.mock.calls.map((c) => c[0].kind)).toEqual(['image', 'image', 'network'])
    expect(screen.getByText('Project data is never removed by “Remove all”.')).toBeInTheDocument()
  })

  it('a volume needs its own explicit confirm, sent with its exact name', async () => {
    render(<StorageSettings />)
    const row = await screen.findByTestId('storage-item-volume:orcha-ehr_pgdata')
    await userEvent.click(within(row).getByRole('button', { name: 'Delete…' }))
    expect(api.storageRemove).not.toHaveBeenCalled()
    const confirm = within(row).getByRole('group', { name: 'Confirm deleting orcha-ehr_pgdata' })
    await userEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }))
    expect(api.storageRemove).not.toHaveBeenCalled()
    await userEvent.click(within(row).getByRole('button', { name: 'Delete…' }))
    await userEvent.click(within(row).getByRole('button', { name: 'Delete data' }))
    await waitFor(() =>
      expect(api.storageRemove).toHaveBeenCalledWith({ kind: 'volume', name: 'orcha-ehr_pgdata', confirm: 'orcha-ehr_pgdata' })
    )
  })

  it('a failed removal says why under that item', async () => {
    api.storageRemove.mockRejectedValue({ code: 'COMPOSE_FAILED', stderr: 'Error response from daemon: conflict: unable to remove repository reference (must force) - container abc is using its referenced image' })
    render(<StorageSettings />)
    const row = await screen.findByTestId('storage-item-image:orcha-demo-portal:latest')
    await userEvent.click(within(row).getByRole('button', { name: 'Remove' }))
    expect(await within(row).findByText(/Couldn’t remove/)).toBeInTheDocument()
  })

  it('Docker down: plain words; nothing to clean shows an empty state', async () => {
    api.storageScan.mockRejectedValueOnce({ code: 'DOCKER_UNAVAILABLE' }).mockResolvedValueOnce({ items: [], inUse: [] })
    render(<StorageSettings />)
    expect(await screen.findByText(/Couldn’t check Docker: Docker isn’t running/)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Scan again' }))
    expect(await screen.findByTestId('storage-empty')).toHaveTextContent('Nothing to clean up.')
  })

  it('totalSize ignores unknown sizes', () => {
    expect(totalSize(REPORT.items)).toBe(14_600_000 + 11_300_000 + 67_590_000)
    expect(totalSize([REPORT.items[2]])).toBeNull()
  })
})
