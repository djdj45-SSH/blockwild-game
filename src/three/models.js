/* ============================================================
   models.js — 程序化低模（方块卡通比例）
   性能约定（重要）：
   1) 几何体按尺寸缓存复用 —— 生成/销毁实体不再重复造 GPU 缓冲
   2) 每个"动画节点"内部的所有零件合并成 1 个顶点色网格 ——
      一只怪 20+ 个 draw call 压到 6 个，且全体共用同一个材质
   3) 被缓存的几何体打了 __shared 标记，disposeObject 不会误删
   ============================================================ */
import * as THREE from 'three';
import { PALETTE, MaterialLib, makeMetal, makeMat, makeTextured } from './materials.js';

const mats = new MaterialLib();

/** 全体共享的顶点色材质：合并后的网格都用它 */
export const VCOL_MAT = new THREE.MeshStandardMaterial({
  vertexColors: true,
  roughness: 0.86,
  metalness: 0.03,
  flatShading: false
});
VCOL_MAT.name = 'vcol';

/* ---------------- 几何体缓存 ---------------- */
const geoCache = new Map();
function cachedGeo(key, make) {
  let g = geoCache.get(key);
  if (!g) {
    g = make();
    g.userData.__shared = true;
    geoCache.set(key, g);
  }
  return g;
}
function boxGeo(w, h, d) {
  return cachedGeo(`b${w.toFixed(4)}_${h.toFixed(4)}_${d.toFixed(4)}`,
    () => new THREE.BoxGeometry(w, h, d));
}
function cylGeo(rt, rb, h, seg) {
  return cachedGeo(`c${rt.toFixed(4)}_${rb.toFixed(4)}_${h.toFixed(4)}_${seg}`,
    () => new THREE.CylinderGeometry(rt, rb, h, seg));
}

/* ---------------- 零件工厂（统一走顶点色，便于合并） ---------------- */
function withColor(geo, colorHex) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  const c = new THREE.Color(colorHex);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  if (!g.attributes.uv) {
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(n * 2), 2));
  }
  return g;
}

function part(geo, colorHex, x, y, z, parent) {
  const m = new THREE.Mesh(withColor(geo, colorHex), VCOL_MAT);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  if (parent) parent.add(m);
  return m;
}

function box(w, h, d, color, x = 0, y = 0, z = 0, parent = null, mat = null) {
  if (mat) {
    const g = new THREE.BoxGeometry(w, h, d);
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    m.castShadow = true; m.receiveShadow = true;
    if (parent) parent.add(m);
    return m;
  }
  return part(boxGeo(w, h, d), color, x, y, z, parent);
}

function cyl(rTop, rBot, h, color, x, y, z, parent, seg = 8, mat = null) {
  if (mat) {
    const g = new THREE.CylinderGeometry(rTop, rBot, h, seg);
    const m = new THREE.Mesh(g, mat);
    m.position.set(x, y, z);
    m.castShadow = true; m.receiveShadow = true;
    if (parent) parent.add(m);
    return m;
  }
  return part(cylGeo(rTop, rBot, h, seg), color, x, y, z, parent);
}

function group(name) {
  const g = new THREE.Group();
  g.name = name;
  return g;
}

