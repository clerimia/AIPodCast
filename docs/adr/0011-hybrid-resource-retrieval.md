# 资源检索：摄入与向量化解耦 + 三模式 RRF 融合

**Status**: accepted

**Date**: 2026-08-31（最初）/ 2026-09-01（增订「摄入/向量化解耦 + 第三模式」）

> 资源模块的检索选型与「摄入/向量化」动作边界的合并 ADR。原 0011 草案描述「双通道混合 + best-effort 同步 embed」已被 `b751468` 推翻——本 ADR 是当前实现的事实记录。

## 背景

工作间级知识库要让写稿大师引用资料。两个独立的动作混在一起会出现问题：

1. **检索形态**：单一通道不够好——BM25 抓专名/编号精确但缺语义泛化；纯向量对术语反而不稳；语料小不值得上 ANN 或外部检索服务。
2. **「让素材入库」（摄入）和「给素材补向量」（向量化）是两件事**。原草案让摄入同步调 embedder，结果是：①每摄入一份资料都要消耗 DashScope 额度，即便用户暂时不用检索；②`embedWarning` 警告（部分块向量化失败）破坏入库交互；③「开关」的语义在资源级（删向量）不优雅。

## 决定

### 检索：双通道 + 应用侧 RRF 融合（融合方式修正）

- **三模式**（`RETRIEVAL_MODE` 与 `retrieve` 工具的 `mode` 参数二选一表达）：
  - `hybrid`（缺省）= BM25 + 向量双通道；
  - `bm25` = 纯全文（专名/编号/型号精确命中，省 DashScope 额度）；
  - `vector` = 纯语义（近义改写召回，BM25 漏召回场景）。
- **BM25 通道**：pg_search（ParadeDB pg17，0.25.4）的 BM25 索引，`chinese_compatible` 分词；查询形状 `id @@@ paradedb.match('content', $query)` + `paradedb.score(id)`（参数化查询天然免注入；不走 `parse`/Lucene 字符串）。
- **向量通道**：pgvector 精确余弦 `<=>`（小语料不建 ANN）。embedding = DashScope `text-embedding-v4` 1024 维，compatible-mode 端点。
- **应用侧 RRF 融合**（等权归一）：`score = Σ (1/(60 + rank) / hits.length)`，每通道贡献先除以该通道命中数再相加。空通道跳过。
  - **为什么等权归一**：库中 90% 资源没向量时，BM25 通道 20 块累加会把向量通道 2 块挤出 top-5；等权归一让两通道权重对等，向量 top-1 稳居融合前部。
- **取前 5** 作为结果。
- **降级**：向量通道任何环节失败（无 key / 超时 / 形状异常）→ 自动退化为纯 BM25，不报错。

### 摄入 / 向量化：动作解耦

- **摄入**（`POST /:wsId/resources`、`POST /:wsId/resources/:rid/replace`）：只切块 + 落库，**不调 embedder**。所有 chunk 的 `embedding` 列 NULL，资源级状态 = `'pending'`。
  - 优点：入库即时返回、不消耗额度、UX 干净（无 `embedWarning`）。
- **向量化**（`POST /:wsId/resources/:rid/embed`）：用户在前端「向量化」按钮显式触发；同步等结果。返回 `{ status, failedCount, chunkCount }`。
  - 资源级 `embeddingStatus` 派生（不持久化）：
    - `pending` = 全部 NULL（刚摄入、用户关通道、或中途失败被覆盖）
    - `partial` = 部分块有向量（中途失败遗留）
    - `done` = 全部块有向量
  - 优点：按需向量化、失败块可重试（再次点「向量化」覆盖 NULL）、开关在检索层（不影响向量列本身）。
- **替换**：内容变了旧向量失效，**新块 embedding 强制 NULL**（状态回 `pending`）——用户必须重新点「向量化」。

### 文件摄入

- `.md` / `.txt` 直读；`.docx` / `.pdf` → 临时文件 → 子进程 `uvx --from 'markitdown[docx,pdf]' markitdown <file>`（stdout = markdown，60s 超时，注入 `PYTHONIOENCODING=utf-8` / `PYTHONUTF8=1` 修 Windows 编码）。
- 转换在路由层完成（先成功、后落库），失败时事务回滚，零库行残留。

### 检索工具面

写稿大师 `retrieve` 工具的 `mode` 参数：`hybrid`（缺省）/`bm25`/`vector`。模型可按场景选通道（专名 → bm25；近义 → vector；一般 → hybrid）。闭包锁 `wsId`，物理上翻不出本工作间。

## 后果

- 检索质量 = 两通道之和；任一通道失效自动退化为纯 BM25。
- 摄入即时返回（<1s 量级，含 markitdown 子进程除外）；向量化在用户显式触发时执行，**调用方感知耗时**（前端 toast 区分 done / partial / pending）。
- 切换 `RETRIEVAL_MODE` 不需要重摄入——开关在检索层。
- 升级 ParadeDB 时重跑 `server/scripts/spike-bm25.ts`（0.25.4 的 `paradedb.match`/`paradedb.score(id)` 形状已绑版本）。
- 精确余弦扫描随块数线性增长；到 ~10⁵ 块量级再评估 ANN（pgvector ivfflat/hnsw）。
- `resource_chunks_bm25` 索引语法：`chinese_compatible` 分词；查询 `id @@@ paradedb.match('content', $query)`；分词失败/版本升级须同步改迁移与 `retrieve.ts`。

## 资产

- 设计文档：`docs/superpowers/specs/2026-08-31-knowledge-retrieval-design.md`
- 实现计划：`docs/superpowers/plans/2026-08-31-knowledge-retrieval.md`（15 任务，task15 = 本 ADR + 文档同步 + 回归收尾）
- spike 结论：`docs/research/knowledge-retrieval-spikes.md`（BM25 0.25.4 形状变更 / 403 insufficient_quota / markitdown extras）
- 数据模型：`docs/data-model-draft.md` 资源层
- 重构提交：`b751468 feat(resources): 摄入与向量化解耦 + 检索工具面 mode 三选`（决策源头与完整 diff 在 commit message）
