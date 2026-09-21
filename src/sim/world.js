/* ============================================================
   world.js — 程序生成的开放世界（明亮方块风）
   世界数据仍是 2D 网格：联机同步、寻路、AI 全部复用；
   渲染成本只跟分辨率有关，所以地图放大几乎不增加开销。
   墙 id: 1石 2木板 3砖 4砂岩 5原木 6树叶 7仙人掌 8红石矿 9基岩
   地面 id: 0草 1土 2沙 3石 4木板 5水 6雪
   ============================================================ */
(function () {
  const ROOT = (typeof window !== 'undefined') ? window : globalThis;
  const PP = (ROOT.PP = ROOT.PP || {});
  const World = (PP.World = {});
  const Core = () => PP.Core;

  const SIZE = 192;
  const CHUNK = 32;
  World.SIZE = SIZE;
  World.CHUNK = CHUNK;
  World.chunksX = SIZE / CHUNK;
  World.seed = 1;
  World.wall = null;
  World.floor = null;
  World.pois = [];
  World.spawn = { x: SIZE / 2 + 0.5, y: SIZE / 2 + 0.5, a: -Math.PI / 2 };
  World.isWater = function (t) { return t === 5; };
  /* 每格墙高（世界单位，1 = 一格方块）：树/仙人掌更高，形成真正的轮廓 */
  World.wallHeight = [1, 1, 1, 1, 1, 2.3, 1.8, 1.5, 1, 1];

  function idx(x, y) { return y * SIZE + x; }

  /* ---------------- 生成 ---------------- */
  World.generate = function (seed) {
    World.seed = seed >>> 0;
    const rng = new (Core().Rng)(World.seed);
    const wall = new Uint8Array(SIZE * SIZE);
    const floor = new Uint8Array(SIZE * SIZE);
    World.wall = wall; World.floor = floor; World.pois = [];
    const fbm = Core().fbm;

    // 1) 基岩边界
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      if (x < 2 || y < 2 || x >= SIZE - 2 || y >= SIZE - 2) wall[idx(x, y)] = 9;
    }

    // 2) 生物群系 + 地面 + 水
    for (let y = 2; y < SIZE - 2; y++) {
      for (let x = 2; x < SIZE - 2; x++) {
        const moist = fbm(x / 46, y / 46, World.seed + 11, 3);
        const temp = fbm(x / 62, y / 62, World.seed + 27, 3);
        const elev = fbm(x / 74, y / 74, World.seed + 43, 4);
        let f;
        if (elev < 0.33) f = 5;                                   // 湖
        else if (temp > 0.60 && moist < 0.42) f = 2;              // 沙漠
        else if (elev > 0.70) f = 3;                              // 岩石高地
        else if (moist > 0.56) f = 0;                             // 森林（草）
        else f = 0;                                               // 草原
        floor[idx(x, y)] = f;
      }
    }

    // 3) 散布植被与岩石
    for (let y = 3; y < SIZE - 3; y++) {
      for (let x = 3; x < SIZE - 3; x++) {
        const f = floor[idx(x, y)];
        if (f === 5) continue;
        const n = Core().h2(x, y, World.seed + 991);
        const moist = fbm(x / 46, y / 46, World.seed + 11, 3);
        const elev = fbm(x / 74, y / 74, World.seed + 43, 4);
        if ((f === 0 && moist > 0.58) && n < 0.055) { plantTree(wall, x, y, rng); }
        else if (f === 0 && n < 0.012) { plantTree(wall, x, y, rng); }
        else if (f === 2 && n < 0.02) { wall[idx(x, y)] = 7; }
        else if (f === 2 && n > 0.995) { blob(wall, x, y, 4, rng); }
        else if (f === 3 && n < 0.03) { blob(wall, x, y, 3, rng); }
        else if (f === 3 && n > 0.994) { blob(wall, x, y, 8, rng, 8); }   // 红石矿脉
        else if (f === 0 && n > 0.993) { blob(wall, x, y, 3, rng); }
      }
    }

    // 4) POI：抖动网格，保证不重叠
    const step = 26;
    for (let gy = step; gy < SIZE - step; gy += step) {
      for (let gx = step; gx < SIZE - step; gx += step) {
        const cx = gx + rng.int(13) - 6;
        const cy = gy + rng.int(13) - 6;
        const d = Math.hypot(cx - SIZE / 2, cy - SIZE / 2);
        if (d < 16) continue;                        // 出生区留空
        const roll = rng.next();
        if (roll < 0.34) makeRuin(wall, floor, cx, cy, rng);
        else if (roll < 0.62) makeCabin(wall, floor, cx, cy, rng);
        else if (roll < 0.85) makeBunker(wall, floor, cx, cy, rng);
        else makeTower(wall, floor, cx, cy, rng);
      }
    }

    // 5) 出生营地：清出一块空地，放补给箱
    const sx = (SIZE / 2) | 0, sy = (SIZE / 2) | 0;
    for (let y = sy - 6; y <= sy + 6; y++) for (let x = sx - 6; x <= sx + 6; x++) {
      if (x < 3 || y < 3 || x >= SIZE - 3 || y >= SIZE - 3) continue;
      wall[idx(x, y)] = 0; floor[idx(x, y)] = 0;
    }
    World.pois.push({ type: 'camp', x: sx + 0.5, y: sy + 0.5, r: 6 });
    return World;
  };

  function plantTree(wall, x, y, rng) {
    const h = 1;
    wall[idx(x, y)] = 5;                       // 树干（1 格）
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      if (rng.next() < 0.75 && wall[idx(x + dx, y + dy)] === 0) wall[idx(x + dx, y + dy)] = 6;
    }
  }

  function blob(wall, x, y, kind, rng, r) {
    const rad = r || 1;
    for (let dy = -rad; dy <= rad; dy++) for (let dx = -rad; dx <= rad; dx++) {
      if (dx * dx + dy * dy > rad * rad + 1) continue;
      if (rng.next() < 0.55) continue;
      const nx = x + dx, ny = y + dy;
      if (nx < 3 || ny < 3 || nx >= SIZE - 3 || ny >= SIZE - 3) continue;
      if (wall[idx(nx, ny)] === 0) wall[idx(nx, ny)] = kind;
    }
  }

  function boxWalls(wall, floor, x0, y0, x1, y1, mat, floorId, doors) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (x < 3 || y < 3 || x >= SIZE - 3 || y >= SIZE - 3) continue;
      const edge = (x === x0 || x === x1 || y === y0 || y === y1);
      if (edge) wall[idx(x, y)] = mat;
      else { wall[idx(x, y)] = 0; floor[idx(x, y)] = floorId; }   // 内部必须清空（否则原有的树/岩石会把房间堵死）
    }
    // 开门
    for (const d of doors) {
      wall[idx(d[0], d[1])] = 0;
      if (d[2]) { wall[idx(d[0] + 1, d[1])] = 0; }
    }
  }

  function makeRuin(wall, floor, cx, cy, rng) {
    const w = 5 + rng.int(4), h = 5 + rng.int(4);
    const x0 = cx - (w >> 1), y0 = cy - (h >> 1), x1 = x0 + w, y1 = y0 + h;
    boxWalls(wall, floor, x0, y0, x1, y1, 3, 3, [
      [x0 + 1 + rng.int(w - 2), y0, 0], [x0 + 1 + rng.int(w - 2), y1, 0],
      [x0, y0 + 1 + rng.int(h - 2), 0], [x1, y0 + 1 + rng.int(h - 2), 0]
    ]);
    // 破损缺口
    for (let i = 0; i < 3 + rng.int(4); i++) {
      const ex = rng.chance(0.5) ? (rng.chance(0.5) ? x0 : x1) : x0 + rng.int(w);
      const ey = rng.chance(0.5) ? (rng.chance(0.5) ? y0 : y1) : y0 + rng.int(h);
      if (ex >= 3 && ey >= 3) wall[idx(ex, ey)] = 0;
    }
    World.pois.push({ type: 'ruin', x: cx + 0.5, y: cy + 0.5, r: Math.max(w, h) / 2 + 1 });
  }

  function makeCabin(wall, floor, cx, cy, rng) {
    const w = 6 + rng.int(3), h = 6 + rng.int(3);
    const x0 = cx - (w >> 1), y0 = cy - (h >> 1), x1 = x0 + w, y1 = y0 + h;
    boxWalls(wall, floor, x0, y0, x1, y1, 2, 4, [[x0 + 1 + rng.int(w - 2), y1, 1]]);
    World.pois.push({ type: 'cabin', x: cx + 0.5, y: cy + 0.5, r: Math.max(w, h) / 2 + 1 });
  }

  function makeBunker(wall, floor, cx, cy, rng) {
    const w = 7, h = 7;
    const x0 = cx - 3, y0 = cy - 3, x1 = x0 + w, y1 = y0 + h;
    boxWalls(wall, floor, x0, y0, x1, y1, 1, 3, [[cx, y1, 1]]);
    for (let y = y0 + 1; y < y1; y++) for (let x = x0 + 1; x < x1; x++) floor[idx(x, y)] = 3;
    World.pois.push({ type: 'bunker', x: cx + 0.5, y: cy + 0.5, r: 5 });
  }

  function makeTower(wall, floor, cx, cy, rng) {
    const r = 3 + rng.int(2);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      const x = cx + dx, y = cy + dy;
      if (x < 3 || y < 3 || x >= SIZE - 3 || y >= SIZE - 3) continue;
      if (d > r) continue;
      if (d > r - 1.4) { wall[idx(x, y)] = 1; } else { wall[idx(x, y)] = 0; floor[idx(x, y)] = 3; }
    }
    // 入口（否则塔内宝箱永远拿不到）
    wall[idx(cx, cy + r)] = 0;
    wall[idx(cx + 1, cy + r)] = 0;
    wall[idx(cx, cy + r - 1)] = 0;
    World.pois.push({ type: 'tower', x: cx + 0.5, y: cy + 0.5, r: r + 1 });
  }

  /* ---------------- 查询 ---------------- */
  World.isWallTile = function (tx, ty) {
    if (tx < 0 || ty < 0 || tx >= SIZE || ty >= SIZE) return true;
    return World.wall[ty * SIZE + tx] !== 0;
  };
  World.tileAt = function (tx, ty) {
    if (tx < 0 || ty < 0 || tx >= SIZE || ty >= SIZE) return 9;
    return World.wall[ty * SIZE + tx];
  };
  World.isWall = function (x, y) { return World.isWallTile(Math.floor(x), Math.floor(y)); };
  World.floorAt = function (x, y) {
    const tx = Math.floor(x), ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= SIZE || ty >= SIZE) return 0;
    return World.floor[ty * SIZE + tx];
  };
  World.inWater = function (x, y) { return World.floorAt(x, y) === 5; };

  World.circleBlocked = function (x, y, r) {
    return World.isWall(x - r, y - r) || World.isWall(x + r, y - r) ||
           World.isWall(x - r, y + r) || World.isWall(x + r, y + r) || World.isWall(x, y);
  };

  World.rayWall = function (px, py, dx, dy, maxD) {
    let mapX = Math.floor(px), mapY = Math.floor(py);
    const ddx = dx === 0 ? Infinity : Math.abs(1 / dx);
    const ddy = dy === 0 ? Infinity : Math.abs(1 / dy);
    let stepX, stepY, sdx, sdy;
    if (dx < 0) { stepX = -1; sdx = (px - mapX) * ddx; } else { stepX = 1; sdx = (mapX + 1 - px) * ddx; }
    if (dy < 0) { stepY = -1; sdy = (py - mapY) * ddy; } else { stepY = 1; sdy = (mapY + 1 - py) * ddy; }
    let d = 0, guard = 0;
    while (guard++ < 512) {
      if (sdx < sdy) { d = sdx; sdx += ddx; mapX += stepX; }
      else { d = sdy; sdy += ddy; mapY += stepY; }
      if (d > maxD) return maxD;
      if (World.isWallTile(mapX, mapY)) return d;
    }
    return maxD;
  };

  World.losClear = function (x0, y0, x1, y1) {
    const dx = x1 - x0, dy = y1 - y0;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-5) return true;
    return World.rayWall(x0, y0, dx / dist, dy / dist, dist) >= dist - 1e-4;
  };

  /* ---------------- 流场寻路（每个玩家一张局部窗口） ----------------
     开放世界不能全图 BFS，只在每个玩家周围算；远处敌人靠低频宏观移动。
     联机时每位玩家一张场，敌人用"自己目标玩家"的那张。 */
  const FLOW_R = 26;
  const FW = FLOW_R * 2 + 1;
  const MAX_FIELDS = 8;
  const DIRS8 = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const fields = [];
  World.fieldCount = 0;
  function field(i) {
    if (!fields[i]) fields[i] = { dist: new Int32Array(FW * FW), q: new Int32Array(FW * FW), ox: 0, oy: 0, ready: false };
    return fields[i];
  }

  World.buildFlows = function (pts) {
    const n = Math.min(pts.length, MAX_FIELDS);
    for (let i = 0; i < n; i++) {
      const f = field(i);
      const px = pts[i][0], py = pts[i][1];
      f.dist.fill(-1);
      f.ox = Math.floor(px) - FLOW_R;
      f.oy = Math.floor(py) - FLOW_R;
      f.ready = true;
      const sx = Math.floor(px), sy = Math.floor(py);
      let head = 0, tail = 0;
      const put = (lx, ly, d) => { const k = ly * FW + lx; f.dist[k] = d; f.q[tail++] = k; };
      if (!World.isWallTile(sx, sy)) put(sx - f.ox, sy - f.oy, 0);
      else {
        let done = false;
        for (const dd of DIRS8) {
          if (!World.isWallTile(sx + dd[0], sy + dd[1])) { put(sx + dd[0] - f.ox, sy + dd[1] - f.oy, 0); done = true; break; }
        }
        if (!done) continue;
      }
      while (head < tail) {
        const c = f.q[head++];
        const lx = c % FW, ly = (c / FW) | 0;
        const nd = f.dist[c] + 1;
        for (const dd of DIRS8) {
          const nx = lx + dd[0], ny = ly + dd[1];
          if (nx < 0 || ny < 0 || nx >= FW || ny >= FW) continue;
          const k = ny * FW + nx;
          if (f.dist[k] !== -1) continue;
          const wx = nx + f.ox, wy = ny + f.oy;
          if (World.isWallTile(wx, wy)) continue;
          if (dd[0] && dd[1] && (World.isWallTile(wx, wy - dd[1]) || World.isWallTile(wx - dd[0], wy))) continue;
          f.dist[k] = nd; f.q[tail++] = k;
        }
      }
    }
    World.fieldCount = n;
  };

  World.buildFlow = function (px, py) { World.buildFlows([[px, py]]); };

  World.flowDir = function (i, x, y) {
    const f = fields[i | 0];
    if (!f || !f.ready) return null;
    const lx = Math.floor(x) - f.ox, ly = Math.floor(y) - f.oy;
    if (lx < 0 || ly < 0 || lx >= FW || ly >= FW) return null;
    const here = f.dist[ly * FW + lx];
    let bestD = here < 0 ? 1e9 : here, bx = -1, by = -1;
    for (const dd of DIRS8) {
      const nx = lx + dd[0], ny = ly + dd[1];
      if (nx < 0 || ny < 0 || nx >= FW || ny >= FW) continue;
      const d = f.dist[ny * FW + nx];
      if (d < 0) continue;
      const wx = nx + f.ox, wy = ny + f.oy;
      if (dd[0] && dd[1] && (World.isWallTile(wx, wy - dd[1]) || World.isWallTile(wx - dd[0], wy))) continue;
      if (d < bestD) { bestD = d; bx = nx; by = ny; }
    }
    if (bx < 0) return null;
    const tx = bx + f.ox + 0.5, ty = by + f.oy + 0.5;
    const vx = tx - x, vy = ty - y;
    const l = Math.hypot(vx, vy);
    if (l < 1e-4) return null;   // 目标点就是脚下（浮点角点），退回直追
    return { x: vx / l, y: vy / l };
  };

  // 该格是否与第 i 位玩家在同一连通区（用于刷怪点校验，防止刷进封闭区）
  World.flowReachable = function (i, x, y) {
    const f = fields[i | 0];
    if (!f || !f.ready) return false;
    const lx = Math.floor(x) - f.ox, ly = Math.floor(y) - f.oy;
    if (lx < 0 || ly < 0 || lx >= FW || ly >= FW) return false;
    return f.dist[ly * FW + lx] >= 0;
  };

  /* ---------------- 随机取点（环形拒绝采样，O(1)） ---------------- */
  World.randomSpawn = function (rng, ax, ay, minDist, maxDist) {
    const maxD = maxDist || (minDist + 18);
    for (let i = 0; i < 40; i++) {
      const a = rng.next() * Math.PI * 2;
      const d = minDist + rng.next() * (maxD - minDist);
      const x = ax + Math.cos(a) * d, y = ay + Math.sin(a) * d;
      if (x < 3 || y < 3 || x >= SIZE - 3 || y >= SIZE - 3) continue;
      if (World.isWallTile(x | 0, y | 0)) continue;
      if (World.floor[idx(x | 0, y | 0)] === 5) continue;
      return { x: x, y: y };
    }
    return { x: ax + 2, y: ay + 2 };
  };

  World.randomFloor = function (rng, ax, ay, maxDist) {
    for (let i = 0; i < 40; i++) {
      const a = rng.next() * Math.PI * 2;
      const d = rng.next() * (maxDist || 20);
      const x = ax + Math.cos(a) * d, y = ay + Math.sin(a) * d;
      if (x < 3 || y < 3 || x >= SIZE - 3 || y >= SIZE - 3) continue;
      if (World.isWallTile(x | 0, y | 0)) continue;
      return { x: x, y: y };
    }
    return { x: ax + 1, y: ay + 1 };
  };
})();
