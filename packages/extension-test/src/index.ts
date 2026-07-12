import {
  AccountSchema,
  AgentCreateRunRequestSchema,
  AgentRunEventSchema,
  ExtensionApiError,
  ExtensionHostClient,
  ExtensionToolDeclarationSchema,
  HostMessageSchema,
  JsonObjectSchema,
  JsonValueSchema,
  ModelProviderDeclarationSchema,
  NetworkRequestSchema,
  NetworkResponseSchema,
  NotificationOptionsSchema,
  ProviderStatusSchema,
  ThemeSchema,
  LocaleSchema,
  createExtensionContext,
  hasPermission,
  toDisposable,
  type Account,
  type Activate,
  type AgentCreateRunRequest,
  type AgentRun,
  type AgentRunEvent,
  type Deactivate,
  type Disposable,
  type ExtensionContext,
  type ExtensionIdentity,
  type ExtensionToolDeclaration,
  type HostNotification,
  type HostRequestContext,
  type HostRequestHandler,
  type HostRequestOptions,
  type HostTransport,
  type JsonObject,
  type JsonValue,
  type ModelProviderDeclaration,
  type ModelProviderStreamEvent,
  type NetworkResponse,
  type Permission,
  type ProviderStatus,
  type Theme,
  type Locale,
  type WorkspaceContext,
  type WorkspaceFile
} from '@kun/extension-api'

type FakeHostHandler = (
  params: JsonValue | undefined,
  options: HostRequestOptions
) => unknown | Promise<unknown>
type PermissionResolver = (params: JsonValue | undefined) => string | undefined

export class FakeClock {
  #now: number

  constructor(now = Date.parse('2026-01-01T00:00:00.000Z')) {
    this.#now = now
  }

  now(): number {
    return this.#now
  }

  nowIso(): string {
    return new Date(this.#now).toISOString()
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('FakeClock can only advance by a positive duration')
    this.#now += ms
  }
}

export interface FakeTransportOptions {
  permissions?: Iterable<Permission | string>
}

export class FakeHostTransport implements HostTransport {
  readonly #hostHandlers = new Map<string, FakeHostHandler>()
  readonly #extensionHandlers = new Map<string, HostRequestHandler>()
  readonly #notificationListeners = new Set<(notification: HostNotification) => void>()
  readonly #permissionResolvers = new Map<string, PermissionResolver>()
  readonly permissions = new Set<string>()
  readonly sentNotifications: HostNotification[] = []
  readonly sentStreams: Array<{ requestId: string; payload: JsonValue; terminal: boolean }> = []
  readonly requests: Array<{ method: string; params?: JsonValue }> = []
  #disposed = false
  #nextInvocation = 1

  constructor(options: FakeTransportOptions = {}) {
    for (const permission of options.permissions ?? []) this.permissions.add(permission)
  }

  handle(method: string, handler: FakeHostHandler): Disposable {
    this.#hostHandlers.set(method, handler)
    return toDisposable(() => {
      this.#hostHandlers.delete(method)
    })
  }

  requirePermission(method: string, permission: string | PermissionResolver): void {
    this.#permissionResolvers.set(method, typeof permission === 'string' ? () => permission : permission)
  }

  grant(...permissions: string[]): void {
    for (const permission of permissions) this.permissions.add(permission)
  }

  deny(...permissions: string[]): void {
    for (const permission of permissions) this.permissions.delete(permission)
  }

  async request(
    method: string,
    params?: JsonValue,
    options: HostRequestOptions = {}
  ): Promise<unknown> {
    this.#assertActive()
    if (options.signal?.aborted) throw this.#cancelled(method)
    this.requests.push({ method, params })
    const required = this.#permissionResolvers.get(method)?.(params)
    if (required && !hasPermission([...this.permissions], required)) {
      throw new ExtensionApiError({
        code: 'PERMISSION_DENIED',
        message: `Permission ${required} is required for ${method}`,
        operation: method,
        retryable: false,
        details: { permission: required }
      })
    }
    const handler = this.#hostHandlers.get(method)
    if (!handler) {
      throw new ExtensionApiError({
        code: 'UNSUPPORTED_CAPABILITY',
        message: `Fake Host has no handler for ${method}`,
        operation: method,
        retryable: false
      })
    }
    return handler(params, options)
  }

