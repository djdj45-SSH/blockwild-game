/* ============================================================
   mcModel.js — Minecraft 原版角色模型

   为什么单独一个文件：
     MC 的角色不是"纯色方块"——它是**带 UV 展开贴图的低模**。方块世界用顶点色
     就够了，但角色必须按 MC 的纹理布局（64×64 / 64×32 的皮肤图）精确切 UV，
     否则脸、衣服、花纹全对不上。这里实现的就是 MC 的 cube UV 规则。

   坐标系：
     MC 的模型 y 轴向下（脚在 y 大处），这里统一转成「脚底 y=0、向上为正」。
     1 MC 像素 = 1/16 格；玩家模型 32px，按 1.8 米高换算 → PX = 0.05625 米。

   纹理来源：tools/fetch-mc-textures.py 从官方 client jar 抽取 entity 纹理，
             再由图集脚本拼成单张 atlas（base64 内联）。
   ============================================================ */
import * as THREE from 'three';
import { ENTITY_PNG_B64, ENTITY_SLOTS, ENTITY_GRID } from './mc-entity-data.js';

const ATLAS_W = ENTITY_GRID.cols * ENTITY_GRID.tile;
const ATLAS_H = ENTITY_GRID.rows * ENTITY_GRID.tile;

/** 1 MC 像素对应的米数：模型 32px 高 → 1.8 米 */
export const PX = 1.8 / 32;

/* ---------------- 纹理 ---------------- */
let entTex = null;
let entPromise = null;
let nodeMode = false;      // 同 textures.js：Node 同步断言环境视为立即就绪

export function preloadEntityAtlas() {
  if (entPromise) return entPromise;
  // 同 textures.js：必须同时判 Image（测试环境的假 DOM 没有 Image）
  if (typeof document === 'undefined' || typeof Image === 'undefined') {
    nodeMode = true;
    entPromise = Promise.resolve(false);
    return entPromise;
  }
  entPromise = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      entTex = new THREE.Texture(img);
      entTex.colorSpace = THREE.SRGBColorSpace;
      // Minecraft 对实体纹理就是 mipmapping 0：点采样、不生成 mipmap。
      // 角色 UV 是跨整张皮肤精确切分的，相邻面紧挨着，mip 一混脸就花。
      entTex.magFilter = THREE.NearestFilter;
      entTex.minFilter = THREE.NearestFilter;
      entTex.generateMipmaps = false;
      entTex.wrapS = entTex.wrapT = THREE.ClampToEdgeWrapping;
      entTex.needsUpdate = true;
      entReady = true;
      resolve(true);
    };
    img.onerror = () => {
      if (typeof console !== 'undefined') console.error('[mc] 角色图集解码失败');
      resolve(false);
    };
    img.src = 'data:image/png;base64,' + ENTITY_PNG_B64;
  });
  return entPromise;
}

let entMat = null;
let entReady = false;

/** 角色图集是否已就绪（Node 环境视为就绪） */
export function entityReady() { return entReady || nodeMode; }

export function entityMaterial() {
  if (entMat) return entMat;
  entMat = new THREE.MeshStandardMaterial({
    map: entTex || null,
    roughness: 0.92,
    metalness: 0.0,
    alphaTest: 0.1,
    side: THREE.FrontSide
  });
  entMat.name = 'entity';
  return entMat;
}

/* ---------------- MC 的 cube UV 布局 ----------------
   给定皮肤图上的起点 (u,v) 和方块尺寸 (w,h,d)：
        ┌────┬────┬────┬────┐
        │    │ up │    │    │
        ├────┼────┼────┼────┤
        │ w  │ F  │ e  │ b  │
        ├────┼────┼────┼────┤
        │    │ dn │    │    │
        └────┴────┴────┴────┘
   w = west(-x)  F = north(-z，正面/脸)  e = east(+x)  b = south(+z) */
function cubeRects(w, h, d, u, v) {
  return {
    up: [u + d, v, w, d],
    down: [u + d, v + d + h, w, d],
    west: [u, v + d, d, h],
    north: [u + d, v + d, w, h],
    east: [u + d + w, v + d, d, h],
    south: [u + d + w + d, v + d, w, h]
  };
}

/* 面定义：法线 + 四个角（从外面看依序 左上/右上/右下/左下）+ 用哪个 UV 矩形 */
function faceDefs(hw, hh, hd, R) {
  return [
    // +x east：从 +x 看，+z 在左手边
    { n: [1, 0, 0], c: [[hw, hh, hd], [hw, hh, -hd], [hw, -hh, -hd], [hw, -hh, hd]], r: R.east },
    // -x west：从 -x 看，+z 在右手边
    { n: [-1, 0, 0], c: [[-hw, hh, -hd], [-hw, hh, hd], [-hw, -hh, hd], [-hw, -hh, -hd]], r: R.west },
    // +y up
    { n: [0, 1, 0], c: [[-hw, hh, -hd], [hw, hh, -hd], [hw, hh, hd], [-hw, hh, hd]], r: R.up },
    // -y down
    { n: [0, -1, 0], c: [[-hw, -hh, hd], [hw, -hh, hd], [hw, -hh, -hd], [-hw, -hh, -hd]], r: R.down },
    // +z south
    { n: [0, 0, 1], c: [[-hw, hh, hd], [hw, hh, hd], [hw, -hh, hd], [-hw, -hh, hd]], r: R.south },
    // -z north（脸）：从 -z 看，+x 在左手边
    { n: [0, 0, -1], c: [[hw, hh, -hd], [-hw, hh, -hd], [-hw, -hh, -hd], [hw, -hh, -hd]], r: R.north }
  ];
}

