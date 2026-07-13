import { useEffect, useRef, type MutableRefObject } from 'react'
import { useWriteWorkspaceStore, type WriteWorkspaceState } from '../../write/write-workspace-store'
import { writeDocumentContextMatches } from '../../write/write-document-context'
import { startWriteWorkspaceFileWatch } from '../../write/write-file-watch'
import type { WriteMarkdownEditorHandle } from './WriteMarkdownEditor'

type PendingAgentReview = NonNullable<WriteWorkspaceState['pendingAgentReview']>

export function pendingWriteAgentReviewMatches(
  state: Pick<WriteWorkspaceState, 'workspaceRoot' | 'activeFilePath' | 'documentEpoch'>,
  review: PendingAgentReview
): boolean {
  return writeDocumentContextMatches(state, review)
}

type UseWriteWorkspaceLifecycleOptions = {
  workspaceRoot: string
  activeFilePath: string | null
  activeFileIsText: boolean
  activeFileIsImage: boolean
  autoSaveEnabled: boolean
  autoSaveDelayMs: number
  fileContent: string
  saveStatus: WriteWorkspaceState['saveStatus']
  workspaceReady: boolean
  readOnly: boolean
  reviewActive: boolean
  pendingAgentReview: PendingAgentReview | null
  saveTimerRef: MutableRefObject<number | null>
  markdownHandleRef: MutableRefObject<WriteMarkdownEditorHandle | null>
  flushSave: WriteWorkspaceState['flushSave']
  syncActiveFileFromDisk: WriteWorkspaceState['syncActiveFileFromDisk']
  syncActiveImageFromDisk: WriteWorkspaceState['syncActiveImageFromDisk']
  setFileContent: WriteWorkspaceState['setFileContent']
  setFileError: WriteWorkspaceState['setFileError']
  clearPendingAgentReview: WriteWorkspaceState['clearPendingAgentReview']
  setReviewActive: WriteWorkspaceState['setReviewActive']
}

export function useWriteWorkspaceLifecycle({
  workspaceRoot,
  activeFilePath,
  activeFileIsText,
  activeFileIsImage,
  autoSaveEnabled,
  autoSaveDelayMs,
  fileContent,
  saveStatus,
  workspaceReady,
  readOnly,
  reviewActive,
  pendingAgentReview,
  saveTimerRef,
  markdownHandleRef,
  flushSave,
  syncActiveFileFromDisk,
  syncActiveImageFromDisk,
  setFileContent,
  setFileError,
  clearPendingAgentReview,
  setReviewActive
}: UseWriteWorkspaceLifecycleOptions): void {
  const autoSaveEnabledRef = useRef(autoSaveEnabled)
  autoSaveEnabledRef.current = autoSaveEnabled

  useEffect(() => {
    if (!pendingAgentReview) return
    const current = useWriteWorkspaceStore.getState()
    clearPendingAgentReview()
    if (!pendingWriteAgentReviewMatches(current, pendingAgentReview)) {
      if (!markdownHandleRef.current?.isDiffReviewActive()) setReviewActive(false)
      return
    }
    const baseline = current.fileContent
    const started = markdownHandleRef.current?.beginDiffReview({
      original: baseline,
      nextDoc: pendingAgentReview.nextContent
    }) ?? false
    if (!started && pendingWriteAgentReviewMatches(useWriteWorkspaceStore.getState(), pendingAgentReview)) {
      // Rich mode / no source editor / identical content: apply directly only
      // while the originating document epoch is still current.
      setFileContent(pendingAgentReview.nextContent)
      setReviewActive(false)
    }
  }, [
    clearPendingAgentReview,
    markdownHandleRef,
    pendingAgentReview,
    setFileContent,
    setReviewActive
  ])

  useEffect(() => {
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = null
    }
    if (
      !autoSaveEnabled ||
      saveStatus !== 'dirty' ||
      !workspaceReady ||
      !activeFileIsText ||
      readOnly ||
      reviewActive
    ) return
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null
      void flushSave(workspaceRoot)
    }, autoSaveDelayMs)
    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
    }
  }, [
    activeFileIsText,
    autoSaveDelayMs,
    autoSaveEnabled,
    fileContent,
    flushSave,
    readOnly,
    reviewActive,
    saveStatus,
    saveTimerRef,
    workspaceReady,
    workspaceRoot
  ])

  useEffect(() => () => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
    if (autoSaveEnabledRef.current) void useWriteWorkspaceStore.getState().flushSave(workspaceRoot)
  }, [saveTimerRef, workspaceRoot])

  useEffect(() => {
    if (!activeFilePath || !workspaceRoot.trim() || (!activeFileIsText && !activeFileIsImage)) return
    if (
      typeof window.kunGui?.watchWorkspaceFile !== 'function' ||
      typeof window.kunGui?.unwatchWorkspaceFile !== 'function' ||
      typeof window.kunGui?.onWorkspaceFileChanged !== 'function'
    ) return

    return startWriteWorkspaceFileWatch({
      api: window.kunGui,
      workspaceRoot,
      path: activeFilePath,
      kind: activeFileIsImage ? 'image' : 'text',
      onTextSnapshot: (snapshot) => {
        void syncActiveFileFromDisk(workspaceRoot, snapshot)
      },
      onImageChanged: (path) => {
        void syncActiveImageFromDisk(workspaceRoot, path)
      },
      onError: setFileError
    })
  }, [
    activeFileIsImage,
    activeFileIsText,
    activeFilePath,
    setFileError,
    syncActiveFileFromDisk,
    syncActiveImageFromDisk,
    workspaceRoot
  ])
}
