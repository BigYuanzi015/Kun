import { ExtensionManifestSchema } from '@kun/extension-api'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ExtensionViewSessionRegistry } from '../extensions/extension-view-sessions'
import {
  registerExtensionIpcHandlers,
  startExtensionNotificationPump,
  startExtensionSecretRevealConsentPump,
  type ExtensionWorkbenchEnvironment
} from './register-extension-ipc-handlers'

const electronMock = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload?: unknown) => Promise<unknown>>(),
  listeners: new Map<string, (event: unknown, payload?: unknown) => void>(),
  showOpenDialog: vi.fn(),
  showMessageBox: vi.fn(),
  fromId: vi.fn()
}))

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: electronMock.showOpenDialog,
    showMessageBox: electronMock.showMessageBox
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, payload?: unknown) => Promise<unknown>) => {
      electronMock.handlers.set(channel, handler)
    }),
    on: vi.fn((channel: string, listener: (event: unknown, payload?: unknown) => void) => {
      electronMock.listeners.set(channel, listener)
    })
  },
  webContents: {
    fromId: electronMock.fromId
  }
}))

function fixture() {
  const mainFrame = { processId: 100, routingId: 200 }
  let mainDestroyedListener: (() => void) | undefined
  const mainContents = {
    id: 1,
    mainFrame,
    once: vi.fn((event: string, listener: () => void) => {
      if (event === 'destroyed') mainDestroyedListener = listener
    }),
    send: vi.fn(),
    isDestroyed: () => false
  }
  const mainWindow = { isDestroyed: () => false, webContents: mainContents }
  const runtimeRequest = vi.fn(async (
    _path: string,
    _method?: string,
    _body?: string,
    _headers?: Record<string, string>
  ) => ({
    ok: true,
    status: 200,
    body: JSON.stringify({ result: { ok: true } })
  }))
  const viewSessions = new ExtensionViewSessionRegistry(() => 1_000)
  const viewProtocols = {
    prepare: vi.fn(),
    assertPrepared: vi.fn(),
    isPreparedInitialNavigation: vi.fn(() => false),
    dispose: vi.fn(() => true),
    disposeAll: vi.fn()
  }
  const contentScripts = {
    sync: vi.fn(async (_sender: unknown, request: { protectedSurface?: string }) =>
      request.protectedSurface
        ? {
            ok: false as const,
            code: 'EXTENSION_PROTECTED_SURFACE_DENIED',
            message: 'Host content scripts cannot run in a protected surface.',
            reloadScheduled: false
          }
        : { ok: true as const, active: [] }),
    bootstrap: vi.fn(() => ({ version: 1, generation: 'test', bindings: [] })),
    handleBridgeRequest: vi.fn(),
    clearFrame: vi.fn(async () => undefined),
    disposeFrame: vi.fn(async () => undefined),
    revokeExtension: vi.fn(async () => true),
    recentDiagnostics: vi.fn(() => [{
      code: 'HOST_DOM_EXTENSION_DIAGNOSTIC',
      extensionId: 'acme.example',
      extensionVersion: '1.0.0',
      contributionId: 'dom',
      workspaceScope: 'global',
      message: 'Selector missing.',
      at: '2026-07-11T00:00:00.000Z'
    }])
  }
  const descriptors = {
    resolvePackage: vi.fn(),
    resolveView: vi.fn(),
    resolveHostContentScript: vi.fn()
  }
  const protectedActions = {
    revokeSender: vi.fn(),
    authorize: vi.fn(),
    consume: vi.fn(),
    authorizeAndPerform: vi.fn(async (
      _binding: unknown,
      _copy: unknown,
      perform: () => Promise<unknown>
    ) => perform()),
    performAfterProtectedDecision: vi.fn(async (
      _binding: unknown,
      _protectedWindowSessionId: string,
      perform: () => Promise<unknown>
    ) => perform())
  }
  const credentialSurface = { prompt: vi.fn(), presentAuthorization: vi.fn() }
  let workbenchEnvironment: ExtensionWorkbenchEnvironment = {
    theme: {
      kind: 'light' as const,
      tokens: { foreground: '#233659' },
      zoomFactor: 1,
      reducedMotion: false
    },
    locale: { language: 'en', direction: 'ltr' as const, messages: {} }
  }
  const options = {
    getMainWindow: () => mainWindow as never,
    runtimeRequest,
    descriptors: descriptors as never,
    viewSessions,
    viewProtocols: viewProtocols as never,
    protectedActions: protectedActions as never,
    credentialSurface: credentialSurface as never,
    contentScripts: contentScripts as never,
    getWorkbenchEnvironment: async () => workbenchEnvironment
  }
  const registration = registerExtensionIpcHandlers(options)
  return {
    runtimeRequest,
    mainContents,
    viewSessions,
    viewProtocols,
    contentScripts,
    descriptors,
    protectedActions,
    credentialSurface,
    registration,
    options,
    setWorkbenchEnvironment(environment: typeof workbenchEnvironment) {
      workbenchEnvironment = environment
    },
    triggerMainDestroyed() {
      mainDestroyedListener?.()
    },
    trustedEvent: { sender: mainContents, senderFrame: mainFrame },
    untrustedEvent: { sender: { id: 99 }, senderFrame: { processId: 999, routingId: 999 } }
  }
}

beforeEach(() => {
  electronMock.handlers.clear()
  electronMock.listeners.clear()
  electronMock.showOpenDialog.mockReset()
  electronMock.showMessageBox.mockReset()
  electronMock.showMessageBox.mockResolvedValue({ response: 0 })
  electronMock.fromId.mockReset()
})

