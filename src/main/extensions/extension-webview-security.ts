import type { App, WebContents, WebPreferences } from 'electron'
import { parseKunExtensionUrl } from './extension-resource-protocol'
import {
  ExtensionViewSessionRegistry,
  type ExtensionViewSessionRecord
} from './extension-view-sessions'

type WebviewSecurityOptions = {
  app: Pick<App, 'on'>
  sessions: ExtensionViewSessionRegistry
  extensionPreloadPath: string
  assertExtensionPartitionPrepared(record: ExtensionViewSessionRecord): void
  isPreparedExtensionNavigation(contents: WebContents, url: string): boolean
  isTrustedWorkbench(contents: WebContents): boolean
  isAllowedDevPreviewUrl(url: string): boolean
  isAuthorizedPrototypeFileUrl(url: string): boolean
  onDenied?: (detail: { code: string; url?: string }) => void
}

export function installWebviewSecurityGuards(options: WebviewSecurityOptions): void {
  options.app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event, webPreferences, params) => {
      const src = typeof params.src === 'string' ? params.src : ''
      if (src.startsWith('kun-extension:')) {
        if (!options.isTrustedWorkbench(contents)) {
          event.preventDefault()
          options.onDenied?.({ code: 'EXTENSION_WEBVIEW_PARENT_INVALID' })
          return
        }
        let record: ExtensionViewSessionRecord | undefined
        try {
          record = options.sessions.prepareAttach(contents.id, src)
          // The handler must already be installed before the renderer receives the
          // View Session. Attach is a second fail-closed check of that binding.
          options.assertExtensionPartitionPrepared(record)
          hardenExtensionWebPreferences(webPreferences, record, options.extensionPreloadPath)
          ;(params as Record<string, unknown>).partition = record.partition
        } catch (error) {
          if (record) options.sessions.dispose(record.sessionId)
          event.preventDefault()
          options.onDenied?.({
            code: error instanceof Error && 'code' in error
              ? String((error as { code: unknown }).code)
              : 'EXTENSION_WEBVIEW_ATTACH_DENIED'
          })
        }
        return
      }

      if (!options.isAllowedDevPreviewUrl(src) && !options.isAuthorizedPrototypeFileUrl(src)) {
        event.preventDefault()
        return
      }
      delete webPreferences.preload
      delete (webPreferences as { preloadURL?: string }).preloadURL
      webPreferences.nodeIntegration = false
      webPreferences.contextIsolation = true
      webPreferences.sandbox = true
      webPreferences.webSecurity = true
      webPreferences.allowRunningInsecureContent = false
    })

    contents.on('did-attach-webview', (_event, guest) => {
      const record = options.sessions.bindNextGuest(contents.id, guest)
      if (record) hardenAttachedExtensionGuest(guest, record, options)
    })

    contents.on('will-navigate', (event, navigationUrl) => {
      if (contents.getType() !== 'webview') return
      const extension = options.sessions.findByGuest(contents.id)
      if (extension) {
        if (!isAllowedExtensionNavigation(navigationUrl, extension)) event.preventDefault()
        return
      }
      // Depending on Chromium event order, the initial navigation can be observed
      // before did-attach-webview binds the guest WebContents. Only the exact source
      // URL registered for this guest Session is allowed through that narrow gap.
      if (options.isPreparedExtensionNavigation(contents, navigationUrl)) return
      if (!options.isAllowedDevPreviewUrl(navigationUrl)) event.preventDefault()
    })

    contents.setWindowOpenHandler(({ url }) => {
      if (contents.getType() !== 'webview') return { action: 'allow' }
      if (options.sessions.findByGuest(contents.id)) return { action: 'deny' }
      return options.isAllowedDevPreviewUrl(url) ? { action: 'allow' } : { action: 'deny' }
    })
  })
}

export function hardenExtensionWebPreferences(
  webPreferences: WebPreferences,
  record: ExtensionViewSessionRecord,
  preloadPath: string
): void {
  delete (webPreferences as { preloadURL?: string }).preloadURL
  delete (webPreferences as { enableRemoteModule?: boolean }).enableRemoteModule
  webPreferences.preload = preloadPath
  webPreferences.nodeIntegration = false
  webPreferences.nodeIntegrationInWorker = false
  webPreferences.nodeIntegrationInSubFrames = false
  webPreferences.contextIsolation = true
  webPreferences.sandbox = true
  webPreferences.webSecurity = true
  webPreferences.allowRunningInsecureContent = false
  webPreferences.webviewTag = false
  webPreferences.partition = record.partition
  webPreferences.additionalArguments = [
    `--kun-extension-view-session=${record.sessionId}`,
    `--kun-extension-view-nonce=${record.nonce}`
  ]
  webPreferences.navigateOnDragDrop = false
  webPreferences.safeDialogs = true
  webPreferences.disableDialogs = true
  webPreferences.autoplayPolicy = 'document-user-activation-required'
}

export function isAllowedExtensionNavigation(
  rawUrl: string,
  record: Pick<ExtensionViewSessionRecord, 'extensionId'>
): boolean {
  try {
    return parseKunExtensionUrl(rawUrl).extensionId === record.extensionId
  } catch {
    return false
  }
}

function hardenAttachedExtensionGuest(
  guest: WebContents,
  record: ExtensionViewSessionRecord,
  options: WebviewSecurityOptions
): void {
  guest.setWindowOpenHandler(() => ({ action: 'deny' }))
  guest.on('will-navigate', (event, url) => {
    if (!isAllowedExtensionNavigation(url, record)) event.preventDefault()
  })
  guest.on('will-redirect', (event, url) => {
    if (!isAllowedExtensionNavigation(url, record)) event.preventDefault()
  })
  guest.on('render-process-gone', () => options.sessions.dispose(record.sessionId))

  const isolatedSession = guest.session
  isolatedSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  isolatedSession.setPermissionCheckHandler(() => false)
  isolatedSession.setDevicePermissionHandler(() => false)
  isolatedSession.on('will-download', (event) => event.preventDefault())
  isolatedSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    let allowed = false
    try {
      allowed = parseKunExtensionUrl(details.url).extensionId === record.extensionId
    } catch {
      allowed = false
    }
    callback({ cancel: !allowed })
  })
}
