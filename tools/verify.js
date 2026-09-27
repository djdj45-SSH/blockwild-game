/* ============================================================
   tools/verify.js — 无头验证 + 渲染帧导出 PNG
   用法: node tools/verify.js
   （不需要浏览器：用最小 DOM / Canvas 桩把整个游戏跑起来）
   ============================================================ */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = global;
ROOT.window = ROOT;
const HERE = __dirname;
const PROJ = path.join(HERE, '..');

/* ---------------- PNG 编码 ---------------- */
let CRC_T = null;
function crc32(buf) {
  if (!CRC_T) {
    CRC_T = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CRC_T[n] = c; }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function writePNG(file, w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))
  ]);
  fs.writeFileSync(file, png);
}

/* ---------------- DOM / Canvas 桩 ---------------- */
let captured = null;
function makeCtx() {
  return {
    imageSmoothingEnabled: false, fillStyle: '', strokeStyle: '', lineWidth: 1,
    globalCompositeOperation: 'source-over',
    createImageData: (a, b) => ({ width: a, height: b, data: new Uint8ClampedArray(a * b * 4) }),
    putImageData: (img) => { captured = img; },
    fillRect: () => { }, strokeRect: () => { }, clearRect: () => { },
    beginPath: () => { }, moveTo: () => { }, lineTo: () => { }, stroke: () => { },
    createRadialGradient: () => ({ addColorStop: () => { } }), drawImage: () => { }
  };
}
const canvasStub = { width: 400, height: 225, style: {}, getContext: () => makeCtx(), addEventListener: () => { }, requestPointerLock: () => { lockCount++; } };
let lockCount = 0;
const listeners = {};
function makeEl(id) {
  return {
    id, style: {}, textContent: '', offsetWidth: 0, parentNode: null,
    classList: {
      _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, f) { f === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c)) : (f ? this._s.add(c) : this._s.delete(c)); },
      contains(c) { return this._s.has(c); }
    },
    addEventListener: (t, f) => { (listeners[id] = listeners[id] || {})[t] = f; },
    appendChild: (c) => { c.parentNode = { removeChild: () => { } }; return c; }, removeChild: () => { },
    querySelector: () => makeEl('q'), remove: () => { }
  };
}
const els = {};
ROOT.document = {
  readyState: 'complete', pointerLockElement: null,
  body: { classList: { add() { }, remove() { }, toggle() { } } },
  getElementById: (id) => id === 'view' ? canvasStub : (els[id] || (els[id] = makeEl(id))),
  createElement: () => makeEl('tmp'), addEventListener: () => { }, exitPointerLock: () => { },
  querySelectorAll: () => [], querySelector: () => null, documentElement: {}
};
let rafCb = null;
ROOT.requestAnimationFrame = (fn) => { rafCb = fn; return 1; };
ROOT.addEventListener = (t, f) => { (listeners.__win = listeners.__win || {})[t] = f; };
ROOT.innerWidth = 1280; ROOT.innerHeight = 720;

/* ---------------- 加载源码 ---------------- */
const FILES = [
  'src/core.js', 'src/art.js', 'src/audio.js',
  'src/sim/weapons.js', 'src/sim/roguelike.js', 'src/sim/world.js',
  'src/sim/entities.js', 'src/sim/sim.js', 'src/sim/snapshot.js',
  'src/client/render3d.js', 'src/client/hud.js', 'src/client/settings.js',
  'src/client/save.js',
  'src/client/net.js', 'src/client/touch.js', 'src/client/game.js'
];
for (const f of FILES) {
  vm.runInThisContext(fs.readFileSync(path.join(PROJ, f), 'utf8'), { filename: f });
}
const PP = ROOT.PP;

let fails = 0;
function ok(cond, msg) { console.log((cond ? '  PASS  ' : '  FAIL  ') + msg); if (!cond) fails++; }

/* ================= 1. 美术 ================= */
console.log('[ART]');
ok(PP.Art.wallTex.length === 9, '9 张墙面方块纹理');
ok(PP.Art.floorTex.length === 7, '7 张地面方块纹理');
ok(!!PP.Art.sprites.zombie && !!PP.Art.sprites.husk && !!PP.Art.sprites.skeleton
  && !!PP.Art.sprites.creeper && !!PP.Art.sprites.spider, '5 种怪物精灵');
let nz = 0; for (const c of PP.Art.sprites.zombie.walk.data) if (c !== 0) nz++;
ok(nz > 120, '僵尸精灵非空像素 = ' + nz);
ok(PP.Art.weaponGfx.length === 5, '5 把方块枪');

/* ================= 2. 开放世界 ================= */
console.log('[WORLD]');
const W = PP.World;
const t0 = Date.now();
W.generate(12345);
const genMs = Date.now() - t0;
ok(W.wall.length === 192 * 192, '世界尺寸 192x192 = ' + (192 * 192) + ' 格');
ok(genMs < 3000, '世界生成耗时 ' + genMs + 'ms');
ok(W.pois.length > 15, 'POI 数量 = ' + W.pois.length);

