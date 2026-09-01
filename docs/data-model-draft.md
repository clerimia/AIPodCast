# 数据模型草稿（重构后，供实现时对照）

> 实现细节，不进 CONTEXT.md。落地时以 drizzle schema 为准。

## 单层文本 + 音频素材 + 素材库

一集 = 一份脚本（一组脚本行）+ 一份产物。**脚本行 = 说话人 + 台词 + 指令**（全部文本，活实体）。没有稿件/定稿/多版——合成直接读活脚本（ADR-0001），逐行取/合成**音频素材**，经后期拼接成产物。

```
编辑页（写稿大师，一个 AI 会话）
  工具: read/add/edit/retrieve
  写脚本行（说话人 + 台词 + 指令）
        │
        ▼ 合成（确定性流水线，非 AI，ADR-0005）
  逐行音频素材 → 后期拼接（停顿/语速/响度/时间戳）→ 产物
  素材库（共享 BGM/音效）→ 垫乐层（MVP 只预留模型）
```

## 表结构

```ts
// PostgreSQL 17 (ParadeDB) + drizzle-orm

// ---- 文本层：写稿大师（编辑页会话）的工具面 ----
episodes(        id, ws_id, show_notes text default '' )
// 单集简介：单集级活文本（用户手写/写稿大师会话代笔），合成时快照进产物 notes.md（ADR-0009）
script_lines(    id uuid PK, episode_id FK→episodes, serial, speaker_id, text,
                 instructions text default '',               // 指令：语气/情感/风格（引擎 input.instructions）
                 post jsonb default '{}',                    // 逐行后期覆盖：{ "pause":"短", "speed":"正常" }，空=用集级默认
                 deleted bool default false, updated_at )    // 活实体；无版本；无 TTS 配置字段
change_sets(     id, episode_id, base_version, kind, applied_at, summary )
change_set_ops(  cs_id, seq, op, line_id, payload jsonb )
// 其余文本层：workspaces、speakers、show_metadata、resources、resource_chunks（见下）

// ---- 音频层：合成 + 后期 ----
audio_assets(    id PK, script_line_id FK UNIQUE→script_lines, audio_ref,
                 duration_ms, created_at )
// 音频素材：每脚本行 0..1 份单行音频（clip），原子、跟随脚本行；写稿侧只产出它、不加工它（职责边界见下）；改台词/改指令 → 作废重合成；改停顿/语速 → 只重拼接
asset_library(   id PK, ws_id, kind enum('bgm','sfx'), asset_ref,
                 duration_ms, created_at )
// 素材库：工作间级共享容器，只装 BGM/音效/垫乐，不绑定单集；对白素材不进库（ADR-0006）
post_rules(      id PK, episode_id FK UNIQUE→episodes, pause, speed )
// 集级后期默认规则（停顿档位/语速档位）；脚本行 post 非空时覆盖
conversations(   id, episode_id, kind enum('writer'), created_at )   // 一集一个写稿会话（ADR-0005）
messages(        id, conversation_id, role, content, meta jsonb, created_at )
artifacts(       id, episode_id FK UNIQUE→episodes, kind, audio_ref,
                 transcript_ref, notes_ref, size, created_at )        // 一集 0..1 产物，重新合成替换
```

## 合成（脚本 → 产物）

1. 读目标脚本（script_lines：内容 + 指令，过滤 deleted，按 serial）
2. 逐行查 audio_assets（by script_line_id）：命中复用，未命中调 TTS 合成并回填（试听 = 单行合成入口，同样落素材）
3. 后期拼接：停顿 = 相邻素材间隔（gap，逐行 post 或集级 post_rules）+ 语速变速（atempo）+ 响度归一 → 回填行级时间戳 → 确定性验证
4. 写 artifacts（替换该集旧产物）

## 职责边界（编辑页产出原子片段，拼接与产物归后期）

