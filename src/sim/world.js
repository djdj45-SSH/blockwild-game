/* ============================================================
   world.js — 真三维体素世界（Minecraft 原版资源 / 1 米立方）

   坐标约定（与渲染层一致，勿改）：
     sim  (x, y) = 水平面，z = 高度（1 单位 = 1 米 = 1 个方块）
     three (x, y, z) 中 three.y = sim.z
   体素索引：vox[(z * SIZE + y) * SIZE + x]

   世界同时维护 4 张 2D 派生表，供寻路 / 刷怪 / 视线 / 兼容旧逻辑使用：
     baseZ[i]  地形（含人工地基）顶面实心块的 z —— "不盖东西时你站在哪"
     surfZ[i]  该列**最低**可站立面（自下而上第一个「脚下实心 + 两格净空」）
     wall[i]   1 = 地面层有遮挡物（树 / 墙 / 岩石），用于视线与兜底碰撞
     floor[i]  地表材质分类（0草 1土 2沙 3石 4木板 5水 6雪）

   ⚠️ surfZ 取"最低"而不是"最高"：这样建筑内部（地板 + 屋顶）算出来是
      室内地板层，人才能走进去；屋顶则靠外墙列 surfZ = 屋顶面体现。
   ============================================================ */
(function () {
  const ROOT = (typeof window !== 'undefined') ? window : globalThis;
  const PP = (ROOT.PP = ROOT.PP || {});
  const World = (PP.World = {});
  const Core = () => PP.Core;

  /* ---------------- 方块表 ---------------- */
  const B = {
    AIR: 0, STONE: 1, GRASS: 2, DIRT: 3, SAND: 4, SANDSTONE: 5, LOG: 6,
    LEAVES: 7, PLANK: 8, COBBLE: 9, BRICK: 10, WATER: 11, BEDROCK: 12,
    GLASS: 13, CACTUS: 14, REDSTONE: 15, SNOW: 16, GRAVEL: 17, MOSSY: 18,
    OBSIDIAN: 19, IRON: 20, GOLD: 21, WOOL: 22
  };
  World.B = B;

  const SOLID = new Uint8Array(32);
  for (const k of ['STONE', 'GRASS', 'DIRT', 'SAND', 'SANDSTONE', 'LOG', 'LEAVES',
    'PLANK', 'COBBLE', 'BRICK', 'BEDROCK', 'GLASS', 'CACTUS', 'REDSTONE',
    'SNOW', 'GRAVEL', 'MOSSY', 'OBSIDIAN', 'IRON', 'GOLD', 'WOOL']) SOLID[B[k]] = 1;
  World.SOLID = SOLID;
  // 水不阻挡；空气不阻挡
  World.isSolidId = function (id) { return SOLID[id] === 1; };

  /* ---------------- 尺寸 ---------------- */
  const SIZE = 192;
  const HEIGHT = 40;
  /* 海平面不是常量 —— 生成时按高度图的 18% 分位数自适应取值。
     写死一个数字在"这一局的地形整体偏高/偏低"时会退化成
     「整张图全是湖」或「一滴水都没有」，两种都很出戏。 */
  let SEA = 9;
  const CHUNK = 16;              // 渲染分块边长
  World.SIZE = SIZE;
  World.HEIGHT = HEIGHT;
  World.SEA = SEA;
  World.CHUNK = CHUNK;
  World.chunksX = SIZE / CHUNK;
  World.seed = 1;
  World.spawn = { x: SIZE / 2 + 0.5, y: SIZE / 2 + 0.5, a: -Math.PI / 2 };
  World.pois = [];

  /* 物理常量（Minecraft 手感：重力 26、跳跃初速 8.4 → 跳高 ≈ 1.36 格） */
  const GRAVITY = 26;
  const JUMP_V = 8.4;
  const STEP_UP = 1.0;           // 可自动跨上的台阶高度（1 格）
  const STEP_DOWN = 1.05;        // 走路下坡时贴合地面的最大落差（否则一路弹跳）
  const FALL_SAFE = 4.5;         // 安全坠落高度（超过才吃掉落伤害）
  World.GRAVITY = GRAVITY;
  World.JUMP_V = JUMP_V;
  World.FALL_SAFE = FALL_SAFE;
  World.STEP_UP = STEP_UP;

  /* 结构体素与派生表（复用，避免重开局反复分配 1.4MB） */
  const N2 = SIZE * SIZE;
  const vox = new Uint8Array(N2 * HEIGHT);
  const baseZ = new Uint8Array(N2);
  const surfZ = new Uint8Array(N2);
  const wall = new Uint8Array(N2);
  const floor = new Uint8Array(N2);
  const biome = new Uint8Array(N2);
  World.vox = vox;
  World.baseZ = baseZ;
  World.surfZ = surfZ;
  World.wall = wall;
  World.floor = floor;
  World.biome = biome;
  World._stamp = 0;

  function vi(x, y, z) { return (z * SIZE + y) * SIZE + x; }
  World.vi = vi;

  function inXY(x, y) { return x >= 0 && y >= 0 && x < SIZE && y < SIZE; }
  function getB(x, y, z) {
    if (!inXY(x, y) || z < 0 || z >= HEIGHT) return 0;
    return vox[(z * SIZE + y) * SIZE + x];
  }
  World.getBlock = getB;
  function setB(x, y, z, m) {
    if (!inXY(x, y) || z < 0 || z >= HEIGHT) return;
    vox[(z * SIZE + y) * SIZE + x] = m;
  }
  World.setBlock = setB;

  /* 界外 = 实心（防止走出地图）；世界顶 = 空气 */
  function isSolid(x, y, z) {
    if (z < 0) return true;
    if (z >= HEIGHT) return false;
    if (!inXY(x, y)) return true;
    return SOLID[vox[(z * SIZE + y) * SIZE + x]] === 1;
  }
  World.solidAt = isSolid;
  World.pointSolid = function (x, y, z) { return isSolid(Math.floor(x), Math.floor(y), Math.floor(z)); };

  /* ---------------- 生成 ---------------- */
  World.generate = function (seed) {
    World.seed = seed >>> 0;
    World._stamp = (World._stamp | 0) + 1;
    const rng = new (Core().Rng)(World.seed);
    const fbm = Core().fbm;
    const S = World.seed;
    World.pois = [];
    vox.fill(0);

    /* --- 1a) 高度图（先算完再灌水，海平面要按分位数自适应） --- */
    const topTmp = new Int16Array(N2);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        /* 三尺度高度图 —— 真 3D 的地形不能只有"起伏"，要有"地势"。

           ⚠️ 两个约束必须同时满足，否则要么平、要么碎：

           ① **梯度约束（防碎）**：value-noise 里 fbm 的每层贡献是 amp*freq，
              而 amp*freq 恒为常数 → 总梯度 ≈ octaves/波长。
              单层波长 λ 的相邻格高差最大 ≈ 1.5/λ，要让**相邻格高差 ≤ 1**
              且不出现 2 格断崖（寻路 stepOK 只允许上 1 格），长波长层的
              振幅必须 ≤ 波长 × 0.5 左右。
              曾经的错误做法："波长 74 + 振幅 15" → 振幅/波长 = 0.2，
              看着安全，但 fbm 两层叠加后实际 ±3.7 格，叠加三尺度就会碎。

           ② **振幅约束（防平）**：fbm 的取值在 0.5 附近高度集中
              （实测 0.45~0.70 占样本 70%），
              直接用 (elev-0.5)*K 会让绝大多数格子挤在中位数附近
              → 大片 `6 6 6 6` 的平板地。必须**放大对比度**
              （把 elev 先从 [0.2,0.8] 重映射到 [-1,1] 再乘振幅）。

           做法：三个尺度各管一件事，最后按格取整。
             macro  波长 130，振幅 7   → 山脉走向、盆地与高地（站远处才能看出的"地势"）
             base   波长  52，振幅 3.5 → 丘陵起伏（走两步就有高差变化）
             detail 波长  17，振幅 1.2 → 表面粗糙度（不改变大形，只让边缘不呆板）
           三者的长波长层都满足 振幅/波长 ≤ 0.06，远低于 0.5 的安全线。

           实测（seed 20261002）：surfZ 跨度 4~21，相邻高差 |d|≤1 占 88%，
           可达率 93%，POI 25/25 全可达。 */
        const contrast = (v, lo, hi) => Math.max(0, Math.min(1, (v - lo) / (hi - lo))) * 2 - 1;
        const macro = contrast(fbm(x / 130, y / 130, S + 43, 2), 0.30, 0.72);
        const base = (fbm(x / 52, y / 52, S + 77, 2) - 0.5) * 2;
        const det = (fbm(x / 17, y / 17, S + 131, 3) - 0.5) * 2;
        let t = 8 + macro * 8.5 + base * 2.6 + det * 0.9;
        /* 边缘抬升成山脊：既是天然边界，也避免"走到地图外"。
           ⚠️ 斜率必须 ≤ 1 格/格：寻路的 stepOK 只允许「上 1 格」，
           2.2 格/格 的陡坡会让整条边界带变成谁也爬不上去的死区
           （实测吃掉 23% 地图，可达率只有 78%）。1 格/格 是 45° 台阶，
           能自动跨上，视觉上仍是一圈围住地图的山。 */
        const edge = Math.min(x, y, SIZE - 1 - x, SIZE - 1 - y);
        if (edge < 10) t = Math.max(t, 7 + (10 - edge));
        t = Math.round(t);
        if (t < 3) t = 3; else if (t > HEIGHT - 8) t = HEIGHT - 8;

        const moist = fbm(x / 46, y / 46, S + 11, 3);
        const temp = fbm(x / 62, y / 62, S + 27, 3);
        let bi = 0;                                  // 草原 / 森林
        if (t >= 17) bi = 3;                         // 雪峰
        else if (temp > 0.56 && moist < 0.46 && t < 11) bi = 1;   // 沙漠
        else if (t >= 14) bi = 2;                    // 岩石高地
        const i = y * SIZE + x;
        biome[i] = bi;
        topTmp[i] = t;
        baseZ[i] = t;
      }
    }
    // 海平面 = 高度图 18% 分位数（约五分之一的地图是水面）
    {
      const sample = [];
      for (let i = 0; i < N2; i += 7) sample.push(topTmp[i]);
      sample.sort((a, b) => a - b);
      SEA = sample[(sample.length * 0.18) | 0] || 9;
      if (SEA < 4) SEA = 4; else if (SEA > HEIGHT - 12) SEA = HEIGHT - 12;
      World.SEA = SEA;
    }

    /* --- 1b) 地层填充 + 灌水 --- */
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const i = y * SIZE + x;
        const t = topTmp[i];
        const bi = biome[i];
        const surface = bi === 1 ? B.SAND : bi === 2 ? B.STONE : bi === 3 ? B.SNOW : B.GRASS;
        const sub = bi === 1 ? B.SAND : bi === 2 ? B.STONE : (bi === 3 ? B.STONE : B.DIRT);
        for (let z = 0; z <= t; z++) {
          let m;
          if (z === 0) m = B.BEDROCK;
          else if (z === t) m = surface;
          else if (z >= t - 3) m = sub;
          else m = B.STONE;
          vox[(z * SIZE + y) * SIZE + x] = m;
        }
        if (t < SEA) {
          for (let z = t + 1; z <= SEA; z++) vox[(z * SIZE + y) * SIZE + x] = B.WATER;
        }
      }
    }

    /* --- 2) 植被与地表装饰 --- */
    for (let y = 3; y < SIZE - 3; y++) {
      for (let x = 3; x < SIZE - 3; x++) {
        const i = y * SIZE + x;
        const bi = biome[i];
        const top = baseZ[i];
        if (top < SEA) continue;                       // 水下不长东西
        const n = Core().h2(x, y, S + 991);
        const forest = fbm(x / 38, y / 38, S + 5, 3);
        if (bi === 0) {
          if ((forest > 0.55 && n < 0.030) || n < 0.0035) plantTree(x, y, top, rng);
        } else if (bi === 1) {
          if (n < 0.016) plantCactus(x, y, top, rng);
          else if (n > 0.996) blobAt(x, y, top + 1, B.SANDSTONE, 2, rng);
        } else if (bi === 2) {
          if (n < 0.020) blobAt(x, y, top + 1, B.COBBLE, 2, rng);
          else if (n > 0.9975) blobAt(x, y, top + 1, B.REDSTONE, 2, rng);
        } else if (bi === 3) {
          if (n < 0.010) blobAt(x, y, top + 1, B.STONE, 2, rng);
        }
      }
    }

    /* --- 3) POI 建筑（抖动网格）
       ⚠️ step 必须大于"最宽建筑 + 护坡"：塔的地基是 2r+H+5 ≈ 18 格宽，
          原来 step=26 + 抖动 ±6 → 最近的两个中心只隔 14 格，后建的塔会把
          先建的地基/阶梯挖掉一半。改 step=30 + 抖动 ±4 → 最近 22 格。 */
    const step = 30;
    for (let gy = step; gy < SIZE - step; gy += step) {
      for (let gx = step; gx < SIZE - step; gx += step) {
        const cx = gx + rng.int(9) - 4;
        const cy = gy + rng.int(9) - 4;
        const d = Math.hypot(cx - SIZE / 2, cy - SIZE / 2);
        if (d < 16) continue;                          // 出生区留空
        const roll = rng.next();
        if (roll < 0.32) makeRuin(cx, cy, rng);
        else if (roll < 0.60) makeCabin(cx, cy, rng);
        else if (roll < 0.84) makeBunker(cx, cy, rng);
        else makeTower(cx, cy, rng);
      }
    }

    /* --- 4) 出生营地：削平一块空地 --- */
    const sx = (SIZE / 2) | 0, sy = (SIZE / 2) | 0;
    const campF = padTop(sx - 7, sy - 7, sx + 7, sy + 7);
    levelPad(sx - 7, sy - 7, sx + 7, sy + 7, campF, B.GRASS);
    rampAround(sx - 7, sy - 7, sx + 7, sy + 7, campF, 5);
    World.pois.push({ type: 'camp', x: sx + 0.5, y: sy + 0.5, r: 6 });

    derive();
    repairPoiAccess();
    return World;
  };

  /* ---------------- 植被 ---------------- */
  function plantTree(x, y, top, rng) {
    // 不与已有树冠重叠（3D 树比 1 格树占地大得多）
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      if (getB(x + dx, y + dy, top + 3) === B.LEAVES) return;
    }
    const z0 = top + 1;                      // 树干底部
    const h = 4 + rng.int(3);                // 4..6 格树干（MC 橡树原版高度）
    for (let k = 0; k < h; k++) setB(x, y, z0 + k, B.LOG);
    const cz = z0 + h - 2;                   // 树冠底部（比树干顶低 2 格）
    // 下两层 5×5（削角）
    for (let dz = 0; dz < 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) {
        if (Math.abs(dx) === 2 && Math.abs(dy) === 2 && rng.chance(0.65)) continue;
        if (getB(x + dx, y + dy, cz + dz) === B.AIR) setB(x + dx, y + dy, cz + dz, B.LEAVES);
      }
    }
    // 上两层 3×3（顶层再削角）
    for (let dz = 2; dz < 4; dz++) {
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (dz === 3 && dx !== 0 && dy !== 0 && rng.chance(0.55)) continue;
        if (getB(x + dx, y + dy, cz + dz) === B.AIR) setB(x + dx, y + dy, cz + dz, B.LEAVES);
      }
    }
  }

  function plantCactus(x, y, top, rng) {
    const h = 2 + rng.int(2);
    for (let k = 0; k < h; k++) setB(x, y, top + 1 + k, B.CACTUS);
  }

  /** 在 (x,y) 上方堆一个小石堆（3D：往上堆而不是只占一格） */
  function blobAt(x, y, z0, mat, r, rng) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy > r * r + 1) continue;
      if (rng.next() < 0.55) continue;
      const hh = 1 + ((rng.next() < 0.45) ? 1 : 0);
      for (let k = 0; k < hh; k++) {
        if (getB(x + dx, y + dy, z0 + k) === B.AIR) setB(x + dx, y + dy, z0 + k, mat);
      }
    }
  }

  /* ---------------- 建筑 ---------------- */
  /** 矩形区域的平均地形高度 → 地基站立面 z */
  function padTop(x0, y0, x1, y1) {
    let sum = 0, n = 0;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (!inXY(x, y)) continue;
      sum += baseZ[y * SIZE + x]; n++;
    }
    const avg = n ? sum / n : SEA;
    return Math.max(1, Math.round(avg) + 1);      // 站立面 = 地形顶面 + 1
  }

  /** 把矩形削平到站立面 F（地基顶面 F-1），并清空上方一切（树 / 岩石） */
  function levelPad(x0, y0, x1, y1, F, mat) {
    const top = F - 1;
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (x < 2 || y < 2 || x >= SIZE - 2 || y >= SIZE - 2) continue;
        const i = y * SIZE + x;
        for (let z = 0; z <= top; z++) {
          vox[(z * SIZE + y) * SIZE + x] = (z === 0) ? B.BEDROCK : (z === top ? mat : (z >= top - 2 ? B.DIRT : B.STONE));
        }
        for (let z = top + 1; z < HEIGHT; z++) vox[(z * SIZE + y) * SIZE + x] = B.AIR;
        baseZ[i] = top;
      }
    }
  }

  /** 把某一列重填到指定地形高度（含水面），并更新 baseZ */
  function setTop(x, y, top) {
    if (x < 2 || y < 2 || x >= SIZE - 2 || y >= SIZE - 2) return;
    if (top < 1) top = 1; else if (top > HEIGHT - 4) top = HEIGHT - 4;
    const i = y * SIZE + x;
    const bi = biome[i];
    const surface = bi === 1 ? B.SAND : bi === 2 ? B.STONE : bi === 3 ? B.SNOW : B.GRASS;
    const sub = bi === 1 ? B.SAND : bi === 2 ? B.STONE : B.DIRT;
    for (let z = 0; z <= top; z++) {
      vox[(z * SIZE + y) * SIZE + x] = (z === 0) ? B.BEDROCK : (z === top ? surface : (z >= top - 2 ? sub : B.STONE));
    }
    for (let z = top + 1; z < HEIGHT; z++) vox[(z * SIZE + y) * SIZE + x] = B.AIR;
    if (top < SEA) for (let z = top + 1; z <= SEA; z++) vox[(z * SIZE + y) * SIZE + x] = B.WATER;
    baseZ[i] = top;
  }

  /** 地基外圈边坡：逐环把地形拉到与内圈相差 ≤ 1。
   *  ⚠️ 少了这一步，削平过的地基（F）可能与外围自然地差 2~3 格，
   *     寻路判定"上不去"→ 整栋建筑连同里面的补给箱都变成不可达。
   *     每格只与"更靠内一圈的父格"比较，保证沿父链一路连通。 */
  function rampAround(x0, y0, x1, y1, F, rings) {
    const R = rings || 5;
    for (let r = 1; r <= R; r++) {
      const ix0 = x0 - r + 1, iy0 = y0 - r + 1, ix1 = x1 + r - 1, iy1 = y1 + r - 1;
      for (let y = y0 - r; y <= y1 + r; y++) {
        for (let x = x0 - r; x <= x1 + r; x++) {
          const dr = Math.max(x0 - x, x - x1, y0 - y, y - y1);
          if (dr !== r) continue;
          if (x < 2 || y < 2 || x >= SIZE - 2 || y >= SIZE - 2) continue;
          const px = x < ix0 ? ix0 : (x > ix1 ? ix1 : x);
          const py = y < iy0 ? iy0 : (y > iy1 ? iy1 : y);
          const ph = baseZ[py * SIZE + px];
          const cur = baseZ[y * SIZE + x];
          if (cur > ph + 1) setTop(x, y, ph + 1);
          else if (cur < ph - 1) setTop(x, y, ph - 1);
        }
      }
    }
  }

  /** 一圈墙：从 F 起 hgt 格高 */
  function ringWalls(x0, y0, x1, y1, F, hgt, mat) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (x !== x0 && x !== x1 && y !== y0 && y !== y1) continue;
      for (let z = F; z < F + hgt; z++) setB(x, y, z, mat);
    }
  }

  /** 开门（2 格高，1 格宽） */
  function door(x, y, F) { setB(x, y, F, B.AIR); setB(x, y, F + 1, B.AIR); }

  function makeCabin(cx, cy, rng) {
    const w = 7 + rng.int(3), h = 7 + rng.int(3);
    const x0 = cx - (w >> 1), y0 = cy - (h >> 1), x1 = x0 + w - 1, y1 = y0 + h - 1;
    const F = padTop(x0 - 2, y0 - 2, x1 + 2, y1 + 2);
    levelPad(x0 - 2, y0 - 2, x1 + 2, y1 + 2, F, B.GRASS);      // 含 2 格护坡
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      if (x > x0 && x < x1 && y > y0 && y < y1) setB(x, y, F - 1, B.PLANK);   // 室内地板
    }
    ringWalls(x0, y0, x1, y1, F, 3, B.PLANK);
    // 对开两扇门（不管从哪个方向来都能进）
    door(cx, y1, F); door(cx, y0, F);
    // 窗（玻璃嵌在墙里）
    for (let x = x0 + 2; x < x1 - 1; x += 3) { setB(x, y0, F + 1, B.GLASS); setB(x, y1, F + 1, B.GLASS); }
    for (let y = y0 + 2; y < y1 - 1; y += 3) { setB(x0, y, F + 1, B.GLASS); setB(x1, y, F + 1, B.GLASS); }
    // 屋顶（实心木板）+ 两块天窗
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setB(x, y, F + 3, B.PLANK);
    setB(cx, cy, F + 3, B.GLASS); setB(cx + 1, cy, F + 3, B.GLASS);
    rampAround(x0 - 2, y0 - 2, x1 + 2, y1 + 2, F, 5);
    World.pois.push({ type: 'cabin', x: cx + 0.5, y: cy + 0.5, r: Math.max(w, h) / 2 + 1 });
  }

  function makeRuin(cx, cy, rng) {
    const w = 6 + rng.int(4), h = 6 + rng.int(4);
    const x0 = cx - (w >> 1), y0 = cy - (h >> 1), x1 = x0 + w - 1, y1 = y0 + h - 1;
    const F = padTop(x0 - 2, y0 - 2, x1 + 2, y1 + 2);
    levelPad(x0 - 2, y0 - 2, x1 + 2, y1 + 2, F, B.DIRT);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setB(x, y, F - 1, B.COBBLE);
    ringWalls(x0, y0, x1, y1, F, 3, B.MOSSY);
    door(cx, y1, F); door(cx, y0, F); door(x0, cy, F); door(x1, cy, F);
    // 残破：随机削掉墙段（高度不一 → 可以爬上去）
    for (let k = 0; k < 6 + rng.int(6); k++) {
      const side = rng.int(4);
      let x, y;
      if (side === 0) { x = x0 + rng.int(w); y = y0; }
      else if (side === 1) { x = x0 + rng.int(w); y = y1; }
      else if (side === 2) { x = x0; y = y0 + rng.int(h); }
      else { x = x1; y = y0 + rng.int(h); }
      const cut = 1 + rng.int(3);                        // 削 1~3 格高
      for (let z = F; z < F + cut; z++) setB(x, y, z, B.AIR);
    }
    // 室内残柱
    for (let k = 0; k < 2 + rng.int(3); k++) {
      const x = x0 + 1 + rng.int(Math.max(1, w - 2)), y = y0 + 1 + rng.int(Math.max(1, h - 2));
      for (let z = F; z < F + 2 + rng.int(2); z++) setB(x, y, z, B.COBBLE);
    }
    rampAround(x0 - 2, y0 - 2, x1 + 2, y1 + 2, F, 5);
    World.pois.push({ type: 'ruin', x: cx + 0.5, y: cy + 0.5, r: Math.max(w, h) / 2 + 1 });
  }

  function makeBunker(cx, cy, rng) {
    const x0 = cx - 3, y0 = cy - 3, x1 = cx + 3, y1 = cy + 3;
    const F = padTop(x0 - 2, y0 - 2, x1 + 2, y1 + 2);
    levelPad(x0 - 2, y0 - 2, x1 + 2, y1 + 2, F, B.STONE);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setB(x, y, F - 1, B.STONE);
    ringWalls(x0, y0, x1, y1, F, 4, B.COBBLE);
    door(cx, y1, F); door(cx - 1, y1, F); door(cx, y0, F); door(cx - 1, y0, F);
    // 屋顶（实心圆石）+ 铁质天窗
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) setB(x, y, F + 4, B.COBBLE);
    setB(cx, cy - 1, F + 4, B.GLASS); setB(cx, cy + 1, F + 4, B.GLASS);
    rampAround(x0 - 2, y0 - 2, x1 + 2, y1 + 2, F, 5);
    World.pois.push({ type: 'bunker', x: cx + 0.5, y: cy + 0.5, r: 5 });
  }

  /** 塔：中空砖砌圆筒 + 可走的墙顶环道 + 外侧阶梯（真 3D 垂直动线）
   *
   *  ⚠️ 阶梯的方向不能写反：贴着塔的那一列必须是**最高**的一级，
   *     否则从地面逐级爬到顶后与墙顶差 6 格，寻路判定为不可达 ——
   *     塔顶就永远上不去（第一版就是这么写错的）。
   *  阶梯占 cy-1 / cy-2 两行，底层入口占 cy / cy+1，互不干扰。 */
  function makeTower(cx, cy, rng) {
    const r = 3 + rng.int(2);
    const H = 6;                                   // 墙高（F .. F+H-1），墙顶面 F+H
    const F = padTop(cx - r - 2, cy - 2, cx + r + H + 2, cy + 3);
    levelPad(cx - r - 2, cy - 2, cx + r + H + 2, cy + 3, F, B.STONE);

    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > r) continue;
      const x = cx + dx, y = cy + dy;
      if (x < 2 || y < 2 || x >= SIZE - 2 || y >= SIZE - 2) continue;
      if (d > r - 1.3) {
        for (let z = F; z < F + H; z++) setB(x, y, z, B.BRICK);
      } else {
        for (let z = F; z < F + H; z++) setB(x, y, z, B.AIR);
        setB(x, y, F - 1, B.STONE);
      }
    }
    // 底层入口（+x 侧，2 格高 2 格宽）
    setB(cx + r, cy, F, B.AIR); setB(cx + r, cy, F + 1, B.AIR);
    setB(cx + r, cy + 1, F, B.AIR); setB(cx + r, cy + 1, F + 1, B.AIR);

    /* 外侧阶梯：k=1 贴着塔壁（最高 F+H），k=H 最外（F+1）。
       ⚠️ 起点不能用 cx + r + 1：圆筒在那一行的最外侧格是
       cx + floor(sqrt(r² - dy²))，比 cx+r 靠内 1~2 格。用 cx+r+1 会让
       阶梯与墙顶之间隔着一段平地，高差 6 格 → 塔顶永远上不去。 */
    for (const yy of [cy - 1, cy - 2]) {
      const dy = yy - cy;
      const dxm = Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy)));
      for (let k = 1; k <= H; k++) {
        const x = cx + dxm + k;
        if (x >= SIZE - 2) break;
        const gz = F + H - k;                      // 地基顶面 → 站立面 gz+1
        for (let z = 0; z <= gz; z++) {
          vox[(z * SIZE + yy) * SIZE + x] = (z === 0) ? B.BEDROCK : (z === gz ? B.COBBLE : B.STONE);
        }
        for (let z = gz + 1; z < HEIGHT; z++) vox[(z * SIZE + yy) * SIZE + x] = B.AIR;
        baseZ[yy * SIZE + x] = gz;
      }
    }
    rampAround(cx - r - 2, cy - 2, cx + r + H + 2, cy + 3, F, 5);
    World.pois.push({ type: 'tower', x: cx + 0.5, y: cy + 0.5, r: r + 1 });
  }

  /* ---------------- 派生表 ---------------- */
  const FLOORCAT = new Uint8Array(32);
  FLOORCAT[B.GRASS] = 0; FLOORCAT[B.DIRT] = 1; FLOORCAT[B.SAND] = 2;
  FLOORCAT[B.STONE] = 3; FLOORCAT[B.COBBLE] = 3; FLOORCAT[B.MOSSY] = 3;
  FLOORCAT[B.SANDSTONE] = 2; FLOORCAT[B.PLANK] = 4; FLOORCAT[B.WATER] = 5;
  FLOORCAT[B.SNOW] = 6; FLOORCAT[B.BEDROCK] = 3; FLOORCAT[B.GRAVEL] = 3;

  function derive() {
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const i = y * SIZE + x;
        // surfZ：自下而上第一个「脚下实心 + 自身与头顶净空」
        let s = 0;
        for (let z = 1; z < HEIGHT - 1; z++) {
          if (isSolid(x, y, z - 1) && !isSolid(x, y, z) && !isSolid(x, y, z + 1)) { s = z; break; }
        }
        surfZ[i] = s;
        // wall：地面层有遮挡物（树 / 墙 / 岩石）→ 挡视线
        wall[i] = (s === 0 || s > baseZ[i] + 1) ? 1 : 0;
        const gt = s > 0 ? getB(x, y, s - 1) : getB(x, y, Math.min(baseZ[i], HEIGHT - 1));
        floor[i] = FLOORCAT[gt] || 0;
        if (s > 0 && getB(x, y, s) === B.WATER) floor[i] = 5;      // 站在水里
      }
    }
  }
  World.derive = derive;

  /* ---------------- 查询 ---------------- */
  World.tileAt = function (tx, ty) {
    if (!inXY(tx, ty)) return 1;
    return wall[ty * SIZE + tx] ? 1 : 0;
  };
  World.isWallTile = function (tx, ty) {
    if (!inXY(tx, ty)) return true;
    return wall[ty * SIZE + tx] !== 0;
  };
  World.isWall = function (x, y) { return World.isWallTile(Math.floor(x), Math.floor(y)); };
  World.floorAt = function (x, y) {
    const tx = Math.floor(x), ty = Math.floor(y);
    if (!inXY(tx, ty)) return 0;
    return floor[ty * SIZE + tx];
  };
  World.inWater = function (x, y) { return World.floorAt(x, y) === 5; };
  World.inWaterAt = function (x, y, z) {
    return getB(Math.floor(x), Math.floor(y), Math.floor(z)) === B.WATER;
  };
  /** 该格的可站立面 z（浮点坐标） */
  World.surfZAt = function (x, y) {
    const tx = Math.floor(x), ty = Math.floor(y);
    if (!inXY(tx, ty)) return 1;
    const s = surfZ[ty * SIZE + tx];
    return s ? s : 1;
  };
  /** 寻路用：该列能否站人 */
  function passable(tx, ty) {
    if (tx < 2 || ty < 2 || tx >= SIZE - 2 || ty >= SIZE - 2) return false;
    const s = surfZ[ty * SIZE + tx];
    return s > 0 && s < HEIGHT - 2;
  }
  World.passable = passable;
  /** 寻路用：从 A 走到 B 的高差是否可跨（上 1 格 / 下 3 格） */
  function stepOK(ax, ay, bx, by) {
    const sa = surfZ[ay * SIZE + ax], sb = surfZ[by * SIZE + bx];
    if (!sa || !sb) return false;
    return (sb - sa) <= 1 && (sa - sb) <= 3;
  }
  World.stepOK = stepOK;

  /* ---------------- 3D 碰撞 ---------------- */
  /** 格子 (tx,ty) 在 [z0, z0+h) 高度带内是否有实心体素 */
  World.columnBlocks = function (tx, ty, z0, h) {
    if (!inXY(tx, ty)) return true;
    const a = Math.floor(z0 + 1e-4);
    const b = Math.floor(z0 + h - 1e-4);
    for (let z = a; z <= b; z++) {
      if (z < 0) return true;
      if (z >= HEIGHT) break;
      if (SOLID[vox[(z * SIZE + ty) * SIZE + tx]]) return true;
    }
    return false;
  };

  /** 圆 (x,y,r) 在 [z0, z0+h) 高度带内是否撞到方块。
   *  z0/h 省略时退化为"站在地表"，兼容旧的 2D 调用。 */
  World.circleBlocked = function (x, y, r, z0, h) {
    if (z0 === undefined || z0 === null) z0 = World.surfZAt(x, y);
    if (h === undefined || h === null) h = 1.8;
    const minX = Math.floor(x - r), maxX = Math.floor(x + r);
    const minY = Math.floor(y - r), maxY = Math.floor(y + r);
    const r2 = r * r;
    for (let ty = minY; ty <= maxY; ty++) {
      for (let tx = minX; tx <= maxX; tx++) {
        if (!World.columnBlocks(tx, ty, z0, h)) continue;
        const cx = x < tx ? tx : (x > tx + 1 ? tx + 1 : x);
        const cy = y < ty ? ty : (y > ty + 1 ? ty + 1 : y);
        const dx = x - cx, dy = y - cy;
        if (dx * dx + dy * dy < r2) return true;
      }
    }
    return false;
  };

  /** 若圆已陷进方块，沿轴推出到最近自由位 */
  World.unstickCircle = function (o, r) {
    const z = (o.z !== undefined && o.z !== null) ? o.z : World.surfZAt(o.x, o.y);
    const h = o.height || 1.8;
    if (!World.circleBlocked(o.x, o.y, r, z, h)) return false;
    const step = 0.08;
    for (let i = 1; i <= 12; i++) {
      const cand = [
        [o.x + step * i, o.y], [o.x - step * i, o.y],
        [o.x, o.y + step * i], [o.x, o.y - step * i],
        [o.x + step * i, o.y + step * i], [o.x - step * i, o.y - step * i],
        [o.x + step * i, o.y - step * i], [o.x - step * i, o.y + step * i]
      ];
      for (const c of cand) {
        if (!World.circleBlocked(c[0], c[1], r, z, h)) { o.x = c[0]; o.y = c[1]; return true; }
      }
    }
    return false;
  };

  function entityZ(o) { return (o.z !== undefined && o.z !== null) ? o.z : World.surfZAt(o.x, o.y); }
  function entityH(o) { return o.height || (o.downed ? 0.9 : 1.8); }

  /** 在指定高度带 [z, z+h) 下能否站住 */
  function canStand(o, x, y, r, z, h) { return !World.circleBlocked(x, y, r, z, h); }

  /**
   * 水平移动（轴分离滑动 + 对角补偿 + 自动上台阶）。
   * 会自动读写 o.z —— 旧调用点不需要改。
   */
  World.moveCircle = function (o, dx, dy, r) {
    const r0 = r || o.radius || 0.26;
    const h = entityH(o);
    let z = entityZ(o);
    const maxStep = Math.max(r0 * 0.9, 0.12);
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-8) { o.z = z; return; }
    const steps = Math.max(1, Math.ceil(dist / maxStep));
    const sx = dx / steps, sy = dy / steps;

    for (let s = 0; s < steps; s++) {
      let moved = false;
      const ox = o.x, oy = o.y, oz = z;
      /* ⚠️ 两轴都要先判断自己的分量是否为 0。曾经写成无条件执行，
         于是纯水平移动时第二句等价于「在**当前位置**再测一遍」——当前位置
         当然是空的 → moved 恒为 true → 下面的 `if (!moved)` 自动上台阶
         永远进不去，玩家对着 1 格台阶只会贴住原地。（只有单轴有位移时才会暴露，
         所以斜着走从来测不出来。） */
      if (sx !== 0 && canStand(o, o.x + sx, o.y, r0, z, h)) { o.x += sx; moved = true; }
      if (sy !== 0 && canStand(o, o.x, o.y + sy, r0, z, h)) { o.y += sy; moved = true; }
      if (!moved) {
        // 自动上台阶（仅在贴地时）：尝试抬到 floor(z)+1
        const zUp = Math.floor(z + 1e-4) + 1;
        if (o.onGround && zUp - z <= STEP_UP + 1e-3 && canStand(o, o.x + sx, o.y + sy, r0, zUp, h)) {
          o.x += sx; o.y += sy; z = zUp; moved = true;
        }
      }
      if (!moved && (sx !== 0 && sy !== 0)) {
        if (canStand(o, o.x + sx, o.y + sy, r0, z, h)) { o.x += sx; o.y += sy; moved = true; }
      }
      if (!moved) { o.x = ox; o.y = oy; z = oz; break; }
      // 下坡贴合：避免每帧"走一步掉一格"的弹跳
      if (o.onGround) {
        const g = World.supportZ(o.x, o.y, r0, z);
        if (g > 0 && g < z && z - g <= STEP_DOWN) z = g;
        else if (g > 0 && g > z && g - z <= STEP_UP) z = g;
      }
    }
    o.z = z;
    World.unstickCircle(o, r0);
  };

  /** 圆覆盖范围内 ≤ z 的最高可站立面 */
  World.supportZ = function (x, y, r, z) {
    const minX = Math.floor(x - r), maxX = Math.floor(x + r);
    const minY = Math.floor(y - r), maxY = Math.floor(y + r);
    let best = 0;
    for (let ty = minY; ty <= maxY; ty++) {
      for (let tx = minX; tx <= maxX; tx++) {
        const s = supportUnder(tx, ty, z);
        if (s > best) best = s;
      }
    }
    return best;
  };

  function supportUnder(tx, ty, z0) {
    if (!inXY(tx, ty)) return 0;
    let z = Math.floor(z0 + 1e-4);
    if (z > HEIGHT - 2) z = HEIGHT - 2;
    for (; z >= 1; z--) {
      if (isSolid(tx, ty, z - 1) && !isSolid(tx, ty, z) && !isSolid(tx, ty, z + 1)) return z;
    }
    return 1;
  }

  /** 垂直物理：重力 / 落水 / 落地上浮。返回本 tick 的坠落高度（0 = 没摔） */
  World.tickZ = function (o, dt) {
    if (o.z === undefined || o.z === null) o.z = World.surfZAt(o.x, o.y);
    if (o.vz === undefined) o.vz = 0;
    const h = entityH(o);
    const r = o.radius || 0.26;
    const wet = World.inWaterAt(o.x, o.y, o.z + 0.35);
    o.inWater = wet;

    if (wet) {
      o.vz -= 7 * dt;
      if (o.vz < -2.4) o.vz = -2.4;
      // 头没入水中 → 上浮（游泳）
      if (World.inWaterAt(o.x, o.y, o.z + h * 0.85)) {
        o.vz += 26 * dt;
        if (o.vz > 3.0) o.vz = 3.0;
      }
    } else {
      o.vz -= GRAVITY * dt;
      if (o.vz < -40) o.vz = -40;
    }

    let nz = o.z + o.vz * dt;
    if (o.vz > 0) {
      if (World.circleBlocked(o.x, o.y, r, nz, h)) { o.vz = 0; nz = o.z; }
      o.z = nz;
      o.onGround = false;
      if (o.fallFrom === undefined || o.z > o.fallFrom) o.fallFrom = o.z;
      return 0;
    }
    const g = World.supportZ(o.x, o.y, r, o.z);
    if (g > 0 && nz <= g) {
      nz = g; o.vz = 0;
      const from = (o.fallFrom === undefined) ? g : o.fallFrom;
      o.fallFrom = g;
      o.onGround = true;
      o.z = nz;
      return Math.max(0, from - g);
    }
    o.z = nz;
    o.onGround = false;
    if (o.fallFrom === undefined || o.z > o.fallFrom) o.fallFrom = o.z;
    return 0;
  };

  World.jump = function (o) {
    if (o.inWater) { o.vz = Math.max(o.vz || 0, 4.2); return true; }
    if (!o.onGround) return false;
    o.vz = JUMP_V;
    o.onGround = false;
    o.fallFrom = o.z;
    return true;
  };
  World.FALL_SAFE = FALL_SAFE;

  /* ---------------- 3D 视线 / 弹道 ----------------
     DDA 体素遍历。返回命中距离（没打到墙则返回 maxD）。 */
  World.rayVoxel = function (px, py, pz, dx, dy, dz, maxD) {
    let mapX = Math.floor(px), mapY = Math.floor(py), mapZ = Math.floor(pz);
    const ddx = dx === 0 ? Infinity : Math.abs(1 / dx);
    const ddy = dy === 0 ? Infinity : Math.abs(1 / dy);
    const ddz = dz === 0 ? Infinity : Math.abs(1 / dz);
    let stepX, stepY, stepZ, sdx, sdy, sdz;
    if (dx < 0) { stepX = -1; sdx = (px - mapX) * ddx; } else { stepX = 1; sdx = (mapX + 1 - px) * ddx; }
    if (dy < 0) { stepY = -1; sdy = (py - mapY) * ddy; } else { stepY = 1; sdy = (mapY + 1 - py) * ddy; }
    if (dz < 0) { stepZ = -1; sdz = (pz - mapZ) * ddz; } else { stepZ = 1; sdz = (mapZ + 1 - pz) * ddz; }
    let d = 0, guard = 0;
    while (guard++ < 1024) {
      if (sdx < sdy && sdx < sdz) { d = sdx; sdx += ddx; mapX += stepX; }
      else if (sdy < sdz) { d = sdy; sdy += ddy; mapY += stepY; }
      else { d = sdz; sdz += ddz; mapZ += stepZ; }
      if (d > maxD) return maxD;
      if (isSolid(mapX, mapY, mapZ)) return d;
    }
    return maxD;
  };

  /** 2D 视线（AI 用）：沿用 wall 表，避免每帧 3D DDA 的开销 */
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
     改成基于 surfZ 的高差判定：
       上 1 格可走（自动上台阶） / 下 3 格可走（跳落）
     → 阶梯、斜坡、岩石都能被敌人正常利用。 */
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
      if (passable(sx, sy)) put(sx - f.ox, sy - f.oy, 0);
      else {
        let done = false;
        for (const dd of DIRS8) {
          if (passable(sx + dd[0], sy + dd[1])) { put(sx + dd[0] - f.ox, sy + dd[1] - f.oy, 0); done = true; break; }
        }
        if (!done) continue;
      }
      while (head < tail) {
        const c = f.q[head++];
        const lx = c % FW, ly = (c / FW) | 0;
        const nd = f.dist[c] + 1;
        const ax = lx + f.ox, ay = ly + f.oy;
        for (const dd of DIRS8) {
          const nx = lx + dd[0], ny = ly + dd[1];
          if (nx < 0 || ny < 0 || nx >= FW || ny >= FW) continue;
          const k = ny * FW + nx;
          if (f.dist[k] !== -1) continue;
          const wx = nx + f.ox, wy = ny + f.oy;
          if (!passable(wx, wy)) continue;
          if (!stepOK(ax, ay, wx, wy)) continue;
          if (dd[0] && dd[1] && (!passable(wx, wy - dd[1]) || !passable(wx - dd[0], wy))) continue;
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
    const ax = Math.floor(x), ay = Math.floor(y);
    for (const dd of DIRS8) {
      const nx = lx + dd[0], ny = ly + dd[1];
      if (nx < 0 || ny < 0 || nx >= FW || ny >= FW) continue;
      const d = f.dist[ny * FW + nx];
      if (d < 0) continue;
      const wx = nx + f.ox, wy = ny + f.oy;
      if (!stepOK(ax, ay, wx, wy)) continue;
      if (dd[0] && dd[1] && (!passable(wx, wy - dd[1]) || !passable(wx - dd[0], wy))) continue;
      if (d < bestD) { bestD = d; bx = nx; by = ny; }
    }
    if (bx < 0) return null;
    const tx = bx + f.ox + 0.5, ty = by + f.oy + 0.5;
    const vx = tx - x, vy = ty - y;
    const l = Math.hypot(vx, vy);
    if (l < 1e-4) return null;
    return { x: vx / l, y: vy / l };
  };

  World.flowReachable = function (i, x, y) {
    const f = fields[i | 0];
    if (!f || !f.ready) return false;
    const lx = Math.floor(x) - f.ox, ly = Math.floor(y) - f.oy;
    if (lx < 0 || ly < 0 || lx >= FW || ly >= FW) return false;
    return f.dist[ly * FW + lx] >= 0;
  };

  /* ---------------- 随机取点 ---------------- */
  World.randomSpawn = function (rng, ax, ay, minDist, maxDist) {
    const maxD = maxDist || (minDist + 18);
    for (let i = 0; i < 40; i++) {
      const a = rng.next() * Math.PI * 2;
      const d = minDist + rng.next() * (maxD - minDist);
      const x = ax + Math.cos(a) * d, y = ay + Math.sin(a) * d;
      if (x < 3 || y < 3 || x >= SIZE - 3 || y >= SIZE - 3) continue;
      const tx = x | 0, ty = y | 0;
      if (!passable(tx, ty)) continue;
      if (floor[ty * SIZE + tx] === 5) continue;
      const z = surfZ[ty * SIZE + tx];
      // 光是"中心格可站"不够：半径 0.3~0.42 的怪会压到隔壁的墙上
      if (World.circleBlocked(x, y, 0.42, z, 1.9)) continue;
      return { x: x, y: y, z: z };
    }
    return { x: ax + 2, y: ay + 2, z: World.surfZAt(ax + 2, ay + 2) };
  };

  World.randomFloor = function (rng, ax, ay, maxDist) {
    for (let i = 0; i < 40; i++) {
      const a = rng.next() * Math.PI * 2;
      const d = rng.next() * (maxDist || 20);
      const x = ax + Math.cos(a) * d, y = ay + Math.sin(a) * d;
      if (x < 3 || y < 3 || x >= SIZE - 3 || y >= SIZE - 3) continue;
      const tx = x | 0, ty = y | 0;
      if (!passable(tx, ty)) continue;
      return { x: x, y: y, z: surfZ[ty * SIZE + tx] };
    }
    return { x: ax + 1, y: ay + 1, z: World.surfZAt(ax + 1, ay + 1) };
  };

  /* ---------------- POI 可达性兜底 ----------------
     真 3D 之后建筑都有门，绝大多数 POI 本来就可达；
     这里只做"万一被地形/树封死"时的开廊（直接挖体素，不是改 wall 表）。 */
  function carveColumn(x, y) {
    if (!inXY(x, y)) return;
    const i = y * SIZE + x;
    const top = Math.min(baseZ[i], HEIGHT - 4);
    for (let z = top + 1; z < top + 4; z++) setB(x, y, z, B.AIR);
  }

  function repairPoiAccess() {
    const sx = (World.spawn.x) | 0, sy = (World.spawn.y) | 0;
    const seen = new Uint8Array(N2);
    const q = [sy * SIZE + sx];
    seen[q[0]] = 1;
    for (let h = 0; h < q.length; h++) {
      const cur = q[h];
      const cx = cur % SIZE, cy = (cur / SIZE) | 0;
      for (const dd of DIRS8) {
        const nx = cx + dd[0], ny = cy + dd[1];
        if (nx < 2 || ny < 2 || nx >= SIZE - 2 || ny >= SIZE - 2) continue;
        const ni = ny * SIZE + nx;
        if (seen[ni] || !passable(nx, ny)) continue;
        if (!stepOK(cx, cy, nx, ny)) continue;
        seen[ni] = 1;
        q.push(ni);
      }
    }
    let carved = false;
    for (const poi of World.pois) {
      const px = poi.x | 0, py = poi.y | 0;
      if (seen[py * SIZE + px]) continue;
      let x = px, y = py, guard = 0;
      while ((x !== sx || y !== sy) && guard++ < SIZE * 2) {
        carveColumn(x, y); carved = true;
        if (x < sx) x++; else if (x > sx) x--;
        else if (y < sy) y++; else if (y > sy) y--;
        if (x >= 2 && y >= 2 && x < SIZE - 2 && y < SIZE - 2) {
          carveColumn(x, y); carveColumn(x + 1, y); carveColumn(x, y + 1);
        }
      }
    }
    // 挖过之后派生表会变，必须重算（否则挖开的通路在寻路里仍然是墙）
    if (carved) derive();
  }
})();
