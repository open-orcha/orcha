// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ApiKeysSettings, { API_KEYS_CAPTION } from './ApiKeysSettings'
import SettingsView from './SettingsView'
import type { ProviderKeysApi, ProviderKeysState } from '../../../shared/providerKeys'

const KEY = 'sk-ant-api03-TYPEDSECRET-wxyz'

function state(over: Partial<ProviderKeysState> = {}): ProviderKeysState {
  return {
    providers: {
      anthropic: { remembered: false, masked: null, useForAgents: false },
      openai: { remembered: false, masked: null, useForAgents: false }
    },
    projects: [
      {
        cid: 'c1',
        name: 'todo-app',
        stack: 'todo-app',
        providers: { anthropic: { state: 'no-key', masked: null }, openai: { state: 'off', masked: null } }
      },
      {
        cid: 'c2',
        name: 'shop',
        stack: 'shop',
        providers: {
          anthropic: { state: 'failed', masked: null, reason: 'this project can’t store keys (encrypted storage is off)' },
          openai: { state: 'no-key', masked: null }
        }
      }
    ],
    canRemember: true,
    checkedAt: 1,
    pending: { anthropic: 0, openai: 0 },
    keychainDenied: false,
    ...over
  }
}

function api(
  initial: ProviderKeysState,
  saved?: ProviderKeysState,
  applied?: ProviderKeysState
): ProviderKeysApi & { save: ReturnType<typeof vi.fn>; applyRemembered: ReturnType<typeof vi.fn> } {
  return {
    get: vi.fn().mockResolvedValue(initial),
    refresh: vi.fn().mockResolvedValue(initial),
    save: vi.fn().mockResolvedValue(saved ?? initial),
    applyRemembered: vi.fn().mockResolvedValue(applied ?? initial)
  }
}

