/* ============================================================
   textures.js — 程序化 Minecraft 风像素纹理
   目标：明亮卡通 · 16×16 硬边像素 · 高饱和 · 块感清晰

   历史教训（勿回退）：
   本文件曾按"写实噪声风"实现（fbm 高频噪声 + Math.random 椭圆斑点 +
   低饱和基色），与用户拍板的"明亮卡通 / Minecraft"方向完全相反：
   草地变成迷彩斑块、树叶被拉伸成竖条纹、远处糊成脏色。
   像素风的三个硬要求：① 按 16×16 网格逐像素硬边着色（绝不抗锯齿）
   ② 固定种子 PRNG（纹理必须可复现，禁用 Math.random）
   ③ 高饱和 Minecraft 官方调色板。
   ============================================================ */
import * as THREE from 'three';

/* 全局各向异性上限：由渲染器按 GPU 能力写入。
   掠射角看地面时，mip 选择会把 1m 一格的地面糊成"一片纯色"——
   各向异性过滤是解决这个的第一手段。 */
let ANISOTROPY = 8;
const texRefs = [];
export function setAnisotropy(max) {
  ANISOTROPY = Math.max(1, Math.min(16, (max | 0) || 1));
  for (const t of texRefs) t.anisotropy = ANISOTROPY;
}
export function getAnisotropy() { return ANISOTROPY; }

/* ---------------- 像素画基础设施 ----------------
   一个方块面 = 1 米 = GRID×GRID 像素（Minecraft 的标准密度）。 */
export const GRID = 16;        // 16×16 像素
const CELL = 16;               // 每像素 16 设备像素
const S = GRID * CELL;         // 256

/** mulberry32 —— 固定种子 PRNG。纹理必须可复现，禁用 Math.random */
function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mk() {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  return ctx;
}

/** 画一个"像素"（占 CELL×CELL 设备像素，硬边） */
function px(ctx, x, y, color) {
  ctx.fillStyle = color;
  ctx.fillRect((x | 0) * CELL, (y | 0) * CELL, CELL, CELL);
}

/** 铺满整张：base 打底，extras 是 [[色值, 概率], ...] 的轻微质地变化。
    Minecraft 的块面是"基本均匀 + 少量噪点"，不是雪花屏——所以基色要占大头。 */
function field(ctx, rnd, base, extras = []) {
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      let r = rnd(), c = base;
      for (let i = 0; i < extras.length; i++) {
        if (r < extras[i][1]) { c = extras[i][0]; break; }
        r -= extras[i][1];
      }
      px(ctx, x, y, c);
    }
  }
}

/** 随机撒 n 个单像素点 */
function dots(ctx, rnd, n, color) {
  for (let i = 0; i < n; i++) px(ctx, (rnd() * GRID) | 0, (rnd() * GRID) | 0, color);
}

/** 随机撒 n 个 w×h 的小色块（比单像素更有"色斑"感） */
function blobs(ctx, rnd, n, color, w = 2, h = 2) {
  for (let i = 0; i < n; i++) {
    const x0 = (rnd() * (GRID - w)) | 0, y0 = (rnd() * (GRID - h)) | 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px(ctx, x0 + x, y0 + y, color);
  }
}

/** 填一个矩形（含端点的像素坐标） */
function rect(ctx, x0, y0, x1, y1, color) {
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) px(ctx, x, y, color);
}

/* ---------------- 12 张方块纹理 ----------------
   统一用 Minecraft 官方调色板；草地/树叶取鲜绿，石头取中性灰，
   木头取暖棕，砖取砖红 —— 保证在明亮天光下既有对比又不脏。 */

/** 草地（地面顶面）：鲜绿 + 细微明暗点 */
export function makeGrassTex() {
  const ctx = mk(), rnd = mulberry32(1001);
  field(ctx, rnd, '#7BB53C', [
    ['#8CC94A', 0.18],
    ['#6EA332', 0.16],
    ['#98D65A', 0.07]
  ]);
  // 少量深色草叶，打散"均匀色块"感
  dots(ctx, rnd, 16, '#5C8C28');
  return ctx.canvas;
}

