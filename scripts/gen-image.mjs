#!/usr/bin/env node
/**
 * gen-image.mjs — DSH 生图 / 改图 skill CLI（v2）
 *
 * 用 DSH 本机已存的 API 凭证（~/.dsh/.credentials.yaml 的 refs 段）文生图与图生图。
 * 无第三方依赖：Node 18+ 内置 fetch。本机实测 curl / Invoke-WebRequest 的 TLS
 * 在沙箱内不可用，所以一律用 node 发请求。
 *
 * 用法:
 *   node gen-image.mjs --prompt "一只在雨夜窗边的猫" --aspect 16:9
 *   node gen-image.mjs --prompt "把背景换成雪天" --image in.jpg
 *   node gen-image.mjs --prompt "..." --transparent --count 2
 *   node gen-image.mjs --list
 *
 * stdout 永远是单个 JSON 对象（成功或失败），便于 agent 解析；stderr 只放人读日志。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.dirname(HERE);
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const CRED_FILE = path.join(DSH_HOME, '.credentials.yaml');

const DEFAULTS = {
  timeoutMs: 180_000,
  retries: 1,
  quality: 'auto',
  provider: 'auto',
  outDir: path.join(process.cwd(), 'image-gen-out'),
  aspect: '1:1',
  count: 1,
};

const MAX_IMAGES = 4;
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const ASPECTS = ['1:1', '4:3', '3:4', '16:9', '9:16', '3:2', '2:3', '21:9'];

const SIZE_MAP = {
  minimax: { '1:1': '1:1', '4:3': '4:3', '3:4': '3:4', '16:9': '16:9', '9:16': '9:16', '3:2': '3:2', '2:3': '2:3', '21:9': '21:9' },
  dashscope: { '1:1': '1024*1024', '4:3': '1152*864', '3:4': '864*1152', '16:9': '1280*720', '9:16': '720*1280', '3:2': '1248*832', '2:3': '832*1248', '21:9': '1344*576' },
  zhipu: { '1:1': '1024x1024', '4:3': '1152x864', '3:4': '864x1152', '16:9': '1440x720', '9:16': '720x1440', '3:2': '1344x768', '2:3': '768x1344', '21:9': '1440x720' },
  // Ark: 面积上限 4,622,420 px、比例 ≤16:1；下面都在范围内
  ark: { '1:1': '2048x2048', '4:3': '2304x1728', '3:4': '1728x2304', '16:9': '2560x1440', '9:16': '1440x2560', '3:2': '2400x1600', '2:3': '1600x2400', '21:9': '2560x1098' },
};

const ARK_MODELS_FALLBACK = {
  flash: 'doubao-seedream-5-0-flash-260915',
  pro: 'doubao-seedream-5-0-pro-260628',
};

const DASHSCOPE_EDIT_MODEL = 'qwen-image-3.0';

const PROVIDERS = {
  minimax: {
    id: 'minimax',
    label: 'MiniMax image-01',
    keyRef: 'MINIMAX1_API_KEY',
    models: ['image-01'],
    defaultModel: 'image-01',
    watermark: false,
    edit: false,
    transparent: false,
    cost: '订阅套餐内（本机 key 为套餐 key）',
    speed: '~15s',
    endpoint: 'https://api.minimaxi.com/v1/image_generation',
  },
  dashscope: {
    id: 'dashscope',
    label: '阿里通义 Qwen-Image / 万相',
    keyRef: 'QWEN_TOKEN_PLAN_CN_API_KEY',
    models: ['wan2.2-t2i-flash', 'wanx2.1-t2i-turbo', 'qwen-image-3.0', 'qwen-image-3.0-pro', 'qwen-image-2.1-pro', 'qwen-image-2.1-turbo'],
    defaultModel: 'wan2.2-t2i-flash',
    editModel: DASHSCOPE_EDIT_MODEL,
    editModels: ['qwen-image-3.0', 'qwen-image-3.0-pro', 'qwen-image-2.1-pro', 'qwen-image-2.1-turbo'],
    notes: ['qwen-image-* 走 multimodal-generation 端点，文生图/编辑均可用；输出固定 2048²，尺寸不可控', 'wan* 走 text2image 异步端点'],
    watermark: false,
    edit: true,
    transparent: false,
    cost: '按张计费（百炼控制台）',
    speed: '~7s（万相）/ 15–105s（Qwen-Image）',
    endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis',
  },
  zhipu: {
    id: 'zhipu',
    label: '智谱 CogView-3-Flash（免费档）',
    keyRef: 'ZAI_CODING_CN_API_KEY',
    models: ['cogview-3-flash', 'cogview-4', 'glm-image'],
    defaultModel: 'cogview-3-flash',
    notes: ['cogview-4 / glm-image 需要资源包，本机 key 无额度（429 code=1113），默认只用免费的 cogview-3-flash'],
    watermark: true,
    edit: false,
    transparent: false,
    cost: '免费，但右下角固定「AI生成」水印',
    speed: '~8s',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4/images/generations',
  },
  ark: {
    id: 'ark',
    label: '火山方舟 Seedream 5.0 / 4.x',
    keyRef: 'ARK_API_KEY',
    models: ['doubao-seedream-5-0-flash-260915', 'doubao-seedream-5-0-pro-260628', 'doubao-seedream-4-0-250828', 'doubao-seedream-4-0-20260415', 'doubao-seedream-4-5-251128'],
    defaultModel: ARK_MODELS_FALLBACK.flash,
    notes: ['4-5-251128 只支持 size:"2K"（传 1K 会 400），且不支持透明背景', 'transparent 仅 5.0 flash/pro 支持，需带 alpha 的 PNG 输入'],
    watermark: false,
    edit: true,
    transparent: true,
    cost: 'Flash ~0.12 元/张，Pro 更贵更慢',
    speed: '~8s（Flash）/ 17–75s（Pro）/ 4–7s（4.x）',
    endpoint: 'https://ark.cn-beijing.volces.com/api/v3/images/generations',
  },
};

const USAGE = `DSH 生图 / 改图 CLI（用本机已存 API 凭证）

用法:
  node gen-image.mjs --prompt "描述" [选项]              # 文生图
  node gen-image.mjs --prompt "把背景换成雪天" --image in.jpg   # 图生图/编辑
  node gen-image.mjs --prompt-file p.txt [选项]
  node gen-image.mjs --list
  node gen-image.mjs --verify [fast|all]                 # 全模型可调用性自检

选项:
  --prompt <text>        提示词；含引号/换行/中文建议改用 --prompt-file
  --prompt-file <path>   从 UTF-8 文件读提示词（"-" 表示 stdin）
  --image <path>         参考图/待编辑图，可重复最多 ${MAX_IMAGES} 张；给了即进入编辑模式
  --aspect <a>           画面比例：${ASPECTS.join(' | ')}（默认 1:1）
  --size <WxH>           显式尺寸，覆盖 --aspect（如 2048x2048）
  --transparent          透明背景（仅 ark 编辑路径；必须同时给带 alpha 的 PNG）
  --count <n>            生成张数 ${DEFAULTS.count}-${MAX_IMAGES}，串行（默认 1）
  --provider <id>        minimax | dashscope | zhipu | ark（默认 auto 按链回退）
  --quality <q>          auto（默认，MiniMax 优先）| high（Seedream Flash 优先）
                         | best（Seedream Pro 优先，最贵最慢）
  --model <id>           覆盖 provider 默认模型（建议配合 --provider）
  --out <dir>            输出目录（默认 <cwd>/image-gen-out）
  --name <base>          文件名前缀（默认由提示词生成）
  --timeout <ms>         单次请求超时（默认 180000）
  --retries <n>          网络/5xx 重试次数（默认 1）
  --list                 列出 provider、能力、凭证可用性与 Ark 可用模型，不出图
  --verify [fast|all]    逐模型真实自检可调用性：fast=每个 provider 一条核心路径，
                         all=完整矩阵（文生图/编辑/透明，按张计费）
  --dry-run              只打印将要发出的请求，不调用 API
  --help                 显示本帮助

凭证:
  按 provider 的 keyRef 依次读 环境变量 -> ${CRED_FILE.replace(os.homedir(), '~')} 的 refs 段：
  MINIMAX1_API_KEY / QWEN_TOKEN_PLAN_CN_API_KEY / ZAI_CODING_CN_API_KEY / ARK_API_KEY

产物:
  图片写到 --out 目录（原子写：先 .part 再 rename），stdout 输出 JSON:
  单张: { ok, provider, model, path, width, height, bytes, ms, watermark, attempts }
  多张: { ok, count, images: [...], totalMs }
  编辑: 额外带 mode:"edit" 与 inputs:[...]

退出码: 0 成功 / 1 全部 provider 失败 / 2 用法错误
`;

// ---------------------------------------------------------------- utils

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class UsageError extends Error {}

function errExit(message, code = 2) {
  console.error(`gen-image: ${message}`);
  process.exit(code);
}

function maskKey(key) {
  if (!key) return null;
  return `${key.slice(0, 6)}…(${key.length})`;
}

function redact(text, key) {
  if (!text) return text;
  return key ? String(text).split(key).join('<KEY>') : String(text);
}

function normalizeAspect(input) {
  if (!input) return DEFAULTS.aspect;
  const a = String(input).trim().replace(/[xX×]/g, ':');
  return ASPECTS.includes(a) ? a : null;
}

function parseSize(input) {
  if (!input) return null;
  const m = String(input).trim().match(/^(\d{3,5})\s*[xX×*]\s*(\d{3,5})$/);
  if (!m) return null;
  return { w: Number(m[1]), h: Number(m[2]), str: `${m[1]}x${m[2]}` };
}

function parseArgs(argv) {
  const opts = {};
  const repeated = new Set(['image']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new UsageError(`无法识别的参数: ${a}`);
    let key = a.slice(2);
    let val;
    const eq = key.indexOf('=');
    if (eq >= 0) {
      val = key.slice(eq + 1);
      key = key.slice(0, eq);
    }
    if (key === 'verify') {
      const next = argv[i + 1];
      if (val === undefined && (next === 'fast' || next === 'all')) {
        i += 1;
        val = next;
      }
      opts.verify = val === undefined ? true : val;
      continue;
    }
    const booleans = new Set(['help', 'list', 'dry-run', 'transparent', 'version', 'verify']);
    if (val === undefined && !booleans.has(key)) {
      val = argv[++i];
      if (val === undefined) throw new UsageError(`--${key} 缺少值`);
    }
    if (repeated.has(key)) {
      opts[key] = opts[key] || [];
      opts[key].push(val === undefined ? true : val);
    } else {
      opts[key] = val === undefined ? true : val;
    }
  }
  return opts;
}

// ---------------------------------------------------------------- credentials

function readCredentials() {
  try {
    const raw = fs.readFileSync(CRED_FILE, 'utf8');
    const refs = {};
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s{2,}([A-Z][A-Z0-9_]*):\s*(\S.*?)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      refs[m[1]] = v;
    }
    return refs;
  } catch {
    return {};
  }
}

function resolveKey(provider, creds) {
  const envVal = process.env[provider.keyRef];
  if (envVal && envVal.trim()) return { key: envVal.trim(), source: 'env' };
  const fromFile = creds[provider.keyRef];
  if (fromFile) return { key: fromFile, source: 'credentials' };
  return { key: null, source: null };
}

// ---------------------------------------------------------------- http

async function httpJson(url, { method = 'GET', headers = {}, body, timeoutMs = DEFAULTS.timeoutMs } = {}) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...headers },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const err = new Error(`网络错误: ${e.name === 'TimeoutError' ? '请求超时' : e.message}`);
    err.kind = 'network';
    err.retryable = true;
    throw err;
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, ok: res.ok, json, text };
}

function providerError(providerId, res, message) {
  const status = res?.status ?? 0;
  const code =
    res?.json?.error?.code ??
    res?.json?.error?.type ??
    res?.json?.base_resp?.status_code ??
    res?.json?.code ??
    null;
  let kind = 'unknown';
  if (status === 401 || status === 403) kind = 'auth';
  else if (status === 429) kind = 'quota';
  else if (status >= 500) kind = 'server';
  else if (status === 400 || status === 404 || status === 422) kind = 'bad_request';
  else if (!status) kind = 'network';
  if (code === 1004 || code === 'AuthenticationError') kind = 'auth';
  if (code === 1008 || code === 1113 || code === 'SetLimitExceeded') kind = 'quota';
  if (code === 1002) kind = 'quota';
  if (code === 1026) kind = 'moderation';
  const err = new Error(`${providerId}: ${message}${code ? ` [${code}]` : ''}`);
  Object.assign(err, { kind, status, code, provider: providerId, body: res?.text?.slice(0, 800) ?? '', retryable: kind === 'server' || kind === 'network' });
  throw err;
}

function assertOk(providerId, res, what) {
  if (res.ok && !(res.json?.base_resp && res.json.base_resp.status_code !== 0)) return;
  const json = res.json;
  if (json?.base_resp && json.base_resp.status_code !== 0) {
    providerError(providerId, res, json.base_resp.status_msg || 'base_resp 非 0');
  }
  if (res.ok) return;
  const msg =
    (json?.error?.message ?? json?.base_resp?.status_msg ?? (res.text || '').slice(0, 300)) || `HTTP ${res.status}`;
  providerError(providerId, res, `${what}失败: ${msg}`);
}

async function downloadImage(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
  if (!res.ok) {
    const err = new Error(`下载图片失败: HTTP ${res.status}`);
    err.kind = 'network';
    err.status = res.status;
    throw err;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > 40 * 1024 * 1024) throw new Error(`图片过大: ${buf.length} bytes`);
  return buf;
}

// ---------------------------------------------------------------- image sniffing

function jpegDims(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) {
      i += 1;
      continue;
    }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    if (len <= 0) break;
    i += 2 + len;
  }
  return null;
}

function sniffImage(buf) {
  if (buf.length > 24 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') {
    const bitDepth = buf[24];
    const colorType = buf[25];
    const hasAlpha = colorType === 4 || colorType === 6 || buf.includes('tRNS');
    return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), hasAlpha, bitDepth };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    const d = jpegDims(buf) ?? {};
    return { format: 'jpeg', width: d.width ?? null, height: d.height ?? null, hasAlpha: false };
  }
  if (buf.length > 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    if (buf.toString('ascii', 12, 16) === 'VP8X') {
      return {
        format: 'webp',
        width: 1 + buf.readUIntLE(24, 3),
        height: 1 + buf.readUIntLE(27, 3),
        hasAlpha: (buf[20] & 0x10) !== 0,
      };
    }
    return { format: 'webp', width: null, height: null, hasAlpha: false };
  }
  return { format: null, width: null, height: null, hasAlpha: false };
}

// ---------------------------------------------------------------- input images

function loadInputImages(paths) {
  return paths.map((p) => {
    const abs = path.resolve(p);
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch {
      throw new UsageError(`读不到参考图: ${p}`);
    }
    if (buf.length > MAX_INPUT_BYTES) throw new UsageError(`参考图过大（>${MAX_INPUT_BYTES / 1024 / 1024}MB）: ${p}`);
    const info = sniffImage(buf);
    if (!info.format) throw new UsageError(`参考图不是 PNG/JPEG/WebP: ${p}`);
    const mime = info.format === 'jpeg' ? 'image/jpeg' : `image/${info.format}`;
    return { path: abs, bytes: buf.length, mime, b64: buf.toString('base64'), dataUrl: `data:${mime};base64,${buf.toString('base64')}`, width: info.width, height: info.height };
  });
}

// ---------------------------------------------------------------- providers

async function minimaxGenerate(ctx) {
  const { prompt, key, model, timeoutMs } = ctx;
  if (ctx.images.length) providerError('minimax', null, 'MiniMax image-01 不支持图生图/编辑');
  const endpoints = ['https://api.minimaxi.com/v1/image_generation', 'https://api.minimax.cn/v1/image_generation'];
  const body = { model, prompt, response_format: 'url', n: 1 };
  if (ctx.size) {
    body.width = ctx.size.w;
    body.height = ctx.size.h;
  } else {
    body.aspect_ratio = SIZE_MAP.minimax[ctx.aspect] || '1:1';
  }
  let lastErr;
  for (const url of endpoints) {
    try {
      const res = await httpJson(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs,
      });
      if (!res.ok) {
        const msg = res.json?.base_resp?.status_msg ?? res.text?.slice(0, 300) ?? `HTTP ${res.status}`;
        providerError('minimax', res, msg);
      }
      const code = res.json?.base_resp?.status_code;
      if (code !== 0) providerError('minimax', res, res.json?.base_resp?.status_msg || 'base_resp 非 0');
      const urls = res.json?.data?.image_urls || [];
      if (urls.length) return { kind: 'url', url: urls[0], requestId: res.json?.id, modelUsed: model };
      const b64 = res.json?.data?.image_base64 || [];
      if (b64.length) return { kind: 'b64', b64: b64[0], mime: 'image/jpeg', requestId: res.json?.id, modelUsed: model };
      providerError('minimax', res, '响应里没有图片');
    } catch (e) {
      lastErr = e;
      if (e.kind !== 'network') throw e;
    }
  }
  throw lastErr;
}

async function dashscopeGenerate(ctx) {
  // qwen-image 系列走原生 multimodal 端点（纯文本 content 即文生图）
  if (/^qwen-image/i.test(ctx.model || '')) {
    const out = await dashscopeMultimodal(ctx, false);
    return { ...out, kind: out.kind };
  }
  const { prompt, key, model, timeoutMs } = ctx;
  const size = ctx.size ? `${ctx.size.w}*${ctx.size.h}` : SIZE_MAP.dashscope[ctx.aspect] || '1024*1024';
  const submit = await httpJson('https://dashscope.aliyuncs.com/api/v1/services/aigc/text2image/image-synthesis', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({ model, input: { prompt }, parameters: { size, n: 1, prompt_extend: true } }),
    timeoutMs,
  });
  assertOk('dashscope', submit, '提交任务');
  const taskId = submit.json?.output?.task_id;
  if (!taskId) providerError('dashscope', submit, '没有返回 task_id');
  const deadline = Date.now() + timeoutMs;
  let delay = 1500;
  while (Date.now() < deadline) {
    await sleep(delay);
    delay = Math.min(Math.round(delay * 1.3), 5000);
    const q = await httpJson(`https://dashscope.aliyuncs.com/api/v1/tasks/${encodeURIComponent(taskId)}`, {
      headers: { Authorization: `Bearer ${key}` },
      timeoutMs,
    });
    assertOk('dashscope', q, '轮询任务');
    const out = q.json?.output || {};
    if (out.task_status === 'SUCCEEDED') {
      const url = out.results?.[0]?.url;
      if (!url) providerError('dashscope', q, '任务成功但没有图片 URL');
      return { kind: 'url', url, requestId: taskId, modelUsed: model };
    }
    if (out.task_status === 'FAILED' || out.task_status === 'CANCELED' || out.task_status === 'UNKNOWN') {
      providerError('dashscope', q, `任务 ${out.task_status}: ${out.code || ''} ${out.message || ''}`.trim());
    }
  }
  providerError('dashscope', null, `轮询超时（${timeoutMs}ms）`);
}

async function dashscopeMultimodal(ctx, withImages) {
  const { prompt, key, timeoutMs } = ctx;
  const model = ctx.model || PROVIDERS.dashscope.editModel;
  const content = [...(withImages ? ctx.images.map((i) => ({ image: i.dataUrl })) : []), { text: prompt }];
  const parameters = {};
  if (ctx.size) parameters.size = `${ctx.size.w}*${ctx.size.h}`;
  const res = await httpJson('https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input: { messages: [{ role: 'user', content }] }, parameters }),
    timeoutMs,
  });
  assertOk('dashscope', res, withImages ? '编辑' : '生成');
  const parts = res.json?.output?.choices?.[0]?.message?.content || [];
  const url = parts.map((c) => c.image).filter(Boolean)[0];
  if (!url) providerError('dashscope', res, '响应里没有图片');
  return { kind: 'url', url, requestId: res.json?.request_id, modelUsed: model };
}

async function zhipuGenerate(ctx) {
  const { prompt, key, model, timeoutMs } = ctx;
  if (ctx.images.length) providerError('zhipu', null, 'CogView-3-Flash 不支持图生图/编辑');
  const size = ctx.size ? `${ctx.size.w}x${ctx.size.h}` : SIZE_MAP.zhipu[ctx.aspect] || '1024x1024';
  const call = async (sz) =>
    httpJson('https://open.bigmodel.cn/api/paas/v4/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, size: sz }),
      timeoutMs,
    });
  let res = await call(size);
  if (!res.ok && res.status === 400 && size !== '1024x1024') {
    res = await call('1024x1024');
    assertOk('zhipu', res, '生成');
    const url2 = res.json?.data?.[0]?.url;
    if (!url2) providerError('zhipu', res, '响应里没有图片 URL');
    return { kind: 'url', url: url2, requestId: res.json?.id, modelUsed: model, note: '尺寸回退到 1024x1024' };
  }
  assertOk('zhipu', res, '生成');
  const url = res.json?.data?.[0]?.url;
  if (!url) providerError('zhipu', res, '响应里没有图片 URL');
  return { kind: 'url', url, requestId: res.json?.id, modelUsed: model };
}

async function pickArkModel(key, preferPro, timeoutMs) {
  try {
    const res = await httpJson('https://ark.cn-beijing.volces.com/api/v3/models', {
      headers: { Authorization: `Bearer ${key}` },
      timeoutMs: Math.min(timeoutMs, 30_000),
    });
    if (res.ok) {
      const list = res.json?.data || res.json?.models || [];
      const imageModels = list
        .filter((m) => (m.domain ?? '').toLowerCase() === 'imagegeneration' && (m.status ?? 'Published') === 'Published')
        .map((m) => m.id)
        .filter(Boolean);
      const want = preferPro ? /seedream-5-0-pro/i : /seedream-5-0-flash/i;
      const matched = imageModels.filter((id) => want.test(id));
      if (matched.length) return matched.sort().at(-1);
      if (imageModels.length) return imageModels.sort().at(-1);
    }
  } catch {
    /* 离线或权限不足时用内置常量 */
  }
  return preferPro ? ARK_MODELS_FALLBACK.pro : ARK_MODELS_FALLBACK.flash;
}

