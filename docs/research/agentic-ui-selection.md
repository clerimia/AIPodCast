# Agentic 组件库选型可行性调研：Vercel AI Elements vs @ant-design/agentic-ui

> 调研时间：2026-08-29（全部来源均为当日查询）。
> 方法说明：research 技能约定的「派发后台代理」在本执行环境不可用，故由本线程直接完成；全部关键结论以官方文档、npm registry、GitHub API 当日抓取为准，未采信二手评测。
> 服务对象：M6「前端打磨」（无新功能收尾期）是否引入 agentic 组件库的决策。
> 本项目基准栈（`web/package.json`，2026-08-29 实测）：Vite ^8.2.2 + React ^19.2.8 + TS ~6.0.2 (strict) + Tailwind ^4.3.3（CSS-first，`@tailwindcss/vite`）+ shadcn CLI ^4.19.0（组件在 `src/components/ui`，radix-ui ^1.6.7 统一包 + sonner + lucide-react）+ TanStack Query ^5.102.8 + Zustand ^5.0.15 + next-themes ^0.4.6。

---

## 0. 概念澄清：`ai` 包 ≠ AI Elements

两者是同一生态里的**两层东西，分属两个仓库、两类分发方式**：

| | `ai`（AI SDK 数据层） | `ai-elements`（AI Elements 组件层） |
| --- | --- | --- |
| 仓库 | github.com/vercel/ai（26,483 stars，1,680 open issues，pushed 2026-08-29） | github.com/vercel/ai-elements（2,377 stars，273 forks，90 open issues，创建 2025-08-15，pushed 2026-08-21） |
| npm | `ai@7.0.84`（Apache-2.0，peer zod ^3.25.76 ‖ ^4.1.8，周下载 23,598,333）；客户端 hooks 在 `@ai-sdk/react@4.0.87`（peer react ^18 ‖ ~19.0.1 ‖ ~19.1.2 ‖ ^19.2.1，**本项目的 ^19.2.8 满足 ^19.2.1**） | `ai-elements@1.9.0`（Apache-2.0，**它只是 CLI**，`bin: { elements: "index.js" }`，周下载 91,893，最近一次 npm 发布 2026-03-12） |
| 职责 | useChat/useCompletion、UIMessage 流协议、ChatTransport、provider 抽象 | **shadcn 风格 registry**：CLI 把组件源码注入你的仓库（默认 `@/components/ai-elements/`），不含运行时包 |
| 自述 | "AI SDK by Vercel - build apps like ChatGPT, Claude, Gemini..." | "a component library and custom registry built on top of shadcn/ui" |