/** 泥土：暖棕 + 深浅团块 */
export function makeDirtTex() {
  const ctx = mk(), rnd = mulberry32(1002);
  field(ctx, rnd, '#8B6239', [
    ['#9C7048', 0.20],
    ['#7A5330', 0.20],
    ['#A67C52', 0.08]
  ]);
  blobs(ctx, rnd, 6, '#6B4526', 2, 2);
  dots(ctx, rnd, 10, '#B08A60');
  return ctx.canvas;
}

/** 石头：中性灰 + 石斑（Minecraft 石头是灰不是黑） */
export function makeStoneTex() {
  const ctx = mk(), rnd = mulberry32(1003);
  field(ctx, rnd, '#8C8C8C', [
    ['#9C9C9C', 0.20],
    ['#7C7C7C', 0.20],
    ['#6E6E6E', 0.07]
  ]);
  blobs(ctx, rnd, 5, '#757575', 2, 2);
  blobs(ctx, rnd, 3, '#A6A6A6', 2, 1);
  dots(ctx, rnd, 8, '#666666');
  return ctx.canvas;
}

/** 木板：暖棕横纹 + 4 像素一组的板缝 */
export function makePlankTex() {
  const ctx = mk(), rnd = mulberry32(1004);
  field(ctx, rnd, '#A87B4A', [
    ['#B98C58', 0.20],
    ['#946B3E', 0.20]
  ]);
  // 板缝：每 4 行一条深色横缝
  for (let y = 0; y < GRID; y += 4) {
    for (let x = 0; x < GRID; x++) px(ctx, x, y, '#6B4A28');
  }
  // 木纹短线（在每条板内随机竖纹）
  for (let i = 0; i < 18; i++) {
    const x = (rnd() * GRID) | 0;
    const band = ((rnd() * 4) | 0) * 4;
    const y = band + 1 + ((rnd() * 2) | 0);
    px(ctx, x, y, '#7E5732');
  }
  return ctx.canvas;
}

/** 砖：错缝砖块（砖高 4px、砖宽 8px、缝 1px） */
export function makeBrickTex() {
  const ctx = mk(), rnd = mulberry32(1005);
  const brick = '#A8503E', brickL = '#B9604C', mortar = '#7A4034';
  field(ctx, rnd, brick, [[brickL, 0.22], ['#954537', 0.20]]);
  for (let row = 0; row < 4; row++) {
    const y0 = row * 4;
    // 横向灰缝
    for (let x = 0; x < GRID; x++) px(ctx, x, y0, mortar);
    // 竖向灰缝（隔行错开半块）
    const off = row % 2 ? 4 : 0;
    for (let x = off; x < GRID; x += 8) {
      for (let y = y0 + 1; y < y0 + 4; y++) px(ctx, x, y, mortar);
    }
  }
  dots(ctx, rnd, 8, '#C07060');
  return ctx.canvas;
}

/** 沙：明亮米黄 + 细点 */
export function makeSandTex() {
  const ctx = mk(), rnd = mulberry32(1006);
  field(ctx, rnd, '#DCD4A0', [
    ['#E8E0B0', 0.22],
    ['#CFC694', 0.22],
    ['#F0E8C0', 0.08]
  ]);
  dots(ctx, rnd, 14, '#BEB488');
  return ctx.canvas;
}

/** 树叶：鲜绿 + 密集叶隙（Minecraft 树叶要读得出"一簇簇叶子"） */
export function makeLeavesTex() {
  const ctx = mk(), rnd = mulberry32(1007);
  field(ctx, rnd, '#3C8C28', [
    ['#4CA336', 0.22],
    ['#2E7520', 0.22],
    ['#5CB03E', 0.08]
  ]);
  // 叶隙：深色小洞，制造通透感
  blobs(ctx, rnd, 7, '#1E5214', 2, 2);
  dots(ctx, rnd, 18, '#246418');
  return ctx.canvas;
}

