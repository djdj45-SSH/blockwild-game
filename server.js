/* ============================================================
   server.js — 零依赖：静态托管 + 最小 WebSocket + 权威世界模拟
   node server.js  →  把打印出来的局域网地址发给队友 / 手机，打开即玩
   设计要点：
     - 服务端跑权威 sim（30Hz），客户端只发输入、收快照（20Hz）
     - 世界靠 seed 同步，不传地图数据
     - 二进制快照，AOI 裁剪，带宽与人数线性相关
   ============================================================ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const vm = require('vm');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;

/* ---------------- 加载模拟层（与浏览器共用同一份代码） ---------------- */
global.window = global;
const SIM_FILES = [
  'src/core.js', 'src/sim/weapons.js', 'src/sim/roguelike.js',
  'src/sim/world.js', 'src/sim/entities.js', 'src/sim/sim.js', 'src/sim/snapshot.js'
];
for (const f of SIM_FILES) {
  vm.runInThisContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), { filename: f });
}
const PP = global.PP;

/* ---------------- 静态文件 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon'
};
function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' });
  res.end(body);
}
const httpServer = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  if (urlPath === '/health') {
    return send(res, 200, JSON.stringify({
      ok: true, uptime: process.uptime(), players: clients.length,
      tick: G ? G.tick : 0, state: G ? G.state : '-', seed: G ? G.seed : 0
    }), MIME['.json']);
  }
  const filePath = path.join(ROOT, path.normalize(urlPath));
  if (!filePath.startsWith(ROOT)) return send(res, 403, 'forbidden');
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, '404 ' + urlPath);
    send(res, 200, data, MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
  });
});

/* ---------------- 最小 WebSocket（RFC6455） ---------------- */
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) { head = Buffer.alloc(2); head[1] = len; }
  else if (len < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(len, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
  head[0] = 0x80 | opcode;
  return Buffer.concat([head, payload]);
}

let bufPool = Buffer.alloc(0);
function parse(buf, cb) {
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off], b1 = buf[off + 1];
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
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
    cb(opcode, payload);
    off = p + len;
  }
  return off;
}

/* ---------------- 游戏实例 ---------------- */
let G = null;
const clients = [];
let nextId = 1;

function newGame(seed) {
  G = PP.Sim.create(seed, { solo: false });
  G.friendlyFire = 0.35;
  for (const ev in EV) G.bus.on(ev, ((name) => (payload) => {
    const msg = EV[name](payload);
    if (msg) broadcastJSON(msg);
  })(ev));
  broadcastJSON({ t: 'restart', seed: G.seed });
  return G;
}

const EV = {
  shot: e => ({ t: 'shot', id: e.id, w: e.weapon, x: e.x, y: e.y }),
  hit: e => ({ t: 'hit', id: e.id, head: e.head }),
  kill: e => ({ t: 'kill', x: e.x, y: e.y, gain: e.gain, head: e.head, killerId: e.killerId }),
  playerHurt: e => ({ t: 'playerHurt', id: e.id, dmg: e.dmg, byPlayer: e.byPlayer }),
  downed: e => ({ t: 'downed', id: e.id, name: e.name }),
  revived: e => ({ t: 'revived', id: e.id, by: e.by, name: e.name }),
  eliminated: e => ({ t: 'eliminated', id: e.id, name: e.name }),
  pickup: e => ({ t: 'pickup', id: e.id, kind: e.kind, text: e.text, rarity: e.rarity, affixes: e.affixes }),
  chest: e => ({ t: 'chest', id: e.id, give: e.give }),
  switch: e => ({ t: 'switch', id: e.id, index: e.index, name: e.name, rarity: e.rarity }),
  reload: e => ({ t: 'reload', id: e.id, dur: e.dur }),
  dryfire: e => ({ t: 'dryfire', id: e.id }),
  threat: e => ({ t: 'threat', level: e.level }),
  levelup: e => ({ t: 'levelup', id: e.id, level: e.level }),
  perkChoices: e => ({ t: 'perkChoices', id: e.id, list: e.list }),
  perkTaken: e => ({ t: 'perkTaken', id: e.id, perk: e.perk, name: e.name }),
  spawn: e => ({ t: 'spawn', x: e.x, y: e.y }),
  enemyShoot: e => ({ t: 'enemyShoot', x: e.x, y: e.y }),
  enemyWindup: e => ({ t: 'enemyWindup', x: e.x, y: e.y }),
  explode: e => ({ t: 'explode', x: e.x, y: e.y }),
  chain: e => ({ t: 'chain', x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2 }),
  friendlyHit: e => ({ t: 'friendlyHit', id: e.id, target: e.target }),
  heal: e => ({ t: 'heal', id: e.id, v: e.v }),
  ammoGain: e => ({ t: 'ammoGain', id: e.id }),
  gameover: () => ({ t: 'gameover' }),
  dead: e => ({ t: 'dead', id: e.id })
};

function broadcastJSON(obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  const f = frame(1, buf);
  for (const c of clients) { try { c.socket.write(f); } catch (e) { } }
}
function broadcastBinary(ab) {
  const f = frame(2, Buffer.from(ab));
  for (const c of clients) { try { c.socket.write(f); } catch (e) { } }
}
function sendJSON(c, obj) {
  try { c.socket.write(frame(1, Buffer.from(JSON.stringify(obj), 'utf8'))); } catch (e) { }
}
function playerListJSON() {
  return G.playerList.map(p => ({
    id: p.id, name: p.name, color: p.colorIdx,
    hp: Math.round(p.hp), maxHp: p.maxHp, downed: p.downed, eliminated: p.eliminated,
    kills: p.kills, score: p.score, level: p.level
  }));
}