/* ---------------- 合并：节点内部的零件 → 1 个网格 ---------------- */
function mergeChildren(node) {
  const kids = node.children.filter((c) => c.isMesh && !c.userData.__noMerge);
  if (kids.length <= 1) {
    if (kids.length === 1) { kids[0].castShadow = true; kids[0].receiveShadow = true; }
    return;
  }
  let total = 0;
  const prepared = [];
  for (const k of kids) {
    k.updateMatrix();
    const g = k.geometry.clone();
    g.applyMatrix4(k.matrix);
    prepared.push(g);
    total += g.attributes.position.count;
    // 零件自身的几何体是"一次性"的（withColor 产物），合并后必须释放
    if (!k.geometry.userData.__shared) k.geometry.dispose();
  }
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let off = 0;
  for (const g of prepared) {
    const n = g.attributes.position.count;
    pos.set(g.attributes.position.array, off * 3);
    nor.set(g.attributes.normal.array, off * 3);
    if (g.attributes.color) col.set(g.attributes.color.array, off * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, off * 2);
    off += n;
    g.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  merged.setAttribute('color', new THREE.BufferAttribute(col, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  merged.computeBoundingSphere();
  const mesh = new THREE.Mesh(merged, VCOL_MAT);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  for (const k of kids) node.remove(k);
  node.add(mesh);
}

/** 递归：把每个层级的直接子网格合并成一个 */
function mergeTree(node) {
  for (const c of node.children) if (c.isGroup) mergeTree(c);
  mergeChildren(node);
}

function finalize(root) {
  mergeTree(root);
  root.traverse((o) => { o.matrixAutoUpdate = true; });
  return root;
}

/* ---------------- 人形（方块卡通比例） ---------------- */
export function buildHumanoid(opts = {}) {
  const {
    shirt = PALETTE.playerShirts[0],
    skin = PALETTE.skin,
    skinDark = PALETTE.skinDark,
    limb = shirt,
    head = skin,
    eye = 0x1a1a18,
    height = 0.98,
    bulk = 1
  } = opts;

  const root = group('humanoid');
  const k = height / 0.98;
  const headH = 0.16 * k;
  const torsoH = 0.30 * k;
  const hipY = 0.34 * k;
  const shoulderY = hipY + torsoH;
  const headY = shoulderY + headH * 0.62;

  box(0.30 * bulk, 0.13 * k, 0.19 * bulk, limb, 0, hipY, 0, root);
  box(0.34 * bulk, torsoH, 0.19 * bulk, shirt, 0, hipY + torsoH * 0.45, 0, root);
  box(0.37 * bulk, 0.09 * k, 0.16 * bulk, shirt, 0, shoulderY - 0.02 * k, 0, root);
  box(0.05 * bulk, 0.05 * k, 0.02, 0x2a2a28, 0, hipY + torsoH * 0.85, 0.10, root);

  const headG = group('head');
  headG.position.set(0, headY, 0);
  root.add(headG);
  box(0.22, headH, 0.22, head, 0, 0, 0, headG);
  box(0.17, headH * 0.42, 0.19, skinDark, 0, -headH * 0.34, 0.008, headG);
  box(0.055, 0.035, 0.02, eye, -0.055, headH * 0.10, 0.115, headG);
  box(0.055, 0.035, 0.02, eye, 0.055, headH * 0.10, 0.115, headG);
  box(0.19, 0.028, 0.045, skinDark, 0, headH * 0.30, 0.095, headG);

  const armL = group('armL');
  armL.position.set(-0.205 * bulk, shoulderY - 0.03, 0);
  root.add(armL);
  part(boxGeo(0.105, 0.21 * k, 0.105), limb, 0, -0.105 * k, 0, armL);
  part(boxGeo(0.088, 0.19 * k, 0.088), skinDark, 0, -0.295 * k, 0, armL);
  part(boxGeo(0.095, 0.085, 0.095), skin, 0, -0.42 * k, 0, armL);

  const armR = group('armR');
  armR.position.set(0.205 * bulk, shoulderY - 0.03, 0);
  root.add(armR);
  part(boxGeo(0.105, 0.21 * k, 0.105), limb, 0, -0.105 * k, 0, armR);
  part(boxGeo(0.088, 0.19 * k, 0.088), skinDark, 0, -0.295 * k, 0, armR);
  part(boxGeo(0.095, 0.085, 0.095), skin, 0, -0.42 * k, 0, armR);

  const legL = group('legL');
  legL.position.set(-0.095 * bulk, hipY - 0.04, 0);
  root.add(legL);
  part(boxGeo(0.155, 0.23 * k, 0.155), limb, 0, -0.125 * k, 0, legL);
  part(boxGeo(0.118, 0.19 * k, 0.125), skinDark, 0, -0.33 * k, 0, legL);
  part(boxGeo(0.135, 0.06, 0.19), 0x3a3630, 0, -0.44 * k, 0.025, legL);

  const legR = group('legR');
  legR.position.set(0.095 * bulk, hipY - 0.04, 0);
  root.add(legR);
  part(boxGeo(0.155, 0.23 * k, 0.155), limb, 0, -0.125 * k, 0, legR);
  part(boxGeo(0.118, 0.19 * k, 0.125), skinDark, 0, -0.33 * k, 0, legR);
  part(boxGeo(0.135, 0.06, 0.19), 0x3a3630, 0, -0.44 * k, 0.025, legR);

  finalize(root);
  root.userData.anim = { head: headG, armL, armR, legL, legR, torso: root, walkPhase: 0 };
  return root;
}

export function buildPlayer(colorIdx = 0) {
  const shirt = PALETTE.playerShirts[colorIdx % PALETTE.playerShirts.length];
  return buildHumanoid({ shirt, limb: shirt, head: PALETTE.skin, eye: 0x1a1a18 });
}

export function buildZombie() {
  return buildHumanoid({
    shirt: PALETTE.zombie, limb: PALETTE.zombie, head: PALETTE.zombie,
    skinDark: PALETTE.zombieDark, eye: 0x203018
  });
}

export function buildHusk() {
  return buildHumanoid({
    shirt: PALETTE.husk, limb: PALETTE.husk, head: PALETTE.husk,
    skinDark: PALETTE.huskDark, eye: 0x282018, height: 1.34, bulk: 1.15
  });
}

export function buildSkeleton() {
  const root = group('skeleton');
  const bone = PALETTE.skeleton;
  const boneD = PALETTE.skeletonDark;
  const k = 0.90 / 0.98;

  box(0.17, 0.29 * k, 0.11, bone, 0, 0.50 * k, 0, root);
  for (let i = 0; i < 4; i++) {
    box(0.27 - i * 0.02, 0.03, 0.13, boneD, 0, 0.40 * k + i * 0.055, 0.01, root);
  }
  box(0.19, 0.08, 0.13, boneD, 0, 0.30 * k, 0, root);

  const headG = group('head');
  headG.position.set(0, 0.78 * k, 0);
  root.add(headG);
  box(0.19, 0.19, 0.19, bone, 0, 0, 0, headG);
  box(0.06, 0.05, 0.03, 0x101010, -0.05, 0.02, 0.10, headG);
  box(0.06, 0.05, 0.03, 0x101010, 0.05, 0.02, 0.10, headG);
  box(0.10, 0.03, 0.02, 0x101010, 0, -0.04, 0.10, headG);

  const armL = group('armL');
  armL.position.set(-0.185, 0.62 * k, 0);
  root.add(armL);
  part(boxGeo(0.058, 0.23 * k, 0.058), bone, 0, -0.115 * k, 0, armL);
  part(boxGeo(0.046, 0.19 * k, 0.046), bone, 0, -0.29 * k, 0, armL);

  const armR = group('armR');
  armR.position.set(0.185, 0.62 * k, 0);
  root.add(armR);
  part(boxGeo(0.058, 0.23 * k, 0.058), bone, 0, -0.115 * k, 0, armR);
  part(boxGeo(0.046, 0.19 * k, 0.046), bone, 0, -0.29 * k, 0, armR);

  const legL = group('legL');
  legL.position.set(-0.075, 0.28 * k, 0);
  root.add(legL);
  part(boxGeo(0.068, 0.23 * k, 0.068), bone, 0, -0.115 * k, 0, legL);
  part(boxGeo(0.052, 0.17 * k, 0.052), bone, 0, -0.29 * k, 0, legL);

  const legR = group('legR');
  legR.position.set(0.075, 0.28 * k, 0);
  root.add(legR);
  part(boxGeo(0.068, 0.23 * k, 0.068), bone, 0, -0.115 * k, 0, legR);
  part(boxGeo(0.052, 0.17 * k, 0.052), bone, 0, -0.29 * k, 0, legR);

  finalize(root);
  root.userData.anim = { head: headG, armL, armR, legL, legR, torso: root, walkPhase: 0 };
  return root;
}

export function buildCreeper() {
  const root = group('creeper');
  const body = PALETTE.creeper;
  const dark = PALETTE.creeperDark;

  box(0.36, 0.64, 0.30, body, 0, 0.52, 0, root);
  box(0.13, 0.19, 0.13, dark, -0.13, 0.62, 0.10, root);
  box(0.11, 0.15, 0.11, dark, 0.15, 0.40, -0.08, root);

  const headG = group('head');
  headG.position.set(0, 1.02, 0);
  root.add(headG);
  box(0.36, 0.34, 0.36, body, 0, 0, 0, headG);
  box(0.09, 0.09, 0.02, 0x0c120c, -0.095, 0.05, 0.19, headG);
  box(0.09, 0.09, 0.02, 0x0c120c, 0.095, 0.05, 0.19, headG);
  box(0.09, 0.15, 0.02, 0x0c120c, 0, -0.05, 0.19, headG);
  box(0.075, 0.12, 0.02, 0x0c120c, -0.115, -0.085, 0.19, headG);
  box(0.075, 0.12, 0.02, 0x0c120c, 0.115, -0.085, 0.19, headG);

  const legs = [];
  let li = 0;
  for (const [sx, sz] of [[-0.115, -0.10], [0.115, -0.10], [-0.115, 0.10], [0.115, 0.10]]) {
    const leg = group('leg' + li++);
    leg.position.set(sx, 0.22, sz);
    root.add(leg);
    part(boxGeo(0.125, 0.27, 0.125), dark, 0, -0.085, 0, leg);
    part(boxGeo(0.14, 0.05, 0.16), 0x3a4a30, 0, -0.23, 0.01, leg);
    legs.push(leg);
  }

  finalize(root);
  root.userData.anim = {
    head: headG, armL: legs[0], armR: legs[1], legL: legs[2], legR: legs[3],
    torso: root, walkPhase: 0, isCreeper: true
  };
  return root;
}

export function buildSpider() {
  const root = group('spider');
  const body = PALETTE.spider;
  const light = PALETTE.spiderLight;

  box(0.50, 0.34, 0.62, body, 0, 0.30, -0.19, root);
  box(0.17, 0.10, 0.21, light, 0, 0.36, -0.29, root);

  const headG = group('head');
  headG.position.set(0, 0.30, 0.18);
  root.add(headG);
  box(0.25, 0.19, 0.23, body, 0, 0, 0, headG);
  box(0.05, 0.05, 0.03, 0xc02020, -0.07, 0.03, 0.125, headG);
  box(0.05, 0.05, 0.03, 0xc02020, 0.07, 0.03, 0.125, headG);
  box(0.03, 0.03, 0.03, 0xc02020, -0.125, 0.07, 0.105, headG);
  box(0.03, 0.03, 0.03, 0xc02020, 0.125, 0.07, 0.105, headG);
  box(0.05, 0.06, 0.08, 0x1a1018, -0.07, -0.06, 0.16, headG);
  box(0.05, 0.06, 0.08, 0x1a1018, 0.07, -0.06, 0.16, headG);

  const legs = [];
  for (let i = 0; i < 4; i++) {
    const z = -0.16 + i * 0.12;
    for (const side of [-1, 1]) {
      const leg = group('spiderLeg');
      leg.position.set(side * 0.16, 0.28, z);
      root.add(leg);
      const u = part(boxGeo(0.055, 0.23, 0.055), body, side * 0.12, 0.02, 0, leg);
      u.rotation.z = side * -0.9;
      const l = part(boxGeo(0.044, 0.23, 0.044), body, side * 0.28, -0.12, 0, leg);
      l.rotation.z = side * 0.35;
      legs.push(leg);
    }
  }

  finalize(root);
  root.userData.anim = {
    head: headG, armL: legs[0], armR: legs[1], legL: legs[2], legR: legs[3],
    legs, torso: root, walkPhase: 0, isSpider: true
  };
  return root;
}

/* ---------------- 武器视模（不合并，保留金属/自发光材质） ----------------
   血泪结论：
   ① 材质 color 会与贴图相乘 → 贴图已带最终色时 color 一律用近似白，
      否则木色贴图 × 木色 ≈ 深褐，整个枪糊成一坨看不出结构。
   ② 视模不能做成"高金属度"：金属没有漫反射，背光/阴影里会直接变黑。
      卡通风格下用低金属度 + 亮基色，保证任何光照下都读得出枪形。
   ③ userData.muzzle 必须落在枪管末端：枪口火焰挂在 weaponRoot 上（不随
      武器缩放），ensureWeapon 会用它按 0.75 缩放换算出火焰位置。
      曾经两处各写各的坐标 → 火焰飘在枪管前方半米，像个白方块。 */
let weaponMats = null;
function wmats() {
  if (!weaponMats) {
    weaponMats = {
      iron: makeTextured('metal', 0xc0c6ce, 1, { metalness: 0.2, roughness: 0.58 }),
      dark: makeTextured('metal', 0x7e858e, 1, { metalness: 0.18, roughness: 0.62 }),
      wood: makeTextured('plank', 0xffffff, 1, { roughness: 0.78 }),
      woodD: makeTextured('plank', 0xb08858, 1, { roughness: 0.82 }),
      obsidian: makeTextured('bedrock', 0x8a86a8, 1, { metalness: 0.35, roughness: 0.4 }),
      redstone: makeTextured('redstone', 0xffffff, 1, {
        metalness: 0.35, roughness: 0.42,
        emissive: 0xc02020, emissiveIntensity: 0.32
      }),
      // 发光件不能给满：emissive 与 diffuse 是叠加的，红色通道最先饱和，
      // 强度拉满时熔岩管会糊成一块纯橙色塑料，纹理细节全丢。
      hot: makeMat(0xd87828, { emissive: 0xb84808, emissiveIntensity: 0.30 }),
      magma: makeTextured('redstone', 0xd07848, 1, {
        metalness: 0.25, roughness: 0.55,
        emissive: 0xd84808, emissiveIntensity: 0.22
      }),
      lapis: makeTextured('metal', 0x6a8ae8, 1, { metalness: 0.45, roughness: 0.4 })
    };
  }
  return weaponMats;
}

export function buildWeaponView(kind = 'pistol') {
  const root = group('weapon');
  const M = wmats();
  const bw = (w, h, d, x, y, z, mat) => box(w, h, d, 0, x, y, z, root, mat);

  if (kind === 'shotgun') {
    // 长枪：木托 + 单管 + 下挂弹仓 + 护木
    bw(0.090, 0.115, 0.26, 0, -0.055, 0.19, M.wood);     // 枪托
    bw(0.100, 0.115, 0.20, 0, -0.005, 0.01, M.dark);     // 机匣
    bw(0.058, 0.058, 0.36, 0, 0.035, -0.30, M.iron);     // 枪管
    bw(0.044, 0.044, 0.30, 0, -0.030, -0.27, M.dark);    // 弹仓管
    bw(0.082, 0.062, 0.20, 0, -0.045, -0.20, M.woodD);   // 护木
    const g1 = bw(0.078, 0.135, 0.10, 0, -0.140, 0.10, M.woodD);  // 握把
    g1.rotation.x = -0.24;
    bw(0.016, 0.030, 0.022, 0, 0.078, -0.44, M.dark);    // 准星
    root.userData.muzzle = new THREE.Vector3(0, 0.035, -0.48);
  } else if (kind === 'pulse' || kind === 'redstone') {
    // 能量枪：暗色枪身 + 发光红石导轨 + 灼热枪口
    const g2 = bw(0.088, 0.160, 0.115, 0, -0.155, 0.05, M.dark);  // 握把
    g2.rotation.x = -0.26;
    bw(0.115, 0.150, 0.34, 0, -0.015, -0.08, M.obsidian);// 枪身
    bw(0.060, 0.050, 0.30, 0, 0.082, -0.30, M.redstone); // 能量导轨
    bw(0.072, 0.072, 0.06, 0, 0.082, -0.475, M.hot);     // 枪口核心
    bw(0.135, 0.050, 0.18, 0, 0.132, -0.06, M.redstone); // 散热罩
    bw(0.040, 0.075, 0.14, -0.078, 0.020, -0.22, M.dark);// 侧翼
    bw(0.040, 0.075, 0.14, 0.078, 0.020, -0.22, M.dark);
    root.userData.muzzle = new THREE.Vector3(0, 0.082, -0.505);
  } else if (kind === 'sniper' || kind === 'lapis') {
    // 狙击：长枪管 + 蓝宝石瞄准镜 + 木托
    bw(0.088, 0.110, 0.22, 0, -0.060, 0.20, M.wood);     // 枪托
    bw(0.085, 0.120, 0.28, 0, -0.005, -0.03, M.dark);    // 机匣
    bw(0.052, 0.052, 0.42, 0, 0.035, -0.31, M.iron);     // 枪管
    bw(0.065, 0.065, 0.05, 0, 0.035, -0.50, M.dark);     // 枪口制退器
    bw(0.070, 0.070, 0.22, 0, 0.125, -0.16, M.lapis);    // 瞄准镜
    bw(0.028, 0.075, 0.09, 0, 0.075, -0.11, M.dark);     // 镜架
    const g3 = bw(0.080, 0.140, 0.10, 0, -0.140, 0.07, M.woodD);   // 握把
    g3.rotation.x = -0.28;
    root.userData.muzzle = new THREE.Vector3(0, 0.035, -0.525);
  } else if (kind === 'magma' || kind === 'lava') {
    // 熔岩枪：厚实枪身 + 灼热熔岩管 + 侧散热口
    const g4 = bw(0.090, 0.170, 0.12, 0, -0.160, 0.06, M.woodD);   // 握把
    g4.rotation.x = -0.26;
    bw(0.130, 0.160, 0.30, 0, -0.015, -0.06, M.dark);    // 枪身
    bw(0.100, 0.100, 0.24, 0, 0.035, -0.29, M.magma);    // 熔岩管
    bw(0.088, 0.088, 0.07, 0, 0.035, -0.45, M.hot);      // 枪口
    bw(0.040, 0.060, 0.12, -0.085, 0.035, -0.16, M.dark);// 侧散热口
    bw(0.040, 0.060, 0.12, 0.085, 0.035, -0.16, M.dark);
    root.userData.muzzle = new THREE.Vector3(0, 0.035, -0.485);
  } else {
    // 手枪：细长套筒 + 薄机匣 + 细枪管 + 前后瞄具 + 后倾握把。
    // 结构分层（银/灰/木三色对比）+ 握把后倾角 = "枪感"；
    // 全灰 + 竖直握把曾经看起来就是一座积木塔。
    const grip = bw(0.082, 0.175, 0.100, 0, -0.140, 0.035, M.woodD);
    grip.rotation.x = -0.26;
    bw(0.092, 0.105, 0.240, 0, -0.010, -0.075, M.dark);   // 机匣
    bw(0.072, 0.046, 0.290, 0, 0.070, -0.095, M.iron);    // 套筒
    bw(0.042, 0.042, 0.240, 0, 0.028, -0.345, M.iron);    // 枪管（伸出足够长才看得见）
    bw(0.014, 0.026, 0.020, 0, 0.103, -0.230, M.dark);    // 准星
    bw(0.044, 0.020, 0.024, 0, 0.098, 0.015, M.dark);     // 照门
    bw(0.024, 0.044, 0.060, 0, -0.070, -0.010, M.dark);   // 扳机护圈
    bw(0.086, 0.020, 0.105, 0, -0.222, 0.035, M.dark);    // 弹匣底
    root.userData.muzzle = new THREE.Vector3(0, 0.028, -0.465);
  }

  root.userData.__dynamicGeos = true;   // 这些几何体是新建的，可以安全释放
  return root;
}

/* ---------------- 道具（合并成 1 个网格） ---------------- */
export function buildPickup(kind = 'ammo') {
  const root = group('pickup');
  if (kind === 'health' || kind === 'med') {
    box(0.30, 0.16, 0.22, PALETTE.health, 0, 0, 0, root);
    box(0.10, 0.04, 0.10, 0xe8e0d8, 0, 0.11, 0.10, root);
    box(0.22, 0.04, 0.06, 0xe8e0d8, 0, 0.11, 0.10, root);
    box(0.32, 0.02, 0.24, PALETTE.iron, 0, -0.08, 0, root);
  } else if (kind === 'armor') {
    box(0.26, 0.28, 0.16, 0x4a6a8a, 0, 0, 0, root);
    box(0.14, 0.10, 0.06, 0xc8d8e8, 0, 0.10, 0.08, root);
    box(0.28, 0.06, 0.18, 0x3a5068, 0, 0.12, -0.02, root);
  } else if (kind === 'shotgun_ammo' || kind === 'shells') {
    box(0.26, 0.14, 0.20, PALETTE.wood, 0, 0, 0, root);
    for (let i = -1; i <= 1; i += 2) {
      part(cylGeo(0.035, 0.035, 0.12, 8), 0xb86828, i * 0.08, 0.12, 0, root);
      part(cylGeo(0.035, 0.035, 0.03, 8), PALETTE.gold, i * 0.08, 0.18, 0, root);
    }
  } else if (kind === 'chest') {
    box(0.40, 0.26, 0.28, PALETTE.wood, 0, 0, 0, root);
    box(0.42, 0.10, 0.30, PALETTE.wood, 0, 0.16, 0, root);
    box(0.42, 0.03, 0.30, PALETTE.ironDark, 0, 0.07, 0, root);
    box(0.08, 0.10, 0.05, PALETTE.gold, 0, 0.02, 0.15, root);
    box(0.42, 0.04, 0.06, PALETTE.ironDark, 0, -0.06, 0, root);
    box(0.42, 0.04, 0.06, PALETTE.ironDark, 0, 0.06, 0, root);
  } else {
    box(0.22, 0.14, 0.16, PALETTE.ammo, 0, 0, 0, root);
    for (let i = -1; i <= 1; i += 2) {
      box(0.05, 0.10, 0.05, PALETTE.iron, i * 0.05, 0.11, 0, root);
    }
  }
  finalize(root);
  return root;
}

export function buildBoneProjectile() {
  const root = group('bone');
  box(0.07, 0.07, 0.18, 0xd8d4c0, 0, 0, 0, root);
  box(0.10, 0.08, 0.06, 0xc8c4b0, 0, 0, 0.10, root);
  box(0.10, 0.08, 0.06, 0xc8c4b0, 0, 0, -0.10, root);
  finalize(root);
  return root;
}

/* ---------------- 动画 ---------------- */
export function animateHumanoid(mesh, t, speed = 1, mode = 'walk') {
  const a = mesh.userData && mesh.userData.anim;
  if (!a) return;

  if (mode === 'dead') {
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.12;
    if (a.legL) a.legL.rotation.x = 0.25;
    if (a.legR) a.legR.rotation.x = -0.25;
    if (a.armL) a.armL.rotation.x = 0.7;
    if (a.armR) a.armR.rotation.x = 0.7;
    return;
  }
  mesh.rotation.x = 0;

  const phase = t * 7.5 * speed + (a.walkPhase || 0);
  const swing = Math.sin(phase) * 0.5 * speed;
  const bob = Math.abs(Math.sin(phase)) * 0.022 * speed;

  if (a.legL) a.legL.rotation.x = swing;
  if (a.legR) a.legR.rotation.x = -swing;
  if (a.armL) a.armL.rotation.x = -swing * 0.75;
  if (a.armR) a.armR.rotation.x = swing * 0.75;
  if (a.head) a.head.rotation.y = Math.sin(phase * 0.45) * 0.07;

  if (mode === 'attack') {
    if (a.armR) a.armR.rotation.x = -1.15;
    if (a.armL) a.armL.rotation.x = -0.95;
  }
  mesh.position.y = bob + (mode === 'hurt' ? 0.015 : 0);
}

export function animateSpider(mesh, t, speed = 1) {
  const a = mesh.userData && mesh.userData.anim;
  if (!a || !a.legs) return;
  const phase = t * 9 * speed;
  for (let i = 0; i < a.legs.length; i++) {
    const side = i % 2 === 0 ? 1 : -1;
    a.legs[i].rotation.x = Math.sin(phase + i * 0.85) * 0.32 * speed * side;
    a.legs[i].rotation.y = Math.sin(phase * 0.5 + i) * 0.12;
  }
  mesh.position.y = Math.abs(Math.sin(phase)) * 0.018;
}

export function buildEnemy(type) {
  switch (type) {
    case 'husk': return buildHusk();
    case 'skeleton': return buildSkeleton();
    case 'creeper': return buildCreeper();
    case 'spider': return buildSpider();
    case 'zombie':
    default: return buildZombie();
  }
}

/** 只释放"独占"的几何体；缓存复用与共享材质一律跳过 */
export function disposeObject(obj) {
  obj.traverse((n) => {
    const g = n.geometry;
    if (g && !g.userData.__shared) g.dispose();
  });
}

export { mats as sharedMats };
