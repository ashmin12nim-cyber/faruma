const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const busboy = require('busboy');

const PORT = parseInt(process.env.PORT) || 3579;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'boli2026';

// ── Supabase configuration (credit system) ──────────────────────────
// Set these on Railway > Variables. If SUPABASE_URL is missing, the app
// falls back to the old in-memory user store so nothing breaks.
const SUPA_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPA_ANON = process.env.SUPABASE_ANON_KEY || '';
const SUPA_SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SUPA_ON = !!(SUPA_URL && SUPA_ANON && SUPA_SERVICE);

console.log('=== Boli Lesson Planner ===');
console.log('Port:', PORT);
console.log('API Key configured:', ANTHROPIC_KEY ? 'YES' : 'NO');
console.log('Supabase credits:', SUPA_ON ? 'ENABLED' : 'DISABLED (in-memory fallback)');

// ── Legacy in-memory store (fallback only) ──────────────────────────
const USERS = {};
const SESSIONS = {};
function hashPass(pass) {
  return crypto.createHash('sha256').update(pass + 'hiyaa_salt_2026').digest('hex');
}
function makeToken() { return crypto.randomBytes(32).toString('hex'); }
function getLegacySession(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token || !SESSIONS[token]) return null;
  const s = SESSIONS[token];
  if (Date.now() > s.expires) { delete SESSIONS[token]; return null; }
  return USERS[s.email] || null;
}
USERS['demo@hiyaa.mv'] = {
  name: 'Demo Teacher', email: 'demo@hiyaa.mv', passHash: hashPass('demo123'),
  plan: 'free', usage: 0, limit: 10, createdAt: new Date().toISOString()
};

