const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const busboy = require('busboy');

const PORT = parseInt(process.env.PORT) || 3579;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const DEFAULT_ADMIN_PASS = 'faruma-change-me';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASS;
// Shown to teachers in the Top Up panel. Set on Railway, e.g.:
// BANK_ACCOUNT = "BML MVR account 7730-XXXXXXX-101 — Hawwa Nimsha"
const BANK_ACCOUNT = process.env.BANK_ACCOUNT || 'Bank account details not configured yet — please contact the FARUMA admin.';
// Optional contact line shown with the bank details, e.g. "Viber/WhatsApp: 7XXXXXX"
const ADMIN_CONTACT = process.env.ADMIN_CONTACT || '';

// ── Supabase configuration (required) ───────────────────────────────
const SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPA_ANON = process.env.SUPABASE_ANON_KEY || '';
const SUPA_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPA_ON = !!(SUPA_URL && SUPA_ANON && SUPA_SERVICE);

// Credit packs: credits -> price in MVR
const PACKS = { 50: 90, 150: 240, 400: 560 };

/* ════════════════════════════════════════════════════════════════════
   IMAGE GENERATION — pluggable providers
   --------------------------------------------------------------------
   Switch provider with one env var; nothing else in the presentation
   pipeline changes. Each provider takes {prompt,width,height} and
   returns {dataUrl} or {error}.

     IMAGE_PROVIDER   openai | together | fal | replicate | imagen | pollinations
     IMAGE_API_KEY    the provider's key (not needed for pollinations)
     IMAGE_MODEL      optional override of the provider's default model
     IMAGE_QUALITY    low | medium | high  (OpenAI only; low is cheapest)
     IMAGE_CREDIT_COST  credits charged per image (default 0)
     IMAGE_DAILY_CAP    max images per user per day  (default 60)
   ════════════════════════════════════════════════════════════════════ */
const IMAGE_PROVIDER    = (process.env.IMAGE_PROVIDER || 'openai').toLowerCase();
// low | medium | high — 'low' on gpt-image-1-mini is the cheapest OpenAI lane
const IMAGE_QUALITY     = (process.env.IMAGE_QUALITY || 'low').toLowerCase();
const IMAGE_API_KEY     = process.env.IMAGE_API_KEY || '';
const IMAGE_MODEL_ENV   = process.env.IMAGE_MODEL || '';
const IMAGE_CREDIT_COST = parseInt(process.env.IMAGE_CREDIT_COST || '0', 10) || 0;
const IMAGE_DAILY_CAP   = parseInt(process.env.IMAGE_DAILY_CAP || '60', 10) || 60;

function postJSON(host, path, headers, payload, timeoutMs) {
  return new Promise((resolve) => {
    const data = Buffer.from(JSON.stringify(payload));
    const req = https.request({
      host, path, method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': data.length
      }, headers || {})
    }, (r) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => {
        const raw = Buffer.concat(chunks).toString();
        let json = null;
        try { json = JSON.parse(raw); } catch (e) {}
        resolve({ status: r.statusCode, json, raw });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.setTimeout(timeoutMs || 60000, () => { req.destroy(); resolve({ status: 0, error: 'timeout' }); });
    req.end(data);
  });
}

function getBinary(urlStr, timeoutMs) {
  return new Promise((resolve) => {
    const u = new URL(urlStr);
    const req = https.get({ host: u.host, path: u.pathname + u.search }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume();
        return resolve(getBinary(r.headers.location, timeoutMs));
      }
      if (r.statusCode !== 200) { r.resume(); return resolve({ error: 'download ' + r.statusCode }); }
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve({
        buf: Buffer.concat(chunks),
        mime: (r.headers['content-type'] || 'image/png').split(';')[0]
      }));
    });
    req.on('error', (e) => resolve({ error: e.message }));
    req.setTimeout(timeoutMs || 45000, () => { req.destroy(); resolve({ error: 'timeout' }); });
  });
}

const toDataUrl = (buf, mime) => 'data:' + (mime || 'image/png') + ';base64,' + buf.toString('base64');

