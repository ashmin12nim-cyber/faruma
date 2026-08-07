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
const BANK_ACCOUNT = process.env.BANK_ACCOUNT || 'BML account 90401480027961000 — CARTHAGE PVT LTD';
// Optional contact line shown with the bank details, e.g. "Viber/WhatsApp: 7XXXXXX"
const ADMIN_CONTACT = process.env.ADMIN_CONTACT || 'edu.carthage@gmail.com';

// ── Supabase configuration (required) ───────────────────────────────
const SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPA_ANON = process.env.SUPABASE_ANON_KEY || '';
const SUPA_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPA_ON = !!(SUPA_URL && SUPA_ANON && SUPA_SERVICE);

// Analytics IDs injected into index.html at serve time (see serveStatic).
const GA4_MEASUREMENT_ID = process.env.GA4_MEASUREMENT_ID || '';
const GTM_CONTAINER_ID   = process.env.GTM_CONTAINER_ID   || '';

// Credit packs: credits -> price in MVR
// Priced so that every credit sold covers at least 2x its worst-case API cost.
const PACKS = { 50: 99, 150: 320, 400: 780 };

// Credits granted to a brand-new account (the free starter plan).
const SIGNUP_CREDITS = parseInt(process.env.SIGNUP_CREDITS || '6', 10) || 6;

/* ════════════════════════════════════════════════════════════════════
   CREDIT PRICING — margin-guaranteed
   --------------------------------------------------------------------
   Every generation is priced from the tokens it can actually consume,
   not from a fixed table, so a bigger job always costs proportionally
   more credits and the margin never inverts.

     credits = ceil( worst_case_usd * MARGIN / USD_PER_CREDIT_FLOOR )

   USD_PER_CREDIT_FLOOR is the revenue of the CHEAPEST credit we sell
   (the 400 pack), so the margin holds even for bulk buyers.
   MARGIN = 2.0 means every credit brings in at least twice what the
   API call behind it can cost us.

   After the response comes back we reconcile against the real token
   usage and refund the difference, so teachers are billed for what
   they actually used while the floor margin is still guaranteed.
   ════════════════════════════════════════════════════════════════════ */
const MVR_PER_USD = parseFloat(process.env.MVR_PER_USD || '15.42') || 15.42;
const CREDIT_MARGIN = parseFloat(process.env.CREDIT_MARGIN || '2.0') || 2.0;
// cheapest credit we sell, in USD  (780 MVR / 400 credits / 15.42)
const USD_PER_CREDIT_FLOOR = (PACKS[400] / 400) / MVR_PER_USD;

// USD per 1M tokens: [input, output]
const MODEL_RATES = {
  'claude-opus-5':      [5,  25],
  'claude-fable-5':     [10, 50],
  'claude-sonnet-5':    [3,  15],
  'claude-sonnet-4-6':  [3,  15],
  'claude-sonnet-4-5':  [3,  15],
  'claude-haiku-4-5':   [1,   5],
  'claude-3-5-haiku':   [1,   5]
};
const DEFAULT_RATE = [3, 15];

function rateFor(model) {
  const m = String(model || '').toLowerCase();
  for (const k in MODEL_RATES) if (m.indexOf(k) >= 0) return MODEL_RATES[k];
  if (m.indexOf('haiku') >= 0) return MODEL_RATES['claude-haiku-4-5'];
  if (m.indexOf('opus')  >= 0) return MODEL_RATES['claude-opus-5'];
  return DEFAULT_RATE;
}

// USD cost of a call given token counts
function usdCost(model, inTok, outTok) {
  const r = rateFor(model);
  return (inTok / 1e6) * r[0] + (outTok / 1e6) * r[1];
}

// credits needed to cover a USD amount at the guaranteed margin
function usdToCredits(usd) {
  return Math.max(1, Math.ceil((usd * CREDIT_MARGIN) / USD_PER_CREDIT_FLOOR));
}

