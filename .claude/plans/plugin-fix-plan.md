# 插件系统修复方案（基于 Claude Code 官方 Plugin 协议）

## 参考源：`D:\ClaudeWork\gis-agent-toolkit`

## 三个问题及修复方案

---

### 问题1：安装插件后看不到版本号，无法使用

**根因分析**：
1. 当前 `listInstalledPlugins()` 返回的 `SerializablePluginEntry` 类型没有 `sourceRoot` 字段
2. Kun 的 `plugin.json` 格式（[claude-plugin-manifest.ts](src/shared/claude-plugin-manifest.ts)）与 Claude Code 官方格式不一致：
   - Kun 用了 `id` 字段，Claude Code 官方用 `name` 字段
   - Kun 没有 `displayName`、`keywords`、`skills`/`commands` 路径字段
3. 从 Gitee 安装后，插件目录下缺少 `sourceRoot` 元数据，前端无法展示来源

**修复内容**：

**A. `SerializablePluginEntry` 增加字段** [claude-plugin-manifest.ts](src/shared/claude-plugin-manifest.ts)
```typescript
export type SerializablePluginEntry = {
  // ... 现有字段
  sourceRoot?: string    // 新增: 插件来源
  displayName?: string   // 新增: 展示名称(Claude Code 格式)
}
```

**B. `plugin.json` 格式兼容 Claude Code 官方** [claude-plugin-manifest.ts](src/shared/claude-plugin-manifest.ts)
- `normalizeClaudePluginManifest()` 同时兼容两种格式：
  - Claude Code 格式: `name` → 映射为 `id`，`displayName` → 映射为 `name`
  - Kun 原有格式: `id` + `name` 保持不变
- 新增 `keywords`、`skills`、`commands` 可选字段

**C. 保存 `sourceRoot` 元数据** [claude-plugin-service.ts](src/main/services/claude-plugin-service.ts)
- 安装时：在 `~/.kun/plugins/<id>/installed.json` 中写入 `{ sourceRoot: "https://gitee.com/...", installedAt: "..." }`
- 列出时：读取 `installed.json` 获取 `sourceRoot`

**D. UI 展示优化** [PluginMarketplaceView.tsx](src/renderer/src/components/PluginMarketplaceView.tsx)
- 当 `version === '0.0.0'` 且 `sourceRoot` 为 Gitee/GitHub URL 时，显示来源 URL 而非无意义版本号
- 显示 `displayName` 优先于 `name`

---

### 问题2：更新插件时请求 npm，但用户使用的是 Gitee 链接

