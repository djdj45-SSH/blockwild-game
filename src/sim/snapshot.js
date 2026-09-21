/* ============================================================
   snapshot.js — 二进制快照编解码（服务端 → 客户端，20Hz）
   服务端与客户端共用同一份，避免两边各写一遍出错。
   布局（小端）：
     u32 tick | u8 state | u16 threat
     u16 nPlayers  [ u32 id, f32 x, f32 y, f32 a, f32 pitch,
                     u8 hp, u8 ap, u8 weapon, u8 flags, u8 level ]
     u16 nEnemies  [ u32 id, u8 type, f32 x, f32 y, u8 hpPct, u8 flags ]
     u16 nProj     [ f32 x, f32 y, f32 z ]
     u16 nPick     [ u32 id, u8 kind, f32 x, f32 y ]
   ============================================================ */
(function () {
  const ROOT = (typeof window !== 'undefined') ? window : globalThis;
  const PP = (ROOT.PP = ROOT.PP || {});
  const Snap = (PP.Snap = {});

  class BW {
    constructor(cap) {
      this.buf = new ArrayBuffer(cap || 8192);
      this.dv = new DataView(this.buf);
      this.o = 0;
    }
    need(n) {
      if (this.o + n <= this.buf.byteLength) return;
      let cap = this.buf.byteLength * 2;
      while (cap < this.o + n) cap *= 2;
      const nb = new ArrayBuffer(cap);
      new Uint8Array(nb).set(new Uint8Array(this.buf, 0, this.o));
      this.buf = nb; this.dv = new DataView(nb);
    }
    u8(v) { this.need(1); this.dv.setUint8(this.o, v); this.o += 1; }
    u16(v) { this.need(2); this.dv.setUint16(this.o, v, true); this.o += 2; }
    u32(v) { this.need(4); this.dv.setUint32(this.o, v >>> 0, true); this.o += 4; }
    f32(v) { this.need(4); this.dv.setFloat32(this.o, v, true); this.o += 4; }
    result() { return this.buf.slice(0, this.o); }
  }

  class BR {
    constructor(buf) {
      // 兼容传入 ArrayBuffer 或已包装好的 DataView
      this.dv = (buf && buf.getFloat32) ? buf : new DataView(buf);
      this.o = 0;
    }
    u8() { const v = this.dv.getUint8(this.o); this.o += 1; return v; }
    u16() { const v = this.dv.getUint16(this.o, true); this.o += 2; return v; }
    u32() { const v = this.dv.getUint32(this.o, true); this.o += 4; return v; }
    f32() { const v = this.dv.getFloat32(this.o, true); this.o += 4; return v; }
  }

  Snap.BW = BW; Snap.BR = BR;

  const ENEMY_KEYS = ['zombie', 'husk', 'skeleton'];
  const PICK_KEYS = ['health', 'armor', 'ammo', 'shotgun', 'pulse', 'chest'];
  Snap.ENEMY_KEYS = ENEMY_KEYS;
  Snap.PICK_KEYS = PICK_KEYS;

  const FLAG_DOWNED = 1, FLAG_ELIM = 2, FLAG_RELOAD = 4, FLAG_FIRE = 8;
  const EFLAG_DEAD = 1, EFLAG_WINDUP = 2, EFLAG_HURT = 4;
  Snap.FLAG = { DOWNED: FLAG_DOWNED, ELIM: FLAG_ELIM, RELOAD: FLAG_RELOAD, FIRE: FLAG_FIRE };
  Snap.EFLAG = { DEAD: EFLAG_DEAD, WINDUP: EFLAG_WINDUP, HURT: EFLAG_HURT };

  // 只发 AOI 内的实体：以玩家为中心 AOI_R 格
  const AOI = 46;

  Snap.encode = function (G, forPlayer) {
    const w = new BW(4096);
    w.u32(G.tick || 0);
    w.u8(G.state === 'over' ? 1 : 0);
    w.u16(G.threat);

    const cx = forPlayer ? forPlayer.x : 0, cy = forPlayer ? forPlayer.y : 0;
    const near = (x, y) => (!forPlayer) || ((x - cx) * (x - cx) + (y - cy) * (y - cy) < AOI * AOI);

    // players（自己始终发）
    const ps = [];
    for (const p of G.playerList) if (p === forPlayer || near(p.x, p.y)) ps.push(p);
    w.u16(ps.length);
    for (const p of ps) {
      w.u32(p.id);
      w.f32(p.x); w.f32(p.y); w.f32(p.a); w.f32(p.pitch);
      w.u8(Math.max(0, Math.min(255, Math.round(p.hp))));
      w.u8(Math.max(0, Math.min(255, Math.round(p.ap))));
      w.u8(p.weapon);
      let f = 0;
      if (p.downed) f |= FLAG_DOWNED;
      if (p.eliminated) f |= FLAG_ELIM;
      if (p.reloadT > 0) f |= FLAG_RELOAD;
      if (p.muzzleT > 0) f |= FLAG_FIRE;
      w.u8(f);
      w.u8(p.level);
    }

    const es = [];
    for (const e of G.enemies) if (near(e.x, e.y)) es.push(e);
    w.u16(es.length);
    for (const e of es) {
      w.u32(e.id);
      w.u8(Math.max(0, ENEMY_KEYS.indexOf(e.type)));
      w.f32(e.x); w.f32(e.y);
      w.u8(Math.max(0, Math.min(255, Math.round(e.hp / e.maxHp * 255))));
      let f = 0;
      if (e.state === 'dead') f |= EFLAG_DEAD;
      if (e.windup > 0) f |= EFLAG_WINDUP;
      if (e.hurt > 0) f |= EFLAG_HURT;
      w.u8(f);
    }

    const bs = [];
    for (const b of G.projectiles) if (near(b.x, b.y)) bs.push(b);
    w.u16(bs.length);
    for (const b of bs) { w.f32(b.x); w.f32(b.y); w.f32(b.z); }

    const ks = [];
    for (const it of G.pickups) if (it.kind !== 'chest' && near(it.x, it.y)) ks.push(it);
    w.u16(ks.length);
    for (const it of ks) {
      w.u32(it.id);
      w.u8(Math.max(0, PICK_KEYS.indexOf(it.kind)));
      w.f32(it.x); w.f32(it.y);
    }
    return w.result();
  };

  Snap.decode = function (buf) {
    const r = new BR(buf);
    const s = { tick: r.u32(), over: !!r.u8(), threat: r.u16(), players: [], enemies: [], projectiles: [], pickups: [] };
    let n = r.u16();
    for (let i = 0; i < n; i++) {
      s.players.push({
        id: r.u32(), x: r.f32(), y: r.f32(), a: r.f32(), pitch: r.f32(),
        hp: r.u8(), ap: r.u8(), weapon: r.u8(), flags: r.u8(), level: r.u8()
      });
    }
    n = r.u16();
    for (let i = 0; i < n; i++) {
      s.enemies.push({
        id: r.u32(), type: ENEMY_KEYS[r.u8()] || 'zombie',
        x: r.f32(), y: r.f32(), hpPct: r.u8(), flags: r.u8()
      });
    }
    n = r.u16();
    for (let i = 0; i < n; i++) s.projectiles.push({ x: r.f32(), y: r.f32(), z: r.f32() });
    n = r.u16();
    for (let i = 0; i < n; i++) {
      s.pickups.push({ id: r.u32(), kind: PICK_KEYS[r.u8()] || 'ammo', x: r.f32(), y: r.f32() });
    }
    return s;
  };
})();
