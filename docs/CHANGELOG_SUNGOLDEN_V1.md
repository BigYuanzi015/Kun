# SunGolden 工作台 v0.1.1 更新说明

> 基于 Kun (DeepSeek GUI) 的深度定制版本

---

## 一、自动更新

**更新源**：`https://app.sun-golden.cn/sungolden-agent/`

- 替换原有的 R2/Kun-agent 更新源为自托管 HTTPS 更新服务器
- 扁平单频道结构（stable），`latest.yml` + 安装包直接放在更新目录根
- `electron-builder.config.cjs` 和 `gui-updater.ts` 均已指向新地址
- 环境变量可覆盖：`R2_PUBLIC_BASE_URL` / `R2_RELEASE_PREFIX`

**操作说明**：
1. `npm run dist:win` 打包后，上传 `dist/latest.yml` + `dist/Kun-{version}-win-x64.exe` 到服务器更新目录
2. 客户端自动检测版本差异，提示更新

---

## 二、Claude Code Plugin 兼容协议改进

**问题背景**：原 Kun 插件系统自行设计了 `plugin.json` 格式，无法直接安装 Claude Code 官方插件市场中的仓库（如 gitee.com/yzy0430/gis-agent-toolkit）。

### 2.1 plugin.json 格式兼容

- `claude-plugin-manifest.ts` 已兼容 Claude Code 官方格式：
  - 标识符：优先 `name` 字段，fallback `id`
  - 展示名：优先 `displayName` 字段，fallback `name`
  - `author` 兼容 `string` 和 `{name, email?}` 两种格式
  - 新增 `keywords` / `skills` / `commands` 字段支持
- 自动查找 `.claude-plugin/plugin.json`（Claude Code 官方路径）或 `plugin.json`（Kun 兼容路径）

### 2.2 Marketplace 安装支持

- 重写 `installPluginFromGitHub`，支持三种模式：
  1. **Marketplace 模式**：仓库根有 `.claude-plugin/marketplace.json` → 自动读取 `plugins[].source` 路径，安装真正的插件子目录
  2. **单插件模式**：子目录含 `.claude-plugin/plugin.json`
  3. **兼容模式**：仓库根有 commands/skills 等原生结构
- 新增 `findPluginViaMarketplace()` 解析 marketplace.json
- 新增 `isMarketplaceDir()` 防止 marketplace 仓库被误判为单插件

### 2.3 文件白名单扩展

- 新增 `ALLOWED_ASSET_EXTENSIONS`：支持 GIS 矢量（.shp/.shx/.dbf/.prj）、栅格（.tiff/.tif）、脚本（.py/.sh/.bat）等格式
- 安装时自动复制 assets/、scripts/、agents/ 目录
- 取消单文件大小限制（原 5MB 限制导致 .shp 等大文件丢失）

### 2.4 插件更新按来源分发

- 安装时保存 `sourceRoot` 到 `installed.json`
- 更新时根据来源分发：
  - `npm:xxx` → 走 npm 更新
  - `https://gitee.com/...` / `https://github.com/...` → 走 Git 仓库更新
  - 本地路径 → 提示用户

### 2.5 插件 Skills 自动发现

- `skill-service.ts` 新增 `discoverKunPluginSkillRoots()`，自动扫描 `~/.kun/plugins/*/skills/`
- 插件安装后 skills 立即可用，无需重启

---

## 三、文件预览能力

### 3.1 Word 文档 (.docx) 预览

- 引入 `mammoth` 库解析 .docx，提取纯文本
- 修改 `workspace-files.ts`（`readWorkspaceFile`），在二进制检测之前特判 .docx
- `workspace-text-preview.ts` 白名单加入 .docx
- 所有路径统一生效：GUI 预览、Write 模式、SDD/计划关联

### 3.2 Excel 文档 (.xlsx/.xls/.xlsm) 预览

- 引入 `xlsx`（SheetJS）库解析 Excel
- 每个工作表转 CSV 格式，`=== 工作表: Sheet1 ===` 分隔
- 同样在二进制检测前特判，白名单加入 .xls/.xlsm/.xlsx

### 3.3 取消文件大小限制

- .docx/.xlsx 解析无文件大小上限

---

## 四、拖拽文件行为优化

**问题**：拖拽 Word/Excel/PDF 文件到对话框会触发浏览器下载行为。

**修复**（`FloatingComposer.tsx`）：
- `dragOver`：有文件就阻止默认事件（不再限于图片/PDF）
- `drop`：有文件立即 preventDefault（防下载）
- 分流逻辑：图片/PDF → 附件上传；其他文件 → 生成 `@路径` 引用

---

## 五、文件上下文优化

### 5.1 上下文上限调小

`workbench-composer-prompts.ts`：
- 单文件上限：60000 字符 → **20000 字符**
- 总计上限：180000 字符 → **60000 字符**

防止多文件注入撑爆模型上下文窗口。

### 5.2 拖拽文件不注入全文

