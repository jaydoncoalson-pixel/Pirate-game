// Authoritative world simulation: bandits on land and Blackwater raider ships at sea.
// The server is the only place these run. Browsers send what their player did
// (hit a bandit, hit a raider) and render the snapshots the server sends back.
'use strict';
const W = require('./world');
const { createMonsters } = require('./monsters');

const BST = ['idle', 'chase', 'dead', 'gone'];
const RST = ['patrol', 'attack', 'sinking', 'gone'];
const angDiff = (a, b) => ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
const angLerp = (a, b, t) => a + angDiff(a, b) * t;
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;

function createSim({ sendTo, broadcast, adminOk = () => true, hornOwns = () => false }) {
  // ---------- state ----------
  const bandits = W.BANDIT_SPAWNS.map(s => ({
    name: s.name, home: s.home, post: s.post || s.home, x: s.x, z: s.z, facing: s.facing,
    hp: 50, max: 50, state: 'idle', atkT: 0, slashT: 0, hitAt: 0, target: null, victim: null, wait: Math.random() * 3, deadT: 0,
  }));
  const raiders = W.RAIDER_SPAWNS.map(s => ({
    home: s.home, T: s.T, galleon: s.galleon, maxHp: s.maxHp, raid: !!s.raid, leaving: false, leaveT: 0,
    x: s.home.x, z: s.home.z, heading: 0, speed: 10, steer: 0, hp: s.maxHp, state: s.raid ? 'gone' : 'patrol',
    reload: { 1: 0, '-1': 0 }, wpt: null, blockT: 0, sinkT: 0, respawnT: 0, target: null, heldBy: null, lastHitBy: null, lastHitKr: false,
  }));

  // ---------- the Blackwater raid ----------
  // Every 5 minutes (while anyone is online) there's a 5% chance the Blackwater fleet sails out of Fort Blackwater.
  // Waves of raid ships come, each bigger than the last; every raider at sea turns more savage; and the Blackwater
  // Beast breaks out of its pen and hunts every ship that doesn't fly the Blackwater flag. After 8 minutes it's over.
  const RAID = { on: false, t: 0, dur: 480, rollT: 300, wave: 0, waveT: 0 };
  // players: Map id -> { p: presence } (filled by the relay)
  const footTargets = players => [...players].filter(([, q]) => q.p && q.p.md === 1 && typeof q.p.x === 'number');
  const shipTargets = players => [...players].filter(([, q]) => q.p && q.p.sh && q.p.sh.a === 1);

  // ---------- bandits ----------
  function walkMove(b, mx, mz) {
    const ok = W.walkable, nx = b.x + mx, nz = b.z + mz;
    if (ok(nx, nz)) { b.x = nx; b.z = nz; }
    else if (ok(nx, b.z)) b.x = nx;
    else if (ok(b.x, nz)) b.z = nz;
    for (const c of W.campColliders) {   // tents and campfire
      const dx = b.x - c.x, dz = b.z - c.z, d = Math.hypot(dx, dz), min = c.r + 0.45;
      if (d < min && d > 1e-4) { const px = c.x + dx / d * min, pz = c.z + dz / d * min; if (ok(px, pz)) { b.x = px; b.z = pz; } }
    }
  }
  function updateBandits(dt, players) {
    const foot = footTargets(players);
    for (const b of bandits) {
      if (b.state === 'gone') {
        b.deadT -= dt; if (b.deadT > 0) continue;
        b.state = 'idle'; b.hp = b.max; b.x = b.post.x; b.z = b.post.z; b.target = null;
      }
      if (b.state === 'dead') { b.deadT += dt; if (b.deadT > 6) { b.state = 'gone'; b.deadT = 150; } continue; }
      // nearest player on foot
      let tg = null, d = 1e9;
      for (const [id, q] of foot) { const dd = Math.hypot(q.p.x - b.x, q.p.z - b.z); if (dd < d) { d = dd; tg = { id, x: q.p.x, z: q.p.z }; } }
      const can = !!tg;
      if (b.state === 'idle' && can && d < 24) b.state = 'chase';
      if (b.state === 'chase' && (!can || d > 45)) b.state = 'idle';
      let tx, tz, want = 0;
      if (b.state === 'chase') {
        tx = tg.x; tz = tg.z;
        if (d > 1.7) want = 4.6;
        else {
          b.facing = angLerp(b.facing, Math.atan2(tg.x - b.x, tg.z - b.z), Math.min(1, dt * 10));
          b.atkT -= dt;
          if (b.atkT <= 0 && b.slashT <= 0) { b.slashT = 0.4; b.hitAt = 0.2; b.atkT = 1.2 + Math.random() * 0.5; b.victim = tg.id; }
        }
      } else if (!b.target || Math.hypot(b.target.x - b.x, b.target.z - b.z) < 0.8) {
        b.wait -= dt;
        if (b.wait <= 0) { const a = Math.random() * 6.28, r = Math.random() * 10; b.target = { x: b.post.x + Math.cos(a) * r, z: b.post.z + Math.sin(a) * r }; b.wait = 2 + Math.random() * 4; }
      } else { tx = b.target.x; tz = b.target.z; want = 1.6; }
      if (want > 0 && tx !== undefined) {
        b.facing = angLerp(b.facing, Math.atan2(tx - b.x, tz - b.z), Math.min(1, dt * 8));
        const ox = b.x, oz = b.z;
        walkMove(b, Math.sin(b.facing) * want * dt, Math.cos(b.facing) * want * dt);
        if (b.state !== 'chase' && Math.hypot(b.x - ox, b.z - oz) < want * dt * 0.2) b.target = null;
      }
      if (b.slashT > 0) {
        b.slashT -= dt;
        if (b.hitAt > 0) {
          b.hitAt -= dt;
          if (b.hitAt <= 0 && b.victim) {
            const v = players.get(b.victim);
            if (v && v.p && v.p.md === 1 && Math.hypot(v.p.x - b.x, v.p.z - b.z) < 2.5) sendTo(b.victim, 'bhit', { to: b.victim, dmg: 9 + Math.floor(Math.random() * 5) });
          }
        }
      }
    }
  }
  function hitBandit(i, dmg, from, players) {
    const b = bandits[i], q = players.get(from);
    if (!b || b.state === 'dead' || b.state === 'gone' || !q || !q.p) return;
    if (Math.hypot(q.p.x - b.x, q.p.z - b.z) > 70) return;   // cutlass reach or pistol range (60), plus lag slack
    b.hp -= Math.max(0, Math.min(80, +dmg || 0)); b.state = 'chase';
    if (b.hp <= 0) { b.hp = 0; b.state = 'dead'; b.deadT = 0; b.slashT = 0; }
  }

  // ---------- raiders ----------
  function raiderWaypoint(r) {
    for (let i = 0; i < 40; i++) { const a = Math.random() * 6.28, d = (600 + Math.random() * 1800) * 1.6, x = r.x + Math.sin(a) * d, z = r.z + Math.cos(a) * d; if (W.raidSea(x, z)) { r.wpt = { x, z }; return; } }
    r.wpt = { x: r.home.x, z: r.home.z };
  }
  function spawnRaider(r, players) {
    const pts = [...players.values()].filter(q => q.p && typeof q.p.x === 'number').map(q => q.p);
    let ok = false;
    for (let i = 0; i < 60 && !ok; i++) {
      // half in the old home waters, half within a few km of a player, so raiders still find ye on the wider sea
      if (i % 2 || !pts.length) { r.x = (Math.random() - 0.5) * 9000; r.z = (Math.random() - 0.5) * 9000; }
      else { const p = pts[Math.floor(Math.random() * pts.length)], a = Math.random() * 6.28, d = 1400 + Math.random() * 3200; r.x = p.x + Math.sin(a) * d; r.z = p.z + Math.cos(a) * d; }
      ok = W.raidSea(r.x, r.z) && pts.every(p => Math.hypot(r.x - p.x, r.z - p.z) > 1000) && !W.blockedAt(r.T, r.x, r.z, 0);
    }
    if (!ok) for (let i = 0; i < 40; i++) { const a = Math.random() * 6.28; r.x = r.home.x + Math.cos(a) * 350; r.z = r.home.z + Math.sin(a) * 350; if (!W.blockedAt(r.T, r.x, r.z, 0)) break; }
    raiderWaypoint(r);
    r.heading = Math.random() * 6.28; r.speed = 10; r.steer = 0; r.hp = r.maxHp; r.state = 'patrol'; r.sinkT = 0;
    r.target = null; r.heldBy = null; r.lastHitBy = null; r.lastHitKr = false;
  }
  // a raid ship comes over the horizon, a mile or so from a captain who's at sea (or anyone, or else Skull Isle)
  function spawnRaidShip(r, players) {
    const all = [...players.values()].filter(q => q.p && typeof q.p.x === 'number'), sea = all.filter(q => q.p.sh && q.p.sh.a === 1);
    const pts = (sea.length ? sea.map(q => q.p.sh) : all.map(q => q.p));
    let ok = false;
    for (let i = 0; i < 80 && !ok && pts.length; i++) {
      const p = pts[Math.floor(Math.random() * pts.length)], a = Math.random() * 6.28, d = 1300 + Math.random() * 1100; r.x = p.x + Math.sin(a) * d; r.z = p.z + Math.cos(a) * d;
      ok = W.raidSea(r.x, r.z) && all.every(q => Math.hypot(r.x - q.p.x, r.z - q.p.z) > 900) && !W.blockedAt(r.T, r.x, r.z, 0);
    }
    if (!ok) for (let i = 0; i < 60; i++) { const a = Math.random() * 6.28; r.x = r.home.x + Math.cos(a) * 300; r.z = r.home.z + Math.sin(a) * 300; if (W.raidSea(r.x, r.z) && !W.blockedAt(r.T, r.x, r.z, 0)) break; }
    raiderWaypoint(r);
    r.heading = Math.random() * 6.28; r.speed = 18; r.steer = 0; r.hp = r.maxHp; r.state = 'patrol'; r.sinkT = 0; r.leaving = false; r.leaveT = 0;
    r.target = null; r.heldBy = null; r.lastHitBy = null; r.lastHitKr = false;
  }
  function raidStart() {
    if (RAID.on) return;
    Object.assign(RAID, { on: true, t: 0, wave: 0, waveT: 4 });
    monsters.beastRelease();
    broadcast('raid', { on: 1, dur: RAID.dur });
    console.log('*** Blackwater raid begins');
  }
  function raidEnd() {
    if (!RAID.on) return;
    RAID.on = false; RAID.rollT = 300;
    for (const r of raiders) if (r.raid) { if (r.state === 'patrol' || r.state === 'attack') { r.leaving = true; r.leaveT = 0; } else if (r.state === 'gone') r.respawnT = Infinity; }
    monsters.beastRecall();
    broadcast('raid', { on: 0 });
    console.log('*** Blackwater raid over');
  }
  function updateRaid(dt, players) {
    if (!RAID.on) {
      if (!players.size) return;
      RAID.rollT -= dt; if (RAID.rollT <= 0) { RAID.rollT = 300; if (Math.random() < 0.05) raidStart(); }
      return;
    }
    RAID.t += dt; RAID.waveT -= dt;
    if (RAID.waveT <= 0) {   // each wave is bigger than the last: 2 ships, then 3, then 4...
      RAID.wave++; RAID.waveT = 40; let n = 1 + RAID.wave, sent = 0;
      for (const r of raiders) if (n > 0 && r.raid && r.state === 'gone' && r.respawnT === Infinity) { r.respawnT = Math.random() * 8; n--; sent++; }
      if (sent) broadcast('raidwave', { w: RAID.wave, n: sent });
    }
    if (RAID.t >= RAID.dur || !players.size) raidEnd();
  }
  function updateRaiders(dt, players) {
    const ships = shipTargets(players);
    for (const r of raiders) {
      for (const k in r.reload) r.reload[k] = Math.max(0, r.reload[k] - dt);
      if (r.state === 'gone') { r.respawnT -= dt; if (r.respawnT <= 0) { if (r.raid) spawnRaidShip(r, players); else spawnRaider(r, players); } continue; }
      if (r.state === 'sinking') { r.sinkT += dt; if (r.sinkT > 8) { r.state = 'gone'; r.respawnT = r.raid ? (RAID.on ? 20 + Math.random() * 20 : Infinity) : 200; } continue; }   // in a raid, sunk raid ships are soon replaced
      if (r.leaving) {   // the raid is over: the fleet sails off over the horizon
        r.leaveT += dt; r.state = 'patrol'; r.target = null;
        if (!r.wpt || Math.hypot(r.wpt.x - r.x, r.wpt.z - r.z) < 120) raiderWaypoint(r);
        if (r.leaveT > 45) { r.state = 'gone'; r.respawnT = Infinity; r.leaving = false; continue; }
      }
      // nearest player ship that is crewed (someone sailing, on deck or below deck)
      let tg = null, td = 1e9;
      for (const [id, q] of ships) { const dd = Math.hypot(q.p.sh.x - r.x, q.p.sh.z - r.z); if (dd < td) { td = dd; tg = { id, x: q.p.sh.x, z: q.p.sh.z }; } }
      for (const [id, q] of players) if (q.p && (q.p.swm === 1 || q.p.wwk === 1 || q.p.rid >= 1) && !(q.p.sh && q.p.sh.a === 1) && typeof q.p.x === 'number') { const dd = Math.hypot(q.p.x - r.x, q.p.z - r.z); if (dd < td) { td = dd; tg = { id, x: q.p.x, z: q.p.z, swim: true }; } }   // a captain in the water is fair game too
      let desired = r.heading, want = 14;
      // in a raid every Blackwater ship is out for blood: they spot ye from much further, sail harder and reload faster.
      // The raid fleet itself hunts down any ship at sea, wherever she is.
      const fury = RAID.on && !r.leaving, sight = r.leaving ? 0 : r.raid ? 6000 : fury ? 2000 : 1000;
      if (tg && td < sight) {
        r.state = 'attack'; r.target = tg.id;
        const tdx = tg.x - r.x, tdz = tg.z - r.z, b = Math.atan2(tdx, tdz);
        if (td > 260) { desired = b; want = fury ? 42 : 34; }
        else { const a1 = b + Math.PI / 2, a2 = b - Math.PI / 2; desired = Math.abs(angDiff(r.heading, a1)) < Math.abs(angDiff(r.heading, a2)) ? a1 : a2; want = fury ? 32 : 26; }
        if (td < 240) {
          const fwdDot = (tdx * Math.sin(r.heading) + tdz * Math.cos(r.heading)) / td;
          const side = tdx * Math.cos(r.heading) - tdz * Math.sin(r.heading) > 0 ? 1 : -1;
          if (Math.abs(fwdDot) < (fury ? 0.5 : 0.4) && r.reload[side] <= 0) { r.reload[side] = fury ? 2.2 + Math.random() * 1 : 3.5 + Math.random() * 1.5; broadcast('rfire', { i: raiders.indexOf(r), s: side }); }
        }
      } else {
        r.state = 'patrol'; r.target = null;
        if (!r.wpt || Math.hypot(r.wpt.x - r.x, r.wpt.z - r.z) < 120) raiderWaypoint(r);
        desired = Math.atan2(r.wpt.x - r.x, r.wpt.z - r.z); want = r.leaving ? 30 : r.raid ? 24 : r.galleon ? 11 : 14;
      }
      if (r.heldBy) { if (r.heldBy !== 'kraken' && !players.has(r.heldBy)) r.heldBy = null; else { desired = r.heading; want = 0; r.speed = 0; } }   // a kraken has her
      const diff = angDiff(r.heading, desired), nh = r.heading + Math.max(-0.45 * dt, Math.min(0.45 * dt, diff));
      r.steer += (Math.sign(diff) * Math.min(1, Math.abs(diff)) - r.steer) * Math.min(1, dt * 2);
      r.speed += (want - r.speed) * Math.min(1, dt * 0.4);
      const nx = r.x + Math.sin(nh) * r.speed * dt, nz = r.z + Math.cos(nh) * r.speed * dt;
      if (W.blockedAt(r.T, nx, nz, nh)) { r.heading += 0.9 * dt; r.speed *= 0.6; r.blockT += dt; if (r.blockT > 4) { r.blockT = 0; raiderWaypoint(r); } }
      else { r.heading = nh; r.x = nx; r.z = nz; }
    }
  }
  function hitRaider(i, dmg, kr, from, players, elKill) {
    const r = raiders[i], q = players.get(from);
    if (!r || (r.state !== 'patrol' && r.state !== 'attack') || !q || !q.p) return;
    const px = q.p.sh ? q.p.sh.x : q.p.x, pz = q.p.sh ? q.p.sh.z : q.p.z;
    const el = Array.isArray(q.p.el) ? q.p.el : null;   // their Elder Serpent bites too
    if (Math.min(Math.hypot(px - r.x, pz - r.z), Math.hypot(q.p.x - r.x, q.p.z - r.z), el ? Math.hypot(el[0] - r.x, el[1] - r.z) : 1e9) > 1000) return;   // cannon, kraken or serpent range
    // the Elder Serpent sinks any ship in one bite (only the horn's owner has one, and he must be right there)
    if (elKill && el && hornOwns(q) && Math.hypot(el[0] - r.x, el[1] - r.z) < 700) r.hp = 0;
    else r.hp -= Math.max(0, Math.min(60, +dmg || 0));
    r.lastHitBy = from; r.lastHitKr = !!kr;
    if (r.hp <= 0) sinkRaider(r, from, r.lastHitKr);
  }
  function sinkRaider(r, by, kr) {
    if (r.state === 'sinking' || r.state === 'gone') return;
    r.hp = 0; r.state = 'sinking'; r.sinkT = 0; r.heldBy = null;
    broadcast('rsunk', { i: raiders.indexOf(r), by, kr: kr ? 1 : 0, gal: r.galleon ? 1 : 0 });
  }

  raiders.forEach(r => { if (r.raid) r.respawnT = Infinity; else spawnRaider(r, new Map()); });
  // the Kraken and the sea serpents, shared by everyone
  const monsters = createMonsters({ sendTo, broadcast, raiders, sinkRaider, adminOk, hornOwns });

  // ---------- public API ----------
  return {
    tick(dt, players) { updateRaid(dt, players); updateBandits(dt, players); updateRaiders(dt, players); monsters.tick(dt, players); },
    raidAdmin(cmd) { if (cmd === 'start') raidStart(); else if (cmd === 'stop') raidEnd(); },
    snapshot() {
      return {
        bsnap: bandits.map((b, i) => [i, r1(b.x), r1(b.z), r2(b.facing), Math.max(0, Math.round(b.hp)), BST.indexOf(b.state), b.slashT > 0 ? 1 : 0]),
        rsnap: raiders.map((r, i) => [i, r1(r.x), r1(r.z), r2(r.heading), Math.max(0, Math.round(r.hp)), RST.indexOf(r.state), r1(r.speed), r2(r.steer), r.target || 0]),
        ...monsters.snapshot(),
        raid: { on: RAID.on ? 1 : 0, left: RAID.on ? Math.max(0, Math.round(RAID.dur - RAID.t)) : 0, w: RAID.wave },
      };
    },
    // events from a browser; returns true if the sim consumed the topic
    handle(from, topic, d, players) {
      if (monsters.handle(from, topic, d, players)) return true;
      if (!d || typeof d !== 'object') return topic === 'bdmg' || topic === 'rdmg' || topic === 'rhold';
      if (topic === 'bdmg') { hitBandit(d.i | 0, d.dmg, from, players); return true; }
      if (topic === 'rdmg') { hitRaider(d.i | 0, d.dmg, d.kr, from, players, !!d.el); return true; }
      if (topic === 'rhold') { const r = raiders[d.i | 0]; if (r) { if (d.on && (r.state === 'patrol' || r.state === 'attack')) r.heldBy = from; else if (r.heldBy === from) r.heldBy = null; } return true; }
      return false;
    },
    removePlayer(id) { monsters.removePlayer(id); for (const r of raiders) if (r.heldBy === id) r.heldBy = null; for (const b of bandits) if (b.victim === id) b.victim = null; },
    _state: { bandits, raiders, monsters: monsters._state, RAID },
  };
}

module.exports = { createSim, BST, RST };
