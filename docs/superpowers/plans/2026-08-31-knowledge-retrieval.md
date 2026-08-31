# 知识摄入与检索（资源模块）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地工作间级知识库：文件上传/粘贴 → markitdown 转 markdown → 切块 → 批量 embedding → 双索引落库（pg_search BM25 + pgvector），写稿大师新增第四工具 `retrieve`（BM25 + 向量双通道，应用侧 RRF 融合），设置页新增资源管理卡片。

**Architecture:** 新增后端模块 `server/src/modules/resources/`（routes/service/convert/chunk/embed/retrieve 六文件），只依赖 `db/`；writer → resources 单向依赖（`makeWriterTools` 增加 `retrieve` 工具 + Layer 2 第六层追加资源清单）；前端 `web/src/features/resources/` 走 REST 挂在工作间设置页。向量通道由 `RETRIEVAL_MODE=hybrid|bm25` 在检索层开关；摄入永远尽力 embed（失败置 NULL）。

**Tech Stack:** Fastify 5 + @fastify/multipart、drizzle-orm（pg-core `vector`）、ParadeDB pg17（pg_search BM25 + pgvector）、DashScope `text-embedding-v4`（compatible-mode）、`uvx markitdown[pdf]` CLI 子进程、React 19 + TanStack Query。

**Spec:** `docs/superpowers/specs/2026-08-31-knowledge-retrieval-design.md`（已批准）。

---

## 文件结构

**新建（后端）：**
- `server/src/modules/resources/chunk.ts` — markdown 感知切块纯函数
- `server/src/modules/resources/embed.ts` — DashScope embeddings 客户端（best-effort，失败返 null）
- `server/src/modules/resources/convert.ts` — 文件 → markdown（md/txt 直读；docx/pdf 走 uvx markitdown 子进程）
- `server/src/modules/resources/retrieve.ts` — BM25 通道 + 向量通道 + RRF 融合（纯函数）+ 编排
- `server/src/modules/resources/service.ts` — 摄入/列表/详情/替换/删除的事务编排
- `server/src/modules/resources/routes.ts` — REST（multipart 上传 + JSON 粘贴）
- `server/test/chunk.test.ts`、`server/test/embed.test.ts`、`server/test/convert.test.ts`、`server/test/retrieve.test.ts`（RRF 纯函数）、`server/test/resources.test.ts`（真 DB 集成）
- `server/test/fixtures.ts` — 手写最小 docx/pdf 夹具生成器 + `hasUvx()`
- `server/scripts/spike-bm25.ts`、`server/scripts/spike-embedding.ts`、`server/scripts/spike-markitdown.ts`
- `server/drizzle/0003_*.sql`（drizzle-kit 生成后手工补扩展与 BM25 索引）
- `docs/research/knowledge-retrieval-spikes.md`（spike 结论）
- `docs/adr/0011-hybrid-resource-retrieval.md`

**修改（后端）：**
- `server/src/db/schema.ts` — resources + resource_chunks 两表 + 关系
- `server/src/env.ts` — `RETRIEVAL_MODE`
- `server/src/app.ts` — 注册 @fastify/multipart、decorate `embedder`、注册 resourceRoutes、`BuildAppOptions.embedder`
- `server/src/modules/writer/tools.ts` — 第四工具 `retrieve`（构造参数加可选 `embedder`）
- `server/src/modules/writer/session.ts` — `WriterRuntime` 透传 `embedder`
- `server/src/modules/writer/context.ts` — 第六层追加资源清单 + 静态种子工具面描述
- `server/package.json` — 依赖 @fastify/multipart + 三个 spike 脚本

**新建（前端）：**
- `web/src/features/resources/ResourceList.tsx`、`web/src/features/resources/PasteDialog.tsx`
- `web/src/lib/api/resource.ts`

**修改（前端）：**
- `web/src/lib/api/types.ts`（Resource 类型）、`web/src/lib/api/http.ts`（`upload`）、`web/src/lib/api/keys.ts`（`resources` 键）
- `web/src/routes/WorkspaceSettingsPage.tsx` — 挂 `<ResourceList/>`

**文档：** `CONTEXT.md`（块条目）、`docs/data-model-draft.md`、`docs/modules-and-phasing.md`、`README.md`

**依赖方向不变式（每个任务自检）：** resources 只 import `db/`、`shared/`；writer 可 import resources（单向）；前端只走 REST。

**命令约定：** 仓库根为 `E:/Project/AIPodCast`（Git Bash）。测试需 DB：`npm run db:up`；server 单测跑单文件 = 在 `server/` 目录 `npx tsx --test test/<file>`；全量 = `npm test -w server`（`--test-concurrency=1`，真 DB）；类型检查 = `npm run typecheck`。

---

### Task 1: 三个实现前 spike（BM25 中文 / embedding 端点 / markitdown CLI）

**Files:**
- Create: `server/test/fixtures.ts`
- Create: `server/scripts/spike-bm25.ts`
- Create: `server/scripts/spike-embedding.ts`
- Create: `server/scripts/spike-markitdown.ts`
- Create: `docs/research/knowledge-retrieval-spikes.md`
- Modify: `server/package.json`（scripts 段）

- [ ] **Step 1: 写测试夹具生成器（手写最小 docx/pdf，STORE 方式 zip）**

`server/test/fixtures.ts`：

```ts
// 知识摄入测试夹具：手写最小 docx（STORE zip 三件套）与最小 pdf（单页文本流）。
// 不引第三方库——docx 只需 word/document.xml 有 <w:t> 文本，markitdown 即可提取。
import { spawn } from 'node:child_process'

export function makeDocxFixture(paragraphs: string[]): Buffer {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>'
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>'
  const body = paragraphs.map((p) => `<w:p><w:r><w:t>${esc(p)}</w:t></w:r></w:p>`).join('')
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${body}</w:body></w:document>`
  const entries = [
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rels, 'utf8') },
    { name: 'word/document.xml', data: Buffer.from(document, 'utf8') },
  ]
  return buildStoreZip(entries)
}

/** 最小 pdf：单页、未压缩文本流；文本经 pdfminer 可提取 */
export function makePdfFixture(text: string): Buffer {
  const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  const stream = `BT /F1 12 Tf 72 720 Td (${esc(text)}) Tj ET`
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${i + 1} 0 obj\n${obj}\nendobj\n`
  })
  const xrefPos = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) pdf += `${off.toString().padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

/** STORE（不压缩）zip：local file header + 中央目录，够 docx 解析器用 */
function buildStoreZip(entries: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(0, 8) // method: store
    local.writeUInt16LE(0, 10) // mod time
    local.writeUInt16LE(0, 12) // mod date
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18) // compressed
    local.writeUInt32LE(data.length, 22) // uncompressed
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28) // extra len
    parts.push(local, nameBuf, data)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0, 8)
    cd.writeUInt16LE(0, 10)
    cd.writeUInt16LE(0, 12)
    cd.writeUInt16LE(0, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(data.length, 20)
    cd.writeUInt32LE(data.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const cdBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cdBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, cdBuf, end])
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xff]! ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** 本机是否有 uv/uvx（markitdown 运行环境）；没有则相关测试标记跳过 */
export function hasUvx(): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('uvx', ['--version'], { windowsHide: true })
    child.on('error', () => resolve(false))
    child.on('close', (code) => resolve(code === 0))
  })
}
```

- [ ] **Step 2: 写 spike 1 脚本（ParadeDB pg_search 中文 BM25）**

`server/scripts/spike-bm25.ts`：

```ts
// Spike 1：ParadeDB pg17 镜像内 pg_search BM25 的建索引语法与中文分词实际效果。
// 结论落 docs/research/knowledge-retrieval-spikes.md；若语法/分词器有变，
// 同步改迁移 0003 的建索引 SQL 与 retrieve.ts 的查询形状。
// 用法：npm run spike-bm25 -w server（DB 需在跑：npm run db:up）
import postgres from 'postgres'
import { env } from '../src/env.js'

const sql = postgres(env.databaseUrl, { max: 1 })
try {
  await sql`CREATE EXTENSION IF NOT EXISTS pg_search`
  await sql`DROP TABLE IF EXISTS spike_bm25`
  await sql`CREATE TABLE spike_bm25 (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), content text NOT NULL)`
  await sql`INSERT INTO spike_bm25 (content) VALUES
    ('量子计算的纠错码是当前工程难点'),
    ('今天聊聊播客制作的后期流水线'),
    ('量子比特与经典比特的本质区别')`
  // 验证项：chinese_compatible 分词器对中文查询的命中
  await sql`CREATE INDEX spike_bm25_idx ON spike_bm25
    USING bm25 (id, content)
    WITH (key_field='id', text_fields='{"content": {"tokenizer": {"type": "chinese_compatible"}, "record": "freq"}}')`

  const hits = await sql`
    SELECT content, paradedb.score('spike_bm25_idx') AS score
    FROM spike_bm25 WHERE content @@@ '量子' ORDER BY score DESC`
  console.log('查询「量子」命中：', hits.length)
  for (const r of hits) console.log(' -', r.score, r.content)
  if (hits.length !== 2) throw new Error('期望命中两条量子行，实际 ' + hits.length)

  // 验证项：查询串含 tantivy 特殊字符时是否报错（应用侧会做 sanitize，这里探裸查询行为）
  try {
    const special = await sql`SELECT count(*)::int AS n FROM spike_bm25 WHERE content @@@ '后期 (流水线)'`
    console.log('特殊字符裸查询可执行，命中：', special[0]!.n)
  } catch (err) {
    console.log('特殊字符裸查询报错（预期内，应用侧已清洗）：', (err as Error).message.slice(0, 200))
  }
  console.log('SPIKE OK：建索引语法与 @@@ 查询可用；把分词效果结论写入 docs/research/knowledge-retrieval-spikes.md')
} finally {
  await sql`DROP TABLE IF EXISTS spike_bm25`
  await sql.end({ timeout: 1 })
}
```

- [ ] **Step 3: 写 spike 2 脚本（DashScope text-embedding-v4 端点形状）**

`server/scripts/spike-embedding.ts`：

```ts
// Spike 2：DashScope text-embedding-v4 compatible-mode 端点：请求形状、维度、批量上限。
// 用法：npm run spike-embedding -w server（凭证从 server/.env / 仓库根 .env 加载）
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadEnv } from 'dotenv'

const serverDir = fileURLToPath(new URL('..', import.meta.url))
loadEnv({ path: join(serverDir, '.env') })
loadEnv({ path: join(serverDir, '../.env') })

const apiKey = process.env.DASHSCOPE_API_KEY
if (!apiKey) throw new Error('missing DASHSCOPE_API_KEY')
const base = (process.env.DASHSCOPE_BASE_URL ?? 'https://dashscope.aliyuncs.com').replace(/\/+$/, '')
const url = `${base}/compatible-mode/v1/embeddings`

async function embed(inputs: string[]) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-v4', input: inputs, dimensions: 1024 }),
  })
  const payload = (await res.json()) as {
    data?: { embedding: number[]; index: number }[]
    error?: { code?: string; message?: string }
  }
  return { status: res.status, payload }
}

// 验证项 1：两条文本 + dimensions=1024 被接受
const two = await embed(['你好，世界', '量子计算的纠错码'])
console.log('批量 2：', two.status, '维度：', two.payload.data?.map((d) => d.embedding.length))
if (two.status !== 200 || two.payload.data?.length !== 2 || two.payload.data[0]?.embedding.length !== 1024) {
  throw new Error('批量 2 / 1024 维未按预期：' + JSON.stringify(two.payload.error ?? two.status))
}

// 验证项 2：单次批量上限（官方限额 10；探 10 与 11）
const ten = await embed(Array.from({ length: 10 }, (_, i) => `文本 ${i}`))
console.log('批量 10：', ten.status)
const eleven = await embed(Array.from({ length: 11 }, (_, i) => `文本 ${i}`))
console.log('批量 11：', eleven.status, JSON.stringify(eleven.payload.error ?? 'ok').slice(0, 200))

console.log('SPIKE OK：把批量上限与错误码结论写入 docs/research/knowledge-retrieval-spikes.md')
```

- [ ] **Step 4: 写 spike 3 脚本（uvx markitdown CLI）**

`server/scripts/spike-markitdown.ts`：

```ts
// Spike 3：uvx markitdown[pdf] CLI：冷启动时长、参数与输出形态、二进制转换产物。
// 夹具由 test/fixtures.ts 手写生成（最小 docx/pdf，不引第三方库）。
// 用法：npm run spike-markitdown -w server（本机需安装 uv 并在 PATH）
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeDocxFixture, makePdfFixture } from '../test/fixtures.js'

