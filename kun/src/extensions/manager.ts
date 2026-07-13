import { join, resolve } from 'node:path'
import type { CompatibilityReport, ExtensionManifest, WorkspaceContext } from '@kun/extension-api'
import { AtomicJsonFile } from './atomic-json.js'
import { asExtensionError, extensionError, type ExtensionErrorDetails } from './errors.js'
import { redactSecrets, redactSecretText } from '../config/secret-redaction.js'
import {
  ExtensionHostProcess,
  type ExtensionBrokerRequest,
  type ExtensionHostExit,
  type ExtensionHostLimits,
  type ExtensionPrincipal
} from './host-process.js'
import type { ExtensionPackageLifecycle, ExtensionPackageManager } from './package-manager.js'
import type { ExtensionPaths } from './paths.js'
import type { JsonValue, ResolvedExtension } from './types.js'

export const DEFAULT_EXTENSION_CRASH_THRESHOLD = 3
export const DEFAULT_EXTENSION_RESTART_BACKOFF_MS = 250
export const DEFAULT_EXTENSION_RESTART_BACKOFF_MAX_MS = 10_000
export const DEFAULT_EXTENSION_HEALTHY_RESET_MS = 60_000
export const DEFAULT_EXTENSION_VIEW_IDLE_TIMEOUT_MS = 30_000

type PersistedHostHealth = {
  extensionId: string
  version?: string
  lifecycleState: string
  activationEvent?: string
  processId?: number
  restartCount: number
  consecutiveFailures: number
  circuitOpen: boolean
  nextRetryAt?: string
  lastError?: { code: string; message: string; details: ExtensionErrorDetails }
  logPath?: string
  updatedAt: string
}

type HostHealthDocument = {
  schemaVersion: 1
  revision: number
  extensions: Record<string, PersistedHostHealth>
}

export type ExtensionHostDiagnostic = PersistedHostHealth & {
  active: boolean
  compatibility?: CompatibilityReport
  negotiatedApiVersion?: string
  negotiatedRpcVersion?: number
}

export type ExtensionManagerOptions = {
  packageManager: ExtensionPackageManager
  paths: ExtensionPaths
  runnerPath?: string
  capabilitiesForExtension?(extension: ResolvedExtension): string[]
  hostLimits?: Partial<ExtensionHostLimits>
  broker?(request: ExtensionBrokerRequest): Promise<JsonValue>
  requiredPermission?(method: string, params: JsonValue): string | undefined
  onNotification?(principal: ExtensionPrincipal, method: string, params: JsonValue): void | Promise<void>
  onStream?(
    principal: ExtensionPrincipal,
    requestId: string,
    sequence: number,
    payload: JsonValue,
    terminal: boolean
  ): void | Promise<void>
  /** Dispose broker-owned registrations before a crashed host can reactivate. */
  onHostExit?(exit: ExtensionHostExit): void | Promise<void>
  /** Bind retained Views to the exact Host process generation that activated. */
  onHostActivated?(principal: ExtensionPrincipal): void | Promise<void>
  crashThreshold?: number
  restartBackoffMs?: number
  restartBackoffMaxMs?: number
  healthyResetMs?: number
  /** Grace period after the last View closes for extensions with no background contribution. */
  viewIdleTimeoutMs?: number
  now?: () => Date
}

export class ExtensionManager {
  private readonly hosts = new Map<string, ExtensionHostProcess>()
  private readonly activationEpochs = new Map<string, number>()
  private readonly activations = new Map<string, {
    epoch: number
    event: string
    workspaceRoots: string[]
    workspaceContextSignature: string
    promise: Promise<ExtensionHostProcess | undefined>
  }>()
  private readonly healthyTimers = new Map<string, NodeJS.Timeout>()
  private readonly idleTimers = new Map<string, NodeJS.Timeout>()
  private readonly viewReferences = new Map<string, number>()
  private readonly idleEligibleExtensions = new Set<string>()
  private readonly stops = new Map<string, Promise<void>>()
  private readonly hostExitCleanups = new Map<string, Promise<void>>()
  private readonly recordedFailures = new WeakSet<ExtensionHostProcess>()
  private readonly healthFile: AtomicJsonFile<HostHealthDocument>
  private readonly crashThreshold: number
  private readonly restartBackoffMs: number
  private readonly restartBackoffMaxMs: number
  private readonly healthyResetMs: number
  private readonly viewIdleTimeoutMs: number
  private shuttingDown = false

