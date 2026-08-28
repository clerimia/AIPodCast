# Qwen 端点探针实测：北京业务空间专属端点的模型可用性

> 探针日期：2026-08-28（本地时间）。用途：核实 `docs/research/qwen-text-model-lineup.md` 遗留的待核实项——`DASHSCOPE_BASE_URL`（北京业务空间专属端点）上实际开通了哪些文本生成模型。
> 探针脚本：`scripts/llm_endpoint_probe.mjs`（Node 22 内置 fetch，可重复运行，Key 从 `.env` 读取、不打印）。
> 端点：`https://llm-3xmgkuxxgaorb0ho.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/chat/completions`。

## 一句话结论

**默认 `qwen3.7-plus` 与 fallback 链 `qwen3.7-flash` → `qwen-plus` 全部成立，无需修正。** 四个候选模型在该专属端点上均实际可用，且全部通过「强制工具调用（`enable_thinking:false` + 强制 `tool_choice`）」与「流式 SSE」两类验证。

## 实测结果表

| 模型 | 可达性 | 工具调用 | 流式 | 备注 |
|---|---|---|---|---|
| `qwen3.7-plus` | 200 OK | 通过（返回 `get_current_time` tool_call） | 通过（54 chunks，`finish_reason=stop`） | 默认模型成立 |
| `qwen3.7-flash` | 200 OK | 通过 | 通过（88 chunks，`stop`） | 成本降档成立 |
| `qwen-plus` | 200 OK | 通过 | 通过（8 chunks，`stop`） | 旧主线兜底成立 |
| `qwen-flash` | 200 OK | 通过 | 通过（9 chunks，`stop`） | 成本兜底也成立 |

> 全部 8 次调用（4 模型 × 2 类）均 HTTP 200，无 404 / 401 / 403 / 5xx。

## 探针方法（以实际 HTTP 响应为准）

对每个候选模型各发两类请求（OpenAI 兼容 chat/completions）：

1. **可达性 + 工具调用**：`stream:false` + `enable_thinking:false` + `tools`（极简自定义 function `get_current_time`，空参数）+ `tool_choice:{"type":"function","function":{"name":"get_current_time"}}` 强制调用。判定：HTTP 200 且 `choices[0].message.tool_calls` 命中 `get_current_time`。
2. **流式**：`stream:true` + 极短 prompt「回复：ok」。判定：HTTP 200、SSE 逐 chunk 返回 `delta.content`、最终 `finish_reason=stop`。

失败分类：按 HTTP 状态码区分 404（模型不存在/未开通）、401（鉴权）、403（无权限）、5xx（服务端）、其他。

## 实测发现的关键细节

1. **四个模型全部开通、全部支持工具调用与流式**：官方清单中的全量模型在该专属业务空间端点上一一命中，选型无需担心「部分模型未开通」。

2. **`enable_thinking:false` 放在 JSON 顶层即可**（curl/Node 场景，非 Python SDK 的 `extra_body`），四模型均接受且正常返回非思考模式响应——与研究结论一致。

3. **强制 `tool_choice` 在 `enable_thinking:false` 下生效**：四模型均返回了指定工具的 `tool_calls`（`function.arguments` 为 `{}`，符合空参数 schema）。

4. **非流式强制工具调用的 `finish_reason` 是 `"stop"` 而非 `"tool_calls"`**（实测原始响应：`choices[0].finish_reason:"stop"`，同时 `message.tool_calls` 正常返回）。这是本端点的行为差异——**agent 判定「模型要调工具」应检查 `message.tool_calls` 数组是否非空，而非依赖 `finish_reason === "tool_calls"`**，否则会误判为普通文本回复。

5. **流式行为**：四模型均按 SSE 逐 chunk 返回，末个 chunk `finish_reason=stop`。`qwen3.7-plus/flash` 的 chunk 数（54/88）明显多于旧主线（8/9），仅反映同一短回复的分块粒度，不代表质量差异。

6. **延迟（单次采样，非基准测试，仅供参考）**：工具调用首字/整次耗时 `qwen3.7-plus` 约 4.0s、`qwen3.7-flash` 约 0.23s、`qwen-plus` 约 0.50s、`qwen-flash` 约 0.26s。3.7-plus 明显更慢但属首推「要质量」档；3.7-flash 与旧 flash 档延迟接近、成本更低，契合「成本/延迟敏感」需求。

## 结论对选型的影响

- 默认 `qwen3.7-plus`：**成立**（能力/成本均衡，1M 上下文，FC + 流式实测通过）。
- fallback `qwen3.7-flash` → `qwen-plus`：**成立**（二者均在端点可用，均为 1M 上下文 + FC + 流式）。
- 额外确认：`qwen-flash` 也可用，可作为更底的成本兜底（若未来需要）。
- 唯一的实现注意点是上文第 4 条：工具调用判定以 `message.tool_calls` 为准，不要依赖 `finish_reason`。
