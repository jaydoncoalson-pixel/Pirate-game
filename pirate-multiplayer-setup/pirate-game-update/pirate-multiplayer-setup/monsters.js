// Shared sea monsters: one Kraken and the sea serpents of the Mistwrack Shoals, the same for every player.
// The server decides where they are, whom they hunt and when they're beaten. Each browser draws them from
// the snapshots (tentacles, coils and all) and applies hull damage to its own ship when it's the one attacked.
'use strict';
const W = require('./world');

const angDiff = (a, b) => ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
const ISL = [[-150, -320, 300], [1900, 500, 128], [-3000, 1100, 420], [-1700, -3500, 400], [2700, -3100, 230], [4200, -700, 340], [900, -1500, 85], [-1300, -1600, 100], [1100, 4200, 270], [-3600, -1900, 170]];
// open sea, away from islands and rocks (same test as the game's krDeep)
const krDeep = (x, z) => Math.abs(x) < 4900 && Math.abs(z) < 4900 && W.heightAt(x, z) < -6.5 && ISL.every(([cx, cz, r]) => Math.hypot(x - cx, z - cz) > r * 1.25 + 40);
const deepNear = (x, z, r0, r1_) => { for (let i = 0; i < 60; i++) { const a = Math.random() * 6.28, r = r0 + Math.random() * (r1_ - r0), px = x + Math.sin(a) * r, pz = z + Math.cos(a) * r; if (krDeep(px, pz)) return { x: px, z: pz }; } return null; };
function mistSpot() {
  const M = W.MIST;
  for (let i = 0; i < 80; i++) { const a = Math.random() * 6.28, d = Math.sqrt(Math.random()) * (M.r - 80), x = M.x + Math.cos(a) * d, z = M.z + Math.sin(a) * d; if (W.heightAt(x, z) <= -6.9 && W.heightAt(x + 30, z) < -6 && W.heightAt(x - 30, z) < -6) return { x, z }; }
  return { x: M.x, z: M.z - M.r - 100 };
}
const KST = ['roam', 'hunt', 'engaged', 'drown', 'leaving', 'dying', 'dead'];
const SST = ['roam', 'hunt', 'circle', 'strike', 'escort', 'dying', 'gone'];

