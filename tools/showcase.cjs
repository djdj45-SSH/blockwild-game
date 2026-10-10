/* showcase.cjs — 取景验收：开阔地 + 建筑 + 正面怪群 + 天空 */
const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path');
function findChromium() {
  const root = 'C:/Users/35547/AppData/Local/ms-playwright';
  if (!fs.existsSync(root)) return null;
  const es = fs.readdirSync(root).filter((n) => n.startsWith('chromium-')).sort();
  for (const e of es.reverse()) {
    for (const rel of ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe']) {
      const p = path.join(root, e, ...rel.split('/'));
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}
const TAG = process.argv[2] || 'show';
const OUT = path.join(__dirname, '..', 'artifacts');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('PE:' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('CE:' + m.text()); });
  await page.goto('http://127.0.0.1:8080/', { waitUntil: 'load' });
  await page.waitForTimeout(900);
  // 固定世界种子：取景是"逐轮对比"用的，种子随机就永远没得比
  await page.evaluate(() => {
    const S = window.PP && window.PP.Sim;
    if (S && !S.__seeded) {
      S.__seeded = true;
      const orig = S.create;
      S.create = function (seed, opts) {
        return orig.call(S, seed === undefined ? 20261002 : seed, opts);
      };
    }
  });
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /单人/.test(x.textContent || '')); if (b) b.click(); });
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    setInterval(() => {
      const g = window.PP.G;
      if (g && g.player) { g.player.hp = g.player.maxHp || 100; g.player.downed = false; g.player.eliminated = false; if (g.state !== 'playing') g.state = 'playing'; }
    }, 150);
  });
  // 冻结模拟：位置由脚本指定，避免怪自己走过来导致取景乱
  await page.evaluate(() => {
    if (!window.__simTickOrig) {
      window.__simTickOrig = window.PP.Sim.tick;
      window.PP.Sim.tick = function () { };
    }
    /* 真 3D 下"瞬移"必须连 z 一起改：只挪 x/y 会让玩家脚停在上一个
       取景点的海拔，相机相对新地形要么埋进土里、要么飘在半空。
       这里包一层 helper，所有场景统一调用。 */
    window.__tp = function (p, x, y) {
      p.x = x; p.y = y;
      const W = window.PP.World;
      p.z = W.surfZAt(x, y);
      p.vz = 0; p.onGround = true; p.fallFrom = p.z;
      return p.z;
    };
  });

  // 找一个真正空旷的点：半径 5 全空，且某个方向 14 格内全空
  const spot = await page.evaluate(() => {
    const W = window.PP.World, SIZE = W.SIZE;
    /* "空旷"的判据必须用**高差**而不是 wall 表。
       真 3D 下 wall 是"该列有实心方块"，整张地图 100% 为真，
       用它找空旷地会随机落到山顶/沙漠 —— 取景完全不可控。
       这里改成：半径 5 内相邻格 surfZ 高差 ≤ 1（可站可走），
       并且中间没有树干（树干会糊住镜头）。 */
    const s = W.surfZ;
    const flatClear = (cx, cy, r) => {
      let base = s[cy * SIZE + cx];
      if (!base) return false;
      for (let j = -r; j <= r; j++) {
        for (let i = -r; i <= r; i++) {
          const x = cx + i, y = cy + j;
          if (x < 1 || y < 1 || x >= SIZE - 1 || y >= SIZE - 1) return false;
          const v = s[y * SIZE + x];
          if (!v || Math.abs(v - base) > 1) return false;
        }
      }
      return true;
    };
    // 前方 16 格内不能有高于脚下 2 格的地形（否则镜头贴着一面土墙）
    const openDir = (cx, cy, ang) => {
      const base = s[cy * SIZE + cx];
      for (let d = 1; d <= 16; d++) {
        const x = Math.floor(cx + Math.cos(ang) * d), y = Math.floor(cy + Math.sin(ang) * d);
        if (x < 1 || y < 1 || x >= SIZE - 1 || y >= SIZE - 1) return d;
        const v = s[y * SIZE + x];
        if (!v || v > base + 2) return d;
      }
      return 16;
    };
    // 优先草地（floor=0），海拔靠近中位（取景海拔太高会一片灰岩石）
    const zs = [];
    for (let i = 0; i < SIZE * SIZE; i += 13) if (s[i]) zs.push(s[i]);
    zs.sort((a, b) => a - b);
    const midZ = zs[(zs.length * 0.5) | 0];
    let best = null;
    for (let y = 10; y < SIZE - 10; y += 2) {
      for (let x = 10; x < SIZE - 10; x += 2) {
        if (!flatClear(x, y, 5)) continue;
        let bestAng = 0, bestD = 0;
        for (let k = 0; k < 16; k++) {
          const ang = k * Math.PI / 8;
          const d = openDir(x, y, ang);
          if (d > bestD) { bestD = d; bestAng = ang; }
        }
        const isGrass = (W.floor[y * SIZE + x] || 0) === 0 ? 1 : 0;
        const zPen = Math.abs(s[y * SIZE + x] - midZ);
        const score = bestD * 10 + isGrass * 25 - zPen * 3;
        if (!best || score > best.score) {
          best = { x: x + 0.5, y: y + 0.5, ang: bestAng, d: bestD, score: score };
        }
      }
    }
    return best || { x: SIZE / 2, y: SIZE / 2, ang: 0, d: 6 };
  });

  // A: 清场 + 在面前一字排开 5 种怪
  await page.evaluate((s) => {
    const G = window.PP.G;
    window.__tp(G.player, s.x, s.y);
    G.player.pitch = 0.05; G.player.pitchBase = 0.05;
    G.player.a = s.ang;
    const dx = Math.cos(s.ang), dy = Math.sin(s.ang);
    const ux = -dy, uy = dx;                       // 侧向单位向量
    G.enemies.length = 0;
    G.pickups.length = 0;
    const types = Object.keys(window.PP.Ent.TYPES);
    for (let i = 0; i < 5; i++) {
      const off = (i - 2) * 1.7;
      const e = window.PP.Ent.spawn(G, types[i % types.length],
        s.x + dx * 4.6 + ux * off, s.y + dy * 4.6 + uy * off);
      if (e) { e.face = s.ang + Math.PI; e.a = s.ang + Math.PI; e.state = 'alive'; }
    }
    window.PP.Ent.spawn(G, 'zombie', s.x + dx * 2.6 - ux * 2.2, s.y + dy * 2.6 - uy * 2.2);
    // 顺手摆几个补给物
    window.PP.Ent.dropPickup(G, s.x + dx * 2.4 + ux * 2.4, s.y + dy * 2.4 + uy * 2.4, 'ammo');
    window.PP.Ent.dropPickup(G, s.x + dx * 6.4, s.y + dy * 6.4, 'chest');
    window.PP.Ent.dropPickup(G, s.x + dx * 2.0, s.y + dy * 2.0, 'health');
  }, spot);
  await page.waitForTimeout(1300);
  await page.screenshot({ path: path.join(OUT, `${TAG}-a-enemies.png`) });

  // B: 站在 POI 前 13 格
  const poi = await page.evaluate(() => {
    const W = window.PP.World, G = window.PP.G;
    const SIZE = W.SIZE;
    const typeAt = (x, y) => W.wall[((y | 0) * SIZE) + (x | 0)];
    const TREE = new Set([5, 6, 7]);            // log / leaves / cactus：会整面糊住镜头
    const types = ['cabin', 'bunker', 'tower', 'ruin'];
    for (const t of types) {
      const p = (W.pois || []).find((q) => q.type === t);
      if (!p) continue;
      // 找一个方向 13 格外是空地
      for (let k = 0; k < 16; k++) {
        const ang = k * Math.PI / 8;
        const px = p.x + Math.cos(ang) * 13, py = p.y + Math.sin(ang) * 13;
        if (px < 6 || py < 6 || px > SIZE - 6 || py > SIZE - 6) continue;
        if (typeAt(px, py)) continue;
        // 沿途必须没有树 —— 否则镜头贴着一整面树篱，取景里什么都看不出
        let blocked = false;
        for (let d = 1; d <= 12; d++) {
          const qx = px + Math.cos(ang + Math.PI) * d;
          const qy = py + Math.sin(ang + Math.PI) * d;
          if (TREE.has(typeAt(qx, qy))) { blocked = true; break; }
        }
        if (blocked) continue;
        window.__tp(G.player, px, py);
        G.player.a = Math.atan2(p.y - py, p.x - px);
        G.player.pitch = 0.06; G.player.pitchBase = 0.06;
        return { type: t, x: p.x, y: p.y };
      }
    }
    return null;
  });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, `${TAG}-b-poi.png`) });

  // C: 抬头看天
  await page.evaluate(() => { const G = window.PP.G; G.player.pitch = 0.85; G.player.pitchBase = 0.85; });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, `${TAG}-c-sky.png`) });

  // D: 开火瞬间（枪口火光 + 后坐）
  await page.evaluate(() => {
    const G = window.PP.G; G.player.pitch = 0; G.player.pitchBase = 0;
    G.muzzleT = 0.06; G.kickPitch = 0.05; G.shake = 0.5;
  });
  await page.waitForTimeout(80);
  await page.screenshot({ path: path.join(OUT, `${TAG}-d-fire.png`) });

  // E: 低头看地面 —— 专查顶点 AO（墙脚接触阴影）与太阳投影是否真的在
  await page.evaluate(() => {
    const G = window.PP.G; G.player.pitch = -0.58; G.player.pitchBase = -0.58;
    G.muzzleT = 0; G.kickPitch = 0; G.shake = 0;
  });
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(OUT, `${TAG}-e-ground.png`) });

  // F: 阴影验证 —— 回到怪群场景，太阳放到玩家正后方低角度，
  //    这样 5 只怪的影子会朝镜头前方投，一定落在视野里。
  //    （默认太阳在右后上方，影子全落在镜头背后，取景里根本无法发现"有没有影子"）
  await page.evaluate((s) => {
    const G = window.PP.G, R = window.PP.Render;
    window.__tp(G.player, s.x, s.y);
    G.player.a = s.ang;
    G.player.pitch = -0.18; G.player.pitchBase = -0.18;
    R.sunOffset.set(-Math.cos(s.ang) * 30, 17, -Math.sin(s.ang) * 30);
  }, spot);
  await page.waitForTimeout(1100);
  await page.screenshot({ path: path.join(OUT, `${TAG}-f-shadow.png`) });

  // G: 极端光照 —— 关掉全部环境光/IBL，只留太阳。
  //    如果这样都看不到影子，就不是"被环境光冲淡"，而是阴影贴图根本没产出
  //    （重点怀疑 SwiftShader 对 sampler2DShadow / textureCompare 的支持）。
  await page.evaluate(() => {
    const R = window.PP.Render, sc = R._scene();
    sc.traverse((o) => {
      if (o.isAmbientLight) o.intensity = 0.02;
      if (o.isHemisphereLight) o.intensity = 0.02;
    });
    if ('environmentIntensity' in sc) sc.environmentIntensity = 0;
  });
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, `${TAG}-g-dark.png`) });

  /* H: 远景俯瞰 —— 真 3D 改造的核心卖点（此前的世界是 2.5D 单层，
        再怎么拍都只有"一堵墙 + 一片地"）。这里找一处**落差最大**的崖边，
        站在高处往低处看，让山脊 / 崖壁 / 谷底 / 远处树线全部进画。 */
  const vista = await page.evaluate(() => {
    const W = window.PP.World, G = window.PP.G, R = window.PP.Render;
    const S = W.SIZE;
    const H = W.HEIGHT || 40;
    // 恢复环境光（G 场景把它们压掉了）
    R._scene().traverse((o) => {
      if (o.isAmbientLight) o.intensity = 0.30;
      if (o.isHemisphereLight) o.intensity = 0.34;
    });
    if ('environmentIntensity' in R._scene()) R._scene().environmentIntensity = 0.22;
    R.sunOffset.set(26, 30, 14);

    // 在中心区域找一个"朝某方向 14 格内落差 ≥ 6 格"的高点
    let best = null;
    for (let y = 40; y < S - 40; y += 2) {
      for (let x = 40; x < S - 40; x += 2) {
        const z0 = W.surfZ[y * S + x];
        if (!z0 || z0 < 12) continue;
        for (let k = 0; k < 16; k++) {
          const a = k * Math.PI / 8;
          const qx = (x + Math.cos(a) * 14) | 0, qy = (y + Math.sin(a) * 14) | 0;
          const z1 = W.surfZ[qy * S + qx];
          if (!z1) continue;
          const drop = z0 - z1;
          if (drop < 6) continue;
          // 沿途不能有树/岩石糊住视线
          let blocked = 0;
          for (let d = 1; d <= 13; d++) {
            const px = (x + Math.cos(a) * d) | 0, py = (y + Math.sin(a) * d) | 0;
            for (let zz = z0; zz < Math.min(z0 + 3, H); zz++) {
              if (W.SOLID[W.getBlock(px, py, zz)] === 1) { blocked++; break; }
            }
          }
          if (blocked > 5) continue;
          if (!best || drop > best.drop) best = { x: x + 0.5, y: y + 0.5, a: a, drop: drop };
        }
      }
    }
    if (!best) return null;
    window.__tp(G.player, best.x, best.y);
    G.player.a = best.a;
    G.player.pitch = -0.34; G.player.pitchBase = -0.34;
    G.enemies.length = 0;
    return best;
  });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, `${TAG}-h-vista.png`) });
  console.log('vista', vista ? JSON.stringify({ x: +vista.x.toFixed(1), y: +vista.y.toFixed(1), drop: vista.drop }) : 'null');

  const st = await page.evaluate((s) => {
    const W = window.PP.World, G = window.PP.G;
    const f = (x, y) => W.floor[((Math.floor(y) | 0) * W.SIZE) + (Math.floor(x) | 0)];
    const w = (x, y) => W.wall[((Math.floor(y) | 0) * W.SIZE) + (Math.floor(x) | 0)];
    const px = G.player.x, py = G.player.y;
    return {
      stats: window.__BW_RENDER__(),
      alive: (window.PP.G.enemies || []).filter((e) => e.state === 'alive').length,
      pois: window.PP.World.pois.length,
      // 脚下 / 四周 6 格的地面与墙体类型 —— 用来判断"地面发暗"到底是
      // 材质本身偏暗，还是阴影自遮挡，免得靠猜
      under: { f: f(px, py), w: w(px, py) },
      ring6: {
        f: [f(px + 6, py), f(px - 6, py), f(px, py + 6), f(px, py - 6)],
        w: [w(px + 6, py), w(px - 6, py), w(px, py + 6), w(px, py - 6)]
      },
      spotRing: { f: f(s.x + 6, s.y), w: w(s.x + 6, s.y) },
      // GL 能力：判断"没影子"是不是软件渲染器不支持阴影采样器
      gl: (() => {
        try {
          const ctx = window.PP.Render._renderer().getContext();
          return {
            renderer: ctx.getParameter(ctx.RENDERER),
            version: ctx.getParameter(ctx.VERSION),
            depthTex: !!ctx.getExtension('WEBGL_depth_texture'),
            colorBufFloat: !!ctx.getExtension('EXT_color_buffer_float')
          };
        } catch (e) { return 'ERR:' + e.message; }
      })(),
      // 阴影链路诊断：截图里"看不到影子"可能是方向问题，也可能是根本没在渲染
      shadow: (() => {
        const R = window.PP.Render;
        const r = R._renderer(), sc = R._scene();
        let sun = null;
        sc.traverse((o) => { if (o.isDirectionalLight && o.castShadow) sun = o; });
        return {
          enabled: r.shadowMap.enabled,
          sunCast: sun ? sun.castShadow : null,
          sunPos: sun ? [+sun.position.x.toFixed(1), +sun.position.y.toFixed(1), +sun.position.z.toFixed(1)] : null,
          mapSize: sun ? [sun.shadow.mapSize.x, sun.shadow.mapSize.y] : null,
          hasMap: sun ? !!sun.shadow.map : null,
          autoUpdate: r.shadowMap.autoUpdate,
          camBounds: sun ? [sun.shadow.camera.left, sun.shadow.camera.right,
            sun.shadow.camera.top, sun.shadow.camera.bottom] : null
        };
      })()
    };
  }, spot);
  console.log('POI', JSON.stringify(poi), 'STATS', JSON.stringify(st));
  console.log(errs.length ? 'ERRORS: ' + errs.slice(0, 8).join(' | ') : 'no errors');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
