/* ============================================================
   net.js — 客户端联机：连接、输入上报、快照应用、本地预测
   视图模型（view）与单机 G 结构一致，渲染层无需区分两种模式
   ============================================================ */
(function () {
  const ROOT = (typeof window !== 'undefined') ? window : globalThis;
  const PP = (ROOT.PP = ROOT.PP || {});
  const Net = (PP.Net = {});

  Net.mode = 'solo';           // 'solo' | 'online'
  Net.ws = null;
  Net.id = 0;
  Net.connected = false;
  Net.view = null;
  Net.latency = 0;
  Net.onStatus = null;

  /* ---------------- 视图模型 ---------------- */
  function makeView(seed) {
    PP.World.generate(seed);
    const V = {
      isView: true, seed: seed, state: 'playing',
      bus: new (PP.Core.Bus)(),
      player: {
        id: 0, name: '', x: PP.World.spawn.x, y: PP.World.spawn.y, a: PP.World.spawn.a,
        pitch: 0, pitchBase: 0, hp: 100, ap: 0, maxHp: 100, maxAp: 100,
        weapon: 0, downed: false, eliminated: false, reviveProg: 0,
        bobT: 0, bobAmt: 0, speed: 0, level: 1, xp: 0, xpNext: 100, pendingPerks: 0,
        mods: {}, insts: [{ def: 0, rarity: 0, affixes: [] }, { def: 1, rarity: 0, affixes: [] }, { def: 2, rarity: 0, affixes: [] }],
        perks: [], mag: [12, 0, 0], reserve: [Infinity, 0, 0], unlocked: [true, false, false],
        score: 0, kills: 0, headshots: 0, combo: 0, comboMult: function () { return 1; }
      },
      mates: [], enemies: [], projectiles: [], pickups: [], particles: [], renderList: [],
      weapon: 0, mag: [12, 0, 0], reserve: [Infinity, 0, 0], unlocked: [true, false, false],
      muzzleT: 0, weaponSwayX: 0, weaponBobY: 0, weaponRaise: 0,
      kickPitch: 0, viewOffsetY: 0, shake: 0, hurtFlash: 0,
      threat: 1, score: 0, kills: 0, combo: 0, time: 0, elapsed: 0,
      friendlyFire: 0.35
    };
    return V;
  }
  Net.makeView = makeView;

  /* ---------------- 连接 ---------------- */
  Net.connect = function (url, name, cb) {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(url); } catch (e) { reject(e); return; }
      Net.ws = ws;
      ws.binaryType = 'arraybuffer';
      const to = setTimeout(() => { try { ws.close(); } catch (e) { } reject(new Error('连接超时')); }, 8000);
      ws.onopen = () => {
        clearTimeout(to);
        Net.connected = true;
        ws.send(JSON.stringify({ t: 'join', name: name }));
        if (cb) cb('joining');
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') handleMsg(JSON.parse(ev.data), resolve);
        else applySnapshot(new DataView(ev.data));
      };
      ws.onclose = () => {
        Net.connected = false;
        if (Net.onStatus) Net.onStatus('closed');
      };
      ws.onerror = () => { clearTimeout(to); reject(new Error('连接失败')); };
    });
  };

  Net.disconnect = function () {
    if (Net.ws) { try { Net.ws.close(); } catch (e) { } }
    Net.ws = null; Net.connected = false; Net.mode = 'solo';
  };

  Net.send = function (obj) {
    if (!Net.ws || Net.ws.readyState !== 1) return;
    Net.ws.send(JSON.stringify(obj));
  };
  Net.sendInput = function (inp) { Net.send({ t: 'input', i: inp }); };

  /* ---------------- 消息 ---------------- */
  function handleMsg(m, resolve) {
    if (m.t === 'welcome') {
      Net.id = m.id;
      Net.mode = 'online';
      Net.view = makeView(m.seed);
      Net.view.player.id = m.id;
      Net.view.player.name = m.name || '';
      Net.view.friendlyFire = m.friendlyFire;
      if (Net.onStatus) Net.onStatus('online');
      resolve(Net.view);
      return;
    }
    const V = Net.view;
    if (!V) return;
    if (m.t === 'players') { Net.mates = m.list; return; }
    if (m.t === 'self') {
      const p = V.player;
      p.weapon = m.weapon; p.mag = m.mag; p.reserve = m.reserve.map(v => v < 0 ? Infinity : v);
      p.unlocked = m.unlocked; p.insts = m.insts; p.perks = m.perks;
      p.xp = m.xp; p.xpNext = m.xpNext; p.level = m.level; p.pendingPerks = m.pendingPerks;
      p.score = m.score; p.kills = m.kills; p.headshots = m.headshots; p.combo = m.combo;
      p.downed = m.downed; p.eliminated = m.eliminated; p.reviveProg = m.reviveProg; p.downT = m.downT;
      p.hp = m.hp; p.ap = m.ap; p.maxHp = m.maxHp; p.maxAp = m.maxAp;
      V.weapon = m.weapon; V.mag = p.mag; V.reserve = p.reserve; V.unlocked = p.unlocked;
      return;
    }
    if (m.t === 'restart') {
      // 开新局：id 映射表必须一起清，否则旧实体会残留
      enemyById.clear(); mateById.clear(); pickById.clear();
      const oldId = Net.id;
      Net.view = makeView(m.seed);
      Net.view.player.id = oldId;
      Net.view.bus.emit('restarted', {});
      return;
    }
    if (m.t === 'ff') { Net.view.friendlyFire = m.v; return; }
    if (m.t === 'perkChoices') {
      if (m.id === Net.id) Net.view.bus.emit('perkChoices', { id: m.id, list: m.list });
      return;
    }
    // 其余事件直接转发给表现层
    Net.view.bus.emit(m.t, m);
  }

  /* ---------------- 快照 ---------------- */
  const enemyById = new Map();
  const mateById = new Map();
  const pickById = new Map();

  function applySnapshot(dv) {
    const V = Net.view;
    if (!V) return;
    const s = PP.Snap.decode(dv);
    Net.lastSnap = s;

    // 自己：用于校正本地预测
    let meSnap = null;
    for (const p of s.players) if (p.id === Net.id) meSnap = p;
    if (meSnap) {
      V.player.hp = meSnap.hp; V.player.ap = meSnap.ap;
      V.player.weapon = meSnap.weapon;
      V.player.downed = !!(meSnap.flags & PP.Snap.FLAG.DOWNED);
      V.player.eliminated = !!(meSnap.flags & PP.Snap.FLAG.ELIM);
      V.player.level = meSnap.level;
      V.player.reloadT = (meSnap.flags & PP.Snap.FLAG.RELOAD) ? 1 : 0;  // 供 HUD 显示"装填中"
      V._server = meSnap;
    }

    // 队友
    const seen = new Set();
    for (const p of s.players) {
      if (p.id === Net.id) continue;
      seen.add(p.id);
      let m = mateById.get(p.id);
      if (!m) {
        m = { id: p.id, name: p.name || ('P' + p.id), x: p.x, y: p.y, a: p.a, pitch: p.pitch, hp: p.hp, downed: false, colorIdx: p.id % 4, fireT: 0 };
        mateById.set(p.id, m); V.mates.push(m);
      }
      m.tx = p.x; m.ty = p.y; m.ta = p.a; m.tpitch = p.pitch;
      m.hp = p.hp; m.level = p.level;
      m.downed = !!(p.flags & PP.Snap.FLAG.DOWNED);
      m.eliminated = !!(p.flags & PP.Snap.FLAG.ELIM);
      m.fireT = (p.flags & PP.Snap.FLAG.FIRE) ? 0.06 : 0;
    }
    for (let i = V.mates.length - 1; i >= 0; i--) {
      if (!seen.has(V.mates[i].id)) { mateById.delete(V.mates[i].id); V.mates.splice(i, 1); }
    }

    // 敌人
    const es = new Set();
    for (const e of s.enemies) {
      es.add(e.id);
      let o = enemyById.get(e.id);
      if (!o) {
        const T = PP.Ent.TYPES[e.type];
        o = {
          id: e.id, type: e.type, T: T, x: e.x, y: e.y, z0: T.z0, height: T.height,
          radius: T.radius, state: 'alive', hp: T.hp, maxHp: T.hp,
          hurt: 0, windup: 0, spawnT: 0, anim: 0, deadT: 0
        };
        enemyById.set(e.id, o); V.enemies.push(o);
      }
      o.tx = e.x; o.ty = e.y;
      o.hp = Math.max(0, e.hpPct / 255 * o.maxHp);
      const dead = !!(e.flags & PP.Snap.EFLAG.DEAD);
      if (dead && o.state !== 'dead') { o.state = 'dead'; o.deadT = 0; }
      o.windup = (e.flags & PP.Snap.EFLAG.WINDUP) ? 0.2 : 0;
      o.hurt = (e.flags & PP.Snap.EFLAG.HURT) ? 0.14 : 0;
    }
    for (let i = V.enemies.length - 1; i >= 0; i--) {
      const o = V.enemies[i];
      if (!es.has(o.id)) { enemyById.delete(o.id); V.enemies.splice(i, 1); }
    }

    // 投射物（数量少，直接替换）
    V.projectiles.length = 0;
    for (const b of s.projectiles) V.projectiles.push({ x: b.x, y: b.y, z: b.z });

    // 拾取物
    const ks = new Set();
    for (const it of s.pickups) {
      ks.add(it.id);
      let o = pickById.get(it.id);
      if (!o) {
        o = { id: it.id, kind: it.kind, x: it.x, y: it.y, z: 0.18, t: Math.random() * 6.28, life: 40 };
        pickById.set(it.id, o); V.pickups.push(o);
      } else { o.x = it.x; o.y = it.y; }
    }
    for (let i = V.pickups.length - 1; i >= 0; i--) {
      if (!ks.has(V.pickups[i].id)) { pickById.delete(V.pickups[i].id); V.pickups.splice(i, 1); }
    }
    V.threat = s.threat;
  }

  /* ---------------- 每帧：预测 + 平滑 ---------------- */
  Net.update = function (dt, input) {
    const V = Net.view;
    if (!V) return;
    V.time += dt; V.elapsed += dt;

    // 本地预测：用与服务端一致的移动规则推进
    const p = V.player;
    PP.Sim.moveOnly(p, input, dt, p.mods, p.downed);

    // 平滑校正到服务器位置
    const s = V._server;
    if (s) {
      const dx = s.x - p.x, dy = s.y - p.y;
      const d = Math.hypot(dx, dy);
      if (d > 1.5) { p.x = s.x; p.y = s.y; }
      else if (d > 0.001) { const k = Math.min(1, dt * (d > 0.6 ? 14 : 7)); p.x += dx * k; p.y += dy * k; }
    }

    // 队友平滑
    for (const m of V.mates) {
      if (m.tx === undefined) continue;
      const k = Math.min(1, dt * 14);
      m.x += (m.tx - m.x) * k; m.y += (m.ty - m.y) * k;
      m.a = m.ta; m.pitch = m.tpitch;
      if (m.fireT > 0) m.fireT -= dt;
    }
    // 敌人平滑
    for (const e of V.enemies) {
      if (e.tx === undefined) continue;
      const k = Math.min(1, dt * 14);
      e.x += (e.tx - e.x) * k; e.y += (e.ty - e.y) * k;
      e.anim += dt;
      if (e.hurt > 0) e.hurt -= dt;
      if (e.state === 'dead') e.deadT += dt;
    }
    // 拾取物浮动
    for (const it of V.pickups) it.t += dt;

    // 本地武器表现
    V.muzzleT = Math.max(0, V.muzzleT - dt);
    V.kickPitch *= Math.exp(-dt * 9);
    V.weaponRaise *= Math.exp(-dt * 11);
    V.shake *= Math.exp(-dt * 7);
    V.hurtFlash = Math.max(0, V.hurtFlash - dt * 2.2);
    p.bobT += dt * (6 + p.speed * 1.7);
    p.bobAmt += ((p.speed > 0.1 ? 1 : 0) - p.bobAmt) * Math.min(1, dt * 8);
    V.weaponSwayX = Math.sin(p.bobT * 0.5) * 5 * p.bobAmt - V.kickPitch * 40;
    V.weaponBobY = Math.abs(Math.sin(p.bobT)) * 4.5 * p.bobAmt;
    V.viewOffsetY = Math.sin(V.time * 41) * V.shake * 3.2;
    V.pitch = p.pitch;
    V.weapon = p.weapon; V.mag = p.mag; V.reserve = p.reserve; V.unlocked = p.unlocked;
    V.combo = p.combo;
  };
})();
