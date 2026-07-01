import { describe, expect, it } from 'vitest'
import { buildDesignQualityHook, matchesGlob } from './design-quality-hook.js'
import type { HookInvocation, HookResult } from '../hook-engine.js'
import type { QualityConfig } from '../../config/kun-config.js'

const baseConfig: QualityConfig = {
  enabled: true,
  strictness: 'standard',
  ignoreRules: [],
  ignoreFiles: [],
  maxFindings: 12
}

function postToolUse(args: Record<string, unknown>, output: unknown, isError = false): HookInvocation {
  return {
    phase: 'PostToolUse',
    call: { callId: 'c1', toolName: 'write', arguments: args },
    context: { threadId: 't', turnId: 'u', workspace: '/ws', approvalPolicy: 'never' } as never,
    result: { output, isError }
  }
}

function runHook(config: QualityConfig, invocation: HookInvocation): HookResult | void {
  const hook = buildDesignQualityHook(config)
  if (!hook || !('run' in hook)) throw new Error('expected a function hook')
  return hook.run(invocation) as HookResult | void
}

describe('matchesGlob', () => {
  it('matches ** across segments and * within a segment', () => {
    expect(matchesGlob('**/vendor/**', 'src/vendor/x.css')).toBe(true)
    expect(matchesGlob('*.css', 'a.css')).toBe(true)
    expect(matchesGlob('*.css', 'dir/a.css')).toBe(false)
    expect(matchesGlob('src/**/*.tsx', 'src/a/b/c.tsx')).toBe(true)
    expect(matchesGlob('build/**', 'src/app.tsx')).toBe(false)
  })
})

describe('buildDesignQualityHook', () => {
  it('returns null when disabled', () => {
    expect(buildDesignQualityHook({ ...baseConfig, enabled: false })).toBeNull()
  })

  it('declares a PostToolUse hook scoped to write/edit', () => {
    const hook = buildDesignQualityHook(baseConfig)
    expect(hook?.phase).toBe('PostToolUse')
    expect(hook?.toolNames).toEqual(['write', 'edit'])
  })

  it('folds findings into output for a flawed frontend file', () => {
    const content = '.x { background: linear-gradient(90deg,#7c3aed,#2563eb); }'
    const result = runHook(
      baseConfig,
      postToolUse({ path: '/ws/a.css', content }, { path: '/ws/a.css', relative_path: 'a.css' })
    )
    expect(result && typeof result === 'object').toBe(true)
    const review = (result as { output: Record<string, unknown> }).output.design_quality_review as {
      findings: unknown[]
    }
    expect(review.findings.length).toBeGreaterThan(0)
    // Preserves the original output fields.
    expect((result as { output: Record<string, unknown> }).output.relative_path).toBe('a.css')
  })

  it('returns void for a clean frontend file', () => {
    const content = 'body { color: #111; font-family: "Albert Sans", sans-serif; }'
    const result = runHook(
      baseConfig,
      postToolUse({ path: '/ws/a.css', content }, { path: '/ws/a.css', relative_path: 'a.css' })
    )
    expect(result).toBeUndefined()
  })

  it('ignores non-frontend files', () => {
    const result = runHook(
      baseConfig,
      postToolUse(
        { path: '/ws/a.ts', content: 'background: linear-gradient(90deg,#7c3aed,#2563eb);' },
        { path: '/ws/a.ts', relative_path: 'a.ts' }
      )
    )
    expect(result).toBeUndefined()
  })

  it('skips errored tool results', () => {
    const result = runHook(
      baseConfig,
      postToolUse({ path: '/ws/a.css', content: 'x' }, { error: 'nope' }, true)
    )
    expect(result).toBeUndefined()
  })

  it('honors ignoreFiles globs', () => {
    const content = '.x { background: linear-gradient(90deg,#7c3aed,#2563eb); }'
    const result = runHook(
      { ...baseConfig, ignoreFiles: ['vendor/**'] },
      postToolUse(
        { path: '/ws/vendor/a.css', content },
        { path: '/ws/vendor/a.css', relative_path: 'vendor/a.css' }
      )
    )
    expect(result).toBeUndefined()
  })
})
