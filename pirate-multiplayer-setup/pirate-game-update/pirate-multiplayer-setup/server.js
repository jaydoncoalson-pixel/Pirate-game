// Pirate Game server: serves the game page and is the authoritative host for the shared world.
//   npm install
//   node server.js            (PORT env var to change the port, default 8080)
// Then open http://localhost:8080 in each browser; the join box fills in the server address itself.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { createSim } = require('./sim');
const { createEnv } = require('./env');
const W = require('./world');
const { createAccounts } = require('./accounts');

const PORT = +process.env.PORT || 8080;
const MAX_PLAYERS = +process.env.MAX_PLAYERS || 16;
const TICK_MS = 50;          // simulation: 20 ticks a second
const SNAP_MS = 100;         // world snapshots to browsers: 10 a second
const PUBLIC = path.join(__dirname, 'public');
// Admin key for server-wide admin actions (time and weather). Set ADMIN_KEY in Render's Environment tab.
// If it is not set, any player using the in-game admin account can change the server's time and weather.
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const ENV_MS = 1000;        // time-and-weather updates to browsers: once a second
// Peer-to-peer topics the server still passes along unchanged (player-vs-player effects).
const RELAY_TOPICS = new Set(['fire', 'pvp', 'ebite']);
// which version of the game page this server is handing out: browsers still running an older page are told to refresh
const BUILD = (() => { try { return crypto.createHash('sha1').update(fs.readFileSync(path.join(__dirname, 'public', 'index.html'))).digest('hex').slice(0, 10); } catch (e) { return ''; } })();

// ---------- accounts: saved on the server (see accounts.js; set DATA_DIR to a persistent disk on Render) ----------
// The horn owner's name ("bob3") can only ever belong to one account. Set OWNER_PASSWORD in Render's Environment tab
// and only someone who knows it can create that account; if it isn't set, whoever creates it first owns it.
const OWNER_NAME = (process.env.HORN_OWNER || 'bob3').toLowerCase();
const accounts = createAccounts({ dir: process.env.DATA_DIR || path.join(__dirname, 'data'), reserved: { [OWNER_NAME]: process.env.OWNER_PASSWORD || null, bob3: process.env.OWNER_PASSWORD || null } });
const authTries = new Map();   // ip -> { n, t }: a brake on password guessing
function authLimited(ip) { const now = Date.now(), r = authTries.get(ip) || { n: 0, t: now }; if (now - r.t > 10 * 60000) { r.n = 0; r.t = now; } r.n++; authTries.set(ip, r); return r.n > 30; }
function readBody(req, max, cb) {
  let size = 0, chunks = [];
  req.on('data', c => { size += c.length; if (size > max) { req.destroy(); return; } chunks.push(c); });
  req.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (e) {} cb(j); });
}
function api(req, res, p) {
  const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (p === '/api/status' && req.method === 'GET') return json(200, Object.assign(accounts.status(), { ownerLocked: !!process.env.OWNER_PASSWORD }));
  if (p === '/api/me' && req.method === 'GET') { const r = accounts.me(bearer); return r ? json(200, r) : json(401, { err: 'Not logged in.' }); }
  if (req.method !== 'POST') return json(405, { err: 'POST only' });
  readBody(req, 600 * 1024, b => {
    if (!b) return json(400, { err: 'Bad request.' });
    if (p === '/api/register' || p === '/api/login') {
      if (authLimited(ip)) return json(429, { err: 'Too many tries. Wait a few minutes.' });
      const r = p === '/api/register' ? accounts.register(b.name, b.password) : accounts.login(b.name, b.password);
      if (!r.err) console.log(`${p === '/api/register' ? 'new account' : 'login'}: ${r.name}`);
      return json(r.err ? 400 : 200, r);
    }
    if (p === '/api/save') { const r = accounts.save(bearer || b.token, b.save); return json(r.err ? 400 : 200, r); }
    if (p === '/api/logout') { accounts.logout(bearer || b.token); return json(200, { ok: true }); }
    json(404, { err: 'Unknown' });
  });
}

// ---------- static files ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' };
const server = http.createServer((req, res) => {
  let p = (req.url || '/').split('?')[0];
  try { p = decodeURIComponent(p); } catch (e) { res.writeHead(400); return res.end(); }
  if (p === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }   // Render health check
  if (p.startsWith('/api/')) return api(req, res, p);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

// ---------- players ----------
const players = new Map();   // id -> { ws, name, p }
const send = (ws, msg) => { if (ws.readyState === 1) ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)); };
const broadcastRaw = (msg, except) => { const s = JSON.stringify(msg); for (const [id, q] of players) if (id !== except) send(q.ws, s); };
const serverEmit = (topic, data) => ({ t: 'emit', topic, data, from: 'server' });

