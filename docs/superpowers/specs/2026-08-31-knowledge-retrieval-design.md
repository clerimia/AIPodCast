# 知识摄入与检索（资源模块）设计

> 日期：2026-08-31
> 状态：已与用户对齐（brainstorming 定案），待实现
> 来源：`CONTEXT.md` 已定义「资源 (Resource)」与「retrieve」工具（此前只有领域定义，无实现）；`docs/data-model-draft.md` 已预留 `resources + chunks(pgvector)`；`docker-compose.yml` 已选 ParadeDB 镜像（自带 pg_search BM25 + pgvector，「资源检索出界回来时零迁移」）。

## 一句话

工作间级知识库：文件上传 / 文本粘贴 → markitdown 统一转 markdown → 切块 → 批量 embedding → 落库（pg_search BM25 + pgvector 双索引）；写稿大师新增第四个工具 `retrieve`，双通道检索 + 应用侧 RRF 融合，向量通道可配置降级。

## 目标与非目标

**目标**：

- 补上「素材进 → 检索引用 → 写稿」的第二条闭环，写稿从凭空生成变为有据可查
- 兑现 `CONTEXT.md` 工具面 `read / add / edit / retrieve` 的最后一件
- 向量通道可配置（`RETRIEVAL_MODE`），关闭/失败时优雅降级为纯 BM25

**非目标（二期或不做）**：

- 网页链接摄入（抓取/反爬）
- 跨工作间「复制到」（`CONTEXT.md` 预留，暂不实现）
- 摄入异步任务化（同步够用；大文档超时直接报错）
- ANN 索引（小语料精确余弦即可）
- 资源内容在线编辑（要改就替换，既定语义）
- 单集级检索范围收窄（工作间级隔离 + 检索相关性已够）

## 已定决策（brainstorming 结论）

| 决策点 | 结论 | 理由摘要 |
|---|---|---|
| 隔离边界 | **工作间级** | `CONTEXT.md` 定案；素材为一档节目服务，跨单集复用；与说话人/节目元数据同粒度 |
| 检索形态 | **BM25 + 向量双通道，应用侧 RRF 融合** | 纯函数可单测、可降级；专有名词靠 BM25，语义靠向量 |
| 向量可配置 | **开关放检索层，不放摄入层** | 摄入永远尽力 embed（失败置 NULL）；切换开关零重摄入成本 |
| 首期格式 | **.md / .txt / .docx / .pdf** | 播客资料现实构成；docx/pdf 经 markitdown CLI 转 markdown |
| 摄入入口 | **文件上传 + 粘贴建资源** | 粘贴进聊天是一次性上下文（已有），摄入的粘贴 = 持久化为资源 |
| 更新语义 | **显式替换**；资源不可编辑；删除级联删块 | 语义直白，无魔法覆盖，实现 = 单事务重建 |
| 摄入时序 | **同步**（一次请求内完成） | 小语料几秒内完成；不为等待引入任务表 + 状态机 |
| 中间格式 | **markdown 唯一真相源** | 标题是天然切块边界；原二进制不落盘 |

## 架构与模块边界

新增后端模块 `server/src/modules/resources/`：

```
resources/
  routes.ts     REST：列表 / 详情 / 删除 / 上传摄入 / 粘贴摄入 / 替换
  service.ts    CRUD + 摄入事务编排（先转换成功、后落库，不留脏数据）
  convert.ts    文件 → markdown：.md/.txt 直读；.docx/.pdf 子进程调
                markitdown CLI（uvx），超时 + 失败语义；与
                post/ffmpeg.ts 的子进程模式同构
  chunk.ts      纯函数：markdown 感知切块（标题边界优先 + 长度上限
                + 重叠），记录标题路径
  embed.ts      DashScope text-embedding-v4 批量 embedding HTTP
                （与 synthesis/tts.ts 同款 fetch 风格）
  retrieve.ts   检索服务：BM25 查询 + 向量查询 + RRF 融合（纯函数）；
                受 RETRIEVAL_MODE=hybrid|bm25 控制（默认 hybrid）
```

**依赖方向**（延续「单向依赖、模块 wiring 即边界」）：