  notify(method: string, params?: JsonValue): void {
    this.#assertActive()
    this.sentNotifications.push({ method, params })
  }

  async sendStream(requestId: string, payload: JsonValue, terminal = false): Promise<void> {
    this.#assertActive()
    this.sentStreams.push({ requestId, payload, terminal })
  }

  onNotification(listener: (notification: HostNotification) => void): Disposable {
    this.#notificationListeners.add(listener)
    return toDisposable(() => {
      this.#notificationListeners.delete(listener)
    })
  }

  registerHandler(method: string, handler: HostRequestHandler): Disposable {
    if (this.#extensionHandlers.has(method)) throw new Error(`Duplicate extension handler: ${method}`)
    this.#extensionHandlers.set(method, handler)
    return toDisposable(() => {
      this.#extensionHandlers.delete(method)
    })
  }

  emit(method: string, params?: JsonValue): void {
    this.#assertActive()
    for (const listener of [...this.#notificationListeners]) listener({ method, params })
  }

  async invokeExtension(
    method: string,
    params?: JsonValue,
    options: HostRequestOptions = {}
  ): Promise<JsonValue> {
    this.#assertActive()
    const handler = this.#extensionHandlers.get(method)
    if (!handler) {
      throw new ExtensionApiError({
        code: 'NOT_FOUND',
        message: `Extension handler ${method} is not registered`,
        operation: method,
        retryable: false
      })
    }
    return handler(params, {
      signal: options.signal,
      requestId: `fake_request_${this.#nextInvocation++}`
    })
  }

  dispose(): void {
    this.#disposed = true
    this.#hostHandlers.clear()
    this.#extensionHandlers.clear()
    this.#notificationListeners.clear()
    this.sentStreams.splice(0)
  }

  #assertActive(): void {
    if (this.#disposed) throw new Error('FakeHostTransport is disposed')
  }

  #cancelled(operation: string): ExtensionApiError {
    return new ExtensionApiError({
      code: 'CANCELLED',
      message: `${operation} was cancelled`,
      operation,
      retryable: false
    })
  }
}

export class FakeStorageService {
  readonly global = new Map<string, JsonValue>()
  readonly workspace = new Map<string, JsonValue>()

  install(transport: FakeHostTransport): void {
    const store = (params: JsonValue | undefined) => {
      const parsed = JsonObjectSchema.parse(params)
      return parsed.scope === 'global' ? this.global : this.workspace
    }
    transport.handle('storage.get', (params) => {
      const parsed = JsonObjectSchema.parse(params)
      const selected = store(params)
      const key = String(parsed.key)
      return selected.has(key) ? { found: true, value: selected.get(key) } : { found: false }
    })
    transport.handle('storage.set', (params) => {
      const parsed = JsonObjectSchema.parse(params)
      store(params).set(String(parsed.key), JsonValueSchema.parse(parsed.value))
      return { ok: true }
    })
    transport.handle('storage.delete', (params) => {
      const parsed = JsonObjectSchema.parse(params)
      return { deleted: store(params).delete(String(parsed.key)) }
    })
    transport.handle('storage.keys', (params) => [...store(params).keys()].sort())
  }
}

export class FakeWorkspaceService {
  readonly files = new Map<string, WorkspaceFile>()

  install(transport: FakeHostTransport): void {
    transport.handle('workspace.readFile', (params) => {
      const { path } = JsonObjectSchema.parse(params)
      const file = this.files.get(String(path))
      if (!file) throw notFound(`Workspace file ${String(path)} was not found`, 'workspace.readFile')
      return file
    })
    transport.handle('workspace.writeFile', (params) => {
      const file = params as unknown as WorkspaceFile
      this.files.set(file.path, file)
      return { ok: true }
    })
    transport.handle('workspace.stat', (params) => {
      const { path } = JsonObjectSchema.parse(params)
      const file = this.files.get(String(path))
      return file
        ? { path: file.path, type: 'file', size: file.content.length }
        : { path: String(path), type: 'directory', size: 0 }
    })
    transport.handle('workspace.list', (params) => {
      const { path = '.' } = JsonObjectSchema.parse(params)
      const prefix = String(path) === '.' ? '' : `${String(path).replace(/\/$/, '')}/`
      return [...this.files.values()]
        .filter((file) => file.path.startsWith(prefix))
        .map((file) => ({ path: file.path, type: 'file', size: file.content.length }))
    })
  }
}

export class FakeAgentService {
  readonly runs = new Map<string, AgentRun>()
  readonly events = new Map<string, AgentRunEvent[]>()
  readonly #subscriptions = new Map<string, string>()
  #nextRun = 1
  #nextSubscription = 1

  constructor(
    private readonly transport: FakeHostTransport,
    private readonly clock: FakeClock,
    private readonly identity: ExtensionIdentity
  ) {}

  install(): void {
    this.transport.handle('agent.createRun', (params) => this.createRun(AgentCreateRunRequestSchema.parse(params)))
    this.transport.handle('agent.getRun', (params) => this.getRun(String(JsonObjectSchema.parse(params).runId)))
    this.transport.handle('agent.subscribe', (params) => {
      const parsed = JsonObjectSchema.parse(params)
      const runId = String(parsed.runId)
      this.getRun(runId)
      const subscriptionId = `subscription-${this.#nextSubscription++}`
      this.#subscriptions.set(subscriptionId, runId)
      const after = Number(parsed.afterSequence ?? 0)
      return {
        subscriptionId,
        replay: (this.events.get(runId) ?? []).filter((event) => event.sequence > after)
      }
    })
    this.transport.handle('agent.unsubscribe', (params) => {
      this.#subscriptions.delete(String(JsonObjectSchema.parse(params).subscriptionId))
      return { ok: true }
    })
    this.transport.handle('agent.steer', (params) => {
      const parsed = JsonObjectSchema.parse(params)
      const run = this.getRun(String(parsed.runId))
      this.emit(run.id, 'steering-accepted', { steeringId: `steering-${this.clock.now()}` })
      return { accepted: true, run }
    })
    this.transport.handle('agent.cancel', (params) => {
      const run = this.getRun(String(JsonObjectSchema.parse(params).runId))
      if (!isTerminal(run.state)) {
        const updated: AgentRun = {
          ...run,
          state: 'cancelled',
          updatedAt: this.clock.nowIso(),
          terminalAt: this.clock.nowIso()
        }
        this.runs.set(run.id, updated)
        this.emit(run.id, 'terminal', { state: 'cancelled' })
      }
      return { accepted: true, run: this.getRun(run.id) }
    })
    this.transport.handle('threads.listOwn', () => ({
      items: [...this.runs.values()].map((run) => ({
        id: run.threadId,
        ownerExtensionId: run.ownerExtensionId,
        ownerExtensionVersion: run.ownerExtensionVersion,
        extensionVisibility: run.extensionVisibility,
        latestRun: run,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt
      })),
      page: { hasMore: false }
    }))
    this.transport.handle('threads.getOwn', (params) => {
      const threadId = String(JsonObjectSchema.parse(params).threadId)
      const run = [...this.runs.values()].find((candidate) => candidate.threadId === threadId)
      if (!run) throw notFound(`Thread ${threadId} was not found`, 'threads.getOwn')
      return {
        id: threadId,
        ownerExtensionId: run.ownerExtensionId,
        ownerExtensionVersion: run.ownerExtensionVersion,
        extensionVisibility: run.extensionVisibility,
        latestRun: run,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt
      }
    })
  }

  createRun(request: AgentCreateRunRequest): { run: AgentRun; createdThread: boolean } {
    const id = `run-${this.#nextRun++}`
    const threadId = request.threadId ?? `thread-${id}`
    const run: AgentRun = {
      id,
      threadId,
      ownerExtensionId: this.identity.id,
      ownerExtensionVersion: this.identity.version,
      accountId: request.providerBinding?.accountId,
      extensionVisibility: request.visibility ?? 'private',
      extensionProfile: request.profileId
        ? {
            id: request.profileId,
            instructionDigest: 'fake-profile-digest',
            providerBinding: request.providerBinding,
            allowedTools: request.allowedTools ?? [],
            budget: request.budget ?? {}
          }
        : undefined,
      extensionBudget: request.budget ?? {},
      toolCatalogEpoch: 'fake-epoch-1',
      state: 'running',
      providerBinding: request.providerBinding,
      createdAt: this.clock.nowIso(),
      updatedAt: this.clock.nowIso()
    }
    this.runs.set(id, run)
    this.events.set(id, [])
    this.emit(id, 'state', { state: 'running' })
    return { run, createdThread: !request.threadId }
  }

  getRun(runId: string): AgentRun {
    const run = this.runs.get(runId)
    if (!run) throw notFound(`Run ${runId} was not found`, 'agent.getRun')
    return run
  }

  emit(runId: string, type: AgentRunEvent['type'], fields: JsonObject = {}): AgentRunEvent {
    const run = this.getRun(runId)
    const list = this.events.get(runId) ?? []
    const event = AgentRunEventSchema.parse({
      runId,
      threadId: run.threadId,
      sequence: list.length + 1,
      timestamp: this.clock.nowIso(),
      type,
      ...fields
    })
    list.push(event)
    this.events.set(runId, list)
    for (const [subscriptionId, subscribedRun] of this.#subscriptions) {
      if (subscribedRun === runId) this.transport.emit('agent.event', { subscriptionId, event })
    }
    return event
  }
}

export class FakeToolService {
  readonly registrations = new Map<string, ExtensionToolDeclaration>()
  #next = 1

  constructor(private readonly transport: FakeHostTransport) {}

  install(): void {
    this.transport.handle('tools.register', (params) => {
      const registrationId = `tool-${this.#next++}`
      this.registrations.set(registrationId, ExtensionToolDeclarationSchema.parse(params))
      return { registrationId }
    })
    this.transport.handle('tools.unregister', (params) => {
      this.registrations.delete(String(JsonObjectSchema.parse(params).registrationId))
      return { ok: true }
    })
  }

  invoke(registrationId: string, input: JsonObject, signal?: AbortSignal): Promise<JsonValue> {
    const declaration = this.registrations.get(registrationId)
    if (!declaration) throw notFound(`Tool ${registrationId} is not registered`, 'tools.invoke')
    return this.transport.invokeExtension(
      `tools.invoke:${registrationId}`,
      {
        invocationId: `invocation-${registrationId}`,
        toolId: declaration.id,
        input
      },
      { signal }
    )
  }
}

export class FakeProviderService {
  readonly registrations = new Map<string, ModelProviderDeclaration>()
  readonly statuses = new Map<string, ProviderStatus>()
  #next = 1

  constructor(
    private readonly transport: FakeHostTransport,
    private readonly clock: FakeClock
  ) {}

  install(): void {
    this.transport.handle('modelProviders.register', (params) => {
      const declaration = ModelProviderDeclarationSchema.parse(params)
      const registrationId = `provider-${this.#next++}`
      this.registrations.set(registrationId, declaration)
      this.statuses.set(declaration.id, {
        providerId: declaration.id,
        status: 'available',
        checkedAt: this.clock.nowIso()
      })
      return { registrationId }
    })
    this.transport.handle('modelProviders.unregister', (params) => {
      this.registrations.delete(String(JsonObjectSchema.parse(params).registrationId))
      return { ok: true }
    })
    this.transport.handle('modelProviders.getStatus', (params) => {
      const providerId = String(JsonObjectSchema.parse(params).providerId)
      return (
        this.statuses.get(providerId) ?? {
          providerId,
          status: 'unavailable',
          checkedAt: this.clock.nowIso()
        }
      )
    })
  }

  async invoke(
    registrationId: string,
    invocation: JsonObject,
    signal?: AbortSignal
  ): Promise<JsonValue> {
    return this.transport.invokeExtension(`modelProviders.invoke:${registrationId}`, invocation, { signal })
  }

  takeStreamEvents(registrationId: string): ModelProviderStreamEvent[] {
    const events = this.transport.sentStreams
      .map((item) => JsonObjectSchema.parse(item.payload))
      .filter((item) => item.kind === 'event')
      .filter((item) => item.registrationId === registrationId)
      .map((item) => item.event as unknown as ModelProviderStreamEvent)
    this.transport.sentStreams.splice(
      0,
      this.transport.sentStreams.length,
      ...this.transport.sentStreams.filter((item) => {
        const payload = JsonObjectSchema.parse(item.payload)
        return payload.registrationId !== registrationId
      })
    )
    return events
  }
}

export class FakeAccountService {
  readonly accounts = new Map<string, Account>()
  readonly secrets = new Map<string, string>()
  #nextSession = 1
  readonly sessions = new Map<string, JsonObject>()

  constructor(private readonly clock: FakeClock) {}

  addAccount(account: Omit<Account, 'createdAt' | 'updatedAt'>, secret?: string): Account {
    const parsed = AccountSchema.parse({
      ...account,
      createdAt: this.clock.nowIso(),
      updatedAt: this.clock.nowIso()
    })
    this.accounts.set(parsed.id, parsed)
    if (secret !== undefined) this.secrets.set(parsed.id, secret)
    return parsed
  }

  install(transport: FakeHostTransport): void {
    transport.handle('authentication.listAccounts', (params) => {
      const providerId = JsonObjectSchema.parse(params).providerId
      return [...this.accounts.values()].filter(
        (account) => providerId === undefined || account.providerId === providerId
      )
    })
    transport.handle('authentication.createSession', (params) => {
      const request = JsonObjectSchema.parse(params)
      const id = `account-session-${this.#nextSession++}`
      const session = { id, status: 'pending' as const, message: `Authorize ${String(request.providerId)}` }
      this.sessions.set(id, session)
      return session
    })
    transport.handle('authentication.getSession', (params) => {
      const id = String(JsonObjectSchema.parse(params).sessionId)
      const session = this.sessions.get(id)
      if (!session) throw notFound(`Account session ${id} was not found`, 'authentication.getSession')
      return session
    })
    transport.handle('authentication.cancelSession', (params) => {
      const id = String(JsonObjectSchema.parse(params).sessionId)
      this.sessions.set(id, { id, status: 'cancelled' })
      return { ok: true }
    })
    transport.handle('authentication.deleteAccount', (params) => {
      const id = String(JsonObjectSchema.parse(params).accountId)
      this.accounts.delete(id)
      this.secrets.delete(id)
      return { ok: true }
    })
    transport.handle('authentication.revealSecret', (params) => {
      const id = String(JsonObjectSchema.parse(params).accountId)
      const secret = this.secrets.get(id)
      if (!secret) throw notFound(`Secret for account ${id} was not found`, 'authentication.revealSecret')
      return { secret }
    })
    transport.handle('authentication.authenticatedFetch', (params) => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountId: JsonObjectSchema.parse(params).accountId }),
      bodyEncoding: 'utf8',
      truncated: false
    }))
  }
}

