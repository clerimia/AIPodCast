# PI SDK 最小可嵌入配方（进程内嵌入，无原生工具）

> 调研日期：2026-08-28
> 目标运行时：TypeScript / Node（Node v22.23.1）
> 用途：作为「写稿大师」agent 的运行时，进程内嵌入 `@earendil-works/pi-coding-agent`，不保留任何 PI 原生工具，只注册三个自定义工具 `read` / `add` / `edit`。

## 引用约定

下文所有「文件 + 行号」出处，除特别注明外，均相对于包根：

```
<pkg> = E:\develop\npm-global\node_modules\@earendil-works\pi-coding-agent  （版本 0.84.3）
```

嵌套依赖的出处写完整路径，例如 `<pkg>/node_modules/@earendil-works/pi-ai/dist/types.d.ts`。

核对结论均来自实际读取的源码 / 类型声明 / 官方文档。凡未能从源码或文档确证的字段，文中明确标注「未确证」，未编造。

---

## 0. 结论摘要（TL;DR）

| 问题 | 结论 |
|---|---|
| 关原生工具的确切字段 | `noTools: "builtin"` + `customTools: [...]`。**不是** `tools: []`。`noTools: "all"` 会把自定义工具一起清空（见 §1） |
| 自定义工具参数 schema | **TypeBox** schema（`TSchema`），不是 JSON Schema（见 §2） |
| `execute` 签名 | 5 参：`(toolCallId, params, signal, onUpdate, ctx)`，返回 `Promise<AgentToolResult<TDetails>>`（见 §2） |
| 会话恢复 | `SessionManager.create(cwd, dir, { id: episodeId })` 建会话；`SessionManager.open(path)` 恢复；`session.sessionFile` / `session.sessionId` 做映射（见 §3） |
| SSE 事件源 | `session.subscribe` 的 `AgentSessionEvent`；正文增量在 `message_update.assistantMessageEvent.type === "text_delta"`（见 §4） |
| DashScope 接入 | `api: "openai-completions"` + `baseUrl` 指向 compatible-mode + `apiKey: "$DASHSCOPE_API_KEY"` + model `compat.thinkingFormat: "qwen"`；runtime key 用 `modelRuntime.setRuntimeApiKey()`（见 §5） |
| 版本 / 许可 | 0.84.3，ESM-only（`"type": "module"`），`engines.node >= 22.19.0`，`license: "MIT"`（package.json 字段；包根未随附独立 LICENSE 文件）（见 §7） |

---

## 1. headless 创建与关原生工具

### 1.1 `createAgentSession(options)` 的确切形状

入口签名（`<pkg>/dist/core/sdk.d.ts:107`）：

```ts
export declare function createAgentSession(
  options?: CreateAgentSessionOptions,
): Promise<CreateAgentSessionResult>;
```

`CreateAgentSessionOptions` 完整字段（`<pkg>/dist/core/sdk.d.ts:10-56`），与本任务相关的字段：

```ts
export interface CreateAgentSessionOptions {
  cwd?: string;                       // 默认 process.cwd()（sdk.d.ts:12）
  agentDir?: string;                  // 默认 ~/.pi/agent（sdk.d.ts:14）
  modelRuntime?: ModelRuntime;        // 默认用 agentDir/auth.json + models.json 建 runtime（sdk.d.ts:16）
  model?: Model<any>;                 // 默认 settings -> 第一个可用（sdk.d.ts:18）
  thinkingLevel?: ThinkingLevel;      // 默认 settings -> 'medium'，按模型能力 clamp（sdk.d.ts:20）
  scopedModels?: Array<{ model; thinkingLevel? }>;

  /** 默认工具抑制模式（无显式 allowlist 时生效）
   *  - "all": 一开始就不启用任何工具
   *  - "builtin": 关闭默认内置工具(read/bash/edit/write)，但保留扩展/自定义工具
   */
  noTools?: "all" | "builtin";        // sdk.d.ts:33

  /** 工具名 allowlist；提供时只启用列出的名字 */
  tools?: string[];                   // sdk.d.ts:43

  /** 工具名 denylist；在 tools 之后生效 */
  excludeTools?: string[];            // sdk.d.ts:45

  /** SDK 自定义工具（附加在内置工具之外注册） */
  customTools?: ToolDefinition[];     // sdk.d.ts:47

  /** 资源加载器；缺省时用 DefaultResourceLoader */
  resourceLoader?: ResourceLoader;    // sdk.d.ts:49

  /** 会话管理器；缺省 SessionManager.create(cwd) */
  sessionManager?: SessionManager;    // sdk.d.ts:51

  /** 设置管理器；缺省 SettingsManager.create(cwd, agentDir) */
  settingsManager?: SettingsManager;  // sdk.d.ts:53
}
```

