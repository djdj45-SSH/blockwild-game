const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

function findChromium() {
  const root = 'C:/Users/35547/AppData/Local/ms-playwright';
  const entries = fs.readdirSync(root).filter((n) => n.startsWith('chromium-'));
  entries.sort();
  for (const e of entries.reverse()) {
    for (const rel of ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe']) {
      const p = path.join(root, e, ...rel.split('/'));
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

(async () => {
  const outDir = path.join(__dirname, '..', 'artifacts');
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: findChromium() });
  const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('PE:' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('CE:' + m.text()); });

  await page.goto('http://127.0.0.1:8080/', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /单人/.test(x.textContent || ''));
    if (b) b.click();
  });
  await page.waitForTimeout(2200);

  // 传送到最近 POI（建筑）
  const poi = await page.evaluate(() => {
    const W = window.PP && window.PP.World;
    const G = window.PP && window.PP.G;
    if (!W || !W.pois || !W.pois.length || !G || !G.player) return null;
    // 找一个 cabin/ruin/bunker/tower
    const prefer = W.pois.filter((p) => p.type !== 'camp');
    const p = prefer[0] || W.pois[0];
    G.player.x = p.x + 2.5;
    G.player.y = p.y + 2.5;
    G.player.a = Math.atan2(p.y - G.player.y, p.x - G.player.x);
    G.player.pitchBase = -0.05;
    G.player.pitch = -0.05;
    return { type: p.type, x: p.x, y: p.y };
  });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(outDir, 'bldg-1.png') });

  // 贴墙看
  await page.evaluate(() => {
    const W = window.PP && window.PP.World;
    const G = window.PP && window.PP.G;
    if (!W || !G) return;
    // 朝建筑中心再靠近
    const p = W.pois && W.pois[0];
    if (!p) return;
    G.player.x = p.x + 0.8;
    G.player.y = p.y + 1.2;
    G.player.a = Math.atan2(p.y - G.player.y + 0.2, p.x - G.player.x + 0.2);
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outDir, 'bldg-2.png') });

  // 侧看墙体
  await page.evaluate(() => {
    const G = window.PP && window.PP.G;
    if (G && G.player) {
      G.player.a += 1.2;
      G.player.pitch = 0.05;
    }
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, 'bldg-3.png') });

  const diag = await page.evaluate(() => ({
    poi: window.__POI__ || null,
    state: window.PP && window.PP.G && window.PP.G.state,
    stats: window.__BW_RENDER__ && window.__BW_RENDER__(),
  }));
  console.log('POI', poi, 'DIAG', JSON.stringify(diag));
  console.log(errors.length ? 'ERRORS ' + errors.slice(0, 8).join(' | ') : 'no errors');

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
