/* ============================================================
   render3d.js — Three.js 渲染器
   契约：PP.Render.init(canvas) / resize() / frame(G) / quality
   世界：图集贴图 + 分块合并网格（32×32 一格一块）→ 视锥/距离剔除
   实体：程序化低模（models.js），按距离做 LOD 休眠
   ============================================================ */
import * as THREE from 'three';
import {
  makeLambert, atlasMaterial, atlasUV, setAnisotropy,
  blockFaceTable, biomeShaded, blendMaterial, K_BLEND
} from '../three/materials.js';
import { preloadAtlas, atlasReady } from '../three/textures.js';
import { preloadEntityAtlas, entityReady } from '../three/mcModel.js';
import {
  buildPlayer, buildEnemy, buildWeaponView, buildPickup,
  buildBoneProjectile, animateHumanoid, animateSpider, disposeObject
} from '../three/models.js';

(function () {
  const ROOT = (typeof window !== 'undefined') ? window : globalThis;
  const PP = (ROOT.PP = ROOT.PP || {});
  const R = (PP.Render = PP.Render || {});

  // 视高按 Minecraft 原版：玩家模型 1.8 米，眼睛在 1.62 米
  // （旧的自定义模型只高 0.98 米，换原版模型后必须同步抬高，否则视线在胸口）
  const EYE = 1.62;          // 站立视高
  const EYE_DOWN = 0.42;     // 倒地视高（爬行时的眼睛贴地）
  const FOV = 72;
  const NEAR = 0.06;
  const FAR = 120;
  // 体素世界每个 chunk 是 CHUNK×CHUNK×HEIGHT，边长给 32 会让单个 mesh
  // 装下上万个面、视锥剔除粒度太粗；给 16 → 12×12 = 144 块，剔除更细。
  const CHUNK = 16;          // 地形分块边长（格）
  // 雾密度：明亮卡通要"看得远"。太浓会让远景糊成一片灰，
  // 与天空的明亮蓝白形成"阴天"错觉（这是美术统一前的实际观感）。
  // Minecraft 的雾很"远"：默认渲染距离内几乎看不出雾，远方才淡淡地化进天空色。
  // 密度给大了远处会糊成一片白，整幅画面立刻失去"方块世界"的通透感。
  const FOG_DENSITY = 0.0062;
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
  // 太阳相对相机的偏移（每帧 sun.position = 相机 + 该偏移），仰角 ≈ 36°。
  // 压低到 36° 是为了让影子够长（影长 ≈ 1.4×物高）—— 43° 时影子缩在方块脚下，
  // 整个画面看起来没有明暗关系。暴露出来是为了让取景脚本能换角度验证阴影；
  // 以后做昼夜循环也从这里走。
  R.sunOffset = new THREE.Vector3(30, 26, 20);

  /* ---------------- 初始化 ---------------- */
  /** 预加载 Minecraft 原版纹理图集。
      必须在 init 之前完成：材质与地形 UV 都在 init 里按图集布局算好，
      图集晚到会导致已经建好的地形 UV 错位。由 game.js 的 boot() 等待。 */
  R.preload = async function () {
    await Promise.all([preloadAtlas(), preloadEntityAtlas()]);
  };

  /** 纹理是否已就绪。调用它会顺带启动加载（幂等）。
      存在的意义：Node 同步断言环境（tools/verify.js）下这两个都"立即就绪"，
      boot() 就不必 await，能做到同步跑完；浏览器里才真正走异步等待。 */
  R.ready = function () {
    preloadAtlas();
    preloadEntityAtlas();
    return atlasReady() && entityReady();
  };

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
    // 手动节流：地形是静态的、太阳只是平移，隔帧重算够用，省一半阴影通道开销。
    // ⚠️ 注意：SwiftShader 软件 GL 下 draw call 会涨上去（阴影通道确实在渲染）
    // 但屏幕上不出现影子 —— 是软件渲染器不支持深度比较采样，不是配置问题，
    // 真机 GPU 上是正常的。别因为这个把阴影配置改坏。
    renderer.shadowMap.autoUpdate = false;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.LinearToneMapping;
    // 曝光：贴图基色在线性空间偏暗，需要提亮；但不能过头——
    // 1.35 时受光面会过曝（树叶被打成亮黄绿、银色枪身白到发光），
    // 明亮卡通的观感来自"色彩饱和"，不是"亮度拉满"。
    renderer.toneMappingExposure = 1.15;
    // 掠射角贴图清晰度：按 GPU 上限开满各向异性
    try {
      const maxA = renderer.capabilities.getMaxAnisotropy();
      setAnisotropy(maxA);
    } catch (e) { setAnisotropy(8); }

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x9ad4f7);
    // 雾色必须与地平线同色系：雾用灰色会让远景整体发闷，
    // 玩家看到的是"明亮的远处"，不是"阴天"。
    scene.fog = new THREE.FogExp2(0xcfe8fa, FOG_DENSITY);

    camera = new THREE.PerspectiveCamera(FOV, 1, NEAR, FAR);
    camera.rotation.order = 'YXZ';

    // 光照配比（明亮卡通）：太阳主导 + 克制的环境光。
    // ⚠️ 环境光/半球光加太多会"把画面照平"——曾经的 0.46+0.45 让受光面与
    // 背光面只差 ~1.4 倍，整幅画面像贴了层塑料膜，方块完全没有体积感。
    // 当前配比：受光面 ≈ 反照率×1.9，侧面 ×1.4，背光面 ×0.6（明暗拉开 3 倍）。
    // 注意环境光的色偏：给蓝会让整个世界的中性灰（石头/石砖）泛蓝，
    // 石砖地面会变成"蓝灰色地板"——环境光要接近中性。
    ambient = new THREE.AmbientLight(0xe6eef6, 0.30);
    scene.add(ambient);

    hemi = new THREE.HemisphereLight(0xdff0ff, 0x9cc46a, 0.34);
    scene.add(hemi);

    sun = new THREE.DirectionalLight(0xfff6e2, 1.55);
    // 太阳压低到 ~36°：影子被拉长到 1.4 倍物高，方块之间才有"体积感"。
    // 高角度（54°）时影子缩在方块脚下，画面看起来同样是一片平。
    sun.position.copy(R.sunOffset);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 110;
    const sc = 30;
    sun.shadow.camera.left = -sc;
    sun.shadow.camera.right = sc;
    sun.shadow.camera.top = sc;
    sun.shadow.camera.bottom = -sc;
    sun.shadow.bias = -0.0005;
    // ⚠️ normalBias 不能再往下调：0.028 时大平面（地面）会大面积自遮挡
    // （shadow acne）→ 整个地面像蒙了层灰，比"影子略微偏移"难看得多。
    // 0.04 是本调的平衡点。
    sun.shadow.normalBias = 0.04;
    // 关键：改过 left/right/top/bottom 之后必须手动重算投影矩阵，
    // 否则阴影相机还是构造时的 ±5 默认框 → 稍远一点就完全没有影子（已踩过）
    sun.shadow.camera.updateProjectionMatrix();
    scene.add(sun);
    scene.add(sun.target);

    fill = new THREE.DirectionalLight(0xbcdcff, 0.22);
    fill.position.set(-24, 22, -18);
    scene.add(fill);

    rim = new THREE.DirectionalLight(0xffe0b8, 0.14);
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
    // 与天空 shader 同一套配色：IBL 的色调直接决定金属/高光件的观感
    g.addColorStop(0, '#5ea4ea');
    g.addColorStop(0.42, '#b4dcf8');
    g.addColorStop(0.5, '#e2f1fd');
    g.addColorStop(0.58, '#a8c878');
    g.addColorStop(1, '#7a9c58');
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
      if ('environmentIntensity' in scene) scene.environmentIntensity = 0.32;
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
        // 明亮卡通天光：天顶蓝 → 中段亮蓝 → 地平线近乎白的浅蓝。
        // 千万别用灰（灰 = 阴天，整幅画面立刻发闷，这是美术统一前的实际观感）
        top: { value: new THREE.Color(0x5ea4ea) },
        mid: { value: new THREE.Color(0x9dd0f8) },
        bottom: { value: new THREE.Color(0xe6f4fe) },
        sunDir: { value: new THREE.Vector3(0.55, 0.62, 0.42).normalize() },
        camXZ: { value: new THREE.Vector2(0, 0) },
        time: { value: 0 }
      },
      vertexShader: `
        varying vec3 vDir;
        void main() {
          vDir = normal;                       // 球体法线就是方向，比 normalize(position) 更准
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 top; uniform vec3 mid; uniform vec3 bottom;
        uniform vec3 sunDir; uniform vec2 camXZ; uniform float time;
        varying vec3 vDir;

        float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1,311.7))) * 43758.5453); }

        /* 云参数：云层高度与格子边长都用"天空球半径"为单位。
           CLOUD_H=0.60 / CLOUD_CELL=0.085 是本调的甜点：
           天顶一块云约占垂直视野 1/9，横排 8~9 块，接近 Minecraft 观感。 */
        const float CLOUD_H = 0.60;
        const float CLOUD_CELL = 0.085;

        void main() {
          vec3 d = normalize(vDir);
          float h = clamp(d.y, -1.0, 1.0) * 0.5 + 0.5;
          vec3 col = mix(bottom, mid, smoothstep(0.42, 0.56, h));
          col = mix(col, top, smoothstep(0.54, 0.96, h));

          /* Minecraft 式方块云。
             ⚠️ 必须用"射线与云平面求交"的坐标，不能直接把 d.xz/d.y 当 uv ——
             那样算出来整个天空只覆盖 ±1.6 个格子，一块云占半屏，
             天空会变成插着几块巨大白多边形板（已踩过，观感极差）。 */
          if (d.y > 0.015) {
            float t = CLOUD_H / d.y;                        // 交点到相机的距离（球半径）
            vec2 p = d.xz * t + camXZ * 0.01136;            // 1/88：相机位移换算成球面坐标，云才有视差
            vec2 cuv = p / CLOUD_CELL + vec2(time * 0.020, time * 0.008);  // 缓慢飘移

            vec2 q = floor(cuv);
            // 邻域投票：让云团成片。孤立小方块看起来是屏幕噪点，不是云；
            // 但阈值不能给低 —— 覆盖率高过 ~25% 就会糊成"白蓝棋盘格"，
            // Minecraft 的云是稀疏的大片，蓝天要占大头。
            float n = hash(q) * 0.30
                    + hash(q + vec2( 1.0, 0.0)) * 0.14
                    + hash(q + vec2(-1.0, 0.0)) * 0.14
                    + hash(q + vec2( 0.0, 1.0)) * 0.14
                    + hash(q + vec2( 0.0,-1.0)) * 0.14
                    + hash(q + vec2( 1.0, 1.0)) * 0.07
                    + hash(q + vec2(-1.0,-1.0)) * 0.07;
            float cloud = step(0.615, n);
            // 密度决定明暗：云团中心纯白，边缘偏冷灰 → 有体块感而不是一张白纸
            float dens = smoothstep(0.615, 0.90, n);
            vec3 cloudCol = mix(vec3(0.85, 0.90, 0.97), vec3(1.0), dens);

            // d.y 趋 0 时格子被透视压得极密，必须淡出，否则地平线糊成噪点带。
            // 淡出区间给宽一点：云要"悬在天上"，不能一直压到地平线上。
            float distFade = 1.0 - smoothstep(14.0, 40.0, length(cuv));
            float fade = smoothstep(0.02, 0.16, d.y) * distFade;
            col = mix(col, cloudCol, cloud * fade * 0.94);
          }

          // 太阳：Minecraft 的太阳是"方块"不是圆盘 —— 这是最强的风格符号之一。
          // 在垂直于 sunDir 的平面上量角度，两个轴上同时 step 出正方形。
          float sd = max(dot(d, sunDir), 0.0);
          vec3 su = normalize(cross(sunDir, vec3(0.0, 1.0, 0.0)));   // 水平基向量
          vec3 sv = normalize(cross(su, sunDir));                     // 垂直基向量
          float ax = abs(dot(d, su)), ay = abs(dot(d, sv));
          float sunMask = step(ax, 0.030) * step(ay, 0.030) * step(0.0, sd);
          col += vec3(1.0, 0.98, 0.92) * sunMask * 1.15;
          // 一圈柔和光晕（让太阳"发光"，不是贴上去的一个白方块）
          col += vec3(1.0, 0.95, 0.80) * pow(sd, 10.0) * 0.14;

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

  /* rot：纹理绕面中心旋转 90°×rot（只用 4 个整数角度，不产生镜像）。
     ao ：[c0,c1,c2,c3] 四角亮度倍数，不传 = 全 1。
     这两个是"画面发平"的解药：UV 旋转打散大面积重复感（Minecraft 的草顶
     也是靠 UV 变体），顶点 AO 制造方块互相遮挡的体积感（smooth lighting）。 */
  function pushQuad(P, N, U, C, c0, c1, c2, c3, n, uv, tint, rot, ao) {
    const seq = [c0, c1, c2, c0, c2, c3];
    const u0 = uv[0], v0 = uv[1], u1 = uv[2], v1 = uv[3];
    let uvs;
    if (rot) {
      // 角序：c0=(u0,v0) c1=(u1,v0) c2=(u1,v1) c3=(u0,v1)
      const cu = [u0, u1, u1, u0], cv = [v0, v0, v1, v1];
      const r0 = rot & 3, r1 = (r0 + 1) & 3, r2 = (r0 + 2) & 3, r3 = (r0 + 3) & 3;
      uvs = [
        cu[r0], cv[r0], cu[r1], cv[r1], cu[r2], cv[r2],
        cu[r0], cv[r0], cu[r2], cv[r2], cu[r3], cv[r3]
      ];
    } else {
      uvs = [u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1];
    }
    const tr = tint[0], tg = tint[1], tb = tint[2];
    const aoSeq = ao ? [ao[0], ao[1], ao[2], ao[0], ao[2], ao[3]] : null;
    for (let i = 0; i < 6; i++) {
      const v = seq[i];
      const m = aoSeq ? aoSeq[i] : 1;
      P.push(v[0], v[1], v[2]);
      N.push(n[0], n[1], n[2]);
      U.push(uvs[i * 2], uvs[i * 2 + 1]);
      C.push(tr * m, tg * m, tb * m);
    }
  }

  /* 皮肤色调（sRGB hex）→ 线性 RGB，用于顶点色调制。
     没有这一步，沙地/水面/原木等会全部变成同一种石头灰。
     返回值是复用数组（pushQuad 立即拷走），避免逐格产生垃圾。 */
  /* 双线性插值的 value noise（CPU 端）。
     直接用 hash(floor(x)) 做地面色差会让色块边界是直角，俯视就是一张棋盘；
     Minecraft 的草地色差是 biome color 渐变 —— 必须插值。 */
  function vhash(a, b, seed) {
    let n = Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(seed, 1274126177);
    n = n ^ (n >>> 13);
    n = Math.imul(n, 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  }
  function vnoise(x, z, seed) {
    const xi = Math.floor(x), zi = Math.floor(z);
    const xf = x - xi, zf = z - zi;
    const sx = xf * xf * (3 - 2 * xf), sz = zf * zf * (3 - 2 * zf);
    const n00 = vhash(xi, zi, seed), n10 = vhash(xi + 1, zi, seed);
    const n01 = vhash(xi, zi + 1, seed), n11 = vhash(xi + 1, zi + 1, seed);
    return (n00 * (1 - sx) + n10 * sx) * (1 - sz) + (n01 * (1 - sx) + n11 * sx) * sz;
  }

  /* 图集 UV 缓存：atlasUV 每次返回新数组，逐格调用会凭空产生上万个临时数组 */
  const uvCache = new Map();
  function atlasUVC(name) {
    let u = uvCache.get(name);
    if (!u) { u = atlasUV(name); uvCache.set(name, u); }
    return u;
  }

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

  /** 顶面（+Y）：u 沿 +z，v 沿 +x。rot = UV 旋转档位（0..3），ao = 四角亮度 */
  function pushTop(P, N, U, C, x0, y, z0, x1, z1, uv, tint, rot, ao) {
    pushQuad(P, N, U, C,
      [x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0],
      [0, 1, 0], uv, tint, rot, ao);
  }

  /** 侧立面：按固定 1 米分段纵向平铺。
      ⚠️ 不能用 h/round(h) 等分：墙高表是 2.0/1.9/2.2/2.85/2.45 这类非整数，
      等分后每段高度 = h/round(h)，纹理会被非均匀拉伸（h=2.45 → 拉长 22%，
      树叶侧面直接变成"横条纹"）。改成每段 1 米、顶段吃余数，
      这样除顶段外纹理都是 1:1。 */
  function pushSide(P, N, U, C, axis, x0, z0, x1, z1, y0, y1, uv, tint) {
    const h = y1 - y0;
    const rows = Math.max(1, Math.ceil(h - 0.001));
    // 墙脚接触阴影：最下面一段的底部两个顶点压暗。
    // Minecraft 的 smooth lighting 就是这么做的 —— 少了它，所有墙都像"浮在草地上"。
    // 顶点顺序里前两个是底（a 高度），后两个是顶（b 高度）。
    // ⚠️ 顶点色是**线性空间**的：0.70 这种值经过 sRGB 编码后屏幕上只暗 13%，
    // 根本看不出来。要"视觉上暗 30%、40%"，线性因子得给到 0.45 / 0.30 ——
    // 换算关系 k_linear ≈ ratio^2.4。这是 AO 一直没效果的真凶。
    const aoBottom = [0.46, 0.46, 1, 1];
    for (let r = 0; r < rows; r++) {
      const a = y0 + r, b = Math.min(y1, a + 1);
      const ao = (r === 0) ? aoBottom : null;
      if (axis === '+x') {
        pushQuad(P, N, U, C,
          [x1, a, z1], [x1, a, z0], [x1, b, z0], [x1, b, z1],
          [1, 0, 0], uv, tint, 0, ao);
      } else if (axis === '-x') {
        pushQuad(P, N, U, C,
          [x0, a, z0], [x0, a, z1], [x0, b, z1], [x0, b, z0],
          [-1, 0, 0], uv, tint, 0, ao);
      } else if (axis === '+z') {
        pushQuad(P, N, U, C,
          [x0, a, z1], [x1, a, z1], [x1, b, z1], [x0, b, z1],
          [0, 0, 1], uv, tint, 0, ao);
      } else {
        pushQuad(P, N, U, C,
          [x1, a, z0], [x0, a, z0], [x0, b, z0], [x1, b, z0],
          [0, 0, -1], uv, tint, 0, ao);
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

  /* ---------------- 体素地形：分块网格 ----------------
     sim 坐标 (x, y, z)：x/y 水平，z 高度；three 位置 = (x, z, y)。
     下面两张表是"世界看不见"的命门，改前先读血泪结论第 2 条：
       缠绕顺序写反 → 被背面剔除 → 整个地面/墙顶消失，只剩灰白虚空。

     FV[f][v]  = 第 f 面第 v 个顶点相对体素最小角的偏移 [dx, dz, dy]
                 （dz 是高度：0 = 方块底、1 = 方块顶）
     FN3[f]    = 该面在 three 空间的法线
     FAO[f][v] = 该顶点角的三个 AO 采样偏移 [side1, side2, corner]
                 —— Minecraft 的 smooth lighting：贴墙的角压暗，
                 没有它所有方块都像"浮在地上"，画面立刻发平。 */
  const FD = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]];
  const FT1 = [[0, 1, 0], [0, 1, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0], [1, 0, 0]];
  const FT2 = [[0, 0, 1], [0, 0, 1], [0, 1, 0], [0, 1, 0], [0, 0, 1], [0, 0, 1]];
  const FSIGN = [
    [[1, -1], [-1, -1], [-1, 1], [1, 1]],   // PX
    [[-1, -1], [1, -1], [1, 1], [-1, 1]],   // NX
    [[-1, -1], [-1, 1], [1, 1], [1, -1]],   // PY
    [[-1, -1], [1, -1], [1, 1], [-1, 1]],   // NY
    [[-1, -1], [1, -1], [1, 1], [-1, 1]],   // PZ
    [[1, -1], [-1, -1], [-1, 1], [1, 1]]    // NZ
  ];
  const FV = [
    [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]],   // PX
    [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],   // NX
    [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],   // PY
    [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],   // NY
    [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],   // PZ
    [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]]    // NZ
  ];
  const FN3 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const FAO = [];
  for (let f = 0; f < 6; f++) {
    const d = FD[f], t1 = FT1[f], t2 = FT2[f], row = [];
    for (let v = 0; v < 4; v++) {
      const s = FSIGN[f][v];
      row.push([
        [d[0] + s[0] * t1[0], d[1] + s[0] * t1[1], d[2] + s[0] * t1[2]],
        [d[0] + s[1] * t2[0], d[1] + s[1] * t2[1], d[2] + s[1] * t2[2]],
        [d[0] + s[0] * t1[0] + s[1] * t2[0], d[1] + s[0] * t1[1] + s[1] * t2[1], d[2] + s[0] * t1[2] + s[1] * t2[2]]
      ]);
    }
    FAO.push(row);
  }
  /* AO 亮度（线性）：3 = 完全开阔 … 0 = 内角。
     ⚠️ 顶点色是线性空间，0.7 这种值屏幕上只暗 13%（k ≈ 视觉比^2.4）。 */
  const AO_LUT = [0.34, 0.52, 0.75, 1.0];

  const VSEQ = [0, 1, 2, 0, 2, 3];

  function buildWorld(G) {
    const Wd = PP.World;
    if (!Wd || !Wd.vox) return;
    // 种子必须进 key：否则重开一局换了 seed 却复用上一局地形（穿模）
    const key = `${Wd.SIZE}|${Wd.seed}|${Wd._stamp || 0}`;
    if (worldBuilt && lastWorldKey === key) return;
    lastWorldKey = key;

    disposeWorld();
    chunks.length = 0;
    worldBuilt = true;

    const SIZE = Wd.SIZE, HEIGHT = Wd.HEIGHT;
    const vox = Wd.vox, biomeArr = Wd.biome;
    const WATER = 11;
    const FT = blockFaceTable();
    const BS = biomeShaded();
    const mat = atlasMaterial();
    const bmat = blendMaterial();
    const N2 = SIZE * SIZE;

    /* 最高非空层：省掉上方整片空气的遍历（世界 40 层，实际只用到 ~32） */
    let topZ = 1;
    for (let z = HEIGHT - 1; z >= 0; z--) {
      const b = z * N2;
      for (let i = 0; i < N2; i++) if (vox[b + i]) { topZ = z + 1; break; }
      if (topZ > 1) break;
    }

    const NC = Math.ceil(SIZE / CHUNK);
    for (let cz = 0; cz < NC; cz++) {
      for (let cx = 0; cx < NC; cx++) {
        const x0 = cx * CHUNK, y0 = cz * CHUNK;
        const x1 = Math.min(SIZE, x0 + CHUNK), y1 = Math.min(SIZE, y0 + CHUNK);
        const oP = [], oN = [], oU = [], oC = [];   // 不透明 + 镂空（树叶/玻璃）
        const bP = [], bN = [], bU = [], bC = [];   // 半透明（水）

        for (let z = 0; z < topZ; z++) {
          const zb = z * N2;
          for (let sy = y0; sy < y1; sy++) {
            const yb = zb + sy * SIZE;
            const bi = biomeArr ? biomeArr[sy * SIZE + x0] : 0;
            for (let sx = x0; sx < x1; sx++) {
              const id = vox[yb + sx];
              if (!id) continue;

              /* 水方块高度是 14/16（原版），顶面降 1/8 格 —— 没有这一步
                 湖岸就没有那条浅色边，水面看着像"盖在草地上的蓝板"。 */
              const top = (id === WATER) ? z + 0.875 : z + 1;

              for (let f = 0; f < 6; f++) {
                const d = FD[f];
                const nx = sx + d[0], ny = sy + d[1], nz = z + d[2];
                let nb = 0;
                if (nz >= 0 && nz < HEIGHT && nx >= 0 && ny >= 0 && nx < SIZE && ny < SIZE) {
                  nb = vox[nz * N2 + ny * SIZE + nx];
                } else if (nz < 0) {
                  nb = 1;                                // 基岩之下 = 实心
                }
                // 邻居遮挡 → 这一面埋在里面，不必生成
                if (nb !== 0 && !(nb === WATER && id !== WATER)) continue;

                const bf = FT[id * 6 + f];
                if (!bf) continue;
                const isBlend = bf.kind === K_BLEND;
                const P = isBlend ? bP : oP, NN = isBlend ? bN : oN;
                const UU = isBlend ? bU : oU, CC = isBlend ? bC : oC;
                const ts = (bf.biome === undefined) ? bf.ts : BS[bf.biome][biomeArr ? biomeArr[sy * SIZE + sx] : 0][f];
                const uv = bf.uv;
                const u0 = uv[0], v0 = uv[1], u1 = uv[2], v1 = uv[3];

                /* 四角 AO：贴墙的那个角压暗。地面占画面一半，这是"发平"最直接的解药。 */
                const aoR = FAO[f];
                let a0 = 1, a1 = 1, a2 = 1, a3 = 1;
                for (let v = 0; v < 4; v++) {
                  const o = aoR[v];
                  let s1 = 0, s2 = 0, cn = 0;
                  for (let k = 0; k < 3; k++) {
                    const oi = o[k];
                    const px = sx + oi[0], py = sy + oi[1], pz = z + oi[2];
                    let occ = 1;
                    if (pz >= 0 && pz < HEIGHT && px >= 0 && py >= 0 && px < SIZE && py < SIZE) {
                      const b2 = vox[pz * N2 + py * SIZE + px];
                      occ = (b2 !== 0 && b2 !== WATER) ? 1 : 0;
                    }
                    if (k === 0) s1 = occ; else if (k === 1) s2 = occ; else cn = occ;
                  }
                  const av = AO_LUT[(s1 && s2) ? 0 : 3 - (s1 + s2 + cn)];
                  if (v === 0) a0 = av; else if (v === 1) a1 = av; else if (v === 2) a2 = av; else a3 = av;
                }
                const aoV = [a0, a1, a2, a0, a2, a3];

                const fnv = FN3[f];
                for (let s = 0; s < 6; s++) {
                  const vi = VSEQ[s];
                  const c = FV[f][vi];
                  P.push(sx + c[0], c[1] ? top : z, sy + c[2]);
                  NN.push(fnv[0], fnv[1], fnv[2]);
                  if (s === 0) UU.push(u0, v0);
                  else if (s === 1) UU.push(u1, v0);
                  else if (s === 2) UU.push(u1, v1);
                  else if (s === 3) UU.push(u0, v0);
                  else if (s === 4) UU.push(u1, v1);
                  else UU.push(u0, v1);
                  const m = aoV[s];
                  CC.push(ts[0] * m, ts[1] * m, ts[2] * m);
                }
              }
            }
          }
        }

        const chunk = { x0, z0: y0, x1, z1: y1, cx, cz, solid: null, blend: null };
        if (oP.length) {
          const m = new THREE.Mesh(makeGeo(oP, oN, oU, oC), mat);
          m.name = `vox_${cx}_${cz}`;
          m.castShadow = true;
          m.receiveShadow = true;
          m.matrixAutoUpdate = false;
          m.updateMatrix();
          worldGroup.add(m);
          chunk.solid = m;
        }
        if (bP.length) {
          const m = new THREE.Mesh(makeGeo(bP, bN, bU, bC), bmat);
          m.name = `water_${cx}_${cz}`;
          m.castShadow = false;
          m.receiveShadow = false;
          m.renderOrder = 1;
          m.matrixAutoUpdate = false;
          m.updateMatrix();
          worldGroup.add(m);
          chunk.blend = m;
        }
        if (chunk.solid || chunk.blend) chunks.push(chunk);
      }
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
      if (c.solid) c.solid.visible = vis;
      if (c.blend) c.blend.visible = vis;
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
  /* 武器视模缩放。
   *
   * ⚠️ 这里踩过一个坑，记录下来避免再犯：
   * 曾经为了"让手臂占屏幕高度 45%"把距离从 0.55 推到 1.148 米、缩放降到 0.46。
   * 计算本身没错，但**手臂是 weaponRoot 的子节点**，推远后手臂跟着变小，
   * 结果枪小到认不出、手几乎看不见 —— 因为我把"手臂该多大"和"枪该多大"
   * 当成同一个自由度了，实际它们必须**分别**标定：
   *   · 手臂大小 ← 由 weaponRoot 到相机的距离决定（0.55 米时合适）
   *   · 枪的大小 ← 由 WEAPON_SCALE 决定（与距离无关）
   * 所以距离回到 0.55，只把武器本身缩到能读清但不遮视野的程度。 */
  const WEAPON_SCALE = 0.56;
  // 视模到相机的距离（米）。0.55 是"手臂在屏幕上占比合适"的位置，
  // 别再为了缩小枪而改这个值 —— 改 WEAPON_SCALE。
  const VIEW_Z = -0.55;
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
    // 位置不在这里写死：由 ensureWeapon 按武器模型的枪管末端换算（见下）
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
    weaponMesh.scale.setScalar(WEAPON_SCALE);
    weaponKind = kind;
    weaponRoot.add(weaponMesh);
    ensureMuzzleFlash();
    // 枪口对齐枪管末端：模型坐标 × WEAPON_SCALE（因为火焰挂在未缩放的 weaponRoot 上）。
    // 之前两边各写各的常量 → 火焰飘在枪管前方半米，屏幕上就是个白方块。
    const mz = weaponMesh.userData.muzzle;
    if (mz) muzzleFlash.position.set(mz.x * WEAPON_SCALE, mz.y * WEAPON_SCALE, mz.z * WEAPON_SCALE);
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

    /* 相机高度 = 玩家脚下的 z + 视高（真 3D：地形有高低，相机必须跟着海拔走）。
       不加上 camObj.z 的话，站在山坡上眼睛还埋在地平面里。 */
    const footZ = (camObj.z !== undefined && camObj.z !== null) ? camObj.z : 0;
    const camX = camObj.x;
    const camY = footZ + eye + viewY + (camShake > 0.001 ? (Math.random() - 0.5) * camShake * 0.3 : 0);
    const camZ = camObj.y;

    camera.position.set(camX, camY, camZ);
    camera.rotation.y = -yaw - Math.PI / 2;
    camera.rotation.x = pitch + camShake * 0.4;
    camera.rotation.z = camShake * 0.2;

    // 光照跟随（阴影贴图只覆盖 ±30，必须跟着玩家走）
    // 偏移默认 (30,34,20) ≈ 43° 仰角，与 init 里的 sun.position 同向
    sun.position.set(camX + R.sunOffset.x, footZ + R.sunOffset.y, camZ + R.sunOffset.z);
    sun.target.position.set(camX, footZ, camZ);
    sun.target.updateMatrixWorld();
    if (skyMesh) skyMesh.position.copy(camera.position);
    if (skyMat) {
      const su = skyMat.uniforms;
      su.time.value = performance.now() * 0.001;
      // 云要有视差：把相机水平位移喂给 shader，否则云像贴在天花板上的贴纸
      su.camXZ.value.set(camera.position.x, camera.position.z);
    }

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
      // sim.z 是脚下的高度（真 3D）；缺字段时退回地形高度，至少不会埋进地里
      const fz = (e.z !== undefined && e.z !== null) ? e.z : PP.World.surfZAt(e.x, e.y);
      mesh.position.set(e.x, fz, e.y);
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
      ent.mesh.position.set(m.x, (m.z !== undefined && m.z !== null) ? m.z : 0, m.y);
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
      // 视模防穿墙：沿视线探测到墙则拉近枪。
      let weaponZ = VIEW_Z;
      if (PP.World && PP.World.rayWall) {
        const dx = Math.cos(yaw) * Math.cos(pitch);
        const dy = Math.sin(yaw) * Math.cos(pitch);
        const wallD = PP.World.rayWall(camObj.x, camObj.y, dx, dy, 1.1);
        if (wallD < 0.7) {
          const k = Math.max(0.15, (wallD - 0.16) / 0.54);
          weaponZ = -0.22 - 0.33 * k;
        }
      }
      // 落点按屏幕比例给：x/|z| = 0.364（右侧 36%）、y/|z| = -0.291（下方 29%）。
      // rotation.y 保持 0.42（≈24°）：第一人称是"从正后方看枪的横截面"，
      // 不外偏就只能看到几层方块叠起来，完全没有枪的纵深感。
      weaponRoot.position.set(0.200 + swayX, -0.160 + bobY + raise, weaponZ);
      weaponRoot.rotation.set(-0.04 + (G.kickPitch || 0) * 0.4, 0.42, 0.045);
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
