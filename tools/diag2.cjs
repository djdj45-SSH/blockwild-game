/* diag2.cjs — 局内取景诊断：无敌 + 定点传送 + 多角度截图
   用法: node tools/diag2.cjs [tag] */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

function findChromium() {
  const root = 'C:/Users/35547/AppData/Local/ms-playwright';
  if (!fs.existsSync(root)) return null;
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

const TAG = process.argv[2] || 'shot';
const OUT = path.join(__dirname, '..', 'artifacts');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({
    headless: true, executablePath: findChromium(),
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader']
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('PE: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('CE: ' + m.text()); });

  await page.goto('http://127.0.0.1:8080/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /单人/.test(x.textContent || ''));
    if (b) b.click();
  });
  await page.waitForTimeout(1500);

  // 无敌 + 冻结敌人伤害
  await page.evaluate(() => {
    const G = window.PP.G;
    G.__god = true;
    setInterval(() => {
      const g = window.PP.G;
      if (g && g.player) { g.player.hp = g.player.maxHp || 100; g.player.downed = false; g.player.eliminated = false; g.state = 'playing'; }
    }, 200);
  });

  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, `${TAG}-00-start.png`) });

  const spots = [
    { name: '01-open', desc: '开阔地' },
    { name: '02-poi', desc: '建筑 POI' },
    { name: '03-water', desc: '水面' }
  ];

  // 开阔地：找一大片没有墙的地方
  const info = await page.evaluate(() => {
    const W = window.PP.World, G = window.PP.G;
    const out = { pois: [], water: null };
    if (W && W.pois) out.pois = W.pois.slice(0, 6).map((p) => ({ type: p.type, x: p.x, y: p.y }));
    return out;
  });

  if (info.pois.length) {
    const p = info.pois.find((q) => q.type !== 'camp') || info.pois[0];
    await page.evaluate((q) => {
      const G = window.PP.G;
      G.player.x = q.x + 6; G.player.y = q.y + 6;
      G.player.a = Math.atan2(q.y - (q.y + 6), q.x - (q.x + 6));
      G.player.pitch = -0.05;
    }, p);
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT, `${TAG}-02-poi.png`) });
  }

  // 找实体多的位置
  await page.evaluate(() => {
    const G = window.PP.G;
    const es = (G.enemies || []).filter((e) => e.state === 'alive');
    if (es.length) {
      const e = es[0];
      G.player.x = e.x + 9; G.player.y = e.y + 9;
      G.player.a = Math.atan2(e.y - (e.y + 9), e.x - (e.x + 9));
      G.player.pitch = 0;
    }
  });
  await page.waitForTimeout(900);
  await page.screenshot({ path: path.join(OUT, `${TAG}-03-enemy.png`) });

  // 抬头看天
  await page.evaluate(() => { window.PP.G.player.pitch = 1.25; });
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, `${TAG}-04-sky.png`) });

  const st = await page.evaluate(() => ({
    stats: window.__BW_RENDER__(),
    hp: Math.round(window.PP.G.player.hp),
    state: window.PP.G.state,
    pois: (window.PP.World.pois || []).map((p) => p.type)
  }));
  console.log('STATS', JSON.stringify(st));
  console.log(errs.length ? 'ERRORS: ' + errs.slice(0, 10).join(' | ') : 'no errors');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
