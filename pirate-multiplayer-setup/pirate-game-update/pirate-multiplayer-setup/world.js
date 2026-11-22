// Server-side copy of the game's world data: terrain height, docks, bandit camps, raider hulls.
// This is a straight port of the client code (no THREE.js), so the server and every browser
// agree on where land, sea and docks are. If you change the islands in the client, change them here too.
'use strict';

class V2 {
  constructor(x = 0, y = 0) { this.x = x; this.y = y; }
  clone() { return new V2(this.x, this.y); }
  sub(v) { this.x -= v.x; this.y -= v.y; return this; }
  addScaledVector(v, s) { this.x += v.x * s; this.y += v.y * s; return this; }
  lengthSq() { return this.x * this.x + this.y * this.y; }
  normalize() { const l = Math.sqrt(this.lengthSq()) || 1; this.x /= l; this.y /= l; return this; }
  copy(v) { this.x = v.x; this.y = v.y; return this; }
  multiplyScalar(k) { this.x *= k; this.y *= k; return this; }
}

// KEEP IN STEP WITH public/index.html: islands spread WS times apart and IRS times bigger
const WS = 2.2, IRS = 2.5, HILLS = 2.2;
const ISLAND = new V2(-150 * WS, -320 * WS);
const R = 300 * IRS;
const DOCK_DIR = new V2(-ISLAND.x, -ISLAND.y).normalize();
const PERP = new V2(-DOCK_DIR.y, DOCK_DIR.x);
const DOCK_BASE = ISLAND.clone().addScaledVector(DOCK_DIR, R * 0.94 - 20);
const TOWN = DOCK_BASE.clone().addScaledVector(DOCK_DIR, -95);
const DOCK_LEN = 130, DECK_Y = 3.6, DOCK_HW = 5, DOCK_HEAD = 22, DOCK_HEADLEN = 14;
const local = (u, v) => TOWN.clone().addScaledVector(DOCK_DIR, u).addScaledVector(PERP, v);

