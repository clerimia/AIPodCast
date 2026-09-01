# 后端模块拆分与实现顺序/分期

> 决议来源：[#21 模块拆分与实现顺序/分期](https://github.com/clerimia/AIPodCast/issues/21)（wayfinder 地图 #14）。
> 上界：技术栈与边界照地图 #14 Notes 不翻（Fastify + drizzle + Postgres 17；PI SDK 进程内嵌入，工具面仅 read/add/edit；TTS 走 DashScope HTTP；后期 = ffmpeg CLI）；#19（接口与数据流）、#20（前端结构）、`docs/audio-params.md`、`docs/data-model-draft.md` 为输入。
> 本文档是**模块拆分 + 实现顺序方案**（计划层，plan not do），给实现阶段开工用；接口形状以 `docs/api-and-dataflow.md` 为准。

## 一句话

后端落在仓库根的 `server/`（Fastify 单进程、ESM、端口 **3000**），按领域切 **六个模块**（工作间配置 / 脚本 / 写稿大师运行时 / 合成 / 后期 / 产物·媒体）+ `db/` 层；实现顺序走 **M0 骨架 → M1 工作间 → M2 脚本·暂存门 → M3 写稿大师 SSE → M4 单行合成·试听 → M5 整集合成·产物 → M6 收尾**，每个里程碑以「可运行的东西」收尾，M3 与 M4 相互独立可并行。

## 仓库布局

```
AIPodCast/
  package.json          # npm workspaces: ["server", "web"]；脚本入口（dev / migrate）
  docker-compose.yml    # 只装 Postgres 17（server/web 在宿主机跑）
  server/               # 本文档：Fastify 后端
  web/                  # #20 已定：Vite + React 前端
  docs/
  media/                # MEDIA_ROOT（gitignore）：ws-{id}/ep-{id}/assets|artifacts
```

- **npm workspaces** 根编排：一条 `npm install` 装两端，`npm run dev -w server` / `-w web` 分头起。
- **`shared/` 类型包本期不抽**（#20 遗留决定，归此票）：接口契约 = `docs/api-and-dataflow.md`，前端照它手写 `lib/api/types.ts`。~20 端点、单用户本地应用，共享包的构建耦合不值；workspaces 布局已为其留位，将来漂移痛了再抽。
- **端口 3000 定案**：#20 的默认值即定值，`vite.config.ts` proxy 无需改。
- **server 全 ESM**（`"type": "module"`）：PI SDK ESM-only，Node ≥ 22.19（本机 22.23.1 ✓）。
- **docker-compose 只装 Postgres 17**：PI SDK 进程内嵌入、DashScope 走宿主机 fetch、ffmpeg 是本地二进制（8.1.1 ✓），都不进容器。

## 后端模块拆分

分层：`app.ts`（Fastify 组装：插件、路由注册、统一错误形状、media 静态服务）+ `db/` + `modules/<domain>/`（routes + service）+ `shared/`。

```
server/
  package.json  tsconfig.json  drizzle.config.ts  .env.example
  src/
    app.ts  env.ts                  # env：PORT / DATABASE_URL / MEDIA_ROOT / DASHSCOPE_*
    db/
      schema.ts                     # drizzle 全表（对照 data-model-draft.md）
      client.ts  migrate.ts
    modules/
      workspaces/                   # 工作间配置
        routes.ts  service.ts
      script/                       # 脚本服务（文本层真相源）
        routes.ts  service.ts
        apply-ops.ts                # ops 应用纯函数（add/edit/delete/reorder → serial 重编，可单测）
      writer/                       # 写稿大师运行时（PI SDK 进程内嵌入）
        session.ts                  # 会话生命周期：Map<episodeId,AgentSession> 懒创建/恢复（id=episodeId）/abort；conversations 行
        tools.ts                    # read/add/edit（TypeBox 参数；只调 script service 文本层函数）
        context.ts                  # system prompt：Layer 3 静态种子（前五层）+ 关 discovery；Layer 2 before_agent_start 每轮覆盖第六层（DB 元数据）
        sse.ts                      # PI 事件 → 浏览器事件词汇（#19 映射表）
        history.ts                  # JSONL → history 列表（过滤 display:false）
      synthesis/                    # 合成编排（确定性，非 AI）
        service.ts                  # synthesizeLine（preview/批量共用）+ 整集编排 + 任务状态
        tts.ts                      # DashScope qwen3-tts-instruct-flash HTTP fetch → wav 24k mono
        asset.ts                    # audio_assets 命中/回填；MEDIA_ROOT 原子写（临时文件→rename）
        jobs.ts                     # 合成任务编排：synthesis_jobs 表落库 + 进程内运行态（AbortController/取消旗标）
      post/                         # 后期流水线（纯 ffmpeg，文件进文件出）
        pipeline.ts                 # atempo→gap→concat→loudnorm 两遍→时间戳→验证→mp3（audio-params.md 七步）
        gaps.ts  verify.ts          # 停顿档位表；ffprobe 确定性验证（≤150ms 容差、时间戳单调）
      artifacts/                    # 产物/媒体
        routes.ts  media.ts         # GET artifact；GET /media/* Range 流式
      resources/                    # 资源摄入与检索（M7，ADR-0011）
        routes.ts                   # 列表/详情/删除/上传摄入/粘贴摄入/替换/向量化
        service.ts                  # 摄入/列表/详情/替换/删除/向量化事务编排
        convert.ts                  # 文件 → markdown：md/txt 直读；docx/pdf 走 uvx markitdown[docx,pdf]
        chunk.ts                    # markdown 感知切块（标题边界 + 长度上限 + 重叠；纯函数）
        embed.ts                    # DashScope text-embedding-v4 客户端（best-effort，失败返 null）+ makeNullEmbedder
        retrieve.ts                 # BM25 + 向量双通道 + RRF 等权融合（纯函数）+ 编排
    shared/
      errors.ts  serial.ts          # 统一错误形状；L001 编解码/重编
```

### 模块职责与禁区

| 模块 | 职责（#19 端点归属） | 不做什么 |
|---|---|---|
| workspaces | 工作间/节目元数据/说话人/单集 CRUD（#19 表 1）；建单集连带 conversations + post_rules 默认行 | 不碰脚本/音频/会话 |
| script | GET script；POST /changes（事务：ops→script_lines + change_sets/ops + 作废素材）；post 参数两个 PATCH | 不碰 TTS/ffmpeg；不 import writer |
| writer | POST writer/messages（响应即 SSE）、abort、history；三工具 + Layer3 静态种子/Layer2 每轮覆盖第六层 prompt + 事件映射 | 工具只达 script service 文本层——**ADR-0005 边界靠依赖方向兑现**，够不到 synthesis/post/artifacts |
| synthesis | preview（同步单行）、synthesize（异步 202）、synthesis-jobs 轮询；逐行取/合成素材 | 不自己跑 ffmpeg（调 post）；不是 AI 会话 |
| post | 纯流水线：素材文件 + 参数 → master + transcript | 无 DB 访问、无 DashScope——纯函数易测 |
| artifacts | GET artifact、/media Range 流式 | 不写业务状态 |
| resources | 资源摄入（multipart 上传 + 文本粘贴）、列表/详情/替换/删除/向量化、检索（BM25 + 向量 + RRF 等权融合） | 不碰脚本/音频/后期；不 import writer/script/synthesis/post/artifacts；只走 db/ 与同模块纯函数 |

### 关键 wiring 决策

1. **依赖方向单向**：`writer → script`（工具进程内直调服务层函数）；`writer → resources`（`retrieve` 工具进程内直调 `retrieve.ts` 检索函数，只读路径，「AI 不碰音频」边界不变）；`synthesis → script`（读行）+ `post`（拼 master）+ `tts`；`script` 不依赖任何音频模块（作废素材 = 事务内删 `audio_assets` 行，一个 DB 操作，不调 synthesis）；`artifacts` 只读。`resources` 只依赖 `db/` 与 `shared/`，不碰 writer/script/synthesis/post/artifacts。
2. **ChangeSet→会话通知的编排放路由层**：`POST /changes` 路由先 `script.service.applyChanges`（事务），成功后再 `writer.session.notifyChangeSet`（会话存在且 idle 时 `sendCustomMessage(triggerTurn:false)`）——script 服务不 import writer，避免环。
3. **preview 与整集共用 `synthesizeLine`**（ADR-0006）：命中素材直接返回，未命中 TTS 后回填；整集 job 循环调它。
4. **合成任务落库 `synthesis_jobs`**（#28 重新讨论，替代原「内存 `Map`」定案）：任务创建插行、状态迁移落库，重启时非终态孤儿行标 `interrupted`（终态，不自动续跑——重新合成命中素材复用）；运行期句柄（AbortController/取消旗标）留进程内。**编排形态仍为进程内 async 循环**：TTS fetch + ffmpeg 子进程全是 I/O、无 CPU 密集段，不引入队列/worker 进程/任务库（#28 定案）。#22 的取消/细粒度进度照旧 M6。
5. **媒体目录**照 data-model-draft.md：`media/ws-{id}/ep-{id}/assets/{lineId}.wav`、`.../artifacts/{master.mp3,transcript.json,notes.md}`；先写临时文件再原子 rename。
6. **drizzle 迁移只建有业务路径的表**：workspaces、show_metadata、speakers、episodes、script_lines、change_sets、change_set_ops、audio_assets、post_rules、conversations、artifacts、synthesis_jobs。**不建** `messages`（地图出界）与 `asset_library`（素材库出界，无读写路径；ADR-0006 预留在数据模型文档层，不等于建表）。

## 实现顺序/分期

原则：

- **每个里程碑收尾 = 一个可运行的东西**（tracer bullet：真 DB、真端点、真页面，不用 mock 撑场）。
- **外部依赖风险先行**：PI SDK 嵌入（M3 头一个 spike）与 DashScope TTS（M4 第一行代码）各由「最小调通」起步，再长成完整功能。
- **垂直切片**：每期后端端点 + 前端消费一起落（#19 的消费方式即验收标准），不留「只做后端」的半层。
- **M3 ⊥ M4**：写稿不依赖音频、音频不依赖写稿（都只依赖 M2 的脚本服务 + M1 的说话人），可并行或换序。

```mermaid
flowchart LR
  M0[M0 骨架与数据层] --> M1[M1 工作间配置] --> M2[M2 脚本·暂存门]
  M2 --> M3[M3 写稿大师 SSE]
  M2 --> M4[M4 单行合成·试听]
  M3 --> M5[M5 整集合成·产物]
  M4 --> M5
  M5 --> M6[M6 收尾]
  M6 --> M7[M7 资源摄入与检索]
```

| 期 | 后端 | 前端 | 收尾时能跑通什么 |
|---|---|---|---|
| **M0 仓库骨架与数据层** | workspaces 根编排；`server/` Fastify + drizzle + compose(Postgres 17) + health；env 加载；**全部 drizzle 迁移** | `web/` Vite 脚手架（#20 全套：router / TanStack Query / Zustand / shadcn / `lib/api` 骨架）+ proxy→3000 | 两端起得来，health 通，迁移跑过 |
| **M1 工作间配置** | workspaces 模块全套（#19 表 1：工作间/元数据/说话人/单集 CRUD，含删除说话人 409） | HomePage（列表/建工作间/建单集进入）+ WorkspaceSettingsPage（元数据表单 + 说话人增删改） | 建工作间→建说话人→建单集，刷新不丢 |
| **M2 脚本与暂存门** | script 模块：GET script、POST /changes（事务 + ChangeSet + 作废素材 + serial 重编）、post 参数两 PATCH | EpisodePage 上下两半布局骨架 + script-panel（staging store、暂存条、`applyOps` 单测）；会话通知路由编排此处接好（writer 未上，空实现） | 手动加行→暂存编辑→提交：serial 重编、刷新持久；无 AI 也能管脚本 |
| **M3 写稿大师 SSE** | **先 spike**：进程内嵌 PI SDK 最小 read 调用（验 #19 验证项 1 + DashScope compat 参数）；writer 模块全套（Map 懒创建会话、三工具、Layer3 静态种子+Layer2 每轮覆盖第六层 prompt、SSE 映射、abort、history） | writer-chat feature：useWriterRun + SSE 手解、气泡流、运行状态条、`script:changed` 防抖失效、停止按钮 | 「写段开场白」→ 流式气泡 + 工具状态条 + 脚本行实时刷新落库——语言生成核心链路通 |
| **M4 单行合成·试听** | **先最小调通** tts.ts（请求体 `input{text,voice,language_type,instructions}` → wav 24k mono）；asset 命中/回填；preview 同步端点；/media Range 流式 | audio-workspace 上半：试听按钮 + 播单行 wav、「需重新合成」标记（invalidatedLineIds）、停顿/语速下拉（PATCH 两端点） | 点试听听声音；改台词提交后行标「需重新合成」；停顿/语速落库即时生效 |
| **M5 整集合成·产物** | post 流水线七步（audio-params.md）；synthesis 异步编排 + `synthesis_jobs` 落库（重启孤儿任务标 `interrupted`；行级 preview 互斥）；synthesize 202 + synthesis-jobs + artifact；产物整包替换（验证失败保留旧产物） | MasterPlayer + useSynthesisJob 轮询（refetchInterval 2s）+ transcript 行级高亮 + 整集合成按钮 + **合成前自动提交**编排（ensureCommitted） | **端到端闭环**：对话写稿→提交改动→试听→整集合成→播 master + 行级高亮。MVP 达成 |
| **M6 收尾（无新功能）** | 错误路径打磨（preview 失败语义与超时，#19 验证项 3）；#22 决议落地（进度/取消扩展 jobs） | 流式气泡合帧、`<audio>` seek 高亮漂移（#20 验证项）；toast/重试补齐；启动文档 | MVP 打磨完成，交付 |
| **M7 资源摄入与检索** | **先 spike**：ParadeDB pg_search 中文 BM25（`chinese_compatible` 分词）/ DashScope `text-embedding-v4` 端点形状与限额 / `uvx markitdown[docx,pdf]` CLI 冷启动与编码坑；迁移 0003 加 `vector` + `pg_search` 扩展 + 手写 BM25 索引（drizzle-kit 不管）；`server/src/modules/resources/{routes,service,convert,chunk,embed,retrieve}.ts`（`embed`/`retrieve` 失败 best-effort 返 null）；writer 第四工具 `retrieve`（闭包锁 `wsId`、可选 `mode` 参数 = hybrid/bm25/vector）；Layer 2 第六层追加工作间资源清单 | `web/src/features/resources/` 资源卡片（列表 / 上传 / 粘贴 / 替换 / 删除 / 向量化按钮 + 状态徽标）；`web/src/lib/api/{resource,types}.ts`；挂在 `WorkspaceSettingsPage`；CONTEXT.md 补「块 (Chunk)」术语 + `retrieve` 工具的 mode 描述 | 上传 .md/.txt 直读 / .docx/.pdf 走 markitdown→ 切块 → 入库；点「向量化」补向量；写稿大师可 `retrieve` 按工作间查资料，hybrid/bm25/vector 三通道自由切换；替换事务回滚保旧 |

## 与 ADR / 边界的对齐

- **ADR-0005**：writer 模块依赖方向单向指向 script，synthesis/post/artifacts 不被 writer 触达——模块 wiring 即边界，不靠约定自觉。
- **ADR-0007**：post 是纯函数模块（文件进文件出、无 DB 无网络），synthesis 编排不掺 AI；验证失败保留旧产物落在 artifacts 替换逻辑。
- **ADR-0006/0001**：preview 与批量共用 `synthesizeLine`；作废素材 = script 事务内删 `audio_assets` 行。
- **ADR-0003/0002**：确认门事务 + ChangeSet 落在 script 模块；会话通知由路由层编排（`triggerTurn:false`）。
- **#19**：每期端点归属见表；SSE 事件词汇照 #19 映射表逐字实现，前端不认 PI 事件名。
- **#20**：前端各 feature 随对应里程碑落；`shared/` 不抽、端口 3000 两处遗留疑问就此定案。

## 实现阶段验证项（未确证 / 待验证）

1. **PI SDK 嵌入 spike（M3 第一件事）**：会话走 `Map<episodeId, AgentSession>` 懒建 + per-episode loader（非裸 `createAgentSession`）。`tool_execution_start` 是否真发出；DashScope 专属端点对 `developer` role / `reasoning_effort` 的接受度（`compat.supportsDeveloperRole` 等，#16 附注）。另验 Layer 2：改设置页元数据后下一轮 prompt 末尾含新值、未改时逐字节不变命中缓存（`before_agent_start` 每轮覆盖第六层生效）。
2. **TTS 最小调用（M4 第一件事）**：`input` 四字段请求与返回形态（流/文件）按 `docs/research/qwen3-tts-instruct-flash.md` 对齐；错误码语义。
3. **ffmpeg 8.x 的 loudnorm 两遍线性**：`linear=true` 传递方式与 print_format JSON 解析。
4. **preview 同步超时**：Fastify 路由级超时设置；TTS 失败返回 `{error}` 不吞 5xx。
