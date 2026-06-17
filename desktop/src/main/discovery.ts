import type { Stack } from '../shared/types'
import { dockerExec, type Exec, type ExecResult } from './dockerExec'

const defaultExec: Exec = dockerExec

const PS_FORMAT = '{{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Label "com.docker.compose.project"}}'

/** Mirror of the CLI's _parse_host_port, extended for IPv6 wildcard binds
 *  (':::8001->8000/tcp', '[::]:8001->8000/tcp') seen on OrbStack/Docker Desktop. */
export function parseHostPort(portsStr: string, containerPort: string): number | null {
  for (const raw of portsStr.split(',')) {
    const chunk = raw.trim()
    if (!chunk.includes(`->${containerPort}/`)) continue
    const match = chunk.match(/(?:0\.0\.0\.0|\[::\]|::):(\d+)->/)
    if (match) {
      const port = Number(match[1])
      if (Number.isInteger(port)) return port
    }
  }
  return null
}

/** Mirror of the CLI's _discover_stacks parsing, over `docker ps -a` output. */
export function parseDockerPs(stdout: string): Stack[] {
  const byProject = new Map<string, Array<{ name: string; status: string; ports: string }>>()
  for (const line of stdout.split('\n')) {
    const parts = line.split('\t')
    if (parts.length < 4) continue
    const [name, status, ports, rawProject] = parts
    const project = rawProject.trim()
    if (!project.startsWith('orcha-')) continue
    const rows = byProject.get(project) ?? []
    rows.push({ name, status, ports })
    byProject.set(project, rows)
  }

  return [...byProject.keys()].sort().map((project) => {
    let apiPort: number | null = null
    let dbPort: number | null = null
    let portalStatus = ''
    for (const { name, status, ports } of byProject.get(project)!) {
      if (name.includes('portal')) {
        portalStatus = status
        apiPort = parseHostPort(ports, '8000')
      } else if (name.includes('db')) {
        dbPort = parseHostPort(ports, '5432')
      }
    }
    return {
      project,
      projectShort: project.replace(/^orcha-/, ''),
      apiPort,
      dbPort,
      portalStatus,
      running: portalStatus.startsWith('Up')
    }
  })
}

/** All orcha-* stacks on this machine, running or stopped.
 *  Rejects with {code:'DOCKER_UNAVAILABLE'} when docker is missing or the daemon is down. */
export async function listStacks(exec: Exec = defaultExec): Promise<Stack[]> {
  let result: ExecResult
  try {
    result = await exec('docker', ['ps', '-a', '--format', PS_FORMAT])
  } catch {
    throw { code: 'DOCKER_UNAVAILABLE' } as const
  }
  return parseDockerPs(result.stdout)
}
