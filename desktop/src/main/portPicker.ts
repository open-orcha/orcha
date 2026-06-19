import net from 'node:net'
import { dockerExec, type Exec } from './dockerExec'

/** Parse the host ports Docker has PUBLISHED from `docker ps` Ports columns.
 *  A host-mapped port looks like `0.0.0.0:5433->5432/tcp`, `127.0.0.1:3300->3000/tcp`,
 *  `:::8001->8000/tcp`, or a range `127.0.0.1:4317-4318->4317-4318/tcp`. Container-only
 *  ports (`1025/tcp`) have no `->` host side and are ignored. */
export function parsePublishedPorts(stdout: string): Set<number> {
  const ports = new Set<number>()
  // Match the host side before "->": optional host addr, then a port or a port range.
  const re = /(?:\d+\.\d+\.\d+\.\d+|\[?::\]?|:::?):(\d+)(?:-(\d+))?->/g
  for (const line of stdout.split('\n')) {
    let m: RegExpExecArray | null
    re.lastIndex = 0
    while ((m = re.exec(line)) !== null) {
      const lo = Number(m[1])
      const hi = m[2] ? Number(m[2]) : lo
      if (Number.isInteger(lo) && Number.isInteger(hi)) {
        for (let p = lo; p <= hi && p - lo < 100; p++) ports.add(p)
      }
    }
  }
  return ports
}

/** Query Docker for the set of host ports currently published by any container
 *  (running or created). Returns an empty set if Docker is unavailable — the host
 *  TCP probe still guards correctness; this just avoids the 0.0.0.0-vs-127.0.0.1
 *  blind spot where a host listen succeeds but Docker's bind collides. */
export async function dockerPublishedPorts(exec: Exec = dockerExec): Promise<Set<number>> {
  try {
    const { stdout } = await exec('docker', ['ps', '-a', '--format', '{{.Ports}}'])
    return parsePublishedPorts(stdout)
  } catch {
    return new Set<number>()
  }
}

/** Probe whether a TCP port is free on the host. Binds 0.0.0.0 (the address Docker
 *  publishes on) so the probe sees the same conflicts Docker would. */
export function probeHostPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.once('listening', () => s.close(() => resolve(true)))
    s.listen(port, '0.0.0.0')
  })
}

export interface PickFreePortOpts {
  /** Host ports already published by Docker (so we skip them even if a host listen would succeed). */
  dockerPorts: Set<number>
  /** Host TCP probe; injected for tests. */
  probe?: (port: number) => Promise<boolean>
  /** How many ports to scan from `start`. */
  span?: number
}

/** Pick a free host port at/after `start`, skipping both host-busy ports AND ports
 *  Docker has already published (the 5433 collision the host probe alone misses). */
export async function pickFreePort(start: number, opts: PickFreePortOpts): Promise<number> {
  const probe = opts.probe ?? probeHostPort
  const span = opts.span ?? 100
  for (let port = start; port < start + span; port++) {
    if (opts.dockerPorts.has(port)) continue
    if (await probe(port)) return port
  }
  throw { code: 'PORT_UNAVAILABLE' } as const
}
