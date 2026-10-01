/* weaponshot.cjs — 武器视模专项取景：5 类武器各截一张
   用途：美术调整后逐个确认"枪形是否读得出来"（枪管指向、握把倾角、三色分层） */
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
const TAG = process.argv[2] || 'wpn';
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
  // 冻结模拟：位置/敌人都由脚本指定，避免取景乱
  await page.evaluate(() => {
    window.PP.Sim.tick = function () { };
  });

  const spot = await page.evaluate(() => {
    const W = window.PP.World, SIZE = W.SIZE, wall = W.wall;
    const solid = (x, y) => (x < 1 || y < 1 || x >= SIZE - 1 || y >= SIZE - 1) ? true : wall[Math.floor(y) * SIZE + Math.floor(x)] !== 0;
    const clearBox = (cx, cy, r) => {
      for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) if (solid(cx + i, cy + j)) return false;
      return true;
    };
    const dirOf = (cx, cy, ang) => {
      for (let d = 1; d <= 16; d++) if (solid(cx + Math.cos(ang) * d, cy + Math.sin(ang) * d)) return d;
      return 16;
    };
    for (let y = 10; y < SIZE - 10; y += 2) {
      for (let x = 10; x < SIZE - 10; x += 2) {
        if (!clearBox(x, y, 4)) continue;
        if (dirOf(x, y, 0) >= 12) return { x: x + 0.5, y: y + 0.5 };
      }
    }
    return { x: SIZE / 2, y: SIZE / 2 };
  });

  // 面前放一只僵尸当参照物；玩家平视
  await page.evaluate((s) => {
    const G = window.PP.G;
    G.player.x = s.x; G.player.y = s.y;
    G.player.a = 0; G.player.pitch = 0; G.player.pitchBase = 0;
    G.enemies.length = 0; G.pickups.length = 0;
    const e = window.PP.Ent.spawn(G, 'zombie', s.x + 4.2, s.y);
    if (e) { e.face = Math.PI; e.a = Math.PI; e.state = 'alive'; }
  }, spot);
  await page.waitForTimeout(1200);

  // 收集去重后的武器类型
  const weapons = await page.evaluate(() => {
    const seen = new Set(); const out = [];
    (window.PP.WEAPONS || []).forEach((w, i) => {
      if (!w || !w.pick || seen.has(w.pick)) return;
      seen.add(w.pick); out.push({ i, pick: w.pick, name: w.name || w.label || w.pick });
    });
    return out;
  });

  const shot = async (suffix) => {
    await page.waitForTimeout(220);
    await page.screenshot({ path: path.join(OUT, `${TAG}-${suffix}.png`) });
  };

  for (const w of weapons) {
    // 切枪（render3d 会按 pick 重建视模）
    await page.evaluate((wi) => { window.PP.G.weapon = wi; }, w.i);
    await shot(`w-${w.pick}`);
    // 开火瞬间：确认枪口火焰是否落在枪管末端
    await page.evaluate(() => { window.PP.G.muzzleT = 0.06; window.PP.G.kickPitch = 0.05; });
    await page.waitForTimeout(60);
    await page.screenshot({ path: path.join(OUT, `${TAG}-w-${w.pick}-fire.png`) });
    await page.evaluate(() => { window.PP.G.muzzleT = 0; window.PP.G.kickPitch = 0; });
    await page.waitForTimeout(120);
  }

  console.log('weapons:', JSON.stringify(weapons.map((w) => w.pick)));
  console.log(errs.length ? 'ERRORS: ' + errs.slice(0, 8).join(' | ') : 'no errors');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