返回 `CreateAgentSessionResult`（`<pkg>/dist/core/sdk.d.ts:59-66`）：`{ session, extensionsResult, modelFallbackMessage? }`。

### 1.2 关掉原生工具：确切字段是 `noTools`，不是 `tools: []`

官方文档在 Tools 一节明确给出三种关闭方式（`<pkg>/docs/sdk.md:524-526`）：

- `noTools: "all"` —— 关闭所有工具
- `noTools: "builtin"` —— 关闭默认内置工具（read/bash/edit/write），保留扩展 + 自定义工具
- `excludeTools` —— 在 allowlist 之后禁用特定工具名

实现层的等价关系（`<pkg>/dist/core/sdk.js:141-144`）：

```js
const allowedToolNames = options.tools ?? (options.noTools === "all" ? [] : undefined);
const excludedToolNames = options.excludeTools;
const initialActiveToolNames = (options.tools
  ?? (options.noTools ? [] : (configuredDefaultToolNames ?? defaultActiveToolNames))
).filter((name) => !excludedToolNameSet?.has(name));
```

推导（重要）：

- `noTools: "all"` ⇒ `allowedToolNames = []`。注册阶段会按 `allowedToolNames` 过滤**所有**工具（含自定义工具），见 `_refreshToolRegistry` 的 `isAllowedTool`（`<pkg>/dist/core/agent-session.js:2035`）。**所以 `noTools: "all"` 会连自定义工具一起清空，不满足本任务。**
- `noTools: "builtin"` ⇒ `allowedToolNames = undefined`（不过滤自定义），`initialActiveToolNames = []`（内置工具默认不启用）。自定义工具仍可启用。
- `tools: ["read","add","edit"]` 是 allowlist 写法；单独使用也会启用同名内置工具（但同名自定义工具会覆盖内置定义，见 §2.3）。

**结论**：本任务的硬约束（不保留任何原生工具，只留三个自定义工具）用：

```ts
createAgentSession({
  noTools: "builtin",            // 关键：不启用默认内置 read/bash/edit/write
  customTools: [readTool, addTool, editTool],
  // ... 其余见下方完整配方
})
```

⚠️ 注意：`12-full-control.ts` 用的是显式 allowlist `tools: ["read","bash"]`（`<pkg>/examples/sdk/12-full-control.ts:58`），它是「显式、无发现」的样例，但**不是**关原生工具的最合适样例——它仍保留了内置 `read`/`bash`。真正要「零内置」需用 `noTools: "builtin"`。

### 1.3 最小 headless 配方（代码形状）

```ts
import {
  createAgentSession,
  createExtensionRuntime,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// 1) 模型运行时（DashScope 见 §5）
const modelRuntime = await ModelRuntime.create({
  modelsPath: "/app/config/models.json",   // 自定义 provider 走 models.json（§5）
});
await modelRuntime.setRuntimeApiKey("dashscope", process.env.DASHSCOPE_API_KEY!);

// 2) 空资源加载器：覆盖默认 discovery，不加载扩展/技能/主题/AGENTS.md（见 §6）
const resourceLoader: ResourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
  getSkills: () => ({ skills: [], diagnostics: [] }),
  getPrompts: () => ({ prompts: [], diagnostics: [] }),
  getThemes: () => ({ themes: [], diagnostics: [] }),
  getAgentsFiles: () => ({ agentsFiles: [] }),
  getSystemPrompt: () => "你是播客写稿大师……",   // 自定义 system prompt
  getSystemPromptSource: () => undefined,
  getAppendSystemPrompt: () => [],
  getAppendSystemPromptSources: () => [],
  extendResources: () => {},
  reload: async () => {},
};

// 3) 内存设置：关 compaction / retry（可选但推荐，避免后台副作用）
const settingsManager = SettingsManager.inMemory({
  compaction: { enabled: false },
  retry: { enabled: false },
});

const model = modelRuntime.getModel("dashscope", "qwen-plus"); // §5

const { session } = await createAgentSession({
  modelRuntime,
  model,
  thinkingLevel: "off",          // 或按需 "medium"/"high"
  resourceLoader,
  noTools: "builtin",            // 关键：零内置工具
  customTools: [readTool, addTool, editTool],
  sessionManager: SessionManager.inMemory(),  // 或持久化，见 §3
  settingsManager,
});

session.subscribe((e) => { /* 转 SSE，见 §4 */ });
await session.prompt("写第 3 集的初稿……");
session.dispose();
```

