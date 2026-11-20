// Player accounts, kept on the server: a name (unique, case-insensitive), a password (salted scrypt hash, never stored
// in the clear), login tokens, and each captain's save. Everything lives in one JSON file, written atomically a moment
// after each change.
//
// Where it's kept (pick one):
//  - Upstash Redis (free, survives everything): set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.
//  - A file: DATA_DIR (env var), default ./data next to this file. On Render the normal filesystem is wiped on every
//    deploy, restart and free-plan sleep, so only use this with a persistent disk mounted at DATA_DIR.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _'-]{1,15}$/;
const MAX_SAVE = 400 * 1024;   // bytes of JSON per captain
const MAX_TOKENS = 6;          // devices that can stay logged in at once

// ---- storage backends ----
function fileStore(dir) {
  const file = path.join(dir, 'accounts.json');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  return {
    where: file,
    async loadAll() { try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return d && typeof d.accounts === 'object' ? d.accounts : {}; } catch (e) { return {}; } },
    async write(all) { const tmp = file + '.tmp'; await fs.promises.writeFile(tmp, JSON.stringify({ accounts: all })); await fs.promises.rename(tmp, file); },   // never half-written
    writeSync(all) { fs.writeFileSync(file + '.tmp', JSON.stringify({ accounts: all })); fs.renameSync(file + '.tmp', file); },
  };
}
// Upstash Redis over its REST API (plain fetch, no extra packages): one key per captain plus an index of names
function redisStore(url, token) {
  const call = async cmd => {
    const r = await fetch(url.replace(/\/$/, ''), { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(cmd) });
    const j = await r.json(); if (j.error) throw new Error(j.error); return j.result;
  };
  return {
    where: 'Upstash Redis',
    async loadAll() {
      const keys = await call(['SMEMBERS', 'pg:index']) || [], out = {};
      for (let i = 0; i < keys.length; i += 100) {
        const part = keys.slice(i, i + 100), vals = await call(['MGET', ...part.map(k => 'pg:acct:' + k)]);
        part.forEach((k, j) => { try { if (vals[j]) out[k] = JSON.parse(vals[j]); } catch (e) {} });
      }
      return out;
    },
    async writeSome(all, keys) { for (const k of keys) { if (!all[k]) continue; await call(['SET', 'pg:acct:' + k, JSON.stringify(all[k])]); await call(['SADD', 'pg:index', k]); } },
  };
}