function runMarkitdown(fileBytes: Buffer, filename: string): Promise<{ ms: number; stdout: string; stderr: string; code: number | null }> {
  return (async () => {
    const dir = await mkdtemp(join(tmpdir(), 'spike-markitdown-'))
    const file = join(dir, filename)
    await writeFile(file, fileBytes)
    const startedAt = Date.now()
    try {
      return await new Promise<{ ms: number; stdout: string; stderr: string; code: number | null }>((resolve) => {
        const child = spawn('uvx', ['--from', 'markitdown[pdf]', 'markitdown', file], { windowsHide: true })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', (c: Buffer) => { stdout += c.toString() })
        child.stderr.on('data', (c: Buffer) => { stderr += c.toString() })
        child.on('error', (err) => resolve({ ms: Date.now() - startedAt, stdout, stderr: String(err), code: null }))
        child.on('close', (code) => resolve({ ms: Date.now() - startedAt, stdout, stderr, code }))
      })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })()
}

const docx = makeDocxFixture(['这是文档第一段。', '第二段提到量子计算。'])
const r1 = await runMarkitdown(docx, 'sample.docx')
console.log('docx：', r1.ms, 'ms；code=', r1.code)
console.log(r1.stdout)
if (r1.code !== 0 || !r1.stdout.includes('量子计算')) {
  throw new Error('docx 转换未达预期：' + r1.stderr.slice(-300))
}

const pdf = makePdfFixture('PDF 正文：播客后期流水线')
const r2 = await runMarkitdown(pdf, 'sample.pdf')
console.log('pdf：', r2.ms, 'ms；code=', r2.code)
console.log(r2.stdout)
if (r2.code !== 0 || !r2.stdout.includes('播客后期流水线')) {
  console.log('注意：最小 pdf 未被提取出文本时，把该事实记入结论（集成测试对该夹具降级断言「转换不报错」）')
}
console.log('SPIKE OK：把冷启动时长/参数形态/失败退出码结论写入 docs/research/knowledge-retrieval-spikes.md')
```

- [ ] **Step 5: 登记 npm scripts**

`server/package.json` 的 `scripts` 段，在 `"spike-tts"` 之后追加三行：

```json
    "spike-bm25": "tsx scripts/spike-bm25.ts",
    "spike-embedding": "tsx scripts/spike-embedding.ts",
    "spike-markitdown": "tsx scripts/spike-markitdown.ts"
```

- [ ] **Step 6: 逐个跑 spike 并记录结论**

```bash
npm run db:up
npm run spike-bm25 -w server
npm run spike-embedding -w server
npm run spike-markitdown -w server
```

预期：三条都以 `SPIKE OK` 结束。把结论写入 `docs/research/knowledge-retrieval-spikes.md`：

```markdown
# 知识摄入与检索：实现前验证（spike 结论）

> 2026-08-31；脚本：server/scripts/spike-{bm25,embedding,markitdown}.ts

## 1. ParadeDB pg_search BM25 中文
- 建索引语法：（照抄验证通过的 WITH 参数）
- 分词器：chinese_compatible 对中文词命中效果：……
- 特殊字符裸查询：……（应用侧已清洗）
- 对实现的影响：迁移 0003 与 retrieve.ts 是否需调整：是/否（改哪里）

## 2. DashScope text-embedding-v4
- 端点：{base}/compatible-mode/v1/embeddings；dimensions=1024 接受：是/否
- 单次批量上限：……；超限错误码：……
- 对实现的影响：EMBED_BATCH_SIZE 取 …

## 3. uvx markitdown[pdf]
- 冷启动：首跑 …ms / 热跑 …ms
- 参数形态：`uvx --from markitdown[pdf] markitdown <file>`，stdout = markdown：是/否
- 失败退出码：…；最小 pdf 夹具提取：成功/降级断言
```

若某条 spike 结论与本计划默认形状冲突（如分词器要换 `lindera`、批量上限不是 10、CLI 参数不同），**先改后续任务的对应代码再往下走**：影响点 = 迁移 0003 的建索引 SQL（Task 2）、`embed.ts` 的 `EMBED_BATCH_SIZE`（Task 4）、`convert.ts` 的 spawn 参数（Task 5）。

- [ ] **Step 7: Commit**

```bash
git add server/scripts/spike-bm25.ts server/scripts/spike-embedding.ts server/scripts/spike-markitdown.ts server/test/fixtures.ts server/package.json docs/research/knowledge-retrieval-spikes.md
git commit -m "chore(resources): 实现前 spike——BM25 中文/嵌入端点/markitdown CLI 结论"
```

---

### Task 2: 数据层——两张表 + 迁移 0003（含扩展与 BM25 索引）+ RETRIEVAL_MODE

**Files:**
- Modify: `server/src/db/schema.ts`
- Modify: `server/src/env.ts`
- Create: `server/drizzle/0003_*.sql`（drizzle-kit 生成 + 手工编辑）

- [ ] **Step 1: schema.ts 加两张表与关系**

`server/src/db/schema.ts`：

1. 顶部 `drizzle-orm/pg-core` 的 import 列表里加入 `vector`（其余保留）。
2. 在 `// ---- 音频层 ...` 注释行之前插入：

```ts
// ---- 资源层：工作间知识库（知识摄入与检索设计 2026-08-31）----

// 资源：工作间级可检索资料；content_md（markitdown 转换产物）是切块与替换的唯一真相源
export const resources = pgTable('resources', {
  id: uuid().primaryKey().defaultRandom(),
  wsId: uuid('ws_id')
    .notNull()
    .references(() => workspaces.id, { onDelete: 'cascade' }),
  title: text().notNull(),
  // md | txt | docx | pdf | paste
  kind: text().notNull(),
  contentMd: text('content_md').notNull(),
  // sha256(content_md)：同工作间重复摄入提示用
  contentHash: text('content_hash').notNull(),
  charCount: integer('char_count').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

// 资源切块（检索单位）：标题路径 + 块文本 + 可空向量。
// embedding 失败/离线置 NULL——BM25 通道不受影响（检索层开关与摄入层解耦，设计定案）
export const resourceChunks = pgTable(
  'resource_chunks',
  {
    id: uuid().primaryKey().defaultRandom(),
    resourceId: uuid('resource_id')
      .notNull()
      .references(() => resources.id, { onDelete: 'cascade' }),
    seq: integer().notNull(),
    // 标题路径（「第一章 > 1.1 背景」）；无标题文档为空串
    heading: text().notNull().default(''),
    content: text().notNull(),
    // 1024 = text-embedding-v4 维度；不建 ANN 索引（小语料精确余弦 <=>）
    embedding: vector({ dimensions: 1024 }),
    createdAt: createdAt(),
  },
  (t) => [index('resource_chunks_resource_seq_idx').on(t.resourceId, t.seq)],
)
```

3. 关系：`workspacesRelations` 改为（加 `resources: many(resources)`）：

```ts
export const workspacesRelations = relations(workspaces, ({ many }) => ({
  speakers: many(speakers),
  episodes: many(episodes),
  resources: many(resources),
}))
```

文件末尾追加：

```ts
export const resourcesRelations = relations(resources, ({ one, many }) => ({
  workspace: one(workspaces, { fields: [resources.wsId], references: [workspaces.id] }),
  chunks: many(resourceChunks),
}))

export const resourceChunksRelations = relations(resourceChunks, ({ one }) => ({
  resource: one(resources, { fields: [resourceChunks.resourceId], references: [resources.id] }),
}))
```

- [ ] **Step 2: env.ts 加 RETRIEVAL_MODE**

`server/src/env.ts`：在 `agentDirEnv()` 之后加：

```ts
// 检索形态：hybrid = BM25 + 向量；bm25 = 纯全文（向量通道整体不走）。只影响检索层
function retrievalModeEnv(): 'hybrid' | 'bm25' {
  const raw = process.env.RETRIEVAL_MODE
  if (raw === undefined || raw === '') return 'hybrid'
  if (raw === 'hybrid' || raw === 'bm25') return raw
  throw new Error(`env RETRIEVAL_MODE must be hybrid or bm25, got: ${raw}`)
}
```

`env` 对象末尾（`writerModel` 之后）加：

```ts
  // 检索形态（向量通道开关）；摄入永远尽力 embed，切换此开关零重摄入成本
  retrievalMode: retrievalModeEnv(),
```

（env 读取不设单测——与仓库现状一致；行为由 Task 10 的检索测试以显式 mode 选项覆盖。）

- [ ] **Step 3: 生成迁移并手工补扩展与 BM25 索引**

```bash
npm run db:generate -w server
```

查看 `server/drizzle/` 新生成的 `0003_*.sql`。**编辑该文件**：

文件**最顶部**（必须早于 `CREATE TABLE "resource_chunks"`，因为 `vector(1024)` 列依赖扩展）插入（保持与文件其余部分相同的 `--> statement-breakpoint` 分隔风格）：

```sql
CREATE EXTENSION IF NOT EXISTS vector;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_search;
```

文件**末尾**追加（BM25 索引 drizzle-kit 不认识，必须手写；照 Task 1 spike 1 验证过的形状，默认如下）：

```sql
--> statement-breakpoint
CREATE INDEX resource_chunks_bm25 ON resource_chunks
  USING bm25 (id, content)
  WITH (key_field='id', text_fields='{"content": {"tokenizer": {"type": "chinese_compatible"}, "record": "freq"}}');
```

- [ ] **Step 4: 跑迁移并验证**

```bash
npm run migrate -w server
```

预期：`[migrate] done: ...`。再验证索引在：

```bash
docker exec aipodcast-db psql -U postgres -d aipodcast -c "\d resource_chunks"
```

预期：列含 `embedding vector(1024)`，索引含 `resource_chunks_bm25` 与 `resource_chunks_resource_seq_idx`。

- [ ] **Step 5: 类型检查 + Commit**

```bash
npm run typecheck
git add server/src/db/schema.ts server/src/env.ts server/drizzle/
git commit -m "feat(resources): 数据层——resources + resource_chunks 两表与迁移 0003（pgvector/pg_search）"
```
### Task 3: chunk.ts——markdown 感知切块（TDD）

**Files:**
- Create: `server/src/modules/resources/chunk.ts`
- Test: `server/test/chunk.test.ts`

- [ ] **Step 1: 写失败测试**

`server/test/chunk.test.ts`：

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chunkMarkdown } from '../src/modules/resources/chunk.js'

test('空文档 / 纯空白 → 零块', () => {
  assert.deepEqual(chunkMarkdown(''), [])
  assert.deepEqual(chunkMarkdown('   \n\n\t '), [])
})

test('只有标题没有正文 → 零块', () => {
  assert.deepEqual(chunkMarkdown('# 标题\n## 子标题'), [])
})

test('单标题 + 短段落 → 一块，记录标题路径，seq 从 0', () => {
  const chunks = chunkMarkdown('# 第一章 > 引言不对——这是标题文本\n正文一段。')
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0]!.seq, 0)
  assert.equal(chunks[0]!.heading, '第一章 > 引言不对——这是标题文本')
  assert.equal(chunks[0]!.content, '正文一段。')
})

test('嵌套标题记标题路径「A > B」', () => {
  const chunks = chunkMarkdown('# A\n\n## B\n\n正文')
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0]!.heading, 'A > B')
})

test('同级标题重置栈：# A → ## B → # C 后 heading 为「C」而非「A > B > C」', () => {
  const chunks = chunkMarkdown('# A\n\n## B\n\n一\n\n# C\n\n二')
  assert.deepEqual(chunks.map((c) => c.heading), ['A > B', 'C'])
})

test('无标题文档：段落直接成块，heading 为空串', () => {
  const chunks = chunkMarkdown('第一段。\n\n第二段。')
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0]!.heading, '')
  assert.equal(chunks[0]!.content, '第一段。\n第二段。')
})

test('超长单段按 target 硬切，相邻块带重叠', () => {
  // 40 字符单段；target=20 overlap=5 → 三块：
  // [0,20) / [15,35) / [30,40)（末块为尾段，含上一块尾部重叠）
  const text = '0123456789'.repeat(4)
  const chunks = chunkMarkdown(text, { targetChars: 20, overlapChars: 5 })
  assert.equal(chunks.length, 3)
  assert.equal(chunks[0]!.content, '01234567890123456789')
  assert.equal(chunks[1]!.content, '56789012345678901234')
  assert.equal(chunks[2]!.content, '0123456789')
  assert.deepEqual(chunks.map((c) => c.seq), [0, 1, 2])
})

test('多段落按 target 累积：超过即出块', () => {
  const md = ['一二三四五六七八九十', '甲乙丙丁戊己庚辛壬癸', '子丑寅卯辰巳午未申酉'].join('\n\n')
  const chunks = chunkMarkdown(`# 节\n\n${md}`, { targetChars: 20, overlapChars: 5 })
  assert.equal(chunks.length, 3)
  assert.equal(chunks[0]!.content, '一二三四五六七八九十')
  assert.ok(chunks[1]!.content.endsWith('甲乙丙丁戊己庚辛壬癸'))
  assert.ok(chunks[2]!.content.includes('子丑寅卯辰巳午未申酉'))
})

test('默认参数可用：长文不炸、每块非空', () => {
  const para = '播客制作的一段资料。'.repeat(100)
  const chunks = chunkMarkdown(`# 大文档\n\n${para}`)
  assert.ok(chunks.length > 1)
  for (const c of chunks) assert.ok(c.content.trim().length > 0)
})
```

- [ ] **Step 2: 跑测试，确认失败**

```bash
npm test -w server -- --test-name-pattern 不存在的模式 2>/dev/null; npx tsx --test test/chunk.test.ts
```

（在 `server/` 目录执行 `npx tsx --test test/chunk.test.ts`）
预期：FAIL，`Cannot find module '../src/modules/resources/chunk.js'`。

- [ ] **Step 3: 实现 chunk.ts**

`server/src/modules/resources/chunk.ts`：

```ts
// markdown 感知切块（纯函数，可单测）：标题边界分节、节内按段落累积到
// ~target 出块、超长段硬切并带重叠；每块记录标题路径（「第三章 > 3.1 背景」）。
export interface ChunkSpec {
  /** 资源内顺序，从 0 起 */
  seq: number
  /** 标题路径；无标题文档为空串 */
  heading: string
  content: string
}

export interface ChunkOptions {
  targetChars?: number
  overlapChars?: number
}

interface Section {
  heading: string
  paragraphs: string[]
}

