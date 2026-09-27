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
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(outDir, 'ui-title.png') });

  await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /单人/.test(x.textContent || ''));
    if (b) b.click();
  });
  await page.waitForTimeout(2200);

  // 转视角看场景
  await page.evaluate(() => {
    const G = window.PP && window.PP.G;
    if (G && G.player) {
      G.player.a = 0.7;
      G.player.pitchBase = -0.2;
      G.player.pitch = -0.2;
    }
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(outDir, 'ui-play.png') });

  // 抬头看天空
  await page.evaluate(() => {
    const G = window.PP && window.PP.G;
    if (G && G.player) {
      G.player.a = 1.2;
      G.player.pitchBase = 0.55;
      G.player.pitch = 0.55;
    }
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(outDir, 'ui-lookup.png') });

  const diag = await page.evaluate(() => ({
    state: window.PP && window.PP.G && window.PP.G.state,
    stats: window.__BW_RENDER__ && window.__BW_RENDER__(),
  }));
  console.log('DIAG', JSON.stringify(diag));
  console.log(errors.length ? 'ERRORS ' + errors.slice(0, 8).join(' | ') : 'no errors');

  const perf = await page.evaluate(async () => {
    const t0 = performance.now();
    let n = 0;
    await new Promise((r) => {
      function tick() { if (++n >= 30) r(); else requestAnimationFrame(tick); }
      requestAnimationFrame(tick);
    });
    return { fps: (n / ((performance.now() - t0) / 1000)).toFixed(1) };
  });
  console.log('PERF', perf);

  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