  constructor(private readonly options: ExtensionManagerOptions) {
    this.crashThreshold = positiveInteger(
      options.crashThreshold,
      DEFAULT_EXTENSION_CRASH_THRESHOLD,
      'crashThreshold'
    )
    this.restartBackoffMs = positiveInteger(
      options.restartBackoffMs,
      DEFAULT_EXTENSION_RESTART_BACKOFF_MS,
      'restartBackoffMs'
    )
    this.restartBackoffMaxMs = positiveInteger(
      options.restartBackoffMaxMs,
      DEFAULT_EXTENSION_RESTART_BACKOFF_MAX_MS,
      'restartBackoffMaxMs'
    )
    this.healthyResetMs = positiveInteger(
      options.healthyResetMs,
      DEFAULT_EXTENSION_HEALTHY_RESET_MS,
      'healthyResetMs'
    )
    this.viewIdleTimeoutMs = positiveInteger(
      options.viewIdleTimeoutMs,
      DEFAULT_EXTENSION_VIEW_IDLE_TIMEOUT_MS,
      'viewIdleTimeoutMs'
    )
    this.healthFile = new AtomicJsonFile(
      join(options.paths.dataRoot, 'host-health.json'),
      validateHealthDocument
    )
  }

  async activate(
    extensionId: string,
    event: string,
    options: {
      workspaceRoot?: string
      workspaceRoots?: string[]
      workspaceContext?: WorkspaceContext
    } = {}
  ): Promise<ExtensionHostProcess | undefined> {
    this.cancelIdleDeactivation(extensionId)
    await this.waitForLifecycleTransition(extensionId)
    const workspaceRoots = normalizedWorkspaceRoots(options)
    const workspaceContextSignature = JSON.stringify(options.workspaceContext ?? null)
    const epoch = this.activationEpoch(extensionId)
    const existing = this.activations.get(extensionId)
    if (existing !== undefined) {
      if (
        existing.epoch === epoch &&
        existing.event === event &&
        existing.workspaceContextSignature === workspaceContextSignature &&
        sameWorkspaceRoots(existing.workspaceRoots, workspaceRoots)
      ) return existing.promise
      // A pending activation is bound to its own admitted workspace scope.
      // Wait for it to settle, then run normal admission for this distinct
      // scope/event; never reuse its promise across a trust boundary.
      await existing.promise.catch(() => undefined)
      return this.activate(extensionId, event, options)
    }
    const activation = this.activateInternal(extensionId, event, options, epoch)
    this.activations.set(extensionId, {
      epoch,
      event,
      workspaceRoots,
      workspaceContextSignature,
      promise: activation
    })
    try {
      return await activation
    } finally {
      if (this.activations.get(extensionId)?.promise === activation) this.activations.delete(extensionId)
      this.scheduleIdleDeactivation(extensionId)
    }
  }

  /** Retain a Node Host synchronously before a View begins asynchronous activation. */
  retainView(extensionId: string): void {
    this.viewReferences.set(extensionId, (this.viewReferences.get(extensionId) ?? 0) + 1)
    this.cancelIdleDeactivation(extensionId)
  }

  activeHostGeneration(extensionId: string): string | undefined {
    const host = this.hosts.get(extensionId)
    return host?.state === 'active' ? host.lifecycleNonce : undefined
  }

  /** Release one View reference and start the bounded grace period at zero. */
  releaseView(extensionId: string): void {
    const current = this.viewReferences.get(extensionId) ?? 0
    if (current <= 1) this.viewReferences.delete(extensionId)
    else this.viewReferences.set(extensionId, current - 1)
    if (current > 0) this.scheduleIdleDeactivation(extensionId)
  }

  get pendingIdleDeactivationCount(): number {
    return this.idleTimers.size
  }

