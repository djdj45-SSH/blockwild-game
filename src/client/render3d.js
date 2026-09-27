/* ============================================================
   render3d.js — Three.js 渲染器（替换软件光栅）
   契约：PP.Render.init(canvas) / resize() / frame(G) / quality
   世界：InstancedMesh 方块 + 顶点色地面
   实体：程序化低模（models.js）
   ============================================================ */
import * as THREE from 'three';
import { WALL_COLORS, FLOOR_COLORS, PALETTE, makeLambert, makeTextured, WALL_SKIN, FLOOR_SKIN } from '../three/materials.js';
import {
  buildPlayer, buildEnemy, buildWeaponView, buildPickup,
  buildBoneProjectile, animateHumanoid, animateSpider, disposeObject
} from '../three/models.js';
import { buildArchitecture } from '../three/architecture.js';

(function () {
  const ROOT = (typeof window !== 'undefined') ? window : globalThis;
  const PP = (ROOT.PP = ROOT.PP || {});
  const R = (PP.Render = PP.Render || {});

  const EYE = 0.62;
  const FOV = 72;
  const NEAR = 0.08;
  const FAR = 120;

  let renderer, scene, camera, sun, ambient, hemi, fill, rim;
  let canvas = null;
  let worldGroup = null, entityGroup = null, fxGroup = null, weaponRoot = null;
  let skyMesh = null;
  let worldBuilt = false;
  let lastWorldKey = '';
  const entityPool = new Map();
  const particlePool = [];
  const tmpObj = new THREE.Object3D();
  const tmpColor = new THREE.Color();
  let muzzleLight = null;
  let muzzleFlash = null;

  R.quality = 1;
  R.ssaa = 1;
  R.taa = false;
  R.fxaa = false;

  /* ---------------- 初始化 ---------------- */
  R.init = function (cvs) {
    canvas = cvs;
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance'
    });
    renderer.setPixelRatio(Math.min(ROOT.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.42;

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x7ec8ef);
    scene.fog = new THREE.FogExp2(0x9aa8a8, 0.011);

    camera = new THREE.PerspectiveCamera(FOV, 1, NEAR, FAR);

    // 环境：冷天光 + 暖地面反弹
    ambient = new THREE.AmbientLight(0xa0b8c8, 0.72);
    scene.add(ambient);

    hemi = new THREE.HemisphereLight(0xc8e0ff, 0x7a9860, 1.15);
    scene.add(hemi);

    // 主光：略暖、柔和阴影
    sun = new THREE.DirectionalLight(0xfff0d8, 3.0);
    sun.position.set(36, 48, 18);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 120;
    const sc = 32;
    sun.shadow.camera.left = -sc;
    sun.shadow.camera.right = sc;
    sun.shadow.camera.top = sc;
    sun.shadow.camera.bottom = -sc;
    sun.shadow.bias = -0.0008;
    sun.shadow.normalBias = 0.04;
    scene.add(sun);
    scene.add(sun.target);

    // 补光：从背阴侧提一点冷色，避免死黑
    fill = new THREE.DirectionalLight(0xa8d0ff, 0.7);
    fill.position.set(-24, 22, -18);
    scene.add(fill);

    // 轮廓光：低强度侧后，勾出角色剪影
    rim = new THREE.DirectionalLight(0xffd0a0, 0.35);
    rim.position.set(-8, 14, 28);
    scene.add(rim);

    worldGroup = new THREE.Group();
    worldGroup.name = 'world';
    scene.add(worldGroup);

    entityGroup = new THREE.Group();
    entityGroup.name = 'entities';
    scene.add(entityGroup);

    fxGroup = new THREE.Group();
    fxGroup.name = 'fx';
    scene.add(fxGroup);

    weaponRoot = new THREE.Group();
    weaponRoot.name = 'weapon';
    scene.add(weaponRoot);

    muzzleLight = new THREE.PointLight(0xffc060, 0, 6, 2);
    scene.add(muzzleLight);

    makeSky();
    R.resize();
  };

  function makeSky() {
    const geo = new THREE.SphereGeometry(120, 40, 24);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x2a5a96) },
        mid: { value: new THREE.Color(0x7a9ab8) },
        bottom: { value: new THREE.Color(0xb8c4c0) },
        sunDir: { value: new THREE.Vector3(0.55, 0.62, 0.42).normalize() },
        time: { value: 0 }
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 top; uniform vec3 mid; uniform vec3 bottom;
        uniform vec3 sunDir; uniform float time;
        varying vec3 vDir;

        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }
        float noise(vec2 p){
          vec2 i = floor(p), f = fract(p);
          f = f*f*(3.0-2.0*f);
          return mix(mix(hash(i), hash(i+vec2(1,0)), f.x),
                     mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), f.x), f.y);
        }
        float fbm(vec2 p){
          float v = 0.0, a = 0.5;
          for(int i=0;i<5;i++){ v += a*noise(p); p*=2.02; a*=0.5; }
          return v;
        }

        void main() {
          vec3 d = normalize(vDir);
          float h = d.y * 0.5 + 0.5;
          vec3 col = mix(bottom, mid, smoothstep(0.42, 0.58, h));
          col = mix(col, top, smoothstep(0.52, 0.88, h));

          // 云：投影到平面
          if (d.y > 0.02) {
            vec2 uv = d.xz / max(d.y, 0.08) * 0.35 + vec2(time*0.002, 0.0);
            float c = fbm(uv * 2.2);
            c = smoothstep(0.42, 0.78, c) * smoothstep(0.02, 0.25, d.y);
            vec3 cloudCol = mix(vec3(0.72,0.76,0.80), vec3(0.92,0.90,0.86), c*0.5);
            col = mix(col, cloudCol, c * 0.75);
          }

          float sun = pow(max(dot(d, sunDir), 0.0), 64.0);
          float glow = pow(max(dot(d, sunDir), 0.0), 8.0);
          col += vec3(1.0, 0.92, 0.78) * sun * 1.4;
          col += vec3(1.0, 0.82, 0.58) * glow * 0.22;

          gl_FragColor = vec4(col, 1.0);
        }
      `
    });
    skyMesh = new THREE.Mesh(geo, mat);
    skyMesh.frustumCulled = false;
    scene.add(skyMesh);
  }

  R.resize = function () {
    if (!canvas || !renderer) return;
    const parent = canvas.parentElement || ROOT;
    const w = parent.clientWidth || ROOT.innerWidth || 1280;
    const h = parent.clientHeight || ROOT.innerHeight || 720;
    const q = R.quality || 1;
    const dpr = Math.min(ROOT.devicePixelRatio || 1, q >= 1.5 ? 2 : q >= 1 ? 1.5 : 1);
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };

  /* ---------------- 世界构建 ---------------- */
  function wallHeight(type) {
    const PPW = PP.World;
    if (PPW && PPW.wallHeight && PPW.wallHeight[type] !== undefined) return PPW.wallHeight[type];
    return 1.5;
  }

  function buildWorld(G) {
    const Wd = PP.World;
    if (!Wd || !Wd.wall) return;
    const key = `${Wd.SIZE}|${Wd.wall.length}|${Wd._genTick || 0}`;
    if (worldBuilt && lastWorldKey === key) return;
    lastWorldKey = key;

    while (worldGroup.children.length) {
      const c = worldGroup.children[0];
      worldGroup.remove(c);
      if (c.geometry) c.geometry.dispose();
      if (c.material && c.material.dispose) c.material.dispose();
    }
    worldBuilt = true;

    const SIZE = Wd.SIZE;
    const wall = Wd.wall;
    const floor = Wd.floor;

    // ---- 地面：合并网格 + UV + 顶点色变 ----
    const floorBuckets = new Map();
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const ty = floor ? (floor[y * SIZE + x] || 0) : 0;
        if (!floorBuckets.has(ty)) floorBuckets.set(ty, { xs: [], ys: [] });
        const b = floorBuckets.get(ty);
        b.xs.push(x); b.ys.push(y);
      }
    }
    for (const [ty, b] of floorBuckets) {
      const n = b.xs.length;
      const pos = new Float32Array(n * 6 * 3);
      const nor = new Float32Array(n * 6 * 3);
      const uvs = new Float32Array(n * 6 * 2);
      const cols = new Float32Array(n * 6 * 3);
      const skin = FLOOR_SKIN[ty] || FLOOR_SKIN[0];
            let o = 0, uo = 0, co = 0;
      for (let i = 0; i < n; i++) {
        const x = b.xs[i], y = b.ys[i];
        const x0 = x, z0 = y, x1 = x + 1, z1 = y + 1;
        const tri = [
          x0, 0, z0, x1, 0, z0, x1, 0, z1,
          x0, 0, z0, x1, 0, z1, x0, 0, z1
        ];
        const uv = [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1];
        for (let k = 0; k < 18; k++) pos[o + k] = tri[k];
        for (let k = 0; k < 12; k++) uvs[uo + k] = uv[k];
        for (let v = 0; v < 6; v++) {
          nor[o + v * 3] = 0; nor[o + v * 3 + 1] = 1; nor[o + v * 3 + 2] = 0;
          const hash = ((x * 73856093) ^ (y * 19349663)) & 255;
          const g = 0.92 + (hash / 255) * 0.16;
          cols[co + v * 3] = g;
          cols[co + v * 3 + 1] = g;
          cols[co + v * 3 + 2] = g;
        }
        o += 18; uo += 12; co += 18;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
      geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
      const mat = makeTextured(skin.map || 'grass', 0xffffff, 1, {
        vertexColors: true,
        side: THREE.FrontSide,
        color: 0xffffff,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1
      });
      // 乘色调：texture 已有基色，用 color 微调
      mat.color.setHex(0xffffff);
      const mesh = new THREE.Mesh(geo, mat);
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      worldGroup.add(mesh);
    }

    // ---- 墙：只生成外露面（消除相邻方块内壁 z-fighting「穿模」） ----
    const wallBuckets = new Map();
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const ty = wall[y * SIZE + x];
        if (!ty) continue;
        if (!wallBuckets.has(ty)) wallBuckets.set(ty, { xs: [], ys: [] });
        const b = wallBuckets.get(ty);
        b.xs.push(x); b.ys.push(y);
      }
    }

    const solidAt = (tx, ty) => {
      if (tx < 0 || ty < 0 || tx >= SIZE || ty >= SIZE) return true;
      return wall[ty * SIZE + tx] !== 0;
    };

    for (const [ty, b] of wallBuckets) {
      const n = b.xs.length;
      const h = wallHeight(ty);
      const skin = WALL_SKIN[ty] || WALL_SKIN[1];
      // 预估最多 6 面，实际更少
      const maxFaces = n * 6;
      const pos = new Float32Array(maxFaces * 6 * 3);
      const nor = new Float32Array(maxFaces * 6 * 3);
      const uvs = new Float32Array(maxFaces * 6 * 2);
      const cols = new Float32Array(maxFaces * 6 * 3);
      let faceCount = 0;

      const pushFace = (verts, nx, ny, nz, tint) => {
        const fi = faceCount * 18;
        for (let k = 0; k < 18; k++) pos[fi + k] = verts[k];
        for (let v = 0; v < 6; v++) {
          nor[fi + v * 3] = nx; nor[fi + v * 3 + 1] = ny; nor[fi + v * 3 + 2] = nz;
          const ui = faceCount * 12;
          // 两三角 UV
          const uv = [0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1];
          for (let k = 0; k < 12; k++) uvs[ui + k] = uv[k];
          cols[fi + v * 3] = tint; cols[fi + v * 3 + 1] = tint; cols[fi + v * 3 + 2] = tint;
        }
        faceCount++;
      };

      for (let i = 0; i < n; i++) {
        const gx = b.xs[i], gy = b.ys[i];
        const x0 = gx, x1 = gx + 1;
        const y0 = 0, y1 = h;
        const z0 = gy, z1 = gy + 1;
        // 顶面着色略亮、底面略暗
        const topT = 1.08, sideT = 1.0, botT = 0.72;

        // 邻接实心 → 该面是内壁，不生成（消除 z-fighting）
        const nX = solidAt(gx + 1, gy);
        const pX = solidAt(gx - 1, gy);
        const nZ = solidAt(gx, gy + 1);
        const pZ = solidAt(gx, gy - 1);
        const covered = nX && pX && nZ && pZ;

        // +Y 顶（四周被围时省略）
        if (!covered) {
          pushFace([x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z0, x1, y1, z1, x0, y1, z1], 0, 1, 0, topT);
        }
        // +X / -X / +Z / -Z
        if (!nX) pushFace([x1, y0, z0, x1, y1, z0, x1, y1, z1, x1, y0, z0, x1, y1, z1, x1, y0, z1], 1, 0, 0, sideT);
        if (!pX) pushFace([x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y0, z0, x0, y1, z1, x0, y1, z0], -1, 0, 0, sideT);
        if (!nZ) pushFace([x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y0, z1, x1, y1, z1, x0, y1, z1], 0, 0, 1, sideT);
        if (!pZ) pushFace([x0, y0, z0, x0, y1, z0, x1, y1, z0, x0, y0, z0, x1, y1, z0, x1, y0, z0], 0, 0, -1, sideT);
      }

      const used = faceCount * 18;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos.subarray(0, used), 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(nor.subarray(0, used), 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(uvs.subarray(0, faceCount * 12), 2));
      geo.setAttribute('color', new THREE.BufferAttribute(cols.subarray(0, used), 3));
      const mat = makeTextured(skin.map || 'stone', 0xffffff, 1, {
        side: THREE.FrontSide,
        color: 0xffffff,
        vertexColors: true,
        polygonOffset: true,
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = 'walls_' + ty;
      worldGroup.add(mesh);
    }

    try {
      const arch = buildArchitecture(Wd);
      worldGroup.add(arch);
    } catch (err) {
      if (typeof console !== 'undefined') console.warn('arch', err);
    }
  }

  /* ---------------- 实体同步 ---------------- */
  function ensureEntity(id, factory) {
    let e = entityPool.get(id);
    if (!e) {
      const mesh = factory();
      entityGroup.add(mesh);
      e = { mesh, kind: mesh.name || 'ent' };
      entityPool.set(id, e);
    }
    return e;
  }

  function releaseStale(activeIds) {
    for (const [id, e] of entityPool) {
      if (!activeIds.has(id)) {
        entityGroup.remove(e.mesh);
        disposeObject(e.mesh);
        entityPool.delete(id);
      }
    }
  }

  function setFlash(mesh, amount) {
    mesh.traverse((n) => {
      if (n.isMesh && n.material && n.material.emissive) {
        n.material = n.material; // shared mats — use scale pulse instead
      }
    });
    if (amount > 0) {
      mesh.scale.setScalar(1 + amount * 0.06);
    } else {
      mesh.scale.setScalar(1);
    }
  }

  /* ---------------- 相机 / 枪 ---------------- */
  let weaponMesh = null;
  let weaponKind = '';
  let camShake = 0;

  function ensureWeapon(kind) {
    if (weaponMesh && weaponKind === kind) return;
    if (weaponMesh) {
      weaponRoot.remove(weaponMesh);
      disposeObject(weaponMesh);
    }
    weaponMesh = buildWeaponView(kind);
    weaponKind = kind;
    weaponRoot.add(weaponMesh);
    // 视模挂在相机下
    camera.add(weaponRoot);
    if (!scene.children.includes(camera)) scene.add(camera);
  }

  /* ---------------- 粒子 ---------------- */
  const particleGeo = new THREE.BoxGeometry(0.08, 0.08, 0.08);
  const particleMats = {
    blood: makeLambert(0x5cc840),
    spark: makeLambert(0xffe282),
    gib: makeLambert(0x78c46c),
    boom: makeLambert(0xff7828),
    smoke: makeLambert(0x888888)
  };

  function syncParticles(G) {
    const list = G.particles || [];
    // 简单复用
    while (particlePool.length < list.length) {
      const m = new THREE.Mesh(particleGeo, particleMats.blood);
      m.castShadow = false;
      fxGroup.add(m);
      particlePool.push(m);
    }
    for (let i = 0; i < particlePool.length; i++) {
      const m = particlePool[i];
      if (i < list.length) {
        const q = list[i];
        m.visible = true;
        m.position.set(q.x, q.z, q.y); // sim: x,y 平面 + z 高 → three: x,z 平面 + y 高
        const s = 0.5 + (q.size || 1) * 0.8;
        m.scale.setScalar(s);
        const key = q.tex || 'blood';
        m.material = particleMats[key] || particleMats.blood;
      } else {
        m.visible = false;
      }
    }
  }

  /* ---------------- 主帧 ---------------- */
  R.frame = function (G) {
    if (!renderer || !G || !G.player) return;
    const p = G.player;

    buildWorld(G);

    // 观战
    let camObj = p;
    let spectating = false;
    if (G.mates && G.mates.length && (p.eliminated || p.downed)) {
      let best = null, bestD = 1e9;
      for (const m of G.mates) {
        if (!m || m.eliminated) continue;
        const d = (m.x - p.x) ** 2 + (m.y - p.y) ** 2;
        if (d < bestD) { bestD = d; best = m; }
      }
      if (best) { camObj = best; spectating = true; }
    }

    const selfDown = !spectating && (p.downed || p.eliminated);
    const eye = selfDown ? 0.30 : EYE;
    const pitch = (camObj.pitch !== undefined ? camObj.pitch : camObj.tpitch) || 0;
    const yaw = camObj.a || 0;

    camShake = (G.shake || 0) * 0.15 + (G.kickPitch || 0) * 0.05;
    const viewY = (G.viewOffsetY || 0) * 0.002;

    // sim: x,y 是地面平面，z 是高度 → three: x,z 地面，y 高度
    const camX = camObj.x;
    const camY = eye + viewY + (Math.random() - 0.5) * camShake * 0.3;
    const camZ = camObj.y;

    camera.position.set(camX, camY, camZ);
    // yaw 0 = +x？ 原软件光栅：a 是方位角，pitch 上正
    // 原 setCam：水平投影 cos/sin(a)，pitch 控制俯仰
    camera.rotation.order = 'YXZ';
    // 原 yaw：a，向 +x 为 0？ 看 setCam
    // 标准 FPS: yaw=0 看向 -Z；这里 sim 的 a=0 通常看向 +x 或 -x
    // 从 minimap: lx = px + cos(p.a)*3, ly = py + sin(p.a)*3 — a=0 → +x
    // Three: rotation.y = -yaw 让 0 看向 -Z；需要 yaw 看向 +X 时 rotation.y = -yaw + Math.PI/2?
    // 向量 (cos a, 0, sin a) in sim (x,y) → three (cos a, 0, sin a) wait y_sim → z_three
    // dir_three = (cos a, 0, sin a)
    // Three camera default looks -Z. We want look dir = (cos a, sin(pitch), sin a) roughly.
    // rotation.y for look at (cos a, 0, sin a): y_rot = atan2(cos a, sin a) = atan2(cos, sin)
    //   正确：rotation.y = -yaw - π/2（相机默认看 -Z）
    camera.rotation.y = -yaw - Math.PI / 2;
    camera.rotation.x = pitch + camShake * 0.4;
    camera.rotation.z = camShake * 0.2;

    // 光照跟随
    sun.position.set(camX + 24, 40, camZ + 16);
    sun.target.position.set(camX, 0, camZ);
    sun.target.updateMatrixWorld();
    if (skyMesh) skyMesh.position.copy(camera.position);

    // ---- 实体 ----
    const active = new Set();
    const enemies = G.enemies || [];
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      const id = 'e' + (e.id !== undefined ? e.id : i);
      active.add(id);
      const ent = ensureEntity(id, () => buildEnemy(e.type));
      const mesh = ent.mesh;
      mesh.position.set(e.x, e.z0 || 0, e.y);
      // 朝向：e 可能有 a / face；默认朝速度或向玩家
      const face = e.face !== undefined ? e.face : (e.a !== undefined ? e.a : yaw);
      mesh.rotation.y = Math.PI / 2 - face;

      const dead = e.state === 'dead';
      const mode = dead ? 'dead' : (e.windup > 0 ? 'attack' : (e.hurt > 0 ? 'hurt' : 'walk'));
      if (e.type === 'spider') animateSpider(mesh, performance.now() * 0.001, dead ? 0 : 1);
      else animateHumanoid(mesh, performance.now() * 0.001, dead ? 0 : (e.state === 'alive' ? 1 : 0.4), mode);
      setFlash(mesh, e.hurt > 0 ? 1 : 0);
    }

    // 队友 / 自己尸体
    const mates = G.mates || [];
    for (let i = 0; i < mates.length; i++) {
      const m = mates[i];
      if (!m || m.eliminated) continue;
      const id = 'p' + (m.id !== undefined ? m.id : i);
      active.add(id);
      const ent = ensureEntity(id, () => buildPlayer(m.colorIdx || 0));
      const mesh = ent.mesh;
      mesh.position.set(m.x, 0, m.y);
      mesh.rotation.y = Math.PI / 2 - (m.a || 0);
      const mode = m.downed ? 'dead' : (m.fireT > 0 ? 'attack' : 'walk');
      animateHumanoid(mesh, performance.now() * 0.001, m.downed ? 0 : 1, mode);
    }
    if (!spectating && (p.downed || p.eliminated)) {
      const id = 'selfdead';
      active.add(id);
      const ent = ensureEntity(id, () => buildPlayer(p.colorIdx || 0));
      ent.mesh.position.set(p.x, 0, p.y);
      animateHumanoid(ent.mesh, 0, 0, 'dead');
    }

    // 拾取物
    const pickups = G.pickups || [];
    for (let i = 0; i < pickups.length; i++) {
      const it = pickups[i];
      const id = 'k' + (it.id !== undefined ? it.id : i);
      active.add(id);
      const ent = ensureEntity(id, () => buildPickup(it.kind));
      const bob = 0.16 + Math.sin((it.t || 0) + performance.now() * 0.003) * 0.05;
      ent.mesh.position.set(it.x, bob, it.y);
      ent.mesh.rotation.y = performance.now() * 0.001 + (it.t || 0);
    }

    // 投射物
    const projectiles = G.projectiles || [];
    for (let i = 0; i < projectiles.length; i++) {
      const b = projectiles[i];
      const id = 'b' + i;
      active.add(id);
      const ent = ensureEntity(id, () => buildBoneProjectile());
      ent.mesh.position.set(b.x, (b.z || 0.6) - 0.1, b.y);
    }

    releaseStale(active);
    syncParticles(G);

    // ---- 手中武器 ----
    const showGun = !spectating && !p.eliminated && !p.downed;
    if (showGun) {
      {
        const wid = (G.weapon !== undefined && G.weapon !== null) ? G.weapon : 0;
        const wdef = (PP.WEAPONS && PP.WEAPONS[wid]) || (PP.WEAPON_BY_ID && PP.WEAPON_BY_ID(wid));
        const kind = (wdef && wdef.pick) || 'pistol';
        ensureWeapon(kind);
      }
      weaponRoot.visible = true;
      const swayX = (G.weaponSwayX || 0) * 0.15;
      const bobY = (G.weaponBobY || 0) * 0.002;
      const raise = (G.weaponRaise || 0) * 0.01;
      // 视模防穿墙：沿视线探测到墙则拉近枪
      let weaponZ = -0.52;
      if (PP.World && PP.World.rayWall) {
        const cy = camObj.a || 0;
        const cp = pitch;
        const dx = Math.cos(cy) * Math.cos(cp);
        const dy = Math.sin(cy) * Math.cos(cp);
        const wallD = PP.World.rayWall(camObj.x, camObj.y, dx, dy, 1.2);
        if (wallD < 0.75) {
          const k = Math.max(0.18, (wallD - 0.18) / 0.55);
          weaponZ = -0.18 - 0.34 * k;
        }
      }
      weaponRoot.position.set(0.32 + swayX, -0.32 + bobY + raise, weaponZ);
      weaponRoot.rotation.set(0.18 + (G.kickPitch || 0) * 0.4, 0.22, 0.04);
      if (G.muzzleT > 0) {
        muzzleLight.intensity = 4 * (G.muzzleT / 0.06);
        muzzleLight.position.copy(camera.position);
        const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
        muzzleLight.position.add(dir.multiplyScalar(0.8));
      } else {
        muzzleLight.intensity = 0;
      }
    } else {
      weaponRoot.visible = false;
      muzzleLight.intensity = 0;
    }

    G.spectateName = spectating ? (camObj.name || '队友') : '';

    // 雾密度按画质微调
    if (scene.fog && scene.fog.density !== undefined) {
      scene.fog.density = 0.010 + (1 - Math.min(1, R.quality)) * 0.008;
    }

    renderer.render(scene, camera);
    drawMinimap(G);
  };

  /* ---------------- 小地图（2D 覆盖） ---------------- */
  function drawMinimap(G) {
    // 使用 canvas 2d 叠加：在 WebGL canvas 上方由 HUD 管更好，
    // 这里在 renderer 后用同一 canvas 的 2D 不可行。改为写入 G 供 HUD 或
    // 创建/更新独立小地图 canvas。
    let mm = ROOT.document && ROOT.document.getElementById('bw-minimap');
    if (!mm) {
      if (!ROOT.document) return;
      mm = ROOT.document.createElement('canvas');
      mm.id = 'bw-minimap';
      mm.width = 128;
      mm.height = 128;
      mm.className = 'bw-minimap';
      ROOT.document.body.appendChild(mm);
    }
    const ctx = mm.getContext('2d');
    const STRIDE = 3;
    const Wd = PP.World;
    if (!Wd || !Wd.wall) return;
    const SIZE = Wd.SIZE;
    const mw = 128;
    const scale = mw / SIZE;
    ctx.fillStyle = 'rgba(10,20,14,0.55)';
    ctx.fillRect(0, 0, mw, mw);
    const p = G.player;
    // 只画周围
    const R2 = 40;
    const px = p.x, py = p.y;
    for (let y = 0; y < SIZE; y += 2) {
      for (let x = 0; x < SIZE; x += 2) {
        if (Math.abs(x - px) > R2 + 20 || Math.abs(y - py) > R2 + 20) continue;
        const t = Wd.wall[y * SIZE + x];
        if (!t) continue;
        ctx.fillStyle = t === 5 ? '#3a7a2a' : t === 6 ? '#4a9a34' : t === 2 ? '#a2733f' : t === 3 ? '#a85a48' : '#8a8a8a';
        ctx.fillRect(x * scale, y * scale, Math.max(1, scale * 2), Math.max(1, scale * 2));
      }
    }
    if (G.mates) {
      for (const m of G.mates) {
        if (m.eliminated) continue;
        ctx.fillStyle = m.downed ? '#ff9c3c' : '#8fd8ff';
        ctx.fillRect(m.x * scale - 2, m.y * scale - 2, 4, 4);
      }
    }
    for (const e of (G.enemies || [])) {
      if (e.state !== 'alive') continue;
      ctx.fillStyle = e.type === 'husk' ? '#e8c078' : (e.type === 'skeleton' ? '#f0f0e0' : e.type === 'creeper' ? '#6fdc4a' : e.type === 'spider' ? '#b070d0' : '#7fd45a');
      ctx.fillRect(e.x * scale - 1, e.y * scale - 1, 3, 3);
    }
    for (const it of (G.pickups || [])) {
      ctx.fillStyle = '#ffe066';
      ctx.fillRect(it.x * scale - 1, it.y * scale - 1, 2, 2);
    }
    ctx.fillStyle = '#fff';
    ctx.fillRect(px * scale - 2, py * scale - 2, 4, 4);
    ctx.strokeStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(px * scale, py * scale);
    ctx.lineTo(px * scale + Math.cos(p.a) * 10, py * scale + Math.sin(p.a) * 10);
    ctx.stroke();
  }

  // 诊断钩子
  R.getStats = function () {
    if (!renderer) return null;
    const info = renderer.info;
    return {
      calls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures
    };
  };
})();
