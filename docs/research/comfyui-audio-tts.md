# ComfyUI 音频 / TTS 生态调研

> 调研范围：ComfyUI 生态里音频 / TTS 生成的主流做法——常见 TTS 节点、多说话人支持、拼接 / 停顿 / 响度处理、输出格式（wav/mp3/ogg）。
> 本文只记录事实与出处，**不下选型结论**。
> 调研时间：2026-08。

---

## 0. ComfyUI 的音频数据模型与内置音频节点（前置背景）

ComfyUI 内置的 `AUDIO` 类型是字典 `{"waveform": torch.Tensor[批次, 声道, 采样], "sample_rate": int}`；TTS 节点统一输出该类型，再接内置的保存 / 预览节点导出。（来源：[Comfy-Org/ComfyUI `comfy_extras/nodes_audio.py`](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_audio.py)）

内置音频节点（同上文件）：

- 加载/录制：`LoadAudio`（可加载视频里的音轨）、`RecordAudio`。
- 导出：`SaveAudio`（FLAC，已标记 deprecated）、`SaveAudioMP3`（deprecated）、`SaveAudioOpus`（deprecated）、`SaveAudioAdvanced`（现行节点，见 §4）、`PreviewAudio`（预览不落 output 目录）。
- 处理：`AudioConcat`（两段音频首尾拼接）、`AudioMerge`（叠加混合：add/mean/subtract/multiply）、`AudioAdjustVolume`（dB 增益）、`TrimAudioDuration`、`SplitAudioChannels` / `JoinAudioChannels`（立体声拆分/合并）、`AudioEqualizer3Band`（3 段 EQ）、`EmptyAudio`（生成指定时长/采样率/声道数的静音）。
- 生成侧：`VAEEncodeAudio` / `VAEDecodeAudio`（音频潜空间编解码；解码时做 peak 风格归一化）、`EmptyLatentAudio`（静音潜空间）。

