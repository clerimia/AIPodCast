# 数据模型草稿（未定稿，供实现时对照）

> 实现细节，不进 CONTEXT.md。骨架来自设计讨论，落地时以 drizzle schema 为准。

## 两层产物：稿件（内容）→ 定稿 → 脚本（内容快照 + 每行 TTS 配置）

```
编辑页 = 写稿大师         脚本页 = 调音大师
工具: read/add/edit/retrieve   工具: tune + 读脚本
写 manuscripts（内容行）       写 script_lines.tts（TTS 配置）
        │                              │
        ▼                              ▼
   稿件(文本+说话人) ──定稿──► 脚本(拷贝的稿件行 + TTS 配置) ──调音/合成──► 产物
```

- **写稿层**：稿件（内容）。写稿大师产出，逐行（稿件行 = 台词 + 说话人）。
- **调音层**：脚本 + 产物。定稿从稿件生成脚本（拷贝 + 默认 TTS 参数）；调音大师只改脚本行的 TTS 配置，合成读脚本。
- 两个会话平级、互不进入对方上下文；交接点就是定稿生成的脚本。
- **会话跟着对象挂**：写稿大师会话挂 episode（一集一个）；调音大师会话挂 script（一版脚本一个，点开哪版就切到哪个会话）。

## 表结构

```ts
// PostgreSQL 17 (ParadeDB) + drizzle-orm

// ---- 写稿层：写稿大师（编辑页会话）的工具面 ----
episodes(        id, ws_id, manuscript_version bigint )   // 稿件每次改动 +1，写者串行化
manuscripts(     id, episode_id, updated_at )             // 稿件本体（当前内容 = manuscript_lines）
manuscript_lines( id uuid PK, episode_id, serial, speaker_id, text,
                 deleted bool default false, updated_at )  // 稿件行：活，可改可删；无 TTS 配置
change_sets(     id, episode_id, base_version, kind, applied_at, summary )
change_set_ops(  cs_id, seq, op, line_id, payload jsonb )  // update/insert/delete/reorder
// 其余写稿层：workspaces、resources + chunks(pgvector)、speakers、show_metadata

// ---- 调音层：定稿生成脚本 + 调音大师（脚本页会话）的工具面 ----
scripts(         id uuid PK, manuscript_id, version_no, snap_id, frozen_at )
// 脚本本体：只挂版本信息；内容全在 script_lines
script_lines(    id uuid PK, script_id FK→scripts, serial, spk, text,
                 tts jsonb )                               // 脚本行：定稿时从稿件行拷贝 + 默认 tts；
                                                            // 内容冻结，调音大师只改 tts；无稿件行指针
tts_cache(       id PK, script_line_id FK UNIQUE→script_lines, audio_ref, created_at )
// 音频缓存：每脚本行 0..1 份单行音频，挂脚本行（与稿件无关）；破坏缓存 = 特定行为重写音频
// 会话：调音大师 = 一版脚本一个会话（跟着点开的脚本走）；写稿大师 = 一集一个会话
conversations(   id, episode_id, kind enum('writer','mixer'), script_id uuid null,
                 created_at )                              // kind=mixer 时 script_id 非空且 UNIQUE
messages(        id, conversation_id, role, content, meta jsonb, created_at )
artifacts(       id, script_id, kind, audio_ref, transcript_ref,
                 notes_ref, size, created_at )             // 脚本 0..1 产物，重新合成替换
```

`script_lines.tts` 形如：

```json
{ "pause":"短", "tone":"自然", "speed":"正常", "emotion":"中性" }
```

## 定稿（一个事务：写稿层 → 调音层）

1. 校验稿件非空、无待提交改动
2. 读当前稿件全部未删行，逐行**拷贝**（serial / speaker_id / text）生成 script_lines（每个新 uuid + 默认 tts）——拷贝是必须、不是冗余：脚本行是"定稿当时内容的存档"，与稿件行后续变化彻底解耦（ADR-0001）
3. 写 scripts（version_no 递增）+ script_lines，内容冻结
4. 稿件本体不动（可继续改、再定稿新一版）

## apply_change_set（一个事务，写稿层）

1. `manuscript_version + 1`（行锁 = 写者串行化）
2. 逐 op 更新 manuscript_lines
3. 追加 change_sets（append-only）；仅用户发起的修改作为上下文事件追加，Agent 工具发起的修改不追加（工具返回即所见）
4. 稿件修改**不触**脚本与音频缓存（缓存挂脚本行，与稿件无关）；影响的是下一次定稿的新脚本行（新行冷缓存）

## 合成（调音层：脚本 → 产物）

