import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import './local-tool-host.js'
import { createGrepLocalTool } from './builtin-search-tools.js'

describe('grep input bounds', () => {
  it('skips oversized files in the in-process scan fallback', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'kun-grep-bound-'))
    try {
      await writeFile(join(workspace, 'large.txt'), 'needle here\n', 'utf8')
      const tool = createGrepLocalTool({
        rgExecutableCandidates: [],
        maxFileBytes: 8,
        maxTotalBytes: 16
      })

      const result = await tool.execute(
        { pattern: 'needle', path: '.' },
        {
          workspace,
          threadId: 'thr_grep_bound',
          turnId: 'turn_grep_bound',
          approvalPolicy: 'auto',
          sandboxMode: 'workspace-write',
          abortSignal: new AbortController().signal,
          awaitApproval: async () => 'deny'
        }
      )

      expect(result.isError).toBeUndefined()
      expect(result.output).toMatchObject({
        backend: 'scan',
        matches: [],
        skipped_large_files: 1,
        scan_byte_limit_reached: false
      })
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })
})
