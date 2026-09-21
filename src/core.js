/* ============================================================
   core.js — 确定性随机、噪声、事件总线、工具函数
   联机一致性前提：所有程序化内容必须走这里，禁止 Math.random()
   ============================================================ */
(function () {
  const ROOT = (typeof window !== 'undefined') ? window : globalThis;
  const PP = (ROOT.PP = ROOT.PP || {});
  const Core = (PP.Core = {});

  /* ---------------- 种子随机 ---------------- */
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  Core.mulberry32 = mulberry32;

  class Rng {
    constructor(seed) { this.seed = seed >>> 0; this.f = mulberry32(this.seed); }
    next() { return this.f(); }
    range(a, b) { return a + this.f() * (b - a); }
    int(n) { return (this.f() * n) | 0; }
    chance(p) { return this.f() < p; }
    pick(arr) { return arr[(this.f() * arr.length) | 0]; }
    sign() { return this.f() < 0.5 ? -1 : 1; }
  }
  Core.Rng = Rng;

  /* ---------------- 确定性哈希噪声 ---------------- */
  function h2(x, y, s) {
    let n = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 1274126177);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  }
  Core.h2 = h2;

  function smooth(t) { return t * t * (3 - 2 * t); }

  Core.noise2 = function (x, y, seed) {
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const fx = smooth(x - x0), fy = smooth(y - y0);
    const a = h2(x0, y0, seed), b = h2(x0 + 1, y0, seed);
    const c = h2(x0, y0 + 1, seed), d = h2(x0 + 1, y0 + 1, seed);
    return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
  };

  Core.fbm = function (x, y, seed, octaves) {
    let v = 0, amp = 1, freq = 1, norm = 0;
    const o = octaves || 4;
    for (let i = 0; i < o; i++) {
      v += Core.noise2(x * freq, y * freq, seed + i * 9176) * amp;
      norm += amp; amp *= 0.5; freq *= 2;
    }
    return v / norm;
  };

  /* ---------------- 事件总线 ---------------- */
  class Bus {
    constructor() { this.map = new Map(); }
    on(type, fn) {
      if (!this.map.has(type)) this.map.set(type, []);
      this.map.get(type).push(fn);
      return () => this.off(type, fn);
    }
    off(type, fn) {
      const l = this.map.get(type); if (!l) return;
      const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1);
    }
    emit(type, payload) {
      const l = this.map.get(type); if (!l) return;
      for (let i = 0; i < l.length; i++) l[i](payload);
    }
    clear() { this.map.clear(); }
  }
  Core.Bus = Bus;

  /* ---------------- 工具 ---------------- */
  let _uid = 1;
  Core.uid = function () { return _uid++; };
  Core.clamp = function (v, a, b) { return v < a ? a : (v > b ? b : v); };
  Core.lerp = function (a, b, t) { return a + (b - a) * t; };
  Core.wrapAngle = function (a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  };
  Core.now = function () {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
  };
})();
