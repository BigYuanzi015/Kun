export type TurnLimitsConfig = {
  maxSteps?: number
  maxWallTimeMs?: number
  maxToolCallsPerStep?: number
}

export type NormalizedTurnLimits = Required<TurnLimitsConfig>

export function normalizeTurnLimits(input: TurnLimitsConfig | undefined): NormalizedTurnLimits {
  return {
    maxSteps: Math.max(1, Math.floor(input?.maxSteps ?? 64)),
    maxWallTimeMs: Math.max(1, Math.floor(input?.maxWallTimeMs ?? 15 * 60_000)),
    maxToolCallsPerStep: Math.max(1, Math.floor(input?.maxToolCallsPerStep ?? 32))
  }
}
