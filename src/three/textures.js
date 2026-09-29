/* ============================================================
   textures.js — 程序化写实纹理（Canvas → THREE.CanvasTexture）
   目标：土感、噪点、砌缝、木纹；去高饱和像素块
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

function canvas(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}

function tex(c, repeat = 1) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = ANISOTROPY;
  texRefs.push(t);
  return t;
}

/** 多倍频值噪声 */
function noise2(x, y, seed) {
  const s = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

function fbm(x, y, seed, oct = 4) {
  let v = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) {
    const xi = Math.floor(x * f), yi = Math.floor(y * f);
    const fx = x * f - xi, fy = y * f - yi;
    const u = fx * fx * (3 - 2 * fx), w = fy * fy * (3 - 2 * fy);
    const n00 = noise2(xi, yi, seed + i);
    const n10 = noise2(xi + 1, yi, seed + i);
    const n01 = noise2(xi, yi + 1, seed + i);
    const n11 = noise2(xi + 1, yi + 1, seed + i);
    const nx0 = n00 * (1 - u) + n10 * u;
    const nx1 = n01 * (1 - u) + n11 * u;
    v += a * ((nx0 * (1 - w) + nx1 * w) * 2 - 1);
    a *= 0.5; f *= 2;
  }
  return v;
}

function fillNoise(ctx, size, base, amp, seed, oct = 4) {
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const n = fbm(x / size * 6, y / size * 6, seed, oct);
      const k = 1 + n * amp;
      const i = (y * size + x) * 4;
      d[i] = Math.min(255, Math.max(0, base[0] * k));
      d[i + 1] = Math.min(255, Math.max(0, base[1] * k));
      d[i + 2] = Math.min(255, Math.max(0, base[2] * k));
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

function speckle(ctx, size, n, color, rMin, rMax, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  for (let i = 0; i < n; i++) {
    const x = Math.random() * size, y = Math.random() * size;
    const r = rMin + Math.random() * (rMax - rMin);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(x, y, r, r * (0.6 + Math.random() * 0.8), Math.random() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export function makeGrassTex() {
  const S = 256, c = canvas(S), ctx = c.getContext('2d');
  fillNoise(ctx, S, [118, 148, 78], 0.28, 11, 5);
  speckle(ctx, S, 400, 'rgba(48,72,28,0.45)', 1, 5, 0.5);
  speckle(ctx, S, 280, 'rgba(110,140,60,0.35)', 1, 4, 0.45);
  speckle(ctx, S, 120, 'rgba(90,78,48,0.3)', 1, 6, 0.35);
  // 细草茎
  ctx.strokeStyle = 'rgba(40,60,22,0.25)';
  ctx.lineWidth = 1;
  for (let i = 0; i < 180; i++) {
    const x = Math.random() * S, y = Math.random() * S;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + (Math.random() - 0.5) * 6, y - 4 - Math.random() * 8);
    ctx.stroke();
  }
  return c;
}

export function makeDirtTex() {
  const S = 256, c = canvas(S), ctx = c.getContext('2d');
  fillNoise(ctx, S, [130, 98, 68], 0.28, 22, 5);
  speckle(ctx, S, 500, 'rgba(60,42,26,0.4)', 1, 7, 0.5);
  speckle(ctx, S, 200, 'rgba(130,100,70,0.35)', 1, 5, 0.4);
  return c;
}

export function makeStoneTex() {
  const S = 256, c = canvas(S), ctx = c.getContext('2d');
  fillNoise(ctx, S, [148, 148, 140], 0.2, 33, 5);
  // 砌缝
  ctx.strokeStyle = 'rgba(50,50,48,0.45)';
  ctx.lineWidth = 2;
  for (let y = 0; y < S; y += 32) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(S, y); ctx.stroke();
    const off = (y / 32) % 2 ? 16 : 0;
    for (let x = off; x < S; x += 48) {
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + 32); ctx.stroke();
    }
  }
  speckle(ctx, S, 300, 'rgba(80,80,76,0.35)', 1, 4, 0.4);
  speckle(ctx, S, 80, 'rgba(160,158,150,0.3)', 1, 3, 0.35);
  return c;
}

export function makePlankTex() {
  const S = 256, c = canvas(S), ctx = c.getContext('2d');
  fillNoise(ctx, S, [168, 132, 82], 0.2, 44, 4);
  // 木纹
  for (let y = 0; y < S; y += 2) {
    const n = fbm(0.4, y / S * 3, 44, 3);
    const g = 1 + n * 0.18;
    ctx.fillStyle = `rgba(${90 * g | 0},${64 * g | 0},${36 * g | 0},0.25)`;
    ctx.fillRect(0, y, S, 2);
  }
  // 板缝
  ctx.fillStyle = 'rgba(40,28,16,0.55)';
  for (let y = 0; y < S; y += 42) ctx.fillRect(0, y, S, 3);
  speckle(ctx, S, 100, 'rgba(160,120,70,0.25)', 2, 10, 0.3);
  return c;
}

export function makeBrickTex() {
  const S = 256, c = canvas(S), ctx = c.getContext('2d');
  fillNoise(ctx, S, [150, 88, 72], 0.24, 55, 4);
  const bh = 22, bw = 48;
  ctx.strokeStyle = 'rgba(70,50,42,0.55)';
  ctx.lineWidth = 3;
  for (let row = 0, y = 0; y < S; row++, y += bh) {
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(S, y); ctx.stroke();
    const off = row % 2 ? bw / 2 : 0;
    for (let x = off; x < S; x += bw) {
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y + bh); ctx.stroke();
    }
  }
  speckle(ctx, S, 250, 'rgba(140,70,55,0.3)', 1, 4, 0.35);
  return c;
}

