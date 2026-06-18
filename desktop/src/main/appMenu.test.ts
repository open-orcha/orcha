import { describe, it, expect, vi } from 'vitest'
import { buildAppMenuTemplate } from './appMenu'

describe('app menu', () => {
  it('has a File submenu with New Project wired to the callback', () => {
    const onNewProject = vi.fn()
    const tmpl = buildAppMenuTemplate({ onNewProject })
    const file = tmpl.find((m) => m.label === 'File')
    expect(file).toBeDefined()
    const item = (file!.submenu as Array<{ label?: string; click?: () => void; accelerator?: string }>).find(
      (i) => i.label === 'New Project…'
    )
    expect(item).toBeDefined()
    expect(item!.accelerator).toBe('CmdOrCtrl+N')
    item!.click!()
    expect(onNewProject).toHaveBeenCalledTimes(1)
  })
})
