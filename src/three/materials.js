/* ============================================================
   materials.js — Minecraft 原版纹理 + 方块材质
   ============================================================ */
import * as THREE from 'three';
import { threeTex, atlasTexture, atlasUV, setAnisotropy, ATLAS_ORDER } from './textures.js';

export { atlasUV, setAnisotropy, ATLAS_ORDER };

/* ---------------- 图集材质：整个地形共用一份 ----------------
   所有方块类型都从同一张图集采样，所以分块网格可以把
   "整块地形的墙 + 地面"压成极少的 draw call。

   alphaTest = 树叶镂空 —— 原版 oak_leaves 的 alpha 是**二元**的
   （完全透明 0 或完全不透明 255，没有中间值），所以阈值取 0.5 正好卡中间：
   实体像素（255）稳过、镂空像素（0）稳剔，中值不会被误判。

   ⚠️ 曾经用 0.1，理由是"怕把远处 mipmap 混合出的中间 alpha 也剔掉"。
   这是**错的**：用对照实验（maxMipLevel 0/1/2/∞ 各截一张）验证过，
   远处树冠的"蓝白网格"与 mip 层级完全无关 —— 它是树叶贴图里
   约 30% 的镂空像素透出**后面的天空**。0.1 会让 mip 混合出的
   浅色半透明像素（alpha≈0.2）也通过测试，屏幕上就是"半透明的网"，
   网格反而更明显。0.5 把这一层滤掉，树冠立刻收紧。 */
/* 树叶的"蓝白网格"收尾：贴图侧的 thin_leaf_alpha 已经把 8 条贯穿竖缝打断了，
   但原版树叶本身还有 ~30% 的镂空像素 —— 远处一个方块只占几个像素时，
   任何固定镂空图案都会压成规则点阵（蓝色天空从缝里透出来）。

   Minecraft 原版靠"渐变距离剔除 + 更密的几何"掩盖它；这里用更省的做法：
   **在远处把 alphaTest 的阈值抬上去**，让边缘像素被判为镂空而合并成实心块。
   配合 already 有的雾，远处树冠会收成一个绿团。

   实现：把阈值做成随相机距离变化的 —— 但这需要自定义 shader。
   折中方案（零成本）：阈值取 0.5 不变，改为在 render3d 里
   对树叶单独走一层"远处替换材质"。见 useLeafLOD()。 */
let atlasMat = null;
export function atlasMaterial() {
  if (atlasMat) return atlasMat;
  atlasMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: atlasTexture(THREE),
    vertexColors: true,
    roughness: 0.94,
    metalness: 0.0,
    alphaTest: 0.5,
    side: THREE.FrontSide
  });
  atlasMat.name = 'terrain';
  applyLeafDither(atlasMat);
  return atlasMat;
}

/* ---- 镂空抖动（onBeforeCompile 注入） ----
   治"远处树冠像蓝白网"的最后一刀。

   原理：alphaTest 是**硬阈值**比较，镂空图案在远处被降采样后会规则地
   重复 → 屏幕上是等距白点阵。给阈值叠一个**屏幕空间抖动**
   （Bayer 矩阵，按 gl_FragCoord 取值）后，同样的镂空图案在相邻像素上
   判定不同 → 点阵被打散成噪点 → 再经 mipmap 混合就是一层"叶隙的绒",
   而不是"网格线"。

   这是影视里 dither/ordered-dither 的老办法，比拉高阈值好：
   拉高阈值会把近处的叶隙一起吃掉，树冠变成实心绿板。 */
const BAYER_SRC = `
  /* 4x4 有序抖动（Bayer）。用位交错公式算，避免 GLSL ES 1.0 里
     数组 + 循环的兼容性坑（WebGL1 下 const 数组索引只能取常量）。 */
  float bayer4(vec2 p){
    vec2 c = mod(floor(p), 4.0);
    float x = c.x, y = c.y;
    float v = 0.0;
    // 交错位：b = (x&1)*1 + (y&1)*2 + (x&2)*2 + (y&2)*4 ... 逐位累加
    v += mod(floor(x * 0.5) + floor(y * 0.5) * 2.0, 2.0) * 8.0;
    v += mod(floor(x * 0.25) + floor(y * 0.25) * 2.0, 2.0) * 4.0;
    v += mod(x, 2.0) * 2.0;
    v += mod(y, 2.0) * 1.0;
    return (v + 0.5) / 16.0;
  }
`;
function applyLeafDither(mat) {
  if (mat.userData._leafDither) return;
  mat.userData._leafDither = true;
  const origCompile = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (origCompile) origCompile(shader, renderer);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\n' + BAYER_SRC)
      // alphaTest 的固定阈值 → 阈值叠一层屏幕空间抖动。
      // 抖动幅度 ±0.06 是实测甜点：再大近处叶隙会开始掉像素。
      .replace('#include <alphatest_fragment>', `
        #ifdef USE_ALPHAMAP
          diffuseColor.a *= texture2D( alphaMap, vAlphaMapUv ).g;
        #endif
        if ( diffuseColor.a < 0.5 + (bayer4(gl_FragCoord.xy) - 0.5) * 0.12 ) discard;
      `);
  };
  mat.needsUpdate = true;
}