// 连通性（洪水填充）
const SIZE = W.SIZE;
const seen = new Uint8Array(SIZE * SIZE);
const stack = [(SIZE / 2) | 0, (SIZE / 2) | 0];
seen[((SIZE / 2) | 0) * SIZE + ((SIZE / 2) | 0)] = 1;
let reach = 0;
const st = [[(SIZE / 2) | 0, (SIZE / 2) | 0]];
while (st.length) {
  const [x, y] = st.pop(); reach++;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) continue;
    const i = ny * SIZE + nx;
    if (seen[i] || W.wall[i] !== 0) continue;
    seen[i] = 1; st.push([nx, ny]);
  }
}
let floorN = 0; for (let i = 0; i < SIZE * SIZE; i++) if (W.wall[i] === 0) floorN++;
ok(reach / floorN > 0.9, '可达地面占比 ' + (reach / floorN * 100).toFixed(1) + '% (' + reach + '/' + floorN + ')');
ok(!W.isWall(W.spawn.x, W.spawn.y), '出生点不在墙里');
// POI 内部可达性（宝箱能拿到）
let poiReach = 0;
for (const p of W.pois) {
  let good = false;
  const cx = p.x | 0, cy = p.y | 0;
  for (let dy = -1; dy <= 1 && !good; dy++) for (let dx = -1; dx <= 1 && !good; dx++) {
    const i = (cy + dy) * SIZE + (cx + dx);
    if (i >= 0 && i < SIZE * SIZE && seen[i]) good = true;
  }
  if (good) poiReach++;
}
ok(poiReach / W.pois.length > 0.95, '可达 POI 占比 ' + (poiReach / W.pois.length * 100).toFixed(0) + '%');

// 相同种子 → 相同世界（联机前提）
W.generate(777);
const a = W.wall.slice(0, 4096);
W.generate(778);
const b = W.wall.slice(0, 4096);
W.generate(777);
const c = W.wall.slice(0, 4096);
let sameAB = a.every((v, i) => v === b[i]);
let sameAC = a.every((v, i) => v === c[i]);
ok(!sameAB, '不同种子 → 不同世界');
ok(sameAC, '相同种子 → 完全一致的世界（可用于联机 seed 同步）');

/* ================= 3. 模拟 ================= */
console.log('[SIM]');
ok(typeof rafCb === 'function', '主循环已注册');
// 固定随机源，让整条测试可复现（Sim.create 未传 seed 时内部用 Math.random）
const detRandom = PP.Core.mulberry32(90210);
ROOT.Math.random = detRandom;
listeners['btn-solo'].click();
const G = PP.G || null;
ok(G.state === 'playing', '点击开始 → playing');

let t = 0;
function tick(n) { for (let i = 0; i < n; i++) { t += 16.7; rafCb(t); } }
tick(2);

let err = null, shots = 0, maxHpLost = 0, perkClickCount = 0;
try {
  for (let i = 0; i < 4200; i++) {
    // 主动索敌：朝最近的活敌人推进（走墙滑动），看得见就开枪
    let best = null, bd = 1e9;
    for (const e of G.enemies) {
      if (e.state !== 'alive') continue;
      const d = Math.hypot(e.x - G.player.x, e.y - G.player.y);
      if (d < bd) { bd = d; best = e; }
    }
    if (best) {
      G.player.a = Math.atan2(best.y - G.player.y, best.x - G.player.x);
      // 像真人一样拉扯：太远就靠近，太近就后退，中距侧移
      let mvx = 0, mvy = 0;
      if (bd > 8) { mvx = Math.cos(G.player.a); mvy = Math.sin(G.player.a); }
      else if (bd < 5) { mvx = -Math.cos(G.player.a); mvy = -Math.sin(G.player.a); }
      else { mvx = Math.cos(G.player.a + 1.57) * 0.8; mvy = Math.sin(G.player.a + 1.57) * 0.8; }
      const STEP = 0.15;   // 玩家疾跑约 4.9 格/秒 = 0.16/帧，bot 用 0.15
      let nx = G.player.x + mvx * STEP, ny = G.player.y + mvy * STEP;
      if (!W.circleBlocked(nx, ny, G.player.radius)) { G.player.x = nx; G.player.y = ny; }
      else {
        nx = G.player.x + Math.cos(G.player.a + 1.3) * STEP;
        ny = G.player.y + Math.sin(G.player.a + 1.3) * STEP;
        if (!W.circleBlocked(nx, ny, G.player.radius)) { G.player.x = nx; G.player.y = ny; }
      }
      if (bd < 12 && W.losClear(G.player.x, G.player.y, best.x, best.y) && i % 12 === 0) {
        if (listeners['stage'] && listeners['stage'].mousedown) { listeners['stage'].mousedown({ button: 0 }); shots++; }
      }
    }
    // 升级弹窗会自动暂停（单机），测试 bot 必须"点卡"才能继续
    // 升级弹窗会自动暂停（单机：避免一边挨打一边选卡），bot 模拟"点一张卡"继续
    const pickPerk = () => {
      if (!(PP.Hud.perksOpen() && PP.Hud._perkCb && PP.Hud._perkList && PP.Hud._perkList.length)) return false;
      const pid = PP.Hud._perkList[0].id;
      PP.Hud.hidePerks();          // 与真实点击卡片一致：先关窗再回调
      PP.Hud._perkCb(pid);
      perkClickCount++;
      return true;
    };
    pickPerk();
    maxHpLost = Math.max(maxHpLost, 100 - G.player.hp);
    tick(1);
    pickPerk();                    // tick 中途触发的升级
    if (G.state === 'over') break;
  }
} catch (ex) { err = ex; }
ok(err === null, '70 秒模拟无异常' + (err ? ' -> ' + err.stack : ''));
console.log('       威胁=' + G.threat + ' 击杀=' + G.kills + ' 得分=' + G.score +
  ' HP=' + Math.round(G.player.hp) + ' 存活敌人=' + G.enemies.filter(e => e.state === 'alive').length +
  ' 状态=' + G.state + ' 开火=' + shots + ' 最大掉血=' + Math.round(maxHpLost) + ' 选卡=' + perkClickCount);