const nperm = new Uint8Array(512);
(s => { const p = [...Array(256).keys()]; for (let i = 255; i > 0; i--) { s = (s * 16807) % 2147483647; const j = s % (i + 1); [p[i], p[j]] = [p[j], p[i]]; } for (let i = 0; i < 512; i++) nperm[i] = p[i & 255]; })(4242);
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, X = xi & 255, Y = yi & 255;
  const a = nperm[nperm[X] + Y], b = nperm[nperm[X + 1] + Y], c = nperm[nperm[X] + Y + 1], d = nperm[nperm[X + 1] + Y + 1];
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return (a + (b - a) * u + ((c + (d - c) * u) - (a + (b - a) * u)) * v) / 255;
}
const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const fbm = (x, y) => vnoise(x, y) * 0.5 + vnoise(x * 2.03 + 17, y * 2.03 + 9) * 0.3 + vnoise(x * 4.1 + 41, y * 4.1 + 23) * 0.2;
function distToSeg(px, pz, a, b) {
  const abx = b.x - a.x, abz = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((px - a.x) * abx + (pz - a.y) * abz) / (abx * abx + abz * abz)));
  return Math.hypot(px - (a.x + abx * t), pz - (a.y + abz * t));
}
const TOWN_BACK = local(-34, 0);
const ISLANDS = [
  { name: 'Gull Island', c: ISLAND, r: R, kind: 'home', hill: 95, seed: 5, rough: 0.38 },
  { name: 'Palm Key', c: new V2(1900, 500), r: 128, kind: 'sandbar', hill: 6, seed: 11, aspect: 2.3, rot: 0.6 },
  { name: 'Jungle Isle', c: new V2(-3000, 1100), r: 420, kind: 'jungle', hill: 110, seed: 23, aspect: 1.45, rot: -0.4 },
  { name: 'Smoke Peak', c: new V2(-1700, -3500), r: 400, kind: 'volcano', hill: 0, seed: 37, aspect: 1.15, rot: 0.9, rough: 0.3 },
  { name: 'Skull Isle', c: new V2(2700, -3100), r: 230, kind: 'skull', hill: 40, seed: 51, aspect: 1.5, rot: 1.2 },
  { name: 'Port Coral', c: new V2(4200, -700), r: 340, kind: 'port', hill: 90, seed: 63, rough: 0.4 },
  { name: 'Gull Rocks', c: new V2(900, -1500), r: 85, kind: 'islet', hill: 16, seed: 71, aspect: 1.6, rot: 0.3 },
  { name: 'Turtle Cay', c: new V2(-1300, -1600), r: 100, kind: 'islet', hill: 10, seed: 77, aspect: 1.4, rot: -0.8 },
  { name: 'Mermaid Cove', c: new V2(1100, 4200), r: 270, kind: 'cove', hill: 22, seed: 83, aspect: 1.15, rot: 0.5, rough: 0.16 },
  { name: 'Driftwood Isle', c: new V2(-3600, -1900), r: 170, kind: 'sandbar', hill: 18, seed: 89, aspect: 1.3, rot: 0.2 },
];
ISLANDS.forEach(I => {
  if (I.kind !== 'home') { I.c.multiplyScalar(WS); I.r *= IRS; }
  I.hill *= HILLS;
  I.cs = Math.cos(I.rot || 0); I.sn = Math.sin(I.rot || 0); I.nf = 1.6 / I.r; I.rough = I.rough ?? 0.42;
  I.toHome = ISLAND.clone().sub(I.c); if (I.toHome.lengthSq() > 1) I.toHome.normalize(); else I.toHome.copy(DOCK_DIR);
});
const PORT = ISLANDS[5];
const PORT_DOCK_BASE = PORT.c.clone().addScaledVector(PORT.toHome, PORT.r * 0.94 - 20), PORT_DOCK_LEN = 100;
const PORT_FRAME = { origin: PORT_DOCK_BASE.clone().addScaledVector(PORT.toHome, -95), dir: PORT.toHome.clone(), perp: new V2(-PORT.toHome.y, PORT.toHome.x) };
const PORT_BACK = PORT_FRAME.origin.clone().addScaledVector(PORT.toHome, -30);
const PORT_DOCK_FAR = PORT_DOCK_BASE.clone().addScaledVector(PORT.toHome, PORT_DOCK_LEN + 60);
const DOCK_FAR = DOCK_BASE.clone().addScaledVector(DOCK_DIR, DOCK_LEN + 60);
// towns, villages and raider camps: the ground is levelled under each (same list and maths as the game)
const SITES = [
  { i: 0, kind: 'town', name: 'Gull Town', u: 5, r: 96 },
  { i: 5, kind: 'town', name: 'Port Coral', u: 5, r: 96 },
  { i: 0, kind: 'village', name: 'Brackenford', a: 2.3, f: 0.5, r: 64 },
  { i: 2, kind: 'village', name: 'Vinehollow', a: 0.6, f: 0.5, r: 64 },
  { i: 9, kind: 'village', name: 'Saltmarsh', a: 1.5, f: 0.45, r: 60 },
  { i: 3, kind: 'village', name: 'Ashfall', a: -0.35, f: 0.7, r: 60 },
  { i: 8, kind: 'village', name: 'Shellharbor', a: 1.9, f: 0.8, r: 58 },
  { i: 5, kind: 'village', name: 'Coral Heights', a: 2.8, f: 0.45, r: 62 },
  { i: 0, kind: 'camp', name: 'Blackwater raider', a: -2.2, f: 0.45, r: 36, n: 4 },
  { i: 2, kind: 'camp', name: 'Blackwater raider', a: -2.0, f: 0.35, r: 36, n: 5 },
  { i: 3, kind: 'camp', name: 'Blackwater raider', a: 2.6, f: 0.66, r: 36, n: 4 },
  { i: 7, kind: 'camp', name: 'Blackwater raider', a: 0.0, f: 0.2, r: 34, n: 3 },
  { i: 5, kind: 'camp', name: 'Blackwater raider', a: -2.4, f: 0.5, r: 36, n: 4 },
  { i: 6, kind: 'camp', name: 'Blackwater raider', a: 0.0, f: 0.2, r: 32, n: 3 },
  { i: 4, kind: 'fort', name: 'Blackwater soldier', a: 0, f: 0, r: 400, n: 20, A: 390, B: 250, h: 14 },   // Skull Isle: Fort Blackwater, walls round most of the island and a harbour bay
];
const FORT_PIER_ANGLES = [Math.PI * 0.62, Math.PI, Math.PI * 1.38];
ISLANDS.forEach(I => I.sites = []);
SITES.forEach(S => {
  const I = ISLANDS[S.i];
  if (S.kind === 'town') {
    const F = S.i === 0 ? { origin: TOWN, dir: DOCK_DIR } : PORT_FRAME;
    S.x = F.origin.x + F.dir.x * S.u; S.z = F.origin.y + F.dir.y * S.u; S.h = 4.2;
  } else if (S.kind === 'fort') {
    S.x = I.c.x; S.z = I.c.y; S.ux = I.cs; S.uz = I.sn;   // its long axis runs along the island's
  } else {
    const ca = Math.cos(S.a), sa = Math.sin(S.a), dx = I.toHome.x * ca - I.toHome.y * sa, dz = I.toHome.x * sa + I.toHome.y * ca;
    let f = S.f, x = I.c.x + dx * I.r * f, z = I.c.y + dz * I.r * f;
    for (; f > 0.08 && islandHeight(I, x, z, true) < 5; f -= 0.02) { x = I.c.x + dx * I.r * f; z = I.c.y + dz * I.r * f; }
    S.x = x; S.z = z; S.h = Math.max(5.5, Math.min(40, islandHeight(I, x, z, true)));
  }
  I.sites.push(S);
});

