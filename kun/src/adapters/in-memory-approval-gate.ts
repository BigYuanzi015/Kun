import type { ApprovalGate } from '../ports/approval-gate.js'
import type { ApprovalRequest } from '../domain/approval.js'
import { expireApprovalRequest, resolveApprovalRequest } from '../domain/approval.js'

type PendingResolver = {
  resolve: (decision: 'allow' | 'deny') => void
  reject: (error: Error) => void
}

/**
 * In-memory approval gate. The HTTP layer posts decisions into
 * `decide`; the loop awaits the `request` promise to learn whether
 * the user allowed or denied the call.
 */
export class InMemoryApprovalGate implements ApprovalGate {
  private readonly resolvedCapacity: number
  private readonly approvals = new Map<string, ApprovalRequest>()
  private readonly resolvers = new Map<string, PendingResolver>()

  constructor(options: { resolvedCapacity?: number } = {}) {
    this.resolvedCapacity = Math.max(1, Math.floor(options.resolvedCapacity ?? 1_024))
  }

  request(approval: ApprovalRequest): Promise<'allow' | 'deny'> {
    this.approvals.set(approval.id, approval)
    return new Promise<'allow' | 'deny'>((resolve, reject) => {
      this.resolvers.set(approval.id, { resolve, reject })
    })
  }

  decide(approvalId: string, decision: 'allow' | 'deny', reason?: string): boolean {
    const approval = this.approvals.get(approvalId)
    if (!approval) return false
    if (approval.status !== 'pending') return false
    const resolved = resolveApprovalRequest(approval, decision, reason)
    this.approvals.set(approvalId, resolved)
    const resolver = this.resolvers.get(approvalId)
    this.resolvers.delete(approvalId)
    resolver?.resolve(decision)
    this.trimResolved()
    return true
  }

  expire(approvalId: string, reason = 'turn cancelled'): boolean {
    const approval = this.approvals.get(approvalId)
    if (!approval || approval.status !== 'pending') return false
    this.approvals.set(approvalId, { ...expireApprovalRequest(approval), reason })
    const resolver = this.resolvers.get(approvalId)
    this.resolvers.delete(approvalId)
    resolver?.resolve('deny')
    this.trimResolved()
    return true
  }

  pending(threadId?: string): ApprovalRequest[] {
    return [...this.approvals.values()].filter(
      (approval) =>
        approval.status === 'pending' && (!threadId || approval.threadId === threadId)
    )
  }

  get(approvalId: string): ApprovalRequest | undefined {
    return this.approvals.get(approvalId)
  }

  /** Used by tests to simulate an external decision and tear down the promise. */
  resolve(approvalId: string, decision: 'allow' | 'deny', reason?: string): boolean {
    return this.decide(approvalId, decision, reason)
  }

  private trimResolved(): void {
    let resolved = [...this.approvals.values()].filter((approval) => approval.status !== 'pending').length
    if (resolved <= this.resolvedCapacity) return
    for (const [id, approval] of this.approvals) {
      if (approval.status === 'pending') continue
      this.approvals.delete(id)
      resolved -= 1
      if (resolved <= this.resolvedCapacity) return
    }
  }
}
