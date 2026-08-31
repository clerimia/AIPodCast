# 知识摄入与检索：实现前验证（spike 结论）

> 2026-08-31；脚本：server/scripts/spike-{bm25,embedding,markitdown}.ts
> 环境：ParadeDB 容器 aipodcast-db（Postgres 17 + pg_search 0.25.4）、uv/uvx 0.11.13（Windows，Git Bash）。
> 本机已装 uv——spike 3 正常执行，无需跳过。

## 1. ParadeDB pg_search BM25 中文

- 建索引语法：计划原样可用（0.25.4 接受）：
  ```sql
  CREATE INDEX spike_bm25_idx ON spike_bm25
    USING bm25 (id, content)
    WITH (key_field='id', text_fields='{"content": {"tokenizer": {"type": "chinese_compatible"}, "record": "freq"}}')
  ```
- **查询形状已变（与计划默认不同）**：旧形状 `WHERE content @@@ '量子'` + `paradedb.score('索引名')`
  在 0.25.4 报错 `could not determine polymorphic type because input has type unknown`（@@@ 左操作数变为
  anyelement，score 函数签名改为 `paradedb.score(relation_reference anyelement)`）。
  实测可用形状：
  ```sql
  SELECT content, paradedb.score(id) AS score
  FROM spike_bm25 WHERE id @@@ paradedb.match('content', '量子') ORDER BY score DESC
  ```
  即：**左操作数 = key_field（id），查询经 `paradedb.match(字段, 词)` 构造，分数取 `paradedb.score(key_field)`**。
- 分词器：chinese_compatible 对中文词命中正常——查询「量子」命中 2/3 条：
  - 0.9490362 量子比特与经典比特的本质区别
  - 0.9224553 量子计算的纠错码是当前工程难点
  多词查询 `paradedb.match('content', '量子 比特')` 返回含任一词的行（默认析取）。
- `paradedb.parse('content:量子')` 对**中文词报错** `could not parse query string 'content:量子'`
  （同样语法对 ASCII `content:hello` 可用）——retrieve.ts 不要走 parse/Lucene 字符串，走 match。
- 特殊字符：`paradedb.match('content', '后期 (流水线)')` 可执行且不报错（match 直接分词，括号不作语法），命中 1 条。
  应用侧清洗仍保留（防其它构造器），但裸 match 本身安全。
- 附带观察：`SELECT count(*)` 与索引同用会出 WARNING `Aggregate Scan not used ... SET paradedb.check_aggregate_scan = false`，不影响结果。
- **对实现的影响**：
  - 迁移 0003 建索引 SQL：否（WITH 参数照抄即可）。
  - retrieve.ts 查询形状：**是**——从 `content @@@ '<清洗后文本>'` + `paradedb.score('<索引名>')`
    改为 `WHERE id @@@ paradedb.match('content', $query)` + `SELECT paradedb.score(id)`
    （id 即索引 key_field；参数化查询天然免注入）。

## 2. DashScope text-embedding-v4

- 端点：`{DASHSCOPE_BASE_URL}/compatible-mode/v1/embeddings`（本机 base 为专属 MaaS 域名
  `https://llm-3xmgkuxxgaorb0ho.cn-beijing.maas.aliyuncs.com`）。
  端点可达、Bearer 认证与请求形状被接受（返回结构化 OpenAI 式错误而非 404/401 形状错）。
- **账户级阻断（本次未能完成数值验证）**：批量 2 / dimensions=1024 请求返回
  `403 {"code":"insufficient_quota","type":"insufficient_quota","message":"Free quota exhausted. To continue accessing the model on a paid basis, please add funds or disable the \"use free tier only\" mode in the management console."}`。
  dimensions=1024 是否被接受：未验证（配额恢复后重跑 `npm run spike-embedding -w server` 即可复测）。
- 单次批量上限：未验证（官方文档限额 10；探 10/11 因同一 403 无法执行）。超限错误码：未验证。
- **对实现的影响**：
  - embed.ts `EMBED_BATCH_SIZE` 暂取 10（官方限额，保守值），配额恢复复测后再定。
  - embed.ts 需把 `403 insufficient_quota` 归为可上报的配置/配额错误（区别于 429 限流重试）。
  - 依赖该端点的后续任务（Task 4 embed.ts 单测的网络部分、Task 10 检索集成测试的向量通道）
    在配额恢复前会失败/需跳过——**需用户先在控制台充值或关闭「仅免费额度」模式**。

## 3. uvx markitdown[pdf]

- 本机 uv/uvx 已安装（0.11.13），spike 3 正常执行。
- **extras 修正（与计划不同）**：裸 `markitdown[pdf]` 对 .docx 报
  `the dependencies needed to read .docx files have not been installed ... include the optional dependency [docx]`，
  退出码 1。正确形态：`uvx --from 'markitdown[docx,pdf]' markitdown <file>`。
- Windows 编码坑：不设环境变量时 stdout 走 locale 码页（本机 GBK），中文乱码；
  注入 `PYTHONIOENCODING=utf-8`、`PYTHONUTF8=1` 后正常。
- 冷启动：首跑（含 PyPI 下载，含一次错误退出）约 49566 ms；uv 缓存建立后热跑
  docx 4888 ms / pdf 1862 ms。摄入任务按「秒级子进程」预算即可，无需常驻进程。
- 参数形态：`uvx --from markitdown[docx,pdf] markitdown <file>`，stdout = 纯 markdown 文本：是。
- 失败退出码：1（如缺依赖/不可解析文件）；stderr 给出可读原因。
- 夹具提取：
  - 最小 docx（fixtures.ts 手写 STORE zip 三件套）：提取成功，两段中文完整输出。
  - 最小 pdf（单页 Helvetica 文本流）：转换不报错（退出码 0），但中文经 WinAnsi Type1 编码
    丢失，输出为 `(cid:NNN)` 占位——**集成测试对该夹具降级断言「转换不报错」，不断言正文内容**；
    需要内容级断言时改用真实样本文件（非手写夹具）。
- **对实现的影响**：
  - convert.ts spawn 参数：**是**——`['--from', 'markitdown[docx,pdf]', 'markitdown', file]`
    且 env 注入 `PYTHONIOENCODING=utf-8`、`PYTHONUTF8=1`。
  - 集成测试：是——pdf 夹具降级断言；具名超时按热跑 ≤10s、首跑 ≤120s 预留。
