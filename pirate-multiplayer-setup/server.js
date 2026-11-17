const http = require('http');
const { WebSocketServer } = require('ws');
const { DEFAULT_WORLD, cloneWorld } = require('./shared/world-state');

const PORT = Number(process.env.PORT || 3000);

const world = {
  ...cloneWorld(DEFAULT_WORLD),
  players: {},
};

const state = {
  nextPlayerId: 1,
  sockets: new Map(),
};

const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Pirate Game multiplayer world server');
});

const send = (socket, type, payload = {}) => {
  if (!socket || socket.readyState !== 1) return;
  socket.send(JSON.stringify({ t: type, ...payload }));
};

const broadcast = (type, payload = {}) => {
  for (const socket of state.sockets.keys()) {
    send(socket, type, payload);
  }
};

const updateWorldState = () => {
  world.timeOfDay = (world.timeOfDay + 1.2) % 1440;

  if (world.timeOfDay < 360) {
    world.weather = 'dawn';
  } else if (world.timeOfDay < 720) {
    world.weather = 'clear';
  } else if (world.timeOfDay < 1020) {
    world.weather = 'sunny';
  } else if (world.timeOfDay < 1200) {
    world.weather = 'storm';
  } else {
    world.weather = 'night';
  }

  world.enemies = world.enemies.map((enemy, index) => {
    const driftX = Math.sin((Date.now() / 700) + index) * 1.5;
    const driftZ = Math.cos((Date.now() / 900) + index) * 1.5;
    const nextHp = Math.max(0, enemy.hp + Math.sin(Date.now() / 1200 + index) * 0.8);

    return {
      ...enemy,
      x: enemy.x + driftX,
      z: enemy.z + driftZ,
      hp: Number(nextHp.toFixed(2)),
    };
  });

  world.kraken.x += Math.sin(Date.now() / 850) * 2.4;
  world.kraken.z += Math.cos(Date.now() / 750) * 1.8;
  world.kraken.phase = world.kraken.phase === 'idle' ? 'chasing' : 'idle';
};

const snapshotWorld = () => ({
  ...cloneWorld(world),
  players: Object.fromEntries(
    Object.entries(world.players).map(([id, player]) => [
      id,
      {
        id: player.id,
        name: player.name,
        x: player.x,
        y: player.y,
        z: player.z,
        health: player.health,
      },
    ])
  ),
  enemies: world.enemies.map((enemy) => ({ ...enemy })),
  kraken: { ...world.kraken },
});

const syncWorld = () => {
  broadcast('world', { world: snapshotWorld() });
};

const removePlayer = (id) => {
  if (!world.players[id]) return;
  delete world.players[id];
  broadcast('peer-left', { id });
};

const handleHello = (socket, payload) => {
  const id = `player-${state.nextPlayerId++}`;
  const name = payload && payload.name ? String(payload.name).slice(0, 20) : `Pirate ${id}`;

  world.players[id] = {
    id,
    name,
    x: 0,
    y: 0,
    z: 0,
    health: 100,
  };

  state.sockets.set(socket, id);

  send(socket, 'welcome', {
    id,
    name,
    world: snapshotWorld(),
    peers: Object.values(world.players).map((player) => ({
      id: player.id,
      name: player.name,
    })),
  });

  broadcast('peer-joined', {
    peer: { id, name },
    world: snapshotWorld(),
  });
};

const handlePresence = (socket, payload) => {
  const id = state.sockets.get(socket);
  if (!id || !world.players[id]) return;

  const player = world.players[id];
  const patch = payload || {};

  if (typeof patch.x === 'number') player.x = patch.x;
  if (typeof patch.y === 'number') player.y = patch.y;
  if (typeof patch.z === 'number') player.z = patch.z;
  if (typeof patch.health === 'number') player.health = patch.health;
  if (typeof patch.name === 'string') player.name = patch.name.slice(0, 20);

  broadcast('presence', {
    id,
    player: {
      id: player.id,
      name: player.name,
      x: player.x,
      y: player.y,
      z: player.z,
      health: player.health,
    },
  });
};

const handleEmit = (socket, payload) => {
  if (!payload || !payload.topic) return;

  const id = state.sockets.get(socket) || 'server';
  broadcast('emit', {
    topic: payload.topic,
    data: payload.data || {},
    from: id,
  });
};

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (socket) => {
  socket.on('message', (raw) => {
    try {
      const msg = JSON.parse(String(raw));
      if (!msg || !msg.t) return;

      switch (msg.t) {
        case 'hello':
          handleHello(socket, msg);
          break;
        case 'pres':
          handlePresence(socket, msg.p);
          break;
        case 'emit':
          handleEmit(socket, msg);
          break;
        default:
          break;
      }
    } catch (error) {
      // ignore malformed packets
    }
  });

  socket.on('close', () => {
    const id = state.sockets.get(socket);
    if (id) removePlayer(id);
    state.sockets.delete(socket);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Pirate Game world server listening on http://localhost:${PORT}`);
});

setInterval(() => {
  updateWorldState();
  syncWorld();
}, 250);

module.exports = {
  world,
  snapshotWorld,
  updateWorldState,
};