export class FakeWebviewService {
  theme: Theme = ThemeSchema.parse({ kind: 'dark', tokens: {}, zoomFactor: 1, reducedMotion: false })
  locale: Locale = LocaleSchema.parse({ language: 'en', direction: 'ltr', messages: {} })
  state: JsonValue | undefined
  readonly messages: JsonValue[] = []
  readonly notifications: Array<{
    id: string
    title: string
    message: string
    severity: 'info' | 'warning' | 'error'
    actions: Array<{ id: string; title: string }>
  }> = []
  readonly #notificationResponses: Array<{ value?: string }> = []

  install(transport: FakeHostTransport): void {
    transport.handle('ui.getTheme', () => this.theme)
    transport.handle('ui.getLocale', () => this.locale)
    transport.handle('ui.getViewState', () =>
      this.state === undefined ? { found: false } : { found: true, value: this.state }
    )
    transport.handle('ui.setViewState', (params) => {
      this.state = JsonObjectSchema.parse(params).value
      return { ok: true }
    })
    transport.handle('ui.postMessage', (params) => {
      this.messages.push(HostMessageSchema.parse(params))
      return { ok: true }
    })
    transport.handle('ui.showNotification', (params) => {
      this.notifications.push(NotificationOptionsSchema.parse(params))
      return this.#notificationResponses.shift() ?? {}
    })
  }

