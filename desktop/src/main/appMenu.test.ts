import { describe, it, expect, vi } from 'vitest'
import { buildAppMenuTemplate } from './appMenu'

describe('app menu', () => {
  it('has a File submenu with Add Project wired to the callback', () => {
    const onAddProject = vi.fn()
    const tmpl = buildAppMenuTemplate({ onAddProject })
    const file = tmpl.find((m) => m.label === 'File')
    expect(file).toBeDefined()
    const item = (file!.submenu as Array<{ label?: string; click?: () => void; accelerator?: string }>).find(
      (i) => i.label === 'Add Project…'
    )
    expect(item).toBeDefined()
    expect(item!.accelerator).toBe('CmdOrCtrl+N')
    item!.click!()
    expect(onAddProject).toHaveBeenCalledTimes(1)
  })
})
