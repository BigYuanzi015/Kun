import { describe, expect, it, vi } from 'vitest'
import { ExtensionManifestSchema, type ModelProviderAdapter } from '@kun/extension-api'
import type { ExtensionToolHandler } from '../adapters/tool/extension-tool-provider.js'
import type { ExtensionBrokerRequest, ExtensionPrincipal as HostPrincipal } from '../extensions/host-process.js'
import {
  ExtensionHostBroker,
  requiredExtensionBrokerPermission
} from './extension-host-broker.js'

const manifest = ExtensionManifestSchema.parse({
  manifestVersion: 1,
  apiVersion: '1.0.0',
  name: 'broker',
  publisher: 'acme',
  version: '1.0.0',
  engines: { kun: '>=0.1.0' },
  main: 'dist/extension.js',
  activationEvents: [
    'onCommand:hello',
    'onTool:summarize',
    'onProvider:echo',
    'onAuthentication:echo-auth'
  ],
  contributes: {
    commands: [{
      id: 'hello',
      title: 'Hello',
      inputSchema: { type: 'object' },
      outputSchema: {
        type: 'object',
        properties: { invoked: { type: 'boolean' } },
        required: ['invoked'],
        additionalProperties: false
      }
    }],
    tools: [{
      id: 'summarize',
      description: 'Summarize input',
      inputSchema: { type: 'object' },
      outputSchema: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
        additionalProperties: false
      },
      sideEffects: 'external'
    }],
    modelProviders: [{
      id: 'echo',
      displayName: 'Echo',
      authenticationProviderId: 'echo-auth',
      credentialHosts: ['api.example.test'],
      models: [{
        id: 'echo-1',
        displayName: 'Echo 1',
        capabilities: { input: ['text'], output: ['text'] }
      }]
    }],
    authentication: [{
      id: 'echo-auth',
      displayName: 'Echo API key',
      type: 'api-key'
    }],
    settings: [{
      id: 'general',
      title: 'General',
      properties: { mode: { type: 'string', default: 'safe' } }
    }]
  },
  permissions: [
    'commands.register',
    'tools.register',
    'providers.register',
    'ui.actions',
    'network:api.example.test'
  ],
  stateSchemaVersion: 1
})

const principal: HostPrincipal = {
  extensionId: 'acme.broker',
  version: '1.0.0',
  apiVersion: '1.0.0',
  lifecycleNonce: 'de7c65b3-f455-4199-aa83-1722fdf8309d',
  grantedPermissions: manifest.permissions,
  workspaceRoots: ['/tmp/workspace'],
  development: true
}

function request(method: string, params: unknown): ExtensionBrokerRequest {
  return {
    principal,
    method,
    params: JSON.parse(JSON.stringify(params ?? null)),
    signal: new AbortController().signal,
    requestId: `request_${method}`
  }
}

