// Family AI Game Day — Node.js server (no dependencies, Node 18+)
// Run: node server.js   then open http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data');
const MATCHES = path.join(DATA, 'matches.json');
// Secret key of the AI judge — reports signed with it cannot be changed without detection
const SECRET = process.env.JUDGE_SECRET || 'family-ai-judge-2026-secret';

if (!fs.existsSync(DATA)) fs.mkdirSync(DATA);

// ---- download the AI models once, so the AI judge also works offline ----
const https = require('https');
const MODELS = path.join(PUBLIC, 'models');
const MODEL_URLS = {
  'efficientdet_lite0.tflite': 'https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite',
  'pose_landmarker_lite.task': 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
};
function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, r => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); return download(r.headers.location, dest).then(resolve, reject); }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error('HTTP ' + r.statusCode)); }
      const tmp = dest + '.part'; const f = fs.createWriteStream(tmp); r.pipe(f);
      f.on('finish', () => f.close(() => { fs.renameSync(tmp, dest); resolve(); }));
    }).on('error', reject);
  });
}
(async () => {
  if (!fs.existsSync(MODELS)) fs.mkdirSync(MODELS, { recursive: true });
  for (const [name, url] of Object.entries(MODEL_URLS)) {
    const dest = path.join(MODELS, name);
    if (fs.existsSync(dest)) continue;
    try { console.log('  ⬇ downloading AI model ' + name + ' …'); await download(url, dest); console.log('  ✓ ' + name + ' saved (AI now works offline)'); }
    catch (e) { console.log('  ⚠ could not download ' + name + ' (' + e.message + ') — the app will load it from the internet'); }
  }
})();
if (!fs.existsSync(MATCHES)) fs.writeFileSync(MATCHES, '[]');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm', '.tflite': 'application/octet-stream', '.task': 'application/octet-stream', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

// stable JSON (sorted keys) so the hash is the same on every machine
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
const sign = payload => crypto.createHmac('sha256', SECRET).update(stable(payload)).digest('hex');

let liveState = { status: 'waiting' };
const sseClients = new Set();
function broadcast() {
  const msg = 'data: ' + JSON.stringify(liveState) + '\n\n';
  for (const res of sseClients) res.write(msg);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 5e6) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(e); } });
  });
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const loadMatches = () => { try { return JSON.parse(fs.readFileSync(MATCHES, 'utf8')); } catch { return []; } };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    // ---- API ----
    if (url.pathname === '/api/sign' && req.method === 'POST') {
      const { payload } = await readBody(req);
      const id = crypto.randomUUID();
      const report = { id, judge: 'Family-AI-Judge v1', signedAt: new Date().toISOString(), payload };
      return json(res, 200, { ...report, hash: sign(report) });
    }
    if (url.pathname === '/api/verify' && req.method === 'POST') {
      const { hash, ...report } = await readBody(req);
      const expected = sign(report);
      const ok = typeof hash === 'string' && hash.length === expected.length && crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(expected));
      return json(res, 200, { ok });
    }
    if (url.pathname === '/api/state' && req.method === 'POST') {
      liveState = await readBody(req); broadcast(); return json(res, 200, { ok: true });
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('data: ' + JSON.stringify(liveState) + '\n\n');
      sseClients.add(res); req.on('close', () => sseClients.delete(res)); return;
    }
    if (url.pathname === '/api/matches' && req.method === 'POST') {
      const m = await readBody(req); const all = loadMatches();
      all.push({ ...m, savedAt: new Date().toISOString() }); fs.writeFileSync(MATCHES, JSON.stringify(all, null, 2));
      return json(res, 200, { ok: true, count: all.length });
    }
    if (url.pathname === '/api/matches') return json(res, 200, loadMatches().slice(-30).reverse());
    if (url.pathname === '/api/leaderboard') {
      const board = {};
      for (const m of loadMatches()) {
        for (const w of m.winnerPlayers || []) { board[w] = board[w] || { name: w, wins: 0, mvp: 0, points: 0 }; board[w].wins++; }
        if (m.mvpName) { board[m.mvpName] = board[m.mvpName] || { name: m.mvpName, wins: 0, mvp: 0, points: 0 }; board[m.mvpName].mvp++; }
        for (const [p, v] of Object.entries(m.playerPts || {})) { board[p] = board[p] || { name: p, wins: 0, mvp: 0, points: 0 }; board[p].points += +v || 0; }
      }
      return json(res, 200, Object.values(board).sort((a, b) => b.wins - a.wins || b.mvp - a.mvp || b.points - a.points));
    }
    // ---- static files ----
    let p = url.pathname === '/' ? '/index.html' : url.pathname;
    if (p === '/scoreboard') p = '/scoreboard.html';
    const file = path.normalize(path.join(PUBLIC, decodeURIComponent(p)));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (e) { json(res, 400, { error: e.message }); }
});

server.listen(PORT, () => {
  const nets = require('os').networkInterfaces(); const ips = [];
  for (const n of Object.values(nets)) for (const a of n) if (a.family === 'IPv4' && !a.internal) ips.push(a.address);
  console.log('\n  🎮 Family AI Game Day is running');
  console.log('  App:        http://localhost:' + PORT);
  console.log('  Scoreboard: http://localhost:' + PORT + '/scoreboard   (open on a TV / second screen)');
  ips.forEach(ip => console.log('  On phone (same Wi-Fi): http://' + ip + ':' + PORT + '/scoreboard'));
  console.log('');
});
