import { afterEach, describe, it, expect } from 'vitest'
import http from 'node:http'
import net from 'node:net'
import { HOOK_BODY_MAX, HOOK_TOKEN_HEADER, startHookReceiver, type HookReceiver } from './hookReceiver'
import type { HookEvent } from './agentStatus'

const TOKEN = 'a'.repeat(64)

let receiver: HookReceiver | null = null
afterEach(async () => {
  await receiver?.close()
  receiver = null
})

async function setup(live: number[] = [7]) {
  const got: Array<[number, HookEvent]> = []
  receiver = await startHookReceiver({
    token: TOKEN,
    accepts: (id) => live.includes(id),
    deliver: (id, e) => got.push([id, e])
  })
  return { got, port: receiver.port }
}

function post(
  port: number,
  path: string,
  body: string,
  headers: Record<string, string> = {},
  method = 'POST'
): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: { 'Content-Type': 'application/json', [HOOK_TOKEN_HEADER]: TOKEN, 'Content-Length': Buffer.byteLength(body), ...headers }
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      }
    )
    req.on('error', (err) => ((err as NodeJS.ErrnoException).code === 'ECONNRESET' || (err as NodeJS.ErrnoException).code === 'EPIPE' ? resolve(-1) : reject(err)))
    req.end(body)
  })
}

describe('hook receiver (loopback, token, schema, size cap)', () => {
  it('listens on 127.0.0.1 only and delivers a valid event (204)', async () => {
    const { got, port } = await setup()
    expect(port).toBeGreaterThan(0)
    expect(await post(port, '/hook/7', '{"event":"Stop","detail":""}')).toBe(204)
    expect(got).toEqual([[7, { event: 'Stop', detail: null }]])
    // not reachable on another interface address
    const addr = (receiver as HookReceiver).port
    const external = await new Promise<boolean>((resolve) => {
      const s = net.connect({ host: '::1', port: addr }, () => {
        s.destroy()
        resolve(true)
      })
      s.on('error', () => resolve(false))
    })
    expect(external).toBe(false)
  })

  it('wrong / missing token → 403, nothing delivered', async () => {
    const { got, port } = await setup()
    expect(await post(port, '/hook/7', '{"event":"Stop"}', { [HOOK_TOKEN_HEADER]: 'b'.repeat(64) })).toBe(403)
    expect(await post(port, '/hook/7', '{"event":"Stop"}', { [HOOK_TOKEN_HEADER]: 'short' })).toBe(403)
    expect(got).toEqual([])
  })

  it('unknown or unhooked term id → 403', async () => {
    const { got, port } = await setup([7])
    expect(await post(port, '/hook/8', '{"event":"Stop"}')).toBe(403)
    expect(got).toEqual([])
  })

  it('browser-shaped requests (Origin header, foreign Host) → 403', async () => {
    const { port } = await setup()
    expect(await post(port, '/hook/7', '{"event":"Stop"}', { Origin: 'https://evil.example' })).toBe(403)
    expect(await post(port, '/hook/7', '{"event":"Stop"}', { Host: `evil.example:${port}` })).toBe(403)
  })

  it('bad JSON / wrong schema → 400', async () => {
    const { got, port } = await setup()
    expect(await post(port, '/hook/7', '{"event":')).toBe(400)
    expect(await post(port, '/hook/7', '{"event":"rm -rf"}')).toBe(400)
    expect(await post(port, '/hook/7', '{"event":"Stop","extra":true}')).toBe(400)
    expect(got).toEqual([])
  })

  it('oversize body → 413 (or connection dropped), never parsed', async () => {
    const { got, port } = await setup()
    const big = JSON.stringify({ event: 'Stop', detail: 'x'.repeat(HOOK_BODY_MAX) })
    expect([413, -1]).toContain(await post(port, '/hook/7', big))
    expect(got).toEqual([])
  })

  it('serves nothing else: other paths / methods → 404', async () => {
    const { port } = await setup()
    expect(await post(port, '/', '')).toBe(404)
    expect(await post(port, '/hook/7', '', {}, 'GET')).toBe(404)
    expect(await post(port, '/hook/07', '{"event":"Stop"}')).toBe(404)
    expect(await post(port, '/hook/7/x', '{"event":"Stop"}')).toBe(404)
    expect(await post(port, '/hook/7?x=1', '{"event":"Stop"}')).toBe(404)
  })
})