function islandHeight(I, x, z, raw) {
  const dx = x - I.c.x, dz = z - I.c.y;
  if (dx * dx + dz * dz > I.r * I.r * 3.4) return -7;
  const ax = dx * I.cs + dz * I.sn, az = (-dx * I.sn + dz * I.cs) * (I.aspect || 1);
  let d = Math.hypot(ax, az) / I.r, amp = I.rough;
  if (I.kind === 'home') amp *= sstep(50, 150, distToSeg(x, z, TOWN_BACK, DOCK_FAR));
  if (I.kind === 'port') amp *= sstep(50, 150, distToSeg(x, z, PORT_BACK, PORT_DOCK_FAR));
  if (amp > 0) d += (fbm(x * I.nf + I.seed, z * I.nf - I.seed) - 0.5) * amp * 2 + (vnoise(x * I.nf * 3.3 + I.seed * 3, z * I.nf * 3.3) - 0.5) * amp * 0.5;
  let s = 1 - d;
  if (I.kind === 'cove') s = (0.24 - Math.abs(d - 0.74)) * 1.7;
  let h = -7 + 11 * sstep(-0.15, 0.2, s);
  h += I.hill * Math.pow(Math.max(0, s - 0.3), 1.4) * (0.5 + 1.0 * fbm(x * 0.006 + I.seed, z * 0.006));
  if (I.kind !== 'volcano' && I.kind !== 'cove') h += I.hill * 0.75 * Math.pow(Math.max(0, fbm(x * 0.003 + I.seed * 1.7, z * 0.003 - I.seed) - 0.35), 1.2) * sstep(0.12, 0.45, s);   // rolling hills
  if (I.kind === 'volcano') {
    h += 300 * Math.pow(Math.max(0, s - 0.22), 1.7);
    h -= 1300 * Math.pow(Math.max(0, s - 0.86), 1.2);
  }
  h += (vnoise(x * 0.08, z * 0.08) - 0.5) * 1.2 * sstep(0, 0.2, s);
  if (I.kind === 'cove') {
    const d0 = Math.hypot(ax, az) / I.r;
    if (d0 < 0.62) h = Math.max(h, -3.3 - (0.62 - d0) * 1.6);
    const a = Math.atan2(dz, dx) - Math.atan2(I.toHome.y, I.toHome.x), am = Math.abs(Math.atan2(Math.sin(a), Math.cos(a)));
    h += (-4.8 - h) * sstep(0.42, 0.22, am) * sstep(1.3, 1.0, d0);
    h = Math.max(h, 3.4 - d0 * 40);
  }
  if (I.kind === 'home') {
    const dd = distToSeg(x, z, TOWN_BACK, DOCK_BASE), w = sstep(42, 30, dd) * sstep(-3, 1.5, h);
    h += (4.2 - h) * w;
  }
  if (I.kind === 'port') {
    const dd = distToSeg(x, z, PORT_BACK, PORT_DOCK_BASE), w = sstep(46, 34, dd) * sstep(-3, 1.5, h);
    h += (4.2 - h) * w;
  }
  if (!raw && I.sites) for (const S of I.sites) {
    if (S.kind === 'fort') { h = fortHeight(S, x, z, h); continue; }
    const dd = Math.hypot(x - S.x, z - S.z);
    if (dd < S.r + 30) { const w = sstep(S.r + 30, S.r, dd) * sstep(-3, 1.5, h); h += (S.h - h) * w; }
  }
  return h;
}
// ---------- The Mistwrack Shoals: a wide field of sea stacks and reefs in the south-west, always shrouded in fog ----------
// Part of the terrain itself (heightAt), so ships, raiders, cannonballs, the kraken and the autopilot all treat the rocks as solid.
// The server builds the very same rocks from the same seed (world.js); keep the two in step.
const EDGE = 14400;   // keep in step with the game: the edge of the charted sea
const MIST = { x: -12900, z: 12900, r: 1350, rocks: [], name: 'The Mistwrack Shoals' };
{
  let s = 917; const mr = () => (s = (s * 16807) % 2147483647) / 2147483647;
  const J = ISLANDS[2], jx = J.c.x, jz = J.c.y, jr = J.r * 1.7 + 120;
  // mountains of rock rising sheer out of the sea, with smaller stacks between them and channels wide enough to sail
  for (let tries = 0; tries < 8000 && MIST.rocks.length < 52; tries++) {
    const a = mr() * Math.PI * 2, d = Math.sqrt(mr()) * MIST.r, x = MIST.x + Math.cos(a) * d, z = MIST.z + Math.sin(a) * d;
    const big = MIST.rocks.length < 14, r = big ? 110 + mr() * 85 : 34 + mr() * 42, hp = big ? 140 + mr() * 150 : 26 + mr() * 60;
    if (Math.abs(x) > EDGE - 120 || Math.abs(z) > EDGE - 120 || Math.hypot(x - jx, z - jz) < jr + r) continue;
    if (Math.hypot(x - MIST.x, z - MIST.z) < r + 150) continue;   // keep clear water round the Serpent Spire
    if (MIST.rocks.some(o => Math.hypot(o.x - x, o.z - z) < o.r + r + 75)) continue;
    MIST.rocks.push({ x, z, r, hp, e: big ? 0.85 : 0.6, sx: 0.8 + mr() * 0.45, rot: mr() * 6.28 });
  }
}
// a sea stack rises steeply from the sea floor (-7) to its peak; slightly oval so they don't all look turned on a lathe
function mistRockH(x, z) {
  const dx0 = x - MIST.x, dz0 = z - MIST.z;
  if (dx0 * dx0 + dz0 * dz0 > (MIST.r + 70) * (MIST.r + 70)) return -100;
  let h = -100;
  for (const o of MIST.rocks) {
    const dx = x - o.x, dz = z - o.z; if (dx > o.r || dx < -o.r || dz > o.r || dz < -o.r) continue;
    const c = Math.cos(o.rot), sn = Math.sin(o.rot), u = (dx * c + dz * sn) / o.sx, v = (-dx * sn + dz * c) * o.sx, d = Math.hypot(u, v);
    if (d >= o.r) continue;
    const v2 = -7 + (o.hp + 7) * Math.pow(1 - d / o.r, o.e); if (v2 > h) h = v2;
  }
  return h;
}
// the Serpent Spire stands in the heart of the shoals on a round stone skerry: flat on top, sloping into the sea like a beach
const TOWER = { x: MIST.x, z: MIST.z, flat: 46, foot: 80, top: 3.2 };
function towerH(x, z) {
  const d = Math.hypot(x - TOWER.x, z - TOWER.z); if (d > TOWER.foot) return -100;
  return -7 + (TOWER.top + 7) * sstep(TOWER.foot, TOWER.flat, d);
}
// Fort Blackwater's ground: everything inside its elliptical wall is levelled (filling any sea), the ground eases
// back down outside, and a harbour bay is dug into the long end: a round basin with a channel out to sea.
function fortLocal(S, x, z) { const dx = x - S.x, dz = z - S.z; return [dx * S.ux + dz * S.uz, -dx * S.uz + dz * S.ux]; }
function fortBayDist(S, u, v) {
  const bu = S.A * 0.6, d1 = Math.hypot(u - bu, v) - 120;                       // the basin
  const t = Math.max(0, Math.min(1, (u - bu) / (S.A + 140 - bu))), d2 = Math.hypot(u - (bu + (S.A + 140 - bu) * t), v) - 42;   // the channel out
  return Math.min(d1, d2);
}
function fortHeight(S, x, z, h) {
  const dx = x - S.x, dz = z - S.z; if (dx * dx + dz * dz > (S.A + 200) * (S.A + 200)) return h;
  const [u, v] = fortLocal(S, x, z), e = (Math.hypot(u / S.A, v / S.B) - 1) * S.B;   // roughly metres outside the wall line
  const w = sstep(60, 6, e); h += (S.h - h) * w;
  // the harbour: a low quayside terrace round the basin (at dock level), ramping up to the fort, then a sheer quay wall into deep water
  const db = fortBayDist(S, u, v);
  if (db < 95 && w > 0.01) h += (4.2 + (S.h - 4.2) * sstep(55, 95, db) - h) * w;
  if (db < 4) h += (-7.6 - h) * sstep(4, -1, db);
  return h;
}
function heightAt(x, z) { let h = Math.max(mistRockH(x, z), towerH(x, z)); for (const I of ISLANDS) { const v = islandHeight(I, x, z); if (v > h) h = v; } return h; }