/** 金属：亮银灰 + 横向拉丝高光 */
export function makeMetalTex() {
  const ctx = mk(), rnd = mulberry32(1008);
  field(ctx, rnd, '#C2C8D0', [
    ['#D6DCE4', 0.22],
    ['#A8AEB8', 0.22],
    ['#E8EEF6', 0.06]
  ]);
  // 横向高光条
  for (let i = 0; i < 4; i++) {
    const y = (rnd() * GRID) | 0;
    for (let x = 0; x < GRID; x++) px(ctx, x, y, '#E4EAF2');
  }
  dots(ctx, rnd, 8, '#8E949E');
  return ctx.canvas;
}

/** 砂岩：暖米色 + 水平层理 */
export function makeSandstoneTex() {
  const ctx = mk(), rnd = mulberry32(1009);
  field(ctx, rnd, '#D9CE9A', [
    ['#E4DAA8', 0.20],
    ['#C8BC86', 0.20]
  ]);
  // 层理：每 4 行一条略深横线
  for (let y = 3; y < GRID; y += 4) {
    for (let x = 0; x < GRID; x++) px(ctx, x, y, '#B8AC78');
  }
  dots(ctx, rnd, 10, '#AEA26E');
  return ctx.canvas;
}

/** 基岩：中深灰斑驳（不要纯黑——明亮卡通里纯黑会变成一大块突兀的黑墙） */
export function makeBedrockTex() {
  const ctx = mk(), rnd = mulberry32(1010);
  field(ctx, rnd, '#6E6E72', [
    ['#5E5E62', 0.24],
    ['#7E7E84', 0.24],
    ['#4E4E52', 0.10]
  ]);
  blobs(ctx, rnd, 6, '#48484C', 2, 2);
  blobs(ctx, rnd, 4, '#8E8E94', 2, 1);
  return ctx.canvas;
}

/** 红石：饱和砖红 + 明暗红斑 */
export function makeRedstoneTex() {
  const ctx = mk(), rnd = mulberry32(1011);
  field(ctx, rnd, '#B02222', [
    ['#C63030', 0.22],
    ['#8E1616', 0.22],
    ['#E05050', 0.08]
  ]);
  blobs(ctx, rnd, 5, '#7A1010', 2, 2);
  blobs(ctx, rnd, 4, '#F07070', 1, 2);
  return ctx.canvas;
}

/** 仙人掌：深绿 + 竖向棱线 + 白色刺点 */
export function makeCactusTex() {
  const ctx = mk(), rnd = mulberry32(1012);
  field(ctx, rnd, '#2E8B2E', [
    ['#379937', 0.24],
    ['#257525', 0.22]
  ]);
  // 竖棱
  for (const x of [0, 5, 10, 15]) {
    for (let y = 0; y < GRID; y++) px(ctx, x, y, '#1B5A1B');
  }
  // 刺
  dots(ctx, rnd, 12, '#DCE8C4');
  return ctx.canvas;
}

/* ---------------- 打包 ---------------- */
let cache = null;
export function buildAllTextures() {
  if (cache) return cache;
  cache = {
    grass: makeGrassTex(),
    dirt: makeDirtTex(),
    stone: makeStoneTex(),
    plank: makePlankTex(),
    brick: makeBrickTex(),
    sand: makeSandTex(),
    leaves: makeLeavesTex(),
    metal: makeMetalTex(),
    sandstone: makeSandstoneTex(),
    bedrock: makeBedrockTex(),
    redstone: makeRedstoneTex(),
    cactus: makeCactusTex()
  };
  return cache;
}

/** 像素风的过滤配置：放大取最近邻（硬边像素），缩小走 mipmap（避免远处摩尔纹闪烁） */
function pixelFilter(t) {
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestMipmapLinearFilter;
  t.generateMipmaps = true;
}

export function threeTex(canvasEl, repeat = 1) {
  const t = new THREE.CanvasTexture(canvasEl);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = ANISOTROPY;
  pixelFilter(t);
  texRefs.push(t);
  return t;
}

/* ---------------- 纹理图集：整个世界一批材质 ----------------
   把 12 张 256² 贴图打进一张图集，于是「所有方块类型」可以共用
   同一个材质 → 分块网格可以把整块地形合进 1 个 draw call。
   相邻格子刻意放相近材质（草/叶、石/砂岩），减少 mip 边缘串色。 */