async function arkGenerate(ctx) {
  const { prompt, key, quality, timeoutMs, images } = ctx;
  const preferPro = quality === 'best' || Boolean(ctx.model && /-pro-/.test(ctx.model));
  const model = ctx.model || (await pickArkModel(key, preferPro, timeoutMs));
  const is45 = /4-5/i.test(model);
  if (is45 && ctx.transparent) {
    const err = new Error('ark: doubao-seedream-4-5 不支持透明背景（仅 5.0 flash/pro 支持）');
    Object.assign(err, { kind: 'bad_request', status: 400, code: 'NotSupported' });
    throw err;
  }
  // 4.5 只认 2K 档；其余按显式 size 或比例映射
  const preferredSize = is45 ? '2K' : ctx.size ? `${ctx.size.w}x${ctx.size.h}` : SIZE_MAP.ark[ctx.aspect] || '2K';
  const attempt = async (size, transparent) => {
    const body = { model, prompt, size, response_format: 'url', watermark: false };
    if (images.length) body.image = images.map((i) => i.dataUrl);
    if (transparent) {
      body.background = 'transparent';
      body.output_format = 'png';
    }
    const res = await httpJson('https://ark.cn-beijing.volces.com/api/v3/images/generations', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs,
    });
    assertOk('ark', res, images.length ? '编辑' : '生成');
    const d = res.json?.data?.[0];
    if (d?.url) return { kind: 'url', url: d.url, requestId: res.json?.id, modelUsed: model, arkSize: d.size, transparent };
    if (d?.b64_json) return { kind: 'b64', b64: d.b64_json, mime: transparent ? 'image/png' : 'image/jpeg', requestId: res.json?.id, modelUsed: model, arkSize: d.size, transparent };
    providerError('ark', res, '响应里没有图片');
  };
  try {
    return await attempt(preferredSize, ctx.transparent);
  } catch (e) {
    if (e.status === 400 && (ctx.transparent || preferredSize !== '2K')) {
      const out = await attempt('2K', ctx.transparent && preferredSize === '2K' ? false : ctx.transparent);
      const dropped = [];
      if (preferredSize !== '2K') dropped.push(`尺寸 ${preferredSize}→2K`);
      if (ctx.transparent && !out.transparent) dropped.push('透明背景→不透明');
      out.note = `参数组合被拒（${e.message.slice(0, 60)}），已回退：${dropped.join('，') || '去掉透明背景'}`;
      return out;
    }
    throw e;
  }
}

