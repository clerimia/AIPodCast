# 确定性后期管线：concat 拼接 + EBU R128 响度 + 行级时间戳 + mp3 产物

**Status**: accepted

整集从逐行音频素材到产物的 ffmpeg 管线定为**确定性流水线**（非 AI，ADR-0005）。素材固定为引擎默认语速的 wav 24k mono，经以下步骤出 master：

1. **逐行变速**：语速档位 ≠ 正常时，该行素材经 ffmpeg `atempo`（慢/正常/快 = 0.9/1.0/1.15），变速后时长 = `duration_ms / factor`（ADR-0004：改语速只重拼接、不重写素材）。
2. **插停顿**：按行序在相邻素材间插静音（`anullsrc` 造 24k mono 静音），gap 取停顿档位（短/中/长 = 400/800/1500ms，换说话人 +400ms；逐行 `post` 覆盖集级 `post_rules`）。**纯静音 gap，不做 crossfade**——逐句对白交叠会互相干扰；交叉淡化属素材序列层增强，不在 MVP。
3. **拼接**：`concat demuxer` 按行序拼接（含静音段）。
4. **响度归一**：对整条 master 做一次 **EBU R128 `loudnorm`，两遍线性**（先测后线性增益），目标 **-16 LUFS、LRA 7、TP -1.5 dBTP**。不做逐行归一（短行 loudnorm 不稳、易抽吸），逐行归一留作增强。
5. **回填行级时间戳**：行级、**确定性计算**（非 ASR）：渲染时长 = 素材时长 ÷ 语速档位，`start_i` = 前面各行渲染时长 + gap 之和（精确到采样点）。载体 **JSON**（行号 / 说话人 / 文本 / start_ms / end_ms），随产物存 `transcript_ref`。字级时间戳出界（引擎不吐字级边界，MVP 不引 ASR）。
6. **确定性验证（全量）**：行数/素材完整（未合成行在合成步已补齐）→ 期望总时长 vs ffprobe 实际（容差随编码：wav ≤50ms、mp3 ≤150ms）→ 时间戳单调连续、gap 与档位一致。**失败即中止，保留旧产物不覆盖**。
7. **编码产物**：master = **mp3 44.1kHz 单声道 192kbps CBR**（引擎 24k mono 重采样至 44.1k——24k 对 MPEG-1 Layer III 非标）。wav 母带 / opus 留作增强。

**Why**:

- **确定性是领域一等要求**：CONTEXT.md 定义「后期 = 确定性音频流水线」。既然拼接/变速/停顿全是已知参数，时间戳**算得出来**，就不引 ASR（贵、不稳、引擎无字级边界）。
- **EBU R128 -16 LUFS** 是播客圈 / Apple Podcasts 惯例目标；两遍线性只做线性增益、不动动态，确定性好，避开单遍动态 loudnorm 的抽吸。
- **mp3 44.1k 单声道 192k** 对齐原型 `master.mp3` 与 podcast_agent（mp3 192k）的「最终成品」惯例；RSS/分发出界（地图 #1）后它仍是产物本身。
- **无 crossfade**：对白逐句交叠会互相干扰；交叉淡化属于时间线增强。

**Consequences**:

- 素材（`audio_assets`）始终存引擎默认语速 wav 24k mono；改语速 / 改停顿只重拼接、不重写素材（ADR-0004 兑现）。
- 行级文稿 = 脚本行 + 计算时间戳，随产物存（`artifacts.transcript_ref`），播放器据此高亮当前行。
- 产物 master = mp3 44.1k mono 192k（`artifacts.audio_ref`）；wav / opus 留作增强。
- BGM 混音 MVP 出界（素材库只预留模型，ADR-0006）；管线为 BGM 轨留扩展位。
- 确定性 = 同输入同参数 → 同输出（同 ffmpeg 版本）；验证失败保留旧产物、报错不覆盖。