/* ---------------- 连接 ---------------- */
httpServer.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Accept: ' + accept,
    '\r\n'
  ].join('\r\n'));
  socket.setNoDelay(true);

  const c = { socket: socket, id: 0, name: '?', alive: true };
  clients.push(c);

  socket.on('data', (chunk) => {
    const buf = Buffer.concat([bufPool, chunk]);
    const used = parse(buf, (op, payload) => {
      if (op === 8) { c.alive = false; try { socket.destroy(); } catch (e) { } return; }
      if (op === 9) { try { socket.write(frame(10, payload)); } catch (e) { } return; }
      if (op === 1) handleText(c, payload.toString('utf8'));
      if (op === 2) handleBinary(c, payload);
    });
    bufPool = buf.slice(used);
  });
  socket.on('close', onClose);
  socket.on('error', onClose);
  function onClose() {
    if (!c.alive) return;
    c.alive = false;
    if (c.id) {
      PP.Sim.removePlayer(G, c.id);
      broadcastJSON({ t: 'players', list: playerListJSON() });
      console.log('  [离开] ' + c.name);
    }
    const i = clients.indexOf(c);
    if (i >= 0) clients.splice(i, 1);
  }
});

function handleText(c, txt) {
  let m;
  try { m = JSON.parse(txt); } catch (e) { return; }
  if (m.t === 'join') {
    c.id = nextId++;
    c.name = (m.name || ('玩家' + c.id)).slice(0, 12);
    const p = PP.Sim.addPlayer(G, c.id, c.name);
    p.colorIdx = c.id % 4;
    sendJSON(c, {
      t: 'welcome', id: c.id, seed: G.seed,
      tickRate: 30, snapshotHz: 20, friendlyFire: G.friendlyFire,
      players: playerListJSON()
    });
    broadcastJSON({ t: 'players', list: playerListJSON() });
    console.log('  [加入] ' + c.name + '  当前 ' + clients.length + ' 人');
    return;
  }
  if (!c.id) return;
  if (m.t === 'input') { PP.Sim.setInput(G, c.id, m.i || {}); return; }
  if (m.t === 'perk' && m.p) {
    const p = G.players.get(c.id);
    if (p) PP.Sim.choosePerk(G, p, m.p);
    return;
  }
  if (m.t === 'perkRequest') {
    const p = G.players.get(c.id);
    if (p) PP.Sim.rollPerkChoices(G, p);
    return;
  }
  if (m.t === 'restart' && clients.length && clients[0] === c) {
    newGame();
    return;
  }
  if (m.t === 'ff' && clients.length && clients[0] === c) {
    G.friendlyFire = Math.max(0, Math.min(1, Number(m.v) || 0));
    broadcastJSON({ t: 'ff', v: G.friendlyFire });
    return;
  }
}
function handleBinary() { /* 客户端只发 JSON 输入 */ }

/* ---------------- 主循环 ---------------- */
newGame();

const TICK_MS = 1000 / 30;
let acc = 0, last = Date.now(), snapAcc = 0, selfAcc = 0;
setInterval(() => {
  const now = Date.now();
  let dt = (now - last) / 1000;
  last = now;
  if (dt > 0.25) dt = 0.25;
  acc += dt * 1000;
  let steps = 0;
  while (acc >= TICK_MS && steps < 5) { PP.Sim.tick(G); acc -= TICK_MS; steps++; }
  if (steps >= 5) acc = 0;

  if (!clients.length) return;
  // 20Hz 快照（按人 AOI 裁剪 → 每人一份）
  snapAcc += dt;
  if (snapAcc >= 1 / 20) {
    snapAcc = 0;
    for (const c of clients) {
      const p = G.players.get(c.id);
      if (!p) continue;
      try { c.socket.write(frame(2, Buffer.from(PP.Snap.encode(G, p)))); } catch (e) { }
    }
  }
  // 6Hz 自身完整状态（弹药/词条/经验）
  selfAcc += dt;
  if (selfAcc >= 1 / 6) {
    selfAcc = 0;
    for (const c of clients) {
      const p = G.players.get(c.id);
      if (!p) continue;
      sendJSON(c, {
        t: 'self',
        weapon: p.weapon, mag: p.mag.slice(), reserve: p.reserve.map(v => v === Infinity ? -1 : v),
        unlocked: p.unlocked.slice(),
        insts: p.insts.map(i => ({ def: i.def, rarity: i.rarity, affixes: i.affixes, name: PP.Rogue.weaponName(i) })),
        perks: p.perks.slice(), xp: p.xp, xpNext: p.xpNext, level: p.level,
        pendingPerks: p.pendingPerks, score: p.score, kills: p.kills,
        headshots: p.headshots, combo: p.combo, downed: p.downed, eliminated: p.eliminated,
        reviveProg: p.reviveProg, downT: p.downT, hp: p.hp, ap: p.ap, maxHp: p.maxHp, maxAp: p.maxAp
      });
    }
    broadcastJSON({ t: 'players', list: playerListJSON() });
  }
}, 16);

/* ---------------- 启动 ---------------- */
httpServer.listen(PORT, '0.0.0.0', () => {
  const nets = os.networkInterfaces();
  const addrs = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) addrs.push(net.address);
    }
  }
  console.log('');
  console.log('  方块荒野 BLOCKWILD — 服务端已启动（权威模拟 + WebSocket）');
  console.log('  --------------------------------------------------------');
  console.log('  本机:      http://localhost:' + PORT);
  addrs.forEach(a => console.log('  局域网:    http://' + a + ':' + PORT + '   ← 发给队友 / 手机'));
  console.log('  --------------------------------------------------------');
  console.log('  世界种子:  ' + G.seed + '   人数无上限');
  console.log('  停止服务:  Ctrl+C');
  console.log('');
});
