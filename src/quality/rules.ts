/**
 * Design-quality rule registry.
 *
 * Each rule is a pure function over source text that returns raw hits
 * (line + snippet, plus an optional per-hit message override). The facade
 * in `detect.ts` attaches the rule's id/category/severity, filters by
 * strictness + ignore list, dedupes, and caps. Rules are reimplemented
 * from the public design-lint heuristics popularized by impeccable
 * (Apache-2.0) — algorithms only, expressed in Kun's own naming and zh copy.
 *
 * Because the Kun runtime has no DOM, every rule works on raw source:
 * CSS declarations, Tailwind utility classes, and markup tags. Rules
 * favor precision over recall so findings stay trustworthy.
 */

import {
  describeColor,
  extractColorLiterals,
  isPurpleOrBlueHue,
  type ColorInfo
} from './color.js'
import type {
  DesignContext,
  DesignFindingSeverity,
  DesignRuleCategory,
  DesignStrictness
} from './types.js'

export type RuleContext = {
  source: string
  lines: readonly string[]
  /** Lower-cased file extension without the dot (e.g. `tsx`), or ''. */
  ext: string
  designContext?: DesignContext
}

export type RuleHit = {
  line: number
  snippet: string
  /** Overrides the rule's default message for this hit. */
  message?: string
}

export type DesignRule = {
  id: string
  category: DesignRuleCategory
  severity: DesignFindingSeverity
  minStrictness: DesignStrictness
  title: string
  /** Default zh message; a hit may override it. */
  message: string
  run: (ctx: RuleContext) => RuleHit[]
}

const MARKUP_EXTS = new Set(['html', 'htm', 'xhtml', 'svg', 'vue', 'svelte', 'astro'])
// Component fragments animate mostly via Tailwind `animate-*` (paired with the
// `motion-reduce:` variant) and keep the reduced-motion guard in global CSS, so
// the reduced-motion rule is scoped down for them — see missingReducedMotion.
const COMPONENT_EXTS = new Set(['jsx', 'tsx', 'vue', 'svelte', 'astro'])
const GENERIC_FONTS = new Set([
  'sans-serif',
  'serif',
  'monospace',
  'system-ui',
  'ui-sans-serif',
  'ui-serif',
  'ui-monospace',
  '-apple-system',
  'blinkmacsystemfont',
  'inherit',
  'cursive',
  'fantasy'
])
const CHROMATIC_TW_FAMILIES =
  'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose'

function snippetOf(line: string): string {
  const trimmed = line.trim()
  return trimmed.length > 140 ? `${trimmed.slice(0, 137)}…` : trimmed
}

/**
 * A warm, light, near-neutral color — the cream/sand/paper AI-default family.
 * HSL saturation inflates toward 1 as lightness nears white, so for RGB-derived
 * colors we judge raw channel spread (lightness-independent) plus a warm
 * ordering (r ≥ g ≥ b) instead. The OKLCH path already carries low chroma.
 */
function isWarmLightNeutral(color: ColorInfo): boolean {
  if (color.lightness <= 0.88) return false
  if (color.hue == null || color.hue < 25 || color.hue > 105) return false
  if (color.rgb) {
    const { r, g, b } = color.rgb
    const spread = Math.max(r, g, b) - Math.min(r, g, b)
    return spread > 3 && spread < 60 && r >= g && g >= b
  }
  return color.saturation > 0.01 && color.saturation < 0.22
}

/** Split a CSS value on commas that are not nested inside parentheses. */
function splitTopLevelCommas(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of value) {
    if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (current.trim()) parts.push(current)
  return parts
}

/** Run a per-line regex and emit a hit for each match. */
function eachLineMatch(
  ctx: RuleContext,
  re: RegExp,
  predicate?: (m: RegExpExecArray, line: string) => boolean,
  messageFor?: (m: RegExpExecArray) => string
): RuleHit[] {
  const hits: RuleHit[] = []
  for (let i = 0; i < ctx.lines.length; i++) {
    const line = ctx.lines[i]
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(line)) !== null) {
      if (!predicate || predicate(m, line)) {
        const hit: RuleHit = { line: i + 1, snippet: snippetOf(line) }
        if (messageFor) hit.message = messageFor(m)
        hits.push(hit)
      }
      if (!re.global) break
    }
  }
  return hits
}

// ── slop: the unmistakable AI tells ───────────────────────────────────────

