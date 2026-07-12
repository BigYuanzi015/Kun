import { describe, expect, it } from 'vitest'
import { SteeringQueue } from './steering-queue.js'

describe('SteeringQueue', () => {
  it('keeps concurrent turn buffers isolated', () => {
    const queue = new SteeringQueue()
    queue.enqueue('turn_a', { text: 'private instruction for A' })
    queue.enqueue('turn_b', { text: 'private instruction for B' })

    expect(queue.drain('turn_b')).toEqual([{ text: 'private instruction for B' }])
    expect(queue.drain('turn_a')).toEqual([{ text: 'private instruction for A' }])
  })

  it('clearing one turn does not discard another turn steering', () => {
    const queue = new SteeringQueue()
    queue.enqueue('turn_a', { text: 'A' })
    queue.enqueue('turn_b', { text: 'B' })

    queue.clear('turn_a')

    expect(queue.drain('turn_a')).toEqual([])
    expect(queue.drain('turn_b')).toEqual([{ text: 'B' }])
  })

  it('rejects entries that exceed a turn buffer entry or byte budget', () => {
    const queue = new SteeringQueue({ maxEntriesPerTurn: 2, maxBytesPerTurn: 6 })

    expect(queue.enqueue('turn_a', { text: 'abc' })).toBe(true)
    expect(queue.enqueue('turn_a', { text: 'de' })).toBe(true)
    expect(queue.enqueue('turn_a', { text: 'f' })).toBe(false)
    expect(queue.enqueue('turn_b', { text: '1234567' })).toBe(false)

    expect(queue.drain('turn_a')).toEqual([{ text: 'abc' }, { text: 'de' }])
    expect(queue.drain('turn_b')).toEqual([])
  })
})
