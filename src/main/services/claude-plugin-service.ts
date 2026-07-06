/**
 * Claude Code Plugin 安装服务。
 *
 * 负责:
 *  1. 从本地文件夹安装插件（扫描 plugin.json，验证 schema）
 *  2. 将 commands/ 复制到 ~/.kun/plugins/<id>/commands/
 *  3. 将 skills/ 注册为 global skill root
 *  4. 将 mcp.json 内容合并到 ~/.kun/mcp.json
 *  5. 记录安装状态到 kun-settings.json
 *
 * 安全模型沿袭 ui-plugin-service: 只复制白名单目录结构与特定后缀文件;
 * 插件目录中不执行任何脚本或可执行文件。
 */

import { homedir } from 'node:os'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises'
import {
  normalizeClaudePluginManifest,
  CLAUDE_PLUGIN_MANIFEST_FILENAME,
  CLAUDE_PLUGIN_DIRNAME,
  CLAUDE_PLUGIN_LIMITS,
  type ClaudePluginManifestV1,
  type InstalledClaudePlugin
} from '../../shared/claude-plugin-manifest'

const INSTALLED_META_FILENAME = 'installed.json'

// ────────────────────────────────────────
// 路径工具
// ────────────────────────────────────────

export function claudePluginsRootDir(): string {
  return join(homedir(), '.kun', 'plugins')
}

function confinedPath(rootDir: string, ...segments: string[]): string {
  const base = resolve(rootDir)
  const target = resolve(base, ...segments)
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`Plugin path escapes root: ${segments.join('/')}`)
  }
  return target
}

function pluginInstallDir(pluginId: string): string {
  return join(claudePluginsRootDir(), pluginId)
}

// ────────────────────────────────────────
// 文件复制 白名单
// ────────────────────────────────────────

const ALLOWED_COMMAND_EXTENSIONS = new Set(['.md'])
const ALLOWED_SKILL_EXTENSIONS = new Set(['.md', '.json', '.png', '.webp', '.jpg', '.jpeg', '.gif', '.html', '.css', '.js', '.py', '.sh', '.txt', '.toml', '.yaml', '.yml'])
const ALLOWED_HOOK_EXTENSIONS = new Set(['.js', '.sh', '.py'])
const ALLOWED_ASSET_EXTENSIONS = new Set([
  '.shp', '.shx', '.dbf', '.prj', '.cpg', '.sbn', '.sbx', '.xml',  // GIS 矢量文件
  '.tiff', '.tif', '.geojson', '.gpkg',                               // 栅格/矢量格式
  '.png', '.webp', '.jpg', '.jpeg', '.gif', '.svg', '.bmp',          // 图片
  '.json', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.env',         // 配置文件
  '.py', '.sh', '.bat', '.ps1', '.js', '.ts',                        // 脚本
  '.md', '.txt', '.rst', '.csv', '.tsv',                             // 文档/数据
  '.zip', '.gz', '.tar', '.7z',                                       // 压缩包(示例数据)
  '.html', '.css', '.jsx', '.tsx',                                    // 前端
  '.dll', '.so', '.dylib',                                            // 本地库
])
const ALLOWED_MCP_FILES = new Set(['mcp.json'])
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', '__pycache__', '.DS_Store'])

function isAllowedExtension(filename: string, allowed: Set<string>): boolean {
  const ext = extname(filename).toLowerCase()
  return allowed.has(ext)
}

// ────────────────────────────────────────
// 安装结果类型
// ────────────────────────────────────────

export type PluginInstallResult =
  | { ok: true; plugin: InstalledClaudePlugin }
  | { ok: false; errors: string[] }

export type PluginUninstallResult =
  | { ok: true }
  | { ok: false; error: string }

// ────────────────────────────────────────
// 扫描与验证
// ────────────────────────────────────────

/**
 * 扫描源目录，统计可安装的文件。
 * 不做复制，只做计数和验证，用于安装前的预览。
 */
/**
 * 查找 plugin.json 的路径。
 * 先找 `.claude-plugin/plugin.json` (Claude Code 官方路径),
 * 再找 `plugin.json` (Kun 兼容路径)。
 */
async function resolveManifestPath(sourceRoot: string): Promise<string> {
  const officialPath = join(sourceRoot, CLAUDE_PLUGIN_DIRNAME, CLAUDE_PLUGIN_MANIFEST_FILENAME)
  try {
    await stat(officialPath)
    return officialPath
  } catch { /* 官方路径不存在 */ }
  return join(sourceRoot, CLAUDE_PLUGIN_MANIFEST_FILENAME)
}

export async function scanPluginSource(sourceRoot: string): Promise<{
  manifest: ClaudePluginManifestV1
  commandCount: number
  skillCount: number
  hookCount: number
  hasMcpConfig: boolean
}> {
  const manifestPath = await resolveManifestPath(sourceRoot)
  let rawManifest: string
  try {
    rawManifest = await readFile(manifestPath, 'utf8')
  } catch {
    throw new Error(`插件目录缺少 ${CLAUDE_PLUGIN_MANIFEST_FILENAME} (尝试了 .claude-plugin/plugin.json 和 plugin.json)`)
  }

  if (Buffer.byteLength(rawManifest, 'utf8') > CLAUDE_PLUGIN_LIMITS.manifestBytes) {
    throw new Error(`${CLAUDE_PLUGIN_MANIFEST_FILENAME} 超过体积上限 ${CLAUDE_PLUGIN_LIMITS.manifestBytes} 字节`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(rawManifest)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`无法解析 ${CLAUDE_PLUGIN_MANIFEST_FILENAME}: ${message}`)
  }

  const validation = normalizeClaudePluginManifest(parsed)
  if (!validation.ok) {
    throw new Error(`插件清单无效:\n${validation.errors.map((e) => `  - ${e}`).join('\n')}`)
  }

  const manifest = validation.manifest

  // 扫描命令数量
  let commandCount = 0
  try {
    const commandsDir = join(sourceRoot, 'commands')
    const entries = await readdir(commandsDir, { withFileTypes: true })
    commandCount = entries.filter((e) => e.isFile() && isAllowedExtension(e.name, ALLOWED_COMMAND_EXTENSIONS)).length
  } catch { /* commands/ 目录不存在是允许的 */ }

  // 扫描技能数量
  let skillCount = 0
  try {
    const skillsDir = join(sourceRoot, 'skills')
    const entries = await readdir(skillsDir, { withFileTypes: true })
    skillCount = entries.filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name)).length
  } catch { /* skills/ 目录不存在是允许的 */ }

  // 扫描 hooks 数量
  let hookCount = manifest.hooks?.length ?? 0
  if (hookCount === 0) {
    try {
      const hooksDir = join(sourceRoot, 'hooks')
      const entries = await readdir(hooksDir, { withFileTypes: true })
      hookCount = entries.filter((e) => e.isFile()).length
    } catch { /* hooks/ 目录不存在是允许的 */ }
  }

  // 检查 mcp.json
  let hasMcpConfig = false
  try {
    await stat(join(sourceRoot, 'mcp.json'))
    hasMcpConfig = true
  } catch { /* 没有 mcp.json 也是允许的 */ }

  return { manifest, commandCount, skillCount, hookCount, hasMcpConfig }
}

