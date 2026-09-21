/* ============================================================
   art.js — 明亮卡通 · 方块风（参考 Minecraft）
   所有纹理 16x16 逻辑像素 → 放大 4x 成 64x64，保留硬边像素颗粒感
   ============================================================ */
(function () {
  const ROOT = (typeof window !== 'undefined') ? window : globalThis;
  const PP = (ROOT.PP = ROOT.PP || {});
  const Art = (PP.Art = {});

  const rgb = (Art.rgb = function (r, g, b) {
    return ((255 << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0;
  });
  function shadeOf(c, k) {
    let r = c & 255, g = (c >> 8) & 255, b = (c >> 16) & 255;
    r = Math.max(0, Math.min(255, Math.round(r * k)));
    g = Math.max(0, Math.min(255, Math.round(g * k)));
    b = Math.max(0, Math.min(255, Math.round(b * k)));
    return rgb(r, g, b);
  }
  Art.shadeOf = shadeOf;

  class Tex {
    constructor(w, h) { this.w = w; this.h = h; this.data = new Uint32Array(w * h); }
    px(x, y, c) {
      x |= 0; y |= 0;
      if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
      this.data[y * this.w + x] = c >>> 0;
    }
    rect(x, y, w, h, c) {
      for (let j = 0; j < h; j++) {
        const yy = y + j; if (yy < 0 || yy >= this.h) continue;
        const row = yy * this.w;
        for (let i = 0; i < w; i++) {
          const xx = x + i; if (xx < 0 || xx >= this.w) continue;
          this.data[row + xx] = c >>> 0;
        }
      }
      return this;
    }
  }
  Art.Tex = Tex;

  /* ---- 16x16 逻辑像素方块纹理生成器 ---- */
  function block16(seed, fn) {
    const t = new Tex(64, 64);
    const rng = PP.Core.mulberry32(seed);
    for (let py = 0; py < 16; py++) {
      for (let px = 0; px < 16; px++) {
        const c = fn(px, py, rng);
        if (c === undefined || c === null) continue;
        t.rect(px * 4, py * 4, 4, 4, c >>> 0);
      }
    }
    return t;
  }
  // 每个像素做 ±亮度抖动，得到 MC 那种"脏脏的手绘方块"质感
  function jit(c, rng, amt) {
    return shadeOf(c, 1 + (rng() - 0.5) * (amt === undefined ? 0.16 : amt));
  }

  /* ---------------- 方块调色板 ---------------- */
  const C = {
    grass: rgb(122, 200, 76), grassDark: rgb(96, 168, 58),
    dirt: rgb(150, 108, 66), dirtDark: rgb(122, 86, 52),
    stone: rgb(170, 170, 170), stoneDark: rgb(140, 140, 140),
    cobble: rgb(154, 154, 154),
    plank: rgb(206, 164, 96), plankDark: rgb(170, 130, 70),
    log: rgb(160, 122, 66), logDark: rgb(122, 90, 48),
    sand: rgb(238, 226, 170), sandDark: rgb(214, 200, 146),
    sandst: rgb(232, 218, 150), sandstDark: rgb(206, 190, 122),
    brick: rgb(196, 92, 70), brickMortar: rgb(226, 214, 200),
    leaves: rgb(88, 178, 66), leavesDark: rgb(60, 132, 44),
    cactus: rgb(96, 168, 64), cactusDark: rgb(70, 130, 46),
    water: rgb(64, 148, 220), waterLight: rgb(120, 190, 246),
    bedrock: rgb(86, 86, 92), bedrockDark: rgb(56, 56, 62),
    redstone: rgb(226, 62, 46), lapis: rgb(60, 110, 220),
    snow: rgb(240, 246, 252),
    outline: rgb(34, 30, 28)
  };

  /* ---------------- 纹理 ---------------- */
  function makeTextures() {
    const T = {};
    T.grassTop = block16(101, (x, y, r) => {
      let c = (x + y) % 3 === 0 ? C.grassDark : C.grass;
      return jit(c, r, 0.18);
    });
    T.grassSide = block16(102, (x, y, r) => {
      if (y === 0) return jit(C.grass, r, 0.14);
      const edge = y <= 2 + (r() < 0.5 ? 0 : 1) || (y === 3 && r() < 0.45);
      if (edge) return jit(C.grass, r, 0.18);
      return jit((x * 7 + y * 3) % 5 === 0 ? C.dirtDark : C.dirt, r, 0.16);
    });
    T.dirt = block16(103, (x, y, r) => jit((x * 5 + y * 3) % 4 === 0 ? C.dirtDark : C.dirt, r, 0.18));
    T.stone = block16(104, (x, y, r) => jit((x * 3 + y * 7) % 6 === 0 ? C.stoneDark : C.stone, r, 0.12));
    T.cobble = block16(105, (x, y, r) => {
      const k = ((x * 13 + y * 7) % 11);
      return jit(k < 2 ? C.stoneDark : (k > 8 ? C.stone : C.cobble), r, 0.14);
    });
    T.plank = block16(106, (x, y, r) => {
      if (y % 4 === 3) return jit(C.plankDark, r, 0.1);
      if (x % 8 === 0) return jit(C.plankDark, r, 0.08);
      return jit(C.plank, r, 0.12);
    });
    T.log = block16(107, (x, y, r) => {
      if (x === 0 || x === 15) return jit(C.logDark, r, 0.1);
      if ((x * 5 + y * 3) % 7 === 0) return jit(C.logDark, r, 0.12);
      return jit(C.log, r, 0.12);
    });
    T.sand = block16(108, (x, y, r) => jit((x + y) % 4 === 0 ? C.sandDark : C.sand, r, 0.1));
    T.sandstone = block16(109, (x, y, r) => {
      if (y === 0 || y === 15) return jit(C.sandstDark, r, 0.08);
      return jit(C.sandst, r, 0.1);
    });
    T.brick = block16(110, (x, y, r) => {
      const row = (y / 4) | 0;
      const off = (row % 2) * 4;
      if (y % 4 === 3 || (x + off) % 8 === 7) return jit(C.brickMortar, r, 0.06);
      return jit(C.brick, r, 0.16);
    });
    T.leaves = block16(111, (x, y, r) => {
      const k = ((x * 7 + y * 11) % 9);
      if (k === 0) return jit(C.leavesDark, r, 0.2);
      if (k < 3) return jit(C.leavesDark, r, 0.1);
      return jit(C.leaves, r, 0.22);
    });
    T.cactus = block16(112, (x, y, r) => {
      if (x === 0 || x === 15) return jit(C.cactusDark, r, 0.08);
      if (y % 5 === 0 && (x === 3 || x === 12)) return jit(C.snow, r, 0.05);
      return jit((x * 3 + y) % 6 === 0 ? C.cactusDark : C.cactus, r, 0.12);
    });
    T.water = block16(113, (x, y, r) => {
      const w = Math.sin((x + y * 0.6) * 0.9) + Math.sin(x * 0.4) * 0.5;
      if (w > 1.1) return jit(C.waterLight, r, 0.08);
      return jit(C.water, r, 0.12);
    });
    T.bedrock = block16(114, (x, y, r) => {
      const k = ((x * 17 + y * 13) % 7);
      return jit(k < 3 ? C.bedrockDark : C.bedrock, r, 0.16);
    });
    T.redstoneOre = block16(115, (x, y, r) => {
      const gem = (x === 3 && y === 4) || (x === 4 && y === 4) || (x === 3 && y === 5) ||
                  (x === 11 && y === 10) || (x === 12 && y === 10) || (x === 11 && y === 11);
      if (gem) return jit(C.redstone, r, 0.1);
      return jit((x * 3 + y * 7) % 6 === 0 ? C.stoneDark : C.stone, r, 0.12);
    });
    T.lapisOre = block16(116, (x, y, r) => {
      const gem = (x >= 4 && x <= 6 && y >= 9 && y <= 11) || (x >= 10 && x <= 11 && y >= 3 && y <= 4);
      if (gem) return jit(C.lapis, r, 0.1);
      return jit((x * 3 + y * 7) % 6 === 0 ? C.stoneDark : C.stone, r, 0.12);
    });
    T.snow = block16(117, (x, y, r) => jit(C.snow, r, 0.06));

    function darken(src, k) {
      const n = new Tex(src.w, src.h);
      for (let i = 0; i < src.data.length; i++) n.data[i] = shadeOf(src.data[i], k);
      return n;
    }
    T.plankCeil = darken(T.plank, 0.52);
    return T;
  }

  /* ---------------- 精灵 ---------------- */
  function bake(rows, pal, w, h) {
    const t = new Tex(w, h);
    for (let y = 0; y < h; y++) {
      const row = ((rows[y] || '') + '................................').slice(0, w);
      for (let x = 0; x < w; x++) {
        const c = pal[row[x]];
        if (c === undefined) continue;
        t.data[y * w + x] = c >>> 0;
      }
    }
    return t;
  }

  const HUM_WALK = [
    '................',
    '................',
    '...oooooooooo...',
    '...ogllllllgo...',
    '...oggggggggo...',
    '...ogwkggwkgo...',
    '...oggggggggo...',
    '...ogggmmgggo...',
    '...oooooooooo...',
    '..obbbbbbbbbbo..',
    '..obbbbbbbbbbo..',
    '.oggbbbbbbboggo.',
    '.oggbbbbbbboggo.',
    '..obbbbbbbbbbo..',
    '...oppppppppo...',
    '...oppp..pppo...',
    '...oppp..pppo...',
    '...oooo..oooo...',
    '................',
    '................'
  ];

  const HUM_ATK = [
    '................',
    '................',
    '...oooooooooo...',
    '...ogllllllgo...',
    '...oggggggggo...',
    '...ogwkggwkgo...',
    '...oggggggggo...',
    '...ogmmmmmmgo...',
    '...oooooooooo...',
    '..obbbbbbbbbbo..',
    '.oobbbbbbbbbboo.',
    'oggobllllllboggo',
    'oggobbbbbbbboggo',
    '.oobbbbbbbbbboo.',
    '..oppppppppppo..',
    '...oppp..pppo...',
    '...oppp..pppo...',
    '...oooo..oooo...',
    '................',
    '................'
  ];

  const HUM_HURT = [
    '................',
    '................',
    '...oooooooooo...',
    '...ogllllllgo...',
    '...oggggggggo...',
    '...ogmmggmmgo...',
    '...oggggggggo...',
    '...ogmmmmmmgo...',
    '...oooooooooo...',
    '..obbbbbbbbbbo..',
    '..obbbbbbbbbbo..',
    '.oggbbbbbbboggo.',
    '.oggbbbbbbboggo.',
    '..obbbbbbbbbbo..',
    '...oppppppppo...',
    '...oppp..pppo...',
    '...oppp..pppo...',
    '...oooo..oooo...',
    '................',
    '................'
  ];

  const SKEL_WALK = [
    '................',
    '................',
    '...oooooooooo...',
    '...oggllllggo...',
    '...oggllllggo...',
    '...okkkggkkkgo..',
    '...oggggggggo...',
    '...ogkwwkwwgo...',
    '...oooooooooo...',
    '..obbbbbbbbbbo..',
    '..obdbdbdbdbdo..',
    '.oggbdbdbdbdggo.',
    '.oggbbbbbbboggo.',
    '..obdbdbdbdbdo..',
    '...oppppppppo...',
    '...opd..oppo....',
    '...opd..oppo....',
    '...ooo..oooo....',
    '................',
    '................'
  ];

  const SKEL_ATK = [
    '................',
    '................',
    '...oooooooooo...',
    '...oggllllggo...',
    '...oggllllggo...',
    '...okkkggkkkgo..',
    '...oggggggggo...',
    '...ogkwwkwwgo...',
    '...oooooooooo...',
    '..obbbbbbbbbbo..',
    '.oobdbdbdbdbdoo.',
    'oggobllllllboggo',
    'oggobdbdbdbdoggo',
    '.oobbbbbbbbbboo.',
    '..oppppppppppo..',
    '...opd..oppo....',
    '...opd..oppo....',
    '...ooo..oooo....',
    '................',
    '................'
  ];

  const PALS = {
    zombie: {
      o: rgb(38, 66, 30), g: rgb(112, 184, 78), l: rgb(146, 214, 106), d: rgb(78, 138, 56),
      b: rgb(64, 100, 184), p: rgb(52, 66, 140), w: rgb(244, 250, 232), k: rgb(32, 32, 26), m: rgb(38, 66, 30)
    },
    husk: {
      o: rgb(88, 62, 24), g: rgb(226, 196, 122), l: rgb(246, 226, 168), d: rgb(184, 156, 92),
      b: rgb(148, 92, 60), p: rgb(110, 70, 48), w: rgb(255, 248, 216), k: rgb(58, 42, 18), m: rgb(88, 62, 24)
    },
    skeleton: {
      o: rgb(58, 58, 66), g: rgb(232, 232, 220), l: rgb(255, 255, 252), d: rgb(170, 170, 160),
      b: rgb(216, 216, 204), p: rgb(150, 150, 140), w: rgb(30, 30, 28), k: rgb(30, 30, 28), m: rgb(58, 58, 66)
    },
    dead: {
      o: rgb(52, 40, 34), g: rgb(126, 92, 74), l: rgb(158, 122, 96), d: rgb(96, 68, 54),
      b: rgb(112, 76, 66), p: rgb(84, 58, 52), w: rgb(112, 92, 80), k: rgb(48, 36, 30), m: rgb(52, 40, 34)
    }
  };

  /* ---------------- 第一人称武器（方块拼装 + 卡通描边） ---------------- */
  const SKIN = rgb(226, 178, 132), SKIN_D = rgb(170, 122, 84), SKIN_L = rgb(248, 206, 164);
  const OL = rgb(38, 32, 28);           // 描边
  const IRON = rgb(206, 210, 218), IRON_D = rgb(148, 154, 166), IRON_L = rgb(240, 244, 250);
  const WOOD = rgb(196, 148, 84), WOOD_D = rgb(142, 100, 52), WOOD_L = rgb(226, 182, 118);
  const OBS = rgb(58, 52, 76), OBS_D = rgb(38, 34, 52);
  const RED = rgb(238, 72, 56), RED_L = rgb(255, 150, 120);

  function gun(ops) {
    const t = new Tex(88, 68);
    for (const o of ops) t.rect(o[0], o[1], o[2], o[3], o[4]);
    return t;
  }

  function buildWeapons() {
    /* 铁手铳 */
    const pistol = gun([
      [36, 0, 12, 8, OL], [38, 2, 8, 6, IRON_D], [38, 2, 8, 2, IRON_L],   // 枪口
      [37, 6, 12, 22, OL], [39, 8, 8, 18, IRON], [39, 8, 8, 3, IRON_L], [45, 10, 2, 14, IRON_D],
      [31, 26, 26, 14, OL], [33, 28, 22, 10, IRON], [33, 28, 22, 3, IRON_L],
      [36, 38, 16, 5, OL], [38, 39, 12, 3, IRON_D],                        // 扳机护圈
      [30, 36, 20, 30, OL], [32, 38, 16, 26, WOOD], [32, 38, 16, 4, WOOD_L], [44, 40, 4, 24, WOOD_D],
      [34, 44, 12, 2, WOOD_D], [34, 50, 12, 2, WOOD_D], [34, 56, 12, 2, WOOD_D],
      [20, 38, 12, 28, SKIN], [20, 38, 12, 3, SKIN_L], [20, 63, 12, 3, SKIN_D],
      [50, 38, 12, 28, SKIN], [50, 38, 12, 3, SKIN_L], [50, 63, 12, 3, SKIN_D],
      [18, 38, 3, 28, OL], [61, 38, 3, 28, OL]
    ]);

    /* 双管猎枪 */
    const shotgun = gun([
      [30, 0, 26, 34, OL], [32, 2, 10, 30, IRON_D], [44, 2, 10, 30, IRON_D],
      [32, 2, 10, 4, IRON_L], [44, 2, 10, 4, IRON_L],
      [40, 2, 6, 30, OBS_D], [40, 2, 6, 4, OBS],
      [28, 30, 30, 14, OL], [30, 32, 26, 10, WOOD], [30, 32, 26, 3, WOOD_L], [30, 39, 26, 3, WOOD_D],
      [32, 42, 22, 9, OL], [34, 44, 18, 5, WOOD_D], [34, 44, 18, 2, WOOD],
      [26, 42, 16, 24, OL], [28, 44, 12, 20, WOOD], [28, 44, 12, 4, WOOD_L],
      [46, 42, 16, 24, OL], [48, 44, 12, 20, WOOD], [48, 44, 12, 4, WOOD_L],
      [20, 40, 12, 26, SKIN], [20, 40, 12, 3, SKIN_L], [20, 63, 12, 3, SKIN_D],
      [52, 40, 12, 26, SKIN], [52, 40, 12, 3, SKIN_L], [52, 63, 12, 3, SKIN_D],
      [18, 40, 3, 26, OL], [63, 40, 3, 26, OL]
    ]);

    /* 红石脉冲枪 */
    const pulse = gun([
      [36, 0, 16, 16, OL], [38, 2, 12, 12, OBS], [40, 4, 8, 8, RED], [42, 6, 4, 4, RED_L],
      [30, 12, 30, 26, OL], [32, 14, 26, 22, OBS], [32, 14, 26, 3, rgb(84, 76, 108)],
      [34, 18, 4, 14, RED], [50, 18, 4, 14, RED],
      [34, 18, 4, 3, RED_L], [50, 18, 4, 3, RED_L],
      [40, 18, 10, 12, OL], [42, 20, 6, 8, RED], [43, 22, 4, 4, RED_L],
      [32, 36, 24, 20, OL], [34, 38, 20, 16, OBS_D], [36, 42, 16, 3, RED], [36, 48, 16, 3, RED],
      [24, 34, 14, 32, OL], [26, 36, 10, 28, OBS], [26, 36, 10, 3, rgb(84, 76, 108)],
      [50, 34, 14, 32, OL], [52, 36, 10, 28, OBS], [52, 36, 10, 3, rgb(84, 76, 108)],
      [20, 38, 12, 28, SKIN], [20, 38, 12, 3, SKIN_L], [20, 63, 12, 3, SKIN_D],
      [54, 38, 12, 28, SKIN], [54, 38, 12, 3, SKIN_L], [54, 63, 12, 3, SKIN_D],
      [18, 38, 3, 28, OL], [65, 38, 3, 28, OL]
    ]);

    Art.weaponGfx = [
      { idle: pistol, muzzle: [43, 3], kick: 1.0 },
      { idle: shotgun, muzzle: [43, 3], kick: 2.4 },
      { idle: pulse, muzzle: [44, 4], kick: 0.55 }
    ];
  }

  /* ---------------- 特效 / 拾取 ---------------- */
  function buildFx() {
    const rng = PP.Core.mulberry32(4242);
    const f = new Tex(40, 40);
    for (let y = 0; y < 40; y++) for (let x = 0; x < 40; x++) {
      const dx = x - 20, dy = y - 20;
      const d = Math.sqrt(dx * dx + dy * dy);
      const a = Math.atan2(dy, dx);
      const r = 16 + Math.sin(a * 5) * 4 + Math.sin(a * 11 + 1) * 2.2 + rng() * 2;
      if (d > r) continue;
      const k = d / r;
      f.px(x, y, k < 0.3 ? rgb(255, 255, 235) : k < 0.58 ? rgb(255, 232, 140) : k < 0.8 ? rgb(255, 170, 60) : rgb(240, 110, 40));
    }
    Art.muzzle = f;

    function dot(size, color) { const t = new Tex(size, size); t.data.fill(color >>> 0); return t; }
    Art.particle = {
      blood: dot(3, rgb(90, 200, 90)), bloodD: dot(3, rgb(50, 140, 56)),
      spark: dot(3, rgb(255, 226, 130)), gib: dot(4, rgb(120, 190, 110))
    };

    const b = new Tex(10, 10);
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
      const dx = x - 4.5, dy = y - 4.5, d = Math.sqrt(dx * dx + dy * dy);
      if (d > 4.5) continue;
      b.px(x, y, d < 1.6 ? rgb(255, 255, 255) : d < 2.8 ? rgb(255, 246, 210) : d < 3.8 ? rgb(236, 226, 186) : rgb(180, 170, 140));
    }
    Art.bone = b;

    function box(bg0, bg1, edge, draw) {
      const t = new Tex(16, 16);
      t.rect(1, 4, 14, 11, edge);
      t.rect(2, 5, 12, 9, bg0);
      t.rect(2, 5, 12, 2, bg1);
      t.rect(4, 1, 8, 4, edge);
      t.rect(5, 2, 6, 2, bg1);
      if (draw) draw(t);
      return t;
    }
    const OL2 = rgb(40, 34, 28);
    Art.pickups = {
      health: box(rgb(206, 64, 72), rgb(238, 108, 112), OL2, (t) => {
        t.rect(6, 7, 4, 5, rgb(255, 240, 236)); t.rect(5, 8, 2, 3, rgb(255, 240, 236));
        t.rect(9, 8, 2, 3, rgb(255, 240, 236)); t.rect(7, 6, 2, 1, rgb(255, 240, 236));
      }),
      armor: box(rgb(72, 132, 220), rgb(126, 178, 246), OL2, (t) => {
        t.rect(5, 6, 6, 6, rgb(226, 240, 255)); t.rect(6, 5, 4, 2, rgb(226, 240, 255));
        t.rect(7, 12, 2, 2, rgb(150, 190, 240));
      }),
      ammo: box(rgb(198, 156, 72), rgb(238, 200, 110), OL2, (t) => {
        t.rect(5, 6, 2, 6, rgb(250, 240, 200)); t.rect(9, 6, 2, 6, rgb(250, 240, 200));
        t.rect(5, 6, 2, 2, rgb(255, 232, 150)); t.rect(9, 6, 2, 2, rgb(255, 232, 150));
      }),
      shotgun: box(rgb(150, 108, 60), rgb(196, 152, 92), OL2, (t) => {
        t.rect(4, 8, 8, 4, rgb(120, 126, 140)); t.rect(5, 6, 2, 4, rgb(180, 186, 200));
        t.rect(9, 6, 2, 4, rgb(180, 186, 200));
      }),
      pulse: box(rgb(70, 62, 92), rgb(110, 100, 140), OL2, (t) => {
        t.rect(4, 8, 8, 4, rgb(52, 46, 72)); t.rect(5, 9, 6, 2, rgb(238, 72, 56));
        t.rect(6, 5, 1, 3, rgb(238, 72, 56)); t.rect(9, 5, 1, 3, rgb(238, 72, 56));
      }),
      chest: box(rgb(168, 122, 62), rgb(210, 164, 92), OL2, (t) => {
        t.rect(2, 8, 12, 2, rgb(120, 84, 40)); t.rect(7, 8, 2, 3, rgb(240, 214, 120));
      })
    };
  }

  /* ---------------- 构建 ---------------- */
  Art.build = function () {
    if (Art.built) return;
    Art.built = true;
    const T = makeTextures();
    Art.tex = T;
    // 墙：id -> 纹理
    Art.wallTex = [T.stone, T.plank, T.brick, T.sandstone, T.log, T.leaves, T.cactus, T.redstoneOre, T.bedrock];
    // 地面：id -> 纹理
    Art.floorTex = [T.grassTop, T.dirt, T.sand, T.stone, T.plank, T.water, T.snow];

    Art.sprites = {};
    for (const k of ['zombie', 'husk']) {
      Art.sprites[k] = {
        walk: bake(HUM_WALK, PALS[k], 16, 20),
        atk: bake(HUM_ATK, PALS[k], 16, 20),
        hurt: bake(HUM_HURT, PALS[k], 16, 20),
        dead: bake(HUM_WALK, PALS.dead, 16, 20)
      };
    }
    Art.sprites.skeleton = {
      walk: bake(SKEL_WALK, PALS.skeleton, 16, 20),
      atk: bake(SKEL_ATK, PALS.skeleton, 16, 20),
      hurt: bake(SKEL_WALK, PALS.dead, 16, 20),
      dead: bake(SKEL_WALK, PALS.dead, 16, 20)
    };

    // 玩家（幸存者）：4 种上衣配色，用于区分联机队友
    const SHIRTS = [rgb(62, 108, 200), rgb(206, 74, 62), rgb(84, 168, 76), rgb(158, 92, 200)];
    Art.sprites.player = [];
    for (let i = 0; i < 4; i++) {
      const pal = {
        o: rgb(44, 32, 22), g: rgb(226, 178, 132), l: rgb(248, 214, 172), d: rgb(170, 122, 84),
        b: SHIRTS[i], p: rgb(88, 70, 50), w: rgb(250, 250, 244), k: rgb(30, 26, 22), m: rgb(120, 70, 52)
      };
      Art.sprites.player.push({
        walk: bake(HUM_WALK, pal, 16, 20),
        atk: bake(HUM_ATK, pal, 16, 20),
        hurt: bake(HUM_HURT, pal, 16, 20),
        dead: bake(HUM_WALK, PALS.dead, 16, 20)
      });
    }
    buildWeapons();
    buildFx();
  };

  Art.build();
})();