describe('Settings › API keys', () => {
  it('explains itself and shows each project’s state per provider', async () => {
    render(<ApiKeysSettings api={api(state())} />)
    expect(screen.getByTestId('api-keys-caption')).toHaveTextContent(
      'No Claude or ChatGPT subscription? Agents can bill an API key instead. Keys are stored encrypted on each project and used only for its agent runs.'
    )
    expect(API_KEYS_CAPTION).toMatch(/^No Claude or ChatGPT subscription\?/)
    const row1 = await screen.findByTestId('api-keys-project-c1')
    expect(row1).toHaveTextContent('todo-app')
    expect(row1.querySelector('[data-provider="anthropic"]')).toHaveTextContent('No key')
    // stored but no hint from the portal → just "stored"
    expect(row1.querySelector('[data-provider="openai"]')).toHaveTextContent('Offstored')
    const row2 = screen.getByTestId('api-keys-project-c2')
    expect(row2.querySelector('[data-provider="anthropic"]')).toHaveTextContent('Failed')
    expect(row2).toHaveTextContent('encrypted storage is off')
  })

  it('saves a typed key with its switch, clears the input at once, and shows only the masked key after', async () => {
    const after = state({
      providers: {
        anthropic: { remembered: true, masked: 'sk-ant-…wxyz', useForAgents: true },
        openai: { remembered: false, masked: null, useForAgents: false }
      },
      projects: [
        {
          cid: 'c1',
          name: 'todo-app',
          stack: 'todo-app',
          providers: { anthropic: { state: 'on', masked: 'sk-ant-…wxyz' }, openai: { state: 'off', masked: null } }
        }
      ]
    })
    const a = api(state(), after)
    render(<ApiKeysSettings api={a} />)
    await screen.findByTestId('api-keys-project-c1')
    const input = screen.getByTestId('api-key-input-anthropic') as HTMLInputElement
    expect(input.type).toBe('password')
    await userEvent.type(input, KEY)
    await userEvent.click(screen.getByRole('switch', { name: 'Use the Anthropic key for agent runs' }))
    await userEvent.click(screen.getByTestId('api-keys-save'))
    expect(a.save).toHaveBeenCalledWith({ anthropic: { apiKey: KEY, useForAgents: true } })
    await waitFor(() => expect(screen.getByTestId('api-keys-notice')).toHaveTextContent('Saved and applied to 1 project.'))
    expect(input.value).toBe('')
    expect(screen.getByTestId('api-key-stored-anthropic')).toHaveTextContent('sk-ant-…wxyz')
    expect(within(screen.getByTestId('api-keys-project-c1')).getByText('On')).toBeInTheDocument()
    expect(document.body.innerHTML).not.toContain('TYPEDSECRET')
  })

  it('flipping only a switch saves just that switch (no key)', async () => {
    const a = api(state())
    render(<ApiKeysSettings api={a} />)
    await screen.findByTestId('api-keys-project-c1')
    expect(screen.getByTestId('api-keys-save')).toBeDisabled()
    await userEvent.click(screen.getByTestId('api-key-use-openai'))
    await userEvent.click(screen.getByTestId('api-keys-save'))
    expect(a.save).toHaveBeenCalledWith({ openai: { useForAgents: true } })
  })

  it('explains the macOS Keychain prompt by Save as soon as a key field has text', async () => {
    render(<ApiKeysSettings api={api(state())} />)
    await screen.findByTestId('api-keys-project-c1')
    expect(screen.queryByTestId('api-keys-keychain-note')).toBeNull()
    await userEvent.type(screen.getByTestId('api-key-input-openai'), 'sk-x')
    expect(screen.getByTestId('api-keys-keychain-note')).toHaveTextContent(
      'macOS will ask to let Embodent store this key in your Keychain. Choose Always Allow so you’re not asked again.'
    )
    await userEvent.clear(screen.getByTestId('api-key-input-openai'))
    expect(screen.queryByTestId('api-keys-keychain-note')).toBeNull()
  })

  it('pending: says how many new projects lack the remembered key, and Apply unlocks it (with the Keychain note)', async () => {
    const remembered = {
      anthropic: { remembered: true, masked: 'sk-ant-…wxyz', useForAgents: true },
      openai: { remembered: false, masked: null, useForAgents: false }
    }
    const before = state({ providers: remembered, pending: { anthropic: 2, openai: 0 } })
    const after = state({ providers: remembered })
    const a = api(before, undefined, after)
    render(<ApiKeysSettings api={a} />)
    const row = await screen.findByTestId('api-key-pending-anthropic')
    expect(row).toHaveTextContent('2 new projects don’t have your Anthropic key yet')
    expect(screen.getByTestId('api-key-apply-note-anthropic')).toHaveTextContent('Always Allow')
    expect(screen.queryByTestId('api-key-pending-openai')).toBeNull()
    await userEvent.click(screen.getByTestId('api-key-apply-anthropic'))
    expect(a.applyRemembered).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByTestId('api-key-pending-anthropic')).toBeNull())
  })

  it('one pending project reads in the singular', async () => {
    render(<ApiKeysSettings api={api(state({ pending: { anthropic: 0, openai: 1 } }))} />)
    expect(await screen.findByTestId('api-key-pending-openai')).toHaveTextContent('1 new project doesn’t have your OpenAI key yet')
  })

  it('Keychain denied: says the saved key couldn’t be read and offers to re-enter it (no Apply)', async () => {
    render(<ApiKeysSettings api={api(state({ pending: { anthropic: 1, openai: 0 }, keychainDenied: true }))} />)
    const row = await screen.findByTestId('api-key-denied-anthropic')
    expect(row).toHaveTextContent('Embodent couldn’t read your saved key from the Keychain')
    expect(screen.queryByTestId('api-key-apply-anthropic')).toBeNull()
    await userEvent.click(screen.getByTestId('api-key-reenter-anthropic'))
    expect(screen.getByTestId('api-key-input-anthropic')).toHaveFocus()
  })

  it('a saved key the Keychain wouldn’t remember: says it went to the projects but isn’t remembered', async () => {
    const after = state({
      projects: [
        {
          cid: 'c1',
          name: 'todo-app',
          stack: 'todo-app',
          providers: { anthropic: { state: 'off', masked: 'sk-ant-…wxyz' }, openai: { state: 'off', masked: null } }
        }
      ]
    })
    const a = api(state(), after)
    render(<ApiKeysSettings api={a} />)
    await screen.findByTestId('api-keys-project-c1')
    await userEvent.type(screen.getByTestId('api-key-input-anthropic'), KEY)
    await userEvent.click(screen.getByTestId('api-keys-save'))
    expect(await screen.findByTestId('api-keys-not-remembered')).toHaveTextContent(
      'Saved to your projects. Not remembered on this Mac, so projects you connect later won’t get it automatically.'
    )
    expect(document.body.innerHTML).not.toContain('TYPEDSECRET')
  })

  it('no running project: says keys are added when one starts', async () => {
    render(<ApiKeysSettings api={api(state({ projects: [] }))} />)
    expect(await screen.findByTestId('api-keys-no-projects')).toHaveTextContent('added to each project when it starts')
  })

  it('is a Settings section (the bridge present), opened directly by the onboarding link', async () => {
    const a = api(state())
    window.orchaDesktop = { providerKeys: a } as never
    render(<SettingsView onClose={() => {}} initialSection="apiKeys" />)
    expect(screen.getByTestId('settings-nav-apiKeys')).toHaveTextContent('API keys')
    expect(screen.getByTestId('settings-nav-apiKeys')).toHaveAttribute('aria-current', 'page')
    expect(await screen.findByTestId('settings-api-keys')).toBeInTheDocument()
    window.orchaDesktop = undefined as never
  })
})