// ────────────────────────────────────────
// 复制辅助
// ────────────────────────────────────────

async function copyDirContents(
  srcDir: string,
  destDir: string,
  allowedExtensions: Set<string>,
  _maxFileBytes?: number
): Promise<number> {
  let copied = 0
  await mkdir(destDir, { recursive: true })

  async function walk(currentSrc: string, currentDest: string): Promise<void> {
    let entries
    try {
      entries = await readdir(currentSrc, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue

      const srcPath = join(currentSrc, entry.name)
      const destPath = join(currentDest, entry.name)

      if (entry.isDirectory()) {
        await mkdir(destPath, { recursive: true })
        await walk(srcPath, destPath)
      } else if (entry.isFile() && isAllowedExtension(entry.name, allowedExtensions)) {
        // 只复制，不执行
        await copyFile(srcPath, destPath, 0)
        copied++
      }
    }
  }

  await walk(srcDir, destDir)
  return copied
}

async function safeCopyFile(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true })
  await copyFile(src, dest, 0)
}

// ────────────────────────────────────────
// 安装
// ────────────────────────────────────────

export async function installPlugin(sourceRoot: string): Promise<PluginInstallResult> {
  const errors: string[] = []

  let scan: Awaited<ReturnType<typeof scanPluginSource>>
  try {
    scan = await scanPluginSource(sourceRoot)
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] }
  }

  const { manifest, commandCount, skillCount, hasMcpConfig } = scan
  const installRoot = pluginInstallDir(manifest.id)

  try {
    // 如果已安装，先清理旧文件
    try {
      await rm(installRoot, { recursive: true, force: true })
    } catch { /* 首次安装,目录不存在 */ }

    await mkdir(installRoot, { recursive: true })

    // 1. 保存 plugin.json 副本 (自动查找 .claude-plugin/plugin.json 或 plugin.json)
    const manifestSrc = await resolveManifestPath(sourceRoot)
    await safeCopyFile(manifestSrc, join(installRoot, CLAUDE_PLUGIN_MANIFEST_FILENAME))

    // 2. 复制 commands/
    let actualCommandCount = 0
    try {
      const commandsSrc = join(sourceRoot, 'commands')
      const commandsDest = join(installRoot, 'commands')
      actualCommandCount = await copyDirContents(commandsSrc, commandsDest, ALLOWED_COMMAND_EXTENSIONS)
    } catch { /* commands/ 目录不存在 */ }

    // 3. 复制 skills/
    let actualSkillCount = 0
    try {
      const skillsSrc = join(sourceRoot, 'skills')
      const skillsDest = join(installRoot, 'skills')
      actualSkillCount = await copyDirContents(skillsSrc, skillsDest, ALLOWED_SKILL_EXTENSIONS)
    } catch { /* skills/ 目录不存在 */ }

    // 4. 复制 hooks/
    let actualHookCount = 0
    try {
      const hooksSrc = join(sourceRoot, 'hooks')
      const hooksDest = join(installRoot, 'hooks')
      actualHookCount = await copyDirContents(hooksSrc, hooksDest, ALLOWED_HOOK_EXTENSIONS)
    } catch { /* hooks/ 目录不存在 */ }

    // 5. 复制 assets/ (Claude Code 官方插件支持)
    try {
      const assetsSrc = join(sourceRoot, 'assets')
      const assetsDest = join(installRoot, 'assets')
      await copyDirContents(assetsSrc, assetsDest, ALLOWED_ASSET_EXTENSIONS)
    } catch { /* assets/ 目录不存在 */ }

    // 6. 复制 scripts/ (社区约定)
    try {
      const scriptsSrc = join(sourceRoot, 'scripts')
      const scriptsDest = join(installRoot, 'scripts')
      await copyDirContents(scriptsSrc, scriptsDest, ALLOWED_ASSET_EXTENSIONS)
    } catch { /* scripts/ 目录不存在 */ }

    // 7. 复制 agents/ (Claude Code 官方插件支持)
    try {
      const agentsSrc = join(sourceRoot, 'agents')
      const agentsDest = join(installRoot, 'agents')
      await copyDirContents(agentsSrc, agentsDest, ALLOWED_SKILL_EXTENSIONS)
    } catch { /* agents/ 目录不存在 */ }

    // 8. 如果源 manifest 在 .claude-plugin/ 下，保持 Claude Code 官方目录结构
    if (basename(dirname(manifestSrc)) === CLAUDE_PLUGIN_DIRNAME) {
      await safeCopyFile(manifestSrc, join(installRoot, CLAUDE_PLUGIN_DIRNAME, CLAUDE_PLUGIN_MANIFEST_FILENAME))
    }

    // 9. 复制 mcp.json
    let actualMcpMerged = false
    if (hasMcpConfig) {
      try {
        const mcpJsonSrc = join(sourceRoot, 'mcp.json')
        const raw = await readFile(mcpJsonSrc, 'utf8')
        const parsed = JSON.parse(raw)
        await mergeMcpConfig(parsed, manifest.id)
        actualMcpMerged = true
      } catch {
        errors.push('mcp.json 无效,已跳过 MCP 配置合并')
      }
    }

    // 10. 如果 hooks 在 manifest 中声明了,也写入 config.json
    if (manifest.hooks && manifest.hooks.length > 0) {
      try {
        await mergeHookConfig(manifest.hooks, installRoot, manifest.id)
      } catch {
        errors.push('Hook 配置合并失败')
      }
    }

    // 11. 将插件的 skills 目录注册为全局 skill root
    //    这样 Agent 在对话中就能自动发现和使用这些 skills
    if (actualSkillCount > 0) {
      try {
        await registerPluginSkillRoot(installRoot, manifest.id)
      } catch {
        errors.push('Skill 注册失败')
      }
    }

    const plugin: InstalledClaudePlugin = {
      manifest,
      installRoot,
      sourceRoot: resolve(sourceRoot),
      installedAt: new Date().toISOString(),
      workspaceScoped: false,
      commandCount: actualCommandCount,
      skillCount: actualSkillCount
    }

    // 8. 保存安装元数据到 installed.json, 供后续更新/卸载使用
    try {
      await writeInstalledMeta(installRoot, {
        sourceRoot: plugin.sourceRoot,
        marketplaceName: plugin.marketplaceName,
        installedAt: plugin.installedAt
      })
    } catch { /* 不影响安装 */ }

    if (errors.length > 0) {
      return { ok: false, errors }
    }
    return { ok: true, plugin }
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] }
  }
}

