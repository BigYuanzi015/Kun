import { ExtensionContributionsSchema } from '@kun/extension-api'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'
import {
  ContributionRegistry,
  ExtensionWorkbenchSnapshotSchema
} from './contribution-registry'
import { ExtensionDeclarativeSettingsPane } from './ExtensionDeclarativeSettingsPane'
import type { ExtensionSettingsService } from './extension-settings-service'

function contribution() {
  const registry = new ContributionRegistry()
  registry.replaceExtensions(ExtensionWorkbenchSnapshotSchema.parse({
    schemaVersion: 1,
    extensions: [{
      id: 'acme.settings',
      version: '1.0.0',
      enabled: true,
      compatible: true,
      workspaceTrusted: true,
      grantedPermissions: ['ui.actions'],
      contributes: ExtensionContributionsSchema.parse({
        settings: [{
          id: 'preferences',
          title: 'Preferences',
          scope: 'workspace',
          properties: {
            density: { type: 'integer', minimum: 1, maximum: 3, default: 2 }
          }
        }]
      })
    }]
  }))
  return registry.list('settings')[0]
}

describe('ExtensionDeclarativeSettingsPane', () => {
  it('loads and updates only through the injected revisioned service', async () => {
    const item = contribution()
    const load = vi.fn(async () => ({
      schemaVersion: 1 as const,
      revision: 4,
      values: { [item.id]: { density: 2 } }
    }))
    const update = vi.fn(async () => ({
      schemaVersion: 1 as const,
      revision: 5,
      values: { [item.id]: { density: 3 } }
    }))
    const service: ExtensionSettingsService = { load, update }
    let renderer: ReactTestRenderer
    await act(async () => {
      renderer = create(createElement(ExtensionDeclarativeSettingsPane, {
        contributions: [item],
        workspaceRoot: '/workspace',
        service
      }))
    })

    expect(load).toHaveBeenCalledWith({
      contributionIds: [item.id],
      workspaceRoot: '/workspace'
    })
    const input = renderer!.root.findByType('input')
    await act(async () => {
      input.props.onChange({ currentTarget: { value: '3' } })
    })
    expect(update).toHaveBeenCalledWith({
      contributionId: item.id,
      key: 'density',
      value: 3,
      expectedRevision: 4,
      workspaceRoot: '/workspace'
    })
    expect(renderer!.root.findByType('input').props.value).toBe(3)
  })
})
