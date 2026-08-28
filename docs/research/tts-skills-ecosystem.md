# Agent Skill 生态里的 TTS 组织方式调研

> 调研范围：agent-skill 生态里 TTS 是怎么用、怎么组织的——用什么 TTS 引擎、文本怎么切分、按行合成还是整段合成、音频怎么拼接、有没有缓存、TTS 参数（停顿/语速/情感等）怎么在 prompt 里表达。
> 覆盖 4 个来源：huangserva/servasyy_skills（Ultra Skill）、podcast-generator、tts-script-generator、awesome-agent-skills（"Content Creation Skills" 一节）。
> 本文只记录事实与出处，**不下选型结论**。
> 调研时间：2026-08。

---

## 0. 来源与口径说明

- **podcast-generator / tts-script-generator 的"repo"定位**：GitHub 上不存在独立成名的同名 standalone repo；这两个名字是 Ultra Skill（`huangserva/servasyy_skills`）里的两个技能目录，各自带 `SKILL.md` 与脚本。本调研按 ticket 意图把它们当作 Ultra Skill 平台下的两个独立技能来读，并额外读了它们背后的 `shared-lib/video/tts` 引擎实现。
- **awesome-agent-skills 的歧义**：名字叫 `awesome-agent-skills` 的 repo 很多（最知名是 VoltAgent/awesome-agent-skills，~33k star），但**没有任何一个 repo 名里带 "Content Creation Skills" 字样的章节标题**；字面叫 "Content Creation Skills" 的章节出现在 `juneyaooo/awesome-ai-media-skills`。因此第 4 节同时覆盖 VoltAgent（规范名）与 JuneYaooo（字面章节），各自标注来源。

---

## 1. huangserva/servasyy_skills —— "Ultra Skill" README