  setTheme(transport: FakeHostTransport, theme: Theme): void {
    this.theme = ThemeSchema.parse(theme)
    transport.emit('ui.themeChanged', this.theme)
  }

  setLocale(transport: FakeHostTransport, locale: Locale): void {
    this.locale = LocaleSchema.parse(locale)
    transport.emit('ui.localeChanged', this.locale)
  }

  sendMessage(transport: FakeHostTransport, channel: string, payload: JsonValue): void {
    transport.emit('ui.message', { channel, payload })
  }

  respondToNextNotification(actionId?: string): void {
    this.#notificationResponses.push(actionId === undefined ? {} : { value: actionId })
  }
}

export interface ExtensionTestHarnessOptions {
  identity?: ExtensionIdentity
  permissions?: Iterable<Permission | string>
  workspace?: WorkspaceContext
  clock?: FakeClock
}

export class ExtensionTestHarness implements Disposable {
  readonly identity: ExtensionIdentity
  readonly permissions: Set<string>
  readonly clock: FakeClock
  readonly transport: FakeHostTransport
  readonly storage = new FakeStorageService()
  readonly workspace = new FakeWorkspaceService()
  readonly agent: FakeAgentService
  readonly tools: FakeToolService
  readonly providers: FakeProviderService
  readonly accounts: FakeAccountService
  readonly webview = new FakeWebviewService()
  readonly configuration = new Map<string, JsonValue>()
  readonly client: ExtensionHostClient
  readonly context: ExtensionContext
  #deactivate?: Deactivate