// ────────────────────────────────────────
// 注册插件的 skills 目录为全局 skill root
// ────────────────────────────────────────

/**
 * 将插件安装目录下的 skills/ 子目录注册到 Kun 的全局 skill roots 中。
 * Kun 的 SkillRuntime 在启动时会扫描 globalRoots 中所有目录下的 skill 包。
 */
async function registerPluginSkillRoot(installRoot: string, pluginId: string): Promise<void> {
  const skillsDir = join(installRoot, 'skills')
  try {
    await stat(skillsDir)
  } catch {
    return // skills 目录不存在,跳过
  }

  const configPath = join(homedir(), '.kun', 'data', 'config.json')
  let existing: Record<string, unknown> = {}
  try {
    const raw = await readFile(configPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (isJsonRecord(parsed)) existing = parsed
  } catch { /* 文件不存在 */ }

  // 获取或创建 capabilities.skills.globalRoots
  const capabilities = (isJsonRecord(existing.capabilities) ? existing.capabilities : {}) as Record<string, unknown>
  const skills = (isJsonRecord(capabilities.skills) ? capabilities.skills : {}) as Record<string, unknown>
  const globalRoots: string[] = Array.isArray(skills.globalRoots) ? skills.globalRoots as string[] : []
  const enabled = skills.enabled !== false

  if (!globalRoots.includes(skillsDir)) {
    globalRoots.push(skillsDir)
  }

  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(
    configPath,
    JSON.stringify(
      {
        ...existing,
        capabilities: {
          ...capabilities,
          skills: {
            ...skills,
            enabled,
            globalRoots
          }
        }
      },
      null,
      2
    ) + '\n',
    'utf8'
  )
}

// ────────────────────────────────────────
// 卸载
// ────────────────────────────────────────

export async function uninstallPlugin(pluginId: string): Promise<PluginUninstallResult> {
  const installRoot = pluginInstallDir(pluginId)

  try {
    // 从 skill roots 中移除
    const configPath = join(homedir(), '.kun', 'data', 'config.json')
    try {
      const raw = await readFile(configPath, 'utf8')
      const parsed = JSON.parse(raw)
      if (isJsonRecord(parsed)) {
        const capabilities = isJsonRecord(parsed.capabilities) ? parsed.capabilities as Record<string, unknown> : {}
        const skills = isJsonRecord(capabilities.skills) ? capabilities.skills as Record<string, unknown> : {}
        const globalRoots: string[] = Array.isArray(skills.globalRoots) ? skills.globalRoots as string[] : []
        const skillsDir = join(installRoot, 'skills')
        const updated = globalRoots.filter((root) => root !== skillsDir)
        if (updated.length !== globalRoots.length) {
          await writeFile(configPath,
            JSON.stringify({
              ...parsed,
              capabilities: { ...capabilities, skills: { ...skills, globalRoots: updated } }
            }, null, 2) + '\n',
            'utf8'
          )
        }
      }
    } catch { /* */ }

    // 从 mcp.json 中移除（清理 plugin:<id>:* 开头的条目）
    try {
      const mcpPath = join(homedir(), '.kun', 'mcp.json')
      const raw = await readFile(mcpPath, 'utf8')
      const parsed = JSON.parse(raw)
      if (isJsonRecord(parsed) && isJsonRecord(parsed.servers)) {
        const servers = parsed.servers as Record<string, unknown>
        const prefix = `plugin:${pluginId}:`
        const cleaned: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(servers)) {
          if (!key.startsWith(prefix)) cleaned[key] = value
        }
        await writeFile(mcpPath, JSON.stringify({ ...parsed, servers: cleaned }, null, 2) + '\n', 'utf8')
      }
    } catch { /* */ }

    await rm(installRoot, { recursive: true, force: true })
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

// ────────────────────────────────────────
// 安装元数据 (installed.json)
// ────────────────────────────────────────

type InstalledMeta = {
  sourceRoot: string
  marketplaceName?: string
  installedAt: string
}

async function readInstalledMeta(installRoot: string): Promise<InstalledMeta | null> {
  try {
    const raw = await readFile(join(installRoot, INSTALLED_META_FILENAME), 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed.sourceRoot === 'string' && parsed.sourceRoot.trim()) {
      return {
        sourceRoot: parsed.sourceRoot,
        marketplaceName: typeof parsed.marketplaceName === 'string' ? parsed.marketplaceName : undefined,
        installedAt: typeof parsed.installedAt === 'string' ? parsed.installedAt : ''
      }
    }
    return null
  } catch {
    return null
  }
}

async function writeInstalledMeta(installRoot: string, meta: InstalledMeta): Promise<void> {
  await writeFile(join(installRoot, INSTALLED_META_FILENAME), JSON.stringify(meta, null, 2), 'utf8')
}

// ────────────────────────────────────────
// 列出已安装插件
// ────────────────────────────────────────

/**
 * IPC 友好的已安装插件摘要。Electron IPC 只能序列化纯 JSON 对象,
 * 不能传 `InstalledClaudePlugin` (带有嵌套类型)。
 */
export type SerializablePluginEntry = {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  homepage?: string
  license?: string
  sourceRoot?: string
  marketplaceName?: string
  commandCount: number
  skillCount: number
}

export async function listInstalledPlugins(): Promise<SerializablePluginEntry[]> {
  const plugins: SerializablePluginEntry[] = []
  const root = claudePluginsRootDir()

  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    try {
      const manifestPath = join(root, entry.name, CLAUDE_PLUGIN_MANIFEST_FILENAME)
      const raw = await readFile(manifestPath, 'utf8')
      const parsed = JSON.parse(raw)
      const validation = normalizeClaudePluginManifest(parsed)
      if (!validation.ok) continue

      const installRoot = join(root, entry.name)
      const m = validation.manifest

      // 读取安装元数据
      const meta = await readInstalledMeta(installRoot)

      let commandCount = 0
      try {
        const cmdDir = join(installRoot, 'commands')
        commandCount = (await readdir(cmdDir, { withFileTypes: true }))
          .filter((e) => e.isFile() && isAllowedExtension(e.name, ALLOWED_COMMAND_EXTENSIONS)).length
      } catch { /* */ }

      let skillCount = 0
      try {
        const skillsDir = join(installRoot, 'skills')
        skillCount = (await readdir(skillsDir, { withFileTypes: true }))
          .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name)).length
      } catch { /* */ }

      // 兼容旧安装: 没有 installed.json 时从 homepage 推断来源
      let sourceRoot = meta?.sourceRoot
      if (!sourceRoot && m.homepage) {
        if (m.homepage.includes('gitee.com') || m.homepage.includes('github.com')) {
          sourceRoot = m.homepage
        }
      }

      plugins.push({
        id: m.id,
        name: m.name,
        version: m.version,
        description: m.description,
        author: m.author,
        homepage: m.homepage,
        license: m.license,
        sourceRoot,
        marketplaceName: meta?.marketplaceName,
        commandCount,
        skillCount
      })
    } catch { /* 跳过无效的插件目录 */ }
  }

  return plugins
}