const IMAGE_PROVIDERS = {
  /* FLUX.1 [schnell] — the budget default. ~$0.003 per 1MP image. */
  together: {
    label: 'Together AI · FLUX.1 [schnell]',
    model: 'black-forest-labs/FLUX.1-schnell',
    needsKey: true,
    async generate(o) {
      const r = await postJSON('api.together.xyz', '/v1/images/generations',
        { Authorization: 'Bearer ' + IMAGE_API_KEY },
        { model: this.model, prompt: o.prompt, width: o.width, height: o.height, steps: 4, n: 1 });
      if (r.status !== 200) return { error: (r.json && r.json.error && r.json.error.message) || r.error || ('provider ' + r.status) };
      const d = r.json && r.json.data && r.json.data[0];
      if (!d) return { error: 'empty response' };
      if (d.b64_json) return { dataUrl: 'data:image/png;base64,' + d.b64_json };
      if (d.url) { const g = await getBinary(d.url); return g.error ? { error: g.error } : { dataUrl: toDataUrl(g.buf, g.mime) }; }
      return { error: 'no image in response' };
    }
  },

  /* fal.ai — same FLUX weights, ~$0.003/MP */
  fal: {
    label: 'fal.ai · FLUX.1 [schnell]',
    model: 'fal-ai/flux/schnell',
    needsKey: true,
    async generate(o) {
      const r = await postJSON('fal.run', '/' + this.model,
        { Authorization: 'Key ' + IMAGE_API_KEY },
        { prompt: o.prompt, image_size: { width: o.width, height: o.height }, num_inference_steps: 4, num_images: 1, enable_safety_checker: true });
      if (r.status !== 200) return { error: (r.json && r.json.detail) || r.error || ('provider ' + r.status) };
      const img = r.json && r.json.images && r.json.images[0];
      if (!img || !img.url) return { error: 'no image in response' };
      const g = await getBinary(img.url);
      return g.error ? { error: g.error } : { dataUrl: toDataUrl(g.buf, g.mime) };
    }
  },

  /* Replicate — same weights, billed per second of GPU time */
  replicate: {
    label: 'Replicate · FLUX.1 [schnell]',
    model: 'black-forest-labs/flux-schnell',
    needsKey: true,
    async generate(o) {
      const r = await postJSON('api.replicate.com', '/v1/models/' + this.model + '/predictions',
        { Authorization: 'Bearer ' + IMAGE_API_KEY, Prefer: 'wait' },
        { input: { prompt: o.prompt, num_outputs: 1, output_format: 'jpg', go_fast: true,
                   aspect_ratio: (o.width >= o.height ? '4:3' : '3:4') } });
      if (r.status !== 200 && r.status !== 201) return { error: (r.json && r.json.detail) || r.error || ('provider ' + r.status) };
      const out = r.json && r.json.output;
      const first = Array.isArray(out) ? out[0] : out;
      if (!first) return { error: 'no image in response' };
      const g = await getBinary(first);
      return g.error ? { error: g.error } : { dataUrl: toDataUrl(g.buf, g.mime) };
    }
  },

  /* OpenAI — the default. gpt-image-1-mini at low quality is the cheapest
     OpenAI lane (~$0.005 per 1024x1024) and is clean enough for flat
     vector / cartoon classroom art. Bump IMAGE_QUALITY to 'medium'
     (~$0.011) if diagrams or realistic styles look too rough. */
  openai: {
    label: 'OpenAI · gpt-image-1-mini',
    model: 'gpt-image-1-mini',
    needsKey: true,
    async generate(o) {
      const size = o.width >= o.height ? '1024x1024' : '1024x1536';
      const r = await postJSON('api.openai.com', '/v1/images/generations',
        { Authorization: 'Bearer ' + IMAGE_API_KEY },
        { model: this.model, prompt: o.prompt, size, n: 1,
          quality: IMAGE_QUALITY, output_format: 'png' }, 120000);
      if (r.status !== 200) return { error: (r.json && r.json.error && r.json.error.message) || r.error || ('provider ' + r.status) };
      const d = r.json && r.json.data && r.json.data[0];
      if (d && d.b64_json) return { dataUrl: 'data:image/png;base64,' + d.b64_json };
      if (d && d.url) { const g = await getBinary(d.url); return g.error ? { error: g.error } : { dataUrl: toDataUrl(g.buf, g.mime) }; }
      return { error: 'no image in response' };
    }
  },

  /* Google Imagen — drop-in future switch */
  imagen: {
    label: 'Google · Imagen 4 Fast',
    model: 'imagen-4.0-fast-generate-001',
    needsKey: true,
    async generate(o) {
      const path = '/v1beta/models/' + this.model + ':predict?key=' + encodeURIComponent(IMAGE_API_KEY);
      const r = await postJSON('generativelanguage.googleapis.com', path, {},
        { instances: [{ prompt: o.prompt }],
          parameters: { sampleCount: 1, aspectRatio: (o.width >= o.height ? '4:3' : '3:4') } });
      if (r.status !== 200) return { error: (r.json && r.json.error && r.json.error.message) || r.error || ('provider ' + r.status) };
      const p = r.json && r.json.predictions && r.json.predictions[0];
      const b64 = p && (p.bytesBase64Encoded || p.image);
      if (!b64) return { error: 'no image in response' };
      return { dataUrl: 'data:image/png;base64,' + b64 };
    }
  },

  /* Keyless fallback so the feature still works before a key is added */
  pollinations: {
    label: 'Pollinations (keyless fallback)',
    model: 'flux',
    needsKey: false,
    async generate(o) {
      const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(o.prompt)
        + '?width=' + o.width + '&height=' + o.height + '&nologo=true&model=flux'
        + (o.seed ? '&seed=' + o.seed : '');
      const g = await getBinary(url, 40000);
      return g.error ? { error: g.error } : { dataUrl: toDataUrl(g.buf, g.mime) };
    }
  }
};

function activeImageProvider() {
  const p = IMAGE_PROVIDERS[IMAGE_PROVIDER] || IMAGE_PROVIDERS.together;
  if (p.needsKey && !IMAGE_API_KEY) return IMAGE_PROVIDERS.pollinations;   // graceful degradation
  return p;
}

/* ── image cache ─────────────────────────────────────────────────────
   Identical prompt + size + quality never hits the provider twice.
   Shared across users, so a second teacher on the same topic and style
   pays nothing. Capped so memory cannot grow without bound. */
const IMAGE_CACHE = new Map();
const IMAGE_CACHE_MAX = parseInt(process.env.IMAGE_CACHE_MAX || '300', 10) || 300;

function imageCacheKey(prompt, w, h) {
  return crypto.createHash('sha1')
    .update(IMAGE_PROVIDER + '|' + IMAGE_QUALITY + '|' + w + 'x' + h + '|' + prompt)
    .digest('hex');
}
function imageCacheGet(k) {
  if (!IMAGE_CACHE.has(k)) return null;
  const v = IMAGE_CACHE.get(k);
  IMAGE_CACHE.delete(k); IMAGE_CACHE.set(k, v);   // refresh recency
  return v;
}
function imageCacheSet(k, v) {
  IMAGE_CACHE.set(k, v);
  while (IMAGE_CACHE.size > IMAGE_CACHE_MAX) IMAGE_CACHE.delete(IMAGE_CACHE.keys().next().value);
}

/* per-user daily cap, in memory (resets on redeploy — a backstop, not billing) */
const imageUsage = new Map();
function imageQuotaOk(userId) {
  const day = new Date().toISOString().slice(0, 10);
  const k = userId + '|' + day;
  const n = (imageUsage.get(k) || 0) + 1;
  if (n > IMAGE_DAILY_CAP) return false;
  imageUsage.set(k, n);
  if (imageUsage.size > 5000) imageUsage.clear();
  return true;
}

console.log('=== FARUMA server ===');
console.log('Port:', PORT);
console.log('API Key configured:', ANTHROPIC_KEY ? 'YES' : 'NO');
console.log('Supabase:', SUPA_ON ? 'ENABLED' : 'MISSING ENV VARS — auth will not work!');
if (ADMIN_PASS === DEFAULT_ADMIN_PASS) console.log('WARNING: ADMIN_PASSWORD is still the default. Set a strong one on Railway.');
(function(){
  const p = activeImageProvider();
  console.log('Images: ' + p.label + (p.needsKey ? ' @ ' + IMAGE_QUALITY + ' quality' : '  (no IMAGE_API_KEY set — using the keyless fallback)'));
  if (IMAGE_CREDIT_COST > 0) console.log('Images: ' + IMAGE_CREDIT_COST + ' credit(s) each, cap ' + IMAGE_DAILY_CAP + '/user/day');
})();

