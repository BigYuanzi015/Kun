import type { UsageSnapshot } from '../contracts/usage.js'
import type { ModelStreamChunk } from '../ports/model-client.js'

/**
 * One captured LLM round: a bounded representation of the HTTP request body
 * and raw output streamed back. Kept in-memory only so the troubleshooting
 * view can inspect recent requests without retaining an unbounded prompt or
 * response history.
 */
export type LlmDebugRound = {
  id: number
  threadId: string
  turnId: string
  provider: string
  model: string
  /** Redacted endpoint URL the request was sent to. */
  url: string
  startedAt: string
  finishedAt: string
  durationMs: number
  /** The request body, or a diagnostic prefix when it exceeded the capture budget. */
  requestBody: Record<string, unknown> | null
  requestBodyTruncated?: boolean
  requestBodyOriginalBytes?: number
  output: LlmDebugOutput
  /** Approximate serialized bytes retained by this completed round. */
  retainedBytes?: number
}

export type LlmDebugToolCall = {
  callId: string
  toolName: string
  arguments: Record<string, unknown>
}

export type LlmDebugOutputTruncation = Partial<Record<
  'text' | 'reasoning' | 'toolCalls' | 'usage' | 'stopReason' | 'error',
  true
>>

export type LlmDebugOutput = {
  text: string
  reasoning: string
  toolCalls: LlmDebugToolCall[]
  usage?: UsageSnapshot
  stopReason?: string
  error?: string
  truncated?: LlmDebugOutputTruncation
}

export type LlmDebugRoundMeta = {
  threadId: string
  turnId: string
  provider: string
  model: string
}

/** Narrow sink used by model clients to retain bounded debug data. */
export interface LlmDebugSink {
  start(meta: LlmDebugRoundMeta): LlmDebugRound
  captureRequest(round: LlmDebugRound, requestBody: Record<string, unknown>, redactedUrl: string): void
  captureChunk(round: LlmDebugRound, chunk: ModelStreamChunk): void
  finish(round: LlmDebugRound): void
}

export type LlmDebugRecorderLimits = {
  capacity: number
  maxRequestBodyBytes: number
  maxRoundBytes: number
  maxTotalBytes: number
}

export const DEFAULT_LLM_DEBUG_RECORDER_LIMITS: LlmDebugRecorderLimits = {
  capacity: 25,
  maxRequestBodyBytes: 512 * 1024,
  maxRoundBytes: 2 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024
}

type CaptureState = {
  requestBytes: number
  outputBytes: number
  text: StringBlockAccumulator
  reasoning: StringBlockAccumulator
}

type StringBlockAccumulator = {
  blocks: string[]
  parts: string[]
}

const DEBUG_TEXT_BLOCK_FRAGMENT_WINDOW = 256

/**
 * Count- and byte-bounded in-memory buffer of recent LLM rounds. Streaming
 * text is accumulated in blocks and joined only once when the round finishes.
 */
export class LlmDebugRecorder implements LlmDebugSink {
  private readonly rounds: LlmDebugRound[] = []
  private readonly states = new WeakMap<LlmDebugRound, CaptureState>()
  private readonly limits: LlmDebugRecorderLimits
  private nextId = 1
  private totalRetainedBytes = 0
  private activeCaptureCountValue = 0

  constructor(limits: Partial<LlmDebugRecorderLimits> = {}) {
    this.limits = {
      capacity: positiveInteger(limits.capacity, DEFAULT_LLM_DEBUG_RECORDER_LIMITS.capacity),
      maxRequestBodyBytes: positiveInteger(
        limits.maxRequestBodyBytes,
        DEFAULT_LLM_DEBUG_RECORDER_LIMITS.maxRequestBodyBytes
      ),
      maxRoundBytes: positiveInteger(limits.maxRoundBytes, DEFAULT_LLM_DEBUG_RECORDER_LIMITS.maxRoundBytes),
      maxTotalBytes: positiveInteger(limits.maxTotalBytes, DEFAULT_LLM_DEBUG_RECORDER_LIMITS.maxTotalBytes)
    }
  }

