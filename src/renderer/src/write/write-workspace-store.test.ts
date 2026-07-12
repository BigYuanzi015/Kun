import { afterEach, describe, expect, it, vi } from 'vitest'
import { useWriteWorkspaceStore } from './write-workspace-store'
import { clearWriteWorkspaceSaveQueueForTests } from './write-save-coordinator'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

function installDsGui(overrides: Partial<Window['kunGui']>): void {
  vi.stubGlobal('window', {
    kunGui: overrides
  })
}

function activateTextFile(path = '/tmp/write/draft.md'): void {
  useWriteWorkspaceStore.setState({
    workspaceRoot: '/tmp/write',
    activeFilePath: path,
    activeFileKind: 'text',
    fileContent: 'old content',
    persistedContent: 'old content',
    documentEpoch: 1,
    contentRevision: 0,
    fileError: null,
    fileLoading: false,
    saveStatus: 'saved'
  })
}

afterEach(() => {
  useWriteWorkspaceStore.getState().resetWorkspace()
  clearWriteWorkspaceSaveQueueForTests()
  vi.unstubAllGlobals()
})

describe('write workspace store', () => {
  it('reports read errors when syncing the active text file from disk', async () => {
    installDsGui({
      readWorkspaceFile: vi.fn(async () => {
        throw new Error('read failed')
      })
    })
    activateTextFile()

    const result = await useWriteWorkspaceStore.getState().syncActiveFileFromDisk('/tmp/write')

    expect(result).toBe(false)
    expect(useWriteWorkspaceStore.getState()).toMatchObject({
      fileError: 'read failed',
      saveStatus: 'error'
    })
  })

  it('does not apply late read errors after the active text file changes', async () => {
    installDsGui({
      readWorkspaceFile: vi.fn(async () => {
        useWriteWorkspaceStore.setState({ activeFilePath: '/tmp/write/next.md' })
        throw new Error('late read failed')
      })
    })
    activateTextFile()

    const result = await useWriteWorkspaceStore.getState().syncActiveFileFromDisk('/tmp/write')

    expect(result).toBe(false)
    expect(useWriteWorkspaceStore.getState()).toMatchObject({
      activeFilePath: '/tmp/write/next.md',
      fileError: null,
      saveStatus: 'saved'
    })
  })

  it('keeps newer edits dirty and writes them after an older save completes', async () => {
    const firstWrite = deferred<{ ok: true; path: string; savedAt: string }>()
    const writeWorkspaceFile = vi.fn()
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValue({ ok: true, path: '/tmp/write/draft.md', savedAt: '2026-07-11T00:00:02.000Z' })
    installDsGui({ writeWorkspaceFile })
    activateTextFile()
    useWriteWorkspaceStore.getState().setFileContent('v1')

    const saving = useWriteWorkspaceStore.getState().flushSave('/tmp/write')
    await vi.waitFor(() => expect(writeWorkspaceFile).toHaveBeenCalledTimes(1))
    useWriteWorkspaceStore.getState().setFileContent('v2')

    firstWrite.resolve({ ok: true, path: '/tmp/write/draft.md', savedAt: '2026-07-11T00:00:01.000Z' })
    await expect(saving).resolves.toBe(true)

    expect(writeWorkspaceFile.mock.calls.map(([payload]) => payload.content)).toEqual(['v1', 'v2'])
    expect(useWriteWorkspaceStore.getState()).toMatchObject({
      fileContent: 'v2',
      persistedContent: 'v2',
      saveStatus: 'saved'
    })
  })

  it('does not let a late save completion mutate another active file', async () => {
    const firstWrite = deferred<{ ok: true; path: string; savedAt: string }>()
    const writeWorkspaceFile = vi.fn(() => firstWrite.promise)
    installDsGui({ writeWorkspaceFile })
    activateTextFile('/tmp/write/a.md')
    useWriteWorkspaceStore.getState().setFileContent('save A')

    const saving = useWriteWorkspaceStore.getState().flushSave('/tmp/write')
    await vi.waitFor(() => expect(writeWorkspaceFile).toHaveBeenCalledTimes(1))
    useWriteWorkspaceStore.setState({
      activeFilePath: '/tmp/write/b.md',
      fileContent: 'B content',
      persistedContent: 'B content',
      documentEpoch: 2,
      contentRevision: 0,
      saveStatus: 'saved',
      fileError: null
    })

    firstWrite.resolve({ ok: true, path: '/tmp/write/a.md', savedAt: '2026-07-11T00:00:01.000Z' })
    await expect(saving).resolves.toBe(true)

    expect(useWriteWorkspaceStore.getState()).toMatchObject({
      activeFilePath: '/tmp/write/b.md',
      fileContent: 'B content',
      persistedContent: 'B content',
      saveStatus: 'saved',
      fileError: null
    })
  })

  it('keeps the active document in error when a queued save resolves unsuccessfully', async () => {
    installDsGui({
      writeWorkspaceFile: vi.fn(async () => ({ ok: false as const, message: 'disk full' }))
    })
    activateTextFile()
    useWriteWorkspaceStore.getState().setFileContent('unsaved')

    await expect(useWriteWorkspaceStore.getState().flushSave('/tmp/write')).resolves.toBe(false)

    expect(useWriteWorkspaceStore.getState()).toMatchObject({
      fileContent: 'unsaved',
      persistedContent: 'old content',
      saveStatus: 'error',
      fileError: 'disk full'
    })
  })
})