export function chunkMarkdown(markdown: string, opts: ChunkOptions = {}): ChunkSpec[] {
  const target = opts.targetChars ?? 400
  const overlap = Math.max(0, Math.min(opts.overlapChars ?? 50, target - 1))

  // 1) 按标题分节，节内按空行分段落
  const sections: Section[] = []
  const headingStack: { level: number; text: string }[] = []
  let current: Section | null = null
  let paragraph: string[] = []

  const flushParagraph = () => {
    if (paragraph.length > 0 && current) current.paragraphs.push(paragraph.join('\n'))
    paragraph = []
  }

  for (const line of markdown.split(/\r?\n/)) {
    const m = /^(#{1,6})\s+(.+)$/.exec(line)
    if (m) {
      flushParagraph()
      const level = m[1]!.length
      while (headingStack.length > 0 && headingStack[headingStack.length - 1]!.level >= level) {
        headingStack.pop()
      }
      headingStack.push({ level, text: m[2]!.trim() })
      current = { heading: headingStack.map((h) => h.text).join(' > '), paragraphs: [] }
      sections.push(current)
      continue
    }
    if (line.trim() === '') {
      flushParagraph()
      continue
    }
    if (!current) {
      current = { heading: '', paragraphs: [] }
      sections.push(current)
    }
    paragraph.push(line)
  }
  flushParagraph()

  // 2) 节内累积出块：超 target 即出；超长段硬切（相邻块带重叠）
  const chunks: ChunkSpec[] = []
  for (const section of sections) {
    let buf = ''
    const flush = (keepOverlap: boolean) => {
      const text = buf.trim()
      if (text !== '') chunks.push({ seq: chunks.length, heading: section.heading, content: text })
      buf = keepOverlap ? buf.slice(-overlap) : ''
    }
    for (const para of section.paragraphs) {
      let rest = para
      while (rest.length > target) {
        if (buf.trim() !== '') flush(true)
        chunks.push({ seq: chunks.length, heading: section.heading, content: rest.slice(0, target) })
        rest = rest.slice(target - overlap)
      }
      if (buf.trim() !== '' && buf.length + 1 + rest.length > target) flush(true)
      buf = buf.trim() !== '' ? `${buf}\n${rest}` : rest
    }
    flush(false)
  }
  return chunks
}
```

- [ ] **Step 4: 跑测试，确认全绿**

```bash
npx tsx --test test/chunk.test.ts
```

（`server/` 目录）预期：8 个用例全 PASS。

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/resources/chunk.ts server/test/chunk.test.ts
git commit -m "feat(resources): markdown 感知切块纯函数（标题边界 + 长度上限 + 重叠）"
```

---

### Task 4: embed.ts——DashScope text-embedding-v4 客户端（TDD）

**Files:**
- Create: `server/src/modules/resources/embed.ts`
- Test: `server/test/embed.test.ts`

- [ ] **Step 1: 写失败测试（fetchImpl 注入，全离线）**

`server/test/embed.test.ts`：

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EMBED_BATCH_SIZE, embedChunks, makeDashscopeEmbedder, type Embedder } from '../src/modules/resources/embed.js'

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status })
}

/** n 维向量：第 i 维为 1 其余 0（测试里 n 固定 1024） */
const oneHot = (i: number, n = 1024) => {
  const v = new Array<number>(n).fill(0)
  v[i] = 1
  return v
}

test('成功：按 index 排序返回、维度校验通过', async () => {
  const seen: unknown[] = []
  const embedder = makeDashscopeEmbedder({
    apiKey: 'k',
    baseUrl: 'https://example.test',
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), body: JSON.parse(String(init?.body)) })
      return jsonResponse(200, {
        data: [
          { index: 1, embedding: oneHot(1) },
          { index: 0, embedding: oneHot(0) },
        ],
      })
    }) as typeof fetch,
  })
  const result = await embedder.embed(['a', 'b'])
  assert.ok(result)
  assert.deepEqual(result[0], oneHot(0))
  assert.deepEqual(result[1], oneHot(1))
  // 端点 = BASE_URL/compatible-mode/v1/embeddings；请求带 dimensions=1024
  assert.equal(seen[0]!.url, 'https://example.test/compatible-mode/v1/embeddings')
  assert.equal((seen[0]!.body as { dimensions: number }).dimensions, 1024)
  assert.equal((seen[0]!.body as { model: string }).model, 'text-embedding-v4')
})

test('非 2xx / 网络错误 / 缺 key → null（best-effort 降级）', async () => {
  const failing = makeDashscopeEmbedder({
    apiKey: 'k',
    fetchImpl: (async () => jsonResponse(429, { error: { message: 'too many' } })) as typeof fetch,
  })
  assert.equal(await failing.embed(['a']), null)

  const throwing = makeDashscopeEmbedder({
    apiKey: 'k',
    fetchImpl: (async () => {
      throw new Error('network down')
    }) as typeof fetch,
  })
  assert.equal(await throwing.embed(['a']), null)

  const noKey = makeDashscopeEmbedder({ apiKey: null })
  assert.equal(await noKey.embed(['a']), null)
})

test('响应形状异常（条数不符 / 维度不符）→ null', async () => {
  const wrongCount = makeDashscopeEmbedder({
    apiKey: 'k',
    fetchImpl: (async () => jsonResponse(200, { data: [{ index: 0, embedding: oneHot(0) }] })) as typeof fetch,
  })
  assert.equal(await wrongCount.embed(['a', 'b']), null)

  const wrongDim = makeDashscopeEmbedder({
    apiKey: 'k',
    fetchImpl: (async () =>
      jsonResponse(200, { data: [{ index: 0, embedding: [1, 2, 3] }] })) as typeof fetch,
  })
  assert.equal(await wrongDim.embed(['a']), null)
})

test('空输入 → 空数组，不发请求', async () => {
  let called = 0
  const embedder = makeDashscopeEmbedder({
    apiKey: 'k',
    fetchImpl: (async () => {
      called++
      return jsonResponse(200, { data: [] })
    }) as typeof fetch,
  })
  assert.deepEqual(await embedder.embed([]), [])
  assert.equal(called, 0)
})

test('embedChunks：按批切分；失败批次置 null 且计数', async () => {
  const texts = Array.from({ length: EMBED_BATCH_SIZE + 2 }, (_, i) => `t${i}`)
  let call = 0
  const embedder: Embedder = {
    async embed(batch) {
      call++
      if (call === 2) return null // 第二批失败
      return batch.map((_, i) => oneHot(i))
    },
  }
  const { vectors, failedCount } = await embedChunks(embedder, texts)
  assert.equal(call, 2)
  assert.equal(failedCount, 2)
  for (let i = 0; i < EMBED_BATCH_SIZE; i++) assert.ok(vectors[i])
  assert.equal(vectors[EMBED_BATCH_SIZE], null)
  assert.equal(vectors[EMBED_BATCH_SIZE + 1], null)
})
```

- [ ] **Step 2: 跑测试，确认失败**

`server/` 目录：`npx tsx --test test/embed.test.ts`
预期：FAIL（模块不存在）。

- [ ] **Step 3: 实现 embed.ts**

`server/src/modules/resources/embed.ts`：

```ts
// DashScope text-embedding-v4（OpenAI 兼容端点）批量 embedding。
// best-effort 语义（设计定案）：任何失败（缺 key / 非 2xx / 超时 / 形状异常）一律返
// null 而非抛错——摄入时该批块 embedding 置 NULL（BM25 不受影响），检索时跳过向量通道。
// 批量上限照 Task 1 spike 2 结论（官方限额 10，留余量取 6）。
import { env } from '../../env.js'

export const EMBED_MODEL = 'text-embedding-v4'
export const EMBED_DIMENSIONS = 1024
export const EMBED_BATCH_SIZE = 6

export interface Embedder {
  /** 返回与 texts 等长同序的向量；null = 本批失败（调用方降级） */
  embed(texts: string[]): Promise<number[][] | null>
}

export interface DashscopeEmbedOptions {
  fetchImpl?: typeof fetch
  /** 缺省读 env.dashscopeApiKey；显式传 null = 无凭证（测试缺失分支用） */
  apiKey?: string | null
  /** 缺省读 env.dashscopeBaseUrl，再缺省官方主机 */
  baseUrl?: string | null
  timeoutMs?: number
}

export function makeDashscopeEmbedder(options: DashscopeEmbedOptions = {}): Embedder {
  const fetchImpl = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? 30_000
  return {
    async embed(texts) {
      if (texts.length === 0) return []
      const apiKey = options.apiKey !== undefined ? options.apiKey : env.dashscopeApiKey
      if (!apiKey) return null
      // BASE_URL 只填主机（与写稿/TTS 共用）；嵌入走 compatible-mode 端点
      const base = (options.baseUrl ?? env.dashscopeBaseUrl ?? 'https://dashscope.aliyuncs.com').replace(/\/+$/, '')
      try {
        const res = await fetchImpl(`${base}/compatible-mode/v1/embeddings`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: EMBED_MODEL, input: texts, dimensions: EMBED_DIMENSIONS }),
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!res.ok) return null
        const payload = (await res.json()) as { data?: { embedding: number[]; index: number }[] }
        const data = payload.data
        if (!Array.isArray(data) || data.length !== texts.length) return null
        const sorted = [...data].sort((a, b) => a.index - b.index)
        if (sorted.some((d) => !Array.isArray(d.embedding) || d.embedding.length !== EMBED_DIMENSIONS)) return null
        return sorted.map((d) => d.embedding)
      } catch {
        return null
      }
    },
  }
}

/** 批量嵌入：按 EMBED_BATCH_SIZE 切批，批失败不阻断——对应块向量为 null */
export async function embedChunks(
  embedder: Embedder,
  texts: string[],
): Promise<{ vectors: (number[] | null)[]; failedCount: number }> {
  const vectors: (number[] | null)[] = new Array(texts.length).fill(null)
  let failedCount = 0
  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE)
    const result = await embedder.embed(batch)
    if (result === null) {
      failedCount += batch.length
      continue
    }
    for (let j = 0; j < batch.length; j++) vectors[i + j] = result[j]!
  }
  return { vectors, failedCount }
}
```

（若 Task 1 spike 2 结论批量上限不同，改 `EMBED_BATCH_SIZE`。）

- [ ] **Step 4: 跑测试，确认全绿**

`npx tsx --test test/embed.test.ts` — 5 个用例全 PASS。

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/resources/embed.ts server/test/embed.test.ts
git commit -m "feat(resources): DashScope text-embedding-v4 客户端（best-effort，失败返 null）"
```

---

### Task 5: convert.ts——文件 → markdown（TDD）

**Files:**
- Create: `server/src/modules/resources/convert.ts`
- Test: `server/test/convert.test.ts`

- [ ] **Step 1: 写失败测试**

`server/test/convert.test.ts`：

```ts
import assert from 'node:assert/strict'
import { access } from 'node:fs/promises'
import { test } from 'node:test'
import { convertToMarkdown, kindFromFilename } from '../src/modules/resources/convert.js'
import { hasUvx, makeDocxFixture, makePdfFixture } from './fixtures.js'
import { AppError } from '../src/shared/errors.js'

test('kindFromFilename：白名单命中与拒绝', () => {
  assert.equal(kindFromFilename('笔记.md'), 'md')
  assert.equal(kindFromFilename('notes.MARKDOWN'), 'md')
  assert.equal(kindFromFilename('readme.txt'), 'txt')
  assert.equal(kindFromFilename('报告.docx'), 'docx')
  assert.equal(kindFromFilename('paper.pdf'), 'pdf')
  assert.equal(kindFromFilename('a.html'), null)
  assert.equal(kindFromFilename('noext'), null)
})

test('md/txt 直读（不进子进程）', async () => {
  const md = await convertToMarkdown(Buffer.from('# 标题\n正文', 'utf8'), 'a.md')
  assert.deepEqual(md, { kind: 'md', markdown: '# 标题\n正文' })
  const txt = await convertToMarkdown(Buffer.from('纯文本', 'utf8'), 'b.txt')
  assert.equal(txt.kind, 'txt')
  assert.equal(txt.markdown, '纯文本')
})

test('不支持的扩展名 → 400 可读错误', async () => {
  await assert.rejects(
    () => convertToMarkdown(Buffer.from('x'), 'a.html'),
    (err: unknown) => err instanceof AppError && err.statusCode === 400 && err.message.includes('不支持的文件类型'),
  )
})

test('docx/pdf 走注入的 CLI：临时文件用完即清；空产物 → 400', async () => {
  let seenFile = ''
  const ok = await convertToMarkdown(Buffer.from('x'), '报告.docx', {
    runCli: async (file) => {
      seenFile = file
      return '# 转换结果'
    },
  })
  assert.equal(ok.kind, 'docx')
  assert.equal(ok.markdown, '# 转换结果')
  assert.ok(seenFile.endsWith('.docx'))
  await assert.rejects(() => access(seenFile)) // 临时文件已清理

  await assert.rejects(
    () => convertToMarkdown(Buffer.from('x'), 'a.pdf', { runCli: async () => '   ' }),
    (err: unknown) => err instanceof AppError && err.message.includes('转换结果为空'),
  )
})

test('真 markitdown：docx 夹具转换出文本（无 uv 时跳过）', async (t) => {
  if (!(await hasUvx())) return t.skip('本机无 uv/uvx，跳过真转换测试')
  const docx = makeDocxFixture(['这是文档第一段。', '第二段提到量子计算。'])
  const result = await convertToMarkdown(docx, 'sample.docx')
  assert.equal(result.kind, 'docx')
  assert.ok(result.markdown.includes('量子计算'), result.markdown)

  const pdf = makePdfFixture('PDF 正文：播客后期流水线')
  const pdfResult = await convertToMarkdown(pdf, 'sample.pdf')
  assert.equal(pdfResult.kind, 'pdf')
  // 最小 pdf 夹具的文本提取依赖 pdfminer 宽容度（Task 1 spike 3 结论）：
  // 提取成功则断言文本在；否则只断言「转换不报错且产物非空」
  assert.ok(pdfResult.markdown.trim().length > 0)
})
```

- [ ] **Step 2: 跑测试，确认失败**

`npx tsx --test test/convert.test.ts` — FAIL（模块不存在）。

- [ ] **Step 3: 实现 convert.ts**

`server/src/modules/resources/convert.ts`（子进程模式照 `modules/post/ffmpeg.ts`：args 数组、不经 shell、超时 kill）：