// ────────────────────────────────────────
// 内置已知插件目录 (Kun 官方兼容列表)
// ────────────────────────────────────────

export type MarketplacePluginEntry = {
  name: string
  version: string
  description?: string
  author?: string
  license?: string
  homepage?: string
  repository?: string
  /** npm 安装名 或 Git 仓库 URL (如 https://gitee.com/user/repo) */
  installName: string
  /** 安装方式: 'npm' (默认) 或 'git' */
  installKind?: 'npm' | 'git'
}

/**
 * Kun 内置已知的 Claude Code 兼容插件/市场列表。
 * 以真实可用的 Git 仓库为主, npm 搜索结果为辅。
 * 不包含不存在的 @anthropic-ai/claude-code-plugin-* 包。
 */
const CURATED_PLUGINS: Array<{
  name: string
  installName: string
  installKind: 'npm' | 'git'
  description: string
  author?: string
  homepage?: string
}> = [
  {
    name: 'GIS 遥感数据处理工具集',
    installName: 'https://gitee.com/yzy0430/gis-agent-toolkit',
    installKind: 'git',
    description: '国产遥感数据处理技能集: 影像分市归档、SHP 合并提取字段、缩略图附件等。基于 GDAL/geopandas 开源栈',
    author: 'yzy'
  },
  {
    name: 'Context7 (Library Docs)',
    installName: '@upstash/context7-mcp',
    installKind: 'npm',
    description: '为 AI 编码助手提供最新第三方库文档上下文',
    author: 'Upstash',
    homepage: 'https://github.com/upstash/context7'
  },
  {
    name: 'Playwright MCP',
    installName: '@playwright/mcp',
    installKind: 'npm',
    description: '浏览器自动化测试, 页面截图和交互',
    author: 'Microsoft',
    homepage: 'https://github.com/microsoft/playwright-mcp'
  },
  {
    name: 'GitHub MCP Server',
    installName: '@modelcontextprotocol/server-github',
    installKind: 'npm',
    description: '仓库管理, PR, Issue, 代码审查等 GitHub 操作',
    author: 'ModelContextProtocol'
  },
  {
    name: 'Brave Search MCP',
    installName: '@modelcontextprotocol/server-brave-search',
    installKind: 'npm',
    description: '通过 Brave Search API 进行 Web 搜索',
    author: 'ModelContextProtocol'
  },
  {
    name: 'Sequential Thinking MCP',
    installName: '@modelcontextprotocol/server-sequential-thinking',
    installKind: 'npm',
    description: '结构化推理与逐步思考',
    author: 'ModelContextProtocol'
  },
  {
    name: 'Memory MCP',
    installName: '@modelcontextprotocol/server-memory',
    installKind: 'npm',
    description: '知识图谱记忆系统',
    author: 'ModelContextProtocol'
  }
]

/**
 * 获取插件市场列表: 内置已知插件 + 从 npm registry 动态搜索的插件。
 * 内置列表确保用户始终有可浏览的内容,
 * npm 动态结果补充新发布的插件。
 */
export async function fetchMarketplacePlugins(): Promise<MarketplacePluginEntry[]> {
  const entries: MarketplacePluginEntry[] = []

  // 先添加内置已知插件
  for (const curated of CURATED_PLUGINS) {
    entries.push({
      name: curated.name,
      version: '',
      description: curated.description,
      author: curated.author,
      homepage: curated.homepage,
      installName: curated.installName,
      installKind: curated.installKind,
      license: undefined,
      repository: undefined
    })
  }

  // 读取用户自定义 marketplace (可选)
  try {
    const customPath = join(homedir(), '.kun', 'plugin-marketplace.json')
    const raw = await readFile(customPath, 'utf8')
    const custom = JSON.parse(raw)
    if (Array.isArray(custom)) {
      const seen = new Set(entries.map((e) => e.installName))
      for (const item of custom) {
        if (typeof item !== 'object' || !item || typeof item.installName !== 'string' || !item.installName.trim()) continue
        if (seen.has(item.installName)) continue
        seen.add(item.installName)
        entries.push({
          name: typeof item.name === 'string' ? item.name : item.installName,
          version: typeof item.version === 'string' ? item.version : '',
          description: typeof item.description === 'string' ? item.description : undefined,
          author: typeof item.author === 'string' ? item.author : undefined,
          license: undefined,
          homepage: typeof item.homepage === 'string' ? item.homepage : undefined,
          repository: typeof item.repository === 'string' ? item.repository : undefined,
          installName: item.installName
        })
      }
    }
  } catch { /* 用户未配置,跳过 */ }

  // 补充 npm registry 动态搜索结果(合并去重)
  try {
    const keyword = 'claude-code-plugin'
    const url = `https://registry.npmmirror.com/-/v1/search?text=keywords:${keyword}&size=30`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10_000)

    const response = await fetch(url, { signal: controller.signal })
    clearTimeout(timer)

    if (response.ok) {
      const body = await response.json() as { objects?: Array<{
        package: { name: string; version: string; description?: string; links?: { homepage?: string; repository?: string }; publisher?: { username?: string }; license?: string }
      }> }
      const seenNames = new Set(entries.map((e) => e.installName))
      for (const obj of body.objects ?? []) {
        const pkg = obj.package
        if (seenNames.has(pkg.name)) continue
        seenNames.add(pkg.name)
        entries.push({
          name: pkg.name,
          version: pkg.version,
          description: pkg.description,
          author: pkg.publisher?.username,
          license: pkg.license,
          homepage: pkg.links?.homepage,
          repository: pkg.links?.repository,
          installName: pkg.name
        })
      }
    }
  } catch {
    console.warn('[claude-plugin] npm marketplace fetch failed, using curated + custom list')
  }

  return entries
}

