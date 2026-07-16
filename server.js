const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const busboy = require('busboy');

const PORT = parseInt(process.env.PORT) || 3579;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'boli2026';

console.log('=== Boli Lesson Planner ===');
console.log('Port:', PORT);
console.log('API Key configured:', ANTHROPIC_KEY ? 'YES' : 'NO');

// ── Simple in-memory user store (persists as long as server runs) ──
// For production, replace with a database
const USERS = {}; // { email: { name, email, passHash, plan, usage, createdAt } }
const SESSIONS = {}; // { token: { email, expires } }

function hashPass(pass) {
  return crypto.createHash('sha256').update(pass + 'hiyaa_salt_2026').digest('hex');
}
function makeToken() {
  return crypto.randomBytes(32).toString('hex');
}
function getSession(req) {
  const auth = req.headers['authorization'] || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token || !SESSIONS[token]) return null;
  const s = SESSIONS[token];
  if (Date.now() > s.expires) { delete SESSIONS[token]; return null; }
  return USERS[s.email] || null;
}

// Seed a demo account
USERS['demo@hiyaa.mv'] = {
  name: 'Demo Teacher',
  email: 'demo@hiyaa.mv',
  passHash: hashPass('demo123'),
  plan: 'free',
  usage: 0,
  limit: 10,
  createdAt: new Date().toISOString()
};

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
      const user = USERS[emailLower];
      if (!user || user.passHash !== hashPass(password)) return jsonRes(res, 401, { error: 'Incorrect email or password' });
      const token = makeToken();
      SESSIONS[token] = { email: emailLower, expires: Date.now() + 7 * 24 * 60 * 60 * 1000 };
      return jsonRes(res, 200, { token, user: { name: user.name, email: emailLower, plan: user.plan, usage: user.usage, limit: user.limit } });
    }

    // ── GET /api/auth/me ─────────────────────────────────────────
    if (req.method === 'GET' && url === '/api/auth/me') {
      const user = getSession(req);
      if (!user) return jsonRes(res, 401, { error: 'Not logged in' });
      return jsonRes(res, 200, { user: { name: user.name, email: user.email, plan: user.plan, usage: user.usage, limit: user.limit } });
    }

    // ── POST /api/auth/logout ────────────────────────────────────
    if (req.method === 'POST' && url === '/api/auth/logout') {
      const auth = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
      if (auth) delete SESSIONS[auth];
      return jsonRes(res, 200, { ok: true });
    }

    // ── POST /api/messages — AI proxy ────────────────────────────
    if (req.method === 'POST' && url === '/api/messages') {
      // Check auth if server has key (server-key mode requires login)
      if (ANTHROPIC_KEY) {
        const user = getSession(req);
        if (!user) return jsonRes(res, 401, { error: { message: 'Please log in to generate lesson plans.' } });
        // Usage tracking is per-device (client-side localStorage)
      }
      const body = JSON.parse((await readBody(req)).toString());
      const apiKey = ANTHROPIC_KEY || req.headers['x-api-key'] || '';
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