const purpleBlueGradient: DesignRule = {
  id: 'slop-purple-blue-gradient',
  category: 'slop',
  severity: 'warning',
  minStrictness: 'relaxed',
  title: '紫→蓝渐变',
  message: '紫→蓝（violet/indigo→blue）渐变是最典型的 AI 生成痕迹。换一个有品牌依据的配色方向，或用单色。',
  run: (ctx) => {
    const hits: RuleHit[] = []
    // Tailwind: a gradient direction utility plus from-/to- in the violet→blue band.
    const twGradient = /\b(?:bg-gradient-to-[a-z]{1,2}|bg-linear-to-[a-z]{1,2}|bg-\[(?:linear|radial|conic)-gradient)/
    const twFrom = /\bfrom-(?:violet|purple|fuchsia|indigo|blue)-\d{2,3}\b/
    const twTo = /\bto-(?:violet|purple|fuchsia|indigo|blue|sky|cyan)-\d{2,3}\b/
    for (let i = 0; i < ctx.lines.length; i++) {
      const line = ctx.lines[i]
      if (twGradient.test(line) && twFrom.test(line) && twTo.test(line)) {
        hits.push({ line: i + 1, snippet: snippetOf(line) })
        continue
      }
      // CSS: a gradient whose chromatic stops are all violet/blue. Achromatic
      // stops (white/black/grey, hue == null) are ignored so the classic
      // violet→blue→white hero gradient still flags.
      const grad = /(?:linear|radial|conic)-gradient\(([^;]*?)\)/i.exec(line)
      if (grad) {
        const chromatic = extractColorLiterals(grad[1])
          .map(describeColor)
          .filter((c): c is ColorInfo => c != null && c.hue != null)
        if (chromatic.length >= 2 && chromatic.every((c) => isPurpleOrBlueHue(c.hue))) {
          hits.push({ line: i + 1, snippet: snippetOf(line) })
        }
      }
    }
    return hits
  }
}

const bounceEasing: DesignRule = {
  id: 'slop-bounce-elastic-easing',
  category: 'slop',
  severity: 'warning',
  minStrictness: 'relaxed',
  title: '弹跳/橡皮筋缓动',
  message: '弹跳/橡皮筋缓动（cubic-bezier 控制点越界 [0,1]）显得过时。改用 ease-out 指数曲线（quart/quint/expo）。',
  run: (ctx) =>
    eachLineMatch(
      ctx,
      /cubic-bezier\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)/gi,
      (m) => {
        const y1 = parseFloat(m[2])
        const y2 = parseFloat(m[4])
        return y1 < -0.02 || y1 > 1.02 || y2 < -0.02 || y2 > 1.02
      }
    )
}

