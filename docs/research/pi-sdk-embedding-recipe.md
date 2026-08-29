# PI SDK 最小可嵌入配方（进程内嵌入，无原生工具）

> 调研日期：2026-08-28（2026-08-29 重新核对 v0.84.4 源码后修订 §0/§3.3/§6，见文末「修订记录」）
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
| 会话架构 | **`Map<episodeId, AgentSession>`**：懒建/恢复，`modelRuntime`+`settingsManager` 共享单例，per-episode `ResourceLoader`+`SessionManager(id=episodeId)`+`customTools`；不用 `createAgentRuntime`（单当前会话=CLI 形态，不合 web 并发，见 §3.3） |
| system prompt 组装 | **Layer 3（`getSystemPrompt`，建会话时算一次）= 静态五层 + 关 discovery；Layer 2（`before_agent_start`，每轮）= 第六层覆盖当前 DB 元数据到末尾**（见 §6）。`getSystemPrompt` **非每轮**调用（见 §6.0 修正） |
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

### 3.3 一集一会话的架构：`Map<episodeId, AgentSession>`（重新讨论定案）

**不用 `createAgentRuntime`/`AgentSessionRuntime`。** 它持有「一个当前会话」、`switchSession(path)` 拆旧建新，是 CLI `/resume`-`/new` 形态（`<pkg>/dist/core/agent-session-runtime.d.ts` 的 `AgentSessionRuntime`）。Web 后端因两点必须跨请求驻留会话，天然并发，单当前会话形态不合：

1. **abort**：单独的 `POST writer/abort` 要打到运行中的会话（`session.abort()`，`<pkg>/dist/core/agent-session.d.ts:439`）；
2. **ChangeSet 通知**：`POST /changes` -> `sendCustomMessage({ customType:"change_set", display:false, ... }, { triggerTurn:false })`（`agent-session.d.ts` 的 `sendCustomMessage`）发给该集**空闲中**的会话。

故进程内持有一张 `Map<episodeId, AgentSession>`，按 episodeId 懒建/恢复：

```ts
const SESSIONS_DIR = "/app/data/sessions";   // 显式目录，避开 cwd 编码
const sessions = new Map<string, AgentSession>();

// modelRuntime / settingsManager 进程内共享单例（建一次）
const modelRuntime = await ModelRuntime.create({ modelsPath: "/app/config/models.json" });
await modelRuntime.setRuntimeApiKey("dashscope", process.env.DASHSCOPE_API_KEY!);
const settingsManager = SettingsManager.inMemory({ compaction:{enabled:false}, retry:{enabled:false} });

async function getOrCreateSession(episodeId: string, scriptService: ScriptService): Promise<AgentSession> {
  const cached = sessions.get(episodeId);
  if (cached) return cached;

  const row = await db.conversations.findByPk(episodeId);   // conversations.session_file
  const sessionManager = row?.sessionFile
    ? SessionManager.open(row.sessionFile, SESSIONS_DIR)           // 恢复
    : SessionManager.create(process.cwd(), SESSIONS_DIR, { id: episodeId });  // 新建：sessionId=episodeId

  const { session } = await createAgentSession({
    modelRuntime,
    model: modelRuntime.getModel("dashscope", "qwen-plus")!,
    thinkingLevel: "off",
    settingsManager,                                              // 共享单例
    resourceLoader: makeWriterResourceLoader(episodeId, scriptService),  // per-episode，见 §6
    noTools: "builtin",
    customTools: makeWriterTools(episodeId, scriptService),       // per-episode：闭包持有该集 script service
    sessionManager,
  });
  if (!row?.sessionFile) {
    await db.conversations.upsert({ episodeId, sessionFile: session.sessionFile! });
  }
  sessions.set(episodeId, session);
  return session;
}
```

要点：

- **共享单例**：`modelRuntime` + `settingsManager` 建一次，所有会话复用；per-episode 的是 `resourceLoader` + `sessionManager` + `customTools`（闭包持有 `episodeId` 与该集的 `scriptService` 句柄）。
- **不主动空闲逐出**：单用户、单集会话内存微不足道；进程退出统一 `session.dispose()`（`agent-session.d.ts:289`）。因 Layer 2 每轮读 DB 元数据（§6），会话驻留时元数据不会陈旧，无需版本号重建。
- **`createAgentRuntime` 为何不用**：即便工厂里从 `sessionManager.getSessionId()` 反推 episodeId 造 per-episode loader 可行，其 `switchSession` 仍只服务「单当前会话」的串行 CLI 模型；Map 天然支持多集并发，且 `abort`/ChangeSet 已逼会话驻留，串行模型不成立。
- 文件名带时间戳前缀（`<timestamp>_<episodeId>.jsonl`，见 §3.2），不要自己拼路径；持久化 `session.sessionFile` 或靠 `SessionManager.list(cwd, SESSIONS_DIR)`（返回 `SessionInfo[]`，`session-manager.d.ts:125-139`）按 `info.id === episodeId` 反查。
- 恢复时若保存的模型不可用，`createAgentSession` 返回 `modelFallbackMessage`（`CreateAgentSessionResult.modelFallbackMessage`，sdk.d.ts:65）。

