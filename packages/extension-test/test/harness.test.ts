import { describe, expect, it } from 'vitest'
import { ExtensionApiError } from '@kun/extension-api'
import { createExtensionTestHarness } from '../src/index.js'

const permissions = [
  'commands.register',
  'storage.global',
  'storage.workspace',
  'agent.run',
  'agent.threads.readOwn',
  'tools.register',
  'providers.register',
  'accounts.read',
  'workspace.read',
  'workspace.write',
  'ui.notifications',
  'network:api.example.com'
]

describe('ExtensionTestHarness', () => {
  it('runs commands, storage, Agent events, and tools deterministically', async () => {
    const harness = createExtensionTestHarness({ permissions })
    const command = await harness.client.commands.registerCommand('hello', async (args) => ({ args }))
    expect(await harness.client.commands.executeCommand('hello', 'world')).toEqual({ args: 'world' })

    await harness.client.storage.global.set('answer', 42)
    expect(await harness.client.storage.global.get('answer')).toBe(42)

    harness.webview.respondToNextNotification('retry')
    expect(await harness.client.ui.showNotification({
      id: 'provider-warning',
      title: 'Provider unavailable',
      message: 'Reconnect and retry.',
      actions: [{ id: 'retry', title: 'Retry' }]
    })).toBe('retry')
    expect(harness.webview.notifications).toEqual([expect.objectContaining({
      id: 'provider-warning',
      severity: 'info',
      actions: [{ id: 'retry', title: 'Retry' }]
    })])

    const { run } = await harness.client.agent.createRun({ input: 'hello' })
    const subscription = await harness.client.agent.subscribe({ runId: run.id })
    const events: string[] = []
    subscription.onEvent((event) => events.push(event.type))
    harness.agent.emit(run.id, 'progress', { message: 'working' })
    expect(events).toEqual(['state', 'progress'])

    const tool = await harness.client.tools.registerTool(
      { id: 'echo', description: 'Echo input', inputSchema: { type: 'object' }, sideEffects: 'none', idempotent: true },
      async (input) => ({ content: input })
    )
    expect(await harness.tools.invoke('tool-1', { value: 'ok' })).toEqual({ content: { value: 'ok' } })

    await tool.dispose()
    await subscription.dispose()
    await command.dispose()
    await harness.dispose()
  })

  it('returns the public permission error shape', async () => {
    const harness = createExtensionTestHarness({ permissions: [] })
    await expect(harness.client.network.fetch({ url: 'https://api.example.com' })).rejects.toMatchObject<
      Partial<ExtensionApiError>
    >({ code: 'PERMISSION_DENIED', operation: 'network.fetch' })
    await harness.dispose()
  })

  it('contains malformed Host notifications as public protocol errors', async () => {
    const harness = createExtensionTestHarness()
    const errors: ExtensionApiError[] = []
    harness.client.onDidError((error) => errors.push(error))
    harness.transport.emit('ui.themeChanged', { kind: 'invalid' })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ code: 'PROTOCOL_ERROR', operation: 'ui.themeChanged' })
    await harness.dispose()
  })

  it('scripts accounts and normalized provider streams without credentials or model calls', async () => {
    const harness = createExtensionTestHarness({
      permissions: [
        'providers.register',
        'accounts.read',
        'accounts.secrets.read:fake-provider'
      ]
    })
    harness.accounts.addAccount(
      {
        id: 'account-1',
        providerId: 'fake-provider',
        label: 'Test account',
        authenticationType: 'api-key',
        status: 'connected',
        metadata: {}
      },
      'not-a-real-secret'
    )
    expect(await harness.client.authentication.listAccounts({ providerId: 'fake-provider' })).toHaveLength(1)
    expect(
      await harness.client.authentication.revealSecret({
        accountId: 'account-1',
        operation: 'test-signing'
      })
    ).toBe('not-a-real-secret')

    await harness.client.modelProviders.registerProvider(
      {
        id: 'fake-provider',
        displayName: 'Fake Provider',
        adapterApiVersion: '1.0.0',
        models: []
      },
      {
        async probe() {
          return { ok: true }
        },
        async listModels() {
          return [
            {
              id: 'fake-model',
              displayName: 'Fake Model',
              capabilities: {
                input: ['text'],
                output: ['text'],
                reasoning: false,
                tools: false,
                parallelTools: false,
                streaming: true
              }
            }
          ]
        },
        async *stream(request) {
          yield { requestId: request.requestId, sequence: 0, type: 'textDelta', delta: 'hello' }
          yield {
            requestId: request.requestId,
            sequence: 1,
            type: 'completed',
            finishReason: 'stop',
            usage: { outputTokens: 1 }
          }
        },
        async cancel() {}
      }
    )
    const binding = { providerId: 'fake-provider', accountId: 'account-1', modelId: 'fake-model' }
    expect(
      await harness.providers.invoke('provider-1', { operation: 'listModels', binding })
    ).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'fake-model' })]))
    await harness.providers.invoke('provider-1', {
      operation: 'stream',
      request: {
        apiVersion: '1.0.0',
        requestId: 'request-1',
        binding,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
      }
    })
    expect(harness.transport.sentNotifications).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ method: 'modelProviders.streamEvent' })])
    )
    expect(harness.transport.sentStreams).toEqual([
      expect.objectContaining({ requestId: 'fake_request_2', terminal: false }),
      expect.objectContaining({ requestId: 'fake_request_2', terminal: true })
    ])
    expect(harness.providers.takeStreamEvents('provider-1').map((event) => event.type)).toEqual([
      'textDelta',
      'completed'
    ])
    await harness.dispose()
  })
})
