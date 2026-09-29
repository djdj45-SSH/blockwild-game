/* ui-check.cjs — 逐个界面截图：标题/暂停/选卡/设置/商店/结算 */
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
const OUT = path.join(__dirname, '..', 'artifacts', 'ui');
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('PE:' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('CE:' + m.text()); });

  await page.goto('http://127.0.0.1:8080/', { waitUntil: 'load' });
  await wait(1600);
  await page.screenshot({ path: path.join(OUT, '01-title.png') });

  // 进入单人
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /单人/.test(x.textContent || '')); if (b) b.click(); });
  await wait(2000);
  await page.screenshot({ path: path.join(OUT, '02-play.png') });

  // 暂停
  await page.evaluate(() => window.PP.Game && document.getElementById('view'));
  await page.evaluate(() => {
    const G = window.PP.G; G.state = 'paused';
    window.PP.Hud.show(window.PP.Hud._sPause, true);
  });
  await wait(500);
  await page.screenshot({ path: path.join(OUT, '03-pause.png') });

  // 设置（从暂停面板进）
  await page.evaluate(() => { const b = document.getElementById('btn-set-pause'); if (b) b.click(); });
  await wait(500);
  await page.screenshot({ path: path.join(OUT, '04-settings.png') });
  await page.evaluate(() => { if (window.PP.Settings) window.PP.Settings.close(); });
  await wait(300);

  // 选卡
  await page.evaluate(() => {
    const G = window.PP.G; G.state = 'playing';
    window.PP.Hud.show(window.PP.Hud._sPause, false);
    window.PP.Sim.rollPerkChoices(G, G.me);
  });
  await wait(600);
  await page.screenshot({ path: path.join(OUT, '05-perk.png') });
  const perkCards = await page.evaluate(() => document.querySelectorAll('#perk-cards > *').length);
  await page.evaluate(() => { if (window.PP.Hud.perksOpen()) window.PP.Hud.pickPerk(1); });
  await wait(400);
  await page.screenshot({ path: path.join(OUT, '06-after-perk.png') });

  // 商店
  await page.evaluate(() => window.PP.Hud.openShop());
  await wait(500);
  await page.screenshot({ path: path.join(OUT, '07-shop.png') });
  await page.evaluate(() => window.PP.Hud.closeShop());
  await wait(300);

  // 结算
  await page.evaluate(() => {
    const G = window.PP.G; G.state = 'playing';
    G.player.hp = 0; G.player.eliminated = true;
    if (window.PP.Hud && window.PP.Hud.gameOver) window.PP.Hud.gameOver(G);
  });
  await wait(700);
  await page.screenshot({ path: path.join(OUT, '08-over.png') });

  // 回主页
  await page.evaluate(() => { const b = document.getElementById('btn-to-title'); if (b) b.click(); });
  await wait(700);
  await page.screenshot({ path: path.join(OUT, '09-back-title.png') });

  // 移动端竖屏提示
  const p2 = await browser.newPage({ viewport: { width: 420, height: 800 }, hasTouch: true, isMobile: true });
  await p2.goto('http://127.0.0.1:8080/', { waitUntil: 'load' });
  await wait(1800);
  await p2.screenshot({ path: path.join(OUT, '10-mobile-portrait.png') });
  await p2.setViewportSize({ width: 860, height: 420 });
  await wait(1200);
  await p2.screenshot({ path: path.join(OUT, '11-mobile-landscape.png') });

  console.log('perkCards', perkCards);
  console.log(errs.length ? 'ERRORS: ' + errs.slice(0, 10).join(' | ') : 'no errors');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
