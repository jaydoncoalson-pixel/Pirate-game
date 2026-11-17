const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { DEFAULT_WORLD, cloneWorld } = require('./shared/world-state');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const WORLD_TICK_MS = 250;

const world = { ...cloneWorld(DEFAULT_WORLD), players: {} };
const clients = new Map(); // socket => { id, name, presence }
let nextId = 1;
let lastTick = Date.now();

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function renderWorld() {
  return cloneWorld({
    ...world,
    players: Object.fromEntries(
      [...clients.values()].map(({ id, name, presence }) => [id, { id, name, ...presence }])
    ),
  });
}

function send(socket, message) {
  if (socket.readyState === 1) socket.send(JSON.stringify(message));
}

function broadcast(message) {
  for (const socket of clients.keys()) send(socket, message);
}

function broadcastWorld() {
  const snapshot = renderWorld();
  // Preserve the relay protocol expected by the existing game client.
  broadcast({ t: 'emit', topic: 'world', data: { world: snapshot }, from: 'server' });
}

function weatherAt(minute) {
  if (minute < 360) return 'night';
  if (minute < 480) return 'dawn';
  if (minute < 1020) return 'clear';
  if (minute < 1140) return 'dusk';
  return 'night';
}

function tickWorld() {
  const now = Date.now();
  const elapsedSeconds = Math.max(0, Math.min(5, (now - lastTick) / 1000));
  lastTick = now;
  // One in-game day takes 20 real minutes. Every client receives the same server clock.
  world.timeOfDay = (world.timeOfDay + elapsedSeconds * 1.2) % 1440;
  world.weather = weatherAt(world.timeOfDay);
}

function contentType(filePath) {
  return mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

function serve(req, res) {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  let relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  let filePath = path.resolve(PUBLIC_DIR, relative);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  fs.readFile(filePath, (error, body) => {
    if (error) {
      res.writeHead(error.code === 'ENOENT' ? 404 : 500);
      res.end(error.code === 'ENOENT' ? 'Not found' : 'Server error');
      return;
    }

    if (path.extname(filePath).toLowerCase() === '.html') {
      const script = '<script src="/js/world-sync.js"></script>';
      const html = body.toString('utf8').replace(/<\/body\s*>/i, `${script}</body>`);
      res.writeHead(200, { 'Content-Type': contentType(filePath), 'Cache-Control': 'no-cache' });
      res.end(html);
      return;
    }

    res.writeHead(200, { 'Content-Type': contentType(filePath) });
    res.end(body);
  });
}

const server = http.createServer(serve);
const wss = new WebSocketServer({ server });

function join(socket, message) {
  if (clients.has(socket)) return;
  const id = `player-${nextId++}`;
  const name = String(message.name || 'Pirate').trim().slice(0, 20) || 'Pirate';
  const peerList = [...clients.values()].map((peer) => ({
    id: peer.id,
    name: peer.name,
    p: peer.presence,
  }));
  const client = { id, name, presence: {} };
  clients.set(socket, client);
  world.players[id] = { id, name };

  send(socket, { t: 'welcome', id, name, peers: peerList, world: renderWorld() });
  broadcast({ t: 'join', id, name });
  broadcastWorld();
}

wss.on('connection', (socket) => {
  socket.on('message', (raw) => {
    let message;
    try { message = JSON.parse(String(raw)); } catch (_) { return; }
    if (!message || typeof message.t !== 'string') return;

    if (message.t === 'hello') {
      join(socket, message);
      return;
    }

    const client = clients.get(socket);
    if (!client) return;

    if (message.t === 'pres' && message.p && typeof message.p === 'object' && !Array.isArray(message.p)) {
      client.presence = { ...client.presence, ...message.p };
      broadcast({ t: 'pres', id: client.id, p: client.presence });
      broadcastWorld();
      return;
    }

    if (message.t === 'emit' && typeof message.topic === 'string') {
      if (message.topic === 'world:request') {
        send(socket, { t: 'emit', topic: 'world', data: { world: renderWorld() }, from: 'server' });
        return;
      }
      // Clients may relay gameplay events, but only server code mutates world snapshots.
      broadcast({ t: 'emit', topic: message.topic, data: message.data || {}, from: client.id });
    }
  });

  socket.on('close', () => {
    const client = clients.get(socket);
    if (!client) return;
    clients.delete(socket);
    delete world.players[client.id];
    broadcast({ t: 'left', id: client.id });
    broadcastWorld();
  });
});

server.listen(PORT, () => {
  console.log(`Pirate Game listening on port ${PORT}`);
});

setInterval(() => {
  tickWorld();
  broadcastWorld();
}, WORLD_TICK_MS);

module.exports = { world, renderWorld, tickWorld };
