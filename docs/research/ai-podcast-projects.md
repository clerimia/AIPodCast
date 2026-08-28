# AI 播客生成项目横向调研

> 来源：用户派送的 Explore 总结（2026-08-28）。以下为按报告记录的事实与观察，未逐项独立核实；标注「用户/Explore 评价」处为其主观评估。服务于地图「TTS 选型与音频生成侧（wayfinder 地图）」的「需求约束与 TTS 引擎选型」票。

## 一、AI 播客生成项目

### 1. Google NotebookLM（闭源标杆）

- 做法：基于 Gemini 1.5 Pro，用户上传 PDF / 网页 / 视频等资料后，AI 自动生成「双人对谈」式播客（Audio Overviews）。
- 核心流程：文档理解 → 内容摘要 → 生成对话脚本（教授+学生角色）→ 双音色 TTS 合成。
- 特点：来源可溯源、减少幻觉、支持中文（2025 年 4 月起）。

### 2. Open NotebookLM（开源复刻）

- GitHub: open-notebooklm。
- 做法：将 PDF 转换为播客对话，5 分钟完成。
- 流程：PDF 解析 → LLM 生成主持人+嘉宾对话脚本 → TTS 合成（支持多语言 13 种）。
- 定位：NotebookLM 的免费开源替代。

### 3. Open Notebook（本地部署版）

- 特点：隐私优先、100% 本地部署。
- 支持模型：DeepSeek、OpenAI、Ollama 等。
- 核心功能：多扬声器播客生成 + 知识库问答。

### 4. Podcastfy（⭐ 最完整的开源方案，用户/Explore 评价）

- GitHub: souzatharsis/podcastfy。
- 定位：NotebookLM 播客功能的 Python 开源替代。
- 做法：输入网页、PDF、图片、YouTube 视频等多模态内容。
- 兼容 100+ LLM 模型（含本地 HuggingFace 模型）。
- TTS 引擎支持：OpenAI、Google、ElevenLabs 等。
- 输出：多语言音频对话。
- 技术亮点：动态优化对话逻辑、自动适配不同语言文化表达。

### 5. GitPodcast

- 做法：将任何 Git 仓库转换为播客。
- 流程：代码分析 → 内容总结 → 对话脚本生成 → 多语音合成。
- 特点：支持自定义语音、多语言、插件扩展。

## 二、Skill 封装形态

Skills 可将播客生成流程封装为可复用的模块化技能：

```
skills/
├── podcast-generator/
│   ├── SKILL.md          # 描述任务流程
│   ├── scripts/
│   │   ├── extract.py    # 内容提取
│   │   ├── script_gen.py # 脚本生成
│   │   └── tts_synth.py  # 语音合成
│   └── templates/
│       └── dialogue.md   # 对话模板
```

> 与我们的领域模型对照：这条「extract → script_gen → tts_synth」拆法与我们的 资源/稿件（写稿大师）→ 脚本 → 合成（调音大师）分层同构，可作为实现侧 skill 组织形态的参考。

## 三、典型 AI 播客生成完整 Pipeline

1. 内容输入（PDF、URL、YouTube、GitHub、文本、图片）
2. 内容提取和摘要：提取关键信息，生成知识图谱
3. 对话脚本生成（LLM）：分配角色，生成自然口语化对话、控制节奏
4. 多角色语言合成（TTS）：为每个角色分配不同音色，支持情感控制、语速调节、停顿插入
5. 后期处理：音频拼接、转场、背景音乐、音量均衡
6. 输出：MP3/WAV 播客文件 / RSS 分发

> 与我们地图的对照：
> - 「对话脚本 + 多角色 TTS + 后期处理」整体形状 = 我们的 稿件 → 脚本 → 合成 → 产物，层级被外部验证。
> - 第 4 步「情感控制、语速调节、停顿插入」与我们 tune 的 停顿/语气/语速/情感 对齐。
> - **新出现的元素**：后期处理里的「转场 / 背景音乐」，以及输出侧的「RSS 分发」——目前不在我们领域模型里（RSS 大概率出界，工作间是生产侧不是分发平台；BGM/转场待定，见地图 Not yet specified）。