`useWorkbenchComposerSubmitController.ts`：
- 拖拽文件只生成 `@路径` 引用，不自动读取全文
- AI 用 read 工具按需读取，避免 500 错误（请求体过大）

---

## 六、PPT 和 Word 生成

### 6.1 PPTX 生成

- 新增 `pptx-export-service.ts`：纯 TypeScript（pptxgenjs），无 Python 依赖
- 内置 4 套中文模板：
  | 模板 | 配色 | 适用场景 |
  |------|------|---------|
  | `tech`（默认）| 科技蓝 | GIS/遥感/信息化项目 |
  | `gov` | 政务红 | 政府汇报/项目申报 |
  | `warm` | 暖橙色 | 商务演示/企业介绍 |
  | `minimal` | 极简黑白 | 学术答辩/研究报告 |
- 内置 skill `generate-pptx`（自动 seed 到 `~/.kun/skills/`）
- 触发词：生成PPT、做成PPT、create presentation 等
- AI 自动调用 `window.kunGui.exportPptx()`，输出真正 .pptx 文件

### 6.2 Word 文档生成

- 新增 `docx-export-service.ts`：基于 html-to-docx（项目已有依赖）
- 内置 4 套中文模板：
  | 模板 | 适用场景 |
  |------|---------|
  | `report`（默认）| 技术报告/工程报告 |
  | `proposal` | 项目方案/标书 |
  | `minutes` | 会议纪要 |
  | `letter` | 正式信函/通知 |
- 内置 skill `generate-docx`
- 触发词：生成Word、写报告、会议纪要、meeting minutes 等
- AI 自动调用 `window.kunGui.exportDocx()`

---

## 七、模型输出限制

`kun/src/adapters/model/compat-model-client.ts`：
- Anthropic Messages 格式 `max_tokens`：8192 → **16384**
- 缓解 AI 写大文件时输出截断导致的 JSON 残缺问题

---

## 八、首次设置页定制

### 8.1 默认值

| 项目 | 原来 | 现在 |
|------|------|------|
| 默认语言 | 英文 | **简体中文** |
| 默认 Provider | DeepSeek | **LiteLLM** |
| 可选 Provider | 3 个 | **LiteLLM + DeepSeek（2 个）** |
| API Key | DeepSeek 必填 | **均必填** |
| 权限模式 | read-only | **bypass（danger-full-access）** |

### 8.2 办公地点选择

- 新增金丰和 / 生地楼选项
- 选地点自动填充对应 LiteLLM 网关地址：
  - 金丰和：`http://192.168.2.29:40000/`
  - 生地楼：`http://47.92.140.194:40000/`
- 网关地址只读，由地点联动

### 8.3 LiteLLM 配置

- endpointFormat 默认：**messages**（Anthropic 格式）
- API Key 必填，提示「如果没有 key，请联系高翔获取」
- 新增「从 API 拉取可用模型」按钮，调 `GET /v1/models` 列出可用模型

---

## 技术栈变更

| 新增依赖 | 用途 |
|---------|------|
| `mammoth` | .docx 文本提取 |
| `xlsx` (SheetJS) | .xlsx/.xls 表格提取 |
| `pptxgenjs` | PPTX 生成（纯 TS） |

---

## 涉及文件清单

```
修改：
  electron-builder.config.cjs                 # 更新源地址
  kun/src/adapters/model/compat-model-client.ts  # max_tokens 上调
  package.json / package-lock.json             # 新依赖
  src/main/gui-updater.ts                     # 更新源 + 下载页
  src/main/ipc/register-app-ipc-handlers.ts    # pptx/docx IPC handler
  src/main/services/claude-plugin-service.ts   # 插件兼容 + marketplace
  src/main/services/skill-service.ts           # 插件 skills 发现
  src/main/services/workspace-files.ts         # docx/xlsx 预览
  src/main/skill-bundled.ts                    # generate-pptx/docx skill
  src/preload/index.ts                        # exportPptx/exportDocx 暴露
  src/shared/claude-plugin-manifest.ts         # plugin.json 兼容
  src/shared/kun-gui-api.ts                    # 类型声明
  src/shared/model-provider-presets.ts         # LiteLLM→messages
  src/renderer/src/components/InitialSetupDialog.tsx   # 初始设置页定制
  src/renderer/src/components/initial-setup-save.ts    # 保存逻辑
  src/renderer/src/components/initial-setup-save.test.ts # 测试更新
  src/renderer/src/components/chat/FloatingComposer.tsx  # 拖拽修复
  src/renderer/src/components/workbench/useWorkbenchComposerSubmitController.ts # 文件注入
  src/renderer/src/components/workbench/workbench-composer-prompts.ts # 上下文上限
  src/renderer/src/lib/workspace-text-preview.ts  # 预览白名单

新增：
  src/main/mammoth.d.ts                        # mammoth 类型声明
  src/main/services/pptx-export-service.ts     # PPTX 生成
  src/main/services/docx-export-service.ts     # DOCX 生成
  src/asset/skills/generate-pptx/SKILL.md      # PPTX skill
```
