import { describe, expect, it } from 'vitest'
import { detectFrontend, isFrontendPath, listDesignRules } from './detect.js'

function ruleIds(source: string, options = {}): string[] {
  return detectFrontend(source, { filePath: 'x.css', ...options }).map((f) => f.ruleId)
}

describe('isFrontendPath', () => {
  it('accepts frontend extensions and rejects others', () => {
    expect(isFrontendPath('a/b/page.tsx')).toBe(true)
    expect(isFrontendPath('styles.css')).toBe(true)
    expect(isFrontendPath('mock.html')).toBe(true)
    expect(isFrontendPath('server.ts')).toBe(false)
    expect(isFrontendPath('readme.md')).toBe(false)
    expect(isFrontendPath(undefined)).toBe(false)
    expect(isFrontendPath('Dockerfile')).toBe(false)
  })
})

describe('detectFrontend — non-frontend gating', () => {
  it('returns nothing for non-frontend files even with bad css', () => {
    expect(detectFrontend('cubic-bezier(0,1.6,1,1)', { filePath: 'a.ts' })).toEqual([])
  })
  it('returns nothing for empty source', () => {
    expect(detectFrontend('', { filePath: 'a.css' })).toEqual([])
  })
})

describe('slop rules', () => {
  it('flags violet→blue Tailwind gradients', () => {
    const ids = ruleIds('<div className="bg-gradient-to-r from-violet-500 to-blue-500">', {
      filePath: 'a.tsx'
    })
    expect(ids).toContain('slop-purple-blue-gradient')
  })

  it('flags a CSS gradient whose stops are all blue/violet', () => {
    const ids = ruleIds('background: linear-gradient(90deg, #7c3aed, #2563eb);')
    expect(ids).toContain('slop-purple-blue-gradient')
  })

  it('does not flag a gradient with a non-blue stop', () => {
    const ids = ruleIds('background: linear-gradient(90deg, #7c3aed, #f59e0b);')
    expect(ids).not.toContain('slop-purple-blue-gradient')
  })

  it('flags bounce/elastic cubic-bezier easing', () => {
    expect(ruleIds('transition-timing-function: cubic-bezier(0.68, -0.55, 0.27, 1.55);')).toContain(
      'slop-bounce-elastic-easing'
    )
  })

  it('does not flag a well-behaved ease-out curve', () => {
    expect(ruleIds('transition-timing-function: cubic-bezier(0.22, 1, 0.36, 1);')).not.toContain(
      'slop-bounce-elastic-easing'
    )
  })

  it('flags cream/sand background tokens', () => {
    expect(ruleIds(':root { --cream: #faf7f0; }')).toContain('slop-cream-default-bg')
  })

  it('flags a warm-neutral oklch body background', () => {
    expect(ruleIds('body { background: oklch(95% 0.02 75); }')).toContain('slop-cream-default-bg')
  })

  it('flags side-tab accent borders (strict signals at standard)', () => {
    const ids = ruleIds('<div className="border-l-4 border-blue-500 rounded-lg">', {
      filePath: 'a.tsx'
    })
    expect(ids).toContain('slop-side-tab-border')
  })

  it('flags gray text on a colored background only at strict', () => {
    const src = '<span className="text-gray-500 bg-blue-600">hi</span>'
    expect(ruleIds(src, { filePath: 'a.tsx' })).not.toContain('slop-gray-text-on-color')
    expect(ruleIds(src, { filePath: 'a.tsx', strictness: 'strict' })).toContain(
      'slop-gray-text-on-color'
    )
  })
})

describe('quality rules', () => {
  it('flags overused fonts as the primary family', () => {
    const findings = detectFrontend('font-family: Inter, sans-serif;', { filePath: 'a.css' })
    const f = findings.find((x) => x.ruleId === 'quality-overused-font')
    expect(f).toBeTruthy()
    expect(f?.message).toContain('Inter')
  })

  it('flags hero font sizes over 6rem', () => {
    expect(ruleIds('h1 { font-size: 7.5rem; }')).toContain('quality-hero-font-ceiling')
    expect(ruleIds('h1 { font-size: clamp(3rem, 8vw, 9rem); }')).toContain(
      'quality-hero-font-ceiling'
    )
    expect(ruleIds('h1 { font-size: 4rem; }')).not.toContain('quality-hero-font-ceiling')
  })

  it('flags too-tight display tracking', () => {
    expect(ruleIds('h1 { letter-spacing: -0.06em; }')).toContain('quality-display-tracking-floor')
    expect(ruleIds('h1 { letter-spacing: -0.02em; }')).not.toContain(
      'quality-display-tracking-floor'
    )
  })

  it('flags overly wide line lengths', () => {
    expect(ruleIds('p { max-width: 90ch; }')).toContain('quality-body-line-length')
    expect(ruleIds('p { max-width: 70ch; }')).not.toContain('quality-body-line-length')
  })

  it('flags magic z-index values', () => {
    expect(ruleIds('.modal { z-index: 9999; }')).toContain('quality-arbitrary-z-index')
    expect(ruleIds('.modal { z-index: 50; }')).not.toContain('quality-arbitrary-z-index')
  })

  it('flags skipped heading levels in markup', () => {
    const ids = ruleIds('<h1>Title</h1>\n<h3>Sub</h3>', { filePath: 'a.html' })
    expect(ids).toContain('quality-skipped-heading-level')
  })

  it('does not flag well-ordered headings', () => {
    const ids = ruleIds('<h1>Title</h1>\n<h2>Sub</h2>\n<h3>Deep</h3>', { filePath: 'a.html' })
    expect(ids).not.toContain('quality-skipped-heading-level')
  })

  it('flags animation without a reduced-motion guard', () => {
    expect(ruleIds('.x { animation: spin 1s linear infinite; }')).toContain(
      'quality-missing-reduced-motion'
    )
  })

  it('does not flag animation that has a reduced-motion guard', () => {
    const src =
      '.x { animation: spin 1s; }\n@media (prefers-reduced-motion: reduce) { .x { animation: none; } }'
    expect(ruleIds(src)).not.toContain('quality-missing-reduced-motion')
  })
})