  async invoke(
    extensionId: string,
    activationEvent: string,
    method: string,
    params: JsonValue,
    options: {
      workspaceRoot?: string
      workspaceRoots?: string[]
      workspaceContext?: WorkspaceContext
      signal?: AbortSignal
      timeoutMs?: number
      resetTimeoutOnStream?: boolean
    } = {}
  ): Promise<JsonValue> {
    // New broker work is rejected while teardown owns the extension. View
    // activation may wait and reopen after cleanup, but an old provider/tool
    // registration must not reactivate itself from its own dispose callback.
    if (this.stops.has(extensionId) || this.hostExitCleanups.has(extensionId)) {
      throw extensionError(
        'EXTENSION_HOST_DEACTIVATING',
        'Extension host is deactivating',
        { extensionId, method }
      )
    }
    const host = await this.activate(extensionId, activationEvent, options)
    if (host === undefined) {
      throw extensionError('EXTENSION_HEADLESS_ENTRYPOINT_REQUIRED', 'Browser-only extension has no Node host', {
        extensionId
      })
    }
    return host.invoke(method, params, options)
  }

  async notify(extensionId: string, method: string, params: JsonValue): Promise<void> {
    const host = this.hosts.get(extensionId)
    if (host === undefined || host.state !== 'active') {
      throw extensionError('EXTENSION_NOT_ACTIVE', 'Cannot notify an inactive extension host', {
        extensionId,
        method
      })
    }
    await host.notify(method, params)
  }

  async deactivate(extensionId: string): Promise<void> {
    this.cancelIdleDeactivation(extensionId)
    this.activationEpochs.set(extensionId, this.activationEpoch(extensionId) + 1)
    try {
      await this.stopHost(extensionId)
    } finally {
      this.idleEligibleExtensions.delete(extensionId)
    }
  }

  private async stopHost(extensionId: string): Promise<void> {
    const existing = this.stops.get(extensionId)
    if (existing !== undefined) return existing
    const stopping = this.stopHostInternal(extensionId)
    this.stops.set(extensionId, stopping)
    try {
      await stopping
    } finally {
      if (this.stops.get(extensionId) === stopping) this.stops.delete(extensionId)
    }
  }

  private async stopHostInternal(extensionId: string): Promise<void> {
    this.cancelIdleDeactivation(extensionId)
    this.idleEligibleExtensions.delete(extensionId)
    const timer = this.healthyTimers.get(extensionId)
    if (timer !== undefined) clearTimeout(timer)
    this.healthyTimers.delete(extensionId)
    const host = this.hosts.get(extensionId)
    if (host === undefined) {
      await this.waitForHostExitCleanup(extensionId)
      return
    }
    this.hosts.delete(extensionId)
    await host.deactivate()
    await this.waitForHostExitCleanup(extensionId)
    await this.updateHealth(extensionId, (health) => ({
      ...health,
      lifecycleState: 'stopped',
      processId: undefined,
      updatedAt: this.now().toISOString()
    }))
  }

  private activationEpoch(extensionId: string): number {
    return this.activationEpochs.get(extensionId) ?? 0
  }

