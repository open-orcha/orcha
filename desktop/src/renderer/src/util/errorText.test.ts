import { describe, it, expect } from 'vitest'
import { detailIsRedundant, knownFailure, readableError, summarizeStderr } from './errorText'

describe('readableError (D4: no raw stderr / [object Object])', () => {
  it('summarizes a multi-line compose stderr to its telling line, keeps the full text as detail', () => {
    const stderr = [
      ' Container orcha-acme-web-db-1  Starting',
      'Error response from daemon: driver failed programming external connectivity on endpoint orcha-acme-web-portal-1: Bind for 0.0.0.0:8001 failed: port is already allocated',
      ''
    ].join('\n')
    const r = readableError({ code: 'COMPOSE_FAILED', stderr })
    expect(r.summary).toBe('Port 8001 is already in use — stop whatever is using it, then try again.')
    expect(r.summary.length).toBeLessThanOrEqual(160)
    expect(r.summary).not.toContain('Error response from daemon')
    expect(r.detail).toContain('Starting')
  })

  it('maps bridge codes to plain words', () => {
    expect(readableError({ code: 'DOCKER_UNAVAILABLE' }).summary).toBe('Docker isn’t running.')
    expect(readableError({ code: 'DOCKER_UNAVAILABLE', unresponsive: true }).summary).toBe(
      'Docker isn’t responding — quit and reopen Docker Desktop.'
    )
    expect(readableError({ code: 'SOMETHING_ODD' }).summary).toBe('Failed (something odd).')
  })

  it('never renders [object Object]', () => {
    expect(readableError({}).summary).toBe('Something went wrong.')
    expect(readableError(null).summary).toBe('Something went wrong.')
    expect(readableError({ nested: { a: 1 } }).summary).not.toContain('[object')
  })

  it('strips ANSI and logrus prefixes', () => {
    expect(summarizeStderr('\u001b[31mtime="2026" level=error msg="no such service: portal"\u001b[0m')).toBe(
      'No such service: portal'
    )
  })

  it('handles empty stderr', () => {
    expect(summarizeStderr('  \n ')).toBe('The command failed without saying why.')
  })

  it('words known daemon failures as a next step', () => {
    expect(summarizeStderr('listen tcp 0.0.0.0:5432: bind: address already in use')).toMatch(/^Port 5432 is already in use/)
    expect(summarizeStderr('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?')).toMatch(
      /^Docker isn’t running/
    )
    expect(knownFailure('some unrelated failure')).toBeNull()
  })

  it('keeps the generic pick for other failures', () => {
    expect(summarizeStderr('Error response from daemon: pull access denied for foo')).toBe('Pull access denied for foo')
  })
})

describe('detailIsRedundant (no Details toggle that repeats the summary)', () => {
  it('hides a detail the summary already says (case / Error: prefix / trailing dot)', () => {
    expect(detailIsRedundant('Couldn’t stop: No such container: orcha-x-db', 'Error: no such container: orcha-x-db.')).toBe(true)
    expect(detailIsRedundant('Something', null)).toBe(true)
  })

  it('keeps a detail that adds information', () => {
    expect(detailIsRedundant('Port 8101 is already in use', 'line one\nBind for 0.0.0.0:8101 failed: port is already allocated')).toBe(false)
  })

  it('readableError drops a single-line stderr detail equal to its summary', () => {
    expect(readableError({ code: 'COMPOSE_FAILED', stderr: 'Error: no such service: portal' }).detail).toBeNull()
    expect(readableError({ code: 'COMPOSE_FAILED', stderr: 'a\nError: no such service: portal' }).detail).not.toBeNull()
  })
})
