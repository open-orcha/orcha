import { describe, it, expect, vi } from 'vitest'
import { parsePublishedPorts, pickFreePort } from './portPicker'

describe('parsePublishedPorts', () => {
  it('extracts host ports from docker ps Ports column (0.0.0.0 and 127.0.0.1 binds)', () => {
    const stdout = [
      '0.0.0.0:8113->8103/tcp',
      '127.0.0.1:3300->3000/tcp',
      '0.0.0.0:5433->5432/tcp'
    ].join('\n')
    const ports = parsePublishedPorts(stdout)
    expect(ports.has(8113)).toBe(true)
    expect(ports.has(3300)).toBe(true)
    expect(ports.has(5433)).toBe(true)
  })

  it('expands host port ranges (e.g. 4317-4318)', () => {
    const ports = parsePublishedPorts('127.0.0.1:4317-4318->4317-4318/tcp')
    expect(ports.has(4317)).toBe(true)
    expect(ports.has(4318)).toBe(true)
  })

  it('ignores container-only ports with no host publish (e.g. 1025/tcp)', () => {
    const ports = parsePublishedPorts('1025/tcp, 1110/tcp')
    expect(ports.size).toBe(0)
  })

  it('handles the :::/[::] IPv6 wildcard form', () => {
    const ports = parsePublishedPorts(':::8001->8000/tcp')
    expect(ports.has(8001)).toBe(true)
  })
})

describe('pickFreePort', () => {
  const occupiedByDocker = new Set([5433])

  it('skips a port that is free on the host TCP stack but published by docker', async () => {
    // host probe says everything is free; docker occupies 5433 → must pick 5434.
    const probe = vi.fn().mockResolvedValue(true)
    const port = await pickFreePort(5432, { dockerPorts: occupiedByDocker, probe })
    // 5432 free (probe true, not in docker set) → picks 5432 first actually.
    expect(port).toBe(5432)
  })

  it('skips the docker-occupied port when the scan reaches it', async () => {
    const probe = vi.fn().mockResolvedValue(true)
    const port = await pickFreePort(5433, { dockerPorts: occupiedByDocker, probe })
    expect(port).toBe(5434) // 5433 excluded by docker set
  })

  it('skips a port the host probe reports busy', async () => {
    // 8000 busy on host, 8001 free, docker set empty
    const probe = vi.fn().mockImplementation((p: number) => Promise.resolve(p !== 8000))
    const port = await pickFreePort(8000, { dockerPorts: new Set(), probe })
    expect(port).toBe(8001)
  })

  it('rejects PORT_UNAVAILABLE when the whole span is taken', async () => {
    const probe = vi.fn().mockResolvedValue(false)
    await expect(pickFreePort(9000, { dockerPorts: new Set(), probe, span: 3 })).rejects.toMatchObject({
      code: 'PORT_UNAVAILABLE'
    })
  })
})
