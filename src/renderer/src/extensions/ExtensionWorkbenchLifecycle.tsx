import { ExtensionIdSchema, NotificationOptionsSchema } from '@kun/extension-api'
import type {
  ExtensionNotificationSnapshot,
  ExtensionWorkbenchNotification
} from '@shared/extension-ipc'
import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useChatStore } from '../store/chat-store'
import {
  DeclarativeNotifications,
  DynamicExtensionNotifications
} from './ControlledContributionSurfaces'
import {
  buildHostContentScriptPlan,
  protectedSurfaceForWorkbench,
  syncHostContentScriptPlan
} from './content-script-planner'
import { extensionWorkbenchClient } from './extension-workbench-client'
import {
  useExtensionContributionBootstrap,
  useWorkbenchContributions,
  workbenchContextForRoute
} from './use-contributions'

/**
 * App-wide contribution discovery and Direct DOM lifecycle. Keeping this
 * outside Workbench means route/approval changes immediately revoke Direct DOM.
 * Settings and onboarding are always protected because they contain secrets
 * and execution-policy controls.
 */
export function ExtensionWorkbenchLifecycle(): ReactElement {
  const route = useChatStore((state) => state.route)
  const workspaceRoot = useChatStore((state) => state.workspaceRoot)
  const runtimeConnection = useChatStore((state) => state.runtimeConnection)
  const protectedSurface = useChatStore((state) => protectedSurfaceForWorkbench({
    route: state.route,
    blocks: state.blocks,
    initialSetupOpen: state.initialSetupOpen
  }))
  const loadComposerModels = useChatStore((state) => state.loadComposerModels)
  const context = useMemo(
    () => workbenchContextForRoute(route, workspaceRoot),
    [route, workspaceRoot]
  )
  useExtensionContributionBootstrap(workspaceRoot, runtimeConnection)
  const contentScripts = useWorkbenchContributions('hostContentScripts', context)
  const notifications = useWorkbenchContributions('notifications', context)
  const [dynamicNotifications, setDynamicNotifications] = useState<ExtensionWorkbenchNotification[]>([])
  const respondingNotifications = useRef(new Set<string>())
  const plan = useMemo(
    () => buildHostContentScriptPlan({ contributions: contentScripts, route, protectedSurface }),
    [contentScripts, protectedSurface, route]
  )

  useEffect(() => {
    void syncHostContentScriptPlan(plan, workspaceRoot).catch((error) => {
      void window.kunGui?.logError?.('extension-content-script', 'Failed to sync host content scripts', {
        message: error instanceof Error ? error.message : String(error)
      })
    })
  }, [plan, workspaceRoot])

  useEffect(() => {
    const refresh = (): void => {
      void loadComposerModels()
    }
    window.addEventListener('kun:provider-bindings-changed', refresh)
    return () => window.removeEventListener('kun:provider-bindings-changed', refresh)
  }, [loadComposerModels])

  useEffect(() => window.kunGui.onExtensionNotifications((payload) => {
    const next = parseExtensionNotificationSnapshot(payload)
    const liveIds = new Set(next.map((notification) => notification.notificationId))
    for (const notificationId of respondingNotifications.current) {
      if (!liveIds.has(notificationId)) respondingNotifications.current.delete(notificationId)
    }
    setDynamicNotifications(next.filter(
      (notification) => !respondingNotifications.current.has(notification.notificationId)
    ))
  }), [])

  const respondToNotification = async (notificationId: string, actionId?: string): Promise<void> => {
    respondingNotifications.current.add(notificationId)
    setDynamicNotifications((current) => current.filter(
      (notification) => notification.notificationId !== notificationId
    ))
    try {
      await window.kunGui.extensionRespondNotification({
        notificationId,
        ...(actionId === undefined ? {} : { actionId })
      })
    } catch (error) {
      respondingNotifications.current.delete(notificationId)
      void window.kunGui.logError('extension-notification', 'Failed to respond to extension notification', {
        message: error instanceof Error ? error.message : String(error)
      })
    }
  }

  return (
    <div className="pointer-events-none fixed right-5 top-5 z-50 flex w-[360px] max-w-[calc(100vw-2rem)] flex-col gap-2">
      <DynamicExtensionNotifications
        notifications={dynamicNotifications}
        onRespond={respondToNotification}
      />
      <DeclarativeNotifications
        contributions={notifications}
        onCommand={(commandId, commandContext) =>
          extensionWorkbenchClient.invokeCommand(commandId, commandContext, workspaceRoot || undefined)}
      />
    </div>
  )
}

export function parseExtensionNotificationSnapshot(
  payload: ExtensionNotificationSnapshot | unknown
): ExtensionWorkbenchNotification[] {
  if (!payload || typeof payload !== 'object' || !Array.isArray(
    (payload as { notifications?: unknown }).notifications
  )) return []
  const parsed = new Map<string, ExtensionWorkbenchNotification>()
  for (const candidate of (payload as { notifications: unknown[] }).notifications.slice(0, 64)) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const record = candidate as Record<string, unknown>
    const extensionId = ExtensionIdSchema.safeParse(record.extensionId)
    const options = NotificationOptionsSchema.safeParse({
      id: record.sourceId,
      title: record.title,
      message: record.message,
      severity: record.severity,
      actions: record.actions
    })
    if (
      !extensionId.success ||
      !options.success ||
      typeof record.notificationId !== 'string' ||
      !/^notification_[0-9a-f-]{36}$/i.test(record.notificationId) ||
      typeof record.extensionVersion !== 'string' ||
      record.extensionVersion.length < 1 ||
      record.extensionVersion.length > 128 ||
      typeof record.createdAt !== 'string' ||
      typeof record.expiresAt !== 'string'
    ) continue
    const createdAt = Date.parse(record.createdAt)
    const expiresAt = Date.parse(record.expiresAt)
    if (!Number.isFinite(createdAt) || !Number.isFinite(expiresAt) || expiresAt < createdAt) continue
    parsed.set(record.notificationId, {
      notificationId: record.notificationId,
      extensionId: extensionId.data,
      extensionVersion: record.extensionVersion,
      sourceId: options.data.id,
      title: options.data.title,
      message: options.data.message,
      severity: options.data.severity,
      actions: options.data.actions.map((action) => ({ ...action })),
      createdAt: new Date(createdAt).toISOString(),
      expiresAt: new Date(expiresAt).toISOString()
    })
  }
  return [...parsed.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt))
}
