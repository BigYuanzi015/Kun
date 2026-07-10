import type { ModelCapabilityMetadata } from '../contracts/capabilities.js'
import type { TurnItem } from '../contracts/items.js'
import type { ModelToolSpec } from '../ports/model-client.js'
import type {
  GuiDesignArtifactContext,
  GuiPlanContext,
  ToolCallLike,
  ToolHostContext,
  ToolProviderKind
} from '../ports/tool-host.js'

/** Terminal status exposed by the public AgentLoop turn boundary. */
export type TurnExecutionStatus = 'completed' | 'failed' | 'aborted'

/** Outcome returned by one native model round to the loop orchestrator. */
export type ModelRoundOutcome = 'continue' | 'stop' | 'failed' | 'aborted'

/** Outcome returned after the ordered tool-dispatch stage. */
export type ToolDispatchOutcome = 'continue' | 'aborted' | 'all_suppressed'

/**
 * Stable inputs shared by a prepared model/tool turn. Context preparation
 * owns populating this record; execution services only consume it.
 */
export type PreparedTurnContext = {
  threadId: string
  turnId: string
  workspace: string
  model: string
  providerId?: string
  mode: 'agent' | 'plan'
  approvalPolicy: ToolHostContext['approvalPolicy']
  sandboxMode: NonNullable<ToolHostContext['sandboxMode']>
  signal: AbortSignal
  history: readonly TurnItem[]
  tools: readonly ModelToolSpec[]
}

/**
 * Stable inputs shared by tool discovery and tool execution. Discovery keeps
 * approval inert; the execution factory is the only boundary that may await a
 * real approval or persist interactive state.
 */
export type ToolTurnContextInput = {
  threadId: string
  turnId: string
  workspace: string
  threadMode?: 'agent' | 'plan'
  activePlanContext?: GuiPlanContext
  guiDesignCanvas?: boolean
  guiDesignMode?: boolean
  guiDesignArtifact?: GuiDesignArtifactContext
  modelProviderId?: string
  modelCapabilities: ModelCapabilityMetadata
  activeSkillIds: readonly string[]
  allowedToolNames?: readonly string[]
  userInputDisabled?: boolean
  imContext?: boolean
  approvalPolicy: ToolHostContext['approvalPolicy']
  sandboxMode: NonNullable<ToolHostContext['sandboxMode']>
  signal: AbortSignal
}

/** Internal boundary between the model round and ordered tool execution. */
export type ToolDispatchInput = ToolTurnContextInput & {
  calls: ToolCallLike[]
  toolProviderKinds: ReadonlyMap<string, ToolProviderKind | undefined>
}
