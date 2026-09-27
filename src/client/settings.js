/* ============================================================
   settings.js — 设置：键位 / 画质 / 音效 / 鼠标灵敏度 / 友伤
   持久化到 localStorage；键位支持重新绑定（含冲突检测）
   ============================================================ */
(function () {
  const ROOT = (typeof window !== 'undefined') ? window : globalThis;
  const PP = (ROOT.PP = ROOT.PP || {});
  const S = (PP.Settings = {});

  const KEY = 'blockwild_settings_v1';

  const DEFAULT_KEYS = {
    fwd: 'w', back: 's', left: 'a', right: 'd',
    turnL: 'q', turnR: 'e', sprint: 'shift',
    reload: 'r', revive: 'f', pause: 'p', mute: 'm',
    w1: '1', w2: '2', w3: '3', w4: '4', w5: '5'
  };

  const DEFAULTS = {
    volume: 0.6,
    muted: false,
    quality: 1,
    mouseSens: 1.0,
    friendlyFire: 0.35,
    keys: Object.assign({}, DEFAULT_KEYS)
  };

  S.data = JSON.parse(JSON.stringify(DEFAULTS));
  S.DEFAULT_KEYS = DEFAULT_KEYS;

  const NICE = {
    fwd: '前进', back: '后退', left: '左移', right: '右移',
    turnL: '左转', turnR: '右转', sprint: '疾跑',
    reload: '装填', revive: '救援', pause: '暂停', mute: '静音',
    w1: '武器 1', w2: '武器 2', w3: '武器 3', w4: '武器 4', w5: '武器 5'
  };
  S.NICE = NICE;

  S.load = function () {
    S._hasSaved = false;
    try {
      const raw = ROOT.localStorage && ROOT.localStorage.getItem(KEY);
      if (raw) {
        const o = JSON.parse(raw);
        S.data = Object.assign(JSON.parse(JSON.stringify(DEFAULTS)), o);
        S.data.keys = Object.assign({}, DEFAULT_KEYS, o.keys || {});
        S._hasSaved = true;
      }
    } catch (e) { }
    return S.data;
  };
  S.save = function () {
    try {
      if (ROOT.localStorage) ROOT.localStorage.setItem(KEY, JSON.stringify(S.data));
    } catch (e) { }
  };
  S.reset = function () {
    S.data = JSON.parse(JSON.stringify(DEFAULTS));
    S.save();
  };
  S.key = function (action) { return S.data.keys[action] || DEFAULT_KEYS[action] || ''; };

  /* ---------------- UI ---------------- */
  let root = null, opened = false, rebinding = null;

  function el(id) { return document.getElementById(id); }
  function label(k) {
    k = (k || '').toLowerCase();
    if (k === 'shift') return 'SHIFT';
    if (k === ' ') return 'SPACE';
    if (k === 'control') return 'CTRL';
    return k.toUpperCase();
  }
  S.label = label;

  S.open = function () {
    if (!root) return;
    root.classList.remove('hide');
    opened = true;
    renderKeys();
    syncUI();
  };
  S.close = function () {
    if (!root) return;
    root.classList.add('hide');
    opened = false;
    rebinding = null;
  };
  S.isOpen = function () { return opened; };

  function renderKeys() {
    const box = el('set-keys');
    if (!box) return;
    box.innerHTML = '';
    for (const action in NICE) {
      const row = document.createElement('div');
      row.className = 'krow';
      const nm = document.createElement('span');
      nm.textContent = NICE[action];
      const btn = document.createElement('button');
      btn.className = 'kbtn';
      btn.textContent = label(S.data.keys[action]);
      btn.addEventListener('click', () => {
        if (rebinding === action) { rebinding = null; btn.textContent = label(S.data.keys[action]); return; }
        rebinding = action;
        btn.textContent = '按任意键…';
        btn.classList.add('wait');
      });
      row.appendChild(nm); row.appendChild(btn);
      box.appendChild(row);
    }
    const rst = document.createElement('button');
    rst.className = 'kbtn reset';
    rst.textContent = '恢复默认键位';
    rst.addEventListener('click', () => { S.data.keys = Object.assign({}, DEFAULT_KEYS); S.save(); renderKeys(); });
    box.appendChild(rst);
  }

  function syncUI() {
    const v = el('set-volume'); if (v) v.value = String(Math.round(S.data.volume * 100));
    const vt = el('set-volume-txt'); if (vt) vt.textContent = Math.round(S.data.volume * 100) + '%';
    const s = el('set-sens'); if (s) s.value = String(S.data.mouseSens);
    const st = el('set-sens-txt'); if (st) st.textContent = S.data.mouseSens.toFixed(2) + 'x';
    const q = el('set-quality'); if (q) q.value = String(S.data.quality);
    const m = el('set-mute'); if (m) m.checked = !!S.data.muted;
  }

  S.init = function () {
    root = el('settings');
    if (!root) return;
    S.load();

    const vol = el('set-volume');
    if (vol) vol.addEventListener('input', () => {
      S.data.volume = Number(vol.value) / 100;
      if (!S.data.muted) PP.Audio.setVolume(S.data.volume);
      const t = el('set-volume-txt'); if (t) t.textContent = Math.round(S.data.volume * 100) + '%';
      S.save();
    });
    const mute = el('set-mute');
    if (mute) mute.addEventListener('change', () => {
      S.data.muted = mute.checked;
      PP.Audio.setMuted(S.data.muted);
      S.save();
    });
    const sens = el('set-sens');
    if (sens) sens.addEventListener('input', () => {
      S.data.mouseSens = Number(sens.value);
      const t = el('set-sens-txt'); if (t) t.textContent = S.data.mouseSens.toFixed(2) + 'x';
      S.save();
    });
    const q = el('set-quality');
    if (q) q.addEventListener('change', () => {
      S.data.quality = Number(q.value);
      PP.Render.quality = S.data.quality;
      PP.Render.resize();
      S.save();
    });
    const ff = el('set-ff');
    if (ff) ff.addEventListener('change', () => {
      S.data.friendlyFire = Number(ff.value);
      if (PP.G) PP.G.friendlyFire = S.data.friendlyFire;
      if (PP.Net && PP.Net.connected) PP.Net.send({ t: 'ff', v: S.data.friendlyFire });
      S.save();
    });

    el('set-close').addEventListener('click', () => S.close());
    el('set-reset').addEventListener('click', () => { S.reset(); renderKeys(); syncUI(); applyAll(); });

    // 重新绑定：捕获下一次按键
    ROOT.addEventListener('keydown', (e) => {
      if (!rebinding) return;
      e.preventDefault();
      const k = (e.key || '').toLowerCase();
      if (k === 'escape') { rebinding = null; renderKeys(); return; }
      // 冲突检测
      for (const a in S.data.keys) {
        if (a !== rebinding && S.data.keys[a] === k) {
          PP.Hud.toast('与「' + (NICE[a] || a) + '」冲突，已交换');
          S.data.keys[a] = S.data.keys[rebinding];
        }
      }
      S.data.keys[rebinding] = k;
      rebinding = null;
      S.save();
      renderKeys();
    }, true);

    applyAll();
  };

  function applyAll() {
    // 画质只在"用户真的存过设置"时才覆盖（否则别把移动端默认的 0.55 顶掉）
    if (S._hasSaved) {
      PP.Render.quality = S.data.quality;
      PP.Render.resize();
    }
    PP.Audio.setVolume(S.data.volume);
    PP.Audio.setMuted(S.data.muted);
    if (PP.G) PP.G.friendlyFire = S.data.friendlyFire;
  }
  S.applyAll = applyAll;
})();
