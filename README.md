# AIPodCast

单用户本地播客制作工作台：AI 写稿大师（聊天式改稿，SSE 流式）→ 逐行 TTS 合成（DashScope qwen3-tts）→ 确定性后期流水线（ffmpeg：变速/停顿/响度归一/校验）→ master.mp3 产物（含逐行时间轴 transcript）。

- 技术栈：Fastify + drizzle + Postgres 17（server），React 19 + Vite + Tailwind v4 + TanStack Query（web）
- 架构与领域：见 `CONTEXT.md` 与 `docs/`（ADR 在 `docs/adr/`）
- 开发路线：`docs/modules-and-phasing.md`（里程碑票在 GitHub issues）

## 前置要求

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 22.19（见 `engines`） | 原生跑 server/web 与测试 |
| ffmpeg / ffprobe | 8.x | PATH 可寻；后期流水线逐行调用 |
| Docker | 任意 | 只装 Postgres 17（ParadeDB 发行版），见 `docker-compose.yml` |
| DashScope 凭证 | — | 写稿与 TTS 用；仅 `DASHSCOPE_API_KEY`/`DASHSCOPE_BASE_URL` |

## 启动

```bash
# 1. 装依赖（npm workspaces：server + web 一次装齐）
npm install

# 2. 起数据库
docker compose up -d --wait

# 3. 环境变量：从样例复制为 server/.env，至少填 DASHSCOPE_API_KEY
cp server/.env.example server/.env

# 4. 建表（drizzle 迁移）
npm run migrate

# 5. 开发服务（server 3000 + web 5173，/api 代理到 3000）
npm run dev          # 两端同时跑（concurrently）
# 或分开跑：
#   npm run dev -w server
#   npm run dev -w web
```

浏览器打开 http://localhost:5173 。媒体文件（素材/产物）落 `MEDIA_ROOT`（默认 `<repo>/media`）。

## 测试与检查

```bash
npm test             # 全部 workspace（server 测试需要上面的 Postgres 在跑）
npm test -w web      # web 单独（vitest）
npm test -w server   # server 单独（node:test，真 DB + 真 ffmpeg + stub TTS）
npm run typecheck    # 两端 tsc
npm run build -w web # web 构建（tsc -b + vite build）
npm run lint -w web  # oxlint
```

## 目录速览

```
server/src/modules/   workspaces / script / synthesis（tts·jobs）/ post（pipeline）/ writer（PI SDK 会话）/ artifacts
web/src/              lib/api（契约类型与端点封装）· features（writer-chat / audio-workspace / script-panel）· stores
docs/                 api-and-dataflow · frontend-structure · synthesis-progress-and-cancel · adr/ · research/
```