export function makeSandTex() {
  const S = 256, c = canvas(S), ctx = c.getContext('2d');
  fillNoise(ctx, S, [210, 192, 148], 0.18, 66, 4);
  speckle(ctx, S, 400, 'rgba(150,130,90,0.3)', 1, 3, 0.4);
  speckle(ctx, S, 150, 'rgba(210,195,150,0.35)', 1, 2, 0.35);
  return c;
}

export function makeLeavesTex() {
  const S = 256, c = canvas(S), ctx = c.getContext('2d');
  fillNoise(ctx, S, [92, 128, 62], 0.3, 77, 5);
  speckle(ctx, S, 600, 'rgba(30,60,22,0.45)', 2, 8, 0.5);
  speckle(ctx, S, 200, 'rgba(80,120,48,0.35)', 2, 7, 0.4);
  return c;
}

export function makeMetalTex() {
  const S = 256, c = canvas(S), ctx = c.getContext('2d');
  fillNoise(ctx, S, [98, 102, 108], 0.16, 88, 3);
  // 拉丝
  for (let i = 0; i < 200; i++) {
    const y = Math.random() * S;
    ctx.fillStyle = `rgba(200,205,210,${0.04 + Math.random() * 0.08})`;
    ctx.fillRect(0, y, S, 1 + Math.random());
  }
  speckle(ctx, S, 80, 'rgba(40,42,46,0.35)', 1, 4, 0.35);
  return c;
}

export function makeSandstoneTex() {
  const S = 256, c = canvas(S), ctx = c.getContext('2d');
  fillNoise(ctx, S, [170, 148, 96], 0.22, 99, 4);
  ctx.strokeStyle = 'rgba(120,100,60,0.25)';
  ctx.lineWidth = 1;
  for (let y = 0; y < S; y += 18) {
    ctx.beginPath(); ctx.moveTo(0, y + Math.sin(y) * 2); ctx.lineTo(S, y + Math.cos(y * 0.2) * 2); ctx.stroke();
  }
  speckle(ctx, S, 200, 'rgba(140,120,80,0.3)', 1, 5, 0.35);
  return c;
}

export function makeBedrockTex() {
  const S = 256, c = canvas(S), ctx = c.getContext('2d');
  fillNoise(ctx, S, [88, 88, 94], 0.26, 111, 5);
  speckle(ctx, S, 300, 'rgba(20,20,24,0.5)', 2, 10, 0.5);
  speckle(ctx, S, 80, 'rgba(90,90,96,0.3)', 1, 4, 0.3);
  return c;
}

export function makeRedstoneTex() {
  const S = 256, c = canvas(S), ctx = c.getContext('2d');
  fillNoise(ctx, S, [100, 70, 64], 0.25, 122, 4);
  speckle(ctx, S, 120, 'rgba(180,40,30,0.55)', 2, 8, 0.55);
  speckle(ctx, S, 40, 'rgba(255,120,80,0.5)', 1, 4, 0.45);
  return c;
}

export function makeCactusTex() {
  const S = 256, c = canvas(S), ctx = c.getContext('2d');
  fillNoise(ctx, S, [58, 98, 48], 0.25, 133, 4);
  ctx.fillStyle = 'rgba(30,50,24,0.35)';
  for (let x = 0; x < S; x += 14) ctx.fillRect(x, 0, 4, S);
  return c;
}

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

export function threeTex(canvasEl, repeat = 1) {
  return tex(canvasEl, repeat);
}

/* ---------------- 纹理图集：整个世界一批材质 ----------------
   把 12 张 256² 贴图打进一张 1024² 图集，于是「所有方块类型」可以共用
   同一个材质 → 分块网格可以把整块地形合进 1 个 draw call。
   相邻格子刻意放相近材质（草/叶、石/砂岩），减少 mip 边缘串色。 */
export const ATLAS_COLS = 4;
export const ATLAS_ROWS = 4;
export const ATLAS_TILE = 256;
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
  const c = document.createElement('canvas');
  c.width = ATLAS_TILE * ATLAS_COLS;
  c.height = ATLAS_TILE * ATLAS_ROWS;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  const uvOf = {};
  ATLAS_ORDER.forEach((name, i) => {
    const col = i % ATLAS_COLS;
    const row = (i / ATLAS_COLS) | 0;
    ctx.drawImage(src[name], col * ATLAS_TILE, row * ATLAS_TILE);
    uvOf[name] = i;
  });
  atlasCache = { canvas: c, index: uvOf };
  return atlasCache;
}

/** 取某张贴图在图集里的 UV 矩形（含半像素内缩，抗采样串色）
 *  CanvasTexture 默认 flipY=true → 图集第 0 行映射到 v 的上方 */
export function atlasUV(name, inset = 1.5) {
  const A = buildAtlas();
  const i = A.index[name];
  if (i === undefined) return [0, 0, 1, 1];
  const W = ATLAS_TILE * ATLAS_COLS, H = ATLAS_TILE * ATLAS_ROWS;
  const col = i % ATLAS_COLS, row = (i / ATLAS_COLS) | 0;
  const u0 = (col * ATLAS_TILE + inset) / W;
  const u1 = ((col + 1) * ATLAS_TILE - inset) / W;
  const v1 = 1 - (row * ATLAS_TILE + inset) / H;
  const v0 = 1 - ((row + 1) * ATLAS_TILE - inset) / H;
  return [u0, v0, u1, v1];
}

/** 把图集包成 THREE 纹理（单例） */
let atlasTexRef = null;
export function atlasTexture(THREE) {
  if (atlasTexRef) return atlasTexRef;
  const A = buildAtlas();
  const t = new THREE.CanvasTexture(A.canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = ANISOTROPY;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  atlasTexRef = t;
  texRefs.push(t);
  return t;
}