  private assertActivationCurrent(extensionId: string, expectedEpoch: number): void {
    if (this.activationEpoch(extensionId) !== expectedEpoch) {
      throw extensionError(
        'EXTENSION_ACTIVATION_CANCELLED',
        'Extension activation was invalidated by a lifecycle or permission change',
        { extensionId }
      )
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true
    for (const timer of this.idleTimers.values()) clearTimeout(timer)
    this.idleTimers.clear()
    const extensionIds = [...new Set([
      ...this.hosts.keys(),
      ...this.activations.keys(),
      ...this.stops.keys(),
      ...this.hostExitCleanups.keys()
    ])]
    await Promise.allSettled(extensionIds.map((extensionId) => this.deactivate(extensionId)))
    await Promise.allSettled([...this.stops.values(), ...this.hostExitCleanups.values()])
    for (const timer of this.healthyTimers.values()) clearTimeout(timer)
    this.healthyTimers.clear()
    this.idleEligibleExtensions.clear()
    this.viewReferences.clear()
  }

  async retry(extensionId: string): Promise<void> {
    await this.deactivate(extensionId)
    await this.updateHealth(extensionId, (health) => ({
      ...health,
      lifecycleState: 'inactive',
      circuitOpen: false,
      consecutiveFailures: 0,
      nextRetryAt: undefined,
      lastError: undefined,
      updatedAt: this.now().toISOString()
    }))
  }

  async diagnostic(extensionId: string): Promise<ExtensionHostDiagnostic> {
    const [document, selectedCompatibility] = await Promise.all([
      this.readHealth(),
      this.options.packageManager.compatibilityReportForExtension(extensionId)
    ])
    const persisted = document.extensions[extensionId] ?? emptyHealth(extensionId, this.now())
    const host = this.hosts.get(extensionId)
    const compatibility = host?.compatibilityReport ?? selectedCompatibility
    const negotiatedApiVersion = compatibility?.api.compatible
      ? compatibility.api.negotiatedApiVersion
      : undefined
    return {
      ...structuredClone(persisted),
      active: host?.state === 'active',
      processId: host?.pid,
      lifecycleState: host === undefined && persisted.lifecycleState === 'active'
        ? 'inactive'
        : host?.state ?? persisted.lifecycleState,
      ...(host === undefined ? {} : { logPath: host.logPath }),
      ...(compatibility === undefined ? {} : { compatibility: structuredClone(compatibility) }),
      ...(negotiatedApiVersion === undefined ? {} : { negotiatedApiVersion }),
      ...(compatibility?.rpc.negotiated === undefined
        ? {}
        : { negotiatedRpcVersion: compatibility.rpc.negotiated })
    }
  }

  async listDiagnostics(): Promise<ExtensionHostDiagnostic[]> {
    const document = await this.readHealth()
    const extensionIds = new Set([...Object.keys(document.extensions), ...this.hosts.keys()])
    return Promise.all([...extensionIds].sort().map((extensionId) => this.diagnostic(extensionId)))
  }

  async migrateState(
    extension: ResolvedExtension,
    from: number,
    to: number,
    state: JsonValue,
    options: { scope: 'global' | 'workspace'; workspace?: JsonValue; signal?: AbortSignal }
  ): Promise<JsonValue> {
    const host = this.createHost(extension, [])
    try {
      return await host.migrateState(from, to, state, options)
    } finally {
      await host.deactivate().catch(() => host.terminate())
    }
  }

  packageLifecycle(): ExtensionPackageLifecycle {
    return {
      beforeVersionSwitch: async ({ extensionId }) => this.deactivate(extensionId),
      beforeDisable: async (extensionId) => this.deactivate(extensionId),
      beforePermissionChange: async (extensionId) => this.deactivate(extensionId),
      beforeUninstall: async (extensionId) => this.deactivate(extensionId)
    }
  }

  private async activateInternal(
    extensionId: string,
    event: string,
    options: {
      workspaceRoot?: string
      workspaceRoots?: string[]
      workspaceContext?: WorkspaceContext
    },
    activationEpoch: number
  ): Promise<ExtensionHostProcess | undefined> {
    const workspaceRoots = normalizedWorkspaceRoots(options)
    const workspaceKeys = workspaceRoots.map((root) => this.options.paths.workspaceKey(root))
    let extension: ResolvedExtension
    try {
      const resolvedScopes: ResolvedExtension[] = []
      if (workspaceKeys.length === 0) {
        resolvedScopes.push(await this.options.packageManager.resolveForActivation(extensionId))
      } else {
        // Every root is an independent trust/enablement boundary. Resolving
        // only `workspaceRoot` while passing additional `workspaceRoots` to
        // the Host would let callers smuggle an unreviewed root into the
        // principal. The Host receives the intersection of all grants.
        for (const workspaceKey of workspaceKeys) {
          resolvedScopes.push(await this.options.packageManager.resolveForActivation(
            extensionId,
            workspaceKey
          ))
        }
      }
      extension = intersectWorkspaceResolutions(resolvedScopes)
      this.assertActivationCurrent(extensionId, activationEpoch)
    } catch (error) {
      if ((error as { code?: string }).code === 'EXTENSION_ACTIVATION_CANCELLED') throw error
      const normalized = asExtensionError(
        error,
        'EXTENSION_ACTIVATION_ADMISSION_FAILED',
        'Extension activation admission failed'
      )
      await this.updateHealth(extensionId, (prior) => ({
        ...prior,
        lifecycleState: isCompatibilityError(normalized.code) ? 'incompatible' : 'unavailable',
        processId: undefined,
        lastError: {
          code: normalized.code,
          message: redactSecretText(normalized.message).slice(0, 2_000),
          details: redactSecrets(structuredClone(normalized.details))
        },
        updatedAt: this.now().toISOString()
      }))
      throw error
    }
    if (!activationMatches(extension.manifest.activationEvents, event)) {
      throw extensionError(
        'EXTENSION_ACTIVATION_EVENT_NOT_DECLARED',
        'Activation event is not declared by the extension',
        { extensionId, event }
      )
    }
    if (extension.manifest.main === undefined) {
      this.idleEligibleExtensions.delete(extensionId)
      this.cancelIdleDeactivation(extensionId)
      this.assertActivationCurrent(extensionId, activationEpoch)
      await this.updateHealth(extensionId, (health) => ({
        ...health,
        version: extension.version,
        lifecycleState: 'browser-only',
        activationEvent: event,
        updatedAt: this.now().toISOString()
      }))
      if (this.activationEpoch(extensionId) !== activationEpoch) {
        await this.updateHealth(extensionId, (health) => ({
          ...health,
          lifecycleState: 'stopped',
          processId: undefined,
          updatedAt: this.now().toISOString()
        }))
        this.assertActivationCurrent(extensionId, activationEpoch)
      }
      return undefined
    }

    const current = this.hosts.get(extensionId)
    if (
      current !== undefined &&
      current.principal.version === extension.version &&
      current.principal.development === extension.development &&
      current.state === 'active'
    ) {
      this.setIdleEligibility(extensionId, extension.manifest)
      assertWorkspaceScope(
        current.principal,
        workspaceRoots
      )
      this.assertActivationCurrent(extensionId, activationEpoch)
      return current
    }
    if (current !== undefined) await this.stopHost(extensionId)

    const health = (await this.readHealth()).extensions[extensionId] ?? emptyHealth(extensionId, this.now())
    if (health.circuitOpen) {
      throw extensionError('EXTENSION_HOST_CIRCUIT_OPEN', 'Extension host circuit is open', {
        extensionId,
        consecutiveFailures: health.consecutiveFailures,
        lastError: health.lastError
      })
    }
    if (health.nextRetryAt !== undefined && Date.parse(health.nextRetryAt) > this.now().getTime()) {
      throw extensionError('EXTENSION_HOST_RESTART_BACKOFF', 'Extension host is in restart backoff', {
        extensionId,
        retryAt: health.nextRetryAt
      })
    }
    this.assertActivationCurrent(extensionId, activationEpoch)

    const host = this.createHost(extension, workspaceRoots, options.workspaceContext)
    this.hosts.set(extensionId, host)
    try {
      await this.updateHealth(extensionId, (prior) => ({
        ...prior,
        version: extension.version,
        lifecycleState: 'activating',
        activationEvent: event,
        restartCount: prior.restartCount + (prior.consecutiveFailures > 0 ? 1 : 0),
        processId: undefined,
        logPath: host.logPath,
        updatedAt: this.now().toISOString()
      }))
      this.assertActivationCurrent(extensionId, activationEpoch)
      await host.activate(event)
      this.assertActivationCurrent(extensionId, activationEpoch)
      await this.updateHealth(extensionId, (prior) => ({
        ...prior,
        version: extension.version,
        lifecycleState: 'active',
        activationEvent: event,
        processId: host.pid,
        nextRetryAt: undefined,
        logPath: host.logPath,
        updatedAt: this.now().toISOString()
      }))
      this.assertActivationCurrent(extensionId, activationEpoch)
      this.scheduleHealthyReset(extensionId, host)
      this.setIdleEligibility(extensionId, extension.manifest)
      await this.options.onHostActivated?.(host.principal)
      return host
    } catch (error) {
      if (this.hosts.get(extensionId) === host) this.hosts.delete(extensionId)
      if ((error as { code?: string }).code === 'EXTENSION_ACTIVATION_CANCELLED') {
        await host.deactivate().catch(() => host.terminate())
        await this.updateHealth(extensionId, (health) => ({
          ...health,
          lifecycleState: 'stopped',
          processId: undefined,
          updatedAt: this.now().toISOString()
        }))
        throw error
      }
      await this.recordHostFailure(extensionId, extension.version, host, error)
      throw error
    }
  }

  private createHost(
    extension: ResolvedExtension,
    workspaceRoots: string[],
    workspaceContext?: WorkspaceContext
  ): ExtensionHostProcess {
    const compatibilityReport = this.options.packageManager.admitManifest(extension.manifest)
    const negotiatedCapabilities = new Set(
      compatibilityReport.api.compatible ? compatibilityReport.api.capabilities : []
    )
    let host: ExtensionHostProcess
    host = new ExtensionHostProcess({
      extension,
      compatibilityReport,
      paths: this.options.paths,
      workspaceRoots,
      workspaceContext,
      capabilities: (this.options.capabilitiesForExtension?.(extension) ?? [])
        .filter((capability) => negotiatedCapabilities.has(capability)),
      runnerPath: this.options.runnerPath,
      limits: this.options.hostLimits,
      broker: this.options.broker,
      requiredPermission: this.options.requiredPermission,
      onNotification: this.options.onNotification,
      onStream: this.options.onStream,
      onExit: (exit) => this.handleHostExit(host, exit)
    })
    return host
  }

  private handleHostExit(host: ExtensionHostProcess, exit: ExtensionHostExit): Promise<void> {
    const prior = this.hostExitCleanups.get(exit.extensionId)
    const cleanup = (async () => {
      if (prior !== undefined) await prior
      await this.handleHostExitInternal(host, exit)
    })()
    this.hostExitCleanups.set(exit.extensionId, cleanup)
    cleanup.then(
      () => {
        if (this.hostExitCleanups.get(exit.extensionId) === cleanup) {
          this.hostExitCleanups.delete(exit.extensionId)
        }
      },
      () => {
        if (this.hostExitCleanups.get(exit.extensionId) === cleanup) {
          this.hostExitCleanups.delete(exit.extensionId)
        }
      }
    )
    return cleanup
  }

  private async handleHostExitInternal(
    host: ExtensionHostProcess,
    exit: ExtensionHostExit
  ): Promise<void> {
    if (this.hosts.get(exit.extensionId) === host) this.hosts.delete(exit.extensionId)
    this.cancelIdleDeactivation(exit.extensionId)
    this.idleEligibleExtensions.delete(exit.extensionId)
    const timer = this.healthyTimers.get(exit.extensionId)
    if (timer !== undefined) clearTimeout(timer)
    this.healthyTimers.delete(exit.extensionId)
    await this.options.onHostExit?.(exit)
    if (!exit.expected) {
      await this.recordHostFailure(
        exit.extensionId,
        host.principal.version,
        host,
        exit.error === undefined
          ? extensionError('EXTENSION_HOST_CRASHED', 'Extension host crashed')
          : extensionError(exit.error.code, exit.error.message, exit.error.details)
      )
    }
  }

  private async waitForLifecycleTransition(extensionId: string): Promise<void> {
    while (true) {
      const pending = this.stops.get(extensionId) ?? this.hostExitCleanups.get(extensionId)
      if (pending === undefined) return
      await pending
    }
  }

  private async waitForHostExitCleanup(extensionId: string): Promise<void> {
    while (true) {
      const cleanup = this.hostExitCleanups.get(extensionId)
      if (cleanup === undefined) return
      await cleanup
    }
  }

  private setIdleEligibility(extensionId: string, manifest: ExtensionManifest): void {
    if (isViewIdleDeactivationEligible(manifest)) {
      this.idleEligibleExtensions.add(extensionId)
      return
    }
    this.idleEligibleExtensions.delete(extensionId)
    this.cancelIdleDeactivation(extensionId)
  }

  private scheduleIdleDeactivation(extensionId: string): void {
    if (
      this.shuttingDown ||
      this.idleTimers.has(extensionId) ||
      (this.viewReferences.get(extensionId) ?? 0) > 0 ||
      !this.idleEligibleExtensions.has(extensionId)
    ) return
    const host = this.hosts.get(extensionId)
    if (host === undefined || host.state !== 'active') return
    const timer = setTimeout(() => {
      if (this.idleTimers.get(extensionId) !== timer) return
      this.idleTimers.delete(extensionId)
      if (
        this.shuttingDown ||
        (this.viewReferences.get(extensionId) ?? 0) > 0 ||
        !this.idleEligibleExtensions.has(extensionId) ||
        this.hosts.get(extensionId) !== host ||
        host.state !== 'active'
      ) return
      void this.deactivate(extensionId).catch(() => undefined)
    }, this.viewIdleTimeoutMs)
    timer.unref?.()
    this.idleTimers.set(extensionId, timer)
  }

  private cancelIdleDeactivation(extensionId: string): void {
    const timer = this.idleTimers.get(extensionId)
    if (timer !== undefined) clearTimeout(timer)
    this.idleTimers.delete(extensionId)
  }

  private async recordFailure(
    extensionId: string,
    version: string,
    host: ExtensionHostProcess,
    error: unknown
  ): Promise<void> {
    const normalized = asExtensionError(error)
    await this.updateHealth(extensionId, (prior) => {
      const consecutiveFailures = prior.consecutiveFailures + 1
      const circuitOpen = consecutiveFailures >= this.crashThreshold
      const backoff = Math.min(
        this.restartBackoffMaxMs,
        this.restartBackoffMs * 2 ** Math.max(0, consecutiveFailures - 1)
      )
      return {
        ...prior,
        version,
        lifecycleState: circuitOpen ? 'circuit-open' : 'crashed',
        processId: undefined,
        consecutiveFailures,
        circuitOpen,
        nextRetryAt: circuitOpen
          ? undefined
          : new Date(this.now().getTime() + backoff).toISOString(),
        lastError: {
          code: normalized.code,
          message: redactSecretText(normalized.message).slice(0, 2_000),
          details: redactSecrets(structuredClone(normalized.details))
        },
        logPath: host.logPath,
        updatedAt: this.now().toISOString()
      }
    })
  }

  private async recordHostFailure(
    extensionId: string,
    version: string,
    host: ExtensionHostProcess,
    error: unknown
  ): Promise<void> {
    if (this.recordedFailures.has(host)) return
    this.recordedFailures.add(host)
    await this.recordFailure(extensionId, version, host, error)
  }

  private scheduleHealthyReset(extensionId: string, host: ExtensionHostProcess): void {
    const prior = this.healthyTimers.get(extensionId)
    if (prior !== undefined) clearTimeout(prior)
    const timer = setTimeout(() => {
      this.healthyTimers.delete(extensionId)
      if (this.hosts.get(extensionId) !== host || host.state !== 'active') return
      void this.updateHealth(extensionId, (health) => ({
        ...health,
        consecutiveFailures: 0,
        circuitOpen: false,
        nextRetryAt: undefined,
        updatedAt: this.now().toISOString()
      }))
    }, this.healthyResetMs)
    timer.unref?.()
    this.healthyTimers.set(extensionId, timer)
  }

  private readHealth(): Promise<HostHealthDocument> {
    return this.healthFile.read(() => ({ schemaVersion: 1, revision: 0, extensions: {} }))
  }

  private updateHealth(
    extensionId: string,
    update: (health: PersistedHostHealth) => PersistedHostHealth
  ): Promise<HostHealthDocument> {
    return this.healthFile.update(
      () => ({ schemaVersion: 1, revision: 0, extensions: {} }),
      (document) => {
        const next = structuredClone(document)
        next.revision += 1
        next.extensions[extensionId] = update(
          next.extensions[extensionId] ?? emptyHealth(extensionId, this.now())
        )
        return next
      }
    )
  }

  private now(): Date {
    return this.options.now?.() ?? new Date()
  }
}

function emptyHealth(extensionId: string, now: Date): PersistedHostHealth {
  return {
    extensionId,
    lifecycleState: 'inactive',
    restartCount: 0,
    consecutiveFailures: 0,
    circuitOpen: false,
    updatedAt: now.toISOString()
  }
}

function validateHealthDocument(value: unknown): HostHealthDocument {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.revision) ||
    !isRecord(value.extensions)
  ) {
    throw extensionError('EXTENSION_HOST_HEALTH_INVALID', 'Extension host health file is invalid')
  }
  for (const [extensionId, health] of Object.entries(value.extensions)) {
    if (
      !isRecord(health) ||
      health.extensionId !== extensionId ||
      typeof health.lifecycleState !== 'string' ||
      !Number.isSafeInteger(health.restartCount) ||
      !Number.isSafeInteger(health.consecutiveFailures) ||
      typeof health.circuitOpen !== 'boolean' ||
      typeof health.updatedAt !== 'string'
    ) {
      throw extensionError('EXTENSION_HOST_HEALTH_INVALID', 'Extension host health record is invalid', {
        extensionId
      })
    }
  }
  return value as unknown as HostHealthDocument
}