### 3.3.1 旧的「单点建会话」写法（已废弃，保留对照）

原先设想的「`SessionManager.create` 单点建会话 + `SessionManager.open` 单点恢复」已并入上方 `Map` 架构。下方为旧写法，仅作 API 对照：

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

### 6.0 修正：`getSystemPrompt()` 不是每轮调用（重新核对源码）

原先易误以为「实现 ResourceLoader 的目的 = 每轮 runAgentLoop 前调用 `getSystemPrompt()` 动态拼提示词」。**源码核对为否**：

- `resourceLoader.getSystemPrompt()` 全 core 唯一调用点在 `<pkg>/dist/core/agent-session.js:752`，包在 `_rebuildSystemPrompt()` 内；`_rebuildSystemPrompt` 仅在 `:671`（`setActiveToolsByName`，改工具时）与 `:1936`（`_refreshToolRegistry`，建会话时）被调，**不在 prompt 路径**。结果缓存为 `this._baseSystemPrompt`。
- 每轮 `prompt()`（`:915`）跑的是 `emitBeforeAgentStart(expandedText, currentImages, this._baseSystemPrompt, this._baseSystemPromptOptions)`，传的是**缓存住**的 `_baseSystemPrompt`；其下 `:921-929` 才是按轮生效的口子：
  ```js
  if (result?.systemPrompt !== undefined) {
    this._systemPromptOverride = result.systemPrompt;
    this.agent.state.systemPrompt = result.systemPrompt;   // handler 返回的串替换本轮
  } else {
    this._systemPromptOverride = undefined;
    this.agent.state.systemPrompt = this._baseSystemPrompt; // 否则用缓存的 base
  }
  ```

即：**「每轮动态拼 prompt」的钩子是 `before_agent_start` 事件（Layer 2），不是 `getSystemPrompt`（Layer 3）。** Layer 3 只在建会话时算一次做种子。`before_agent_start` 类型定义（`<pkg>/dist/core/extensions/types.d.ts:536-549`）：「Fired after user submits prompt but before agent loop」；返回值 `BeforeAgentStartEventResult.systemPrompt`（同文件 `:847-851`）：「Replace the system prompt for this turn. If multiple extensions return this, they are chained.」官方样例 `<pkg>/examples/extensions/prompt-customizer.ts` 即此模式。

### 6.1 写稿大师的 system prompt = Layer 3 静态种子 + Layer 2 每轮覆盖第六层

「六层 prompt（静态层 + 节目元数据/说话人快照）」拆成两层机制：

- **Layer 3（`getSystemPrompt`，建会话时算一次）= 前五层静态层**：写稿大师身份、角色、风格等不变内容；同时用空 loader **关掉 discovery**（不加载项目扩展/技能/AGENTS.md，隔离写稿大师）。`buildSystemPrompt` 自动追加工具段（read/add/edit，取自 `customTools` 的 description）。这份种子缓存为 `_baseSystemPrompt`，每轮当稳定前缀复用。
- **Layer 2（`before_agent_start`，每轮）= 第六层覆盖当前 DB 元数据**：每轮从 DB 读**当前**节目元数据 + 说话人快照，作为第六层覆盖到末尾（工具段之后）：
  ```ts
  return {
    systemPrompt: event.systemPrompt + "\n\n## 节目信息与说话人\n" + currentMetadata,
  };
  ```
  固定槽位（末尾）、**覆盖、不累加**（每轮重新拼，不是每轮多塞一份）。

**缓存**：提示词缓存按内容哈希、前缀缓存。元数据没改 -> 整条逐字节相同 -> 命中；改了 -> 只有末尾第六层 miss，前缀（身份+工具）全命中。动态层放末尾 = 最长稳定前缀 = 缓存最优。元数据极少变（设置页才改），99% 的轮次命中。

### 6.2 per-episode ResourceLoader 形状（Layer 3 静态种子 + 关 discovery）