---

## 2. 自定义工具 `ToolDefinition`

### 2.1 完整形状

`<pkg>/dist/core/extensions/types.d.ts:344-376`：

```ts
export interface ToolDefinition<
  TParams extends TSchema = TSchema,
  TDetails = unknown,
  TState = any,
> {
  name: string;                       // LLM 工具调用名（types.d.ts:346）
  label: string;                      // UI 展示名（:348）
  description: string;                // 给 LLM 的描述（:350）
  promptSnippet?: string;             // 可选：默认系统提示 "Available tools" 一节的一行摘要（:352）
  promptGuidelines?: string[];        // 可选：系统提示 Guidelines 一节的追加条目（:354）
  parameters: TParams;                // TypeBox schema（:356）
  constrainedSampling?: false | ConstrainedSamplingConfig;  // :358
  renderShell?: "default" | "self";   // :360（未在本任务使用）
  prepareArguments?: (args: unknown) => Static<TParams>;     // :362
  executionMode?: ToolExecutionMode;  // "sequential" | "parallel"（:370）
  execute(
    toolCallId: string,
    params: Static<TParams>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<TDetails>>;   // :372
  renderCall?: (args, theme, context) => Component;          // :374（TUI 渲染，可省略）
  renderResult?: (result, options, theme, context) => Component;  // :376（可省略）
}
```

**关键点**：`parameters` 是 **TypeBox** schema（`TSchema`），不是 JSON Schema。基类 `Tool` 在 pi-ai 里的定义是 `parameters: TParameters` 且 `TParameters extends TSchema`（`<pkg>/node_modules/@earendil-works/pi-ai/dist/types.d.ts:381-385`）。`typebox` 是包的直接依赖（`<pkg>/package.json` dependencies 里的 `"typebox": "1.3.7"`），导入用 `import { Type } from "typebox"`（官方示例，`<pkg>/docs/sdk.md:581`）。

### 2.2 `execute` 返回结构与 `onUpdate`

`AgentToolResult<T>`（`<pkg>/node_modules/@earendil-works/pi-agent-core/dist/types.d.ts:316-331`）：

```ts
export interface AgentToolResult<T> {
  content: (TextContent | ImageContent)[];  // 回传给模型的文本/图片（:318）
  details: T;                               // 结构化细节，供日志/UI（:320）
  usage?: Usage;                            // 工具自身的 token 用量（:322）
  addedToolNames?: string[];                // 该结果引入的新工具名（:324）
  terminate?: boolean;                      // 提示本批工具执行完后停止（:326）
}
```

其中 `TextContent = { type: "text"; text: string; textSignature? }`（`<pkg>/node_modules/@earendil-works/pi-ai/dist/types.d.ts:237-241`）。

`AgentToolUpdateCallback`（`<pkg>/node_modules/@earendil-works/pi-agent-core/dist/types.d.ts:337`）：

```ts
export type AgentToolUpdateCallback<T = any> =
  (partialResult: AgentToolResult<T>) => void;
```

`onUpdate` 用于流式输出中间结果；工具 promise settle 之后再调用会被忽略（见该类型上方注释，agent-core types.d.ts:331-337）。

`defineTool` 工厂（保留参数推断，供 `customTools` 数组使用）（`<pkg>/dist/core/extensions/types.d.ts:386`）：

```ts
export declare function defineTool<TParams extends TSchema, TDetails = unknown, TState = any>(
  tool: ToolDefinition<TParams, TDetails, TState>,
): ToolDefinition<TParams, TDetails, TState> & AnyToolDefinition;
```

### 2.3 完整 `read` 工具最小示例

```ts
import { Type } from "typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";

const readTool = defineTool({
  name: "read",                       // 与内置 read 同名：会覆盖内置定义（见下）
  label: "Read",
  description: "读取一个文件内容",
  parameters: Type.Object({
    path: Type.String({ description: "文件绝对路径" }),
  }),
  execute: async (toolCallId, params, signal, onUpdate, ctx) => {
    // params 已由 TypeBox 校验并推断为 { path: string }
    const text = await readFile(params.path, "utf8");
    return {
      content: [{ type: "text", text }],
      details: { path: params.path, bytes: text.length },
    };
  },
});
```

**同名覆盖**（重要，已从源码确证）：自定义工具与内置工具同名时，**自定义定义覆盖内置定义**。`_refreshToolRegistry` 里先把内置定义放进 registry，再用 `allCustomTools`（= 扩展工具 + `customTools`）`set` 覆盖同名字段：

