import { describe, it, expect } from 'vitest'
import { describeProvisionFailure } from './provisionError'

describe('describeProvisionFailure', () => {
  it('names the failing step in plain words and keeps stderr as on-demand detail', () => {
    const f = describeProvisionFailure({
      code: 'PROVISION_FAILED',
      step: 'start',
      stderr: '  boom\n'
    })
    expect(f.message).toBe('Setup failed while starting Orcha.')
    expect(f.detail).toBe('boom')
    expect(f.step).toBe('start')
  })

  it('maps known codes to readable sentences', () => {
    expect(describeProvisionFailure({ code: 'DEST_NOT_EMPTY' }).message).toMatch(/isn.t empty/)
    expect(
      describeProvisionFailure({
        code: 'CLONE_FAILED',
        stderr: 'fatal: repo not found'
      }).detail
    ).toBe('fatal: repo not found')
  })

  it('turns a recognizable daemon error into a fixable headline', () => {
    const f = describeProvisionFailure({
      code: 'PROVISION_FAILED',
      step: 'start',
      stderr:
        'Container orcha-demo-portal-1  Starting\nError response from daemon: driver failed programming external connectivity on endpoint orcha-demo-portal-1: Bind for 0.0.0.0:8101 failed: port is already allocated\n'
    })
    expect(f.message).toBe('Port 8101 is already in use. Stop whatever is using it, then try again.')
    expect(f.cause).toBeNull()
    expect(f.detail).toMatch(/0\.0\.0\.0:8101/)
    expect(describeProvisionFailure({ code: 'COMPOSE_FAILED', stderr: 'listen tcp :5433: bind: address already in use' }).message).toMatch(
      /^Port 5433 is already in use/
    )
    expect(describeProvisionFailure({ code: 'COMPOSE_FAILED', stderr: 'write /var/lib: no space left on device' }).message).toMatch(
      /disk space/
    )
  })

  it('keeps the generic step headline but surfaces the telling line as the cause', () => {
    const f = describeProvisionFailure({
      code: 'PROVISION_FAILED',
      step: 'start',
      stderr: 'pulling portal\nError response from daemon: invalid mount config for type "bind": bind source path does not exist'
    })
    expect(f.message).toBe('Setup failed while starting Orcha.')
    expect(f.cause).toMatch(/^Invalid mount config/)
    // Known codes with their own sentence don't get a redundant cause line.
    expect(describeProvisionFailure({ code: 'DEST_NOT_EMPTY', stderr: 'x failed' }).cause).toBeNull()
  })

  it('never produces [object Object] or JSON for odd rejections', () => {
    for (const err of [undefined, null, 'x', 42, { weird: { nested: true } }, new Error('kaput')]) {
      const f = describeProvisionFailure(err)
      expect(f.message).not.toMatch(/\[object|\{/)
      expect(f.code).toBe('INTERNAL')
    }
    expect(describeProvisionFailure(new Error('kaput')).detail).toBe('kaput')
  })
})
