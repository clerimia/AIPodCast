# Qwen 文本生成模型选型（DashScope / 百炼）调研

> 调研日期：2026-08-28（UTC）。基于阿里云百炼官方文档（help.aliyun.com/zh/model-studio/）与千问云平台文档，辅以社区第三方信息（已标注）。
> 用途：为「写稿大师」agent 选定底层文本生成 LLM。需求：中文写作优秀、支持 function/tool calling（read/add/edit/retrieve 四工具）、支持流式 SSE、走百炼 DashScope（.env 已配 `DASHSCOPE_API_KEY` + `DASHSCOPE_BASE_URL`）、成本/延迟敏感（单用户本地工作间）。

## 一句话结论

**首选 `qwen3.7-plus`（能力/成本均衡、1M 上下文、完整 Function Calling + 结构化输出 + 流式），成本敏感的降档是 `qwen3.7-flash`（同样 1M 上下文与功能集，价格约为其 1/10）；两者走 OpenAI 兼容接口即可同时拿到工具调用 + SSE 流式。** 推理/思考模式（qwq-plus、enable_thinking=true）对工具型 agent 不是好选择（延迟与成本翻倍，且思考模式下不支持强制指定工具）。另注意：仓库 .env 的 `DASHSCOPE_BASE_URL` 是北京地域业务空间专属端点（`*.cn-beijing.maas.aliyuncs.com`），**该端点实际可用的模型清单需实测探针确认**（官方清单为全量、专属空间可能只开通部分模型）。

---

## 一、模型清单与定位（截至 2026-08-28，官方）

### 百炼「推荐模型」（官方文本生成总览页顶栏）

| 模型 ID | 上下文 | 思考模式 | Function Calling | 内置工具 | 结构化输出 | 定位 |
|---|---|---|---|---|---|---|
| `qwen3.8-max` | 1M | 支持 | 支持 | 支持 | 支持 | 旗舰（2.4T 参数 MoE，最强推理，成本高） |
| `qwen3.7-plus` | 1M | 支持 | 支持 | 支持 | 支持 | **均衡（官方首推）** |
| `qwen3.7-flash` | 1M | 支持 | 支持 | 支持 | 支持 | 轻量低成本（"效果接近旗舰，同上下文同功能"） |

### Qwen 各系列（官方「旧版/历史」与现行清单，节选与本需求相关者）

| 模型 ID | 上下文 | 思考模式 | Function Calling | 内置工具 | 结构化输出 | 备注 |
|---|---|---|---|---|---|---|
| `qwen3-max`（及 preview/2025-09-23/2026-01-23 快照） | 256k | 支持 | 支持 | 支持 | 支持 | **2026-10-10 下线**，替代 `qwen3.7-max` |
| `qwen-plus`（及快照） | 1M | 支持 | 支持 | 支持 | 支持 | 旧主线，仍可用 |
| `qwen-flash`（及快照） | 1M | 支持 | 支持 | 支持 | 支持 | 旧主线，仍可用 |
| `qwen-turbo`（及快照） | 128k | 支持 | 支持 | 支持 | 支持 | 旧主线，**第三方信息称 2026-10-10 下线**（官方未确认） |
| `qwq-plus` | 128k | 支持 | 支持 | 不支持 | 不支持 | 推理专用；**第三方信息称 2026-10-10 下线**（官方未确认） |
| `qvq-max` | 128k | 支持 | 不支持 | 不支持 | 不支持 | 多模态推理 |
| `qwen-long` / `qwen-long-latest` | 10M | 不支持 | 不支持 | 不支持 | 支持 | 超长文档专用，无工具调用 |

> `qwen3-r1`：**未出现在当前官方文本生成模型清单、API 参考与下线清单中**（官方文档 2026-08 快照），无法确认可用，视为已随 Qwen3 主线迭代淡出；推理专用代表模型现为 `qwq-plus`。
> `qwen3.6-flash`/`qwen3.5-plus`/`qwen3.5-flash` 等中间代仍在售（qwen3.6-flash 1M 上下文），但官方推荐已上移至 3.7 系。

### 深度思考（推理模型）现状

- 所有 Qwen3 及以上模型支持"混合思考模式"（`enable_thinking` 逐请求开关），Qwen3 开源版（如 `qwen3-235b-a22b`）与 `qwq-plus`/`DeepSeek-R1` 为"仅思考模式"（无法关闭）。
- 思考内容经 `reasoning_content` 字段返回（流式下先 reasoning 后 content）。

## 二、上下文窗口：中文写作 agent 够不够用（官方确认）

