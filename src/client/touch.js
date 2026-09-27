/* ============================================================
   touch.js — 移动端横屏虚拟摇杆与按键
   布局（横屏）：
     左半屏  = 移动摇杆（按下处为原点，浮动）
     右半屏  = 拖拽转视角
     右下角  = 射击（大）/ 装填 / 换枪 / 救援
     右上角  = 暂停；左下角 = 疾跑开关
   输出统一写进 input 对象，与键盘输入共用同一条链路
   ============================================================ */
(function () {
  const ROOT = (typeof window !== 'undefined') ? window : globalThis;
  const PP = (ROOT.PP = ROOT.PP || {});
  const T = (PP.Touch = {});

  T.enabled = false;
  T.active = false;

  const STICK_R = 58;      // 摇杆最大半径（CSS px）
  const DEAD = 0.16;
  const LOOK_SENS = 0.0032; // 每像素弧度

  const pointers = new Map();     // pointerId -> 'stick' | 'look'
  const lookPts = new Map();      // pointerId -> {x,y}（各自独立，避免多指互相污染）
  const btnPts = new Map();       // pointerId -> 按钮名（手指滑出按钮也能正确松开）
  let stickOX = 0, stickOY = 0;

  T.move = { x: 0, y: 0 };
  T.look = { dx: 0, dy: 0 };
  T.fire = false;
  T.firePressed = false;
  T.sprint = false;
  T.btnReload = false;
  T.btnWeapon = false;
  T.btnRevive = false;
  T.btnPause = false;

  const held = Object.create(null);   // 按键按下状态

  /* 仅「触控优先」设备进入触屏模式。
     Windows 桌面 / 触屏本 / 混合设备上 ontouchstart、maxTouchPoints 常为真，
     若据此开启触屏，会把 WASD/鼠标整套键鼠输入吃掉（摇杆恒 0 + isPlaying 恒 false）。 */
  function isTouch() {
    const nav = ROOT.navigator;
    const ua = (nav && nav.userAgent) || '';
    if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua)) return true;
    // iPadOS 桌面版 Safari 伪装成 Macintosh
    if (/Macintosh/.test(ua) && nav && nav.maxTouchPoints > 1) return true;
    if (ROOT.matchMedia) {
      try {
        const coarse = ROOT.matchMedia('(pointer: coarse)').matches;
        const fine = ROOT.matchMedia('(pointer: fine)').matches;
        if (coarse && !fine) return true;
      } catch (e) { }
    }
    return false;
  }
  T.isTouch = isTouch;

  T.init = function () {
    if (!isTouch()) { T.enabled = false; return false; }
    T.enabled = true;
    T.active = true;
    const root = document.getElementById('touch');
    if (!root) return false;
    root.classList.remove('hide');
    document.body.classList.add('touch');

    const zoneL = document.getElementById('t-left');
    const zoneR = document.getElementById('t-right');
    const knob = document.getElementById('t-knob');
    const base = document.getElementById('t-base');

    function pressBtn(btn) {
      held[btn] = true;
      if (btn === 'fire') { T.fire = true; T.firePressed = true; }
      if (btn === 'sprint') T.sprint = !T.sprint;
      if (btn === 'weapon') T.btnWeapon = true;
      if (btn === 'reload') T.btnReload = true;
      if (btn === 'revive') T.btnRevive = true;
      if (btn === 'pause') T.btnPause = true;
    }
    function releaseBtn(btn) {
      held[btn] = false;
      if (btn === 'fire') T.fire = false;
      if (btn === 'revive') T.btnRevive = false;   // 救援是"按住"，松开即停
    }

    function onDown(e) {
      const b = e.target && e.target.getAttribute ? e.target.getAttribute('data-btn') : null;
      if (b) { btnPts.set(e.pointerId, b); pressBtn(b); e.preventDefault(); return; }
      const x = e.clientX, y = e.clientY;
      if (x < ROOT.innerWidth * 0.5) {
        pointers.set(e.pointerId, 'stick');
        stickOX = x; stickOY = y;
        if (base) { base.style.left = x + 'px'; base.style.top = y + 'px'; base.classList.add('on'); }
        if (knob) { knob.style.left = x + 'px'; knob.style.top = y + 'px'; }
      } else {
        pointers.set(e.pointerId, 'look');
        lookPts.set(e.pointerId, { x: x, y: y });
      }
      e.preventDefault();
    }

    function onMove(e) {
      if (pointers.get(e.pointerId) === 'stick') {
        let dx = e.clientX - stickOX, dy = e.clientY - stickOY;
        const d = Math.hypot(dx, dy);
        if (d > STICK_R) { dx = dx / d * STICK_R; dy = dy / d * STICK_R; }
        if (knob) { knob.style.left = (stickOX + dx) + 'px'; knob.style.top = (stickOY + dy) + 'px'; }
        let nx = dx / STICK_R, ny = dy / STICK_R;
        const m = Math.hypot(nx, ny);
        if (m < DEAD) { nx = 0; ny = 0; }
        else { const k = Math.min(1, m) / m; nx *= k; ny *= k; }
        T.move.x = nx; T.move.y = ny;
      } else if (pointers.get(e.pointerId) === 'look') {
        const last = lookPts.get(e.pointerId);
        if (last) { T.look.dx += (e.clientX - last.x); T.look.dy += (e.clientY - last.y); }
        lookPts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      e.preventDefault();
    }

    function onUp(e) {
      const kind = pointers.get(e.pointerId);
      if (kind === 'stick') {
        T.move.x = 0; T.move.y = 0;
        if (base) base.classList.remove('on');
        if (knob) { knob.style.left = '-999px'; knob.style.top = '-999px'; }
      }
      lookPts.delete(e.pointerId);
      pointers.delete(e.pointerId);
      // 按钮：按 pointerId 找回（手指滑出按钮也能松开）
      const b = btnPts.get(e.pointerId) ||
        (e.target && e.target.getAttribute ? e.target.getAttribute('data-btn') : null);
      if (b) { releaseBtn(b); btnPts.delete(e.pointerId); }
      e.preventDefault();
    }

    // 用原生事件监听（pointer 事件在移动端可用；不支持时退化为 touch）
    if (ROOT.PointerEvent) {
      root.addEventListener('pointerdown', onDown);
      ROOT.addEventListener('pointermove', onMove, { passive: false });
      ROOT.addEventListener('pointerup', onUp);
      ROOT.addEventListener('pointercancel', onUp);
    } else {
      root.addEventListener('touchstart', (e) => {
        for (const t of e.changedTouches) onDown({ pointerId: t.identifier, clientX: t.clientX, clientY: t.clientY, target: e.target, preventDefault: () => e.preventDefault() });
      }, { passive: false });
      ROOT.addEventListener('touchmove', (e) => {
        for (const t of e.changedTouches) onMove({ pointerId: t.identifier, clientX: t.clientX, clientY: t.clientY, preventDefault: () => e.preventDefault() });
      }, { passive: false });
      ROOT.addEventListener('touchend', (e) => {
        for (const t of e.changedTouches) onUp({ pointerId: t.identifier, clientX: t.clientX, clientY: t.clientY, target: e.target, preventDefault: () => { } });
      });
    }
    return true;
  };

  /* 消费一次性输入 */
  T.consumeLook = function () {
    const d = { dx: T.look.dx, dy: T.look.dy };
    T.look.dx = 0; T.look.dy = 0;
    return d;
  };
  T.consumeFire = function () { const v = T.firePressed; T.firePressed = false; return v; };
  T.consumeReload = function () { const v = T.btnReload; T.btnReload = false; return v; };
  T.consumeWeapon = function () { const v = T.btnWeapon; T.btnWeapon = false; return v; };
  T.consumeRevive = function () { const v = T.btnRevive; T.btnRevive = false; return v; };
  T.consumePause = function () { const v = T.btnPause; T.btnPause = false; return v; };

  /* 写进统一输入对象 */
  /* 与键鼠合并而不是覆盖：摇杆有位移才改移动量，按键用 OR，避免清掉 WASD / 鼠标开火 */
  T.applyTo = function (input) {
    if (!T.enabled) return input;
    if (T.move.x || T.move.y) {
      input.fwd = -T.move.y;      // 摇杆向上 = 前进
      input.strafe = T.move.x;
    }
    if (T.sprint) input.sprint = true;
    if (T.fire) input.fire = true;
    if (T.btnRevive) input.revive = true;
    return input;
  };

  T.LOOK_SENS = LOOK_SENS;
})();