// ── Supabase REST helper ────────────────────────────────────────────
function supaFetch(pathname, { method = 'GET', token = null, service = false, body = null, headers: extra = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const key = service ? SUPA_SERVICE : SUPA_ANON;
    const headers = Object.assign({
      'apikey': key,
      'Authorization': 'Bearer ' + (token || key),
      'Content-Type': 'application/json'
    }, extra);
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    const u = new URL(SUPA_URL + pathname);
    const req = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method, headers, timeout: 15000
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Supabase timeout')); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function supaGetUser(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token) return null;
  try {
    const r = await supaFetch('/auth/v1/user', { token });
    if (r.status !== 200 || !r.data || !r.data.id) return null;
    return {
      id: r.data.id,
      email: r.data.email,
      name: (r.data.user_metadata && r.data.user_metadata.name) || r.data.email,
      token
    };
  } catch (e) { return null; }
}

async function supaGetCredits(userId) {
  const r = await supaFetch('/rest/v1/profiles?id=eq.' + userId + '&select=credit_balance', { service: true });
  if (r.status === 200 && Array.isArray(r.data) && r.data[0]) return r.data[0].credit_balance;
  return null;
}

async function supaDeduct(userId, amount, reason) {
  const r = await supaFetch('/rest/v1/rpc/deduct_credits', {
    method: 'POST', service: true,
    body: { p_user_id: userId, p_amount: amount, p_reason: reason }
  });
  if (r.status === 200) return { ok: true, balance: r.data };
  const msg = (r.data && (r.data.message || r.data.hint || '')) + '';
  if (msg.indexOf('INSUFFICIENT_CREDITS') >= 0) return { ok: false, insufficient: true };
  console.error('deduct_credits failed:', r.status, msg);
  return { ok: false };
}

async function supaAddCredits(userId, amount, reason, txn) {
  const r = await supaFetch('/rest/v1/rpc/add_credits', {
    method: 'POST', service: true,
    body: { p_user_id: userId, p_amount: amount, p_reason: reason, p_bml_txn: txn || null }
  });
  if (r.status !== 200) {
    console.error('add_credits failed:', userId, amount, r.status, JSON.stringify(r.data));
    return null;
  }
  return r.data; // new balance
}

function userPayload(name, email, credits) {
  return { name: name, email: email, plan: 'free', usage: 0, limit: credits, credits: credits };
}

// Constant-time comparison so a wrong password cannot be narrowed down by
// timing the response.  Lengths are hashed first so they never leak either.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Per-IP throttle for the admin surface: 20 attempts per 10 minutes, then a
// lockout that grows with each further attempt.
const ADMIN_HITS = new Map();
const ADMIN_WINDOW_MS = 10 * 60 * 1000;
const ADMIN_MAX_TRIES = 20;

function clientIp(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || (req.socket && req.socket.remoteAddress) || 'unknown';
}

function adminThrottled(req) {
  const ip = clientIp(req);
  const now = Date.now();
  let rec = ADMIN_HITS.get(ip);
  if (!rec || now - rec.start > ADMIN_WINDOW_MS) { rec = { start: now, tries: 0, fails: 0 }; ADMIN_HITS.set(ip, rec); }
  rec.tries++;
  if (ADMIN_HITS.size > 5000) {
    for (const [k, v] of ADMIN_HITS) { if (now - v.start > ADMIN_WINDOW_MS) ADMIN_HITS.delete(k); }
  }
  if (rec.tries > ADMIN_MAX_TRIES) {
    const wait = Math.ceil((ADMIN_WINDOW_MS - (now - rec.start)) / 1000);
    return wait > 0 ? wait : 1;
  }
  return 0;
}

function adminOk(req) {
  const given = req.headers['x-admin-pass'] || (parseQuery(req.url).pass || '');
  const ok = safeEqual(given, ADMIN_PASS);
  if (ok) { ADMIN_HITS.delete(clientIp(req)); }
  else { const r = ADMIN_HITS.get(clientIp(req)); if (r) r.fails++; }
  return ok;
}

function isAdmin(req) { return adminOk(req); }

// Small query-string helper (the router only keeps the path).
function parseQuery(rawUrl) {
  const q = {};
  const i = String(rawUrl || '').indexOf('?');
  if (i < 0) return q;
  for (const part of rawUrl.slice(i + 1).split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const k = decodeURIComponent(eq < 0 ? part : part.slice(0, eq)).trim();
    const v = eq < 0 ? '' : decodeURIComponent(part.slice(eq + 1).replace(/\+/g, ' '));
    if (k) q[k] = v;
  }
  return q;
}

// ── Lightweight in-process counters for the admin Traffic tab ────────
const STATS = { boot: Date.now(), pageLoads: 0, apiCalls: 0, generations: 0 };
function fmtUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), mm = Math.floor((s % 3600) / 60);
  if (d) return d + 'd ' + hh + 'h';
  if (hh) return hh + 'h ' + mm + 'm';
  return mm + 'm';
}
function dayKey(d) { return new Date(d).toISOString().slice(0, 10); }
function emptySeries(days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    out.push({ day: dayKey(Date.now() - i * 86400000), count: 0 });
  }
  return out;
}
function fillSeries(rows, field, days) {
  const series = emptySeries(days);
  const idx = {};
  series.forEach((s, i) => { idx[s.day] = i; });
  (rows || []).forEach(r => {
    const k = r && r[field] ? dayKey(r[field]) : null;
    if (k != null && idx[k] != null) series[idx[k]].count++;
  });
  return series;
}

function makeRefCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  const bytes = crypto.randomBytes(5);
  for (let i = 0; i < 5; i++) s += chars[bytes[i] % chars.length];
  return 'FRM-' + s;
}

// ── Credit pricing (inferred from the request) ──────────────────────
function creditCost(body) {
  try {
    // Parallel sub-requests belonging to one job (e.g. slide batches) are billed
    // on the parent call only, so splitting work never costs the teacher more.
    if (body.faruma_sub === true && (parseInt(body.max_tokens) || 0) <= 5000) return 0;
    // The slide outline call carries the price of the whole deck.
    if (body.faruma_job === 'slides-outline') return 2;
    const model = String(body.model || '').toLowerCase();
    if (model.indexOf('haiku') >= 0) return 0;
    let attach = false;
    (body.messages || []).forEach(m => {
      if (Array.isArray(m.content)) m.content.forEach(b => {
        if (b && (b.type === 'image' || b.type === 'document')) attach = true;
      });
    });
    const heavy = (parseInt(body.max_tokens) || 0) > 5000;
    return 1 + (heavy ? 1 : 0) + (attach ? 1 : 0);
  } catch (e) { return 1; }
}

// ── MIME types ──────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.json': 'application/json',
  '.txt':  'text/plain'
};