const creamDefaultBg: DesignRule = {
  id: 'slop-cream-default-bg',
  category: 'slop',
  severity: 'warning',
  minStrictness: 'standard',
  title: '米/沙/纸色背景',
  message: '米/沙/纸/象牙色背景是 2026 的 AI 默认底色。用品牌色、纯中性色（chroma 0），或明显属于品牌的中调色。',
  run: (ctx) => {
    const hits: RuleHit[] = []
    // A cream-ish token NAME, capturing its declared value — we still verify the
    // value is actually a warm light neutral so `--vanilla: #f00` is not flagged.
    const tokenDecl =
      /--(?:paper|cream|sand|bone|linen|parchment|wheat|biscuit|ivory|flour|eggshell|oat|almond|vanilla)\b\s*:\s*([^;{]+)/i
    const bgDecl = /background(?:-color)?\s*:\s*([^;{]+)/i
    for (let i = 0; i < ctx.lines.length; i++) {
      const line = ctx.lines[i]
      const token = tokenDecl.exec(line)
      if (token) {
        const color = extractColorLiterals(token[1]).map(describeColor).find(Boolean)
        if (color && isWarmLightNeutral(color)) {
          hits.push({ line: i + 1, snippet: snippetOf(line) })
        }
        continue
      }
      const bg = bgDecl.exec(line)
      if (bg) {
        const color = extractColorLiterals(bg[1]).map(describeColor).find(Boolean)
        if (color && isWarmLightNeutral(color)) {
          hits.push({ line: i + 1, snippet: snippetOf(line) })
        }
      }
    }
    return hits
  }
}

const sideTabBorder: DesignRule = {
  id: 'slop-side-tab-border',
  category: 'slop',
  severity: 'warning',
  minStrictness: 'standard',
  title: '侧边强调条',
  message: '单侧彩色粗边框 + 圆角是典型的「侧边强调条」AI 痕迹。改用整体背景/底色变化或更克制的指示。',
  run: (ctx) => {
    const sideBorder = /\bborder-(?:l|r|t|b|s|e)-(?:2|4|8)\b/
    const rounded = /\brounded(?:-|\b)/
    const colored = new RegExp(`\\bborder-(?:${CHROMATIC_TW_FAMILIES})-\\d{2,3}\\b`)
    return ctx.lines.reduce<RuleHit[]>((acc, line, i) => {
      if (sideBorder.test(line) && rounded.test(line) && colored.test(line)) {
        acc.push({ line: i + 1, snippet: snippetOf(line) })
      }
      return acc
    }, [])
  }
}

const gradientText: DesignRule = {
  id: 'slop-gradient-text',
  category: 'slop',
  severity: 'advisory',
  minStrictness: 'standard',
  title: '渐变文字',
  message: '渐变文字（背景裁剪到文字）被过度使用且常有可读性/对比问题。仅在真正增益时保留。',
  run: (ctx) =>
    eachLineMatch(ctx, /\bbg-clip-text\b|(?:-webkit-)?background-clip\s*:\s*text\b/gi)
}

const grayTextOnColor: DesignRule = {
  id: 'slop-gray-text-on-color',
  category: 'slop',
  severity: 'advisory',
  minStrictness: 'strict',
  title: '彩色底上的灰字',
  message: '彩色背景上用灰字会发灰发脏。用背景同色系的更深色，或文字色的透明度，而不是中性灰。',
  run: (ctx) => {
    const grayText = /\btext-(?:gray|slate|zinc|neutral|stone)-\d{2,3}\b/
    const colorBg = new RegExp(`\\bbg-(?:${CHROMATIC_TW_FAMILIES})-\\d{2,3}\\b`)
    return ctx.lines.reduce<RuleHit[]>((acc, line, i) => {
      if (grayText.test(line) && colorBg.test(line)) {
        acc.push({ line: i + 1, snippet: snippetOf(line) })
      }
      return acc
    }, [])
  }
}

const darkColoredGlow: DesignRule = {
  id: 'slop-dark-colored-glow',
  category: 'slop',
  severity: 'advisory',
  minStrictness: 'strict',
  title: '彩色辉光',
  message: '彩色 box-shadow 辉光是常见的暗色 AI 痕迹。用中性阴影表达层级，把发光留给真正需要的元素。',
  run: (ctx) => {
    const hits: RuleHit[] = []
    const decl = /box-shadow\s*:\s*([^;{]+)/gi
    for (let i = 0; i < ctx.lines.length; i++) {
      const line = ctx.lines[i]
      decl.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = decl.exec(line)) !== null) {
        // box-shadow is `[inset] offset-x offset-y [blur] [spread] color`, with
        // multiple comma-separated layers. The blur radius is the 3rd length —
        // don't mistake a large offset for a glow.
        for (const layer of splitTopLevelCommas(m[1])) {
          const chromatic = extractColorLiterals(layer).some((c) => {
            const info = describeColor(c)
            return info != null && info.saturation > 0.35
          })
          if (!chromatic) continue
          // Strip the color so only geometry numbers remain (offsets/blur/spread,
          // which may be unitless `0` or px/rem/em). Blur is the 3rd length.
          const geometry = layer
            .replace(/#[0-9a-f]{3,8}\b/gi, ' ')
            .replace(/(?:rgba?|hsla?|oklch)\([^)]*\)/gi, ' ')
          const lengths = [...geometry.matchAll(/-?\d+(?:\.\d+)?(?:px|rem|em)?/g)]
            .map((x) => parseFloat(x[0]))
            .filter((n) => !Number.isNaN(n))
          const blur = lengths.length >= 3 ? lengths[2] : 0
          if (blur >= 8) {
            hits.push({ line: i + 1, snippet: snippetOf(line) })
            break
          }
        }
      }
    }
    return hits
  }
}

// ── quality: general craft ─────────────────────────────────────────────────

const overusedFont: DesignRule = {
  id: 'quality-overused-font',
  category: 'quality',
  severity: 'warning',
  minStrictness: 'standard',
  title: '被滥用的字体',
  message: 'Inter / Arial / Roboto / Helvetica 等是被滥用的默认字体。挑一个有性格、贴合品牌的字族作为主字体。',
  run: (ctx) =>
    eachLineMatch(
      ctx,
      /font-family\s*:\s*['"]?\s*(Inter|Arial|Roboto|Helvetica Neue|Helvetica)\b/gi,
      undefined,
      (m) => `主字体使用了被滥用的「${m[1]}」。挑一个有性格、贴合品牌的字族。`
    )
}

const heroFontCeiling: DesignRule = {
  id: 'quality-hero-font-ceiling',
  category: 'quality',
  severity: 'warning',
  minStrictness: 'standard',
  title: 'Display 字号上限',
  message: 'Display 标题 > 6rem（约 96px）像在喊叫而非设计。收回到 6rem 以内。',
  run: (ctx) => {
    const hits: RuleHit[] = []
    const remSize = /font-size\s*:\s*([\d.]+)rem/gi
    const clampBody = /font-size\s*:\s*clamp\(([^)]*)\)/gi
    const twArb = /\btext-\[([\d.]+)rem\]/g
    const tw9xl = /\btext-9xl\b/
    for (let i = 0; i < ctx.lines.length; i++) {
      const line = ctx.lines[i]
      const over = (re: RegExp): boolean => {
        re.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = re.exec(line)) !== null) if (parseFloat(m[1]) > 6) return true
        return false
      }
      // clamp(min, preferred, max): inspect every rem argument, not just the
      // last — `clamp(7rem, 5vw, 4rem)` has an oversized minimum.
      const clampOver = (): boolean => {
        clampBody.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = clampBody.exec(line)) !== null) {
          const rems = [...m[1].matchAll(/([\d.]+)rem/g)].map((x) => parseFloat(x[1]))
          if (rems.length > 0 && Math.max(...rems) > 6) return true
        }
        return false
      }
      if (over(remSize) || clampOver() || over(twArb) || tw9xl.test(line)) {
        hits.push({ line: i + 1, snippet: snippetOf(line) })
      }
    }
    return hits
  }
}

