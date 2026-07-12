/**
 * Serializes the main process operations that can replace or reconfigure the
 * single managed Kun runtime. The coordinator owns concurrency only; callers
 * retain runtime policy and I/O.
 */
export class ManagedRuntimeOperationCoordinator<Settings> {
  private ensurePromise: Promise<Settings> | null = null
  private ensureFingerprint: string | null = null
  private restartPromise: Promise<void> | null = null
  private settingsApplyPromise: Promise<void> | null = null
  private latestSettings: Settings | null = null

  hasPendingOperation(): boolean {
    return Boolean(this.ensurePromise || this.restartPromise || this.settingsApplyPromise)
  }

  latestOr(fallback: Settings): Settings {
    return this.latestSettings ?? fallback
  }

  noteLatest(settings: Settings): void {
    this.latestSettings = settings
  }

  async waitForRestart(): Promise<boolean> {
    const restart = this.restartPromise
    if (!restart) return false
    await restart
    return true
  }

  async ensure(fingerprint: string, operation: () => Promise<Settings>): Promise<Settings> {
    const pending = this.ensurePromise
    const pendingFingerprint = this.ensureFingerprint
    if (pending) {
      try {
        const result = await pending
        if (pendingFingerprint === fingerprint) return result
      } catch {
        // A caller with current settings gets one fresh attempt below.
      }
    }
    let tracked: Promise<Settings>
    tracked = operation().finally(() => {
      if (this.ensurePromise === tracked) {
        this.ensurePromise = null
        this.ensureFingerprint = null
      }
    })
    this.ensurePromise = tracked
    this.ensureFingerprint = fingerprint
    return tracked
  }

  restart(operation: () => Promise<void>): Promise<void> {
    if (this.restartPromise) return this.restartPromise
    let tracked: Promise<void>
    tracked = operation().finally(() => {
      if (this.restartPromise === tracked) this.restartPromise = null
    })
    this.restartPromise = tracked
    this.ensurePromise = null
    this.ensureFingerprint = null
    return tracked
  }

  enqueueSettingsApply(
    operation: () => Promise<void>,
    onError: (error: unknown) => void
  ): void {
    const previous = this.settingsApplyPromise ?? Promise.resolve()
    let tracked: Promise<void>
    tracked = previous
      .catch(() => undefined)
      .then(operation)
      .catch(onError)
      .finally(() => {
        if (this.settingsApplyPromise === tracked) this.settingsApplyPromise = null
      })
    this.settingsApplyPromise = tracked
  }

  async waitForSettingsApply(): Promise<void> {
    await this.settingsApplyPromise
  }
}