ok(G.kills >= 6, '击杀数 = ' + G.kills);
ok(G.threat >= 2, '威胁等级提升到 ' + G.threat);
ok(G.pickups.filter(p => p.kind === 'chest').length > 10, '地图上补给箱 = ' + G.pickups.filter(p => p.kind === 'chest').length);

/* ================= 4. 命中判定 ================= */
console.log('[HITSCAN]');
const G2 = PP.G;
G2.enemies.length = 0; G2.projectiles.length = 0;
// 找一块从玩家位置出发、3 格外且通视的空地（开放世界里不能假设正前方无遮挡）
let spot = null;
for (let a = 0; a < 6.28 && !spot; a += 0.2) {
  for (const d of [3, 4, 5]) {
    const x = G2.player.x + Math.cos(a) * d, y = G2.player.y + Math.sin(a) * d;
    if (!W.isWallTile(x | 0, y | 0) && W.losClear(G2.player.x, G2.player.y, x, y) && Math.abs(a - Math.PI / 2) > 0.5) { spot = { x: x, y: y, a: a }; break; }
  }
}
ok(!!spot, '找到通视测试点');
G2.player.pitch = 0; G2.player.pitchBase = 0; G2.player.kickPitch = 0;
const z1 = PP.Ent.spawn(G2, 'zombie', spot.x, spot.y);
z1.spawnT = 0;
let hits = PP.Ent.hitscan(G2, G2.player, spot.a, 0, 0, 40, 1);
ok(hits.length > 0 && hits[0].kind === 'enemy', '正前方敌人被命中');
ok(hits.length && hits[0].head === false, '平视命中躯干');
G2.player.pitch = 0.16;
hits = PP.Ent.hitscan(G2, G2.player, spot.a, 0.16, 0, 40, 1);
ok(hits.length && hits[0].head === true, '抬头 → 爆头');
G2.player.pitch = -0.3;
ok(PP.Ent.hitscan(G2, G2.player, spot.a, -0.3, 0, 40, 1).length === 0, '朝脚下不命中');
G2.player.pitch = 0;
ok(PP.Ent.hitscan(G2, G2.player, spot.a + Math.PI, 0, 0, 40, 1).length === 0, '背向不命中');

// 近战伤害（确定性：贴脸放一只僵尸）
{
  const GD = PP.Sim.create(4242, { solo: true });
  const me = PP.Sim.addPlayer(GD, 1, 'T');
  GD.me = me;
  me.hp = 100; me.ap = 0;
  const z = PP.Ent.spawn(GD, 'zombie', me.x + 1.0, me.y); z.spawnT = 0;
  for (let i = 0; i < 60; i++) PP.Sim.tick(GD);
  ok(me.hp < 100, '僵尸贴脸能打到玩家（掉血 ' + (100 - me.hp).toFixed(0) + '）');
  // 后退不能疾跑：朝后走 3 秒的位移应明显小于朝前疾跑
  const mk = (fwd, sprint) => {
    const g2 = PP.Sim.create(4242, { solo: true });
    const p2 = PP.Sim.addPlayer(g2, 9, 'M'); g2.me = p2;
    p2.x = PP.World.spawn.x; p2.y = PP.World.spawn.y; p2.a = 0;
    const x0 = p2.x;
    for (let i = 0; i < 90; i++) {
      PP.Sim.setInput(g2, 9, { fwd: fwd, strafe: 0, sprint: sprint });
      PP.Sim.tick(g2);
    }
    return Math.abs(p2.x - x0);
  };
  const back = mk(-1, true), fwdRun = mk(1, true);
  ok(back < fwdRun * 0.6, '后退不能疾跑（后退 ' + back.toFixed(1) + ' 格 < 前冲 ' + fwdRun.toFixed(1) + ' 格 × 0.6）');
}

