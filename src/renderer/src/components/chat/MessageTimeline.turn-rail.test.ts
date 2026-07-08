import { describe, expect, it } from 'vitest'
import {
  activeTimelineTurnKey,
  timelineJumpRailLeft,
  timelineJumpRailPreviewLeft,
  timelineJumpWaveLevel
} from './MessageTimeline'

describe('activeTimelineTurnKey', () => {
  const positions = [
    { key: 'turn-1', top: -220 },
    { key: 'turn-2', top: 40 },
    { key: 'turn-3', top: 280 }
  ]

  it('keeps the latest turn that crossed the viewport threshold active', () => {
    expect(activeTimelineTurnKey(positions)).toBe('turn-2')
  })

  it('uses the first turn before any later turn crosses the threshold', () => {
    expect(activeTimelineTurnKey([
      { key: 'turn-1', top: 180 },
      { key: 'turn-2', top: 420 }
    ])).toBe('turn-1')
  })

  it('returns null for an empty timeline', () => {
    expect(activeTimelineTurnKey([])).toBeNull()
  })
})

describe('timelineJumpWaveLevel', () => {
  it('cycles compact rail items through a wave pattern', () => {
    expect(Array.from({ length: 7 }, (_, index) => timelineJumpWaveLevel(index))).toEqual([2, 4, 5, 3, 1, 2, 4])
  })
})

describe('timelineJumpRailLeft', () => {
  it('anchors the rail to the left side of the conversation stage', () => {
    expect(timelineJumpRailLeft(1000)).toBe(16)
  })

  it('keeps the same left inset in wide conversation stages', () => {
    expect(timelineJumpRailLeft(1600)).toBe(16)
  })

  it('stays inside a very narrow chat stage', () => {
    expect(timelineJumpRailLeft(24)).toBe(0)
  })

  it('falls back to the stage inset when the width is not measurable yet', () => {
    expect(timelineJumpRailLeft(0)).toBe(16)
  })
})

describe('timelineJumpRailPreviewLeft', () => {
  it('keeps the hover preview inside the conversation gutter', () => {
    expect(timelineJumpRailPreviewLeft(-20, 520)).toBe(16)
  })

  it('keeps the hover preview inside the conversation right edge', () => {
    expect(timelineJumpRailPreviewLeft(1000, 1200)).toBe(768)
  })
})
