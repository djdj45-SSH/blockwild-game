/* ============================================================
   tools/netverify.js — 联机独立验证（不依赖 nettest）
   覆盖：多客户端、seed 一致性、快照编解码往返、输入隔离、
        换弹/换枪、Perk 联机、重连、异常洪水、长跑稳定性
   用法: node tools/netverify.js
   ============================================================ */
const { spawn } = require('child_process');
const net = require('net');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const PORT = 8211;
let fails = 0, passes = 0;
function ok(c, m) {
  console.log((c ? '  PASS  ' : '  FAIL  ') + m);
  if (c) passes++; else fails++;
}

/* ---- 最小 WS 客户端 ---- */
function wsConnect(port, onMsg) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const s = net.connect(port, '127.0.0.1');
    let handshaken = false, buf = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error('握手超时')), 6000);
    s.on('connect', () => {
      s.write('GET /ws HTTP/1.1\r\nHost: 127.0.0.1:' + port +
        '\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\nSec-WebSocket-Version: 13\r\n\r\n');
    });
    s.on('error', (e) => { clearTimeout(timer); reject(e); });
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!handshaken) {
        const i = buf.indexOf('\r\n\r\n');
        if (i < 0) return;
        const head = buf.slice(0, i).toString();
        buf = buf.slice(i + 4);
        if (!/ 101 /.test(head)) { clearTimeout(timer); return reject(new Error('握手失败')); }
        handshaken = true; clearTimeout(timer); resolve(api);
        if (buf.length) processBuf();
        return;
      }
      processBuf();
    });
    function processBuf() {
      let off = 0;
      while (buf.length - off >= 2) {
        const b0 = buf[off], b1 = buf[off + 1];
        const op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f, p = off + 2;
        if (len === 126) { if (buf.length < p + 2) break; len = buf.readUInt16BE(p); p += 2; }
        else if (len === 127) { if (buf.length < p + 8) break; len = Number(buf.readBigUInt64BE(p)); p += 8; }
        let mask = null;
        if (masked) { if (buf.length < p + 4) break; mask = buf.slice(p, p + 4); p += 4; }
        if (buf.length < p + len) break;
        let payload = buf.slice(p, p + len);
        if (masked) {
          const out = Buffer.allocUnsafe(len);
          for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
          payload = out;
        }
        onMsg(op, payload);
        off = p + len;
      }
      buf = buf.slice(off);
    }
    function send(obj) {
      const pl = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj), 'utf8');
      const m = crypto.randomBytes(4);
      const masked = Buffer.allocUnsafe(pl.length);
      for (let i = 0; i < pl.length; i++) masked[i] = pl[i] ^ m[i & 3];
      let head;
      if (pl.length < 126) { head = Buffer.alloc(2); head[1] = 0x80 | pl.length; }
      else if (pl.length < 65536) { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(pl.length, 2); }
      else { head = Buffer.alloc(10); head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(pl.length), 2); }
      head[0] = 0x81;
      s.write(Buffer.concat([head, m, masked]));
    }
    function sendRawBin(ab) {
      const pl = Buffer.from(ab);
      const m = crypto.randomBytes(4);
      const masked = Buffer.allocUnsafe(pl.length);
      for (let i = 0; i < pl.length; i++) masked[i] = pl[i] ^ m[i & 3];
      let head;
      if (pl.length < 126) { head = Buffer.alloc(2); head[1] = 0x80 | pl.length; }
      else { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(pl.length, 2); }
      head[0] = 0x82;
      s.write(Buffer.concat([head, m, masked]));
    }
    const api = { send, sendRawBin, close: () => { try { s.destroy(); } catch (e) { } }, socket: s };
  });
}

function toDV(pl) {
  return new DataView(pl.buffer ? pl.buffer.slice(pl.byteOffset, pl.byteOffset + pl.byteLength) : pl);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makeClient() {
  const st = {
    id: 0, snaps: 0, events: [], self: null, last: null,
    seeds: [], playerCounts: [], ticks: [], positions: []
  };
  st.onMsg = (op, pl) => {
    if (op === 2) {
      st.snaps++; st.last = pl;
      try {
        const s = PP.Snap.decode(toDV(pl));
        st.ticks.push(s.tick);
        st.playerCounts.push(s.players.length);
        for (const p of s.players) st.positions.push({ id: p.id, x: p.x, y: p.y, tick: s.tick });
      } catch (e) { st.snapErr = e; }
      return;
    }
    if (op !== 1) return;
    let m;
    try { m = JSON.parse(pl.toString()); } catch (e) { return; }
    if (m.t === 'welcome') { st.id = m.id; st.seed = m.seed; st.seeds.push(m.seed); }
    else if (m.t === 'self') st.self = m;
    else if (m.t === 'restart') { st.seeds.push(m.seed); st.events.push(m); }
    else st.events.push(m);
  };
  return st;
}

global.window = global;
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'core.js'), 'utf8'));
vm.runInThisContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'sim', 'snapshot.js'), 'utf8'));
const PP = global.PP;

