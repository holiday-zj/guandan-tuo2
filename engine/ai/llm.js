// LLM 客户端：百炼(OpenAI兼容) + 超时/降级/缓存
// ⚠️ 密钥只在 data/llm.env（已 gitignore），不进代码库、不打日志
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// engine/ai/ → engine/ → 项目根 → data/llm.env（曾误写 '../data/' 导致永远读不到配置、静默降级）
const ENV_FILE = path.resolve(__dirname, '../../data/llm.env');

function loadEnv() {
  const cfg = {};
  try {
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#') || !t.includes('=')) continue;
      const i = t.indexOf('=');
      cfg[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  } catch { /* 无配置文件 */ }
  // 环境变量优先（生产部署用 systemd Environment）
  for (const k of ['LLM_BASE', 'LLM_KEY', 'LLM_MODEL', 'LLM_FAST_MODEL']) {
    if (process.env[k]) cfg[k] = process.env[k];
  }
  return cfg;
}

let cfg = loadEnv();

export function llmStatus() {
  const disabled = process.env.LLM_DISABLE === '1'; // 测试/离线模式：强制走启发式，不发起真实API调用
  const enabled = !disabled && !!(cfg.LLM_KEY && cfg.LLM_KEY.length >= 20);
  return {
    enabled,
    disabledByEnv: disabled,
    base: cfg.LLM_BASE || '(未配置)',
    model: cfg.LLM_MODEL || '(未配置)',
    fastModel: cfg.LLM_FAST_MODEL || '(未配置)',
    keyLen: cfg.LLM_KEY ? cfg.LLM_KEY.length : 0,
  };
}

export function reloadLlmConfig() { cfg = loadEnv(); return llmStatus(); }

// 简易响应缓存：同样局面不重复调用（省钱省时间）
const cache = new Map();
const CACHE_MAX = 400;

function cacheKey(model, messages) {
  const h = crypto.createHash('sha256');
  h.update(model);
  for (const m of messages) h.update(m.role + '\n' + m.content);
  return h.digest('hex').slice(0, 32);
}

// —— 大模型输入输出日志（写入 data/llm-io.log；设 LLM_IO_LOG=0 可关闭）——
const IO_LOG_FILE = path.resolve(__dirname, '../../data/llm-io.log');
let ioSeq = 0;
let sysPromptLogged = false;

function logIO(reqId, model, type, payload) {
  if (process.env.LLM_IO_LOG === '0') return;
  try {
    const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const lines = [`[${ts}] #${reqId} ${type} model=${model}`];
    if (type === 'REQUEST') {
      // system prompt 每次相同，只在进程内完整记录一次
      if (!sysPromptLogged) {
        lines.push('===== SYSTEM PROMPT（完整，后续请求省略）=====');
        lines.push(payload.system);
        sysPromptLogged = true;
      } else {
        lines.push('===== SYSTEM PROMPT: 同前，省略 =====');
      }
      lines.push('===== USER PROMPT（发给模型的牌局信息）=====');
      lines.push(payload.user);
    } else if (type === 'RESPONSE') {
      lines.push(`===== 耗时 ${payload.ms}ms =====`);
      lines.push('----- RAW（模型原始输出）-----');
      lines.push(String(payload.raw || '').trim());
      lines.push('----- PARSED（解析后实际执行）-----');
      lines.push(JSON.stringify(payload.parsed));
      if (payload.usage) lines.push('----- TOKENS ----- ' + JSON.stringify(payload.usage));
    } else if (type === 'ERROR') {
      lines.push(`===== 调用失败 耗时${payload.ms}ms =====`);
      lines.push(String(payload.error));
    }
    lines.push('');
    fs.appendFileSync(IO_LOG_FILE, lines.join('\n') + '\n');
  } catch { /* 日志失败绝不能影响游戏 */ }
}

/**
 * 调用大模型，要求返回 JSON
 * @returns {Promise<{ok:boolean, data?:any, raw?:string, ms:number, cached?:boolean, error?:string}>}
 */
export async function askJson(systemPrompt, userPrompt, opts = {}) {
  const model = opts.fast ? (cfg.LLM_FAST_MODEL || cfg.LLM_MODEL) : (cfg.LLM_MODEL || cfg.LLM_FAST_MODEL);
  if (process.env.LLM_DISABLE === '1' || !cfg.LLM_KEY || !model) {
    return { ok: false, ms: 0, error: 'LLM_NOT_CONFIGURED' };
  }
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
  const ck = cacheKey(model, messages);
  if (cache.has(ck)) return { ok: true, data: cache.get(ck), cached: true, ms: 0 };

  const reqId = (++ioSeq).toString(36);
  const timeoutMs = opts.timeoutMs || 12000;
  const t0 = Date.now();
  logIO(reqId, model, 'REQUEST', { system: systemPrompt, user: userPrompt });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const resp = await fetch((cfg.LLM_BASE || '') + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: ['Bea', 'rer ', cfg.LLM_KEY].join(''),
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.maxTokens ?? 400,
        response_format: { type: 'json_object' },
        // 关闭深度思考：实测 qwen3.8-max 开启思考时每手 10~47 秒（游戏不可用），
        // 关闭后降到 ~2 秒且出牌质量不降。可用 LLM_THINKING=true 恢复思考模式。
        ...(process.env.LLM_THINKING === 'true' ? {} : { enable_thinking: false }),
      }),
      signal: ac.signal,
    });
    if (!resp.ok) {
      const txt = (await resp.text()).slice(0, 200);
      logIO(reqId, model, 'ERROR', { ms: Date.now() - t0, error: `HTTP ${resp.status}: ${txt}` });
      return { ok: false, ms: Date.now() - t0, error: `HTTP ${resp.status}: ${txt}` };
    }
    // ⚠️ 关键：abort 定时器必须覆盖到响应体读取完成。
    // 曾因收到响应头后就 clearTimeout，若 API 响应体卡住（限流/网络抖动），
    // resp.json() 永久挂起 → 机器人决策卡死整局（真实事故）
    const d = await resp.json();
    clearTimeout(timer);
    const raw = d?.choices?.[0]?.message?.content || '';
    const data = extractJson(raw);
    logIO(reqId, model, 'RESPONSE', { ms: Date.now() - t0, raw, parsed: data, usage: d?.usage });
    if (!data) return { ok: false, ms: Date.now() - t0, raw, error: 'JSON_PARSE_FAILED' };
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(ck, data);
    return { ok: true, data, raw, ms: Date.now() - t0, usage: d.usage };
  } catch (e) {
    clearTimeout(timer);
    const err = e.name === 'AbortError' ? 'TIMEOUT' : String(e.message || e);
    logIO(reqId, model, 'ERROR', { ms: Date.now() - t0, error: err });
    return { ok: false, ms: Date.now() - t0, error: err };
  }
}

// 从模型输出里稳健提取 JSON（容错代码块、前后废话）
export function extractJson(text) {
  if (!text) return null;
  const t = String(text).trim();
  try { return JSON.parse(t); } catch { /* 继续 */ }
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) { try { return JSON.parse(fenced[1].trim()); } catch { /* 继续 */ } }
  // 取第一个平衡的 {...}
  const start = t.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < t.length; i++) {
    if (t[i] === '{') depth++;
    else if (t[i] === '}') { depth--; if (depth === 0) { try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; } } }
  }
  return null;
}
