import { describe, it, expect } from 'vitest'
import type {
  ProvisionMode,
  ProgressEvent,
  OrchaDesktopApi
} from './types'

describe('shared onboarding types', () => {
  it('ProgressEvent variants carry a runId and step', () => {
    const ok: ProgressEvent = { runId: 'r1', step: 'compose-up', status: 'ok' }
    const log: ProgressEvent = { runId: 'r1', step: 'compose-up', status: 'log', line: 'pulling' }
    const fail: ProgressEvent = {
      runId: 'r1',
      step: 'wait-portal',
      status: 'fail',
      code: 'PORTAL_TIMEOUT',
      detail: 'no 200 in 30s'
    }
    expect([ok.runId, log.runId, fail.runId]).toEqual(['r1', 'r1', 'r1'])
  })

  it('ProvisionMode is the three supported modes', () => {
    const modes: ProvisionMode[] = ['init', 'upgrade', 'reset']
    expect(modes).toHaveLength(3)
  })

  it('OrchaDesktopApi exposes the new onboarding methods', () => {
    const keys: Array<keyof OrchaDesktopApi> = [
      'preflight',
      'pickFolder',
      'inspectFolder',
      'provision',
      'openOnboarding',
      'openOnboardingPortal',
      'onProvisionProgress'
    ]
    expect(keys.length).toBeGreaterThan(0)
  })
})
