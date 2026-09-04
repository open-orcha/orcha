import { describe, it, expect, vi } from 'vitest'
import {
  loadReadme,
  buildTreeListing,
  buildAnalysisPrompt,
  stripMarkdownFence,
  parseAnalysisOutput,
  analyzeProject,
  ANALYSIS_INSTRUCTION,
  type DirLister,
  type AnalyzeProjectDeps
} from './analyzeProject'

describe('loadReadme', () => {
  it('reads README.md when present', () => {
    const fs = { exists: (p: string) => p.endsWith('README.md'), readFile: () => 'hello project' }
    expect(loadReadme('/proj', fs)).toBe('hello project')
  })

  it('returns "" when no README exists', () => {
    const fs = { exists: () => false, readFile: () => '' }
    expect(loadReadme('/proj', fs)).toBe('')
  })

  it('caps content at 8KB', () => {
    const big = 'x'.repeat(20_000)
    const fs = { exists: (p: string) => p.endsWith('README.md'), readFile: () => big }
    const result = loadReadme('/proj', fs)
    expect(result.length).toBe(8 * 1024)
  })

  it('tries alternate casings', () => {
    const fs = { exists: (p: string) => p.endsWith('Readme.md'), readFile: () => 'alt casing' }
    expect(loadReadme('/proj', fs)).toBe('alt casing')
  })
})

describe('buildTreeListing', () => {
  function lister(tree: Record<string, Array<{ name: string; isDirectory: boolean }>>): DirLister {
    return { list: (dir) => tree[dir] ?? [] }
  }

  it('lists top-level entries and one level into directories', () => {
    const l = lister({
      '/proj': [
        { name: 'src', isDirectory: true },
        { name: 'package.json', isDirectory: false }
      ],
      '/proj/src': [{ name: 'index.ts', isDirectory: false }]
    })
    const lines = buildTreeListing('/proj', l)
    expect(lines).toContain('src/')
    expect(lines).toContain('package.json')
    expect(lines).toContain('  src/index.ts')
  })

  it('skips node_modules, .git, dist, vendor', () => {
    const l = lister({
      '/proj': [
        { name: 'node_modules', isDirectory: true },
        { name: '.git', isDirectory: true },
        { name: 'dist', isDirectory: true },
        { name: 'vendor', isDirectory: true },
        { name: 'src', isDirectory: true }
      ],
      '/proj/src': []
    })
    const lines = buildTreeListing('/proj', l)
    expect(lines).toEqual(['src/'])
  })

  it('skips dotfiles', () => {
    const l = lister({ '/proj': [{ name: '.env', isDirectory: false }, { name: 'a.ts', isDirectory: false }] })
    expect(buildTreeListing('/proj', l)).toEqual(['a.ts'])
  })

  it('caps at 200 entries total', () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ name: `f${i}.ts`, isDirectory: false }))
    const l = lister({ '/proj': many })
    expect(buildTreeListing('/proj', l)).toHaveLength(200)
  })

  it('returns [] for an unreadable/empty folder', () => {
    const l = lister({})
    expect(buildTreeListing('/proj', l)).toEqual([])
  })
})

describe('buildAnalysisPrompt', () => {
  it('embeds the README, tree, and the exact ANALYSIS_INSTRUCTION', () => {
    const prompt = buildAnalysisPrompt('My cool app', ['src/', '  src/index.ts'])
    expect(prompt).toContain('My cool app')
    expect(prompt).toContain('src/')
    expect(prompt).toContain('  src/index.ts')
    expect(prompt).toContain(ANALYSIS_INSTRUCTION)
  })

  it('placeholders an empty README and empty tree', () => {
    const prompt = buildAnalysisPrompt('', [])
    expect(prompt).toContain('(no README.md found)')
    expect(prompt).toContain('(empty or unreadable)')
  })
})

