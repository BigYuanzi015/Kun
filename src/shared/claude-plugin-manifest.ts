/**
 * Claude Code Plugin 清单格式 —— Kun 内建支持的插件打包规范。
 *
 * 一个 Claude Code Plugin 是包含以下可选内容的文件夹:
 *   plugin.json   — 插件元数据（本文件定义的清单）
 *   commands/     — 自定义斜杠命令 (*.md)
 *   skills/       — Skill 包
 *   hooks/        — Hook 脚本
 *   mcp.json      — MCP 服务器配置片段
 *
 * 与 Claude Code 兼容:commands/ 和 skills/ 的目录结构沿用
 * .claude/commands/ 和 .claude/skills/ 的约定。
 */

export const CLAUDE_PLUGIN_MANIFEST_FILENAME = 'plugin.json'

export const CLAUDE_PLUGIN_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][\w.-]{0,40})?$/

/**
 * plugin.json 中的 Hook 声明。
 * `phase` 指定生命周期阶段; `command` 是插件目录内的脚本相对路径。
 */
export type ClaudePluginHookManifest = {
  phase: 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'TurnStart' | 'TurnEnd' | 'PreCompact'
  /** 插件目录内的脚本相对路径 (如 hooks/pre-tool-use.js) */
  command: string
  /**
   * 可选的工具名匹配模式(PreToolUse / PostToolUse 阶段用)。
   * 支持 `*` 通配符,例如 `bash` 或 `write_*`。
   */
  matcher?: string
  /** 超时毫秒数; 默认 30000 */
  timeoutMs?: number
}

/**
 * Claude Code Plugin 清单 v1。
 *
 * 体积限制: plugin.json ≤ 64KB。
 */
export type ClaudePluginManifestV1 = {
  /** 插件唯一标识: 2-60 位小写字母/数字/连字符 */
  id: string
  /** 显示名称: ≤80 字符 */
  name: string
  /** 语义化版本,如 1.0.0 */
  version: string
  /** 作者: ≤120 字符 */
  author?: string
  /** 简要描述: ≤320 字符,支持 markdown 纯文本片段 */
  description?: string
  /** 主页/仓库 URL (可选) */
  homepage?: string
  /** 许可标识 (如 MIT, Apache-2.0) */
  license?: string
  /**
   * 最低 Kun 版本要求 (semver range 风格,仅做展示和粗略检查)。
   * 例如 "^0.1.0"。
   */
  kunVersion?: string
  /**
   * 插件声明的 Hooks。
   * 安装时写入 Kun config.json 的 hooks 数组。
   */
  hooks?: ClaudePluginHookManifest[]
  /**
   * 插件声明的 capability 要求。
   * Kun 目前忽略此字段(向后兼容),仅做文档用途。
   */
  capabilities?: Record<string, unknown>
}

/** 插件的体积限制 */
export const CLAUDE_PLUGIN_LIMITS = {
  /** plugin.json 最大字节数 */
  manifestBytes: 64 * 1024,
  /** 插件目录整体最大字节数(粗略扫描) */
  totalBytes: 50 * 1024 * 1024,
  /** 单文件最大字节数 */
  fileBytes: 5 * 1024 * 1024,
  /** id 最大字符数 */
  idChars: 60,
  /** name 最大字符数 */
  nameChars: 80,
  /** author 最大字符数 */
  authorChars: 120,
  /** description 最大字符数 */
  descriptionChars: 320,
  /** homepage URL 最大字符数 */
  urlChars: 1024
} as const

// ────────────────────────────────────────
// 运行时类型: 已安装插件
// ────────────────────────────────────────

export type InstalledClaudePlugin = {
  manifest: ClaudePluginManifestV1
  /** 安装根目录 (~/.kun/plugins/<id>/ 或插件源目录) */
  installRoot: string
  /** 插件源目录(用户选择安装时的原始路径) */
  sourceRoot: string
  /** 安装时间 ISO */
  installedAt: string
  /** 是否来自项目工作区 (false = 全局安装) */
  workspaceScoped: boolean
  /** 已复制的命令数量 */
  commandCount: number
  /** 已注册的技能数量 */
  skillCount: number
}

// ────────────────────────────────────────
// 校验
// ────────────────────────────────────────

const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,59}$/
const PLUGIN_RESERVED_IDS = new Set(['kun', 'ikun', 'gui_schedule'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readTrimmedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > max) return null
  return trimmed
}

const VALID_HOOK_PHASES = new Set([
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'TurnStart',
  'TurnEnd',
  'PreCompact'
])

