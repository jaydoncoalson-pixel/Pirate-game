// Shared sea monsters: one Kraken and the sea serpents of the Mistwrack Shoals, the same for every player.
// The server decides where they are, whom they hunt and when they're beaten. Each browser draws them from
// the snapshots (tentacles, coils and all) and applies hull damage to its own ship when it's the one attacked.
'use strict';
const W = require('./world');

const angDiff = (a, b) => ((b - a + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
const ISL = [[-150, -320, 300], [1900, 500, 128], [-3000, 1100, 420], [-1700, -3500, 400], [2700, -3100, 230], [4200, -700, 340], [900, -1500, 85], [-1300, -1600, 100], [1100, 4200, 270], [-3600, -1900, 170]];
// open sea, away from islands and rocks (same test as the game's krDeep)
const krDeep = (x, z) => Math.abs(x) < W.EDGE - 200 && Math.abs(z) < W.EDGE - 200 && W.heightAt(x, z) < -6.5 && ISL.every(([cx, cz, r]) => Math.hypot(x - cx, z - cz) > r * 1.25 + 40);
const deepNear = (x, z, r0, r1_) => { for (let i = 0; i < 60; i++) { const a = Math.random() * 6.28, r = r0 + Math.random() * (r1_ - r0), px = x + Math.sin(a) * r, pz = z + Math.cos(a) * r; if (krDeep(px, pz)) return { x: px, z: pz }; } return null; };
function mistSpot() {
  const M = W.MIST;
  for (let i = 0; i < 80; i++) { const a = Math.random() * 6.28, d = Math.sqrt(Math.random()) * (M.r - 80), x = M.x + Math.cos(a) * d, z = M.z + Math.sin(a) * d; if (W.heightAt(x, z) <= -6.9 && W.heightAt(x + 30, z) < -6 && W.heightAt(x - 30, z) < -6) return { x, z }; }
  return { x: M.x, z: M.z - M.r - 100 };
}
const KST = ['roam', 'hunt', 'engaged', 'drown', 'leaving', 'dying', 'dead'];
const SST = ['roam', 'hunt', 'circle', 'strike', 'escort', 'dying', 'gone', 'bow'];
const BWST = ['caged', 'rise', 'hunt', 'attack', 'return', 'dying', 'dead'];

function createMonsters({ sendTo, broadcast, raiders, sinkRaider, adminOk, hornOwns }) {
  // ---------------------------------------------------------------- the Kraken
  const K = { st: 'roam', x: -1300 * W.WS, z: 2700 * W.WS, h: 0, hp: 480, max: 480, t: 0, cd: 20, rs: 0, wp: null, tg: null, ally: null, scanT: 0, ramT: 10, dmgAcc: 0 };
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
    // locked in a fight with a serpent: it stands its ground and grabs no one until the clash is over
    if (K.clash > 0) { K.clash -= dt; if (K.st === 'roam' || K.st === 'hunt') { if (K.st === 'hunt') { K.st = 'roam'; K.tg = null; } K.cd = Math.max(K.cd, 6); return; } }
    switch (K.st) {
      case 'dead': K.rs -= dt; if (K.rs <= 0) { const q = deepNear(-1300 * W.WS, 2700 * W.WS, 0, 1500) || { x: -1300 * W.WS, z: 2700 * W.WS }; Object.assign(K, { st: 'roam', hp: K.max, cd: 30, x: q.x, z: q.z, tg: null }); } return;
      case 'dying': if (K.t > 4) { K.st = 'dead'; K.rs = 600; K.tg = null; } return;
      case 'drown': if (K.t > 9) { K.st = 'roam'; K.tg = null; K.cd = K.ally ? 0 : 60; K.wp = null; } return;
      case 'leaving': kMove(K.x + Math.sin(K.h) * 100, K.z + Math.cos(K.h) * 100, 20, dt); if (K.t > 5) { K.st = 'roam'; if (!K.ally) { const q = deepNear(K.x, K.z, 250, 400); if (q) { K.x = q.x; K.z = q.z; } } } return;
      case 'roam': {
        K.cd = Math.max(0, K.cd - dt);
        let gx, gz, sp = 18;
        if (!K.wp || Math.hypot(K.wp.x - K.x, K.wp.z - K.z) < 60) K.wp = deepNear(K.x, K.z, 400, 1300 * W.WS) || { x: -1300 * W.WS, z: 2700 * W.WS };
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
      const el = Array.isArray(q.p.el) ? q.p.el : null, elNear = !!(d.el && el && Math.hypot(el[0] - K.x, el[1] - K.z) < 700);   // an Elder Serpent can tear into it anywhere
      if (elNear ? (K.st === 'dying' || K.st === 'dead') : ((K.st !== 'engaged') || Math.min(Math.hypot(px - K.x, pz - K.z), Math.hypot(q.p.x - K.x, q.p.z - K.z)) > 400)) return;
      if (K.ally && K.ally.owner === from) return;   // its caller can't hurt it
      K.hp -= Math.max(0, Math.min(100, +d.dmg || 0));
      if (K.hp <= 0) { K.hp = 0; K.st = 'dying'; K.t = 0; broadcast('kdead', { by: from }); }
    } else if (topic === 'kclash') {   // a serpent has met it: hold it in place for the fight
      const el = Array.isArray(q.p.el) ? q.p.el : null;
      if (el && Math.hypot(el[0] - K.x, el[1] - K.z) < 900 && ['roam', 'hunt', 'engaged', 'leaving'].includes(K.st) && !(K.clash > 0)) {
        if (K.st !== 'roam') { K.st = 'roam'; K.tg = null; K.t = 0; releaseRaider(); }   // it lets go of whatever it had to face the serpent
        K.clash = 19.5; K.clashBy = from;
      }
    } else if (topic === 'kslay') {   // the clash ends with the serpent's killing bite
      const el = Array.isArray(q.p.el) ? q.p.el : null;
      const mine = (K.clash > 0 && K.clashBy === from) || (hornOwns && hornOwns(q));
      if (mine && el && Math.hypot(el[0] - K.x, el[1] - K.z) < 900 && !['dying', 'dead', 'drown'].includes(K.st)) { if (K.st === 'engaged') releaseRaider(); K.hp = 0; K.st = 'dying'; K.t = 0; K.clash = 0; broadcast('kdead', { by: from }); }
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
      if (topic === 'kquest' && (K.st === 'engaged' || K.st === 'hunt' || K.st === 'drown' || K.st === 'dying' || K.st === 'dead')) return;   // a beaten Kraken stays down until it respawns
      if (!q.p.sh || !q.p.sh.a || !krDeep(q.p.sh.x, q.p.sh.z)) return;
      const s = deepNear(q.p.sh.x, q.p.sh.z, 240, 260); if (!s) return;
      Object.assign(K, { x: s.x, z: s.z, st: 'hunt', tg: { k: 'ship', id: from }, hp: K.max, ally: null, cd: 0, t: 0 });
    }
  }

  // ---------------------------------------------------------------- sea serpents
  const SERP = [0, 1, 2, 3, 4].map(n => { const q = mistSpot(); return { x: q.x, z: q.z, h: Math.random() * 6.28, speed: 8, st: 'roam', hp: 320, max: 320, wp: null, ang: 0, side: n % 2 ? 1 : -1, strikeT: 3, sk: 0, hit: false, deadT: 0, tg: null }; });
  const serpAlive = s => s.st !== 'dying' && s.st !== 'gone';
  const prevSh = new Map();   // player -> last ship position, for speed
  // serpents never leave the mist: anything they steer for is pulled back inside its edge
  const inMist = (x, z, m = 0) => Math.hypot(x - W.MIST.x, z - W.MIST.z) < W.MIST.r + m;
  function clampMist(x, z) { const M = W.MIST, dx = x - M.x, dz = z - M.z, d = Math.hypot(dx, dz), lim = M.r - 40; return d <= lim ? [x, z] : [M.x + dx / d * lim, M.z + dz / d * lim]; }
  const SPD = 1.5;   // serpent pace multiplier: roaming, hunting, circling and striking (escort/bow keep pace with the ship)
  function serpSteer(s, tx, tz, want, dt, turn) {
    [tx, tz] = clampMist(tx, tz);
    const desired = Math.atan2(tx - s.x, tz - s.z), diff = angDiff(s.h, desired);
    let nh = s.h + Math.max(-turn * dt, Math.min(turn * dt, diff));
    s.speed += (want - s.speed) * Math.min(1, dt * 1.5);
    for (let tries = 0; tries < 6; tries++) { const ax = s.x + Math.sin(nh) * 14, az = s.z + Math.cos(nh) * 14; if (W.heightAt(ax, az) < -4.5) break; nh += (tries % 2 ? -1 : 1) * 0.5 * (tries + 1); }
    s.h = nh;
    const nx = s.x + Math.sin(nh) * s.speed * dt, nz = s.z + Math.cos(nh) * s.speed * dt;
    if (W.heightAt(nx, nz) < -4.5) { s.x = nx; s.z = nz; } else s.speed *= 0.5;
  }
  function startEscort(s, prey) {
    s.st = 'escort'; s.tg = prey.id; s.wait = 0; s.sk = 0;
    const other = SERP.find(o => o !== s && o.tg === prey.id && (o.st === 'escort' || o.st === 'bow'));
    if (other) s.side = -other.side;   // one on each side of her
  }
  function updateSerpents(dt, players) {
    // each crewed ship, with how fast she's going and whether her captain carries the Sword of the Sea
    const ships = [];
    for (const [id, q] of players) {
      // a captain swimming in the fog is prey too: they hunt swimmers just as they hunt ships
      if (q.p && q.p.swm === 1 && !(q.p.sh && q.p.sh.a === 1) && typeof q.p.x === 'number') { prevSh.delete(id); ships.push({ id, x: q.p.x, z: q.p.z, h: q.p.f || 0, sp: 3, calm: q.p.sw === 'seasword', swim: true }); continue; }
      if (!q.p || !q.p.sh || q.p.sh.a !== 1) { prevSh.delete(id); continue; }
      const sh = q.p.sh, pv = prevSh.get(id), raw = pv ? Math.min(150, Math.hypot(sh.x - pv.x, sh.z - pv.z) / Math.max(dt, 0.01)) : 0, sp = pv ? pv.sp + (raw - pv.sp) * Math.min(1, dt * 3) : 0;
      prevSh.set(id, { x: sh.x, z: sh.z, sp });
      ships.push({ id, x: sh.x, z: sh.z, h: sh.h || 0, sp, calm: q.p.sw === 'seasword' });
    }
    const M = W.MIST;
    // the whole nest keeps watch: a ship anywhere in the fog is noticed. Up to 3 hunt her, or 2 come to bow to a sword-bearer
    const busy = (id, calm) => SERP.filter(o => o.tg === id && (calm ? o.st === 'escort' || o.st === 'bow' : o.st === 'hunt' || o.st === 'circle' || o.st === 'strike')).length;
    const BOW_T = 6.2;
    // send the nearest idle serpents to each ship in the fog, up to the cap
    for (const s of SERP) s.want = null;
    for (const p of ships) {
      if (!inMist(p.x, p.z)) continue;
      let room = (p.calm ? 2 : p.swim ? 2 : 3) - busy(p.id, p.calm);
      const idle = SERP.filter(o => o.st === 'roam' && !o.want).sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z));
      for (const o of idle) { if (room-- <= 0) break; o.want = p.id; }
    }
    for (const s of SERP) {
      if (s.st === 'gone') { s.deadT -= dt; if (s.deadT <= 0) { const q = mistSpot(); Object.assign(s, { x: q.x, z: q.z, hp: s.max, st: 'roam', tg: null }); } continue; }
      if (s.st === 'dying') { s.deadT += dt; if (s.deadT > 5) { s.st = 'gone'; s.deadT = 300; } continue; }
      let prey = s.tg ? ships.find(p => p.id === s.tg) : null;
      if (!prey || s.st === 'roam') prey = s.want ? ships.find(p => p.id === s.want) : null;   // the ship this one was sent after
      const d = prey ? Math.hypot(prey.x - s.x, prey.z - s.z) : 1e9, leash = prey ? inMist(prey.x, prey.z, 30) : false;   // a ship that sails out of the fog is let go
      if (prey && prey.calm && (s.st === 'hunt' || s.st === 'circle' || s.st === 'strike')) startEscort(s, prey);
      if (prey && !prey.calm && (s.st === 'escort' || s.st === 'bow')) s.st = 'hunt';
      if (s.st === 'escort' || s.st === 'bow') {
        if (!prey || !leash) { s.st = 'roam'; s.tg = null; s.bowed = null; }
        else {
          // swim up alongside her, just off the beam; once there, rise out of the sea and bow; then keep her company
          const sx = Math.sin(prey.h), sz = Math.cos(prey.h), bowing = s.st === 'bow' || s.bowed !== prey.id, off = (bowing ? 24 : 38) * s.side, ahead = bowing ? 4 : 25;
          const tx = prey.x + sz * off + sx * ahead, tz = prey.z - sx * off + sz * ahead, ds = Math.hypot(tx - s.x, tz - s.z);
          serpSteer(s, tx, tz, Math.max(6, Math.min(120, prey.sp + ds * (bowing ? 0.4 : 0.08))), dt, 2.4);
          if (s.st === 'escort') { s.wait = (s.wait || 0) + dt; if (s.bowed !== prey.id && ds < 16 && (Math.abs(angDiff(s.h, prey.h)) < 0.7 || s.wait > 12)) { s.st = 'bow'; s.sk = 0; } }
          else { s.sk += dt; if (s.sk > BOW_T) { s.st = 'escort'; s.bowed = prey.id; s.sk = 0; } }
        }
      } else if (s.st === 'roam') {
        s.tg = null; s.bowed = null;
        if (prey) { if (prey.calm) startEscort(s, prey); else { s.st = 'hunt'; s.tg = prey.id; } }
        if (!s.wp || Math.hypot(s.wp.x - s.x, s.wp.z - s.z) < 40) s.wp = mistSpot();
        serpSteer(s, s.wp.x, s.wp.z, 9 * SPD, dt, 1.2);
      } else if (s.st === 'hunt') {
        if (!prey || !leash) { s.st = 'roam'; s.tg = null; }
        else { s.tg = prey.id; s.ang = Math.atan2(s.x - prey.x, s.z - prey.z); serpSteer(s, prey.x + Math.sin(s.ang) * 44, prey.z + Math.cos(s.ang) * 44, Math.max(55 * SPD, prey.sp + 25 * SPD), dt, 2.6); if (d < 80) { s.st = 'circle'; s.strikeT = 1 + Math.random(); } }
      } else if (s.st === 'circle') {
        if (!prey || !leash) { s.st = 'roam'; s.tg = null; }
        else if (d > 170) s.st = 'hunt';
        else {
          s.ang += dt * 0.55 * s.side;
          serpSteer(s, prey.x + Math.sin(s.ang) * 40, prey.z + Math.cos(s.ang) * 40, Math.max(25 * SPD, prey.sp + 20 * SPD), dt, 3);
          s.strikeT -= dt; if (s.strikeT <= 0 && d < 66) { s.st = 'strike'; s.sk = 0; s.hit = false; }
        }
      } else if (s.st === 'strike') {
        s.sk += dt;
        if (prey) serpSteer(s, prey.x, prey.z, s.sk < 0.9 ? Math.max(4, prey.sp) : prey.sp + 18 * SPD, dt, 3);   // keep pace with her while rearing up
        if (!s.hit && s.sk > 1.15) { s.hit = true; if (prey && d < (prey.swim ? 30 : 48)) sendTo(prey.id, 'sbite', { to: prey.id, i: SERP.indexOf(s), dmg: 22, sw: prey.swim ? 1 : 0 }); }
        if (s.sk > 1.9) { s.st = leash ? 'circle' : 'roam'; s.strikeT = 2 + Math.random() * 1.5; }
      }
    }
  }
  function serpentHandle(from, d, players) {
    const s = SERP[d.i | 0], q = players.get(from);
    if (!s || !serpAlive(s) || !q || !q.p) return;
    const px = q.p.sh ? q.p.sh.x : q.p.x, pz = q.p.sh ? q.p.sh.z : q.p.z;
    const el = Array.isArray(q.p.el) ? q.p.el : null;
    if (Math.min(Math.hypot(px - s.x, pz - s.z), Math.hypot(q.p.x - s.x, q.p.z - s.z), el ? Math.hypot(el[0] - s.x, el[1] - s.z) : 1e9) > 500) return;
    if (d.el && el && hornOwns && hornOwns(q) && Math.hypot(el[0] - s.x, el[1] - s.z) < 700) s.hp = 0;   // the Elder Serpent kills one in a single bite
    else s.hp -= Math.max(0, Math.min(60, +d.dmg || 0));
    if (s.st === 'roam') { s.st = 'hunt'; s.tg = from; }
    if (s.hp <= 0) { s.hp = 0; s.st = 'dying'; s.deadT = 0; broadcast('sdead', { i: d.i | 0, by: from }); }
  }

  // ---------------------------------------------------------------- the Blackwater Beast
  // Kept caged under Skull Isle. In a Blackwater raid it breaks loose, surfaces off the island and hunts any crewed
  // ship that isn't Blackwater (so: players), seizing her in its claws and crushing her hull until she sinks or gets
  // away. It keeps to open water. When the raid ends it swims home to its pen.
  const BW = { st: 'caged', x: 0, z: 0, h: 0, hp: 1500, max: 1500, t: 0, tg: null, wp: null, atkT: 0, pk: 99, sp: 0, grip: 0, cd: 0, orb: 0 };
  // deep water, clear of the shallows (its legs would hit bottom): it can go anywhere the sea is deep enough
  const bwSea = (x, z) => Math.abs(x) < W.EDGE - 300 && Math.abs(z) < W.EDGE - 300 && W.heightAt(x, z) < -6.5 && W.heightAt(x + 45, z) < -4 && W.heightAt(x - 45, z) < -4 && W.heightAt(x, z + 45) < -4 && W.heightAt(x, z - 45) < -4;
  const bwAlive = () => BW.st === 'rise' || BW.st === 'hunt' || BW.st === 'attack' || BW.st === 'return';
  function bwHome() {
    const I = W.ISLANDS[4];
    for (let i = 0; i < 120; i++) { const a = Math.random() * 6.28, d = I.r * 1.3 + 80 + Math.random() * 400, x = I.c.x + Math.sin(a) * d, z = I.c.y + Math.cos(a) * d; if (W.raidSea(x, z)) return { x, z }; }
    return { x: I.c.x + I.r * 2.5, z: I.c.y };
  }
  function bwMove(gx, gz, sp, dt) {
    BW.sp += (sp - BW.sp) * Math.min(1, dt * 1.2);
    let want = Math.atan2(gx - BW.x, gz - BW.z);
    for (let k = 0; k < 7; k++) { const a = want + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.45; if (bwSea(BW.x + Math.sin(a) * 90, BW.z + Math.cos(a) * 90)) { want = a; break; } }   // feel round islands
    BW.h += Math.max(-1.3 * dt, Math.min(1.3 * dt, angDiff(BW.h, want)));
    const nx = BW.x + Math.sin(BW.h) * BW.sp * dt, nz = BW.z + Math.cos(BW.h) * BW.sp * dt;
    if (bwSea(nx, nz)) { BW.x = nx; BW.z = nz; BW.stuck = 0; } else { BW.sp *= 0.5; BW.stuck = (BW.stuck || 0) + dt; }
    // boxed in by land: strike out for open water somewhere to the side for a while, then try again
    if (BW.stuck > 2) { BW.stuck = 0; for (let i = 0; i < 60; i++) { const a = Math.random() * 6.28, r = 300 + Math.random() * 900, x = BW.x + Math.sin(a) * r, z = BW.z + Math.cos(a) * r; if (bwSea(x, z)) { BW.detour = { x, z, t: 10 }; break; } } }
  }
  // steer for (gx, gz), unless it's working its way round an island
  function bwGo(gx, gz, sp, dt) {
    if (BW.detour) { BW.detour.t -= dt; if (BW.detour.t <= 0 || Math.hypot(BW.detour.x - BW.x, BW.detour.z - BW.z) < 80) BW.detour = null; else { bwMove(BW.detour.x, BW.detour.z, Math.max(sp, 60), dt); return; } }
    bwMove(gx, gz, sp, dt);
  }
  function updateBeast(dt, players) {
    BW.t += dt; BW.pk += dt;
    if (BW.st === 'caged' || BW.st === 'dead') return;
    if (BW.st === 'dying') { if (BW.t > 6) { BW.st = 'dead'; BW.tg = null; } return; }
    if (BW.st === 'rise') { if (BW.t > 6) { BW.st = 'hunt'; BW.t = 0; } return; }
    if (BW.st === 'return') {
      if (!BW.wp) BW.wp = bwHome();
      BW.deep = true; const a = Math.atan2(BW.wp.x - BW.x, BW.wp.z - BW.z); BW.h += angDiff(BW.h, a) * Math.min(1, dt * 2); BW.sp = 60; BW.x += Math.sin(BW.h) * 60 * dt; BW.z += Math.cos(BW.h) * 60 * dt;   // home through the deep
      if (BW.t > 90 || Math.hypot(BW.wp.x - BW.x, BW.wp.z - BW.z) < 120) { BW.st = 'caged'; BW.t = 0; BW.wp = null; BW.deep = false; }
      return;
      bwGo(BW.wp.x, BW.wp.z, 45, dt);
      if (BW.t > 90 || Math.hypot(BW.wp.x - BW.x, BW.wp.z - BW.z) < 120) { BW.st = 'caged'; BW.t = 0; BW.wp = null; }
      return;
    }
    const ships = [];
    for (const [id, q] of players) if (q.p && q.p.sh && q.p.sh.a === 1 && typeof q.p.sh.x === 'number') ships.push({ id, x: q.p.sh.x, z: q.p.sh.z });
      else if (q.p && q.p.swm === 1 && typeof q.p.x === 'number') ships.push({ id, x: q.p.x, z: q.p.z, swim: true });   // and anyone swimming
    let prey = BW.tg ? ships.find(p => p.id === BW.tg) : null;
    if (BW.st === 'hunt') {
      if (!prey) { let bd = 1e9; for (const p of ships) { const d = Math.hypot(p.x - BW.x, p.z - BW.z); if (d < bd && bwSea(p.x, p.z)) { bd = d; prey = p; } } BW.tg = prey ? prey.id : null; }
      if (!prey) {   // nothing at sea: prowl
        if (!BW.wp || Math.hypot(BW.wp.x - BW.x, BW.wp.z - BW.z) < 150) { const q = [...players.values()].find(q => q.p && typeof q.p.x === 'number'); BW.wp = q ? (deepNearSea(q.p.x, q.p.z, 900, 2000) || bwHome()) : bwHome(); }
        bwGo(BW.wp.x, BW.wp.z, 28, dt); return;
      }
      const d = Math.hypot(prey.x - BW.x, prey.z - BW.z);
      if (BW.cd > 0) {   // it has let her go for a moment: it circles her, out of reach, before it comes again
        BW.cd -= dt; BW.orb += dt * 0.35; const ox = prey.x + Math.sin(BW.orb) * 380, oz = prey.z + Math.cos(BW.orb) * 380; bwGo(ox, oz, 55, dt); return;
      }
      // far off, it sinks out of sight and races straight for her through the deep, under reefs and round islands alike;
      // it only surfaces again in open water near her
      if (d > 900 || (BW.deep && !bwSea(BW.x, BW.z))) { BW.deep = true; BW.detour = null; const a = Math.atan2(prey.x - BW.x, prey.z - BW.z); BW.h += angDiff(BW.h, a) * Math.min(1, dt * 2); BW.sp += (130 - BW.sp) * Math.min(1, dt); BW.x += Math.sin(BW.h) * BW.sp * dt; BW.z += Math.cos(BW.h) * BW.sp * dt; return; }
      BW.deep = false;
      bwGo(prey.x, prey.z, d > 600 ? 62 : 46, dt);
      if (d < 85) { BW.st = 'attack'; BW.t = 0; BW.atkT = 1.4; BW.grip = 0; }
      return;
    }
    if (BW.st === 'attack') {
      if (!prey) { BW.st = 'hunt'; BW.tg = null; return; }   // she sank, or her crew left her
      const d = Math.hypot(prey.x - BW.x, prey.z - BW.z);
      if (d > 280) { BW.st = 'hunt'; return; }   // she slipped its grip
      // stay right up against her, facing her, and crush
      const a = Math.atan2(BW.x - prey.x, BW.z - prey.z), gx = prey.x + Math.sin(a) * 62, gz = prey.z + Math.cos(a) * 62;
      { const dx = gx - BW.x, dz = gz - BW.z, dd = Math.hypot(dx, dz), st = Math.min(dd, 70 * dt); if (dd > 0.01) { const nx = BW.x + dx / dd * st, nz = BW.z + dz / dd * st; if (bwSea(nx, nz)) { BW.x = nx; BW.z = nz; } } BW.sp = st / Math.max(dt, 1e-3); }   // it scuttles sideways to keep its grip
      BW.h += angDiff(BW.h, Math.atan2(prey.x - BW.x, prey.z - BW.z)) * Math.min(1, dt * 3);
      BW.atkT -= dt;
      if (BW.atkT <= 0 && d < 140) { BW.atkT = 2.6 + Math.random() * 0.6; BW.pk = 0; BW.grip++; sendTo(prey.id, 'bwhit', { to: prey.id, dmg: 18 + Math.floor(Math.random() * 7), sw: prey.swim ? 1 : 0 }); }
      if (BW.grip >= 3 && BW.atkT > 1.5) { BW.st = 'hunt'; BW.cd = 12; BW.orb = Math.atan2(BW.x - prey.x, BW.z - prey.z); }   // three crushing blows, then it lets go and circles: a chance to fight back or flee
    }
  }
  const deepNearSea = (x, z, r0, r1_) => { for (let i = 0; i < 60; i++) { const a = Math.random() * 6.28, r = r0 + Math.random() * (r1_ - r0), px = x + Math.sin(a) * r, pz = z + Math.cos(a) * r; if (bwSea(px, pz)) return { x: px, z: pz }; } return null; };
  function beastRelease() {
    if (bwAlive() && BW.st !== 'return') return;
    const q = bwHome(); Object.assign(BW, { deep: false, detour: null, st: 'rise', x: q.x, z: q.z, h: Math.random() * 6.28, hp: BW.max, t: 0, tg: null, wp: null, sp: 0, pk: 99 });
  }
  function beastRecall() { if (BW.st === 'rise' || BW.st === 'hunt' || BW.st === 'attack') { BW.st = 'return'; BW.t = 0; BW.tg = null; BW.wp = null; } }
  function beastHandle(from, d, players) {
    const q = players.get(from); if (!q || !q.p || !bwAlive() || BW.st === 'rise') return;
    const px = q.p.sh ? q.p.sh.x : q.p.x, pz = q.p.sh ? q.p.sh.z : q.p.z, el = Array.isArray(q.p.el) ? q.p.el : null;
    if (Math.min(Math.hypot(px - BW.x, pz - BW.z), Math.hypot(q.p.x - BW.x, q.p.z - BW.z), el ? Math.hypot(el[0] - BW.x, el[1] - BW.z) : 1e9) > 1200) return;
    BW.hp -= d.el && el && hornOwns && hornOwns(q) && Math.hypot(el[0] - BW.x, el[1] - BW.z) < 700 ? 300 : Math.max(0, Math.min(60, +d.dmg || 0));   // the Elder Serpent's bite tears a great chunk out of it
    if (BW.st === 'hunt' && !BW.tg && q.p.sh && q.p.sh.a === 1) BW.tg = from;   // it turns on whoever hurts it
    if (BW.hp <= 0) { BW.hp = 0; BW.st = 'dying'; BW.t = 0; BW.tg = null; broadcast('bwdead', { by: from }); }
  }

  return {
    tick(dt, players) { updateKraken(dt, players); updateSerpents(dt, players); updateBeast(dt, players); },
    beastRelease, beastRecall,
    snapshot() {
      BW.h = Math.atan2(Math.sin(BW.h), Math.cos(BW.h));
      return { bwsnap: [r1(BW.x), r1(BW.z), r2(BW.h), BWST.indexOf(BW.st), Math.max(0, Math.round(BW.hp)), BW.max, BW.tg || 0, r1(Math.min(BW.pk, 99)), r1(BW.sp), BW.deep ? 1 : 0], ksnap: krakenSnap(), ssnap: SERP.map((s, i) => [i, r1(s.x), r1(s.z), r2(s.h), Math.max(0, Math.round(s.hp)), SST.indexOf(s.st), r2(s.sk), r1(s.speed), s.tg || 0]) };
    },
    handle(from, topic, d, players) {
      if (!d || typeof d !== 'object') d = {};
      if (topic === 'kdmg' || topic === 'kclash' || topic === 'kslay' || topic === 'kcall' || topic === 'kpick' || topic === 'kquest' || topic === 'kadmin') { krakenHandle(from, topic, d, players); return true; }
      if (topic === 'sdmg') { serpentHandle(from, d, players); return true; }
      if (topic === 'bwdmg') { beastHandle(from, d, players); return true; }
      return false;
    },
    removePlayer(id) { if (BW.tg === id) BW.tg = null; if (K.ally && K.ally.owner === id) K.ally = null; prevSh.delete(id); for (const s of SERP) if (s.tg === id) s.tg = null; },
    _state: { K, SERP, BW },
  };
}

module.exports = { createMonsters, KST, SST, BWST, krDeep };
