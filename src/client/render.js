/* ============================================================
   render.js — 软件光栅化：DDA 墙体 + 地面投射 + 天空全景 + 精灵
   写入 Uint32Array 像素缓冲 → putImageData → CSS 放大（硬边像素）
   渲染成本 ≈ 内部分辨率像素数，与地图大小无关（192² 与 32² 同价）
   ============================================================ */
(function () {
  const ROOT = (typeof window !== 'undefined') ? window : globalThis;
  const PP = (ROOT.PP = ROOT.PP || {});
  const R = (PP.Render = {});

  const PLANE = 0.72;
  const EYE = 0.5;
  const TEX = 64;
  const TEXMASK = 63;

  let cvs = null, ctx = null, img = null, buf32 = null;
  let W = 0, H = 0, zbuf = null, projDist = 0, colAng = null;
  R.quality = 1;

  const SKY_TOP = { r: 62, g: 140, b: 224 };
  const SKY_HOR = { r: 176, g: 222, b: 248 };
  const SKY_FOG = { r: 168, g: 214, b: 244 };

  R.init = function (canvas) {
    cvs = canvas;
    ctx = cvs.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = false;
    makeSky();
    R.resize();
  };

  /* ---------------- 天空全景（512x64，随视角滚动） ---------------- */
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
        // 云：低频噪声，靠近地平线更密
        const cf = PP.Core.fbm(x / 34, y / 12 + 3, 7717, 3) + PP.Core.fbm(x / 90, y / 30, 3313, 2) * 0.5;
        const cloud = cf - 0.62 + (1 - t) * 0.10;
        if (cloud > 0) {
          const k = Math.min(1, cloud * 4.5);
          r += (255 - r) * k; g += (255 - g) * k; b += (255 - b) * k;
        }
        skyTex.data[y * w + x] = PP.Art.rgb(r | 0, g | 0, b | 0);
      }
    }
    // 太阳
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
    // 星星（顶部）
    for (let i = 0; i < 120; i++) {
      const x = (rng() * w) | 0, y = (rng() * 10) | 0;
      skyTex.data[y * w + x] = PP.Art.rgb(255, 255, 245);
    }
  }

  R.resize = function () {
    if (!cvs) return;
    const vw = ROOT.innerWidth || 960, vh = ROOT.innerHeight || 600;
    const aspect = vw / vh;
    const target = 90000 * R.quality;
    let h = Math.sqrt(target / aspect);
    h = Math.max(150, Math.min(280, Math.round(h)));
    let w = Math.round(h * aspect);
    w = Math.max(220, Math.min(600, w));
    W = w; H = h;
    cvs.width = W; cvs.height = H;
    ctx.imageSmoothingEnabled = false;
    img = ctx.createImageData(W, H);
    buf32 = new Uint32Array(img.data.buffer);
    zbuf = new Float32Array(W);
    projDist = (W / 2) / PLANE;
    colAng = new Float32Array(W);
    for (let x = 0; x < W; x++) colAng[x] = Math.atan2((2 * x / W - 1) * PLANE, 1);
    R.W = W; R.H = H;
  };

  /* 雾：亮度系数 + 向天空色混合的比例（0..256） */
  const FOG_NEAR = 16, FOG_FAR = 62;
  function fogAmount(d) {
    if (d <= FOG_NEAR) return 0;
    let t = (d - FOG_NEAR) / (FOG_FAR - FOG_NEAR);
    if (t > 1) t = 1;
    return (t * 210) | 0;
  }
  function shade(c, f) {
    const r = ((c & 255) * f) >> 8;
    const g = (((c >>> 8) & 255) * f) >> 8;
    const b = (((c >>> 16) & 255) * f) >> 8;
    return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
  }
  function shadeFog(c, f, t) {
    let r = ((c & 255) * f) >> 8;
    let g = (((c >>> 8) & 255) * f) >> 8;
    let b = (((c >>> 16) & 255) * f) >> 8;
    if (t) {
      r += ((SKY_FOG.r - r) * t) >> 8;
      g += ((SKY_FOG.g - g) * t) >> 8;
      b += ((SKY_FOG.b - b) * t) >> 8;
    }
    return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
  }
  function flashify(c) {
    const r = Math.min(255, ((c & 255) >> 1) + 140);
    const g = Math.min(255, (((c >>> 8) & 255) >> 1) + 140);
    const b = Math.min(255, (((c >>> 16) & 255) >> 1) + 140);
    return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
  }

  /* ---------------- 主绘制 ---------------- */
  R.frame = function (G) {
    const Art = PP.Art, Wd = PP.World;
    const p = G.player;
    const grid = Wd.wall, floorGrid = Wd.floor, SIZE = Wd.SIZE;
    const wallTex = Art.wallTex, floorTexs = Art.floorTex, ceilTex = Art.tex.plankCeil || Art.tex.plank;
    const wallHTab = Wd.wallHeight;

    const dirX = Math.cos(p.a), dirY = Math.sin(p.a);
    const planeX = -dirY * PLANE, planeY = dirX * PLANE;
    const horizon = H * 0.5 + Math.tan(p.pitch) * projDist + G.viewOffsetY;
    const roofed = Wd.floorAt(p.x, p.y) === 3 || Wd.floorAt(p.x, p.y) === 4;

    /* ===== 1) 天空 / 天花板 ===== */
    if (roofed) {
      for (let y = 0; y < H; y++) {
        const pd = y - horizon;
        if (pd >= -0.0001) break;
        const rowDist = (1 - EYE) * projDist / (-pd);
        if (rowDist > 70) break;
        const f = 256 - fogAmount(rowDist) * 0.35 | 0;
        const t = fogAmount(rowDist);
        const o = y * W;
        const stepX = rowDist * (dirX + planeX - (dirX - planeX)) / W;
        const stepY = rowDist * (dirY + planeY - (dirY - planeY)) / W;
        let fx = p.x + rowDist * (dirX - planeX);
        let fy = p.y + rowDist * (dirY - planeY);
        const data = ceilTex.data;
        for (let x = 0; x < W; x++) {
          const tx = ((fx * TEX) | 0) & TEXMASK;
          const ty = ((fy * TEX) | 0) & TEXMASK;
          buf32[o + x] = t ? shadeFog(data[ty * TEX + tx], f, t) : shade(data[ty * TEX + tx], f);
          fx += stepX; fy += stepY;
        }
      }
    } else {
      const skyH = Math.max(1, Math.ceil(Math.min(horizon, H)));
      const sw = skyTex.w, sh = skyTex.h, sd = skyTex.data;
      const vScale = sh / (H * 0.62);
      for (let y = 0; y < skyH; y++) {
        let v = ((horizon - y) * vScale) | 0;
        if (v < 0) v = 0; if (v >= sh) v = sh - 1;
        const rowOff = v * sw;
        const o = y * W;
        for (let x = 0; x < W; x++) {
          let u = (((p.a + colAng[x]) * (sw / (Math.PI * 2))) | 0) % sw;
          if (u < 0) u += sw;
          buf32[o + x] = sd[rowOff + u];
        }
      }
      // 地平线以下但天空未覆盖到的部分（抬头时）由地面 pass 填
    }

    /* ===== 2) 地面 ===== */
    const rd0x = dirX - planeX, rd0y = dirY - planeY;
    const rd1x = dirX + planeX, rd1y = dirY + planeY;
    const yStart = Math.max(0, Math.floor(horizon) + 1);
    for (let y = yStart; y < H; y++) {
      const pd = y - horizon;
      if (pd <= 0.0001) continue;
      const rowDist = EYE * projDist / pd;
      const o = y * W;
      if (rowDist > 70) { buf32.fill(0xff000000 | (SKY_FOG.b << 16) | (SKY_FOG.g << 8) | SKY_FOG.r, o, o + W); continue; }
      const f = 256;
      const t = fogAmount(rowDist);
      const stepX = rowDist * (rd1x - rd0x) / W;
      const stepY = rowDist * (rd1y - rd0y) / W;
      let fx = p.x + rowDist * rd0x;
      let fy = p.y + rowDist * rd0y;
      for (let x = 0; x < W; x++) {
        const tx = ((fx * TEX) | 0) & TEXMASK;
        const ty = ((fy * TEX) | 0) & TEXMASK;
        const gx = fx | 0, gy = fy | 0;
        let fid = 0;
        if (gx >= 0 && gy >= 0 && gx < SIZE && gy < SIZE) fid = floorGrid[gy * SIZE + gx];
        const data = (floorTexs[fid] || floorTexs[0]).data;
        const c = data[ty * TEX + tx];
        buf32[o + x] = t ? shadeFog(c, f, t) : c;
        fx += stepX; fy += stepY;
      }
    }

    /* ===== 3) 墙体 ===== */
    for (let x = 0; x < W; x++) {
      const camX = 2 * x / W - 1;
      const rdx = dirX + planeX * camX;
      const rdy = dirY + planeY * camX;
      let mapX = p.x | 0, mapY = p.y | 0;
      const ddx = rdx === 0 ? 1e30 : Math.abs(1 / rdx);
      const ddy = rdy === 0 ? 1e30 : Math.abs(1 / rdy);
      let stepX, stepY, sdx, sdy;
      if (rdx < 0) { stepX = -1; sdx = (p.x - mapX) * ddx; } else { stepX = 1; sdx = (mapX + 1 - p.x) * ddx; }
      if (rdy < 0) { stepY = -1; sdy = (p.y - mapY) * ddy; } else { stepY = 1; sdy = (mapY + 1 - p.y) * ddy; }
      let side = 0, hit = false, guard = 0;
      while (guard++ < 400) {
        if (sdx < sdy) { sdx += ddx; mapX += stepX; side = 0; }
        else { sdy += ddy; mapY += stepY; side = 1; }
        if (mapX < 0 || mapY < 0 || mapX >= SIZE || mapY >= SIZE) break;
        if (grid[mapY * SIZE + mapX] !== 0) { hit = true; break; }
      }
      const perp = hit ? (side === 0 ? (sdx - ddx) : (sdy - ddy)) : 70;
      zbuf[x] = perp;
      if (!hit || perp <= 0.0001) continue;

      const texId = grid[mapY * SIZE + mapX];
      const hWall = wallHTab[texId] || 1;          // 这格墙的实际高度
      const lineH = projDist / perp;               // 每世界单位的像素数
      const yTop = horizon - (hWall - EYE) * lineH;
      const yBot = horizon + EYE * lineH;
      const data = (wallTex[texId - 1] || wallTex[0]).data;
      let wallX = side === 0 ? (p.y + perp * rdy) : (p.x + perp * rdx);
      wallX -= Math.floor(wallX);
      let texX = (wallX * TEX) | 0;
      if ((side === 0 && rdx > 0) || (side === 1 && rdy < 0)) texX = TEXMASK - texX;
      texX &= TEXMASK;

      let f = 256;
      if (side === 1) f = 190;
      const t = fogAmount(perp);
      const step = TEX / (hWall * lineH);   // 纹理纵向平铺（高墙重复贴图）
      let y0 = yTop < 0 ? 0 : Math.ceil(yTop);
      let y1 = yBot > H ? H : Math.ceil(yBot);
      let texPos = (y0 - yTop) * step;
      if (y1 > y0) {
        for (let y = y0; y < y1; y++) {
          const ty = (texPos | 0) & TEXMASK;
          texPos += step;
          const c = data[ty * TEX + texX];
          buf32[y * W + x] = t ? shadeFog(c, f, t) : shade(c, f);
        }
      }
    }

    /* ===== 4) 精灵 ===== */
    const list = G.renderList;
    list.length = 0;
    for (let i = 0; i < G.enemies.length; i++) {
      const e = G.enemies[i];
      const set = Art.sprites[e.type];
      if (e.state === 'dead') {
        list.push({ x: e.x, y: e.y, z0: 0.02, h: 0.44, tex: set.dead, flash: false });
      } else {
        const tex = (e.windup > 0) ? set.atk : (e.hurt > 0 ? set.hurt : set.walk);
        list.push({ x: e.x, y: e.y, z0: e.z0, h: e.height, tex: tex, flash: e.hurt > 0, spawn: e.spawnT > 0 ? e.spawnT / 0.35 : 0 });
      }
    }
    for (let i = 0; i < G.pickups.length; i++) {
      const it = G.pickups[i];
      list.push({ x: it.x, y: it.y, z0: 0.16 + Math.sin(it.t * 3) * 0.05, h: 0.46, tex: Art.pickups[it.kind] || Art.pickups.ammo });
    }
    // 联机队友
    if (G.mates) {
      for (let i = 0; i < G.mates.length; i++) {
        const m = G.mates[i];
        if (m.eliminated) continue;
        const set = Art.sprites.player[(m.colorIdx || 0) % Art.sprites.player.length];
        if (m.downed) list.push({ x: m.x, y: m.y, z0: 0.02, h: 0.44, tex: set.dead });
        else list.push({
          x: m.x, y: m.y, z0: 0, h: 0.98,
          tex: (m.fireT > 0 ? set.atk : set.walk)
        });
      }
    }
    for (let i = 0; i < G.projectiles.length; i++) {
      const b = G.projectiles[i];
      list.push({ x: b.x, y: b.y, z0: (b.z || 0.6) - 0.16, h: 0.32, tex: Art.bone });
    }
    for (let i = 0; i < G.particles.length; i++) {
      const q = G.particles[i];
      list.push({ x: q.x, y: q.y, z0: q.z, h: 0.05 * q.size, tex: Art.particle[q.tex] || Art.particle.blood });
    }
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      s.d = (s.x - p.x) * (s.x - p.x) + (s.y - p.y) * (s.y - p.y);
    }
    list.sort((a, b) => b.d - a.d);

    const invDet = 1.0 / (planeX * dirY - dirX * planeY);
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const sx = s.x - p.x, sy = s.y - p.y;
      const ty = invDet * (-planeY * sx + planeX * sy);
      if (ty <= 0.05) continue;
      const tx = invDet * (dirY * sx - dirX * sy);
      const screenX = (W / 2) * (1 + tx / ty);
      let hh = s.h;
      if (s.spawn) hh *= (1 - s.spawn * 0.7);
      const hpx = (hh * projDist) / ty;
      const wpx = hpx * (s.tex.w / s.tex.h);
      if (wpx < 0.6 || hpx < 0.6) continue;
      const yTop = horizon - (s.z0 + hh - EYE) * projDist / ty;
      const yBot = horizon - (s.z0 - EYE) * projDist / ty;
      let x0 = Math.floor(screenX - wpx / 2), x1 = Math.floor(screenX + wpx / 2);
      let y0 = Math.ceil(yTop), y1 = Math.floor(yBot);
      if (x1 < 0 || x0 >= W || y1 < 0 || y0 >= H) continue;
      if (x0 < 0) x0 = 0; if (x1 > W - 1) x1 = W - 1;
      if (y0 < 0) y0 = 0; if (y1 > H - 1) y1 = H - 1;
      const t = fogAmount(ty);
      const f = 256;
      const stepX = s.tex.w / wpx, stepY = s.tex.h / hpx;
      const left = screenX - wpx / 2;
      const tex = s.tex, td = tex.data, tw = tex.w, th = tex.h, fl = s.flash;
      for (let x = x0; x <= x1; x++) {
        if (ty >= zbuf[x]) continue;
        const tX = (((x - left) * stepX) | 0);
        if (tX < 0 || tX >= tw) continue;
        let texYf = (y0 - yTop) * stepY;
        let o = y0 * W + x;
        for (let y = y0; y <= y1; y++) {
          const tY = (texYf | 0);
          texYf += stepY;
          if (tY >= 0 && tY < th) {
            const c = td[tY * tw + tX];
            if (c !== 0) buf32[o] = fl ? flashify(c) : (t ? shadeFog(c, f, t) : c);
          }
          o += W;
        }
      }
    }

    /* ===== 5) 手中武器 ===== */
    const gfx = Art.weaponGfx[G.weapon];
    if (gfx) {
      const gx = Math.round(W / 2 - gfx.idle.w / 2 + G.weaponSwayX);
      const gy = Math.round(H - gfx.idle.h + G.weaponBobY + G.weaponRaise);
      blit(gfx.idle, gx, gy);
      if (G.muzzleT > 0) {
        const m = Art.muzzle;
        const k = 0.7 + Math.random() * 0.6;
        blitScaled(m, gx + gfx.muzzle[0] - (m.w * k) / 2, gy + gfx.muzzle[1] - (m.h * k) / 2, k);
      }
      ctx.putImageData(img, 0, 0);
      if (G.muzzleT > 0) {
        const mx = gx + gfx.muzzle[0], my = gy + gfx.muzzle[1];
        const rad = 90 * (G.muzzleT / 0.06);
        const grd = ctx.createRadialGradient(mx, my, 0, mx, my, Math.max(4, rad));
        const a = Math.min(0.5, G.muzzleT * 7);
        grd.addColorStop(0, 'rgba(255,235,170,' + a.toFixed(3) + ')');
        grd.addColorStop(1, 'rgba(255,170,60,0)');
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = grd;
        ctx.fillRect(0, 0, W, H);
        ctx.globalCompositeOperation = 'source-over';
      }
    } else {
      ctx.putImageData(img, 0, 0);
    }

    /* ===== 6) 小地图 ===== */
    drawMinimap(G, SIZE, grid);
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
        const sx = ((x / tw) * tex.w) | 0;
        const c = td[sy * tex.w + sx];
        if (c !== 0) buf32[rowD + xx] = c;
      }
    }
  }

  function drawMinimap(G, SIZE, grid) {
    const STRIDE = 3, S = 1;
    const mw = Math.ceil(SIZE / STRIDE), mh = mw;
    const ox = Math.round((W - mw) / 2), oy = 6;
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
        const t = grid[gy * SIZE + gx];
        if (t === 0) continue;
        ctx.fillStyle = t === 5 ? '#3a7a2a' : t === 6 ? '#4a9a34' : t === 2 ? '#a2733f' : t === 3 ? '#a85a48' : '#8a8a8a';
        ctx.fillRect(ox + x, oy + y, S, S);
      }
    }
    for (const poi of PP.World.pois) {
      ctx.fillStyle = poi.type === 'camp' ? '#7fe07f' : '#ffe066';
      ctx.fillRect(ox + (poi.x / STRIDE | 0) - 1, oy + (poi.y / STRIDE | 0) - 1, 2, 2);
    }
    for (const it of G.pickups) {
      if (it.kind === 'chest') { ctx.fillStyle = '#ffd447'; ctx.fillRect(ox + (it.x / STRIDE | 0) - 1, oy + (it.y / STRIDE | 0) - 1, 2, 2); }
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
      ctx.fillStyle = e.type === 'husk' ? '#e8c078' : (e.type === 'skeleton' ? '#f0f0e0' : '#7fd45a');
      ctx.fillRect(ox + (e.x / STRIDE | 0) - 1, oy + (e.y / STRIDE | 0) - 1, 2, 2);
    }
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(ox + px - 1, oy + py - 1, 3, 3);
    const lx = ox + px + Math.cos(p.a) * 3, ly = oy + py + Math.sin(p.a) * 3;
    ctx.strokeStyle = '#ffffff';
    ctx.beginPath(); ctx.moveTo(ox + px, oy + py); ctx.lineTo(lx, ly); ctx.stroke();
  }
})();