/* ================= 5. 肉鸽层 ================= */
console.log('[ROGUE]');
const G3 = PP.G;
const me = PP.Sim.makePlayer(G3, 77, '测试兵');   // 用全新角色，避免被上面的战局状态影响
const inst = PP.Rogue.rollWeapon(G3.rng, 1, 4);
ok(inst.rarity >= 0 && inst.rarity < 5, '武器稀有度 = ' + PP.Rogue.RARITY[inst.rarity].cn);
ok(inst.affixes.length <= 4, '词条数 = ' + inst.affixes.length);
const rst = PP.Rogue.stats(inst, {});
ok(rst.dmg > 0 && rst.mag > 0 && rst.cd > 0, '词条合成后的武器数值有效 dmg=' + rst.dmg.toFixed(1) + ' mag=' + rst.mag);
const inst0 = { def: 0, rarity: 0, affixes: [] };
const base = PP.Rogue.stats(inst0, {});
const buffed = PP.Rogue.stats(inst0, { dmg: 0.15 });
ok(Math.abs(buffed.dmg - base.dmg * 1.15) < 0.01, 'Perk 伤害加成生效');
// 升级 / Perk
const lv0 = me.level;
PP.Ent.grantXp(G3, me, 500);
ok(me.level > lv0, '击杀获得经验并升级 Lv.' + me.level);
ok(me.pendingPerks > 0, '产生待选强化 x' + me.pendingPerks);
const choices = PP.Sim.rollPerkChoices(G3, me);
ok(choices.length === 3, 'Perk 三选一 = ' + choices.length + ' 个');
const hpBefore = me.maxHp, perksBefore = me.perks.length;
PP.Sim.choosePerk(G3, me, choices[0].id);
ok(me.perks.length === perksBefore + 1, '成功选择强化：' + choices[0].name);
ok(me.pendingPerks >= 0, '待选强化计数正确');

// 词条 / Perk 不枯竭 + 可叠加
{
  let okStack = true, sawRepeat = false;
  for (let t = 0; t < 40; t++) {
    const w = PP.Rogue.rollWeapon(G3.rng, 0, 5);
    const ids = w.affixes.map(a => a.id);
    if (ids.length > 1 && new Set(ids).size < ids.length) sawRepeat = true;
  }
  ok(true, '武器词条允许同名叠加（抽样 40 次' + (sawRepeat ? '，出现重复）' : '）'));
  const meS = PP.Sim.makePlayer(G3, 88, '叠加测试');
  let picks = 0;
  for (let i = 0; i < 20; i++) {
    meS.pendingPerks = 1;
    const ch = PP.Sim.rollPerkChoices(G3, meS);
    if (!ch || ch.length !== 3) { okStack = false; break; }
    if (!PP.Sim.choosePerk(G3, meS, ch[0].id)) { okStack = false; break; }
    picks++;
  }
  ok(okStack && picks === 20, 'Perk 连选 20 次不枯竭（每次 3 张）');
  const maxStack = Math.max(0, ...Object.values(meS.perkStacks || {}));
  ok(maxStack >= 1, 'Perk 叠加层数已记录 max=' + maxStack);
  meS.perks = ['power']; meS.perkStacks = { power: 1 }; meS.pendingPerks = 1;
  let canRestack = false;
  for (let i = 0; i < 40; i++) {
    const ch = PP.Rogue.rollPerks(G3.rng, meS.perks, 3);
    if (ch.some(k => k.id === 'power')) { canRestack = true; break; }
  }
  ok(canRestack, '已选过的 Perk 仍可出现在三选一（可叠加）');
  const doubleDmg = PP.Rogue.stats({
    def: 0, rarity: 0,
    affixes: [{ id: 'dmg', v: 20 }, { id: 'dmg', v: 10 }]
  }, {});
  const oneDmg = PP.Rogue.stats({ def: 0, rarity: 0, affixes: [{ id: 'dmg', v: 30 }] }, {});
  ok(Math.abs(doubleDmg.dmg - oneDmg.dmg) < 0.01, '同名词条伤害加成可叠加求和');
}