// ── Helpers ─────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((res, rej) => {
    const c = []; req.on('data', d => c.push(d)); req.on('end', () => res(Buffer.concat(c))); req.on('error', rej);
  });
}
function jsonRes(res, status, data) {
  if (res.headersSent || res.writableEnded) return;
  const b = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b), 'Access-Control-Allow-Origin': '*' });
  res.end(b);
}
function parseUpload(req) {
  return new Promise((resolve, reject) => {
    const bb = busboy({ headers: req.headers, limits: { fileSize: 10 * 1024 * 1024 } });
    const fields = {}; let fileBuffer = null, fileName = '', fileMime = '';
    bb.on('field', (n, v) => { fields[n] = v; });
    bb.on('file', (n, file, info) => { fileName = info.filename; fileMime = info.mimeType; const c = []; file.on('data', d => c.push(d)); file.on('end', () => { fileBuffer = Buffer.concat(c); }); });
    bb.on('close', () => resolve({ fields, fileBuffer, fileName, fileMime }));
    bb.on('error', reject);
    req.pipe(bb);
  });
}
async function extractDocx(buffer) {
  const mammoth = require('mammoth');
  return (await mammoth.extractRawText({ buffer })).value;
}
async function extractPdf(buffer) {
  const pdfParse = require('pdf-parse');
  return (await pdfParse(buffer)).text;
}
function callAnthropic(body, apiKey) {
  return new Promise((resolve, reject) => {
    const key = apiKey || ANTHROPIC_KEY;
    if (!key) return reject(new Error('No API key. Set ANTHROPIC_API_KEY env variable on Railway.'));
    const payload = JSON.stringify(body);
    const options = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(payload) }
    };
    const chunks = [];
    const req = https.request(options, res => { res.on('data', c => chunks.push(c)); res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch(e) { reject(new Error('Invalid JSON from Anthropic')); } }); });
    req.on('error', reject); req.write(payload); req.end();
  });
}
// Streams Anthropic's SSE straight through to the browser so text appears as it is written.
// Resolves {ok:true, sawError} once the stream is finished, or {ok:false, error} if the
// upstream call failed before any bytes were sent (in which case nothing was written to res).
function callAnthropicStream(body, apiKey, res, extraHeaders) {
  return new Promise((resolve, reject) => {
    const key = apiKey || ANTHROPIC_KEY;
    if (!key) return reject(new Error('No API key. Set ANTHROPIC_API_KEY env variable on Railway.'));
    const payload = JSON.stringify(body);
    const options = {
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Length': Buffer.byteLength(payload) }
    };
    const up = https.request(options, r => {
      if (r.statusCode !== 200) {
        const chunks = [];
        r.on('data', c => chunks.push(c));
        r.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString()); } catch (e) {}
          resolve({ ok: false, status: r.statusCode, error: (parsed && parsed.error) || { message: 'Upstream error ' + r.statusCode } });
        });
        return;
      }
      const headers = Object.assign({
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Expose-Headers': 'X-Faruma-Credits-Spent, X-Faruma-Credits-Balance'
      }, extraHeaders || {});
      res.writeHead(200, headers);
      let sawError = false;
      r.on('data', c => {
        if (c.indexOf('"type":"error"') >= 0) sawError = true;
        res.write(c);
        if (typeof res.flush === 'function') res.flush();
      });
      r.on('end', () => { res.end(); resolve({ ok: true, streamed: true, sawError: sawError }); });
      r.on('error', () => { try { res.end(); } catch (e) {} resolve({ ok: true, streamed: true, sawError: true }); });
    });
    up.on('error', reject);
    up.write(payload); up.end();
  });
}
function serveStatic(req, res) {
  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = path.join(__dirname, urlPath);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': stat.size });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ── Router ───────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, anthropic-version, Authorization, x-admin-pass');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = req.url.split('?')[0];
  if (url.indexOf('/api/') === 0) STATS.apiCalls++;
  else if (url === '/' || url === '/index.html') STATS.pageLoads++;

  try {
    // ── GET /api/has-key ─────────────────────────────────────────
    if (req.method === 'GET' && url === '/api/has-key') {
      return jsonRes(res, 200, { hasKey: !!ANTHROPIC_KEY });
    }

    // ── POST /api/auth/register ──────────────────────────────────
    if (req.method === 'POST' && url === '/api/auth/register') {
      if (!SUPA_ON) return jsonRes(res, 500, { error: 'Server is not configured. Contact the FARUMA admin.' });
      const body = JSON.parse((await readBody(req)).toString());
      const { name, email, password } = body;
      if (!name || !email || !password) return jsonRes(res, 400, { error: 'Name, email and password required' });
      if (password.length < 6) return jsonRes(res, 400, { error: 'Password must be at least 6 characters' });
      const emailLower = email.toLowerCase().trim();

      const r = await supaFetch('/auth/v1/signup', {
        method: 'POST',
        body: { email: emailLower, password: password, data: { name: name.trim() } }
      });
      if (r.status !== 200) {
        const msg = (r.data && (r.data.msg || r.data.message || r.data.error_description)) || 'Registration failed';
        return jsonRes(res, 400, { error: msg });
      }
      if (!r.data.access_token) {
        return jsonRes(res, 400, { error: 'Account created. Please check your email to confirm, then sign in.' });
      }
      const uid = r.data.user.id;
      const credits = await supaGetCredits(uid);
      console.log('New user registered:', emailLower);
      return jsonRes(res, 200, { token: r.data.access_token, user: userPayload(name.trim(), emailLower, credits === null ? 0 : credits) });
    }

    // ── POST /api/auth/login ─────────────────────────────────────
    if (req.method === 'POST' && url === '/api/auth/login') {
      if (!SUPA_ON) return jsonRes(res, 500, { error: 'Server is not configured. Contact the FARUMA admin.' });
      const body = JSON.parse((await readBody(req)).toString());
      const emailLower = ((body.email || '') + '').toLowerCase().trim();
      const r = await supaFetch('/auth/v1/token?grant_type=password', {
        method: 'POST', body: { email: emailLower, password: body.password }
      });
      if (r.status !== 200 || !r.data.access_token) {
        return jsonRes(res, 401, { error: 'Incorrect email or password' });
      }
      const u = r.data.user;
      const nm = (u.user_metadata && u.user_metadata.name) || emailLower;
      const credits = await supaGetCredits(u.id);
      return jsonRes(res, 200, { token: r.data.access_token, user: userPayload(nm, emailLower, credits === null ? 0 : credits) });
    }

    // ── GET /api/auth/me ─────────────────────────────────────────
    if (req.method === 'GET' && url === '/api/auth/me') {
      const su = await supaGetUser(req);
      if (!su) return jsonRes(res, 401, { error: 'Not logged in' });
      const credits = await supaGetCredits(su.id);
      return jsonRes(res, 200, { user: userPayload(su.name, su.email, credits === null ? 0 : credits) });
    }

    // ── POST /api/auth/logout ────────────────────────────────────
    if (req.method === 'POST' && url === '/api/auth/logout') {
      const auth = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
      if (SUPA_ON && auth) {
        try { await supaFetch('/auth/v1/logout', { method: 'POST', token: auth }); } catch (e) {}
      }
      return jsonRes(res, 200, { ok: true });
    }

    // ── POST /api/auth/forgot ────────────────────────────────────
    if (req.method === 'POST' && url === '/api/auth/forgot') {
      if (!SUPA_ON) return jsonRes(res, 500, { error: 'Server is not configured.' });
      const body = JSON.parse((await readBody(req)).toString());
      const emailLower = ((body.email || '') + '').toLowerCase().trim();
      if (!emailLower) return jsonRes(res, 400, { error: 'Please enter your email address.' });
      try {
        await supaFetch('/auth/v1/recover', { method: 'POST', body: { email: emailLower } });
      } catch (e) { console.error('recover failed:', e.message); }
      return jsonRes(res, 200, { ok: true, message: 'If an account exists for that email, a reset link has been sent. Check your inbox (and spam folder).' });
    }

    // ── POST /api/auth/reset ─────────────────────────────────────
    if (req.method === 'POST' && url === '/api/auth/reset') {
      if (!SUPA_ON) return jsonRes(res, 500, { error: 'Server is not configured.' });
      const body = JSON.parse((await readBody(req)).toString());
      const token = (body.token || '') + '';
      const password = (body.password || '') + '';
      if (!token) return jsonRes(res, 400, { error: 'Reset link is missing or expired. Please request a new one.' });
      if (password.length < 6) return jsonRes(res, 400, { error: 'Password must be at least 6 characters' });
      const r = await supaFetch('/auth/v1/user', { method: 'PUT', token: token, body: { password: password } });
      if (r.status !== 200) {
        const msg = (r.data && (r.data.msg || r.data.message)) || 'Reset link expired. Please request a new one.';
        return jsonRes(res, 400, { error: msg });
      }
      return jsonRes(res, 200, { ok: true, message: 'Password updated. You can now sign in with your new password.' });
    }

    // ── POST /api/topup/request — teacher requests a credit pack ─
    if (req.method === 'POST' && url === '/api/topup/request') {
      if (!SUPA_ON) return jsonRes(res, 500, { error: 'Server is not configured.' });
      const su = await supaGetUser(req);
      if (!su) return jsonRes(res, 401, { error: 'Please log in first.' });
      const body = JSON.parse((await readBody(req)).toString());
      const pack = parseInt(body.pack);
      if (!PACKS[pack]) return jsonRes(res, 400, { error: 'Unknown credit pack.' });

      // Limit: max 3 open pending requests per user
      const pend = await supaFetch('/rest/v1/topup_requests?user_id=eq.' + su.id + '&status=eq.pending&select=id', { service: true });
      if (pend.status === 200 && Array.isArray(pend.data) && pend.data.length >= 3) {
        return jsonRes(res, 400, { error: 'You already have pending top-up requests. Please wait for them to be approved.' });
      }

      const ref = makeRefCode();
      const ins = await supaFetch('/rest/v1/topup_requests', {
        method: 'POST', service: true,
        headers: { 'Prefer': 'return=representation' },
        body: {
          user_id: su.id, email: su.email, name: su.name,
          pack_credits: pack, pack_price_mvr: PACKS[pack], ref_code: ref
        }
      });
      if (ins.status !== 201) {
        console.error('topup insert failed:', ins.status, JSON.stringify(ins.data));
        return jsonRes(res, 500, { error: 'Could not create top-up request. Please try again.' });
      }
      return jsonRes(res, 200, {
        ok: true, ref_code: ref, pack_credits: pack, pack_price_mvr: PACKS[pack],
        bank_account: BANK_ACCOUNT, admin_contact: ADMIN_CONTACT
      });
    }

    // ── GET /api/topup/mine — teacher's own requests ─────────────
    if (req.method === 'GET' && url === '/api/topup/mine') {
      if (!SUPA_ON) return jsonRes(res, 500, { error: 'Server is not configured.' });
      const su = await supaGetUser(req);
      if (!su) return jsonRes(res, 401, { error: 'Please log in first.' });
      const r = await supaFetch('/rest/v1/topup_requests?user_id=eq.' + su.id + '&select=ref_code,pack_credits,pack_price_mvr,status,created_at&order=created_at.desc&limit=10', { service: true });
      return jsonRes(res, 200, { requests: (r.status === 200 && Array.isArray(r.data)) ? r.data : [] });
    }

    // ── POST /api/support — teacher sends a message to admin ─────
    if (req.method === 'POST' && url === '/api/support') {
      if (!SUPA_ON) return jsonRes(res, 500, { error: 'Server is not configured.' });
      const su = await supaGetUser(req);
      if (!su) return jsonRes(res, 401, { error: 'Please log in first.' });
      const raw = await readBody(req);
      if (raw.length > 7 * 1024 * 1024) return jsonRes(res, 413, { error: 'That attachment is too large. Please keep it under 4MB.' });
      let body;
      try { body = JSON.parse(raw.toString()); }
      catch (e) { return jsonRes(res, 400, { error: 'Could not read that request.' }); }

      const msg = ((body.message || '') + '').trim().slice(0, 2000);
      const att = (body.attachment || '') + '';
      if (msg.length < 3 && !att) return jsonRes(res, 400, { error: 'Please write a message.' });

      const row = { user_id: su.id, email: su.email, name: su.name, message: msg || 'Template attached.' };

      let attName = '';
      if (att) {
        // base64 grows ~4/3, so 4MB of file is ~5.6MB of text
        if (att.length > 5.8 * 1024 * 1024) return jsonRes(res, 413, { error: 'That attachment is too large. Please keep it under 4MB.' });
        if (!/^[A-Za-z0-9+/=\s]+$/.test(att.slice(0, 4096))) return jsonRes(res, 400, { error: 'That attachment could not be read.' });
        const rawName = ((body.attachment_name || 'template') + '').replace(/[\r\n]/g, '').slice(0, 160);
        attName = path.basename(rawName) || 'template';
        const type = ((body.attachment_type || 'application/octet-stream') + '').slice(0, 120);
        const ALLOWED = /^(image\/(png|jpe?g|gif|webp|heic|heif)|application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document)$/i;
        if (!ALLOWED.test(type)) return jsonRes(res, 400, { error: 'Please attach an image, a PDF, or a Word document.' });
        row.attachment_name = attName;
        row.attachment_type = type;
        row.attachment_data = att.replace(/\s+/g, '');
      }

      let ins = await supaFetch('/rest/v1/support_messages', { method: 'POST', service: true, body: row });

      // If the attachment columns have not been added to Supabase yet, keep the
      // message rather than losing it, and tell the teacher what happened.
      if (ins.status !== 201 && row.attachment_name) {
        const why = JSON.stringify(ins.data || {});
        if (/column|schema|attachment/i.test(why)) {
          console.error('support_messages is missing the attachment columns — run the migration. Falling back to text only.');
          const fallback = {
            user_id: su.id, email: su.email, name: su.name,
            message: (msg || 'Template attached.') + '\n\n[A file named "' + attName + '" was attached but could not be stored — the support_messages attachment columns are missing. Ask the teacher to email it.]'
          };
          ins = await supaFetch('/rest/v1/support_messages', { method: 'POST', service: true, body: fallback });
          if (ins.status === 201) {
            return jsonRes(res, 200, { ok: true, message: 'Message sent, but the file could not be stored. The admin will contact you for it.' });
          }
        }
      }

      if (ins.status !== 201) {
        console.error('support insert failed:', ins.status, JSON.stringify(ins.data || {}));
        return jsonRes(res, 500, { error: 'Could not send message. Please try again.' });
      }
      return jsonRes(res, 200, {
        ok: true,
        message: attName
          ? 'Thank you — your template has been sent. We will add it as a format option.'
          : 'Message sent. The FARUMA admin will get back to you.'
      });
    }

    // ── ADMIN: GET /api/admin/overview ───────────────────────────
    if (req.method === 'GET' && url === '/api/admin/overview') {
      const wait = adminThrottled(req);
      if (wait) return jsonRes(res, 429, { error: 'Too many attempts. Try again in ' + wait + 's.' });
      if (!isAdmin(req)) return jsonRes(res, 401, { error: 'Wrong admin password.' });
      const [pending, recent, msgs] = await Promise.all([
        supaFetch('/rest/v1/topup_requests?status=eq.pending&select=id,email,name,pack_credits,pack_price_mvr,ref_code,created_at&order=created_at.asc', { service: true }),
        supaFetch('/rest/v1/topup_requests?status=neq.pending&select=id,email,pack_credits,ref_code,status,resolved_at&order=resolved_at.desc&limit=15', { service: true }),
        supaFetch('/rest/v1/support_messages?select=id,email,name,message,status,created_at,attachment_name,attachment_type&order=created_at.desc&limit=80', { service: true })
      ]);

      // Fall back to the original column list if the attachment columns are absent.
      let msgRows = (msgs.status === 200 && Array.isArray(msgs.data)) ? msgs.data : null;
      if (msgRows === null) {
        const plain = await supaFetch('/rest/v1/support_messages?select=id,email,name,message,status,created_at&order=created_at.desc&limit=80', { service: true });
        msgRows = (plain.status === 200 && Array.isArray(plain.data)) ? plain.data : [];
      }
      return jsonRes(res, 200, {
        pending: (pending.status === 200 && Array.isArray(pending.data)) ? pending.data : [],
        recent: (recent.status === 200 && Array.isArray(recent.data)) ? recent.data : [],
        messages: msgRows
      });
    }

    // ── ADMIN: GET /api/admin/attachment?id=..&pass=.. ───────────
    if (req.method === 'GET' && url === '/api/admin/attachment') {
      const wait = adminThrottled(req);
      if (wait) { res.writeHead(429, { 'Content-Type': 'text/plain' }); return res.end('Too many attempts. Try again in ' + wait + 's.'); }
      if (!isAdmin(req)) { res.writeHead(401, { 'Content-Type': 'text/plain' }); return res.end('Wrong admin password.'); }
      if (!SUPA_ON) { res.writeHead(500, { 'Content-Type': 'text/plain' }); return res.end('Server is not configured.'); }

      const id = parseInt(parseQuery(req.url).id, 10);
      if (!id) { res.writeHead(400, { 'Content-Type': 'text/plain' }); return res.end('Missing message id.'); }

      const r = await supaFetch('/rest/v1/support_messages?id=eq.' + id + '&select=attachment_name,attachment_type,attachment_data', { service: true });
      const row = (r.status === 200 && Array.isArray(r.data)) ? r.data[0] : null;
      if (!row || !row.attachment_data) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('No attachment on that message.'); }

      let buf;
      try { buf = Buffer.from(String(row.attachment_data), 'base64'); }
      catch (e) { res.writeHead(500, { 'Content-Type': 'text/plain' }); return res.end('Attachment could not be decoded.'); }

      const safeName = String(row.attachment_name || 'template').replace(/[^\w.\- ]+/g, '_');
      const isImg = /^image\//i.test(row.attachment_type || '');
      res.writeHead(200, {
        'Content-Type': row.attachment_type || 'application/octet-stream',
        'Content-Length': buf.length,
        // images render inline in the Templates tab; documents download
        'Content-Disposition': (isImg ? 'inline' : 'attachment') + '; filename="' + safeName + '"',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff'
      });
      return res.end(buf);
    }

    // ── ADMIN: GET /api/admin/traffic ────────────────────────────
    if (req.method === 'GET' && url === '/api/admin/traffic') {
      const wait = adminThrottled(req);
      if (wait) return jsonRes(res, 429, { error: 'Too many attempts. Try again in ' + wait + 's.' });
      if (!isAdmin(req)) return jsonRes(res, 401, { error: 'Wrong admin password.' });

      const server = {
        uptime: fmtUptime(Date.now() - STATS.boot),
        apiCalls: STATS.apiCalls,
        pageLoads: STATS.pageLoads,
        imageCache: IMAGE_CACHE.size
      };

      if (!SUPA_ON) return jsonRes(res, 200, { server, note: 'Supabase is not configured, so only in-process counters are available.' });

      const iso = d => new Date(Date.now() - d * 86400000).toISOString();
      const d7 = iso(7), d14 = iso(14), d30 = iso(30);

      // Everything below is derived from tables that already exist — no migration needed.
      const [profAll, prof14, ledger30, topups] = await Promise.all([
        supaFetch('/rest/v1/profiles?select=id&limit=100000', { service: true }),
        supaFetch('/rest/v1/profiles?created_at=gte.' + d14 + '&select=id,created_at&order=created_at.asc&limit=5000', { service: true }),
        supaFetch('/rest/v1/credit_ledger?created_at=gte.' + d30 + '&select=user_id,amount,reason,created_at&order=created_at.asc&limit=100000', { service: true }),
        supaFetch('/rest/v1/topup_requests?created_at=gte.' + d30 + '&select=status,pack_credits,pack_price_mvr,created_at&limit=5000', { service: true })
      ]);

      const users = {
        total:  (profAll.status === 200 && Array.isArray(profAll.data)) ? profAll.data.length : null,
        new7:   0, new30: null
      };
      const prof14Rows = (prof14.status === 200 && Array.isArray(prof14.data)) ? prof14.data : [];
      prof14Rows.forEach(r => { if (r.created_at >= d7) users.new7++; });
      const signupSeries = fillSeries(prof14Rows, 'created_at', 14);

      // Spends are negative ledger entries; each one is a generated document.
      const led = (ledger30.status === 200 && Array.isArray(ledger30.data)) ? ledger30.data : [];
      const spends = led.filter(r => Number(r.amount) < 0);
      const gen7 = spends.filter(r => r.created_at >= d7);
      const genSeries = fillSeries(spends.filter(r => r.created_at >= d14), 'created_at', 14);

      const active = {};
      gen7.forEach(r => { active[r.user_id] = true; });

      const perUser = {};
      spends.forEach(r => { perUser[r.user_id] = (perUser[r.user_id] || 0) + 1; });
      const topUsers = Object.keys(perUser)
        .map(k => ({ user_id: k, count: perUser[k] }))
        .sort((a, b) => b.count - a.count).slice(0, 8);

      // Attach emails to the busiest teachers, one lookup for all of them.
      if (topUsers.length) {
        const ids = topUsers.map(u => '"' + u.user_id + '"').join(',');
        const pr = await supaFetch('/rest/v1/profiles?id=in.(' + encodeURIComponent(ids) + ')&select=id,email', { service: true });
        const byId = {};
        if (pr.status === 200 && Array.isArray(pr.data)) pr.data.forEach(p => { byId[p.id] = p.email; });
        topUsers.forEach(u => { u.email = byId[u.user_id] || u.user_id.slice(0, 8) + '…'; delete u.user_id; });
      }

      const tp = (topups.status === 200 && Array.isArray(topups.data)) ? topups.data : [];
      const credits = {
        spent7: gen7.length ? gen7.reduce((s, r) => s + Math.abs(Number(r.amount) || 0), 0) : 0,
        spent30: spends.reduce((s, r) => s + Math.abs(Number(r.amount) || 0), 0),
        purchased30: led.filter(r => Number(r.amount) > 0).reduce((s, r) => s + Number(r.amount), 0),
        revenue30: tp.filter(r => r.status === 'approved').reduce((s, r) => s + (parseInt(r.pack_price_mvr, 10) || 0), 0),
        outstanding: null
      };

      const bal = await supaFetch('/rest/v1/profiles?select=credit_balance&limit=100000', { service: true });
      if (bal.status === 200 && Array.isArray(bal.data)) {
        credits.outstanding = bal.data.reduce((s, r) => s + (Number(r.credit_balance) || 0), 0);
      }

      return jsonRes(res, 200, {
        users: { total: users.total, new7: users.new7, active7: Object.keys(active).length },
        generations: { total7: gen7.length, total30: spends.length },
        credits, topUsers, signupSeries, genSeries, server,
        note: 'Page-level visitor numbers (sessions, sources, devices) live in Google Analytics — this tab reports what the FARUMA database itself can prove.'
      });
    }

    // ── ADMIN: POST /api/admin/topup/approve ─────────────────────
    if (req.method === 'POST' && url === '/api/admin/topup/approve') {
      const wait = adminThrottled(req);
      if (wait) return jsonRes(res, 429, { error: 'Too many attempts. Try again in ' + wait + 's.' });
      if (!isAdmin(req)) return jsonRes(res, 401, { error: 'Wrong admin password.' });
      const body = JSON.parse((await readBody(req)).toString());
      const id = parseInt(body.id);
      if (!id) return jsonRes(res, 400, { error: 'Missing request id.' });
      const g = await supaFetch('/rest/v1/topup_requests?id=eq.' + id + '&select=*', { service: true });
      const reqRow = (g.status === 200 && Array.isArray(g.data)) ? g.data[0] : null;
      if (!reqRow) return jsonRes(res, 404, { error: 'Request not found.' });
      if (reqRow.status !== 'pending') return jsonRes(res, 400, { error: 'Request already ' + reqRow.status + '.' });

      const newBal = await supaAddCredits(reqRow.user_id, reqRow.pack_credits, 'purchase', reqRow.ref_code);
      if (newBal === null) return jsonRes(res, 500, { error: 'Crediting failed — check server logs.' });

      await supaFetch('/rest/v1/topup_requests?id=eq.' + id, {
        method: 'PATCH', service: true,
        body: { status: 'approved', resolved_at: new Date().toISOString() }
      });
      console.log('Top-up approved:', reqRow.ref_code, reqRow.email, '+' + reqRow.pack_credits);
      return jsonRes(res, 200, { ok: true, new_balance: newBal });
    }

    // ── ADMIN: POST /api/admin/topup/reject ──────────────────────
    if (req.method === 'POST' && url === '/api/admin/topup/reject') {
      const wait = adminThrottled(req);
      if (wait) return jsonRes(res, 429, { error: 'Too many attempts. Try again in ' + wait + 's.' });
      if (!isAdmin(req)) return jsonRes(res, 401, { error: 'Wrong admin password.' });
      const body = JSON.parse((await readBody(req)).toString());
      const id = parseInt(body.id);
      if (!id) return jsonRes(res, 400, { error: 'Missing request id.' });
      const r = await supaFetch('/rest/v1/topup_requests?id=eq.' + id + '&status=eq.pending', {
        method: 'PATCH', service: true,
        body: { status: 'rejected', resolved_at: new Date().toISOString() }
      });
      return jsonRes(res, 200, { ok: true });
    }

    // ── ADMIN: POST /api/admin/message/read ──────────────────────
    if (req.method === 'POST' && url === '/api/admin/message/read') {
      const wait = adminThrottled(req);
      if (wait) return jsonRes(res, 429, { error: 'Too many attempts. Try again in ' + wait + 's.' });
      if (!isAdmin(req)) return jsonRes(res, 401, { error: 'Wrong admin password.' });
      const body = JSON.parse((await readBody(req)).toString());
      const id = parseInt(body.id);
      if (!id) return jsonRes(res, 400, { error: 'Missing message id.' });
      await supaFetch('/rest/v1/support_messages?id=eq.' + id, {
        method: 'PATCH', service: true, body: { status: 'read' }
      });
      return jsonRes(res, 200, { ok: true });
    }

    // ── POST /api/messages — AI proxy with credit gating ─────────
    // ── image generation for the presentation builder ────────────
    if (req.method === 'GET' && url === '/api/image/info') {
      const p = activeImageProvider();
      return jsonRes(res, 200, {
        provider: IMAGE_PROVIDER, active: p.label,
        model: IMAGE_MODEL_ENV || p.model,
        keyed: !!IMAGE_API_KEY,
        fallback: p === IMAGE_PROVIDERS.pollinations && IMAGE_PROVIDER !== 'pollinations',
        quality: IMAGE_QUALITY, cached: IMAGE_CACHE.size,
        creditCost: IMAGE_CREDIT_COST, dailyCap: IMAGE_DAILY_CAP
      });
    }

    if (req.method === 'POST' && url === '/api/image') {
      const body = JSON.parse((await readBody(req)).toString());
      const prompt = String(body.prompt || '').slice(0, 700).trim();
      if (!prompt) return jsonRes(res, 400, { error: { message: 'No image prompt supplied.' } });

      // keep resolution modest — image APIs bill per megapixel
      const width  = Math.min(1024, Math.max(256, parseInt(body.width, 10)  || 1024));
      const height = Math.min(1024, Math.max(256, parseInt(body.height, 10) || 768));

      // a cache hit costs nothing, so serve it before touching credits.
      // "Regenerate" sends noCache, because the teacher wants a different picture.
      const cacheKey = imageCacheKey(prompt, width, height);
      if (!body.noCache) {
        const hit = imageCacheGet(cacheKey);
        if (hit) return jsonRes(res, 200, { image: hit, cached: true, provider: IMAGE_PROVIDER });
      }

      let userId = 'anon';
      if (SUPA_ON) {
        const su = await supaGetUser(req);
        if (!su) return jsonRes(res, 401, { error: { message: 'Please log in to generate slide images.' } });
        userId = su.id;
        if (!imageQuotaOk(userId)) {
          return jsonRes(res, 429, { error: { message: 'Daily image limit reached (' + IMAGE_DAILY_CAP + '). Try again tomorrow.' } });
        }
        if (IMAGE_CREDIT_COST > 0) {
          const d = await supaDeduct(userId, IMAGE_CREDIT_COST, 'slide-image');
          if (!d.ok) {
            if (d.insufficient) return jsonRes(res, 402, { error: { message: 'You have run out of credits. Tap "Top Up" to buy a credit pack.' } });
            return jsonRes(res, 500, { error: { message: 'Credit check failed. Please try again.' } });
          }
        }
      }

      const p = activeImageProvider();
      if (IMAGE_MODEL_ENV) p.model = IMAGE_MODEL_ENV;
      const out = await p.generate({ prompt, width, height, seed: parseInt(body.seed, 10) || 0 });

      if (out.error) {
        // refund on provider failure so a teacher is never charged for nothing
        if (SUPA_ON && IMAGE_CREDIT_COST > 0 && userId !== 'anon') {
          try { await supaAddCredits(userId, IMAGE_CREDIT_COST, 'refund', 'slide-image-failed'); } catch (e) {}
        }
        return jsonRes(res, 502, { error: { message: 'Image provider failed: ' + out.error } });
      }
      imageCacheSet(cacheKey, out.dataUrl);
      return jsonRes(res, 200, { image: out.dataUrl, cached: false, provider: IMAGE_PROVIDER, model: p.model });
    }

    if (req.method === 'POST' && url === '/api/messages') {
      const body = JSON.parse((await readBody(req)).toString());
      const apiKey = ANTHROPIC_KEY || req.headers['x-api-key'] || '';
      const wantStream = body.faruma_stream === true;
      // internal routing flags must never be forwarded to Anthropic
      const upstream = Object.assign({}, body);
      delete upstream.faruma_sub; delete upstream.faruma_job; delete upstream.faruma_stream;
      if (wantStream) upstream.stream = true;

      // BYO-key mode (no server key): pass through, no credits involved.
      if (!ANTHROPIC_KEY) {
        if (wantStream) {
          const r = await callAnthropicStream(upstream, apiKey, res);
          if (!r.ok) return jsonRes(res, 400, { error: r.error });
          return;
        }
        const result = await callAnthropic(upstream, apiKey);
        return jsonRes(res, result.error ? 400 : 200, result);
      }

      if (!SUPA_ON) return jsonRes(res, 500, { error: { message: 'Server is not configured. Contact the FARUMA admin.' } });
      const su = await supaGetUser(req);
      if (!su) return jsonRes(res, 401, { error: { message: 'Please log in to generate lesson plans.' } });

      const cost = creditCost(body);
      if (cost > 0) {
        const d = await supaDeduct(su.id, cost, 'generation');
        if (!d.ok) {
          if (d.insufficient) {
            return jsonRes(res, 402, { error: { message: 'You have run out of credits. Tap "Top Up" in the top bar to buy a credit pack.' } });
          }
          return jsonRes(res, 500, { error: { message: 'Credit check failed. Please try again.' } });
        }
        try {
          if (wantStream) {
            const r = await callAnthropicStream(upstream, apiKey, res, {
              'X-Faruma-Credits-Spent': String(cost),
              'X-Faruma-Credits-Balance': String(d.balance)
            });
            if (!r.ok) {
              await supaAddCredits(su.id, cost, 'refund:api_error', null);
              return jsonRes(res, 400, { error: r.error });
            }
            if (r.sawError) await supaAddCredits(su.id, cost, 'refund:api_error', null);
            return;
          }
          const result = await callAnthropic(upstream, apiKey);
          if (result.error) {
            await supaAddCredits(su.id, cost, 'refund:api_error', null);
            return jsonRes(res, 400, result);
          }
          result.faruma_credits = { spent: cost, balance: d.balance };
          return jsonRes(res, 200, result);
        } catch (err) {
          await supaAddCredits(su.id, cost, 'refund:network_error', null);
          throw err;
        }
      }
      if (wantStream) {
        const r = await callAnthropicStream(upstream, apiKey, res);
        if (!r.ok) return jsonRes(res, 400, { error: r.error });
        return;
      }
      const result = await callAnthropic(upstream, apiKey);
      return jsonRes(res, result.error ? 400 : 200, result);
    }

    // ── POST /api/parse-template ─────────────────────────────────
    if (req.method === 'POST' && url === '/api/parse-template') {
      const { fileBuffer, fileName, fileMime } = await parseUpload(req);
      if (!fileBuffer) return jsonRes(res, 400, { error: 'No file uploaded' });
      const ext = path.extname(fileName).toLowerCase();
      let text = '';
      if (ext === '.docx') text = await extractDocx(fileBuffer);
      else if (ext === '.pdf') text = await extractPdf(fileBuffer);
      else return jsonRes(res, 400, { error: 'Please upload a .docx or .pdf file' });
      if (!text || text.trim().length < 20) return jsonRes(res, 400, { error: 'Could not extract text. File may be image-only.' });

      const apiKey = ANTHROPIC_KEY || req.headers['x-api-key'] || '';
      let structure = { sections: [], fields: {}, format: 'Custom template', preview: text.slice(0, 300) };
      if (apiKey) {
        try {
          const aiRes = await callAnthropic({ model: 'claude-sonnet-4-5', max_tokens: 800, messages: [{ role: 'user', content: `Analyse this lesson plan template. Return ONLY valid JSON:\n{"sections":["section1","section2"],"format":"brief style description","preview":"first 200 chars"}\n\nTemplate:\n${text.slice(0, 2000)}` }] }, apiKey);
          const raw = aiRes.content[0].text.replace(/```json|```/g, '').trim();
          structure = JSON.parse(raw);
        } catch(e) { console.error('Template analysis error:', e.message); }
      }
      return jsonRes(res, 200, { success: true, fileName, textLength: text.length, templateText: text.slice(0, 5000), structure });
    }

    // ── Static files ─────────────────────────────────────────────
    serveStatic(req, res);

  } catch(e) {
    console.error('Request error:', e.message);
    jsonRes(res, 500, { error: { message: e.message } });
  }
});

server.on('error', e => { console.error('FATAL:', e.message); process.exit(1); });
server.listen(PORT, '0.0.0.0', () => {
  console.log('FARUMA ready at http://0.0.0.0:' + PORT);
});
