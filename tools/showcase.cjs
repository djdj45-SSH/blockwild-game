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
  });

  // 找一个真正空旷的点：半径 5 全空，且某个方向 14 格内全空
  const spot = await page.evaluate(() => {
    const W = window.PP.World, SIZE = W.SIZE, wall = W.wall;
    const solid = (x, y) => (x < 1 || y < 1 || x >= SIZE - 1 || y >= SIZE - 1) ? true : wall[Math.floor(y) * SIZE + Math.floor(x)] !== 0;
    const clearBox = (cx, cy, r) => {
      for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (solid(cx + i, cy + j)) return false;
      return true;
    };
    const dirOf = (cx, cy, ang) => {
      for (let d = 1; d <= 16; d++) {
        if (solid(cx + Math.cos(ang) * d, cy + Math.sin(ang) * d)) return d;
      }
      return 16;
    };
    let best = null;
    for (let y = 8; y < SIZE - 8; y += 2) {
      for (let x = 8; x < SIZE - 8; x += 2) {
        if (!clearBox(x, y, 5)) continue;
        let bestAng = 0, bestD = 0;
        for (let k = 0; k < 16; k++) {
          const ang = k * Math.PI / 8;
          const d = dirOf(x, y, ang);
          if (d > bestD) { bestD = d; bestAng = ang; }
        }
        if (!best || bestD > best.d) best = { x: x + 0.5, y: y + 0.5, ang: bestAng, d: bestD };
      }
    }
    return best || { x: SIZE / 2, y: SIZE / 2, ang: 0, d: 6 };
  });

  // A: 清场 + 在面前一字排开 5 种怪
  await page.evaluate((s) => {
    const G = window.PP.G;
    G.player.x = s.x; G.player.y = s.y; G.player.pitch = 0.05; G.player.pitchBase = 0.05;
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
    const types = ['cabin', 'bunker', 'tower', 'ruin'];
    for (const t of types) {
      const p = (W.pois || []).find((q) => q.type === t);
      if (!p) continue;
      // 找一个方向 13 格外是空地
      for (let k = 0; k < 8; k++) {
        const ang = k * Math.PI / 4;
        const px = p.x + Math.cos(ang) * 13, py = p.y + Math.sin(ang) * 13;
        if (px < 5 || py < 5 || px > W.SIZE - 5 || py > W.SIZE - 5) continue;
        if (W.wall[Math.floor(py) * W.SIZE + Math.floor(px)]) continue;
        G.player.x = px; G.player.y = py;
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

  const st = await page.evaluate(() => ({
    stats: window.__BW_RENDER__(),
    alive: (window.PP.G.enemies || []).filter((e) => e.state === 'alive').length,
    pois: window.PP.World.pois.length
  }));
  console.log('POI', JSON.stringify(poi), 'STATS', JSON.stringify(st));
  console.log(errs.length ? 'ERRORS: ' + errs.slice(0, 8).join(' | ') : 'no errors');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