PROVIDERS.minimax.generate = minimaxGenerate;
PROVIDERS.dashscope.generate = dashscopeGenerate;
PROVIDERS.dashscope.editGenerate = (ctx) => dashscopeMultimodal(ctx, true);
PROVIDERS.zhipu.generate = zhipuGenerate;
PROVIDERS.ark.generate = arkGenerate;

// 可调用性自检矩阵：provider × model × 模式
const VERIFY_MATRIX = [
  { provider: 'minimax', model: 'image-01', mode: 't2i', core: true },
  { provider: 'dashscope', model: 'wan2.2-t2i-flash', mode: 't2i', core: true },
  { provider: 'dashscope', model: 'wanx2.1-t2i-turbo', mode: 't2i' },
  { provider: 'dashscope', model: 'qwen-image-3.0', mode: 't2i' },
  { provider: 'dashscope', model: 'qwen-image-3.0-pro', mode: 't2i' },
  { provider: 'dashscope', model: 'qwen-image-2.1-turbo', mode: 't2i' },
  { provider: 'zhipu', model: 'cogview-3-flash', mode: 't2i', core: true },
  { provider: 'ark', model: ARK_MODELS_FALLBACK.flash, mode: 't2i', core: true },
  { provider: 'ark', model: ARK_MODELS_FALLBACK.pro, mode: 't2i' },
  { provider: 'ark', model: 'doubao-seedream-4-5-251128', mode: 't2i' },
  { provider: 'ark', model: 'doubao-seedream-4-0-250828', mode: 't2i' },
  { provider: 'ark', model: 'doubao-seedream-4-0-20260415', mode: 't2i' },
  { provider: 'ark', model: ARK_MODELS_FALLBACK.flash, mode: 'edit', core: true },
  { provider: 'ark', model: ARK_MODELS_FALLBACK.pro, mode: 'edit' },
  { provider: 'ark', model: 'doubao-seedream-4-5-251128', mode: 'edit' },
  { provider: 'ark', model: 'doubao-seedream-4-0-250828', mode: 'edit' },
  { provider: 'dashscope', model: 'qwen-image-3.0', mode: 'edit', core: true },
  { provider: 'dashscope', model: 'qwen-image-3.0-pro', mode: 'edit' },
  { provider: 'dashscope', model: 'qwen-image-2.1-pro', mode: 'edit' },
  { provider: 'dashscope', model: 'qwen-image-2.1-turbo', mode: 'edit' },
  { provider: 'ark', model: ARK_MODELS_FALLBACK.flash, mode: 'transparent', core: true },
  { provider: 'ark', model: ARK_MODELS_FALLBACK.pro, mode: 'transparent' },
];