export type PluginValidationResult =
  | { ok: true; manifest: ClaudePluginManifestV1 }
  | { ok: false; errors: string[] }

export function normalizeClaudePluginManifest(raw: unknown): PluginValidationResult {
  const errors: string[] = []
  if (!isPlainObject(raw)) {
    return { ok: false, errors: ['plugin.json 必须是 JSON 对象'] }
  }

  const id = readTrimmedString(raw.id, CLAUDE_PLUGIN_LIMITS.idChars)
  if (!id || !PLUGIN_ID_PATTERN.test(id)) {
    errors.push('id 需为 2-60 位小写字母/数字/连字符,且以字母或数字开头')
  } else if (PLUGIN_RESERVED_IDS.has(id)) {
    errors.push(`id "${id}" 是保留字，不可使用`)
  }

  const name = readTrimmedString(raw.name, CLAUDE_PLUGIN_LIMITS.nameChars)
  if (!name) errors.push(`name 必填 (≤${CLAUDE_PLUGIN_LIMITS.nameChars} 字符)`)

  const version = readTrimmedString(raw.version, 60)
  if (!version || !CLAUDE_PLUGIN_VERSION_PATTERN.test(version)) {
    errors.push('version 需为语义化版本号,如 1.0.0')
  }

  const author = readTrimmedString(raw.author, CLAUDE_PLUGIN_LIMITS.authorChars) ?? undefined
  if (raw.author !== undefined && author === undefined) {
    errors.push(`author 过长 (≤${CLAUDE_PLUGIN_LIMITS.authorChars} 字符)`)
  }

  const description = readTrimmedString(raw.description, CLAUDE_PLUGIN_LIMITS.descriptionChars) ?? undefined
  if (raw.description !== undefined && description === undefined) {
    errors.push(`description 过长 (≤${CLAUDE_PLUGIN_LIMITS.descriptionChars} 字符)`)
  }

  const homepage = readTrimmedString(raw.homepage, CLAUDE_PLUGIN_LIMITS.urlChars) ?? undefined
  if (raw.homepage !== undefined && homepage === undefined) {
    errors.push(`homepage URL 过长 (≤${CLAUDE_PLUGIN_LIMITS.urlChars} 字符)`)
  }

  const license = readTrimmedString(raw.license, 80) ?? undefined
  const kunVersion = readTrimmedString(raw.kunVersion, 40) ?? undefined

  // 校验 hooks
  let hooks: ClaudePluginHookManifest[] | undefined
  if (raw.hooks !== undefined) {
    if (!Array.isArray(raw.hooks)) {
      errors.push('hooks 需为数组')
    } else {
      hooks = []
      for (let i = 0; i < raw.hooks.length; i++) {
        const hook = raw.hooks[i]
        if (!isPlainObject(hook)) {
          errors.push(`hooks[${i}] 需为对象`)
          continue
        }
        const phase = readTrimmedString(hook.phase, 30)
        if (!phase || !VALID_HOOK_PHASES.has(phase)) {
          errors.push(`hooks[${i}].phase 无效 (有效值: ${[...VALID_HOOK_PHASES].join(', ')})`)
          continue
        }
        const command = readTrimmedString(hook.command, 512)
        if (!command) {
          errors.push(`hooks[${i}].command 必填`)
          continue
        }
        const matcher = readTrimmedString(hook.matcher, 256) ?? undefined
        const timeoutMs = typeof hook.timeoutMs === 'number' && hook.timeoutMs > 0 && hook.timeoutMs <= 120_000
          ? hook.timeoutMs
          : undefined
        hooks.push({
          phase: phase as ClaudePluginHookManifest['phase'],
          command,
          ...(matcher ? { matcher } : {}),
          ...(timeoutMs ? { timeoutMs } : {})
        })
      }
    }
  }

  let capabilities: Record<string, unknown> | undefined
  if (raw.capabilities !== undefined) {
    if (!isPlainObject(raw.capabilities)) {
      errors.push('capabilities 需为对象')
    } else {
      capabilities = raw.capabilities
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  return {
    ok: true,
    manifest: {
      id: id as string,
      name: name as string,
      version: version as string,
      ...(author ? { author } : {}),
      ...(description ? { description } : {}),
      ...(homepage ? { homepage } : {}),
      ...(license ? { license } : {}),
      ...(kunVersion ? { kunVersion } : {}),
      ...(hooks && hooks.length > 0 ? { hooks } : {}),
      ...(capabilities ? { capabilities } : {})
    }
  }
}
