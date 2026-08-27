# 数据模型草稿（未定稿，供实现时对照）

> 实现细节，不进 CONTEXT.md。骨架来自设计讨论，落地时以 drizzle schema 为准。

## 两层产物：稿件（内容）→ 定稿 → 脚本（内容 + 每行 TTS 配置）

```
编辑页 = 写稿大师         脚本页 = 调音大师
工具: read/add/edit/retrieve   工具: tune + 读脚本
写 manuscripts（内容行）       写 scripts.lines[].tts（TTS 配置）
        │                              │
        ▼                              ▼
   稿件(文本+说话人) ──定稿──► 脚本(稿件行+TTS配置) ──调音/合成──► 产物
```

- **写稿层**：稿件（内容）。写稿大师产出，逐行（稿件行 = 台词 + 说话人）。
- **调音层**：脚本 + 产物。定稿从稿件生成脚本（默认 TTS 参数）；调音大师只改脚本行的 TTS 配置，合成读脚本。
- 两个会话平级、互不进入对方上下文；交接点就是定稿生成的脚本。
- **会话跟着对象挂**：写稿大师会话挂 episode（一集一个）；调音大师会话挂 script（一版脚本一个，点开哪版就切到哪个会话）。

## 表结构

```ts
// PostgreSQL 17 (ParadeDB) + drizzle-orm

// ---- 写稿层：写稿大师（编辑页会话）的工具面 ----
episodes(        id, ws_id, manuscript_version bigint )   // 稿件每次改动 +1，写者串行化
manuscript_lines( id uuid PK, episode_id, serial, deleted bool default false,
                 speaker_id, text, updated_at )          // 稿件行：id=Agent 引用；serial(L001) 既是序列号也是顺序；逻辑删除；行无 TTS 配置
change_sets(     id, episode_id, base_version, kind, applied_at, summary )
change_set_ops(  cs_id, seq, op, line_id, payload jsonb )  // update/insert/delete/reorder
manuscripts(     id, episode_id, updated_at )             // 稿件本体（当前内容 = manuscript_lines）
// 其余写稿层：workspaces、resources + chunks(pgvector)、speakers、show_metadata

// ---- 调音层：定稿生成脚本 + 调音大师（脚本页会话）的工具面 ----
scripts(         id, manuscript_id, version_no, snap_id, frozen_at,
                 lines jsonb )                           // 脚本行 = 稿件行 + tts 配置；定稿时冻结内容、给默认 tts
// 会话：调音大师 = 一版脚本一个会话（跟着点开的脚本走）；写稿大师 = 一集一个会话
conversations(   id, episode_id, kind enum('writer','mixer'), script_id uuid null,
                 created_at )                            // kind=mixer 时 script_id 非空且 UNIQUE
messages(        id, conversation_id, role, content, meta jsonb, created_at )  // conversation 是隔离边界
tts_cache(       cache_key PK, audio_ref, created_at )
artifacts(       id, script_id, kind, audio_ref, transcript_ref,
                 notes_ref, size, created_at )           // 脚本 0..1 产物，重新合成替换
```

`scripts.lines` 形如：

```json
[{ "id":"uuid", "spk":"host", "text":"…", "tts":{"pause":"短","tone":"自然","speed":"正常","emotion":"中性"} }]
```

## 定稿（一个事务：写稿层 → 调音层）

1. 校验稿件非空、无待提交改动
2. 由当前稿件内容生成一版脚本：`lines = 稿件行 × { tts: 默认 }`（默认 TTS 参数）
3. 写 scripts（version_no 递增），内容冻结
4. 稿件本体不动（可继续改、再定稿新一版）

## apply_change_set（一个事务，写稿层）

1. `manuscript_version + 1`（行锁 = 写者串行化）
2. 逐 op 更新 manuscript_lines
3. 追加 change_sets（append-only）；仅用户发起的修改作为上下文事件追加，Agent 工具发起的修改不追加（工具返回即所见）
4. 清理被删行的 tts_cache

## 合成（调音层：脚本 → 产物）

1. 只读目标脚本 `lines`（内容 + 每行 tts 配置）
2. 逐行查 tts_cache；命中直接复用，未命中走 TTS 并回填
3. 拼接 · 停顿 · 响度归一 → 回填行级时间戳 → 确定性验证
4. 写 artifacts（替换该脚本旧产物）；更新 hit / need

## 关键性质

- **id 与行号**：行有唯一 uuid（Agent 操作引用，永不变）。行号 serial（L001）既是序列号也是顺序——重排 / 插入时按序重编，供视图与人类引用。Agent 的工具操作一律引用 uuid。
- **两类行**：稿件行 = 台词 + 说话人（写稿层）；脚本行 = 稿件行 + TTS 配置（调音层）。tune 只改脚本行的 tts，不写稿件行。
- **缓存键 = hash(行ID, 文本, 音色, 模型, TTS配置[pause/tone/speed/emotion])，不含位置**：改文本 / 调 TTS 配置自动 miss，重排全命中零成本。
- **read 不重放**：read 工具直接读物质化的稿件行（按行号 serial 排序，过滤 deleted），不从 change_sets 重放历史；change_sets 只做增量上下文通知（ADR-0002）。
- **新增 / 删除**：add 发新 id + 排在末尾续编行号；删除是置 deleted=true（逻辑删除），行从视图消失，read 过滤；id 永不重用，上下文引用不悬空。
- **并发守卫**：ChangeSet 带 base_version，与当前 manuscript_version 不符（基于旧视图）→ 拒绝重生成。
- **写稿层不碰调音层**：写稿大师没有 tune 工具，调音大师没有 add/edit 工具；两端通过定稿的脚本交接，零冲突。
- **会话按对象挂**：调音大师会话挂 script_id（一版脚本一个，UNIQUE）——点开哪版脚本，会话就跟到哪版；切换脚本即切换会话，各版 TTS 配置讨论互不串台。写稿大师会话挂 episode（一集一个）。消息进 messages，conversation 是上下文的隔离边界。

## 统一读取接口

```
GET /ep/:id/manuscript    → 当前稿件（可编辑）
GET /ep/:id/scripts?ver=N → 某版脚本（内容 + TTS 配置；内容只读、tts 可改）
```

都序列化为 `{ id, version, lines[], readOnly }`。Agent 工具（read_script / validate_script）也走它。

## 已定边界

- 用户修改是破坏缓存 / 影响上下文的操作：先暂存，确认（提交改动）后才持久化；Agent 用工具发起的修改走工具返回，不追加上下文、不需确认门。
- 音色不随稿件冻结：重新合成跟随当前说话人配置。
- 微调是调音大师的操作：逐行改脚本行的 TTS 配置（停顿 / 语气 / 语速 / 情感），定稿后内容冻结、不可经微调改动；微调不新增版本，只覆盖该版合成输出。
- 审核可指定对象：默认稿件，也支持 validate_script({scriptId}) 审某版脚本。
- 产物是独立实体（artifacts 表），脚本 0..1 产物，重新合成替换。
- 不设"对齐纪要"实体：写稿与对齐共用写稿大师的会话上下文，对齐结论只活在会话里。