// ---------------------------------------------------------------- chain / run

function buildChain(cfg) {
  if (cfg.provider !== 'auto') return [cfg.provider];
  if (cfg.images.length) {
    // 编辑模式：能改图的在前
    const editOrder = ['ark', 'dashscope'];
    return cfg.quality === 'auto' ? editOrder : [...editOrder, 'minimax', 'zhipu'];
  }
  const order = {
    auto: ['minimax', 'dashscope', 'zhipu', 'ark'],
    high: ['ark', 'minimax', 'dashscope', 'zhipu'],
    best: ['ark', 'minimax', 'dashscope', 'zhipu'],
  };
  return order[cfg.quality] || order.auto;
}

function slugify(text) {
  const s = String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return s || 'image';
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function writeImageAtomic(file, buf) {
  const tmp = `${file}.part`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
}

async function withRetries(fn, retries) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!e.retryable || i === retries) throw e;
      await sleep(1000 * (i + 1));
    }
  }
  throw lastErr;
}

async function generateOne(cfg, index) {
  const creds = readCredentials();
  const chain = buildChain(cfg);
  const attempts = [];
  const startedAt = Date.now();
  const timestamp = stamp();

  for (const pid of chain) {
    const provider = PROVIDERS[pid];
    if (!provider) {
      attempts.push({ provider: pid, skipped: '未知 provider' });
      continue;
    }
    if (cfg.images.length && !provider.edit) {
      attempts.push({ provider: pid, skipped: '不支持编辑' });
      continue;
    }
    if (cfg.transparent && !provider.transparent) {
      attempts.push({ provider: pid, skipped: '不支持透明背景' });
      continue;
    }
    const { key, source } = resolveKey(provider, creds);
    if (!key) {
      attempts.push({ provider: pid, skipped: `缺少凭证 ${provider.keyRef}` });
      continue;
    }
    // ark 允许留空由 pickArkModel 按 quality/transparent 选 flash 或 pro
    const model =
      cfg.model ?? (pid === 'ark' ? null : cfg.images.length ? provider.editModel || provider.defaultModel : provider.defaultModel);
    const timeoutForProvider = cfg.timeoutExplicit
      ? cfg.timeoutMs
      : pid === 'dashscope' && cfg.images.length
        ? 300_000
        : cfg.timeoutMs;
    const ctx = {
      prompt: cfg.prompt,
      key,
      model,
      aspect: cfg.aspect,
      size: cfg.size,
      quality: cfg.quality,
      provider: pid,
      timeoutMs: timeoutForProvider,
      keySource: source,
      images: cfg.images,
      transparent: cfg.transparent,
    };
    if (cfg.dryRun) {
      attempts.push({ provider: pid, keyRef: provider.keyRef, key: maskKey(key), model, planned: true });
      continue;
    }

    const t0 = Date.now();
    try {
      const run = cfg.images.length && provider.editGenerate ? provider.editGenerate : provider.generate;
      const out = await withRetries(() => run(ctx), cfg.retries);
      const buf = out.kind === 'url' ? await downloadImage(out.url, cfg.timeoutMs) : Buffer.from(out.b64 || '', 'base64');
      if (!buf || buf.length < 1024) throw new Error('下载到的图片为空或过小');
      const info = sniffImage(buf);
      if (!info.format) throw new Error('下载内容不是 PNG/JPEG/WebP，可能被网关拦截');
      const ext = info.format === 'jpeg' ? 'jpg' : info.format;
      fs.mkdirSync(cfg.outDir, { recursive: true });
      const base = cfg.name ? slugify(cfg.name) : slugify(cfg.prompt);
      const suffix = cfg.count > 1 ? `-${index + 1}` : '';
      const file = path.join(cfg.outDir, `${base}${suffix}-${timestamp}.${ext}`);
      writeImageAtomic(file, buf);
      const ms = Date.now() - t0;
      const payload = {
        ok: true,
        mode: cfg.images.length ? 'edit' : 'text-to-image',
        provider: pid,
        providerLabel: provider.label,
        model: out.modelUsed || model,
        path: file,
        width: info.width,
        height: info.height,
        format: info.format,
        hasAlpha: info.hasAlpha,
        transparent: Boolean(cfg.transparent && info.format === 'png' && info.hasAlpha),
        bytes: buf.length,
        ms,
        totalMs: Date.now() - startedAt,
        watermark: provider.watermark,
        prompt: cfg.prompt,
        aspect: cfg.aspect,
        size: cfg.size ? cfg.size.str : null,
        keySource: source,
        quality: cfg.quality,
        attempts: [...attempts, { provider: pid, ok: true, ms, model: out.modelUsed || model }],
      };
      if (cfg.images.length) {
        payload.inputs = cfg.images.map((i) => ({ path: i.path, bytes: i.bytes, mime: i.mime, width: i.width, height: i.height }));
      }
      if (out.note) payload.note = out.note;
      if (provider.watermark) payload.note = `${payload.note ? payload.note + '；' : ''}该 provider 免费档带「AI生成」水印`;
      return payload;
    } catch (e) {
      attempts.push({
        provider: pid,
        ok: false,
        status: e.status ?? null,
        code: e.code ?? null,
        kind: e.kind ?? 'error',
        message: redact(e.message, key),
      });
      if (e.kind === 'moderation') {
        return { ok: false, error: { kind: 'moderation', message: '提示词被内容审核拒绝，请改写提示词' }, attempts };
      }
    }
  }

  return {
    ok: false,
    error: { kind: 'all_failed', message: '所有可用 provider 都失败或被跳过' },
    attempts,
    hint: '检查 ~/.dsh/.credentials.yaml 的 refs，或用 --provider/--quality 指定；--list 可看可用性',
  };
}

