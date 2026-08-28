# 音频素材与产物存储：本地文件系统 + 产物文件包

**Status**: accepted

- **素材（audio_assets）存本地文件系统**：DB 只存 `audio_ref` = 相对 `MEDIA_ROOT` 的相对路径，不存二进制。素材 = 引擎默认语速 **wav 24k mono 原样**（零转码、零损失），文件名 = `{script_line_id}.wav`，目录 `media/ws-{id}/ep-{id}/assets/`。`MEDIA_ROOT` 配置化（.env）、gitignore。`audio_assets` 表是唯一索引（不做 podcast_agent 式注册表文件）。
- **产物（artifacts）= 文件包**：`media/ws-{id}/ep-{id}/artifacts/` 下三个文件同包——`master.mp3`（#7：44.1k 单声道 192k）、`transcript.json`（行级文稿：行号/说话人/文本/start_ms/end_ms，播放器高亮当前行）、`notes.md`（单集简介）。`artifacts` 表存 `audio_ref / transcript_ref / notes_ref` + 元数据（duration / size / created_at）。**重新合成 = 整包替换**。
- **清理与替换的原子性**：删行 / 删集 / 删工作间 → 级联删 DB 行 + 删对应文件（删行 → 删素材文件；删集 → 清 ep 目录；删工作间 → 清 ws 目录）；替换 → 先写临时文件再**原子 rename**（避免播放/读取读到半截文件）。

**Why**:

- 单用户本地工作间 → 文件系统最简：备份 = 拷目录，ffmpeg 与浏览器 `<audio>` 直接用文件；对象存储（OSS）是面向多设备/云端的复杂度，MVP 不引入（本工作间唯一远端是 DashScope TTS API）；DB blob 拖累数据库、播放要经 API 全量读出。
- 素材保留 wav 原样：素材是中间件、反复读写，转码只省空间不省钱（mp3 只在产物层，#7）。
- 产物 = 成品快照：文件包自包含、可整包复制导出（RSS 出界后它仍是"最终文件"）；行级文稿是快照不是活数据，播放器一次读全量即可，不需要 DB 按行查询。
- 原子替换避免读到半截文件；文件名由 id 推导 → DB 权威、无孤儿文件，不需要独立 GC。

**Consequences**:

- `audio_assets` / `artifacts` 只存 ref（相对路径）+ 元数据，不存二进制；读取经后端 API 流式（`GET /api/audio/...`）。
- 行级文稿 = 脚本行 + #7 计算时间戳，随产物存 JSON；单集简介的内容生成 → ADR-0009。
- 备份/迁移 = 拷 `MEDIA_ROOT` + DB dump。
- 目录结构由 ws / ep / line id 推导，无注册表、无孤儿清理。
