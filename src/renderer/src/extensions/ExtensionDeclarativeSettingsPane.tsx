import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { JsonValue } from '@kun/extension-api'
import type { RegisteredContribution } from './contribution-registry'
import { DeclarativeSettingsSections } from './ControlledContributionSurfaces'
import type {
  ExtensionSettingChange,
  ExtensionSettingsService,
  ExtensionSettingsSnapshot
} from './extension-settings-service'

export function ExtensionDeclarativeSettingsPane({
  contributions,
  workspaceRoot,
  service
}: {
  contributions: readonly RegisteredContribution<'settings'>[]
  workspaceRoot: string
  service: ExtensionSettingsService
}): ReactElement {
  const [snapshot, setSnapshot] = useState<ExtensionSettingsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [updating, setUpdating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const snapshotRef = useRef<ExtensionSettingsSnapshot | null>(null)
  const updateQueueRef = useRef(Promise.resolve())
  const contributionKey = contributions.map((contribution) => contribution.id).join('\n')
  const contributionIds = useMemo(
    () => contributionKey ? contributionKey.split('\n') : [],
    [contributionKey]
  )

  const applySnapshot = useCallback((next: ExtensionSettingsSnapshot): void => {
    snapshotRef.current = next
    setSnapshot(next)
  }, [])

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setError(null)
    try {
      applySnapshot(await service.load({
        contributionIds,
        ...(workspaceRoot ? { workspaceRoot } : {})
      }))
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      setLoading(false)
    }
  }, [applySnapshot, contributionIds, service, workspaceRoot])

  useEffect(() => {
    void load()
  }, [contributionKey, load])

  useEffect(() => service.subscribe?.((change: ExtensionSettingChange) => {
    if (!contributionIds.includes(change.contributionId)) return
    if (change.scope === 'workspace' && change.workspaceRoot !== workspaceRoot) return
    setSnapshot((current) => {
      if (!current || change.revision <= current.revision) return current
      const next: ExtensionSettingsSnapshot = {
        ...current,
        revision: change.revision,
        values: {
          ...current.values,
          [change.contributionId]: {
            ...(current.values[change.contributionId] ?? {}),
            [change.key]: change.value
          }
        }
      }
      snapshotRef.current = next
      return next
    })
  }), [contributionIds, service, workspaceRoot])

  const update = (contributionId: string, key: string, value: JsonValue): void => {
    setUpdating(true)
    setError(null)
    updateQueueRef.current = updateQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        const current = snapshotRef.current
        if (!current) throw new Error('Extension settings are not loaded.')
        applySnapshot(await service.update({
          contributionId,
          key,
          value,
          expectedRevision: current.revision,
          ...(workspaceRoot ? { workspaceRoot } : {})
        }))
      })
      .catch(async (updateError) => {
        const message = updateError instanceof Error ? updateError.message : String(updateError)
        await load()
        setError(message)
      })
      .finally(() => setUpdating(false))
  }

  if (loading && !snapshot) {
    return <div role="status" className="text-[12px] text-ds-muted">Loading extension settings…</div>
  }

  return (
    <div className="space-y-4">
      {error ? (
        <div role="alert" className="rounded-xl border border-red-300/70 bg-red-50 px-4 py-3 text-[12px] text-red-800 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
          <div>{error}</div>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-2 rounded-lg border border-current px-2 py-1 font-semibold"
          >
            Retry
          </button>
        </div>
      ) : null}
      <DeclarativeSettingsSections
        contributions={contributions}
        values={snapshot?.values ?? {}}
        disabled={updating || loading}
        onChange={update}
      />
    </div>
  )
}
