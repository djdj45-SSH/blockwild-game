/* ============================================================
   architecture.js — 写实建筑构件（合并网格，按材质批绘）
   ============================================================ */
import * as THREE from 'three';
import { makeTextured, makeMat, makeMetal } from './materials.js';

/** 累积盒体，最后按材质 merge */
class Batch {
  constructor() {
    this.groups = new Map(); // mat -> Matrix4[] / geometry list
  }
  add(mat, w, h, d, x, y, z, rotY = 0) {
    const g = new THREE.BoxGeometry(w, h, d);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    if (rotY) q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotY);
    m.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 1, 1));
    g.applyMatrix4(m);
    if (!this.groups.has(mat)) this.groups.set(mat, []);
    this.groups.get(mat).push(g);
  }
  build(parent) {
    for (const [mat, geos] of this.groups) {
      if (!geos.length) continue;
      const merged = mergeBoxes(geos);
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      parent.add(mesh);
      for (const g of geos) g.dispose();
    }
    this.groups.clear();
  }
}

function mergeBoxes(geos) {
  // 简易合并：收集 position/normal/uv
  let vCount = 0, iCount = 0;
  for (const g of geos) {
    vCount += g.attributes.position.count;
    iCount += g.index ? g.index.count : g.attributes.position.count;
  }
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const idx = new Uint32Array(iCount);
  let vo = 0, io = 0;
  for (const g of geos) {
    const p = g.attributes.position.array;
    const n = g.attributes.normal.array;
    const u = g.attributes.uv ? g.attributes.uv.array : null;
    const c = g.attributes.position.count;
    pos.set(p, vo * 3);
    nor.set(n, vo * 3);
    if (u) uv.set(u, vo * 2);
    if (g.index) {
      const gi = g.index.array;
      for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
      io += gi.length;
    } else {
      for (let i = 0; i < c; i++) idx[io + i] = vo + i;
      io += c;
    }
    vo += c;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}

export function buildArchitecture(Wd) {
  const root = new THREE.Group();
  root.name = 'architecture';
  if (!Wd || !Wd.wall) return root;

  const SIZE = Wd.SIZE;
  const wall = Wd.wall;
  const solid = (x, y) => x >= 0 && y >= 0 && x < SIZE && y < SIZE && wall[y * SIZE + x] !== 0;
  const typeAt = (x, y) => (x >= 0 && y >= 0 && x < SIZE && y < SIZE) ? wall[y * SIZE + x] : 0;
  const wallH = (t) => {
    const arr = Wd.wallHeight || [1, 2, 1.9, 2.2, 1.7, 2.85, 2.45, 1.6, 1, 3];
    return arr[t] || 1.5;
  };

  const B = new Batch();
  // 色调压一档：之前是纯白，配上直射光后描边过曝（白边发光）
  const plank = makeTextured('plank', 0xe6d2a8, 1);
  const stone = makeTextured('stone', 0xbfc0b8, 1);
  const dark = makeMat(0x1a1c18, { roughness: 0.95 });
  const glass = makeMat(0x2a3230, {
    roughness: 0.35, metalness: 0.15,
    transparent: true, opacity: 0.35
  });
  const iron = makeMetal(0x6a7078);

  // 建筑墙：压顶 + 少量窗 + 墙基
  for (let y = 1; y < SIZE - 1; y++) {
    for (let x = 1; x < SIZE - 1; x++) {
      const t = typeAt(x, y);
      if (!t) continue;
      if (t !== 1 && t !== 2 && t !== 3 && t !== 4) continue;
      const h = wallH(t);
      const isWood = t === 2 || t === 5;

      const nX = solid(x + 1, y), pX = solid(x - 1, y);
      const nZ = solid(x, y + 1), pZ = solid(x, y - 1);
      const degree = (nX ? 1 : 0) + (pX ? 1 : 0) + (nZ ? 1 : 0) + (pZ ? 1 : 0);

      // 墙基（外露侧）
      if (!nX) B.add(stone, 0.08, 0.18, 1.02, x + 1.02, 0.09, y + 0.5);
      if (!pX) B.add(stone, 0.08, 0.18, 1.02, x - 0.02, 0.09, y + 0.5);
      if (!nZ) B.add(stone, 1.02, 0.18, 0.08, x + 0.5, 0.09, y + 1.02);
      if (!pZ) B.add(stone, 1.02, 0.18, 0.08, x + 0.5, 0.09, y - 0.02);

      // 压顶
      if (!nX || !pX || !nZ || !pZ) {
        B.add(isWood ? plank : stone, 1.06, 0.09, 1.06, x + 0.5, h + 0.045, y + 0.5);
      }

      // 端柱
      if (degree <= 1) {
        B.add(stone, 1.1, 0.12, 1.1, x + 0.5, 0.06, y + 0.5);
        B.add(isWood ? plank : stone, 1.08, 0.12, 1.08, x + 0.5, h - 0.06, y + 0.5);
      }

      // 窗：稀疏
      if ((x * 3 + y * 5) % 11 === 0) {
        const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (const [dx, dy] of dirs) {
          if (solid(x + dx, y + dy)) continue;
          const wy = h * 0.58;
          const wx = x + 0.5 + dx * 0.52;
          const wz = y + 0.5 + dy * 0.52;
          B.add(glass, dx !== 0 ? 0.03 : 0.28, 0.28, dy !== 0 ? 0.03 : 0.28, wx, wy, wz);
          B.add(isWood ? plank : stone,
            dx !== 0 ? 0.07 : 0.46, 0.05, dy !== 0 ? 0.07 : 0.46,
            wx, wy + 0.21, wz);
          B.add(isWood ? plank : stone,
            dx !== 0 ? 0.07 : 0.46, 0.05, dy !== 0 ? 0.07 : 0.46,
            wx, wy - 0.21, wz);
          break;
        }
      }
    }
  }

  // POI：门框与道具（每 POI 限量）
  const pois = Wd.pois || [];
  for (const poi of pois) {
    const px = Math.floor(poi.x), py = Math.floor(poi.y);
    let doorFound = false;
    for (let oy = -5; oy <= 5 && !doorFound; oy++) {
      for (let ox = -5; ox <= 5; ox++) {
        const x = px + ox, y = py + oy;
        if (solid(x, y)) continue;
        if (solid(x - 1, y) && solid(x + 1, y)) {
          B.add(plank, 0.1, 1.45, 0.12, x - 0.05, 0.72, y + 0.5);
          B.add(plank, 0.1, 1.45, 0.12, x + 1.05, 0.72, y + 0.5);
          B.add(plank, 1.2, 0.1, 0.16, x + 0.5, 1.52, y + 0.5);
          doorFound = true;
          break;
        }
      }
    }

    // 散落物 2-3 个
    const ax = poi.x + 2.2, ay = poi.y + 1.6;
    if (!solid(Math.floor(ax), Math.floor(ay))) {
      B.add(plank, 0.42, 0.5, 0.42, ax, 0.25, ay);
      B.add(stone, 0.32, 0.3, 0.32, ax + 0.75, 0.15, ay + 0.35);
    }
    if (poi.type === 'camp') {
      B.add(dark, 0.85, 0.22, 0.85, poi.x, 0.11, poi.y + 2.2);
      B.add(makeMat(0x6a2818, { emissive: 0xa03018, emissiveIntensity: 0.45 }),
        0.32, 0.32, 0.32, poi.x, 0.38, poi.y + 2.2);
    }
    if (poi.type === 'tower') {
      B.add(iron, 1.35, 0.18, 1.35, poi.x, 2.55, poi.y);
    }
    if (poi.type === 'cabin' || poi.type === 'bunker') {
      B.add(isWoodMat(), 0.9, 0.7, 0.55, poi.x - 1.5, 0.35, poi.y + 1.2);
    }
  }

  function isWoodMat() { return plank; }

  B.build(root);
  return root;
}