/**
 * 从 npm 远程安装插件到 ~/.kun/plugins/<name>/。
 * 使用 `npm pack` + 解压 方式获取插件 tarball。
 */
export async function installPluginFromNpm(installName: string): Promise<PluginInstallResult> {
  const pluginRoot = join(homedir(), '.kun', 'plugins', '.tmp', `npm-${Date.now()}`)
  const tmpDir = join(homedir(), '.kun', 'plugins', '.tmp')

  try {
    await mkdir(tmpDir, { recursive: true })

    // Step 1: fetch tarball URL from registry
    const registryUrl = getNpmRegistry()
    const manifestUrl = `${registryUrl}/${installName}/latest`
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 30_000)

    const manifestResp = await fetch(manifestUrl, { signal: ctrl.signal })
    if (!manifestResp.ok) {
      return { ok: false, errors: [`无法获取 ${installName}: HTTP ${manifestResp.status}`] }
    }
    const manifestData = await manifestResp.json() as { version?: string; dist?: { tarball?: string } }
    const tarballUrl = manifestData.dist?.tarball
    if (!tarballUrl) {
      return { ok: false, errors: [`${installName} 没有可下载的安装包`] }
    }

    // Step 2: download tarball
    const tarballResp = await fetch(tarballUrl, { signal: ctrl.signal })
    if (!tarballResp.ok) {
      return { ok: false, errors: [`下载 ${installName} 失败: HTTP ${tarballResp.status}`] }
    }
    const tarballBuffer = Buffer.from(await tarballResp.arrayBuffer())
    clearTimeout(t)

    // Step 3: extract (simple .tar.gz or .tgz)
    await mkdir(pluginRoot, { recursive: true })
    const tarPath = join(tmpDir, `${installName}.tgz`)
    await writeFile(tarPath, tarballBuffer)
    await untar(tarPath, pluginRoot)

    // Step 4: scan the extracted dir for plugin.json
    const scanned = await findPluginInDir(pluginRoot)
    if (!scanned) {
      return { ok: false, errors: [`${installName} 下载成功但找不到 plugin.json -- 可能不是有效的 Claude Code 插件`] }
    }

    // Step 5: install from the scanned dir
    const result = await installPlugin(scanned)
    if (result.ok) {
      const sourceUrl = `npm:${installName}`
      result.plugin.sourceRoot = sourceUrl
      // 覆盖 installed.json 中的临时路径为正确的源 URL
      try {
        await writeInstalledMeta(result.plugin.installRoot, {
          sourceRoot: sourceUrl,
          installedAt: result.plugin.installedAt
        })
      } catch { /* */ }
    }

    // cleanup
    try { await rm(pluginRoot, { recursive: true, force: true }) } catch { /* */ }
    try { await rm(tarPath, { force: true }) } catch { /* */ }

    return result
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] }
  } finally {
    try { await rm(pluginRoot, { recursive: true, force: true }) } catch { /* */ }
  }
}

/**
 * 从 Git 仓库 (GitHub / Gitee / GitLab) 安装 Claude Code 兼容插件。
 *
 * 支持三种模式:
 *   1. Marketplace 模式 (仓库根有 .claude-plugin/marketplace.json):
 *      读取 marketplace.json → 找到 plugins[].source → 安装子目录中的真正插件
 *      如果没有指定 subPath，安装 marketplace 中的第一个插件
 *   2. 单插件模式 (子目录/.claude-plugin/plugin.json):
 *      Claude Code 官方结构，直接安装
 *   3. 兼容模式 (仓库根有 commands/skills 等原生结构):
 *      自动生成 plugin.json 后安装
 *
 * 支持的地址格式:
 *   - https://gitee.com/user/repo
 *   - https://github.com/user/repo/tree/main/plugins/my-plugin
 *   - github:user/repo[/subpath]
 *   - gitee:user/repo[/subpath]
 */
export async function installPluginFromGitHub(repoUrl: string): Promise<PluginInstallResult> {
  const parsed = parseRepoUrl(repoUrl)
  if (!parsed) {
    return { ok: false, errors: ['无效的 Git 仓库地址。支持 GitHub / Gitee / GitLab，格式: https://host/user/repo 或 host:user/repo'] }
  }

  const { host, owner, repo, subPath } = parsed
  const isGithub = host === 'github.com'

  const archiveUrl = isGithub
    ? `https://codeload.github.com/${owner}/${repo}/zip/refs/heads/HEAD`
    : `https://${host}/${owner}/${repo}/repository/archive/main.zip`

  const tmpDir = join(homedir(), '.kun', 'plugins', '.tmp')
  const downloadId = `${host.replace(/\./g, '-')}-${owner}-${repo}-${Date.now()}`
  const extractDir = join(tmpDir, downloadId)

  try {
    await mkdir(tmpDir, { recursive: true })

    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 60_000)

    let response = await fetch(archiveUrl, { signal: ctrl.signal })
    if (!response.ok && !isGithub) {
      const fallbackUrl = `https://${host}/${owner}/${repo}/repository/archive/master.zip`
      response = await fetch(fallbackUrl, { signal: ctrl.signal })
    }
    if (!response.ok) {
      return { ok: false, errors: [`无法下载 ${host}/${owner}/${repo}: HTTP ${response.status}`] }
    }
    const zipBuffer = Buffer.from(await response.arrayBuffer())
    clearTimeout(t)

    await mkdir(extractDir, { recursive: true })
    await unzip(zipBuffer, extractDir)

    // Git archive 解压后通常是 `<repo>-<branch>/` 目录
    let scanDir = extractDir
    const entries = await readdir(extractDir, { withFileTypes: true })
    if (entries.length === 1 && entries[0]!.isDirectory()) {
      scanDir = join(extractDir, entries[0]!.name)
    }
    if (subPath) {
      scanDir = join(scanDir, ...subPath.split('/').filter(Boolean))
    }

    // ── 模式1: 尝试 marketplace.json ──────────────────────
    const marketplacePluginDir = await findPluginViaMarketplace(scanDir)
    if (marketplacePluginDir) {
      const result = await installPlugin(marketplacePluginDir)
      if (result.ok) {
        const sourceUrl = `https://${host}/${owner}/${repo}${subPath ? `/${subPath}` : ''}`
        result.plugin.sourceRoot = sourceUrl
        // 从 marketplace.json 获取 market 名称
        try {
          const marketJson = JSON.parse(await readFile(join(scanDir, CLAUDE_PLUGIN_DIRNAME, 'marketplace.json'), 'utf8'))
          if (typeof marketJson.name === 'string') {
            result.plugin.marketplaceName = marketJson.name
          }
        } catch { /* */ }
        try {
          await writeInstalledMeta(result.plugin.installRoot, {
            sourceRoot: sourceUrl,
            marketplaceName: result.plugin.marketplaceName,
            installedAt: result.plugin.installedAt
          })
        } catch { /* */ }
      }
      try { await rm(extractDir, { recursive: true, force: true }) } catch { /* */ }
      return result
    }

    // ── 模式2/3: 普通插件 (直接找 plugin.json 或原生结构) ──
    const pluginRoot = await findPluginInDir(scanDir)
    if (!pluginRoot) {
      return {
        ok: false,
        errors: [`${host}/${owner}/${repo} 下载成功但未找到可安装的插件。请确认仓库包含 .claude-plugin/plugin.json、plugin.json、或 commands/skills 等 Claude Code 原生结构`]
      }
    }

    const result = await installPlugin(pluginRoot)
    if (result.ok) {
      const sourceUrl = `https://${host}/${owner}/${repo}${subPath ? `/${subPath}` : ''}`
      result.plugin.sourceRoot = sourceUrl
      try {
        await writeInstalledMeta(result.plugin.installRoot, {
          sourceRoot: sourceUrl,
          installedAt: result.plugin.installedAt
        })
      } catch { /* */ }
    }

    try { await rm(extractDir, { recursive: true, force: true }) } catch { /* */ }
    return result
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] }
  } finally {
    try { await rm(extractDir, { recursive: true, force: true }) } catch { /* */ }
  }
}