/* 独立纹理（武器 / 建筑这类需要各自 metalness / roughness 的物体） */
let texCache = null;
function T() {
  if (!texCache) {
    texCache = {
      grass: threeTex('grass_top', 1),
      dirt: threeTex('dirt', 1),
      stone: threeTex('stone', 1),
      plank: threeTex('plank', 1),
      brick: threeTex('brick', 1),
      sand: threeTex('sand', 1),
      leaves: threeTex('leaves', 1),
      metal: threeTex('iron', 1),          // 原版 iron_block
      sandstone: threeTex('sandstone', 1),
      bedrock: threeTex('bedrock', 1),
      redstone: threeTex('redstone', 1),
      cactus: threeTex('cactus_side', 1),
      log: threeTex('log_side', 1),
      obsidian: threeTex('obsidian', 1),
      gold: threeTex('gold', 1)
    };
  }
  return texCache;
}

export function makeMat(hex, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color: hex,
    flatShading: false,
    roughness: 0.9,
    metalness: 0.02,
    ...opts
  });
}

export const makeLambert = makeMat;

export function makeUnlit(hex, opts = {}) {
  return new THREE.MeshBasicMaterial({ color: hex, ...opts });
}

export function makeMetal(hex, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color: hex,
    roughness: 0.38,
    metalness: 0.72,
    flatShading: true,
    ...opts
  });
}

export function makeTextured(kind, hex = 0xffffff, repeat = 1, opts = {}) {
  const t = T()[kind];
  let map = t;
  if (repeat !== 1 && t) {
    map = t.clone();
    map.needsUpdate = true;
    map.repeat.set(repeat, repeat);
  }
  return new THREE.MeshStandardMaterial({
    color: hex,
    map: map || null,
    roughness: kind === 'metal' ? 0.45 : 0.92,
    metalness: kind === 'metal' ? 0.55 : 0.02,
    ...opts
  });
}

/** 墙类型 → 图集纹理名。
 *  ⚠️ color 用 0xffffff 之外的值只有一种情况：**原图是灰度**。
 *  Minecraft 把 grass_block_top / oak_leaves / water_still 存成灰度图，
 *  颜色在运行时由 biome color 乘上去（colormap/grass.png 之类）。
 *  直接用原图会得到一片灰白 —— 这不是纹理错了，是缺了染色这一步。
 *  这里给的就是原版 plains 群系的默认色。
 *  `map` = 侧面纹理，`top` = 顶面纹理（缺省则与侧面相同）。
 *  Minecraft 里原木、仙人掌的顶面本来就与侧面不同，这是它的特征之一。 */
export const WALL_SKIN = {
  1: { map: 'stone', color: 0xffffff },
  2: { map: 'plank', color: 0xffffff },
  3: { map: 'brick', color: 0xffffff },
  4: { map: 'sandstone', color: 0xffffff },
  5: { map: 'log_side', top: 'log_top', color: 0xffffff },
  6: { map: 'leaves', color: 0x77ab2f },      // 原图是灰度 → 补 foliage 染色
  7: { map: 'cactus_side', top: 'cactus_top', color: 0xffffff },
  8: { map: 'redstone', color: 0xffffff },
  9: { map: 'bedrock', color: 0xffffff }
};