async function runGenerate(cfg) {
  if (cfg.dryRun) {
    const creds = readCredentials();
    const chain = buildChain(cfg);
    const attempts = chain.map((pid) => {
      const p = PROVIDERS[pid];
      if (!p) return { provider: pid, skipped: '未知 provider' };
      const { key } = resolveKey(p, creds);
      const skip = cfg.images.length && !p.edit ? '不支持编辑' : cfg.transparent && !p.transparent ? '不支持透明背景' : null;
      if (skip) return { provider: pid, skipped: skip };
      if (!key) return { provider: pid, skipped: `缺少凭证 ${p.keyRef}` };
      const model =
        cfg.model ??
        (cfg.transparent && p.id === 'ark'
          ? ARK_MODELS_FALLBACK.pro
          : cfg.images.length
            ? p.editModel || p.defaultModel
            : p.defaultModel);
      return { provider: pid, keyRef: p.keyRef, keyMask: maskKey(key), model, planned: true };
    });
    return {
      ok: true,
      dryRun: true,
      mode: cfg.images.length ? 'edit' : 'text-to-image',
      aspect: cfg.aspect,
      size: cfg.size ? cfg.size.str : null,
      transparent: cfg.transparent,
      count: cfg.count,
      promptChars: cfg.prompt.length,
      inputs: cfg.images.map((i) => i.path),
      attempts,
      hint: 'dry-run 未发起任何请求、未产生费用',
    };
  }

  if (cfg.count === 1) return generateOne(cfg, 0);
  const images = [];
  const failures = [];
  const t0 = Date.now();
  for (let i = 0; i < cfg.count; i++) {
    const r = await generateOne(cfg, i);
    if (r.ok) images.push(r);
    else {
      failures.push({ index: i, ...r });
      break;
    }
  }
  if (!images.length) return failures[0] || { ok: false, error: { message: '没有生成任何图片' } };
  return {
    ok: true,
    count: images.length,
    requested: cfg.count,
    totalMs: Date.now() - t0,
    images,
    paths: images.map((i) => i.path),
    failures,
  };
}

