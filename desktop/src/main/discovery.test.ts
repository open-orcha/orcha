import { describe, it, expect, vi } from 'vitest'
import { parseHostPort, parseDockerPs, listStacks } from './discovery'

// Real output shape from this machine (docker ps -a --format with tab separators).
// 5th column is the compose working_dir label (<project>/.orcha).
const REAL_OUTPUT = [
  'orcha-quantal-ehr-portal-1\tUp 4 hours\t0.0.0.0:8001->8000/tcp\torcha-quantal-ehr\t/Users/me/quantal-ehr/.orcha',
  'kan69-plan-localstack\tUp 18 hours (healthy)\t4510-4559/tcp, 5678/tcp, 0.0.0.0:4567->4566/tcp\t\t',
  'orcha-quantal-ehr-db-1\tUp 21 hours (healthy)\t0.0.0.0:5435->5432/tcp\torcha-quantal-ehr\t/Users/me/quantal-ehr/.orcha',
  'quantal-backend\tUp 20 hours (healthy)\t0.0.0.0:8103->8103/tcp\tintegration-all-prs\t/Users/me/x',
  ''
].join('\n')

const STOPPED_OUTPUT = [
  'orcha-todo-app-portal-1\tExited (0) 2 days ago\t\torcha-todo-app\t/Users/me/todo-app/.orcha',
  'orcha-todo-app-db-1\tExited (0) 2 days ago\t\torcha-todo-app\t/Users/me/todo-app/.orcha',
  ''
].join('\n')

describe('parseHostPort', () => {
  it('extracts the host port for a container port', () => {
    expect(parseHostPort('0.0.0.0:8001->8000/tcp', '8000')).toBe(8001)
  })
  it('picks the right mapping out of a multi-port list', () => {
    expect(
      parseHostPort('4510-4559/tcp, 5678/tcp, 0.0.0.0:4567->4566/tcp', '4566')
    ).toBe(4567)
  })
  it('returns null when the container port is not published', () => {
    expect(parseHostPort('', '8000')).toBeNull()
    expect(parseHostPort('4510-4559/tcp', '8000')).toBeNull()
  })
  it('handles IPv6 wildcard binds (::: and [::]:)', () => {
    expect(parseHostPort(':::8001->8000/tcp', '8000')).toBe(8001)
    expect(parseHostPort('[::]:5435->5432/tcp', '5432')).toBe(5435)
  })
  it('prefers the first matching bind in dual-stack output', () => {
    expect(parseHostPort('0.0.0.0:8001->8000/tcp, :::8001->8000/tcp', '8000')).toBe(8001)
  })
})

describe('parseDockerPs', () => {
  it('groups orcha-* projects and extracts portal/db ports', () => {
    const stacks = parseDockerPs(REAL_OUTPUT)
    expect(stacks).toEqual([
      {
        project: 'orcha-quantal-ehr',
        projectShort: 'quantal-ehr',
        apiPort: 8001,
        dbPort: 5435,
        portalStatus: 'Up 4 hours',
        running: true,
        folder: '/Users/me/quantal-ehr'
      }
    ])
  })
  it('ignores non-orcha projects and unlabeled containers', () => {
    const stacks = parseDockerPs(REAL_OUTPUT)
    expect(stacks.map((s) => s.project)).not.toContain('integration-all-prs')
  })
  it('includes stopped stacks with null ports and running=false', () => {
    const [stack] = parseDockerPs(STOPPED_OUTPUT)
    expect(stack).toEqual({
      project: 'orcha-todo-app',
      projectShort: 'todo-app',
      apiPort: null,
      dbPort: null,
      portalStatus: 'Exited (0) 2 days ago',
      running: false,
      folder: '/Users/me/todo-app'
    })
  })
  it('skips malformed lines', () => {
    expect(parseDockerPs('garbage\nno\ttabs here\n')).toEqual([])
  })
  it('sorts stacks by project name', () => {
    const out =
      'orcha-zeta-portal-1\tUp 1 hour\t0.0.0.0:8002->8000/tcp\torcha-zeta\n' +
      'orcha-alpha-portal-1\tUp 1 hour\t0.0.0.0:8001->8000/tcp\torcha-alpha\n'
    expect(parseDockerPs(out).map((s) => s.project)).toEqual(['orcha-alpha', 'orcha-zeta'])
  })
})

describe('listStacks', () => {
  it('runs docker ps -a with the label format and parses the output', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: REAL_OUTPUT })
    const stacks = await listStacks(exec)
    expect(exec).toHaveBeenCalledWith('docker', [
      'ps',
      '-a',
      '--format',
      '{{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}'
    ])
    expect(stacks).toHaveLength(1)
    expect(stacks[0].project).toBe('orcha-quantal-ehr')
    expect(stacks[0].running).toBe(true)
  })
  it('maps exec failure to DOCKER_UNAVAILABLE', async () => {
    const exec = vi.fn().mockRejectedValue(new Error('spawn docker ENOENT'))
    await expect(listStacks(exec)).rejects.toEqual({ code: 'DOCKER_UNAVAILABLE' })
  })
})