const trackingFloor: DesignRule = {
  id: 'quality-display-tracking-floor',
  category: 'quality',
  severity: 'warning',
  minStrictness: 'standard',
  title: '字距下限',
  message: '字距 < -0.04em 会让字母粘连。紧凑的 grotesque display 用 -0.02 ~ -0.03em 已足够。',
  run: (ctx) => {
    const css = /letter-spacing\s*:\s*(-[\d.]+)em/gi
    const tw = /\btracking-\[(-[\d.]+)em\]/g
    const hits: RuleHit[] = []
    for (let i = 0; i < ctx.lines.length; i++) {
      const line = ctx.lines[i]
      const tooTight = (re: RegExp): boolean => {
        re.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = re.exec(line)) !== null) if (parseFloat(m[1]) < -0.04) return true
        return false
      }
      if (tooTight(css) || tooTight(tw)) hits.push({ line: i + 1, snippet: snippetOf(line) })
    }
    return hits
  }
}

const lineLength: DesignRule = {
  id: 'quality-body-line-length',
  category: 'quality',
  severity: 'warning',
  minStrictness: 'standard',
  title: '正文行宽',
  message: '正文行宽 > 75ch 会降低可读性。把 max-width 控制在 65–75ch。',
  run: (ctx) => {
    const css = /max-width\s*:\s*([\d.]+)ch/gi
    const tw = /\bmax-w-\[([\d.]+)ch\]/g
    const hits: RuleHit[] = []
    for (let i = 0; i < ctx.lines.length; i++) {
      const line = ctx.lines[i]
      const tooWide = (re: RegExp): boolean => {
        re.lastIndex = 0
        let m: RegExpExecArray | null
        while ((m = re.exec(line)) !== null) if (parseFloat(m[1]) > 75) return true
        return false
      }
      if (tooWide(css) || tooWide(tw)) hits.push({ line: i + 1, snippet: snippetOf(line) })
    }
    return hits
  }
}

const arbitraryZIndex: DesignRule = {
  id: 'quality-arbitrary-z-index',
  category: 'quality',
  severity: 'warning',
  minStrictness: 'standard',
  title: '魔法 z-index',
  message: '魔法 z-index（999 / 9999）说明缺少层级体系。建立语义化刻度（dropdown → sticky → modal → toast → tooltip）。',
  run: (ctx) =>
    eachLineMatch(
      ctx,
      /z-index\s*:\s*(\d{3,})|(?<![\w-])z-\[(\d{3,})\]/gi,
      (m) => {
        const n = parseInt(m[1] ?? m[2], 10)
        return n >= 999
      }
    )
}

