/* ============================================================
   game.js — 客户端：双模式主循环
     单机 = 本地权威（Sim 跑在浏览器里）
     联机 = 远端权威（Sim 跑在 server.js，客户端只发输入 + 收快照）
   两种模式下渲染层拿到的都是同一个结构（G），渲染代码无需分支
   ============================================================ */
(function () {
  const ROOT = (typeof window !== 'undefined') ? window : globalThis;
  const PP = (ROOT.PP = ROOT.PP || {});
  const Game = (PP.Game = {});

  let canvas = null, G = null, mode = 'solo';
  let rafId = 0, lastT = 0, acc = 0, sendAcc = 0;
  let fpsAcc = 0, fpsCount = 0, degradeLeft = 3;
  const keys = Object.create(null);
  let mouseDown = false;
  // 一次性输入：必须等"真正送达"后才清除，否则联机下 30Hz 发送会漏掉点击
  const pending = { fire: false, reload: false, switchTo: -1 };
  function clearPending() { pending.fire = false; pending.reload = false; pending.switchTo = -1; }
  let myId = 0, myName = '玩家';

  const input = {
    fwd: 0, strafe: 0, turn: 0, pitch: 0, sprint: false,
    fire: false, firePressed: false, revive: false, switchTo: -1, reload: false
  };

  /* ---------------- 事件 → 音效 / UI ---------------- */
  function wire(bus) {
    const A = PP.Audio, H = PP.Hud;
    bus.on('shot', (e) => {
      A[PP.WEAPONS[e.w !== undefined ? e.w : e.weapon].sfx]();
      // 联机：本地立刻给枪口火光与后坐（不等服务端回包，手感更跟手）
      if (e.id === myId && G) {
        G.muzzleT = 0.06;
        G.kickPitch = (G.kickPitch || 0) + 0.02 * PP.WEAPONS[e.w !== undefined ? e.w : e.weapon].kick;
        G.shake = Math.min(1, (G.shake || 0) + 0.04);
      }
    });
    bus.on('hit', (e) => { A[e.head ? 'headshot' : 'hit'](); if (e.id === myId) H.hitmarker(e.head); });
    bus.on('kill', (e) => {
      A.enemyDie(); H.hitmarker(e.head);
      if (e.killerId === myId || !e.killerId) {
        H.popup((e.head ? '爆头 +' : '+') + e.gain, e.head ? 'head' : 'kill',
          (Math.random() - 0.5) * 70, -20 + (Math.random() - 0.5) * 30);
      }
    });
    bus.on('playerHurt', (e) => {
      if (e.id === myId || !e.id) A.playerHurt();
      // 联机下快照不带受击信息，用事件补上红屏与震屏
      if (mode === 'online' && e.id === myId && G) {
        G.hurtFlash = Math.min(1, (G.hurtFlash || 0) + (e.dmg || 5) / 45 + 0.18);
        G.shake = Math.min(1, (G.shake || 0) + (e.dmg || 5) / 60);
      }
    });
    bus.on('pickup', (e) => {
      if (e.id === myId || !e.id) { A.pickup(); H.toast(e.text); }
    });
    bus.on('chest', (e) => { if (e.id === myId || !e.id) { A.pickupBig(); H.toast('打开补给箱'); } });
    bus.on('switch', () => A.switchWeapon());
    bus.on('reload', (e) => { if (e.id === myId || !e.id) A.reload(e.dur); });
    bus.on('dryfire', (e) => { if (e.id === myId || !e.id) A.dryFire(); });
    bus.on('spawn', () => A.spawn());
    bus.on('enemyWindup', (e) => { if (e && e.creeper) A.creeperHiss(); else A.enemyGrowl(); });
    bus.on('enemyShoot', () => A.bow());
    bus.on('explode', () => A.creeperBoom());
    bus.on('threat', (e) => {
      A.waveStart();
      H.banner('威胁等级 ' + e.level + '\n怪物变得更强了');
    });
    bus.on('levelup', (e) => {
      if (e.id === myId) { A.pickupBig(); H.toast('升级！Lv.' + e.level + ' — 选择强化'); }
    });
    bus.on('perkChoices', (e) => {
      if (e.id !== myId) return;
      // 单机：选卡期间自动暂停，避免一边被围殴一边选
      let wasPaused = false;
      if (mode === 'solo' && G && G.state === 'playing') { G.state = 'paused'; wasPaused = true; }
      // 必须放开指针锁定，否则鼠标光标没了就没法点卡片
      if (document.pointerLockElement) document.exitPointerLock();
      PP.Hud.showPerks(e.list, (pid) => {
        if (wasPaused && G && G.state === 'paused') G.state = 'playing';
        if (mode === 'solo') PP.Sim.choosePerk(G, G.me, pid);
        else PP.Net.send({ t: 'perk', p: pid });
        if (isPlaying()) lockPointer(canvas);     // 选完重新锁定
      });
      if (wasPaused) PP.Hud.show(PP.Hud._sPause, false);
    });
    bus.on('perkTaken', (e) => { if (e.id === myId) { A.pickupBig(); H.toast('获得强化：' + e.name); } });
    bus.on('downed', (e) => {
      A.playerHurt();
      H.banner((e.name || '队友') + ' 倒地了！\n靠近按住 E 救援');
    });
    bus.on('revived', (e) => {
      A.waveClear();
      H.toast((e.name || '队友') + ' 被救起了');
    });
    bus.on('eliminated', (e) => { H.toast((e.name || '队友') + ' 已阵亡'); });
    bus.on('friendlyHit', (e) => { if (e.id === myId) H.hitmarker(false); });
    bus.on('restarted', () => {
      // 服务端重开一局：换到新视图并重新绑定事件
      G = PP.Net.view;
      if (G) { G.me = G.player; PP.G = G; wire(G.bus); PP.Hud.reset(); }
    });
    bus.on('dead', (e) => {
      if (mode === 'solo') { A.gameOver(); endRun(); }
    });
    bus.on('gameover', () => { A.gameOver(); endRun(); });
  }

  function endRun() {
    if (document.pointerLockElement) document.exitPointerLock();
    PP.Hud.gameOver(G);
    // 局外收益：写入星币 / 统计
    if (PP.Save && G) {
      const p = G.player || G.me || {};
      const info = PP.Save.recordRun({
        score: (p.score != null ? p.score : G.score) || 0,
        kills: p.kills || G.kills || 0,
        time: G.elapsed || 0,
        level: p.level || 1,
        cleared: false
      });
      PP.Hud.showReward(info);
      PP.Hud.refreshProfile();
    }
  }

  /* ---------------- 启动 ---------------- */
  function startSolo() {
    PP.Audio.init(); PP.Audio.resume();
    mode = 'solo';
    if (PP.Save) {
      const nameInput = document.getElementById('inp-name');
      if (nameInput && nameInput.value) PP.Save.setName(nameInput.value);
    }
    G = PP.Sim.create(undefined, { solo: true });
    const me = PP.Sim.addPlayer(G, 1, myName || (PP.Save && PP.Save.name()) || '幸存者');
    me.colorIdx = 0;
    if (PP.Save) PP.Save.applyToPlayer(me);
    G.me = me; myId = me.id;
    PP.G = G;
    wire(G.bus);
    PP.Sim.syncView(G);
    showGame();
  }

  function startOnline(addr) {
    PP.Audio.init(); PP.Audio.resume();
    mode = 'online';
    PP.Hud.netStatus('连接中…', 'wait');
    let url = addr.trim();
    if (!/^wss?:\/\//.test(url)) url = 'ws://' + url.replace(/\/+$/, '');
    if (!/\/(ws)?$/.test(url)) url += '/ws';
    PP.Net.connect(url, myName).then((V) => {
      G = V; myId = PP.Net.id;
      G.me = G.player;
      PP.G = G;
      wire(G.bus);
      PP.Net.onStatus = (s) => {
        if (s === 'closed') { PP.Hud.netStatus('连接已断开', 'bad'); }
      };
      PP.Hud.netStatus('联机中 · ' + url.replace('ws://', ''), 'ok');
      showGame();
    }).catch((err) => {
      // 连不上就退回单机状态，避免停在"半联机"的坏状态里
      mode = 'solo';
      PP.Net.mode = 'solo';
      PP.Net.view = null;
      PP.Hud.netStatus('连接失败：' + (err && err.message ? err.message : '未知错误'), 'bad');
      PP.Hud.toast('连接失败，可先玩单机，或检查服务端是否已启动');
    });
  }

  function showGame() {
    PP.Hud.show(PP.Hud._sTitle, false);
    PP.Hud.show(PP.Hud._sOver, false);
    PP.Hud.show(PP.Hud._sPause, false);
    const shop = document.getElementById('s-shop');
    if (shop) shop.classList.add('hide');
    PP.Hud.show(PP.Hud._hud, true);
    PP.Hud.reset();
    PP.Hud.banner('方块荒野\n找到补给箱，活下去');
    // 移动端：全屏 + 尽量锁定横屏（iOS 可能不支持，忽略失败）
    if (PP.Touch.enabled) {
      try { if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen(); } catch (e) { }
      try { if (ROOT.screen && ROOT.screen.orientation && ROOT.screen.orientation.lock) ROOT.screen.orientation.lock('landscape'); } catch (e) { }
    }
    lockPointer(canvas);
  }

  function showTitle() {
    PP.Hud.show(PP.Hud._sTitle, true);
    PP.Hud.show(PP.Hud._sOver, false);
    PP.Hud.show(PP.Hud._sPause, false);
    PP.Hud.show(PP.Hud._hud, false);
    const shop = document.getElementById('s-shop');
    if (shop) shop.classList.add('hide');
    if (document.pointerLockElement) document.exitPointerLock();
    if (PP.Save) {
      const nameInput = document.getElementById('inp-name');
      if (nameInput && !nameInput.value) nameInput.value = PP.Save.name() || '';
      PP.Hud.refreshProfile();
    }
  }

  let lockGrace = 0;   // 指针锁定后的忽略帧数（防止锁定瞬间的大位移甩视角）
  /* 只有"真的在打"的时候才允许锁定指针 / 开火。
     否则点标题页、暂停页、结算页、设置页的空白处都会把鼠标吞掉。 */
  function isPlaying() {
    if (!G) return false;
    // 键鼠与触屏可并存：不能因为开了触屏就禁用鼠标开火
    if (mode === 'solo') return G.state === 'playing';
    return !!G.paused === false && G.state !== 'over' && PP.Net.connected;
  }

  function lockPointer(el) {
    if (!el || !el.requestPointerLock) return;
    lockGrace = 3;
    try { const r = el.requestPointerLock(); if (r && r.catch) r.catch(() => { }); } catch (e) { }
  }

  function setPause(on) {
    if (!G) return;
    const st = () => (mode === 'solo' ? G.state : 'playing');
    if (on && st() === 'playing') {
      if (mode === 'solo') G.state = 'paused';
      else G.paused = true;
      PP.Hud.show(PP.Hud._sPause, true);
      if (document.pointerLockElement) document.exitPointerLock();
    } else if (!on) {
      if (mode === 'solo' && G.state === 'paused') G.state = 'playing';
      if (mode === 'online') G.paused = false;
      PP.Hud.show(PP.Hud._sPause, false);
      lockPointer(canvas);
    }
  }

  /* ---------------- 输入 ---------------- */
  function bindInput() {
    ROOT.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase();
      keys[key] = true;
      if (key === ' ') e.preventDefault();
      if (!G) return;
      // 选卡中：数字键直接选（并吞掉，避免同时切枪）
      if (PP.Hud.perksOpen()) {
        const idx = ['1', '2', '3'].indexOf(key);
        if (idx >= 0) { PP.Hud.pickPerk(idx); e.preventDefault(); return; }
        return;
      }
      const me = mePlayer();
      if (me && !me.eliminated) {
        if (key === k('reload')) pending.reload = true;
        if (key === k('w1')) pending.switchTo = 0;
        if (key === k('w2') && me.unlocked[1]) pending.switchTo = 1;
        if (key === k('w3') && me.unlocked[2]) pending.switchTo = 2;
        if (key === k('w4') && me.unlocked[3]) pending.switchTo = 3;
        if (key === k('w5') && me.unlocked[4]) pending.switchTo = 4;
      }
      if (key === k('mute')) { const m = PP.Audio.toggleMute(); PP.Hud.toast(m ? '静音' : '音效开'); }
      if (key === k('pause')) setPause(true);
      if (key === 'escape') { if (PP.Settings && PP.Settings.isOpen()) PP.Settings.close(); }
    });
    ROOT.addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });

    const stage = document.getElementById('stage');
    stage.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      if (!isPlaying()) return;                     // 非游玩状态：不吞鼠标、不开火
      mouseDown = true;
      if (!document.pointerLockElement) lockPointer(canvas);
      pending.fire = true;
    });
    ROOT.addEventListener('mouseup', (e) => { if (e.button === 0) mouseDown = false; });
    ROOT.addEventListener('mousemove', (e) => {
      if (!G || !document.pointerLockElement) return;
      const p = mePlayer();
      if (!p || p.eliminated) return;
      let mx = e.movementX, my = e.movementY;
      // 浏览器在"刚锁定指针 / 切窗口 / 掉帧"时偶尔会抛出几百 px 的假位移，
      // 直接采信就会出现"视角莫名甩一下"。这里丢弃异常值而不是钳制。
      if (!isFinite(mx) || !isFinite(my)) return;
      if (Math.abs(mx) > 180 || Math.abs(my) > 180) return;
      if (lockGrace > 0) return;                       // 刚锁定的前几帧忽略
      const sens = 0.0022 * (PP.Settings ? PP.Settings.data.mouseSens : 1);
      p.a += mx * sens;
      p.pitchBase = PP.Core.clamp(p.pitchBase - my * sens * 0.9, -1.30, 1.30);
      if (mode === 'online') p.pitch = p.pitchBase;
    });
    ROOT.addEventListener('wheel', (e) => {
      const me = mePlayer();
      if (!G || !me) return;
      const dir = e.deltaY > 0 ? 1 : -1;
      for (let i = 1; i <= 3; i++) {
        const n = (me.weapon + dir * i + 24) % (PP.WEAPONS.length || 5);
        if (me.unlocked[n]) { pending.switchTo = n; break; }
      }
    }, { passive: true });

    document.addEventListener('pointerlockchange', () => {
      const locked = !!document.pointerLockElement;
      document.body.classList.toggle('locked', locked);
      // 桌面端失去指针锁定 = 玩家想离开画面 → 暂停（触屏从来没有锁定，不会触发）
      if (!locked && G) {
        if (mode === 'solo' && G.state === 'playing') setPause(true);
        else if (mode === 'online' && !G.paused && !PP.Touch.enabled) setPause(true);
      }
    });
    ROOT.addEventListener('resize', () => PP.Render.resize());
    ROOT.addEventListener('blur', () => { if (G && mode === 'solo' && G.state === 'playing') setPause(true); });
  }

  function mePlayer() { return G ? G.player : null; }

  function k(action) { return PP.Settings.key(action); }
  function pressed(action) { return !!keys[k(action)]; }

  function buildInput() {
    input.fwd = 0; input.strafe = 0; input.turn = 0; input.pitch = 0;
    if (pressed('fwd')) input.fwd += 1;
    if (pressed('back')) input.fwd -= 1;
    if (pressed('right')) input.strafe += 1;
    if (pressed('left')) input.strafe -= 1;
    if (keys['arrowup']) input.fwd += 1;
    if (keys['arrowdown']) input.fwd -= 1;
    if (keys['arrowleft']) input.turn -= 2.2;
    if (keys['arrowright']) input.turn += 2.2;
    if (pressed('turnL')) input.turn -= 2.2;
    if (pressed('turnR')) input.turn += 2.2;
    input.sprint = pressed('sprint');
    input.fire = mouseDown;
    input.revive = pressed('revive');
    input.firePressed = pending.fire;
    input.reload = pending.reload;
    input.switchTo = pending.switchTo;

    // 触屏覆盖：虚拟摇杆 / 按键
    if (PP.Touch && PP.Touch.enabled) {
      PP.Touch.applyTo(input);
      if (PP.Touch.consumeFire()) pending.fire = true;
      if (PP.Touch.consumeReload()) pending.reload = true;
      if (PP.Touch.consumeWeapon()) pending.switchTo = -2;      // -2 = 循环切换
      if (PP.Touch.btnRevive) input.revive = true;
      input.firePressed = pending.fire;
      input.reload = pending.reload;
      input.switchTo = pending.switchTo;
    }
    return input;
  }

  /* 触屏转视角 */
  function applyTouchLook() {
    if (!PP.Touch || !PP.Touch.enabled) return;
    const l = PP.Touch.consumeLook();
    if (!l.dx && !l.dy) return;
    const p = mePlayer();
    if (!p || p.eliminated) return;
    const s = PP.Touch.LOOK_SENS;
    p.a += l.dx * s;
    p.pitchBase = PP.Core.clamp(p.pitchBase - l.dy * s * 0.9, -1.30, 1.30);
    if (mode === 'online') p.pitch = p.pitchBase;
  }

  /* 触屏一次性按键 */
  function pollTouchButtons() {
    if (!PP.Touch || !PP.Touch.enabled || !G) return;
    if (PP.Touch.consumePause()) { setPause(true); return; }
    const me = mePlayer();
    if (!me) return;
    // 疾跑按钮的视觉反馈
    const sb = document.querySelector('.tbtn.sprint');
    if (sb) sb.classList.toggle('on', PP.Touch.sprint);
  }

  /* ---------------- 主循环 ---------------- */
  function loop(t) {
    rafId = requestAnimationFrame(loop);
    if (!lastT) lastT = t;
    let dt = (t - lastT) / 1000;
    lastT = t;
    if (dt > 0.25) dt = 0.25;
    if (!G) return;

    const paused = (mode === 'solo' ? G.state !== 'playing' : !!G.paused);
    if (paused) return;

    const inp = buildInput();
    applyTouchLook();
    pollTouchButtons();
    if (lockGrace > 0) lockGrace--;

    if (mode === 'solo') {
      acc += dt;
      let steps = 0;
      while (acc >= PP.Sim.TICK && steps < 5) {
        PP.Sim.setInput(G, myId, inp);
        clearPending();                                   // 已送达
        inp.firePressed = false; inp.reload = false; inp.switchTo = -1;
        PP.Sim.tick(G);
        acc -= PP.Sim.TICK; steps++;
        if (G.state !== 'playing') break;
      }
      if (steps >= 5) acc = 0;
      pollPerks();
    } else {
      PP.Net.update(dt, inp);
      sendAcc += dt;
      if (sendAcc >= 1 / 30) {
        sendAcc = 0;
        PP.Net.sendInput(inp);
        clearPending();                                   // 已送达
        inp.firePressed = false; inp.reload = false; inp.switchTo = -1;
      }
      pollPerks();
    }
    // 注意：pending 只在真正送达后清除，避免 30Hz 发送漏掉点击

    // 桌面端：没锁定指针时给明确提示（ESC 后浏览器有约 1s 冷却，点"继续"可能静默失败）
    const hint = document.getElementById('lockhint');
    if (hint) {
      const need = isPlaying() && !document.pointerLockElement;
      hint.classList.toggle('hide', !need);
    }

    PP.Render.frame(G);
    PP.Hud.update(G, reviveInfo());

    fpsAcc += dt; fpsCount++;
    if (fpsCount >= 90) {
      const avg = fpsAcc / fpsCount;
      fpsAcc = 0; fpsCount = 0;
      if (avg > 0.021 && degradeLeft > 0) {
        degradeLeft--;
        PP.Render.quality *= 0.82;
        PP.Render.resize();
      }
    }
  }

  let lastPerkReq = 0;
  function pollPerks() {
    const me = mePlayer();
    if (!me || me.eliminated) return;
    if ((me.pendingPerks || 0) <= 0) return;
    if (PP.Hud.perksOpen()) return;
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (now - lastPerkReq < 1200) return;    // 联机下 self 状态 6Hz 刷新，避免重复摇奖
    lastPerkReq = now;
    if (mode === 'solo') PP.Sim.rollPerkChoices(G, G.me);
    else PP.Net.send({ t: 'perkRequest' });
  }

  function reviveInfo() {
    const me = mePlayer();
    if (!me) return null;
    if (me.eliminated) return { eliminated: true };
    if (G.mates && G.mates.length && !me.eliminated) {
      if (me.downed) return { self: true, prog: me.reviveProg || 0, name: '' };
      let best = null, bd = 1e9;
      for (const m of G.mates) {
        if (!m.downed || m.eliminated) continue;
        const d = Math.hypot(m.x - me.x, m.y - me.y);
        if (d < 2.4 && d < bd) { bd = d; best = m; }
      }
      if (best) return { self: false, prog: best.reviveProg || (G.playerList ? 0 : 0), name: best.name, target: best };
    }
    return null;
  }

  /* ---------------- boot ---------------- */
  function boot() {
    canvas = document.getElementById('view');
    PP.Hud.init();
    PP.Hud._sTitle = document.getElementById('s-title');
    PP.Hud._sPause = document.getElementById('s-pause');
    PP.Hud._sOver = document.getElementById('s-over');
    PP.Hud._hud = document.getElementById('hud');

    // 移动端：默认降分辨率（软件光栅化成本 = 像素数），再靠自适应继续降
    if (PP.Touch.isTouch()) PP.Render.quality = 0.55;
    PP.Render.init(canvas);
    PP.Touch.init();
    PP.Settings.init();          // 读档后会覆盖画质 / 音量 / 灵敏度

    // 设置面板入口
    const openSet = () => { PP.Settings.open(); if (document.pointerLockElement) document.exitPointerLock(); };
    const bs1 = document.getElementById('btn-set-title'); if (bs1) bs1.addEventListener('click', openSet);
    const bs2 = document.getElementById('btn-set-pause'); if (bs2) bs2.addEventListener('click', openSet);

    // 画质档位
    const qbtns = document.querySelectorAll('.qbtn');
    for (const b of qbtns) {
      b.addEventListener('click', () => {
        PP.Render.quality = parseFloat(b.getAttribute('data-q')) || 1;
        PP.Render.resize();
        for (const o of qbtns) o.classList.toggle('on', o === b);
        PP.Hud.toast('画质已切换');
      });
    }

    const nameInput = document.getElementById('inp-name');
    const addrInput = document.getElementById('inp-addr');
    const host = (typeof location !== 'undefined' && location.host) ? location.host : 'localhost:8080';
    if (addrInput) addrInput.value = host;

    const val = function (el, def) {
      const v = el && el.value;
      return (typeof v === 'string' && v.trim()) ? v.trim() : def;
    };
    document.getElementById('btn-solo').addEventListener('click', () => {
      myName = val(nameInput, '玩家');
      if (PP.Save) PP.Save.setName(myName);
      startSolo();
    });
    document.getElementById('btn-online').addEventListener('click', () => {
      myName = val(nameInput, '玩家');
      if (PP.Save) PP.Save.setName(myName);
      startOnline(val(addrInput, host));
    });
    document.getElementById('btn-resume').addEventListener('click', () => setPause(false));
    document.getElementById('btn-restart').addEventListener('click', () => {
      if (mode === 'solo') startSolo(); else PP.Net.send({ t: 'restart' });
    });
    document.getElementById('btn-restart-p').addEventListener('click', () => {
      if (mode === 'solo') startSolo(); else PP.Net.send({ t: 'restart' });
    });

    // 局外：商店 / 结算跳转 / 回主页
    const btnShop = document.getElementById('btn-shop');
    if (btnShop) btnShop.addEventListener('click', () => { PP.Hud.openShop(); });
    const btnShopClose = document.getElementById('btn-shop-close');
    if (btnShopClose) btnShopClose.addEventListener('click', () => { PP.Hud.closeShop(); });
    const btnToShop = document.getElementById('btn-to-shop');
    if (btnToShop) btnToShop.addEventListener('click', () => {
      PP.Hud.show(PP.Hud._sOver, false);
      PP.Hud.openShop();
    });
    const btnToTitle = document.getElementById('btn-to-title');
    if (btnToTitle) btnToTitle.addEventListener('click', () => { showTitle(); });

    // 存档：导出 / 导入 / 清空
    const btnExport = document.getElementById('btn-export');
    if (btnExport) btnExport.addEventListener('click', () => {
      const code = PP.Save && PP.Save.exportCode();
      if (!code) { PP.Hud.toast('导出失败'); return; }
      const ta = document.getElementById('import-text');
      if (ta) { ta.value = code; ta.select(); }
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code);
      } catch (e) { }
      const imp = document.getElementById('s-import');
      if (imp) imp.classList.remove('hide');
      PP.Hud.toast('存档码已生成，请复制保存');
    });
    const btnImport = document.getElementById('btn-import');
    if (btnImport) btnImport.addEventListener('click', () => {
      const imp = document.getElementById('s-import');
      if (imp) imp.classList.remove('hide');
    });
    const btnImportOk = document.getElementById('btn-import-ok');
    if (btnImportOk) btnImportOk.addEventListener('click', () => {
      const ta = document.getElementById('import-text');
      const r = PP.Save && PP.Save.importCode(ta ? ta.value : '');
      if (r && r.ok) {
        PP.Hud.toast('导入成功：' + (r.name || '幸存者') + ' · 星币 ' + r.coins);
        if (nameInput) nameInput.value = r.name || nameInput.value;
        PP.Hud.refreshProfile();
        const imp = document.getElementById('s-import');
        if (imp) imp.classList.add('hide');
      } else {
        PP.Hud.toast((r && r.reason) || '导入失败');
      }
    });
    const btnImportCancel = document.getElementById('btn-import-cancel');
    if (btnImportCancel) btnImportCancel.addEventListener('click', () => {
      const imp = document.getElementById('s-import');
      if (imp) imp.classList.add('hide');
    });
    const btnReset = document.getElementById('btn-reset-save');
    if (btnReset) btnReset.addEventListener('click', () => {
      if (!confirm('确定清空本机进度？（星币与增益都会丢失）')) return;
      if (PP.Save) PP.Save.reset();
      if (nameInput) nameInput.value = '';
      PP.Hud.refreshProfile();
      PP.Hud.toast('进度已清空');
    });

    // 昵称变化时写入存档
    if (nameInput) {
      nameInput.addEventListener('change', () => {
        if (PP.Save) { PP.Save.setName(nameInput.value); PP.Hud.refreshProfile(); }
      });
    }

    if (PP.Save) {
      if (nameInput && !nameInput.value) nameInput.value = PP.Save.name() || '';
      PP.Hud.refreshProfile();
    }

    bindInput();

    // 标题背景：用固定种子渲染一帧
    G = PP.Sim.create(20240917, { solo: true });
    const me = PP.Sim.addPlayer(G, 999, 'preview');
    G.me = me; myId = me.id;
    PP.Sim.syncView(G);
    G.state = 'title';
    PP.Render.frame(G);

    rafId = requestAnimationFrame(loop);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
