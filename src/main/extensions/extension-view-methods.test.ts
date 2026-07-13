import { describe, expect, it } from 'vitest'
import { isAllowedExtensionViewMethod } from './extension-view-methods'

describe('extension View method policy', () => {
  it('allows bounded view operations and denies credential/registration operations', () => {
    expect(isAllowedExtensionViewMethod('ui.getTheme')).toBe(true)
    expect(isAllowedExtensionViewMethod('authentication.listAccounts')).toBe(true)
    expect(isAllowedExtensionViewMethod('authentication.getSession')).toBe(false)
    expect(isAllowedExtensionViewMethod('authentication.authenticatedFetch')).toBe(false)
    expect(isAllowedExtensionViewMethod('authentication.createSession')).toBe(false)
    expect(isAllowedExtensionViewMethod('authentication.cancelSession')).toBe(false)
    expect(isAllowedExtensionViewMethod('authentication.deleteAccount')).toBe(false)
    expect(isAllowedExtensionViewMethod('authentication.revealSecret')).toBe(false)
    expect(isAllowedExtensionViewMethod('tools.register')).toBe(false)
    expect(isAllowedExtensionViewMethod('modelProviders.register')).toBe(false)
  })
})
