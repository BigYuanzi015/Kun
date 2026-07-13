export type BackfillScan<TUsage> = { highWater: number; usage: TUsage[] }

export type HybridThreadBackfillDeps<TUsage> = {
  indexedRows: () => Array<{ id: string; usage_backfilled?: number }>
  filesystemThreadIds: () => Promise<string[]>
  readMissingThread: (threadId: string) => Promise<boolean>
  scanEvents: (threadId: string) => Promise<BackfillScan<TUsage>>
  upsertMissing: (threadId: string, highWater: number) => Promise<void>
  noteExistingHighWater: (threadId: string, highWater: number) => void
  insertUsage: (threadId: string, usage: TUsage[]) => Promise<void>
  markUsageBackfilled: (threadId: string) => void
  threadDirectoryExists: (threadId: string) => Promise<boolean>
  deleteIndexRow: (threadId: string) => void
  yieldToEventLoop: () => Promise<void>
  warn: (action: string, error: unknown) => void
}

/** Single-flight owner for startup index/usage recovery and stale-row cleanup. */
export class HybridThreadBackfillCoordinator<TUsage> {
  private promise: Promise<void> | null = null
  private stopped = false
  constructor(private readonly deps: HybridThreadBackfillDeps<TUsage>) {}

  start(): void {
    if (this.promise || this.stopped) return
    this.promise = this.run().catch((error) => this.deps.warn('background backfill', error))
  }

  stop(): void { this.stopped = true }

  async wait(): Promise<void> { await this.promise }

  private async run(): Promise<void> {
    if (this.stopped) return
    const rows = this.deps.indexedRows()
    const indexed = new Map(rows.map((row) => [row.id, row.usage_backfilled === 1]))
    const filesystemThreadIds = await this.deps.filesystemThreadIds()
    if (this.stopped) return
    for (const threadId of filesystemThreadIds) {
      if (this.stopped) return
      const usageBackfilled = indexed.get(threadId)
      if (usageBackfilled === true) continue
      if (usageBackfilled === undefined) {
        const readable = await this.deps.readMissingThread(threadId)
        if (this.stopped) return
        if (!readable) continue
      }
      const scan = await this.deps.scanEvents(threadId)
      if (this.stopped) return
      if (usageBackfilled === undefined) {
        await this.deps.upsertMissing(threadId, scan.highWater)
        if (this.stopped) return
      } else {
        this.deps.noteExistingHighWater(threadId, scan.highWater)
      }
      await this.deps.insertUsage(threadId, scan.usage)
      if (this.stopped) return
      this.deps.markUsageBackfilled(threadId)
      await this.deps.yieldToEventLoop()
      if (this.stopped) return
    }
    try {
      for (const row of rows) {
        if (this.stopped) return
        const exists = await this.deps.threadDirectoryExists(row.id)
        if (this.stopped) return
        if (!exists) this.deps.deleteIndexRow(row.id)
      }
    } catch (error) { this.deps.warn('backfill cleanup', error) }
  }
}