- 定义表：`definitionRegistry.set(tool.definition.name, ...)`（`<pkg>/dist/core/agent-session.js:2054`）
- 实际 registry：`toolRegistry.set(tool.name, tool)`（`<pkg>/dist/core/agent-session.js:2082`）

因此自定义 `read` / `edit` 与内置同名是安全的（自定义胜出），且配合 `noTools: "builtin"` 时内置 `bash` / `write` 等根本不进入活动工具集。**但建议验证**：若担心歧义，自定义工具名可用不冲突的名字（如 `doc_read`），但任务要求名字就是 `read`/`add`/`edit`，源码层面同名覆盖已成立。

`customTools` 的激活路径（`<pkg>/dist/core/agent-session.js:2039-2083` 与 `:2093-2098`）：`noTools: "builtin"` ⇒ `initialActiveToolNames = []`，但构造函数以 `includeAllExtensionTools: true` 调 `_buildRuntime`（`<pkg>/dist/core/agent-session.js:157-158`），`_refreshToolRegistry` 走到 `else if (options?.includeAllExtensionTools)` 分支，把 `allCustomTools`（含 `customTools`）的名字 push 进活动工具集（`<pkg>/dist/core/agent-session.js:2093-2098`）。因此自定义工具自动激活，内置工具不激活。

---

## 3. 会话持久化 / 恢复

### 3.1 `SessionManager` 静态工厂（确切签名）

`<pkg>/dist/core/session-manager.d.ts`：

```ts
static create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager;      // :318
static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager;             // :325
static continueRecent(cwd: string, sessionDir?: string): SessionManager;                          // :331
static inMemory(cwd?: string, options?: NewSessionOptions): SessionManager;                       // :333
static list(cwd: string, sessionDir?: string, onProgress?): Promise<SessionInfo[]>;               // :348
static listAll(...): Promise<SessionInfo[]>;                                                      // :353-354
```

`NewSessionOptions`（`<pkg>/dist/core/session-manager.d.ts:13-16`）：

```ts
export interface NewSessionOptions {
  id?: string;          // 显式 session id
  parentSession?: string;
}
```

官方用法示例（`<pkg>/examples/sdk/11-sessions.ts`）：

- `SessionManager.inMemory()` —— 无持久化（11-sessions.ts:11）
- `SessionManager.create(process.cwd())` —— 新持久会话（11-sessions.ts:18）
- `SessionManager.continueRecent(process.cwd())` —— 继续最近（11-sessions.ts:24-25）
- `SessionManager.list(process.cwd())` + `SessionManager.open(sessions[0].path)` —— 枚举 + 打开（11-sessions.ts:32, 40）
- 自定义会话目录（脱离 cwd 编码）：`SessionManager.create(process.cwd(), customDir)`（11-sessions.ts:49，注释示例）

### 3.2 会话文件命名与 sessionId/sessionFile

- `AgentSession` 暴露 `sessionFile: string | undefined` 与 `sessionId: string`（`<pkg>/dist/core/agent-session.d.ts:330,332`）。
- 持久会话文件名规则（`<pkg>/dist/core/session-manager.js:667`）：

```js
this.sessionFile = join(this.getSessionDir(), `${fileTimestamp}_${this.sessionId}.jsonl`);
```

其中 `sessionId = options?.id ?? createSessionId()`（`<pkg>/dist/core/session-manager.js:649`）。默认 `sessionDir = ~/.pi/agent/sessions/<encoded-cwd>/`（`SessionManager.create` 注释，session-manager.d.ts:313-317；或 `getDefaultSessionDir`）。

### 3.3 一集一会话的映射与恢复方案

推荐方案（利用 `NewSessionOptions.id` 做确定性映射）：

```ts
const SESSIONS_DIR = "/app/data/sessions";   // 显式目录，避开 cwd 编码

// 新建第 N 集会话：sessionId = episodeId，文件 = <timestamp>_<episodeId>.jsonl
const { session } = await createAgentSession({
  // ...
  sessionManager: SessionManager.create(process.cwd(), SESSIONS_DIR, { id: episodeId }),
});
// 持久化映射：episodeId -> session.sessionFile
await db.save({ episodeId, sessionFile: session.sessionFile! });
```

```ts
// 恢复第 N 集：按 sessionFile 打开（或先 list 再按 id 匹配）
const { session } = await createAgentSession({
  // ...
  sessionManager: SessionManager.open(stored.sessionFile, SESSIONS_DIR),
});
```