export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 4;
export const ATLAS_TILE = 256;   // 单格内容尺寸
/** 每格四周的护栏宽度（设备像素）。
    像素风 + mipmap 缩小时，双线性会在格子边界采到隔壁材质 →
    远处出现"彩色描边"。护栏把边缘像素向外延伸，采样越界时仍然是本材质的颜色。 */
const ATLAS_PAD = 16;

/** 把一格内容 + 一圈边缘延伸画进图集 */
function blitPadded(ctx, src, dx, dy, size, pad) {
  // 中心内容
  ctx.drawImage(src, 0, 0, size, size, dx + pad, dy + pad, size, size);
  const N = 1; // 取 1 像素宽的边缘，向外拉伸填满护栏
  // 四边
  ctx.drawImage(src, 0, 0, size, N, dx + pad, dy, size, pad);
  ctx.drawImage(src, 0, size - N, size, N, dx + pad, dy + pad + size, size, pad);
  ctx.drawImage(src, 0, 0, N, size, dx, dy + pad, pad, size);
  ctx.drawImage(src, size - N, 0, N, size, dx + pad + size, dy + pad, pad, size);
  // 四角
  ctx.drawImage(src, 0, 0, N, N, dx, dy, pad, pad);
  ctx.drawImage(src, size - N, 0, N, N, dx + pad + size, dy, pad, pad);
  ctx.drawImage(src, 0, size - N, N, N, dx, dy + pad + size, pad, pad);
  ctx.drawImage(src, size - N, size - N, N, N, dx + pad + size, dy + pad + size, pad, pad);
}

/** 图集内的排布顺序（索引 = 槽位） */
export const ATLAS_ORDER = [
  'grass', 'leaves', 'dirt', 'sand',
  'stone', 'sandstone', 'plank', 'cactus',
  'brick', 'redstone', 'bedrock', 'metal'
];

let atlasCache = null;
export function buildAtlas() {
  if (atlasCache) return atlasCache;
  const src = buildAllTextures();
  const slotW = ATLAS_TILE + ATLAS_PAD * 2;
  const c = document.createElement('canvas');
  c.width = slotW * ATLAS_COLS;
  c.height = slotW * ATLAS_ROWS;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const uvOf = {};
  ATLAS_ORDER.forEach((name, i) => {
    const col = i % ATLAS_COLS;
    const row = (i / ATLAS_COLS) | 0;
    blitPadded(ctx, src[name], col * slotW, row * slotW, ATLAS_TILE, ATLAS_PAD);
    uvOf[name] = i;
  });
  atlasCache = { canvas: c, index: uvOf, slotW, pad: ATLAS_PAD };
  return atlasCache;
}

/** 取某张贴图在图集里的 UV 矩形（只取内容区，护栏不参与 UV）
 *  CanvasTexture 默认 flipY=true → 图集第 0 行映射到 v 的上方 */
export function atlasUV(name) {
  const A = buildAtlas();
  const i = A.index[name];
  if (i === undefined) return [0, 0, 1, 1];
  const W = A.slotW * ATLAS_COLS, H = A.slotW * ATLAS_ROWS;
  const col = i % ATLAS_COLS, row = (i / ATLAS_COLS) | 0;
  const u0 = (col * A.slotW + A.pad) / W;
  const u1 = (col * A.slotW + A.pad + ATLAS_TILE) / W;
  const v1 = 1 - (row * A.slotW + A.pad) / H;
  const v0 = 1 - (row * A.slotW + A.pad + ATLAS_TILE) / H;
  return [u0, v0, u1, v1];
}

/** 把图集包成 THREE 纹理（单例） */
let atlasTexRef = null;
export function atlasTexture(THREE_) {
  if (atlasTexRef) return atlasTexRef;
  const A = buildAtlas();
  const t = new THREE_.CanvasTexture(A.canvas);
  t.colorSpace = THREE_.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE_.ClampToEdgeWrapping;
  t.anisotropy = ANISOTROPY;
  pixelFilter(t);
  t.needsUpdate = true;
  atlasTexRef = t;
  texRefs.push(t);
  return t;
}
