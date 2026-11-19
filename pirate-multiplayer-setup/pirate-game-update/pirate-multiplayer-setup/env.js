// Shared day/night clock and weather for the whole server.
// The natural clock and weather cycle always keep running underneath. An admin can override
// the time (shifts the clock, which keeps ticking from there) and lock the weather.
// "Back to normal" drops both overrides, so everyone returns to the natural time and weather.
'use strict';

const DAY_LEN = 840;   // seconds for a full in-game day (same as the client)
const WEATHERS = ['clear', 'cloudy', 'rain', 'storm', 'fog'];
const NEXT_WEATHER = { clear: [['clear', 2], ['cloudy', 5], ['fog', 1.2]], cloudy: [['clear', 3], ['rain', 3], ['storm', 1], ['fog', 1.5]], rain: [['cloudy', 4], ['storm', 2.5], ['rain', 1.5]], storm: [['rain', 6], ['cloudy', 2]], fog: [['clear', 3], ['cloudy', 3]] };
const wrap24 = h => ((h % 24) + 24) % 24;

function createEnv() {
  let natTime = 9, natDay = 1, natWx = 'clear', wxT = 150 + Math.random() * 200;
  let timeOff = 0, wxLock = null;
  const pick = () => {
    const opts = NEXT_WEATHER[natWx]; let r = Math.random() * opts.reduce((a, o) => a + o[1], 0);
    for (const [k, w] of opts) if ((r -= w) <= 0) return k;
    return 'clear';
  };
  return {
    tick(dt) {
      natTime += dt * 24 / DAY_LEN;
      if (natTime >= 24) { natTime -= 24; natDay++; }
      wxT -= dt;
      if (wxT <= 0) { wxT = 150 + Math.random() * 220; natWx = pick(); }
    },
    snapshot() {
      const t = natTime + timeOff;
      return { t: Math.round(wrap24(t) * 1000) / 1000, d: natDay + Math.floor(t / 24), w: wxLock || natWx, ot: timeOff !== 0 ? 1 : 0, ow: wxLock ? 1 : 0 };
    },
    // returns true if anything changed
    admin(d) {
      if (!d || typeof d !== 'object') return false;
      if (d.reset) { timeOff = 0; wxLock = null; return true; }
      let changed = false;
      if (typeof d.time === 'number' && d.time >= 0 && d.time < 24) {
        let off = d.time - natTime; if (off < 0) off += 24;   // always move the clock forward, like waiting
        timeOff = off; changed = true;
      }
      if (typeof d.weather === 'string' && WEATHERS.includes(d.weather)) { wxLock = d.weather; changed = true; }
      return changed;
    },
  };
}

module.exports = { createEnv };
