/** Settings › Profile persistence + applying a new name to running projects.
 *
 *  The name lives in <userData>/profile.json (this Mac only). New projects register their
 *  human with it (engineDeps().user); saving a new one renames YOUR human in every running
 *  project via PATCH /api/agents/{id} — the same human-authority route the portal uses, with
 *  that human as its own actor. */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { normalizeProfileName, type ProfileRenameResult } from '../shared/profile'

export function profileFilePath(userDataDir: string): string {
  return path.join(userDataDir, 'profile.json')
}

/** The saved name, or null when absent/unreadable/malformed — never throws. */
export function readProfileName(userDataDir: string): string | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(profileFilePath(userDataDir), 'utf8'))
    const name = (parsed as { name?: unknown } | null)?.name
    return typeof name === 'string' ? normalizeProfileName(name) : null
  } catch {
    return null
  }
}

/** Persist the name (null clears it). Throws on a write failure — the caller reports it. */
export function writeProfileName(userDataDir: string, name: string | null): void {
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(profileFilePath(userDataDir), JSON.stringify({ name }, null, 2) + '\n')
}

interface AgentRow {
  id: string
  kind: string
  alias?: string
  status?: string
}

/** Which human on a roster is YOU: the one still carrying your previous name, else the only
 *  human. null when that can't be told apart (several humans, none with your old name). */
export function pickSelf(agents: AgentRow[], previousName: string): AgentRow | null {
  const humans = agents.filter((a) => a.kind === 'human' && a.status !== 'terminated')
  const prev = previousName.toLowerCase()
  return humans.find((a) => (a.alias ?? '').toLowerCase() === prev) ?? (humans.length === 1 ? humans[0] : null)
}

export interface RenameDeps {
  /** Running stacks with a published portal. */
  stacks: { projectShort: string; apiPort: number }[]
  request(apiPort: number, path: string, method: 'GET' | 'PATCH', body?: unknown): Promise<unknown>
}

function reasonOf(err: unknown): string {
  const e = err as { status?: number; detail?: string; message?: string }
  if (e?.status === 409) return 'that name is already taken in this project'
  return e?.detail || e?.message || 'the portal did not answer'
}

/** Rename your human from `previousName` to `nextName` in every running project. Never
 *  throws: each project reports its own outcome. */
export async function renameSelfInProjects(
  deps: RenameDeps,
  previousName: string,
  nextName: string
): Promise<ProfileRenameResult[]> {
  return Promise.all(
    deps.stacks.map(async ({ projectShort: project, apiPort }): Promise<ProfileRenameResult> => {
      try {
        const list = (await deps.request(apiPort, '/api/containers', 'GET')) as { containers?: { id: string }[] }
        const cid = list.containers?.[0]?.id
        if (!cid) return { project, status: 'skipped', reason: 'no project container yet' }
        const detail = (await deps.request(apiPort, `/api/containers/${cid}`, 'GET')) as { agents?: AgentRow[] }
        const self = pickSelf(detail.agents ?? [], previousName)
        if (!self) return { project, status: 'skipped', reason: 'could not tell which person is you' }
        if (self.alias === nextName) return { project, status: 'unchanged' }
        await deps.request(apiPort, `/api/agents/${self.id}`, 'PATCH', { actor_agent_id: self.id, alias: nextName })
        return { project, status: 'renamed' }
      } catch (err) {
        return { project, status: 'failed', reason: reasonOf(err) }
      }
    })
  )
}
