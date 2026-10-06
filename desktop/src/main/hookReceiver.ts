/** Agent-hook receiver: a loopback-only HTTP endpoint the bundled hook script
 *  (main/agentHooks.ts) POSTs lifecycle events to — `POST /hook/<termId>`.
 *
 *  Security model:
 *  - Bound to 127.0.0.1 on a random port; nothing else is served (every other method / path
 *    is a bare 404, no body, no CORS).
 *  - A per-app-run secret (32 random bytes) must arrive in `X-Orcha-Hook-Token`; compared in
 *    constant time. The token lives only in a 0600 file under userData and in main's memory.
 *  - Browser-originated requests are refused: any `Origin` header → 403, and `Host` must be
 *    exactly `127.0.0.1:<port>` (DNS-rebinding guard).
 *  - `termId` must be a live session that was launched WITH hooks → else 403.
 *  - Bodies are small JSON (≤ HOOK_BODY_MAX bytes, counted as bytes while streaming) with an
 *    exact schema (agentStatus.parseHookEvent); oversize → 413, malformed → 400.
 *  - Slow clients are cut off (request / headers timeouts).
 *
 *  Shape informed by Orca's agent-hook server (github.com/stablyai/orca, MIT © Lovecast Inc.:
 *  loopback listener, token header, byte-counted body cap, slowloris timeout). */
import http from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { parseHookEvent, type HookEvent } from './agentStatus'

/** Largest accepted body. The script sends `{"event":"…","detail":"…"}` (< 100 bytes). */
export const HOOK_BODY_MAX = 2048
/** A request must be complete within this long. */
export const HOOK_REQUEST_TIMEOUT_MS = 5000
export const HOOK_TOKEN_HEADER = 'x-orcha-hook-token'

const PATH_RE = /^\/hook\/([1-9][0-9]{0,14})$/

export interface HookReceiverDeps {
  token: string
  /** Is `termId` a live session launched with hooks? */
  accepts(termId: number): boolean
  deliver(termId: number, e: HookEvent): void
}

function tokenMatches(expected: string, got: unknown): boolean {
  if (typeof got !== 'string') return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(got, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The request handler (exported for tests; `port` is the bound port, for the Host check). */
export function createHookHandler(deps: HookReceiverDeps, port: () => number) {
  return (req: http.IncomingMessage, res: http.ServerResponse): void => {
    const done = (code: number): void => {
      if (res.headersSent) return
      res.writeHead(code, { 'Content-Length': '0', Connection: 'close' })
      res.end()
    }
    const m = req.method === 'POST' && typeof req.url === 'string' ? PATH_RE.exec(req.url) : null
    if (!m) {
      req.resume()
      done(404)
      return
    }
    if (req.headers.origin !== undefined || req.headers.host !== `127.0.0.1:${port()}` || !tokenMatches(deps.token, req.headers[HOOK_TOKEN_HEADER])) {
      req.resume()
      done(403)
      return
    }
    const termId = Number(m[1])
    if (!deps.accepts(termId)) {
      req.resume()
      done(403)
      return
    }
    const declared = Number(req.headers['content-length'] ?? '0')
    if (Number.isFinite(declared) && declared > HOOK_BODY_MAX) {
      done(413)
      req.destroy()
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    req.on('data', (chunk: Buffer) => {
      if (over) return
      size += chunk.length
      if (size > HOOK_BODY_MAX) {
        over = true
        done(413)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', () => done(400))
    req.on('end', () => {
      if (over) return
      // A body cut short of its own Content-Length (a proxy / IDS resetting loopback) is
      // incomplete, never parsed as a smaller JSON document.
      if (Number.isFinite(declared) && req.headers['content-length'] !== undefined && size !== declared) {
        done(400)
        return
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        done(400)
        return
      }
      const e = parseHookEvent(parsed)
      if (!e) {
        done(400)
        return
      }
      // Re-check: the session may have exited while the body streamed in.
      if (!deps.accepts(termId)) {
        done(403)
        return
      }
      deps.deliver(termId, e)
      done(204)
    })
  }
}

export interface HookReceiver {
  port: number
  close(): Promise<void>
}

/** Start listening on 127.0.0.1:<random>. */
export function startHookReceiver(deps: HookReceiverDeps): Promise<HookReceiver> {
  let bound = 0
  const server = http.createServer(createHookHandler(deps, () => bound))
  server.requestTimeout = HOOK_REQUEST_TIMEOUT_MS
  server.headersTimeout = HOOK_REQUEST_TIMEOUT_MS
  server.keepAliveTimeout = 1000
  server.maxHeadersCount = 32
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject)
      const addr = server.address()
      bound = typeof addr === 'object' && addr ? addr.port : 0
      // A hook POST must never keep the app alive on quit.
      server.unref()
      resolve({
        port: bound,
        close: () =>
          new Promise<void>((r) => {
            server.close(() => r())
            server.closeAllConnections?.()
          })
      })
    })
  })
}