describe('drift rules', () => {
  it('flags fonts outside the declared design context', () => {
    const findings = detectFrontend('font-family: "Comic Sans MS", sans-serif;', {
      filePath: 'a.css',
      strictness: 'strict',
      designContext: { allowedFonts: ['Albert Sans', 'Alumni Sans'] }
    })
    expect(findings.map((f) => f.ruleId)).toContain('drift-font-not-in-system')
  })

  it('does not flag an allowed font', () => {
    const findings = detectFrontend('font-family: "Albert Sans", sans-serif;', {
      filePath: 'a.css',
      strictness: 'strict',
      designContext: { allowedFonts: ['Albert Sans'] }
    })
    expect(findings.map((f) => f.ruleId)).not.toContain('drift-font-not-in-system')
  })
})

describe('strictness + caps', () => {
  it('relaxed only fires the most reliable slop tells', () => {
    const src = 'h1 { font-size: 9rem; }\n.x { background: linear-gradient(90deg,#7c3aed,#2563eb); }'
    const relaxed = ruleIds(src, { strictness: 'relaxed' })
    expect(relaxed).toContain('slop-purple-blue-gradient')
    expect(relaxed).not.toContain('quality-hero-font-ceiling')
  })

  it('respects ignoreRules', () => {
    const src = 'font-family: Inter;'
    expect(ruleIds(src, { ignoreRules: ['quality-overused-font'] })).not.toContain(
      'quality-overused-font'
    )
  })

  it('caps the number of findings', () => {
    const many = Array.from({ length: 40 }, () => 'h1 { font-size: 9rem; }').join('\n')
    expect(detectFrontend(many, { filePath: 'a.css', maxFindings: 5 })).toHaveLength(5)
  })
})

describe('review regressions', () => {
  it('flags literal cream/beige/paper backgrounds (not just token names)', () => {
    for (const hex of ['#faf8f3', '#f5efe6', '#f5f5dc', '#fdf6e3', '#fffaf0', '#fffbeb']) {
      expect(ruleIds(`body { background: ${hex}; }`)).toContain('slop-cream-default-bg')
    }
  })

  it('does not flag pure white / true-neutral backgrounds as cream', () => {
    expect(ruleIds('body { background: #ffffff; }')).not.toContain('slop-cream-default-bg')
    expect(ruleIds('body { background: #f8f8f8; }')).not.toContain('slop-cream-default-bg')
  })

  it('does not flag a cream-named token whose value is not cream', () => {
    expect(ruleIds(':root { --vanilla: #f00; }')).not.toContain('slop-cream-default-bg')
    expect(ruleIds(':root { --cream: #faf8f3; }')).toContain('slop-cream-default-bg')
  })

  it('flags violet→blue→white gradients (achromatic stops ignored)', () => {
    expect(ruleIds('background: linear-gradient(135deg, #7c3aed, #2563eb, #ffffff);')).toContain(
      'slop-purple-blue-gradient'
    )
  })

  it('flags clamp() with an oversized minimum, not just the max arg', () => {
    expect(ruleIds('h1 { font-size: clamp(7rem, 5vw, 4rem); }')).toContain(
      'quality-hero-font-ceiling'
    )
  })

  it('treats box-shadow blur as the 3rd length, not the offset', () => {
    expect(
      ruleIds('a { box-shadow: 40px 2px 4px #7c3aed; }', { strictness: 'strict' })
    ).not.toContain('slop-dark-colored-glow')
    expect(ruleIds('a { box-shadow: 0 0 24px #7c3aed; }', { strictness: 'strict' })).toContain(
      'slop-dark-colored-glow'
    )
  })

  it('flags z-[9999] even when it is the first class after a quote', () => {
    expect(ruleIds('<div class="z-[9999]">', { filePath: 'a.tsx' })).toContain(
      'quality-arbitrary-z-index'
    )
  })

  it('does not nag reduced-motion on Tailwind animate-* in component files', () => {
    expect(ruleIds('<div className="animate-spin" />', { filePath: 'a.tsx' })).not.toContain(
      'quality-missing-reduced-motion'
    )
    expect(
      ruleIds('const css = `@keyframes spin { to { transform: rotate(360deg) } }`', {
        filePath: 'a.tsx'
      })
    ).toContain('quality-missing-reduced-motion')
    expect(ruleIds('.x { transition: all 200ms ease; }', { filePath: 'a.css' })).toContain(
      'quality-missing-reduced-motion'
    )
  })

  it('does not match data-animate-* attributes as motion', () => {
    expect(ruleIds('<div data-animate-on-scroll="true" />', { filePath: 'a.html' })).not.toContain(
      'quality-missing-reduced-motion'
    )
  })
})

describe('registry', () => {
  it('lists rule metadata', () => {
    const rules = listDesignRules()
    expect(rules.length).toBeGreaterThanOrEqual(14)
    expect(rules.every((r) => r.id && r.title && r.category && r.severity)).toBe(true)
  })
})
