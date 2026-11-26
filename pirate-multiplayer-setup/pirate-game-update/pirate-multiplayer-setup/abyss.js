// The Leviathan of the Abyssal Trench, run by the server so every captain fights the same beast.
// Its mind (public/abyss-core.js) is shared with the browser, which runs the same code for offline play.
// Here: who's in the trench, range checks and rate limits on the damage captains report.
'use strict';
const W = require('./world');
const { createLeviathanCore } = require('./public/abyss-core');

// the same spot the game picks: open deep water well clear of every island
function abyssSite() {
  for (let k = 0; k < 200; k++) {
    const a = k * 2.399, d = 7000 + (k % 7) * 500, x = Math.sin(a) * d, z = Math.cos(a) * d;
    if (Math.abs(x) > W.EDGE - 2200 || Math.abs(z) > W.EDGE - 2200) continue;
    if (!W.ISLANDS.every(I => Math.hypot(x - I.c.x, z - I.c.y) > I.r + 2600)) continue;
    let ok = true; for (let j = 0; j < 12 && ok; j++) { const b = j / 12 * 6.28; if (W.heightAt(x + Math.sin(b) * 1200, z + Math.cos(b) * 1200) > -6) ok = false; }
    if (ok) return { x, z };
  }
  return { x: -9000, z: 9000 };
}

function createAbyss({ sendTo, broadcast }) {
  const core = createLeviathanCore({ site: abyssSite(), emit: broadcast, log: s => console.log(s) });
  const L = core.state, rate = new Map();
  const ships = players => { const out = []; for (const [id, q] of players) { const s = q.p && q.p.sh; if (s && typeof s.x === 'number') out.push({ id, x: s.x, z: s.z, k: s.k }); } return out; };
  return {
    site: core.site,
    tick(dt, players) { core.tick(dt, ships(players)); },
    snapshot: () => core.snapshot(),
    handle(from, topic, d, players) {
      if (topic !== 'lvdmg') return false;
      if (!d || typeof d !== 'object' || !L.on) return true;
      const q = players.get(from); if (!q || !q.p) return true;
      const px = q.p.sh ? q.p.sh.x : q.p.x, pz = q.p.sh ? q.p.sh.z : q.p.z;
      if (Math.hypot(px - L.x, pz - L.z) > 1500) return true;   // in cannon (or mortar) range of it
      const now = Date.now(), r = rate.get(from) && now - rate.get(from).t < 1000 ? rate.get(from) : { t: now, n: 0 };
      const n = Math.max(0, Math.min(120, +d.dmg || 0, 1500 - r.n)); if (!n) return true; r.n += n; rate.set(from, r);
      core.hurt(from, n);
      return true;
    },
    removePlayer(id) { core.forget(id); rate.delete(id); },
    _state: L,
  };
}
module.exports = { createAbyss, abyssSite };
