/* ============================================================
   models.js — 写实比例程序化模型
   人形 7.5 头身、锥形肢体；枪械分段更细
   ============================================================ */
import * as THREE from 'three';
import { PALETTE, MaterialLib, makeMetal, makeMat, makeTextured } from './materials.js';

const mats = new MaterialLib();

function box(w, h, d, color, x = 0, y = 0, z = 0, parent = null, mat = null) {
  const g = new THREE.BoxGeometry(w, h, d);
  const m = new THREE.Mesh(g, mat || mats.get(color));
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  if (parent) parent.add(m);
  return m;
}

function cyl(rTop, rBot, h, color, x, y, z, parent, seg = 8, mat = null) {
  const g = new THREE.CylinderGeometry(rTop, rBot, h, seg);
  const m = new THREE.Mesh(g, mat || mats.get(color));
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  if (parent) parent.add(m);
  return m;
}

function group(name) {
  const g = new THREE.Group();
  g.name = name;
  return g;
}

/* ---------------- 人形（写实比例） ---------------- */
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
  // 7.5 头身近似：头高 ≈ height/7.5，躯干中段
  const headH = 0.14 * k;
  const torsoH = 0.32 * k;
  const hipY = 0.34 * k;
  const shoulderY = hipY + torsoH;
  const headY = shoulderY + headH * 0.65;

  // 骨盆
  box(0.28 * bulk, 0.12 * k, 0.18 * bulk, limb, 0, hipY, 0, root);
  // 胸腔（略宽于腰）
  const torso = box(0.32 * bulk, torsoH, 0.18 * bulk, shirt, 0, hipY + torsoH * 0.45, 0, root);
  // 肩带
  box(0.34 * bulk, 0.08 * k, 0.15 * bulk, shirt, 0, shoulderY - 0.02 * k, 0, root);

  // 头（圆角感：盒 + 下巴）
  const headG = group('head');
  headG.position.set(0, headY, 0);
  root.add(headG);
  box(0.20, headH, 0.20, head, 0, 0, 0, headG);
  box(0.16, 0.08, 0.18, skinDark, 0, -0.06, 0.01, headG); // 下颌
  // 眼窝
  box(0.055, 0.03, 0.02, eye, -0.05, 0.02, 0.11, headG);
  box(0.055, 0.03, 0.02, eye, 0.05, 0.02, 0.11, headG);
  // 眉弓
  box(0.18, 0.025, 0.04, skinDark, 0, 0.05, 0.09, headG);

  // 手臂：上臂锥、前臂、手
  const armL = group('armL');
  armL.position.set(-0.19 * bulk, shoulderY - 0.02, 0);
  root.add(armL);
  cyl(0.048, 0.042, 0.20 * k, limb, 0, -0.10 * k, 0, armL, 7);
  cyl(0.042, 0.038, 0.18 * k, skinDark, 0, -0.28 * k, 0, armL, 7);
  box(0.07, 0.08, 0.06, skin, 0, -0.40 * k, 0, armL);

  const armR = group('armR');
  armR.position.set(0.19 * bulk, shoulderY - 0.02, 0);
  root.add(armR);
  cyl(0.048, 0.042, 0.20 * k, limb, 0, -0.10 * k, 0, armR, 7);
  cyl(0.042, 0.038, 0.18 * k, skinDark, 0, -0.28 * k, 0, armR, 7);
  box(0.07, 0.08, 0.06, skin, 0, -0.40 * k, 0, armR);

  // 腿：大腿、小腿、靴
  const legL = group('legL');
  legL.position.set(-0.09 * bulk, hipY - 0.04, 0);
  root.add(legL);
  cyl(0.075, 0.055, 0.22 * k, limb, 0, -0.12 * k, 0, legL, 7);
  cyl(0.05, 0.042, 0.18 * k, skinDark, 0, -0.32 * k, 0, legL, 7);
  box(0.10, 0.06, 0.16, 0x2a2824, 0, -0.43 * k, 0.03, legL);

  const legR = group('legR');
  legR.position.set(0.09 * bulk, hipY - 0.04, 0);
  root.add(legR);
  cyl(0.075, 0.055, 0.22 * k, limb, 0, -0.12 * k, 0, legR, 7);
  cyl(0.05, 0.042, 0.18 * k, skinDark, 0, -0.32 * k, 0, legR, 7);
  box(0.10, 0.06, 0.16, 0x2a2824, 0, -0.43 * k, 0.03, legR);

  root.userData.anim = { head: headG, armL, armR, legL, legR, torso, walkPhase: 0 };
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

  box(0.16, 0.28 * k, 0.10, bone, 0, 0.50 * k, 0, root);
  for (let i = 0; i < 4; i++) {
    box(0.26 - i * 0.02, 0.03, 0.12, boneD, 0, 0.40 * k + i * 0.055, 0.01, root);
  }
  box(0.18, 0.08, 0.12, boneD, 0, 0.30 * k, 0, root);

  const headG = group('head');
  headG.position.set(0, 0.78 * k, 0);
  root.add(headG);
  box(0.18, 0.18, 0.18, bone, 0, 0, 0, headG);
  box(0.06, 0.05, 0.03, 0x101010, -0.05, 0.02, 0.10, headG);
  box(0.06, 0.05, 0.03, 0x101010, 0.05, 0.02, 0.10, headG);
  box(0.10, 0.03, 0.02, 0x101010, 0, -0.04, 0.10, headG);

  const armL = group('armL');
  armL.position.set(-0.18, 0.62 * k, 0);
  root.add(armL);
  cyl(0.028, 0.022, 0.22 * k, bone, 0, -0.11 * k, 0, armL, 6);
  cyl(0.022, 0.018, 0.18 * k, bone, 0, -0.28 * k, 0, armL, 6);

  const armR = group('armR');
  armR.position.set(0.18, 0.62 * k, 0);
  root.add(armR);
  cyl(0.028, 0.022, 0.22 * k, bone, 0, -0.11 * k, 0, armR, 6);
  cyl(0.022, 0.018, 0.18 * k, bone, 0, -0.28 * k, 0, armR, 6);

  const legL = group('legL');
  legL.position.set(-0.07, 0.28 * k, 0);
  root.add(legL);
  cyl(0.032, 0.026, 0.22 * k, bone, 0, -0.11 * k, 0, legL, 6);
  cyl(0.024, 0.02, 0.16 * k, bone, 0, -0.28 * k, 0, legL, 6);

  const legR = group('legR');
  legR.position.set(0.07, 0.28 * k, 0);
  root.add(legR);
  cyl(0.032, 0.026, 0.22 * k, bone, 0, -0.11 * k, 0, legR, 6);
  cyl(0.024, 0.02, 0.16 * k, bone, 0, -0.28 * k, 0, legR, 6);

  root.userData.anim = { head: headG, armL, armR, legL, legR, torso: root, walkPhase: 0 };
  return root;
}