备选：用 `SessionManager.list(cwd, SESSIONS_DIR)` 枚举（返回 `SessionInfo[]`，含 `id` / `path` / `cwd` / `created` / `modified` / `firstMessage`，`<pkg>/dist/core/session-manager.d.ts:125-139`），按 `info.id === episodeId` 找到文件后 `open(info.path)`。

注意点：

- 文件名带时间戳前缀，**不是** `episodeId.jsonl` 纯命名；所以不要自己拼路径，持久化 `session.sessionFile` 或靠 `list()` 反查。
- 会话树是 append-only（`id`/`parentId` 结构），本任务按「一集一个文件」平铺即可，不涉及 `branch`/`navigateTree`。
- 恢复时若保存的模型不可用，`createAgentSession` 返回 `modelFallbackMessage`（`CreateAgentSessionResult.modelFallbackMessage`，sdk.d.ts:65；示例 11-sessions.ts:24-27）。

---

## 4. 流式事件 → SSE 映射

### 4.1 订阅入口

`session.subscribe(listener)` 返回退订函数（`<pkg>/dist/core/agent-session.d.ts:282`）：

```ts
subscribe(listener: AgentSessionEventListener): () => void;
// AgentSessionEventListener = (event: AgentSessionEvent) => void  （agent-session.d.ts:108）
```

`session.prompt(text, options?)`、`session.steer(text, images?)`、`session.followUp(text, images?)`、`session.abort()`、`session.waitForIdle()`、`session.dispose()` 的签名分别见 `<pkg>/dist/core/agent-session.d.ts:361, 377, 385, 439, 440, 289`。

### 4.2 `AgentSessionEvent` 联合类型

`<pkg>/dist/core/agent-session.d.ts:40-107`。它 = `Exclude<AgentEvent, {type:"agent_end"}>`（继承 agent-core 的 `AgentEvent`，见 `<pkg>/node_modules/@earendil-works/pi-agent-core/dist/types.d.ts:374-410`）再扩展会话级事件。

底层 `AgentEvent`（agent-core types.d.ts:374-410）：

```ts
{ type: "agent_start" }
{ type: "agent_end"; messages: AgentMessage[] }
{ type: "turn_start" }
{ type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
{ type: "message_start"; message: AgentMessage }
{ type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
{ type: "message_end"; message: AgentMessage }
{ type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
{ type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
{ type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean }
```

`agent_end` 在会话层被替换为带 `willRetry` 的版本，并追加会话级事件（agent-session.d.ts:40-107）：

```ts
{ type: "agent_end"; messages: AgentMessage[]; willRetry: boolean }
{ type: "agent_settled" }                       // 本次 run 完全 settle，无后续自动重试/压缩/队列续跑
{ type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
{ type: "compaction_start"; reason: "manual"|"threshold"|"overflow" }
{ type: "compaction_end"; reason; result; aborted; willRetry; errorMessage? }
{ type: "entry_appended"; entry: SessionEntry }
{ type: "session_info_changed"; name: string | undefined }
{ type: "thinking_level_changed"; level: ThinkingLevel }
{ type: "auto_retry_start"; attempt; maxAttempts; delayMs; errorMessage }
{ type: "auto_retry_end"; success; attempt; finalError? }
{ type: "summarization_retry_scheduled"; ... }
{ type: "summarization_retry_attempt_start"; ... }
{ type: "summarization_retry_finished" }
{ type: "bash_execution_update"; id?: string; delta: string }
```

### 4.3 正文/思考增量：`message_update.assistantMessageEvent`

正文增量嵌套在 `message_update` 里，`assistantMessageEvent` 是 `AssistantMessageEvent` 联合类型（`<pkg>/node_modules/@earendil-works/pi-ai/dist/types.d.ts:400-451`）：

```ts
{ type: "start"; partial }
{ type: "text_start"; contentIndex; partial }
{ type: "text_delta"; contentIndex; delta: string; partial }      // :408-410
{ type: "text_end"; contentIndex; content: string; partial }
{ type: "thinking_start"; contentIndex; partial }
{ type: "thinking_delta"; contentIndex; delta: string; partial }  // :422-424
{ type: "thinking_end"; contentIndex; content: string; partial }
{ type: "toolcall_start"; contentIndex; partial }
{ type: "toolcall_delta"; contentIndex; delta: string; partial }
{ type: "toolcall_end"; contentIndex; toolCall: ToolCall; partial }
{ type: "done"; reason; message }
{ type: "error"; reason; error }
```

官方示例只取 `text_delta`（`<pkg>/docs/sdk.md:271-273`；`<pkg>/examples/sdk/12-full-control.ts:53-55`）。