function createAccounts({ dir, reserved = {} }) {
  const U = process.env.UPSTASH_REDIS_REST_URL, UT = process.env.UPSTASH_REDIS_REST_TOKEN;
  const store = U && UT ? redisStore(U, UT) : fileStore(dir);
  const db = { accounts: {} }, byToken = new Map();
  let ready = false, loadErr = null;
  // load everything at start-up; if the store can't be reached, keep retrying (logins wait until it works)
  const tryLoad = () => store.loadAll().then(all => {
    db.accounts = all || {};
    for (const [key, a] of Object.entries(db.accounts)) for (const t of a.tokens || []) byToken.set(t, key);
    ready = true; loadErr = null; console.log(`Accounts: ${Object.keys(db.accounts).length} loaded from ${store.where}`);
  }).catch(e => { loadErr = e.message; console.error(`Accounts: could not load from ${store.where}: ${e.message}. Retrying in 15s.`); setTimeout(tryLoad, 15000); });
  const loaded = tryLoad();
  if (store.where !== 'Upstash Redis' && process.env.RENDER && !process.env.DATA_DIR) console.warn('Accounts: saving to the ordinary disk on Render, which is wiped on every restart. Set up Upstash Redis or a persistent disk (see accounts.js).');

  // write changes a moment later (batched); retried if the store is briefly unreachable
  let timer = null; const dirty = new Set();
  function persist(key) {
    if (key) dirty.add(key);
    if (timer) return;
    timer = setTimeout(async () => {
      timer = null; const keys = [...dirty]; dirty.clear();
      try { if (store.writeSome) await store.writeSome(db.accounts, keys); else await store.write(db.accounts); }
      catch (e) { console.error('Could not save accounts:', e.message); keys.forEach(k => dirty.add(k)); setTimeout(() => persist(), 5000); }
    }, 800);
  }
  function flushSync() { if (store.writeSync) { if (timer) { clearTimeout(timer); timer = null; } try { store.writeSync(db.accounts); } catch (e) { console.error('Could not save accounts:', e.message); } } }

  const hash = (pw, salt) => crypto.scryptSync(String(pw), salt, 32).toString('hex');
  const keyOf = name => String(name || '').trim().toLowerCase();
  function newToken(key) {
    const a = db.accounts[key], t = crypto.randomBytes(24).toString('hex');
    a.tokens = (a.tokens || []).concat(t);
    while (a.tokens.length > MAX_TOKENS) byToken.delete(a.tokens.shift());
    byToken.set(t, key); persist(key);
    return t;
  }
  const pub = (key, token) => { const a = db.accounts[key]; return { name: a.name, token, save: a.save || null }; };

  const notReady = () => ({ err: loadErr ? `The server can't open its account storage (${store.where}: ${loadErr}). Check the storage settings in Render.` : 'The server is still starting up. Try again in a moment.' });
  return {
    ready: () => ready, loaded, status: () => ({ ready, store: store.where, error: loadErr, accounts: Object.keys(db.accounts).length, persistent: store.where === 'Upstash Redis' || !!process.env.DATA_DIR }),
    register(name, pw) {
      if (!ready) return notReady();
      name = String(name || '').trim().replace(/\s+/g, ' ');
      if (!NAME_RE.test(name)) return { err: 'Names are 2 to 16 letters, numbers, spaces, - _ or \'.' };
      if (String(pw || '').length < 4) return { err: 'Pick a password of at least 4 characters.' };
      const key = keyOf(name);
      if (db.accounts[key]) return { err: 'That name is already taken. Log in, or choose another name.' };
      if (reserved[key] !== undefined && reserved[key] !== null && String(pw) !== reserved[key]) return { err: 'That name is reserved. Its password must be the owner password (OWNER_PASSWORD in Render).' };
      const salt = crypto.randomBytes(16).toString('hex');
      db.accounts[key] = { name, salt, hash: hash(pw, salt), save: null, created: Date.now(), tokens: [] };
      persist(key);
      return pub(key, newToken(key));
    },
    login(name, pw) {
      if (!ready) return notReady();
      const key = keyOf(name), a = db.accounts[key];
      if (!a) return { err: `There's no captain called "${String(name).trim()}" yet. Click Create account to make one.`, noAccount: true };
      if (hash(pw, a.salt) !== a.hash) return { err: 'Wrong password for that captain.' };
      return pub(key, newToken(key));
    },
    me(token) { const key = byToken.get(String(token || '')); return key && db.accounts[key] ? pub(key, token) : null; },
    nameFor(token) { const key = byToken.get(String(token || '')); return key && db.accounts[key] ? db.accounts[key].name : null; },
    logout(token) { const key = byToken.get(String(token || '')); if (!key) return; const a = db.accounts[key]; a.tokens = (a.tokens || []).filter(t => t !== token); byToken.delete(token); persist(key); },
    save(token, data) {
      const key = byToken.get(String(token || '')); if (!key || !db.accounts[key]) return { err: 'Not logged in.' };
      if (!data || typeof data !== 'object' || Array.isArray(data)) return { err: 'Bad save.' };
      const s = JSON.stringify(data); if (s.length > MAX_SAVE) return { err: 'Save too large.' };
      db.accounts[key].save = JSON.parse(s); db.accounts[key].saved = Date.now(); persist(key);
      return { ok: true };
    },
    flushSync,
    count: () => Object.keys(db.accounts).length,
  };
}
module.exports = { createAccounts };
