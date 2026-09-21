/* ============================================================
   sim.js — 权威模拟层（多人 / 固定步长 / 无 DOM）
   浏览器单机（本地权威）与 Node 服务器（远端权威）跑同一份代码。
   表现层（音效/飘字/UI）一律通过事件总线广播。
   ============================================================ */
(function () {
  const ROOT = (typeof window !== 'undefined') ? window : globalThis;
  const PP = (ROOT.PP = ROOT.PP || {});
  const Sim = (PP.Sim = {});
  const Core = () => PP.Core;
  const TICK = 1 / 30;
  Sim.TICK = TICK;

  /* ---------------- 玩家 ---------------- */
  function makePlayer(G, id, name) {
    const p = {
      id: id, name: name || ('P' + id),
      x: PP.World.spawn.x, y: PP.World.spawn.y, a: PP.World.spawn.a,
      pitchBase: 0, pitch: 0,
      hp: 100, maxHp: 100, ap: 0, maxAp: 100,
      radius: 0.26, invuln: 0,
      downed: false, downT: 0, eliminateAt: 45, eliminated: false, reviveProg: 0, _helper: null,
      weapon: 0,
      insts: [
        { def: 0, rarity: 0, affixes: [] },
        { def: 1, rarity: 0, affixes: [] },
        { def: 2, rarity: 0, affixes: [] }
      ],
      unlocked: [true, false, false],
      mag: [PP.WEAPONS[0].mag, 0, 0],
      reserve: [Infinity, 0, 0],
      fireCd: 0, reloadT: 0, muzzleT: 0, kickPitch: 0, weaponRaise: 0,
      bobT: 0, bobAmt: 0, speed: 0,
      mods: {}, perks: [], level: 1, xp: 0, xpNext: 100, pendingPerks: 0, perkChoices: null,
      score: 0, kills: 0, headshots: 0, shotsFired: 0, shotsHit: 0,
      combo: 0, comboT: 0, bestCombo: 0,
      viewShake: 0, viewOffsetY: 0, hurtFlash: 0,
      weaponSwayX: 0, weaponBobY: 0,
      input: { fwd: 0, strafe: 0, turn: 0, pitch: 0, sprint: false, fire: false, firePressed: false, revive: false, switchTo: -1, reload: false }
    };
    p.comboMult = function () { return Math.min(4, 1 + Math.floor(p.combo / 4) * 0.5); };
    p.registerCombo = function () {
      p.combo++; p.comboT = 3.2;
      if (p.combo > p.bestCombo) p.bestCombo = p.combo;
    };
    p.wStats = function () { return PP.Rogue.stats(p.insts[p.weapon], p.mods); };
    return p;
  }
  Sim.makePlayer = makePlayer;

  /* ---------------- 创建世界 ---------------- */
  Sim.create = function (seed, opts) {
    const o = opts || {};
    const s = seed === undefined ? ((Math.random() * 0xffffffff) >>> 0) : (seed >>> 0);
    PP.World.generate(s);

    const G = {
      seed: s,
      state: 'playing',
      solo: o.solo !== false,
      time: 0, elapsed: 0, tick: 0,
      rng: new (Core().Rng)(s ^ 0x5f3a),
      bus: new (Core().Bus)(),
      players: new Map(), playerList: [],
      enemies: [], projectiles: [], pickups: [], particles: [],
      renderList: [],
      threat: 1, threatT: 60, spawnT: 1.2, flowT: 0,
      score: 0, kills: 0,
      friendlyFire: 0.35,      // 队友伤害系数（房主可调 0 / 0.35 / 1）
      me: null, player: null,  // 客户端视角（服务器为 null）
      // 表现层字段（由 syncView 从本地玩家拷贝，供渲染/HUD 直接读）
      weapon: 0, mag: [12, 0, 0], reserve: [Infinity, 0, 0], unlocked: [true, false, false],
      muzzleT: 0, weaponSwayX: 0, weaponBobY: 0, weaponRaise: 0,
      kickPitch: 0, viewOffsetY: 0, shake: 0, hurtFlash: 0,
      combo: 0, headshots: 0, shotsFired: 0, shotsHit: 0
    };

    G.damagePlayer = function (id, dmg, srcId, sx, sy) {
      const p = G.players.get(id);
      if (!p || p.eliminated || p.downed || p.invuln > 0) return;
      let d = dmg;
      if (srcId) d *= G.friendlyFire;      // 来自其他玩家 → 打折
      p.invuln = 0.16;
      const absorbed = Math.min(p.ap, d * 0.6);
      p.ap -= absorbed; d -= absorbed;
      p.hp -= d;
      p.hurtFlash = Math.min(1, p.hurtFlash + d / 45 + 0.18);
      p.viewShake = Math.min(1, p.viewShake + d / 60);
      if (p.mods.thorns) {
        for (const e of G.enemies) {
          if (e.state !== 'alive') continue;
          const d2 = (e.x - p.x) * (e.x - p.x) + (e.y - p.y) * (e.y - p.y);
          if (d2 < 9) PP.Ent.damage(G, e, p.mods.thorns * (1 - Math.sqrt(d2) / 3), false, { killerId: p.id });
        }
      }
      G.bus.emit('playerHurt', { id: id, dmg: dmg, x: sx, y: sy, byPlayer: !!srcId });
      if (p.hp <= 0) {
        p.hp = 0;
        if (G.solo) {
          p.eliminated = true;
          G.state = 'over';
          G.bus.emit('dead', { id: id });
        } else {
          p.downed = true; p.downT = 0; p.reviveProg = 0;
          G.bus.emit('downed', { id: id, name: p.name });
          let anyUp = false;
          for (const q of G.playerList) if (!q.downed && !q.eliminated) anyUp = true;
          if (!anyUp) { G.state = 'over'; G.bus.emit('gameover', {}); }
        }
      }
    };

    G.tryPickup = function (p, kind, item) {
      if (kind === 'health') {
        if (p.hp >= p.maxHp) return false;
        p.hp = Math.min(p.maxHp, p.hp + 25);
        G.bus.emit('pickup', { id: p.id, kind: kind, text: '+25 生命' });
        return true;
      }
      if (kind === 'armor') {
        p.ap = Math.min(p.maxAp, p.ap + 40);
        G.bus.emit('pickup', { id: p.id, kind: kind, text: '+40 护甲' });
        return true;
      }
      if (kind === 'ammo') {
        let got = false;
        for (let i = 1; i < 3; i++) {
          if (!p.unlocked[i]) continue;
          const cap = PP.WEAPONS[i].maxReserve * (1 + (p.mods.ammoMax || 0));
          if (p.reserve[i] < cap) {
            p.reserve[i] = Math.min(cap, p.reserve[i] + (i === 1 ? 8 : 50));
            got = true;
          }
        }
        if (!got) return false;
        G.bus.emit('pickup', { id: p.id, kind: kind, text: '+弹药' });
        return true;
      }
      if (kind === 'shotgun' || kind === 'pulse') {
        const i = kind === 'shotgun' ? 1 : 2;
        const luck = (p.mods.luck || 0);
        const inst = PP.Rogue.rollWeapon(G.rng, i, G.threat + luck * 2);
        if (!p.unlocked[i]) {
          p.unlocked[i] = true;
          p.insts[i] = inst;
          p.reserve[i] = PP.WEAPONS[i].startReserve;
          p.mag[i] = PP.Rogue.stats(inst, p.mods).mag;
          Sim.switchWeapon(G, p, i);
          G.bus.emit('pickup', {
            id: p.id, kind: kind,
            text: '获得 ' + PP.Rogue.weaponName(inst),
            rarity: inst.rarity, affixes: inst.affixes
          });
          return true;
        }
        if (inst.rarity > p.insts[i].rarity) {
          p.insts[i] = inst;
          p.reserve[i] = Math.max(p.reserve[i], PP.Rogue.stats(inst, p.mods).mag * 2);
          Sim.switchWeapon(G, p, i);
          G.bus.emit('pickup', {
            id: p.id, kind: kind,
            text: '换装 ' + PP.Rogue.weaponName(inst),
            rarity: inst.rarity, affixes: inst.affixes
          });
          return true;
        }
        // 重复武器 → 当弹药
        const cap = PP.WEAPONS[i].maxReserve * (1 + (p.mods.ammoMax || 0));
        if (p.reserve[i] < cap) {
          p.reserve[i] = Math.min(cap, p.reserve[i] + (i === 1 ? 8 : 50));
          G.bus.emit('pickup', { id: p.id, kind: 'ammo', text: '+弹药' });
          return true;
        }
        return false;
      }
      if (kind === 'chest') {
        const r = G.rng.next();
        let give;
        if (r < 0.30) give = 'health';
        else if (r < 0.50) give = 'ammo';
        else if (r < 0.72) give = 'armor';
        else give = p.unlocked[1] ? (p.unlocked[2] ? 'ammo' : 'pulse') : 'shotgun';
        G.bus.emit('chest', { id: p.id, give: give });
        return G.tryPickup(p, give, item);
      }
      return false;
    };

    // 补给箱（POI）
    for (const poi of PP.World.pois) {
      if (poi.type === 'camp') continue;
      G.pickups.push({ id: Core().uid(), kind: 'chest', x: poi.x, y: poi.y, z: 0.18, t: G.rng.next() * 6.28, life: Infinity });
    }

    G.bus.emit('start', { seed: s });
    return G;
  };

  /* ---------------- 玩家管理 ---------------- */
  Sim.addPlayer = function (G, id, name) {
    if (G.players.has(id)) return G.players.get(id);
    const p = makePlayer(G, id, name);
    // 多个玩家错开出生点，避免叠在一起
    const n = G.playerList.length;
    if (n > 0) {
      const s = PP.World.randomSpawn(G.rng, PP.World.spawn.x, PP.World.spawn.y, 1.5, 5);
      p.x = s.x; p.y = s.y;
    }
    G.players.set(id, p);
    G.playerList.push(p);
    G.bus.emit('join', { id: id, name: p.name });
    return p;
  };
  Sim.removePlayer = function (G, id) {
    const p = G.players.get(id);
    if (!p) return;
    G.players.delete(id);
    const i = G.playerList.indexOf(p);
    if (i >= 0) G.playerList.splice(i, 1);
    G.bus.emit('leave', { id: id, name: p.name });
  };
  Sim.setInput = function (G, id, input) {
    const p = G.players.get(id);
    if (!p) return;
    for (const k in input) p.input[k] = input[k];
  };

  /* ---------------- 武器 ---------------- */
  Sim.switchWeapon = function (G, p, i) {
    if (i === p.weapon || !p.unlocked[i]) return;
    p.weapon = i; p.reloadT = 0; p.weaponRaise = 44;
    p.fireCd = Math.max(p.fireCd, 0.18);
    G.bus.emit('switch', { id: p.id, index: i, name: PP.Rogue.weaponName(p.insts[i]), rarity: p.insts[i].rarity });
  };

  Sim.startReload = function (G, p) {
    const s = p.wStats();
    if (p.reloadT > 0 || p.mag[p.weapon] >= s.mag) return;
    if (p.reserve[p.weapon] !== Infinity && p.reserve[p.weapon] <= 0) return;
    p.reloadT = s.reload;
    G.bus.emit('reload', { id: p.id, dur: s.reload });
  };

  Sim.fire = function (G, p) {
    if (G.state !== 'playing' || p.downed || p.eliminated) return;
    if (p.reloadT > 0 || p.fireCd > 0) return;
    const s = p.wStats();
    if (p.mag[p.weapon] <= 0) {
      p.fireCd = 0.35;
      G.bus.emit('dryfire', { id: p.id });
      Sim.startReload(G, p);
      return;
    }
    p.mag[p.weapon]--;
    p.fireCd = s.cd;
    p.muzzleT = 0.06;
    p.kickPitch += 0.020 * s.kick;
    p.viewShake = Math.min(1, p.viewShake + 0.06 * s.kick);
    p.shotsFired++;
    G.bus.emit('shot', { id: p.id, weapon: p.weapon, x: p.x, y: p.y });

    let anyHit = false, anyHead = false;
    const maxHits = 1 + (s.pierce || 0);
    for (let i = 0; i < s.pellets; i++) {
      const hits = PP.Ent.hitscan(G, p, p.a, p.pitch, s.spread, s.range, maxHits);
      let chained = 0;
      for (const h of hits) {
        if (h.kind === 'enemy') {
          let dmg = s.dmg;
          if (s.falloff && h.dist > s.range * 0.45) {
            dmg *= Math.max(0.35, 1 - (h.dist - s.range * 0.45) / (s.range * 0.75));
          }
          if (h.head) dmg *= s.headMul;
          h.e.lastKiller = p.id;
          PP.Ent.damage(G, h.e, dmg, h.head, {
            killerId: p.id, knock: s.knockback,
            burn: s.burn ? s.burn : 0, burnDps: s.burn ? s.dmg * 0.25 : 0
          });
          anyHit = true; if (h.head) anyHead = true;
          // 链式传导
          if (s.chain && chained < s.chain) {
            for (const o of G.enemies) {
              if (o === h.e || o.state !== 'alive') continue;
              const d2 = (o.x - h.e.x) * (o.x - h.e.x) + (o.y - h.e.y) * (o.y - h.e.y);
              if (d2 < 16) {
                o.lastKiller = p.id;
                PP.Ent.damage(G, o, s.dmg * 0.5, false, { killerId: p.id });
                chained++;
                G.bus.emit('chain', { x1: h.e.x, y1: h.e.y, x2: o.x, y2: o.y });
                break;
              }
            }
          }
          for (let k = 0; k < 3; k++) {
            G.particles.push({
              x: h.x, y: h.y, z: h.z,
              vx: (G.rng.next() - 0.5) * 1.4, vy: (G.rng.next() - 0.5) * 1.4, vz: 0.6 + G.rng.next(),
              life: 0.22, size: 1, tex: 'blood'
            });
          }
        } else if (h.kind === 'player') {
          G.damagePlayer(h.p.id, s.dmg * (h.head ? s.headMul : 1), p.id, h.x, h.y);
          anyHit = true;
          G.bus.emit('friendlyHit', { id: p.id, target: h.p.id });
        }
      }
      if (!hits.length) {
        for (let k = 0; k < 2; k++) {
          G.particles.push({
            x: hits.endX - Math.cos(p.a) * 0.05, y: hits.endY - Math.sin(p.a) * 0.05, z: hits.endZ,
            vx: (G.rng.next() - 0.5) * 1.2, vy: (G.rng.next() - 0.5) * 1.2, vz: 0.5 + G.rng.next(),
            life: 0.18, size: 1, tex: 'spark'
          });
        }
      }
    }
    if (anyHit) { p.shotsHit++; G.bus.emit('hit', { id: p.id, head: anyHead }); }
    if (p.mag[p.weapon] <= 0) Sim.startReload(G, p);
  };

  /* ---------------- Perk ---------------- */
  Sim.rollPerkChoices = function (G, p) {
    const taken = p.perks.slice();
    p.perkChoices = PP.Rogue.rollPerks(G.rng, taken, 3);
    G.bus.emit('perkChoices', { id: p.id, list: p.perkChoices.map(k => ({ id: k.id, name: k.name, desc: k.desc })) });
    return p.perkChoices;
  };
  Sim.choosePerk = function (G, p, perkId) {
    if (!p || p.pendingPerks <= 0) return false;
    const def = PP.Rogue.PERKS.find(k => k.id === perkId);
    if (!def || p.perks.indexOf(perkId) >= 0) return false;
    def.apply(p.mods, p);
    p.perks.push(perkId);
    p.pendingPerks--;
    p.perkChoices = null;
    if (def.id === 'ammo') {
      for (let i = 1; i < 3; i++) if (p.unlocked[i]) p.reserve[i] = PP.WEAPONS[i].maxReserve * (1 + (p.mods.ammoMax || 0));
    }
    G.bus.emit('perkTaken', { id: p.id, perk: perkId, name: def.name });
    return true;
  };

  /* ---------------- 单个玩家更新 ---------------- */
  function updatePlayer(G, p, dt) {
    const inp = p.input;
    if (p.eliminated) return;

    p.invuln = Math.max(0, p.invuln - dt);
    p.hurtFlash = Math.max(0, p.hurtFlash - dt * 2.2);
    p.viewShake *= Math.exp(-dt * 7);
    p.kickPitch *= Math.exp(-dt * 9);
    p.muzzleT = Math.max(0, p.muzzleT - dt);
    p.weaponRaise *= Math.exp(-dt * 11);
    if (p.comboT > 0) { p.comboT -= dt; if (p.comboT <= 0) p.combo = 0; }

    if (inp.turn) p.a += inp.turn * dt;
    if (inp.pitch) p.pitchBase = Core().clamp(p.pitchBase + inp.pitch * dt, -1.30, 1.30);
    p.pitch = p.pitchBase + p.kickPitch;
    p.viewOffsetY = Math.sin(G.time * 41 + p.id) * p.viewShake * 3.2;

    // 移动（倒地只能爬行）
    const crawl = p.downed ? 0.32 : 1;
    let fwd = inp.fwd || 0, strafe = inp.strafe || 0;
    const mag = Math.hypot(fwd, strafe);
    if (mag > 1) { fwd /= mag; strafe /= mag; }
    // 疾跑只对"向前/侧向"生效：后退不能冲刺，否则纯后退放风筝零风险
    const backing = fwd < -0.1;
    const inWater = PP.World.inWater(p.x, p.y);
    const sprintMul = (inp.sprint && !backing) ? (1.5 + (p.mods.sprint || 0)) : 1;
    const st = p.wStats();
    const speed = 3.3 * sprintMul * (backing ? 0.72 : 1) * (inWater ? 0.6 : 1) * crawl *
      (st.moveSpeed || 1) * (1 + (p.mods.moveSpeed || 0));
    const dirX = Math.cos(p.a), dirY = Math.sin(p.a);
    const vx = (dirX * fwd - dirY * strafe) * speed;
    const vy = (dirY * fwd + dirX * strafe) * speed;
    const r = p.radius;
    if (!PP.World.circleBlocked(p.x + vx * dt, p.y, r)) p.x += vx * dt;
    if (!PP.World.circleBlocked(p.x, p.y + vy * dt, r)) p.y += vy * dt;
    p.speed = Math.hypot(vx, vy);
    p.bobT += dt * (6 + p.speed * 1.7);
    p.bobAmt += ((p.speed > 0.1 ? 1 : 0) - p.bobAmt) * Math.min(1, dt * 8);
    p.weaponSwayX = Math.sin(p.bobT * 0.5) * 5 * p.bobAmt - p.kickPitch * 40;
    p.weaponBobY = Math.abs(Math.sin(p.bobT)) * 4.5 * p.bobAmt;
    if (p.reloadT > 0) p.weaponBobY += Math.sin((1 - p.reloadT / Math.max(0.01, st.reload)) * Math.PI) * 26;

    if (p.downed) { p.downT += dt; return; }

    // 武器
    if (inp.switchTo >= 0 && inp.switchTo < 3) { Sim.switchWeapon(G, p, inp.switchTo); inp.switchTo = -1; }
    else if (inp.switchTo === -2) {          // 移动端"换枪"按钮：循环切到下一把已解锁的
      for (let i = 1; i <= 3; i++) {
        const n = (p.weapon + i) % 3;
        if (p.unlocked[n]) { Sim.switchWeapon(G, p, n); break; }
      }
      inp.switchTo = -1;
    }
    if (inp.reload) Sim.startReload(G, p);
    if (p.fireCd > 0) p.fireCd -= dt;
    if (p.reloadT > 0) {
      p.reloadT -= dt;
      if (p.reloadT <= 0) {
        p.reloadT = 0;
        const need = st.mag - p.mag[p.weapon];
        if (p.reserve[p.weapon] === Infinity) p.mag[p.weapon] = st.mag;
        else {
          const take = Math.min(need, p.reserve[p.weapon]);
          p.mag[p.weapon] += take; p.reserve[p.weapon] -= take;
        }
      }
    }
    if (st.auto) { if (inp.fire) Sim.fire(G, p); }
    else if (inp.firePressed) { inp.firePressed = false; Sim.fire(G, p); }

    // 救援：标记正在被谁救
    if (inp.revive) {
      let best = null, bd = 1e9;
      for (const o of G.playerList) {
        if (o === p || !o.downed || o.eliminated) continue;
        const d = Math.hypot(o.x - p.x, o.y - p.y);
        if (d < 1.9 && d < bd) { bd = d; best = o; }
      }
      if (best) { best._helper = p; p.reviving = best.id; } else p.reviving = 0;
    } else p.reviving = 0;
  }

  /* ---------------- 威胁导演 ---------------- */
  function director(G, dt) {
    G.threatT -= dt;
    if (G.threatT <= 0) {
      G.threat++; G.threatT = 50;      // 50s 一级：更早出骷髅（远程），惩罚纯后退放风筝
      G.bus.emit('threat', { level: G.threat });
    }
    let alive = 0;
    for (const e of G.enemies) if (e.state === 'alive') alive++;
    const target = Math.min(32, 4 + G.threat * 2 + (G.playerList.length - 1) * 2);
    G.spawnT -= dt;
    if (G.spawnT > 0 || alive >= target) return;
    G.spawnT = Math.max(0.35, 1.6 - G.threat * 0.08);

    // 任选一位存活玩家作为锚点，在他的流场里刷
    const anchors = G.playerList.filter(p => !p.eliminated && !p.downed);
    if (!anchors.length) return;
    const idx = (G.rng.next() * anchors.length) | 0;
    const anchor = anchors[idx];
    const s = PP.World.randomSpawn(G.rng, anchor.x, anchor.y, 24, 44);
    const fi = G.playerList.indexOf(anchor);
    // 在流场窗口内就必须确认连通（避免刷进封闭区）；窗口外靠"长期无进展就回收"兜底
    if (Math.hypot(s.x - anchor.x, s.y - anchor.y) <= 25 && !PP.World.flowReachable(fi, s.x, s.y)) return;
    let pick = 'zombie';
    const r = G.rng.next();
    if (G.threat >= 3 && r < 0.28) pick = 'skeleton';
    else if (G.threat >= 2 && r < 0.35) pick = 'husk';
    const d = Math.hypot(s.x - anchor.x, s.y - anchor.y);
    if (!PP.World.losClear(anchor.x, anchor.y, s.x, s.y) || d > 22) {
      PP.Ent.spawn(G, pick, s.x, s.y);
      G.bus.emit('spawn', { x: s.x, y: s.y });
    }
  }

  /* ---------------- 只做移动（客户端预测用，规则必须与服务端一致） ---------------- */
  Sim.moveOnly = function (p, inp, dt, mods, downed) {
    const crawl = downed ? 0.32 : 1;
    let fwd = inp.fwd || 0, strafe = inp.strafe || 0;
    const mag = Math.hypot(fwd, strafe);
    if (mag > 1) { fwd /= mag; strafe /= mag; }
    if (inp.turn) p.a += inp.turn * dt;
    if (inp.pitch) p.pitchBase = Core().clamp(p.pitchBase + inp.pitch * dt, -1.30, 1.30);
    p.pitch = p.pitchBase + (p.kickPitch || 0);
    const inWater = PP.World.inWater(p.x, p.y);
    // 与 updatePlayer 同规则：后退不能冲刺
    const backing = fwd < -0.1;
    const sprintMul = (inp.sprint && !backing) ? (1.5 + ((mods || {}).sprint || 0)) : 1;
    const speed = 3.3 * sprintMul * (backing ? 0.72 : 1) * (inWater ? 0.6 : 1) * crawl *
      (1 + ((mods || {}).moveSpeed || 0));
    const dirX = Math.cos(p.a), dirY = Math.sin(p.a);
    const vx = (dirX * fwd - dirY * strafe) * speed;
    const vy = (dirY * fwd + dirX * strafe) * speed;
    const r = p.radius || 0.26;
    if (!PP.World.circleBlocked(p.x + vx * dt, p.y, r)) p.x += vx * dt;
    if (!PP.World.circleBlocked(p.x, p.y + vy * dt, r)) p.y += vy * dt;
    p.speed = Math.hypot(vx, vy);
  };

  /* ---------------- 表现层字段同步（只有客户端有 me） ---------------- */
  function syncView(G) {
    const p = G.me;
    if (!p) return;
    G.player = p;
    G.weapon = p.weapon;
    G.mag = p.mag; G.reserve = p.reserve; G.unlocked = p.unlocked;
    G.muzzleT = p.muzzleT;
    G.weaponSwayX = p.weaponSwayX; G.weaponBobY = p.weaponBobY; G.weaponRaise = p.weaponRaise;
    G.kickPitch = p.kickPitch; G.viewOffsetY = p.viewOffsetY; G.shake = p.viewShake;
    G.hurtFlash = p.hurtFlash;
    G.combo = p.combo; G.headshots = p.headshots;
    G.shotsFired = p.shotsFired; G.shotsHit = p.shotsHit;
    G.ammoPct = p.mag[p.weapon];
  }
  Sim.syncView = syncView;

  /* ---------------- 主 tick ---------------- */
  Sim.tick = function (G) {
    const dt = TICK;
    if (G.state !== 'playing') return;
    G.time += dt; G.elapsed += dt; G.tick++;

    for (const p of G.playerList) updatePlayer(G, p, dt);

    // 倒地 / 救援 / 流血
    for (const p of G.playerList) {
      if (!p.downed || p.eliminated) { p.reviveProg = 0; continue; }
      if (p._helper) {
        p.reviveProg += dt * (1 + (p._helper.mods.reviveSpeed || 0)) / 2.0;
        if (p.reviveProg >= 1) {
          p.downed = false; p.downT = 0; p.reviveProg = 0;
          p.hp = Math.max(30, Math.round(p.maxHp * 0.4));
          p.invuln = 1.0;
          const helper = p._helper;
          if (helper) { helper.score += 150; helper.kills += 0; }
          G.bus.emit('revived', { id: p.id, by: helper ? helper.id : 0, name: p.name });
        }
      } else {
        p.reviveProg = Math.max(0, p.reviveProg - dt * 0.6);
      }
      p._helper = null;
      const limit = 45 + (p.mods.bleed || 0);
      if (p.downT > limit) {
        p.eliminated = true;
        G.bus.emit('eliminated', { id: p.id, name: p.name });
        let anyUp = false;
        for (const q of G.playerList) if (!q.downed && !q.eliminated) anyUp = true;
        if (!anyUp) { G.state = 'over'; G.bus.emit('gameover', {}); }
      }
    }

    PP.Ent.update(G, dt);
    director(G, dt);

    // 回收过远的敌人（相对最近的玩家）
    for (let i = G.enemies.length - 1; i >= 0; i--) {
      const e = G.enemies[i];
      let nearest = 1e9;
      for (const p of G.playerList) {
        const d = Math.hypot(e.x - p.x, e.y - p.y);
        if (d < nearest) nearest = d;
      }
      if (nearest > 90) G.enemies.splice(i, 1);
    }

    syncView(G);
  };
})();
