(() => {
  const formatTime = (minutes) => {
    const value = Number(minutes) || 0;
    const hour = Math.floor(value / 60) % 24;
    const minute = Math.floor(value % 60);
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  };

  const palette = {
    dawn: { bg: '#f3a261', glow: '#ffe0a8', filter: 'saturate(1.05)' },
    clear: { bg: '#8ec5e6', glow: '#dff5ff', filter: 'saturate(1.0)' },
    storm: { bg: '#2e3d4f', glow: '#ccd9ec', filter: 'saturate(0.7) brightness(0.85)' },
    dusk: { bg: '#9b5b4d', glow: '#ffd39a', filter: 'saturate(0.9)' },
    night: { bg: '#0d2238', glow: '#a3bcff', filter: 'saturate(0.75) brightness(0.8)' },
  };

  const applyWorld = (world) => {
    if (!world || typeof world !== 'object') return;
    window.__serverWorld = world;

    const weather = String(world.weather || 'clear');
    const cfg = palette[weather] || palette.clear;

    const clock = document.getElementById('clock');
    if (clock) {
      clock.textContent = `${formatTime(world.timeOfDay || 0)} • ${weather}`;
    }

    const body = document.body;
    if (body) {
      body.style.background = cfg.bg;
      body.style.filter = cfg.filter;
      body.dataset.weather = weather;
    }

    if (Array.isArray(world.enemies)) {
      for (const enemy of world.enemies) {
        if (enemy && enemy.id && typeof window.setEnemyState === 'function') {
          window.setEnemyState(enemy.id, enemy);
        }
      }
    }

    if (world.kraken && typeof window.setKrakenState === 'function') {
      window.setKrakenState(world.kraken);
    }
  };

  const attachToRoom = async () => {
    if (!window.claude || typeof window.claude.use !== 'function') return false;
    const room = await window.claude.use('room');
    if (!room || typeof room.on !== 'function') return false;
    room.on('emit', (event) => {
      if (event && event.topic === 'world' && event.data && event.data.world) {
        applyWorld(event.data.world);
      }
    });
    if (typeof room.emit === 'function') room.emit('world:request', {});
    return true;
  };

  const attachToSocket = () => {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(`${protocol}//${location.host}`);
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ t: 'hello', name: localStorage.getItem('pg_name') || 'Pirate' }));
      socket.send(JSON.stringify({ t: 'emit', topic: 'world:request', data: {} }));
    });
    socket.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (!msg || !msg.t) return;
        if (msg.t === 'emit' && msg.topic === 'world' && msg.data && msg.data.world) {
          applyWorld(msg.data.world);
        }
      } catch (error) {
        // ignore malformed packets
      }
    });
  };

  window.addEventListener('DOMContentLoaded', () => {
    attachToRoom().then((ok) => {
      if (!ok) attachToSocket();
    });
  });
})();
