/**
 * First-party (builtin) hooks.
 *
 * Unlike config.json command hooks, these are assembled in code and always
 * available. They are prepended to the resolved hook list at the runtime
 * composition root so they run before user-configured hooks.
 */

import type { ResolvedHook } from '../hook-engine.js'
import type { QualityConfig } from '../../config/kun-config.js'
import { buildDesignQualityHook } from './design-quality-hook.js'

export type BuiltinHookInput = {
  quality?: QualityConfig
}

/** Assemble the builtin hooks enabled by the given runtime config. */
export function buildBuiltinHooks(input: BuiltinHookInput): ResolvedHook[] {
  const hooks: ResolvedHook[] = []
  if (input.quality) {
    const designQuality = buildDesignQualityHook(input.quality)
    if (designQuality) hooks.push(designQuality)
  }
  return hooks
}

export { buildDesignQualityHook, matchesGlob } from './design-quality-hook.js'