### 4.4 SSE 事件映射表

| SSE 事件 | PI 事件来源 | 关键字段 |
|---|---|---|
| `text_delta` | `message_update` 且 `assistantMessageEvent.type === "text_delta"` | `assistantMessageEvent.delta`（string） |
| `thinking_delta` | `message_update` 且 `assistantMessageEvent.type === "thinking_delta"` | `assistantMessageEvent.delta` |
| `tool_execution_start` | 顶层 `tool_execution_start` | `toolCallId`, `toolName`, `args` |
| `tool_execution_update` | 顶层 `tool_execution_update` | `toolCallId`, `toolName`, `partialResult` |
| `tool_execution_end` | 顶层 `tool_execution_end` | `toolCallId`, `toolName`, `result`, `isError` |
| `turn_start` / `turn_end` | 顶层 `turn_start` / `turn_end` | 会话层 `turn_end` 字段为 `message` + `toolResults`（agent-core types.d.ts:382-386，无 `turnIndex`）；扩展层 `TurnEndEvent` 另含 `turnIndex`（extensions/types.d.ts:564-575），二者是不同联合，勿混淆 |
| `agent_start` / `agent_end` | 顶层 `agent_start` / `agent_end` | `agent_end.messages`, `agent_end.willRetry` |
| `done`（终结） | 顶层 `agent_settled`（比 `agent_end` 更「最终」，无后续重试/压缩） | 无 |
| 队列/重试（可选） | `queue_update` / `auto_retry_start` / `auto_retry_end` / `compaction_*` | 见 §4.2 |

> 注：`turn_end` 的具体字段在不同层有差异。`session.subscribe` 收到的 `turn_end` 来自 agent-core `AgentEvent`（字段 `message` + `toolResults`，无 `turnIndex`，agent-core types.d.ts:382-386）。extensions 层的 `TurnEndEvent`（字段 `turnIndex` + `message` + `toolResults`，extensions/types.d.ts:564-575）是另一个类型，**不要**混淆。

---

## 5. 模型接入 DashScope（OpenAI 兼容模式）

### 5.1 注册 provider：`api: "openai-completions"` + baseUrl + apiKey

DashScope 的 compatible-mode 端点用 OpenAI Chat Completions 协议，对应 API 类型 `openai-completions`（`<pkg>/docs/custom-provider.md:226`：「OpenAI Chat Completions API and compatibles」；`<pkg>/docs/models.md:125`：「most compatible」）。

两种注册方式（任选其一）：

**(a) models.json 文件方式（文档主推，`<pkg>/docs/models.md`）**——运行时通过 `ModelRuntime.create({ modelsPath })` 指定（`<pkg>/dist/core/model-runtime.d.ts:7`）：

```json
{
  "providers": {
    "dashscope": {
      "baseUrl": "https://llm-3xmgkuxxgaorb0ho.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
      "api": "openai-completions",
      "apiKey": "$DASHSCOPE_API_KEY",
      "models": [
        {
          "id": "qwen-plus",
          "name": "Qwen Plus",
          "reasoning": true,
          "input": ["text"],
          "contextWindow": 131072,
          "maxTokens": 8192,
          "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
          "compat": { "thinkingFormat": "qwen" }
        }
      ]
    }
  }
}
```

`apiKey` 的 `$ENV_VAR` 环境插值语义（`<pkg>/docs/models.md:156-159`；`<pkg>/docs/custom-provider.md:186`）：`"$DASHSCOPE_API_KEY"` 会读环境变量；`!command` 前缀执行命令；`$$` 转义。provider 级 `compat` 可对全模型生效，model 级 `compat` 覆盖 provider 级（`<pkg>/docs/models.md:41, 440-441`）。

**(b) 编程注册方式**：`ModelRuntime.registerProvider(providerId, config)`（`<pkg>/dist/core/model-runtime.d.ts:97`）。config 的内部类型名是 `ProviderConfigInput`（`<pkg>/dist/core/provider-composer.d.ts:16-38`），与根导出的 `ProviderConfig` 结构一致（根导出见 `<pkg>/dist/index.d.ts:7` 的 `ProviderConfig` / `ProviderModelConfig`）：

```ts
modelRuntime.registerProvider("dashscope", {
  baseUrl: "https://llm-3xmgkuxxgaorb0ho.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  apiKey: "$DASHSCOPE_API_KEY",
  api: "openai-completions",
  models: [{
    id: "qwen-plus",
    name: "Qwen Plus",
    reasoning: true,
    input: ["text"],
    contextWindow: 131072,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { thinkingFormat: "qwen" },
  }],
});
```

