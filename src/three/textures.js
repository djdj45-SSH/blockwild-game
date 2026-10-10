/* ============================================================
   textures.js — Minecraft 原版方块纹理

   资源链路（两条脚本，产物已内联进仓库，运行时不必联网）：
     tools/fetch-mc-textures.py  从 Mojang 官方 client jar 抽出 25 张 16×16 原图
     tools/build-mc-atlas.py      拼成单张图集并生成 src/three/mc-atlas-data.js

   为什么换成原图而不是继续调程序化纹理：
     程序化纹理再怎么调也只是"像" Minecraft，原图才是"是"。上一轮已经把
     风格（像素密度 / 卡通调色板 / 方块云 / 方块太阳）全部对齐，剩下的差距
     就在纹理本身 —— 直接换原图，这一步的收益远大于继续调数值。

   为什么把图集做成 base64 内联而不是 import 图片或相对 URL：
     项目同时支持「源码根 + importmap 纯静态托管」和「vite build 产物」两种部署，
     import PNG 在浏览器里直接报错、相对路径在构建后层级也会变，两种都会在其中
     一种模式下失效。data URL 两种都零成本生效，还省一次请求。
   ============================================================ */
import * as THREE from 'three';
import { ATLAS_PNG_B64, ATLAS_LAYOUT, ATLAS_GRID } from './mc-atlas-data.js';

/* ---------------- 各向异性 ----------------
   掠射角看地面时，mip 选择会把 1 米一格的地面糊成"一片纯色"——
   各向异性过滤是解决这个的第一手段。 */
let ANISOTROPY = 8;
const texRefs = [];
export function setAnisotropy(max) {
  ANISOTROPY = Math.max(1, Math.min(16, (max | 0) || 1));
  for (const t of texRefs) t.anisotropy = ANISOTROPY;
}
export function getAnisotropy() { return ANISOTROPY; }

/* ---------------- 图集布局 ---------------- */
export const ATLAS_COLS = ATLAS_GRID.cols;
export const ATLAS_ROWS = ATLAS_GRID.rows;
export const ATLAS_TILE = ATLAS_GRID.tile;   // 16（原版边长）
export const ATLAS_PAD = ATLAS_GRID.pad;     // 16（mip 护栏）
const ATLAS_CELL = ATLAS_GRID.cell;          // 48
export const ATLAS_ORDER = Object.keys(ATLAS_LAYOUT);

/** 像素风过滤：放大取最近邻（硬边像素），缩小走 mipmap（防远处摩尔纹闪烁）
 *
 *  ⚠️ 关于树叶的 alpha 与 mipmap —— 这里踩过一个大坑，结论已用对照实验确认：
 *
 *  【错误假设 1】"蓝白网格是 mipmap + alphaTest 把中间 alpha 丢了"
 *      → 把 maxMipLevel 设成 0（完全关 mip）后，蓝白网格**依然存在**。
 *        判定：与 mip 层级无关。
 *  【错误假设 2】"是图集护栏不够宽，采样越界采到隔壁格"
 *      → 把 maxMipLevel 放到无限大，画面清晰，没有任何越界描边。
 *        判定：护栏（PAD=16）是够的。
 *
 *  【真实成因】远处树叶的蓝白网格 = 树叶纹理自身的**镂空像素**
 *  被 alphaTest 剔掉后**透出后面的天空**。树叶 16×16 贴图里本来就有
 *  约 30% 的完全透明像素（alpha=0），近看只是"叶子之间的缝"，
 *  远看这些缝密集到像素级 → 成片透出天空 → 看着像"蓝白网"。
 *
 *  这不是 bug，是 alphaTest 该有的行为；真正的问题在**阈值与距离**：
 *  远处一个树叶方块只占几个像素，任何阈值都会让"缝"占比被放大。
 *  Minecraft 原版的应对是**树叶用特殊光照 + 更密的几何**，而不是调 mip。
 *  本项目采取的对策：把 alphaTest 提到 0.5（原版树叶 alpha 是 0 或 1，
 *  0.5 正好卡在中间，能剔掉半透明边缘像素但不会误伤实体像素），
 *  配合下面的 maxMipLevel 限制，远处树冠的"网眼"会明显收细。 */
export const ATLAS_MAX_MIP = 2;
function pixelFilter(t) {
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestMipmapLinearFilter;
  t.generateMipmaps = true;
  t.maxMipLevel = ATLAS_MAX_MIP;
}
/* 独立小纹理（武器用的 16×16 entity/方块图）不受图集限制影响，
   但同样限制 mip 层级：它们也不该被压成纯色。 */