function createMonsters({ sendTo, broadcast, raiders, sinkRaider, adminOk }) {
  // ---------------------------------------------------------------- the Kraken
  const K = { st: 'roam', x: -1300, z: 2700, h: 0, hp: 480, max: 480, t: 0, cd: 20, rs: 0, wp: null, tg: null, ally: null, scanT: 0, ramT: 10, dmgAcc: 0 };
  const ship = (players, id) => { const q = players.get(id); return q && q.p && q.p.sh && q.p.sh.a === 1 ? q.p.sh : null; };
  const swimmer = (players, id) => { const q = players.get(id); return q && q.p && q.p.swm === 1 ? q.p : null; };
  function tgPos(players, tg) {
    if (!tg) return null;
    if (tg.k === 'ship') return ship(players, tg.id);
    if (tg.k === 'swim') return swimmer(players, tg.id);
    const r = raiders[tg.i]; return r && (r.state === 'patrol' || r.state === 'attack') ? r : null;
  }
  function kLeave(cd) { releaseRaider(); K.st = 'leaving'; K.t = 0; K.tg = null; K.cd = cd; }
  function releaseRaider() { for (const r of raiders) if (r.heldBy === 'kraken') r.heldBy = null; }
  function kScan(players) {
    let best = null, bd = 1e9;
    const consider = (tg, x, z, range) => { const d = Math.hypot(x - K.x, z - K.z); if (d < range && d < bd && krDeep(x, z)) { bd = d; best = tg; } };
    if (K.ally) {
      const pick = K.ally.pick || { kind: 'raider' };
      if (pick.kind === 'player') { const s = ship(players, pick.peer); return s && krDeep(s.x, s.z) ? { k: 'ship', id: pick.peer } : null; }
      const owner = players.get(K.ally.owner), ox = owner && owner.p ? (owner.p.sh ? owner.p.sh.x : owner.p.x) : K.x, oz = owner && owner.p ? (owner.p.sh ? owner.p.sh.z : owner.p.z) : K.z;
      if (Number.isInteger(pick.i)) { const r = raiders[pick.i]; if (r && (r.state === 'patrol' || r.state === 'attack') && krDeep(r.x, r.z)) return { k: 'raider', i: pick.i }; }
      raiders.forEach((r, i) => { if ((r.state === 'patrol' || r.state === 'attack') && Math.hypot(r.x - ox, r.z - oz) < 900 && krDeep(r.x, r.z)) { const d = Math.hypot(r.x - ox, r.z - oz); if (d < bd) { bd = d; best = { k: 'raider', i }; } } });
      return best;
    }
    for (const [id, q] of players) { if (!q.p) continue; if (q.p.sh && q.p.sh.a === 1) consider({ k: 'ship', id }, q.p.sh.x, q.p.sh.z, 800); else if (q.p.swm === 1) consider({ k: 'swim', id }, q.p.x, q.p.z, 450); }
    raiders.forEach((r, i) => { if (r.state === 'patrol' || r.state === 'attack') consider({ k: 'raider', i }, r.x, r.z, 600); });
    return best;
  }
  function kMove(gx, gz, sp, dt) {
    const b = Math.atan2(gx - K.x, gz - K.z), nx = K.x + Math.sin(b) * sp * dt, nz = K.z + Math.cos(b) * sp * dt;
    if (sp > 0) K.h = b;
    if (krDeep(nx, nz)) { K.x = nx; K.z = nz; return true; }
    K.wp = null; return false;
  }
  function updateKraken(dt, players) {
    if (K.ally) {
      K.ally.t -= dt;
      if (K.ally.t <= 0) { const wasShip = K.tg && K.tg.k === 'ship'; K.ally = null; K.cd = 120; if ((K.st === 'engaged' || K.st === 'hunt') && wasShip) kLeave(120); }
      else if (!players.has(K.ally.owner)) K.ally = null;
    }
    K.t += dt;
    if (K.st !== 'engaged') releaseRaider();
    switch (K.st) {
      case 'dead': K.rs -= dt; if (K.rs <= 0) { const q = deepNear(-1300, 2700, 0, 1500) || { x: -1300, z: 2700 }; Object.assign(K, { st: 'roam', hp: K.max, cd: 30, x: q.x, z: q.z, tg: null }); } return;
      case 'dying': if (K.t > 4) { K.st = 'dead'; K.rs = 600; K.tg = null; } return;
      case 'drown': if (K.t > 9) { K.st = 'roam'; K.tg = null; K.cd = K.ally ? 0 : 60; K.wp = null; } return;
      case 'leaving': kMove(K.x + Math.sin(K.h) * 100, K.z + Math.cos(K.h) * 100, 20, dt); if (K.t > 5) { K.st = 'roam'; if (!K.ally) { const q = deepNear(K.x, K.z, 250, 400); if (q) { K.x = q.x; K.z = q.z; } } } return;
      case 'roam': {
        K.cd = Math.max(0, K.cd - dt);
        let gx, gz, sp = 18;
        if (!K.wp || Math.hypot(K.wp.x - K.x, K.wp.z - K.z) < 60) K.wp = deepNear(K.x, K.z, 400, 1300) || { x: -1300, z: 2700 };
        gx = K.wp.x; gz = K.wp.z;
        if (K.ally) {   // escort: keep close alongside whoever called it
          const o = players.get(K.ally.owner), me = o && o.p ? (o.p.sh || o.p) : null;
          if (me) { const d = Math.hypot(me.x - K.x, me.z - K.z); gx = me.x; gz = me.z; sp = d > 120 ? Math.min(110, 24 + d * 0.3) : d > 60 ? 20 : 0; }
        }
        kMove(gx, gz, sp, dt);
        K.scanT -= dt;
        if (K.cd <= 0 && K.scanT <= 0) {
          K.scanT = 1; const tg = kScan(players);
          if (tg) {
            K.tg = tg; K.st = 'hunt'; K.t = 0;
            const p = tgPos(players, tg);
            if (K.ally && p && Math.hypot(p.x - K.x, p.z - K.z) > 500) { const q = deepNear(p.x, p.z, 220, 300); if (q) { K.x = q.x; K.z = q.z; } }   // it rises close to the target its caller picked
          }
        }
        return;
      }
      case 'hunt': {
        const p = tgPos(players, K.tg);
        if (!p) { K.st = 'roam'; K.tg = null; K.cd = 10; return; }
        const d = Math.hypot(p.x - K.x, p.z - K.z), picked = K.ally && K.ally.pick && K.ally.pick.kind === 'player';
        if (d > 1000 && !picked) { K.st = 'roam'; K.tg = null; K.cd = 8; return; }
        const reach = K.tg.k === 'swim' ? 18 : K.tg.k === 'raider' ? raiders[K.tg.i].T.L * 0.5 + 18 : 45;
        if (d < reach && krDeep(p.x, p.z)) { K.st = 'engaged'; K.t = 0; K.ramT = 10 + Math.random() * 4; K.dmgAcc = 0; return; }
        if (!kMove(p.x, p.z, 76, dt) && Math.random() < dt) { K.st = 'roam'; K.tg = null; K.cd = 6; }
        return;
      }
      case 'engaged': {
        const p = tgPos(players, K.tg);
        if (!p) {
          // the ship went down (or sailed off / the swimmer got away)
          if (K.tg && K.tg.k === 'ship') { if (K.ally && K.ally.owner !== K.tg.id) sendTo(K.ally.owner, 'ksunk', { to: K.ally.owner, id: K.tg.id }); K.st = 'drown'; K.t = 0; }
          else kLeave(K.ally ? 0 : 45);
          return;
        }
        K.x = p.x; K.z = p.z;
        if (K.hp <= 0) { K.st = 'dying'; K.t = 0; return; }
        if (K.tg.k === 'raider') {   // a raider in its grip: the server tears at her hull (players apply their own)
          const r = raiders[K.tg.i]; r.heldBy = 'kraken';
          if (K.t > 2.6) { K.dmgAcc += 5 * dt; K.ramT -= dt; if (K.ramT <= 0) { K.ramT = 9 + Math.random() * 5; K.dmgAcc += 20; } }
          if (K.dmgAcc >= 1) { const n = Math.floor(K.dmgAcc); K.dmgAcc -= n; r.hp -= n; }
          if (r.hp <= 0) { releaseRaider(); sinkRaider(r, K.ally ? K.ally.owner : 'kraken', !!K.ally); K.st = 'drown'; K.t = 0; }
        }
        return;
      }
    }
  }
  function krakenSnap() {
    return { x: r1(K.x), z: r1(K.z), h: r2(K.h), s: KST.indexOf(K.st), hp: Math.max(0, Math.round(K.hp)), max: K.max, tg: K.tg, ally: K.ally ? K.ally.owner : 0, aT: K.ally ? r1(K.ally.t) : 0 };
  }
  function krakenHandle(from, topic, d, players) {
    const q = players.get(from); if (!q || !q.p) return;
    const px = q.p.sh ? q.p.sh.x : q.p.x, pz = q.p.sh ? q.p.sh.z : q.p.z;
    if (topic === 'kdmg') {
      if ((K.st !== 'engaged') || Math.min(Math.hypot(px - K.x, pz - K.z), Math.hypot(q.p.x - K.x, q.p.z - K.z)) > 400) return;
      if (K.ally && K.ally.owner === from) return;   // its caller can't hurt it
      K.hp -= Math.max(0, Math.min(60, +d.dmg || 0));
      if (K.hp <= 0) { K.hp = 0; K.st = 'dying'; K.t = 0; broadcast('kdead', { by: from }); }
    } else if (topic === 'kcall') {
      if (q.p.sw !== 'seasword') return;
      const pick = d.pick && (d.pick.kind === 'player' || d.pick.kind === 'raider') ? { kind: d.pick.kind, peer: d.pick.peer, i: Number.isInteger(d.pick.i) ? d.pick.i : undefined } : { kind: 'raider' };
      const engagedOnCaller = (K.st === 'engaged' || K.st === 'hunt') && K.tg && K.tg.k !== 'raider' && K.tg.id === from;
      K.ally = { owner: from, t: 90, pick }; K.cd = 0; K.scanT = 0;
      if (K.st === 'dead' || K.st === 'dying') { K.st = 'roam'; K.hp = K.max; }
      if (engagedOnCaller || (K.st === 'hunt' && K.tg && K.tg.k !== 'raider')) kLeave(0);
      if ((K.st === 'roam' || K.st === 'hunt') && Math.hypot(K.x - px, K.z - pz) > 600) { const s = deepNear(px, pz, 120, 220); if (s) { K.x = s.x; K.z = s.z; } }
      if (K.st === 'leaving') K.t = 4.5;   // let go quickly
    } else if (topic === 'kpick') {
      if (!K.ally || K.ally.owner !== from || !d.pick) return;
      K.ally.pick = { kind: d.pick.kind === 'player' ? 'player' : 'raider', peer: d.pick.peer, i: Number.isInteger(d.pick.i) ? d.pick.i : undefined };
      if (K.st === 'engaged' || K.st === 'hunt') { K.st = 'leaving'; K.t = 4.5; K.tg = null; }
      K.cd = 0; K.scanT = 0;
    } else if (topic === 'kquest' || (topic === 'kadmin' && adminOk(d))) {
      // a quest (or an admin) calls the Kraken up beside this player's ship
      if (topic === 'kadmin' && d.cmd === 'defeat') { if (K.st === 'engaged') { K.hp = 0; K.st = 'dying'; K.t = 0; broadcast('kdead', { by: from }); } return; }
      if (topic === 'kquest' && (K.st === 'engaged' || K.st === 'hunt' || K.st === 'drown')) return;
      if (!q.p.sh || !q.p.sh.a || !krDeep(q.p.sh.x, q.p.sh.z)) return;
      const s = deepNear(q.p.sh.x, q.p.sh.z, 240, 260); if (!s) return;
      Object.assign(K, { x: s.x, z: s.z, st: 'hunt', tg: { k: 'ship', id: from }, hp: K.max, ally: null, cd: 0, t: 0 });
    }
  }

  // ---------------------------------------------------------------- sea serpents
  const SERP = [0, 1, 2].map(n => { const q = mistSpot(); return { x: q.x, z: q.z, h: Math.random() * 6.28, speed: 8, st: 'roam', hp: 240, max: 240, wp: null, ang: 0, side: n % 2 ? 1 : -1, strikeT: 3, sk: 0, hit: false, deadT: 0, tg: null }; });
  const serpAlive = s => s.st !== 'dying' && s.st !== 'gone';
  const prevSh = new Map();   // player -> last ship position, for speed
  function serpSteer(s, tx, tz, want, dt, turn) {
    const desired = Math.atan2(tx - s.x, tz - s.z), diff = angDiff(s.h, desired);
    let nh = s.h + Math.max(-turn * dt, Math.min(turn * dt, diff));
    s.speed += (want - s.speed) * Math.min(1, dt * 1.5);
    for (let tries = 0; tries < 6; tries++) { const ax = s.x + Math.sin(nh) * 14, az = s.z + Math.cos(nh) * 14; if (W.heightAt(ax, az) < -4.5) break; nh += (tries % 2 ? -1 : 1) * 0.5 * (tries + 1); }
    s.h = nh;
    const nx = s.x + Math.sin(nh) * s.speed * dt, nz = s.z + Math.cos(nh) * s.speed * dt;
    if (W.heightAt(nx, nz) < -4.5) { s.x = nx; s.z = nz; } else s.speed *= 0.5;
  }
  function updateSerpents(dt, players) {
    // each crewed ship, with how fast she's going and whether her captain carries the Sword of the Sea
    const ships = [];
    for (const [id, q] of players) {
      if (!q.p || !q.p.sh || q.p.sh.a !== 1) { prevSh.delete(id); continue; }
      const sh = q.p.sh, pv = prevSh.get(id), sp = pv ? Math.min(40, Math.hypot(sh.x - pv.x, sh.z - pv.z) / Math.max(dt, 0.01)) : 0;
      prevSh.set(id, { x: sh.x, z: sh.z });
      ships.push({ id, x: sh.x, z: sh.z, h: sh.h || 0, sp, calm: q.p.sw === 'seasword' });
    }
    const M = W.MIST;
    for (const s of SERP) {
      if (s.st === 'gone') { s.deadT -= dt; if (s.deadT <= 0) { const q = mistSpot(); Object.assign(s, { x: q.x, z: q.z, hp: s.max, st: 'roam', tg: null }); } continue; }
      if (s.st === 'dying') { s.deadT += dt; if (s.deadT > 5) { s.st = 'gone'; s.deadT = 300; } continue; }
      let prey = s.tg ? ships.find(p => p.id === s.tg) : null;
      if (!prey || s.st === 'roam') {   // nearest crewed ship
        let bd = 1e9; prey = null; for (const p of ships) { const d = Math.hypot(p.x - s.x, p.z - s.z); if (d < bd) { bd = d; prey = p; } }
      }
      const d = prey ? Math.hypot(prey.x - s.x, prey.z - s.z) : 1e9, leash = Math.hypot(s.x - M.x, s.z - M.z) < M.r + 900;
      if (prey && prey.calm && (s.st === 'hunt' || s.st === 'circle' || s.st === 'strike')) s.st = 'escort';
      if (prey && !prey.calm && s.st === 'escort') s.st = 'hunt';
      if (s.st === 'escort') {
        if (!prey || d > 420) { s.st = 'roam'; s.tg = null; }
        else { const sx = Math.sin(prey.h), sz = Math.cos(prey.h), off = 38 * s.side; serpSteer(s, prey.x + sz * off + sx * 25, prey.z - sx * off + sz * 25, Math.max(8, Math.min(40, prey.sp + d * 0.05)), dt, 2.2); }
      } else if (s.st === 'roam') {
        s.tg = null;
        if (prey && d < (prey.calm ? 160 : 380) && leash) { s.st = prey.calm ? 'escort' : 'hunt'; s.tg = prey.id; }
        if (!s.wp || Math.hypot(s.wp.x - s.x, s.wp.z - s.z) < 40) s.wp = mistSpot();
        serpSteer(s, s.wp.x, s.wp.z, 9, dt, 1.2);
      } else if (s.st === 'hunt') {
        if (!prey || d > 700 || !leash) { s.st = 'roam'; s.tg = null; }
        else { s.tg = prey.id; s.ang = Math.atan2(s.x - prey.x, s.z - prey.z); serpSteer(s, prey.x + Math.sin(s.ang) * 44, prey.z + Math.cos(s.ang) * 44, 26, dt, 2.2); if (d < 75) { s.st = 'circle'; s.strikeT = 2 + Math.random() * 2; } }
      } else if (s.st === 'circle') {
        if (!prey || d > 170) s.st = prey ? 'hunt' : 'roam';
        else {
          s.ang += dt * 0.55 * s.side;
          serpSteer(s, prey.x + Math.sin(s.ang) * 40, prey.z + Math.cos(s.ang) * 40, Math.max(14, prey.sp + 8), dt, 2.6);
          s.strikeT -= dt; if (s.strikeT <= 0 && d < 62) { s.st = 'strike'; s.sk = 0; s.hit = false; }
        }
      } else if (s.st === 'strike') {
        s.sk += dt;
        if (prey) serpSteer(s, prey.x, prey.z, s.sk < 0.9 ? 4 : 18, dt, 3);
        if (!s.hit && s.sk > 1.15) { s.hit = true; if (prey && d < 42) sendTo(prey.id, 'sbite', { to: prey.id, i: SERP.indexOf(s), dmg: 13 }); }
        if (s.sk > 1.9) { s.st = 'circle'; s.strikeT = 3.5 + Math.random() * 2.5; }
      }
    }
  }
  function serpentHandle(from, d, players) {
    const s = SERP[d.i | 0], q = players.get(from);
    if (!s || !serpAlive(s) || !q || !q.p) return;
    const px = q.p.sh ? q.p.sh.x : q.p.x, pz = q.p.sh ? q.p.sh.z : q.p.z;
    if (Math.min(Math.hypot(px - s.x, pz - s.z), Math.hypot(q.p.x - s.x, q.p.z - s.z)) > 500) return;
    s.hp -= Math.max(0, Math.min(60, +d.dmg || 0));
    if (s.st === 'roam') { s.st = 'hunt'; s.tg = from; }
    if (s.hp <= 0) { s.hp = 0; s.st = 'dying'; s.deadT = 0; broadcast('sdead', { i: d.i | 0, by: from }); }
  }

  return {
    tick(dt, players) { updateKraken(dt, players); updateSerpents(dt, players); },
    snapshot() {
      return { ksnap: krakenSnap(), ssnap: SERP.map((s, i) => [i, r1(s.x), r1(s.z), r2(s.h), Math.max(0, Math.round(s.hp)), SST.indexOf(s.st), r2(s.sk), r1(s.speed), s.tg || 0]) };
    },
    handle(from, topic, d, players) {
      if (!d || typeof d !== 'object') d = {};
      if (topic === 'kdmg' || topic === 'kcall' || topic === 'kpick' || topic === 'kquest' || topic === 'kadmin') { krakenHandle(from, topic, d, players); return true; }
      if (topic === 'sdmg') { serpentHandle(from, d, players); return true; }
      return false;
    },
    removePlayer(id) { if (K.ally && K.ally.owner === id) K.ally = null; prevSh.delete(id); for (const s of SERP) if (s.tg === id) s.tg = null; },
    _state: { K, SERP },
  };
}

module.exports = { createMonsters, KST, SST, krDeep };