**根因分析**：
`updatePluginItem()` ([PluginMarketplaceView.tsx:1307](src/renderer/src/components/PluginMarketplaceView.tsx#L1307-L1323)) 硬编码：
```typescript
const result = await window.kunGui.installClaudePluginFromNpm(plugin.id)
```
将插件 id 当成 npm 包名去安装更新。

**修复内容**：

**A. `updatePluginItem` 根据 `sourceRoot` 分发更新方式** [PluginMarketplaceView.tsx](src/renderer/src/components/PluginMarketplaceView.tsx)
```typescript
const updatePluginItem = async (plugin) => {
  const sourceRoot = plugin.sourceRoot || ''
  if (sourceRoot.startsWith('npm:')) {
    // npm 包 → installClaudePluginFromNpm
    result = await window.kunGui.installClaudePluginFromNpm(sourceRoot.slice(4))
  } else if (sourceRoot.startsWith('https://gitee.com') || sourceRoot.startsWith('https://github.com')) {
    // Gitee/GitHub → installClaudePluginFromGitHub
    result = await window.kunGui.installClaudePluginFromGitHub(sourceRoot)
  } else {
    // 本地路径 → 提示用户重新选择文件夹
    result = await window.kunGui.installClaudePlugin()
  }
}
```

**B. 安装时正确保存 `sourceRoot`** [claude-plugin-service.ts](src/main/services/claude-plugin-service.ts)
- `installPluginFromGitHub()` 已保存 URL 到 `sourceRoot`（第893行），但需要持久化到 `installed.json`
- `installPluginFromNpm()` 已保存 `npm:xxx` 格式
- `installPlugin()`（本地安装）保存绝对路径

---

### 问题3：协议不对，没有遵循 Claude Code Plugin 协议

**根因分析**：
1. **`plugin.json` 格式差异**：
   | 字段 | Kun 当前 | Claude Code 官方 | 兼容策略 |
   |------|----------|------------------|----------|
   | 唯一标识 | `id`（必填） | `name` | 优先 `name`，fallback `id` |
   | 展示名称 | `name`（必填） | `displayName` | 优先 `displayName`，fallback `name` |
   | 技能路径 | 无 | `skills: "./skills/"` | 新增可选字段 |
   | 命令路径 | 无 | `commands: "./commands/"` | 新增可选字段 |
   | 关键字 | 无 | `keywords: [...]` | 新增可选字段 |
   | 作者 | `author`（string） | `author: {name, email?}` | 兼容 string 和 object |

2. **Marketplace 搜索问题**：
   - `CURATED_PLUGINS` 列表中的 `@anthropic-ai/claude-code-plugin-*` 包在 npm 上不存在
   - npm 搜索 keyword `claude-code-plugin` 实际用的人很少
   - 没有支持从 Gitee marketplace 格式（`marketplace.json`）安装

3. **缺少 marketplace 机制**：
   - Claude Code 使用 `/plugin marketplace add <url>` 添加市场
   - 市场是 Git 仓库，根目录有 `.claude-plugin/marketplace.json`
   - 安装用 `/plugin install <plugin>@<marketplace>`
   - Kun 当前没有实现这个流程

**修复内容**：

**A. 兼容 Claude Code 官方 `plugin.json` 格式** [claude-plugin-manifest.ts](src/shared/claude-plugin-manifest.ts)
- `normalizeClaudePluginManifest()` 改为兼容双格式：
  ```typescript
  // 标识符: Claude Code 用 name, Kun 用 id
  const pluginId = (raw.name as string) || (raw.id as string)
  // 展示名: Claude Code 用 displayName, Kun 用 name
  const displayName = (raw.displayName as string) || (raw.name as string) || raw.id
  ```
- 新增 `keywords?: string[]`、`skills?: string`、`commands?: string` 可选字段
- `author` 兼容 `string` 和 `{name: string}` 两种格式

**B. 支持 `marketplace.json` 格式** [claude-plugin-service.ts](src/main/services/claude-plugin-service.ts)
- 新增 `fetchMarketplaceFromGitRepo(url)` 函数
- 从 Git 仓库根目录读取 `.claude-plugin/marketplace.json`
- 解析 `plugins` 数组，获取每个插件的 `source` 路径
- 调用 `installPluginFromGitHub()` 安装子路径

**C. 清理 `CURATED_PLUGINS` 列表** [claude-plugin-service.ts](src/main/services/claude-plugin-service.ts)
- 移除所有不存在的 `@anthropic-ai/claude-code-plugin-*` 条目
- 替换为已有的真实仓库地址（如 `https://gitee.com/yzy0430/gis-agent-toolkit`）
- 保留通过 npm keyword 搜索的 fallback 机制

**D. 支持 marketplace URL 格式** 
- 新增 UI 入口让用户输入 marketplace 仓库 URL
- 安装 marketplace 后展示其中所有可用插件

---

## 涉及修改的文件清单

| # | 文件 | 改动说明 | 预估行数 |
|---|------|---------|---------|
| 1 | [claude-plugin-manifest.ts](src/shared/claude-plugin-manifest.ts) | 兼容 Claude Code 官方 plugin.json 格式；`id`/`name`/`displayName` 映射；新增 `keywords`/`skills`/`commands` 字段；`author` 兼容 object；`SerializablePluginEntry` 增加 `sourceRoot`/`displayName` | ~60行 |
| 2 | [claude-plugin-service.ts](src/main/services/claude-plugin-service.ts) | 安装时持久化 `sourceRoot` 到 `installed.json`；`listInstalledPlugins()` 返回 `sourceRoot`；新增 `fetchMarketplaceFromGitRepo()`；清理 `CURATED_PLUGINS` 列表；新增 `getPluginSourceRoot()` | ~100行 |
| 3 | [register-app-ipc-handlers.ts](src/main/ipc/register-app-ipc-handlers.ts) | `toSerializable()` 增加 `sourceRoot`/`displayName`；新增 `claude-plugin:install:marketplace` IPC handler | ~30行 |
| 4 | [PluginMarketplaceView.tsx](src/renderer/src/components/PluginMarketplaceView.tsx) | `updatePluginItem()` 根据 `sourceRoot` 分发；已安装列表显示来源；增加 marketplace URL 输入入口；版本号为 `0.0.0` 时显示来源信息 | ~60行 |
| 5 | [kun-gui-api.ts](src/shared/kun-gui-api.ts) + [preload/index.ts](src/preload/index.ts) | 新增 `installClaudePluginFromMarketplace` API | ~20行 |

**总计：约 270 行代码改动**