function activationMatches(declared: string[], event: string): boolean {
  return declared.includes('*') || declared.includes(event)
}

/**
 * A Node Host is idle-disposable only when every executable contribution is
 * View-scoped. Declarative layout/settings contributions do not keep it alive.
 */
export function isViewIdleDeactivationEligible(manifest: ExtensionManifest): boolean {
  if (
    manifest.main === undefined ||
    manifest.activationEvents.length === 0 ||
    manifest.activationEvents.some((event) => !event.startsWith('onView:'))
  ) return false
  const contributions = manifest.contributes
  return contributions.commands.length === 0 &&
    contributions.tools.length === 0 &&
    contributions.modelProviders.length === 0 &&
    contributions.authentication.length === 0 &&
    contributions.agentProfiles.length === 0 &&
    contributions.hostContentScripts.length === 0
}

function assertWorkspaceScope(principal: ExtensionPrincipal, requestedRoots: string[]): void {
  const granted = new Set(principal.workspaceRoots)
  const missing = requestedRoots.map((root) => root).filter((root) => !granted.has(root))
  if (missing.length > 0) {
    throw extensionError(
      'EXTENSION_WORKSPACE_SCOPE_MISMATCH',
      'Active extension host is not bound to the requested workspace roots',
      { missing }
    )
  }
}

