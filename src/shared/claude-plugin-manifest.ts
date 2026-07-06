/**
 * Claude Code Plugin 清单格式 —— 兼容 Claude Code 官方协议 + Kun 扩展。
 *
 * Claude Code 官方 plugin.json 格式 (参考:
 *   https://docs.anthropic.com/en/docs/claude-code/plugins):
 *   - 使用 `name` 作为唯一标识 (Kun 内部映射为 `id`)
 *   - 使用 `displayName` 作为展示名称 (映射为 `name`)
 *   - `skills` / `commands` 是相对路径字符串
 *   - `author` 支持 `{name, email?}` 对象或字符串
 *
 * Kun 扩展字段 (官方格式中不存在, Kun 内部使用):
 *   - `kunVersion` 最低 Kun 版本要求
 *   - `capabilities` capability 声明
 *
 * 一个 Claude Code Plugin 是包含以下内容的文件夹:
 *   .claude-plugin/plugin.json — 插件元数据 (Claude Code 官方路径)
 *   或 plugin.json             — Kun 兼容路径
 *   commands/                  — 自定义斜杠命令 (*.md)
 *   skills/                    — Skill 包
 *   hooks/                     — Hook 脚本
 *   mcp.json                   — MCP 服务器配置片段
 */

export const CLAUDE_PLUGIN_MANIFEST_FILENAME = 'plugin.json'
export const CLAUDE_PLUGIN_DIRNAME = '.claude-plugin'

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
 * 兼容 Claude Code 官方格式 + Kun 扩展。
 */
export type ClaudePluginManifestV1 = {
  /** 插件唯一标识: 2-60 位小写字母/数字/连字符
   *  (Claude Code 官方用 `name` 字段; Kun 内部统一映射为 `id`) */
  id: string
  /** 显示名称: ≤80 字符
   *  (Claude Code 官方用 `displayName`; Kun 优先取 displayName, fallback name/id) */
  name: string
  /** 语义化版本,如 1.0.0 */
  version: string
  /** 作者: ≤120 字符 (兼容 Claude Code 官方 `{name, email?}` 对象格式, 安装时取 name) */
  author?: string
  /** 简要描述: ≤320 字符,支持 markdown 纯文本片段 */
  description?: string
  /** 主页/仓库 URL (可选) */
  homepage?: string
  /** 许可标识 (如 MIT, Apache-2.0) */
  license?: string
  /** 关键词 (Claude Code 官方字段) */
  keywords?: string[]
  /** skills 目录相对路径 (Claude Code 官方字段), 如 "./skills/" */
  skills?: string
  /** commands 目录相对路径 (Claude Code 官方字段), 如 "./commands/" */
  commands?: string
  /**
   * 最低 Kun 版本要求 (semver range 风格,仅做展示和粗略检查)。
   * 例如 "^0.1.0"。Kun 扩展字段, Claude Code 官方无此字段。
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

/** 插件的元数据/命名限制(文件大小不做限制) */
export const CLAUDE_PLUGIN_LIMITS = {
  /** plugin.json 最大字节数 */
  manifestBytes: 64 * 1024,
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
  /** 插件源: 本地路径 / "npm:<packageName>" / "https://gitee.com/..." 等 */
  sourceRoot: string
  /** 市场名 (如 "gis-agent-toolkit"), 从 marketplace 安装时有值 */
  marketplaceName?: string
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

  // ── 标识符: Claude Code 官方用 `name`; Kun 用 `id` ──────────
  const rawId = readTrimmedString(raw.id, CLAUDE_PLUGIN_LIMITS.idChars)
  const rawName = readTrimmedString(raw.name, CLAUDE_PLUGIN_LIMITS.idChars)
  // 优先 Claude Code 官方的 `name` 作为唯一标识
  let id = rawName || rawId
  if (!id) {
    errors.push('缺少标识符 (Claude Code 格式用 `name`, Kun 也可用 `id`)')
  } else if (!PLUGIN_ID_PATTERN.test(id)) {
    // 从 raw.name 来的时候可能含大写/特殊字符, 做 slug 处理
    const slugged = rawName
      ? rawName.trim().normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}_-]+/gu, '-').replace(/^-+|-+$/g, '')
      : id
    if (PLUGIN_ID_PATTERN.test(slugged)) {
      id = slugged
    } else {
      errors.push('插件标识符需为 2-60 位小写字母/数字/连字符,且以字母或数字开头')
    }
  }
  if (id && PLUGIN_RESERVED_IDS.has(id)) {
    errors.push(`id "${id}" 是保留字，不可使用`)
  }

  // ── 展示名称: Claude Code 官方用 `displayName`; Kun 用 `name` ──
  const displayName = readTrimmedString(raw.displayName, CLAUDE_PLUGIN_LIMITS.nameChars)
  const nameFromRaw = readTrimmedString(raw.name, CLAUDE_PLUGIN_LIMITS.nameChars)
  const name = displayName || nameFromRaw || (id as string | undefined) || ''
  if (!name) errors.push(`name/displayName 必填 (≤${CLAUDE_PLUGIN_LIMITS.nameChars} 字符)`)

  // ── 版本号 ──────────────────────────────────────────────
  const version = readTrimmedString(raw.version, 60)
  if (!version || !CLAUDE_PLUGIN_VERSION_PATTERN.test(version)) {
    errors.push('version 需为语义化版本号,如 1.0.0')
  }

  // ── 作者: 兼容 Claude Code 官方 `{name, email?}` 对象格式 ──
  let author: string | undefined
  if (typeof raw.author === 'string') {
    author = readTrimmedString(raw.author, CLAUDE_PLUGIN_LIMITS.authorChars) ?? undefined
  } else if (isPlainObject(raw.author)) {
    author = readTrimmedString(raw.author.name, CLAUDE_PLUGIN_LIMITS.authorChars) ?? undefined
  }
  if (raw.author !== undefined && author === undefined) {
    errors.push(`author 过长或格式无效 (≤${CLAUDE_PLUGIN_LIMITS.authorChars} 字符)`)
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

  // ── Claude Code 官方字段 ──────────────────────────────
  const keywords: string[] | undefined = Array.isArray(raw.keywords)
    ? raw.keywords.filter((k): k is string => typeof k === 'string' && k.trim().length > 0).slice(0, 20)
    : undefined
  const skills = readTrimmedString(raw.skills, 256) ?? undefined
  const commands = readTrimmedString(raw.commands, 256) ?? undefined

  // ── 校验 hooks ────────────────────────────────────────
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
      ...(keywords ? { keywords } : {}),
      ...(skills ? { skills } : {}),
      ...(commands ? { commands } : {}),
      ...(kunVersion ? { kunVersion } : {}),
      ...(hooks && hooks.length > 0 ? { hooks } : {}),
      ...(capabilities ? { capabilities } : {})
    }
  }
}