async function runVerify(cfg) {
  const scope = cfg.verifyScope === 'all' ? 'all' : 'fast';
  const matrix = scope === 'all' ? VERIFY_MATRIX : VERIFY_MATRIX.filter((e) => e.core);
  if (cfg.dryRun) {
    return {
      ok: true,
      dryRun: true,
      verifyScope: scope,
      total: matrix.length,
      matrix,
      hint: 'dry-run：只列出矩阵，未发起任何请求、未产生费用',
    };
  }
  const verifyAsset = path.join(SKILL_DIR, 'assets', 'verify-input.png');
  const results = [];
  const startedAt = Date.now();

  for (const entry of matrix) {
    let images = [];
    if (entry.mode !== 't2i') {
      try {
        images = loadInputImages([verifyAsset]);
      } catch (e) {
        results.push({ provider: entry.provider, model: entry.model, mode: entry.mode, ok: false, error: `缺少自检素材: ${e.message}` });
        continue;
      }
    }
    const sub = {
      ...cfg,
      prompt:
        entry.mode === 't2i'
          ? 'a red apple on a wooden table'
          : 'keep the subject unchanged, replace the background with a snowy field',
      provider: entry.provider,
      model: entry.model,
      images,
      transparent: entry.mode === 'transparent',
      size: null, // 让各 provider 用默认尺寸（qwen 系尺寸不可控，Ark 4.5 只认 2K）
      count: 1,
      name: `verify-${entry.provider}`,
      dryRun: false,
      timeoutExplicit: false,
      retries: 0,
    };
    const t0 = Date.now();
    const r = await generateOne(sub, 0);
    results.push({
      provider: entry.provider,
      model: entry.model,
      mode: entry.mode,
      ok: Boolean(r.ok),
      ms: r.ok ? r.ms : Date.now() - t0,
      width: r.width ?? null,
      height: r.height ?? null,
      path: r.path ?? null,
      transparent: r.transparent ?? null,
      error: r.ok ? null : r.error?.message || (r.attempts || []).map((a) => a.message).filter(Boolean).join('; ') || '未知错误',
    });
  }

  const failed = results.filter((r) => !r.ok);
  return {
    ok: failed.length === 0,
    verifyScope: scope,
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    totalMs: Date.now() - startedAt,
    results,
    hint: 'verify 按矩阵逐条真实调用（1024² 小尺寸，按张计费）；失败项看 error',
  };
}

