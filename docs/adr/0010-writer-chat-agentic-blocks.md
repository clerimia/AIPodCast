# 写稿大师聊天流：AI Elements 三块组件 + 思考开关

**Status**: accepted

**写稿大师聊天流**（编辑页 AI 会话）的气泡从纯文本升级为三种可区分的块，组件以 AI Elements（shadcn registry 源码注入，无运行时包）单点引入：

- **文本块**：`message`（底层 streamdown）——assistant 正文流式 markdown 渲染，修掉现状「markdown 源码直出」；
- **思考块**：`Reasoning`——AI 思考过程，可折叠；
- **工具调用块**：`Task`——read/add/edit 步骤的可折叠清单，替换现状「使用 tool：summary」小字行。

**思考链路**（本 ADR 重划 M6「后端一行不动」边界，用户定案）：

- 打开思考：`session.ts` 的 `THINKING_LEVEL = 'off'` 是配方默认值的沿用、非记录决策；改为运行时可切，模型 `reasoning: true` + `thinkingFormat: 'qwen'` 现成。
- 转发：SSE 词汇（`web/src/lib/api/types.ts` + `server/src/modules/writer/sse.ts`）新增 `thinking` 事件，转发 SDK `message_update` 的 `thinking_delta`（配方 §4.3）。
- 回放：`history.ts` 回放 assistant 消息时补 thinking 块（现状 `textContentOf` 只挑 text、思考被丢）。
- **思考开关**：聊天界面用户开关，默认关（与现状行为一致）、localStorage 持久化；每条消息经 `POST /writer/messages` 参数 → `session.setThinkingLevel()`（SDK 现成 API，agent-session.d.ts:475）即时生效。

**不引入**：AI SDK 数据层（useChat/UIMessage，自研 writer-run store 保持）；@ant-design/agentic-ui 与 @ant-design/x 2.x（antd 设计系统接管 + React 19 补丁，与 Tailwind v4 + shadcn 冲突，调研即建议出局）。M6 其余交付物（进度/取消、seek 高亮、rAF 合帧、toast）仍自建——两候选均无现成物。

**Why**:

- **适配成本排序（调研资产 §4）**：现状自建 < AI Elements 仅展示层 < AI SDK 数据层 < agentic-ui。三块区分是产品要求，展示层单点是满足它的最低成本档；再上一档（数据层）在收尾期纯负收益。
- **POC 实证**：`message` 在真实栈（Vite 8 + React 19.2 + Tailwind v4 CSS-first + 自研 SSE store）有条件可用——构建/流式/暗色/与 rAF 合帧不冲突全部实测通过，条件均为一行级小改；`Reasoning`/`Task` 同 registry 装法，实施时先小验证。
- **思考块的数据此前不存在**：`THINKING_LEVEL='off'` 从建库起就在，后端从未发过思考内容；SDK 事件、切换 API、端点思考格式全是现成物，改动面小且完全可逆（开关关 = 无思考事件，前端自然退化为两块）。
- **bundle 代价本地无感**：裁 `{cjk, code}` 后 eager 约 +212 kB gzip，单用户本地应用从 localhost 加载。

**Consequences**:

- web：注入 `message`/`Reasoning`/`Task` + 伴生 ui 件；`@source` 五行走 workspace 路径（`../../node_modules/...`）；插件裁 `{cjk, code}`（删 math/mermaid import）；`ai@7` 移类型依赖；外链保持默认 link-safety 拦截。
- server：`sse.ts` thinking 转发 + `history.ts` 回放补块 + messages 路由收开关参数（`session.setThinkingLevel`）；后端一行不动边界就此重划。
- 开思考后回复延迟增加（先想后写）；若写稿质量/延迟不可接受，开关默认关即回退路径，组件层无需改动。
- #29 交付物与验收同步更新；实施由 #29 承担。

**资产**：调研 `docs/research/agentic-ui-selection.md`（#32）；POC 分支 `prototype/ai-elements-message`（#33，截图+构建清单）；决策票 #34（wayfinder 地图 #31）。
