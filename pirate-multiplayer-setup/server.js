const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { DEFAULT_WORLD, cloneWorld } = require('./shared/world-state');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.resolve(__dirname, 'public');
const WORLD_TICK_MS = 250;

const world = { ...cloneWorld(DEFAULT_WORLD), players: {} };
const clients = new Map();
let nextPlayerId = 1;
let lastWorldTick = Date.now();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
};

function send(socket, message) {
  if (socket.readyState === 1) socket.send(JSON.stringify(message));
}

function broadcast(message) {
  for (const socket of clients.keys()) send(socket, message);
}

function getWorldSnapshot() {
  const players = {};
  for (const client of clients.values()) {
    players[client.id] = { id: client.id, name: client.name, ...client.presence };
  }
  return { ...cloneWorld(world), players };
}

function broadcastWorld() {
  // Use the existing game's relay event envelope so its room.on('world', ...) handlers work.
  broadcast({ t: 'emit', topic: 'world', data: { world: getWorldSnapshot() }, from: 'server' });
}

function updateWorld() {
  const now = Date.now();
  const elapsedSeconds = Math.max(0, Math.min(5, (now - lastWorldTick) / 1000));
  lastWorldTick = now;
  // A full in-game day takes 20 real minutes.
  world.timeOfDay = (world.timeOfDay + elapsedSeconds * 1.2) % 1440;
  const minute = world.timeOfDay;
  world.weather = minute < 360 || minute >= 1200 ? 'night'
    : minute < 480 ? 'dawn'
      : minute < 1080 ? 'clear' : 'dusk';
}

function safeResolvePublicPath(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath); } catch (_) { return null; }
  const normalized = decoded.replace(/\\/g, '/').replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, normalized || 'index.html');
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) return null;
  return filePath;
}

function serveStatic(req, res) {
  let pathname;
  try { pathname = new URL(req.url, 'http://localhost').pathname; }
  catch (_) { res.writeHead(400); res.end('Bad request'); return; }

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  const filePath = safeResolvePublicPath(pathname);
  if (!filePath) { res.writeHead(403); res.end('Forbidden'); return; }

  fs.stat(filePath, (statError, stat) => {
    if (statError) { res.writeHead(404); res.end('Not found'); return; }
    const resolved = stat.isDirectory() ? path.join(filePath, 'index.html') : filePath;

    fs.readFile(resolved, (readError, contents) => {
      if (readError) { res.writeHead(readError.code === 'ENOENT' ? 404 : 500); res.end(readError.code === 'ENOENT' ? 'Not found' : 'Server error'); return; }

      const type = MIME_TYPES[path.extname(resolved).toLowerCase()] || 'application/octet-stream';
      res.writeHead(200, {
        'Content-Type': type,
        'Cache-Control': path.extname(resolved).toLowerCase() === '.html' ? 'no-cache' : 'public, max-age=3600',
      });
      res.end(contents);
    });
  });
}

function removeClient(socket) {
  const client = clients.get(socket);
  if (!client) return;
  clients.delete(socket);
  delete world.players[client.id];
  broadcast({ t: 'left', id: client.id });
  broadcastWorld();
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server });

wss.on('connection', (socket) => {
  socket.on('message', (raw) => {
    let message;
    try { message = JSON.parse(String(raw)); } catch (_) { return; }
    if (!message || typeof message.t !== 'string') return;

    if (message.t === 'hello') {
      if (clients.has(socket)) return;
      const id = `player-${nextPlayerId++}`;
      const name = String(message.name || 'Pirate').trim().slice(0, 20) || 'Pirate';
      const peers = [...clients.values()].map(({ id: peerId, name: peerName, presence }) => ({ id: peerId, name: peerName, p: presence }));
      clients.set(socket, { id, name, presence: {} });
      world.players[id] = { id, name };
      send(socket, { t: 'welcome', id, name, peers, world: getWorldSnapshot() });
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
        send(socket, { t: 'emit', topic: 'world', data: { world: getWorldSnapshot() }, from: 'server' });
        return;
      }
      // Preserve the existing game's relay behavior for chat/actions/customization events.
      broadcast({ t: 'emit', topic: message.topic, data: message.data || {}, from: client.id });
    }
  });

  socket.on('close', () => removeClient(socket));
  socket.on('error', () => removeClient(socket));
});

server.listen(PORT, () => {
  console.log(`Pirate Game listening on port ${PORT}`);
});

setInterval(() => {
  updateWorld();
  broadcastWorld();
}, WORLD_TICK_MS);

module.exports = { world, getWorldSnapshot, updateWorld };
