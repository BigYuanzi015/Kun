import type { WorkspaceFileWritePayload, WorkspaceFileWriteResult } from '@shared/workspace-file'

type WriteWorkspaceFile = (payload: WorkspaceFileWritePayload) => Promise<WorkspaceFileWriteResult>

const saveQueues = new Map<string, Promise<unknown>>()

function normalizedKeyPart(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/\/+$/, '')
}

export function writeSaveQueueKey(workspaceRoot: string, path: string): string {
  return `${normalizedKeyPart(workspaceRoot)}\0${normalizedKeyPart(path)}`
}

/**
 * Serializes any read/modify/write operation with normal document saves for
 * the same workspace file. This is used by background jobs such as
 * infographic placeholder resolution, which must not race an autosave.
 */
export function enqueueWriteWorkspaceFileTask<T>(
  workspaceRoot: string,
  path: string,
  operation: () => Promise<T>
): Promise<T> {
  const key = writeSaveQueueKey(workspaceRoot, path)
  const previous = saveQueues.get(key) ?? Promise.resolve()
  const task = previous
    .catch(() => undefined)
    .then(operation)
  saveQueues.set(key, task)
  void task.finally(() => {
    if (saveQueues.get(key) === task) saveQueues.delete(key)
  }).catch(() => undefined)
  return task
}

export function enqueueWriteWorkspaceSave(
  payload: WorkspaceFileWritePayload,
  writeWorkspaceFile: WriteWorkspaceFile = window.kunGui.writeWorkspaceFile
): Promise<WorkspaceFileWriteResult> {
  return enqueueWriteWorkspaceFileTask(
    payload.workspaceRoot ?? '',
    payload.path,
    () => writeWorkspaceFile(payload)
  )
}

export async function flushWriteWorkspaceSaveQueue(
  workspaceRoot?: string,
  path?: string
): Promise<void> {
  if (workspaceRoot !== undefined && path !== undefined) {
    await saveQueues.get(writeSaveQueueKey(workspaceRoot, path))?.catch(() => undefined)
    return
  }
  await Promise.all([...saveQueues.values()].map((task) => task.catch(() => undefined)))
}

export function clearWriteWorkspaceSaveQueueForTests(): void {
  saveQueues.clear()
}
