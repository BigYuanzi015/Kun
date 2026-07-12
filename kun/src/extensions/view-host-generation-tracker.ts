type TrackedViewSession = {
  extensionId: string
  hostGeneration?: string
}

/**
 * Associates transient View sessions with the exact Extension Host process
 * generation that serves them. A session created after a Host has entered a
 * crashed state remains unbound until the replacement Host activates, so a
 * delayed exit callback cannot dispose the new session.
 */
export class ExtensionViewHostGenerationTracker {
  private readonly sessions = new Map<string, TrackedViewSession>()

  register(sessionId: string, extensionId: string, hostGeneration?: string): void {
    this.sessions.set(sessionId, {
      extensionId,
      ...(hostGeneration ? { hostGeneration } : {})
    })
  }

  unregister(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  bindExtension(extensionId: string, hostGeneration: string): void {
    for (const session of this.sessions.values()) {
      if (session.extensionId === extensionId) session.hostGeneration = hostGeneration
    }
  }

  takeExitedGeneration(extensionId: string, hostGeneration: string): string[] {
    const sessionIds: string[] = []
    for (const [sessionId, session] of this.sessions) {
      if (
        session.extensionId === extensionId &&
        session.hostGeneration === hostGeneration
      ) {
        sessionIds.push(sessionId)
        this.sessions.delete(sessionId)
      }
    }
    return sessionIds
  }
}