export function buildCreeper() {
  const root = group('creeper');
  const body = PALETTE.creeper;
  const dark = PALETTE.creeperDark;

  cyl(0.16, 0.18, 0.62, body, 0, 0.52, 0, root, 8);
  // 皮肤斑块
  box(0.12, 0.18, 0.12, dark, -0.12, 0.62, 0.10, root);
  box(0.10, 0.14, 0.10, dark, 0.14, 0.40, -0.08, root);

  const headG = group('head');
  headG.position.set(0, 1.00, 0);
  root.add(headG);
  box(0.34, 0.32, 0.34, body, 0, 0, 0, headG);
  // 经典面
  box(0.08, 0.08, 0.02, 0x0c120c, -0.09, 0.05, 0.18, headG);
  box(0.08, 0.08, 0.02, 0x0c120c, 0.09, 0.05, 0.18, headG);
  box(0.08, 0.14, 0.02, 0x0c120c, 0, -0.05, 0.18, headG);
  box(0.07, 0.11, 0.02, 0x0c120c, -0.11, -0.08, 0.18, headG);
  box(0.07, 0.11, 0.02, 0x0c120c, 0.11, -0.08, 0.18, headG);

  const legs = [];
  for (const [sx, sz] of [[-0.11, -0.10], [0.11, -0.10], [-0.11, 0.10], [0.11, 0.10]]) {
    const leg = group('leg');
    leg.position.set(sx, 0.22, sz);
    root.add(leg);
    cyl(0.06, 0.05, 0.26, dark, 0, -0.08, 0, leg, 7);
    box(0.12, 0.05, 0.14, 0x1a2218, 0, -0.22, 0.01, leg);
    legs.push(leg);
  }

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

  // 腹部
  const ab = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), mats.get(body));
  ab.position.set(0, 0.30, -0.18);
  ab.scale.set(1.1, 0.75, 1.35);
  ab.castShadow = true;
  root.add(ab);
  box(0.16, 0.10, 0.20, light, 0, 0.36, -0.28, root);

  const headG = group('head');
  headG.position.set(0, 0.30, 0.18);
  root.add(headG);
  box(0.24, 0.18, 0.22, body, 0, 0, 0, headG);
  box(0.05, 0.05, 0.03, 0xc02020, -0.07, 0.03, 0.12, headG);
  box(0.05, 0.05, 0.03, 0xc02020, 0.07, 0.03, 0.12, headG);
  box(0.03, 0.03, 0.03, 0xc02020, -0.12, 0.07, 0.10, headG);
  box(0.03, 0.03, 0.03, 0xc02020, 0.12, 0.07, 0.10, headG);
  // 螯肢
  box(0.05, 0.06, 0.08, 0x1a1018, -0.07, -0.06, 0.16, headG);
  box(0.05, 0.06, 0.08, 0x1a1018, 0.07, -0.06, 0.16, headG);

  const legs = [];
  for (let i = 0; i < 4; i++) {
    const z = -0.16 + i * 0.12;
    for (const side of [-1, 1]) {
      const leg = group('spiderLeg');
      leg.position.set(side * 0.16, 0.28, z);
      root.add(leg);
      const u = cyl(0.025, 0.02, 0.22, body, side * 0.12, 0.02, 0, leg, 6);
      u.rotation.z = side * -0.9;
      const l = cyl(0.02, 0.015, 0.22, body, side * 0.28, -0.12, 0, leg, 6);
      l.rotation.z = side * 0.35;
      legs.push(leg);
    }
  }

  root.userData.anim = {
    head: headG, armL: legs[0], armR: legs[1], legL: legs[2], legR: legs[3],
    legs, torso: root, walkPhase: 0, isSpider: true
  };
  return root;
}