```ts
// 文件 → markdown：.md/.txt 直读；.docx/.pdf 写临时文件后子进程调
// `uvx --from markitdown[pdf] markitdown <file>`（stdout = markdown，60s 超时，
// 参数形态照 Task 1 spike 3 结论）。失败 = 400 可读错误；临时文件 finally 清理，
// 转换失败零库行残留（落库在转换成功之后，见 service.ts）。
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AppError } from '../../shared/errors.js'

export type ResourceKind = 'md' | 'txt' | 'docx' | 'pdf' | 'paste'

export const MAX_FILE_BYTES = 20 * 1024 * 1024
export const MAX_PASTE_CHARS = 200_000
const CONVERT_TIMEOUT_MS = 60_000

const EXT_TO_KIND: Record<string, 'md' | 'txt' | 'docx' | 'pdf'> = {
  '.md': 'md',
  '.markdown': 'md',
  '.txt': 'txt',
  '.docx': 'docx',
  '.pdf': 'pdf',
}

export function kindFromFilename(filename: string): 'md' | 'txt' | 'docx' | 'pdf' | null {
  const dot = filename.lastIndexOf('.')
  if (dot === -1) return null
  return EXT_TO_KIND[filename.slice(dot).toLowerCase()] ?? null
}

export type CliRunner = (file: string, timeoutMs: number) => Promise<string>

/** 默认 runner：uvx markitdown；非零退出/超时/启动失败 → 400「文件解析失败」 */
export const runMarkitdown: CliRunner = (file, timeoutMs) =>
  new Promise((resolve, reject) => {
    const child = spawn('uvx', ['--from', 'markitdown[pdf]', 'markitdown', file], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    const fail = (message: string) => {
      clearTimeout(timer)
      reject(new AppError('BAD_REQUEST', message, 400))
    }
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString()
    })
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString()
    })
    child.on('error', (err) => fail(`文件解析失败：markitdown 启动失败（本机需安装 uv 并在 PATH）：${err.message}`))
    child.on('close', (code) => {
      if (timedOut) {
        fail(`文件解析失败：转换超时（${Math.round(timeoutMs / 1000)}s）`)
        return
      }
      if (code !== 0) {
        fail(`文件解析失败：markitdown 退出码 ${code}：${stderr.trim().split('\n').slice(-3).join(' ').slice(0, 500)}`)
        return
      }
      clearTimeout(timer)
      resolve(stdout)
    })
  })

export async function convertToMarkdown(
  buffer: Buffer,
  filename: string,
  opts: { runCli?: CliRunner } = {},
): Promise<{ kind: 'md' | 'txt' | 'docx' | 'pdf'; markdown: string }> {
  const kind = kindFromFilename(filename)
  if (!kind) {
    throw new AppError('BAD_REQUEST', `不支持的文件类型：${filename}（支持 .md/.txt/.docx/.pdf）`, 400)
  }
  if (kind === 'md' || kind === 'txt') {
    return { kind, markdown: buffer.toString('utf8') }
  }
  const runCli = opts.runCli ?? runMarkitdown
  const dir = await mkdtemp(join(tmpdir(), 'aipodcast-convert-'))
  const file = join(dir, `${randomUUID()}.${kind}`)
  try {
    await writeFile(file, buffer)
    const markdown = await runCli(file, CONVERT_TIMEOUT_MS)
    if (markdown.trim() === '') {
      throw new AppError('BAD_REQUEST', '文件解析失败：转换结果为空', 400)
    }
    return { kind, markdown }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
```

- [ ] **Step 4: 跑测试，确认全绿**

`npx tsx --test test/convert.test.ts` — 全 PASS（无 uv 的机器上第 5 例显示 skip，不算失败）。

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/resources/convert.ts server/test/convert.test.ts
git commit -m "feat(resources): 文件转 markdown——md/txt 直读、docx/pdf 走 uvx markitdown"
```

---

### Task 6: retrieve.ts——RRF 纯函数 + 双通道检索（TDD 纯函数部分）

**Files:**
- Create: `server/src/modules/resources/retrieve.ts`
- Test: `server/test/retrieve.test.ts`

- [ ] **Step 1: 写失败测试（只测纯函数：fuseRrf / sanitizeQuery / formatHits）**

`server/test/retrieve.test.ts`：

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatHits, fuseRrf, sanitizeQuery } from '../src/modules/resources/retrieve.js'

test('fuseRrf：单通道保持原序', () => {
  assert.deepEqual(fuseRrf([['a', 'b', 'c']]), ['a', 'b', 'c'])
})

test('fuseRrf：双通道重叠项被抬升（score = Σ 1/(60+rank)，rank 从 1）', () => {
  // b 在两通道各排第 2/第 1：1/62 + 1/61 > a 的 1/61 > c 的 1/62
  assert.deepEqual(fuseRrf([['a', 'b'], ['b', 'c']]), ['b', 'a', 'c'])
})

test('fuseRrf：三通道同 id 归并去重', () => {
  const fused = fuseRrf([['x', 'y'], ['y', 'z'], ['y', 'x']])
  assert.equal(fused[0], 'y')
  assert.equal(new Set(fused).size, fused.length)
})

test('fuseRrf：空通道 → 空结果', () => {
  assert.deepEqual(fuseRrf([]), [])
  assert.deepEqual(fuseRrf([[]]), [])
})

test('sanitizeQuery：剥掉 tantivy 语法字符，归一空白', () => {
  assert.equal(sanitizeQuery('量子 (计算) [技术]!'), '量子 计算 技术')
  assert.equal(sanitizeQuery('  a && b || c  '), 'a b c')
  assert.equal(sanitizeQuery('!!!'), '')
})

test('formatHits：《资源标题》> 标题路径：块文本；无标题路径省略箭头', () => {
  const text = formatHits([
    { chunkId: '1', resourceTitle: '量子手册', heading: '第一章 > 背景', content: '正文甲' },
    { chunkId: '2', resourceTitle: '随手记', heading: '', content: '正文乙' },
  ])
  assert.deepEqual(text.split('\n\n'), [
    '《量子手册》> 第一章 > 背景：正文甲',
    '《随手记》：正文乙',
  ])
})
```

- [ ] **Step 2: 跑测试，确认失败**

`npx tsx --test test/retrieve.test.ts` — FAIL（模块不存在）。

- [ ] **Step 3: 实现 retrieve.ts**

`server/src/modules/resources/retrieve.ts`（DB 通道的集成验证在 Task 9；本任务先把纯函数与查询形状落对）：

```ts
// 检索服务：BM25（pg_search）+ 向量（pgvector 精确余弦）双通道，应用侧 RRF 融合。
// 开关在检索层：mode 缺省读 env.retrievalMode；向量通道失败/无向量自动退化为纯
// BM25，不报错。空库短路返回引导语状态（防模型反复空检索，同说话人清单手法）。
import { and, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { resources } from '../../db/schema.js'
import { env } from '../../env.js'
import { makeDashscopeEmbedder, type Embedder } from './embed.js'

export const BM25_TOP_K = 20
export const VECTOR_TOP_K = 20
export const RRF_K = 60
export const RESULT_LIMIT = 5

export interface RetrievalHit {
  chunkId: string
  resourceTitle: string
  heading: string
  content: string
}

export interface RetrieveResult {
  status: 'empty_library' | 'no_hits' | 'ok'
  hits: RetrievalHit[]
}

export interface RetrieveOptions {
  mode?: 'hybrid' | 'bm25'
  /** 缺省现造（生产路径）；测试注入 stub */
  embedder?: Embedder
  resultLimit?: number
}

/** RRF 融合（纯函数）：通道 = 按相关性降序的 chunkId 列表；score = Σ 1/(60+rank)，rank 从 1 起 */
export function fuseRrf(channels: string[][]): string[] {
  const score = new Map<string, number>()
  for (const channel of channels) {
    channel.forEach((id, i) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + i + 1))
    })
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
}

/** tantivy 查询语法特殊字符清洗：用户文本按纯词处理 */
export function sanitizeQuery(query: string): string {
  return query
    .replace(/[+\-=&|><!()[\]{}^"~*?:\\/]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 工具结果格式：《资源标题》> 标题路径：块文本 */
export function formatHits(hits: RetrievalHit[]): string {
  return hits
    .map((h) => `《${h.resourceTitle}》${h.heading ? `> ${h.heading}` : ''}：${h.content}`)
    .join('\n\n')
}

async function bm25Channel(db: Db, wsId: string, query: string, limit: number): Promise<RetrievalHit[]> {
  const rows = await db.execute(sql`
    SELECT c.id, c.heading, c.content, r.title AS resource_title,
           paradedb.score('resource_chunks_bm25') AS score
    FROM resource_chunks c
    JOIN resources r ON r.id = c.resource_id
    WHERE r.ws_id = ${wsId} AND c.content @@@ ${query}
    ORDER BY score DESC
    LIMIT ${limit}`)
  return rows.map((r) => ({
    chunkId: String(r.id),
    resourceTitle: String(r.resource_title),
    heading: String(r.heading),
    content: String(r.content),
  }))
}

async function vectorChannel(
  db: Db,
  wsId: string,
  embedding: number[],
  limit: number,
): Promise<RetrievalHit[]> {
  const literal = `[${embedding.join(',')}]`
  const rows = await db.execute(sql`
    SELECT c.id, c.heading, c.content, r.title AS resource_title,
           c.embedding <=> ${literal}::vector AS distance
    FROM resource_chunks c
    JOIN resources r ON r.id = c.resource_id
    WHERE r.ws_id = ${wsId} AND c.embedding IS NOT NULL
    ORDER BY distance ASC
    LIMIT ${limit}`)
  return rows.map((r) => ({
    chunkId: String(r.id),
    resourceTitle: String(r.resource_title),
    heading: String(r.heading),
    content: String(r.content),
  }))
}

export async function retrieve(
  db: Db,
  wsId: string,
  query: string,
  opts: RetrieveOptions = {},
): Promise<RetrieveResult> {
  const [ws] = await db.select({ id: resources.id }).from(resources).where(eq(resources.wsId, wsId)).limit(1)
  if (!ws) return { status: 'empty_library', hits: [] }

  const q = sanitizeQuery(query)
  if (q === '') return { status: 'no_hits', hits: [] }

  const mode = opts.mode ?? env.retrievalMode
  const channels: RetrievalHit[][] = [await bm25Channel(db, wsId, q, BM25_TOP_K)]
  if (mode === 'hybrid') {
    const embedder = opts.embedder ?? makeDashscopeEmbedder()
    const vector = (await embedder.embed([query]))?.[0] ?? null
    if (vector !== null) {
      channels.push(await vectorChannel(db, wsId, vector, VECTOR_TOP_K))
    }
  }

  const fused = fuseRrf(channels.map((c) => c.map((h) => h.chunkId)))
  const byId = new Map<string, RetrievalHit>()
  for (const channel of channels) for (const hit of channel) byId.set(hit.chunkId, hit)
  const hits = fused
    .map((id) => byId.get(id))
    .filter((h): h is RetrievalHit => h !== undefined)
    .slice(0, opts.resultLimit ?? RESULT_LIMIT)
  return hits.length > 0 ? { status: 'ok', hits } : { status: 'no_hits', hits: [] }
}
```

注意：`and` import 若未被使用则删掉（此处只用到 `eq`——实现时保持 import 最小：`import { eq, sql } from 'drizzle-orm'`）。

- [ ] **Step 4: 跑测试 + 类型检查**

```bash
npx tsx --test test/retrieve.test.ts
npm run typecheck
```

预期：6 个纯函数用例全 PASS；typecheck 通过。

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/resources/retrieve.ts server/test/retrieve.test.ts
git commit -m "feat(resources): 检索服务——BM25/向量双通道 + 应用侧 RRF 融合"
```

---

### Task 7: service.ts——摄入/列表/详情/替换/删除编排

**Files:**
- Create: `server/src/modules/resources/service.ts`

（服务层全部走 DB，行为断言放 Task 8/9 的集成测试；本任务以类型检查为门。）

- [ ] **Step 1: 实现 service.ts**

`server/src/modules/resources/service.ts`：

```ts
// 资源服务：摄入编排（转换在路由层完成——先转换成功、后落库，不留脏数据）+
// 列表/详情/替换/删除。摄入与替换都是单事务（替换中途失败回滚，旧资源原样保留）。
// 依赖方向：只碰 db/ 与同模块纯函数；不 import writer/script/synthesis/post。
import { createHash } from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { resourceChunks, resources, workspaces } from '../../db/schema.js'
import { AppError } from '../../shared/errors.js'
import { chunkMarkdown } from './chunk.js'
import { embedChunks, makeDashscopeEmbedder, type Embedder } from './embed.js'
import type { ResourceKind } from './convert.js'

export interface ResourceView {
  id: string
  title: string
  kind: string
  charCount: number
  chunkCount: number
  embeddedCount: number
  createdAt: Date
}

export interface ResourceDetail extends ResourceView {
  updatedAt: Date
  contentMd: string
}

export interface IngestInput {
  title: string
  kind: ResourceKind
  contentMd: string
}

export interface IngestResult {
  resource: { id: string; title: string; kind: string; charCount: number; createdAt: Date }
  chunkCount: number
  /** embedding 部分失败提示；全成功为 null */
  embedWarning: string | null
  /** 同工作间已存在同内容资源的标题；无重复为 null（不阻断，尊重用户决定） */
  duplicateTitle: string | null
}

export interface ServiceDeps {
  /** 缺省现造（生产路径读 env 凭证）；buildApp 注入 stub 供测试 */
  embedder?: Embedder
}

async function workspaceExists(db: Db, wsId: string): Promise<boolean> {
  const [ws] = await db.select({ id: workspaces.id }).from(workspaces).where(eq(workspaces.id, wsId))
  return ws !== undefined
}

/** 工作间不存在 → null（路由映射 404） */
export async function listResources(db: Db, wsId: string): Promise<ResourceView[] | null> {
  if (!(await workspaceExists(db, wsId))) return null
  const rows = await db.execute(sql`
    SELECT r.id, r.title, r.kind, r.char_count, r.created_at,
           count(c.id)::int AS chunk_count,
           count(c.embedding)::int AS embedded_count
    FROM resources r
    LEFT JOIN resource_chunks c ON c.resource_id = r.id
    WHERE r.ws_id = ${wsId}
    GROUP BY r.id
    ORDER BY r.created_at DESC`)
  return rows.map((r) => ({
    id: String(r.id),
    title: String(r.title),
    kind: String(r.kind),
    charCount: Number(r.char_count),
    chunkCount: Number(r.chunk_count),
    embeddedCount: Number(r.embedded_count),
    createdAt: r.created_at as Date,
  }))
}

