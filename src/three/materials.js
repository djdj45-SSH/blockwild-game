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
 *  注意：贴图本身已经带基色了，这里的 color 只做"轻微偏色"，
 *  给成 0xffffff 表示不染色。以前这里给的是深色，会把贴图二次压暗。 */
export const WALL_SKIN = {
  1: { map: 'stone', color: 0xffffff },
  2: { map: 'plank', color: 0xfff0dc },
  3: { map: 'brick', color: 0xffe8e0 },
  4: { map: 'sandstone', color: 0xfff8ec },
  5: { map: 'plank', color: 0xe8d0b0 }, // log
  6: { map: 'leaves', color: 0xe4f4d4 },
  7: { map: 'cactus', color: 0xe4f4dc },
  8: { map: 'redstone', color: 0xffe4dc },
  9: { map: 'bedrock', color: 0xa8a8b0 }
};

export const FLOOR_SKIN = {
  0: { map: 'grass', color: 0xeaf6d8 },
  1: { map: 'dirt', color: 0xf4e4d0 },
  2: { map: 'sand', color: 0xfff8e4 },
  3: { map: 'stone', color: 0xffffff },
  4: { map: 'plank', color: 0xfff0d4 },
  5: { map: 'stone', color: 0x74a8d0 }, // water-ish
  6: { map: 'stone', color: 0xf4f8ff }
};

/** 兼容旧调色 */
export const WALL_COLORS = {
  1: 0x9aa0a8, 2: 0xc49a62, 3: 0xb85c48, 4: 0xe0d090,
  5: 0x8b6a42, 6: 0x4e9e3c, 7: 0x5a9e40, 8: 0xc83c30, 9: 0x4e5058
};
export const FLOOR_COLORS = {
  0: 0x6eb848, 1: 0x8c6440, 2: 0xe8d8a0, 3: 0x9aa0a8,
  4: 0xc49a62, 5: 0x3a88c8, 6: 0xe8f0f8
};

export const PALETTE = {
  playerShirts: [0x3a5a7a, 0x7a4038, 0x4a6a42, 0x5a4a70],
  skin: 0xc8a080,
  skinDark: 0x8a6850,
  zombie: 0x6a8a50,
  zombieDark: 0x4a6040,
  husk: 0xb89868,
  huskDark: 0x8a7048,
  skeleton: 0xc8c4b0,
  skeletonDark: 0x8a8878,
  creeper: 0x5a8a48,
  creeperDark: 0x3a5830,
  spider: 0x2a2030,
  spiderLight: 0x4a3850,
  iron: 0xa8aeb8,
  ironDark: 0x6a7078,
  wood: 0x8a6840,
  woodDark: 0x5a4028,
  obsidian: 0x28242e,
  redstone: 0xa83028,
  magma: 0xb84820,
  magmaHot: 0xe89030,
  lapis: 0x2a4a98,
  gold: 0xc8a040,
  ammo: 0xa88848,
  health: 0x8a3838,
  shotgun: 0x6a4c30
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
