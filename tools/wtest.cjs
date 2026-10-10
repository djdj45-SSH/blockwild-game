/* wtest.cjs — 体素世界生成诊断（node 环境，只读 src/core.js + src/sim/world.js）
   用法： node tools/wtest.cjs [seed]
   关注：可站立列 / BFS 可达率 / POI 可达 / 阻断原因分布 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const ctx = { console, Math, Date, Uint8Array, Int16Array, Float32Array, Int32Array, Uint32Array, Array, Object, JSON };
ctx.globalThis = ctx;
ctx.window = undefined;
vm.createContext(ctx);
for (const f of ['src/core.js', 'src/sim/world.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const PP = ctx.PP;
const W = PP.World;
const SIZE = W.SIZE, HEIGHT = W.HEIGHT;

const seed = (process.argv[2] !== undefined) ? (process.argv[2] >>> 0) : 20261002;
const t0 = Date.now();
W.generate(seed);
const genMs = Date.now() - t0;

const surfZ = W.surfZ, wall = W.wall, baseZ = W.baseZ;
console.log(`=== seed ${seed}  生成 ${genMs}ms  SIZE=${SIZE} HEIGHT=${HEIGHT} SEA=${W.SEA} ===`);

/* --- 1. 可站立列 --- */
let standable = 0;
const zHist = new Map();
for (let i = 0; i < SIZE * SIZE; i++) {
  if (surfZ[i] > 0) { standable++; zHist.set(surfZ[i], (zHist.get(surfZ[i]) || 0) + 1); }
}
console.log(`可站立列 ${standable}/${SIZE * SIZE} = ${(standable / (SIZE * SIZE) * 100).toFixed(1)}%`);
const zs = [...zHist.keys()].sort((a, b) => a - b);
console.log('surfZ 分布:', zs.map(z => `${z}:${zHist.get(z)}`).join(' '));
console.log(`wall 列 ${wall.reduce((a, b) => a + b, 0)}`);

/* --- 2. BFS 可达（8 邻域，stepOK 上1下3） --- */
const seen = new Uint8Array(SIZE * SIZE);
const q = new Int32Array(SIZE * SIZE);
let qh = 0, qt = 0;
const sx = Math.floor(W.spawn.x), sy = Math.floor(W.spawn.y);
if (!W.passable(sx, sy)) console.log(`!! 出生点 (${sx},${sy}) 不可站 surfZ=${surfZ[sy * SIZE + sx]}`);
seen[sy * SIZE + sx] = 1; q[qt++] = sy * SIZE + sx;
const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
while (qh < qt) {
  const i = q[qh++];
  const x = i % SIZE, y = (i / SIZE) | 0;
  for (const [dx, dy] of NB) {
    const nx = x + dx, ny = y + dy;
    if (nx < 2 || ny < 2 || nx >= SIZE - 2 || ny >= SIZE - 2) continue;
    const j = ny * SIZE + nx;
    if (seen[j]) continue;
    if (!W.passable(nx, ny)) continue;
    if (!W.stepOK(x, y, nx, ny)) continue;
    seen[j] = 1; q[qt++] = j;
  }
}
let reach = 0;
for (let i = 0; i < SIZE * SIZE; i++) if (seen[i]) reach++;
console.log(`BFS 可达列 ${reach} / 可站立 ${standable} = ${(reach / standable * 100).toFixed(1)}%`);