// rough token estimate for a request body (~4 chars per token)
function estInputTokens(body) {
  try {
    return Math.ceil(JSON.stringify(body.messages || []).length / 4) + 250;
  } catch (e) { return 1500; }
}

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
// USD billed by the image provider per generated image, used for the admin
// spend report. Pollinations is free; OpenAI gpt-image-1-mini 'low' is ~$0.01.
// Override with IMAGE_USD_COST once you see your real provider invoice.
const IMAGE_USD_COST = parseFloat(process.env.IMAGE_USD_COST || '0.01') || 0;
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

// Constant-time comparison so the password can't be recovered by timing.
function safeEqual(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  if (A.length !== B.length) {
    // still burn a comparison so length isn't leaked by timing
    try { crypto.timingSafeEqual(A, A); } catch (e) {}
    return false;
  }
  try { return crypto.timingSafeEqual(A, B); } catch (e) { return false; }
}

// ── Simple in-memory rate limiter (per IP, sliding window) ──────────
const RATE_HITS = new Map();
function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}
function rateLimited(req, bucket, max, windowMs) {
  const key = bucket + '|' + clientIp(req);
  const now = Date.now();
  let hits = RATE_HITS.get(key) || [];
  hits = hits.filter(t => now - t < windowMs);
  if (hits.length >= max) { RATE_HITS.set(key, hits); return true; }
  hits.push(now);
  RATE_HITS.set(key, hits);
  if (RATE_HITS.size > 5000) {
    for (const [k, v] of RATE_HITS) { if (!v.length || now - v[v.length - 1] > windowMs) RATE_HITS.delete(k); }
  }
  return false;
}

function isAdmin(req) {
  return safeEqual(req.headers['x-admin-pass'] || '', ADMIN_PASS);
}

function makeRefCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  const bytes = crypto.randomBytes(5);
  for (let i = 0; i < 5; i++) s += chars[bytes[i] % chars.length];
  return 'FRM-' + s;
}

// ── Credit pricing (derived from what the call can actually cost) ───
// Returns the number of credits to RESERVE before the call runs. The real
// figure is reconciled from the response's token usage and refunded.
function creditCost(body) {
  try {
    const model  = body.model || '';
    const maxTok = parseInt(body.max_tokens) || 1000;
    const inTok  = estInputTokens(body);

    // Small helper calls (autocomplete, tidy-ups) stay free — they are
    // fractions of a cent and charging for them would feel petty.
    if (rateFor(model)[1] <= 5 && maxTok <= 1600) return 0;

    // A slide deck is billed once, on the outline call, for the WHOLE deck.
    // The parallel batch writes that follow are free (faruma_sub), so the
    // outline has to carry the cost of every slide the deck will contain.
    if (body.faruma_job === 'slides-outline') {
      const deckTok = Math.max(4000, parseInt(body.faruma_deck_tokens) || 8500);
      // batches re-send the outline context, so input is charged ~1.6x
      let usd = usdCost(model, inTok * 1.6 + deckTok * 0.35, deckTok * 1.25);
      // Slide images are paid for here too: roughly one per slide. When the
      // provider is keyless Pollinations this adds nothing.
      if (!body.faruma_no_images && IMAGE_PROVIDER !== 'pollinations' && IMAGE_API_KEY) {
        usd += Math.round(deckTok / 700) * IMAGE_USD_COST;
      }
      return usdToCredits(usd);
    }

    // Parallel sub-requests of a job already paid for by its parent.
    if (body.faruma_sub === true) return 0;

    // FARUMA's core product: a lesson plan is a FLAT 1 credit whenever even
    // its worst case stays under what one credit earns, so it is never sold
    // at a loss. Bigger jobs (school's own uploaded template, very long
    // prompts) fall back to metered pricing automatically.
    if (body.faruma_job === 'lesson-plan') {
      const worst = usdCost(model, inTok, maxTok);
      return worst <= USD_PER_CREDIT_FLOOR ? 1 : usdToCredits(worst);
    }

    return usdToCredits(usdCost(model, inTok, maxTok));
  } catch (e) { return 2; }
}

