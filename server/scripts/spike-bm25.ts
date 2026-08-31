// Spike 1：ParadeDB pg17 镜像内 pg_search BM25 的建索引语法与中文分词实际效果。
// 结论落 docs/research/knowledge-retrieval-spikes.md；若语法/分词器有变，
// 同步改迁移 0003 的建索引 SQL 与 retrieve.ts 的查询形状。
// 用法：npm run spike-bm25 -w server（DB 需在跑；本机为常驻容器 aipodcast-db）
// 注：脚本先探旧形状（计划默认），失败即记录；再探当前版本可用形状并断言。
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
  // 验证项：建索引语法（计划原样）在镜像内是否仍被接受
  await sql`CREATE INDEX spike_bm25_idx ON spike_bm25
    USING bm25 (id, content)
    WITH (key_field='id', text_fields='{"content": {"tokenizer": {"type": "chinese_compatible"}, "record": "freq"}}')`
  console.log('建索引语法（USING bm25 + WITH key_field/text_fields）可用')

  // 探针 A：计划默认旧形状——content @@@ '量子' + paradedb.score('索引名')
  try {
    await sql`
      SELECT content, paradedb.score('spike_bm25_idx') AS score
      FROM spike_bm25 WHERE content @@@ '量子' ORDER BY score DESC`
    console.log('旧形状（content @@@ 裸查询 + paradedb.score(索引名)）可用')
  } catch (err) {
    console.log('旧形状（content @@@ 裸查询 + paradedb.score(索引名)）不可用：', (err as Error).message.slice(0, 200))
  }

  // 探针 B：paradedb.parse('content:量子')（column:term Lucene 形状）
  try {
    await sql`SELECT count(*)::int AS n FROM spike_bm25 WHERE id @@@ paradedb.parse('content:量子')`
    console.log('paradedb.parse(column:term) 对中文可用')
  } catch (err) {
    console.log('paradedb.parse(column:term) 对中文报错：', (err as Error).message.slice(0, 200))
  }

  // 探针 C：当前版本可用形状——key_field @@@ paradedb.match(字段, 词) + paradedb.score(key_field)
  const hits = await sql`
    SELECT content, paradedb.score(id) AS score
    FROM spike_bm25 WHERE id @@@ paradedb.match('content', '量子') ORDER BY score DESC`
  console.log('新形状查询「量子」命中：', hits.length)
  for (const r of hits) console.log(' -', r.score, r.content)
  if (hits.length !== 2) throw new Error('期望命中两条量子行，实际 ' + hits.length)

  // 验证项：查询串含 tantivy/Lucene 特殊字符时的行为（match 走分词而非语法解析）
  const special = await sql`
    SELECT count(*)::int AS n FROM spike_bm25 WHERE id @@@ paradedb.match('content', '后期 (流水线)')`
  console.log('特殊字符经 paradedb.match 可执行，命中：', special[0]!.n)

  console.log('SPIKE OK：建索引语法与 @@@ 查询可用；把分词效果结论写入 docs/research/knowledge-retrieval-spikes.md')
} finally {
  await sql`DROP TABLE IF EXISTS spike_bm25`
  await sql.end({ timeout: 1 })
}