describe('stripMarkdownFence', () => {
  it('strips a ```json fence', () => {
    expect(stripMarkdownFence('```json\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('strips a plain ``` fence', () => {
    expect(stripMarkdownFence('```\n{"a":1}\n```')).toBe('{"a":1}')
  })

  it('leaves unfenced text unchanged', () => {
    expect(stripMarkdownFence('{"a":1}')).toBe('{"a":1}')
  })
})

describe('parseAnalysisOutput', () => {
  const validAgents = [
    { alias: 'sable', role: 'iOS', focus: 'SwiftUI views', rationale: 'found ios/' },
    { alias: 'ripple', role: 'Backend', focus: 'API routes', rationale: 'found api/' }
  ]

  it('parses a `result` envelope with plain JSON content', () => {
    const envelope = JSON.stringify({ result: JSON.stringify({ summary: 'A todo app', agents: validAgents }) })
    const parsed = parseAnalysisOutput(envelope)
    expect(parsed).toEqual({ ok: true, summary: 'A todo app', agents: validAgents })
  })

  it('parses a `content` string envelope', () => {
    const envelope = JSON.stringify({ content: JSON.stringify({ summary: 'A todo app', agents: validAgents }) })
    expect(parseAnalysisOutput(envelope).ok).toBe(true)
  })

  it('parses a `content` array-of-blocks envelope (Messages API shape)', () => {
    const envelope = JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify({ summary: 'A todo app', agents: validAgents }) }]
    })
    expect(parseAnalysisOutput(envelope).ok).toBe(true)
  })

  it('tolerates a markdown-fenced inner JSON', () => {
    const inner = '```json\n' + JSON.stringify({ summary: 'A todo app', agents: validAgents }) + '\n```'
    const envelope = JSON.stringify({ result: inner })
    expect(parseAnalysisOutput(envelope)).toEqual({ ok: true, summary: 'A todo app', agents: validAgents })
  })

  it('fails on invalid outer JSON', () => {
    const result = parseAnalysisOutput('not json')
    expect(result.ok).toBe(false)
  })

  it('fails when the envelope has no result/content text', () => {
    const result = parseAnalysisOutput(JSON.stringify({ foo: 'bar' }))
    expect(result.ok).toBe(false)
  })

  it('fails when the inner text is not valid JSON', () => {
    const result = parseAnalysisOutput(JSON.stringify({ result: 'not json at all' }))
    expect(result.ok).toBe(false)
  })

  it('fails when summary/agents are missing', () => {
    const result = parseAnalysisOutput(JSON.stringify({ result: JSON.stringify({ summary: 'x' }) }))
    expect(result.ok).toBe(false)
  })

  it('clamps summary to 600 chars', () => {
    const longSummary = 'x'.repeat(1000)
    const envelope = JSON.stringify({ result: JSON.stringify({ summary: longSummary, agents: validAgents }) })
    const parsed = parseAnalysisOutput(envelope)
    expect(parsed.ok && parsed.summary.length).toBe(600)
  })

  it('caps agents at 5 and drops malformed entries', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ alias: `a${i}`, role: 'r', focus: 'f', rationale: 'x' }))
    const envelope = JSON.stringify({ result: JSON.stringify({ summary: 's', agents: many }) })
    const parsed = parseAnalysisOutput(envelope)
    expect(parsed.ok && parsed.agents).toHaveLength(5)
  })

  it('drops an "atlas" alias entry (the lead is implied)', () => {
    const withAtlas = [{ alias: 'Atlas', role: 'lead', focus: 'x', rationale: 'x' }, ...validAgents]
    const envelope = JSON.stringify({ result: JSON.stringify({ summary: 's', agents: withAtlas }) })
    const parsed = parseAnalysisOutput(envelope)
    expect(parsed.ok && parsed.agents.map((a) => a.alias)).not.toContain('atlas')
  })

  it('fails when fewer than 2 usable agents remain', () => {
    const envelope = JSON.stringify({ result: JSON.stringify({ summary: 's', agents: [validAgents[0]] }) })
    expect(parseAnalysisOutput(envelope).ok).toBe(false)
  })

  it('lowercases aliases', () => {
    const envelope = JSON.stringify({
      result: JSON.stringify({ summary: 's', agents: [{ alias: 'Sable', role: 'r', focus: 'f', rationale: 'x' }, validAgents[1]] })
    })
    const parsed = parseAnalysisOutput(envelope)
    expect(parsed.ok && parsed.agents[0].alias).toBe('sable')
  })
})

describe('analyzeProject (orchestration)', () => {
  const fsAdapter = { exists: () => false, readFile: () => '' }
  const lister: DirLister = { list: () => [] }

  it('skips (ok:false) without running anything when claude is not on PATH', async () => {
    const deps: AnalyzeProjectDeps = { which: vi.fn(async () => null), runClaude: vi.fn() }
    const result = await analyzeProject('/proj', deps, fsAdapter, lister)
    expect(result).toEqual({ ok: false, reason: 'claude is not installed on this Mac' })
    expect(deps.runClaude).not.toHaveBeenCalled()
  })

  it('runs claude and parses a successful result', async () => {
    const agents = [
      { alias: 'sable', role: 'iOS', focus: 'views', rationale: 'x' },
      { alias: 'ripple', role: 'Backend', focus: 'api', rationale: 'y' }
    ]
    const deps: AnalyzeProjectDeps = {
      which: vi.fn(async () => '/usr/local/bin/claude'),
      runClaude: vi.fn(async () => JSON.stringify({ result: JSON.stringify({ summary: 'An app', agents }) }))
    }
    const result = await analyzeProject('/proj', deps, fsAdapter, lister)
    expect(result).toEqual({ ok: true, summary: 'An app', agents })
  })

  it('never throws — a runClaude rejection becomes ok:false', async () => {
    const deps: AnalyzeProjectDeps = {
      which: vi.fn(async () => '/usr/local/bin/claude'),
      runClaude: vi.fn(async () => {
        throw Object.assign(new Error('claude analysis timed out'), { stderr: '', timedOut: true })
      })
    }
    const result = await analyzeProject('/proj', deps, fsAdapter, lister)
    expect(result.ok).toBe(false)
    expect((result as { reason: string }).reason).toMatch(/timed out/)
  })

  it('never throws — a which() rejection becomes ok:false', async () => {
    const deps: AnalyzeProjectDeps = {
      which: vi.fn(async () => {
        throw new Error('boom')
      }),
      runClaude: vi.fn()
    }
    const result = await analyzeProject('/proj', deps, fsAdapter, lister)
    expect(result.ok).toBe(false)
  })
})