const skippedHeading: DesignRule = {
  id: 'quality-skipped-heading-level',
  category: 'quality',
  severity: 'warning',
  minStrictness: 'standard',
  title: '标题层级跳级',
  message: '标题层级跳级（如 h1 直接到 h3）破坏文档结构与可访问性。逐级递进。',
  run: (ctx) => {
    if (!MARKUP_EXTS.has(ctx.ext) && ctx.ext !== 'jsx' && ctx.ext !== 'tsx') return []
    const hits: RuleHit[] = []
    const re = /<h([1-6])\b/gi
    let prev = 0
    for (let i = 0; i < ctx.lines.length; i++) {
      const line = ctx.lines[i]
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(line)) !== null) {
        const level = parseInt(m[1], 10)
        if (prev > 0 && level - prev > 1) {
          hits.push({
            line: i + 1,
            snippet: snippetOf(line),
            message: `标题从 h${prev} 跳到 h${level}，跳过了 h${prev + 1}。逐级递进以保持结构与可访问性。`
          })
        }
        prev = level
      }
    }
    return hits
  }
}

const missingReducedMotion: DesignRule = {
  id: 'quality-missing-reduced-motion',
  category: 'quality',
  severity: 'warning',
  minStrictness: 'standard',
  title: '缺少 reduced-motion',
  message: '存在动画但缺少 `@media (prefers-reduced-motion: reduce)` 兜底。这是无障碍必备：提供淡入或瞬时替代。',
  run: (ctx) => {
    if (/prefers-reduced-motion/i.test(ctx.source)) return []
    // In component files, Tailwind `animate-*` pairs with `motion-reduce:` and
    // the global guard lives elsewhere — flag only real CSS animation
    // primitives there. Stylesheets and single-file HTML get the full check
    // (transitions + Tailwind utilities), anchored so `data-animate-*` and
    // `animation:/transition: none` do not false-fire.
    const motion = COMPONENT_EXTS.has(ctx.ext)
      ? /@keyframes\b|animation\s*:\s*(?!\s*none\b)|animation-name\s*:\s*(?!\s*none\b)|animation-duration\s*:\s*(?!\s*0s\b)\d/i
      : /@keyframes\b|animation\s*:\s*(?!\s*none\b)|animation-name\s*:\s*(?!\s*none\b)|animation-duration\s*:\s*(?!\s*0s\b)\d|transition\s*:\s*(?!\s*none\b)[^;{]*\d|transition-duration\s*:\s*(?!\s*0s\b)\d|(?:^|[\s"'`])animate-(?!none\b)[a-z]/i
    for (let i = 0; i < ctx.lines.length; i++) {
      if (motion.test(ctx.lines[i])) {
        return [{ line: i + 1, snippet: snippetOf(ctx.lines[i]) }]
      }
    }
    return []
  }
}

// ── drift: divergence from declared design context ─────────────────────────

const fontDrift: DesignRule = {
  id: 'drift-font-not-in-system',
  category: 'drift',
  severity: 'advisory',
  minStrictness: 'strict',
  title: '字体偏离设计语境',
  message: '该字体不在设计语境声明的字族内。',
  run: (ctx) => {
    const allowed = ctx.designContext?.allowedFonts
    if (!allowed || allowed.length === 0) return []
    const allowedLower = new Set(allowed.map((f) => f.trim().toLowerCase()))
    return eachLineMatch(
      ctx,
      /font-family\s*:\s*['"]?\s*([A-Za-z][A-Za-z0-9 _-]+?)['"]?\s*[,;}]/gi,
      (m) => {
        const font = m[1].trim().toLowerCase()
        return !GENERIC_FONTS.has(font) && !allowedLower.has(font)
      },
      (m) => `字体「${m[1].trim()}」不在设计语境允许的字族内（${allowed.join('、')}）。`
    )
  }
}

/** All detector rules, in display order. */
export const DESIGN_RULES: readonly DesignRule[] = [
  purpleBlueGradient,
  bounceEasing,
  creamDefaultBg,
  sideTabBorder,
  gradientText,
  grayTextOnColor,
  darkColoredGlow,
  overusedFont,
  heroFontCeiling,
  trackingFloor,
  lineLength,
  arbitraryZIndex,
  skippedHeading,
  missingReducedMotion,
  fontDrift
]