function normalizedWorkspaceRoots(options: {
  workspaceRoot?: string
  workspaceRoots?: string[]
}): string[] {
  const roots = [...new Set([
    ...(options.workspaceRoots ?? []),
    ...(options.workspaceRoot === undefined ? [] : [options.workspaceRoot])
  ].map((root) => resolve(root)))].sort()
  if (roots.length > 32) {
    throw extensionError(
      'EXTENSION_WORKSPACE_SCOPE_INVALID',
      'Extension activation cannot bind more than 32 workspace roots',
      { count: roots.length }
    )
  }
  return roots
}

function sameWorkspaceRoots(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((root, index) => root === right[index])
}

function intersectWorkspaceResolutions(scopes: ResolvedExtension[]): ResolvedExtension {
  const first = scopes[0]
  if (first === undefined) {
    throw extensionError(
      'EXTENSION_ACTIVATION_ADMISSION_FAILED',
      'Extension activation produced no admitted scope'
    )
  }
  for (const scope of scopes.slice(1)) {
    if (
      scope.id !== first.id ||
      scope.version !== first.version ||
      resolve(scope.packagePath) !== resolve(first.packagePath) ||
      scope.development !== first.development ||
      scope.generation !== first.generation
    ) {
      throw extensionError(
        'EXTENSION_WORKSPACE_SELECTION_MISMATCH',
        'Workspace scopes resolved to different extension packages',
        { extensionId: first.id }
      )
    }
  }
  return {
    ...first,
    grantedPermissions: first.grantedPermissions.filter((permission) =>
      scopes.every((scope) => scope.grantedPermissions.includes(permission)))
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw extensionError('EXTENSION_HOST_LIMIT_INVALID', 'Extension manager limit is invalid', {
      name,
      value: resolved
    })
  }
  return resolved
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCompatibilityError(code: string): boolean {
  return /(?:MANIFEST_VERSION|API_(?:VERSION|MINOR|CAPABILITY)|ENGINE|RPC_VERSION).*?(?:UNSUPPORTED|INCOMPATIBLE|REQUIRED)/.test(code)
}