const sim = createSim({
  sendTo: (id, topic, data) => { const q = players.get(id); if (q) send(q.ws, serverEmit(topic, data)); },
  broadcast: (topic, data) => broadcastRaw(serverEmit(topic, data)),
  adminOk: d => !ADMIN_KEY || (d && d.key === ADMIN_KEY),
  hornOwns: q => hornOwns(q),
});

// ---------- the Serpent Horn: the true horn (and the Elder Serpent) belongs to the bob3 account ----------
// Set HORN_OWNER in Render's Environment tab to give it to a different account. Anyone else who climbs the
// Serpent Spire gets a lesser horn that calls a common sea serpent.
const HORN = { owner: process.env.HORN_OWNER || 'bob3' };
console.log(`Serpent Horn belongs to the ${HORN.owner} account`);
const hornOwns = q => !!(HORN.owner && q && (q.acct || '').toLowerCase() === HORN.owner.toLowerCase());
const giftsPending = new Map();   // gift id -> { admin, name, amount, timer }
const hornMsg = q => serverEmit('horn', { owner: HORN.owner, mine: hornOwns(q) });
function hornClaim(me) { send(me.ws, hornMsg(me)); }   // the game asks who holds the horn
// a horn serpent's bite on another player's ship, with the serpent right beside that ship. A sinking bite only comes from
// the true horn's owner (the Elder Serpent); anyone else's common sea serpent bites for at most 22
function ebiteOk(me, d) {
  const el = me.p && me.p.el, tq = d && players.get(d.to);
  if (!Array.isArray(el) || !tq || !tq.p) return false;
  const near = (x, z) => typeof x === 'number' && Math.hypot(el[0] - x, el[1] - z) <= 700;   // generous: he moves up to ~500 m/s and presence lags a little
  if (!(d.person ? near(tq.p.x, tq.p.z) || (tq.p.sh && near(tq.p.sh.x, tq.p.sh.z)) : tq.p.sh && near(tq.p.sh.x, tq.p.sh.z))) return false;   // a captain, or their ship, right beside the serpent
  if (d.kill) return hornOwns(me);
  return (+d.dmg || 0) <= 45;
}

const env = createEnv();

