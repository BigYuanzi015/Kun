import { describe, expect, it } from 'vitest'
import { ToolStormBreaker } from './tool-storm-breaker.js'

describe('ToolStormBreaker', () => {
  it('suppresses repeated interactive user-input gates in one turn', () => {
    const breaker = new ToolStormBreaker({ interactiveThreshold: 2 })

    expect(
      breaker.inspect({ callId: 'c1', toolName: 'user_input', arguments: { prompt: 'one' } })
    ).toEqual({ suppress: false })
    expect(
      breaker.inspect({ callId: 'c2', toolName: 'request_user_input', arguments: { prompt: 'two' } })
    ).toEqual({ suppress: false })
    expect(
      breaker.inspect({ callId: 'c3', toolName: 'user_input', arguments: { prompt: 'three' } })
    ).toMatchObject({
      suppress: true,
      reason: expect.stringContaining('interactive prompt guard')
    })
  })

  it('resets the interactive prompt count between turns', () => {
    const breaker = new ToolStormBreaker({ interactiveThreshold: 1 })

    expect(
      breaker.inspect({ callId: 'c1', toolName: 'user_input', arguments: { prompt: 'one' } })
    ).toEqual({ suppress: false })
    expect(
      breaker.inspect({ callId: 'c2', toolName: 'user_input', arguments: { prompt: 'two' } })
    ).toMatchObject({ suppress: true })

    breaker.reset()

    expect(
      breaker.inspect({ callId: 'c3', toolName: 'user_input', arguments: { prompt: 'new turn' } })
    ).toEqual({ suppress: false })
  })
})
