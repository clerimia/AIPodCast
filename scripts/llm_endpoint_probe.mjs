#!/usr/bin/env node
// -*- coding: utf-8 -*-
// LLM 端点探针 — 验证北京业务空间专属端点上实际开通的文本生成模型。
//
// 对每个候选模型发两类调用（OpenAI 兼容 chat/completions）：
//   1. 可达性 + 工具调用：stream:false + tools(get_current_time) + 强制 tool_choice + enable_thinking:false
//   2. 流式：stream:true + 极短 prompt
// 记录 HTTP 状态码、是否返回 tool_calls、SSE 是否逐 chunk、finish_reason，以及失败时的错误类别。
//
// 用法：node scripts/llm_endpoint_probe.mjs
// Key 与 base_url 从仓库根目录 .env 读取；不会打印 Key。
// 可重复运行，不产生任何副作用。

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const MODELS = ['qwen3.7-plus', 'qwen3.7-flash', 'qwen-plus', 'qwen-flash'];
const TOOL_NAME = 'get_current_time';

// ── .env 读取（不打印 Key） ──────────────────────────────────────────────
function loadEnv(key) {
  try {
    const raw = readFileSync(join(REPO_ROOT, '.env'), 'utf-8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (m && m[1] === key) return m[2].trim();
    }
  } catch {
    // fall through
  }
  return process.env[key] ?? '';
}

const API_KEY = loadEnv('DASHSCOPE_API_KEY');
const BASE_URL = loadEnv('DASHSCOPE_BASE_URL').replace(/\/+$/, '');
const ENDPOINT = `${BASE_URL}/compatible-mode/v1/chat/completions`;

if (!API_KEY) {
  console.error('[FATAL] DASHSCOPE_API_KEY not found in .env');
  process.exit(1);
}
if (!BASE_URL) {
  console.error('[FATAL] DASHSCOPE_BASE_URL not found in .env');
  process.exit(1);
}

// ── 小工具 ────────────────────────────────────────────────────────────────
const decoder = new TextDecoder('utf-8');

function classifyError(status, bodyText) {
  if (status === 401) return '401 鉴权失败';
  if (status === 403) return '403 无权限';
  if (status === 404) return '404 模型不存在/未开通';
  if (status >= 500) return `${status} 服务端错误`;
  if (status >= 400) {
    // 尝试从 body 里抠出 message
    try {
      const j = JSON.parse(bodyText);
      const msg = j.error?.message || j.message || j.msg || '';
      return `${status} ${msg}`.slice(0, 160);
    } catch {
      return `${status} 客户端错误`;
    }
  }
  return `${status}`;
}

