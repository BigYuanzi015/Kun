import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import i18n from '../../i18n'
import { WorkbenchSideRail, WorkbenchTopActions } from './WorkbenchTopBar'
import { ExtensionContributionsSchema } from '@kun/extension-api'
import {
  ContributionRegistry,
  ExtensionWorkbenchSnapshotSchema
} from '../../extensions/contribution-registry'

describe('WorkbenchTopActions', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders editor and terminal actions for the top bar', () => {
    const html = renderToStaticMarkup(
      createElement(WorkbenchTopActions, {
        terminalOpen: false,
        onToggleTerminal: vi.fn()
      })
    )

    expect(html).toContain(`data-tooltip="Choose default editor"`)
    expect(html).toContain(`aria-label="Choose default editor"`)
    expect(html).toContain(`data-tooltip="Terminal"`)
    expect(html).toContain(`aria-label="Terminal"`)
    expect(html).not.toContain(`title="Choose default editor"`)
    expect(html).not.toContain(`title="Terminal"`)
    expect(html.indexOf('data-tooltip="Choose default editor"')).toBeLessThan(
      html.indexOf('data-tooltip="Terminal"')
    )
  })
})

describe('WorkbenchSideRail', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('renders visible tooltip labels for right rail icon buttons', () => {
    const registry = new ContributionRegistry()
    registry.replaceExtensions(ExtensionWorkbenchSnapshotSchema.parse({
      schemaVersion: 1,
      revision: 1,
      extensions: [{
        id: 'acme.issues',
        version: '1.0.0',
        workspaceTrusted: true,
        grantedPermissions: ['ui.views', 'webview'],
        contributes: ExtensionContributionsSchema.parse({
          'views.rightSidebar': [{
            id: 'issues',
            title: 'Issues',
            entry: 'dist/index.html'
          }]
        })
      }]
    }))
    const html = renderToStaticMarkup(
      createElement(WorkbenchSideRail, {
        rightPanelMode: null,
        onToggleRightPanelMode: vi.fn(),
        planPanelEnabled: true,
        canvasEnabled: true,
        sideChatCount: 0,
        sideChatRunningCount: 0,
        sideChatOpen: false,
        sideChatEnabled: true,
        fileTreeOpen: false,
        fileTreeEnabled: true,
        onToggleFileTree: vi.fn(),
        onOpenSideChat: vi.fn(),
        extensionItems: registry.list('views.rightSidebar').filter((item) => item.owner.kind === 'extension')
      })
    )

    for (const label of [
      'Open branch conversation',
      'Todo',
      'Plan',
      'Changes',
      'Preview',
      'Whiteboard',
      'Subagents',
      'Files'
    ]) {
      expect(html).toContain(`data-tooltip="${label}"`)
      expect(html).toContain(`aria-label="${label}"`)
      expect(html).not.toContain(`title="${label}"`)
    }

    expect(html).toContain('data-tooltip="Issues"')
    expect(html).toContain('data-contribution-id="extension:acme.issues/issues"')

    expect(html).not.toContain(`data-tooltip="Choose default editor"`)
    expect(html).not.toContain(`data-tooltip="Terminal"`)

    expect(html.match(/ds-side-rail-button/g)?.length).toBeGreaterThanOrEqual(8)
  })
})