- 1M 上下文 ≈ 70 万汉字 ≈ 10 本小说（官方口径）。常规任务官方建议 128k–256k 已足够；长文档/大型代码库才需要 1M。
- 「写稿大师」的上下文构成：system 提示词 + 节目元数据 + 追加的 ChangeSet + 多轮对话历史。即使素材很大，通常也在几万 token 内；**所有候选模型（≥128k，主推 3.7 系 1M）都远超需要，上下文不是选型约束**。
- 追加式 ChangeSet 场景下 1M 模型（`qwen3.7-plus`/`qwen3.7-flash`/`qwen-plus`/`qwen-flash`）留足余量，且 1M 按阶梯计费（输入 token 越多单价越高，见第五节）。
- 注意：思考模式下上下文要扣掉思维链预算（如 qwen3.7-plus 思考模式最大输入 983,616，思维链上限 262,144）。

## 三、Function / Tool Calling（官方确认，OpenAI 兼容）

- **所有通用模型均支持 Function Calling**（官方明确："Function Calling（自定义工具，模型调用）：所有通用模型均支持"）。本需求的 read/add/edit/retrieve 四工具属于标准自定义 function，无任何障碍。
- OpenAI 兼容格式（与 OpenAI Chat Completions 一致）：
  - `tools: [{type:"function", function:{name, description, parameters(JSON Schema)}}]`
  - `tool_choice`：默认 `auto`；可 `none` / `required` / `{"type":"function","function":{"name":...}}`（强制指定工具）。
  - 返回 `message.tool_calls`（含 `id`、`function.name`、`function.arguments` JSON 字符串），再以 `role:"tool"` + `tool_call_id` 回传结果，支持多轮。
  - `parallel_tool_calls`（布尔）可一次返回多个工具调用。
- **关键坑：思考模式下的模型不支持"强制调用某个工具"**（`tool_choice` 强制指定在思考模式不生效）——工具型 agent 若用思考模式，只能 `auto`。
- 官方提醒：模型输出的入参可能不符合函数签名，调用前需校验参数。
- 内置工具（联网搜索/代码解释器/网页抓取）与自定义 function calling 是两回事，本需求只用自定义工具。

## 四、流式输出（SSE）（官方确认）

- 基于 SSE 协议；**OpenAI 兼容接口设 `stream: true` 即可**，逐 chunk 返回 `choices[].delta.content`，`finish_reason` 最后为 `stop`。
- 流式 + 工具调用：官方文档明确支持——`stream=true` + `tools` 同时开启，工具名在第一个 chunk 返回，参数分块流式返回（`delta.tool_calls`）。
- `stream_options: {"include_usage": true}` 让最后一个 chunk 带 usage（OpenAI 协议默认不返回 token 消耗）。
- 流式 + JSON 结构化输出：`stream=true` + `response_format={"type":"json_object"}` 也支持。
- 官方建议优先流式（非流式长输出有 300s 超时风险）。
- DashScope 原生接口（非 OpenAI 兼容）则是 `X-DashScope-SSE: enable` + `incremental_output: true`；本仓库已用 OpenAI 兼容模式，走 `stream: true` 即可。
- 部分模型（Qwen3 开源版、QwQ、QVQ 等）**仅支持流式**，非流式直接报错——再次支持流式优先。

### OpenAI 兼容端点形态（与本仓库 .env 相关）

- 官方现行 base_url：`https://{WorkspaceId}.{region}.maas.aliyuncs.com/compatible-mode/v1`（北京为 `{WorkspaceId}.cn-beijing.maas.aliyuncs.com`）。旧公共域名 `dashscope.aliyuncs.com` 仍兼容但官方建议迁移到业务空间专属域名。
- 本仓库 `DASHSCOPE_BASE_URL=https://llm-xxx.cn-beijing.maas.aliyuncs.com`（北京业务空间专属端点），OpenAI 兼容调用点 = **`{DASHSCOPE_BASE_URL}/compatible-mode/v1/chat/completions`**。
- `enable_thinking` 等非 OpenAI 标准参数：Python SDK 走 `extra_body={"enable_thinking":...}`，curl/Node 放 JSON 顶层。
- **注意：专属业务空间端点上实际开通了哪些模型，官方清单只保证全量，需用探针实测确认（见第七节建议）。**

## 五、成本对比（官方价格页，华北2·北京，人民币/百万 token，原价）

| 模型 | 输入 ≤32k | 输出 ≤32k | 输入 ≤256k | 输出 ≤256k | 输入 ≤1M | 输出 ≤1M |
|---|---|---|---|---|---|---|
| `qwen3.7-plus` | — | — | 2 元 | 8 元 | 6 元 | 24 元 |
| `qwen3.7-flash` | 0.2 元 | 0.8 元 | 0.6 元 | 2.4 元 | 1.2 元 | 4.8 元 |
| `qwen3.8-flash` | — | — | 0.8 元 | 2.7 元 | 0.8 元 | 2.7 元 |
| `qwen-plus` | — | — | 0.8 元 | 2 元（思考 8 元） | — | — |
| `qwen-flash` | — | — | 0.15 元 | 1.5 元 | 1.2 元 | 12 元 |