  start(meta: LlmDebugRoundMeta): LlmDebugRound {
    const startedAt = new Date().toISOString()
    const round: LlmDebugRound = {
      id: this.nextId++,
      threadId: meta.threadId,
      turnId: meta.turnId,
      provider: meta.provider,
      model: meta.model,
      url: '',
      startedAt,
      finishedAt: startedAt,
      durationMs: 0,
      requestBody: null,
      output: { text: '', reasoning: '', toolCalls: [] }
    }
    this.states.set(round, {
      requestBytes: 0,
      outputBytes: 0,
      text: { blocks: [], parts: [] },
      reasoning: { blocks: [], parts: [] }
    })
    this.activeCaptureCountValue += 1
    return round
  }

  captureRequest(
    round: LlmDebugRound,
    requestBody: Record<string, unknown>,
    redactedUrl: string
  ): void {
    const state = this.stateFor(round)
    const serialized = serializeJson(requestBody)
    const originalBytes = Buffer.byteLength(serialized.json, 'utf8')
    const availableBytes = Math.max(
      0,
      Math.min(this.limits.maxRequestBodyBytes, this.limits.maxRoundBytes - state.outputBytes)
    )

    round.url = redactedUrl
    round.requestBodyOriginalBytes = originalBytes
    if (serialized.exact && originalBytes <= availableBytes) {
      round.requestBody = requestBody
      round.requestBodyTruncated = false
      state.requestBytes = originalBytes
      return
    }

    round.requestBodyTruncated = true
    round.requestBody = truncatedRequestBody(serialized.json, originalBytes, availableBytes)
    state.requestBytes = round.requestBody ? jsonBytes(round.requestBody) : 0
  }

  captureChunk(round: LlmDebugRound, chunk: ModelStreamChunk): void {
    const state = this.stateFor(round)
    switch (chunk.kind) {
      case 'assistant_text_delta':
        this.captureText(round, state, 'text', chunk.text)
        break
      case 'assistant_reasoning_delta':
        this.captureText(round, state, 'reasoning', chunk.text)
        break
      case 'tool_call_complete':
        this.captureToolCall(round, state, {
          callId: chunk.callId,
          toolName: chunk.toolName,
          arguments: chunk.arguments
        })
        break
      case 'usage':
        this.captureValue(round, state, 'usage', chunk.usage)
        break
      case 'completed':
        this.captureString(round, state, 'stopReason', chunk.stopReason)
        break
      case 'error':
        this.captureString(round, state, 'error', chunk.message)
        break
    }
  }

  finish(round: LlmDebugRound): void {
    const state = this.stateFor(round)
    round.output.text = joinStringBlocks(state.text)
    round.output.reasoning = joinStringBlocks(state.reasoning)
    if (this.states.delete(round)) {
      this.activeCaptureCountValue = Math.max(0, this.activeCaptureCountValue - 1)
    }
    round.finishedAt = new Date().toISOString()
    round.durationMs = Math.max(0, Date.parse(round.finishedAt) - Date.parse(round.startedAt))
    round.retainedBytes = 0
    for (let pass = 0; pass < 4; pass += 1) {
      const measured = jsonBytes(round)
      if (measured === round.retainedBytes) break
      round.retainedBytes = measured
    }
    this.totalRetainedBytes += round.retainedBytes
    this.rounds.push(round)
    while (
      this.rounds.length > this.limits.capacity ||
      this.totalRetainedBytes > this.limits.maxTotalBytes
    ) {
      const removed = this.rounds.shift()
      if (!removed) break
      this.totalRetainedBytes = Math.max(0, this.totalRetainedBytes - (removed.retainedBytes ?? jsonBytes(removed)))
    }
  }

  /** Most-recent-first copy of the retained rounds. */
  snapshot(): LlmDebugRound[] {
    return [...this.rounds].reverse()
  }

  clear(): void {
    this.rounds.length = 0
    this.totalRetainedBytes = 0
  }

  /** Number of in-flight rounds that still retain block accumulators. */
  get activeCaptureCount(): number {
    return this.activeCaptureCountValue
  }

  private captureText(
    round: LlmDebugRound,
    state: CaptureState,
    field: 'text' | 'reasoning',
    value: string
  ): void {
    if (!value) return
    const retained = truncateJsonStringContent(value, this.remainingOutputBytes(state))
    if (retained) {
      appendStringBlock(field === 'text' ? state.text : state.reasoning, retained)
      state.outputBytes += jsonStringContentBytes(retained)
    }
    if (retained !== value) markTruncated(round.output, field)
  }