/** 资源不存在或不属于该工作间 → null（路由映射 404） */
export async function getResource(db: Db, wsId: string, resourceId: string): Promise<ResourceDetail | null> {
  const rows = await db.execute(sql`
    SELECT r.id, r.title, r.kind, r.char_count, r.content_md, r.created_at, r.updated_at,
           count(c.id)::int AS chunk_count,
           count(c.embedding)::int AS embedded_count
    FROM resources r
    LEFT JOIN resource_chunks c ON c.resource_id = r.id
    WHERE r.id = ${resourceId} AND r.ws_id = ${wsId}
    GROUP BY r.id`)
  const r = rows[0]
  if (!r) return null
  return {
    id: String(r.id),
    title: String(r.title),
    kind: String(r.kind),
    charCount: Number(r.char_count),
    chunkCount: Number(r.chunk_count),
    embeddedCount: Number(r.embedded_count),
    createdAt: r.created_at as Date,
    updatedAt: r.updated_at as Date,
    contentMd: String(r.content_md),
  }
}

/** 切块 + 嵌入的事务外准备（网络不进事务）；空内容 → 400 */
async function prepare(
  contentMd: string,
  deps: ServiceDeps,
): Promise<{
  chunks: ReturnType<typeof chunkMarkdown>
  vectors: (number[] | null)[]
  failedCount: number
  contentHash: string
}> {
  if (contentMd.trim() === '') {
    throw new AppError('BAD_REQUEST', '内容为空，没有可入库的文本', 400)
  }
  const chunks = chunkMarkdown(contentMd)
  if (chunks.length === 0) {
    throw new AppError('BAD_REQUEST', '内容为空，没有可入库的文本', 400)
  }
  const embedder = deps.embedder ?? makeDashscopeEmbedder()
  const { vectors, failedCount } = await embedChunks(embedder, chunks.map((c) => c.content))
  const contentHash = createHash('sha256').update(contentMd).digest('hex')
  return { chunks, vectors, failedCount, contentHash }
}

function chunkValues(resourceId: string, chunks: ReturnType<typeof chunkMarkdown>, vectors: (number[] | null)[]) {
  return chunks.map((c, i) => ({
    resourceId,
    seq: c.seq,
    heading: c.heading,
    content: c.content,
    embedding: vectors[i] ? `[${vectors[i]!.join(',')}]` : null,
  }))
}

function makeResult(
  row: { id: string; title: string; kind: string; charCount: number; createdAt: Date },
  chunkCount: number,
  failedCount: number,
  duplicateTitle: string | null,
): IngestResult {
  return {
    resource: row,
    chunkCount,
    embedWarning: failedCount > 0 ? `已入库，但 ${failedCount} 个块未生成向量（检索仍可走全文通道）` : null,
    duplicateTitle,
  }
}

/** 工作间不存在 → null；空内容 → 400（调用方已保证转换成功） */
export async function ingestResource(
  db: Db,
  wsId: string,
  input: IngestInput,
  deps: ServiceDeps = {},
): Promise<IngestResult | null> {
  if (!(await workspaceExists(db, wsId))) return null
  const { chunks, vectors, failedCount, contentHash } = await prepare(input.contentMd, deps)

  const [dup] = await db
    .select({ title: resources.title })
    .from(resources)
    .where(and(eq(resources.wsId, wsId), eq(resources.contentHash, contentHash)))
    .limit(1)

  const row = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(resources)
      .values({
        wsId,
        title: input.title,
        kind: input.kind,
        contentMd: input.contentMd,
        contentHash,
        charCount: input.contentMd.length,
      })
      .returning({
        id: resources.id,
        title: resources.title,
        kind: resources.kind,
        charCount: resources.charCount,
        createdAt: resources.createdAt,
      })
    await tx.insert(resourceChunks).values(chunkValues(inserted!.id, chunks, vectors))
    return inserted!
  })
  return makeResult(row, chunks.length, failedCount, dup?.title ?? null)
}

/** 显式替换：同摄入管道；单事务删旧块 + 更新资源行 + 写新块，中途失败整体回滚。
 *  标题缺省 = 沿用原标题。资源不存在 → 'not_found'（路由映射 404） */
export async function replaceResource(
  db: Db,
  wsId: string,
  resourceId: string,
  input: { title?: string; kind: ResourceKind; contentMd: string },
  deps: ServiceDeps = {},
): Promise<IngestResult | 'not_found'> {
  const { chunks, vectors, failedCount, contentHash } = await prepare(input.contentMd, deps)

  const result = await db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ id: resources.id, title: resources.title })
      .from(resources)
      .where(and(eq(resources.id, resourceId), eq(resources.wsId, wsId)))
    if (!existing) return 'not_found' as const

    await tx.delete(resourceChunks).where(eq(resourceChunks.resourceId, resourceId))
    const [updated] = await tx
      .update(resources)
      .set({
        title: input.title ?? existing.title,
        kind: input.kind,
        contentMd: input.contentMd,
        contentHash,
        charCount: input.contentMd.length,
        updatedAt: new Date(),
      })
      .where(eq(resources.id, resourceId))
      .returning({
        id: resources.id,
        title: resources.title,
        kind: resources.kind,
        charCount: resources.charCount,
        createdAt: resources.createdAt,
      })
    await tx.insert(resourceChunks).values(chunkValues(resourceId, chunks, vectors))
    return makeResult(updated!, chunks.length, failedCount, null)
  })
  return result
}

/** 删除（块由外键级联）；不存在 → false（路由映射 404） */
export async function deleteResource(db: Db, wsId: string, resourceId: string): Promise<boolean> {
  const deleted = await db
    .delete(resources)
    .where(and(eq(resources.id, resourceId), eq(resources.wsId, wsId)))
    .returning({ id: resources.id })
  return deleted.length > 0
}

/** 第六层资源清单（标题 + 字符数，上限 50 条防 prompt 膨胀） */
export async function listResourceTitles(db: Db, wsId: string): Promise<{ title: string; charCount: number }[]> {
  return db
    .select({ title: resources.title, charCount: resources.charCount })
    .from(resources)
    .where(eq(resources.wsId, wsId))
    .orderBy(desc(resources.createdAt))
    .limit(50)
}
```

- [ ] **Step 2: 类型检查**

```bash
npm run typecheck
```

预期：通过。

- [ ] **Step 3: Commit**

```bash
git add server/src/modules/resources/service.ts
git commit -m "feat(resources): 服务层——摄入/列表/详情/替换/删除事务编排"
```

---

### Task 8: app 装配 + 路由（测试先行：列表/详情/删除）

**Files:**
- Modify: `server/package.json`（依赖 @fastify/multipart）
- Modify: `server/src/app.ts`
- Create: `server/src/modules/resources/routes.ts`
- Test: `server/test/resources.test.ts`

- [ ] **Step 1: 安装 @fastify/multipart**

```bash
npm install @fastify/multipart -w server
```

- [ ] **Step 2: 写第一批失败测试（列表/详情/删除 + 404 形状）**

`server/test/resources.test.ts`（先落骨架与本步骤用例；摄入/替换/检索用例在后续步骤追加进同一文件）：

```ts
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { inArray } from 'drizzle-orm'
import { buildApp } from '../src/app.js'
import { workspaces } from '../src/db/schema.js'
import type { Embedder } from '../src/modules/resources/embed.js'

type App = Awaited<ReturnType<typeof buildApp>>
type Db = App['db']

/** 确定性 stub：含「量子」→ 第 0 维，其余 → 第 1 维（1024 维 one-hot） */
export const deterministicEmbedder: Embedder = {
  async embed(texts) {
    return texts.map((t) => {
      const v = new Array<number>(1024).fill(0)
      v[t.includes('量子') ? 0 : 1] = 1
      return v
    })
  },
}

async function cleanup(db: Db, wsIds: string[]) {
  if (wsIds.length === 0) return
  // resources/resource_chunks 对工作间是级联删，删工作间即清场
  await db.delete(workspaces).where(inArray(workspaces.id, wsIds))
}

async function fixtureWorkspace(app: App, created: string[], name: string) {
  const res = await app.inject({ method: 'POST', url: '/api/workspaces', payload: { name } })
  assert.equal(res.statusCode, 201)
  const ws = res.json() as { id: string }
  created.push(ws.id)
  return ws
}

interface IngestResponse {
  resource: { id: string; title: string; kind: string; charCount: number }
  chunkCount: number
  embedWarning: string | null
  duplicateTitle: string | null
}

test('列表：工作间未知 404；空工作间 []；粘贴摄入后含计数', async () => {
  const app = await buildApp({ embedder: deterministicEmbedder })
  const created: string[] = []
  try {
    const missing = await app.inject({
      method: 'GET',
      url: '/api/workspaces/00000000-0000-4000-8000-000000000000/resources',
    })
    assert.equal(missing.statusCode, 404)

    const ws = await fixtureWorkspace(app, created, '资源工作间')
    const empty = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/resources` })
    assert.equal(empty.statusCode, 200)
    assert.deepEqual(empty.json(), [])

    const made = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/resources`,
      payload: { title: '量子入门', text: '# 量子\n\n量子计算的纠错码是工程难点。' },
    })
    assert.equal(made.statusCode, 201)
    const body = made.json() as IngestResponse
    assert.equal(body.resource.title, '量子入门')
    assert.equal(body.resource.kind, 'paste')
    assert.equal(body.embedWarning, null)
    assert.equal(body.duplicateTitle, null)

    const list = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/resources` })
    const rows = list.json() as { id: string; title: string; chunkCount: number; embeddedCount: number }[]
    assert.equal(rows.length, 1)
    assert.equal(rows[0]!.title, '量子入门')
    assert.equal(rows[0]!.chunkCount, body.chunkCount)
    assert.equal(rows[0]!.embeddedCount, body.chunkCount) // stub 全成功 → 向量全覆盖
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

test('详情：含 contentMd；未知资源 404', async () => {
  const app = await buildApp({ embedder: deterministicEmbedder })
  const created: string[] = []
  try {
    const ws = await fixtureWorkspace(app, created, '详情工作间')
    const made = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/resources`,
      payload: { title: '随手记', text: '一段纯文本资料。' },
    })
    const { resource } = made.json() as IngestResponse

    const detail = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/resources/${resource.id}` })
    assert.equal(detail.statusCode, 200)
    const body = detail.json() as { contentMd: string; kind: string }
    assert.equal(body.contentMd, '一段纯文本资料。')
    assert.equal(body.kind, 'paste')

    const missing = await app.inject({
      method: 'GET',
      url: `/api/workspaces/${ws.id}/resources/00000000-0000-4000-8000-000000000000`,
    })
    assert.equal(missing.statusCode, 404)
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

test('删除：204 且级联删块；再来一次 404', async () => {
  const app = await buildApp({ embedder: deterministicEmbedder })
  const created: string[] = []
  try {
    const ws = await fixtureWorkspace(app, created, '删除工作间')
    const made = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/resources`,
      payload: { title: '待删', text: '内容甲。' },
    })
    const { resource } = made.json() as IngestResponse
    const del = await app.inject({ method: 'DELETE', url: `/api/workspaces/${ws.id}/resources/${resource.id}` })
    assert.equal(del.statusCode, 204)
    const again = await app.inject({ method: 'DELETE', url: `/api/workspaces/${ws.id}/resources/${resource.id}` })
    assert.equal(again.statusCode, 404)
    const list = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/resources` })
    assert.deepEqual(list.json(), [])
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})
```

- [ ] **Step 3: 跑测试，确认失败**

`server/` 目录：`npx tsx --test test/resources.test.ts`
预期：三个用例全失败（404——路由不存在；且 `buildApp` 尚无 `embedder` 选项 → 编译报错也属预期红灯）。

- [ ] **Step 4: app.ts 装配（multipart + embedder + 路由注册）**

`server/src/app.ts` 改动：

1. import 追加：

```ts
import multipart from '@fastify/multipart'
import { makeDashscopeEmbedder, type Embedder } from './modules/resources/embed.js'
import { resourceRoutes } from './modules/resources/routes.js'
```

2. `FastifyInstance` 装饰声明加一行：`embedder: Embedder`。

3. `BuildAppOptions` 加：

```ts
  /** 覆盖 embedding 客户端（测试注入 stub 用；缺省现造，读 DashScope 凭证） */
  embedder?: Embedder
```

4. `buildApp` 体内，`app.decorate('tts', tts)` 之后：

```ts
  const embedder = opts.embedder ?? makeDashscopeEmbedder()
  app.decorate('embedder', embedder)

  // multipart（资源上传）：单文件上限 20MB（convert.ts 的 MAX_FILE_BYTES）
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024 } })
```

5. 路由注册，`workspaceRoutes` 之后：

```ts
  await app.register(resourceRoutes, { prefix: '/api/workspaces' })
```

- [ ] **Step 5: routes.ts 骨架 + 列表/详情/删除**

`server/src/modules/resources/routes.ts`：

```ts
// resources 模块路由（知识摄入与检索设计 2026-08-31）：
// 形状/上限校验在路由层；约束（工作间存在性/事务）在服务层。
// POST 摄入双形态：multipart 文件（字段 file）或 JSON { title, text }（粘贴）。
import type { FastifyInstance } from 'fastify'
import { AppError } from '../../shared/errors.js'
import { asBody, requireString, requireUuidParam } from '../../shared/validate.js'
import { convertToMarkdown, MAX_FILE_BYTES, MAX_PASTE_CHARS } from './convert.js'
import * as service from './service.js'

interface WsParams {
  wsId: string
}

interface ResourceParams {
  wsId: string
  rid: string
}

export async function resourceRoutes(app: FastifyInstance) {
  app.get<{ Params: WsParams }>('/:wsId/resources', async (req) => {
    const wsId = requireUuidParam(req.params.wsId, 'workspace')
    const rows = await service.listResources(app.db, wsId)
    if (rows === null) throw new AppError('NOT_FOUND', 'workspace not found', 404)
    return rows
  })

  app.get<{ Params: ResourceParams }>('/:wsId/resources/:rid', async (req) => {
    const wsId = requireUuidParam(req.params.wsId, 'workspace')
    const rid = requireUuidParam(req.params.rid, 'resource')
    const detail = await service.getResource(app.db, wsId, rid)
    if (!detail) throw new AppError('NOT_FOUND', 'resource not found', 404)
    return detail
  })

  app.delete<{ Params: ResourceParams }>('/:wsId/resources/:rid', async (req, reply) => {
    const wsId = requireUuidParam(req.params.wsId, 'workspace')
    const rid = requireUuidParam(req.params.rid, 'resource')
    const deleted = await service.deleteResource(app.db, wsId, rid)
    if (!deleted) throw new AppError('NOT_FOUND', 'resource not found', 404)
    return reply.status(204).send()
  })
}
```

