# Kun 深度魔改计划

## 项目总览

Kun 是一个 **Electron + React 桌面 AI 编程工作台**，约 **45,000 行生产 TypeScript 代码**，1696 个源文件。

### 核心架构（三层）

```
┌─────────────────────────────────────────────────┐
│  Renderer (React 19, ~43,000 行)                │
│  src/renderer/src/                               │
│  ├── components/   UI 组件                       │
│  │   ├── chat/     聊天、消息、会话              │
│  │   ├── design/   设计模式 (Design Mode)        │
│  │   ├── write/    写作模式 (Write Mode)         │
│  │   ├── plan/     计划系统                      │
│  │   └── workflow/ Workflow 编排                 │
│  ├── store/        zustand 状态管理              │
│  ├── agent/        Agent 运行时客户端            │
│  └── lib/          工具库                        │
├─────────────────────────────────────────────────┤
│  Main Process (Electron, ~18,000 行)             │
│  src/main/                                       │
│  ├── index.ts      入口 + 窗口管理               │
│  ├── ipc/          IPC 通道 (61个 handler)       │
│  ├── services/     核心业务服务                   │
│  └── runtime/      运行时管理                     │
├─────────────────────────────────────────────────┤
│  Shared (~13,000 行)                             │
│  src/shared/     类型、常量、API 契约             │
├─────────────────────────────────────────────────┤
│  Core Runtime ("kun" 子项目)                     │
│  kun/src/         Agent 引擎、工具、模型适配       │
│  ├── loop/        Agent 主循环                   │
│  ├── adapters/    模型/工具/文件适配器            │
│  ├── delegation/  子 Agent 调度                   │
│  ├── domain/      会话/事件/领域模型              │
│  └── server/      HTTP/SSE 服务端                │
└─────────────────────────────────────────────────┘
```

---

## 魔改路线图（由浅入深）

### 第一层：表面魔改（品牌/UI/体验）

| 序号 | 目标 | 涉及文件 | 难度 |
|------|------|----------|------|
| 1.1 | 改名字、Logo、图标 | `src/asset/img/kun.png`, `src/main/app-icon.ts`, `package.json` 的 `productName` | ⭐ |
| 1.2 | 改启动页、Hero 图 | `src/asset/img/sungolden_hero.png`, `AnimatedWorkLogo.tsx`, `InitialSetupDialog.tsx` | ⭐ |
| 1.3 | 改默认 Provider/模型 | `src/main/upstream-models.ts`, `src/renderer/src/store/chat-store-initial-state.ts` | ⭐ |
| 1.4 | 改界面文案 (i18n) | `src/renderer/src/locales/zh/*.json` + `en/*.json` | ⭐⭐ |
| 1.5 | 改窗口标题、托盘 | `src/main/index.ts`, `src/main/app-identity.ts`, `src/main/tray-session-menu.ts` | ⭐ |

### 第二层：功能魔改（增删改核心能力）

| 序号 | 目标 | 涉及文件 | 难度 |
|------|------|----------|------|
| 2.1 | **增强 Claude Code Plugin 兼容** | `src/main/services/claude-plugin-service.ts` — 这是我们刚改的文件，核心是 marketplace 发现 + 安装逻辑 | ⭐⭐ |
| 2.2 | 自定义 MCP Server 管理 | `src/main/services/` — 新增 MCP 配置导入 / 自动发现 | ⭐⭐⭐ |
| 2.3 | 自定义 Skill 模板 | `src/main/services/skill-service.ts`, `src/skills/skill-runtime.ts` | ⭐⭐⭐ |
| 2.4 | 自定义 Agent 配置 | `src/renderer/src/components/settings-section-agents.tsx`, `src/delegation/` | ⭐⭐⭐ |
| 2.5 | 新增自定义工具 | `src/adapters/tool/` — 继承现有工具协议 | ⭐⭐⭐⭐ |
| 2.6 | **自定义 Agent Loop** | `kun/src/loop/agent-loop.ts` — 修改 Agent 行为策略 | ⭐⭐⭐⭐ |
| 2.7 | 新增模型 Provider | `src/adapters/model/` — 实现 Provider 接口 | ⭐⭐⭐ |

### 第三层：架构魔改（深层重构）

| 序号 | 目标 | 涉及文件 | 难度 |
|------|------|----------|------|
| 3.1 | **替换 kun 运行时** | `kun/` 整个子项目 — 用你自己写的 Python/其他语言运行时替代 | ⭐⭐⭐⭐⭐ |
| 3.2 | 改会话/持久化存储 | `src/adapters/in-memory-session-store.ts`, `src/domain/session.ts` | ⭐⭐⭐⭐ |
| 3.3 | 改审批/权限模型 | `src/domain/approval.ts`, `src/main/services/computer-use-permissions.ts` | ⭐⭐⭐⭐ |
| 3.4 | 支持多窗口 / 多项目 | `src/main/index.ts` — Electron 多窗口管理 | ⭐⭐⭐⭐ |
| 3.5 | 自定义 Design Mode | `src/renderer/src/design/` — 整套设计系统 | ⭐⭐⭐⭐⭐ |

---

## 推荐入门路径

如果你要做 **GIS Agent 专用工作台**，建议按这个顺序：

```
1. 第一层全做（品牌定制）
     ↓
2. 第二层 2.1→2.3→2.5（插件+技能+工具，核心差异化）
     ↓
3. 集成你自己的插件市场（替换内置 marketplace 列表为 Gitee 仓库）
     ↓
4. 第二层 2.6（改 Agent Loop，嵌入 GIS 领域判断）
     ↓
5. 根据需要做第三层
```

### 关键入口文件

| 想看什么 | 从这里开始 |
|----------|-----------|
| Electron 主进程启动 | [src/main/index.ts](src/main/index.ts) |
| 所有 IPC 通信 | [src/main/ipc/register-app-ipc-handlers.ts](src/main/ipc/register-app-ipc-handlers.ts) |
| 前端主工作台 | [src/renderer/src/components/Workbench.tsx](src/renderer/src/components/Workbench.tsx) |
| 全局状态管理 | [src/renderer/src/store/chat-store.ts](src/renderer/src/store/chat-store.ts) |
| Agent 主循环 | [src/loop/agent-loop.ts](src/loop/agent-loop.ts) |
| 工具注册 | [src/adapters/tool/](src/adapters/tool/) |
| Skill 运行时 | [src/skills/skill-runtime.ts](src/skills/skill-runtime.ts) |
| 插件安装服务 | [src/main/services/claude-plugin-service.ts](src/main/services/claude-plugin-service.ts) |
| 模型 Provider | [src/adapters/model/](src/adapters/model/) |
| 共享类型/API | [src/shared/](src/shared/) |

### 构建/调试命令

```bash
npm run dev          # 开发模式（热重载）
npm run build        # 构建
npm run test         # 运行测试
npm run typecheck    # 类型检查
npm run dist:win     # 打包 Windows 安装包
```