// ── Usage logging ───────────────────────────────────────────────────
// Records every billable API call so the admin console can show real
// token counts and real money spent. Never throws into the request path.
async function logApiUsage(row) {
  if (!SUPA_ON) return;
  try {
    await supaFetch('/rest/v1/api_usage', {
      method: 'POST', service: true,
      headers: { Prefer: 'return=minimal' },
      body: {
        user_id:       row.userId || null,
        email:         row.email || null,
        provider:      row.provider || 'anthropic',
        model:         row.model || '',
        job:           row.job || null,
        input_tokens:  row.inTok || 0,
        output_tokens: row.outTok || 0,
        images:        row.images || 0,
        cost_usd:      Math.round((row.usd || 0) * 1e6) / 1e6,
        credits_charged: row.credits || 0
      }
    });
  } catch (e) { console.error('api_usage log failed:', e.message); }
}

// Pull {input_tokens, output_tokens} out of a non-streaming response.
function usageOf(result) {
  const u = (result && result.usage) || {};
  return {
    inTok:  (parseInt(u.input_tokens)  || 0) + (parseInt(u.cache_read_input_tokens) || 0),
    outTok: parseInt(u.output_tokens) || 0
  };
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
      // Anthropic reports input tokens in message_start and the final output
      // count in message_delta, so we sniff both as the bytes go past.
      let inTok = 0, outTok = 0, tail = '';
      function sniff(text) {
        const buf = tail + text;
        tail = buf.slice(-400);
        let m = buf.match(/"input_tokens"\s*:\s*(\d+)/);
        if (m) inTok = Math.max(inTok, parseInt(m[1]) || 0);
        m = buf.match(/"cache_read_input_tokens"\s*:\s*(\d+)/);
        if (m) inTok += parseInt(m[1]) || 0;
        const all = buf.match(/"output_tokens"\s*:\s*(\d+)/g);
        if (all && all.length) {
          const last = all[all.length - 1].match(/(\d+)/);
          if (last) outTok = Math.max(outTok, parseInt(last[1]) || 0);
        }
      }
      r.on('data', c => {
        const text = c.toString('utf8');
        if (text.indexOf('"type":"error"') >= 0) sawError = true;
        sniff(text);
        res.write(c);
        if (typeof res.flush === 'function') res.flush();
      });
      r.on('end', () => { res.end(); resolve({ ok: true, streamed: true, sawError: sawError, inTok: inTok, outTok: outTok }); });
      r.on('error', () => { try { res.end(); } catch (e) {} resolve({ ok: true, streamed: true, sawError: true, inTok: inTok, outTok: outTok }); });
    });
    up.on('error', reject);
    up.write(payload); up.end();
  });
}
function serveStatic(req, res) {
  const cleanPath = req.url.split('?')[0];
  const urlPath = (cleanPath === '/' || cleanPath === '') ? '/index.html' : cleanPath;
  const filePath = path.join(__dirname, urlPath);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();

    // index.html carries analytics placeholders that must be filled per deploy
    if (ext === '.html') {
      fs.readFile(filePath, 'utf8', (e2, html) => {
        if (e2) { res.writeHead(500); res.end('Read error'); return; }
        if (GA4_MEASUREMENT_ID) html = html.split('__GA4_ID__').join(GA4_MEASUREMENT_ID);
        if (GTM_CONTAINER_ID)   html = html.split('__GTM_ID__').join(GTM_CONTAINER_ID);
        const buf = Buffer.from(html, 'utf8');
        res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': buf.length });
        res.end(buf);
      });
      return;
    }

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

  try {
    // ── GET /api/has-key ─────────────────────────────────────────
    if (req.method === 'GET' && url === '/api/has-key') {
      return jsonRes(res, 200, { hasKey: !!ANTHROPIC_KEY });
    }

    // ── GET /api/pricing — packs + starter grant, for the UI ─────
    if (req.method === 'GET' && url === '/api/pricing') {
      return jsonRes(res, 200, {
        packs: PACKS,
        signupCredits: SIGNUP_CREDITS,
        bankAccount: BANK_ACCOUNT,
        adminContact: ADMIN_CONTACT,
        imageUsd: (IMAGE_PROVIDER !== 'pollinations' && IMAGE_API_KEY) ? IMAGE_USD_COST : 0
      });
    }

    // ── Auth brute-force guard ───────────────────────────────────
    if (url.indexOf('/api/auth/') === 0 && req.method === 'POST') {
      if (rateLimited(req, 'auth', 20, 10 * 60 * 1000)) {
        return jsonRes(res, 429, { error: 'Too many attempts. Please wait a few minutes.' });
      }
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
      // Starter plan: make sure a new account lands on exactly SIGNUP_CREDITS.
      // The Supabase profile row may seed a different number, so top up or
      // trim the difference here — this is the single source of truth.
      let credits = await supaGetCredits(uid);
      if (credits === null) credits = 0;
      if (credits !== SIGNUP_CREDITS) {
        const diff = SIGNUP_CREDITS - credits;
        try {
          if (diff > 0) {
            const nb = await supaAddCredits(uid, diff, 'signup:starter', null);
            if (nb !== null) credits = nb;
          } else {
            const d = await supaDeduct(uid, -diff, 'signup:starter_adjust');
            if (d && d.ok) credits = d.balance;
          }
        } catch (e) { console.error('starter credit set failed:', e.message); }
      }
      console.log('New user registered:', emailLower, '- starter credits:', credits);
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
      let token = (body.token || '') + '';
      const password = (body.password || '') + '';
      if (!token) return jsonRes(res, 400, { error: 'Reset link is missing or expired. Please request a new one.' });
      if (password.length < 6) return jsonRes(res, 400, { error: 'Password must be at least 6 characters' });

      // A token_hash (PKCE/verify flow) is not yet a session — exchange it for
      // an access token first. Implicit-flow access tokens are used as-is.
      // A recovery token_hash is short and lacks the JWT dots.
      if (token.indexOf('.') < 0) {
        const v = await supaFetch('/auth/v1/verify', {
          method: 'POST',
          body: { type: 'recovery', token_hash: token }
        });
        if (v.status === 200 && v.data && v.data.access_token) {
          token = v.data.access_token;
        } else {
          const vmsg = (v.data && (v.data.msg || v.data.message)) || 'Reset link expired. Please request a new one.';
          return jsonRes(res, 400, { error: vmsg });
        }
      }

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
      const body = JSON.parse((await readBody(req)).toString());
      const msg = ((body.message || '') + '').trim().slice(0, 2000);
      if (msg.length < 3) return jsonRes(res, 400, { error: 'Please write a message.' });
      const ins = await supaFetch('/rest/v1/support_messages', {
        method: 'POST', service: true,
        body: { user_id: su.id, email: su.email, name: su.name, message: msg }
      });
      if (ins.status !== 201) return jsonRes(res, 500, { error: 'Could not send message. Please try again.' });
      return jsonRes(res, 200, { ok: true, message: 'Message sent. The FARUMA admin will get back to you.' });
    }

    // ── ADMIN: rate limit every admin route (brute-force guard) ──
    if (url.indexOf('/api/admin/') === 0) {
      if (rateLimited(req, 'admin', 30, 60 * 1000)) {
        return jsonRes(res, 429, { error: 'Too many admin requests. Wait a minute and try again.' });
      }
    }

    // ── ADMIN: GET /api/admin/usage — API spend by tokens & money ─
    if (req.method === 'GET' && url === '/api/admin/usage') {
      if (!isAdmin(req)) return jsonRes(res, 401, { error: 'Wrong admin password.' });
      const days = Math.min(365, Math.max(1, parseInt((req.url.split('days=')[1] || '').split('&')[0]) || 30));
      const since = new Date(Date.now() - days * 86400000).toISOString();
      const r = await supaFetch(
        '/rest/v1/api_usage?created_at=gte.' + since +
        '&select=provider,model,job,input_tokens,output_tokens,images,cost_usd,credits_charged,created_at&order=created_at.desc&limit=20000',
        { service: true });
      if (r.status !== 200 || !Array.isArray(r.data)) {
        return jsonRes(res, 200, {
          ok: false, days: days, rows: [], byModel: [], byProvider: [], daily: [], totals: null,
          note: 'No usage data yet. Create the api_usage table in Supabase (SQL is in the FARUMA setup notes).'
        });
      }
      const rows = r.data;
      const totals = { calls: 0, inTok: 0, outTok: 0, images: 0, usd: 0, credits: 0 };
      const byModel = {}, byProvider = {}, daily = {};
      rows.forEach(x => {
        const inT = x.input_tokens || 0, outT = x.output_tokens || 0;
        const usd = parseFloat(x.cost_usd) || 0, img = x.images || 0;
        totals.calls++; totals.inTok += inT; totals.outTok += outT;
        totals.images += img; totals.usd += usd; totals.credits += (x.credits_charged || 0);

        const mk = x.model || '(unknown)';
        if (!byModel[mk]) byModel[mk] = { model: mk, provider: x.provider || '', calls: 0, inTok: 0, outTok: 0, images: 0, usd: 0, credits: 0 };
        byModel[mk].calls++; byModel[mk].inTok += inT; byModel[mk].outTok += outT;
        byModel[mk].images += img; byModel[mk].usd += usd; byModel[mk].credits += (x.credits_charged || 0);

        const pk = x.provider || 'anthropic';
        if (!byProvider[pk]) byProvider[pk] = { provider: pk, calls: 0, inTok: 0, outTok: 0, images: 0, usd: 0, credits: 0 };
        byProvider[pk].calls++; byProvider[pk].inTok += inT; byProvider[pk].outTok += outT;
        byProvider[pk].images += img; byProvider[pk].usd += usd; byProvider[pk].credits += (x.credits_charged || 0);

        const dk = String(x.created_at || '').slice(0, 10);
        if (!daily[dk]) daily[dk] = { day: dk, calls: 0, usd: 0, credits: 0 };
        daily[dk].calls++; daily[dk].usd += usd; daily[dk].credits += (x.credits_charged || 0);
      });
      const revenueMvr = totals.credits * (PACKS[400] / 400);
      return jsonRes(res, 200, {
        ok: true, days: days,
        totals: Object.assign({}, totals, {
          mvr: totals.usd * MVR_PER_USD,
          revenueMvr: revenueMvr,
          marginMvr: revenueMvr - (totals.usd * MVR_PER_USD)
        }),
        mvrPerUsd: MVR_PER_USD,
        byModel:    Object.keys(byModel).map(k => byModel[k]).sort((a, b) => b.usd - a.usd),
        byProvider: Object.keys(byProvider).map(k => byProvider[k]).sort((a, b) => b.usd - a.usd),
        daily:      Object.keys(daily).map(k => daily[k]).sort((a, b) => a.day < b.day ? 1 : -1).slice(0, 60)
      });
    }

    // ── ADMIN: GET /api/admin/overview ───────────────────────────
    if (req.method === 'GET' && url === '/api/admin/overview') {
      if (!isAdmin(req)) return jsonRes(res, 401, { error: 'Wrong admin password.' });
      const [pending, recent, msgs] = await Promise.all([
        supaFetch('/rest/v1/topup_requests?status=eq.pending&select=id,email,name,pack_credits,pack_price_mvr,ref_code,created_at&order=created_at.asc', { service: true }),
        supaFetch('/rest/v1/topup_requests?status=neq.pending&select=id,email,pack_credits,ref_code,status,resolved_at&order=resolved_at.desc&limit=15', { service: true }),
        supaFetch('/rest/v1/support_messages?select=id,email,name,message,status,created_at&order=created_at.desc&limit=50', { service: true })
      ]);
      return jsonRes(res, 200, {
        pending: (pending.status === 200 && Array.isArray(pending.data)) ? pending.data : [],
        recent: (recent.status === 200 && Array.isArray(recent.data)) ? recent.data : [],
        messages: (msgs.status === 200 && Array.isArray(msgs.data)) ? msgs.data : []
      });
    }

    // ── ADMIN: POST /api/admin/topup/approve ─────────────────────
    if (req.method === 'POST' && url === '/api/admin/topup/approve') {
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
      logApiUsage({
        userId: userId === 'anon' ? null : userId,
        provider: IMAGE_PROVIDER, model: p.model, job: 'slide-image',
        inTok: 0, outTok: 0, images: 1,
        usd: (IMAGE_PROVIDER === 'pollinations' ? 0 : IMAGE_USD_COST),
        credits: IMAGE_CREDIT_COST
      });
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
        // Reconcile the reserved credits against what the call really used,
        // log the spend, and hand back anything the teacher over-paid.
        const settle = async (inTok, outTok) => {
          const usd = usdCost(body.model, inTok, outTok);
          let actual = cost;
          if (body.faruma_job !== 'slides-outline') {
            actual = Math.min(cost, usdToCredits(usd));
            const back = cost - actual;
            if (back > 0) {
              try { await supaAddCredits(su.id, back, 'adjust:actual_usage', null); } catch (e) {}
            }
          }
          logApiUsage({
            userId: su.id, email: su.email, provider: 'anthropic',
            model: body.model, job: body.faruma_job || null,
            inTok: inTok, outTok: outTok, usd: usd, credits: actual
          });
          return actual;
        };

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
            if (r.sawError) { await supaAddCredits(su.id, cost, 'refund:api_error', null); return; }
            await settle(r.inTok || estInputTokens(body), r.outTok || 0);
            return;
          }
          const result = await callAnthropic(upstream, apiKey);
          if (result.error) {
            await supaAddCredits(su.id, cost, 'refund:api_error', null);
            return jsonRes(res, 400, result);
          }
          const u = usageOf(result);
          const actual = await settle(u.inTok || estInputTokens(body), u.outTok);
          result.faruma_credits = { spent: actual, balance: d.balance + (cost - actual) };
          return jsonRes(res, 200, result);
        } catch (err) {
          await supaAddCredits(su.id, cost, 'refund:network_error', null);
          throw err;
        }
      }
      if (wantStream) {
        const r = await callAnthropicStream(upstream, apiKey, res);
        if (!r.ok) return jsonRes(res, 400, { error: r.error });
        logApiUsage({
          userId: su.id, email: su.email, provider: 'anthropic', model: body.model,
          job: body.faruma_job || (body.faruma_sub ? 'sub' : null),
          inTok: r.inTok || 0, outTok: r.outTok || 0,
          usd: usdCost(body.model, r.inTok || 0, r.outTok || 0), credits: 0
        });
        return;
      }
      const result = await callAnthropic(upstream, apiKey);
      if (!result.error) {
        const u0 = usageOf(result);
        logApiUsage({
          userId: su.id, email: su.email, provider: 'anthropic', model: body.model,
          job: body.faruma_job || (body.faruma_sub ? 'sub' : null),
          inTok: u0.inTok, outTok: u0.outTok,
          usd: usdCost(body.model, u0.inTok, u0.outTok), credits: 0
        });
      }
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