function baseHeaders() {
  return {
    Authorization: `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  };
}

// ── 调用 1：非流式 + 工具调用 ─────────────────────────────────────────────
async function probeToolCall(model) {
  const body = {
    model,
    stream: false,
    enable_thinking: false,
    messages: [
      { role: 'system', content: '你是工具调用测试助手。' },
      { role: 'user', content: '请调用 get_current_time 工具。' },
    ],
    tools: [
      {
        type: 'function',
        function: {
          name: TOOL_NAME,
          description: '获取当前时间',
          parameters: { type: 'object', properties: {}, required: [] },
        },
      },
    ],
    tool_choice: { type: 'function', function: { name: TOOL_NAME } },
  };

  const t0 = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: baseHeaders(),
      body: JSON.stringify(body),
    });
    const status = res.status;
    const text = await res.text();
    const ms = Date.now() - t0;

    if (status !== 200) {
      return {
        model,
        test: 'tool_call',
        status,
        ok: false,
        note: classifyError(status, text),
        ms,
      };
    }

    let toolCalls = null;
    let finishReason = null;
    try {
      const j = JSON.parse(text);
      const msg = j.choices?.[0]?.message;
      toolCalls = msg?.tool_calls ?? null;
      finishReason = j.choices?.[0]?.finish_reason ?? null;
    } catch {
      return { model, test: 'tool_call', status, ok: false, note: '200 但响应非 JSON', ms };
    }

    const names = Array.isArray(toolCalls) ? toolCalls.map((t) => t.function?.name) : [];
    return {
      model,
      test: 'tool_call',
      status,
      ok: names.includes(TOOL_NAME),
      toolCallNames: names,
      finishReason,
      note: names.includes(TOOL_NAME) ? 'tool_calls 已返回并命中强制工具' : '未返回期望的 tool_calls',
      ms,
    };
  } catch (e) {
    return {
      model,
      test: 'tool_call',
      status: 0,
      ok: false,
      note: `网络/请求异常: ${e.message}`,
      ms: Date.now() - t0,
    };
  }
}

// ── 调用 2：流式 ──────────────────────────────────────────────────────────
async function probeStream(model) {
  const body = {
    model,
    stream: true,
    messages: [{ role: 'user', content: '回复：ok' }],
  };

  const t0 = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { ...baseHeaders(), Accept: 'text/event-stream' },
      body: JSON.stringify(body),
    });
    const status = res.status;

    if (status !== 200) {
      const text = await res.text();
      return {
        model,
        test: 'stream',
        status,
        ok: false,
        note: classifyError(status, text),
        ms: Date.now() - t0,
      };
    }

    // 读 SSE：逐 chunk 解析 data: 行
    let chunkCount = 0;
    let finishReason = null;
    let content = '';
    let rawErr = null;
    try {
      const reader = res.body.getReader();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunkCount += 1;
        buf += decoder.decode(value, { stream: true });
        // 以空行为界切分 SSE 事件
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const event = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of event.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (data === '[DONE]') continue;
            try {
              const j = JSON.parse(data);
              const delta = j.choices?.[0]?.delta;
              const fr = j.choices?.[0]?.finish_reason;
              if (typeof delta?.content === 'string') content += delta.content;
              if (fr) finishReason = fr;
            } catch {
              rawErr = `SSE 非 JSON 行: ${data.slice(0, 80)}`;
            }
          }
        }
      }
      // 剩余未以 \n\n 结尾的片段
      if (buf.trim()) {
        for (const line of buf.split('\n')) {
          if (line.startsWith('data:') && line.slice(5).trim() !== '[DONE]') {
            try {
              const j = JSON.parse(line.slice(5).trim());
              const fr = j.choices?.[0]?.finish_reason;
              if (fr) finishReason = fr;
            } catch {
              /* 忽略尾片 */
            }
          }
        }
      }
    } catch (e) {
      rawErr = `读流异常: ${e.message}`;
    }

    return {
      model,
      test: 'stream',
      status,
      ok: chunkCount > 0 && content.trim() !== '',
      chunkCount,
      finishReason,
      content: content.trim().slice(0, 40),
      note: rawErr ?? 'SSE 逐 chunk 返回',
      ms: Date.now() - t0,
    };
  } catch (e) {
    return {
      model,
      test: 'stream',
      status: 0,
      ok: false,
      note: `网络/请求异常: ${e.message}`,
      ms: Date.now() - t0,
    };
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────
function pad(s, n) {
  s = String(s);
  return s + ' '.repeat(Math.max(0, n - s.length));
}

async function main() {
  console.log(`端点探针 · ${ENDPOINT}`);
  console.log(`候选模型：${MODELS.join(', ')}\n`);

  const results = [];
  for (const model of MODELS) {
    const [tool, stream] = await Promise.all([
      probeToolCall(model),
      probeStream(model),
    ]);
    results.push(tool, stream);
  }

  // 汇总表
  console.log('模型             | 工具调用        | 流式            | 备注');
  console.log('-----------------|-----------------|-----------------|------------------------------------------');
  const byModel = new Map();
  for (const r of results) {
    if (!byModel.has(r.model)) byModel.set(r.model, {});
    byModel.get(r.model)[r.test] = r;
  }
  for (const model of MODELS) {
    const t = byModel.get(model).tool_call;
    const s = byModel.get(model).stream;
    const tCell = t.status === 200
      ? `${t.ok ? 'OK' : 'x'}(${t.finishReason ?? '-'})`
      : `FAIL(${t.status})`;
    const sCell = s.status === 200
      ? `OK chunks=${s.chunkCount} (${s.finishReason ?? '-'})`
      : `FAIL(${s.status})`;
    const note = (t.status === 200 && s.status === 200)
      ? `${s.content ? '"' + s.content + '"' : ''}`
      : (t.status !== 200 ? t.note : s.note);
    console.log(`${pad(model, 16)} | ${pad(tCell, 15)} | ${pad(sCell, 15)} | ${note}`);
  }

  console.log('\n── 原始结果（JSON，供机器读取） ──────────────────────────────');
  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exit(1);
});