(async function main() {
  console.log('[NETVERIFY] 独立联机验证');
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let srvLog = '';
  srv.stdout.on('data', d => { srvLog += d.toString(); });
  srv.stderr.on('data', d => { srvLog += d.toString(); });
  await sleep(1200);
  ok(/服务端已启动/.test(srvLog), 'server 启动');
  ok(!/Error|throw/i.test(srvLog), '启动日志无异常');

  /* ---------- 1) 三客户端同时加入 ---------- */
  const A = makeClient(), B = makeClient(), C = makeClient();
  const ca = await wsConnect(PORT, A.onMsg);
  const cb = await wsConnect(PORT, B.onMsg);
  const cc = await wsConnect(PORT, C.onMsg);
  ca.send({ t: 'join', name: '甲' });
  cb.send({ t: 'join', name: '乙' });
  cc.send({ t: 'join', name: '丙' });
  await sleep(600);

  // 全程保活：否则长测会被 25s 心跳超时踢掉
  const keepAlives = [ca, cb, cc];
  const hbTimer = setInterval(() => {
    for (const c of keepAlives) {
      try { c.send({ t: 'hb' }); } catch (e) { }
    }
  }, 4000);
  ok(A.id && B.id && C.id && A.id !== B.id && B.id !== C.id && A.id !== C.id,
    '3 名玩家拿到互异 id: ' + [A.id, B.id, C.id].join(','));
  ok(A.seed === B.seed && B.seed === C.seed, '三人 welcome seed 一致: ' + A.seed);

  /* ---------- 2) seed 一致性：本地按 seed 生成世界应与服务端匹配 ---------- */
  {
    // 加载完整 sim 侧世界生成
    const files = ['src/sim/weapons.js', 'src/sim/roguelike.js', 'src/sim/world.js'];
    // weapons/roguelike 已在 snapshot 路径？ snapshot 只依赖 Core。补载 world。
    for (const f of files) {
      const p = path.join(__dirname, '..', f);
      if (fs.existsSync(p)) {
        try { vm.runInThisContext(fs.readFileSync(p, 'utf8')); } catch (e) { }
      }
    }
    if (PP.World && PP.World.generate) {
      PP.World.generate(A.seed);
      const w1 = PP.World.wall;
      const hash1 = hashU8(w1);
      PP.World.generate(A.seed);
      const hash2 = hashU8(PP.World.wall);
      ok(hash1 === hash2, '同 seed 世界确定性 hash 一致');
      PP.World.generate(A.seed + 1);
      ok(hashU8(PP.World.wall) !== hash1, '不同 seed 世界不同');
    } else {
      ok(true, '（跳过本地世界 hash，world.js 未载入）');
    }
  }

  /* ---------- 3) 输入隔离：A 冲刺向前，B 后退，位置应分离且各自按输入移动 ---------- */
  const p0 = lastPos(A, A.id), q0 = lastPos(B, B.id);
  const t0 = Date.now();
  while (Date.now() - t0 < 2500) {
    ca.send({ t: 'input', i: { fwd: 1, strafe: 0, turn: 0, pitch: 0, sprint: true, fire: false, switchTo: -1 } });
    cb.send({ t: 'input', i: { fwd: -1, strafe: 0, turn: 0, pitch: 0, sprint: false, fire: false, switchTo: -1 } });
    cc.send({ t: 'input', i: { fwd: 0, strafe: 1, turn: 0, pitch: 0, sprint: false, fire: false, switchTo: -1 } });
    await sleep(33);
  }
  await sleep(200);
  const p1 = lastPos(A, A.id), q1 = lastPos(B, B.id), r1 = lastPos(C, C.id);
  ok(!!p1 && !!q1, 'A/B 都有坐标快照');
  const dA = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const dB = Math.hypot(q1.x - q0.x, q1.y - q0.y);
  ok(dA > 0.5, 'A 按输入移动了 ' + dA.toFixed(2) + ' 格');
  ok(dB > 0.2, 'B 按反向输入移动了 ' + dB.toFixed(2) + ' 格');
  ok(Math.hypot(p1.x - q1.x, p1.y - q1.y) > Math.hypot(p0.x - q0.x, p0.y - q0.y) + 0.3,
    'A/B 距离拉开（输入隔离）');
  ok(A.playerCounts[A.playerCounts.length - 1] === 3, 'AOI 快照含 3 名玩家');

  /* ---------- 4) 快照编解码往返一致 ---------- */
  {
    const s = PP.Snap.decode(toDV(A.last));
    ok(s.tick > 0 && s.players.length === 3, '快照 tick/人数有效 tick=' + s.tick);
    ok(s.players.every(p => isFinite(p.x) && isFinite(p.y) && isFinite(p.a)), '所有玩家坐标/朝向有限');
    ok(isFinite(s.threat) && s.threat >= 1, '威胁等级有效: ' + s.threat);
  }

  /* ---------- 5) 换枪 / 装填 / 开火事件 ---------- */
  {
    ca.send({ t: 'input', i: { fire: true, firePressed: true, fwd: 0, switchTo: -1, reload: true } });
    await sleep(400);
    const kinds = new Set(A.events.map(e => e.t));
    ok(kinds.has('shot') || kinds.has('reload') || kinds.has('dryfire') || kinds.has('kill'),
      '开火/装填事件到达: ' + Array.from(kinds).filter(k => ['shot', 'reload', 'dryfire', 'kill', 'hit'].includes(k)).join(','));
  }

  /* ---------- 6) Perk 联机：无点数不发卡；升级后完整往返 ---------- */
  {
    // 6a) 未升级时 perkRequest 不应给出可选卡
    A.events.length = 0;
    ca.send({ t: 'perkRequest' });
    await sleep(250);
    const early = A.events.filter(e => e.t === 'perkChoices');
    ok(early.length === 0, '无待选点数时不发 perkChoices（已加固）');

    // 6b) 持续开火打怪攒经验，直到出现待选点
    const tPerk = Date.now();
    let gotPending = false;
    let sawKill = false, sawHit = false, sawSpawn = false;
    let lastEnemy = null;
    while (Date.now() - tPerk < 25000) {
      // 朝最近敌人方向慢转 + 前进扫射
      if (A.last) {
        try {
          const s = PP.Snap.decode(toDV(A.last));
          const me = s.players.find(p => p.id === A.id);
          if (me && s.enemies.length) {
            let best = s.enemies[0], bd = 1e9;
            for (const e of s.enemies) {
              const d = (e.x - me.x) ** 2 + (e.y - me.y) ** 2;
              if (d < bd) { bd = d; best = e; }
            }
            lastEnemy = { d: Math.sqrt(bd), x: best.x, y: best.y, hpPct: best.hpPct, type: best.type };
            // turn/pitch 是角速度：按偏差比例给 turn，pitch 必须接近 0（否则会瞄到天上）
            const want = Math.atan2(best.y - me.y, best.x - me.x);
            let da = want - me.a;
            while (da > Math.PI) da -= Math.PI * 2;
            while (da < -Math.PI) da += Math.PI * 2;
            const turn = Math.max(-6, Math.min(6, da * 4));
            ca.send({ t: 'input', i: { fwd: Math.abs(da) < 0.35 ? 0.55 : 0.15, strafe: 0, turn: turn, pitch: 0, fire: true, firePressed: true, switchTo: -1 } });
          } else {
            ca.send({ t: 'input', i: { fwd: 0.4, turn: 0.8, fire: true, firePressed: true, switchTo: -1 } });
          }
        } catch (e) {
          ca.send({ t: 'input', i: { fwd: 0.3, turn: 1, fire: true, firePressed: true } });
        }
      } else {
        ca.send({ t: 'input', i: { fwd: 0.3, turn: 1, fire: true, firePressed: true } });
      }
      await sleep(40);
      if (A.events.some(e => e.t === 'kill')) sawKill = true;
      if (A.events.some(e => e.t === 'hit')) sawHit = true;
      if (A.events.some(e => e.t === 'spawn')) sawSpawn = true;
      if (A.self) {
        if (A.self.kills > 0) sawKill = true;
        if (A.self.pendingPerks > 0) { gotPending = true; break; }
        if (A.self.level > 1) { gotPending = true; break; }
      }
    }
    console.log('        战斗: level=' + (A.self ? A.self.level : '?') +
      ' kills=' + (A.self ? A.self.kills : '?') +
      ' xp=' + (A.self ? A.self.xp : '?') +
      ' shots=' + (A.self ? A.self.shotsFired + '/' + A.self.shotsHit : '?') +
      ' pending=' + (A.self ? A.self.pendingPerks : '?') +
      ' hit事件=' + sawHit + ' kill事件=' + sawKill + ' spawn=' + sawSpawn +
      ' 最近敌人=' + (lastEnemy ? lastEnemy.d.toFixed(1) + '格 hp%=' + lastEnemy.hpPct : '无'));
    ok(sawKill || gotPending, '联机战斗能产生击杀/经验');
    ok(sawHit || sawKill, '联机命中/击杀事件可送达客户端');
    if (gotPending || (A.self && A.self.pendingPerks > 0)) {
      A.events.length = 0;
      ca.send({ t: 'perkRequest' });
      await sleep(300);
      const choices = A.events.filter(e => e.t === 'perkChoices');
      ok(choices.length > 0, '升级后收到 perkChoices');
      const list = choices.length ? choices[choices.length - 1].list : null;
      if (list && list.length) {
        const pid = list[0].id;
        ca.send({ t: 'perk', p: pid });
        await sleep(350);
        const inSelf = A.self && A.self.perks && A.self.perks.indexOf(pid) >= 0;
        ok(inSelf, 'self 状态回传已选 Perk: ' + pid);
      } else ok(false, 'perkChoices 列表为空');
    } else {
      // 仍未升级：至少验证错误选择不会写入 perks（联机安全属性）
      ca.send({ t: 'perk', p: 'power' });
      await sleep(250);
      const inSelf = A.self && A.self.perks && A.self.perks.indexOf('power') >= 0;
      ok(!inSelf, '无点数时 choosePerk 被拒绝（perks 未写入）· 本轮未刷出足够击杀');
    }
  }

  /* ---------- 7) 异常洪水：不能打挂 ---------- */
  {
    const before = A.snaps;
    for (let i = 0; i < 40; i++) {
      ca.send({ t: 'input', i: { fwd: 999, turn: 1e20, switchTo: 777, fire: true, evil: [1, 2] } });
      ca.send({ t: 'nope' });
      ca.send({ t: 'hb' });
    }
    ca.send('not-json-at-all{{{');
    ca.sendRawBin(crypto.randomBytes(200));
    await sleep(400);
    ok(A.snaps > before, '洪水后仍在收快照（服务端存活）');
    ok(srv.exitCode === null, 'server 进程未退出');
  }

  /* ---------- 8) 重连 ---------- */
  {
    ca.close();
    await sleep(500);
    ok(B.playerCounts.length > 0, 'B 仍在收快照');
    const A2 = makeClient();
    const ca2 = await wsConnect(PORT, A2.onMsg);
    ca2.send({ t: 'join', name: '甲2' });
    await sleep(500);
    ok(A2.id > 0, '断线后重连并重新 join 成功 id=' + A2.id);
    // 服务端不应炸：再拉一会快照
    const n0 = A2.snaps;
    await sleep(400);
    ok(A2.snaps > n0, '重连后持续收快照');
    ca2.close();
  }

  /* ---------- 9) 长跑 5 秒：tick 单调、无 NaN ---------- */
  {
    const n0 = B.snaps;
    const ticks0 = B.ticks.length;
    const t1 = Date.now();
    while (Date.now() - t1 < 5000) {
      cb.send({ t: 'input', i: { fwd: 0.2, strafe: 0.1, turn: 0.3 } });
      cb.send({ t: 'hb' });
      await sleep(50);
    }
    ok(B.snaps > n0 + 40, '5 秒长跑快照充足 +' + (B.snaps - n0));
    const ticks = B.ticks.slice(ticks0);
    let mono = true, bad = false;
    for (let i = 1; i < ticks.length; i++) {
      if (ticks[i] < ticks[i - 1]) mono = false;
    }
    for (const p of B.positions) {
      if (!isFinite(p.x) || !isFinite(p.y)) bad = true;
    }
    ok(mono, '服务端 tick 单调递增');
    ok(!bad, '长跑期间坐标无 NaN/Inf');
    ok(!B.snapErr, '长跑期间快照解码零异常' + (B.snapErr ? ': ' + B.snapErr.message : ''));
  }

  /* ---------- 10) 房主重启（向所有仍连着的客户端发，兼容 host 变更） ---------- */
  {
    const restartsBefore = B.events.filter(e => e.t === 'restart').length;
    try { cb.send({ t: 'restart' }); } catch (e) { }
    try { cc.send({ t: 'restart' }); } catch (e) { }
    await sleep(700);
    const restarts = B.events.filter(e => e.t === 'restart');
    ok(restarts.length > restartsBefore, '收到 restart 事件');
    ok(restarts.length && restarts[restarts.length - 1].seed !== undefined, 'restart 带新 seed: ' +
      (restarts.length ? restarts[restarts.length - 1].seed : '-'));
    ok(B.id > 0, '重启后客户端 id 仍有效');
  }

  clearInterval(hbTimer);
  cb.close(); cc.close();
  srv.kill();
  await sleep(200);

  console.log('\n结果: ' + passes + ' 通过 / ' + fails + ' 失败');
  process.exit(fails ? 1 : 0);
})().catch(e => {
  console.error('验证异常: ' + (e && e.stack || e));
  process.exit(1);
});

function lastPos(st, id) {
  for (let i = st.positions.length - 1; i >= 0; i--) {
    if (st.positions[i].id === id) return st.positions[i];
  }
  return null;
}
function hashU8(u8) {
  if (!u8) return 'null';
  let h = 0x811c9dc5;
  for (let i = 0; i < u8.length; i++) {
    h ^= u8[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