describe('ExtensionHostBroker', () => {
  it('routes declared configuration through the host-owned service and reserves internal state keys', async () => {
    const configuration = {
      get: vi.fn(async () => 'safe'),
      update: vi.fn(async () => ({ schemaVersion: 1, revision: 1, values: {} })),
      keys: vi.fn(async () => ['mode'])
    }
    const broker = createBroker({ configuration })
    await expect(broker.handle(request('configuration.get', {
      sectionId: 'general',
      key: 'mode'
    }))).resolves.toEqual({ found: true, value: 'safe' })
    await expect(broker.handle(request('configuration.update', {
      sectionId: 'general',
      key: 'mode',
      value: 'fast'
    }))).resolves.toBeNull()
    await expect(broker.handle(request('configuration.keys', {
      sectionId: 'general'
    }))).resolves.toEqual(['mode'])
    await expect(broker.handle(request('storage.get', {
      scope: 'global',
      key: '__kun_configuration_document_v1'
    }))).rejects.toThrow(/Reserved/)
    await expect(broker.handle(request('storage.set', {
      scope: 'global',
      key: 'visible',
      value: true
    }))).resolves.toBeNull()
    await expect(broker.handle(request('storage.keys', {
      scope: 'global'
    }))).resolves.toEqual(['visible'])
  })

  it('routes commands and tools using only the connection-bound identity', async () => {
    let toolHandler: ExtensionToolHandler | undefined
    let broker!: ExtensionHostBroker
    const progress = vi.fn(async () => undefined)
    const invokeExtension = vi.fn(async (
      extensionId: string,
      _event: string,
      method: string,
      params: unknown
    ) => {
      expect(extensionId).toBe('acme.broker')
      if (method.startsWith('tools.invoke:')) {
        const invocationId = (params as { invocationId: string }).invocationId
        await broker.notification(principal, 'tools.progress', {
          invocationId,
          message: 'halfway',
          fraction: 0.5
        })
        return { content: { summary: 'done' } }
      }
      return { invoked: true }
    })
    broker = createBroker({
      invokeExtension,
      tools: {
        register: vi.fn(async (_principal, _declaration, handler) => {
          toolHandler = handler
          return { canonicalToolId: 'extension:acme.broker/summarize', modelAlias: 'ext_summary', dispose() {} }
        })
      }
    })

    const command = await broker.handle(request('commands.register', { id: 'hello' })) as { registrationId: string }
    await expect(broker.handle(request('commands.execute', {
      id: 'hello',
      args: { extensionId: 'forged.owner' }
    }))).resolves.toEqual({ invoked: true })
    expect(invokeExtension).toHaveBeenCalledWith(
      'acme.broker',
      'onCommand:hello',
      `commands.invoke:${command.registrationId}`,
      { extensionId: 'forged.owner' },
      expect.any(Object)
    )

    await broker.handle(request('tools.register', manifest.contributes.tools[0]))
    const result = await toolHandler!({
      invocationId: 'invocation_1',
      canonicalToolId: 'extension:acme.broker/summarize',
      modelAlias: 'ext_summary',
      arguments: { text: 'hello' },
      threadId: 'thread_1',
      turnId: 'turn_1',
      workspace: '/tmp/workspace',
      signal: new AbortController().signal,
      reportProgress: progress
    })
    expect(result).toEqual({
      output: { content: { summary: 'done' } },
      declaredOutput: { summary: 'done' },
      isError: false
    })
    expect(progress).toHaveBeenCalledWith({
      output: { type: 'extension_tool_progress', message: 'halfway', fraction: 0.5 }
    })
  })

  it('enforces manifest command schemas and rejects runtime declaration drift', async () => {
    const invokeExtension = vi.fn(async (_extensionId, _event, method) => {
      if (method.startsWith('commands.invoke:')) return { invoked: 'not-a-boolean' }
      return null
    })
    const tools = { register: vi.fn() }
    const modelProviders = { register: vi.fn() }
    const providerAccounts = {
      registerProvider: vi.fn(),
      unregisterProvider: vi.fn()
    }
    const broker = createBroker({ invokeExtension, tools, modelProviders, providerAccounts })

    await broker.handle(request('commands.register', { id: 'hello' }))
    await expect(broker.handle(request('commands.execute', {
      id: 'hello', args: 'invalid-command-input'
    }))).rejects.toThrow(/declared JSON Schema/)
    await expect(broker.handle(request('commands.execute', {
      id: 'hello', args: { valid: true }
    }))).rejects.toThrow(/command hello result does not match/)

    await expect(broker.handle(request('tools.register', {
      ...manifest.contributes.tools[0],
      sideEffects: 'none'
    }))).rejects.toThrow(/does not match its active manifest/)
    expect(tools.register).not.toHaveBeenCalled()

    await expect(broker.handle(request('modelProviders.register', {
      ...manifest.contributes.modelProviders[0],
      credentialHosts: []
    }))).rejects.toThrow(/does not match its active manifest/)
    expect(providerAccounts.registerProvider).not.toHaveBeenCalled()
    expect(modelProviders.register).not.toHaveBeenCalled()
  })

  it('disposes command-only extensions during broker shutdown', async () => {
    const broker = createBroker({
      invokeExtension: vi.fn(async () => ({ invoked: true }))
    })
    await broker.handle(request('commands.register', { id: 'hello' }))
    await expect(broker.handle(request('commands.execute', {
      id: 'hello', args: { valid: true }
    }))).resolves.toEqual({ invoked: true })

    await broker.dispose()

    await expect(broker.handle(request('commands.execute', {
      id: 'hello', args: { valid: true }
    }))).rejects.toThrow('command is not registered')
  })

  it('preserves the manifest output schema and content value at the ToolHost boundary', async () => {
    let toolHandler: ExtensionToolHandler | undefined
    const register = vi.fn(async (_principal, _declaration, handler) => {
      toolHandler = handler
      return {
        canonicalToolId: 'extension:acme.broker/summarize',
        modelAlias: 'ext_summary',
        dispose() {}
      }
    })
    const broker = createBroker({
      invokeExtension: vi.fn(async () => ({ content: { summary: 42 } })),
      tools: { register }
    })
    await broker.handle(request('tools.register', manifest.contributes.tools[0]))
    expect(register).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ outputSchema: manifest.contributes.tools[0]!.outputSchema }),
      expect.any(Function)
    )

    await expect(toolHandler!({
      invocationId: 'invocation_invalid_output',
      canonicalToolId: 'extension:acme.broker/summarize',
      modelAlias: 'ext_summary',
      arguments: {},
      threadId: 'thread_1',
      turnId: 'turn_1',
      workspace: '/tmp/workspace',
      signal: new AbortController().signal,
      reportProgress: async () => undefined
    })).resolves.toMatchObject({
      declaredOutput: { summary: 42 }
    })
  })

  it('keeps bounded legacy model-provider notifications compatible', async () => {
    let adapter: ModelProviderAdapter | undefined
    let broker!: ExtensionHostBroker
    const invokeExtension = vi.fn(async (
      _extensionId: string,
      _event: string,
      method: string,
      params: unknown
    ) => {
      if (method.startsWith('modelProviders.invoke:') && (params as { operation: string }).operation === 'stream') {
        const registrationId = method.slice('modelProviders.invoke:'.length)
        const modelRequest = (params as { request: { requestId: string } }).request
        await broker.notification(principal, 'modelProviders.streamEvent', {
          registrationId,
          event: { requestId: modelRequest.requestId, sequence: 0, type: 'textDelta', delta: 'hello' }
        })
        await broker.notification(principal, 'modelProviders.streamEvent', {
          registrationId,
          event: { requestId: modelRequest.requestId, sequence: 1, type: 'completed', finishReason: 'stop' }
        })
      }
      return { accepted: true }
    })
    broker = createBroker({
      invokeExtension,
      providerAccounts: {
        registerProvider: vi.fn(async () => ({ id: 'ext-provider-echo' })),
        unregisterProvider: vi.fn(async () => true)
      },
      modelProviders: {
        register: vi.fn(async (_principal, _declaration, registeredAdapter) => {
          adapter = registeredAdapter
          return { providerId: 'ext-provider-echo', async dispose() {} }
        })
      }
    })

    await broker.handle(request('modelProviders.register', manifest.contributes.modelProviders[0]))
    const events = []
    for await (const event of adapter!.stream({
      apiVersion: '1.0.0',
      requestId: 'model_request_1',
      binding: { providerId: 'ext-provider-echo', accountId: 'account_1', modelId: 'echo-1' },
      instructions: [],
      messages: [],
      tools: [],
      generation: {}
    }, cancellationContext())) events.push(event)
    expect(events.map((event) => event.type)).toEqual(['textDelta', 'completed'])
  })

  it('bridges acknowledgement-backed provider stream envelopes per model request', async () => {
    let adapter: ModelProviderAdapter | undefined
    let broker!: ExtensionHostBroker
    const invokeExtension = vi.fn(async (
      _extensionId: string,
      _event: string,
      method: string,
      params: unknown
    ) => {
      if (method.startsWith('modelProviders.invoke:') && (params as { operation: string }).operation === 'stream') {
        const registrationId = method.slice('modelProviders.invoke:'.length)
        const modelRequest = (params as { request: { requestId: string } }).request
        await broker.stream(principal, 'rpc_model_request_1', 1, {
          kind: 'event',
          registrationId,
          requestId: modelRequest.requestId,
          event: {
            requestId: modelRequest.requestId,
            sequence: 0,
            type: 'textDelta',
            delta: 'streamed'
          }
        }, false)
        await broker.stream(principal, 'rpc_model_request_1', 2, {
          kind: 'event',
          registrationId,
          requestId: modelRequest.requestId,
          event: {
            requestId: modelRequest.requestId,
            sequence: 1,
            type: 'completed',
            finishReason: 'stop'
          }
        }, true)
      }
      return { accepted: true }
    })
    broker = createBroker({
      invokeExtension,
      providerAccounts: {
        registerProvider: vi.fn(async () => ({ id: 'ext-provider-echo' })),
        unregisterProvider: vi.fn(async () => true)
      },
      modelProviders: {
        register: vi.fn(async (_principal, _declaration, registeredAdapter) => {
          adapter = registeredAdapter
          return { providerId: 'ext-provider-echo', async dispose() {} }
        })
      }
    })

    await broker.handle(request('modelProviders.register', manifest.contributes.modelProviders[0]))
    const events = []
    for await (const event of adapter!.stream({
      apiVersion: '1.0.0',
      requestId: 'model_request_stream',
      binding: { providerId: 'ext-provider-echo', accountId: 'account_1', modelId: 'echo-1' },
      instructions: [],
      messages: [],
      tools: [],
      generation: {}
    }, cancellationContext())) events.push(event)
    expect(events.map((event) => event.type)).toEqual(['textDelta', 'completed'])
  })

  it('fails only the overflowing legacy provider request instead of growing its queue', async () => {
    let adapter: ModelProviderAdapter | undefined
    let broker!: ExtensionHostBroker
    const invokeExtension = vi.fn(async (
      _extensionId: string,
      _event: string,
      method: string,
      params: unknown
    ) => {
      const registrationId = method.slice('modelProviders.invoke:'.length)
      const modelRequest = (params as { request: { requestId: string } }).request
      for (let sequence = 0; sequence < 3; sequence += 1) {
        void broker.notification(principal, 'modelProviders.streamEvent', {
          registrationId,
          event: {
            requestId: modelRequest.requestId,
            sequence,
            type: 'textDelta',
            delta: `event-${sequence}`
          }
        })
      }
      return { accepted: true }
    })
    broker = createBroker({
      invokeExtension,
      providerStreamQueueEvents: 1,
      providerAccounts: {
        registerProvider: vi.fn(async () => ({ id: 'ext-provider-echo' })),
        unregisterProvider: vi.fn(async () => true)
      },
      modelProviders: {
        register: vi.fn(async (_principal, _declaration, registeredAdapter) => {
          adapter = registeredAdapter
          return { providerId: 'ext-provider-echo', async dispose() {} }
        })
      }
    })

    await broker.handle(request('modelProviders.register', manifest.contributes.modelProviders[0]))
    const iterator = adapter!.stream({
      apiVersion: '1.0.0',
      requestId: 'model_request_overflow',
      binding: { providerId: 'ext-provider-echo', accountId: 'account_1', modelId: 'echo-1' },
      instructions: [],
      messages: [],
      tools: [],
      generation: {}
    }, cancellationContext())[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toThrow('queue limit exceeded')
  })

  it('returns fixed pre-gate permissions and leaves dynamic network scopes to broker validation', () => {
    expect(requiredExtensionBrokerPermission('storage.get', { scope: 'global', key: 'x' })).toBe('storage.global')
    expect(requiredExtensionBrokerPermission('agent.createRun', {})).toBe('agent.run')
    expect(requiredExtensionBrokerPermission('network.fetch', { url: 'https://api.example.test' })).toBeUndefined()
  })

  it('routes live Agent events to the sender-bound View while keeping Node subscriptions on Node IPC', async () => {
    const listeners: Array<(event: {
      seq: number
      timestamp: string
      type: 'assistant_text_delta' | 'turn_completed'
      runId: string
      threadId: string
      ownerExtensionId: string
      payload: Record<string, unknown>
    }) => Promise<void> | void> = []
    const closes: Array<ReturnType<typeof vi.fn>> = []
    const agent = {
      subscribe: vi.fn(async (_principal, _input, listener) => {
        listeners.push(listener)
        const close = vi.fn()
        closes.push(close)
        return { lastDeliveredSeq: 0, closed: false, close }
      })
    }
    const notifyView = vi.fn(async () => undefined)
    const notifyExtension = vi.fn(async () => undefined)
    const broker = createBroker({ agent, notifyView, notifyExtension })
    const viewPrincipal = {
      extensionId: 'acme.broker',
      extensionVersion: '1.0.0',
      permissions: ['agent.run'],
      workspaceRoots: ['/tmp/workspace'],
      workspaceTrusted: true,
      viewSessionId: 'view-session-one',
      viewContributionId: 'extension:acme.broker/panel'
    } as const

    const viewSubscription = await broker.handlePrincipal({
      principal: viewPrincipal,
      method: 'agent.subscribe',
      params: { runId: 'run-1', afterSequence: 0 },
      signal: new AbortController().signal,
      requestId: 'subscribe-from-view'
    }) as { subscriptionId: string }
    await listeners[0]!({
      seq: 1,
      timestamp: new Date().toISOString(),
      type: 'assistant_text_delta',
      runId: 'run-1',
      threadId: 'thread-1',
      ownerExtensionId: 'acme.broker',
      payload: { delta: 'hello' }
    })

    expect(notifyView).toHaveBeenCalledWith({
      principal: viewPrincipal,
      method: 'agent.event',
      params: expect.objectContaining({
        subscriptionId: viewSubscription.subscriptionId,
        event: expect.objectContaining({ type: 'message', sequence: 2 })
      })
    })
    expect(notifyExtension).not.toHaveBeenCalled()

    await broker.handlePrincipal({
      principal: { ...viewPrincipal, viewSessionId: 'view-session-two' },
      method: 'agent.unsubscribe',
      params: { subscriptionId: viewSubscription.subscriptionId },
      signal: new AbortController().signal,
      requestId: 'foreign-view-unsubscribe'
    })
    expect(closes[0]).not.toHaveBeenCalled()
    expect(broker.disposeViewSession('view-session-one')).toBe(1)
    expect(closes[0]).toHaveBeenCalledTimes(1)

    const failedViewSubscription = await broker.handlePrincipal({
      principal: viewPrincipal,
      method: 'agent.subscribe',
      params: { runId: 'run-failed-view', afterSequence: 0 },
      signal: new AbortController().signal,
      requestId: 'subscribe-from-failed-view'
    }) as { subscriptionId: string }
    notifyView.mockRejectedValueOnce(new Error('view session closed'))
    await expect(listeners[1]!({
      seq: 1,
      timestamp: new Date().toISOString(),
      type: 'assistant_text_delta',
      runId: 'run-failed-view',
      threadId: 'thread-failed-view',
      ownerExtensionId: 'acme.broker',
      payload: { delta: 'late' }
    })).rejects.toThrow('view session closed')
    expect(closes[1]).toHaveBeenCalledTimes(1)
    expect(broker.disposeViewSession('view-session-one')).toBe(0)
    expect(failedViewSubscription.subscriptionId).toMatch(/^agentsub_/)

    const nodeSubscription = await broker.handle(request('agent.subscribe', {
      runId: 'run-2',
      afterSequence: 0
    })) as { subscriptionId: string }
    await listeners[2]!({
      seq: 2,
      timestamp: new Date().toISOString(),
      type: 'turn_completed',
      runId: 'run-2',
      threadId: 'thread-2',
      ownerExtensionId: 'acme.broker',
      payload: {}
    })
    expect(notifyExtension).toHaveBeenCalledWith(
      'acme.broker',
      'agent.event',
      expect.objectContaining({ subscriptionId: nodeSubscription.subscriptionId })
    )
    expect(closes[2]).toHaveBeenCalledTimes(1)
  })

  it('bounds network responses, strips credential headers, and never auto-follows redirects', async () => {
    const fetchImpl = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(init?.redirect).toBe('manual')
      let sent = 0
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (sent >= 2) {
            controller.close()
            return
          }
          sent += 1
          controller.enqueue(new Uint8Array(5 * 1024 * 1024).fill(97))
        }
      })
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': 'text/plain',
          'set-cookie': 'secret=value',
          authorization: 'Bearer response-secret',
          'x-request-id': 'safe-id'
        }
      })
    }) as unknown as typeof fetch
    const broker = createBroker({ fetch: fetchImpl })
    const result = await broker.handlePrincipal({
      principal: {
        extensionId: 'acme.broker',
        extensionVersion: '1.0.0',
        permissions: ['network:api.example.test'],
        workspaceRoots: [],
        workspaceTrusted: false
      },
      method: 'network.fetch',
      params: { url: 'https://api.example.test/large' },
      signal: new AbortController().signal,
      requestId: 'bounded-network-response'
    }) as { body: string; truncated: boolean; headers: Record<string, string> }
    expect(Buffer.byteLength(result.body)).toBe(8 * 1024 * 1024)
    expect(result.truncated).toBe(true)
    expect(result.headers['set-cookie']).toBeUndefined()
    expect(result.headers.authorization).toBeUndefined()
    expect(result.headers['x-request-id']).toBe('safe-id')
  })

  it('uses the production DNS/address policy when no test fetch is injected', async () => {
    const broker = createBroker()
    await expect(broker.handlePrincipal({
      principal: {
        extensionId: 'acme.broker',
        extensionVersion: '1.0.0',
        permissions: ['network:127.0.0.1'],
        workspaceRoots: [],
        workspaceTrusted: false
      },
      method: 'network.fetch',
      params: { url: 'https://127.0.0.1/metadata' },
      signal: new AbortController().signal,
      requestId: 'blocked-loopback-network'
    })).rejects.toThrow(/resolved to blocked loopback address 127\.0\.0\.1/)
  })

  it('persists global Webview state per contribution when no workspace is active', async () => {
    const broker = createBroker()
    const viewPrincipal = {
      extensionId: 'acme.broker',
      extensionVersion: '1.0.0',
      permissions: ['ui.views'],
      workspaceRoots: [],
      workspaceTrusted: false,
      viewContributionId: 'extension:acme.broker/primary'
    } as const
    const signal = new AbortController().signal
    await broker.handlePrincipal({
      principal: viewPrincipal,
      method: 'ui.setViewState',
      params: { value: { selected: 'item-1' } },
      signal,
      requestId: 'set-view-state'
    })
    await expect(broker.handlePrincipal({
      principal: viewPrincipal,
      method: 'ui.getViewState',
      params: {},
      signal,
      requestId: 'get-view-state'
    })).resolves.toEqual({ found: true, value: { selected: 'item-1' } })
    await expect(broker.handlePrincipal({
      principal: { ...viewPrincipal, viewContributionId: 'extension:acme.broker/secondary' },
      method: 'ui.getViewState',
      params: {},
      signal,
      requestId: 'get-other-view-state'
    })).resolves.toEqual({ found: false })
  })

  it('completes PKCE only through the protected callback path and redacts session internals', async () => {
    const now = '2026-07-11T10:00:00.000Z'
    const completePkceAuthorization = vi.fn(async () => ({
      id: 'account_pkce',
      providerId: 'echo',
      ownerExtensionId: 'acme.broker',
      label: 'Echo account',
      authType: 'oauth-pkce' as const,
      status: 'connected' as const,
      metadata: {},
      createdAt: now,
      updatedAt: now
    }))
    const broker = createBroker({
      providerAccounts: {
        requireOwnedProvider: vi.fn(async () => ({
          id: 'echo', displayName: 'Echo', oauthPkce: {}
        }))
      },
      accounts: {
        beginPkceAuthorization: vi.fn(async () => ({
          transactionId: 'pkce_transaction',
          authorizationUrl: 'https://auth.example/authorize',
          expiresAt: '2099-07-11T10:10:00.000Z'
        })),
        completePkceAuthorization
      }
    })
    const accountPrincipal = {
      extensionId: 'acme.broker',
      extensionVersion: '1.0.0',
      permissions: ['accounts.manage:echo'],
      workspaceRoots: [],
      workspaceTrusted: false
    }
    const session = await broker.handlePrincipal({
      principal: accountPrincipal,
      method: 'authentication.createSession',
      params: {
        providerId: 'echo', authenticationProviderId: 'echo-auth', label: 'Echo account'
      },
      signal: new AbortController().signal,
      requestId: 'create-pkce-session'
    }) as { id: string; transactionId?: string; providerId?: string }
    expect(session).toMatchObject({
      status: 'pending',
      message: expect.stringMatching(/Settings > Extensions/)
    })
    expect(session).not.toHaveProperty('verificationUrl')
    expect(session).not.toHaveProperty('transactionId')
    expect(session).not.toHaveProperty('providerId')

    await expect(broker.handleTrustedManagement({
      principal: accountPrincipal,
      method: 'authentication.getSession',
      params: { sessionId: session.id },
      signal: new AbortController().signal,
      requestId: 'protected-get-pkce-session'
    })).resolves.toMatchObject({
      status: 'pending',
      verificationUrl: 'https://auth.example/authorize'
    })

    const completed = await broker.completePkceAccountSession({
      principal: accountPrincipal,
      sessionId: session.id,
      callbackUrl: 'https://callback.example/?code=authorization-code&state=expected-state'
    })
    expect(completed).toMatchObject({
      status: 'completed',
      account: { id: 'account_pkce', protection: 'encrypted-fallback' }
    })
    expect(completePkceAuthorization).toHaveBeenCalledWith(expect.objectContaining({
      transactionId: 'pkce_transaction',
      code: 'authorization-code',
      state: 'expected-state',
      protectedCallback: true
    }))
  })

  it('rejects raw-secret requests outside Node and before prompting without permission', async () => {
    const authorizeSecretReveal = vi.fn(async () => true)
    const revealSecret = vi.fn(async () => ({ apiKey: 'must-not-be-returned' }))
    const broker = createBroker({
      providerAccounts: {
        getAccount: vi.fn(async () => ({
          id: 'account_secret',
          providerId: 'echo',
          ownerExtensionId: 'acme.broker'
        }))
      },
      accounts: { revealSecret },
      authorizeSecretReveal
    })
    const viewPrincipal = {
      extensionId: 'acme.broker',
      extensionVersion: '1.0.0',
      permissions: ['accounts.secrets.read:echo'],
      workspaceRoots: ['/tmp/workspace'],
      workspaceTrusted: true,
      viewSessionId: 'view_secret',
      viewContributionId: 'secret'
    }

    await expect(broker.handlePrincipal({
      principal: viewPrincipal,
      method: 'authentication.revealSecret',
      params: { accountId: 'account_secret', operation: 'sign-request' },
      signal: new AbortController().signal,
      requestId: 'view-secret-request'
    })).rejects.toThrow(/Node Extension Host/)
    await expect(broker.handle(request('authentication.revealSecret', {
      accountId: 'account_secret', operation: 'sign-request'
    }))).rejects.toThrow(/Missing permission/)
    expect(authorizeSecretReveal).not.toHaveBeenCalled()
    expect(revealSecret).not.toHaveBeenCalled()
  })

  it('polls device authorization in the broker and projects completion through session polling', async () => {
    const now = '2026-07-11T10:00:00.000Z'
    let completeDevice!: (account: unknown) => void
    const completion = new Promise((resolve) => { completeDevice = resolve })
    const broker = createBroker({
      providerAccounts: {
        requireOwnedProvider: vi.fn(async () => ({
          id: 'echo', displayName: 'Echo', oauthDevice: {}
        }))
      },
      accounts: {
        beginDeviceAuthorization: vi.fn(async () => ({
          transactionId: 'device_transaction',
          verificationUri: 'https://auth.example/device',
          userCode: 'ABCD-EFGH',
          expiresAt: '2099-07-11T10:10:00.000Z'
        })),
        completeDeviceAuthorization: vi.fn(() => completion)
      }
    })
    const accountPrincipal = {
      extensionId: 'acme.broker',
      extensionVersion: '1.0.0',
      permissions: ['accounts.manage:echo'],
      workspaceRoots: [],
      workspaceTrusted: false
    }
    const session = await broker.handleTrustedManagement({
      principal: accountPrincipal,
      method: 'authentication.createSession',
      params: { providerId: 'echo', authenticationProviderId: 'echo-auth' },
      signal: new AbortController().signal,
      requestId: 'create-device-session'
    }) as { id: string }
    expect(session).toMatchObject({
      status: 'pending',
      verificationUrl: 'https://auth.example/device',
      userCode: 'ABCD-EFGH'
    })

    completeDevice({
      id: 'account_device',
      providerId: 'echo',
      ownerExtensionId: 'acme.broker',
      label: 'Echo',
      authType: 'oauth-device',
      status: 'connected',
      metadata: {},
      createdAt: now,
      updatedAt: now
    })
    await vi.waitFor(async () => {
      await expect(broker.handlePrincipal({
        principal: accountPrincipal,
        method: 'authentication.getSession',
        params: { sessionId: session.id },
        signal: new AbortController().signal,
        requestId: 'poll-device-session'
      })).resolves.toMatchObject({ status: 'completed', account: { id: 'account_device' } })
    })
  })
})