const DOCK_TOP = DECK_Y + 0.25;
const DOCKS = [
  { base: DOCK_BASE, dir: DOCK_DIR, perp: PERP, len: DOCK_LEN, hw: DOCK_HW, head: DOCK_HEAD, headLen: DOCK_HEADLEN },
  { base: PORT_DOCK_BASE, dir: PORT.toHome, perp: PORT_FRAME.perp, len: PORT_DOCK_LEN, hw: DOCK_HW, head: 18, headLen: 12 },
];
// Fort Blackwater's harbour piers (keep in step with the other side): out from the quay toward the middle of the basin
for (const S of SITES) if (S.kind === 'fort') for (const a of FORT_PIER_ANGLES) {
  const bu = S.A * 0.6, cx = S.x + S.ux * bu, cz = S.z + S.uz * bu, ox = Math.cos(a), ov = Math.sin(a);   // pier root direction from the basin centre (fort-local)
  const wx = S.ux * ox - S.uz * ov, wz = S.uz * ox + S.ux * ov, base = new V2(cx + wx * 121, cz + wz * 121), dir = new V2(-wx, -wz);
  DOCKS.push({ base, dir, perp: new V2(-dir.y, dir.x), len: 62, hw: 4, head: 11, headLen: 8, fort: true });
}
DOCKS.forEach(d => d.rr = Math.pow(d.len + d.headLen + d.head + 8, 2));
function onDock(x, z) {
  for (const d of DOCKS) {
    const px = x - d.base.x, pz = z - d.base.y;
    if (px * px + pz * pz > d.rr) continue;
    const lx = -(px * d.perp.x + pz * d.perp.y), lz = px * d.dir.x + pz * d.dir.y;
    if ((Math.abs(lx) <= d.hw && lz >= -3 && lz <= d.len + 1) || (Math.abs(lx) <= d.head && lz >= d.len - 1 && lz <= d.len + d.headLen)) return true;
  }
  return false;
}
const walkable = (x, z) => { if (onDock(x, z)) return true; const h = heightAt(x, z); return h > 0.6 && h < 300; };