- [ ] **Step 6: 跑测试，确认第一批变绿**

`npx tsx --test test/resources.test.ts` — 预期：三个用例中列表/详情/删除的**列表空/404、详情 404、删除 404** 分支通过；含摄入的断言仍失败（POST 未实现）——这是下一任务的红灯，保持不动。

- [ ] **Step 7: Commit**

```bash
git add server/package.json package-lock.json server/src/app.ts server/src/modules/resources/routes.ts server/test/resources.test.ts
git commit -m "feat(resources): app 装配（multipart + embedder 注入）与路由骨架（列表/详情/删除）"
```

---

### Task 9: 摄入与替换路由（测试先行）

**Files:**
- Modify: `server/src/modules/resources/routes.ts`
- Modify: `server/test/resources.test.ts`

- [ ] **Step 1: 追加摄入/替换失败测试**

在 `server/test/resources.test.ts` 追加：

```ts
test('粘贴摄入校验：缺 title / 空 text / 超长 text / 空内容 → 400', async () => {
  const app = await buildApp({ embedder: deterministicEmbedder })
  const created: string[] = []
  try {
    const ws = await fixtureWorkspace(app, created, '校验工作间')
    const bad = [
      { text: '有内容没标题' },
      { title: '有标题', text: '   ' },
      { title: '超长', text: '甲'.repeat(200_001) },
      { title: '纯标题空白文档', text: '  \n  ' },
    ]
    for (const payload of bad) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/workspaces/${ws.id}/resources`,
        payload,
      })
      assert.equal(res.statusCode, 400, JSON.stringify(payload).slice(0, 60))
      assert.equal((res.json() as { error: { code: string } }).error.code, 'BAD_REQUEST')
    }
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

test('重复摄入：同内容第二次命中 duplicateTitle（不阻断）', async () => {
  const app = await buildApp({ embedder: deterministicEmbedder })
  const created: string[] = []
  try {
    const ws = await fixtureWorkspace(app, created, '重复工作间')
    const body = { title: '第一份', text: '# 重复内容\n同一段资料。' }
    await app.inject({ method: 'POST', url: `/api/workspaces/${ws.id}/resources`, payload: body })
    const second = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/resources`,
      payload: { ...body, title: '第二份' },
    })
    assert.equal(second.statusCode, 201)
    assert.equal((second.json() as IngestResponse).duplicateTitle, '第一份')
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

test('embedding 全失败 → 201 + embedWarning + 向量覆盖 0（检索仍可走全文）', async () => {
  const failing: Embedder = { async embed() { return null } }
  const app = await buildApp({ embedder: failing })
  const created: string[] = []
  try {
    const ws = await fixtureWorkspace(app, created, '降级工作间')
    const made = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/resources`,
      payload: { title: '无向量', text: '一段没有向量的资料。' },
    })
    assert.equal(made.statusCode, 201)
    const body = made.json() as IngestResponse
    assert.ok(body.embedWarning)
    assert.ok(body.embedWarning!.includes('未生成向量'))
    const list = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/resources` })
    const row = (list.json() as { embeddedCount: number; chunkCount: number }[])[0]!
    assert.equal(row.embeddedCount, 0)
    assert.equal(row.chunkCount, body.chunkCount)
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

test('multipart 上传 .md：201、标题取文件名（去扩展名）；非法扩展名 400', async () => {
  const app = await buildApp({ embedder: deterministicEmbedder })
  const created: string[] = []
  try {
    const ws = await fixtureWorkspace(app, created, '上传工作间')
    const boundary = '----aipodcast-test-boundary'
    const content = '# 上传的笔记\n\n这里是正文，提到播客后期。'
    const multipartBody = (filename: string, fileContent: string) =>
      [
        `--${boundary}`,
        `Content-Disposition: form-data; name="file"; filename="${filename}"`,
        'Content-Type: application/octet-stream',
        '',
        fileContent,
        `--${boundary}--`,
        '',
      ].join('\r\n')

    const ok = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/resources`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody('我的笔记.md', content),
    })
    assert.equal(ok.statusCode, 201)
    const body = ok.json() as IngestResponse
    assert.equal(body.resource.title, '我的笔记')
    assert.equal(body.resource.kind, 'md')

    const bad = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/resources`,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipartBody('page.html', '<p>x</p>'),
    })
    assert.equal(bad.statusCode, 400)
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

test('替换：内容与块整体换新（旧块不残留）；空内容替换 → 400 且旧资源原样', async () => {
  const app = await buildApp({ embedder: deterministicEmbedder })
  const created: string[] = []
  try {
    const ws = await fixtureWorkspace(app, created, '替换工作间')
    const made = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/resources`,
      payload: { title: '旧版', text: '旧内容。' },
    })
    const { resource, chunkCount: oldChunks } = made.json() as IngestResponse

    const replaced = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/resources/${resource.id}/replace`,
      payload: { title: '新版', text: '# 新\n新内容第一段。\n\n新内容第二段。' },
    })
    assert.equal(replaced.statusCode, 200)
    const body = replaced.json() as IngestResponse
    assert.equal(body.resource.title, '新版')
    assert.ok(body.resource.charCount !== resource.charCount)

    const detail = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/resources/${resource.id}` })
    const d = detail.json() as { contentMd: string; chunkCount: number }
    assert.equal(d.contentMd, '# 新\n新内容第一段。\n\n新内容第二段。')
    assert.notEqual(d.chunkCount, 0)

    // 失败路径：空内容不进事务，旧资源原样
    const failed = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/resources/${resource.id}/replace`,
      payload: { text: '   ' },
    })
    assert.equal(failed.statusCode, 400)
    const after = await app.inject({ method: 'GET', url: `/api/workspaces/${ws.id}/resources/${resource.id}` })
    assert.equal((after.json() as { contentMd: string }).contentMd, '# 新\n新内容第一段。\n\n新内容第二段。')

    // 未知资源 404
    const missing = await app.inject({
      method: 'POST',
      url: `/api/workspaces/${ws.id}/resources/00000000-0000-4000-8000-000000000000/replace`,
      payload: { text: 'x' },
    })
    assert.equal(missing.statusCode, 404)
    void oldChunks
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})
```

- [ ] **Step 2: 跑测试，确认新用例失败**

`npx tsx --test test/resources.test.ts` — POST /replace 相关全红（404：端点未注册）。

- [ ] **Step 3: routes.ts 补摄入与替换端点**

在 `resourceRoutes` 内追加（`app.delete` 之前或之后均可）：

```ts
  // 摄入：multipart（字段 file）或 JSON { title, text }（粘贴）
  app.post<{ Params: WsParams }>('/:wsId/resources', async (req, reply) => {
    const wsId = requireUuidParam(req.params.wsId, 'workspace')
    let input: service.IngestInput
    if (req.isMultipart()) {
      const file = await req.file({ limits: { fileSize: MAX_FILE_BYTES } })
      if (!file) throw new AppError('BAD_REQUEST', '缺少上传文件（字段名 file）', 400)
      if (file.file.truncated) {
        throw new AppError('BAD_REQUEST', `文件超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 上限`, 400)
      }
      const buffer = await file.toBuffer()
      const { kind, markdown } = await convertToMarkdown(buffer, file.filename)
      const title = file.filename.replace(/\.[^.]+$/, '').trim() || file.filename
      input = { title, kind, contentMd: markdown }
    } else {
      const body = asBody(req.body)
      const text = requireString(body, 'text')
      if (text.length > MAX_PASTE_CHARS) {
        throw new AppError('BAD_REQUEST', `粘贴文本超过 ${MAX_PASTE_CHARS} 字符上限`, 400)
      }
      input = { title: requireString(body, 'title'), kind: 'paste', contentMd: text }
    }
    const result = await service.ingestResource(app.db, wsId, input, { embedder: app.embedder })
    if (!result) throw new AppError('NOT_FOUND', 'workspace not found', 404)
    return reply.status(201).send(result)
  })

  // 显式替换：同摄入管道；事务内删旧块 + 写新块，中途失败整体回滚
  app.post<{ Params: ResourceParams }>('/:wsId/resources/:rid/replace', async (req) => {
    const wsId = requireUuidParam(req.params.wsId, 'workspace')
    const rid = requireUuidParam(req.params.rid, 'resource')
    let input: { title?: string; kind: import('./convert.js').ResourceKind; contentMd: string }
    if (req.isMultipart()) {
      const file = await req.file({ limits: { fileSize: MAX_FILE_BYTES } })
      if (!file) throw new AppError('BAD_REQUEST', '缺少上传文件（字段名 file）', 400)
      if (file.file.truncated) {
        throw new AppError('BAD_REQUEST', `文件超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 上限`, 400)
      }
      const buffer = await file.toBuffer()
      const { kind, markdown } = await convertToMarkdown(buffer, file.filename)
      const title = file.filename.replace(/\.[^.]+$/, '').trim() || file.filename
      input = { title, kind, contentMd: markdown }
    } else {
      const body = asBody(req.body)
      const text = requireString(body, 'text')
      if (text.length > MAX_PASTE_CHARS) {
        throw new AppError('BAD_REQUEST', `粘贴文本超过 ${MAX_PASTE_CHARS} 字符上限`, 400)
      }
      const title = body.title
      if (title !== undefined && (typeof title !== 'string' || title.trim() === '')) {
        throw new AppError('BAD_REQUEST', "field 'title' must be a non-empty string", 400)
      }
      input = { title: title as string | undefined, kind: 'paste', contentMd: text }
    }
    const result = await service.replaceResource(app.db, wsId, rid, input, { embedder: app.embedder })
    if (result === 'not_found') throw new AppError('NOT_FOUND', 'resource not found', 404)
    return result
  })
```

（把 `import('./convert.js').ResourceKind` 换成顶部 `import { convertToMarkdown, MAX_FILE_BYTES, MAX_PASTE_CHARS, type ResourceKind } from './convert.js'` 的具名导入。）

- [ ] **Step 4: 跑测试，确认全绿**

`npx tsx --test test/resources.test.ts` — 全部 PASS（8 个用例）。

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/resources/routes.ts server/test/resources.test.ts
git commit -m "feat(resources): 摄入与替换端点——上传/粘贴双形态、显式替换事务"
```

---

### Task 10: 检索集成测试（空库 / 中文 BM25 / 向量 / 隔离）

**Files:**
- Modify: `server/test/resources.test.ts`

- [ ] **Step 1: 追加检索集成测试**

`server/test/resources.test.ts` 顶部追加 import：

```ts
import { eq } from 'drizzle-orm'
import { episodes } from '../src/db/schema.js'
import { retrieve } from '../src/modules/resources/retrieve.js'
```

文件末尾追加：

```ts
/** 夹具：一个工作间摄入两份资料（量子主题 + 火锅主题），返回 wsId */
async function fixtureLibrary(app: App, created: string[], name: string) {
  const ws = await fixtureWorkspace(app, created, name)
  await app.inject({
    method: 'POST',
    url: `/api/workspaces/${ws.id}/resources`,
    payload: { title: '量子手册', text: '# 量子\n\n量子计算的纠错码是当前工程难点。' },
  })
  await app.inject({
    method: 'POST',
    url: `/api/workspaces/${ws.id}/resources`,
    payload: { title: '火锅指南', text: '# 火锅\n\n老北京涮羊肉讲究清汤锅底。' },
  })
  return ws
}