- **写稿侧只产出原子音频片段**：编辑页下半区（音频工作区）试听 = 单行合成，一个脚本行 → 一份 clip（落 audio_assets）；写稿大师会话只碰文本，不产出音频。
- **写稿侧不加工片段**：不 trim / 不 split / 不自由摆放；片段在写稿侧是原子的、不可再分。
- **拼接与最终产物归后期**：后期（非 AI 确定性流水线）读脚本行 + 已落地素材 + 后期参数 → 拼接 / 停顿 / 语速 / 响度 / 时间戳 → master（artifacts，一集 0..1）。
- **片段编辑（若做）属后期序列层（已预留方向）**：timeline 项引用素材 + 摆放 / 裁剪参数（offset / duration / 重叠 / 交叉淡化）；素材 1:1 与可重合成不变，编辑片段只改序列、不重写源素材。

## 素材语义（音频素材）

- **跟随脚本行**：audio_assets 以 script_line_id 为外键（UNIQUE，每行 0..1 份）。行就是音频的源头（单层模型，无稿件解耦）。
- **破坏素材 = 特定行为重写音频**：
  - 改台词 / 改指令 → 重写该行素材（单行、精准）
  - 强制重新生成 → 显式重写（绕过素材 / 清后重生成）
  - 换音色 / 换 TTS 模型 → 批量重写所有受影响行的素材
  - 改停顿 / 改语速 → 只重拼接，不重写（后期参数，ADR-0004）
- **不做内容寻址**：素材键 = script_line_id；无版本共享（一集只有当前素材）。
- **素材库是共享容器**（asset_library，工作间级）：BGM/音效跨集复用，不绑定单集；对白素材跟随脚本行、不进库（ADR-0006）。
- 素材行随脚本行级联清理（episode → script_lines → audio_assets ON DELETE CASCADE）。

## 关键性质

- **id 与行号**：脚本行有独立 uuid（Agent 操作引用，永不变）。行号 serial（L001）既是序列号也是顺序——重排 / 插入时按序重编。
- **单类行**：只有脚本行（说话人 + 台词 + 指令），活实体；没有稿件行/脚本行之分。
- **删除**：置 deleted=true（逻辑删除），行从视图消失，read 过滤；id 永不重用，上下文引用不悬空。
- **并发守卫**：ChangeSet 带 base_version，与当前版本不符 → 拒绝重生成。
- **写稿大师的 AI 工具面不碰后期**：写稿大师（AI 会话）没有后期工具，够不到音频素材和后期参数；但**编辑页是用户工作台**，下半区是音频工作区（试听/合成/参数），用户可碰（ADR-0005）。
- **会话按对象挂**：写稿大师会话挂 episode（一集一个）。消息进 messages，conversation 是上下文的隔离边界。
- **停顿 / 语速是后期参数**（ADR-0004）：MVP 用默认规则（档位），时间线手动调 gap 是增强。

## 统一读取接口

```
GET /ep/:id/script → 当前脚本（可编辑）：script_lines（过滤 deleted，按 serial）
```

## 资源层（工作间知识库，ADR-0011）

工作间级知识库，让写稿大师 `retrieve` 工具按场景引用资料。`workspaces 1—N resources 1—N resource_chunks`，两条外键均 `ON DELETE CASCADE`（删工作间带删资源与块）。

```
resources(
  id uuid PK,
  ws_id      FK→workspaces ON DELETE CASCADE,    // 工作间级隔离
  title      text NOT NULL,                      // 展示名（文件名或粘贴时用户填）
  kind       text NOT NULL,                      // 'md' | 'txt' | 'docx' | 'pdf' | 'paste'
  content_md text NOT NULL,                      // markitdown 转换产物（切块与替换的唯一真相源）
  content_hash text NOT NULL,                    // sha256(content_md)：同工作间重复摄入提示
  char_count integer NOT NULL,
  created_at, updated_at
)

resource_chunks(
  id uuid PK,
  resource_id  FK→resources ON DELETE CASCADE,   // 删资源级联删块
  seq          integer NOT NULL,                 // 资源内顺序
  heading      text NOT NULL default '',         // 标题路径（「第三章 > 3.1 背景」）
  content      text NOT NULL,
  embedding    vector(1024),                     // 可空——见「摄入 / 向量化」边界
  created_at
)
```

