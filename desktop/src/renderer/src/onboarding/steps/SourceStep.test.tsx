// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import SourceStep, { SHOW_PREVIEW_SOURCES } from './SourceStep'

/** GH #238: the setup-mode chooser lists all four ways to set up a project. Only the two
 *  that are built (local folder, git URL) are selectable; iCloud Drive and Cloud-hosted are
 *  inert previews with copy that is honest about what they do NOT do. */
describe('SourceStep — setup-mode chooser', () => {
  it('shows all four setup modes, in order', () => {
    render(<SourceStep onChoose={vi.fn()} />)
    const names = screen.getAllByRole('button').map((b) => b.textContent ?? '')
    expect(names).toHaveLength(4)
    expect(names[0]).toMatch(/local folder/i)
    expect(names[1]).toMatch(/from github, gitlab or bitbucket/i)
    expect(names[2]).toMatch(/icloud drive folder/i)
    expect(names[3]).toMatch(/cloud-hosted orcha/i)
    expect(SHOW_PREVIEW_SOURCES).toBe(true)
  })

  it('local folder and git URL cards hand their source up', async () => {
    const onChoose = vi.fn()
    const user = userEvent.setup()
    render(<SourceStep onChoose={onChoose} />)

    await user.click(screen.getByRole('button', { name: /local folder/i }))
    expect(onChoose).toHaveBeenLastCalledWith('local')

    await user.click(screen.getByRole('button', { name: /from github, gitlab or bitbucket/i }))
    expect(onChoose).toHaveBeenLastCalledWith('github')
    expect(onChoose).toHaveBeenCalledTimes(2)
  })

  it('git card copy matches the validator: https only, named hosts, SSH unsupported', () => {
    render(<SourceStep onChoose={vi.fn()} />)
    const card = screen.getByRole('button', { name: /from github, gitlab or bitbucket/i })
    expect(card.textContent).toMatch(/https:\/\//)
    expect(card.textContent).toMatch(/ssh urls aren.t supported/i)
  })

  it('iCloud Drive and Cloud-hosted are disabled previews that never fire onChoose', async () => {
    const onChoose = vi.fn()
    const user = userEvent.setup()
    render(<SourceStep onChoose={onChoose} />)

    const icloud = screen.getByRole('button', { name: /icloud drive folder/i })
    const cloud = screen.getByRole('button', { name: /cloud-hosted orcha/i })
    expect(icloud).toBeDisabled()
    expect(cloud).toBeDisabled()
    expect(icloud.textContent).toMatch(/coming soon/i)
    expect(cloud.textContent).toMatch(/coming soon/i)

    await user.click(icloud)
    await user.click(cloud)
    expect(onChoose).not.toHaveBeenCalled()
  })

  it('iCloud copy is explicit that only code/config sync — not agents, tasks, history or the database', () => {
    render(<SourceStep onChoose={vi.fn()} />)
    const icloud = screen.getByRole('button', { name: /icloud drive folder/i })
    const text = icloud.textContent ?? ''
    expect(text).toMatch(/code and \.orcha config/i)
    expect(text).toMatch(/agents, tasks, history and the database do not sync/i)
    expect(text).toMatch(/each mac runs its own orcha/i)
    expect(text).toMatch(/optimize mac storage off/i)
    expect(text).toMatch(/can contain secrets/i)
  })

  it('cloud-hosted copy does not promise anything the app cannot do yet (no URL field, no pairing)', () => {
    render(<SourceStep onChoose={vi.fn()} />)
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    const cloud = screen.getByRole('button', { name: /cloud-hosted orcha/i })
    expect(cloud.textContent).toMatch(/nothing is cloned or provisioned locally/i)
  })
})
