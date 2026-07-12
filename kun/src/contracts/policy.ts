import { z } from 'zod'

export const APPROVAL_POLICIES = [
  'always',
  'on-request',
  'untrusted',
  'never',
  'auto',
  'suggest'
] as const
/**
 * A fresh runtime must not silently grant model-controlled tools host-wide
 * execution. Users can still opt into trusted-workspace or bypass modes
 * explicitly in settings.
 */
export const DEFAULT_APPROVAL_POLICY = 'on-request'

export const ApprovalPolicySchema = z.enum(APPROVAL_POLICIES)
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>

export const SANDBOX_MODES = [
  'read-only',
  'workspace-write',
  'danger-full-access',
  'external-sandbox'
 ] as const
export const DEFAULT_SANDBOX_MODE = 'workspace-write'

export const SandboxModeSchema = z.enum(SANDBOX_MODES)
export type SandboxMode = z.infer<typeof SandboxModeSchema>