来源：[huangserva/servasyy_skills README](https://github.com/huangserva/servasyy_skills)（默认分支 `master`；另有同名 fork `nanlis/servasyy_skills` 内容一致）。

- 定位：**"Ultra Skill - AI 多媒体内容生产平台"**，14 个集成技能，其中音频生成类两个：
  - **podcast-generator**（492K）："生成自然真实的双人访谈播客"，引擎标称 **3 种 TTS 引擎（Edge TTS、IndexTTS2、MiniMax、CosyVoice3）**，特点"情感控制、自然对话、多角色声音映射"。
  - **tts-script-generator**（20K）："智能压缩文档到目标时长，转换为 TTS 友好脚本"，特点"自动分段、情感标注、口语化风格"，用途"视频旁白、播客脚本"。
- 技术栈：TTS 列 **Edge TTS、IndexTTS2、MiniMax、CosyVoice3**；AI/ML 列 Claude API、Whisper；视频列 Remotion、FFmpeg、Manim。
- 配置：`shared-lib/config.yaml` 里 `tts: default_engine: edge_tts`，即**默认引擎 Edge TTS**。
- 使用示例（README）：`python podcast-generator/generate.py script.txt --engine indextts2`。
- 更新日志（2026-02-05）提到"podcast-generator 新增 CosyVoice3 支持"。

> **值得记录的事实矛盾**：README 正文多处写"**3 种** TTS 引擎"，但引擎清单/技术栈实际列了 **4 个**（Edge TTS、IndexTTS2、MiniMax、CosyVoice3），且更新日志确认 CosyVoice3 是后来加的。README 本身口径不一致。

---

## 2. podcast-generator —— SKILL.md 与实现

来源：`podcast-generator/` 目录（[SKILL.md](https://github.com/huangserva/servasyy_skills/blob/master/podcast-generator/SKILL.md)、[README_PODCAST.md](https://github.com/huangserva/servasyy_skills/blob/master/podcast-generator/README_PODCAST.md)、[skill.py](https://github.com/huangserva/servasyy_skills/blob/master/podcast-generator/skill.py)、[tts_generator.py](https://github.com/huangserva/servasyy_skills/blob/master/podcast-generator/tts_generator.py)），以及 `shared-lib/video/tts/` 引擎实现（[factory.py](https://github.com/huangserva/servasyy_skills/blob/master/shared-lib/video/tts/factory.py)、[base.py](https://github.com/huangserva/servasyy_skills/blob/master/shared-lib/video/tts/base.py)、[edge_tts.py](https://github.com/huangserva/servasyy_skills/blob/master/shared-lib/video/tts/edge_tts.py)、[minimax.py](https://github.com/huangserva/servasyy_skills/blob/master/shared-lib/video/tts/minimax.py)、[indextts2.py](https://github.com/huangserva/servasyy_skills/blob/master/shared-lib/video/tts/indextts2.py)、[cosyvoice3.py](https://github.com/huangserva/servasyy_skills/blob/master/shared-lib/video/tts/cosyvoice3.py)）。

### 2.1 引擎

- **4 个引擎**，通过 `TTSFactory.create(name, config)` 统一创建（factory.py 注册表：`edge-tts` / `indextts2` / `minimax` / `cosyvoice3`）：
  - **Edge TTS**（默认）：子进程调 `edge-tts --voice --rate --text --write-media`，无需 key，输出 **MP3**；不支持情感。
  - **IndexTTS2**：连本地/远程 Gradio Web UI（`http://219.147.109.250:7860` 等），基于参考音频做声音克隆，输出 **WAV**；支持 **8 维情感向量**（vec1..vec8）。
  - **MiniMax**：HTTP POST 到 `https://api.minimax.chat/v1/text_to_speech`（model `speech-01`），输出 **MP3**；支持简单情感字符串映射。
  - **CosyVoice3**：本地加载阿里 `Fun-CosyVoice3-0.5B` 模型，`inference_instruct2` 指令模式，输出 WAV；零样本克隆（参考 wav）+ 英文情感指令。

### 2.2 文本切片 / 分段

- **脚本格式即分段**：SKILL.md 规定脚本每行格式 `角色|情感|文本`（或旧格式 `角色[情感]：文本`），**一行 = 一个台词 = 一个音频片段**，不再做句级再切分。
- 对话规范在 prompt 里约束粒度：口语化、短句为主（**每句不超过 30 字，单句上限 40 字**）、同一角色连续 2–4 句再换人、每段 50 字左右（README_PODCAST：推荐 50 字、最短 20、最长 80）。
- Edge TTS 版（README_PODCAST）明确"优化段落 50 字左右/段"。

### 2.3 按行 vs 整段合成

- **纯按行（逐台词）合成**：`generate_audio_segments()` 对解析出的每个 (speaker, text, emotion) 三元组单独调一次引擎生成，落盘为 `seg_NNN.wav`（indextts2/cosyvoice3）或 `seg_NNN.mp3`（edge/minimax）。**没有任何"整段/整脚本一次合成"**的路径。
- 每个片段有 **3 次重试**，失败跳过继续。

### 2.4 音频拼接 / 装配

- **FFmpeg concat demuxer + 人为静音**（`merge_audio`）：
  - 生成两种停顿：**短停顿 0.3s**（同一说话人连续说）与**长停顿 1.0s**（换人），用 ffmpeg `anullsrc` 造静音（22050Hz 单声道，匹配 IndexTTS2 输出）。
  - 按"当前段说话人 == 下一段说话人"决定插短/长停顿，写入 filelist.txt，`ffmpeg -f concat -safe 0 ... -acodec libmp3lame -q:a 2` 重编码合并为最终 MP3。
  - 另有 `generate_silence()` 生成 `--pause` 指定秒数（默认 0.1s）的静音文件。
- Edge TTS 版 README_PODCAST：对话间停顿默认 **0.5s**（`--pause 0.5`），可用 `--pause 0.3/0.8` 调整；语速 `--female-rate +5% / --male-rate +3%`。

### 2.5 缓存

- **无内容寻址 TTS 缓存**。有两个"近似缓存"行为：
  - **片段级复用**：`--segments 18,20,24,...` 只重新生成指定片段，其余片段**复用已存在的 seg 文件**（`segment_indices` 逻辑：命中直接 append 现有文件，不加入清理列表）。
  - **CosyVoice3 参考音频重采样缓存**：`_resampled_cache` 内存缓存 + 落盘 `cosyvoice3_22050_<name>` 临时文件，重采样结果复用。
- 每轮生成前会**清理旧的 seg 文件**（除非走 `--segments`），避免跨项目混淆。

### 2.6 TTS 参数在 prompt / 代码里的表达

- **prompt 侧（SKILL.md）**：情感用**情感标签**在脚本行内联表达，`角色|情感|文本`，情感词表：`cheerful/chat/calm/serious/gentle/fearful/sad/angry/disgruntled`（还有中文旧词：开心/生气/悲伤/恐惧/低落/惊喜/平静）。说话人 = 角色名（晓晓/云扬，或小丽/大伟/美美/阿刚等）。
- **引擎侧映射**：
  - **Edge TTS**：忽略情感；每说话人一个 `--rate`（女 +5% / 男 +3%）。
  - **IndexTTS2**：情感词 → **8 维向量**（如 cheerful `{vec1:0.3}`、sad `{vec3:1.0}`、serious `{vec8:0.7}`、gentle `{vec8:0.8, vec1:0.3}`、calm/chat 不设），另按说话人设 `emo_weight`（女 0.7 / 男 0.6）与 `temperature`（女 0.85 / 男 0.75）；SKILL.md 里标注 IndexTTS2 参数 emo_weight 0–1 默认 0.65、temperature 0.1–2.0 默认 0.8。
  - **MiniMax**：情感词 → 字符串（cheerful→happy、chat/calm→neutral、serious→serious、gentle→gentle、fearful→fearful、sad→sad、angry/disgruntled→angry）；参数含 `speed:1.0, vol:1.0, pitch:0, emotion, audio_sample_rate:24000, bitrate:128000`；voice_id 按性别 `female-tianmei` / `male-qn-qingse`。
  - **CosyVoice3**：情感词 → **英文指令句**（如 angry/serious→"Speak in a serious and stern tone."、sad→"Speak in a sad and disappointed tone."），走 `inference_instruct2`，指令前缀 "You are a helpful assistant. …<|endofprompt|>"；顺带做**防削波**（最大振幅 >0.99 时归一化到 0.99）。

---

## 3. tts-script-generator —— SKILL.md 与脚本

来源：`tts-script-generator/` 目录（[SKILL.md](https://github.com/huangserva/servasyy_skills/blob/master/tts-script-generator/SKILL.md)、[SKILL_NEW.md](https://github.com/huangserva/servasyy_skills/blob/master/tts-script-generator/SKILL_NEW.md)、[scripts/generate.py](https://github.com/huangserva/servasyy_skills/blob/master/tts-script-generator/scripts/generate.py)）。

- **定位：只生成 TTS 脚本，不生成音频**。SKILL.md 明确"不包含 TTS 音频生成（由 image-to-video skill 负责）"，引擎无关；被 image-to-video（主要）与 podcast-generator 调用。
- **工作方式**：Claude 在对话中改写（allowed-tools: Bash/Read/Write/Edit/Glob/Grep/TodoWrite）：
  1. 读原文档 → 分析主题/结构/核心观点/内容密度。
  2. **智能时长决策**：自动定 3–8 分钟目标时长，按比例压缩（例：5947 字 19 分钟 → 1350 字 5 分钟）。
  3. 口语化改写 + **添加情感词语**（强调词"真的/非常/特别"、惊叹词"哇/天哪/想象一下"、语气词"啊/呢/吧"）。
  4. **自动分段**：每段 10–20 秒、每段一个核心点（默认 ~15s/段）。
  5. 输出 `tts_script.json`（TTS 文本 + 动画标记）+ `visual_config.json`（配图描述）。
- **tts_script.json 结构**：`[{segment, text, duration, animation_style, emphasis}]`——即**逐段对象**，每段带预计时长（秒）。
- **引擎 / 合成**：不涉及。**不拼接音频**（本技能不做 TTS 调用）。
- **缓存**：无音频缓存（没有音频产出）。
- **脚本端（scripts/generate.py）的确定性切分实现**（Claude 之外的另一条路径）：
  - 按 Markdown **H2 章节**提取；`clean_markdown()` 去格式；`to_spoken_style()` 在标点后插空格模拟停顿；**按时长切分** `split_by_duration(target_duration=25s, chars_per_second=5)`——即按 **5 字/秒**的朗读速率换算字数窗口、按句号切句并拼块。
  - 输出 `estimated_duration = len(text) / 5.0`（同样按 5 字/秒估算）。
- **TTS 参数表达**：本技能在脚本里表达的是**文本级参数**（分段时长、停顿位置靠标点空格、情感靠语气词），**不表达引擎级参数**（无语速/音色/情感标签字段）；情感标注是"口语化+情感词"，与 podcast-generator 的 `角色|情感|文本` 显式标签不同。

---

## 4. awesome-agent-skills —— "Content Creation Skills" 一节

### 4.1 VoltAgent/awesome-agent-skills（名字的"规范" repo，~33k star）

来源：[VoltAgent/awesome-agent-skills README](https://github.com/VoltAgent/awesome-agent-skills/)。

- 组织方式：**"Official Skills by <厂商>" + 一个 "Community Skills"**（折叠小节：Vector Databases / Marketing / Productivity and Collaboration / Development and Testing / Context Engineering / Specialized Domains / n8n Automation）。**没有字面 "Content Creation Skills" 标题**；内容创作相关散落在 Marketing、Specialized Domains 与各厂商小节里。
- 其中与 TTS/音频直接相关的条目（事实清单）：
  - `veniceai/venice-audio-speech` — TTS 模型、音色、格式与流式。
  - `microsoft/podcast-generation` — "AI podcast audio with Azure OpenAI Realtime API"。
  - `microsoft/azure-ai-voicelive-*`（dotnet/java/py/ts）— 实时双向语音 AI。
  - `fal-ai-community/fal-audio` — 用 fal.ai 音频模型的 TTS 与 STT。
  - `openai/speech` — 用 OpenAI API 内置音色生成语音；`openai/transcribe` — 转写。
  - `MiniMax-AI/cli` — 通过 MiniMax 生成文本/图像/视频/语音/音乐。
  - `NVIDIA nemotron-voice-agent` — 部署 Nemotron Voice Agent。
  - `NoizAI/skills` — "Human-like TTS workflows with local/cloud APIs"。
  - `degausai/wonda` — "AI content creation: images, video, music, audio, editing, publishing"。
  - `video-db/skills` — 实时/批处理视频工作流（含抓屏/音频、转写、字幕）。
- 附注（README）："Skills in this list are curated, not audited"，安装前自行核验安全。

### 4.2 juneyaooo/awesome-ai-media-skills（字面 "Content Creation Skills" 章节）

来源：[juneyaooo/awesome-ai-media-skills README](https://github.com/JuneYaooo/awesome-ai-media-skills)（"## Content Creation Skills" 小节，目录 TOC 第 15 行锚点）。

- 这是**唯一字面含 "## Content Creation Skills" 标题**的调研对象（repo 名是 awesome-**ai-media**-skills，非 awesome-agent-skills）。
- 该小节列了 18 个技能，**全部是写作/社媒发布/运营向**：content-pipeline（创作者工作流：调研/草稿/排版/封面/多平台发布）、typefully/agent-skills（X/LinkedIn/Threads/Bluesky/Mastodon 发帖）、social-media-skills（blacktwist）、baoyu-skills（小红书卡片/信息图）、khazix-skills（微信长文）、claude-blog（博客）、notebooklm-skill、social-account-doctor、xhs-writer-skill、social-media-caption-generator、marketing-skills、self-media-compliance-review 等。
- **该小节没有 TTS 技能**；TTS 相关内容出现在该 repo 的 **"Video Generation Skills"** 小节：`video-podcast-maker`（"multilingual TTS"）、`claude-code-skills`（deAPI 的 "AI voice (TTS)"）、`MiniMax-MCP`（官方 MCP，text-to-speech 等）。
- 附注：该 repo 是对技能/ MCP 的**链接清单式 curated list**，不带 SKILL.md 正文，也不提供引擎/拼接/缓存等实现细节。

### 4.3 其他同名 repo 的 "Content Creation" 片段（次要）

- `6missedcalls/awesome-agent-skills` 有 "### Video & Content Creation" 小节，但内容为视频剪辑（FFmpeg+Whisper）与 Revid API，**无 TTS 实现细节**（来源：[README](https://github.com/6missedcalls/awesome-agent-skills)）。
- 其余大量 `awesome-agent-skills` repo（heilcheng、libukai、skillmatic-ai、JackyST0、itgoyo 等）README 均无 "Content Creation Skills" 标题，多为目录/索引性质。

---

## 5. 横切观察（仅事实汇总，不下结论）

- **引擎分布**：生态里 TTS 引擎五花八门——云 API（Edge TTS、MiniMax、ElevenLabs、OpenAI、Fish Audio、Azure、fal.ai、Volcengine）、本地/可克隆模型（IndexTTS2、CosyVoice3、Kokoro、F5-TTS、OuteTTS、PocketTTS、Piper）都有；Ultra Skill 是"多引擎 + 工厂切换 + 每引擎映射情感"的典型。
- **分段单元**：Ultra Skill 体系里，podcast 是"**台词行 = 片段**"（prompt 里用字数约束行粒度），tts-script 是"**按时长/字数窗口切块**（5 字/秒）"；两类都以**小粒度逐段合成**为默认。
- **拼接**：podcast-generator 用 **FFmpeg concat + 人为静音**（同人短停顿 0.3s / 换人长停顿 1.0s）把逐段音频拼成 mp3；停顿是**拼接层参数**而非合成参数。
- **缓存**：生态里**普遍没有内容寻址 TTS 缓存**；最接近的是"片段级复用/部分重生成"（podcast `--segments`）与"参考音频重采样缓存"（CosyVoice3）。本项目自身的 ADR-0006（[docs/adr/0006-audio-cache-per-script-line.md](../adr/0006-audio-cache-per-script-line.md)）采用的"缓存挂脚本行、特定行为显式失效"是另一种（更强的）设计。
- **参数表达**：情感在 prompt 里的表达方式分为——(a) **显式标签**（podcast 的 `角色|情感|文本` + 情感词表）、(b) **文本级语气词**（tts-script 的口语化/语气词）、(c) **引擎级参数/指令**（IndexTTS2 8 维向量、MiniMax 情感字符串、CosyVoice3 英文指令句）；同一情感词在不同引擎被映射成完全不同的底层参数。