/* ---------------- 武器视模（写实分段） ---------------- */
export function buildWeaponView(kind = 'pistol') {
  const root = group('weapon');
  const ironM = () => makeMetal(PALETTE.iron);
  const darkM = () => makeMetal(PALETTE.ironDark);
  const woodM = () => makeMat(PALETTE.wood, { roughness: 0.75 });
  const woodD = () => makeMat(PALETTE.woodDark, { roughness: 0.8 });

  const mIron = ironM(), mDark = darkM(), mWood = woodM(), mWoodD = woodD();

  function bw(w, h, d, x, y, z, mat) {
    return box(w, h, d, 0, x, y, z, root, mat);
  }

  if (kind === 'pistol' || kind === 'iron') {
    bw(0.09, 0.12, 0.22, 0, 0, -0.08, mIron);      // 套筒
    bw(0.07, 0.10, 0.18, 0, 0.02, -0.18, mIron);   // 枪管
    bw(0.075, 0.14, 0.10, 0, -0.11, 0.02, mWoodD); // 握把
    bw(0.04, 0.03, 0.08, 0, 0.07, -0.02, mDark);   // 击锤区
    bw(0.02, 0.025, 0.02, 0, 0.08, -0.22, mDark);  // 准星
  } else if (kind === 'shotgun') {
    bw(0.10, 0.09, 0.55, 0, 0, -0.18, mWood);      // 枪托
    bw(0.08, 0.07, 0.12, 0, 0.01, -0.02, mDark);
    bw(0.07, 0.06, 0.42, 0, 0.03, -0.40, mDark);   // 双管
    bw(0.075, 0.05, 0.18, 0, -0.02, -0.28, mWoodD);// 护木
    bw(0.11, 0.14, 0.16, 0, -0.10, 0.14, mWoodD);  // 枪托底
    bw(0.03, 0.04, 0.06, 0, -0.06, -0.05, mDark);  // 扳机护圈
  } else if (kind === 'pulse' || kind === 'redstone') {
    bw(0.11, 0.14, 0.38, 0, 0, -0.14, makeMetal(PALETTE.obsidian));
    bw(0.06, 0.05, 0.30, 0, 0.08, -0.30, makeMetal(PALETTE.redstone, { emissive: PALETTE.redstone, emissiveIntensity: 0.35 }));
    bw(0.05, 0.05, 0.10, 0, 0.08, -0.48, makeMat(PALETTE.magmaHot, { emissive: PALETTE.magmaHot, emissiveIntensity: 0.8 }));
    bw(0.09, 0.16, 0.12, 0, -0.13, 0.06, mDark);
    bw(0.13, 0.05, 0.18, 0, 0.13, -0.10, makeMetal(PALETTE.redstone));
  } else if (kind === 'sniper' || kind === 'lapis') {
    bw(0.075, 0.09, 0.72, 0, 0, -0.28, mIron);
    bw(0.06, 0.055, 0.50, 0, 0.07, -0.34, makeMetal(PALETTE.lapis));
    bw(0.05, 0.05, 0.20, 0, 0.12, -0.28, mDark);   // 瞄具
    bw(0.10, 0.08, 0.24, 0, -0.01, 0.12, mWood);
    bw(0.13, 0.13, 0.18, 0, -0.11, 0.22, mWoodD);
    bw(0.07, 0.12, 0.10, 0, -0.12, 0.02, mDark);
    bw(0.025, 0.03, 0.02, 0, 0.10, -0.58, mDark);
  } else if (kind === 'magma' || kind === 'lava') {
    bw(0.14, 0.16, 0.34, 0, 0, -0.12, mDark);
    bw(0.11, 0.11, 0.28, 0, 0.03, -0.32, makeMetal(PALETTE.magma, { emissive: PALETTE.magma, emissiveIntensity: 0.25 }));
    bw(0.09, 0.09, 0.12, 0, 0.03, -0.50, makeMat(PALETTE.magmaHot, { emissive: PALETTE.magmaHot, emissiveIntensity: 1.1 }));
    bw(0.10, 0.16, 0.12, 0, -0.14, 0.06, mWoodD);
    bw(0.16, 0.07, 0.16, 0, 0.14, -0.12, makeMetal(PALETTE.magma));
    bw(0.04, 0.04, 0.08, 0.08, 0.02, -0.40, mDark);
    bw(0.04, 0.04, 0.08, -0.08, 0.02, -0.40, mDark);
  } else {
    bw(0.09, 0.12, 0.22, 0, 0, -0.08, mIron);
    bw(0.075, 0.14, 0.10, 0, -0.11, 0.02, mWoodD);
  }

  root.userData.muzzle = new THREE.Vector3(0, 0.04, -0.62);
  return root;
}