// --- Skull Isle "X marks the spot" (the Blackwater thugs camp next to it) ---
const SPOT_X = (() => {
  const I = ISLANDS[4], toHome = ISLAND.clone().sub(I.c).normalize();
  let xp = I.c.clone().addScaledVector(toHome, -I.r * 0.35);
  for (let t = 0.35; t > 0 && heightAt(xp.x, xp.y) < 4.5; t -= 0.02) xp = I.c.clone().addScaledVector(toHome, -I.r * t);
  return { x: xp.x, z: xp.y };
})();

// --- Bandit camps: same order and layout as makeCamp() in the client, so bandit indexes match ---
function landNear(cx, cz, lo, hi) {
  for (let r = 0; r < 200; r += 4) for (let a = 0; a < 6.28; a += 0.4) { const x = cx + Math.cos(a) * r, z = cz + Math.sin(a) * r, h = heightAt(x, z); if (h >= lo && h <= hi) return { x, z }; }
  return { x: cx, z: cz };
}
const campColliders = [];
function campBandits(near, n, name) {
  const c = landNear(near.x, near.z, 4, 16), out = [];
  [[6, 2], [-5, 4]].forEach(([dx, dz]) => campColliders.push({ x: c.x + dx, z: c.z + dz, r: 2.6 }));
  campColliders.push({ x: c.x, z: c.z, r: 1.0 });
  for (let i = 0; i < n; i++) { const a = i / n * 6.28; out.push({ name, home: { x: c.x, z: c.z }, x: c.x + Math.cos(a) * 5, z: c.z + Math.sin(a) * 5, facing: a }); }
  return out;
}
// the Blackwater raider camps on the sites (same tent spots as the game's raiderCamp)
const CAMP_TENTS = [[9, 3], [-8, 6], [2, -10], [-7, -7]];
function siteCamp(S) {
  const c = { x: S.x, z: S.z }, out = [];
  CAMP_TENTS.forEach(([dx, dz]) => campColliders.push({ x: c.x + dx, z: c.z + dz, r: 2.6 }));
  campColliders.push({ x: c.x, z: c.z, r: 1.4 });
  for (let i = 0; i < S.n; i++) { const a = i / S.n * 6.28; out.push({ name: S.name, home: { x: c.x, z: c.z }, x: c.x + Math.cos(a) * 5, z: c.z + Math.sin(a) * 5, facing: a }); }
  return out;
}
// the fortress garrison: soldiers posted round the fort (same posts as the game's buildFort), each keeping to their post
function fortPosts(S) {
  const out = [];
  for (let i = 0; i < S.n; i++) {
    const f = [0.22, 0.48, 0.74][i % 3], a = i / S.n * 6.28 + 0.3;
    let u = S.A * f * Math.cos(a), v = S.B * f * Math.sin(a);
    if (fortBayDist(S, u, v) < 25) u = -u;   // not in the harbour
    out.push([S.x + S.ux * u - S.uz * v, S.z + S.uz * u + S.ux * v, a]);
  }
  return out;
}
function fortGarrison(S) { return fortPosts(S).map(([x, z, a]) => ({ name: S.name, home: { x: S.x, z: S.z }, post: { x, z }, x, z, facing: a })); }
const BANDIT_SPAWNS = [
  ...campBandits({ x: ISLANDS[9].c.x, z: ISLANDS[9].c.y }, 4, 'Bandit'),
  ...campBandits({ x: SPOT_X.x + 14, z: SPOT_X.z + 10 }, 3, 'Blackwater thug'),
  ...SITES.filter(S => S.kind === 'camp').flatMap(siteCamp),
  ...SITES.filter(S => S.kind === 'fort').flatMap(fortGarrison),
];