async function runList() {
  const creds = readCredentials();
  const providers = Object.values(PROVIDERS).map((p) => {
    const { key, source } = resolveKey(p, creds);
    return {
      id: p.id,
      label: p.label,
      keyRef: p.keyRef,
      keyPresent: Boolean(key),
      keyMask: maskKey(key),
      keySource: source,
      models: p.models,
      notes: p.notes || null,
      editModel: p.editModel || null,
      editModels: p.editModels || null,
      edit: p.edit,
      transparent: p.transparent,
      watermark: p.watermark,
      cost: p.cost,
      speed: p.speed,
      endpoint: p.endpoint,
    };
  });
  let arkModels = null;
  const ark = providers.find((p) => p.id === 'ark');
  if (ark?.keyPresent) {
    const { key } = resolveKey(PROVIDERS.ark, creds);
    try {
      const res = await httpJson('https://ark.cn-beijing.volces.com/api/v3/models', {
        headers: { Authorization: `Bearer ${key}` },
        timeoutMs: 30_000,
      });
      if (res.ok) {
        const list = res.json?.data || res.json?.models || [];
        arkModels = list
          .filter((m) => (m.domain ?? '').toLowerCase() === 'imagegeneration')
          .map((m) => ({ id: m.id, status: m.status }));
      }
    } catch {
      arkModels = null;
    }
  }
  return { ok: true, credentialsFile: CRED_FILE, providers, arkModels, skillDir: SKILL_DIR, version: 2 };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    errExit(e.message + '\n\n' + USAGE, 2);
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (opts.list) {
    process.stdout.write(JSON.stringify(await runList(), null, 2) + '\n');
    return;
  }
  if (opts.verify) {
    const scope = opts.verify === true ? 'fast' : String(opts.verify);
    if (!['fast', 'all'].includes(scope)) errExit('--verify 只接受 fast 或 all\n\n' + USAGE, 2);
    const result = await runVerify({
      prompt: '',
      aspect: '1:1',
      size: null,
      images: [],
      transparent: false,
      provider: 'auto',
      quality: 'auto',
      timeoutMs: DEFAULTS.timeoutMs,
      timeoutExplicit: false,
      retries: 0,
      count: 1,
      outDir: path.resolve(opts.out || DEFAULTS.outDir),
      name: null,
      model: null,
      dryRun: Boolean(opts['dry-run']),
      verifyScope: scope,
    });
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    if (!result.ok) process.exit(1);
    return;
  }

  let prompt = opts.prompt;
  if (opts['prompt-file'] !== undefined) {
    const p = opts['prompt-file'];
    prompt = p === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(p, 'utf8');
  }
  if (typeof prompt !== 'string' || !prompt.trim()) errExit('缺少 --prompt 或 --prompt-file\n\n' + USAGE, 2);
  prompt = prompt.trim();
  if (prompt.length > 4000) errExit('提示词过长（>4000 字符）', 2);

  const aspect = normalizeAspect(opts.aspect);
  if (!aspect) errExit(`--aspect 必须是 ${ASPECTS.join('/')} 之一`, 2);
  const size = opts.size ? parseSize(opts.size) : null;
  if (opts.size && !size) errExit('--size 格式应为 WxH，例如 2048x2048', 2);

  let images = [];
  if (opts.image) {
    const list = Array.isArray(opts.image) ? opts.image : [opts.image];
    if (list.length > MAX_IMAGES) errExit(`--image 最多 ${MAX_IMAGES} 张`, 2);
    try {
      images = loadInputImages(list);
    } catch (e) {
      errExit(e.message, 2);
    }
  }

  const provider = opts.provider ?? DEFAULTS.provider;
  if (provider !== 'auto' && !PROVIDERS[provider]) errExit('--provider 必须是 auto/minimax/dashscope/zhipu/ark 之一', 2);
  if (opts.transparent) {
    if (!images.length) {
      errExit('--transparent 必须同时给 --image（一张带 alpha 的 PNG 参考图）：Seedream 只在编辑路径支持透明背景', 2);
    }
    if (provider !== 'auto' && !PROVIDERS[provider].transparent) {
      errExit(`--provider ${provider} 不支持透明背景（只有 ark/Seedream Pro 支持）`, 2);
    }
  }
  const quality = opts.quality ?? DEFAULTS.quality;
  if (!['auto', 'high', 'best'].includes(quality)) errExit('--quality 必须是 auto/high/best 之一', 2);
  const timeoutMs = opts.timeout ? Number(opts.timeout) : DEFAULTS.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 10_000) errExit('--timeout 至少 10000 ms', 2);
  const retries = opts.retries !== undefined ? Number(opts.retries) : DEFAULTS.retries;
  if (!Number.isInteger(retries) || retries < 0 || retries > 3) errExit('--retries 必须是 0-3', 2);
  const count = opts.count !== undefined ? Number(opts.count) : DEFAULTS.count;
  if (!Number.isInteger(count) || count < 1 || count > MAX_IMAGES) errExit(`--count 必须是 1-${MAX_IMAGES}`, 2);

  const cfg = {
    prompt,
    aspect,
    size,
    images,
    transparent: Boolean(opts.transparent),
    provider,
    quality,
    timeoutMs,
    timeoutExplicit: Boolean(opts.timeout),
    retries,
    count,
    outDir: path.resolve(opts.out || DEFAULTS.outDir),
    name: opts.name,
    model: opts.model,
    dryRun: Boolean(opts['dry-run']),
  };

  const result = await runGenerate(cfg);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  if (!result.ok) process.exit(1);
}

main().catch((e) => {
  process.stdout.write(JSON.stringify({ ok: false, error: { message: e.message } }, null, 2) + '\n');
  process.exit(1);
});