test('检索：空库短路 → empty_library；净查询空白 → no_hits', async () => {
  const app = await buildApp({ embedder: deterministicEmbedder })
  const created: string[] = []
  try {
    const ws = await fixtureWorkspace(app, created, '空库工作间')
    const empty = await retrieve(app.db, ws.id, '随便查', { embedder: deterministicEmbedder })
    assert.equal(empty.status, 'empty_library')

    const lib = await fixtureLibrary(app, created, '空白查询库')
    const blank = await retrieve(app.db, lib.id, '!!!', { embedder: deterministicEmbedder })
    assert.equal(blank.status, 'no_hits')
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

test('检索：纯 BM25 模式命中中文词；embedder 绝不被调用', async () => {
  const app = await buildApp({ embedder: deterministicEmbedder })
  const created: string[] = []
  try {
    const ws = await fixtureLibrary(app, created, 'BM25 工作间')
    const poisoned: Embedder = {
      async embed() {
        throw new Error('bm25 模式不应调用 embedder')
      },
    }
    const result = await retrieve(app.db, ws.id, '火锅', { mode: 'bm25', embedder: poisoned })
    assert.equal(result.status, 'ok')
    assert.ok(result.hits[0]!.content.includes('涮羊肉'))
    assert.equal(result.hits[0]!.resourceTitle, '火锅指南')
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

test('检索：向量通道（hybrid）——与词面无重叠也能召回语义块', async () => {
  const app = await buildApp({ embedder: deterministicEmbedder })
  const created: string[] = []
  try {
    const ws = await fixtureLibrary(app, created, '向量工作间')
    // stub 语义：查询含「量子」→ 第 0 维，与量子块的嵌入同向（余弦距离 0）
    const result = await retrieve(app.db, ws.id, '量子', { mode: 'hybrid', embedder: deterministicEmbedder })
    assert.equal(result.status, 'ok')
    assert.ok(result.hits[0]!.content.includes('量子计算'))
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

test('检索：工作间隔离——A 库的资料在 B 库查不到', async () => {
  const app = await buildApp({ embedder: deterministicEmbedder })
  const created: string[] = []
  try {
    await fixtureLibrary(app, created, 'A 工作间')
    const wsB = await fixtureWorkspace(app, created, 'B 工作间')
    await app.inject({
      method: 'POST',
      url: `/api/workspaces/${wsB.id}/resources`,
      payload: { title: 'B 的资料', text: '与量子毫不相干的内容。' },
    })
    const result = await retrieve(app.db, wsB.id, '量子', { mode: 'hybrid', embedder: deterministicEmbedder })
    // B 库唯一块与查询向量不同向（第 1 维），BM25 亦无词面命中 → 不得串出 A 的块
    assert.ok(!result.hits.some((h) => h.resourceTitle === '量子手册'))
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})

test('retrieve 工具：形状、执行与跨工作间隔离', async () => {
  const { makeWriterTools } = await import('../src/modules/writer/tools.js')
  const app = await buildApp({ embedder: deterministicEmbedder })
  const created: string[] = []
  try {
    const ws = await fixtureLibrary(app, created, '工具工作间')
    const ep = (
      (
        await app.inject({
          method: 'POST',
          url: `/api/workspaces/${ws.id}/episodes`,
          payload: { title: '检索测试集' },
        })
      ).json() as { id: string }
    )

    const tools = makeWriterTools(app.db, ep.id, { embedder: deterministicEmbedder })
    assert.deepEqual(tools.map((t) => t.name), ['read', 'add', 'edit', 'retrieve'])

    const retrieveTool = tools[3]!
    const out = (await retrieveTool.execute('call-1', { query: '火锅' }, {})) as {
      content: { type: string; text: string }[]
      details: { summary: string; lineIds: string[] }
    }
    const text = out.content[0]!.text
    assert.ok(text.includes('《火锅指南》'), text)
    assert.ok(text.includes('涮羊肉'))
    assert.deepEqual(out.details.lineIds, [])

    // 空库引导语
    const ws2 = await fixtureWorkspace(app, created, '空工具工作间')
    await app.inject({ method: 'POST', url: `/api/workspaces/${ws2.id}/episodes`, payload: { title: '空集' } })
    const [ep2] = await app.db.select({ id: episodes.id }).from(episodes).where(eq(episodes.wsId, ws2.id))
    const tools2 = makeWriterTools(app.db, ep2!.id, { embedder: deterministicEmbedder })
    const out2 = (await tools2[3]!.execute('call-2', { query: 'x' }, {})) as {
      content: { text: string }[]
    }
    assert.ok(out2.content[0]!.text.includes('还没有资源'))
  } finally {
    await cleanup(app.db, created)
    await app.close()
  }
})
```

- [ ] **Step 2: 跑测试，确认失败点**

`npx tsx --test test/resources.test.ts`
预期：`retrieve 工具` 用例编译失败——`makeWriterTools` 还没有第三参数，工具数组也没有 `retrieve`。这是 Task 11 的红灯；检索四例若因中文分词失败，先对照 Task 1 spike 1 结论修正建索引分词器（改迁移 → `npm run migrate`），不要改测试断言语义。

- [ ] **Step 3: Commit（红灯也提交，保持小步）**

```bash
git add server/test/resources.test.ts
git commit -m "test(resources): 检索集成测试——空库/中文 BM25/向量/隔离/工具形状（工具侧待续）"
```

---

### Task 11: 写稿大师第四工具 `retrieve`

**Files:**
- Modify: `server/src/modules/writer/tools.ts`
- Modify: `server/src/modules/writer/session.ts`
- Modify: `server/src/modules/writer/context.ts`（静态种子的工具面描述）
- Modify: `server/test/writer-context.test.ts`

- [ ] **Step 1: tools.ts 加 retrieve 工具与可选 embedder**

`server/src/modules/writer/tools.ts`：

1. import 追加：

```ts
import { formatHits, retrieve } from '../resources/retrieve.js'
import type { Embedder } from '../resources/embed.js'
```

2. `makeWriterTools` 签名改为：

```ts
export function makeWriterTools(db: Db, episodeId: string, opts: { embedder?: Embedder } = {}): WriterTool[] {
```

3. `editTool` 之后、`return` 之前插入：

```ts
  const retrieveTool = defineTool({
    name: 'retrieve',
    label: '检索资源',
    description:
      '检索本工作间的资源（知识库）。涉及事实、数据、背景、引用时先检索，用带出处的检索结果写稿。',
    parameters: Type.Object({
      query: Type.String({ description: '检索关键词或问题' }),
    }),
    execute: async (_toolCallId, params) => {
      const [ep] = await db.select({ wsId: episodes.wsId }).from(episodes).where(eq(episodes.id, episodeId))
      if (!ep) throw new AppError('NOT_FOUND', 'episode not found', 404)
      const result = await retrieve(db, ep.wsId, params.query, { embedder: opts.embedder })
      const text =
        result.status === 'empty_library'
          ? '本工作间还没有资源。请提示用户到「工作间设置 → 资源」上传资料后再检索。'
          : result.status === 'no_hits'
            ? `没有检索到与「${params.query}」相关的内容。`
            : formatHits(result.hits)
      return {
        content: [{ type: 'text', text }],
        // lineIds 恒空：检索是只读路径，不触发脚本刷新
        details: { summary: `检索资源：${briefText(params.query, 30)}`, lineIds: [] },
      }
    },
  })

  return [readTool, addTool, editTool, retrieveTool]
```

（原 `return [readTool, addTool, editTool]` 删掉。）

- [ ] **Step 2: session.ts 透传 embedder**

`server/src/modules/writer/session.ts`：

1. import：`import type { Embedder } from '../resources/embed.js'`
2. 构造函数：`constructor(private readonly db: Db, private readonly opts: { embedder?: Embedder } = {}) {}`
3. `createSession` 里：`customTools: makeWriterTools(this.db, episodeId, this.opts),`

`server/src/app.ts`：`const writer = new WriterRuntime(db)` 改为 `new WriterRuntime(db, { embedder })`
（放在 `embedder` 装配之后——把 writer 的构造挪到 `app.decorate('embedder', embedder)` 那段后面，或确保 `embedder` 常量先声明）。

- [ ] **Step 3: context.ts 静态种子补工具面**

`server/src/modules/writer/context.ts` 的 `writerStaticPrompt()`：

1. 「职责边界」第二条改为：

```
    '- 你的全部改动都通过 read / add / edit 三个工具落到脚本上，工具返回结果就是你看到的最新状态；查资料用 retrieve（只读，不改脚本）。',
```

2. 「工作流」末尾追加一条：

```
    '- 涉及事实、数据、背景、引用时，先 retrieve 检索本工作间资源，用带出处的检索结果写稿；第六层有资源清单，先扫一眼再决定检索词。',
```

- [ ] **Step 4: 更新 writer-context 测试**

`server/test/writer-context.test.ts` 最后一个用例断言扩充：

```ts
test('静态种子（Layer 3）不含第六层标题——动态内容只在 before_agent_start 覆盖', () => {
  const seed = writerStaticPrompt()
  assert.ok(!seed.includes('## 节目信息与说话人'))
  assert.ok(seed.includes('read / add / edit'))
  assert.ok(seed.includes('retrieve'))
})
```

- [ ] **Step 5: 跑测试与类型检查**

```bash
npx tsx --test test/resources.test.ts test/writer-context.test.ts
npm run typecheck
```

预期：Task 10 的 `retrieve 工具` 用例转绿；其余不回退。

- [ ] **Step 6: 全量回归**

```bash
npm test -w server
```

预期：全绿（含既有 writer/script/synthesis 测试）。

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/writer/tools.ts server/src/modules/writer/session.ts server/src/modules/writer/context.ts server/src/app.ts server/test/writer-context.test.ts
git commit -m "feat(writer): 第四工具 retrieve——闭包锁工作间的资源检索"
```

---

### Task 12: 第六层资源清单（Layer 2 增强）

**Files:**
- Modify: `server/src/modules/writer/context.ts`
- Modify: `server/test/writer-context.test.ts`

- [ ] **Step 1: 写失败测试**

`server/test/writer-context.test.ts`：

1. 既有两个 `formatShowContext` 用例的入参对象都加字段 `resources: []`（第一个用例可改用下面的资源断言）。
2. 追加用例：

```ts
test('第六层：资源清单（标题 + 字符数）；空库给引导', () => {
  const withRes = formatShowContext({
    title: 't', showNotes: '', outline: '', topic: '', tone: '', terms: '', bannedWords: '', intro: '',
    speakers: [],
    resources: [{ title: '量子手册', charCount: 1234 }],
  })
  assert.ok(withRes.includes('工作间资源（细节用 retrieve 工具检索）：'))
  assert.ok(withRes.includes('- 《量子手册》（1234 字）'))

  const empty = formatShowContext({
    title: 't', showNotes: '', outline: '', topic: '', tone: '', terms: '', bannedWords: '', intro: '',
    speakers: [],
    resources: [],
  })
  assert.ok(empty.includes('还没有资源'))
})
```

- [ ] **Step 2: 跑测试，确认失败**

`npx tsx --test test/writer-context.test.ts` — FAIL（`resources` 字段不存在）。

- [ ] **Step 3: context.ts 实现**

1. `ShowContext` 接口加：

```ts
  /** 资源清单（标题 + 字符数）：模型不检索也知道库里有什么，避免盲检 */
  resources: { title: string; charCount: number }[]
```

2. `formatShowContext` 末尾（说话人段之后）追加：

```ts
  if (ctx.resources.length > 0) {
    lines.push('工作间资源（细节用 retrieve 工具检索）：')
    for (const r of ctx.resources) {
      lines.push(`- 《${r.title}》（${r.charCount} 字）`)
    }
  } else {
    lines.push('（本工作间还没有资源；需要事实资料时提示用户到「工作间设置 → 资源」上传）')
  }
```

3. `loadShowContext`：import resources service 的 `listResourceTitles`（`import { listResourceTitles } from '../resources/service.js'`——writer → resources 单向），返回对象加：

```ts
    resources: await listResourceTitles(db, ep.wsId),
```

- [ ] **Step 4: 跑测试，确认全绿 + 全量回归**

```bash
npx tsx --test test/writer-context.test.ts
npm test -w server
```

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/writer/context.ts server/test/writer-context.test.ts
git commit -m "feat(writer): 第六层追加工作间资源清单（防盲检）"
```

---

### Task 13: 前端 API 层（类型 / resourceApi / upload / 查询键）

**Files:**
- Modify: `web/src/lib/api/types.ts`
- Modify: `web/src/lib/api/http.ts`
- Modify: `web/src/lib/api/keys.ts`
- Create: `web/src/lib/api/resource.ts`

- [ ] **Step 1: types.ts 追加资源类型**

`web/src/lib/api/types.ts` 文件末尾：

```ts
// ---- 资源（工作间知识库）----
export type ResourceKind = 'md' | 'txt' | 'docx' | 'pdf' | 'paste'

export interface ResourceSummary {
  id: string
  title: string
  kind: ResourceKind
  charCount: number
  chunkCount: number
  embeddedCount: number
  createdAt: string
}

/** POST /resources 与 POST /resources/:rid/replace 的响应 */
export interface IngestResourceResponse {
  resource: ResourceSummary
  chunkCount: number
  /** embedding 部分失败提示；全成功为 null */
  embedWarning: string | null
  /** 同工作间同内容已有资源的标题；无重复为 null */
  duplicateTitle: string | null
}
```

- [ ] **Step 2: http.ts 加 upload（FormData 走 fetch，不手设 Content-Type）**

`web/src/lib/api/http.ts`：把错误解析抽成共用，再加 `upload`。完整改法——

`request` 函数体内 `if (!res.ok)` 段替换为调用新助手：

```ts
async function throwApiError(res: Response): Promise<never> {
  let code = String(res.status)
  let message = res.statusText
  try {
    const payload = (await res.json()) as { error?: { code?: string; message?: string } }
    if (payload.error) {
      code = payload.error.code ?? code
      message = payload.error.message ?? message
    }
  } catch {
    // 错误体不是 JSON，保持默认
  }
  throw new ApiError(code, message, res.status)
}
```

`request` 内改用 `await throwApiError(res)`；并在 `http` 对象追加：

```ts
  /** multipart 上传：浏览器生成 boundary，不能手设 Content-Type */
  upload: async <T>(path: string, formData: FormData, signal?: AbortSignal): Promise<T> => {
    const res = await fetch(`/api${path}`, { method: 'POST', body: formData, signal })
    if (!res.ok) await throwApiError(res)
    return (await res.json()) as T
  },
```

- [ ] **Step 3: keys.ts 加 resources 键**

```ts
  resources: (wsId: string) => ['resources', wsId] as const,
```

- [ ] **Step 4: resource.ts**

`web/src/lib/api/resource.ts`：

```ts
// 资源端点（知识摄入与检索设计 2026-08-31）：列表/上传/粘贴/替换/删除。
// 检索不给前端——那是写稿大师的工具面。
import { http } from './http'
import type { IngestResourceResponse, ResourceSummary } from './types'

export const resourceApi = {
  list: (wsId: string) => http.get<ResourceSummary[]>(`/workspaces/${wsId}/resources`),

  upload: (wsId: string, file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return http.upload<IngestResourceResponse>(`/workspaces/${wsId}/resources`, fd)
  },

  paste: (wsId: string, body: { title: string; text: string }) =>
    http.post<IngestResourceResponse>(`/workspaces/${wsId}/resources`, body),

  replaceWithFile: (wsId: string, resourceId: string, file: File) => {
    const fd = new FormData()
    fd.append('file', file)
    return http.upload<IngestResourceResponse>(`/workspaces/${wsId}/resources/${resourceId}/replace`, fd)
  },

  remove: (wsId: string, resourceId: string) =>
    http.delete<void>(`/workspaces/${wsId}/resources/${resourceId}`),
}
```

- [ ] **Step 5: 类型检查 + Commit**

```bash
npm run typecheck
git add web/src/lib/api/types.ts web/src/lib/api/http.ts web/src/lib/api/keys.ts web/src/lib/api/resource.ts
git commit -m "feat(web): 资源 API 层——类型、resourceApi、FormData 上传"
```

---

### Task 14: 前端资源卡片（列表 / 上传 / 粘贴 / 替换 / 删除）

**Files:**
- Create: `web/src/features/resources/ResourceList.tsx`
- Create: `web/src/features/resources/PasteDialog.tsx`
- Modify: `web/src/routes/WorkspaceSettingsPage.tsx`

- [ ] **Step 1: PasteDialog.tsx**

```tsx
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { apiErrorMessage } from '@/lib/api/http'
import { qk } from '@/lib/api/keys'
import { resourceApi } from '@/lib/api/resource'

const MAX_PASTE_CHARS = 200_000

export function PasteDialog({ wsId, open, onOpenChange }: { wsId: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const queryClient = useQueryClient()
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')

  const submit = useMutation({
    mutationFn: () => resourceApi.paste(wsId, { title: title.trim(), text }),
    onSuccess: (body) => {
      void queryClient.invalidateQueries({ queryKey: qk.resources(wsId) })
      if (body.embedWarning) toast.warning(body.embedWarning)
      if (body.duplicateTitle) toast.info(`注意：工作间已有同内容资源《${body.duplicateTitle}》`)
      toast.success('资源已入库')
      setTitle('')
      setText('')
      onOpenChange(false)
    },
    onError: (e) => toast.error(`入库失败：${apiErrorMessage(e)}`),
  })

  const valid = title.trim() !== '' && text.trim() !== '' && text.length <= MAX_PASTE_CHARS

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>粘贴文本建资源</DialogTitle>
          <DialogDescription>
            持久化为工作间资源：切块、向量化后可被写稿大师检索引用。上限 {MAX_PASTE_CHARS.toLocaleString()} 字符。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="paste-title">标题</Label>
            <Input id="paste-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：行业报告摘要" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="paste-text">正文</Label>
            <Textarea
              id="paste-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={10}
              placeholder="粘贴正文…（支持 markdown）"
            />
            <p className="text-xs text-muted-foreground">
              {text.length.toLocaleString()} / {MAX_PASTE_CHARS.toLocaleString()}
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={!valid || submit.isPending} onClick={() => submit.mutate()}>
            {submit.isPending ? '入库中…' : '入库'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

（若 `ui/dialog` 的具名导出与上面不一致，以 `web/src/components/ui/dialog.tsx` 实际导出为准，语义不变。）

- [ ] **Step 2: ResourceList.tsx**

```tsx
import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileText, Upload } from 'lucide-react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/empty-state'
import { apiErrorMessage } from '@/lib/api/http'
import { qk } from '@/lib/api/keys'
import { resourceApi } from '@/lib/api/resource'
import type { ResourceSummary } from '@/lib/api/types'
import { PasteDialog } from './PasteDialog'

const ACCEPT = '.md,.markdown,.txt,.docx,.pdf'

const kindLabel: Record<ResourceSummary['kind'], string> = {
  md: 'Markdown',
  txt: '文本',
  docx: 'Word',
  pdf: 'PDF',
  paste: '粘贴',
}

function reportIngest(body: { embedWarning: string | null; duplicateTitle: string | null }) {
  if (body.embedWarning) toast.warning(body.embedWarning)
  if (body.duplicateTitle) toast.info(`注意：工作间已有同内容资源《${body.duplicateTitle}》`)
}

export function ResourceList({ wsId }: { wsId: string }) {
  const queryClient = useQueryClient()
  const uploadInput = useRef<HTMLInputElement>(null)
  const replaceInput = useRef<HTMLInputElement>(null)
  const [replacing, setReplacing] = useState<ResourceSummary | null>(null)
  const [pendingFile, setPendingFile] = useState<File | null>(null)
  const [deleting, setDeleting] = useState<ResourceSummary | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)

  const { data: resources = [], isPending } = useQuery({
    queryKey: qk.resources(wsId),
    queryFn: () => resourceApi.list(wsId),
  })

  const upload = useMutation({
    mutationFn: (file: File) => resourceApi.upload(wsId, file),
    onSuccess: (body) => {
      void queryClient.invalidateQueries({ queryKey: qk.resources(wsId) })
      reportIngest(body)
      toast.success(`《${body.resource.title}》已入库（${body.chunkCount} 块）`)
    },
    onError: (e) => toast.error(`上传失败：${apiErrorMessage(e)}`),
  })

  const replace = useMutation({
    mutationFn: ({ rid, file }: { rid: string; file: File }) => resourceApi.replaceWithFile(wsId, rid, file),
    onSuccess: (body) => {
      void queryClient.invalidateQueries({ queryKey: qk.resources(wsId) })
      reportIngest(body)
      toast.success('已替换')
      setReplacing(null)
      setPendingFile(null)
    },
    onError: (e) => {
      toast.error(`替换失败：${apiErrorMessage(e)}`)
      setReplacing(null)
      setPendingFile(null)
    },
  })

  const remove = useMutation({
    mutationFn: (rid: string) => resourceApi.remove(wsId, rid),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.resources(wsId) })
      toast.success('资源已删除')
      setDeleting(null)
    },
    onError: (e) => toast.error(`删除失败：${apiErrorMessage(e)}`),
  })

  const busy = upload.isPending || replace.isPending

  return (
    <Card>
      <CardHeader>
        <CardTitle>资源</CardTitle>
        <CardDescription>工作间知识库：上传或粘贴资料，写稿大师检索引用（.md/.txt/.docx/.pdf，≤20MB）</CardDescription>
        <CardAction>
          <div className="flex gap-1.5">
            <Button size="sm" variant="outline" disabled={busy} onClick={() => setPasteOpen(true)}>
              粘贴文本
            </Button>
            <Button size="sm" disabled={busy} onClick={() => uploadInput.current?.click()}>
              <Upload />
              {upload.isPending ? '上传中…' : '上传文件'}
            </Button>
          </div>
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2">
        {/* 上传：选中即提交；替换：选中后进确认对话框（替换不可逆，多一步确认） */}
        <input
          ref={uploadInput}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) upload.mutate(file)
            e.target.value = ''
          }}
        />
        <input
          ref={replaceInput}
          type="file"
          accept={ACCEPT}
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file && replacing) setPendingFile(file)
            e.target.value = ''
          }}
        />

        {isPending && <div className="h-24 animate-pulse rounded-xl bg-muted/60" />}

        {!isPending && resources.length === 0 && (
          <EmptyState
            compact
            icon={FileText}
            title="还没有资源"
            description="上传或粘贴资料后，写稿大师涉及事实、数据、背景时会先检索再写。"
          />
        )}

        {!isPending &&
          resources.map((r) => (
            <div
              key={r.id}
              className="flex items-start justify-between gap-3 rounded-lg border p-3 transition-colors hover:bg-muted/40"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.title}</span>
                  <Badge variant="outline">{kindLabel[r.kind]}</Badge>
                </div>
                <p className="text-sm text-muted-foreground">
                  {new Date(r.createdAt).toLocaleDateString()} · {r.charCount.toLocaleString()} 字 · {r.chunkCount} 块
                  {r.embeddedCount < r.chunkCount ? ` · 向量 ${r.embeddedCount}/${r.chunkCount}` : ''}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setReplacing(r)
                    replaceInput.current?.click()
                  }}
                >
                  替换
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  disabled={remove.isPending}
                  onClick={() => setDeleting(r)}
                >
                  删除
                </Button>
              </div>
            </div>
          ))}
      </CardContent>

      {/* 替换确认：选中文件后二次确认（spec「文件选择后确认」） */}
      <Dialog
        open={replacing !== null && pendingFile !== null}
        onOpenChange={(v) => {
          if (!v) {
            setPendingFile(null)
            setReplacing(null)
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>替换资源</DialogTitle>
            <DialogDescription>
              用「{pendingFile?.name}」替换《{replacing?.title}》？旧内容与切块会被整体换新，不可恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setPendingFile(null)
                setReplacing(null)
              }}
            >
              取消
            </Button>
            <Button
              disabled={replace.isPending}
              onClick={() => replacing && pendingFile && replace.mutate({ rid: replacing.id, file: pendingFile })}
            >
              {replace.isPending ? '替换中…' : '确认替换'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 删除确认：级联删块不可逆，多一步确认 */}
      <Dialog open={deleting !== null} onOpenChange={(v) => !v && setDeleting(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>删除资源</DialogTitle>
            <DialogDescription>
              确定删除《{deleting?.title}》？切块与向量会一并删除，写稿大师将检索不到它。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => deleting && remove.mutate(deleting.id)}
            >
              {remove.isPending ? '删除中…' : '删除'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PasteDialog wsId={wsId} open={pasteOpen} onOpenChange={setPasteOpen} />
    </Card>
  )
}
```

- [ ] **Step 3: 挂进工作间设置页**

`web/src/routes/WorkspaceSettingsPage.tsx`：

1. import 追加：

```tsx
import { ResourceList } from '@/features/resources/ResourceList'
```

2. `workspace.data &&` 分支内，`<SpeakerList .../>` 之后追加：

```tsx
          <ResourceList wsId={wsId} />
```

- [ ] **Step 4: 类型检查**

```bash
npm run typecheck
```

预期：server + web 均通过。

- [ ] **Step 5: 浏览器手工验证（前端改动必测）**

```bash
npm run dev
```

打开 `工作间设置` 页，逐条过：

1. 空态显示「还没有资源」引导。
2. 上传一个 `.md` 文件 → toast「《文件名》已入库（N 块）」，列表出现该行（字符数/块数正确）。
3. 粘贴文本建资源 → 对话框校验（空标题/空正文不可提交），入库成功。
4. 重复上传同内容文件 → toast 提示「工作间已有同内容资源《…》」，不阻断。
5. 替换：点「替换」选新文件 → 弹确认框（显示文件名与目标资源）→ 确认后字符数/块数更新；`GET /resources/:id` 的 contentMd 是新的；取消则原样。
6. 删除：弹确认框 → 确认后行消失。
7. 负路径：上传 `.html` → toast 报「不支持的文件类型」。
8. 暗色模式下卡片样式正常。

- [ ] **Step 6: Commit**

```bash
git add web/src/features/resources/ResourceList.tsx web/src/features/resources/PasteDialog.tsx web/src/routes/WorkspaceSettingsPage.tsx
git commit -m "feat(web): 工作间设置资源卡片——上传/粘贴/替换/删除"
```

---

### Task 15: 文档同步 + 全量回归收尾

**Files:**
- Create: `docs/adr/0011-hybrid-resource-retrieval.md`
- Modify: `CONTEXT.md`、`docs/data-model-draft.md`、`docs/modules-and-phasing.md`、`README.md`

- [ ] **Step 1: ADR 0011**

`docs/adr/0011-hybrid-resource-retrieval.md`（照仓库 ADR 既有格式：背景 → 决定 → 后果）：

```markdown
# 0011 混合检索：BM25 + 向量，应用侧 RRF 融合

日期：2026-08-31；状态：已采纳（设计文档 `docs/superpowers/specs/2026-08-31-knowledge-retrieval-design.md`）

## 背景

写稿大师需要引用工作间资料。单一通道各有短板：BM25 抓词面精确匹配但缺语义泛化；
纯向量对专名/术语反而不稳。语料规模小（单工作间几十份资料），不值得引入外部
检索服务或 ANN 索引。

## 决定

- 双通道：pg_search BM25（top-20）+ pgvector 精确余弦 `<=>`（top-20），应用侧
  RRF 融合（`score = Σ 1/(60+rank)`）取前 5。
- 向量通道在检索层开关：`RETRIEVAL_MODE=hybrid|bm25`（缺省 hybrid）。摄入永远
  尽力 embed（失败置 NULL）——切换开关零重摄入成本。
- embedding = DashScope text-embedding-v4（1024 维，compatible-mode），best-effort：
  失败不阻断摄入，BM25 通道兜底。
- 文件摄入统一经 `uvx markitdown[pdf]` 转 markdown 再切块——格式适配外包给成熟
  工具，仓库零 Python 依赖（运行期前置要求 = 本机装 uv）。

## 后果

- 检索质量 = 两通道之和；任一通道失效（无 uv / 无凭证 / 无向量）自动退化为纯
  BM25，不报错。
- `resource_chunks_bm25` 索引语法绑定 pg_search 版本（spike 验证于 ParadeDB pg17）；
  升级 ParadeDB 时重跑 `server/scripts/spike-bm25.ts`。
- 精确余弦扫描随块数线性增长；到 ~10⁵ 块量级再评估 ANN（pgvector ivfflat/hnsw）。
```

- [ ] **Step 2: CONTEXT.md 补术语**

`CONTEXT.md`：

1. 术语表（按字母/既有顺序）加一条：

```markdown
- **块（Chunk）**：资源切块后的检索单位（`resource_chunks`）；带标题路径（「第一章 > 1.1」）
  与可选向量。写稿大师的 `retrieve` 工具返回的就是块。
```

2. 「写稿大师」相关条目里若列了工具面（read / add / edit），补成
   `read / add / edit / retrieve`（retrieve 只读，不改脚本）。

- [ ] **Step 3: docs/data-model-draft.md 与 docs/modules-and-phasing.md**

1. `docs/data-model-draft.md`：在实体清单加 `resources` 与 `resource_chunks`
   （字段照 `server/src/db/schema.ts` 资源层两表），关系注明
   `workspaces 1—N resources 1—N resource_chunks`，两条外键均级联删除。
2. `docs/modules-and-phasing.md`：续一期——加「资源摄入与检索」里程碑条目：
   后端 `modules/resources`（routes/service/convert/chunk/embed/retrieve）、
   writer 第四工具 `retrieve`、第六层资源清单、前端资源卡片。

- [ ] **Step 4: README.md**

1. 前置要求表加一行：`uv`（markitdown 运行环境；仅上传 .docx/.pdf 需要）。
2. 环境变量段加：`RETRIEVAL_MODE`（`hybrid`（缺省）| `bm25`；只影响检索层，
   摄入永远尽力 embed）。

- [ ] **Step 5: 全量回归**

```bash
npm run db:up
npm test
npm run typecheck
```

预期：全绿（`npm test` 根脚本 = 两工作区 `--if-present`；server 测试 `--test-concurrency=1` 跑真 DB）。

- [ ] **Step 6: Commit**

```bash
git add docs/adr/0011-hybrid-resource-retrieval.md CONTEXT.md docs/data-model-draft.md docs/modules-and-phasing.md README.md
git commit -m "docs(resources): ADR-0011 混合检索 + 术语/数据模型/里程碑/前置要求同步"
```