`createAgentSession` 缺省使用 `DefaultResourceLoader`（`<pkg>/dist/core/sdk.d.ts:49` 注释），它会做标准 discovery：项目扩展 `.pi/extensions/`、技能 `.agents/skills/`、prompts、主题、`AGENTS.md` 上下文文件、settings、models.json、auth.json（`<pkg>/docs/sdk.md` 的 Directories 一节）。进程内嵌入时应把这些全部覆盖为 no-op。**关键**：`getSystemPrompt` 不带 episode 参数，故每集需自己的 loader 实例，闭包持有 `episodeId`（见 §3.3 的 `makeWriterResourceLoader`）：

```ts
// 返回写稿大师的「前五层静态身份」。建会话时算一次，之后缓存复用。
function writerStaticPrompt(): string {
  return `你是播客写稿大师。负责全部文本（台词 + 指令）……（前五层静态内容）`;
}

function makeWriterResourceLoader(episodeId: string, scriptService: ScriptService): ResourceLoader {
  return {
    getExtensions: () => ({ extensions: [writerBeforeAgentStartExtension(episodeId)], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => writerStaticPrompt(),   // Layer 3：静态种子，建会话时算一次
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}
```

要点：

1. **ResourceLoader 覆盖**：传自定义 `resourceLoader` 后，`cwd`/`agentDir` 不再驱动 discovery（`<pkg>/docs/sdk.md` Directories 一节：「When you pass a custom ResourceLoader, cwd and agentDir no longer control resource discovery」）。空 discovery（`getSkills/getPrompts/getThemes/getAgentsFiles` 返空）保证不加载项目扩展/技能/主题/AGENTS.md。
2. **`getExtensions` 返回一个 InlineExtension**（即 Layer 2 的 `before_agent_start` handler，见 §6.3），不再返空数组。
3. **内置工具**：用 `noTools: "builtin"`（§1.2），不要用 `noTools: "all"`（会连自定义工具一起关掉）。
4. **TUI / run modes**：不要 import / 运行 `InteractiveMode`、`runPrintMode`、`runRpcMode` 或 `main()`（它们会带出 TUI/CLI 生命周期，见 `<pkg>/dist/index.d.ts:5-6, 20` 的导出）。嵌入只用 `createAgentSession` + `session.prompt`。
5. **SettingsManager**：用 `SettingsManager.inMemory(...)` 并显式关掉 compaction / retry（`12-full-control.ts:29-32`；`SettingsManager.inMemory` 见 `<pkg>/docs/sdk.md` Settings 一节），避免后台自动压缩/重试的副作用。
6. **凭证/模型目录**：`ModelRuntime.create({ authPath, modelsPath })` 指向应用自己的目录，别落到 `~/.pi/agent`（`12-full-control.ts:17-20`）。
7. `createExtensionRuntime()` 是构造 loader 时需要的导出（`<pkg>/dist/index.d.ts:8`）。
8. **实现侧定案（2026-08-29）**：手写 loader 改为 **`DefaultResourceLoader` + 选项**（`systemPrompt` + `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles: true` + `extensionFactories: [...]`）——factory→`Extension` 的加载（`handlers` Map）由 SDK 自己做，手写 `getExtensions()` 需复刻 `loadExtensionFromFactory` 不值得。**必须 `await loader.reload()` 后再传入**：`createAgentSession` 只对自己新建的 loader 调 `reload()`（`sdk.js:77` 仅 `if (!resourceLoader)` 分支），而 `DefaultResourceLoader` 是惰性的，不 reload 则 `getSystemPrompt()`/`getExtensions()` 返回空（spike 踩过）。

### 6.3 Layer 2：`before_agent_start` InlineExtension（每轮覆盖第六层）

