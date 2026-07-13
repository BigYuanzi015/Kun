import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeAppSettings, type AppSettingsV1 } from '@shared/app-settings'
import { rendererRuntimeClient } from '../agent/runtime-client'
import { useWriteWorkspaceStore } from './write-workspace-store'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

function settingsFor(workspaceRoot: string): AppSettingsV1 {
  return normalizeAppSettings({
    write: {
      activeWorkspaceRoot: workspaceRoot,
      workspaces: [workspaceRoot]
    }
  } as AppSettingsV1)
}

afterEach(() => {
  vi.restoreAllMocks()
  useWriteWorkspaceStore.setState({
    workspaceRoot: '',
    workspaceRoots: [],
    settingsLoading: false,
    settingsError: null
  })
})

describe('write workspace settings actions', () => {
  it('applies only the latest workspace selection when settings responses finish out of order', async () => {
    const first = deferred<AppSettingsV1>()
    const second = deferred<AppSettingsV1>()
    vi.spyOn(rendererRuntimeClient, 'setSettings')
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
    const initializeWorkspace = vi.fn(async () => undefined)
    useWriteWorkspaceStore.setState({
      workspaceRoots: ['/workspace/original'],
      initializeWorkspace
    })

    const selectingFirst = useWriteWorkspaceStore.getState().selectWriteWorkspace('/workspace/a')
    const selectingSecond = useWriteWorkspaceStore.getState().selectWriteWorkspace('/workspace/b')

    second.resolve(settingsFor('/workspace/b'))
    await selectingSecond
    first.resolve(settingsFor('/workspace/a'))
    await selectingFirst

    expect(initializeWorkspace).toHaveBeenCalledTimes(1)
    expect(initializeWorkspace).toHaveBeenCalledWith('/workspace/b')
    expect(useWriteWorkspaceStore.getState().workspaceRoots).toContain('/workspace/b')
    expect(useWriteWorkspaceStore.getState().workspaceRoots).not.toContain('/workspace/a')
  })
})
