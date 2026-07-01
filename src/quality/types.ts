/**
 * Design-quality detector contracts.
 *
 * The detector is a dependency-free, source-based scanner that flags
 * AI-generated frontend "tells" (slop) and general design-quality issues.
 * It runs in the Node-only Kun runtime, so it works on raw source text
 * (HTML / CSS / JSX / TSX / SVG) — never on a rendered DOM or computed
 * styles. Rules trade a little recall for high precision so the findings
 * fed back to the model are trustworthy.
 */

/** How loudly a finding should be treated. `advisory` rules are heuristic. */
export type DesignFindingSeverity = 'warning' | 'advisory'

/**
 * `slop` = AI-generated tell (purple gradients, bounce easing, ...).
 * `quality` = general craft issue (line length, heading order, ...).
 * `drift` = divergence from the project's declared design context.
 */
export type DesignRuleCategory = 'slop' | 'quality' | 'drift'

/**
 * Detection aggressiveness. `relaxed` only fires the most reliable slop
 * tells; `standard` adds craft + clear slop; `strict` adds heuristic rules
 * that can occasionally over-fire.
 */
export type DesignStrictness = 'relaxed' | 'standard' | 'strict'

export const DESIGN_STRICTNESS_LEVELS: readonly DesignStrictness[] = [
  'relaxed',
  'standard',
  'strict'
]

/** A single design issue found in a source file. */
export type DesignFinding = {
  ruleId: string
  category: DesignRuleCategory
  severity: DesignFindingSeverity
  /** Human-readable, actionable message (zh). */
  message: string
  /** 1-based line number the issue was found on. */
  line: number
  /** Short surrounding source context (trimmed, capped). */
  snippet: string
}

/**
 * Project design intent the detector can check source against. Sourced
 * from the SDD requirement's design context or the workspace palette.
 * All fields optional — drift rules no-op when their input is absent.
 */
export type DesignContext = {
  designType?: 'brand' | 'product'
  brandColor?: string
  tone?: readonly string[]
  /** Font families the project sanctions; others flag as drift. */
  allowedFonts?: readonly string[]
}

export type DetectOptions = {
  /** Used for extension gating, ignore-glob matching, and finding context. */
  filePath?: string
  strictness?: DesignStrictness
  /** Rule ids to suppress entirely. */
  ignoreRules?: readonly string[]
  designContext?: DesignContext
  /** Hard cap on returned findings (default 12). */
  maxFindings?: number
}

/** Static metadata describing one detector rule (for UIs and docs). */
export type DesignRuleMeta = {
  id: string
  category: DesignRuleCategory
  severity: DesignFindingSeverity
  /** Lowest strictness at which this rule fires. */
  minStrictness: DesignStrictness
  /** Short zh title for settings UIs. */
  title: string
}
