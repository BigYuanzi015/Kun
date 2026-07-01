/**
 * Design-quality detector — Kun's first-party frontend output linter.
 *
 * Flags AI-generated design "tells" and craft issues in frontend source
 * (HTML / CSS / JSX / TSX / SVG) using deterministic, source-based rules.
 * Used by the builtin PostToolUse hook to feed findings back to the model
 * so it self-corrects, and available to other surfaces (settings, SDD).
 *
 * Design heuristics are reimplemented from the public impeccable
 * (Apache-2.0) lint rules — algorithms only, in Kun's own naming and copy.
 */

export {
  detectFrontend,
  isFrontendPath,
  extensionOf,
  listDesignRules,
  FRONTEND_EXTENSIONS
} from './detect.js'
export { DESIGN_RULES } from './rules.js'
export {
  DESIGN_STRICTNESS_LEVELS,
  type DesignFinding,
  type DesignFindingSeverity,
  type DesignRuleCategory,
  type DesignRuleMeta,
  type DesignContext,
  type DesignStrictness,
  type DetectOptions
} from './types.js'