describe('extension IPC security bridge', () => {
  it('presents source, digest, signature, and high-risk contributions before installation', async () => {
    const state = fixture()
    const manifest = ExtensionManifestSchema.parse({
      manifestVersion: 1,
      apiVersion: '1.0.0',
      publisher: 'acme',
      name: 'example',
      version: '1.2.3',
      engines: { kun: '*' },
      main: 'dist/main.mjs',
      activationEvents: ['onStartup'],
      contributes: {
        hostContentScripts: [{
          id: 'direct-dom',
          matches: ['workbench:code'],
          scripts: ['dist/content.js']
        }]
      },
      permissions: ['hostDom'],
      stateSchemaVersion: 0
    })
    state.runtimeRequest.mockImplementation(async (path: string) => path === '/v1/extensions/inspect'
      ? {
          ok: true,
          status: 200,
          body: JSON.stringify({
            inspection: {
              id: 'acme.example',
              version: '1.2.3',
              archiveSha256: 'a'.repeat(64),
              signatureStatus: 'present-unverified',
              manifest
            }
          })
        }
      : { ok: true, status: 201, body: JSON.stringify({ extension: { id: 'acme.example' } }) })

    await electronMock.handlers.get('extension:install')!(state.trustedEvent, {
      source: 'archive',
      path: '/tmp/example.kunx'
    })

    expect(state.protectedActions.authorizeAndPerform).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionId: 'acme.example',
        extensionVersion: '1.2.3',
        operationKind: 'extension.install'
      }),
      expect.objectContaining({
        detail: expect.stringMatching(/Local \.kunx archive[\s\S]*a{64}[\s\S]*not verified[\s\S]*Direct DOM/i)
      }),
      expect.any(Function)
    )
  })

  it('rejects extension management calls from a non-workbench sender', async () => {
    const state = fixture()
    await expect(
      electronMock.handlers.get('extension:list')!(state.untrustedEvent, undefined)
    ).rejects.toThrow(/trusted workbench frame/)
    expect(state.runtimeRequest).not.toHaveBeenCalled()
  })

  it('binds guest requests to the Main-owned session and forwards nonce headers', async () => {
    const state = fixture()
    const record = state.viewSessions.create({
      sessionId: 'view_12345678-1234-1234-1234-123456789abc',
      runtimeSessionId: 'view_12345678-1234-1234-1234-123456789abc',
      nonce: 'n'.repeat(43),
      extensionId: 'acme.example',
      extensionVersion: '1.0.0',
      contributionId: 'extension:acme.example/issues',
      entryPath: 'dist/index.html',
      parentWebContentsId: 1
    })
    state.viewSessions.prepareAttach(1, record.sourceUrl)
    const guest = { id: 20, once: vi.fn() }
    state.viewSessions.bindNextGuest(1, guest as never)

    const response = await electronMock.handlers.get('extension:view:request')!(
      { sender: guest },
      {
        sessionId: record.sessionId,
        sessionNonce: record.nonce,
        requestId: 'request-123',
        method: 'ui.getViewState',
        params: {}
      }
    )

    expect(response).toEqual({ ok: true })
    expect(state.runtimeRequest).toHaveBeenCalledWith(
      `/v1/extensions/view-sessions/${record.runtimeSessionId}/requests`,
      'POST',
      expect.stringContaining('ui.getViewState'),
      {
        'x-kun-extension-session-id': record.runtimeSessionId,
        'x-kun-extension-session-nonce': record.nonce
      }
    )
  })

  it('serves the real workbench environment locally and publishes live changes to bound guests', async () => {
    const state = fixture()
    const record = state.viewSessions.create({
      sessionId: 'view_12345678-1234-1234-1234-123456789abc',
      nonce: 'n'.repeat(43),
      extensionId: 'acme.example',
      extensionVersion: '1.0.0',
      contributionId: 'extension:acme.example/issues',
      entryPath: 'dist/index.html',
      parentWebContentsId: 1
    })
    state.viewSessions.prepareAttach(1, record.sourceUrl)
    const guest = {
      id: 20,
      once: vi.fn(),
      send: vi.fn(),
      isDestroyed: () => false,
      close: vi.fn()
    }
    state.viewSessions.bindNextGuest(1, guest as never)

    await expect(electronMock.handlers.get('extension:view:request')!(
      { sender: guest },
      {
        sessionId: record.sessionId,
        sessionNonce: record.nonce,
        requestId: 'request-theme',
        method: 'ui.getTheme',
        params: {}
      }
    )).resolves.toMatchObject({ kind: 'light', tokens: { foreground: '#233659' } })
    expect(state.runtimeRequest).not.toHaveBeenCalled()

    state.setWorkbenchEnvironment({
      theme: {
        kind: 'dark',
        tokens: { foreground: '#f0f5fc' },
        zoomFactor: 1.25,
        reducedMotion: true
      },
      locale: { language: 'zh', direction: 'ltr', messages: {} }
    })
    await state.registration.publishWorkbenchEnvironmentChanged()

    expect(state.runtimeRequest).toHaveBeenCalledWith(
      '/v1/extensions/workbench/environment',
      'PUT',
      JSON.stringify({
        theme: {
          kind: 'dark',
          tokens: { foreground: '#f0f5fc' },
          zoomFactor: 1.25,
          reducedMotion: true
        },
        locale: { language: 'zh', direction: 'ltr', messages: {} }
      })
    )
    expect(guest.send).toHaveBeenCalledWith('extension:view:notification', {
      sessionId: record.sessionId,
      method: 'ui.themeChanged',
      params: expect.objectContaining({ kind: 'dark', zoomFactor: 1.25, reducedMotion: true })
    })
    expect(guest.send).toHaveBeenCalledWith('extension:view:notification', {
      sessionId: record.sessionId,
      method: 'ui.localeChanged',
      params: { language: 'zh', direction: 'ltr', messages: {} }
    })
  })

  it('queues trusted HostMessages for one owned View Session through the bounded runtime pump', async () => {
    const state = fixture()
    const record = state.viewSessions.create({
      sessionId: 'view_12345678-1234-1234-1234-123456789abc',
      nonce: 'n'.repeat(43),
      extensionId: 'acme.example',
      extensionVersion: '1.0.0',
      contributionId: 'extension:acme.example/issues',
      entryPath: 'dist/index.html',
      parentWebContentsId: 1
    })

    await electronMock.handlers.get('extension:view-session:message')!(state.trustedEvent, {
      sessionId: record.sessionId,
      channel: 'preview.initialize',
      payload: { artifactId: 'artifact-1' }
    })

    expect(state.runtimeRequest).toHaveBeenCalledWith(
      `/v1/extensions/view-sessions/${record.runtimeSessionId}/host-messages`,
      'POST',
      JSON.stringify({
        channel: 'preview.initialize',
        payload: { artifactId: 'artifact-1' }
      })
    )
  })

  it('routes replayed broker notifications only to the owning guest', async () => {
    const state = fixture()
    const record = state.viewSessions.create({
      sessionId: 'view_12345678-1234-1234-1234-123456789abc',
      nonce: 'n'.repeat(43),
      extensionId: 'acme.example',
      extensionVersion: '1.0.0',
      contributionId: 'extension:acme.example/issues',
      entryPath: 'dist/index.html',
      parentWebContentsId: 1
    })
    state.viewSessions.prepareAttach(1, record.sourceUrl)
    const guest = {
      id: 20,
      once: vi.fn(),
      send: vi.fn(),
      isDestroyed: () => false,
      close: vi.fn()
    }
    state.viewSessions.bindNextGuest(1, guest as never)
    state.runtimeRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: JSON.stringify({
        events: [{
          sequence: 2,
          type: 'bridge',
          payload: {
            method: 'agent.event',
            params: { subscriptionId: 'agentsub-1', event: { sequence: 7 } }
          }
        }],
        nextCursor: 2,
        hasMore: false
      })
    })

    await electronMock.handlers.get('extension:view-session:events')!(state.trustedEvent, {
      sessionId: record.sessionId,
      cursor: 1,
      limit: 10
    })

    expect(guest.send).toHaveBeenCalledWith('extension:view:notification', {
      sessionId: record.sessionId,
      method: 'agent.event',
      params: { subscriptionId: 'agentsub-1', event: { sequence: 7 } }
    })
  })

  it('reconnects the production event pump from a bounded cursor gap and resumes live delivery', async () => {
    const state = fixture()
    state.descriptors.resolveView.mockResolvedValue({
      extensionVersion: '1.0.0',
      entry: 'dist/index.html'
    })
    let eventPoll = 0
    state.runtimeRequest.mockImplementation(async (path: string, method?: string) => {
      if (path === '/v1/extensions/view-sessions' && method === 'POST') {
        return {
          ok: true,
          status: 201,
          body: JSON.stringify({
            sessionId: 'view_12345678-1234-1234-1234-123456789abc',
            nonce: 'n'.repeat(43),
            extensionId: 'acme.example',
            extensionVersion: '1.0.0',
            contributionId: 'extension:acme.example/issues'
          })
        }
      }
      if (path.includes('/events?')) {
        eventPoll += 1
        if (eventPoll === 1) {
          return {
            ok: false,
            status: 409,
            body: JSON.stringify({ code: 'cursor_expired', oldestAvailableCursor: 4 })
          }
        }
        if (eventPoll === 2) {
          return {
            ok: true,
            status: 200,
            body: JSON.stringify({
              events: [{
                sequence: 5,
                type: 'bridge',
                payload: {
                  method: 'agent.event',
                  params: { subscriptionId: 'agentsub-live', event: { sequence: 9 } }
                }
              }],
              nextCursor: 5,
              hasMore: false
            })
          }
        }
        return { ok: false, status: 404, body: '{}' }
      }
      return { ok: true, status: 200, body: '{}' }
    })

    const created = await electronMock.handlers.get('extension:view-session:create')!(
      state.trustedEvent,
      { contributionId: 'extension:acme.example/issues' }
    ) as { sessionId: string; src: string }
    expect(state.viewProtocols.prepare).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: created.sessionId }),
      expect.objectContaining({ extensionVersion: '1.0.0', entry: 'dist/index.html' })
    )
    state.viewSessions.prepareAttach(1, created.src)
    const guest = {
      id: 20,
      once: vi.fn(),
      send: vi.fn(),
      isDestroyed: () => false,
      close: vi.fn()
    }
    state.viewSessions.bindNextGuest(1, guest as never)

    await vi.waitFor(() => expect(guest.send).toHaveBeenCalledWith(
      'extension:view:notification',
      {
        sessionId: created.sessionId,
        method: 'agent.event',
        params: { subscriptionId: 'agentsub-live', event: { sequence: 9 } }
      }
    ))
    expect(guest.send).toHaveBeenCalledWith('extension:view:notification', {
      sessionId: created.sessionId,
      method: 'ui.message',
      params: {
        channel: 'kun.extension.view.overflow',
        payload: { code: 'cursor_expired', oldestAvailableCursor: 4 }
      }
    })
    expect(eventPoll).toBeGreaterThanOrEqual(2)
    state.registration.dispose()
  })

  it('rolls back the runtime View Session when isolated protocol preparation fails', async () => {
    const state = fixture()
    state.descriptors.resolveView.mockResolvedValue({
      extensionId: 'acme.example',
      extensionVersion: '1.0.0',
      packageRoot: '/extensions/acme.example/1.0.0',
      entry: 'dist/index.html',
      localResourceRoots: ['dist/assets']
    })
    state.viewProtocols.prepare.mockImplementationOnce(() => {
      throw new Error('isolated protocol unavailable')
    })
    state.runtimeRequest.mockImplementation(async (path: string, method?: string) => {
      if (path === '/v1/extensions/view-sessions' && method === 'POST') {
        return {
          ok: true,
          status: 201,
          body: JSON.stringify({
            sessionId: 'view_12345678-1234-1234-1234-123456789abc',
            nonce: 'n'.repeat(43),
            extensionId: 'acme.example',
            extensionVersion: '1.0.0',
            contributionId: 'extension:acme.example/issues'
          })
        }
      }
      return { ok: true, status: 200, body: '{}' }
    })

    await expect(electronMock.handlers.get('extension:view-session:create')!(
      state.trustedEvent,
      { contributionId: 'extension:acme.example/issues' }
    )).rejects.toThrow(/isolated protocol unavailable/)

    expect(state.viewSessions.get('view_12345678-1234-1234-1234-123456789abc')).toBeUndefined()
    await vi.waitFor(() => expect(state.runtimeRequest).toHaveBeenCalledWith(
      '/v1/extensions/view-sessions/view_12345678-1234-1234-1234-123456789abc',
      'DELETE'
    ))
  })

  it('binds cleanup to a Main window created after IPC registration', () => {
    const state = fixture()
    const record = state.viewSessions.create({
      sessionId: 'view_12345678-1234-1234-1234-123456789abc',
      extensionId: 'acme.example',
      extensionVersion: '1.0.0',
      contributionId: 'extension:acme.example/issues',
      entryPath: 'dist/index.html',
      parentWebContentsId: 1
    })

    state.registration.bindMainWindow({
      webContents: state.mainContents
    } as never)
    state.triggerMainDestroyed()

    expect(state.protectedActions.revokeSender).toHaveBeenCalledWith(1)
    expect(state.viewSessions.get(record.sessionId)).toBeUndefined()
    expect(state.viewProtocols.dispose).toHaveBeenCalledWith(record.sessionId)
  })

  it('cancels the event pump and disposes the runtime session when a guest is destroyed', async () => {
    const state = fixture()
    const record = state.viewSessions.create({
      sessionId: 'view_12345678-1234-1234-1234-123456789abc',
      runtimeSessionId: 'view_runtime_12345678-1234-1234-1234-123456789abc',
      nonce: 'n'.repeat(43),
      extensionId: 'acme.example',
      extensionVersion: '1.0.0',
      contributionId: 'extension:acme.example/issues',
      entryPath: 'dist/index.html',
      parentWebContentsId: 1
    })
    state.viewSessions.prepareAttach(1, record.sourceUrl)
    let destroyed: (() => void) | undefined
    const guest = {
      id: 20,
      once: vi.fn((_event: string, listener: () => void) => {
        destroyed = listener
      }),
      send: vi.fn(),
      isDestroyed: () => true,
      close: vi.fn()
    }
    state.viewSessions.bindNextGuest(1, guest as never)

    destroyed?.()
    await vi.waitFor(() => expect(state.runtimeRequest).toHaveBeenCalledWith(
      `/v1/extensions/view-sessions/${record.runtimeSessionId}`,
      'DELETE'
    ))
    expect(state.viewSessions.get(record.sessionId)).toBeUndefined()
  })

  it('denies protected account methods from a Webview before runtime dispatch', async () => {
    const state = fixture()
    const record = state.viewSessions.create({
      sessionId: 'view_12345678-1234-1234-1234-123456789abc',
      nonce: 'n'.repeat(43),
      extensionId: 'acme.example',
      extensionVersion: '1.0.0',
      contributionId: 'extension:acme.example/issues',
      entryPath: 'dist/index.html',
      parentWebContentsId: 1
    })
    state.viewSessions.prepareAttach(1, record.sourceUrl)
    const guest = { id: 20, once: vi.fn() }
    state.viewSessions.bindNextGuest(1, guest as never)

    await expect(electronMock.handlers.get('extension:view:request')!(
      { sender: guest },
      {
        sessionId: record.sessionId,
        sessionNonce: record.nonce,
        requestId: 'request-123',
        method: 'authentication.createSession',
        params: {}
      }
    )).rejects.toThrow(/not available/)
    expect(state.runtimeRequest).not.toHaveBeenCalled()
  })

  it('collects OAuth callbacks only in a protected Main surface', async () => {
    const state = fixture()
    state.descriptors.resolvePackage.mockResolvedValue({
      extensionVersion: '1.2.3',
      manifest: {
        contributes: {
          modelProviders: [{ id: 'models', authenticationProviderId: 'oauth' }],
          authentication: [{ id: 'oauth', scopes: ['models.read'] }]
        }
      }
    })
    state.credentialSurface.prompt.mockResolvedValue({
      submitted: true,
      value: 'https://callback.example/?code=secret-code&state=expected-state',
      protectedWindowSessionId: 'protected-session-123456'
    })

    const response = await electronMock.handlers.get('extension:accounts:complete-session')!(
      state.trustedEvent,
      {
        extensionId: 'acme.example',
        extensionVersion: '1.2.3',
        sessionId: 'account-session-123456',
        workspaceRoot: '/workspace'
      }
    )

    expect(response).toMatchObject({ ok: true, status: 200 })
    expect(state.credentialSurface.prompt).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ label: 'OAuth callback URL' })
    )
    expect(state.protectedActions.performAfterProtectedDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionId: 'acme.example',
        extensionVersion: '1.2.3',
        operationKind: 'account.complete-session',
        parameters: expect.objectContaining({
          extensionId: 'acme.example',
          extensionVersion: '1.2.3',
          sessionId: 'account-session-123456',
          callbackDigest: expect.stringMatching(/^[a-f0-9]{64}$/)
        })
      }),
      'protected-session-123456',
      expect.any(Function)
    )
    const runtimeBody = JSON.parse(state.runtimeRequest.mock.calls.at(-1)?.[2] as string)
    expect(runtimeBody).toEqual({
      extensionId: 'acme.example',
      extensionVersion: '1.2.3',
      callbackUrl: 'https://callback.example/?code=secret-code&state=expected-state',
      workspaceRoot: '/workspace'
    })
    expect(JSON.stringify(state.protectedActions.performAfterProtectedDecision.mock.calls[0]?.[0]))
      .not.toContain('secret-code')
  })

  it('binds account-session creation to the selected workspace version', async () => {
    const state = fixture()
    state.descriptors.resolvePackage.mockResolvedValue({
      extensionVersion: '1.2.3',
      manifest: {
        contributes: {
          modelProviders: [{ id: 'models', authenticationProviderId: 'oauth' }],
          authentication: [{ id: 'oauth', scopes: ['models.read'] }]
        }
      }
    })

    const response = await electronMock.handlers.get('extension:accounts:create-session')!(
      state.trustedEvent,
      {
        extensionId: 'acme.example',
        extensionVersion: '1.2.3',
        providerId: 'models',
        authenticationProviderId: 'oauth',
        scopes: ['models.read'],
        workspaceRoot: '/workspace'
      }
    )

    expect(response).toMatchObject({ ok: true, status: 200 })
    expect(state.descriptors.resolvePackage).toHaveBeenCalledWith('acme.example', '/workspace')
    expect(state.protectedActions.authorizeAndPerform).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionId: 'acme.example',
        extensionVersion: '1.2.3',
        operationKind: 'account.create-session',
        workspaceRoot: '/workspace'
      }),
      expect.any(Object),
      expect.any(Function)
    )
    expect(state.runtimeRequest).toHaveBeenCalledWith(
      '/v1/extensions/accounts/sessions',
      'POST',
      JSON.stringify({
        extensionId: 'acme.example',
        extensionVersion: '1.2.3',
        providerId: 'models',
        authenticationProviderId: 'oauth',
        scopes: ['models.read'],
        workspaceRoot: '/workspace'
      })
    )
  })

  it('shows full model-input disclosure before persisting an exact provider binding', async () => {
    const state = fixture()
    state.descriptors.resolvePackage.mockResolvedValue({
      extensionVersion: '1.2.3',
      manifest: {
        displayName: 'Example models',
        contributes: {
          modelProviders: [{
            id: 'models',
            displayName: 'Example Provider',
            models: [{
              id: 'model-a',
              capabilities: { input: ['text', 'image'] }
            }]
          }]
        }
      }
    })

    const response = await electronMock.handlers.get('extension:providers:set-binding')!(
      state.trustedEvent,
      {
        extensionId: 'acme.example',
        extensionVersion: '1.2.3',
        providerId: 'models',
        accountId: 'account-123',
        modelId: 'model-a',
        workspaceRoot: '/workspace'
      }
    )

    expect(response).toMatchObject({ ok: true, status: 200 })
    expect(state.protectedActions.authorizeAndPerform).toHaveBeenCalledWith(
      expect.objectContaining({
        extensionId: 'acme.example',
        extensionVersion: '1.2.3',
        operationKind: 'provider.bind',
        workspaceRoot: '/workspace',
        parameters: expect.objectContaining({
          providerId: 'models',
          accountId: 'account-123',
          modelId: 'model-a'
        })
      }),
      expect.objectContaining({
        detail: expect.stringMatching(/complete conversation history[\s\S]*system and mode instructions[\s\S]*attachments[\s\S]*tool names/i)
      }),
      expect.any(Function)
    )
    expect(state.runtimeRequest).toHaveBeenCalledWith(
      '/v1/extensions/model-providers/binding',
      'PUT',
      JSON.stringify({
        extensionId: 'acme.example',
        extensionVersion: '1.2.3',
        providerId: 'models',
        accountId: 'account-123',
        modelId: 'model-a',
        workspaceRoot: '/workspace',
        acknowledgedDataAccess: true
      })
    )
  })

  it('keeps OAuth and device verification material inside the protected Main window', async () => {
    const state = fixture()
    state.descriptors.resolvePackage.mockResolvedValue({
      extensionVersion: '1.2.3',
      manifest: {
        contributes: {
          modelProviders: [{ id: 'models', authenticationProviderId: 'device-auth' }],
          authentication: [{
            id: 'device-auth',
            type: 'device-code',
            scopes: ['models.read']
          }]
        }
      }
    })
    state.runtimeRequest.mockResolvedValue({
      ok: true,
      status: 201,
      body: JSON.stringify({
        schemaVersion: 1,
        session: {
          id: 'account-session-device',
          status: 'pending',
          verificationUrl: 'https://auth.example/device',
          userCode: 'ABCD-EFGH',
          expiresAt: '2099-07-11T10:10:00.000Z'
        }
      })
    })
    state.credentialSurface.presentAuthorization.mockResolvedValue(undefined)

    const response = await electronMock.handlers.get('extension:accounts:create-session')!(
      state.trustedEvent,
      {
        extensionId: 'acme.example',
        extensionVersion: '1.2.3',
        providerId: 'models',
        authenticationProviderId: 'device-auth',
        workspaceRoot: '/workspace'
      }
    ) as { body: string }

    expect(state.credentialSurface.presentAuthorization).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        verificationUrl: 'https://auth.example/device',
        userCode: 'ABCD-EFGH'
      })
    )
    expect(JSON.parse(response.body).session).toEqual({
      id: 'account-session-device',
      status: 'pending',
      expiresAt: '2099-07-11T10:10:00.000Z'
    })
    expect(response.body).not.toContain('ABCD-EFGH')
    expect(response.body).not.toContain('auth.example')

    const refreshed = await electronMock.handlers.get('extension:accounts:get-session')!(
      state.trustedEvent,
      { extensionId: 'acme.example', sessionId: 'account-session-device' }
    ) as { body: string }
    expect(refreshed.body).not.toContain('ABCD-EFGH')
    expect(refreshed.body).not.toContain('auth.example')
  })

  it('replaces an API key through the protected surface while binding only its digest to consent', async () => {
    const state = fixture()
    state.descriptors.resolvePackage.mockResolvedValue({ extensionVersion: '1.2.3' })
    state.credentialSurface.prompt.mockResolvedValue({
      submitted: true,
      value: 'replacement-secret-key',
      protectedWindowSessionId: 'protected-session-replace'
    })

    await electronMock.handlers.get('extension:accounts:replace-api-key')!(state.trustedEvent, {
      extensionId: 'acme.example',
      extensionVersion: '1.2.3',
      providerId: 'models',
      accountId: 'account-123',
      workspaceRoot: '/workspace'
    })

    const binding = state.protectedActions.performAfterProtectedDecision.mock.calls.at(-1)?.[0]
    expect(binding).toMatchObject({
      operationKind: 'account.replace-api-key',
      parameters: expect.objectContaining({
        accountId: 'account-123',
        secretDigest: expect.stringMatching(/^[a-f0-9]{64}$/)
      })
    })
    expect(JSON.stringify(binding)).not.toContain('replacement-secret-key')
    expect(state.runtimeRequest).toHaveBeenCalledWith(
      '/v1/extensions/accounts/account-123/api-key',
      'PUT',
      expect.stringContaining('replacement-secret-key')
    )
  })

  it('pumps one-shot raw secret decisions through a Main-owned warning dialog', async () => {
    const state = fixture()
    state.runtimeRequest.mockImplementation(async (path: string, method?: string) => {
      if (path === '/v1/extensions/secret-reveal-requests' && method === 'GET') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            requests: [{
              id: 'secret_reveal_12345678-1234-1234-1234-123456789abc',
              extensionId: 'acme.example',
              extensionVersion: '1.2.3',
              accountId: 'account-123',
              operation: 'sign-request'
            }]
          })
        }
      }
      return { ok: true, status: 200, body: '{}' }
    })
    electronMock.showMessageBox.mockResolvedValue({ response: 1 })

    const stop = startExtensionSecretRevealConsentPump(state.options, 10_000)
    await vi.waitFor(() => expect(electronMock.showMessageBox).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(state.runtimeRequest).toHaveBeenCalledWith(
      '/v1/extensions/secret-reveal-requests/secret_reveal_12345678-1234-1234-1234-123456789abc/decision',
      'POST',
      JSON.stringify({ decision: 'allow' })
    ))
    stop()
  })

  it('projects validated runtime notification snapshots and returns trusted user actions', async () => {
    const state = fixture()
    const notificationId = 'notification_12345678-1234-1234-1234-123456789abc'
    state.runtimeRequest.mockImplementation(async (path: string, method?: string, body?: string) => {
      if (path === '/v1/extensions/workbench/notifications' && method === 'GET') {
        return {
          ok: true,
          status: 200,
          body: JSON.stringify({
            schemaVersion: 1,
            notifications: [{
              notificationId,
              extensionId: 'acme.example',
              extensionVersion: '1.2.3',
              sourceId: 'provider-warning',
              title: 'Provider unavailable',
              message: 'Reconnect the account and retry.',
              severity: 'warning',
              actions: [{ id: 'retry', title: 'Retry' }],
              createdAt: '2026-07-11T00:00:00.000Z',
              expiresAt: '2026-07-11T00:01:00.000Z'
            }]
          })
        }
      }
      if (path.endsWith(`/${notificationId}/respond`) && method === 'POST') {
        expect(body).toBe(JSON.stringify({ actionId: 'retry' }))
        return { ok: true, status: 200, body: JSON.stringify({ responded: true }) }
      }
      return { ok: false, status: 404, body: '{}' }
    })

    const stop = startExtensionNotificationPump(state.options, 10_000)
    const workbench = state.mainContents
    await vi.waitFor(() => expect(workbench.send).toHaveBeenCalledWith(
      'extension:notifications',
      {
        notifications: [expect.objectContaining({
          notificationId,
          extensionId: 'acme.example',
          actions: [{ id: 'retry', title: 'Retry' }]
        })]
      }
    ))
    stop()
    await vi.waitFor(() => expect(state.runtimeRequest).toHaveBeenCalledWith(
      '/v1/extensions/workbench/presence',
      'DELETE'
    ))

    await expect(electronMock.handlers.get('extension:notification:respond')!(
      state.trustedEvent,
      { notificationId, actionId: 'retry' }
    )).resolves.toBe(true)
    await expect(electronMock.handlers.get('extension:notification:respond')!(
      state.untrustedEvent,
      { notificationId, actionId: 'retry' }
    )).rejects.toThrow(/trusted workbench frame/)
  })

  it('dispatches fire-and-forget guest notifications through the broker route', async () => {
    const state = fixture()
    const record = state.viewSessions.create({
      sessionId: 'view_12345678-1234-1234-1234-123456789abc',
      nonce: 'n'.repeat(43),
      extensionId: 'acme.example',
      extensionVersion: '1.0.0',
      contributionId: 'extension:acme.example/issues',
      entryPath: 'dist/index.html',
      parentWebContentsId: 1
    })
    state.viewSessions.prepareAttach(1, record.sourceUrl)
    const guest = { id: 20, once: vi.fn() }
    state.viewSessions.bindNextGuest(1, guest as never)

    await electronMock.handlers.get('extension:view:notify')!(
      { sender: guest },
      {
        sessionId: record.sessionId,
        sessionNonce: record.nonce,
        method: 'ui.setViewState',
        params: { value: { selected: 'item-1' } }
      }
    )

    expect(state.runtimeRequest).toHaveBeenCalledWith(
      `/v1/extensions/view-sessions/${record.runtimeSessionId}/requests`,
      'POST',
      expect.stringMatching(/"requestId":"view-notify-[^"]+".*"method":"ui\.setViewState"/),
      {
        'x-kun-extension-session-id': record.runtimeSessionId,
        'x-kun-extension-session-nonce': record.nonce
      }
    )
  })

  it('tears down content scripts and rejects protected surfaces', async () => {
    const state = fixture()
    await expect(electronMock.handlers.get('extension:sync-host-content-scripts')!(
      state.trustedEvent,
      {
        surface: null,
        protectedSurface: 'account-credentials',
        descriptors: []
      }
    )).resolves.toMatchObject({
      ok: false,
      code: 'EXTENSION_PROTECTED_SURFACE_DENIED',
      reloadScheduled: false
    })
    expect(state.contentScripts.sync).toHaveBeenCalledWith(
      state.trustedEvent.sender,
      expect.objectContaining({ protectedSurface: 'account-credentials' })
    )
    expect(state.contentScripts.clearFrame).not.toHaveBeenCalled()
  })

  it('binds preload bootstrap and the narrow bridge to the trusted main frame', async () => {
    const state = fixture()
    const bootstrapEvent = { ...state.trustedEvent, returnValue: undefined as unknown }
    electronMock.listeners.get('extension:content-script:bootstrap')!(bootstrapEvent)
    expect(bootstrapEvent.returnValue).toEqual({ version: 1, generation: 'test', bindings: [] })
    expect(state.contentScripts.bootstrap).toHaveBeenCalledWith(state.trustedEvent.sender)

    const request = {
      bindingId: 'content_script_12345678-1234-1234-1234-123456789abc',
      nonce: 'n'.repeat(43),
      method: 'reportDiagnostic',
      diagnostic: { code: 'SELECTOR_MISSING', message: 'Expected selector was absent.' }
    }
    await expect(electronMock.handlers.get('extension:content-script:bridge')!(
      state.untrustedEvent,
      request
    )).rejects.toThrow(/trusted workbench frame/)
    await expect(electronMock.handlers.get('extension:content-script:bridge')!(
      state.trustedEvent,
      request
    )).resolves.toEqual({ ok: true })
    expect(state.contentScripts.handleBridgeRequest).toHaveBeenCalledWith(
      state.trustedEvent.sender,
      expect.objectContaining({ bindingId: request.bindingId, method: 'reportDiagnostic' })
    )
  })

  it('merges bounded Main content-script diagnostics into extension doctor output', async () => {
    const state = fixture()
    state.runtimeRequest.mockResolvedValueOnce({
      ok: true,
      status: 200,
      body: JSON.stringify({ diagnostics: [] })
    })
    const result = await electronMock.handlers.get('extension:diagnostics')!(
      state.trustedEvent,
      'acme.example'
    ) as { body: string }
    expect(JSON.parse(result.body)).toMatchObject({
      diagnostics: [],
      contentScriptDiagnostics: [expect.objectContaining({
        code: 'HOST_DOM_EXTENSION_DIAGNOSTIC',
        extensionId: 'acme.example'
      })]
    })
  })

  it('revokes active Direct DOM principals after disablement succeeds', async () => {
    const state = fixture()
    await electronMock.handlers.get('extension:disable')!(state.trustedEvent, {
      extensionId: 'acme.example',
      workspaceRoot: '/workspace'
    })
    expect(state.contentScripts.revokeExtension).toHaveBeenCalledWith(
      state.trustedEvent.sender,
      'acme.example',
      'disable'
    )
  })

  it('forwards only the fixed command route and validated absolute workspace', async () => {
    const state = fixture()
    const result = await electronMock.handlers.get('extension:invoke-command')!(
      state.trustedEvent,
      {
        commandId: 'extension:acme.example/open',
        context: { source: 'topBar' },
        workspaceRoot: '/workspace'
      }
    )
    expect(result).toEqual({ ok: true })
    expect(state.runtimeRequest).toHaveBeenCalledWith(
      '/v1/extensions/commands/invoke',
      'POST',
      JSON.stringify({
        commandId: 'extension:acme.example/open',
        context: { source: 'topBar' },
        workspaceRoot: '/workspace'
      })
    )
  })

  it('maps trusted workbench and provider reads only onto fixed runtime routes', async () => {
    const state = fixture()

    await electronMock.handlers.get('extension:workbench:get')!(
      state.trustedEvent,
      { workspaceRoot: '/workspace one' }
    )
    expect(state.runtimeRequest).toHaveBeenLastCalledWith(
      '/v1/extensions/workbench?workspace_root=%2Fworkspace+one',
      'GET'
    )

    await electronMock.handlers.get('extension:model-providers:list')!(
      state.trustedEvent,
      undefined
    )
    expect(state.runtimeRequest).toHaveBeenLastCalledWith(
      '/v1/extensions/model-providers',
      'GET'
    )

    await electronMock.handlers.get('extension:model-providers:list-models')!(
      state.trustedEvent,
      {
        extensionId: 'acme.example',
        extensionVersion: '1.2.3',
        providerId: 'models',
        accountId: 'account/with?delimiters',
        workspaceRoot: '/workspace'
      }
    )
    expect(state.runtimeRequest).toHaveBeenLastCalledWith(
      '/v1/extensions/model-providers/models?' +
        'extension_id=acme.example&extension_version=1.2.3&provider_id=models&' +
        'account_id=account%2Fwith%3Fdelimiters&workspace_root=%2Fworkspace',
      'GET'
    )
  })

  it('maps trusted configuration operations onto fixed methods and JSON bodies', async () => {
    const state = fixture()
    const load = {
      contributionIds: ['extension:acme.example/general'],
      workspaceRoot: '/workspace'
    }
    await electronMock.handlers.get('extension:configuration:load')!(state.trustedEvent, load)
    expect(state.runtimeRequest).toHaveBeenLastCalledWith(
      '/v1/extensions/configuration/snapshot',
      'POST',
      JSON.stringify(load)
    )

    const update = {
      contributionId: 'extension:acme.example/general',
      key: 'mode',
      value: 'safe',
      expectedRevision: 2,
      workspaceRoot: '/workspace'
    }
    await electronMock.handlers.get('extension:configuration:update')!(state.trustedEvent, update)
    expect(state.runtimeRequest).toHaveBeenLastCalledWith(
      '/v1/extensions/configuration',
      'PUT',
      JSON.stringify(update)
    )
  })

  it('rejects every dedicated workbench bridge before runtime dispatch for untrusted senders', async () => {
    const state = fixture()
    const calls: Array<[string, unknown]> = [
      ['extension:workbench:get', { workspaceRoot: '/workspace' }],
      ['extension:model-providers:list', { workspaceRoot: '/workspace' }],
      ['extension:model-providers:list-models', {
        extensionId: 'acme.example',
        extensionVersion: '1.2.3',
        providerId: 'models',
        accountId: 'account-1',
        workspaceRoot: '/workspace'
      }],
      ['extension:configuration:load', {
        contributionIds: ['extension:acme.example/general'],
        workspaceRoot: '/workspace'
      }],
      ['extension:configuration:update', {
        contributionId: 'extension:acme.example/general',
        key: 'mode',
        value: 'safe',
        expectedRevision: 0,
        workspaceRoot: '/workspace'
      }]
    ]
    for (const [channel, payload] of calls) {
      await expect(
        electronMock.handlers.get(channel)!(state.untrustedEvent, payload)
      ).rejects.toThrow(/trusted workbench frame/)
    }
    expect(state.runtimeRequest).not.toHaveBeenCalled()
  })

  it('rejects route injection and relative workspaces before runtime dispatch', async () => {
    const state = fixture()
    await expect(electronMock.handlers.get('extension:workbench:get')!(
      state.trustedEvent,
      { workspaceRoot: 'relative', path: '/v1/usage' }
    )).rejects.toThrow(/Invalid payload/)
    await expect(electronMock.handlers.get('extension:configuration:update')!(
      state.trustedEvent,
      {
        contributionId: 'extension:acme.example/general',
        key: 'mode',
        value: 'safe',
        expectedRevision: 0,
        workspaceRoot: '/workspace',
        method: 'DELETE'
      }
    )).rejects.toThrow(/Invalid payload/)
    expect(state.runtimeRequest).not.toHaveBeenCalled()
  })

  it('rejects configuration bodies above the runtime route limit in Main', async () => {
    const state = fixture()
    await expect(electronMock.handlers.get('extension:configuration:update')!(
      state.trustedEvent,
      {
        contributionId: 'extension:acme.example/general',
        key: 'mode',
        value: 'x'.repeat(256 * 1024),
        expectedRevision: 0,
        workspaceRoot: '/workspace'
      }
    )).rejects.toThrow(/payload is too large/)
    expect(state.runtimeRequest).not.toHaveBeenCalled()
  })
})
