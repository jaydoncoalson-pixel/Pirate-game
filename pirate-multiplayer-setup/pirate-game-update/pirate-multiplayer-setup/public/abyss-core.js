// The Leviathan's mind: where it swims, who it hunts, when it strikes and how much fight it has left.
// The same code runs on the server (one beast for every captain online) and in the browser (offline play).
// It only decides; the game draws the beast and resolves each attack against its own ship.
(function (root) {
  'use strict';
  const angDiff = (a, b) => ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
  const r1 = v => Math.round(v * 10) / 10;
  const RING = { sloop: 32, brig: 44, galleon: 56, titan: 100 };
  const R = 1500, HEART = 600, COOL_MS = 20 * 60 * 1000, BASE_HP = 18000, PER_EXTRA = 6000;

  function createLeviathanCore({ site, emit, now = () => Date.now(), log = () => {} }) {
    const A = site;
    const L = { on: false, x: 0, y: -60, z: 0, h: 0, hp: 0, max: BASE_HP, ph: 1, t: 0, ang: 0, tgt: null, tgtT: 0, timers: {}, rearT: 0, intro: 0, dying: 0, emptyT: 0, cool: 0, enr: false, dmg: new Map(), roarT: 8 };
    const vel = new Map();

    function wake(list) {
      const near = list.filter(s => Math.hypot(s.x - A.x, s.z - A.z) < R);
      Object.assign(L, { on: true, ph: 1, t: 0, dying: 0, emptyT: 0, rearT: 0, intro: 7, enr: false, dmg: new Map(), roarT: 10, timers: { slam: 9, spit: 10, ram: 14, wave: 18, barrage: 12 } });
      L.max = BASE_HP + PER_EXTRA * Math.max(0, near.length - 1); L.hp = L.max;   // a tougher beast for a bigger fleet
      const t = list.find(s => Math.hypot(s.x - A.x, s.z - A.z) < HEART) || near[0]; L.tgt = t.id; L.tgtT = 25;
      L.x = A.x; L.z = A.z; L.y = -70; L.h = Math.atan2(t.x - A.x, t.z - A.z); L.ang = L.h + Math.PI;
      emit('lvwake', { max: L.max, x: r1(A.x), z: r1(A.z) });
      log(`*** the Leviathan rises (${near.length} captain${near.length === 1 ? '' : 's'})`);
    }
    function sleep(killed) {
      L.on = false;
      if (killed) { L.cool = now() + COOL_MS; const by = [...L.dmg].filter(([, d]) => d >= L.max * 0.03).map(([id]) => id); emit('lvdead', { by }); log(`*** the Leviathan is slain (${by.length} captain${by.length === 1 ? '' : 's'})`); }
      else emit('lvsleep', {});
    }
    const tmul = () => (L.enr ? 0.6 : 1);

    function tick(dt, list) {   // list: [{ id, x, z, k }] ships at sea
      for (const s of list) { const v = vel.get(s.id); if (v && dt > 0) { v.vx += ((s.x - v.x) / dt - v.vx) * 0.2; v.vz += ((s.z - v.z) / dt - v.vz) * 0.2; v.x = s.x; v.z = s.z; } else vel.set(s.id, { x: s.x, z: s.z, vx: 0, vz: 0 }); }
      if (!L.on) { if (now() > L.cool && list.some(s => Math.hypot(s.x - A.x, s.z - A.z) < HEART)) wake(list); return; }
      const inside = list.filter(s => Math.hypot(s.x - A.x, s.z - A.z) < R * 1.15);
      if (!inside.length && !L.dying) { L.emptyT += dt; if (L.emptyT > 10) sleep(false); return; } L.emptyT = 0;
      L.t += dt;
      // the rising: it bursts up out of the whirl at the heart of the trench and towers over the sea before it hunts
      if (L.intro > 0) { L.intro -= dt; L.y += ((L.intro > 1.5 ? 70 : 10) - L.y) * Math.min(1, dt * 1.2); L.h += 0.15 * dt; return; }
      if (L.dying) { L.dying += dt; L.y += ((L.dying < 3 ? 80 : -120) - L.y) * Math.min(1, dt * (L.dying < 3 ? 1.5 : 0.8)); if (L.dying > 8) sleep(true); return; }
      let T = inside.find(s => s.id === L.tgt); L.tgtT -= dt;
      if (!T || L.tgtT <= 0) { T = inside[Math.floor(Math.random() * inside.length)]; L.tgt = T.id; L.tgtT = 18 + Math.random() * 10; }
      const P3 = L.ph, spd = (P3 === 3 ? 78 : P3 === 2 ? 64 : 52) * (L.enr ? 1.2 : 1);
      L.ang += dt * (P3 === 3 ? 0.5 : 0.34) * (L.enr ? 1.3 : 1); const rad = 150 + 60 * Math.sin(L.t * 0.23);
      const tx = T.x + Math.sin(L.ang) * rad, tz = T.z + Math.cos(L.ang) * rad, want = Math.atan2(tx - L.x, tz - L.z);
      L.h += angDiff(L.h, want) * Math.min(1, dt * 1.7);
      const ty = L.rearT > 0 ? 48 : -6 + 16 * Math.sin(L.t * 0.6);
      if (L.rearT <= 0) { L.x += Math.sin(L.h) * spd * dt; L.z += Math.cos(L.h) * spd * dt; } else L.rearT -= dt;   // rearing up it holds still (and its belly is open to shot)
      L.y += (ty - L.y) * Math.min(1, dt * 1.6);
      L.roarT -= dt; if (L.roarT <= 0) { L.roarT = 9 + Math.random() * 8; emit('lvroar', {}); }
      const tm = L.timers, m = tmul(); for (const k in tm) tm[k] -= dt;
      const v = vel.get(T.id) || { vx: 0, vz: 0 };
      if (tm.slam <= 0) {   // the tail comes down where yer ship will be: once, then twice, then three times
        tm.slam = (P3 === 3 ? 4.5 : P3 === 2 ? 5.5 : 6.5) * m; const n = P3;
        for (let i = 0; i < n; i++) { const lead = 2.2 + i * 1.1; emit('lvwarn', { k: 'slam', x: r1(T.x + v.vx * lead), z: r1(T.z + v.vz * lead), r: 50, life: 2.2 + i * 1.1 }); }
      }
      if (P3 >= 2 && tm.spit <= 0) { tm.spit = (P3 === 3 ? 4 : 5.5) * m; emit('lvspit', { to: T.id, n: P3 === 3 ? 8 : 5 }); }
      if (P3 >= 2 && tm.ram <= 0) { tm.ram = (P3 === 3 ? 9 : 12) * m; emit('lvwarn', { k: 'ram', x: r1(T.x), z: r1(T.z), r: RING[T.k] || 56, life: 2.4, to: T.id }); }
      if (P3 >= 2 && tm.wave <= 0) { tm.wave = (P3 === 3 ? 11 : 15) * m; L.rearT = 2.2; emit('lvwave', { x: r1(L.x), z: r1(L.z), spd: 95, max: 900 }); }
      if (P3 >= 3 && tm.barrage <= 0) { tm.barrage = 13 * m; for (const s of inside) emit('lvspit', { to: s.id, n: 6 }); }   // abyssal fire on every ship in the trench
    }

    function hurt(from, n) {
      if (!L.on || L.dying || L.intro > 0) return 0;
      n = Math.max(0, n) * (L.rearT > 0 ? 2 : 1);   // rearing, its pale belly is open: double damage
      L.hp -= n; L.dmg.set(from, (L.dmg.get(from) || 0) + n);
      const ph = L.hp < L.max * 0.33 ? 3 : L.hp < L.max * 0.66 ? 2 : 1;
      if (ph !== L.ph) { L.ph = ph; L.rearT = 3.5; L.timers.wave = 2; emit('lvphase', { ph }); }
      if (!L.enr && L.hp < L.max * 0.15 && L.hp > 0) { L.enr = true; emit('lvenrage', {}); }
      if (L.hp <= 0) { L.hp = 0; L.dying = 0.01; emit('lvdying', {}); }
      return n;
    }

    return {
      tick, hurt, site: A,
      state: L,
      snapshot() { return L.on ? { on: 1, x: r1(L.x), y: r1(L.y), z: r1(L.z), h: Math.round(L.h * 100) / 100, hp: Math.round(L.hp), max: L.max, ph: L.ph, d: L.dying ? 1 : 0, i: L.intro > 0 ? 1 : 0, rr: L.rearT > 0 ? 1 : 0, w: L.ph >= 3 && !L.dying ? 1 : 0, e: L.enr ? 1 : 0, tg: L.tgt } : { on: 0, cool: Math.max(0, Math.round((L.cool - now()) / 1000)) }; },
      forget(id) { vel.delete(id); },
    };
  }
  const api = { createLeviathanCore, R, HEART, COOL_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.LeviathanCore = api;
})(typeof window !== 'undefined' ? window : this);