- `resources` 只依赖 `db/`，不碰 writer / script / synthesis / post / artifacts
- `writer → resources`：`makeWriterTools` 增加第四件工具 `retrieve`，进程内直调 `retrieve.ts` 检索函数（与 `writer → script` 同模式）；检索是只读路径，「AI 不碰音频」边界不变
- 前端 `web/src/features/resources/` 只走 REST

## 数据模型

两张新表，一次迁移建齐（坐实 data-model-draft 预留）：

```ts
resources(
  id uuid PK,
  ws_id        FK→workspaces, ON DELETE CASCADE,   // 工作间级隔离
  title        text NOT NULL,      // 展示名（文件名或用户填）
  kind         text NOT NULL,      // 'md' | 'txt' | 'docx' | 'pdf' | 'paste'
  content_md   text NOT NULL,      // 转换后 markdown 规范文本（切块真相源）
  content_hash text NOT NULL,      // sha256(content_md)，重复摄入提示用
  char_count   integer NOT NULL,
  created_at, updated_at
)

resource_chunks(
  id uuid PK,
  resource_id  FK→resources, ON DELETE CASCADE,    // 删资源级联删块
  seq          integer NOT NULL,   // 资源内顺序
  heading      text NOT NULL default '',  // 标题路径（「第三章 > 3.1 背景」）
  content      text NOT NULL,
  embedding    vector(1024),       // 可空：embedding 失败/离线为 NULL，
                                   // BM25 不受影响；1024 = text-embedding-v4 默认维度
  created_at
)
```

索引：

- `resource_chunks.content`：pg_search BM25 索引（tantivy，含 CJK 分词）——具体建索引语法见验证项 1
- `resource_chunks.embedding`：**不建 ANN 索引**，小语料用精确余弦（`<=>`）

## 摄入数据流（同步）

```
POST /ws/:id/resources            multipart 文件 或 JSON { title, text }（粘贴）
  ├─ 校验：扩展名白名单 .md/.txt/.docx/.pdf；单文件 ≤ 20MB；
  │        粘贴文本非空且 ≤ 200,000 字符
  ├─ 转换：.md/.txt 直读；.docx/.pdf → 写临时文件 →
  │        子进程 `uvx markitdown[pdf] <file>`（stdout = markdown，
  │        60s 超时）；失败 = 400 可读错误，清理临时文件，零库行残留
  ├─ 切块（chunk.ts 纯函数）：按 markdown 标题切节，节内超长再按
  │        段落切；目标 ~400 字 / 重叠 ~50；每块记录标题路径
  ├─ embedding（embed.ts）：批量调 DashScope text-embedding-v4；
  │        失败/离线 → 该批块 embedding 置 NULL，不阻断
  └─ 单事务：insert resources + resource_chunks → 返回摘要
             （embedWarning 提示未向量化的块数）

POST /ws/:id/resources/:rid/replace   显式替换：同管道，事务内删旧块 + 写新块
                                      （中途失败回滚，旧资源原样保留）
DELETE /ws/:id/resources/:rid         级联删块
```

重复摄入提示：`content_hash` 命中同工作间已有资源时，响应带提示字段（不阻断，尊重用户决定）。

## 检索管道与 `retrieve` 工具

```
retrieve(query)
  ├─ 空库短路：工作间无资源 → 直接回「本工作间还没有资源」
  │           （防模型反复空检索，同说话人清单引导手法）
  ├─ BM25 通道：pg_search 查 resource_chunks，top k1 = 20
  ├─ 向量通道（RETRIEVAL_MODE=hybrid 且 query embedding 成功）：
  │           query embedding 与块向量精确余弦，top k2 = 20；
  │           embedding 为 NULL 的块天然不参与
  ├─ RRF 融合（纯函数）：score = Σ 1/(60 + rank)，按 chunk id 归并；
  │        单通道时退化为该通道排序
  └─ 返回 top-5，格式：《资源标题》> 标题路径：块文本
```

**工具面**（`makeWriterTools` 第四件）：

