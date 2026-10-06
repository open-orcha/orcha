// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ProfileSettings from './ProfileSettings'
import type { ProfileApi } from '../../../shared/profile'

function api(overrides: Partial<ProfileApi> = {}): ProfileApi {
  return {
    get: vi.fn(async () => ({ name: null, deviceName: 'husseinmohamed', effective: 'husseinmohamed' })),
    set: vi.fn(async (name: string | null) => ({
      state: { name, deviceName: 'husseinmohamed', effective: name ?? 'husseinmohamed' },
      projects: [
        { project: 'todo', status: 'renamed' as const },
        { project: 'site', status: 'failed' as const, reason: 'that name is already taken in this project' }
      ]
    })),
    ...overrides
  }
}

describe('Settings › Profile', () => {
  it('shows the Mac name as the fallback and saves a new name', async () => {
    const a = api()
    render(<ProfileSettings api={a} />)
    const input = await screen.findByPlaceholderText('husseinmohamed')
    expect(screen.getByTestId('settings-profile')).toHaveTextContent('this Mac’s name, “husseinmohamed”')
    expect(screen.getByTestId('profile-save')).toBeDisabled()
    await userEvent.type(input, '  Hussein  Abdinoor ')
    await userEvent.click(screen.getByTestId('profile-save'))
    expect(a.set).toHaveBeenCalledWith('Hussein Abdinoor')
    expect(await screen.findByTestId('profile-notice')).toHaveTextContent('updated in 1 running project.')
    expect(screen.getByTestId('profile-problems')).toHaveTextContent('Not updated in site — that name is already taken')
  })

  it('clearing the name goes back to the Mac name', async () => {
    const a = api({ get: vi.fn(async () => ({ name: 'Hussein', deviceName: 'hm', effective: 'Hussein' })) })
    render(<ProfileSettings api={a} />)
    const input = await screen.findByDisplayValue('Hussein')
    await userEvent.clear(input)
    await userEvent.click(screen.getByTestId('profile-save'))
    expect(a.set).toHaveBeenCalledWith(null)
  })
})