/* ---------------- 道具 ---------------- */
export function buildPickup(kind = 'ammo') {
  const root = group('pickup');
  const wood = makeMat(PALETTE.wood, { roughness: 0.8 });
  const metal = makeMetal(PALETTE.iron);
  const brass = makeMetal(PALETTE.gold, { roughness: 0.4 });

  if (kind === 'health' || kind === 'med') {
    box(0.30, 0.16, 0.22, 0, 0, 0, 0, root, makeMat(PALETTE.health, { roughness: 0.7 }));
    box(0.10, 0.04, 0.10, 0, 0, 0.11, 0.10, root, makeMat(0xe8e0d8));
    box(0.22, 0.04, 0.06, 0, 0, 0.11, 0.10, root, makeMat(0xe8e0d8));
    box(0.32, 0.02, 0.24, 0, 0, -0.08, 0, root, metal);
  } else if (kind === 'armor') {
    box(0.26, 0.28, 0.16, 0, 0, 0, 0, root, makeMetal(0x4a6a8a, { metalness: 0.45, roughness: 0.55 }));
    box(0.14, 0.10, 0.06, 0, 0, 0.10, 0.08, root, makeMat(0xc8d8e8, { metalness: 0.3 }));
    box(0.28, 0.06, 0.18, 0, 0, 0.12, -0.02, root, makeMetal(0x3a5068));
  } else if (kind === 'shotgun_ammo' || kind === 'shells') {
    box(0.26, 0.14, 0.20, 0, 0, 0, 0, root, wood);
    for (let i = -1; i <= 1; i += 2) {
      cyl(0.035, 0.035, 0.12, 0, i * 0.08, 0.12, 0, root, 8, makeMat(0xb86828, { roughness: 0.6 }));
      cyl(0.035, 0.035, 0.03, 0, i * 0.08, 0.18, 0, root, 8, brass);
    }
  } else if (kind === 'chest') {
    box(0.40, 0.26, 0.28, 0, 0, 0, 0, root, wood);
    box(0.42, 0.10, 0.30, 0, 0, 0.16, 0, root, makeMat(PALETTE.wood, { roughness: 0.7 }));
    box(0.42, 0.03, 0.30, 0, 0, 0.07, 0, root, makeMetal(PALETTE.ironDark));
    box(0.08, 0.10, 0.05, 0, 0, 0.02, 0.15, root, brass);
    // 条带
    box(0.42, 0.04, 0.06, 0, 0, -0.06, 0, root, makeMetal(PALETTE.ironDark));
    box(0.42, 0.04, 0.06, 0, 0, 0.06, 0, root, makeMetal(PALETTE.ironDark));
  } else {
    box(0.22, 0.14, 0.16, 0, 0, 0, 0, root, makeMat(PALETTE.ammo, { roughness: 0.65 }));
    for (let i = -1; i <= 1; i += 2) {
      box(0.05, 0.10, 0.05, 0, i * 0.05, 0.11, 0, root, makeMetal(PALETTE.iron, { roughness: 0.35 }));
    }
  }
  return root;
}

