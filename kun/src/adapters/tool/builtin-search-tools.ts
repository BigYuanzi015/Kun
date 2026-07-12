import { readFile, stat } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import { LocalToolHost, type LocalTool } from './local-tool-host.js'
import type { FindLocalToolOptions, GrepLocalToolOptions, GrepMatch, LsLocalToolOptions } from './builtin-tool-types.js'
import {
  DEFAULT_FIND_LIMIT,
  DEFAULT_GREP_MAX_CONTEXT_LINES,
  DEFAULT_GREP_MAX_FILE_BYTES,
  DEFAULT_GREP_MAX_MATCHES,
  DEFAULT_GREP_MAX_TOTAL_BYTES,
  DEFAULT_LIST_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  FD_EXECUTABLE_CANDIDATES,
  RG_EXECUTABLE_CANDIDATES
} from './builtin-tool-types.js'
import { defaultLsLocalToolOperations } from './builtin-tool-operations.js'
import {
  collectPaths,
  globToRegExp,
  isBinaryBuffer,
  listDirectoryWithOps,
  normalizeBoolean,
  normalizePositiveInteger,
  normalizeToolPath,
  resolveExecutable,
  resolveWorkspacePath,
  spawnCapture,
  withToolBoundary
} from './builtin-tool-utils.js'

export function createLsLocalTool(options: LsLocalToolOptions = {}): LocalTool {
  const statOp = options.operations?.stat ?? defaultLsLocalToolOperations.stat!
  const readdirOp = options.operations?.readdir ?? defaultLsLocalToolOperations.readdir!
  return LocalToolHost.defineTool({
    name: 'ls',
    description: 'List directory contents. Returns entries sorted alphabetically and marks directories.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        limit: { type: 'number' }
      },
      required: [],
      additionalProperties: false
    },
    policy: 'auto',
    execute: async (args, context) => withToolBoundary(async () => {
      const rawPath = typeof args.path === 'string' && args.path.trim() ? args.path : '.'
      const limit = normalizePositiveInteger(args.limit, options.defaultLimit ?? DEFAULT_LIST_LIMIT)
      const { workspaceRoot: root, absolutePath, relativePath } = await resolveWorkspacePath(rawPath, context)
      const targetStat = await statOp(absolutePath)
      if (!targetStat.isDirectory()) {
        return {
          output: {
            error: `not a directory: ${absolutePath}`,
            path: absolutePath
          },
          isError: true
        }
      }
      const entries = await listDirectoryWithOps(absolutePath, root, false, limit, statOp, readdirOp)
      return {
        output: {
          path: absolutePath,
          relative_path: relativePath,
          entries: entries.map((entry) => ({
            ...entry,
            display_name: entry.kind === 'directory' ? `${entry.name}/` : entry.name
          })),
          names: entries.map((entry) => (entry.kind === 'directory' ? `${entry.name}/` : entry.name)),
          truncated: entries.length >= limit,
          entry_limit_reached: entries.length >= limit ? limit : null
        }
      }
    })
  })
}

export const createLsTool = createLsLocalTool
export const createLsToolDefinition = createLsLocalTool

export function createFindLocalTool(options: FindLocalToolOptions = {}): LocalTool {
  return LocalToolHost.defineTool({
    name: 'find',
    description: 'Find workspace files by glob pattern, similar to pi find.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        limit: { type: 'number' }
      },
      required: ['pattern'],
      additionalProperties: false
    },
    policy: 'auto',
    execute: async (args, context) => withToolBoundary(async () => {
      const pattern = typeof args.pattern === 'string' ? args.pattern.trim() : ''
      if (!pattern) return { output: { error: 'pattern is required' }, isError: true }
      const rawPath = typeof args.path === 'string' && args.path.trim() ? args.path : '.'
      const limit = normalizePositiveInteger(args.limit, options.defaultLimit ?? DEFAULT_FIND_LIMIT)
      const { workspaceRoot: root, absolutePath, relativePath } = await resolveWorkspacePath(rawPath, context)
      const matcher = globToRegExp(pattern.includes('/') ? pattern : `**/${pattern}`)
      if (options.operations?.glob) {
        const matches = await options.operations.glob({ pattern, path: absolutePath, limit })
        return {
          output: {
            path: absolutePath,
            relative_path: relativePath,
            pattern,
            matches,
            backend: 'custom',
            truncated: matches.length >= limit,
            result_limit_reached: matches.length >= limit ? limit : null
          }
        }
      }
      const fd = resolveExecutable(options.fdExecutableCandidates ?? FD_EXECUTABLE_CANDIDATES)
      const rg = resolveExecutable(options.rgExecutableCandidates ?? RG_EXECUTABLE_CANDIDATES)
      let matches: Array<{ path: string; relative_path: string }>
      if (fd) {
        const args = [
          '--glob',
          '--color=never',
          '--hidden',
          '--no-require-git',
          '--max-results',
          String(limit),
          '--',
          pattern,
          absolutePath
        ]
        const result = await spawnCapture(fd, args, { cwd: root, signal: context.abortSignal })
        const candidates = result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
        matches = candidates
          .map((path) => ({
            path: resolve(path),
            relative_path: normalizeToolPath(relative(root, resolve(path)) || '.')
          }))
          .slice(0, limit)
      } else if (rg) {
        const result = await spawnCapture(
          rg,
          ['--files', '--hidden', '-g', pattern, absolutePath],
          { cwd: root, signal: context.abortSignal }
        )
        const candidates = result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
        matches = candidates
          .map((path) => ({
            path: resolve(path),
            relative_path: normalizeToolPath(relative(root, resolve(path)) || '.')
          }))
          .slice(0, limit)
      } else {
        const paths = await collectPaths(absolutePath, { includeDirectories: false, limit: limit * 8 })
        matches = paths
          .map((path) => ({ path, relative_path: normalizeToolPath(relative(root, path) || '.') }))
          .filter((entry) => matcher.test(entry.relative_path))
          .slice(0, limit)
      }
      return {
        output: {
          path: absolutePath,
          relative_path: relativePath,
          pattern,
          matches,
          backend: fd ? 'fd' : rg ? 'rg' : 'scan',
          truncated: matches.length >= limit,
          result_limit_reached: matches.length >= limit ? limit : null
        }
      }
    })
  })
}

