/* ============================================================
   render3d.js — 真 3D 软件光栅化渲染器
     相机：pinhole 透视（yaw + 真 pitch，不再靠平移地平线伪造）
     世界：2D 网格 + 每格高度 → 体素柱，只提交"裸露面"
     光栅：透视校正纹理映射 + 1/z 深度缓冲
     地面：平面按行光栅（对 pinhole 相机是精确解，不是近似）
   仍然是 写 Uint32Array → putImageData → CSS 放大（保留硬边像素风）
   模拟层完全不用改：AI / 寻路 / 命中判定 / 联机照旧
   ============================================================ */
(function () {
  const ROOT = (typeof window !== 'undefined') ? window : globalThis;
  const PP = (ROOT.PP = ROOT.PP || {});
  const R = (PP.Render = {});

  const EYE = 0.62;          // 视点高度（世界单位，1 = 一格方块）
  const FOV_TAN = 0.72;      // tan(水平半视角)
  const TEX = 64, MASK = 63;
  const NEAR = 0.08;
  const FOG_NEAR = 14, FOG_FAR = 34;
  const DRAW_R = 34;         // 绘制半径（格）

  let cvs = null, ctx = null, img = null, buf32 = null;
  let W = 0, H = 0, zb = null, projDist = 0, ccx = 0, ccy = 0;
  let outW = 0, outH = 0, imgOut = null, bufOut = null, ssaa = 1;
  let colAz = null, rowEl = null;
  let prev32 = null, fxaaBuf = null;
  const prevCam = { x: 0, y: 0, a: 0, p: 0, has: false };
  R.quality = 1;
  R.ssaa = 1;
  R.taa = false;
  R.fxaa = false;

  const SKY_TOP = { r: 48, g: 126, b: 226 };
  const SKY_HOR = { r: 172, g: 220, b: 248 };
  const SKY_FOG = { r: 170, g: 214, b: 244 };

  /* ---------------- 天空全景 ---------------- */
  let skyTex = null;
  function makeSky() {
    const w = 512, h = 64;
    skyTex = new PP.Art.Tex(w, h);
    const rng = PP.Core.mulberry32(20240);
    for (let y = 0; y < h; y++) {
      const t = y / (h - 1);
      for (let x = 0; x < w; x++) {
        let r = SKY_HOR.r + (SKY_TOP.r - SKY_HOR.r) * t;
        let g = SKY_HOR.g + (SKY_TOP.g - SKY_HOR.g) * t;
        let b = SKY_HOR.b + (SKY_TOP.b - SKY_HOR.b) * t;
        const cf = PP.Core.fbm(x / 34, y / 12 + 3, 7717, 3) + PP.Core.fbm(x / 90, y / 30, 3313, 2) * 0.5;
        const cloud = cf - 0.74 + (1 - t) * 0.12;
        if (cloud > 0) {
          const k = Math.min(1, cloud * 5.0);
          r += (255 - r) * k; g += (255 - g) * k; b += (255 - b) * k;
        }
        skyTex.data[y * w + x] = PP.Art.rgb(r | 0, g | 0, b | 0);
      }
    }
    for (let y = 6; y < 20; y++) for (let x = 150; x < 164; x++) {
      const dx = x - 157, dy = (y - 13) * 1.6;
      if (dx * dx + dy * dy < 42) {
        const d = Math.sqrt(dx * dx + dy * dy);
        const k = 1 - d / 7;
        const c = skyTex.data[y * w + x];
        const cr = c & 255, cg = (c >> 8) & 255, cb = (c >> 16) & 255;
        skyTex.data[y * w + x] = PP.Art.rgb(
          Math.min(255, cr + (255 - cr) * k), Math.min(255, cg + (250 - cg) * k), Math.min(255, cb + (210 - cb) * k));
      }
    }
    for (let i = 0; i < 120; i++) {
      const x = (rng() * w) | 0, y = (rng() * 10) | 0;
      skyTex.data[y * w + x] = PP.Art.rgb(255, 255, 245);
    }
  }

  R.init = function (canvas) {
    cvs = canvas;
    ctx = cvs.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = false;
    makeSky();
    R.resize();
  };

  /* 像素预算：q≤1 与旧档位兼容；高清/超清拉高输出像素，超清再开 2× 超采样 */
  function budgetOf(q) {
    if (q <= 1.001) return 90000 * q;
    if (q <= 1.7) return Math.round(90000 * q * q * 0.85);   // 高清 ≈ 165k @1.5
    return 125000;                                            // 超清：输出适中，靠 SSAA
  }

  R.resize = function () {
    if (!cvs) return;
    const vw = ROOT.innerWidth || 960, vh = ROOT.innerHeight || 600;
    const aspect = vw / vh;
    // 超清档开启 2×2 盒式超采样（空间重建，DLSS 的离线简化版）
    ssaa = (R.quality > 1.8) ? 2 : 1;
    R.ssaa = ssaa;

    const target = budgetOf(R.quality);
    let oh = Math.sqrt(target / aspect);
    const hi = R.quality >= 1.4;
    oh = Math.max(150, Math.min(hi ? 540 : (R.quality >= 1 ? 360 : 300), Math.round(oh)));
    let ow = Math.round(oh * aspect);
    ow = Math.max(220, Math.min(hi ? 1024 : (R.quality >= 1 ? 720 : 640), ow));
    outW = ow; outH = oh;

    // 渲染分辨率（SSAA 时是输出的 2 倍）
    W = ow * ssaa; H = oh * ssaa;
    cvs.width = outW; cvs.height = outH;
    ctx.imageSmoothingEnabled = false;

    if (ssaa > 1) {
      // 高分辨率渲染缓冲（不直接 putImageData）
      const data = new Uint8ClampedArray(W * H * 4);
      img = { width: W, height: H, data: data };
      buf32 = new Uint32Array(data.buffer);
      imgOut = ctx.createImageData(outW, outH);
      bufOut = new Uint32Array(imgOut.data.buffer);
    } else {
      img = ctx.createImageData(W, H);
      buf32 = new Uint32Array(img.data.buffer);
      imgOut = img; bufOut = buf32;
    }
    zb = new Float32Array(W * H);
    // TAA 历史帧 + FXAA 工作缓冲（仅高清档启用）
    R.taa = R.quality >= 1.4;
    R.fxaa = R.quality >= 1.4;
    prev32 = new Uint32Array(W * H);
    fxaaBuf = new Uint32Array(outW * outH);
    prevCam.has = false;

    projDist = (W / 2) / FOV_TAN;
    ccx = W / 2; ccy = H / 2;
    colAz = new Float32Array(W);
    for (let x = 0; x < W; x++) colAz[x] = Math.atan2((x - ccx) / projDist, 1);
    rowEl = new Float32Array(H);
    for (let y = 0; y < H; y++) rowEl[y] = Math.atan2((ccy - y) / projDist, 1);
    R.W = W; R.H = H;
    R.outW = outW; R.outH = outH;
  };

  /* TAA-lite：世界+精灵与上一帧混合；镜头动得越狠，历史权重越低（减轻拖影） */
  function taaBlend(G, camObj) {
    if (!R.taa || !prev32) return;
    const p = camObj || G.player;
    if (!p) return;
    const motion =
      Math.abs(p.x - prevCam.x) + Math.abs(p.y - prevCam.y) +
      Math.abs((p.a || 0) - prevCam.a) * 1.5 +
      Math.abs((p.pitch || 0) - prevCam.p) * 1.5 +
      Math.abs((G.weaponBobY || 0) % 4) * 0.02;
    // 静止时历史 ~0.5，快速转动时压到 ~0.08
    let hist = 0.52 - motion * 1.8;
    if (hist < 0.08) hist = 0.08;
    if (hist > 0.52) hist = 0.52;
    const a = 1 - hist;
    const n = buf32.length;
    const ah = (hist * 256) | 0, ac = (a * 256) | 0;
    for (let i = 0; i < n; i++) {
      const c = buf32[i], o = prev32[i];
      const r = (((c & 255) * ac + (o & 255) * ah) >> 8);
      const g = ((((c >>> 8) & 255) * ac + ((o >>> 8) & 255) * ah) >> 8);
      const b = ((((c >>> 16) & 255) * ac + ((o >>> 16) & 255) * ah) >> 8);
      buf32[i] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
    }
    prev32.set(buf32);
    prevCam.x = p.x; prevCam.y = p.y; prevCam.a = p.a || 0; prevCam.p = p.pitch || 0;
    prevCam.has = true;
  }
  R.taaBlend = taaBlend;

  /* FXAA-lite：只柔化高对比斜向边缘，保留硬像素块的整体质感 */
  function fxaaLite(buf, w, h) {
    if (w < 4 || h < 4) return;
    fxaaBuf.set(buf);
    for (let y = 1; y < h - 1; y++) {
      const row = y * w;
      for (let x = 1; x < w - 1; x++) {
        const i = row + x;
        const c = fxaaBuf[i];
        const l = (c & 255) + ((c >>> 8) & 255) + ((c >>> 16) & 255);
        const lN = lum(fxaaBuf[i - w]), lS = lum(fxaaBuf[i + w]);
        const lW = lum(fxaaBuf[i - 1]), lE = lum(fxaaBuf[i + 1]);
        const lNW = lum(fxaaBuf[i - w - 1]), lNE = lum(fxaaBuf[i - w + 1]);
        const lSW = lum(fxaaBuf[i + w - 1]), lSE = lum(fxaaBuf[i + w + 1]);
        const rangeMax = Math.max(lN, lS, lW, lE, Math.max(lNW, lNE, lSW, lSE));
        const rangeMin = Math.min(lN, lS, lW, lE, Math.min(lNW, lNE, lSW, lSE));
        const range = rangeMax - rangeMin;
        if (range < 48) continue;
        // 斜向对比强于正交 → 判定为斜边，做 5 点柔化
        const diag = Math.abs(lNW - lSE) + Math.abs(lNE - lSW);
        const orth = Math.abs(lN - lS) + Math.abs(lW - lE);
        if (diag <= orth * 0.85) continue;
        const r = (((c & 255) + (fxaaBuf[i - w] & 255) + (fxaaBuf[i + w] & 255) +
          (fxaaBuf[i - 1] & 255) + (fxaaBuf[i + 1] & 255)) / 5) | 0;
        const g = (((((c >>> 8) & 255) + ((fxaaBuf[i - w] >>> 8) & 255) + ((fxaaBuf[i + w] >>> 8) & 255) +
          ((fxaaBuf[i - 1] >>> 8) & 255) + ((fxaaBuf[i + 1] >>> 8) & 255)) / 5) | 0);
        const b = (((((c >>> 16) & 255) + ((fxaaBuf[i - w] >>> 16) & 255) + ((fxaaBuf[i + w] >>> 16) & 255) +
          ((fxaaBuf[i - 1] >>> 16) & 255) + ((fxaaBuf[i + 1] >>> 16) & 255)) / 5) | 0);
        // 一半混合，避免糊掉像素风
        buf[i] = (0xff000000 |
          (((((c >>> 16) & 255) + b) >> 1) << 16) |
          (((((c >>> 8) & 255) + g) >> 1) << 8) |
          ((((c & 255) + r) >> 1))) >>> 0;
      }
    }
  }
  function lum(c) { return (c & 255) + ((c >>> 8) & 255) + ((c >>> 16) & 255); }

  /* 2×2 盒式降采样 → 画布（超采样抗锯齿） */
  function present() {
    if (ssaa === 1) {
      if (R.fxaa) fxaaLite(bufOut, outW, outH);
      ctx.putImageData(imgOut, 0, 0);
      return;
    }
    const s = ssaa;
    for (let y = 0; y < outH; y++) {
      const y0 = y * s, y1 = y0 + 1;
      const row0 = y0 * W, row1 = y1 * W;
      const orow = y * outW;
      for (let x = 0; x < outW; x++) {
        const x0 = x * s, x1 = x0 + 1;
        const c0 = buf32[row0 + x0], c1 = buf32[row0 + x1];
        const c2 = buf32[row1 + x0], c3 = buf32[row1 + x1];
        const r = ((c0 & 255) + (c1 & 255) + (c2 & 255) + (c3 & 255)) >> 2;
        const g = (((c0 >>> 8) & 255) + ((c1 >>> 8) & 255) + ((c2 >>> 8) & 255) + ((c3 >>> 8) & 255)) >> 2;
        const b = (((c0 >>> 16) & 255) + ((c1 >>> 16) & 255) + ((c2 >>> 16) & 255) + ((c3 >>> 16) & 255)) >> 2;
        bufOut[orow + x] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
      }
    }
    if (R.fxaa) fxaaLite(bufOut, outW, outH);
    ctx.putImageData(imgOut, 0, 0);
  }
  R.present = present;

  /* ---------------- 相机 ---------------- */
  let camX = 0, camY = 0, camZ = EYE;
  let fx = 1, fy = 0, fz = 0;      // forward
  let rx = 0, ry = 1;              // right（水平，z=0）
  let ux = 0, uy = 0, uz = 1;      // up
  let yawv = 0, pitchv = 0;

  function setCam(x, y, z, yaw, pitch) {
    camX = x; camY = y; camZ = z;
    yawv = yaw; pitchv = pitch;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const cyw = Math.cos(yaw), syw = Math.sin(yaw);
    fx = cyw * cp; fy = syw * cp; fz = sp;
    rx = -syw; ry = cyw;
    ux = -cyw * sp; uy = -syw * sp; uz = cp;
  }

  /* ---------------- 通用：世界点 → 相机空间 ---------------- */
  function toCam(wx, wy, wz, out) {
    const dx = wx - camX, dy = wy - camY, dz = wz - camZ;
    out[0] = dx * rx + dy * ry;                 // 右
    out[1] = dx * ux + dy * uy + dz * uz;       // 上
    out[2] = dx * fx + dy * fy + dz * fz;       // 前（深度）
    return out;
  }

  /* ---------------- 三角光栅化（逐行求交，稳健处理平顶/平底） ---------------- */
  const vsx = new Float64Array(8), vsy = new Float64Array(8),
    viz = new Float64Array(8), vuz = new Float64Array(8), vvz = new Float64Array(8);
  const EX = [0, 0], EIZ = [0, 0], EUZ = [0, 0], EVZ = [0, 0];

  function rasterTri(i0, i1, i2, texData, bright) {
    let ymin = vsy[i0], ymax = vsy[i0];
    if (vsy[i1] < ymin) ymin = vsy[i1]; if (vsy[i1] > ymax) ymax = vsy[i1];
    if (vsy[i2] < ymin) ymin = vsy[i2]; if (vsy[i2] > ymax) ymax = vsy[i2];
    const yA = Math.max(0, Math.ceil(ymin - 0.5));
    const yB = Math.min(H - 1, Math.ceil(ymax - 0.5) - 1);
    if (yA > yB) return;
    const fogInv = 1 / (FOG_FAR - FOG_NEAR);

    for (let y = yA; y <= yB; y++) {
      const yc = y + 0.5;
      let n = 0;
      // 与三条边求交（半开区间，顶点不重复计）
      for (let e = 0; e < 3; e++) {
        const a = e === 0 ? i0 : (e === 1 ? i1 : i2);
        const b = e === 0 ? i1 : (e === 1 ? i2 : i0);
        const ay = vsy[a], by = vsy[b];
        if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) {
          const t = (yc - ay) / (by - ay);
          if (n === 0) {
            EX[0] = vsx[a] + (vsx[b] - vsx[a]) * t;
            EIZ[0] = viz[a] + (viz[b] - viz[a]) * t;
            EUZ[0] = vuz[a] + (vuz[b] - vuz[a]) * t;
            EVZ[0] = vvz[a] + (vvz[b] - vvz[a]) * t;
            n = 1;
          } else {
            EX[1] = vsx[a] + (vsx[b] - vsx[a]) * t;
            EIZ[1] = viz[a] + (viz[b] - viz[a]) * t;
            EUZ[1] = vuz[a] + (vuz[b] - vuz[a]) * t;
            EVZ[1] = vvz[a] + (vvz[b] - vvz[a]) * t;
            n = 2;
          }
        }
      }
      if (n < 2) continue;
      let xl = EX[0], xr = EX[1], izl = EIZ[0], izr = EIZ[1], uzl = EUZ[0], uzr = EUZ[1], vzl = EVZ[0], vzr = EVZ[1];
      if (xl > xr) {
        let t = xl; xl = xr; xr = t;
        t = izl; izl = izr; izr = t;
        t = uzl; uzl = uzr; uzr = t;
        t = vzl; vzl = vzr; vzr = t;
      }
      const dx = xr - xl;
      if (dx < 1e-9) continue;
      const diz = (izr - izl) / dx, duz = (uzr - uzl) / dx, dvz = (vzr - vzl) / dx;
      let xa = xl, xb = xr, iz = izl, uz = uzl, vz = vzl;
      if (xa < 0) { const s = -xa; iz += diz * s; uz += duz * s; vz += dvz * s; xa = 0; }
      if (xb > W - 1) xb = W - 1;
      let o = y * W + (xa | 0);
      for (let x = xa | 0; x <= xb; x++, o++) {
        if (iz > zb[o]) {
          const z = 1 / iz;
          const u = uz * z, v = vz * z;
          const tx = (u | 0) & MASK, ty = (v | 0) & MASK;
          const c = texData[ty * TEX + tx];
          if (c !== 0) {
            let rr = ((c & 255) * bright) >> 8;
            let gg = (((c >>> 8) & 255) * bright) >> 8;
            let bb = (((c >>> 16) & 255) * bright) >> 8;
            let t = (z - FOG_NEAR) * fogInv;
            if (t > 0) {
              if (t > 1) t = 1;
              const ti = (t * 255) | 0;
              rr += ((SKY_FOG.r - rr) * ti) >> 8;
              gg += ((SKY_FOG.g - gg) * ti) >> 8;
              bb += ((SKY_FOG.b - bb) * ti) >> 8;
            }
            zb[o] = iz;
            buf32[o] = (0xff000000 | (bb << 16) | (gg << 8) | rr) >>> 0;
          }
        }
        iz += diz; uz += duz; vz += dvz;
      }
    }
  }

  /* ---------------- 面提交（近平面裁剪 → 投影 → 三角化） ---------------- */
  const wxA = new Float64Array(8), wyA = new Float64Array(8), wzA = new Float64Array(8),
    wuA = new Float64Array(8), wvA = new Float64Array(8);
  const cxA = new Float64Array(8), cyA = new Float64Array(8), czA = new Float64Array(8);

  function emitFace(tex, bright, n, px, py, pz, pu, pv) {
    // 1) 世界 → 相机
    let behind = 0;
    for (let i = 0; i < n; i++) {
      const dx = px[i] - camX, dy = py[i] - camY, dz = pz[i] - camZ;
      cxA[i] = dx * rx + dy * ry;
      cyA[i] = dx * ux + dy * uy + dz * uz;
      czA[i] = dx * fx + dy * fy + dz * fz;
      if (czA[i] < NEAR) behind++;
    }
    if (behind === n) return;

    let m = 0;
    if (behind > 0) {
      // 近平面裁剪（Sutherland–Hodgman，单平面）
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const zi = czA[i], zj = czA[j];
        const ini = zi >= NEAR, inj = zj >= NEAR;
        if (ini) { wxA[m] = cxA[i]; wyA[m] = cyA[i]; wzA[m] = zi; wuA[m] = pu[i]; wvA[m] = pv[i]; m++; }
        if (ini !== inj) {
          const t = (NEAR - zi) / (zj - zi);
          wxA[m] = cxA[i] + (cxA[j] - cxA[i]) * t;
          wyA[m] = cyA[i] + (cyA[j] - cyA[i]) * t;
          wzA[m] = NEAR;
          wuA[m] = pu[i] + (pu[j] - pu[i]) * t;
          wvA[m] = pv[i] + (pv[j] - pv[i]) * t;
          m++;
        }
      }
      if (m < 3) return;
    } else {
      for (let i = 0; i < n; i++) { wxA[i] = cxA[i]; wyA[i] = cyA[i]; wzA[i] = czA[i]; wuA[i] = pu[i]; wvA[i] = pv[i]; }
      m = n;
    }

    // 2) 投影
    for (let i = 0; i < m; i++) {
      const inv = 1 / wzA[i];
      vsx[i] = ccx + wxA[i] * projDist * inv;
      vsy[i] = ccy - wyA[i] * projDist * inv;
      viz[i] = inv;
      vuz[i] = wuA[i] * inv;
      vvz[i] = wvA[i] * inv;
    }
    // 3) 扇形三角化
    const td = tex.data;
    for (let i = 1; i < m - 1; i++) rasterTri(0, i, i + 1, td, bright);
  }

  /* ---------------- 地形/方块 ---------------- */
  const fpx = new Float64Array(4), fpy = new Float64Array(4), fpz = new Float64Array(4),
    fpu = new Float64Array(4), fpv = new Float64Array(4);

  function drawBlocks(G) {
    const Wd = PP.World;
    const wall = Wd.wall, HT = Wd.wallHeight, SIZE = Wd.SIZE;
    const wt = PP.Art.wallTex, ft = PP.Art.floorTex;
    const px = Math.floor(camX), py = Math.floor(camY);

    for (let ty = py - DRAW_R; ty <= py + DRAW_R; ty++) {
      if (ty < 0 || ty >= SIZE) continue;
      for (let tx = px - DRAW_R; tx <= px + DRAW_R; tx++) {
        if (tx < 0 || tx >= SIZE) continue;
        const id = wall[ty * SIZE + tx];
        if (!id) continue;
        const h = HT[id] || 1;
        if (h <= 0) continue;

        // 视锥粗剔除
        const mx = tx + 0.5 - camX, my = ty + 0.5 - camY, mz = h * 0.5 - camZ;
        const dep = mx * fx + my * fy + mz * fz;
        if (dep < -h) continue;
        const lat = mx * rx + my * ry;
        if (Math.abs(lat) > dep * FOV_TAN * 1.5 + 2.5) continue;

        const tex = wt[id - 1] || wt[0];
        const x0 = tx, x1 = tx + 1, y0 = ty, y1 = ty + 1;

        // 顶面（原木用年轮、树叶用叶面，不再错用地板纹理）
        if (camZ > h - 0.001) {
          fpx[0] = x0; fpy[0] = y0; fpz[0] = h; fpu[0] = x0 * TEX; fpv[0] = y0 * TEX;
          fpx[1] = x1; fpy[1] = y0; fpz[1] = h; fpu[1] = x1 * TEX; fpv[1] = y0 * TEX;
          fpx[2] = x1; fpy[2] = y1; fpz[2] = h; fpu[2] = x1 * TEX; fpv[2] = y1 * TEX;
          fpx[3] = x0; fpy[3] = y1; fpz[3] = h; fpu[3] = x0 * TEX; fpv[3] = y1 * TEX;
          const topTex = (PP.Art.wallTopTex && PP.Art.wallTopTex[id - 1]) || tex;
          emitFace(topTex, 256, 4, fpx, fpy, fpz, fpu, fpv);
        }

        // 四个侧面（邻居更矮才画）
        const nH = (nx, ny) => {
          if (nx < 0 || ny < 0 || nx >= SIZE || ny >= SIZE) return 3;
          const ni = wall[ny * SIZE + nx];
          return ni ? (HT[ni] || 1) : 0;
        };

        // +X 面（法线 +x）
        let nh = nH(tx + 1, ty);
        if (nh < h) {
          const vis = (camX - x1) > 0;
          if (vis) {
            fpx[0] = x1; fpy[0] = y0; fpz[0] = h; fpu[0] = y0 * TEX; fpv[0] = h * TEX;
            fpx[1] = x1; fpy[1] = y1; fpz[1] = h; fpu[1] = y1 * TEX; fpv[1] = h * TEX;
            fpx[2] = x1; fpy[2] = y1; fpz[2] = nh; fpu[2] = y1 * TEX; fpv[2] = nh * TEX;
            fpx[3] = x1; fpy[3] = y0; fpz[3] = nh; fpu[3] = y0 * TEX; fpv[3] = nh * TEX;
            emitFace(tex, 205, 4, fpx, fpy, fpz, fpu, fpv);
          }
        }
        // -X 面（法线 -x）
        nh = nH(tx - 1, ty);
        if (nh < h) {
          if ((camX - x0) < 0) {
            fpx[0] = x0; fpy[0] = y1; fpz[0] = h; fpu[0] = y1 * TEX; fpv[0] = h * TEX;
            fpx[1] = x0; fpy[1] = y0; fpz[1] = h; fpu[1] = y0 * TEX; fpv[1] = h * TEX;
            fpx[2] = x0; fpy[2] = y0; fpz[2] = nh; fpu[2] = y0 * TEX; fpv[2] = nh * TEX;
            fpx[3] = x0; fpy[3] = y1; fpz[3] = nh; fpu[3] = y1 * TEX; fpv[3] = nh * TEX;
            emitFace(tex, 205, 4, fpx, fpy, fpz, fpu, fpv);
          }
        }
        // +Y 面
        nh = nH(tx, ty + 1);
        if (nh < h) {
          if ((camY - y1) > 0) {
            fpx[0] = x1; fpy[0] = y1; fpz[0] = h; fpu[0] = x1 * TEX; fpv[0] = h * TEX;
            fpx[1] = x0; fpy[1] = y1; fpz[1] = h; fpu[1] = x0 * TEX; fpv[1] = h * TEX;
            fpx[2] = x0; fpy[2] = y1; fpz[2] = nh; fpu[2] = x0 * TEX; fpv[2] = nh * TEX;
            fpx[3] = x1; fpy[3] = y1; fpz[3] = nh; fpu[3] = x1 * TEX; fpv[3] = nh * TEX;
            emitFace(tex, 168, 4, fpx, fpy, fpz, fpu, fpv);
          }
        }
        // -Y 面
        nh = nH(tx, ty - 1);
        if (nh < h) {
          if ((camY - y0) < 0) {
            fpx[0] = x0; fpy[0] = y0; fpz[0] = h; fpu[0] = x0 * TEX; fpv[0] = h * TEX;
            fpx[1] = x1; fpy[1] = y0; fpz[1] = h; fpu[1] = x1 * TEX; fpv[1] = h * TEX;
            fpx[2] = x1; fpy[2] = y0; fpz[2] = nh; fpu[2] = x1 * TEX; fpv[2] = nh * TEX;
            fpx[3] = x0; fpy[3] = y0; fpz[3] = nh; fpu[3] = x0 * TEX; fpv[3] = nh * TEX;
            emitFace(tex, 168, 4, fpx, fpy, fpz, fpu, fpv);
          }
        }
      }
    }
  }

  /* ---------------- 地面（平面按行光栅，对 pinhole 精确） ---------------- */
  function drawGround(G) {
    const Wd = PP.World;
    const floorGrid = Wd.floor, SIZE = Wd.SIZE;
    const ftx = PP.Art.floorTex;
    const fogInv = 1 / (FOG_FAR - FOG_NEAR);

    for (let y = 0; y < H; y++) {
      const b = (ccy - y) / projDist;
      const dirZ = fz + b * uz;               // sin(pitch) + b*cos(pitch)
      // 天空行：dirZ >= 0 → 采样天空全景
      if (dirZ >= -0.0008) {
        const el = pitchv + rowEl[y];
        let v = ((el + 0.30) / 1.62) * (skyTex.h - 1);
        if (v < 0) v = 0; else if (v > skyTex.h - 1) v = skyTex.h - 1;
        const rowOff = (v | 0) * skyTex.w;
        const o = y * W;
        const sd = skyTex.data;
        for (let x = 0; x < W; x++) {
          let u = (((yawv + colAz[x]) * (skyTex.w / (Math.PI * 2))) | 0) % skyTex.w;
          if (u < 0) u += skyTex.w;
          buf32[o + x] = sd[rowOff + u];
        }
        zb.fill(0, y * W, y * W + W);
        continue;
      }
      // 地面行
      const t = camZ / (-dirZ);               // 射线参数
      let dmax = Math.hypot(t * (fx + b * ux), t * (fy + b * uy));
      if (dmax > FOG_FAR + 6) dmax = FOG_FAR + 6;
      const o = y * W;
      if (dmax > FOG_FAR) {
        const c = PP.Art.rgb(SKY_FOG.r, SKY_FOG.g, SKY_FOG.b);
        buf32.fill(c, o, o + W);
        zb.fill(0, o, o + W);
        continue;
      }
      // 起点（x=0 列）与每列步进
      const a0 = (0 - ccx) / projDist;
      let wx = camX + t * (fx + a0 * rx + b * ux);
      let wy = camY + t * (fy + a0 * ry + b * uy);
      const sx = t * rx / projDist, sy = t * ry / projDist;
      const invRow = 1 / t;                    // 深度 = 沿相机前向的分量（dir 与 right/up 正交，故 zc = t）
      const dist = Math.hypot(wx - camX, wy - camY);
      let tf = (dist - FOG_NEAR) * fogInv;
      if (tf < 0) tf = 0; else if (tf > 1) tf = 1;
      const ti = (tf * 255) | 0;
      zb.fill(invRow, o, o + W);
      for (let x = 0; x < W; x++, wx += sx, wy += sy) {
        const gx = wx | 0, gy = wy | 0;
        let fid = 0;
        if (gx >= 0 && gy >= 0 && gx < SIZE && gy < SIZE) fid = floorGrid[gy * SIZE + gx];
        const data = (ftx[fid] || ftx[0]).data;
        const tx2 = ((wx * TEX) | 0) & MASK, ty2 = ((wy * TEX) | 0) & MASK;
        const c = data[ty2 * TEX + tx2];
        let rr = c & 255, gg = (c >>> 8) & 255, bb = (c >>> 16) & 255;
        if (ti) {
          rr += ((SKY_FOG.r - rr) * ti) >> 8;
          gg += ((SKY_FOG.g - gg) * ti) >> 8;
          bb += ((SKY_FOG.b - bb) * ti) >> 8;
        }
        buf32[o + x] = (0xff000000 | (bb << 16) | (gg << 8) | rr) >>> 0;
      }
    }
  }

  /* ---------------- 精灵（公告板） ---------------- */
  function drawSprite(tex, wx, wy, wz, hgt, flash) {
    // 以世界点为中心的竖直公告板：横向用 right 向量
    const dx = wx - camX, dy = wy - camY, dz = wz - camZ;
    const zc = dx * fx + dy * fy + dz * fz;
    if (zc < NEAR) return;
    const xc = dx * rx + dy * ry;
    const ycBase = dx * ux + dy * uy + dz * uz;
    const inv = 1 / zc;
    const sx = ccx + xc * projDist * inv;
    const syBase = ccy - ycBase * projDist * inv;
    const syTop = ccy - (ycBase + hgt) * projDist * inv;
    const wpx = hgt * (tex.w / tex.h) * projDist * inv;
    const hpx = syBase - syTop;
    if (wpx < 0.7 || hpx < 0.7) return;

    let x0 = Math.floor(sx - wpx / 2), x1 = Math.ceil(sx + wpx / 2);
    let y0 = Math.floor(syTop), y1 = Math.ceil(syBase);
    if (x1 < 0 || x0 >= W || y1 < 0 || y0 >= H) return;
    const left = sx - wpx / 2;
    const stepX = tex.w / wpx, stepY = tex.h / hpx;
    const iz = inv;
    const td = tex.data, tw = tex.w, th = tex.h;
    const fogInv = 1 / (FOG_FAR - FOG_NEAR);
    let tf = (zc - FOG_NEAR) * fogInv;
    if (tf < 0) tf = 0; else if (tf > 1) tf = 1;
    const ti = (tf * 255) | 0;

    const cx0 = Math.max(0, x0), cx1 = Math.min(W - 1, x1);
    const cy0 = Math.max(0, y0), cy1 = Math.min(H - 1, y1);
    for (let y = cy0; y <= cy1; y++) {
      const tY = (((y - syTop) * stepY) | 0);
      if (tY < 0 || tY >= th) continue;
      let o = y * W + cx0;
      for (let x = cx0; x <= cx1; x++, o++) {
        if (iz <= zb[o]) continue;
        const tX = (((x - left) * stepX) | 0);
        if (tX < 0 || tX >= tw) continue;
        const c = td[tY * tw + tX];
        if (c === 0) continue;
        if (flash) {
          buf32[o] = (0xff000000 | ((((c >>> 16) & 255) >> 1) + 140) << 16 |
            ((((c >>> 8) & 255) >> 1) + 140) << 8 | (((c & 255) >> 1) + 140)) >>> 0;
        } else {
          let rr = c & 255, gg = (c >>> 8) & 255, bb = (c >>> 16) & 255;
          if (ti) {
            rr += ((SKY_FOG.r - rr) * ti) >> 8;
            gg += ((SKY_FOG.g - gg) * ti) >> 8;
            bb += ((SKY_FOG.b - bb) * ti) >> 8;
          }
          buf32[o] = (0xff000000 | (bb << 16) | (gg << 8) | rr) >>> 0;
        }
      }
    }
  }

  /* 观战目标：优先未倒地的存活队友，其次最近倒地队友 */
  function pickSpectate(G) {
    const me = G.player;
    const mates = G.mates || [];
    let bestUp = null, bestUpD = 1e9;
    let bestDown = null, bestDownD = 1e9;
    for (const m of mates) {
      if (!m || m.eliminated) continue;
      const d = (m.x - me.x) * (m.x - me.x) + (m.y - me.y) * (m.y - me.y);
      if (m.downed) {
        if (d < bestDownD) { bestDownD = d; bestDown = m; }
      } else if (d < bestUpD) {
        bestUpD = d; bestUp = m;
      }
    }
    return bestUp || bestDown || null;
  }

  /* ---------------- 主帧 ---------------- */
  R.frame = function (G) {
    const Art = PP.Art;
    const p = G.player;
    if (!p) return;

    // 观战：阵亡 / 倒地时跟随存活队友；无队友则趴低视角
    let camObj = p;
    let spectating = false;
    if (G.mates && G.mates.length && (p.eliminated || p.downed)) {
      const target = pickSpectate(G);
      if (target) { camObj = target; spectating = true; }
    }
    const selfDown = !spectating && p.downed;
    const eye = selfDown ? 0.30 : EYE;
    const pitch = (camObj.pitch !== undefined ? camObj.pitch : camObj.tpitch) || 0;
    setCam(camObj.x, camObj.y, eye + (G.viewOffsetY || 0) * 0.002, camObj.a || 0, pitch);

    zb.fill(0);
    drawGround(G);
    drawBlocks(G);

    // 精灵收集
    const list = G.renderList;
    list.length = 0;
    for (let i = 0; i < G.enemies.length; i++) {
      const e = G.enemies[i];
      const set = Art.sprites[e.type];
      if (!set) continue;
      if (e.state === 'dead') list.push({ x: e.x, y: e.y, z: 0.02, h: 0.44, tex: set.dead });
      else list.push({
        x: e.x, y: e.y, z: e.z0, h: e.height,
        tex: (e.windup > 0 ? set.atk : (e.hurt > 0 ? set.hurt : set.walk)),
        flash: e.hurt > 0
      });
    }
    if (G.mates) {
      for (const m of G.mates) {
        if (m.eliminated) continue;
        const set = Art.sprites.player[(m.colorIdx || 0) % Art.sprites.player.length];
        if (m.downed) list.push({ x: m.x, y: m.y, z: 0.02, h: 0.44, tex: set.dead });
        else list.push({ x: m.x, y: m.y, z: 0, h: 0.98, tex: (m.fireT > 0 ? set.atk : set.walk) });
      }
    }
    // 自己倒地时画出自己的身体（观战他人时不画）
    if (!spectating && (p.downed || p.eliminated)) {
      const set = Art.sprites.player[(p.colorIdx || 0) % Art.sprites.player.length];
      list.push({ x: p.x, y: p.y, z: 0.02, h: 0.44, tex: set.dead });
    }
    for (const it of G.pickups) list.push({ x: it.x, y: it.y, z: 0.16 + Math.sin(it.t * 3) * 0.05, h: 0.46, tex: Art.pickups[it.kind] || Art.pickups.ammo });
    for (const b of G.projectiles) list.push({ x: b.x, y: b.y, z: (b.z || 0.6) - 0.16, h: 0.32, tex: Art.bone });
    for (const q of G.particles) list.push({ x: q.x, y: q.y, z: q.z, h: 0.05 * q.size, tex: Art.particle[q.tex] || Art.particle.blood });

    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      s.d = (s.x - camX) * (s.x - camX) + (s.y - camY) * (s.y - camY);
    }
    list.sort((a, b) => b.d - a.d);
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      drawSprite(s.tex, s.x, s.y, s.z, s.h, s.flash);
    }

    // 世界/精灵先做时域混合，再画枪（枪保持锐利不拖影）
    taaBlend(G, camObj);
    G.spectateName = spectating ? (camObj.name || '队友') : '';

    // 手中武器：观战 / 阵亡 / 倒地时不画
    const showGun = !spectating && !p.eliminated && !p.downed;
    const gfx = showGun ? Art.weaponGfx[G.weapon] : null;
    const s = ssaa;
    if (gfx) {
      const gw = gfx.idle.w * s, gh = gfx.idle.h * s;
      const gx = Math.round(W / 2 - gw / 2 + G.weaponSwayX * s);
      const gy = Math.round(H - gh + (G.weaponBobY + G.weaponRaise) * s);
      if (s === 1) blit(gfx.idle, gx, gy);
      else blitScaled(gfx.idle, gx, gy, s);
      if (G.muzzleT > 0) {
        const m = Art.muzzle;
        const k = (0.7 + Math.random() * 0.6) * s;
        blitScaled(m, gx + gfx.muzzle[0] * s - (m.w * k) / 2, gy + gfx.muzzle[1] * s - (m.h * k) / 2, k);
      }
      present();
      if (G.muzzleT > 0) {
        const mx = gx + gfx.muzzle[0] * s, my = gy + gfx.muzzle[1] * s;
        // 枪在渲染坐标系，光晕画在画布上：换算到输出分辨率
        const mxo = mx / s, myo = my / s;
        const rad = 90 * (G.muzzleT / 0.06);
        const grd = ctx.createRadialGradient(mxo, myo, 0, mxo, myo, Math.max(4, rad));
        const a = Math.min(0.5, G.muzzleT * 7);
        grd.addColorStop(0, 'rgba(255,235,170,' + a.toFixed(3) + ')');
        grd.addColorStop(1, 'rgba(255,170,60,0)');
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = grd;
        ctx.fillRect(0, 0, outW, outH);
        ctx.globalCompositeOperation = 'source-over';
      }
    } else {
      present();
    }

    drawMinimap(G);
  };

  function blit(tex, ox, oy) {
    const tw = tex.w, th = tex.h, td = tex.data;
    for (let y = 0; y < th; y++) {
      const yy = oy + y;
      if (yy < 0 || yy >= H) continue;
      const rowS = y * tw, rowD = yy * W;
      for (let x = 0; x < tw; x++) {
        const xx = ox + x;
        if (xx < 0 || xx >= W) continue;
        const c = td[rowS + x];
        if (c !== 0) buf32[rowD + xx] = c;
      }
    }
  }

  function blitScaled(tex, ox, oy, k) {
    const tw = Math.max(1, Math.round(tex.w * k)), th = Math.max(1, Math.round(tex.h * k));
    const td = tex.data;
    for (let y = 0; y < th; y++) {
      const yy = oy + y;
      if (yy < 0 || yy >= H) continue;
      const sy = ((y / th) * tex.h) | 0;
      const rowD = yy * W;
      for (let x = 0; x < tw; x++) {
        const xx = ox + x;
        if (xx < 0 || xx >= W) continue;
        const sx2 = ((x / tw) * tex.w) | 0;
        const c = td[sy * tex.w + sx2];
        if (c !== 0) buf32[rowD + xx] = c;
      }
    }
  }

  function drawMinimap(G) {
    const STRIDE = 3, S = 1;
    const Wd = PP.World, SIZE = Wd.SIZE;
    const mw = Math.ceil(SIZE / STRIDE), mh = mw;
    const ox = Math.round((outW - mw) / 2), oy = 6;
    ctx.fillStyle = 'rgba(10,20,14,0.62)';
    ctx.fillRect(ox - 2, oy - 2, mw + 4, mh + 4);
    ctx.strokeStyle = 'rgba(200,255,190,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox - 2.5, oy - 2.5, mw + 5, mh + 5);
    const p = G.player;
    const px = (p.x / STRIDE) | 0, py = (p.y / STRIDE) | 0;
    const R2 = 22;
    for (let y = py - R2; y <= py + R2; y++) {
      for (let x = px - R2; x <= px + R2; x++) {
        if (x < 0 || y < 0 || x >= mw || y >= mh) continue;
        const gx = x * STRIDE, gy = y * STRIDE;
        if (gx >= SIZE || gy >= SIZE) continue;
        const t = Wd.wall[gy * SIZE + gx];
        if (t === 0) continue;
        ctx.fillStyle = t === 5 ? '#3a7a2a' : t === 6 ? '#4a9a34' : t === 2 ? '#a2733f' : t === 3 ? '#a85a48' : '#8a8a8a';
        ctx.fillRect(ox + x, oy + y, S, S);
      }
    }
    for (const poi of Wd.pois) {
      ctx.fillStyle = poi.type === 'camp' ? '#7fe07f' : '#ffe066';
      ctx.fillRect(ox + (poi.x / STRIDE | 0) - 1, oy + (poi.y / STRIDE | 0) - 1, 2, 2);
    }
    if (G.mates) {
      for (const m of G.mates) {
        if (m.eliminated) continue;
        ctx.fillStyle = m.downed ? '#ff9c3c' : '#8fd8ff';
        ctx.fillRect(ox + (m.x / STRIDE | 0) - 1, oy + (m.y / STRIDE | 0) - 1, 2, 2);
      }
    }
    for (const e of G.enemies) {
      if (e.state !== 'alive') continue;
      ctx.fillStyle = e.type === 'husk' ? '#e8c078' : (e.type === 'skeleton' ? '#f0f0e0' : e.type === 'creeper' ? '#6fdc4a' : e.type === 'spider' ? '#b070d0' : '#7fd45a');
      ctx.fillRect(ox + (e.x / STRIDE | 0) - 1, oy + (e.y / STRIDE | 0) - 1, 2, 2);
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(ox + px - 1, oy + py - 1, 3, 3);
    const lx = ox + px + Math.cos(p.a) * 3, ly = oy + py + Math.sin(p.a) * 3;
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath(); ctx.moveTo(ox + px, oy + py); ctx.lineTo(lx, ly); ctx.stroke();
  }
})();
