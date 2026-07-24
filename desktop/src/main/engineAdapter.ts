/** Connects the pure provisioning engine to real host filesystem and network services. */
import { randomBytes } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dockerExec } from './dockerExec'
import { startHostWorker, nodeHostWorkerDeps } from './hostWorker'
import { type EngineDeps, type EngineFs } from './initEngine'
import { templatesRoot } from './templates'

const nodeEngineFs: EngineFs = {
  readFile: (file) => readFileSync(file, 'utf8'),
  writeFile: (file, content) => writeFileSync(file, content),
  copyTree: (source, destination) => cpSync(source, destination, { recursive: true }),
  mkdirp: (directory) => void mkdirSync(directory, { recursive: true }),
  chmod: (file, mode) => chmodSync(file, mode),
  exists: (file) => existsSync(file)
}

async function fetchJson(
  url: string,
  init?: { method?: string; body?: unknown }
): Promise<unknown> {
  const response = await fetch(url, {
    method: init?.method ?? 'GET',
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    body: init?.body ? JSON.stringify(init.body) : undefined
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw Object.assign(new Error(`HTTP ${response.status} ${text.slice(0, 500)}`), {
      status: response.status
    })
  }
  const contentType = response.headers.get('content-type') ?? ''
  return contentType.includes('application/json') ? response.json() : undefined
}

/** Build real provisioning dependencies; callers override the per-run port resolver. */
export function engineDeps(): EngineDeps {
  return {
    exec: dockerExec,
    fetchJson,
    fs: nodeEngineFs,
    templatesRoot,
    findFreePort: (start) => start,
    readComposeTemplate: () => {
      const composePath = path.join(templatesRoot(), 'docker-compose.yml.j2')
      if (!existsSync(composePath)) {
        throw new Error(
          'App assets are missing (bundled Orcha templates not found). ' +
            'In a dev checkout run `npm run build` (or `npm run copy:templates`) before ' +
            'launching; in a packaged build this means the .app was built incorrectly.'
        )
      }
      return readFileSync(composePath, 'utf8')
    },
    genSecret: () => randomBytes(32).toString('base64url'),
    user: os.userInfo().username || 'operator',
    startWorker: (folder) => startHostWorker(folder, nodeHostWorkerDeps)
  }
}
