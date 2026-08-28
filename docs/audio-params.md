# 合成后期 MVP 参数表

> 决议来源：[#18 合成流水线参数表（停顿/语速档位与响度目标）](https://github.com/clerimia/AIPodCast/issues/18)（wayfinder 地图 #14）。
> 决策主权仍归 [ADR-0007](./adr/0007-deterministic-post-pipeline.md)（确定性后期管线）与 [ADR-0004](./adr/0004-tune-as-text-and-post-params.md)（微调=改指令+改后期参数）。本文档是**查表参考**，不重复决策推理。

## 一句话

后期 = 确定性音频流水线（非 AI）。素材固定为引擎默认语速的 **wav 24kHz mono 16-bit**；停顿/语速是**拼接层参数**（只重拼接、不重写素材）；响度在 master 级归一；最终编码为 mp3。下表是 MVP 的档位值。

## 参数表

### 停顿档位（pause）

拼接层参数。相邻素材间的纯静音 gap，由 ffmpeg `anullsrc`（24kHz mono）生成，`concat demuxer` 拼接。纯静音 gap，无 crossfade。

| 档位 | gap |
|---|---|
| 短 short | 400 ms |
| 中 medium | 800 ms |
| 长 long | 1500 ms |

**换说话人**：相邻行 i 与 i+1 说话人不同时，gap **叠加** +400ms（即 gap = 该行停顿档位 + 400ms）。叠加在默认与逐行 override 两种情况下**都生效**。

- 默认（无逐行 override）+ 换说话人：800 + 400 = **1200 ms**
- 逐行"长"档 + 换说话人：1500 + 400 = **1900 ms**

**gap 归属**：相邻行 i 与 i+1 之间的 gap 由**后一行（i+1）的 pause 参数**决定（"下一句开口前的停顿"）。逐行 `post` 覆盖集级 `post_rules`。

**默认档位**：行无逐行 override 时，集级 `post_rules` 默认 = **中（800ms）**。

### 语速档位（speed）

拼接层参数。逐行 ffmpeg `atempo`（atempo 取值 0.5–100，0.9/1.15 在音质安全区，无需链式）。变速后时长 = `素材时长_ms / factor`。改语速只重拼接、不重写素材。

| 档位 | atempo 系数 | 含义 |
|---|---|---|
| 慢 slow | 0.9 | 放慢 10%（时长 +11%） |
| 正常 normal | 1.0 | 原速 |
| 快 fast | 1.15 | 加快 15%（时长 -13%） |

**非对称是有意的**：人耳对放慢比加快更敏感，故快档幅度大于慢档。MVP 先保守；想给快档加到 1.2–1.3 只重拼接、不重合成、零成本。

**默认档位**：行无逐行 override 时，集级 `post_rules` 默认 = **正常（1.0）**。

### 响度归一目标（EBU R128）

master 级，ffmpeg `loudnorm`，**两遍线性**（先测后线性增益、不动动态范围）。不做逐行归一（短行 loudnorm 不稳、易抽吸），逐行归一留作增强。

| 参数 | 目标 | 说明 |
|---|---|---|
| I（integrated loudness） | **-16 LUFS** | 播客 / Apple Podcasts 惯例 |
| LRA（loudness range） | **7** | ffmpeg `loudnorm` 默认值；线性模式下基本为参考，不压动态 |
| TP（true peak） | **-1.5 dBTP** | 比 ffmpeg 默认 -2 紧 0.5 dB，比 EBU 推荐 -1 松 0.5 dB，保守防削顶 |

选 -1.5 dBTP 是因为 DashScope 合成音量不可预测，留 headroom 防削顶。MVP 后想紧到 -1.0 只重跑 loudnorm、不重拼接不重合成。

### 重采样与编码链

| 步骤 | 值 |
|---|---|
| 素材输入 | wav 24kHz mono 16-bit（引擎固定输出） |
| 拼接采样率 | 24kHz mono |
| 重采样目标 | 44.1kHz mono |
| 编码格式 | mp3 |
| 码率 | **128 kbps CBR** |
| 声道 | mono（单声道） |

- **44.1kHz**：播客生态主流，播放器/设备兼容性最好（24k 虽是合法 MPEG-2 Layer III 采样率，但非播客主流）。
- **128 kbps CBR mono**：mono 人声 128k 是"听感无差别"档，单集约省一半体积（相对 192k）；改码率只需重跑 ffmpeg 末步、不重拼接不重合成。

## 管线顺序（ADR-0007 兑现）

1. 逐行 `atempo`（语速档位 ≠ 正常时）
2. 行间插静音 gap（`anullsrc` 24k mono，停顿档位，换说话人 +400ms）
3. `concat demuxer` 按行序拼接
4. master 级 `loudnorm` 两遍线性（-16 LUFS / LRA 7 / TP -1.5 dBTP）
5. 回填行级时间戳（确定性计算：`start_i` = 前面各行渲染时长 + gap 之和，gap 归 i+1）
6. 确定性验证（行数/素材完整 -> 期望总时长 vs ffprobe 实际，mp3 ≤150ms 容差 -> 时间戳单调连续 -> 失败即中止、保留旧产物）
7. 编码产物 mp3 44.1k mono 128k CBR

## 不变量

- 素材（`audio_assets`）始终存引擎默认语速 wav 24k mono。
- 改指令 -> 该行素材重合成（ADR-0006）；改停顿/语速 -> 只重拼接（ADR-0004）。
- 确定性 = 同输入同参数 -> 同输出（同 ffmpeg 版本）。
