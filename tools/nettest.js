/* ============================================================
   tools/nettest.js — 联机端到端测试（无需浏览器）
   启动 server.js → 用最小 WebSocket 客户端连两个玩家 →
   检查 welcome / 快照 / 输入 / 事件是否都通
   用法: node tools/nettest.js
   ============================================================ */
const { spawn } = require('child_process');
const net = require('net');
const crypto = require('crypto');
const path = require('path');
const vm = require('vm');

const PORT = 8199;
let fails = 0;
function ok(c, m) { console.log((c ? '  PASS  ' : '  FAIL  ') + m); if (!c) fails++; }

/* ---- 最小 WebSocket 客户端 ---- */
function wsConnect(port, onMsg) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const s = net.connect(port, '127.0.0.1');
    let handshaken = false;
    let buf = Buffer.alloc(0);
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
        if (!/ 101 /.test(head)) { clearTimeout(timer); return reject(new Error('握手失败: ' + head.split('\r\n')[0])); }
        handshaken = true;
        clearTimeout(timer);
        resolve(api);
        if (buf.length) process();
        return;
      }
      process();
    });

    function process() {
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
          const o = Buffer.allocUnsafe(len);
          for (let i = 0; i < len; i++) o[i] = payload[i] ^ mask[i & 3];
          payload = o;
        }
        onMsg(op, payload);
        off = p + len;
      }
      buf = buf.slice(off);
    }

    function send(obj) {
      const pl = Buffer.from(JSON.stringify(obj), 'utf8');
      const m = crypto.randomBytes(4);
      const masked = Buffer.allocUnsafe(pl.length);
      for (let i = 0; i < pl.length; i++) masked[i] = pl[i] ^ m[i & 3];
      let head;
      if (pl.length < 126) { head = Buffer.alloc(2); head[1] = 0x80 | pl.length; }
      else { head = Buffer.alloc(4); head[1] = 0x80 | 126; head.writeUInt16BE(pl.length, 2); }
      head[0] = 0x81;
      s.write(Buffer.concat([head, m, masked]));
    }
    const api = { send, close: () => s.destroy() };
  });
}

/* ---- 加载 snapshot 解码器（与游戏共用） ---- */
global.window = global;
vm.runInThisContext(require('fs').readFileSync(path.join(__dirname, '..', 'src', 'core.js'), 'utf8'));
vm.runInThisContext(require('fs').readFileSync(path.join(__dirname, '..', 'src', 'sim', 'snapshot.js'), 'utf8'));
const PP = global.PP;

(async function main() {
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: Object.assign({}, process.env, { PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let srvLog = '';
  srv.stdout.on('data', d => { srvLog += d.toString(); });
  srv.stderr.on('data', d => { srvLog += d.toString(); });

  await new Promise(r => setTimeout(r, 1200));
  ok(/服务端已启动/.test(srvLog), 'server.js 启动成功');
  ok(srvLog.indexOf('0.0.0.0') >= 0 || /局域网/.test(srvLog), '打印了局域网地址');

  const A = { id: 0, snaps: 0, events: [], last: null, self: null };
  const B = { id: 0, snaps: 0, events: [], last: null, self: null };

  const ca = await wsConnect(PORT, (op, pl) => {
    if (op === 2) { A.snaps++; A.last = pl; return; }
    const m = JSON.parse(pl.toString());
    if (m.t === 'welcome') A.id = m.id;
    else if (m.t === 'self') A.self = m;
    else A.events.push(m);
  });
  ok(true, '客户端 A 完成 WebSocket 握手');
  ca.send({ t: 'join', name: '甲' });
  await new Promise(r => setTimeout(r, 500));
  ok(A.id > 0, 'A 收到 welcome，分配到 id = ' + A.id);

  const cb = await wsConnect(PORT, (op, pl) => {
    if (op === 2) { B.snaps++; B.last = pl; return; }
    const m = JSON.parse(pl.toString());
    if (m.t === 'welcome') B.id = m.id;
    else if (m.t === 'self') B.self = m;
    else B.events.push(m);
  });
  cb.send({ t: 'join', name: '乙' });
  await new Promise(r => setTimeout(r, 500));
  ok(B.id > 0 && B.id !== A.id, 'B 收到 welcome，id = ' + B.id + '（与 A 不同）');

  // 持续发输入 3 秒（A 一直向前 + 开火）
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) {
    ca.send({ t: 'input', i: { fwd: 1, strafe: 0, turn: 0.4, pitch: 0, sprint: true, fire: true, firePressed: true, revive: false, switchTo: -1, reload: false } });
    cb.send({ t: 'input', i: { fwd: -0.5, strafe: 0.5, turn: -0.3, pitch: 0, sprint: false, fire: false, firePressed: false, revive: false, switchTo: -1, reload: false } });
    await new Promise(r => setTimeout(r, 33));
  }

  ok(A.snaps > 20, 'A 收到快照 = ' + A.snaps + ' 帧（3 秒内，20Hz 应约 60 帧）');
  ok(B.snaps > 20, 'B 收到快照 = ' + B.snaps + ' 帧');
  ok(!!A.self && !!B.self, '双方都收到 self 状态同步');

  if (A.last) {
    const dv = new DataView(A.last.buffer ? A.last.buffer.slice(A.last.byteOffset, A.last.byteOffset + A.last.byteLength) : A.last);
    const s = PP.Snap.decode(dv);
    ok(s.players.length === 2, '快照里包含 2 名玩家');
    ok(s.players.every(p => isFinite(p.x) && isFinite(p.y)), '快照坐标有效');
    const me = s.players.find(p => p.id === A.id);
    const other = s.players.find(p => p.id === B.id);
    ok(!!me && !!other, '快照能区分自己与队友');
    ok(Math.hypot(me.x - other.x, me.y - other.y) > 0.001, '两名玩家位置不同（输入被服务端分别处理）');
    console.log('        快照: tick=' + s.tick + ' 敌人=' + s.enemies.length + ' 威胁=' + s.threat);
  } else ok(false, 'A 没有收到任何快照');

  const kinds = new Set(A.events.map(e => e.t));
  ok(kinds.has('shot') || kinds.has('spawn') || kinds.has('threat'), '收到游戏事件: ' + Array.from(kinds).slice(0, 6).join(','));
  ok(A.events.some(e => e.t === 'players'), '收到队友列表更新');

  // 断线处理
  cb.close();
  await new Promise(r => setTimeout(r, 800));
  ok(A.events.some(e => e.t === 'players' && e.list && e.list.length === 1), 'B 断线后队友列表更新为 1 人');

  ca.close();
  srv.kill();
  await new Promise(r => setTimeout(r, 300));

  console.log('\n结果: ' + (fails === 0 ? '全部通过' : fails + ' 项失败'));
  process.exit(fails ? 1 : 0);
})().catch(e => {
  console.error('测试异常: ' + (e && e.stack || e));
  process.exit(1);
});