/**
 * 构造一个 MC 风格的贴图方块体。
 * @param w,h,d  尺寸（MC 像素）
 * @param u,v    该方块在皮肤图上的左上角（MC 像素坐标，图集坐标系）
 */
export function mcBoxGeo(w, h, d, u, v) {
  const W = w * PX, H = h * PX, D = d * PX;
  const hw = W / 2, hh = H / 2, hd = D / 2;
  const R = cubeRects(w, h, d, u, v);
  const faces = faceDefs(hw, hh, hd, R);

  const pos = [], nor = [], uv = [];
  const tri = [0, 2, 1, 0, 3, 2];      // 角点顺序是顺时针，翻成 CCW 才是正面

  for (const f of faces) {
    const [rx, ry, rw, rh] = f.r;
    // 角点(左上/右上/右下/左下) → 纹理四角
    const cu = [rx, rx + rw, rx + rw, rx];
    const cv = [ry, ry, ry + rh, ry + rh];
    for (const i of tri) {
      const c = f.c[i];
      pos.push(c[0], c[1], c[2]);
      nor.push(f.n[0], f.n[1], f.n[2]);
      // flipY：纹理第 0 行在 v=1
      uv.push(cu[i] / ATLAS_W, 1 - cv[i] / ATLAS_H);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nor), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(uv), 2));
  g.computeBoundingSphere();
  return g;
}