function pixelFilter16(t) {
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestMipmapLinearFilter;
  t.generateMipmaps = true;
  t.maxMipLevel = 2;
}

/* ---------------- 图集加载 ----------------
   材质与地形 UV 都依赖图集，必须在 Render.init 之前完成，
   所以对外给 Promise，由 game.js 的 boot() await。 */
let atlasImg = null;
let preloadPromise = null;
// Node（tools/verify.js 这类同步断言环境）里没有 Image，视为"立即就绪"：
// boot() 是 async 的，如果这里返回"永远未就绪"，同步断言环境会卡在 await 上，
// 后面的 UI 监听器注册就永远等不到（verify.js 曾经直接 FAIL 在这一条）。
let nodeMode = false;

export function preloadAtlas() {
  if (preloadPromise) return preloadPromise;
  // 判据必须同时看 Image：verify.js 提供的是「有 document 但没有 Image」的假 DOM，
  // 只判 document 会走真实加载分支 → new Image() 抛错 → Promise 永远 pending → boot 卡死。
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    nodeMode = true;
    preloadPromise = Promise.resolve(false);
    return preloadPromise;
  }
  preloadPromise = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => { atlasImg = img; resolve(true); };
    img.onerror = () => {
      if (typeof console !== 'undefined') console.error('[mc] 图集解码失败');
      resolve(false);
    };
    img.src = 'data:image/png;base64,' + ATLAS_PNG_B64;
  });
  return preloadPromise;
}

export function atlasReady() { return !!atlasImg || nodeMode; }

/** 取某张贴图在图集里的 UV 矩形（只取内容区，护栏不参与 UV）。
 *  Texture 默认 flipY=true → 图集第 0 行映射到 v 的上方 */
export function atlasUV(name) {
  const p = ATLAS_LAYOUT[name] || ATLAS_LAYOUT.stone;
  const W = ATLAS_CELL * ATLAS_COLS, H = ATLAS_CELL * ATLAS_ROWS;
  const x0 = p[0] * ATLAS_CELL + ATLAS_PAD;
  const y0 = p[1] * ATLAS_CELL + ATLAS_PAD;
  const u0 = x0 / W, u1 = (x0 + ATLAS_TILE) / W;
  const v1 = 1 - y0 / H, v0 = 1 - (y0 + ATLAS_TILE) / H;
  return [u0, v0, u1, v1];
}

/** 兜底图集：图集没加载出来时用，保证不至于崩（画面是纯灰但能跑） */
let fallbackCanvas = null;
function makeFallback() {
  if (fallbackCanvas) return fallbackCanvas;
  fallbackCanvas = document.createElement('canvas');
  fallbackCanvas.width = ATLAS_CELL * ATLAS_COLS;
  fallbackCanvas.height = ATLAS_CELL * ATLAS_ROWS;
  const ctx = fallbackCanvas.getContext('2d');
  ctx.fillStyle = '#9a9a9a';
  ctx.fillRect(0, 0, fallbackCanvas.width, fallbackCanvas.height);
  return fallbackCanvas;
}

/** 把图集包成 THREE 纹理（单例，整块地形共用一个材质就靠它） */
let atlasTexRef = null;
export function atlasTexture(THREE_) {
  if (atlasTexRef) return atlasTexRef;
  const t = new THREE_.Texture(atlasImg || makeFallback());
  t.colorSpace = THREE_.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE_.ClampToEdgeWrapping;
  t.anisotropy = ANISOTROPY;
  pixelFilter(t);
  t.needsUpdate = true;
  atlasTexRef = t;
  texRefs.push(t);
  return t;
}

/** 从图集裁出单格做成独立纹理。
 *  武器 / 建筑这类需要各自 metalness / roughness 的物体用独立纹理，
 *  UV 保持标准 [0,1]，不用去算图集坐标。 */
export function threeTex(name, repeat = 1) {
  const c = document.createElement('canvas');
  c.width = c.height = ATLAS_TILE;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  if (atlasImg) {
    const p = ATLAS_LAYOUT[name] || ATLAS_LAYOUT.stone;
    ctx.drawImage(atlasImg,
      p[0] * ATLAS_CELL + ATLAS_PAD, p[1] * ATLAS_CELL + ATLAS_PAD,
      ATLAS_TILE, ATLAS_TILE, 0, 0, ATLAS_TILE, ATLAS_TILE);
  } else {
    ctx.fillStyle = '#9a9a9a';
    ctx.fillRect(0, 0, ATLAS_TILE, ATLAS_TILE);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.anisotropy = ANISOTROPY;
  pixelFilter(t);
  texRefs.push(t);
  return t;
}
