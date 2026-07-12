import { describe, expect, it } from 'vitest'
import {
  MAX_SVG_SOURCE_BYTES,
  SVG_NAMESPACE,
  isVisualSvgElement,
  parseAndSanitizeSvgDocument,
  svgAnimationTiming,
  validSvgRootNamespace
} from './svg-document'

describe('SVG document safety helpers', () => {
  it('accepts the SVG namespace and repairs only a plain unprefixed root', () => {
    expect(validSvgRootNamespace(SVG_NAMESPACE, null, SVG_NAMESPACE)).toBe(true)
    expect(validSvgRootNamespace(null, null, null)).toBe(true)
    expect(validSvgRootNamespace('urn:not-svg', 'bad', null)).toBe(false)
    expect(validSvgRootNamespace(null, 'bad', null)).toBe(false)
    expect(validSvgRootNamespace(SVG_NAMESPACE, 's', null)).toBe(false)
    expect(validSvgRootNamespace(SVG_NAMESPACE, null, 'urn:not-svg')).toBe(false)
  })

  it('does not count definition-only geometry as rendered artwork', () => {
    expect(isVisualSvgElement('path', [])).toBe(true)
    expect(isVisualSvgElement('use', [])).toBe(true)
    expect(isVisualSvgElement('path', ['defs'])).toBe(false)
    expect(isVisualSvgElement('rect', ['pattern', 'defs'])).toBe(false)
    expect(isVisualSvgElement('linearGradient', [])).toBe(false)
  })

  it('enforces the SVG admission limit as UTF-8 bytes before DOM parsing', () => {
    const oversized = '界'.repeat(Math.ceil((MAX_SVG_SOURCE_BYTES + 1) / 3))
    expect(parseAndSanitizeSvgDocument(oversized)).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'source-too-large' })]
    })
  })

  it('keeps the complete static SMIL timing contract instead of guessing one second', () => {
    expect(svgAnimationTiming({ dur: '2min' })).toEqual({ endMs: 120_000, mayContinue: false })
    expect(svgAnimationTiming({ dur: '1s', repeatDur: '10s' })).toEqual({ endMs: 10_000, mayContinue: false })
    expect(svgAnimationTiming({ dur: '1s', repeatCount: 'indefinite', repeatDur: '10s' }))
      .toEqual({ endMs: 10_000, mayContinue: false })
    expect(svgAnimationTiming({ dur: '1s', repeatCount: 'indefinite' })).toEqual({ endMs: 0, mayContinue: true })
    expect(svgAnimationTiming({ dur: '1s', begin: 'click' })).toEqual({ endMs: 0, mayContinue: true })
  })
})