`AudioConcat` 自动处理格式差异：单声道转立体声、匹配采样率，按 `direction`（after/before）决定拼接顺序。**内置没有专门的"插入停顿"节点**，但可用 `EmptyAudio` 造静音再 `AudioConcat`。（来源：[docs.comfy.org AudioConcat](https://docs.comfy.org/built-in-nodes/AudioConcat)）

---

## 1. 常见 TTS 节点

### 1.1 Edge TTS（微软在线服务，无需 API key）

- 底层库 [rany2/edge-tts](https://github.com/rany2/edge-tts)：调用 Microsoft Edge 在线 TTS 服务，无需 Edge 浏览器 / Windows / API key；`--list-voices` 可拉取全部在线神经语音（如 `ar-EG-SalmaNeural`），带性别 / ContentCategories / VoicePersonalities 属性；支持 rate、pitch、volume 参数，并可用 `--write-subtitles` 输出 `.srt` 字幕。原生输出为 **MP3**（`--write-media hello.mp3`）。
- 代表节点 [1038lab/ComfyUI-EdgeTTS](https://github.com/1038lab/ComfyUI-EdgeTTS)（~74 stars）：`EdgeTTS` 节点，输入 text（多行）、voice（下拉，语音表来自微软在线列表）、speed（0.5–2.0）、pitch（-20..+20 Hz）；输出 `AUDIO`。实现上 `edge_tts.Communicate(text, voice, rate, pitch)` 落盘临时文件 → `torchaudio.load` → 转单声道 → 归一化 → 输出 ComfyUI AUDIO 格式（[ailab_edgeTTS.py](https://github.com/1038lab/ComfyUI-EdgeTTS/blob/main/ailab_edgeTTS.py)）。需联网。
- 变体 / fork：[laichaoyi/ComfyUI-EdgeTTS](https://github.com/laichaoyi/ComfyUI-EdgeTTS)、[petercunha/ComfyUI-EdgeTTS](https://github.com/petercunha/ComfyUI-EdgeTTS)（同 README）；[GeekatplayStudio/ComfyUI-Text2Speech](https://github.com/GeekatplayStudio/ComfyUI-Text2Speech)（Flask 本地服务，17 个 Edge TTS 语音，rate 50–400、volume 0–1，输出 **WAV** 文件路径，Edge TTS 不可用时回退 pyttsx3 离线语音）。
- 特点：语音数量多（数百个神经语音）、多语言、参数简单，**无语音克隆**；节点自带保存（[runcomfy Save Audio 节点说明](https://www.runcomfy.com/comfyui-nodes/ComfyUI-EdgeTTS/save-audio) 提到 wav/mp3/flac 与默认输出目录 `/output/TTS/...`）。

### 1.2 Kokoro（Kokoro-82M，~82M 参数，Apache-2.0）

- 底层模型 [hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)，语音表见 [VOICES.md](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md)；输出采样率 24kHz。
- [GeekyGhost/ComfyUI-Geeky-Kokoro-TTS](https://github.com/GeekyGhost/ComfyUI-Geeky-Kokoro-TTS)（2025 版）：54+ 语音 / 9 语言；**语音混合**（blend_ratio 0–1，线性插值）、guided voice morphing、autotune 音高修正、谱形变、18 个音色 profile；智能文本分块保持句序；GPU/CPU 自动回退。输入 text、voice、speed（0.5–2.0）、use_gpu 及可选 second_voice + blend_ratio；输出 `AUDIO` + 处理后的文本。基于 `kokoro` 包（KModel/KPipeline），模型放 `models/kokoro_tts/`（[node.py](https://github.com/GeekyGhost/ComfyUI-Geeky-Kokoro-TTS/blob/main/node.py)）。
- [1038lab/ComfyUI-KokoroTTS](https://github.com/1038lab/ComfyUI-KokoroTTS)：多语言多语音，可调语速与音量，语言/语音配置在 `Languages.json`，V1.1.0 起内置音频保存。
- [stavsap/comfyui-kokoro](https://github.com/stavsap/comfyui-kokoro)：拆成 3 个节点——`Kokoro Speaker`、`Kokoro Speaker Combiner`（把 2 个 speaker 合成新 speaker）、`Kokoro Generate`；基于 kokoro-onnx。
- [benjiyaya/ComfyUI-KokoroTTS](https://github.com/benjiyaya/ComfyUI-KokoroTTS)：语音列表（af_sarah、am_adam、bf_emma…），输出 AUDIO 张量。
- 特点：轻量、本地离线、音色选择 + 混合/组合，**单次生成是单说话人**；多说话人对话需逐段生成后拼接。

### 1.3 F5-TTS（零样本语音克隆 TTS，SWivid/F5-TTS）

- 代表节点 [niknah/ComfyUI-F5-TTS](https://github.com/niknah/ComfyUI-F5-TTS)：3 个节点——`F5TTSAudio`（基于参考文件的多语音合成）、`F5TTSAudioInputs`（直接输入音频）、`F5TTSAudioAdvanced`（高级参数）。用你自己的声音做 TTS；参考音频需要成对的 `voice.wav` + `voice.txt`（转写），可放 `input/`、`input/F5-TTS/`、`input/audio/`；多语言靠 `models/checkpoints/F5-TTS/` 下同名 `.txt`（词汇）+ `.safetensors` 模型。输出 `AUDIO`。（来源：[README](https://github.com/niknah/ComfyUI-F5-TTS/blob/main/README.md)、[DeepWiki 概览](https://deepwiki.com/niknah/ComfyUI-F5-TTS)、[comfy.icu](https://comfy.icu/extension/niknah__ComfyUI-F5-TTS)）
- **多说话人**：文本里用 `{main}` / `{deep}` 之类的 voice tag 切换语音（对应 `voice.wav/voice.txt` 与 `voice.deep.wav/voice.deep.txt`），即"一次生成内多语音"。
- 特点：零样本克隆（几秒参考音频）、多语言、速度可调；依赖 F5-TTS 子模块。

### 1.4 OuteTTS（LLM 系 TTS，Apache-2.0，多语言 + 语音克隆）

- 代表节点 [billwuhao/ComfyUI_OuteTTS](https://github.com/billwuhao/ComfyUI_OuteTTS)：`OuteTTSRun` 节点，输入 model（`1B`/`0.6B`）、text、可选 audio（**语音克隆，源音频 ≤20s**）、speaker（预存说话人）、save_speaker / speaker_name（**自动保存说话人**）、chunked、seed；输出 AUDIO 波形 + 采样率（24kHz）。模型：`Llama-OuteTTS-1.0-1B` + DAC.speech 24kHz 解码器 + whisper-large-v3-turbo（转写参考音频），放 `models/TTS/`。（来源：[README](https://github.com/billwuhao/ComfyUI_OuteTTS)、[comfyai.run OuteTTSRun 文档](https://comfyai.run/documentation/OuteTTSRun)）
- 特点：既有预定义说话人、又能克隆并保存为说话人库；多语言（14 种，见 ComfyUI-Voice 表）。

### 1.5 其他值得注意的 TTS 节点

| 节点 / 仓库 | 模型 / 能力 | 多说话人方式 |
|---|---|---|
| [neverbiasu/ComfyUI-ChatTTS](https://github.com/neverbiasu/ComfyUI-ChatTTS) | ChatTTS，可控 TTS；文本内标签 `[speed_n]` `[oral_n]` `[laugh_n]` `[break_n]` `[lbreak]` `[uv_break]` `[laugh]` | 采样随机说话人或自定义音色参数 |
| [yuvraj108c/ComfyUI-PiperTTS](https://github.com/yuvraj108c/ComfyUI-PiperTTS) | Piper 轻量离线 TTS，按所选语音自动下载模型（[rhasspy/piper VOICES.md](https://github.com/rhasspy/piper/blob/master/VOICES.md)） | 逐语音选择 |
| [ComfyUI-XTTS](https://comfyai.run/custom_node/ComfyUI-XTTS) / [MushroomFleet/DJZ-XTTS](https://github.com/MushroomFleet/DJZ-XTTS) | Coqui XTTS，17 种语言，克隆 | 参考音色克隆 |
| [saganaki22/ComfyUI-OmniVoice-TTS](https://github.com/saganaki22/ComfyUI-OmniVoice-TTS) | OmniVoice，600+ 语言零样本克隆 / 语音设计 / **多说话人对话**（`[Speaker_N]:` 标签，2–10 人，`pause_between_speakers` 控制间隔，`postprocess_output` 去长静音）；非语言标签 `[laughter]` `[sigh]` | 原生单次生成多说话人 |
| [1038lab/ComfyUI-SparkTTS](https://github.com/1038lab/ComfyUI-SparkTTS) | SparkTTS，语音创建（gender/pitch/speed 调参）+ 克隆 | 逐说话人节点 |
| [1038lab/ComfyUI-MegaTTS](https://github.com/1038lab/ComfyUI-MegaTTS) | ByteDance MegaTTS3，中英双语克隆（wav+npy 特征，24kHz） | 逐说话人参考 |
| [flybirdxx/ComfyUI-SoulX-Podcast](https://github.com/flybirdxx/ComfyUI-SoulX-Podcast) | SoulX-Podcast（[Soul-AILab/SoulX-Podcast](https://github.com/Soul-AILab/SoulX-Podcast)），**两人播客对话生成**，`[S1]/[S2]` 剧本格式，参考音频驱动克隆，方言支持；输出 24kHz AUDIO | 原生双人对话（S1/S2） |
| [wildminder/ComfyUI-VibeVoice](https://github.com/wildminder/ComfyUI-VibeVoice) | 微软 VibeVoice，长文多说话人对话（**≤4 人**），`[1]` / `Speaker 1:` 剧本格式；克隆 + 零样本生成可混用（留空即生成新音色）；`.wav`/`.mp3` 参考均可 | 原生单次生成多说话人 |
| [Streamize-llc/ComfyUI-Voice](https://github.com/Streamize-llc/ComfyUI-Voice) | 统一多引擎套件：MeloTTS、CosyVoice3、Supertonic、Higgs Audio v3、Chatterbox、Qwen3-TTS、OuteTTS 1.0；能力声明驱动，节点输入随引擎自适应 | 逐引擎能力声明 |
| [diodiogod/TTS-Audio-Suite](https://github.com/diodiogod/TTS-Audio-Suite)（[registry](https://registry.comfy.org/nodes/tts_audio_suite)） | **通用多引擎 TTS 套件**：ChatterBox、F5-TTS、Higgs Audio 2/v3、VibeVoice、IndexTTS-2、CosyVoice3、Qwen3-TTS、OmniVoice、Echo-TTS、Step Audio EditX、MOSS、RVC 等 19 引擎；统一 `TTS Text` / `TTS SRT` 节点、角色语音管理（Character Voices、`[CharacterName]` 切换）、`[pause]` 停顿标签、SRT 字幕 TTS、语言切换括号语法 | `[角色名]` 标签切换 + 角色语音库 |

---

## 2. 多说话人支持的三种形态

从上面节点看，ComfyUI 生态处理多说话人主要有三种做法（多为社区方案，各仓库 README 自述）：

1. **模型原生多说话人（一次生成一条音频）**：剧本里用说话人标签切换——OmniVoice `[Speaker_N]:`、SoulX-Podcast `[S1]/[S2]`、VibeVoice `[1]`/`Speaker 1:`、Higgs Audio `[CharacterName]`、F5-TTS `{main}/{deep}`。适合"对话内容一次性合成长音频"。
2. **逐行/逐说话人生成 + 拼接**：每个脚本行（或每个说话人）分别用一个单说话人 TTS 节点（Kokoro、Edge TTS、Piper…）生成，再用 `AudioConcat` / `EmptyAudio` 插入停顿拼接。这正是"播客逐行合成"工作流最常见的形态（见 §4 工作流形态）。
3. **节点级音色组合**：Kokoro 的 Speaker Combiner / 语音混合（blend_ratio）、OuteTTS 的保存说话人库 + 克隆、Edge TTS 每节点选一个 voice。

社区"多说话人播客"方案示例：TTS-Audio-Suite 用 `character_alias_map.txt` 把角色名映射到语音样本（格式 `<角色名> = <语音文件名>, <语言码>`），配合 `[CharacterName]` 标签与 `[pause]` 标签控制角色与停顿（[diodiogod/TTS-Audio-Suite](https://github.com/diodiogod/TTS-Audio-Suite)；使用示例见 Meefik 的 AI 播客搭建文章 [meefik.dev](https://meefik.dev/2025/12/10/ai-podcast-from-scratch/)）。

---

## 3. 拼接 / 停顿 / 响度处理

### 3.1 拼接（concatenation）

- **内置**：`AudioConcat`（两段首尾拼接，after/before，自动处理单/立体声与采样率）。无内置"拼接列表"节点。
- **社区**：
  - [ComfyUI-speech-dataset-toolkit 的 Concat Audio](https://comfy.icu/node/SDT_ConcatAudio)：`audio1` + `audio2` + **`silent_interval`（FLOAT 秒）**，拼接时在两段之间插入停顿（为 ASR/TTS 数据集制作设计，torchaudio 实现）。
  - [lum3on/ComfyUI_AudioTools](https://github.com/lum3on/ComfyUI_AudioTools)：`Concatenate Audio`（两段首尾相接）、`Pad With Silence`（首/尾加静音，秒为单位）、`Mix Audio Tracks`、`Trim` 等。
  - TTS-Audio-Suite：多引擎"智能分块 + 无缝拼接"长文生成（如 VibeVoice / Higgs Audio 的 Smart Chunking）。
  - 视频化流程里常用 [Kosinkadink/ComfyUI-VideoHelperSuite](https://github.com/kosinkadink/comfyui-videohelpersuite) 的 `Video Combine` 把多段 + 音频合并进视频（ffmpeg，`apad`/`-shortest` 处理音画长度）。

### 3.2 停顿（silence / pause）

- **内置**：`EmptyAudio`（造静音）+ `AudioConcat` 手工插入。
- **文本内停顿标签**：ChatTTS `[break_n]` / `[lbreak]` / `[uv_break]`；SoulX-Podcast / OmniVoice 的 `[laughter]` `[sigh]` 等副语言标签。
- **节点参数**：OmniVoice 多说话人节点 `pause_between_speakers`（默认 0.3s）；SDT Concat Audio `silent_interval`；TTS-Audio-Suite `[pause]` 标签与停顿标签系统。
- **去停顿**：OmniVoice `postprocess_output`（移除长静音）；AudioTools `Remove Silence`（阈值 dB + 最短时长 ms）。

### 3.3 响度（loudness）

- **内置**：`AudioAdjustVolume`（dB 增益）；`VAEDecodeAudio` 解码时做 peak 归一化。
- **社区**：
  - AudioTools：`Normalize Audio`（峰值归一化到目标 dB，建议 -1dB 防削波）、`Amplify / Gain`（dB）、`Loudness Meter (LUFS)`（按 EBU R 128 测响度）、`Noise Gate`、`De-Esser`、`Vocal Compressor`、`Parametric EQ`。
  - GeekyGhost Kokoro 的 Voice Mod 节点：输出音量（dB）、EQ、混响等（作为 TTS 后处理）。

---

## 4. 输出格式（wav / mp3 / ogg）

- **ComfyUI 内置导出格式：FLAC / MP3 / Opus**。现行节点 `SaveAudioAdvanced` 可选 `flac`/`mp3`/`opus`；mp3 质量 `V0`/`128k`/`320k`，opus 码率 `64k`–`320k`（默认 128k）；opus 会按需重采样到 Opus 支持采样率（≤48kHz）。编码用 PyAV（libmp3lame / libopus / flac），可内嵌 prompt 元数据。（来源：[docs.comfy.org SaveAudioAdvanced](https://docs.comfy.org/built-in-nodes/SaveAudioAdvanced)、[Comfy-Org/ComfyUI `comfy_api/latest/_ui.py`](https://github.com/Comfy-Org/ComfyUI/blob/c011fb52/comfy_api/latest/_ui.py)）
- **WAV**：不是内置保存格式，由社区节点提供——如 [Alta: SaveAudioToPath](https://comfyai.run/documentation/Alta:SaveAudioToPath)（flac/mp3/opus/**wav**）、Geekatplay Text2Speech（WAV）、EdgeTTS 自带 Save Audio（wav/mp3/flac）、AudioTools 等。
- **OGG**：内置保存不支持；**读取**侧 VHS `LoadAudio` 支持扩展名 `wav, mp3, ogg, m4a, flac`（[Kosinkadink/ComfyUI-VideoHelperSuite](https://github.com/kosinkadink/comfyui-videohelpersuite)）。ogg 导出一般走 ffmpeg 系社区节点。
- **TTS 引擎原生采样率**（多为 24kHz，节点转成 ComfyUI AUDIO 后由保存节点再编码）：F5-TTS、Kokoro-82M、OuteTTS（DAC 24kHz 解码）、OmniVoice、SoulX-Podcast 均为 24kHz；个别 ONNX 变体（如 BS_Kokoro-onnx 文档示例 22050Hz）不同（[comfyai.run 文档](https://comfyai.run/documentation/Kokoro%20TTS)）。
- **edge-tts**：原生输出 MP3（含 `.srt` 字幕可选）；节点加载后转 AUDIO 再按需导出（[rany2/edge-tts](https://github.com/rany2/edge-tts)）。

---

## 5. 典型工作流形态（社区示例）

- **"AI 播客"端到端工作流**（Meefik 实测，2025-12）：ComfyUI 里用 TTS-Audio-Suite 的 IndexTTS-2 / Chatterbox 引擎，多说话人脚本 → 一次生成含多说话人的单条音频；因套件不输出多轨，用 **SRT 标记**分说话人拆轨（生成带准确时间戳的 SRT，把另一说话人替换为 `[pause]` 再各生成一遍，得到带静音间隔的逐说话人音频），再配 BGM 与转场。（来源：[meefik.dev/ai-podcast-from-scratch](https://meefik.dev/2025/12/10/ai-podcast-from-scratch/)）
- **VibeVoice 多说话人对话工作流**：多个 `Load Audio` 加载各说话人参考 → `VibeVoice TTS`（剧本 `Speaker 1:`/`[1]`）→ 单条多说话人音频（教程含 workflow JSON：[nextdiffusion.ai](https://www.nextdiffusion.ai/tutorials/multi-speaker-audio-generation-microsoft-vibevoice-comfyui)）。
- **SoulX-Podcast 两人播客工作流**：`SoulX Podcast Loader` → `Load Audio`（S1/S2 参考）→ `Input Parser`（`[S1]…` / `[S2]…` 剧本）→ `Generate` → `Preview/Save Audio`。（来源：[flybirdxx/ComfyUI-SoulX-Podcast](https://github.com/flybirdxx/ComfyUI-SoulX-Podcast)）
- **F5-TTS 语音克隆工作流**：参考 `voice.wav + voice.txt` → `F5TTSAudio` → `Save Audio`；多语音用 `{main}/{deep}` 标签。（来源：[comfy.icu](https://comfy.icu/extension/niknah__ComfyUI-F5-TTS)）
- **逐行拼接播客形态**：单说话人节点（Kokoro / Edge TTS / Piper）逐行生成 → `AudioConcat` / SDT Concat Audio（含 `silent_interval`）→ `SaveAudioAdvanced` 导出 mp3/flac。此形态与本仓库"脚本行 → 逐行 TTS → 拼接"的模型（见 `CONTEXT.md` 合成 / 音频缓存）最接近，但本文不下结论。

---

## 6. 出处汇总

- ComfyUI 内置音频节点 / AUDIO 类型 / 保存实现：[Comfy-Org/ComfyUI `comfy_extras/nodes_audio.py`](https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_extras/nodes_audio.py)、[`comfy_api/latest/_ui.py`](https://github.com/Comfy-Org/ComfyUI/blob/c011fb52/comfy_api/latest/_ui.py)、[docs.comfy.org 内置节点](https://docs.comfy.org/built-in-nodes/)。
- Edge TTS：[rany2/edge-tts](https://github.com/rany2/edge-tts)、[1038lab/ComfyUI-EdgeTTS](https://github.com/1038lab/ComfyUI-EdgeTTS)（含 [ailab_edgeTTS.py](https://github.com/1038lab/ComfyUI-EdgeTTS/blob/main/ailab_edgeTTS.py)）、[GeekatplayStudio/ComfyUI-Text2Speech](https://github.com/GeekatplayStudio/ComfyUI-Text2Speech)。
- Kokoro：[hexgrad/Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M)（[VOICES.md](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md)）、[GeekyGhost/ComfyUI-Geeky-Kokoro-TTS](https://github.com/GeekyGhost/ComfyUI-Geeky-Kokoro-TTS)、[1038lab/ComfyUI-KokoroTTS](https://github.com/1038lab/ComfyUI-KokoroTTS)、[stavsap/comfyui-kokoro](https://github.com/stavsap/comfyui-kokoro)、[benjiyaya/ComfyUI-KokoroTTS](https://github.com/benjiyaya/ComfyUI-KokoroTTS)。
- F5-TTS：[niknah/ComfyUI-F5-TTS](https://github.com/niknah/ComfyUI-F5-TTS)、[DeepWiki](https://deepwiki.com/niknah/ComfyUI-F5-TTS)、[comfy.icu](https://comfy.icu/extension/niknah__ComfyUI-F5-TTS)。
- OuteTTS：[billwuhao/ComfyUI_OuteTTS](https://github.com/billwuhao/ComfyUI_OuteTTS)、[comfyai.run OuteTTSRun](https://comfyai.run/documentation/OuteTTSRun)。
- 其他 TTS：ChatTTS、Piper、XTTS、OmniVoice、SparkTTS、MegaTTS3、SoulX-Podcast、VibeVoice、ComfyUI-Voice、TTS-Audio-Suite（链接见 §1.5 表内）。
- 拼接/停顿/响度：AudioTools（[lum3on/ComfyUI_AudioTools](https://github.com/lum3on/ComfyUI_AudioTools)）、SDT Concat Audio（[comfy.icu](https://comfy.icu/node/SDT_ConcatAudio)）、VHS（[Kosinkadink/ComfyUI-VideoHelperSuite](https://github.com/kosinkadink/comfyui-videohelpersuite)）、Alta SaveAudioToPath（[comfyai.run](https://comfyai.run/documentation/Alta:SaveAudioToPath)）。
- 工作流示例：[meefik.dev AI 播客搭建](https://meefik.dev/2025/12/10/ai-podcast-from-scratch/)、[nextdiffusion.ai VibeVoice 教程](https://www.nextdiffusion.ai/tutorials/multi-speaker-audio-generation-microsoft-vibevoice-comfyui)。