// --- Raiders: same order as the client's raider list ---
const HULLS = { brig: { L: 27, B: 7.6 }, galleon: { L: 40, B: 11 } };
const RAIDER_SPAWNS = [[2500, -1700, 'brig'], [-2300, -700, 'brig'], [3200, 1400, 'brig'], [-3400, 3400, 'brig'], [1800, 3600, 'brig'], [-3600, -3200, 'galleon'], [3800, -3800, 'galleon'], [300, -2400, 'galleon']]
  .map(([x, z, kind]) => [x * WS, z * WS, kind]).map(([x, z, kind]) => ({ home: { x, z }, kind, T: HULLS[kind], galleon: kind === 'galleon', maxHp: kind === 'galleon' ? 520 : 230 }))
  // the Blackwater raid fleet: 16 more ships that only put to sea during a Blackwater raid (keep in step with the game)
  .concat(Array.from({ length: 16 }, (_, k) => { const kind = k % 3 === 2 ? 'galleon' : 'brig', I = ISLANDS[4], a = k / 16 * Math.PI * 2; return { home: { x: I.c.x + Math.cos(a) * I.r * 2, z: I.c.y + Math.sin(a) * I.r * 2 }, kind, T: HULLS[kind], galleon: kind === 'galleon', maxHp: kind === 'galleon' ? 520 : 230, raid: true }; }));

function blockedAt(T, cx, cz, h) {
  const s = Math.sin(h), c = Math.cos(h);
  return [[0, T.L / 2 + 1], [0, -T.L / 2], [T.B / 2, 0], [-T.B / 2, 0], [T.B * 0.35, T.L * 0.3], [-T.B * 0.35, T.L * 0.3]]
    .some(([lx, lz]) => { const wx = cx + lx * c + lz * s, wz = cz - lx * s + lz * c; return heightAt(wx, wz) > -2.2 || onDock(wx, wz); });
}
const raidSea = (x, z) => Math.abs(x) < EDGE - 300 && Math.abs(z) < EDGE - 300 && heightAt(x, z) < -6.5 && ISLANDS.every(I => Math.hypot(x - I.c.x, z - I.c.y) > I.r * 1.25 + 60);

module.exports = { WS, ISLANDS, SITES, fortPosts, fortLocal, fortBayDist, EDGE, MIST, TOWER, heightAt, onDock, walkable, blockedAt, raidSea, campColliders, BANDIT_SPAWNS, RAIDER_SPAWNS, SPOT_X };