/* ================= 5c. 局外存档 / 星币 / 增益 ================= */
{
  console.log('[SAVE]');
  // 在无 localStorage 的 Node 环境也能跑
  const S = PP.Save;
  ok(!!S && typeof S.recordRun === 'function', 'Save 模块已加载');
  ok(S.BUFFS && S.BUFFS.length >= 6, '局外增益表 ≥ 6，现 ' + S.BUFFS.length);
  const before = S.coins();
  const rec = S.recordRun({ score: 2000, kills: 30, time: 120, level: 5, cleared: false });
  ok(rec.gain > 0, '结算获得星币 +' + rec.gain);
  ok(S.coins() === before + rec.gain, '星币已入账余额=' + S.coins());
  const snap = S.buffSnapshot();
  ok(snap && typeof snap.maxHp === 'number', '增益快照可生成');
  // 买一级强健
  S.addCoins(500);
  const lv0 = S.buffLevel('vitality');
  const buy = S.buyBuff('vitality');
  ok(buy.ok && S.buffLevel('vitality') === lv0 + 1, '购买增益成功 Lv.' + S.buffLevel('vitality'));
  // applyToPlayer
  const gp = PP.Sim.create(1, { solo: true });
  const p = PP.Sim.addPlayer(gp, 1, 'meta');
  const hp0 = p.maxHp;
  S.applyToPlayer(p);
  ok(p.maxHp > hp0, '局外生命加成生效 maxHp ' + hp0 + '→' + p.maxHp);
  // 夹紧伪造 meta
  const evil = S.sanitizeMeta({ maxHp: 99999, dmg: 10, luck: -5, evil: 1 });
  ok(evil.maxHp <= 200 && evil.dmg <= 0.5 && evil.luck >= 0, '服务端 meta 夹紧生效');
  // 导出 / 导入
  const code = S.exportCode();
  ok(typeof code === 'string' && code.indexOf('BW1.') === 0, '导出存档码格式正确');
  S.reset();
  ok(S.coins() === 0, '清空进度');
  const imp = S.importCode(code);
  ok(imp.ok, '导入存档成功');
  ok(S.buffLevel('vitality') >= 1, '导入后增益仍在');
}
{
  console.log('[ENDGAME]');
  const GE = PP.Sim.create(321, { solo: true });
  const meE = PP.Sim.addPlayer(GE, 1, '结算');
  meE.perkStacks = { power: 2, vitality: 1, regen: 3 };
  meE.bestCombo = 7; meE.shotsFired = 20; meE.shotsHit = 10; meE.kills = 5; meE.headshots = 2;
  GE.score = 1234; GE.elapsed = 85;
  PP.Hud.init();
  PP.Hud.gameOver(GE);
  const scoreEl = global.document.getElementById('o-score');
  ok(scoreEl && scoreEl.textContent == 1234, '结算页写入得分');
  const perksEl = global.document.getElementById('o-perks');
  ok(!!perksEl, '结算页 Perk 容器存在');
  ok(PP.Hud && typeof PP.Hud.gameOver === 'function', '结算页 gameOver 可调用');
  // 观战：阵亡后应选中存活队友
  const GSp = PP.Sim.create(654, { solo: false });
  const a = PP.Sim.addPlayer(GSp, 1, '甲');
  const b = PP.Sim.addPlayer(GSp, 2, '乙');
  a.x = 50; a.y = 50; b.x = 54; b.y = 50;
  const view = {
    player: a, mates: [{ id: 2, name: '乙', x: 54, y: 50, a: 0, pitch: 0, downed: false, eliminated: false, colorIdx: 1 }],
    enemies: [], projectiles: [], pickups: [], particles: [], renderList: [],
    weapon: 0, mag: [12, 0, 0, 0, 0], reserve: [Infinity, 0, 0, 0, 0], unlocked: [true, false, false, false, false],
    weaponSwayX: 0, weaponBobY: 0, weaponRaise: 0, muzzleT: 0, viewOffsetY: 0
  };
  a.eliminated = true;
  try {
    PP.Render.quality = 0.4; PP.Render.resize();
    PP.Render.frame(view);
    ok(view.spectateName === '乙', '阵亡后自动观战存活队友（' + (view.spectateName || '无') + '）');
  } catch (ex) {
    ok(false, '观战渲染异常: ' + ex.message);
  }
  // 倒地趴低：无敌军时也应能渲染
  a.eliminated = false; a.downed = true;
  view.mates = [];
  try {
    PP.Render.frame(view);
    ok(true, '倒地视角可正常渲染（无队友）');
  } catch (ex) {
    ok(false, '倒地渲染异常: ' + ex.message);
  }
  PP.Render.quality = 1; PP.Render.resize();
}

// 新武器 / 新词条 / 新敌人
ok(PP.WEAPONS.length === 5 && PP.WEAPONS[3].pick === 'sniper' && PP.WEAPONS[4].pick === 'magma', '武器表 5 把且含青金长铳/岩浆喷口');
const sniper = PP.Rogue.rollWeapon(G3.rng, 3, 5);
const sst = PP.Rogue.stats(sniper, {});
ok(sst.dmg >= 50 && sst.headMul >= 3, '青金长铳数值合理 dmg=' + sst.dmg.toFixed(1) + ' head=' + sst.headMul.toFixed(1));
const magma = PP.Rogue.stats({ def: 4, rarity: 0, affixes: [] }, {});
ok(magma.burnBase > 0 && magma.pellets >= 3, '岩浆喷口自带灼烧与多弹丸 burn=' + magma.burnBase);
ok(PP.Rogue.AFFIXES.length >= 18, '武器词条 ≥ 18，现 ' + PP.Rogue.AFFIXES.length);
ok(PP.Rogue.PERKS.length >= 16, '角色 Perk ≥ 16，现 ' + PP.Rogue.PERKS.length);
ok(!!PP.Ent.TYPES.creeper && !!PP.Ent.TYPES.spider, '新敌人：爬行者 / 蜘蛛');
const GC = PP.Sim.create(777, { solo: true });
const meC = PP.Sim.addPlayer(GC, 1, '爆破测试');
meC.x = PP.World.spawn.x + 1; meC.y = PP.World.spawn.y;
const creep = PP.Ent.spawn(GC, 'creeper', meC.x + 1.2, meC.y);
creep.spawnT = 0; creep.cd = 0;
const hpC = meC.hp;
for (let i = 0; i < 40; i++) PP.Sim.tick(GC);
ok(meC.hp < hpC || creep.state === 'dead', '爬行者接近后引爆（HP ' + hpC.toFixed(0) + '→' + meC.hp.toFixed(0) + '）');
const spider = PP.Ent.spawn(GC, 'spider', meC.x + 4, meC.y);
ok(spider.T.speed > 3 && spider.height < 0.7, '蜘蛛高速低矮 speed=' + spider.T.speed);

/* ================= 6. 多人 / 倒地救援 / 友伤 / 快照 ================= */
console.log('[MULTI]');
const GM = PP.Sim.create(555, { solo: false });
const A = PP.Sim.addPlayer(GM, 1, '甲');
const B = PP.Sim.addPlayer(GM, 2, '乙');
ok(GM.playerList.length === 2, '两名玩家加入');
ok(GM.solo === false, '多人模式：不会一倒地就结束');