export function buildBoneProjectile() {
  const root = group('bone');
  box(0.07, 0.07, 0.18, 0, 0, 0, 0, root, makeMat(0xd8d4c0, { roughness: 0.7 }));
  box(0.10, 0.08, 0.06, 0, 0, 0, 0.10, root, makeMat(0xc8c4b0));
  box(0.10, 0.08, 0.06, 0, 0, 0, -0.10, root, makeMat(0xc8c4b0));
  return root;
}

export function buildTree() {
  const root = group('tree');
  cyl(0.12, 0.18, 1.2, 0, 0, 0.6, 0, root, 8, makeTextured('plank', 0x8a6840, 1));
  cyl(0.7, 0.9, 1.0, 0, 0, 1.55, 0, root, 7, makeTextured('leaves', 0x5a8a40, 1));
  cyl(0.5, 0.7, 0.8, 0, 0, 2.25, 0, root, 7, makeTextured('leaves', 0x6a9a48, 1));
  return root;
}

/* ---------------- 动画 ---------------- */
export function animateHumanoid(mesh, t, speed = 1, mode = 'walk') {
  const a = mesh.userData && mesh.userData.anim;
  if (!a) return;
  const phase = t * 7.5 * speed + (a.walkPhase || 0);

  if (mode === 'dead') {
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.12;
    return;
  }
  mesh.rotation.x = 0;

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

export function disposeObject(obj) {
  obj.traverse((n) => {
    if (n.geometry) n.geometry.dispose();
  });
}

export { mats as sharedMats };