- 参数：`query: string`（TypeBox）；作用域由闭包 `wsId` 锁死，物理上翻不出本工作间（同 read/add/edit 锁 episodeId 手法）
- 工具描述：「检索本工作间的资源资料。涉及事实、数据、背景时先检索，引用检索结果写稿。」
- 返回带出处（资源标题 + 标题路径），模型可引用

**第六层 prompt 增强**：`before_agent_start`（Layer 2）的元数据层追加当前工作间资源清单（仅标题 + 字符数）——模型不检索也知道库里有什么，避免盲检；复用已验证的 Layer 2 机制，对提示词缓存的影响只在末尾增量。

## 前端

`web/src/features/resources/`，挂在现有工作间设置页：

- 设置页新增「资源」标签（与节目元数据、说话人并列）：资源列表（标题 / 来源徽标 / 字符数 / 块数 / 向量覆盖率 / 创建时间）
- 上传按钮：文件选择，限 .md/.txt/.docx/.pdf；「粘贴文本」对话框：标题 + 文本域
- 每行操作：替换（文件选择后确认）/ 删除（确认对话框）；**无内容编辑入口**
- 上传/替换期间按钮禁用 + loading；embedding 部分失败用 toast 提示（「已入库，但 N 个块未生成向量」）
- 数据获取沿用 TanStack Query + `lib/api` 封装模式
- 单集编辑页零改动（`retrieve` 幕后工作）；首页/编辑页不加资源入口（设置页是唯一管理面）

## 错误处理与降级

| 失败点 | 行为 |
|---|---|
| 格式不支持 / 超大小上限 | 400 可读错误；前端白名单先拦一道 |
| markitdown 转换失败 / 超时（60s） | 400「文件解析失败」；临时文件清理，零库行残留 |
| embedding 批量调用失败 | 不阻断：块落库、embedding 置 NULL，响应带 `embedWarning` |
| `RETRIEVAL_MODE=bm25` 或库内全无 embedding | 检索自动走纯 BM25，无错误 |
| 检索空库 | `retrieve` 返回「本工作间还没有资源」引导语 |
| 替换中途失败 | 事务回滚，旧资源与旧块原样保留 |

环境变量：新增 `RETRIEVAL_MODE=hybrid|bm25`（默认 `hybrid`）；embedding 复用现有 `DASHSCOPE_API_KEY` / `DASHSCOPE_BASE_URL`（compatible-mode 端点），无新增凭证。

## 测试策略

照仓库现有风格（真 DB 集成 + 纯函数单测，`server/test/`）：

- **纯函数单测**：`chunk.ts`（标题边界 / 超长切分 / 重叠 / 空文档）、`retrieve.ts` 的 RRF 融合（排序 / 去重 / 单通道降级）
- **集成测试（真 ParadeDB）**：资源 CRUD、替换事务性（中途失败保旧）、级联删块、**中文 BM25 命中**、向量余弦命中（测试可用固定假向量）
- **writer-tools**：`retrieve` 工具形状、作用域隔离（跨工作间查不到）
- **markitdown**：docx/pdf fixture → 转换产物含预期文本（环境无 `uv` 时标记跳过）

## 实现前验证项（spike）

1. ParadeDB 镜像内 `pg_search`：BM25 索引创建语法 + **中文分词实际效果**（tantivy CJK）；不可用时的后备（zhparser / 应用层预切词）
2. DashScope `text-embedding-v4`：compatible-mode 端点请求形状、单次批量上限、维度参数、错误码
3. `uvx markitdown[pdf]`：冷启动时长、CLI 参数与输出形态、失败退出码

## 配套文档更新（实现期一并落）

- 新 ADR：检索选型（双通道混合 + 应用侧融合 + markitdown 转换 + 摄入层尽力/检索层开关）
- `CONTEXT.md`：补「块 (Chunk)」词汇条目（资源的切块检索单位）
- `docs/data-model-draft.md`：落实 resources / resource_chunks 两表
- `docs/modules-and-phasing.md`：续一期（资源摄入与检索里程碑）
- `README.md`：前置要求表加 `uv`（markitdown 运行环境）；环境变量加 `RETRIEVAL_MODE`