- 3.7 系新模型带 **100 万 token 免费额度（开通起 90 天）**；上下文缓存命中输入价再打折；Batch 调用半价。
- 思考模式按"思维链+回答"合并计费且输出单价更高（如 qwen-plus 输出思考 8 元 vs 非思考 2 元）——**工具型 agent 开思考模式成本会明显上升**。
- 结论：单用户工作间量级下，qwen3.7-flash 输出 0.8 元/M token 几乎可忽略成本；qwen3.7-plus 是"要质量"档的最优平衡。

## 六、对中文写作 / 工具型 agent 的选型建议

- **官方口径**（官方文档原文推荐）：内容生成、摘要、文档处理等场景推荐 `qwen3.7-plus`（能力与成本均衡）；确认效果后可用 `qwen3.7-flash` 降本（"效果接近旗舰模型，且拥有相同的上下文长度和功能支持"）；要最强推理再上 `qwen3.8-max`（贵）。
- **中文写作**：Qwen 系列中文指令遵循/创作能力一贯是强项；3.7 系相比 3.5 系在主观创作类任务（qwen-plus 2025-12 快照"主观创作类任务表现更优"的趋势延续）表现更好。写作 agent 建议用 plus 档保证对白/台词质量。
- **工具型 agent 是否用 reasoning 模型**：不建议。理由（官方事实）：① 思考模式不支持强制 `tool_choice`，工具编排可预测性下降；② 思维链输出按更高单价计费且拉长首字延迟（单用户工作间对延迟敏感）；③ 本 agent 只有 4 个工具，属于"轻工具"场景，不需要强推理。开 `enable_thinking=false` 走非思考模式即可（3.7 系默认支持，可混合切换）。
- **备选/兜底**：若专属端点上 3.7 系未开通，`qwen-plus`（1M、FC、思考+非思考）是稳妥次选；`qwen-flash` 是成本兜底。**避免押注即将下线的模型**：`qwen3-max` 官方确认 2026-10-10 下线；`qwen-turbo`/`qwq-plus` 下线为第三方信息（待官方核实）。

## 七、待核实 / 风险（区分来源）

**官方确认**：模型清单、上下文、FC 支持、流式 SSE、思考模式与 `enable_thinking`、价格、`qwen3-max` 2026-10-10 下线、OpenAI 兼容 base_url 形态。

**社区/第三方（未逐项独立核实）**：
- `qwen-turbo`、`qwq-plus`、`qvq-max` 将于 2026-10-10 下线（来源：TheRouter.ai 报道，非官方；官方下线清单仅明确列出 qwen3-max 系列等）。若选型依赖这些模型需再核实。
- 专属业务空间端点上实际开通的模型集合未知——**建议写一个探针脚本**（OpenAI SDK，base_url=`{DASHSCOPE_BASE_URL}/compatible-mode/v1`），对 `qwen3.7-plus` / `qwen3.7-flash` / `qwen-plus` / `qwen-flash` 各发一次含 tools+stream 的调用，确认 404 与否与工具流式行为。

## 出处

- 文本生成模型列表（推荐/各系列/旧版，上下文、FC、结构化输出矩阵）：https://help.aliyun.com/zh/model-studio/text-generation-model/
- 模型信息页：qwen3.8-max https://help.aliyun.com/zh/model-studio/qwen3-8-max ｜ qwen3.7-plus https://help.aliyun.com/zh/model-studio/qwen3-7-plus ｜ qwen3.7-flash https://help.aliyun.com/zh/model-studio/qwen3-7-flash ｜ qwen3-max https://help.aliyun.com/zh/model-studio/model-qwen3-max ｜ qwen-plus https://help.aliyun.com/zh/model-studio/qwen-plus ｜ qwen-flash https://help.aliyun.com/zh/model-studio/qwen-flash
- OpenAI 兼容 Chat Completions（base_url、tools、tool_choice、enable_thinking、流式、max_completion_tokens）：https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions
- Function Calling 指南（tools 格式、tool_choice、parallel_tool_calls、流式工具调用、GLM 需 tool_stream）：https://help.aliyun.com/zh/model-studio/qwen-function-calling
- 流式输出（SSE、stream=true、stream_options.include_usage、思考模型流式、仅流式模型）：https://help.aliyun.com/zh/model-studio/stream
- 深度思考模型用法（enable_thinking、thinking_budget、reasoning_content）：https://help.aliyun.com/zh/model-studio/deep-thinking
- 模型价格：https://help.aliyun.com/zh/model-studio/model-pricing
- 模型下线机制 / qwen3-max 等 2026-10-10 下线：https://help.aliyun.com/zh/model-studio/model-depreciation
- 第三方：百炼 2026-10 下线第三方与历史千问模型路由分析（qwen-turbo/qwq-plus/qvq-max 下线为第三方口径）：https://therouter.ai/zh/news/dashscope-third-party-model-retirement-october-2026-routing/
