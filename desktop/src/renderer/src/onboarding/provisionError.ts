import type { BridgeError, ProvisionStep } from '../../../shared/types'
import { summarizeStderr } from '../util/errorText'

/** A provisioning failure, translated for a person: a one-line message, an optional raw
 *  detail (daemon/CLI stderr — shown only on demand), and which step failed when known.
 *  Never renders "[object Object]" or raw JSON (D4). */
export interface ProvisionFailure {
  code: string
  message: string
  /** The most telling line of the raw output, in plain words, when the headline is still
   *  generic ("Setup failed while starting the containers.") — shown under the headline so
   *  the fixable cause is visible without opening the details. */
  cause: string | null
  detail: string | null
  step: ProvisionStep | null
}

const MESSAGES: Record<string, string> = {
  DOCKER_UNAVAILABLE: 'Docker stopped responding. Make sure Docker is running, then try again.',
  DOCKER_NOT_INSTALLED: 'Docker isn’t installed on this Mac.',
  DOCKER_START_TIMEOUT: 'Docker didn’t finish starting in time. Open Docker, wait until it’s running, then try again.',
  PORT_UNAVAILABLE: 'Embodent couldn’t find a free port for this project. Stop another project or app, then try again.',
  TEMPLATES_MISSING: 'The Orcha helper is missing its project templates. Reinstall the helper, then try again.',
  ALREADY_INITIALIZED: 'This folder already has an Orcha project. Go back and choose it again to reconnect.',
  PORTAL_TIMEOUT: 'The project started, but its portal didn’t answer in time. Trying again usually fixes this.',
  CONTAINER_EXISTS: 'A project with this name already exists. Go back and choose a different name.',
  COMPOSE_FAILED: 'Docker couldn’t start the project’s containers.',
  PROVISION_FAILED: 'A setup step failed.',
  GIT_NOT_INSTALLED: 'Git isn’t installed on this Mac. Install it with `xcode-select --install`, then try again.',
  INVALID_REPO_URL: 'That repository URL isn’t valid.',
  DEST_NOT_EMPTY: 'The destination folder isn’t empty. Go back and choose a different folder.',
  CLONE_FAILED: 'The repository couldn’t be cloned. Check the URL and your access to it.',
  UNKNOWN_STACK: 'The new project couldn’t be found after it was created.',
  INTERNAL: 'Something went wrong inside Embodent.'
}

const STEP_NAMES: Partial<Record<ProvisionStep, string>> = {
  preflight: 'checking Docker',
  'clone-repo': 'cloning the repository',
  'render-compose': 'preparing the project files',
  'copy-templates': 'copying the project templates',
  'compose-up': 'starting the containers',
  'wait-portal': 'waiting for the portal',
  'create-container': 'creating the project',
  'register-human': 'registering you',
  'start-daemons': 'starting the agent worker'
}

/** Known, fixable causes recognized in daemon/CLI output — each becomes the headline. */
const CAUSES: { test: RegExp; message: (m: RegExpMatchArray) => string }[] = [
  {
    test: /(?:[\d.]+|\[[^\]]*\]|localhost)?:(\d{2,5})\b[^\n]*?(?:port is already allocated|address already in use)/i,
    message: (m) => `Port ${m[1]} is already in use. Stop whatever is using it, then try again.`
  },
  {
    test: /(?:port is already allocated|address already in use)/i,
    message: () => 'A port this project needs is already in use. Stop whatever is using it, then try again.'
  },
  {
    test: /no space left on device/i,
    message: () => 'Docker ran out of disk space. Free some space in Docker, then try again.'
  },
  {
    test: /cannot connect to the docker daemon|is the docker daemon running/i,
    message: () => MESSAGES.DOCKER_UNAVAILABLE
  },
  {
    test: /pull access denied|manifest unknown|toomanyrequests|failed to resolve reference/i,
    message: () => 'Docker couldn’t download one of the project’s images. Check your connection, then try again.'
  },
  {
    test: /repository not found|could not read from remote repository|authentication failed/i,
    message: () => 'The repository couldn’t be reached. Check the URL and that you have access to it.'
  }
]

/** Codes whose headline is generic enough that the raw output's cause is worth surfacing. */
const GENERIC = new Set(['COMPOSE_FAILED', 'PROVISION_FAILED', 'CLONE_FAILED', 'INTERNAL'])

/** Normalize whatever a rejected provision/clone promise carried into a ProvisionFailure. */
export function describeProvisionFailure(err: unknown): ProvisionFailure {
  const e = (err && typeof err === 'object' ? err : {}) as Partial<BridgeError> & {
    code?: string
    stderr?: string
    reason?: string
    step?: ProvisionStep
    message?: string
  }
  const code = typeof e.code === 'string' ? e.code : 'INTERNAL'
  const step = typeof e.step === 'string' ? e.step : null
  let message = MESSAGES[code] ?? MESSAGES.INTERNAL
  if (code === 'PROVISION_FAILED' && step && STEP_NAMES[step]) {
    message = `Setup failed while ${STEP_NAMES[step]}.`
  }
  if (code === 'INVALID_REPO_URL' && typeof e.reason === 'string') message = e.reason
  const rawDetail =
    typeof e.stderr === 'string' ? e.stderr : typeof e.message === 'string' && code === 'INTERNAL' ? e.message : null
  const detail = rawDetail && rawDetail.trim() ? rawDetail.trim() : null
  let cause: string | null = null
  if (detail && GENERIC.has(code)) {
    const known = CAUSES.map((c) => ({ c, m: detail.match(c.test) })).find((x) => x.m)
    if (known && known.m) message = known.c.message(known.m)
    else if (code !== 'INTERNAL') {
      const line = summarizeStderr(detail)
      if (!/without saying why/.test(line) && line !== message) cause = line
    }
  }
  return { code, message, cause, detail, step }
}
