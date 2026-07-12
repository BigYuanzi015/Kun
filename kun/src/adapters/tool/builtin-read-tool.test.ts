import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import './local-tool-host.js'
import { createReadLocalTool } from './builtin-read-tool.js'

describe('read input bounds', () => {
  it('rejects an oversized file before calling readFile', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-read-bound-'))
    try {
      await writeFile(join(workspace, 'large.txt'), '0123456789', 'utf8')
      const readFile = vi.fn()
      const tool = createReadLocalTool({
        maxFileBytes: 8,
        operations: { readFile }
      })

      const result = await tool.execute(
        { path: 'large.txt' },
        {
          workspace,
          threadId: 'thr_read_bound',
          turnId: 'turn_read_bound',
          approvalPolicy: 'auto',
          sandboxMode: 'workspace-write',
          abortSignal: new AbortController().signal,
          awaitApproval: async () => 'deny'
        }
      )

      expect(result.isError).toBe(true)
      expect(result.output).toMatchObject({
        code: 'file_too_large',
        byte_size: 10,
        max_file_bytes: 8
      })
      expect(readFile).not.toHaveBeenCalled()
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