function mesh(w, h, d, u, v) {
  const m = new THREE.Mesh(mcBoxGeo(w, h, d, u, v), entityMaterial());
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/** 取皮肤槽位起点 */
function slot(name) {
  const s = ENTITY_SLOTS[name] || ENTITY_SLOTS.zombie || [0, 0];
  return s;
}

/* ---------------- 人形（玩家 / 僵尸 / 赫斯克 / 骷髅） ----------------
   节点名与旧模型完全一致（head / body / armL / armR / legL / legR），
   所以 animateHumanoid 不用改一行。

   slim=true 时手臂/腿细一圈（骷髅是 2×12×2），
   limb64=true 表示皮肤是 64×64（左臂/左腿有独立 UV 区），
   否则（64×32）左右肢体共用同一块 UV。 */
export function buildMcHumanoid(name, opts = {}) {
  const [u0, v0] = slot(name);
  const slim = !!opts.slim;
  const limb64 = !!opts.limb64;
  const aw = slim ? 2 : 4, ad = slim ? 2 : 4;       // 手臂宽/深
  const lw = slim ? 2 : 4, ld = slim ? 2 : 4;       // 腿宽/深

  const root = new THREE.Group();
  root.name = 'humanoid';

  // 头：挂在颈部（y=24px），绕颈部转 —— 和 MC 的 rotationPoint 一致
  const head = new THREE.Group(); head.name = 'head';
  head.position.set(0, 24 * PX, 0);
  root.add(head);
  const headMesh = mesh(8, 8, 8, u0, v0);
  headMesh.position.set(0, 4 * PX, 0);
  head.add(headMesh);

  // 身体（8×12×4，中心 y=18px）
  const body = mesh(8, 12, 4, u0 + 16, v0 + 16);
  body.position.set(0, 18 * PX, 0);
  root.add(body);

  // 手臂：肩部在 y=22px，x=±5px；方块中心相对肩部 (-sign, -4px)
  const armU = 40, armV = 16;
  const armLimbU = 32, armLimbV = 48;
  function arm(nm, sign, uvU, uvV) {
    const g = new THREE.Group(); g.name = nm;
    g.position.set(sign * 5 * PX, 22 * PX, 0);
    root.add(g);
    const m = mesh(aw, 12, ad, u0 + uvU, v0 + uvV);
    m.position.set(sign * -1 * PX, -4 * PX, 0);
    g.add(m);
    return g;
  }
  const armR = arm('armR', -1, armU, armV);
  const armL = arm('armL', 1, limb64 ? armLimbU : armU, limb64 ? armLimbV : armV);

  // 腿：髋部在 y=12px，x=±1.9px；方块中心相对髋部 (0, -6px)
  function leg(nm, sign, uvU, uvV) {
    const g = new THREE.Group(); g.name = nm;
    g.position.set(sign * 1.9 * PX, 12 * PX, 0);
    root.add(g);
    const m = mesh(lw, 12, ld, u0 + uvU, v0 + uvV);
    m.position.set(0, -6 * PX, 0);
    g.add(m);
    return g;
  }
  const legR = leg('legR', -1, 0, 16);
  const legL = leg('legL', 1, limb64 ? 16 : 0, limb64 ? 48 : 16);

  root.userData.anim = { head, armL, armR, legL, legR };
  root.userData.mcModel = true;
  return root;
}

/* ---------------- 苦力怕 ----------------
   MC 的 CreeperModel：头 8×8×8（y −2..6）／身 8×12×4（y 6..18）／
   四条腿 4×6×4（y 18..24，分别位于 x=±2, z=±4）。总高 26px。
   转成"脚底 0 向上"：头中心 22、身体中心 12、腿中心 3。 */
export function buildMcCreeper(name = 'creeper') {
  const [u0, v0] = slot(name);
  const root = new THREE.Group();
  root.name = 'creeper';
  const H = 26;                       // 总高（px）

  const head = new THREE.Group(); head.name = 'head';
  head.position.set(0, (H - 6) * PX, 0);
  root.add(head);
  const headMesh = mesh(8, 8, 8, u0, v0);
  headMesh.position.set(0, 4 * PX, 0);
  head.add(headMesh);

  const body = mesh(8, 12, 4, u0 + 16, v0 + 16);
  body.position.set(0, (H - 12) * PX, 0);
  root.add(body);

  const legs = [];
  const legPos = [[-2, 4], [2, 4], [-2, -4], [2, -4]];
  const legPivots = [];
  legPos.forEach((p, i) => {
    const g = new THREE.Group(); g.name = 'leg' + i;
    g.position.set(p[0] * PX, (H - 18) * PX, p[1] * PX);
    root.add(g);
    const m = mesh(4, 6, 4, u0 + 0, v0 + 16);
    m.position.set(0, -3 * PX, 0);
    g.add(m);
    legs.push(m);
    legPivots.push(g);
  });

  root.userData.anim = { head, body, legs: legPivots, creeper: true };
  root.userData.mcModel = true;
  return root;
}

/* ---------------- 蜘蛛 ----------------
   MC 的蜘蛛是 8 条双段腿，模型复杂度高。这里保留"头 + 胸 + 腹 + 8 条单段腿"
   的结构，比例与腿的分布按原版来（身体 6×6×6 心 + 8×8×8 头 + 前置 8 腿）。 */
export function buildMcSpider(name = 'spider') {
  const [u0, v0] = slot(name);
  const root = new THREE.Group();
  root.name = 'spider';

  // 头：MC 蜘蛛头部 UV (32, 4)
  const head = new THREE.Group(); head.name = 'head';
  head.position.set(0, 9 * PX, -(8 * PX));
  root.add(head);
  const headMesh = mesh(8, 8, 8, u0 + 32, v0 + 4);
  head.add(headMesh);

  // 胸（身体前段）：UV (0, 0) 8×8×8
  const thorax = mesh(8, 8, 8, u0 + 0, v0 + 0);
  thorax.position.set(0, 8 * PX, -1 * PX);
  root.add(thorax);

  // 腹（身体后段）：UV (0, 16) 6×6×6
  const abdo = mesh(6, 6, 6, u0 + 0, v0 + 16);
  abdo.position.set(0, 8 * PX, 7 * PX);
  root.add(abdo);

  // 8 条腿：左右各 4，沿身体前后分布；用 (18,0) 的腿纹理
  const legs = [];
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < 4; i++) {
      const z = (-6 + i * 4) * PX;
      const g = new THREE.Group();
      g.name = 'leg' + (side > 0 ? 'L' : 'R') + i;
      g.position.set(side * 3 * PX, 6 * PX, z);
      root.add(g);
      const m = mesh(1, 10, 1.6, u0 + 18, v0 + 0);
      m.position.set(side * 3 * PX, -2 * PX, 0);
      m.rotation.z = side * -0.9;
      g.add(m);
      const m2 = mesh(1, 9, 1.4, u0 + 18, v0 + 0);
      m2.position.set(side * 6.5 * PX, -6 * PX, 0);
      m2.rotation.z = side * 0.5;
      g.add(m2);
      legs.push(g);
    }
  }

  root.userData.anim = { head, legs, spider: true };
  root.userData.mcModel = true;
  return root;
}

/** 第一人称手臂：玩家皮肤里那一段 4×12×4 的右臂。
    每次新建几何体（不共享），配合武器模型的 __dynamicGeos 一起被释放。 */
export function buildArmGeo(name = 'steve') {
  const [u0, v0] = slot(name);
  return mcBoxGeo(4, 12, 4, u0 + 40, v0 + 16);
}

/** 手臂在"米制"武器模型里的换算系数：
    mcBoxGeo 输出用的是 PX = 1.8/32，而方块标准是 1/16 米 → 需要补偿。 */
export const ARM_TO_BLOCK = (1 / 16) / PX;
