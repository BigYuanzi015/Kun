/**
 * Public entry point for the design-quality detector.
 *
 * `detectFrontend` scans a single source file's text and returns findings
 * filtered by strictness and the ignore list. It is pure and synchronous —
 * safe to call from a PostToolUse hook on the tool-result path.
 */

import { DESIGN_RULES, type RuleContext } from './rules.js'
import {
  DESIGN_STRICTNESS_LEVELS,
  type DesignFinding,
  type DesignRuleMeta,
  type DesignStrictness,
  type DetectOptions
} from './types.js'

/** File extensions the detector understands. Others return no findings. */
export const FRONTEND_EXTENSIONS: readonly string[] = [
  'html',
  'htm',
  'xhtml',
  'css',
  'scss',
  'sass',
  'less',
  'jsx',
  'tsx',
  'vue',
  'svelte',
  'astro',
  'svg'
]

const FRONTEND_EXT_SET = new Set(FRONTEND_EXTENSIONS)

/** Lower-cased extension (no dot) of a path, or '' when there is none. */
export function extensionOf(filePath: string | undefined): string {
  if (!filePath) return ''
  const base = filePath.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/** True when a path looks like a frontend source file worth scanning. */
export function isFrontendPath(filePath: string | undefined): boolean {
  return FRONTEND_EXT_SET.has(extensionOf(filePath))
}

function strictnessRank(level: DesignStrictness): number {
  const idx = DESIGN_STRICTNESS_LEVELS.indexOf(level)
  return idx < 0 ? 1 : idx
}

/**
 * Scan source text for design-quality findings. Returns an empty array
 * when the file is not frontend (and a path was provided), nothing fires,
 * or everything was filtered out. Never throws.
 */
export function detectFrontend(source: string, options: DetectOptions = {}): DesignFinding[] {
  if (options.filePath !== undefined && !isFrontendPath(options.filePath)) return []
  if (typeof source !== 'string' || source.length === 0) return []

  const strictness = options.strictness ?? 'standard'
  const want = strictnessRank(strictness)
  const ignore = new Set(options.ignoreRules ?? [])
  const ext = extensionOf(options.filePath)
  const lines = source.split(/\r\n|\r|\n/)
  const ctx: RuleContext = {
    source,
    lines,
    ext,
    ...(options.designContext ? { designContext: options.designContext } : {})
  }

  const findings: DesignFinding[] = []
  for (const rule of DESIGN_RULES) {
    if (ignore.has(rule.id)) continue
    if (strictnessRank(rule.minStrictness) > want) continue
    let hits
    try {
      hits = rule.run(ctx)
    } catch {
      // A single buggy rule must never break the whole scan.
      continue
    }
    for (const hit of hits) {
      findings.push({
        ruleId: rule.id,
        category: rule.category,
        severity: rule.severity,
        message: hit.message ?? rule.message,
        line: hit.line,
        snippet: hit.snippet
      })
    }
  }

  const seen = new Set<string>()
  const deduped = findings.filter((f) => {
    const key = `${f.ruleId}:${f.line}:${f.snippet}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  deduped.sort((a, b) => a.line - b.line || a.ruleId.localeCompare(b.ruleId))

  const max = options.maxFindings && options.maxFindings > 0 ? options.maxFindings : 12
  return deduped.slice(0, max)
}

/** Static metadata for every rule, e.g. for a settings UI. */
export function listDesignRules(): DesignRuleMeta[] {
  return DESIGN_RULES.map((rule) => ({
    id: rule.id,
    category: rule.category,
    severity: rule.severity,
    minStrictness: rule.minStrictness,
    title: rule.title
  }))
}