> 注：`ProviderConfigInput` 未从包根导出（`<pkg>/dist/index.d.ts` 未见该名，只导出 `ProviderConfig`/`ProviderModelConfig`）。写 TS 时用根导出的 `ProviderConfig` 类型或直接内联对象即可。

### 5.2 qwen 的 `compat.thinkingFormat`

- `thinkingFormat: "qwen"` 的语义：DashScope 风格顶层 `enable_thinking: true`（`<pkg>/docs/custom-provider.md:255` 注释「top-level enable_thinking: true」；`<pkg>/docs/custom-provider.md:775`：「`qwen` is for DashScope-style top-level `enable_thinking`」；`<pkg>/docs/models.md` OpenAI 兼容一节同样表述）。
- `thinkingFormat` 的合法值全集（`<pkg>/docs/custom-provider.md:754`）：`"openai" | "openrouter" | "deepseek" | "together" | "baseten" | "zai" | "qwen" | "chat-template" | "qwen-chat-template" | "string-thinking" | "ant-ling"`；默认 `"openai"`（reasoning_effort）。
- 重要坑：`thinkingTokenBudgetField` 独立于 `thinkingFormat`，**不要**在 Qwen 上同时启用 `thinking_budget` 与 `reasoning_effort`，DashScope 会拒绝（`<pkg>/docs/models.md` OpenAI 兼容一节末尾；`<pkg>/docs/custom-provider.md:776` 附近同述）。本任务用 `thinkingFormat: "qwen"`（顶层 enable_thinking）即可，不需要 token budget。
- DashScope OpenAI 兼容端点一般不认 `developer` role；如遇 400 可考虑 `compat.supportsDeveloperRole: false`（见 `<pkg>/docs/models.md:39` 的通用说明）。本任务端点为阿里云专属 MaaS 端点，具体行为未在文档/源码中针对该 URL 验证——**实现阶段建议先用最小请求验证 `developer` role 与 `enable_thinking` 是否被接受**，必要时补 `supportsDeveloperRole: false` 与 `supportsReasoningEffort: false`。

### 5.3 runtime 设置 API key 的编程接口

`ModelRuntime` 的运行时覆盖（**不落盘**，优先级最高）（`<pkg>/dist/core/model-runtime.d.ts:82`）：

```ts
await modelRuntime.setRuntimeApiKey(providerId: string, apiKey: string, options?): Promise<void>;
// removeRuntimeApiKey(providerId, options?): Promise<void>  （model-runtime.d.ts:83）
```

认证解析优先级（`<pkg>/docs/sdk.md:445`）：runtime override → `auth.json` 存储凭据 → 环境变量（`ANTHROPIC_API_KEY` 等）→ fallback（models.json 的 provider apiKey）。所以既可以直接 `setRuntimeApiKey("dashscope", process.env.DASHSCOPE_API_KEY)`，也可以在 models.json 写 `"$DASHSCOPE_API_KEY"` 二选一；二者都行，`setRuntimeApiKey` 更贴近「编程接口」要求。

取模型：`modelRuntime.getModel(providerId, modelId)`（`<pkg>/dist/core/model-runtime.d.ts:65`）；`getAvailable()` 返回已配置认证的模型（`<pkg>/dist/core/model-runtime.d.ts:67`）。

```ts
const model = modelRuntime.getModel("dashscope", "qwen-plus");
if (!model) throw new Error("dashscope/qwen-plus 未注册");
```

---

## 6. 要避开的耦合（ResourceLoader / 内置工具 / TUI）

`createAgentSession` 缺省使用 `DefaultResourceLoader`（`<pkg>/dist/core/sdk.d.ts:49` 注释），它会做标准 discovery：项目扩展 `.pi/extensions/`、技能 `.agents/skills/`、prompts、主题、`AGENTS.md` 上下文文件、settings、models.json、auth.json（`<pkg>/docs/sdk.md` 的 Directories 一节）。进程内嵌入时应把这些全部覆盖为 no-op，`12-full-control.ts` 给出了完整样例（`<pkg>/examples/sdk/12-full-control.ts:36-49`）：

```ts
const resourceLoader: ResourceLoader = {
  getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),  // :37
  getSkills: () => ({ skills: [], diagnostics: [] }),                                        // :38
  getPrompts: () => ({ prompts: [], diagnostics: [] }),                                      // :39
  getThemes: () => ({ themes: [], diagnostics: [] }),                                        // :40
  getAgentsFiles: () => ({ agentsFiles: [] }),                                               // :41
  getSystemPrompt: () => `You are a minimal assistant. ...`,                                 // :42-43
  getSystemPromptSource: () => undefined,                                                    // :44
  getAppendSystemPrompt: () => [],                                                           // :45
  getAppendSystemPromptSources: () => [],                                                    // :46
  extendResources: () => {},                                                                 // :47
  reload: async () => {},                                                                    // :48
};
```

