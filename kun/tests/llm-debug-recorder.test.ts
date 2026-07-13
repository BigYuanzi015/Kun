import { describe, expect, it } from 'vitest'
import { LlmDebugRecorder } from '../src/services/llm-debug-recorder.js'

function record(recorder: LlmDebugRecorder, model: string): void {
  const round = recorder.start({ threadId: 't', turnId: 'u', provider: 'compat', model })
  recorder.captureRequest(round, { model }, 'https://example.test/v1/chat/completions')
  recorder.captureChunk(round, { kind: 'assistant_text_delta', text: `out:${model}` })
  recorder.finish(round)
}

describe('LlmDebugRecorder', () => {
  it('keeps only the most recent 25 rounds', () => {
    const recorder = new LlmDebugRecorder()
    for (let i = 1; i <= 30; i++) record(recorder, `m${i}`)
    const snapshot = recorder.snapshot()
    expect(snapshot).toHaveLength(25)
    // Oldest five (m1..m5) dropped; m6 is the oldest retained.
    expect(snapshot[snapshot.length - 1]?.model).toBe('m6')
  })

  it('returns the snapshot most-recent first', () => {
    const recorder = new LlmDebugRecorder()
    record(recorder, 'a')
    record(recorder, 'b')
    const snapshot = recorder.snapshot()
    expect(snapshot.map((r) => r.model)).toEqual(['b', 'a'])
    expect(snapshot[0]?.requestBody).toEqual({ model: 'b' })
    expect(snapshot[0]?.output.text).toBe('out:b')
  })

  it('clear empties the buffer', () => {
    const recorder = new LlmDebugRecorder()
    record(recorder, 'a')
    recorder.clear()
    expect(recorder.snapshot()).toHaveLength(0)
  })

  it('retains only a bounded prefix of oversized request bodies', () => {
    const recorder = new LlmDebugRecorder({
      maxRequestBodyBytes: 96,
      maxRoundBytes: 1_024,
      maxTotalBytes: 4_096
    })
    const round = recorder.start({ threadId: 't', turnId: 'u', provider: 'compat', model: 'm' })
    recorder.captureRequest(round, { prompt: '💡'.repeat(1_000) }, 'https://example.test/v1/chat/completions')
    recorder.finish(round)

    const captured = recorder.snapshot()[0]
    expect(captured?.requestBodyTruncated).toBe(true)
    expect(captured?.requestBodyOriginalBytes).toBeGreaterThan(96)
    expect(captured?.requestBody).toMatchObject({ __debugTruncated: true })
    expect(Buffer.byteLength(JSON.stringify(captured?.requestBody), 'utf8')).toBeLessThanOrEqual(96)
  })

  it('bounds streamed output bytes without repeatedly joining prior chunks', () => {
    const recorder = new LlmDebugRecorder({
      maxRequestBodyBytes: 64,
      maxRoundBytes: 128,
      maxTotalBytes: 4_096
    })
    const round = recorder.start({ threadId: 't', turnId: 'u', provider: 'compat', model: 'm' })
    expect(recorder.activeCaptureCount).toBe(1)
    recorder.captureRequest(round, { model: 'm' }, 'https://example.test/v1/chat/completions')
    for (let index = 0; index < 100; index += 1) {
      recorder.captureChunk(round, { kind: 'assistant_text_delta', text: '"\\\n💡'.repeat(10) })
    }
    recorder.finish(round)
    expect(recorder.activeCaptureCount).toBe(0)

    const captured = recorder.snapshot()[0]
    expect(captured?.output.truncated?.text).toBe(true)
    expect(Buffer.byteLength(captured?.output.text ?? '', 'utf8')).toBeLessThan(128)
    expect(Buffer.byteLength(JSON.stringify(captured?.output.text), 'utf8')).toBeLessThan(128)
    expect(captured?.output.text).not.toContain('\ufffd')
  })

  it('evicts old rounds when the global byte budget is exhausted', () => {
    const recorder = new LlmDebugRecorder({
      capacity: 25,
      maxRequestBodyBytes: 64,
      maxRoundBytes: 512,
      maxTotalBytes: 1_000
    })
    for (const model of ['a', 'b', 'c']) {
      const round = recorder.start({ threadId: 't', turnId: model, provider: 'compat', model })
      recorder.captureRequest(round, { model }, 'https://example.test/v1/chat/completions')
      recorder.captureChunk(round, { kind: 'assistant_text_delta', text: model.repeat(250) })
      recorder.finish(round)
    }

    const snapshot = recorder.snapshot()
    expect(snapshot.length).toBeLessThan(3)
    expect(snapshot[0]?.model).toBe('c')
    expect(snapshot.reduce((total, round) => total + (round.retainedBytes ?? 0), 0)).toBeLessThanOrEqual(1_000)
  })
})
