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
const RELAY_TOPICS = new Set(['fire', 'pvp', 'kraken', 'krsic', 'kroff', 'krres']);   // krsic/kroff/krres: Sword of the Sea kraken sent at a player

// ---------- static files ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.json': 'application/json', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' };
const server = http.createServer((req, res) => {
  let p = (req.url || '/').split('?')[0];
  try { p = decodeURIComponent(p); } catch (e) { res.writeHead(400); return res.end(); }
  if (p === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }   // Render health check
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
});

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
      const name = String(m.name || 'Pirate').replace(/[<>&]/g, '').slice(0, 16) || 'Pirate';
      const peers = [...players].map(([pid, q]) => ({ id: pid, name: q.name, p: q.p }));
      players.set(id, { ws, name, p: {} });
      send(ws, { t: 'welcome', id, peers });
      const snap = sim.snapshot();   // so the newcomer sees the world right away
      send(ws, serverEmit('bsnap', snap.bsnap)); send(ws, serverEmit('rsnap', snap.rsnap)); send(ws, serverEmit('env', env.snapshot()));
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
    broadcastRaw(serverEmit('bsnap', snap.bsnap));
    broadcastRaw(serverEmit('rsnap', snap.rsnap));
  }
}, TICK_MS);

server.listen(PORT, () => console.log(`Pirate server on http://localhost:${PORT}${ADMIN_KEY ? '' : ' (no ADMIN_KEY set: admin time/weather is open to the admin account)'}`));