function createBroker(overrides: Record<string, unknown> = {}): ExtensionHostBroker {
  const state = new Map<string, unknown>()
  return new ExtensionHostBroker({
    agent: {} as never,
    profiles: { register: () => () => undefined } as never,
    tools: { register: vi.fn() } as never,
    modelProviders: { register: vi.fn() } as never,
    providerAccounts: {
      registerProvider: vi.fn(),
      unregisterProvider: vi.fn(),
      getAccount: vi.fn(),
      requireOwnedProvider: vi.fn(),
      validateBinding: vi.fn()
    } as never,
    accounts: {} as never,
    credentials: { protection: async () => ({ mode: 'encrypted-fallback' }) } as never,
    state: {
      read: async () => ({
        global: Object.fromEntries(state),
        workspaces: {}
      }),
      getGlobal: async (_id: string, key: string) => state.get(key),
      setGlobal: async (_id: string, key: string, value: unknown) => {
        if (value === undefined) state.delete(key)
        else state.set(key, value)
      }
    } as never,
    invokeExtension: vi.fn(async () => null),
    notifyExtension: vi.fn(async () => undefined),
    resolveManifest: async () => manifest,
    ...overrides
  } as never)
}

function cancellationContext() {
  return {
    cancellation: {
      isCancellationRequested: false,
      onCancellationRequested: () => ({ dispose() {} })
    }
  }
}