// ── Supabase REST helper ────────────────────────────────────────────
function supaFetch(pathname, { method = 'GET', token = null, service = false, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const key = service ? SUPA_SERVICE : SUPA_ANON;
    const headers = {
      'apikey': key,
      'Authorization': 'Bearer ' + (token || key),
      'Content-Type': 'application/json'
    };
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

// Verify a Supabase access token -> returns { id, email, name } or null
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
  // returns { ok, balance } or { ok:false, insufficient:true }
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

async function supaRefund(userId, amount, reason) {
  const r = await supaFetch('/rest/v1/rpc/add_credits', {
    method: 'POST', service: true,
    body: { p_user_id: userId, p_amount: amount, p_reason: 'refund:' + reason, p_bml_txn: null }
  });
  if (r.status !== 200) console.error('REFUND FAILED - fix manually:', userId, amount, r.status, JSON.stringify(r.data));
}

// Build the user object the front end expects
function userPayload(name, email, credits) {
  return { name: name, email: email, plan: 'free', usage: 0, limit: credits, credits: credits };
}

// ── Credit pricing (inferred from the request itself) ───────────────
// haiku helper calls: free. Attachments (+1). Heavy generations >5000
// max_tokens e.g. SOW / Thaana (+1). Base 1. Max 3.
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, anthropic-version, Authorization');
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
      const body = JSON.parse((await readBody(req)).toString());
      const { name, email, password } = body;
      if (!name || !email || !password) return jsonRes(res, 400, { error: 'Name, email and password required' });
      if (password.length < 6) return jsonRes(res, 400, { error: 'Password must be at least 6 characters' });
      const emailLower = email.toLowerCase().trim();

      if (SUPA_ON) {
        const r = await supaFetch('/auth/v1/signup', {
          method: 'POST',
          body: { email: emailLower, password: password, data: { name: name.trim() } }
        });
        if (r.status !== 200) {
          const msg = (r.data && (r.data.msg || r.data.message || r.data.error_description)) || 'Registration failed';
          return jsonRes(res, 400, { error: msg });
        }
        if (!r.data.access_token) {
          // Email confirmation is switched ON in Supabase — session not issued yet.
          return jsonRes(res, 400, { error: 'Account created. Please check your email to confirm, then sign in. (Admin: to skip this step, disable "Confirm email" in Supabase Auth settings.)' });
        }
        const uid = r.data.user.id;
        const credits = (await supaGetCredits(uid));
        console.log('New user registered (Supabase):', emailLower);
        return jsonRes(res, 200, { token: r.data.access_token, user: userPayload(name.trim(), emailLower, credits === null ? 15 : credits) });
      }

      // Legacy fallback
      if (USERS[emailLower]) return jsonRes(res, 400, { error: 'An account with this email already exists' });
      USERS[emailLower] = { name: name.trim(), email: emailLower, passHash: hashPass(password), plan: 'free', usage: 0, limit: 10, createdAt: new Date().toISOString() };
      const token = makeToken();
      SESSIONS[token] = { email: emailLower, expires: Date.now() + 7 * 24 * 60 * 60 * 1000 };
      console.log('New user registered:', emailLower);
      return jsonRes(res, 200, { token, user: { name: USERS[emailLower].name, email: emailLower, plan: 'free', usage: 0, limit: 10 } });
    }

    // ── POST /api/auth/login ─────────────────────────────────────
    if (req.method === 'POST' && url === '/api/auth/login') {
      const body = JSON.parse((await readBody(req)).toString());
      const { email, password } = body;
      const emailLower = (email || '').toLowerCase().trim();

      if (SUPA_ON) {
        if (emailLower === 'demo@hiyaa.mv') {
          return jsonRes(res, 401, { error: 'The demo account has been retired. Create a free account — you get 15 free credits.' });
        }
        const r = await supaFetch('/auth/v1/token?grant_type=password', {
          method: 'POST', body: { email: emailLower, password: password }
        });
        if (r.status !== 200 || !r.data.access_token) {
          return jsonRes(res, 401, { error: 'Incorrect email or password' });
        }
        const u = r.data.user;
        const nm = (u.user_metadata && u.user_metadata.name) || emailLower;
        const credits = await supaGetCredits(u.id);
        return jsonRes(res, 200, { token: r.data.access_token, user: userPayload(nm, emailLower, credits === null ? 0 : credits) });
      }

      // Legacy fallback
      const user = USERS[emailLower];
      if (!user || user.passHash !== hashPass(password)) return jsonRes(res, 401, { error: 'Incorrect email or password' });
      const token = makeToken();
      SESSIONS[token] = { email: emailLower, expires: Date.now() + 7 * 24 * 60 * 60 * 1000 };
      return jsonRes(res, 200, { token, user: { name: user.name, email: emailLower, plan: user.plan, usage: user.usage, limit: user.limit } });
    }

    // ── GET /api/auth/me ─────────────────────────────────────────
    if (req.method === 'GET' && url === '/api/auth/me') {
      if (SUPA_ON) {
        const su = await supaGetUser(req);
        if (!su) return jsonRes(res, 401, { error: 'Not logged in' });
        const credits = await supaGetCredits(su.id);
        return jsonRes(res, 200, { user: userPayload(su.name, su.email, credits === null ? 0 : credits) });
      }
      const user = getLegacySession(req);
      if (!user) return jsonRes(res, 401, { error: 'Not logged in' });
      return jsonRes(res, 200, { user: { name: user.name, email: user.email, plan: user.plan, usage: user.usage, limit: user.limit } });
    }

    // ── POST /api/auth/logout ────────────────────────────────────
    if (req.method === 'POST' && url === '/api/auth/logout') {
      const auth = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
      if (SUPA_ON && auth) {
        try { await supaFetch('/auth/v1/logout', { method: 'POST', token: auth }); } catch (e) {}
      }
      if (auth) delete SESSIONS[auth];
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

      if (SUPA_ON) {
        const su = await supaGetUser(req);
        if (!su) return jsonRes(res, 401, { error: { message: 'Please log in to generate lesson plans.' } });

        const cost = creditCost(body);
        if (cost > 0) {
          const d = await supaDeduct(su.id, cost, 'generation');
          if (!d.ok) {
            if (d.insufficient) {
              return jsonRes(res, 402, { error: { message: 'You have run out of credits. Please top up to keep generating. (Top-up packs coming soon — contact your FARUMA admin.)' } });
            }
            return jsonRes(res, 500, { error: { message: 'Credit check failed. Please try again.' } });
          }
          try {
            const result = await callAnthropic(body, apiKey);
            if (result.error) {
              await supaRefund(su.id, cost, 'api_error');
              return jsonRes(res, 400, result);
            }
            result.faruma_credits = { spent: cost, balance: d.balance };
            return jsonRes(res, 200, result);
          } catch (err) {
            await supaRefund(su.id, cost, 'network_error');
            throw err;
          }
        }
        // Free helper call (haiku)
        const result = await callAnthropic(body, apiKey);
        return jsonRes(res, result.error ? 400 : 200, result);
      }

      // Legacy: require login when server key is set
      const user = getLegacySession(req);
      if (!user) return jsonRes(res, 401, { error: { message: 'Please log in to generate lesson plans.' } });
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
  console.log('Boli ready at http://0.0.0.0:' + PORT);
});