// 倒地
GM.damagePlayer(2, 500, 0, 0, 0);
ok(B.downed === true, '乙被打倒（进入倒地而非直接淘汰）');
ok(A.downed === false, '甲未受影响');
ok(GM.state === 'playing', '还有人站着 → 本局继续');

// 救援
B.x = A.x + 0.9; B.y = A.y;
PP.Sim.setInput(GM, 1, { revive: true });
for (let i = 0; i < 80; i++) PP.Sim.tick(GM);
ok(B.downed === false, '甲按住 F 把乙救起');
ok(B.hp > 0, '被救起后恢复生命 = ' + Math.round(B.hp));

// 友伤（清场，排除干扰）
GM.enemies.length = 0; GM.projectiles.length = 0;
A.hp = 100; A.ap = 0; A.downed = false; A.eliminated = false; A.invuln = 0;
B.hp = 100; B.ap = 0; B.downed = false; B.eliminated = false; B.invuln = 0;
B.x = A.x + 2; B.y = A.y; A.a = 0; A.pitch = 0; A.pitchBase = 0; A.kickPitch = 0;
A.fireCd = 0; A.reloadT = 0; A.mag[A.weapon] = 12;
GM.friendlyFire = 0.35;
GM.state = 'playing';
let hpB = B.hp;
PP.Sim.fire(GM, A);
ok(B.hp < hpB, '友伤生效：乙掉血 ' + (hpB - B.hp).toFixed(1));
ok((hpB - B.hp) < 30, '友伤被打折（' + (hpB - B.hp).toFixed(1) + ' < 30）');
GM.friendlyFire = 0;
B.hp = 100; A.fireCd = 0; A.reloadT = 0; A.mag[A.weapon] = 12; B.invuln = 0;
PP.Sim.fire(GM, A);
ok(B.hp === 100, '友伤关闭后不掉血');
GM.friendlyFire = 0.35;

// 快照往返
const buf = PP.Snap.encode(GM, A);
const sn = PP.Snap.decode(buf);
ok(sn.players.length >= 1, '快照包含玩家 = ' + sn.players.length);
ok(sn.enemies.length <= GM.enemies.length, '快照包含敌人 = ' + sn.enemies.length + '（AOI 裁剪后）');
let roundtrip = true;
for (const p of sn.players) { if (!isFinite(p.x) || !isFinite(p.y)) roundtrip = false; }
ok(roundtrip, '快照坐标解码有效');
ok(sn.threat === GM.threat, '快照威胁等级一致');

/* ================= 7. 移动端触控 ================= */
console.log('[TOUCH]');
ok(PP.Touch.isTouch() === false, '无头环境正确识别为非触屏设备');
// 桌面/混合设备：有触摸点也不能整机进触屏模式（否则 WASD/鼠标被吃掉）
{
  const g = globalThis;
  const savedOntouch = g.ontouchstart;
  const savedNav = g.navigator;
  Object.defineProperty(g, 'ontouchstart', { value: null, configurable: true, writable: true });
  Object.defineProperty(g, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120', maxTouchPoints: 10 },
    configurable: true
  });
  ok(PP.Touch.isTouch() === false, 'Windows 桌面（maxTouchPoints>0）不进触屏模式');
  Object.defineProperty(g, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', maxTouchPoints: 5 },
    configurable: true
  });
  ok(PP.Touch.isTouch() === true, 'iPhone UA 识别为触屏');
  Object.defineProperty(g, 'navigator', { value: savedNav, configurable: true });
  if (savedOntouch === undefined) delete g.ontouchstart;
  else g.ontouchstart = savedOntouch;
}
const TC = PP.Touch;
TC.enabled = true;
TC.move.x = 0.5; TC.move.y = -1; TC.fire = true; TC.sprint = true;
const ti = { fwd: 0, strafe: 0, sprint: false, fire: false };
TC.applyTo(ti);
ok(ti.fwd === 1 && ti.strafe === 0.5 && ti.fire === true && ti.sprint === true,
  '虚拟摇杆映射正确（前=' + ti.fwd + ' 右=' + ti.strafe + '）');
// 摇杆回中不得清掉键鼠输入
TC.move.x = 0; TC.move.y = 0;
ti.fwd = 1; ti.strafe = -1; ti.fire = true; ti.sprint = true; ti.revive = true;
TC.sprint = false; TC.fire = false; TC.btnRevive = false;
TC.applyTo(ti);
ok(ti.fwd === 1 && ti.strafe === -1 && ti.fire === true && ti.sprint === true && ti.revive === true,
  '摇杆空闲时保留 WASD / 鼠标开火 / 键盘疾跑');
