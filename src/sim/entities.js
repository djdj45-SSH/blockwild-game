/* ============================================================
   entities.js — 敌人 / 投射物 / 拾取物 / 粒子 / 命中判定（多人版）
   纯逻辑，无 DOM：浏览器单机与 Node 权威服务器共用同一份
   ============================================================ */
(function () {
  const ROOT = (typeof window !== 'undefined') ? window : globalThis;
  const PP = (ROOT.PP = ROOT.PP || {});
  const E = (PP.Ent = {});
  const W = () => PP.World;

  /* 玩家视高（米）。必须与 /src/client/render3d.js 的 EYE / EYE_DOWN 一致 ——
     两处不一致会出现"准星明明瞄着头、射线却从胸口穿过"的诡异手感。
     值取自 Minecraft 原版：模型 1.8 米，眼睛在 1.62 米。 */
  const EYE_H = 1.62, EYE_LOW = 0.42, PLAYER_H = 1.80;

  /* ---------------- 敌人配置 ----------------
     ⚠️ height 必须与 /src/three/mcModel.js 里的模型实际高度一致：
     换成 Minecraft 原版模型后，人形是 32px×PX = 1.8 米、苦力怕 26px = 1.46 米。
     命中判定的射线-包围盒相交用这个值，对不上就会出现"明明打中却穿过去"。 */
  E.TYPES = {
    zombie: {
      key: 'zombie', hp: 40, speed: 2.30, radius: 0.30,
      height: 1.80,
      dmg: 9, atkRange: 1.05, atkCd: 0.85, windup: 0.32,
      score: 100, ranged: false, mass: 1, xp: 12
    },
    husk: {
      key: 'husk', hp: 140, speed: 1.34, radius: 0.42,
      height: 1.80,
      dmg: 24, atkRange: 1.30, atkCd: 1.30, windup: 0.45,
      score: 260, ranged: false, mass: 3, xp: 34
    },
    skeleton: {
      key: 'skeleton', hp: 44, speed: 1.65, radius: 0.32,
      height: 1.80,
      dmg: 12, atkRange: 999, atkCd: 1.85, windup: 0.42,
      score: 190, ranged: true, shootRange: 12, projSpeed: 7.2, mass: 1, xp: 20
    },
    creeper: {
      key: 'creeper', hp: 55, speed: 2.05, radius: 0.32,
      height: 1.46,
      dmg: 38, atkRange: 1.55, atkCd: 99, windup: 0.95,
      score: 220, ranged: false, explode: true, blastR: 2.6, mass: 2, xp: 28
    },
    spider: {
      key: 'spider', hp: 26, speed: 3.55, radius: 0.24,
      height: 0.90,
      dmg: 5, atkRange: 0.95, atkCd: 0.42, windup: 0.16,
      score: 130, ranged: false, mass: 0.7, xp: 15
    }
  };

  /* ---------------- 生成 ---------------- */
  E.spawn = function (G, typeKey, x, y) {
    const T = E.TYPES[typeKey];
    const e = {
      id: PP.Core.uid(), type: typeKey, T: T,
      x: x, y: y,
      hp: T.hp, maxHp: T.hp,
      radius: T.radius, height: T.height,
      state: 'alive',
      cd: 0.6 + G.rng.next() * 0.6, windup: 0, hurt: 0, deadT: 0,
      anim: G.rng.next() * 6.28, bob: 0,
      strafe: G.rng.chance(0.5) ? 1 : -1, strafeT: 1 + G.rng.next() * 2,
      stuck: 0, unstick: 0, unstickDir: 0, spawnT: 0.35,
      burn: 0, burnDps: 0, lastKiller: 0, slow: 0,
      tp: null, ti: 0, retarget: 0
    };
    // z 轴物理初值（真 3D）：不初始化会让第一帧 tickZ 判定为"从天而降"
    const w0 = W();
    e.z = w0.surfZAt ? w0.surfZAt(x, y) : 0;
    e.vz = 0; e.onGround = true; e.grounded = true; e.stuckT = 0;
    G.enemies.push(e);
    return e;
  };

  /* ---------------- 目标选择 ---------------- */
  function pickTarget(G, e) {
    let best = null, bd = 1e9, bi = 0;
    for (let i = 0; i < G.playerList.length; i++) {
      const p = G.playerList[i];
      if (p.downed || p.eliminated) continue;
      const d = (p.x - e.x) * (p.x - e.x) + (p.y - e.y) * (p.y - e.y);
      if (d < bd) { bd = d; best = p; bi = i; }
    }
    if (!best) { e.tp = null; return; }
    e.tp = best; e.ti = bi;
  }

  /* ---------------- 伤害 ---------------- */
  E.damage = function (G, e, amount, head, opts) {
    if (e.state !== 'alive') return false;
    const o = opts || {};
    e.hp -= amount;
    e.hurt = 0.14;
    if (o.burn) { e.burn = Math.max(e.burn, o.burn); e.burnDps = Math.max(e.burnDps, o.burnDps || 0); }
    if (o.slow) e.slow = Math.max(e.slow, o.slow);
    const src = o.from || e.tp;
    const dx = e.x - (src ? src.x : e.x + 1), dy = e.y - (src ? src.y : e.y);
    const d = Math.hypot(dx, dy) || 1;
    const kb = (head ? 0.16 : 0.10) * (o.knock || 1) / (e.T.mass || 1);
    moveEntity(e, (dx / d) * kb, (dy / d) * kb);
    if (e.hp <= 0) { E.kill(G, e, head, o.killerId); return true; }
    return false;
  };

  E.kill = function (G, e, head, killerId) {
    e.state = 'dead'; e.deadT = 0; e.hp = 0;
    const killer = (killerId !== undefined && killerId) ? G.players.get(killerId) : null;
    const mult = killer ? killer.comboMult() : 1;
    const gain = Math.round(e.T.score * (head ? 1.5 : 1) * mult);
    G.score += gain; G.kills++;
    if (killer) {
      killer.score += gain; killer.kills++;
      if (head) killer.headshots++;
      killer.registerCombo();
      grantXp(G, killer, e.T.xp);
      const st = killer.wStats();
      if (st.leech) { killer.hp = Math.min(killer.maxHp, killer.hp + st.leech); G.bus.emit('heal', { id: killer.id, v: st.leech }); }
      if (st.scav && G.rng.chance(st.scav / 100)) {
        const i = killer.weapon;
        if (killer.reserve[i] !== Infinity) {
          const cap = PP.WEAPONS[i].maxReserve * (1 + (killer.mods.ammoMax || 0));
          killer.reserve[i] = Math.min(cap, killer.reserve[i] + Math.max(2, Math.round(st.mag * 0.5)));
          G.bus.emit('ammoGain', { id: killer.id });
        }
      }
      if (st.boom) {
        G.bus.emit('explode', { x: e.x, y: e.y, r: 2.2 });
        for (const o of G.enemies) {
          if (o === e || o.state !== 'alive') continue;
          const d2 = (o.x - e.x) * (o.x - e.x) + (o.y - e.y) * (o.y - e.y);
          if (d2 < 4.84) E.damage(G, o, st.boom * (1 - Math.sqrt(d2) / 2.2), false, { killerId: killer.id });
        }
      }
    }
    G.bus.emit('kill', { enemy: e, gain: gain, head: !!head, x: e.x, y: e.y, killerId: killerId });
    for (let i = 0; i < 12; i++) {
      const a = G.rng.next() * Math.PI * 2;
      const sp = 0.6 + G.rng.next() * 2.4;
      G.particles.push({
        /* ⚠️ 真 3D：血雾要从敌人**实际的高度**冒出来。这里原先用 e.z0（恒 0 的
           旧 2.5D 遗留字段），敌人站在山崖/屋顶上时被击杀，血会从十几米下的
           地面喷出来。玩家掉不觉察，但对比起 Ia live 的感觉是很明显的。 */
        x: e.x, y: e.y, z: (e.z || 0) + e.height * (0.3 + G.rng.next() * 0.5),
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: 1.2 + G.rng.next() * 2.4,
        life: 0.5 + G.rng.next() * 0.5, size: G.rng.chance(0.3) ? 1.6 : 1.0,
        tex: G.rng.chance(0.35) ? 'gib' : (G.rng.chance(0.5) ? 'bloodD' : 'blood')
      });
    }
    const r = G.rng.next();
    if (r < 0.11) E.dropPickup(G, e.x, e.y, 'health');
    else if (r < 0.36) E.dropPickup(G, e.x, e.y, 'ammo');
  };

  function grantXp(G, p, amount) {
    if (!p || p.eliminated) return;
    const mul = 1 + ((p.mods && p.mods.xpMul) || 0);
    p.xp += Math.round(amount * mul);
    let guard = 0;
    while (p.xp >= p.xpNext && p.level < 30 && guard++ < 10) {
      p.xp -= p.xpNext;
      p.level++;
      p.xpNext = PP.Rogue.xpForLevel(p.level);
      p.pendingPerks = (p.pendingPerks || 0) + 1;
      G.bus.emit('levelup', { id: p.id, level: p.level });
    }
  }
  E.grantXp = grantXp;

  E.dropPickup = function (G, x, y, kind) {
    G.pickups.push({ id: PP.Core.uid(), kind: kind, x: x, y: y, z: 0.18, t: G.rng.next() * 6.28, life: 40 });
  };

  /* ---------------- 移动 ---------------- */
  function moveEntity(o, dx, dy) {
    const w = W();
    const r = o.radius || 0.28;
    if (w.moveCircle) w.moveCircle(o, dx, dy, r);
    else {
      if (!w.circleBlocked(o.x + dx, o.y, r)) o.x += dx;
      if (!w.circleBlocked(o.x, o.y + dy, r)) o.y += dy;
    }
  }
  /** 垂直物理：敌人也要吃重力，否则会飘在挖开的坑上方 / 站在半空 */
  function tickEntityZ(o, dt) {
    const w = W();
    if (!w.tickZ) return;
    // 跳跃：卡住时跳一下（MC 的 mob 就是这么爬台阶的）
    if (o.grounded === false && o.stuckT > 0.5 && o.canJump !== false) {
      if (w.jump) w.jump(o);
      o.stuckT = 0;
    }
    w.tickZ(o, dt);
    if (o.onGround) o.grounded = true; else o.grounded = false;
  }
  E.tickEntityZ = tickEntityZ;
  E.moveEntity = moveEntity;

  /* ---------------- 更新 ---------------- */
  E.update = function (G, dt) {
    const w = W();

    G.flowT -= dt;
    if (G.flowT <= 0) {
      const pts = [];
      for (const p of G.playerList) if (!p.eliminated) pts.push([p.x, p.y]);
      if (pts.length) w.buildFlows(pts);
      G.flowT = 0.25;
    }

    for (let i = G.enemies.length - 1; i >= 0; i--) {
      const e = G.enemies[i];
      e.anim += dt;
      if (e.hurt > 0) e.hurt -= dt;
      if (e.spawnT > 0) e.spawnT -= dt;

      if (e.state === 'dead') {
        e.deadT += dt;
        if (e.deadT > 8) G.enemies.splice(i, 1);
        continue;
      }

      if (e.burn > 0) {
        e.burn -= dt;
        e.hp -= e.burnDps * dt;
        if (e.hp <= 0) { E.kill(G, e, false, e.lastKiller); continue; }
      }

      e.retarget -= dt;
      if (e.retarget <= 0 || !e.tp || e.tp.downed || e.tp.eliminated) { pickTarget(G, e); e.retarget = 0.5; }
      if (!e.tp) continue;

      const p = e.tp;
      const dx = p.x - e.x, dy = p.y - e.y;
      const dist = Math.hypot(dx, dy) || 1e-6;
      const nx = dx / dist, ny = dy / dist;
      const T = e.T;
      const canSee = w.losClear(e.x, e.y, p.x, p.y);
      if (e.cd > 0) e.cd -= dt;

      if (e.windup > 0) {
        e.windup -= dt;
        if (e.windup <= 0) {
          if (T.explode) {
            // 爬行者自爆：范围伤害 + 粒子，然后变尸体
            const R = T.blastR || 2.6;
            G.bus.emit('explode', { x: e.x, y: e.y, r: R });
            for (const q of G.playerList) {
              if (q.downed || q.eliminated) continue;
              const d = Math.hypot(q.x - e.x, q.y - e.y);
              if (d < R) G.damagePlayer(q.id, T.dmg * Math.max(0.35, 1 - d / (R * 1.25)), 0, e.x, e.y);
            }
            for (let k = 0; k < 16; k++) {
              const a = G.rng.next() * Math.PI * 2;
              const sp = 1.2 + G.rng.next() * 3.2;
              G.particles.push({
                x: e.x, y: e.y, z: 0.3 + G.rng.next() * 0.5,
                vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: 1.5 + G.rng.next() * 2.5,
                life: 0.45 + G.rng.next() * 0.4, size: G.rng.chance(0.4) ? 1.8 : 1.1,
                tex: G.rng.chance(0.5) ? 'spark' : 'gib'
              });
            }
            E.kill(G, e, false, e.lastKiller);
            continue;
          }
          if (!T.ranged) {
            if (dist <= T.atkRange + 0.35 && canSee) G.damagePlayer(p.id, T.dmg, 0, e.x, e.y);
          } else if (canSee && dist <= T.shootRange) {
            G.projectiles.push({
              id: PP.Core.uid(),
              x: e.x + nx * 0.35, y: e.y + ny * 0.35, z: 0.62,
              vx: nx * T.projSpeed, vy: ny * T.projSpeed, vz: 0,
              dmg: T.dmg, life: 3.2
            });
            G.bus.emit('enemyShoot', { x: e.x, y: e.y });
          }
        }
      }

      if (e.windup <= 0 && e.cd <= 0 && e.spawnT <= 0) {
        if (T.explode) {
          if (dist <= T.atkRange && canSee) { e.windup = T.windup; e.cd = 99; G.bus.emit('enemyWindup', { x: e.x, y: e.y, creeper: true }); }
        } else if (!T.ranged && dist <= T.atkRange + 0.3 && canSee) { e.windup = T.windup; e.cd = T.atkCd; G.bus.emit('enemyWindup', { x: e.x, y: e.y }); }
        else if (T.ranged && canSee && dist <= T.shootRange && dist > 0.9) { e.windup = T.windup; e.cd = T.atkCd; }
      }

      let mx = 0, my = 0;
      if (e.spawnT <= 0) {
        const chase = canSee ? { x: nx, y: ny } : (w.flowDir(e.ti, e.x, e.y) || { x: nx, y: ny });
        if (T.ranged) {
          if (dist > 7) { mx = chase.x; my = chase.y; }
          else if (dist < 3.2) { mx = -chase.x; my = -chase.y; }
          e.strafeT -= dt;
          if (e.strafeT <= 0) { e.strafe *= -1; e.strafeT = 1.2 + G.rng.next() * 2.2; }
          mx += -chase.y * e.strafe * 0.75;
          my += chase.x * e.strafe * 0.75;
        } else {
          if (dist > T.atkRange * 0.85 || !canSee) { mx = chase.x; my = chase.y; }
          else { mx += -chase.y * e.strafe * 0.35; my += chase.x * e.strafe * 0.35; }
          if (e.unstick > 0) { e.unstick -= dt; mx = Math.cos(e.unstickDir); my = Math.sin(e.unstickDir); }
        }
      }
      if (e.slow > 0) e.slow -= dt;
      const slowMul = e.slow > 0 ? 0.52 : 1;
      const ml = Math.hypot(mx, my);
      if (ml > 1e-4) {
        const inWater = w.inWater(e.x, e.y);
        const sp = T.speed * (e.windup > 0 ? 0.35 : 1) * (e.spawnT > 0 ? 0 : 1) * (inWater ? 0.6 : 1) * slowMul;
        const ox = e.x, oy = e.y;
        moveEntity(e, (mx / ml) * sp * dt, (my / ml) * sp * dt);
        e.bob += Math.hypot(e.x - ox, e.y - oy) * 6;
        if (Math.hypot(e.x - ox, e.y - oy) < sp * dt * 0.25) {
          e.stuck += dt;
          if (e.stuck > 0.35 && e.unstick <= 0) {
            e.unstick = 0.55;
            e.unstickDir = Math.atan2(ny, nx) + (G.rng.chance(0.5) ? 1 : -1) * 1.1;
            e.stuck = 0;
          }
        } else e.stuck = 0;
      }
      // 垂直物理：敌人也要吃重力（掉进坑、爬上台阶），并统计"卡住时长"用于自动起跳
      if (ml > 1e-4 && Math.hypot(e.x - (e.px || e.x), e.y - (e.py || e.y)) < 1e-4) e.stuckT += dt;
      else e.stuckT = 0;
      e.px = e.x; e.py = e.y;
      tickEntityZ(e, dt);

      // 兜底：长时间无法靠近目标（例如被刷进封闭区）就回收，避免出现"打不完的怪"
      if (e.state === 'alive' && e.tp) {
        const dp = Math.hypot(p.x - e.x, p.y - e.y);
        if (e._bestD === undefined || dp < e._bestD - 1.5) { e._bestD = dp; e._noProg = 0; }
        else {
          e._noProg = (e._noProg || 0) + dt;
          if (e._noProg > 30) { G.enemies.splice(i, 1); continue; }
        }
      }
    }

      // 分离
      for (let i2 = 0; i2 < G.enemies.length; i2++) {
        const a = G.enemies[i2];
        if (a.state !== 'alive') continue;
        for (let j = i2 + 1; j < G.enemies.length; j++) {
          const b = G.enemies[j];
          if (b.state !== 'alive') continue;
          const dx = b.x - a.x, dy = b.y - a.y;
          const rr = a.radius + b.radius;
          const d2 = dx * dx + dy * dy;
          if (d2 > rr * rr || d2 < 1e-8) continue;
          const d = Math.sqrt(d2);
          const push = (rr - d) * 0.5;
          const ux = dx / d, uy = dy / d;
          const wa = 1 / (a.T.mass || 1), wb = 1 / (b.T.mass || 1), tot = wa + wb;
          moveEntity(a, -ux * push * (wa / tot) * 2, -uy * push * (wa / tot) * 2);
          moveEntity(b, ux * push * (wb / tot) * 2, uy * push * (wb / tot) * 2);
        }
      }

    // 投射物
    for (let i = G.projectiles.length - 1; i >= 0; i--) {
      const b = G.projectiles[i];
      b.life -= dt;
      b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
      let gone = b.life <= 0;
      if (!gone && w.isWall(b.x, b.y)) {
        gone = true;
        for (let k = 0; k < 5; k++) {
          G.particles.push({ x: b.x, y: b.y, z: b.z, vx: (G.rng.next() - 0.5) * 2, vy: (G.rng.next() - 0.5) * 2, vz: 1 + G.rng.next(), life: 0.25, size: 1, tex: 'spark' });
        }
      }
      if (!gone) {
        for (const p of G.playerList) {
          if (p.downed || p.eliminated) continue;
          const dx = b.x - p.x, dy = b.y - p.y;
          if (dx * dx + dy * dy < 0.16) { G.damagePlayer(p.id, b.dmg, 0, b.x, b.y); gone = true; break; }
        }
      }
      if (gone) G.projectiles.splice(i, 1);
    }

    // 粒子
    for (let i = G.particles.length - 1; i >= 0; i--) {
      const q = G.particles[i];
      q.life -= dt;
      if (q.life <= 0) { G.particles.splice(i, 1); continue; }
      q.vz -= 9.0 * dt;
      const nz = q.z + q.vz * dt;
      if (nz < 0.02) { q.z = 0.02; q.vz = 0; q.vx *= 0.6; q.vy *= 0.6; } else q.z = nz;
      const nx2 = q.x + q.vx * dt, ny2 = q.y + q.vy * dt;
      if (!w.isWall(nx2, q.y)) q.x = nx2; else q.vx = -q.vx * 0.3;
      if (!w.isWall(q.x, ny2)) q.y = ny2; else q.vy = -q.vy * 0.3;
    }

    // 拾取
    for (let i = G.pickups.length - 1; i >= 0; i--) {
      const it = G.pickups[i];
      it.t += dt;
      if (it.life !== Infinity) { it.life -= dt; if (it.life <= 0) { G.pickups.splice(i, 1); continue; } }
      for (const p of G.playerList) {
        if (p.eliminated || p.downed) continue;
        const dx = it.x - p.x, dy = it.y - p.y;
        if (dx * dx + dy * dy < 0.30) {
          if (G.tryPickup(p, it.kind, it)) { G.pickups.splice(i, 1); break; }
        }
      }
    }
  };

  /* ---------------- 命中射线（支持穿透 + 友伤） ----------------
     返回按距离排序的命中数组（敌人 + 队友），被墙挡住的会裁掉
  */
  E.hitscan = function (G, shooter, angle, pitch, spread, range, maxHits) {
    const w = W();
    const a = angle + (G.rng.next() - 0.5) * spread;
    const dx = Math.cos(a), dy = Math.sin(a);
    const cosP = Math.cos(pitch), sinP = Math.sin(pitch);
    /* 3D 方向向量（sim 坐标：dz 是高度）。
       真 3D 下 pitch 必须参与水平分量（cosP）—— 用 2D 的 (cos a, sin a)
       当水平方向、再单独算 dz 是**近似**，在大俯仰角时会明显偏
       （抬头 60° 打远处目标，水平方向其实已经被压缩了一半）。 */
    const rx = dx * cosP, ry = dy * cosP, rz = sinP;

    // 射线起点 = 玩家眼睛的三维坐标（倒地时贴地）
    const eye = shooter.downed ? EYE_LOW : EYE_H;
    const footZ = (shooter.z !== undefined && shooter.z !== null) ? shooter.z : 0;
    const ox = shooter.x, oy = shooter.y, oz = footZ + eye;

    /* 地形遮挡用 3D DDA —— 真 3D 下 2D 的 rayWall 会把"前方一座山"判成通路
       （山的 wall 位都是 0，只有地基那几格是 1），子弹直接穿山。 */
    let wallD = range;
    if (w.rayVoxel) wallD = w.rayVoxel(ox, oy, oz, rx, ry, rz, range);
    else wallD = w.rayWall(ox, oy, dx, dy, range);

    const hits = [];

    for (let i = 0; i < G.enemies.length; i++) {
      const e = G.enemies[i];
      if (e.state !== 'alive') continue;
      // 轴对齐包围盒 + 射线相交（竖直方向用 e.z 起的 height 高的盒子，
      // 原来只看 z0 恒为 0 —— 真 3D 下敌人站山顶时子弹从它肚子下面飞过）
      const ez = (e.z !== undefined && e.z !== null) ? e.z : 0;
      /* ⚠️ rayBox 的形参顺序是 (x0, y0, z0, x1, y1, z1) —— 末尾三个是数学惯例的
         "第三轴"，但本项目 sim 里**第三轴 z 是高度、中间那个 y 才是水平第二轴**。
         曾经按直觉写成 (e.x-r, ez, e.y-r)，把高度塞进水平槽 —— 结果 rayBox 立刻
         判出"射线在该轴完全位于盒外"，永远返回 null，全场打不中任何东西
         （击杀 0 / 威胁不涨 / 友伤 0）。写联调测试时务必按顺序 (x, y, z)。 */
      const t = rayBox(ox, oy, oz, rx, ry, rz,
        e.x - e.radius, e.y - e.radius, ez,
        e.x + e.radius, e.y + e.radius, ez + e.height);
      if (t === null || t <= 0.05 || t > range || t > wallD) continue;
      const hz = oz + rz * t;
      // 爆头线 0.92：玩家眼高 1.62、人形敌人高 1.8 —— 阈值给 0.70 的话
      // 平视就正好落在"头部"（1.26 以上），变成"不用抬枪也爆头"，爆头失去意义。
      // 0.92×1.8 = 1.66 > 1.62，平视打躯干、稍微上抬才是爆头。
      hits.push({
        kind: 'enemy', e: e, dist: t,
        head: hz >= ez + e.height * 0.92,
        x: ox + rx * t, y: oy + ry * t, z: hz
      });
    }

    if (G.friendlyFire > 0) {
      for (const p of G.playerList) {
        if (p.id === shooter.id || p.downed || p.eliminated) continue;
        const pz = (p.z !== undefined && p.z !== null) ? p.z : 0;
        const ph = p.downed ? 0.95 : PLAYER_H;
        const t = rayBox(ox, oy, oz, rx, ry, rz,
          p.x - 0.34, p.y - 0.34, pz,
          p.x + 0.34, p.y + 0.34, pz + ph);
        if (t === null || t <= 0.25 || t > range || t > wallD) continue;
        const hz = oz + rz * t;
        hits.push({
          kind: 'player', p: p, dist: t,
          head: hz > pz + ph * 0.86,
          x: ox + rx * t, y: oy + ry * t, z: hz
        });
      }
    }

    hits.sort((m, n) => m.dist - n.dist);
    const maxH = Math.max(1, maxHits || 1);
    const out = [];
    let pierced = 0;
    for (const h of hits) {
      if (h.kind === 'enemy') {
        if (pierced >= maxH) break;
        pierced++;
      }
      out.push(h);
    }
    out.wallDist = wallD;
    out.endX = ox + rx * wallD;
    out.endY = oy + ry * wallD;
    out.endZ = oz + rz * wallD;
    return out;
  };

  /** 射线 vs 轴对齐包围盒（slab 法）。无交返回 null，否则返回进入距离 t。 */
  function rayBox(ox, oy, oz, dx, dy, dz, x0, y0, z0, x1, y1, z1) {
    let tmin = -Infinity, tmax = Infinity;
    // X
    if (Math.abs(dx) < 1e-9) { if (ox < x0 || ox > x1) return null; }
    else {
      let t1 = (x0 - ox) / dx, t2 = (x1 - ox) / dx;
      if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
    // Y（水平面第二轴 = sim 的 y）
    if (Math.abs(dy) < 1e-9) { if (oy < y0 || oy > y1) return null; }
    else {
      let t1 = (y0 - oy) / dy, t2 = (y1 - oy) / dy;
      if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
    // Z（高度）
    if (Math.abs(dz) < 1e-9) { if (oz < z0 || oz > z1) return null; }
    else {
      let t1 = (z0 - oz) / dz, t2 = (z1 - oz) / dz;
      if (t1 > t2) { const s = t1; t1 = t2; t2 = s; }
      if (t1 > tmin) tmin = t1;
      if (t2 < tmax) tmax = t2;
      if (tmin > tmax) return null;
    }
    if (tmax < 0) return null;
    return tmin < 0 ? 0 : tmin;                  // 起点在盒内 → t = 0
  }
  E.rayBox = rayBox;
})();
