/* ============================================================
   render3d.js — Three.js 渲染器
   契约：PP.Render.init(canvas) / resize() / frame(G) / quality
   世界：图集贴图 + 分块合并网格（32×32 一格一块）→ 视锥/距离剔除
   实体：程序化低模（models.js），按距离做 LOD 休眠
   ============================================================ */
import * as THREE from 'three';
import {
  PALETTE, makeLambert, atlasMaterial, atlasUV, setAnisotropy,
  WALL_SKIN, FLOOR_SKIN
} from '../three/materials.js';
import {
  buildPlayer, buildEnemy, buildWeaponView, buildPickup,
  buildBoneProjectile, animateHumanoid, animateSpider, disposeObject
} from '../three/models.js';
import { buildArchitecture } from '../three/architecture.js';

(function () {
  const ROOT = (typeof window !== 'undefined') ? window : globalThis;
  const PP = (ROOT.PP = ROOT.PP || {});
  const R = (PP.Render = PP.Render || {});

  const EYE = 0.62;          // 站立视高（玩家模型高 0.98）
  const EYE_DOWN = 0.34;     // 倒地视高
  const FOV = 72;
  const NEAR = 0.06;
  const FAR = 120;
  const CHUNK = 32;          // 地形分块边长（格）
  const FOG_DENSITY = 0.0125;
  const ENEMY_DRAW_DIST = 64;   // 超过此距离的敌人不渲染（已经埋进雾里）
  const MAX_ENEMY_DRAW = 24;    // 同时最多渲染多少只怪（按距离取最近的一批）

  let renderer, scene, camera, sun, ambient, hemi, fill, rim;
  let canvas = null;
  let worldGroup = null, entityGroup = null, fxGroup = null, weaponRoot = null;
  let skyMesh = null, skyMat = null;
  let worldBuilt = false;
  let lastWorldKey = '';
  let shadowLevel = -1, shadowFrame = 0;
  const chunks = [];                     // { x0, z0, x1, z1, walls, floor, cx, cz }
  const entityPool = new Map();
  const tmpObj = new THREE.Object3D();
  let muzzleLight = null;

  // 每帧复用容器，避免 GC 抖动
  const activeIds = new Set();
  const enemyDist = [];

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
      powerPreference: 'high-performance',
      stencil: false
    });
    renderer.setPixelRatio(1);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = false;      // 手动节流：地形是静态的，太阳跟着走
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.LinearToneMapping;
    // 曝光 1.35：贴图基色在线性空间偏暗，不需要这一步整个世界会发闷
    renderer.toneMappingExposure = 1.35;
    // 掠射角贴图清晰度：按 GPU 上限开满各向异性
    try {
      const maxA = renderer.capabilities.getMaxAnisotropy();
      setAnisotropy(maxA);
    } catch (e) { setAnisotropy(8); }

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x9fd6f5);
    scene.fog = new THREE.FogExp2(0xb9dcf0, FOG_DENSITY);

    camera = new THREE.PerspectiveCamera(FOV, 1, NEAR, FAR);
    camera.rotation.order = 'YXZ';

    // 光照配比（明亮卡通）：高环境光 + 中等太阳，阴影侧不糊成黑块。
    // 目标：受光面 ≈ 反照率×1.05，背光面 ≈ 反照率×0.4
    ambient = new THREE.AmbientLight(0xc2dcf0, 0.75);
    scene.add(ambient);

    hemi = new THREE.HemisphereLight(0xd8eeff, 0x8fb074, 0.75);
    scene.add(hemi);

    sun = new THREE.DirectionalLight(0xfff4de, 1.5);
    sun.position.set(36, 48, 18);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 110;
    const sc = 30;
    sun.shadow.camera.left = -sc;
    sun.shadow.camera.right = sc;
    sun.shadow.camera.top = sc;
    sun.shadow.camera.bottom = -sc;
    sun.shadow.bias = -0.0009;
    sun.shadow.normalBias = 0.05;
    // 关键：改过 left/right/top/bottom 之后必须手动重算投影矩阵，
    // 否则阴影相机还是构造时的 ±5 默认框 → 稍远一点就完全没有影子（已踩过）
    sun.shadow.camera.updateProjectionMatrix();
    scene.add(sun);
    scene.add(sun.target);

    fill = new THREE.DirectionalLight(0xbcdcff, 0.35);
    fill.position.set(-24, 22, -18);
    scene.add(fill);

    rim = new THREE.DirectionalLight(0xffe0b8, 0.22);
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
    camera.add(weaponRoot);
    scene.add(camera);

    muzzleLight = new THREE.PointLight(0xffc060, 0, 6, 2);
    scene.add(muzzleLight);

    makeSky();
    makeEnvironment();
    initParticles();
    R.resize();
  };

  /* 程序化环境贴图（PMREM）：
     没有 envMap 时，metalness>0 的材质（枪、铁件）会渲染成死黑——
     金属没有漫反射，只靠环境反射。这里用一张天空渐变烤一张 IBL 出来。 */
  function makeEnvironment() {
    if (!ROOT.document) return;
    const w = 64, h = 32;
    const c = ROOT.document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#2f7fd6');
    g.addColorStop(0.42, '#9ed4f2');
    g.addColorStop(0.5, '#cfe6ee');
    g.addColorStop(0.58, '#93a878');
    g.addColorStop(1, '#63794c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
    const sx = w * 0.72, sy = h * 0.2;
    const sg = ctx.createRadialGradient(sx, sy, 0, sx, sy, 10);
    sg.addColorStop(0, 'rgba(255,250,232,1)');
    sg.addColorStop(1, 'rgba(255,250,232,0)');
    ctx.fillStyle = sg;
    ctx.fillRect(0, 0, w, h);

    const t = new THREE.CanvasTexture(c);
    t.mapping = THREE.EquirectangularReflectionMapping;
    t.colorSpace = THREE.SRGBColorSpace;
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const rt = pmrem.fromEquirectangular(t);
      scene.environment = rt.texture;
      if ('environmentIntensity' in scene) scene.environmentIntensity = 0.45;
      t.dispose();
      pmrem.dispose();
    } catch (e) {
      if (typeof console !== 'undefined') console.warn('env', e);
    }
  }

  function makeSky() {
    const geo = new THREE.SphereGeometry(88, 32, 20);
    skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      uniforms: {
        top: { value: new THREE.Color(0x2f7fd6) },
        mid: { value: new THREE.Color(0x8ec8ee) },
        bottom: { value: new THREE.Color(0xd8ecf8) },
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
          for(int i=0;i<4;i++){ v += a*noise(p); p*=2.02; a*=0.5; }
          return v;
        }

        void main() {
          vec3 d = normalize(vDir);
          float h = clamp(d.y, -1.0, 1.0) * 0.5 + 0.5;
          vec3 col = mix(bottom, mid, smoothstep(0.44, 0.58, h));
          col = mix(col, top, smoothstep(0.55, 0.95, h));

          if (d.y > 0.03) {
            vec2 uv = d.xz / max(d.y, 0.10) * 0.30 + vec2(time*0.0016, 0.0);
            float c = fbm(uv * 2.0);
            c = smoothstep(0.46, 0.80, c) * smoothstep(0.03, 0.22, d.y);
            vec3 cloudCol = mix(vec3(0.86,0.90,0.94), vec3(1.0,0.99,0.96), c*0.6);
            col = mix(col, cloudCol, c * 0.62);
          }

          float sd = max(dot(d, sunDir), 0.0);
          col += vec3(1.0, 0.95, 0.82) * pow(sd, 90.0) * 1.1;
          col += vec3(1.0, 0.90, 0.70) * pow(sd, 8.0) * 0.14;

          gl_FragColor = vec4(col, 1.0);
        }
      `
    });
    skyMesh = new THREE.Mesh(geo, skyMat);
    skyMesh.frustumCulled = false;
    skyMesh.renderOrder = -1000;
    // 必须保持 matrixAutoUpdate=true：天空球每帧跟着相机走，
    // 一旦关掉自动矩阵，position.copy() 就不生效，玩家走远后
    // 会跑到球外面 → 天上出现一道"巨大蓝色圆弧"（已踩过）
    scene.add(skyMesh);
  }

  R.resize = function () {
    if (!canvas || !renderer) return;
    const parent = canvas.parentElement || ROOT;
    const w = parent.clientWidth || ROOT.innerWidth || 1280;
    const h = parent.clientHeight || ROOT.innerHeight || 720;
    // 画质 = 真实分辨率倍率（相对于 CSS 像素），档位调节是真的有效果的。
    // 上限随档位收紧：默认档在 Retina 上不超过 1.5×，只有"高清/超清"才允许 2×，
    // 否则 MacBook 一进游戏就是 2 倍像素、直接掉帧。
    const q = Math.max(0.35, Math.min(2, R.quality || 1));
    const dpr = Math.min(ROOT.devicePixelRatio || 1, 2);
    const cap = q >= 1.5 ? 2 : (q >= 1 ? 1.5 : 1.3);
    const scale = Math.max(0.4, Math.min(cap, q * dpr));
    renderer.setPixelRatio(scale);
    renderer.setSize(w, h, false);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    applyShadowQuality(q);
  };

  /** 阴影贴图分辨率按画质档位切换（低档位减半，省一大截带宽） */
  function applyShadowQuality(q) {
    const level = q >= 1.5 ? 2 : q >= 0.95 ? 1 : 0;
    if (level === shadowLevel) return;
    shadowLevel = level;
    const size = level === 2 ? 2048 : level === 1 ? 1536 : 1024;
    sun.shadow.mapSize.set(size, size);
    if (sun.shadow.map) {
      sun.shadow.map.dispose();
      sun.shadow.map = null;
    }
  }

  /* ---------------- 地形：分块网格 ----------------
     面绕序约定：四角按"从外侧看逆时针"给，且 UV 逐角对应。
     （历史上地面/墙顶的 +Y 面绕序写反，被背面剔除 → 整个世界看起来像悬空，
       这是"地面一片纯色/看不到墙顶"的根因，勿回退。） */
  function wallHeight(type) {
    const PPW = PP.World;
    if (PPW && PPW.wallHeight && PPW.wallHeight[type] !== undefined) return PPW.wallHeight[type];
    return 1.5;
  }

  function pushQuad(P, N, U, C, c0, c1, c2, c3, n, uv, tint) {
    const seq = [c0, c1, c2, c0, c2, c3];
    const uvs = [uv[0], uv[1], uv[2], uv[1], uv[2], uv[3], uv[0], uv[1], uv[2], uv[3], uv[0], uv[3]];
    const tr = tint[0], tg = tint[1], tb = tint[2];
    for (let i = 0; i < 6; i++) {
      const v = seq[i];
      P.push(v[0], v[1], v[2]);
      N.push(n[0], n[1], n[2]);
      U.push(uvs[i * 2], uvs[i * 2 + 1]);
      C.push(tr, tg, tb);
    }
  }

  /* 皮肤色调（sRGB hex）→ 线性 RGB，用于顶点色调制。
     没有这一步，沙地/水面/原木等会全部变成同一种石头灰。
     返回值是复用数组（pushQuad 立即拷走），避免逐格产生垃圾。 */
  const tintCache = new Map();
  const tintTmp = new THREE.Color();
  function tintOf(hex, k) {
    const kk = k === undefined ? 1 : k;
    const key = hex * 128 + Math.round(kk * 64);
    let t = tintCache.get(key);
    if (!t) {
      tintTmp.setHex(hex);
      t = [tintTmp.r * kk, tintTmp.g * kk, tintTmp.b * kk];
      tintCache.set(key, t);
    }
    return t;
  }

  /** 顶面（+Y）：u 沿 +z，v 沿 +x */
  function pushTop(P, N, U, C, x0, y, z0, x1, z1, uv, tint) {
    pushQuad(P, N, U, C,
      [x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0],
      [0, 1, 0], uv, tint);
  }

  /** 侧立面：按 rows 段纵向平铺（墙高 >1 格时纹理不会被拉长） */
  function pushSide(P, N, U, C, axis, x0, z0, x1, z1, y0, y1, uv, tint) {
    const h = y1 - y0;
    const rows = Math.max(1, Math.round(h / 1.0));
    const rh = h / rows;
    for (let r = 0; r < rows; r++) {
      const a = y0 + r * rh, b = a + rh;
      if (axis === '+x') {
        pushQuad(P, N, U, C,
          [x1, a, z1], [x1, a, z0], [x1, b, z0], [x1, b, z1],
          [1, 0, 0], uv, tint);
      } else if (axis === '-x') {
        pushQuad(P, N, U, C,
          [x0, a, z0], [x0, a, z1], [x0, b, z1], [x0, b, z0],
          [-1, 0, 0], uv, tint);
      } else if (axis === '+z') {
        pushQuad(P, N, U, C,
          [x0, a, z1], [x1, a, z1], [x1, b, z1], [x0, b, z1],
          [0, 0, 1], uv, tint);
      } else {
        pushQuad(P, N, U, C,
          [x1, a, z0], [x0, a, z0], [x0, b, z0], [x1, b, z0],
          [0, 0, -1], uv, tint);
      }
    }
  }

  function makeGeo(P, N, U, C) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(P), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(N), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(U), 2));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(C), 3));
    g.computeBoundingSphere();
    return g;
  }

  function buildWorld(G) {
    const Wd = PP.World;
    if (!Wd || !Wd.wall) return;
    // 种子必须进 key：否则重开一局换了 seed 却复用上一局的地形（穿模）
    const key = `${Wd.SIZE}|${Wd.seed}|${Wd.pois ? Wd.pois.length : 0}|${Wd._stamp || 0}`;
    if (worldBuilt && lastWorldKey === key) return;
    lastWorldKey = key;

    disposeWorld();
    chunks.length = 0;
    worldBuilt = true;

    const SIZE = Wd.SIZE;
    const wall = Wd.wall;
    const floor = Wd.floor;
    const mat = atlasMaterial();

    const solidAt = (x, z) => (x < 0 || z < 0 || x >= SIZE || z >= SIZE) ? true : wall[z * SIZE + x] !== 0;

    const N = Math.ceil(SIZE / CHUNK);
    for (let cz = 0; cz < N; cz++) {
      for (let cx = 0; cx < N; cx++) {
        const x0 = cx * CHUNK, z0 = cz * CHUNK;
        const x1 = Math.min(SIZE, x0 + CHUNK), z1 = Math.min(SIZE, z0 + CHUNK);

        const fP = [], fN = [], fU = [], fC = [];
        const wP = [], wN = [], wU = [], wC = [];

        for (let z = z0; z < z1; z++) {
          for (let x = x0; x < x1; x++) {
            const i = z * SIZE + x;
            const wt = wall[i];
            if (wt) {
              const h = wallHeight(wt);
              const skin = WALL_SKIN[wt] || WALL_SKIN[1];
              const uv = atlasUV(skin.map || 'stone');
              const nX = solidAt(x + 1, z), pX = solidAt(x - 1, z);
              const nZ = solidAt(x, z + 1), pZ = solidAt(x, z - 1);
              const buried = nX && pX && nZ && pZ;
              if (!buried) {
                pushTop(wP, wN, wU, wC, x, h, z, x + 1, z + 1, uv, tintOf(skin.color, 1.08));
              }
              if (!nX) pushSide(wP, wN, wU, wC, '+x', x, z, x + 1, z + 1, 0, h, uv, tintOf(skin.color, 1.0));
              if (!pX) pushSide(wP, wN, wU, wC, '-x', x, z, x + 1, z + 1, 0, h, uv, tintOf(skin.color, 0.93));
              if (!nZ) pushSide(wP, wN, wU, wC, '+z', x, z, x + 1, z + 1, 0, h, uv, tintOf(skin.color, 0.97));
              if (!pZ) pushSide(wP, wN, wU, wC, '-z', x, z, x + 1, z + 1, 0, h, uv, tintOf(skin.color, 0.86));
              // 墙体占格 → 该格地面被压住，不生成（省 ~15% 地面三角形）
              continue;
            }
            const ty = floor ? (floor[i] || 0) : 0;
            const fskin = FLOOR_SKIN[ty] || FLOOR_SKIN[0];
            const fuv = atlasUV(fskin.map || 'grass');
            // 棋盘微差，避免大片纯色
            const hv = ((x * 73856093) ^ (z * 19349663)) & 255;
            pushTop(fP, fN, fU, fC, x, 0, z, x + 1, z + 1, fuv, tintOf(fskin.color, 0.95 + (hv / 255) * 0.10));
          }
        }

        const chunk = { x0, z0, x1, z1, cx, cz, walls: null, floor: null };
        if (wP.length) {
          const m = new THREE.Mesh(makeGeo(wP, wN, wU, wC), mat);
          m.name = `walls_${cx}_${cz}`;
          m.castShadow = true;
          m.receiveShadow = true;
          m.matrixAutoUpdate = false;
          m.updateMatrix();
          worldGroup.add(m);
          chunk.walls = m;
        }
        if (fP.length) {
          const m = new THREE.Mesh(makeGeo(fP, fN, fU, fC), mat);
          m.name = `floor_${cx}_${cz}`;
          m.castShadow = false;
          m.receiveShadow = true;
          m.matrixAutoUpdate = false;
          m.updateMatrix();
          worldGroup.add(m);
          chunk.floor = m;
        }
        if (chunk.walls || chunk.floor) chunks.push(chunk);
      }
    }

    try {
      const arch = buildArchitecture(Wd);
      arch.matrixAutoUpdate = false;
      arch.updateMatrix();
      arch.traverse((o) => { o.matrixAutoUpdate = false; o.updateMatrix(); });
      worldGroup.add(arch);
    } catch (err) {
      if (typeof console !== 'undefined') console.warn('arch', err);
    }
  }

  function disposeWorld() {
    for (let i = worldGroup.children.length - 1; i >= 0; i--) {
      const c = worldGroup.children[i];
      worldGroup.remove(c);
      c.traverse((n) => {
        if (n.geometry) n.geometry.dispose();
      });
      // 材质是全局共享的（图集），不在这里 dispose
    }
  }

  /** 距离剔除：雾外/背后的区块不必进渲染与阴影 pass */
  function cullChunks(camX, camZ) {
    const lim = FAR * 0.92;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const dx = Math.max(c.x0 - camX, 0, camX - c.x1);
      const dz = Math.max(c.z0 - camZ, 0, camZ - c.z1);
      const near = Math.sqrt(dx * dx + dz * dz);
      const vis = near < lim;
      if (c.walls) c.walls.visible = vis;
      if (c.floor) c.floor.visible = vis;
    }
  }

  /* ---------------- 实体 ---------------- */
  function makeEntity(id, mesh) {
    entityGroup.add(mesh);
    const e = { mesh, kind: mesh.name || 'ent' };
    entityPool.set(id, e);
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

  /* ---------------- 枪 ---------------- */
  let weaponMesh = null;
  let weaponKind = '';
  let camShake = 0;
  let muzzleFlash = null;
  const muzzleDir = new THREE.Vector3();

  function ensureMuzzleFlash() {
    if (muzzleFlash) return;
    // 点光只能照亮近处，真正"看得见"的火光得有个面片。
    // 它是相机的子节点，PlaneGeometry 默认朝 +Z → 永远正对相机。
    // 尺寸必须小（0.14 见方）：之前用 0.30 会在屏幕上糊出一大块方卡。
    const S = 64;
    const c = ROOT.document.createElement('canvas');
    c.width = c.height = S;
    const cx2 = c.getContext('2d');
    const rg = cx2.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    rg.addColorStop(0, 'rgba(255,255,238,1)');
    rg.addColorStop(0.32, 'rgba(255,214,120,0.78)');
    rg.addColorStop(1, 'rgba(255,150,40,0)');
    cx2.fillStyle = rg;
    cx2.fillRect(0, 0, S, S);
    cx2.globalCompositeOperation = 'lighter';
    cx2.strokeStyle = 'rgba(255,242,200,0.8)';
    cx2.lineWidth = 2.5;
    cx2.lineCap = 'round';
    for (let i = 0; i < 6; i++) {
      const a = i * Math.PI / 3;
      cx2.beginPath();
      cx2.moveTo(S / 2, S / 2);
      cx2.lineTo(S / 2 + Math.cos(a) * S * 0.45, S / 2 + Math.sin(a) * S * 0.45);
      cx2.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, opacity: 1,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, fog: false
    });
    muzzleFlash = new THREE.Mesh(new THREE.PlaneGeometry(0.14, 0.14), m);
    muzzleFlash.position.set(0, 0.045, -0.50);
    muzzleFlash.frustumCulled = false;
    muzzleFlash.renderOrder = 999;
    weaponRoot.add(muzzleFlash);
  }

  function ensureWeapon(kind) {
    if (weaponMesh && weaponKind === kind) return;
    if (weaponMesh) {
      weaponRoot.remove(weaponMesh);
      disposeObject(weaponMesh);
    }
    weaponMesh = buildWeaponView(kind);
    weaponMesh.scale.setScalar(0.75);
    weaponKind = kind;
    weaponRoot.add(weaponMesh);
    ensureMuzzleFlash();
  }

  /* ---------------- 粒子（单 draw call） ---------------- */
  const MAX_PARTICLES = 320;
  const PARTICLE_COLORS = {
    blood: 0x5cc840, spark: 0xffe282, gib: 0x78c46c,
    boom: 0xff7828, smoke: 0x8a8a8a
  };
  const PARTICLE_ORDER = ['blood', 'spark', 'gib', 'boom', 'smoke'];
  let pMesh = null;
  const pColorOf = {};
  const pTmpColor = new THREE.Color();

  function initParticles() {
    const geo = new THREE.BoxGeometry(0.08, 0.08, 0.08);
    const mat = makeLambert(0xffffff);
    pMesh = new THREE.InstancedMesh(geo, mat, MAX_PARTICLES);
    pMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    pMesh.frustumCulled = false;
    pMesh.castShadow = false;
    pMesh.receiveShadow = false;
    pMesh.count = 0;
    // 先铺一遍把 instanceColor 缓冲分配出来
    pTmpColor.setHex(0xffffff);
    for (let i = 0; i < MAX_PARTICLES; i++) pMesh.setColorAt(i, pTmpColor);
    for (const k of PARTICLE_ORDER) pColorOf[k] = new THREE.Color(PARTICLE_COLORS[k]);
    fxGroup.add(pMesh);
  }

  function syncParticles(G) {
    const list = G.particles || [];
    const n = Math.min(list.length, MAX_PARTICLES);
    for (let i = 0; i < n; i++) {
      const q = list[i];
      const s = 0.5 + (q.size || 1) * 0.8;
      tmpObj.position.set(q.x, q.z, q.y);
      tmpObj.rotation.set(0, 0, 0);
      tmpObj.scale.setScalar(s);
      tmpObj.updateMatrix();
      pMesh.setMatrixAt(i, tmpObj.matrix);
      pMesh.setColorAt(i, pColorOf[q.tex] || pColorOf.blood);
    }
    pMesh.count = n;
    pMesh.instanceMatrix.needsUpdate = true;
    if (pMesh.instanceColor) pMesh.instanceColor.needsUpdate = true;
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
    const eye = selfDown ? EYE_DOWN : EYE;
    const pitch = (camObj.pitch !== undefined ? camObj.pitch : camObj.tpitch) || 0;
    const yaw = camObj.a || 0;

    camShake = (G.shake || 0) * 0.15 + (G.kickPitch || 0) * 0.05;
    const viewY = (G.viewOffsetY || 0) * 0.002;

    const camX = camObj.x;
    const camY = eye + viewY + (camShake > 0.001 ? (Math.random() - 0.5) * camShake * 0.3 : 0);
    const camZ = camObj.y;

    camera.position.set(camX, camY, camZ);
    camera.rotation.y = -yaw - Math.PI / 2;
    camera.rotation.x = pitch + camShake * 0.4;
    camera.rotation.z = camShake * 0.2;

    // 光照跟随（阴影贴图只覆盖 ±30，必须跟着玩家走）
    sun.position.set(camX + 24, 40, camZ + 16);
    sun.target.position.set(camX, 0, camZ);
    sun.target.updateMatrixWorld();
    if (skyMesh) skyMesh.position.copy(camera.position);
    if (skyMat) skyMat.uniforms.time.value = performance.now() * 0.001;

    cullChunks(camX, camZ);

    const now = performance.now();
    const tSec = now * 0.001;

    activeIds.clear();
    enemyDist.length = 0;

    const enemies = G.enemies || [];
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i];
      const dx = e.x - camX, dz = e.y - camZ;
      enemyDist.push({ e, d2: dx * dx + dz * dz, i });
    }
    // 远的先剔除（雾里本来也看不见；同时省掉阴影 pass 里的绘制）。
    // 近的优先渲染，超过 MAX_ENEMY_DRAW 只保留最近的若干只，
    // 否则后期 30+ 只怪会让 draw call 直接翻好几倍。
    enemyDist.sort((a, b) => a.d2 - b.d2);
    const far2 = ENEMY_DRAW_DIST * ENEMY_DRAW_DIST;
    for (let k = 0; k < enemyDist.length; k++) {
      const it = enemyDist[k];
      const e = it.e;
      const id = 'e' + (e.id !== undefined ? e.id : it.i);
      // 注意：即使因为太远/超预算而隐藏，也要留在 activeIds 里，
      // 否则 releaseStale 会把它回收掉，下一帧又重建 → 反复分配 GPU 缓冲。
      activeIds.add(id);
      const skip = it.d2 > far2 || k >= MAX_ENEMY_DRAW;
      let ent = entityPool.get(id);
      if (skip) {
        if (ent) ent.mesh.visible = false;
        continue;
      }
      if (!ent) ent = makeEntity(id, buildEnemy(e.type));
      const mesh = ent.mesh;
      mesh.visible = true;
      const dead = e.state === 'dead';
      const mode = dead ? 'dead' : (e.windup > 0 ? 'attack' : (e.hurt > 0 ? 'hurt' : 'walk'));
      mesh.position.set(e.x, e.z0 || 0, e.y);
      const face = e.face !== undefined ? e.face : (e.a !== undefined ? e.a : yaw);
      mesh.rotation.y = Math.PI / 2 - face;
      if (e.type === 'spider') animateSpider(mesh, tSec, dead ? 0 : 1);
      else animateHumanoid(mesh, tSec, dead ? 0 : (e.state === 'alive' ? 1 : 0.4), mode);
      setFlash(mesh, e.hurt > 0 ? 1 : 0);
    }

    // 队友
    const mates = G.mates || [];
    for (let i = 0; i < mates.length; i++) {
      const m = mates[i];
      if (!m || m.eliminated) continue;
      const id = 'p' + (m.id !== undefined ? m.id : i);
      let ent = entityPool.get(id) || makeEntity(id, buildPlayer(m.colorIdx || 0));
      activeIds.add(id);
      ent.mesh.visible = true;
      ent.mesh.position.set(m.x, 0, m.y);
      ent.mesh.rotation.y = Math.PI / 2 - (m.a || 0);
      const mode = m.downed ? 'dead' : (m.fireT > 0 ? 'attack' : 'walk');
      animateHumanoid(ent.mesh, tSec, m.downed ? 0 : 1, mode);
    }

    // 拾取物
    const pickups = G.pickups || [];
    for (let i = 0; i < pickups.length; i++) {
      const it = pickups[i];
      const id = 'k' + (it.id !== undefined ? it.id : i);
      activeIds.add(id);
      const dx = it.x - camX, dz = it.y - camZ;
      if (dx * dx + dz * dz > 3600) {
        const old = entityPool.get(id);
        if (old) old.mesh.visible = false;
        continue;
      }
      let ent = entityPool.get(id) || makeEntity(id, buildPickup(it.kind));
      ent.mesh.visible = true;
      const bob = 0.16 + Math.sin((it.t || 0) + tSec * 3) * 0.05;
      ent.mesh.position.set(it.x, bob, it.y);
      ent.mesh.rotation.y = tSec + (it.t || 0);
    }

    // 投射物
    const projectiles = G.projectiles || [];
    for (let i = 0; i < projectiles.length; i++) {
      const b = projectiles[i];
      const id = 'b' + i;
      let ent = entityPool.get(id) || makeEntity(id, buildBoneProjectile());
      activeIds.add(id);
      ent.mesh.visible = true;
      ent.mesh.position.set(b.x, (b.z || 0.6) - 0.1, b.y);
    }

    releaseStale(activeIds);
    syncParticles(G);

    // ---- 手中武器 ----
    const showGun = !spectating && !p.eliminated && !p.downed;
    if (showGun) {
      const wid = (G.weapon !== undefined && G.weapon !== null) ? G.weapon : 0;
      const wdef = (PP.WEAPONS && PP.WEAPONS[wid]) || (PP.WEAPON_BY_ID && PP.WEAPON_BY_ID(wid));
      ensureWeapon((wdef && wdef.pick) || 'pistol');
      weaponRoot.visible = true;
      const swayX = (G.weaponSwayX || 0) * 0.10;
      const bobY = (G.weaponBobY || 0) * 0.0016;
      const raise = (G.weaponRaise || 0) * 0.008;
      // 视模防穿墙：沿视线探测到墙则拉近枪
      let weaponZ = -0.44;
      if (PP.World && PP.World.rayWall) {
        const dx = Math.cos(yaw) * Math.cos(pitch);
        const dy = Math.sin(yaw) * Math.cos(pitch);
        const wallD = PP.World.rayWall(camObj.x, camObj.y, dx, dy, 1.1);
        if (wallD < 0.7) {
          const k = Math.max(0.15, (wallD - 0.16) / 0.54);
          weaponZ = -0.17 - 0.27 * k;
        }
      }
      weaponRoot.position.set(0.185 + swayX, -0.135 + bobY + raise, weaponZ);
      weaponRoot.rotation.set(0.03 + (G.kickPitch || 0) * 0.4, 0.10, 0.015);
      if (G.muzzleT > 0) {
        const k = Math.min(1, G.muzzleT / 0.06);
        muzzleLight.intensity = 4.5 * k;
        muzzleDir.set(0, 0, -1).applyQuaternion(camera.quaternion);
        muzzleLight.position.copy(camera.position).addScaledVector(muzzleDir, 0.8);
        if (muzzleFlash) {
          muzzleFlash.visible = true;
          muzzleFlash.scale.setScalar(0.85 + k * 0.55);
          muzzleFlash.rotation.z = Math.random() * 6.283;
          muzzleFlash.material.opacity = 0.45 + k * 0.55;
        }
      } else {
        muzzleLight.intensity = 0;
        if (muzzleFlash) muzzleFlash.visible = false;
      }
    } else {
      weaponRoot.visible = false;
      muzzleLight.intensity = 0;
    }

    G.spectateName = spectating ? (camObj.name || '队友') : '';

    // 阴影贴图节流：隔帧更新（人的眼睛看不出 15Hz 的影子移动，但省一半阴影开销）
    shadowFrame++;
    renderer.shadowMap.needsUpdate = (shadowFrame & 1) === 0;

    renderer.render(scene, camera);
    drawMinimap(G, now);
  };

  /* ---------------- 小地图（2D 叠加，节流到 8Hz） ---------------- */
  let mm = null, mmCtx = null, mmLast = 0, mmScale = 1;
  function drawMinimap(G, now) {
    if (!ROOT.document) return;
    if (!mm) {
      mm = ROOT.document.getElementById('bw-minimap');
      if (!mm) {
        mm = ROOT.document.createElement('canvas');
        mm.id = 'bw-minimap';
        mm.width = 160;
        mm.height = 160;
        mm.className = 'bw-minimap';
        (ROOT.document.getElementById('hud') || ROOT.document.body).appendChild(mm);
      }
      mmCtx = mm.getContext('2d');
      mmScale = mm.width / (PP.World ? PP.World.SIZE : 192);
    }
    if (now - mmLast < 120) return;    // ≈8Hz，没必要每帧重绘 128² 的地图
    mmLast = now;

    const ctx = mmCtx;
    const Wd = PP.World;
    if (!ctx || !Wd || !Wd.wall) return;
    const SIZE = Wd.SIZE;
    const mw = mm.width;
    const scale = mmScale;
    const p = G.player;
    const px = p.x, py = p.y;
    const R2 = 34;                       // 只画周围 R2 格（放大后可读性好）

    ctx.clearRect(0, 0, mw, mw);
    ctx.fillStyle = 'rgba(10,22,18,0.62)';
    ctx.fillRect(0, 0, mw, mw);

    const view = mw / (R2 * 2);          // 像素/格
    const ox = mw / 2 - px * view;
    const oy = mw / 2 - py * view;
    const x0 = Math.max(0, Math.floor(px - R2)), x1 = Math.min(SIZE - 1, Math.ceil(px + R2));
    const y0 = Math.max(0, Math.floor(py - R2)), y1 = Math.min(SIZE - 1, Math.ceil(py + R2));
    const cell = Math.max(1.5, view);
    for (let y = y0; y <= y1; y++) {
      const row = y * SIZE;
      for (let x = x0; x <= x1; x++) {
        const t = Wd.wall[row + x];
        if (!t) continue;
        ctx.fillStyle = t === 6 ? '#3f7f2a' : t === 5 ? '#6a4a2a'
          : t === 2 ? '#9a7444' : t === 3 ? '#9e5648'
            : t === 8 ? '#a83830' : t === 9 ? '#4a4c56' : '#8e8e88';
        ctx.fillRect(ox + x * view, oy + y * view, cell, cell);
      }
    }
    // 队友 / 敌人 / 补给
    if (G.mates) {
      for (const m of G.mates) {
        if (m.eliminated) continue;
        ctx.fillStyle = m.downed ? '#ff9c3c' : '#8fd8ff';
        ctx.fillRect(ox + m.x * view - 2, oy + m.y * view - 2, 4, 4);
      }
    }
    for (const e of (G.enemies || [])) {
      if (e.state !== 'alive') continue;
      const d2 = (e.x - px) * (e.x - px) + (e.y - py) * (e.y - py);
      if (d2 > R2 * R2) continue;
      ctx.fillStyle = e.type === 'husk' ? '#e8c078' : e.type === 'skeleton' ? '#f4f2e6'
        : e.type === 'creeper' ? '#6fdc4a' : e.type === 'spider' ? '#c080e0' : '#8fe06a';
      ctx.fillRect(ox + e.x * view - 1.5, oy + e.y * view - 1.5, 3, 3);
    }
    for (const it of (G.pickups || [])) {
      const d2 = (it.x - px) * (it.x - px) + (it.y - py) * (it.y - py);
      if (d2 > R2 * R2) continue;
      ctx.fillStyle = '#ffe066';
      ctx.fillRect(ox + it.x * view - 1.5, oy + it.y * view - 1.5, 3, 3);
    }
    // 玩家（永远在正中）
    ctx.save();
    ctx.translate(mw / 2, mw / 2);
    ctx.rotate(p.a + Math.PI / 2);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(0, -6); ctx.lineTo(4.5, 5); ctx.lineTo(0, 2.5); ctx.lineTo(-4.5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    // 边框十字
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(mw / 2, 3); ctx.lineTo(mw / 2, mw - 3);
    ctx.moveTo(3, mw / 2); ctx.lineTo(mw - 3, mw / 2);
    ctx.stroke();
  }

  /** 受击闪白：只做缩放脉冲（材质是共享的，不能逐实体改色） */
  function setFlash(mesh, amount) {
    const s = amount > 0 ? 1 + amount * 0.06 : 1;
    if (mesh.userData._flash !== s) {
      mesh.userData._flash = s;
      mesh.scale.setScalar(s);
    }
  }

  // 诊断钩子
  R.getStats = function () {
    if (!renderer) return null;
    const info = renderer.info;
    return {
      calls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      chunks: chunks.length,
      quality: +R.quality.toFixed(2),
      shadow: shadowLevel
    };
  };
  R._scene = () => scene;
  R._camera = () => camera;
  R._renderer = () => renderer;
  R._worldGroup = () => worldGroup;
  R._chunks = () => chunks;
})();
