# 插件安装重构方案

## 根因

Claude Code 的插件体系是三层结构：**Marketplace → Plugin**

```
仓库根 (Marketplace)
├── .claude-plugin/marketplace.json   ← 市场清单，列出插件
├── plugins/
│   └── gis-toolkit/                  ← 真正的插件
│       ├── .claude-plugin/plugin.json
│       ├── skills/**, commands/**, assets/**
```

当前 Kun 的 `installPluginFromGitHub` 下载仓库 zip 后：
1. 解压到临时目录
2. `findPluginInDir` 在仓库**根目录**找到 `.claude/CLAUDE.md`，匹配 `hasNativeClaudeCodeLayout`
3. 把**仓库根**误判为插件，生成假的 `plugin.json`
4. `installPlugin` 把假的 plugin.json 复制到 `~/.kun/plugins/`，**skills/commands/assets 全丢了**

正确做法是：**先读 marketplace.json → 找到对应的插件 source 路径 → 安装那个子目录**。

## 修复方案

### 修改 `installPluginFromGitHub` (`claude-plugin-service.ts`)

重写逻辑：

1. 下载解压 zip（保持）
2. 在解压根目录查找 `.claude-plugin/marketplace.json`
3. **如果找到 marketplace.json**：
   - 解析得到 `plugins[]` 数组
   - 如果只有一个插件，直接安装该 `source` 路径对应的子目录
   - 如果多个插件，返回列表让用户选择（UI 层处理）
4. **如果没有 marketplace.json**（普通单插件仓库）：
   - 走现有 `findPluginInDir` 逻辑
   - 但**排除** `.claude-plugin/marketplace.json` 的情况（只有 marketplace 的仓库不是插件）
   - 优先查找 `.claude-plugin/plugin.json`（Claude Code 官方路径）

### 修改 `findPluginInDir` (`claude-plugin-service.ts`)

- 新增 `.claude-plugin/plugin.json` 的查找（Claude Code 官方插件路径）
- `hasNativeClaudeCodeLayout` 如果发现当前目录有 marketplace.json 且有 plugins 子目录，返回 false（这不是一个插件，是一个 marketplace）
- 查找子目录时，也查找 `plugins/` 下符合 Claude Code 结构的子目录

### 修改 `installPlugin` (`claude-plugin-service.ts`)

- 安装插件时，除了 skills/commands/hooks/mcp.json，也要复制：
  - `assets/` 目录（Claude Code 官方支持）
  - `agents/` 目录（Claude Code 官方支持）
  - `scripts/` 目录（社区约定）
- 白名单扩展：`ALLOWED_SKILL_EXTENSIONS` 加入 `.py`、`.sh`、`.bat` 等脚本后缀

### UI 改动 (`PluginMarketplaceView.tsx`)

- marketplace 支持多插件市场：安装市场 URL 后，展示市场内所有可用插件列表
- 用户可选择安装某个具体插件

### 目录结构对比（修复后）

**修复前**：
```
~/.kun/plugins/gis-agent-toolkit-master/
├── plugin.json          # 假的，仓库根自动生成的
├── installed.json
                          # ← 没有 skills！没有 assets！
```

**修复后**：
```
~/.kun/plugins/gis-toolkit/
├── .claude-plugin/
│   └── plugin.json
├── skills/              # ← 真正的 skills
│   ├── imagery-archive-by-city/
│   ├── imagery-clip-by-city/
│   ├── imagery-mosaic/
│   ├── raster-reproject/
│   └── band-stack/
├── commands/            # ← 如果存在
├── assets/              # ← 附带资源
│   ├── city_hlj_boundaries/
│   ├── env/
│   └── rules/
├── scripts/             # ← 公共脚本
└── installed.json       # sourceRoot: https://gitee.com/...
```

## 涉及文件

| 文件 | 改动量 |
|------|--------|
| `claude-plugin-service.ts` | ~100行（重写 marketplace 发现逻辑 + 扩展白名单） |
| `PluginMarketplaceView.tsx` | ~30行（市场内插件选择 UI） |
