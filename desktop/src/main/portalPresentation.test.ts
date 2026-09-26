import { describe, expect, it } from 'vitest'
import { isTaskCodeSpaceUrl } from './portalPresentation'

describe('isTaskCodeSpaceUrl', () => {
  it('recognizes task-linked Code Space URLs', () => {
    expect(isTaskCodeSpaceUrl('/code?task=t1&run=r1')).toBe(true)
    expect(isTaskCodeSpaceUrl('http://localhost:8000/code?task=t1')).toBe(true)
  })

  it('keeps generic Code Space and unrelated routes in normal desktop chrome', () => {
    expect(isTaskCodeSpaceUrl('/code')).toBe(false)
    expect(isTaskCodeSpaceUrl('/tasks?task=t1')).toBe(false)
    expect(isTaskCodeSpaceUrl('/code?path=task')).toBe(false)
  })
})