Layer 2 的 `before_agent_start` handler 以 ExtensionFactory 形状经 loader 的 `extensionFactories` 注册（per-episode 闭包持有 `episodeId` 与 service 句柄）。**v0.84.4 实测形状**：`InlineExtension = ExtensionFactory | { name, factory, hidden? }`，其中 `ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>`（`extensions/types.d.ts:1151-1160`）——本配方早期草稿写的 `{ name, setup(api) }` 形状在 0.84.4 **不存在**，官方样例 `examples/extensions/prompt-customizer.ts` 即 factory 形状：

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function writerBeforeAgentStartExtension(
  episodeId: string,
): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.on("before_agent_start", async (event) => {
      // 每轮从 DB 读当前节目元数据 + 说话人快照（第六层）
      const meta = await loadShowMetadata(episodeId);
      const speakers = await loadSpeakers(episodeId);
      const layer6 = formatMetadataLayer(meta, speakers); // "## 节目信息与说话人\n..."
      // 覆盖到末尾（event.systemPrompt = _baseSystemPrompt，含静态五层 + 工具段）
      return { systemPrompt: event.systemPrompt + "\n\n" + layer6 };
    });
  };
}
```

核对：`BeforeAgentStartEvent`（`extensions/types.d.ts:536-549`）携带 `systemPrompt`（缓存住的 `_baseSystemPrompt`）与 `systemPromptOptions`；`BeforeAgentStartEventResult.systemPrompt`（`:847-851`）替换本轮。factory 经 `DefaultResourceLoader.loadExtensionFactories`（`resource-loader.js:741`，`loadExtensionFromFactory`）加载成 `Extension` 后由 `ExtensionRunner` 绑定，`emitBeforeAgentStart`（`extensions/runner.js`）链式调用各 handler。

> **实现已验证（2026-08-29 spike，`server/scripts/spike-pi-embed.ts`）**：改元数据后下一轮 prompt 末尾含新值；未改时逐字节相同（sha256 对比）；`sendCustomMessage(triggerTurn:false)` 不触发回合。

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

> **2026-08-29 spike 后状态更新**（`server/scripts/spike-pi-embed.ts` + 原始 HTTP 探针）：

1. ~~DashScope 专属端点是否接受 pi 默认 `developer` role 与 `reasoning_effort`~~ **已验证**：`developer` role 被 400 拒绝（`developer is not one of ['system', 'assistant', 'user', 'tool', 'function']`）→ 需 `compat.supportsDeveloperRole: false`；`reasoning_effort`/`enable_thinking` 均 200 接受；SDK 全链路配 `thinkingFormat: "qwen"` 跑通（工具调用 `finish_reason: "tool_calls"` 正常，#19 验证项 1 的 `tool_execution_start` 真发出）。模型 id `qwen3.7-plus` 与 `qwen-plus` 均可用。
2. `ProviderConfigInput`（编程注册 provider 的内部类型名）未从包根导出；根导出的是 `ProviderConfig`。TS 中建议直接用根导出的 `ProviderConfig` 类型或内联对象，避免 import 内部路径。
3. ~~同名覆盖建议验证~~ **已验证**：自定义 `read` 工具 + `noTools: "builtin"` 下模型调用命中自定义实现（E2E 返回脚本行文本，非文件内容）。
4. ~~Layer 2 每轮覆盖生效~~ **已验证**：改元数据后下一轮 prompt 末尾含新值；未改时逐字节不变（sha256）；base prompt 建会话算一次不变。
5. ~~InlineExtension 绑定路径确认~~ **已验证**：factory 形状（`(pi) => { pi.on("before_agent_start", ...) }`）经 `DefaultResourceLoader` 的 `extensionFactories` 注册后每轮触发；注意 `{ name, setup(api) }` 形状在 0.84.4 不存在（§6.3 已修正）。

---

## 修订记录

- **2026-08-29（实现期，#26 M3 落地后）**：
  - **§6.2 要点 8**：手写空 loader 定案改为 `DefaultResourceLoader` + 选项（systemPrompt + 全关 discovery + extensionFactories），并记录「必须 `await loader.reload()`」的坑。
  - **§6.3**：修正 v0.84.4 的 `InlineExtension` 形状——是 `ExtensionFactory`（`(pi) => { pi.on(...) }`）或 `{ name, factory }`，**不是** `{ name, setup(api) }`（早期草稿形状不存在）。
  - **附录验证项**：1/3/4/5 已由 spike + E2E 验证（DashScope compat、同名覆盖、Layer 2 覆盖、factory 绑定）。
  - 实现记录：writer 模块全套（`server/src/modules/writer/`）+ E2E 通过；spike 保留在 `server/scripts/spike-pi-embed.ts`（`npm run spike -w server`）。
- **2026-08-29**（重新核对 v0.84.4 源码，对应 #26 重新讨论）：
  - **修正**：`getSystemPrompt()` 非每轮调用；每轮动态拼 prompt 的钩子是 `before_agent_start`（Layer 2）。新增 §6.0。
  - **§3.3**：会话架构从「`SessionManager.create` 单点建/恢复」改为 `Map<episodeId, AgentSession>`（懒建/恢复，共享 `modelRuntime`+`settingsManager` 单例，per-episode loader/sessionManager/customTools）；明确不用 `createAgentRuntime`（单当前会话=CLI 形态，不合 web 并发；`abort`+ChangeSet 已逼会话驻留）。
  - **§6**：system prompt 从「空 loader + `getSystemPrompt` 返硬编码串」改为 **Layer 3 静态种子（前五层）+ Layer 2 `before_agent_start` 每轮覆盖第六层（当前 DB 元数据，末尾、覆盖不累加）**；新增 §6.1/§6.2/§6.3 与 InlineExtension 注册。
  - **TL;DR（§0）**：同步更新会话架构与 system prompt 组装两行。
  - 决策详情见 #26 评论（https://github.com/clerimia/AIPodCast/issues/26#issuecomment-5460672700）。