/**
 * 读取 marketplace.json，找到并返回真正的插件目录。
 * marketplace.json 格式: { plugins: [{ name, source: "./plugins/xxx" }] }
 */
async function findPluginViaMarketplace(scanDir: string): Promise<string | null> {
  // 查找 marketplace.json
  let marketPath = join(scanDir, CLAUDE_PLUGIN_DIRNAME, 'marketplace.json')
  try {
    await stat(marketPath)
  } catch {
    // 也尝试根目录下的 marketplace.json (非标准但有容错性)
    marketPath = join(scanDir, 'marketplace.json')
    try {
      await stat(marketPath)
    } catch {
      return null // 没有 marketplace，不是 marketplace 仓库
    }
  }

  let marketJson: unknown
  try {
    marketJson = JSON.parse(await readFile(marketPath, 'utf8'))
  } catch {
    return null
  }
  if (!isJsonRecord(marketJson)) return null

  const plugins = Array.isArray(marketJson.plugins) ? marketJson.plugins : []
  if (plugins.length === 0) return null

  // 取第一个插件的 source 路径
  const firstPlugin = plugins[0]
  if (!isJsonRecord(firstPlugin)) return null
  const source = typeof firstPlugin.source === 'string' ? firstPlugin.source : null
  if (!source) return null

  // source 是相对路径 (如 "./plugins/gis-toolkit"), 基于 marketplace.json 所在目录
  const marketDir = dirname(marketPath)
  const pluginDir = resolve(marketDir, source)

  // 检查该目录是否存在且包含 .claude-plugin/plugin.json 或 plugin.json
  try {
    await stat(pluginDir)
  } catch {
    return null
  }
  // 查找清单
  try {
    await stat(join(pluginDir, CLAUDE_PLUGIN_DIRNAME, CLAUDE_PLUGIN_MANIFEST_FILENAME))
    return pluginDir
  } catch { /* */ }
  try {
    await stat(join(pluginDir, CLAUDE_PLUGIN_MANIFEST_FILENAME))
    return pluginDir
  } catch { /* */ }
  // 如果插件目录包含 skills/commands/hooks，也接受
  try {
    if (await hasNativeClaudeCodeLayout(pluginDir)) {
      await generatePluginManifest(pluginDir)
      return pluginDir
    }
  } catch { /* */ }

  return null
}

// ────────────────────────────────────────
// 压缩/解压 工具
// ────────────────────────────────────────