  constructor(options: ExtensionTestHarnessOptions = {}) {
    this.identity =
      options.identity ??
      ({ id: 'test.extension', publisher: 'test', name: 'extension', version: '1.0.0' } as const)
    this.clock = options.clock ?? new FakeClock()
    this.transport = new FakeHostTransport({ permissions: options.permissions })
    this.permissions = this.transport.permissions
    this.agent = new FakeAgentService(this.transport, this.clock, this.identity)
    this.tools = new FakeToolService(this.transport)
    this.providers = new FakeProviderService(this.transport, this.clock)
    this.accounts = new FakeAccountService(this.clock)

    this.#installPermissionRules()
    this.#installServices()
    this.client = new ExtensionHostClient(this.transport)
    this.context = createExtensionContext(
      this.transport,
      {
        extension: this.identity,
        apiVersion: '1.0.0',
        capabilities: [],
        permissions: [...this.permissions],
        workspaceContext: options.workspace,
        activationEvent: 'onStartup'
      },
      this.client
    )
  }

  async activate(activate: Activate<ExtensionContext>, deactivate?: Deactivate): Promise<ExtensionContext> {
    this.#deactivate = deactivate
    await activate(this.context)
    return this.context
  }

  grant(...permissions: string[]): void {
    this.transport.grant(...permissions)
  }