要点：

1. **ResourceLoader 覆盖**：传自定义 `resourceLoader` 后，`cwd`/`agentDir` 不再驱动 discovery（`<pkg>/docs/sdk.md` Directories 一节：「When you pass a custom ResourceLoader, cwd and agentDir no longer control resource discovery」）。空 loader 保证不加载扩展/技能/主题/AGENTS.md。
2. **内置工具**：用 `noTools: "builtin"`（§1.2），不要用 `noTools: "all"`（会连自定义工具一起关掉）。
3. **TUI / run modes**：不要 import / 运行 `InteractiveMode`、`runPrintMode`、`runRpcMode` 或 `main()`（它们会带出 TUI/CLI 生命周期，见 `<pkg>/dist/index.d.ts:5-6, 20` 的导出）。嵌入只用 `createAgentSession` + `session.prompt`。
4. **SettingsManager**：用 `SettingsManager.inMemory(...)` 并显式关掉 compaction / retry（`12-full-control.ts:29-32`；`SettingsManager.inMemory` 见 `<pkg>/docs/sdk.md` Settings 一节），避免后台自动压缩/重试的副作用。
5. **凭证/模型目录**：`ModelRuntime.create({ authPath, modelsPath })` 指向应用自己的目录，别落到 `~/.pi/agent`（`12-full-control.ts:17-20`）。
6. `createExtensionRuntime()` 是构造空 loader 时需要的导出（`<pkg>/dist/index.d.ts:8`）。

---

## 7. 版本 / 许可 / 运行要求

来源：`<pkg>/package.json`。

| 项 | 值 | 出处 |
|---|---|---|
| version | `0.84.3` | package.json `"version"` |
| ESM-only | `"type": "module"`；`exports["."].import = "./dist/index.js"`（无 `require` 条目） | package.json `"type"`、`"exports"` |
| engines | `"node": ">=22.19.0"` | package.json `"engines"` |
| license | `"MIT"` | package.json `"license"` |
| types | `"types": "./dist/index.d.ts"`；`"main": "./dist/index.js"` | package.json |
| 依赖 `typebox` | `"typebox": "1.3.7"`（自定义工具 schema 用） | package.json `"dependencies"` |
| 子路径导出 | `"."`, `"./rpc-entry"`, `"./client"` | package.json `"exports"` |

确认与提醒：

- **MIT**：仅 package.json 的 `"license": "MIT"` 字段可确证；包根**未随附独立 LICENSE 文件**（对 `<pkg>` 根做 `find -iname "LICENSE*"` 无命中，只有各依赖自带 LICENSE）。若实现阶段需要 license 文本，建议从上游仓库（package.json `"repository"` 指向 `github.com/earendil-works/pi`）取 LICENSE 原文，此处不臆造内容。
- **Node 版本**：项目 Node v22.23.1 ≥ 22.19.0，满足 engines。
- **ESM-only 影响**：agent-runtime 模块必须跑在 ESM 上下文（或用动态 `import()`）；本项目后端 TypeScript/Node 若用 CommonJS 构建，需注意（`type: "module"` 且无 CJS 导出条目）。

---

## 附：未确证 / 待实现阶段验证项

1. DashScope 专属端点 `https://llm-3xmgkuxxgaorb0ho.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` 是否接受 pi 默认的 `developer` role 与 `reasoning_effort`——文档只给出通用 `supportsDeveloperRole` / `supportsReasoningEffort` 开关（`docs/models.md:39`），未针对该 URL 验证。实现前用最小请求验证，必要时加 `compat: { supportsDeveloperRole: false, supportsReasoningEffort: false, thinkingFormat: "qwen" }`。
2. `ProviderConfigInput`（编程注册 provider 的内部类型名）未从包根导出；根导出的是 `ProviderConfig`。TS 中建议直接用根导出的 `ProviderConfig` 类型或内联对象，避免 import 内部路径。
3. 自定义工具与内置工具同名（`read`/`edit`）的覆盖行为已从 `dist/core/agent-session.js:2054, 2082` 源码确证为「自定义胜出」；但仍建议在实现阶段写一个最小集成测试实际触发一次 `read` 工具调用，确认拿到的是自定义实现而非内置实现。