import { createWriteStream } from 'node:fs'
import { createGunzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'

async function untar(tarPath: string, destDir: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('tar', ['-xzf', tarPath, '-C', destDir], {
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 30_000
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('close', (code) => {
      if (code === 0) { resolvePromise() }
      else { reject(new Error(`tar extract failed (${code}): ${stderr.trim()}`)) }
    })
    child.on('error', reject)
  })
}

async function unzip(zipBuffer: Buffer, destDir: string): Promise<void> {
  const zipPath = join(tmpdir(), `kun-plugin-${Date.now()}.zip`)
  await writeFile(zipPath, zipBuffer)
  return new Promise((resolvePromise, reject) => {
    // Windows 用 PowerShell Expand-Archive, Unix 用 unzip
    const cmd = process.platform === 'win32'
      ? spawn('powershell', ['-Command', `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 30_000 })
      : spawn('unzip', ['-q', '-o', zipPath, '-d', destDir], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 30_000 })
    let stderr = ''
    cmd.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    cmd.on('close', (code) => {
      try { rm(zipPath, { force: true }).catch(() => {}) } catch { /* */ }
      if (code === 0) { resolvePromise() }
      else { reject(new Error(`unzip failed (${code}): ${stderr.trim()}`)) }
    })
    cmd.on('error', (err) => {
      try { rm(zipPath, { force: true }).catch(() => {}) } catch { /* */ }
      reject(err)
    })
  })
}

/**
 * 扫描目录，查找或自动生成插件清单。
 *
 * 优先级:
 * 1. .claude-plugin/plugin.json  (Claude Code 官方路径)
 * 2. plugin.json                  (Kun / 社区路径)
 * 3. plugins/ 子目录中的插件
 * 4. 当前目录包含 commands/skills/hooks (Claude Code 原生格式,自动生成)
 * 5. package.json 标记为 claude-code-plugin
 *
 * 注意: 如果当前目录包含 marketplace.json, 不会当作单插件处理
 * (该情况由 findPluginViaMarketplace 负责)
 */
async function findPluginInDir(dirPath: string): Promise<string | null> {
  // 先检查不是 marketplace-only 仓库 (有 marketplace.json 但没有自己就是插件)
  const isMarketplace = await isMarketplaceDir(dirPath)
  // 如果当前目录是 marketplace 仓库, 先搜索 plugins/ 子目录
  if (isMarketplace) {
    try {
      const pluginsDir = join(dirPath, 'plugins')
      const entries = await readdir(pluginsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue
        const subPluginRoot = await findPluginInSubDir(join(pluginsDir, entry.name))
        if (subPluginRoot) return subPluginRoot
      }
    } catch { /* */ }
    // 如果 plugins/ 下没找到, 不把 marketplace 仓库根当作插件
    return null
  }

  return findPluginInSubDir(dirPath)
}

/**
 * 在单个子目录中查找插件(不递归到 plugins 子目录)
 */
async function findPluginInSubDir(dirPath: string): Promise<string | null> {
  // 1. .claude-plugin/plugin.json (Claude Code 官方路径)
  try {
    await stat(join(dirPath, CLAUDE_PLUGIN_DIRNAME, CLAUDE_PLUGIN_MANIFEST_FILENAME))
    return dirPath
  } catch { /* */ }

  // 2. plugin.json
  try {
    await stat(join(dirPath, CLAUDE_PLUGIN_MANIFEST_FILENAME))
    return dirPath
  } catch { /* */ }

  // 3. 递归搜索一层 (非点开头、非 plugins 子目录)
  try {
    const entries = await readdir(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'plugins') continue
      const subPath = join(dirPath, entry.name)
      try {
        await stat(join(subPath, CLAUDE_PLUGIN_DIRNAME, CLAUDE_PLUGIN_MANIFEST_FILENAME))
        return subPath
      } catch { /* */ }
      try {
        await stat(join(subPath, CLAUDE_PLUGIN_MANIFEST_FILENAME))
        return subPath
      } catch { /* */ }
    }
  } catch { /* */ }

  // 4. 检测 Claude Code 原生格式 (但排除只有 README/INSTALL 等的目录)
  try {
    if (await hasNativeClaudeCodeLayout(dirPath)) {
      await generatePluginManifest(dirPath)
      return dirPath
    }
  } catch { /* */ }

  // 5. 检测 package.json 并尝试推断
  try {
    const pkgPath = join(dirPath, 'package.json')
    const pkgRaw = await readFile(pkgPath, 'utf8')
    const pkg = JSON.parse(pkgRaw)
    const keywords = Array.isArray(pkg.keywords) ? pkg.keywords : []
    const isClaudePlugin = keywords.includes('claude-code-plugin') || keywords.includes('claude-code')
    if (isClaudePlugin) {
      await generatePluginManifest(dirPath)
      return dirPath
    }
  } catch { /* */ }

  return null
}

/**
 * 检查目录是否是一个 marketplace（有 marketplace.json 和 plugins/ 子目录）。
 */
async function isMarketplaceDir(dirPath: string): Promise<boolean> {
  try {
    await stat(join(dirPath, CLAUDE_PLUGIN_DIRNAME, 'marketplace.json'))
    return true
  } catch { /* */ }
  try {
    await stat(join(dirPath, 'marketplace.json'))
    return true
  } catch { /* */ }
  return false
}

/**
 * 检测仓库是否包含 Claude Code 原生目录结构。
 */
async function hasNativeClaudeCodeLayout(dirPath: string): Promise<boolean> {
  // 只有 commands/skills/hooks 目录才算真正的 Claude Code 插件结构
  // .claude/ 和 .codex/ 太泛（可以是 marketplace 仓库的项目配置），需要配合其他目录判断
  let hasSkillOrCommand = false
  const primaryChecks: Array<{ relative: string; isDir: boolean }> = [
    { relative: 'commands', isDir: true },
    { relative: 'skills', isDir: true },
    { relative: 'hooks', isDir: true },
    { relative: 'agents', isDir: true },
  ]
  for (const check of primaryChecks) {
    try {
      const info = await stat(join(dirPath, check.relative))
      if (check.isDir ? info.isDirectory() : info.isFile()) {
        hasSkillOrCommand = true
        break
      }
    } catch { /* */ }
  }

  // 有 commands/skills/hooks/agents 目录 → 确认是插件
  if (hasSkillOrCommand) return true

  // 检查 mcp.json（插件级）
  try {
    const info = await stat(join(dirPath, 'mcp.json'))
    if (info.isFile()) return true
  } catch { /* */ }

  // .mcp.json 也是
  try {
    const info = await stat(join(dirPath, '.mcp.json'))
    if (info.isFile()) return true
  } catch { /* */ }

  return false
}

/**
 * 为没有 plugin.json 但包含 Claude Code 原生目录的仓库自动生成 manifest。
 * 以目录名作为插件 id 和名称。
 */
async function generatePluginManifest(dirPath: string): Promise<void> {
  const dirName = basename(dirPath)

  // 尝试从 README 获取描述
  let description = ''
  try {
    for (const readme of ['README.md', 'readme.md', 'README.zh-CN.md', 'README.md']) {
      try {
        const content = await readFile(join(dirPath, readme), 'utf8')
        const titleMatch = /^#\s+(.+)/m.exec(content)
        if (titleMatch) { description = titleMatch[1].trim().replace(/^\[/, '').replace(/\]$/, '') }
        break
      } catch { /* */ }
    }
  } catch { /* */ }

  // 尝试从 package.json 获取元数据
  let name = dirName
  let version = '0.0.0'
  let author: string | undefined
  try {
    const pkgRaw = await readFile(join(dirPath, 'package.json'), 'utf8')
    const pkg = JSON.parse(pkgRaw)
    name = typeof pkg.name === 'string' ? pkg.name : dirName
    version = typeof pkg.version === 'string' ? pkg.version : '0.0.0'
    author = typeof pkg.author === 'string' ? pkg.author : (pkg.author && typeof pkg.author === 'object' && 'name' in pkg.author ? String(pkg.author.name) : undefined)
    if (!description && typeof pkg.description === 'string') description = pkg.description
  } catch { /* */ }

  // 统计命令和技能数量
  let descSuffix = ''
  let cmdCount = 0
  try {
    cmdCount = (await readdir(join(dirPath, 'commands'), { withFileTypes: true })).filter((e) => e.isFile() && e.name.endsWith('.md')).length
  } catch { /* */ }
  let skillCount = 0
  try {
    skillCount = (await readdir(join(dirPath, 'skills'), { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.')).length
  } catch { /* */ }
  const parts: string[] = []
  if (cmdCount > 0) parts.push(`${cmdCount} commands`)
  if (skillCount > 0) parts.push(`${skillCount} skills`)
  if (parts.length > 0) descSuffix = ` (${parts.join(', ')})`
  if (!description) description = `Claude Code plugin${descSuffix}`

  const manifest: ClaudePluginManifestV1 = {
    id: slug(name),
    name,
    version,
    ...(author ? { author } : {}),
    description: description + descSuffix
  }

  const manifestPath = join(dirPath, CLAUDE_PLUGIN_MANIFEST_FILENAME)
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
}

/**
 * 给字符串做 slug 处理，用于生成插件 id。
 */
function slug(value: string): string {
  return value
    .trim()
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '') || 'plugin'
}

function getNpmRegistry(): string {
  // 优先使用 npmmirror (国内镜像)，可通过环境变量覆盖
  return process.env.NPM_CONFIG_REGISTRY || process.env.KUN_NPM_MIRROR || 'https://registry.npmmirror.com'
}

/**
 * 支持 GitHub / Gitee / 其他常见的 Git 托管平台。
 *
 * 格式:
 *   github:user/repo[/path]   (简写)
 *   https://gitee.com/user/repo[/tree/branch/path]  (完整 URL)
 *   https://github.com/user/repo.git  (.git 后缀自动去除)
 *
 * 返回 { host, owner, repo, branch, subPath }，null 表示无法解析。
 */
type ParsedRepo = {
  host: string       // e.g. 'gitee.com', 'github.com'
  owner: string
  repo: string
  branch: string     // 默认 'HEAD' (archive API 会导出默认分支)
  subPath: string    // 仓库内的子路径，可为空
}

function parseRepoUrl(raw: string): ParsedRepo | null {
  const trimmed = raw.trim()

  // 简写: github:user/repo, gitee:user/repo
  const prefix = trimmed.match(/^(github|gitee):(.+)$/)
  if (prefix) {
    const host = prefix[1] === 'gitee' ? 'gitee.com' : 'github.com'
    const parts = prefix[2].split('/')
    if (parts.length >= 2) {
      return { host, owner: parts[0]!, repo: parts[1]!.replace(/\.git$/, ''), branch: 'HEAD', subPath: parts.slice(2).join('/') }
    }
  }

  // 完整 URL: https://host/owner/repo[/tree/branch/subpath...]
  try {
    const url = new URL(trimmed)
    const host = url.hostname
    // 支持的 Git 托管平台
    const supportedHosts = ['github.com', 'gitee.com', 'gitlab.com']
    if (!supportedHosts.includes(host)) return null

    const pathParts = url.pathname.split('/').filter(Boolean)
    if (pathParts.length < 2) return null
    const owner = pathParts[0]!
    let repo = pathParts[1]!.replace(/\.git$/, '')
    let branch = 'HEAD'
    let subPath = ''

    if (pathParts.length > 2) {
      // 检测 /tree/<branch>/<subpath> 或 /-/tree/<branch>/<subpath> (GitLab)
      let idx = 2
      if (pathParts[2] === '-' || pathParts[2] === 'raw') idx = 3
      if (pathParts[idx] === 'tree') {
        branch = pathParts[idx + 1] ?? 'HEAD'
        subPath = pathParts.slice(idx + 2).join('/')
      } else {
        // 没有 tree 前缀，剩余部分都算 subPath
        subPath = pathParts.slice(2).join('/')
      }
    }

    return { host, owner, repo, branch, subPath }
  } catch { /* */ }

  return null
}

// 保留旧函数名以向后兼容 (被 installPluginFromGitHub 内部调用)
function parseGitHubUrl(raw: string): { owner: string; repo: string; subPath: string } | null {
  const parsed = parseRepoUrl(raw)
  if (!parsed) return null
  return { owner: parsed.owner, repo: parsed.repo, subPath: parsed.subPath }
}

// ────────────────────────────────────────
// MCP 配置合并
// ────────────────────────────────────────

async function mergeMcpConfig(fragment: unknown, pluginId: string): Promise<void> {
  if (!isJsonRecord(fragment)) return

  const mcpPath = join(homedir(), '.kun', 'mcp.json')
  let existing: Record<string, unknown> = {}

  try {
    const raw = await readFile(mcpPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (isJsonRecord(parsed)) existing = parsed
  } catch { /* 文件不存在或无效,从空白开始 */ }

  const existingServers = isJsonRecord(existing.servers) ? existing.servers : {}
  const fragmentServers = isJsonRecord((fragment as Record<string, unknown>).servers)
    ? (fragment as Record<string, unknown>).servers as Record<string, unknown>
    : {}

  // 在插件提供的每个 server id 前加上插件 id 前缀以避免冲突
  const namespacedServers: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fragmentServers)) {
    namespacedServers[`plugin:${pluginId}:${key}`] = value
  }

  await mkdir(dirname(mcpPath), { recursive: true })
  await writeFile(
    mcpPath,
    JSON.stringify(
      {
        ...existing,
        servers: { ...existingServers, ...namespacedServers }
      },
      null,
      2
    ) + '\n',
    'utf8'
  )
}

// ────────────────────────────────────────
// Hook 配置合并
// ────────────────────────────────────────

async function mergeHookConfig(
  hooks: Array<{ phase: string; command: string; matcher?: string; timeoutMs?: number }>,
  installRoot: string,
  pluginId: string
): Promise<void> {
  const configPath = join(homedir(), '.kun', 'data', 'config.json')
  let existing: Record<string, unknown> = {}

  try {
    const raw = await readFile(configPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (isJsonRecord(parsed)) existing = parsed
  } catch { /* 文件不存在 */ }

  // 将相对路径转为绝对路径
  const resolvedHooks = hooks.map((hook) => ({
    phase: hook.phase,
    command: resolve(installRoot, hook.command),
    ...(hook.matcher ? { matcher: hook.matcher } : {}),
    ...(hook.timeoutMs ? { timeoutMs: hook.timeoutMs } : {}),
    // 标记来源,便于卸载时识别
    _pluginId: pluginId
  }))

  const existingHooks = Array.isArray(existing.hooks) ? existing.hooks : []

  await mkdir(dirname(configPath), { recursive: true })
  await writeFile(
    configPath,
    JSON.stringify(
      { ...existing, hooks: [...existingHooks, ...resolvedHooks] },
      null,
      2
    ) + '\n',
    'utf8'
  )
}

// ────────────────────────────────────────
// 辅助
// ────────────────────────────────────────

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// 导出 copyFile 用于测试
import { copyFile } from 'node:fs/promises'
