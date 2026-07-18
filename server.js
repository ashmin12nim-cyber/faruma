const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const busboy = require('busboy');

const PORT = parseInt(process.env.PORT) || 3579;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'boli2026';
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

console.log('=== FARUMA server ===');
console.log('Port:', PORT);
console.log('API Key configured:', ANTHROPIC_KEY ? 'YES' : 'NO');
console.log('Supabase:', SUPA_ON ? 'ENABLED' : 'MISSING ENV VARS — auth will not work!');
if (ADMIN_PASS === 'boli2026') console.log('WARNING: ADMIN_PASSWORD is still the default. Set a strong one on Railway.');

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

function isAdmin(req) {
  return (req.headers['x-admin-pass'] || '') === ADMIN_PASS;
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
    if (req.method === 'POST' && url === '/api/messages') {
      const body = JSON.parse((await readBody(req)).toString());
      const apiKey = ANTHROPIC_KEY || req.headers['x-api-key'] || '';

      // BYO-key mode (no server key): pass through, no credits involved.
      if (!ANTHROPIC_KEY) {
        const result = await callAnthropic(body, apiKey);
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
          const result = await callAnthropic(body, apiKey);
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
      const result = await callAnthropic(body, apiKey);
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
