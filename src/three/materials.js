/* ============================================================
   materials.js — 写实 PBR + 程序化纹理
   ============================================================ */
import * as THREE from 'three';
import { buildAllTextures, threeTex, atlasTexture, atlasUV, setAnisotropy, ATLAS_ORDER } from './textures.js';

export { atlasUV, setAnisotropy, ATLAS_ORDER };

/* ---------------- 图集材质：整个地形共用一份 ----------------
   所有方块类型都从同一张 1024² 图集采样，所以分块网格可以把
   "整块地形的墙 + 地面"压成极少的 draw call。 */
let atlasMat = null;
export function atlasMaterial() {
  if (atlasMat) return atlasMat;
  atlasMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: atlasTexture(THREE),
    vertexColors: true,
    roughness: 0.94,
    metalness: 0.0,
    side: THREE.FrontSide
  });
  atlasMat.name = 'terrain';
  return atlasMat;
}

let texCache = null;
function T() {
  if (!texCache) {
    const raw = buildAllTextures();
    texCache = {
      grass: threeTex(raw.grass, 1),
      dirt: threeTex(raw.dirt, 1),
      stone: threeTex(raw.stone, 1),
      plank: threeTex(raw.plank, 1),
      brick: threeTex(raw.brick, 1),
      sand: threeTex(raw.sand, 1),
      leaves: threeTex(raw.leaves, 1),
      metal: threeTex(raw.metal, 1),
      sandstone: threeTex(raw.sandstone, 1),
      bedrock: threeTex(raw.bedrock, 1),
      redstone: threeTex(raw.redstone, 1),
      cactus: threeTex(raw.cactus, 1)
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

/** 墙类型 → 纹理名 + 色调
 *  注意：贴图本身已经带最终色了，这里的 color 只做"轻微偏色"，
 *  给成 0xffffff 表示不染色。
 *  血泪结论：这里曾经给深色值（如 bedrock 用 0xa8a8b0），顶点色与贴图相乘
 *  会把整面墙二次压暗成近黑块，在明亮卡通场景里极其突兀。现在一律 ≥0xe0。 */
export const WALL_SKIN = {
  1: { map: 'stone', color: 0xffffff },
  2: { map: 'plank', color: 0xfff6e8 },
  3: { map: 'brick', color: 0xfff0ea },
  4: { map: 'sandstone', color: 0xfffaf0 },
  5: { map: 'plank', color: 0xf2ddc4 }, // log：树皮略深一档，但不要发黑
  6: { map: 'leaves', color: 0xeefada },
  7: { map: 'cactus', color: 0xeafaea },
  8: { map: 'redstone', color: 0xffeae4 },
  9: { map: 'bedrock', color: 0xf0f0f4 }
};

export const FLOOR_SKIN = {
  0: { map: 'grass', color: 0xf2fae6 },
  1: { map: 'dirt', color: 0xfaeede },
  2: { map: 'sand', color: 0xfffcf0 },
  3: { map: 'stone', color: 0xffffff },
  4: { map: 'plank', color: 0xfff6e2 },
  5: { map: 'stone', color: 0x86c8ee }, // water-ish：明亮水蓝
  6: { map: 'stone', color: 0xf8fcff }
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