const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });
wss.on('connection', ws => {
  let id = null;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello' && !id) {
      if (players.size >= MAX_PLAYERS) { send(ws, { t: 'full' }); return ws.close(); }
      id = crypto.randomBytes(6).toString('hex');
      // who they are comes from their login token, never from what the page claims: a guest has no account (no admin, no horn)
      const acct = accounts.nameFor(m.token) || '';
      const name = acct || ('Guest ' + String(m.name || 'Pirate').replace(/[<>&]/g, '').slice(0, 10));
      for (const [pid, q] of players) if (acct && q.acct === acct) { send(q.ws, serverEmit('dup', {})); try { q.ws.close(); } catch (e) {} }   // the same captain logged in somewhere else: the old session ends
      const peers = [...players].map(([pid, q]) => ({ id: pid, name: q.name, p: q.p }));
      players.set(id, { ws, name, acct, p: {} });
      send(ws, { t: 'welcome', id, peers, build: BUILD });
      const snap = sim.snapshot();   // so the newcomer sees the world right away
      for (const k of ['bsnap', 'rsnap', 'ksnap', 'ssnap', 'bwsnap', 'raid']) send(ws, serverEmit(k === 'raid' ? 'raidsnap' : k, snap[k]));
      send(ws, serverEmit('env', env.snapshot()));
      send(ws, hornMsg(players.get(id)));
      broadcastRaw({ t: 'join', id, name }, id);
      console.log(`+ ${name} (${id}) — ${players.size} online`);
      return;
    }
    if (!id) return;
    const me = players.get(id);
    if (m.t === 'pres') {
      if (!m.p || typeof m.p !== 'object') return;
      me.p = m.p;
      broadcastRaw({ t: 'pres', id, p: m.p }, id);
    } else if (m.t === 'emit' && typeof m.topic === 'string') {
      if (m.topic === 'admin_env') {                                    // admin: change time/weather for everyone
        const d = m.data || {};
        if (ADMIN_KEY && d.key !== ADMIN_KEY) { send(ws, serverEmit('admin_denied', { what: 'env' })); return; }
        if (env.admin(d)) { broadcastRaw(serverEmit('env', env.snapshot())); console.log(`admin ${me.name}: ${d.reset ? 'reset time and weather' : JSON.stringify({ time: d.time, weather: d.weather })}`); }
        return;
      }
      if (m.topic === 'hclaim') { hornClaim(me); return; }
      if (m.topic === 'gift_ack') {                                     // a player's game confirms a gift arrived
        const g = giftsPending.get(String((m.data || {}).id || '')); if (!g) return;
        clearTimeout(g.timer); giftsPending.delete(String(m.data.id));
        const a = players.get(g.admin); if (a) send(a.ws, serverEmit('gift_ack', { name: g.name, amount: g.amount }));
        return;
      }
      if (m.topic === 'gift') {                                         // admin: gift gold to a player (or everyone)
        const d = m.data || {}, amount = Math.floor(+d.amount || 0);
        const ok = ADMIN_KEY ? d.key === ADMIN_KEY : (me.acct || '').toLowerCase() === 'bob3';   // with no ADMIN_KEY set, only the bob3 account
        if (!ok) { send(ws, serverEmit('admin_denied', { what: 'gift' })); return; }
        if (!(amount > 0 && amount <= 1000000)) return;
        const to = d.to === 'all' ? [...players].filter(([pid]) => pid !== id) : players.has(d.to) ? [[d.to, players.get(d.to)]] : [];
        // each player's game confirms the gift arrived; if one doesn't (an old page that doesn't know about gifts), the admin is told
        for (const [pid, q] of to) {
          const gid = crypto.randomBytes(4).toString('hex');
          giftsPending.set(gid, { admin: id, name: q.name, amount, timer: setTimeout(() => { giftsPending.delete(gid); const a = players.get(id); if (a) send(a.ws, serverEmit('gift_lost', { name: q.name, amount })); }, 8000) });
          send(q.ws, serverEmit('gift', { amount, from: me.name, id: gid }));
        }
        send(ws, serverEmit('gift_ok', { amount, n: to.length, name: to.length === 1 ? to[0][1].name : null }));
        console.log(`admin ${me.name}: gifted ${amount} gold to ${d.to === 'all' ? 'everyone' : to.length ? to[0][1].name : 'nobody'}`);
        return;
      }
      if (m.topic === 'raidadmin') {                                    // admin: start or stop a Blackwater raid
        const d = m.data || {}, ok = ADMIN_KEY ? d.key === ADMIN_KEY : (me.acct || '').toLowerCase() === 'bob3';
        if (!ok) { send(ws, serverEmit('admin_denied', { what: 'raid' })); return; }
        sim.raidAdmin(d.cmd); console.log(`admin ${me.name}: raid ${d.cmd}`); return;
      }
      if (m.topic === 'ebite' && !ebiteOk(me, m.data)) return;
      if (m.topic === 'kadmin' && ADMIN_KEY && !(m.data && m.data.key === ADMIN_KEY)) { send(ws, serverEmit('admin_denied', { what: 'kraken' })); return; }
      if (sim.handle(id, m.topic, m.data, players)) return;           // world events: the server decides
      if (RELAY_TOPICS.has(m.topic)) broadcastRaw({ t: 'emit', topic: m.topic, data: m.data, from: id }, id);
      // anything else (e.g. a client trying to send bsnap/rsnap/bhit) is dropped
    }
  });
  ws.on('close', () => {
    if (!id) return;
    const q = players.get(id); players.delete(id); sim.removePlayer(id);
    broadcastRaw({ t: 'left', id });
    console.log(`- ${q ? q.name : id} — ${players.size} online`);
  });
  ws.on('error', () => {});
});

// drop dead connections
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; try { ws.ping(); } catch (e) {} } }, 15000);

// ---------- game loop ----------
let last = Date.now(), snapAcc = 0, envAcc = 0;
setInterval(() => {
  const now = Date.now(), dt = Math.min(0.2, (now - last) / 1000); last = now;
  sim.tick(dt, players);
  env.tick(dt);
  envAcc += dt * 1000;
  if (envAcc >= ENV_MS) { envAcc = 0; if (players.size) broadcastRaw(serverEmit('env', env.snapshot())); }
  snapAcc += dt * 1000;
  if (snapAcc >= SNAP_MS && players.size) {
    snapAcc = 0;
    const snap = sim.snapshot();
    for (const k of ['bsnap', 'rsnap', 'ksnap', 'ssnap', 'bwsnap', 'raid']) broadcastRaw(serverEmit(k === 'raid' ? 'raidsnap' : k, snap[k]));
  }
}, TICK_MS);

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { accounts.flushSync(); process.exit(0); });   // never lose the last few saves on shutdown
server.listen(PORT, () => console.log(`Pirate server on http://localhost:${PORT}${ADMIN_KEY ? '' : ' (no ADMIN_KEY set: admin time/weather is open to the admin account)'}`));
