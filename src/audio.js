/* ============================================================
   audio.js — 纯 WebAudio 合成音效（零外部资源）
   ============================================================ */
(function () {
  const ROOT = (typeof window !== 'undefined') ? window : globalThis;
  const PP = (ROOT.PP = ROOT.PP || {});
  const A = (PP.Audio = {});

  let ctx = null, master = null, noiseBuf = null, muted = false;
  let volume = 0.6;

  A.setVolume = function (v) {
    volume = Math.max(0, Math.min(1, v === undefined ? 0.6 : v));
    if (master) master.gain.value = muted ? 0 : volume * 0.75;
  };
  A.getVolume = function () { return volume; };
  A.setMuted = function (m) {
    muted = !!m;
    if (master) master.gain.value = muted ? 0 : volume * 0.75;
  };
  A.toggleMute = function () { A.setMuted(!muted); return muted; };

  A.init = function () {
    if (ctx) return true;
    try {
      const AC = ROOT.AudioContext || ROOT.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : volume * 0.75;
      master.connect(ctx.destination);
      const len = ctx.sampleRate | 0;
      noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    } catch (e) { ctx = null; return false; }
    return true;
  };

  A.resume = function () { if (ctx && ctx.state === 'suspended') ctx.resume(); };
  A.isMuted = function () { return muted; };

  function ready() { return !!ctx && !muted; }
  function tone(type, f0, f1, dur, vol, delay) {
    if (!ready()) return;
    const t = ctx.currentTime + (delay || 0);
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + Math.min(0.012, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(master);
    o.start(t); o.stop(t + dur + 0.02);
  }
  function noise(dur, vol, f0, f1, q, delay, type) {
    if (!ready()) return;
    const t = ctx.currentTime + (delay || 0);
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf; s.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = type || 'lowpass';
    bp.frequency.setValueAtTime(f0, t);
    if (f1 && f1 !== f0) bp.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    bp.Q.value = q || 1;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(bp); bp.connect(g); g.connect(master);
    s.start(t); s.stop(t + dur + 0.02);
  }

  A.shotPistol = function () {
    noise(0.09, 0.55, 4200, 500, 1, 0);
    tone('square', 320, 70, 0.10, 0.30);
    tone('triangle', 900, 180, 0.06, 0.18);
  };
  A.shotShotgun = function () {
    noise(0.26, 0.85, 3000, 160, 0.7, 0);
    tone('sawtooth', 180, 38, 0.28, 0.42);
    tone('square', 90, 30, 0.22, 0.22, 0.01);
  };
  A.shotPulse = function () {
    tone('square', 1400, 260, 0.09, 0.22);
    tone('sawtooth', 700, 140, 0.13, 0.16);
    noise(0.10, 0.28, 2600, 700, 3, 0, 'bandpass');
  };
  A.shotSniper = function () {
    noise(0.18, 0.70, 5200, 400, 0.8, 0);
    tone('square', 220, 48, 0.22, 0.40);
    tone('triangle', 1200, 160, 0.10, 0.18);
  };
  A.shotMagma = function () {
    noise(0.07, 0.32, 900, 280, 0.6, 0);
    tone('sawtooth', 140, 70, 0.08, 0.14);
    noise(0.05, 0.18, 2200, 900, 2, 0.02, 'bandpass');
  };
  A.creeperHiss = function () {
    noise(0.85, 0.28, 1800, 420, 1.2, 0, 'bandpass');
    tone('sine', 90, 55, 0.85, 0.10);
  };
  A.creeperBoom = function () {
    noise(0.45, 0.85, 2400, 80, 0.6, 0);
    tone('sawtooth', 140, 28, 0.40, 0.45);
    tone('square', 80, 24, 0.35, 0.28, 0.02);
  };
  A.bow = function () {
    noise(0.07, 0.18, 1800, 600, 3, 0, 'bandpass');
    tone('triangle', 520, 260, 0.10, 0.10);
  };
  A.dryFire = function () { tone('square', 220, 120, 0.035, 0.14); noise(0.03, 0.14, 1800, 900, 2, 0); };
  A.reload = function (dur) {
    tone('square', 180, 120, 0.05, 0.16, 0);
    tone('square', 140, 320, 0.07, 0.18, (dur || 1) * 0.55);
    tone('square', 420, 620, 0.05, 0.14, (dur || 1) * 0.8);
  };
  A.hit = function () { tone('square', 640, 900, 0.05, 0.20); noise(0.05, 0.22, 2400, 800, 2, 0); };
  A.headshot = function () { tone('square', 900, 1600, 0.06, 0.24); tone('square', 1400, 2400, 0.07, 0.16, 0.05); };
  A.enemyDie = function () { noise(0.34, 0.42, 1400, 90, 0.8, 0); tone('sawtooth', 220, 44, 0.32, 0.24); };
  A.enemyGrowl = function () { tone('sawtooth', 110, 62, 0.34, 0.13); noise(0.28, 0.12, 700, 220, 1, 0); };
  A.playerHurt = function () { tone('sine', 160, 60, 0.22, 0.36); noise(0.18, 0.30, 900, 160, 1, 0); };
  A.pickup = function () { tone('square', 660, 660, 0.07, 0.18); tone('square', 990, 990, 0.09, 0.16, 0.06); };
  A.pickupBig = function () {
    tone('square', 440, 440, 0.08, 0.18);
    tone('square', 660, 660, 0.08, 0.18, 0.07);
    tone('square', 880, 880, 0.12, 0.18, 0.14);
  };
  A.waveStart = function () {
    tone('sawtooth', 110, 110, 0.5, 0.16);
    tone('sawtooth', 165, 165, 0.5, 0.14, 0.02);
    tone('square', 55, 55, 0.6, 0.18, 0.02);
  };
  A.waveClear = function () { [523, 659, 784, 1046].forEach((f, i) => tone('square', f, f, 0.14, 0.16, i * 0.09)); };
  A.gameOver = function () {
    [440, 349, 261, 174].forEach((f, i) => tone('sawtooth', f, f * 0.94, 0.4, 0.20, i * 0.18));
    noise(0.9, 0.2, 800, 60, 1, 0.5);
  };
  A.spawn = function () { tone('sawtooth', 70, 240, 0.28, 0.13); noise(0.2, 0.12, 400, 1600, 2, 0, 'bandpass'); };
  A.switchWeapon = function () { tone('square', 300, 520, 0.06, 0.13); };
})();