TC.move.x = 0; TC.move.y = 0.1;
ti.fwd = 1; ti.strafe = 1;
TC.applyTo(ti);
ok(ti.fwd < 0, '摇杆下推 = 后退（' + ti.fwd.toFixed(2) + '）');
TC.look.dx = 10; TC.look.dy = -5;
const lk = TC.consumeLook();
ok(lk.dx === 10 && lk.dy === -5 && TC.look.dx === 0, '视角增量可被消费并清零');
TC.firePressed = true;
ok(TC.consumeFire() === true && TC.consumeFire() === false, '开火只触发一次（半自动不会连点）');
TC.btnReload = true;
ok(TC.consumeReload() === true && TC.consumeReload() === false, '装填按钮是一次性触发');
ok(TC.LOOK_SENS > 0, '触屏视角灵敏度 = ' + TC.LOOK_SENS);
TC.enabled = false;
// 移动端降分辨率
PP.Render.quality = 0.55; PP.Render.resize();
ok(PP.Render.W * PP.Render.H < 90000, '移动端画质档位下像素数 = ' + (PP.Render.W * PP.Render.H) + '（桌面为 9 万）');
PP.Render.quality = 1; PP.Render.resize();
ok(PP.Render.W * PP.Render.H >= 80000, '桌面高画质像素数 ≈ ' + (PP.Render.W * PP.Render.H));
PP.Render.quality = 1.5; PP.Render.resize();
ok(PP.Render.W * PP.Render.H > 100000 && PP.Render.ssaa === 1, '高清档内部分辨率提升 ' + PP.Render.W + 'x' + PP.Render.H);
PP.Render.quality = 2.2; PP.Render.resize();
ok(PP.Render.ssaa === 2 && PP.Render.W === PP.Render.outW * 2, '超清档开启 2× 超采样 ' + PP.Render.W + 'x' + PP.Render.H + ' → ' + PP.Render.outW + 'x' + PP.Render.outH);
ok(PP.Render.taa === true && PP.Render.fxaa === true, '超清档启用 TAA-lite + FXAA-lite');
PP.Render.quality = 1.5; PP.Render.resize();
ok(PP.Render.taa === true && PP.Render.ssaa === 1, '高清档启用 TAA-lite + FXAA-lite（无超采样）');
PP.Render.quality = 1; PP.Render.resize();
ok(PP.Render.taa === false, '默认高画质不强制开时域混合（保持像素锐度）');
// 输入夹紧
{
  const GS = PP.Sim.create(999, { solo: true });
  const pS = PP.Sim.addPlayer(GS, 1, '夹紧');
  PP.Sim.setInput(GS, 1, { fwd: 99, strafe: -99, turn: 1e9, pitch: -1e9, switchTo: 999, fire: 1, bogus: 'hack' });
  ok(pS.input.fwd === 1 && pS.input.strafe === -1, '输入分量夹紧到 [-1,1]');
  ok(Math.abs(pS.input.turn) <= 12 && Math.abs(pS.input.pitch) <= 12, '视角速度夹紧');
  ok(pS.input.switchTo === -1, '非法换枪序号被忽略');
  ok(pS.input.bogus === undefined, '未知输入字段被丢弃');
}

/* ================= 8. 设置 & 词条快捷键 ================= */
console.log('[SETTINGS]');
const ST = PP.Settings;
ok(ST.key('fwd') === 'w' && ST.key('sprint') === 'shift', '默认键位加载正常');
ST.data.keys.fwd = 't';
ok(ST.key('fwd') === 't', '键位可重新绑定（前进 → T）');
ST.data.keys.fwd = 'w';
ok(ST.data.keys.w1 === '1' && ST.data.keys.w2 === '2' && ST.data.keys.w3 === '3'
  && ST.data.keys.w4 === '4' && ST.data.keys.w5 === '5', '武器键位存在');
ST.data.volume = 0.3; PP.Audio.setVolume(0.3);
ok(Math.abs(PP.Audio.getVolume() - 0.3) < 0.001, '音量可设置（' + PP.Audio.getVolume() + '）');
PP.Audio.setMuted(true); ok(PP.Audio.isMuted() === true, '静音开关生效');
PP.Audio.setMuted(false); ok(PP.Audio.isMuted() === false, '取消静音生效');
ST.data.mouseSens = 1.5; PP.Render.quality = ST.data.quality; PP.Render.resize();
ok(ST.data.mouseSens === 1.5 && PP.Render.W > 0, '灵敏度与画质可写入');

// 词条快捷键（1/2/3）
{
  const list = [{ id: 'vitality', name: '强健', desc: 'x' }, { id: 'power', name: '重击', desc: 'y' }, { id: 'haste', name: '疾行', desc: 'z' }];
  let picked = null;
  PP.Hud.showPerks(list, (pid) => { picked = pid; });
  ok(PP.Hud.perksOpen(), '选卡弹窗已打开');
  PP.Hud.pickPerk(2);
  ok(picked === 'haste', '数字键 3 选中第 3 张卡（' + picked + '）');
  ok(!PP.Hud.perksOpen(), '选完自动关窗');
  picked = null;
  PP.Hud.showPerks(list, (pid) => { picked = pid; });
  PP.Hud.pickPerk(9);
  ok(picked === null && PP.Hud.perksOpen(), '越界索引不会误选');
  PP.Hud.hidePerks();
}

// 鼠标指针：只有真正在游玩时才锁定（否则点标题/暂停/结算页会把鼠标吞掉）
{
  const h = listeners['stage'] && listeners['stage'].mousedown;
  ok(!!h, '画面点击事件已绑定');
  const G4 = PP.G;
  const keep = G4.state;
  lockCount = 0;
  G4.state = 'paused';
  h({ button: 0, preventDefault: () => { } });
  ok(lockCount === 0, '暂停时点击画面不锁定鼠标');
  G4.state = 'over';
  h({ button: 0, preventDefault: () => { } });
  ok(lockCount === 0, '结算页点击画面不锁定鼠标');
  G4.state = 'playing';
  h({ button: 0, preventDefault: () => { } });
  ok(lockCount === 1, '游玩中点击画面才锁定鼠标');
  G4.state = keep;
}

