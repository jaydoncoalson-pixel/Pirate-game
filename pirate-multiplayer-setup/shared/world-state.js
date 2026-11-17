const DEFAULT_WORLD = Object.freeze({
  version: 1,
  timeOfDay: 420,
  weather: 'clear',
  enemies: [],
  kraken: {
    id: 'kraken',
    active: false,
    x: 0,
    y: 0,
    z: 0,
    hp: 0,
    maxHp: 0,
    phase: 'inactive',
  },
  players: {},
});

function cloneWorld(world = DEFAULT_WORLD) {
  return JSON.parse(JSON.stringify(world));
}

if (typeof module !== 'undefined') module.exports = { DEFAULT_WORLD, cloneWorld };
if (typeof window !== 'undefined') {
  window.DEFAULT_WORLD = DEFAULT_WORLD;
  window.cloneWorld = cloneWorld;
}
