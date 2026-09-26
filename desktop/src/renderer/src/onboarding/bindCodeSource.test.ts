// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { bindCodeSource } from './bindCodeSource'

function stubOrchaDesktop(overrides: Partial<typeof window.orchaDesktop> = {}) {
  window.orchaDesktop = {
    portalGet: vi.fn(),
    portalPut: vi.fn(),
    ...overrides
  } as never
}

describe('bindCodeSource', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('skips (returns false) without calling anything when the folder is not a git repo', async () => {
    const portalGet = vi.fn()
    const portalPut = vi.fn()
    stubOrchaDesktop({ portalGet, portalPut })

    const result = await bindCodeSource(8001, false)

    expect(result).toBe(false)
    expect(portalGet).not.toHaveBeenCalled()
    expect(portalPut).not.toHaveBeenCalled()
  })

  it('resolves cid + human agent id, then PUTs {repo:"local", actor_agent_id} on the github route', async () => {
    const portalGet = vi
      .fn()
      .mockResolvedValueOnce({ containers: [{ id: 'c1' }] }) // resolveContainerId
      .mockResolvedValueOnce({ agents: [{ id: 'h1', kind: 'human' }] }) // resolveHumanAgentId
    const portalPut = vi.fn().mockResolvedValue({ ok: true })
    stubOrchaDesktop({ portalGet, portalPut })

    const result = await bindCodeSource(8001, true)

    expect(result).toBe(true)
    expect(portalPut).toHaveBeenCalledWith(8001, '/api/containers/c1/github', {
      repo: 'local',
      actor_agent_id: 'h1'
    })
  })

  it('silently skips (returns false) when the container cannot be resolved', async () => {
    const portalGet = vi.fn().mockResolvedValueOnce({ containers: [] })
    const portalPut = vi.fn()
    stubOrchaDesktop({ portalGet, portalPut })

    const result = await bindCodeSource(8001, true)

    expect(result).toBe(false)
    expect(portalPut).not.toHaveBeenCalled()
  })

  it('silently skips (returns false, never throws) on a non-200 PUT — e.g. open-portal stacks rejecting "local"', async () => {
    const portalGet = vi
      .fn()
      .mockResolvedValueOnce({ containers: [{ id: 'c1' }] })
      .mockResolvedValueOnce({ agents: [{ id: 'h1', kind: 'human' }] })
    const portalPut = vi.fn().mockRejectedValue({ code: 'PORTAL_REQUEST_FAILED', status: 404 })
    stubOrchaDesktop({ portalGet, portalPut })

    await expect(bindCodeSource(8001, true)).resolves.toBe(false)
  })

  it('still binds when no human agent is registered yet (actor_agent_id null)', async () => {
    const portalGet = vi
      .fn()
      .mockResolvedValueOnce({ containers: [{ id: 'c1' }] })
      .mockResolvedValueOnce({ agents: [] })
    const portalPut = vi.fn().mockResolvedValue({ ok: true })
    stubOrchaDesktop({ portalGet, portalPut })

    const result = await bindCodeSource(8001, true)

    expect(result).toBe(true)
    expect(portalPut).toHaveBeenCalledWith(8001, '/api/containers/c1/github', {
      repo: 'local',
      actor_agent_id: null
    })
  })
})