**索引：**
- `resource_chunks_resource_seq_idx`：`(resource_id, seq)`（drizzle 自动建）
- `resource_chunks_bm25`：`USING bm25 (id, content) WITH (key_field='id', text_fields='{"content": {"tokenizer": {"type": "chinese_compatible"}, "record": "freq"}})`（手写，见迁移 0003 末尾）
- `resource_chunks.embedding` 不建 ANN（小语料精确余弦 `<=>` 即可）

**摄入 / 向量化边界（核心）：**

- **摄入**（`POST /:wsId/resources`、`POST /:wsId/resources/:rid/replace`）：**不调 embedder**——切块即落库，所有 chunk `embedding=NULL`，资源级状态 = `'pending'`。理由：①入库即时返回；②不消耗 DashScope 额度；③UX 干净（无 `embedWarning`）。
- **向量化**（`POST /:wsId/resources/:rid/embed`）：用户在前端「向量化」按钮显式触发；同步等结果。失败块 `embedding` 保持 NULL，可重试。资源级 `embeddingStatus` 派生（不持久化）：
  - `pending` — 全部 NULL（刚摄入、用户关通道、或部分失败后再次失败）
  - `partial` — 部分块有向量
  - `done` — 全部块有向量
- **替换**：内容变了旧向量失效，新块 `embedding` 强制 NULL（状态回 `pending`），用户必须重新点「向量化」。

**检索形态**（`RETRIEVAL_MODE` / `retrieve` 工具 `mode` 参数）：

- `hybrid`（缺省）= BM25 + 向量双通道，应用侧 RRF 等权融合（`score = Σ (1/(60+rank) / hits.length)`）取前 5。等权归一：库中 90% 资源没向量时，BM25 20 块的累加会把向量 2 块挤出 top-5；归一后两通道权重对等。
- `bm25` = 纯全文（专名/编号精确，省额度）。
- `vector` = 纯语义（近义改写召回）。
- 任一通道失败自动降级（向量失败 → 纯 BM25；库内全无 embedding → 纯 BM25）。
- BM25 查询形状：`id @@@ paradedb.match('content', $query)` + `paradedb.score(id)`（pg_search 0.25.4 绑定，升级时重跑 `server/scripts/spike-bm25.ts`）。

**不持久化 `embeddingStatus`**：用户主动「关通道」时状态自然回到 `pending`（与刚摄入视觉一致）；切换 `RETRIEVAL_MODE` 不重摄入——开关在检索层。


## 已定边界

- 用户修改先暂存、确认（提交改动）后才持久化；确认门也把"改台词/改指令触发重合成"的成本挡在一次到位之后（ADR-0003）。
- 音色不随内容冻结：重新合成跟随当前说话人配置（ADR-0001）。
- 微调 = 改指令（文本，触发重合成）+ 改后期参数（停顿/语速，只重拼接）。
- 产物是独立实体（artifacts 表），一集 0..1 产物，重新合成替换。
- 产物 master = mp3 44.1k 单声道 192k（#7：引擎 24k mono 重采样至 44.1k；wav/opus 留作增强）；行级文稿 = 脚本行 + 计算时间戳（JSON，随产物存 transcript_ref，播放器高亮当前行）。
- 素材与产物都存本地文件系统（#8）：audio_ref/transcript_ref/notes_ref = 相对 MEDIA_ROOT 的相对路径，DB 不存二进制；目录 `media/ws-{id}/ep-{id}/assets/{line_id}.wav` 与 `.../artifacts/{master.mp3, transcript.json, notes.md}`；替换先写临时文件再原子 rename。
- 单集简介 = episodes.show_notes 单集级活字段（可空、用户手写、写稿大师可会话代笔），合成时快照进产物 notes.md、重新合成保留；MVP 不自动生成（#11）。
- 引擎输出固定 wav 24k mono；指令式合成（qwen3-tts-instruct-flash），请求体只有 input{text, voice, language_type, instructions, optimize_instructions}，无 parameters（`docs/research/qwen3-tts-instruct-flash.md`）。