  private captureToolCall(round: LlmDebugRound, state: CaptureState, call: LlmDebugToolCall): void {
    const bytes = jsonBytes(call)
    if (bytes > this.remainingOutputBytes(state)) {
      markTruncated(round.output, 'toolCalls')
      return
    }
    round.output.toolCalls.push(call)
    state.outputBytes += bytes
  }

  private captureValue(
    round: LlmDebugRound,
    state: CaptureState,
    field: 'usage',
    value: UsageSnapshot
  ): void {
    if (round.output[field] !== undefined) return
    const bytes = jsonBytes(value)
    if (bytes > this.remainingOutputBytes(state)) {
      markTruncated(round.output, field)
      return
    }
    round.output[field] = value
    state.outputBytes += bytes
  }

  private captureString(
    round: LlmDebugRound,
    state: CaptureState,
    field: 'stopReason' | 'error',
    value: string
  ): void {
    if (round.output[field] !== undefined) return
    const retained = truncateJsonStringContent(value, this.remainingOutputBytes(state))
    if (retained) {
      round.output[field] = retained
      state.outputBytes += jsonStringContentBytes(retained)
    }
    if (retained !== value) markTruncated(round.output, field)
  }

  private remainingOutputBytes(state: CaptureState): number {
    return Math.max(0, this.limits.maxRoundBytes - state.requestBytes - state.outputBytes)
  }

  private stateFor(round: LlmDebugRound): CaptureState {
    const existing = this.states.get(round)
    if (existing) return existing
    const created: CaptureState = {
      requestBytes: 0,
      outputBytes: 0,
      text: { blocks: [], parts: [] },
      reasoning: { blocks: [], parts: [] }
    }
    this.states.set(round, created)
    this.activeCaptureCountValue += 1
    return created
  }
}

function appendStringBlock(accumulator: StringBlockAccumulator, value: string): void {
  accumulator.parts.push(value)
  if (accumulator.parts.length < DEBUG_TEXT_BLOCK_FRAGMENT_WINDOW) return
  accumulator.blocks.push(accumulator.parts.join(''))
  accumulator.parts = []
}

function joinStringBlocks(accumulator: StringBlockAccumulator): string {
  if (accumulator.parts.length === 0) return accumulator.blocks.join('')
  return [...accumulator.blocks, accumulator.parts.join('')].join('')
}

function markTruncated(output: LlmDebugOutput, field: keyof LlmDebugOutputTruncation): void {
  const truncated = output.truncated ?? (output.truncated = {})
  truncated[field] = true
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback
}

function serializeJson(value: unknown): { json: string; exact: boolean } {
  try {
    return { json: JSON.stringify(value) ?? 'null', exact: true }
  } catch (error) {
    return {
      json: JSON.stringify({
        __debugUnserializable: true,
        error: error instanceof Error ? error.message : String(error)
      }),
      exact: false
    }
  }
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(serializeJson(value).json, 'utf8')
}

function truncatedRequestBody(
  json: string,
  originalBytes: number,
  maxBytes: number
): Record<string, unknown> | null {
  const envelope = (jsonPrefix: string): Record<string, unknown> => ({
    __debugTruncated: true,
    originalBytes,
    jsonPrefix
  })
  if (jsonBytes(envelope('')) > maxBytes) return null

  let low = 0
  let high = json.length
  let best = ''
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const prefix = safeStringPrefix(json, middle)
    if (jsonBytes(envelope(prefix)) <= maxBytes) {
      best = prefix
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return envelope(best)
}

function truncateJsonStringContent(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  if (jsonStringContentBytes(value) <= maxBytes) return value
  let low = 0
  let high = value.length
  let best = ''
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    const prefix = safeStringPrefix(value, middle)
    if (jsonStringContentBytes(prefix) <= maxBytes) {
      best = prefix
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return best
}

function jsonStringContentBytes(value: string): number {
  const serialized = JSON.stringify(value)
  return Buffer.byteLength(serialized.slice(1, -1), 'utf8')
}

function safeStringPrefix(value: string, length: number): string {
  let end = Math.min(value.length, Math.max(0, length))
  if (end > 0) {
    const last = value.charCodeAt(end - 1)
    if (last >= 0xd800 && last <= 0xdbff) end -= 1
  }
  return value.slice(0, end)
}
