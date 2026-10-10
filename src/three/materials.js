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
  return atlasMat;
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
