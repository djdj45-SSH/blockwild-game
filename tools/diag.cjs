/* diag.cjs — 真实浏览器诊断：启动单人局，测 FPS / draw call / 报错，出截图
   用法: node tools/diag.cjs [tag] */
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

const TAG = process.argv[2] || 'diag';
const OUT = path.join(__dirname, '..', 'artifacts');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: findChromium(),
    args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox']
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('PE: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('CE: ' + m.text()); });

  await page.goto('http://127.0.0.1:8080/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(1200);

  const btn = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /单人/.test(x.textContent || ''));
    if (b) { b.click(); return b.textContent.trim(); }
    return null;
  });
  await page.waitForTimeout(2500);

  // FPS 采样
  const fps = await page.evaluate(() => new Promise((res) => {
    const t = []; let last = performance.now(); let n = 0;
    function loop(now) {
      t.push(now - last); last = now; n++;
      if (n < 150) requestAnimationFrame(loop);
      else {
        t.sort((a, b) => a - b);
        res({
          n,
          median: +t[(t.length / 2) | 0].toFixed(2),
          p95: +t[(t.length * 0.95) | 0].toFixed(2),
          max: +t[t.length - 1].toFixed(2),
          avg: +(t.reduce((a, b) => a + b, 0) / t.length).toFixed(2)
        });
      }
    }
    requestAnimationFrame(loop);
  }));

  const diag = await page.evaluate(() => {
    const G = window.PP && window.PP.G;
    const st = window.__BW_RENDER__ && window.__BW_RENDER__();
    return {
      state: G && G.state,
      tick: G && G.tick,
      enemies: G && G.enemies ? G.enemies.length : -1,
      hp: G && G.player ? Math.round(G.player.hp) : -1,
      stats: st,
      hasCanvasSize: (() => { const c = document.getElementById('view'); return c ? c.width + 'x' + c.height : 'none'; })()
    };
  });

  await page.screenshot({ path: path.join(OUT, `${TAG}-play.png`) });

  // 跑 20 秒模拟后看是否稳定
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(OUT, `${TAG}-play2.png`) });
  const diag2 = await page.evaluate(() => {
    const G = window.PP && window.PP.G;
    return { tick: G && G.tick, enemies: G && G.enemies ? G.enemies.length : -1, stats: window.__BW_RENDER__() };
  });

  console.log('BTN:', btn);
  console.log('FPS(ms/frame):', JSON.stringify(fps), '→', (1000 / fps.median).toFixed(1), 'fps median');
  console.log('DIAG1:', JSON.stringify(diag));
  console.log('DIAG2:', JSON.stringify(diag2));
  console.log(errs.length ? 'ERRORS(' + errs.length + '): ' + errs.slice(0, 10).join(' | ') : 'no errors');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
