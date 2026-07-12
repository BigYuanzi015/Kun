import { describe, expect, it, vi } from 'vitest'
import { applyTrustedComposerExecutionChange } from './FloatingComposerExecutionPicker'

describe('FloatingComposer execution security', () => {
  it('does not apply bypass mode from a Direct DOM synthetic click', () => {
    const onChange = vi.fn()
    const bypass = { approvalPolicy: 'auto' as const, sandboxMode: 'danger-full-access' as const }

    expect(applyTrustedComposerExecutionChange({ isTrusted: false }, bypass, onChange)).toBe(false)
    expect(onChange).not.toHaveBeenCalled()

    expect(applyTrustedComposerExecutionChange({ isTrusted: true }, bypass, onChange)).toBe(true)
    expect(onChange).toHaveBeenCalledWith(bypass)
  })
})
