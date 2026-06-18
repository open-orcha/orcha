import { describe, it, expect } from 'vitest'
import { sanitizeName, renderCompose, templatesRoot } from './templates'

describe('templates helpers', () => {
  it('sanitizeName mirrors the CLI rule', () => {
    expect(sanitizeName('My App!')).toBe('my-app')
    expect(sanitizeName('  ')).toBe('orcha')
    expect(sanitizeName('keep_under-score')).toBe('keep_under-score')
  })

  it('renderCompose substitutes all four placeholders', () => {
    const tmpl =
      'name: orcha-{{ project_name }}\nports: ["{{ db_port }}:5432"]\n' +
      'api: {{ api_port }} bridge: {{ bridge_port }}'
    const out = renderCompose(tmpl, { projectName: 'demo', dbPort: 5433, apiPort: 8001, bridgePort: 8766 })
    expect(out).toContain('name: orcha-demo')
    expect(out).toContain('["5433:5432"]')
    expect(out).toContain('api: 8001 bridge: 8766')
    expect(out).not.toContain('{{')
  })

  it('templatesRoot points at a directory containing docker-compose.yml.j2', () => {
    expect(templatesRoot().endsWith('orcha-templates')).toBe(true)
  })
})