来源：[npm ai](https://registry.npmjs.org/ai/latest)、[npm @ai-sdk/react](https://registry.npmjs.org/@ai-sdk/react/latest)、[npm ai-elements](https://registry.npmjs.org/ai-elements/latest)、[npm downloads](https://api.npmjs.org/downloads/point/last-week/ai)、[GitHub vercel/ai](https://api.github.com/repos/vercel/ai)、[GitHub vercel/ai-elements](https://api.github.com/repos/vercel/ai-elements)、[AI Elements Overview](https://elements.ai-sdk.dev/overview)。查询日期均为 2026-08-29。

安装方式（两法等价，摘自官方 Setup 页）：

```bash
npx ai-elements@latest add message
# 或
npx shadcn@latest add @ai-elements/message
```

（来源：[AI Elements Setup](https://elements.ai-sdk.dev/docs/setup)）

---

## 1. 候选 1 事实档案：AI Elements

### 1.1 版本、发布状态与许可证

- 组件本体**没有版本化 npm 包**——组件以源码进仓库，版本事实上是「registry 快照 + CLI 版本」。CLI（`ai-elements`）latest 1.9.0，发布于 2026-03-12；此前 1.8.x 系列 2026-01～02 月连续发布（npm time 字段实测）。（来源：[npm ai-elements 完整元数据](https://registry.npmjs.org/ai-elements)）
- GitHub 仓库 `vercel/ai-elements` 2026-08-21 仍有提交（pushed_at 实测），官方文档页脚 "Copyright Vercel 2026"，维护活跃。（来源：[GitHub API](https://api.github.com/repos/vercel/ai-elements)、[Overview](https://elements.ai-sdk.dev/overview)）
- 许可证：npm 元数据标 **Apache-2.0**；仓库 LICENSE 文件为标准 Apache-2.0 文本（"Copyright 2023 Vercel, Inc."，经 GitHub contents API 原文核验；GitHub API 的 license 字段显示 NOASSERTION 是 monorepo 多 license 的常见表现）。
- 发布状态：官方未标 beta/GA 字样（Overview 与 Setup 页均无）；文档站已进入正式形态（含 skill、troubleshooting、contribution 章节），可视为 **GA 可用但组件 API 仍在演进**（从早期 0.x 的 `Response`/`Actions`/`Loader` 独立组件，演进到当前把流式 markdown 收进 `Message` 的子组件 `MessageResponse`，详见 1.2）。

### 1.2 组件清单（48 个，官方导航逐项核验）

Chatbot 类（18）：Attachments、Chain of Thought、Checkpoint、Confirmation、Context、Conversation、Inline Citation、Message、Model Selector、Plan、Prompt Input、Queue、Reasoning、Shimmer、Sources、Suggestion、**Task**、Tool。
Code 类（15）：Agent、Artifact、Code Block、Commit、Environment Variables、File Tree、JSX Preview、Package Info、Sandbox、Schema Display、Snippet、Stack Trace、Terminal、Test Results、Web Preview。
Voice 类（6）：Audio Player、Mic Selector、Persona、Speech Input、Transcription、Voice Selector。
Workflow 类（7）：Canvas、Connection、Controls、Edge、Node、Panel、Toolbar。
Utilities（2）：Image、Open In Chat。

（来源：[elements.ai-sdk.dev Overview 导航](https://elements.ai-sdk.dev/overview) 与 `/components/*` 路由逐项存在性核验，2026-08-29）

与本任务书相关的两点修正/澄清：

1. **没有独立的 `Response` 组件了**。流式 markdown 渲染现在是 `Message` 的子组件 **`MessageResponse`**，底层是 Vercel 的 **streamdown** 渲染器；官方 Setup 页示例即 `Message > MessageContent > MessageResponse`。（来源：[Setup](https://elements.ai-sdk.dev/docs/setup)、[Message 组件页](https://elements.ai-sdk.dev/components/message)）
2. Message 组件页明确要求在 `globals.css` 加 `@source "../node_modules/streamdown/dist/*.js";`——这是 **Tailwind v4 CSS-first 的 `@source` 指令**，与本项目 Tailwind 4.3 用法同构。（来源：[Message 组件页](https://elements.ai-sdk.dev/components/message)）

### 1.3 关键可行性：能否脱离 useChat、纯 props 驱动？——**能，且有官方一手证据**

- **官方 Setup 页的"Verify Installation"示例本身就不含 useChat**：`<Message from="assistant"><MessageContent><MessageResponse>Hello, world!</MessageResponse></MessageContent></Message>` 纯静态渲染。（来源：[Setup](https://elements.ai-sdk.dev/docs/setup)）
- **Task 组件**：`TaskTrigger` 只要求 `title` 字符串，`defaultOpen` + 透传 Radix Collapsible props；官方示例虽然用 `experimental_useObject` 取数，但渲染层只是把对象字段映射成 props（`<TaskTrigger title={task.title || "Loading..."} />`），传静态数据等价。TaskItem 状态为 `pending | in_progress | completed`。（来源：[Task 组件页](https://elements.ai-sdk.dev/components/task)）
- **PromptInput 组件**：自含表单状态，唯一集成点是 `onSubmit: (message: PromptInputMessage, event) => void`；文档特性列表写明 "Form-based submission handling" 与 "Optional provider for lifted state management"（可选的 `PromptInputProvider`，不接也能用）。示例里 `useChat` 只是示例后端接线，换成任意本地 handler 均可。（来源：[PromptInput 组件页](https://elements.ai-sdk.dev/components/prompt-input)）
- Overview 页对三大支柱之一的表述是 "AI SDK integration（Streaming, status states and type safety built-in）"——即 AI SDK 是**可选增强**而非运行时前提；组件对 `ai` 包的引用多为类型导入（如 `ToolUIPart`）。（来源：[Overview](https://elements.ai-sdk.dev/overview)、[Setup 示例](https://elements.ai-sdk.dev/docs/setup)）

结论：把 AI Elements 当**纯展示组件**接我们的 Zustand writer-run store，是官方支持的用法。

### 1.4 若上完整数据层：与自定义 SSE 协议的适配成本

UIMessage 数据流协议事实（[Stream Protocols](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol)）：

- 传输载体就是 **SSE**（"uses Server-Sent Events (SSE) format"），自定义后端需设响应头 `x-vercel-ai-ui-message-stream: v1`；
- 分块词汇表（`data: {...}` 每行一个 JSON）：`start`、`text-start/text-delta/text-end`（按 id 分块 start/delta/end 模式）、`reasoning-start/delta/end`、`source-url`、`source-document`、`file`、`custom`、`data-*`（自定义数据部分）、`tool-*` 系列、`finish`、`error`；
- 文档明确鼓励自写后端："You can use this information to develop custom backends and frontends for your use case, e.g., to provide compatible API endpoints that are implemented in a different language such as Python."（内含 FastAPI 示例）

Transport 机制（[Transport](https://ai-sdk.dev/docs/ai-sdk-ui/transport)）：`useChat({ transport })`；自定义 transport 需实现 `ChatTransport` 接口的 `sendMessages` 与 `reconnectToStream`（接口源码在 vercel/ai 仓库 `packages/ai/src/ui/chat-transport.ts`），`sendMessages` 返回 UIMessage chunk 流；`DefaultChatTransport` 默认对 `/api/chat` 发 HTTP POST。

**对我们协议的逐事件映射（全部可在前端完成，不改 Fastify 后端）**：

| 本项目事件（`web/src/lib/api/types.ts`） | UIMessage chunk |
| --- | --- |
| `delta {delta}` | `text-start` + `text-delta` |
| `message:end {text}` | `text-end` |
| `tool:start {toolCallId, tool}` | `tool-input-start` / `tool-input-available` |
| `tool:end {ok, isError, summary, lineIds}` | `tool-output-available`（或错误变体） |
| `script:changed {lineIds}`、`turn:end`、`run:start` | `data-script-changed` 等 `data-*` 自定义部分 |
| `done` / `error` | `finish` / `error` |

即：写一个把 POST `/writer/messages` 自定义帧翻译成 UIMessage chunk 的 `ChatTransport`（fetch + ReadableStream 的解析逻辑可平移），**不需要改后端发流格式**。真正的成本不在协议翻译，而在**数据层替换**：writer-run store（含 rAF 合帧、abort 接线 `POST /episodes/:id/writer/abort`、脚本行联动）要迁到 useChat 的状态模型并回归测试。

### 1.5 兼容性

官方 Setup 页 Prerequisites 原文（[Setup](https://elements.ai-sdk.dev/docs/setup)）：

> "Node.js 18 or later / React 19 / Next.js 14+ (App Router recommended) / AI SDK installed and configured / shadcn/ui initialized in your project / Tailwind CSS 4"

- **Tailwind CSS 4**：与本项目 4.3.3 直接匹配（见 1.2 的 `@source` 用法）。
- **shadcn/ui**：前提条件之一；组件注入后复用我们已有的 shadcn 主题与原语，"Your existing theme and setup apply automatically"（[Overview](https://elements.ai-sdk.dev/overview)）。本项目 shadcn CLI 4.19.0 + radix-ui 统一包与 shadcn 4.x 产物形态一致。
- **React 19**：`@ai-sdk/react@4.0.87` peer 范围含 `^19.2.1`，我们的 ^19.2.8 满足。
- **Vite**：官方 prerequisites 写的是 "Next.js 14+ (App Router recommended)"，**文档未明确背书 Vite**。但组件是纯源码（React + Tailwind + radix），无 Next 专属 API（示例中的 `"use client"` 在 Vite 里是无害冗余）；shadcn/ui 本身官方支持 Vite。判定：理论可用、需本地 POC 验证（列入未验证清单）。

### 1.6 M6 进度/取消 UI 覆盖度

- **Task** 组件：`TaskItem` 状态 pending/in_progress/completed → 可直接表达「逐行✓ + 当前行转圈（in_progress）」，收起/展开基于 Radix Collapsible。（[Task](https://elements.ai-sdk.dev/components/task)）
- **没有**总进度条组件（无 Progress 类）、**没有**取消/中断组件（Confirmation 是"审批门"，不是取消）；audio seek 行级高亮属音画同步域，两候选都无对应物。
- 判定：M6 进度/取消 UI 的主体（总进度条 + 取消按钮 + 与 `POST /synthesis-jobs` 状态机的联动）仍应自建（shadcn/ui Progress + 现有 `RunStatusBar.tsx` 方向）；Task 只在想要「可折叠逐行清单」观感时有增量。

---

## 2. 候选 2 事实档案：@ant-design/agentic-ui

### 2.1 它是什么；与 Ant DesignX 的关系——**两套并行项目，不是 X 的 2.0**

- **X 的 2.0 是另一回事**：官方公告（[ant-design/x issue #1357，2025-11-21](https://github.com/ant-design/x/issues/1357)）明确 X 2.0 = 底层升级 antd v6 + React 19 + CSS Variables 样式架构，monorepo 拆成三包 `@ant-design/x`、`@ant-design/x-markdown`、`@ant-design/x-sdk`；V1 分支进入半年维护。npm 现状：`@ant-design/x@2.9.0`（MIT，peer **antd ^6.1.1**、react >=18），周下载 100,404，仓库 4,745 stars、pushed 2026-08-10。（来源：[npm @ant-design/x](https://registry.npmjs.org/@ant-design/x/latest)、[npm downloads](https://api.npmjs.org/downloads/point/last-week/@ant-design/x)、[GitHub ant-design/x](https://api.github.com/repos/ant-design/x)）
- **agentic-ui 不是那个 X 2.0**：npm `@ant-design/agentic-ui@2.32.47` 自述"面向智能体的 UI 组件库，提供多步推理可视化、工具调用展示、任务执行协同等 Agentic UI 能力"；GitHub 仓库 `ant-design/agentic-ui` 已 **301 重定向到 `antdigital-ai/agentic-ui`**（GitHub API 实测），224 stars / 35 forks / 10 open issues，pushed 2026-08-12，homepage https://agentic.antdigital.ai （蚂蚁数科 Ant Digital 域名）。官方渠道（README、X 2.0 公告、npm 描述）**均未声明它与 @ant-design/x 的演进/归属关系**——README 通篇未提 X。（来源：[npm @ant-design/agentic-ui](https://registry.npmjs.org/@ant-design/agentic-ui/latest)、[GitHub API repositories/784065050](https://api.github.com/repositories/784065050)、[README](https://github.com/ant-design/agentic-ui)）
- 版本与活跃度：首次发布 2025-10-27，累计 226 个版本，latest 2.32.47 发布于 2026-07-28，另有 `beta: 2.29.10-beta.1` dist-tag——**发版频繁但版本号膨胀快（两周一个 patch）**。（来源：[npm 完整元数据](https://registry.npmjs.org/@ant-design/agentic-ui)）
- 健康度信号：**周下载仅 455**（2026-08-22～28，对比 @ant-design/x 的 100,404、ai-elements 的 91,893、@assistant-ui/react 的 1,718,225）；GitHub 224 stars。（来源：[npm downloads API](https://api.npmjs.org/downloads/point/last-week/@ant-design/agentic-ui)）
- 注意：README 里的在线文档链接 `https://ant-design.github.io/agentic-ui/` 实测 **GitHub Pages 404（"Site not found"）**；官网 agentic.antdigital.ai 为纯客户端渲染 SPA 且有反爬，公开可抓取的文本仅标题。（2026-08-29 实测）

### 2.2 硬依赖：强绑定 antd 5 全家桶，不能独立使用

`@ant-design/agentic-ui@2.32.47` 的 **dependencies**（npm registry 实测，节选）：

- **`antd: ^5.29.3`**（运行时依赖，会自动整包安装 antd 5）、`@ant-design/icons: ^5.6.1`
- `styled-components: ^6.3.8`（组件层 CSS-in-JS）、`framer-motion: ^11.18.2`
- 重型可选渲染栈：`slate: 0.124.0`、`mermaid: ^11.14.0`、`three: ^0.182.0`、`chart.js: ^4.5.1`、`katex: ^0.16.44`、`rxjs: ^7.8.2`、`dompurify: ^3.3.1`、`lodash` 等（约 70 项）
- peerDependencies：`react: >=16.9.0`、`react-dom: >=16.9.0`（名义范围极宽）

README 自述 "**基于 Ant Design 体系**"（[README](https://github.com/ant-design/agentic-ui)）——组件直接构建在 antd 之上，**不存在脱离 antd 的独立用法**。对「Tailwind v4 + shadcn 单设计系统」意味着：

1. **双设计系统并存**：antd 5 自带 Reset/组件基线 + `@ant-design/cssinjs` CSS-in-JS + styled-components，与 Tailwind preflight 的样式互踩是社区反复踩的坑（button 背景透明化等），antd 官方对 v5+Tailwind 没有提供像 v6 那样的一等兼容层（antd v6 才转向 CSS Variables 架构，见 [v5→v6 迁移指南](https://ant.design/docs/react/migration-v6/)）。
2. **主题定制走 antd ConfigProvider token 体系**，与我们的 Tailwind theme/shadcn CSS 变量是两套语义；**暗色模式**需要把 next-themes 的 class 策略桥接到 antd `theme.darkAlgorithm`（antd 不认 `.dark` class），桥接代码自担。
3. **体积**：`three`/`mermaid`/`chart.js`/`katex` 虽大概率是插件化懒加载（README："插件化架构"），但依赖树与 lockfile 侵入实打实；实际 tree-shaking 效果未测（未验证清单）。

### 2.3 React 19 / Vite 兼容性——**antd 5 线是硬伤**

- antd v5 官方支持范围是 **React 16～18**；React 19 必须加官方补丁包 **`@ant-design/v5-patch-for-react-19@1.0.3`** 并在入口 `import '@ant-design/v5-patch-for-react-19'`，否则运行时告警 "antd v5 support React is 16 ~ 18"。（来源：[npm 补丁包](https://www.npmjs.com/package/@ant-design/v5-patch-for-react-19)、[antd 官方 React 19 兼容指南](https://5x.ant.design/docs/react/v5-for-19/)）
- antd **v6 原生支持 React 19**（补丁包在 v6 移除），但 **agentic-ui 钉在 antd ^5.29.3**——即引入它就同时引入「antd 5 + React 19 补丁」组合（本项目 React ^19.2.8）。antd 6.6.2 已发布，agentic-ui 尚未跟进 v6（[npm antd](https://registry.npmjs.org/antd/latest)）。
- Vite：无官方声明（官网为 umi/dva 系技术栈，README 本地开发用 `pnpm start` 起文档站）；组件库理论上与构建器无关，但 React 19.2 + Vite 8 组合下的实际表现无公开实证（未验证清单）。

### 2.4 组件清单与 M6 映射

README「核心智能体组件」表（[README](https://github.com/ant-design/agentic-ui)）：

| 组件 | 描述 | 对本项目的映射 |
| --- | --- | --- |
| `Bubble` | 对话气泡，AI 模式带 `thoughtChain` | 对应 ChatStream 气泡（rAF 合帧需自行保留） |
| `ThoughtChainList` | 独立展示"思考—行动—观察"推理过程 | 对应 tool:start/tool:end 展示 |
| `TaskList` | "任务列表，展示多步骤任务的状态（进行中、完成、等待）" | **两候选中唯一最接近 M6「逐行✓+当前行」的现成物**（但无总进度条与取消） |
| `ToolUseBar` | 工具调用状态栏 | 对应 RunStatusBar 的工具段落 |
| `AgenticLayout` / `Workspace` | 布局框架 / 工作台 | 本项目不需要 |
| `MarkdownEditor` | "支持流式输出、插件扩展的 Markdown 编辑器" | 对应流式 markdown（带编辑能力，超需求） |
| `MarkdownInputField`、`SchemaForm`、`SuggestionList`、`WelcomeMessage`、`History` | 输入/表单/建议/欢迎/历史 | 对应 Composer 等（多数超需求） |

判定：能力覆盖面广，但每一项都以「接收 antd 5 设计系统」为代价；M6 真正缺的（总进度条 + 取消 + audio seek 高亮）它同样没有现成物。

---

## 3. 对照表

| 维度 | AI Elements（展示层用法） | AI SDK 全数据层（useChat） | @ant-design/agentic-ui | 现状自建（shadcn/ui + writer-run store） |
| --- | --- | --- | --- | --- |
| 许可证 | Apache-2.0（LICENSE 原文核验） | Apache-2.0 | MIT | — |
| 版本形态 | 源码注入仓库，无 npm 组件包；CLI 1.9.0 | ai@7.0.84 / @ai-sdk/react@4.0.87 | 2.32.47（npm，226 版） | — |
| 数据层耦合 | **零**（纯 props，官方示例即静态用法） | 深（UIMessage 状态模型替换 Zustand store） | 中（自带 Bubble/TaskList 吃 props，但生态假设 antd + XRequest/useXChat 类数据流） | 零 |
| 样式体系契合（Tailwind v4 + shadcn） | **完全同构**（Tailwind 4 + radix + shadcn registry） | 同左 | **冲突**（antd 5 CSS-in-JS + styled-components 双轨） | 完全契合 |
| React 19.2 + Vite 8 | peer 满足；Vite 无官方背书，需 POC | peer 满足（^19.2.1） | 需 `@ant-design/v5-patch-for-react-19`；Vite 无实证 | 已在跑 |
| 暗色模式 | 复用 shadcn/next-themes 变量，自动生效 | 同左 | 需桥接 antd darkAlgorithm ↔ next-themes | 已接 |
| 流式 markdown | `MessageResponse`（streamdown）现成 | 同左 | `MarkdownEditor`（重） | 无（当前气泡按纯文本/简单渲染） |
| 工具调用/思考展示 | Tool / Chain of Thought / Reasoning / Task | 同左 | ThoughtChainList / ToolUseBar | 自建 |
| 任务进度+取消（M6） | Task 只覆盖逐行状态；**无总进度条/取消** | 无 | TaskList 有状态清单；**无总进度条/取消** | 自建是唯一完整路径 |
| 依赖侵入 | 注入的组件源码 + streamdown 等 CLI 自动装 | + ai / @ai-sdk/react | **antd 5 全家 + ~70 个直接依赖** | 零 |
| 健康度 | GitHub 活跃（pushed 08-21）；CLI npm 节奏慢 | ai 周下载 23.6M，vercel/ai 26.5k stars | 周下载 455、224 stars、组织已迁 antdigital-ai | — |
| M6 迁移成本 | 低（按组件渐进引入，可只 add 1-2 个） | 中高（store→useChat 重写 + 回归） | 高（设计系统接管 + 主题/暗色桥接 + React19 补丁） | 零 |

---

## 4. 针对本项目的适配成本分析（贴栈程度排序）

1. **现状自建（基线，成本 0）**。M6 四项交付物（进度/取消 UI、rAF 合帧、audio seek 行级高亮、toast/重试）没有任何现成组件能整体覆盖；`RunStatusBar.tsx` + shadcn/ui（Progress/Tooltip/Sonner）继续是主路径。自定义 SSE 帧解析（`useWriterRun.ts`）已工作，无替换动机。
2. **AI Elements 仅展示层（低成本，可选）**。`npx ai-elements@latest add <name>` 按个引入，源码落仓库、复用现有主题；与 Zustand store 之间只需写一层 props 映射（`writer-run` 的 tool 状态 → `Tool`/`Task` props；delta → `MessageResponse` 子流）。若 M6 打磨中确实需要「像样的流式 markdown」，最小方案是单点引入 `message` 组件（连带 streamdown，`@source` 一行 CSS）。**不装 `ai` 包数据层**。
3. **AI SDK 全数据层（中高成本，M6 明确不做）**。技术上可行且不动后端：自写 `ChatTransport.sendMessages` 把我们的 SSE 帧翻译成 UIMessage chunk（映射表见 1.4）。但收益仅是换一套状态管理语义，代价是重写 writer-run store、rAF 合帧与 abort 接线并全量回归——在「无新功能收尾期」纯负收益。留作未来若接多模型/多会话时的选项。
4. **@ant-design/agentic-ui（最高成本，不建议）**。为一个组件清单引入 antd 5 整包 + React 19 官方补丁 + styled-components，换取与现有 Tailwind/shadcn 设计系统并行的第二套 token 体系，外加暗色模式桥接与 455/周的低采用度；X 2.0（antd 6 线）虽解 React 19 问题但同样要求接管设计系统。对单用户本地应用，收益结构性为负。

---

## 5. 初步倾向

- **M6 不引入任何 agentic 数据层框架**；进度/取消 UI 自建（该需求两候选均无现成物，自建反而最贴 `synthesis_jobs` 状态机）。
- 「两个都不如不加」对 M6 交付物而言**基本成立**：总进度条、逐行✓（可折叠增强版）、取消、audio seek 高亮、toast/重试，全部走自建。
- **唯一值得考虑的单点引入**：AI Elements 的流式 markdown（`message` 组件 / 底层 streamdown）——若打磨阶段确认气泡需要 GFM/代码块渲染；不引入则维持现状。可先 `add message` 做 30 分钟 POC（Vite 兼容性顺带验证）。
- `@ant-design/agentic-ui` 从候选中剔除；`@ant-design/x` 2.x 仅在「未来愿意迁 antd 6」的前提下才有讨论意义。

---

## 6. 未验证 / 存疑清单

1. **AI Elements 在 Vite 8 下的官方支持度**：Setup 页 prerequisites 写 "Next.js 14+ (App Router recommended)"，未提 Vite；组件无 Next 专属 API，理论可用，但需 POC（含 radix-ui 统一包版本对齐、Tailwind v4 `@source` 路径差异）。
2. **AI Elements registry 更新与 CLI 版本错位**：CLI npm 最近发布 2026-03-12（1.9.0），而 GitHub 仓库 2026-08-21 仍活跃、文档已含 48 组件——registry JSON 是否随 main 分支即时更新未验证。
3. **`Response`→`MessageResponse`、`Actions`/`Loader` 去向**：由当前官方导航与示例推断，未找到官方变更说明；早期文章提及的组件名可能已失效。
4. **agentic-ui 与 @ant-design/x 的组织关系**：仓库从 `ant-design` org 301 至 `antdigital-ai` org，双方官方文档均未声明关系；「蚂蚁数科出品」的推断仅基于域名 antdigital.ai 与 homepage，未核实。
5. **agentic-ui 实际 bundle 体积**：`three`/`mermaid`/`chart.js`/`katex` 在 dependencies 中，但插件化懒加载后的真实增量未测。
6. **agentic-ui + React 19.2 + Vite 8 实证**：peer 范围宽（>=16.9），antd 5 补丁可用，但无公开项目在 19.2/Vite 8 组合下使用的实证；其 styled-components 6 与 React 19 的组合未验证。
7. **styled-components / antd 5 与 Tailwind v4 preflight 冲突细节**：社区普遍报告（button 背景等），本次未找到 antd 官方针对 v5+Tailwind v4 的兼容指南，严重度未量化。
8. **AI Elements `Conversation` 自动滚动与 rAF 合帧的兼容**：未读其实现源码，是否与我们的合帧策略冲突未知。
9. **streamdown 在无 @tailwindcss/typography 插件项目的默认渲染质量**：未验证。

---

## 附：第三候选一句话（仅完整性，不展开）

**assistant-ui**（@assistant-ui/react@0.15.17，MIT，11,914 stars，周下载 1,718,225，仓库 assistant-ui/assistant-ui pushed 2026-08-29，peer react ^18‖^19，依赖含 zustand/radix-ui——与本项目栈有亲和性）是比 AI Elements 更「框架化」的完整聊天方案：它自带 Runtime/数据层，收益在整体替换聊天数据流而非单点借组件；对只想借展示层、且已有自定义 SSE store 的本项目，耦合深度高于 AI Elements 路线，本里程碑不列入，未来若重写聊天框架可再评估。（来源：[npm](https://registry.npmjs.org/@assistant-ui/react/latest)、[downloads](https://api.npmjs.org/downloads/point/last-week/@assistant-ui/react)、[GitHub](https://api.github.com/repos/assistant-ui/assistant-ui)）

---

## 主要来源汇总（查询日期均为 2026-08-29）

- AI Elements：[Overview](https://elements.ai-sdk.dev/overview) · [Setup](https://elements.ai-sdk.dev/docs/setup) · [Task](https://elements.ai-sdk.dev/components/task) · [PromptInput](https://elements.ai-sdk.dev/components/prompt-input) · [Message](https://elements.ai-sdk.dev/components/message) · [npm ai-elements](https://registry.npmjs.org/ai-elements/latest) · [GitHub vercel/ai-elements](https://api.github.com/repos/vercel/ai-elements)
- AI SDK：[Stream Protocols](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol) · [Transport](https://ai-sdk.dev/docs/ai-sdk-ui/transport) · [npm ai](https://registry.npmjs.org/ai/latest) · [npm @ai-sdk/react](https://registry.npmjs.org/@ai-sdk/react/latest) · [GitHub vercel/ai](https://api.github.com/repos/vercel/ai)
- Ant 系：[npm @ant-design/agentic-ui](https://registry.npmjs.org/@ant-design/agentic-ui/latest)（及完整元数据）· [GitHub antdigital-ai/agentic-ui](https://github.com/antdigital-ai/agentic-ui)（原 ant-design/agentic-ui 301）· [README](https://github.com/ant-design/agentic-ui) · [npm @ant-design/x](https://registry.npmjs.org/@ant-design/x/latest) · [X 2.0 公告](https://github.com/ant-design/x/issues/1357) · [npm antd](https://registry.npmjs.org/antd/latest) · [antd React 19 指南](https://5x.ant.design/docs/react/v5-for-19/) · [v5 补丁包](https://www.npmjs.com/package/@ant-design/v5-patch-for-react-19) · [v5→v6 迁移](https://ant.design/docs/react/migration-v6/)
- 下载量：[npm downloads API](https://api.npmjs.org/downloads/point/last-week/ai) 各端点（2026-08-22～28 周窗口）
- 第三候选：[npm @assistant-ui/react](https://registry.npmjs.org/@assistant-ui/react/latest) · [GitHub assistant-ui](https://api.github.com/repos/assistant-ui/assistant-ui)
- 本项目事实：`web/package.json`、`web/src/lib/api/types.ts`、`web/src/features/writer-chat/*`、`web/src/stores/writer-run.ts`