/* --- 3. 阻断原因统计：站在可达区边缘，统计邻居为何进不去 --- */
const reason = { notPassable: 0, climb: 0, drop: 0, dropBig: 0, ok: 0 };
const dropHist = new Map(), climbHist = new Map();
for (let y = 2; y < SIZE - 2; y++) {
  for (let x = 2; x < SIZE - 2; x++) {
    const i = y * SIZE + x;
    if (!seen[i]) continue;
    for (const [dx, dy] of NB) {
      const nx = x + dx, ny = y + dy;
      if (nx < 2 || ny < 2 || nx >= SIZE - 2 || ny >= SIZE - 2) continue;
      const j = ny * SIZE + nx;
      if (seen[j]) continue;
      const sa = surfZ[i], sb = surfZ[j];
      if (!W.passable(nx, ny)) { reason.notPassable++; continue; }
      const d = sb - sa;
      if (d > 1) { reason.climb++; climbHist.set(d, (climbHist.get(d) || 0) + 1); }
      else if (sa - sb > 3) { reason.dropBig++; dropHist.set(sa - sb, (dropHist.get(sa - sb) || 0) + 1); }
      else reason.ok++;
    }
  }
}
console.log('边缘阻断原因:', JSON.stringify(reason));
if (climbHist.size) console.log('  上不去(需爬 N 格):', [...climbHist.entries()].sort((a, b) => a[0] - b[0]).map(e => `${e[0]}:${e[1]}`).join(' '));
if (dropHist.size) console.log('  下不去(落差 N 格):', [...dropHist.entries()].sort((a, b) => a[0] - b[0]).map(e => `${e[0]}:${e[1]}`).join(' '));
console.log(`  ⚠️ ok=${reason.ok} 表示"高差合法却没被 BFS 收入" —— 非 0 说明 BFS/判定不一致`);

/* --- 4. 不可达簇的大小分布 --- */
const compSz = [];
const seen2 = new Uint8Array(SIZE * SIZE);
for (let i = 0; i < SIZE * SIZE; i++) {
  if (seen2[i] || !W.passable(i % SIZE, (i / SIZE) | 0)) continue;
  let n = 0; const st = [i]; seen2[i] = 1;
  while (st.length) {
    const k = st.pop(); n++;
    const x = k % SIZE, y = (k / SIZE) | 0;
    for (const [dx, dy] of NB) {
      const nx = x + dx, ny = y + dy;
      if (nx < 2 || ny < 2 || nx >= SIZE - 2 || ny >= SIZE - 2) continue;
      const j = ny * SIZE + nx;
      if (seen2[j] || !W.passable(nx, ny) || !W.stepOK(x, y, nx, ny)) continue;
      seen2[j] = 1; st.push(j);
    }
  }
  compSz.push(n);
}
compSz.sort((a, b) => b - a);
console.log(`连通块 ${compSz.length} 个，最大 5 个: ${compSz.slice(0, 5).join(', ')}，孤立(<20格) ${compSz.filter(n => n < 20).length} 个`);
console.log(`spawn 所在连通块 ${reach}；非 spawn 块合计 ${standable - reach}（屋顶/树顶/塔顶为正常）`);

/* --- 5. POI 可达 --- */
let ok = 0;
const bad = [];
for (const p of W.pois) {
  const px = Math.floor(p.x), py = Math.floor(p.y);
  let hit = false;
  for (let r = 0; r <= 6 && !hit; r++) {
    for (let dy = -r; dy <= r && !hit; dy++) for (let dx = -r; dx <= r && !hit; dx++) {
      const nx = px + dx, ny = py + dy;
      if (nx < 2 || ny < 2 || nx >= SIZE - 2 || ny >= SIZE - 2) continue;
      if (seen[ny * SIZE + nx]) hit = true;
    }
  }
  if (hit) ok++; else bad.push(`${p.type}@${px},${py}`);
}
console.log(`POI 可达 ${ok}/${W.pois.length}` + (bad.length ? `  不可达: ${bad.slice(0, 12).join(' ')}` : ''));

/* --- 6. ASCII 俯视图 --- */
const step = 4;
let art = '';
for (let y = 0; y < SIZE; y += step) {
  let line = '';
  for (let x = 0; x < SIZE; x += step) {
    const i = y * SIZE + x;
    if (x === sx && y === sy) line += 'S';
    else if (!surfZ[i]) line += '#';
    else if (seen[i]) line += '.';
    else line += 'x';
  }
  art += line + '\n';
}
console.log('--- 俯视（. 可达 / x 不可达 / # 无站立面 / S 出生点）---');
console.log(art);
