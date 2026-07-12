import { ExtensionContributionsSchema } from '@kun/extension-api'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  ContributionRegistry,
  ExtensionWorkbenchSnapshotSchema
} from './contribution-registry'
import {
  ExtensionActivityBar,
  firstViewForContainer,
  readStoredExtensionSurfaceId,
  viewBelongsToContainer,
  type ExtensionWorkbenchViewGroups,
  writeStoredExtensionSurfaceId
} from './ExtensionWorkbenchSurfaces'

function fixture(): {
  registry: ContributionRegistry
  groups: ExtensionWorkbenchViewGroups
} {
  const registry = new ContributionRegistry()
  registry.replaceExtensions(ExtensionWorkbenchSnapshotSchema.parse({
    schemaVersion: 1,
    revision: 1,
    extensions: [{
      id: 'acme.workbench',
      version: '1.0.0',
      enabled: true,
      compatible: true,
      workspaceTrusted: true,
      grantedPermissions: ['ui.views', 'webview'],
      contributes: ExtensionContributionsSchema.parse({
        'views.containers': [
          { id: 'project', title: 'Project', location: 'leftSidebar' },
          { id: 'inspect', title: 'Inspect', location: 'rightSidebar' },
          { id: 'activity', title: 'Activity', location: 'activity' }
        ],
        'views.leftSidebar': [{
          id: 'tree', title: 'Tree', entry: 'dist/tree.html', container: 'project'
        }],
        'views.rightSidebar': [{
          id: 'details', title: 'Details', entry: 'dist/details.html', container: 'inspect'
        }],
        'views.auxiliaryPanel': [{
          id: 'logs', title: 'Logs', entry: 'dist/logs.html', container: 'activity'
        }],
        'views.editorTab': [{ id: 'editor', title: 'Editor', entry: 'dist/editor.html' }],
        'views.fullPage': [{ id: 'dashboard', title: 'Dashboard', entry: 'dist/dashboard.html' }]
      })
    }]
  }))
  return {
    registry,
    groups: {
      leftSidebar: registry.list('views.leftSidebar'),
      rightSidebar: registry.list('views.rightSidebar').filter((item) => item.owner.kind === 'extension'),
      auxiliaryPanel: registry.list('views.auxiliaryPanel'),
      editorTab: registry.list('views.editorTab'),
      fullPage: registry.list('views.fullPage')
    }
  }
}

describe('Extension workbench surface consumers', () => {
  it('resolves containers only to owned Views at their declared sidebar location', () => {
    const { registry, groups } = fixture()
    const containers = registry.list('views.containers')
    const activity = containers.find((item) => item.payload.id === 'activity')!
    const inspect = containers.find((item) => item.payload.id === 'inspect')!
    const project = containers.find((item) => item.payload.id === 'project')!
    expect(firstViewForContainer(project, groups)?.id).toBe('extension:acme.workbench/tree')
    expect(firstViewForContainer(inspect, groups)?.id).toBe('extension:acme.workbench/details')
    expect(firstViewForContainer(activity, groups)?.id).toBe('extension:acme.workbench/logs')
    expect(viewBelongsToContainer(project, groups.rightSidebar[0])).toBe(false)
  })

  it('renders host-owned activity controls without mounting extension React code', () => {
    const { registry, groups } = fixture()
    const html = renderToStaticMarkup(createElement(ExtensionActivityBar, {
      containers: registry.list('views.containers'),
      groups,
      activeId: 'extension:acme.workbench/tree',
      onOpen: vi.fn()
    }))
    expect(html).toContain('aria-label="Extension activity"')
    expect(html).toContain('data-contribution-id="extension:acme.workbench/project"')
    expect(html).toContain('aria-label="Open extension Views"')
    expect(html).not.toContain('dangerouslySetInnerHTML')
  })

  it('persists only qualified extension surface IDs per workspace', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string): string | null => values.get(key) ?? null,
      setItem: (key: string, value: string): void => { values.set(key, value) },
      removeItem: (key: string): void => { values.delete(key) }
    }
    writeStoredExtensionSurfaceId(storage, 'extension:acme.workbench/editor')
    expect(readStoredExtensionSurfaceId(storage)).toBe('extension:acme.workbench/editor')
    writeStoredExtensionSurfaceId(storage, 'builtin:right-panel-todo')
    expect(readStoredExtensionSurfaceId(storage)).toBeNull()
    writeStoredExtensionSurfaceId(storage, null)
    expect(readStoredExtensionSurfaceId(storage)).toBeNull()
  })
})