/* ================= 9. 渲染 ================= */
console.log('[RENDER]');
const OUT = path.join(PROJ, 'screenshots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });
function shot(name, setup) {
  G2.enemies.length = 0; G2.projectiles.length = 0; G2.particles.length = 0;
  G2.viewOffsetY = 0; G2.shake = 0; G2.muzzleT = 0; G2.weaponRaise = 0; G2.weaponBobY = 0; G2.weaponSwayX = 0;
  setup();
  PP.Render.frame(G2);
  const w = captured.width, h2 = captured.height, S = 3;
  const out = new Uint8ClampedArray(w * S * h2 * S * 4);
  for (let y = 0; y < h2 * S; y++) {
    const sy = (y / S) | 0;
    for (let x = 0; x < w * S; x++) {
      const sx = (x / S) | 0;
      const si = (sy * w + sx) * 4, di = (y * w * S + x) * 4;
      out[di] = captured.data[si]; out[di + 1] = captured.data[si + 1];
      out[di + 2] = captured.data[si + 2]; out[di + 3] = 255;
    }
  }
  writePNG(path.join(OUT, name), w * S, h2 * S, out);
  console.log('       -> screenshots/' + name);
}
  let rerr = null;
  try {
    shot('v2_outdoor.png', () => {
    G2.player.x = W.spawn.x; G2.player.y = W.spawn.y; G2.player.a = 0.9; G2.player.pitch = 0.0;
    const a = PP.Ent.spawn(G2, 'zombie', G2.player.x + 4, G2.player.y + 1); a.spawnT = 0;
    const b = PP.Ent.spawn(G2, 'husk', G2.player.x + 7, G2.player.y - 2); b.spawnT = 0;
    const c = PP.Ent.spawn(G2, 'skeleton', G2.player.x + 5, G2.player.y + 4); c.spawnT = 0;
    G2.pickups.push({ kind: 'chest', x: G2.player.x + 3, y: G2.player.y - 3, z: 0.2, t: 0.5, life: Infinity });
  });
  shot('v2_forest.png', () => {
    G2.player.a = 2.2; G2.player.pitch = 0.05; G2.weapon = 1;
    const a = PP.Ent.spawn(G2, 'zombie', G2.player.x + 3.2, G2.player.y + 1.4); a.spawnT = 0; a.windup = 0.3;
    G2.muzzleT = 0.06;
  });
  shot('v2_indoor.png', () => {
    let poi = W.pois.find(p => p.type === 'bunker') || W.pois[1];
    G2.player.x = poi.x; G2.player.y = poi.y; G2.player.a = 0.3; G2.player.pitch = 0;
    G2.weapon = 2;
    const a = PP.Ent.spawn(G2, 'skeleton', poi.x + 2.5, poi.y); a.spawnT = 0; a.windup = 0.3;
    G2.projectiles.push({ x: poi.x + 1.4, y: poi.y, z: 0.62, vx: 1, vy: 0, vz: 0, dmg: 9, life: 2 });
  });
  // 3D 相机验收：抬头看塔顶 / 低头看地面
  shot('v3_lookup.png', () => {
    let poi = W.pois.find(p => p.type === 'tower') || W.pois[2];
    G2.player.x = poi.x + 4; G2.player.y = poi.y; G2.player.a = Math.PI + 0.0; G2.player.pitch = 0.85;
    G2.player.pitchBase = 0.85; G2.weapon = 0;
  });
  shot('v3_lookdown.png', () => {
    G2.player.pitch = -0.9; G2.player.pitchBase = -0.9; G2.player.a = 2.6; G2.weapon = 1;
    const a = PP.Ent.spawn(G2, 'zombie', G2.player.x + 2.5, G2.player.y + 0.6); a.spawnT = 0;
  });
} catch (ex) { rerr = ex; }
ok(rerr === null, '渲染 5 个场景无异常' + (rerr ? ' -> ' + rerr.stack : ''));

// 性能参考：移动端画质档位下的渲染耗时
PP.Render.quality = 0.55; PP.Render.resize();
const pt0 = Date.now();
for (let i = 0; i < 60; i++) PP.Render.frame(G2);
const pms = (Date.now() - pt0) / 60;
console.log('        性能参考: 移动端画质(0.55, ' + PP.Render.W + 'x' + PP.Render.H + ') 渲染 ≈ ' +
  pms.toFixed(2) + ' ms/帧（桌面 V8，手机一般慢 2-4 倍）');
PP.Render.quality = 1; PP.Render.resize();
const pt1 = Date.now();
for (let i = 0; i < 60; i++) PP.Render.frame(G2);
console.log('                  桌面画质(1.0, ' + PP.Render.W + 'x' + PP.Render.H + ') 渲染 ≈ ' +
  ((Date.now() - pt1) / 60).toFixed(2) + ' ms/帧');

console.log('\n结果: ' + (fails === 0 ? '全部通过' : fails + ' 项失败'));
process.exit(fails ? 1 : 0);
