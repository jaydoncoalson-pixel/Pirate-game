const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { DEFAULT_WORLD, cloneWorld } = require('./shared/world-state');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_ROOT = path.resolve(__dirname, 'public');
const TICK_MS = 250;
const DAY_MINUTES_PER_SECOND = 1.2;

const world = cloneWorld(DEFAULT_WORLD);
const clients = new Map();
let nextPlayerId = 1;
let lastTick = Date.now();

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
};

function send(socket, message) {
  if (socket.readyState === 1) socket.send(JSON.stringify(message));
}

function broadcast(message) {
  for (const socket of clients.keys()) send(socket, message);
}

function snapshot() {
  const players = {};
  for (const client of clients.values()) {
    players[client.id] = { id: client.id, name: client.name, ...client.presence };
  }
  return { ...cloneWorld(world), players };
}

function broadcastWorld(target = null) {
  const message = { t: 'emit', topic: 'world', data: { world: snapshot() }, from: 'server' };
  if (target) send(target, message);
  else broadcast(message);
}

function weatherFor(minute) {
  if (minute < 300 || minute >= 1260) return 'night';
  if (minute < 420) return 'dawn';
  if (minute < 1020) return 'clear';
  if (minute < 1140) return 'dusk';
  return 'storm';
}

function tick() {
  const now = Date.now();
  const elapsed = Math.max(0, Math.min(5, (now - lastTick) / 1000));
  lastTick = now;
  world.timeOfDay = (Number(world.timeOfDay) + elapsed * DAY_MINUTES_PER_SECOND) % 1440;
  world.weather = weatherFor(world.timeOfDay);
  broadcastWorld();
}

function resolvePublicFile(requestPath) {
  let decoded;
  try { decoded = decodeURIComponent(requestPath); } catch (_) { return null; }
  const relative = decoded.replace(/\\/g, '/').replace(/^\/+/, '') || 'index.html';
  const file = path.resolve(PUBLIC_ROOT, relative);
  return file === PUBLIC_ROOT || file.startsWith(PUBLIC_ROOT + path.sep) ? file : null;
}

function serve(req, res) {
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; }
  catch (_) { res.writeHead(400); res.end('Bad request'); return; }

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  const requested = resolvePublicFile(pathname);
  if (!requested) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.stat(requested, (statError, stat) => {
    if (statError) { res.writeHead(404); res.end('Not found'); return; }
    const file = stat.isDirectory() ? path.join(requested, 'index.html') : requested;
    fs.readFile(file, (readError, data) => {
      if (readError) { res.writeHead(readError.code === 'ENOENT' ? 404 : 500); res.end('Unable to read game file'); return; }
      const extension = path.extname(file).toLowerCase();
      const headers = { 'Content-Type': MIME[extension] || 'application/octet-stream' };
      if (extension === '.html') {
        headers['Cache-Control'] = 'no-cache';
        let html = data.toString('utf8');
        if (!html.includes('/js/world-sync.js')) {
          html = html.replace(/<\/body\s*>/i, '<script src="/js/world-sync.js"></script>\n</body>');
        }
        res.writeHead(200, headers);
        res.end(html);
        return;
      }
      res.writeHead(200, headers);
      res.end(data);
    });
  });
}

const server = http.createServer(serve);
const wss = new WebSocketServer({ server, maxPayload: 1024 * 1024 });

wss.on('connection', (socket) => {
  socket.on('message', (raw) => {
    let message;
    try { message = JSON.parse(String(raw)); } catch (_) { return; }
    if (!message || typeof message.t !== 'string') return;

    if (message.t === 'hello') {
      if (clients.has(socket)) return;
      const id = `player-${nextPlayerId++}`;
      const name = String(message.name || 'Pirate').replace(/[<>"&]/g, '').trim().slice(0, 20) || 'Pirate';
      const peers = [...clients.values()].map(({ id: peerId, name: peerName, presence }) => ({ id: peerId, name: peerName, p: presence }));
      clients.set(socket, { id, name, presence: {} });
      send(socket, { t: 'welcome', id, name, peers, world: snapshot() });
      broadcast({ t: 'join', id, name });
      broadcastWorld();
      return;
    }

    const client = clients.get(socket);
    if (!client) return;

    if (message.t === 'pres' && message.p && typeof message.p === 'object' && !Array.isArray(message.p)) {
      client.presence = { ...client.presence, ...message.p };
      broadcast({ t: 'pres', id: client.id, p: client.presence });
      return;
    }

    if (message.t === 'emit' && typeof message.topic === 'string') {
      if (message.topic === 'world:request') {
        broadcastWorld(socket);
        return;
      }
      // Retain the game's existing event relay for gameplay and cosmetic events.
      broadcast({ t: 'emit', topic: message.topic, data: message.data || {}, from: client.id });
    }
  });

  const disconnect = () => {
    const client = clients.get(socket);
    if (!client) return;
    clients.delete(socket);
    broadcast({ t: 'left', id: client.id });
    broadcastWorld();
  };
  socket.on('close', disconnect);
  socket.on('error', disconnect);
});

server.listen(PORT, () => console.log(`Pirate Game server listening on port ${PORT}`));
const timer = setInterval(tick, TICK_MS);
if (timer.unref) timer.unref();

module.exports = { world, snapshot, tick };