1. 读目标脚本（scripts + script_lines：内容 + 每行 tts）
2. 逐行查 tts_cache（by script_line_id）：命中直接复用，未命中走 TTS 并回填（试听 = 单行合成入口，同样落缓存）
3. 拼接 · 停顿 · 响度归一（停顿是拼接参数，不改变单行音频）→ 回填行级时间戳 → 确定性验证
4. 写 artifacts（替换该脚本旧产物）

## 缓存语义（音频缓存）

- **跟随脚本行**：tts_cache 以 script_line_id 为外键（UNIQUE，每行 0..1 份），**与稿件无关**——稿件怎么改都够不到缓存。
- **破坏缓存 = 特定行为重写音频**：
  - 改语气 / 语速 / 情感 → 重写该脚本行缓存（单行、精准）
  - 强制重新生成 → 显式重写（绕过缓存 / 清条目后重生成）
  - 换音色 / 换 TTS 模型 → 批量重写所有受影响脚本行的缓存
  - 改停顿 → 只重拼接，不重写（停顿作用于拼接层，ADR-0004）
- **不做内容寻址**：缓存键 = script_line_id，无唯一内容 hash；跨版本不共享（重定稿 = 新脚本行 = 冷缓存，整版重新合成）——有意的取舍，主战场是单脚本内的试听 / 调 / 批量循环（ADR-0006）。
- 批量合成前可预览命中：已存在缓存行的 script_line = 命中，其余 = 需新合成。
- 缓存行随脚本级联清理（script → script_lines → tts_cache ON DELETE CASCADE）。

## 关键性质

- **id 与行号**：稿件行与脚本行各有独立 uuid（Agent 操作引用，永不变）。行号 serial（L001）既是序列号也是顺序——重排 / 插入时按序重编，供视图与人类引用。工具操作一律引用 uuid。
- **两类行**：稿件行 = 台词 + 说话人（写稿层，活）；脚本行 = 定稿时**拷贝**的稿件行（顺序 / 说话人 / 文本）+ 每行 TTS 配置（调音层，内容冻结）。脚本行**不引用稿件行**（无血缘指针）——拷贝即存档，稿件行变 / 删都不影响它。
- **缓存跟随脚本行**：试听 / 批量合成共用同一份缓存；命中 = 该行已有缓存音频；改语气 / 语速 / 情感、强制重生成、换音色 / 换模型触发重写；改停顿只重拼接。稿件修改不触缓存。
- **read 不重放**：read 工具直接读物质化的稿件行（按行号 serial 排序，过滤 deleted），不从 change_sets 重放历史；change_sets 只做增量上下文通知（ADR-0002）。
- **新增 / 删除**：add 发新 id + 排在末尾续编行号；删除是置 deleted=true（逻辑删除），行从视图消失，read 过滤；id 永不重用，上下文引用不悬空。
- **并发守卫**：ChangeSet 带 base_version，与当前 manuscript_version 不符（基于旧视图）→ 拒绝重生成。
- **写稿层不碰调音层**：写稿大师没有 tune 工具，调音大师没有 add/edit 工具；两端通过定稿的脚本交接，零冲突。
- **会话按对象挂**：调音大师会话挂 script_id（一版脚本一个，UNIQUE）——点开哪版脚本，会话就跟到哪版；切换脚本即切换会话，各版 TTS 配置讨论互不串台。写稿大师会话挂 episode（一集一个）。消息进 messages，conversation 是上下文的隔离边界。

## 统一读取接口

```
GET /ep/:id/manuscript    → 当前稿件（可编辑）：manuscript_lines（过滤 deleted，按 serial）
GET /ep/:id/scripts?ver=N → 某版脚本（scripts + script_lines：内容只读、tts 可改）
```

都序列化为 `{ id, version, lines[], readOnly }`。Agent 工具（read_script / validate_script）也走它。

## 已定边界

- 用户修改是记入上下文 / 影响下一版的操作：先暂存，确认（提交改动）后才持久化；Agent 用工具发起的修改走工具返回，不追加上下文、不需确认门。
- 音色不随稿件冻结：重新合成跟随当前说话人配置。
- 微调是调音大师的操作：逐行改脚本行的 TTS 配置（停顿 / 语气 / 语速 / 情感），定稿后内容冻结、不可经微调改动；微调不新增版本，只覆盖该版合成输出。
- 审核可指定对象：默认稿件，也支持 validate_script({scriptId}) 审某版脚本。
- 产物是独立实体（artifacts 表），脚本 0..1 产物，重新合成替换。
- 不设"对齐纪要"实体：写稿与对齐共用写稿大师的会话上下文，对齐结论只活在会话里。