export const FLOOR_SKIN = {
  0: { map: 'grass_top', color: 0x91bd59 },   // 原图是灰度 → 补 grass 染色
  1: { map: 'dirt', color: 0xffffff },
  2: { map: 'sand', color: 0xffffff },
  3: { map: 'stone', color: 0xffffff },
  4: { map: 'plank', color: 0xffffff },
  // 水：原图 water_still 是灰度，颜色由 biome color 乘上去。
  // 0x3f76e4 是原版的"水色常量"，但直接乘灰度图（均值 188）再经曝光 1.15，
  // 屏幕上是刺眼的荧光蓝 —— 原版还有 alpha 0.72 + 水面光照衰减在压它。
  // 这里折到 0x2f66c8（更沉稳、略带钢蓝），配合 render3d 的水面波纹，
  // 才是 Minecraft 湖面在明亮日光下的观感。
  5: { map: 'water', color: 0x2f66c8 },
  6: { map: 'snow', color: 0xffffff }
};

/* ============================================================
   体素方块材质表（v11 真 3D）

   面编号与 sim 坐标的对应（渲染层 three.y = sim.z，勿改）：
     PY = sim +z（顶面）  NY = sim -z（底面）
     PX = sim +x   NX = sim -x   PZ = sim +y   NZ = sim -y

   明暗照搬 Minecraft 的**固定面系数**（顶 1.0 / 南北 0.8 / 东西 0.6），
   这是 MC 方块感的来源：不管光源在哪，方块六个面永远有这组固定差。
   ⚠️ 填的是**线性值**（顶点色是线性空间，视觉比 = 线性^(1/2.4)）：
     顶 1.22 / 南北 0.74 / 东西 0.42 —— 这组是上一轮美术调过的实测值。

   ⚠️ 原版 grass_block_top / oak_leaves / water_still 存的是**灰度图**，
   颜色由 biome color 在运行时乘上去（colormap）。直接贴是一片灰白，
   **不是纹理坏了**。这里按 plains / desert / mountains / snowy 四档补色。
   ============================================================ */
export const F = { PX: 0, NX: 1, PY: 2, NY: 3, PZ: 4, NZ: 5 };
const FACE_SHADE = [0.42, 0.42, 1.22, 0.30, 0.74, 0.74];
export function faceShade(f) { return FACE_SHADE[f]; }

/* kind：0 不透明 / 1 镂空（alphaTest）/ 2 半透明（水、玻璃） */
export const K_OPAQUE = 0, K_CUTOUT = 1, K_BLEND = 2;

/* 方块 id 必须与 src/sim/world.js 的 B 表一致（改表要同步两处） */
export const BLOCK_DEF = {
  1:  { s: 'stone' },                                              // STONE
  2:  { s: 'grass_side', t: 'grass_top', b: 'dirt', biome: 0 },    // GRASS
  3:  { s: 'dirt', t: 'dirt', b: 'dirt' },                         // DIRT
  4:  { s: 'sand' },                                                // SAND
  5:  { s: 'sandstone', t: 'sandstone', b: 'sandstone' },          // SANDSTONE
  6:  { s: 'log_side', t: 'log_top', b: 'log_top' },               // LOG
  7:  { s: 'leaves', kind: K_CUTOUT, biome: 1 },                   // LEAVES
  8:  { s: 'plank' },                                               // PLANK
  9:  { s: 'cobble' },                                              // COBBLE
  10: { s: 'brick' },                                               // BRICK
  11: { s: 'water', kind: K_BLEND, biome: 2 },                     // WATER
  12: { s: 'bedrock' },                                             // BEDROCK
  13: { s: 'glass', kind: K_CUTOUT },                               // GLASS
  14: { s: 'cactus_side', t: 'cactus_top', b: 'cactus_top' },      // CACTUS
  15: { s: 'redstone' },                                            // REDSTONE
  16: { s: 'snow' },                                                // SNOW
  17: { s: 'gravel' },                                              // GRAVEL
  18: { s: 'mossy' },                                               // MOSSY
  19: { s: 'obsidian' },                                            // OBSIDIAN
  20: { s: 'iron' },                                                // IRON
  21: { s: 'gold' },                                                // GOLD
  22: { s: 'wool_red' }                                             // WOOL
};

/* biome 染色（plains / desert / mountains / snowy）—— 原版 colormap 的四档 */
export const BIOME_TINT = [
  [0x91bd59, 0xbfb755, 0x8ab689, 0x80b497],   // 0 = 草顶
  [0x77ab2f, 0xaea42a, 0x77ab2f, 0x60a017],   // 1 = 树叶
  [0x2f66c8, 0x2f66c8, 0x2f66c8, 0x2f66c8]    // 2 = 水
];