export const createFindTool = createFindLocalTool
export const createFindToolDefinition = createFindLocalTool

export function createGrepLocalTool(options: GrepLocalToolOptions = {}): LocalTool {
  return LocalToolHost.defineTool({
    name: 'grep',
    description: 'Search file contents for a pattern and return matching lines with paths and line numbers.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        glob: { type: 'string' },
        ignoreCase: { type: 'boolean' },
        literal: { type: 'boolean' },
        context: { type: 'number' },
        limit: { type: 'number' }
      },
      required: ['pattern'],
      additionalProperties: false
    },
    policy: 'auto',
    execute: async (args, context) => withToolBoundary(async () => {
      const pattern = typeof args.pattern === 'string' ? args.pattern : ''
      if (!pattern.trim()) return { output: { error: 'pattern is required' }, isError: true }
      const literal = normalizeBoolean(args.literal)
      const ignoreCase = normalizeBoolean(args.ignoreCase)
      const contextLines = typeof args.context === 'number' && Number.isFinite(args.context) && args.context > 0
        ? Math.min(DEFAULT_GREP_MAX_CONTEXT_LINES, Math.floor(args.context))
        : 0
      const glob = typeof args.glob === 'string' && args.glob.trim() ? args.glob.trim() : null
      const limit = Math.min(
        DEFAULT_GREP_MAX_MATCHES,
        normalizePositiveInteger(args.limit, options.defaultLimit ?? DEFAULT_SEARCH_LIMIT)
      )
      const maxFileBytes = normalizePositiveInteger(options.maxFileBytes, DEFAULT_GREP_MAX_FILE_BYTES)
      const maxTotalBytes = Math.max(
        maxFileBytes,
        normalizePositiveInteger(options.maxTotalBytes, DEFAULT_GREP_MAX_TOTAL_BYTES)
      )
      const rawPath = typeof args.path === 'string' && args.path.trim() ? args.path : '.'
      const flags = ignoreCase ? 'i' : ''
      const effectiveMatcher = literal
        ? new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags)
        : new RegExp(pattern, flags)
      const globMatcher = glob ? globToRegExp(glob.includes('/') ? glob : `**/${glob}`) : null
      const { workspaceRoot: root, absolutePath, relativePath } = await resolveWorkspacePath(rawPath, context)
      if (options.operations?.search) {
        const matches = await options.operations.search({
          pattern,
          path: absolutePath,
          glob,
          ignoreCase,
          literal,
          context: contextLines,
          limit
        })
        return {
          output: {
            path: absolutePath,
            relative_path: relativePath,
            pattern,
            glob,
            ignore_case: ignoreCase,
            literal,
            context: contextLines,
            backend: 'custom',
            matches,
            truncated: matches.length >= limit,
            match_limit_reached: matches.length >= limit ? limit : null
          }
        }
      }
      const matches: GrepMatch[] = []
      const linesByPath = new Map<string, string[] | null>()
      let scannedBytes = 0
      let skippedLargeFiles = 0
      let scanByteLimitReached = false
      let commandOutputTruncated = false
      const loadTextLines = async (candidatePath: string): Promise<string[] | null> => {
        if (linesByPath.has(candidatePath)) return linesByPath.get(candidatePath) ?? null
        try {
          const fileStat = await stat(candidatePath)
          const fileBytes = Math.max(0, fileStat.size)
          if (!fileStat.isFile() || fileBytes > maxFileBytes || scannedBytes + fileBytes > maxTotalBytes) {
            if (fileStat.isFile() && fileBytes > maxFileBytes) skippedLargeFiles += 1
            if (fileStat.isFile() && scannedBytes + fileBytes > maxTotalBytes) scanByteLimitReached = true
            linesByPath.set(candidatePath, null)
            return null
          }
          const buffer = await readFile(candidatePath)
          // Re-check after opening in case the file changed after stat().
          if (buffer.length > maxFileBytes || scannedBytes + buffer.length > maxTotalBytes) {
            if (buffer.length > maxFileBytes) skippedLargeFiles += 1
            if (scannedBytes + buffer.length > maxTotalBytes) scanByteLimitReached = true
            linesByPath.set(candidatePath, null)
            return null
          }
          scannedBytes += buffer.length
          if (isBinaryBuffer(buffer)) {
            linesByPath.set(candidatePath, null)
            return null
          }
          const lines = buffer.toString('utf8').replace(/\r\n/g, '\n').split('\n')
          linesByPath.set(candidatePath, lines)
          return lines
        } catch {
          // Files can legitimately disappear while rg/scan is walking a live
          // workspace. Treat that one path as unavailable rather than failing
          // the entire bounded search.
          linesByPath.set(candidatePath, null)
          return null
        }
      }
      const rg = resolveExecutable(options.rgExecutableCandidates ?? RG_EXECUTABLE_CANDIDATES)
      if (rg) {
        const rgArgs = ['--hidden', '--line-number', '--with-filename', '--color', 'never']
        if (ignoreCase) rgArgs.push('--ignore-case')
        if (literal) rgArgs.push('--fixed-strings')
        if (glob) rgArgs.push('-g', glob)
        rgArgs.push(pattern, absolutePath)
        const result = await spawnCapture(rg, rgArgs, { cwd: root, signal: context.abortSignal })
        commandOutputTruncated = result.outputTruncated
        const rows = result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
        for (const row of rows) {
          if (matches.length >= limit) break
          const parsed = row.match(/^(.*?):(\d+):(.*)$/)
          if (!parsed) continue
          const candidatePath = resolve(parsed[1] ?? '')
          const lineNumber = Number(parsed[2] ?? '0')
          const lineText = parsed[3] ?? ''
          const candidateRelative = normalizeToolPath(relative(root, candidatePath) || '.')
          if (globMatcher && !globMatcher.test(candidateRelative)) continue
          const columnMatch = effectiveMatcher.exec(lineText)
          const lines = contextLines > 0 ? await loadTextLines(candidatePath) : null
          if (contextLines > 0 && !lines) continue
          matches.push({
            path: candidatePath,
            relative_path: candidateRelative,
            line: lineNumber,
            column: (columnMatch?.index ?? 0) + 1,
            text: lineText,
            ...(contextLines > 0
              ? {
                  context_before: lines!.slice(Math.max(0, lineNumber - 1 - contextLines), lineNumber - 1),
                  context_after: lines!.slice(lineNumber, lineNumber + contextLines)
                }
              : {})
          })
        }
      } else {
        const candidates = await collectPaths(absolutePath, { includeDirectories: false, limit: limit * 8 })
        for (const candidatePath of candidates) {
          if (matches.length >= limit) break
          const candidateRelative = normalizeToolPath(relative(root, candidatePath) || '.')
          if (globMatcher && !globMatcher.test(candidateRelative)) continue
          const lines = await loadTextLines(candidatePath)
          if (!lines) continue
          for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index] ?? ''
            const result = effectiveMatcher.exec(line)
            if (!result) continue
            matches.push({
              path: candidatePath,
              relative_path: candidateRelative,
              line: index + 1,
              column: (result.index ?? 0) + 1,
              text: line,
              ...(contextLines > 0
                ? {
                    context_before: lines.slice(Math.max(0, index - contextLines), index),
                    context_after: lines.slice(index + 1, index + 1 + contextLines)
                  }
                : {})
            })
            if (matches.length >= limit) break
          }
        }
      }
      return {
        output: {
          path: absolutePath,
          relative_path: relativePath,
          pattern,
          glob,
          ignore_case: ignoreCase,
          literal,
          context: contextLines,
          backend: rg ? 'rg' : 'scan',
          matches,
          truncated: matches.length >= limit,
          match_limit_reached: matches.length >= limit ? limit : null,
          skipped_large_files: skippedLargeFiles,
          scan_byte_limit_reached: scanByteLimitReached,
          command_output_truncated: commandOutputTruncated
        }
      }
    })
  })
}

export const createGrepTool = createGrepLocalTool
export const createGrepToolDefinition = createGrepLocalTool
