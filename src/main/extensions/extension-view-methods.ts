/** Stable, fail-closed methods exposed to sandboxed extension Webviews. */
const EXTENSION_VIEW_METHODS = new Set([
  'ui.getTheme',
  'ui.getLocale',
  'ui.getViewState',
  'ui.setViewState',
  'ui.postMessage',
  'ui.showNotification',
  'commands.execute',
  'network.fetch',
  'agent.createRun',
  'agent.getRun',
  'agent.subscribe',
  'agent.unsubscribe',
  'agent.steer',
  'agent.cancel',
  'threads.listOwn',
  'threads.getOwn',
  'authentication.listAccounts',
  'modelProviders.getStatus',
  'storage.get',
  'storage.set',
  'storage.delete',
  'storage.keys',
  'workspace.readFile',
  'workspace.writeFile',
  'workspace.stat',
  'workspace.list'
])

export function isAllowedExtensionViewMethod(method: string): boolean {
  return EXTENSION_VIEW_METHODS.has(method)
}