const _c = new THREE.Color();
function srgbToLinear(hex) {
  _c.setHex(hex, THREE.SRGBColorSpace);
  return [_c.r, _c.g, _c.b];
}

/** 预计算：BLOCK_FACE[id * 6 + face] = { uv, ts:[r,g,b], kind, biome }
 *  ⚠️ ts 是**已乘过面明暗**的线性三元组 —— 逐顶点再乘一次 shade 是纯浪费
 *  （15 万个面 × 6 顶点 × 3 通道）。biome 方块（草/叶/水）的 ts 为 undefined，
 *  走 BIOME_SHADED 表。 */
let BLOCK_FACE = null;
export function blockFaceTable() {
  if (BLOCK_FACE) return BLOCK_FACE;
  BLOCK_FACE = new Array(32 * 6);
  for (const key of Object.keys(BLOCK_DEF)) {
    const id = +key, d = BLOCK_DEF[key];
    const kind = d.kind || K_OPAQUE;
    for (let f = 0; f < 6; f++) {
      const name = (f === F.PY && d.t) ? d.t : (f === F.NY && d.b) ? d.b : d.s;
      const sh = FACE_SHADE[f];
      const bTi = d.biome;
      const ts = bTi === undefined
        ? srgbToLinear(0xffffff).map(v => v * sh)
        : null;                      // 染色方块按列取 BIOME_SHADED
      BLOCK_FACE[id * 6 + f] = { uv: atlasUV(name), ts, kind, biome: bTi };
    }
  }
  return BLOCK_FACE;
}
/** biome 色 × 面明暗：[slot][biomeIdx][face] = [r,g,b]（线性） */
let BIOME_SHADED = null;
export function biomeShaded() {
  if (BIOME_SHADED) return BIOME_SHADED;
  BIOME_SHADED = BIOME_TINT.map(row => row.map(hex => {
    const lin = srgbToLinear(hex);
    return FACE_SHADE.map(sh => [lin[0] * sh, lin[1] * sh, lin[2] * sh]);
  }));
  return BIOME_SHADED;
}

/** 半透明（水 / 玻璃）单独一份材质：transparent 不能和不透明共用一个 mesh，
 *  否则深度排序会把水面画到地形前面去。 */
let blendMat = null;
export function blendMaterial() {
  if (blendMat) return blendMat;
  blendMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: atlasTexture(THREE),
    vertexColors: true,
    roughness: 0.22,
    metalness: 0.0,
    transparent: true,
    opacity: 0.74,
    depthWrite: false,
    side: THREE.DoubleSide
  });
  blendMat.name = 'terrain-blend';
  return blendMat;
}

/** 全局调色板（明亮卡通 / Minecraft 取向）
 *  约束：所有基色都要保证"受光面接近原色、背光面仍读得出形体"，
 *  所以不用纯黑（纯黑在整个世界偏亮时反而变成突兀的黑洞）。 */
export const PALETTE = {
  playerShirts: [0x3d7bb8, 0xc05a48, 0x4e9a52, 0x7a5ab0],
  skin: 0xd8b08c,
  skinDark: 0xb08a68,
  zombie: 0x5aa04a,
  zombieDark: 0x3e7a32,
  husk: 0xd0ae78,
  huskDark: 0xa8825a,
  skeleton: 0xd8d8d0,
  skeletonDark: 0xb0b0a8,
  creeper: 0x5cb85c,
  creeperDark: 0x3e8c3e,
  spider: 0x3a2e44,
  spiderLight: 0x554466,
  iron: 0xc8ced8,
  ironDark: 0x8a9098,
  wood: 0xa87b4a,
  woodDark: 0x6b4a28,
  obsidian: 0x3a3350,
  redstone: 0xc02020,
  magma: 0xe06020,
  magmaHot: 0xf5a030,
  lapis: 0x3a5ac8,
  gold: 0xe8c050,
  ammo: 0xb89858,
  health: 0xb03030,
  shotgun: 0x8a6440
};

export class MaterialLib {
  constructor() { this.cache = new Map(); }
  get(hex, opts) {
    const key = `${hex}|${opts ? JSON.stringify(opts) : ''}`;
    if (!this.cache.has(key)) this.cache.set(key, makeMat(hex, opts));
    return this.cache.get(key);
  }
  dispose() {
    for (const m of this.cache.values()) m.dispose();
    this.cache.clear();
  }
}
