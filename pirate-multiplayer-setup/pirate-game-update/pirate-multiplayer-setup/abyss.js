// The Leviathan of the Abyssal Trench, run by the server so every captain fights the same beast.
// The server moves its head, picks who it hunts, times its attacks and keeps its health; each browser draws the
// body along the path the head swims, resolves the attacks that land on its own ship and reports the damage it deals.
'use strict';
const W = require('./world');

const R = 1500, HEART = 600, COOL_MS = 20 * 60 * 1000, BASE_HP = 6500, PER_EXTRA = 3000;
const angDiff = (a, b) => ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
const r1 = v => Math.round(v * 10) / 10;
const RING = { sloop: 30, brig: 40, galleon: 50, titan: 95 };

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
  const A = abyssSite();
  const L = { on: false, x: 0, y: -40, z: 0, h: 0, hp: 0, max: BASE_HP, ph: 1, t: 0, ang: 0, tgt: null, tgtT: 0, timers: {}, rearT: 0, dying: 0, emptyT: 0, cool: 0, dmg: new Map(), rate: new Map() };
  const vel = new Map();   // player -> { x, z, vx, vz } (to lead the tail slam)
  const ships = players => { const out = []; for (const [id, q] of players) { const s = q.p && q.p.sh; if (s && typeof s.x === 'number') out.push({ id, x: s.x, z: s.z, k: s.k }); } return out; };

  function wake(list) {
    const near = list.filter(s => Math.hypot(s.x - A.x, s.z - A.z) < R);
    Object.assign(L, { on: true, hp: 0, ph: 1, t: 0, dying: 0, emptyT: 0, rearT: 0, timers: { slam: 6, spit: 9, ram: 16 }, dmg: new Map() });
    L.max = BASE_HP + PER_EXTRA * Math.max(0, near.length - 1); L.hp = L.max;   // a tougher beast for a bigger fleet
    const t = list.find(s => Math.hypot(s.x - A.x, s.z - A.z) < HEART); L.tgt = t.id; L.tgtT = 25;
    L.ang = Math.atan2(t.x - A.x, t.z - A.z) + Math.PI; L.x = t.x + Math.sin(L.ang) * 260; L.z = t.z + Math.cos(L.ang) * 260; L.y = -40; L.h = 0;
    broadcast('lvwake', { max: L.max });
    console.log(`*** the Leviathan rises (${near.length} captain${near.length === 1 ? '' : 's'})`);
  }
  function sleep(killed) {
    L.on = false;
    if (killed) {
      L.cool = Date.now() + COOL_MS;
      const by = [...L.dmg].filter(([, d]) => d >= L.max * 0.03).map(([id]) => id);
      broadcast('lvdead', { by }); console.log(`*** the Leviathan is slain (${by.length} captain${by.length === 1 ? '' : 's'})`);
    } else broadcast('lvsleep', {});
  }

  function tick(dt, players) {
    const list = ships(players);
    for (const s of list) { const v = vel.get(s.id); if (v && dt > 0) { v.vx += ((s.x - v.x) / dt - v.vx) * 0.2; v.vz += ((s.z - v.z) / dt - v.vz) * 0.2; v.x = s.x; v.z = s.z; } else vel.set(s.id, { x: s.x, z: s.z, vx: 0, vz: 0 }); }
    if (!L.on) { if (Date.now() > L.cool && list.some(s => Math.hypot(s.x - A.x, s.z - A.z) < HEART)) wake(list); return; }
    const inside = list.filter(s => Math.hypot(s.x - A.x, s.z - A.z) < R * 1.15);
    if (!inside.length) { L.emptyT += dt; if (L.emptyT > 10) sleep(false); return; } L.emptyT = 0;
    // who it hunts: the same captain for a while, then whoever else is in the trench
    L.tgtT -= dt; let T = inside.find(s => s.id === L.tgt);
    if (!T || L.tgtT <= 0) { T = inside[Math.floor(Math.random() * inside.length)]; L.tgt = T.id; L.tgtT = 20 + Math.random() * 10; }
    L.t += dt; const P3 = L.ph, spd = (P3 === 3 ? 70 : P3 === 2 ? 58 : 48) * (L.dying ? 0.3 : 1);
    L.ang += dt * (P3 === 3 ? 0.42 : 0.3); const rad = 170 + 50 * Math.sin(L.t * 0.23);
    const tx = T.x + Math.sin(L.ang) * rad, tz = T.z + Math.cos(L.ang) * rad, want = Math.atan2(tx - L.x, tz - L.z);
    L.h += angDiff(L.h, want) * Math.min(1, dt * 1.6);
    const ty = L.dying ? -60 : -4 + 15 * Math.sin(L.t * 0.55) * (L.rearT > 0 ? 0 : 1) + (L.rearT > 0 ? 22 : 0);
    L.x += Math.sin(L.h) * spd * dt; L.z += Math.cos(L.h) * spd * dt; L.y += (ty - L.y) * Math.min(1, dt * 1.4);
    if (L.rearT > 0) L.rearT -= dt;
    if (L.dying) { L.dying += dt; if (L.dying > 6) sleep(true); return; }
    const tm = L.timers; for (const k in tm) tm[k] -= dt;
    const v = vel.get(T.id) || { vx: 0, vz: 0 };
    if (tm.slam <= 0) { tm.slam = P3 === 3 ? 5 : P3 === 2 ? 7 : 9; L.rearT = 2.2; broadcast('lvwarn', { k: 'slam', x: r1(T.x + v.vx * 2.2), z: r1(T.z + v.vz * 2.2), r: 48, life: 2.2 }); }
    if (P3 >= 2 && tm.spit <= 0) { tm.spit = P3 === 3 ? 4.5 : 6.5; broadcast('lvspit', { to: T.id }); }
    if (P3 >= 2 && tm.ram <= 0) { tm.ram = P3 === 3 ? 11 : 15; broadcast('lvwarn', { k: 'ram', x: r1(T.x), z: r1(T.z), r: RING[T.k] || 50, life: 2.6, to: T.id }); }
  }

  function hurt(from, d, players) {
    if (!L.on || L.dying) return;
    const q = players.get(from); if (!q || !q.p) return;
    const px = q.p.sh ? q.p.sh.x : q.p.x, pz = q.p.sh ? q.p.sh.z : q.p.z;
    if (Math.hypot(px - L.x, pz - L.z) > 1500) return;   // in cannon (or mortar) range of it
    const now = Date.now(), r = L.rate.get(from) && now - L.rate.get(from).t < 1000 ? L.rate.get(from) : { t: now, n: 0 };
    const n = Math.max(0, Math.min(120, +d.dmg || 0, 1500 - r.n)); if (!n) return; r.n += n; L.rate.set(from, r);
    L.hp -= n; L.dmg.set(from, (L.dmg.get(from) || 0) + n);
    const ph = L.hp < L.max * 0.33 ? 3 : L.hp < L.max * 0.66 ? 2 : 1;
    if (ph !== L.ph) { L.ph = ph; broadcast('lvphase', { ph }); }
    if (L.hp <= 0) { L.hp = 0; L.dying = 0.01; }
  }

  return {
    tick,
    site: A,
    snapshot() { return L.on ? { on: 1, x: r1(L.x), y: r1(L.y), z: r1(L.z), h: Math.round(L.h * 100) / 100, hp: Math.round(L.hp), max: L.max, ph: L.ph, d: L.dying ? 1 : 0, tg: L.tgt } : { on: 0, cool: Math.max(0, Math.round((L.cool - Date.now()) / 1000)) }; },
    handle(from, topic, d, players) { if (topic !== 'lvdmg') return false; if (d && typeof d === 'object') hurt(from, d, players); return true; },
    removePlayer(id) { vel.delete(id); L.rate.delete(id); },
    _state: L,
  };
}
module.exports = { createAbyss, abyssSite };