  deny(...permissions: string[]): void {
    this.transport.deny(...permissions)
  }

  async dispose(): Promise<void> {
    await this.#deactivate?.()
    await this.context.subscriptions.dispose()
  }

  #installServices(): void {
    this.storage.install(this.transport)
    this.workspace.install(this.transport)
    this.agent.install()
    this.tools.install()
    this.providers.install()
    this.accounts.install(this.transport)
    this.webview.install(this.transport)
    this.transport.handle('configuration.get', (params) => {
      const input = JsonObjectSchema.parse(params)
      const key = `${String(input.sectionId)}/${String(input.key)}`
      const value = this.configuration.get(key)
      return value === undefined ? { found: false } : { found: true, value }
    })
    this.transport.handle('configuration.update', (params) => {
      const input = JsonObjectSchema.parse(params)
      const sectionId = String(input.sectionId)
      const key = String(input.key)
      const value = JsonValueSchema.parse(input.value)
      this.configuration.set(`${sectionId}/${key}`, value)
      this.transport.emit('configuration.changed', {
        sectionId,
        key,
        scope: 'workspace',
        value
      })
      return null
    })
    this.transport.handle('configuration.keys', (params) => {
      const sectionId = `${String(JsonObjectSchema.parse(params).sectionId)}/`
      return [...this.configuration.keys()]
        .filter((key) => key.startsWith(sectionId))
        .map((key) => key.slice(sectionId.length))
        .sort()
    })
    this.transport.handle('commands.register', (params) => ({
      registrationId: `command-${String(JsonObjectSchema.parse(params).id)}`
    }))
    this.transport.handle('commands.unregister', () => ({ ok: true }))
    this.transport.handle('commands.execute', (params) => {
      const parsed = JsonObjectSchema.parse(params)
      return this.transport.invokeExtension(`commands.invoke:command-${String(parsed.id)}`, parsed.args)
    })
    this.transport.handle('network.fetch', (params) => {
      const request = NetworkRequestSchema.parse(params)
      return NetworkResponseSchema.parse({
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: request.url, method: request.method }),
        bodyEncoding: 'utf8',
        truncated: false
      })
    })
  }

  #installPermissionRules(): void {
    this.transport.requirePermission('commands.register', 'commands.register')
    this.transport.requirePermission('storage.get', storagePermission)
    this.transport.requirePermission('storage.set', storagePermission)
    this.transport.requirePermission('storage.delete', storagePermission)
    this.transport.requirePermission('storage.keys', storagePermission)
    this.transport.requirePermission('network.fetch', (params) => {
      const request = NetworkRequestSchema.parse(params)
      return `network:${new URL(request.url).hostname}`
    })
    for (const method of [
      'agent.createRun',
      'agent.getRun',
      'agent.subscribe',
      'agent.unsubscribe',
      'agent.steer',
      'agent.cancel'
    ]) {
      this.transport.requirePermission(method, 'agent.run')
    }
    this.transport.requirePermission('threads.listOwn', 'agent.threads.readOwn')
    this.transport.requirePermission('threads.getOwn', 'agent.threads.readOwn')
    this.transport.requirePermission('tools.register', 'tools.register')
    this.transport.requirePermission('modelProviders.register', 'providers.register')
    this.transport.requirePermission('authentication.listAccounts', 'accounts.read')
    this.transport.requirePermission('configuration.get', 'ui.actions')
    this.transport.requirePermission('configuration.update', 'ui.actions')
    this.transport.requirePermission('configuration.keys', 'ui.actions')
    this.transport.requirePermission('ui.showNotification', 'ui.notifications')
    this.transport.requirePermission('authentication.revealSecret', (params) => {
      const account = this.accounts.accounts.get(String(JsonObjectSchema.parse(params).accountId))
      return account ? `accounts.secrets.read:${account.providerId}` : 'accounts.read'
    })
    this.transport.requirePermission('workspace.readFile', 'workspace.read')
    this.transport.requirePermission('workspace.stat', 'workspace.read')
    this.transport.requirePermission('workspace.list', 'workspace.read')
    this.transport.requirePermission('workspace.writeFile', 'workspace.write')
  }
}

function storagePermission(params: JsonValue | undefined): string {
  return JsonObjectSchema.parse(params).scope === 'global' ? 'storage.global' : 'storage.workspace'
}

function notFound(message: string, operation: string): ExtensionApiError {
  return new ExtensionApiError({
    code: 'NOT_FOUND',
    message,
    operation,
    retryable: false
  })
}

function isTerminal(state: AgentRun['state']): boolean {
  return ['completed', 'failed', 'cancelled', 'budget-exhausted'].includes(state)
}

export function createExtensionTestHarness(
  options: ExtensionTestHarnessOptions = {}
): ExtensionTestHarness {
  return new ExtensionTestHarness(options)
}
