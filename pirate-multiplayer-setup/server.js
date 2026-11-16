// Pirate Game multiplayer relay. Public players share "public"; invite-code rooms are isolated.
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000, MAX_PLAYERS_PER_ROOM = 40, MAX_TOTAL_PLAYERS = 400;
const TOPICS = new Set(['fire', 'pvp', 'bsnap', 'bdmg', 'bhit', 'kraken']);
const page = path.join(__dirname, 'public', 'index.html');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/health') { res.writeHead(200); return res.end('ok'); }
  if (pathname === '/robots.txt') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('User-agent: *\nAllow: /\nSitemap: https://' + req.headers.host + '/sitemap.xml\n');
  }
  if (pathname === '/sitemap.xml') {
    res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
    return res.end('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://' + req.headers.host + '/</loc></url></urlset>');
  }
  if (pathname !== '/') { res.writeHead(404); return res.end('Not found'); }
  fs.readFile(page, (err, data) => { if (err) { res.writeHead(500); return res.end('game file missing'); }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' }); res.end(data); });
});
const wss = new WebSocketServer({ server, maxPayload: 16 * 1024 });
const clients = new Map();
const send = (ws, o) => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
const roomMembers = room => [...clients].filter(([, c]) => c.room === room);
const others = (id, room, o) => { const s = JSON.stringify(o); for (const [k, c] of clients) if (k !== id && c.room === room && c.ws.readyState === 1) c.ws.send(s); };
wss.on('connection', ws => {
  if (clients.size >= MAX_TOTAL_PLAYERS) { send(ws, { t: 'full' }); return ws.close(); }
  const id = crypto.randomBytes(4).toString('hex');
  const me = { ws, id, room: 'public', name: 'Pirate ' + id.slice(0, 3), pres: {}, n: 0, t: Date.now(), alive: true, joined: false };
  clients.set(id, me);
  ws.on('pong', () => { me.alive = true; });
  ws.on('message', raw => {
    const now = Date.now(); if (now - me.t > 1000) { me.t = now; me.n = 0; } if (++me.n > 80) return;
    let m; try { m = JSON.parse(raw); } catch (_) { return; } if (!m || typeof m !== 'object') return;
    if (m.t === 'hello' && !me.joined) {
      const room = String(m.room || 'public').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 12) || 'PUBLIC';
      const roomKey = room === 'PUBLIC' ? 'public' : room;
      if (roomMembers(roomKey).length >= MAX_PLAYERS_PER_ROOM) { send(ws, { t: 'full' }); ws.close(); return; }
      me.room = roomKey; me.joined = true;
      me.name = String(m.name || me.name).replace(/[<>&"]/g, '').slice(0, 16) || me.name;
      send(ws, { t: 'welcome', id, room: roomKey, peers: roomMembers(roomKey).filter(([k]) => k !== id).map(([k, c]) => ({ id: k, name: c.name, p: c.pres })) });
      others(id, roomKey, { t: 'join', id, name: me.name });
    } else if (!me.joined) return;
    else if (m.t === 'pres' && m.p && typeof m.p === 'object') {
      me.pres = m.p; others(id, me.room, { t: 'pres', id, p: m.p });
    } else if (m.t === 'emit' && TOPICS.has(m.topic)) {
      others(id, me.room, { t: 'emit', from: id, topic: m.topic, data: m.data });
    }
  });
  ws.on('close', () => { clients.delete(id); if (me.joined) others(id, me.room, { t: 'left', id }); });
});
setInterval(() => { for (const c of clients.values()) { if (!c.alive) { c.ws.terminate(); continue; } c.alive = false; c.ws.ping(); } }, 30000);
server.listen(PORT, () => console.log('Pirate multiplayer server listening on ' + PORT));
