/* perf.cjs — 渲染开销分解（软件光栅下相对值，用于判断优化优先级） */
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  await page.goto('http://127.0.0.1:8080/', { waitUntil: 'load' });
  await wait(900);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /单人/.test(x.textContent || '')); if (b) b.click(); });
  await wait(1600);
  await page.evaluate(() => { window.PP.Render.quality = 0.5; window.PP.Render.resize(); });
  await wait(400);

  async function measure(label, setup) {
    await page.evaluate(setup);
    await wait(500);
    const r = await page.evaluate(() => new Promise((res) => {
      const t = []; let last = performance.now(); let n = 0;
      const loop = (now) => {
        t.push(now - last); last = now;
        if (++n < 40) requestAnimationFrame(loop);
        else { t.sort((a, b) => a - b); res({ median: +t[(t.length / 2) | 0].toFixed(1), p95: +t[(t.length * 0.95) | 0].toFixed(1) }); }
      };
      requestAnimationFrame(loop);
    }));
    const st = await page.evaluate(() => window.__BW_RENDER__());
    console.log(`${label.padEnd(30)} median ${String(r.median).padStart(7)} ms   p95 ${String(r.p95).padStart(7)} ms   calls ${st.calls}  tris ${st.triangles}`);
    return r.median;
  }

  // 定位到开阔地 + 固定朝天空/地面，减少变异
  await page.evaluate(() => {
    const W = window.PP.World, G = window.PP.G, S = W.SIZE;
    G.player.x = S / 2; G.player.y = S / 2; G.player.a = 0; G.player.pitch = 0;
    window.PP.Render.quality = 0.5; window.PP.Render.resize();
    setInterval(() => { G.player.hp = 100; G.state = 'playing'; }, 100);
  });
  await wait(400);

  const base = await measure('基线 q0.5 (480x270)', () => { });

  await measure('阴影关闭', () => {
    const R = window.PP.Render._renderer();
    R.shadowMap.enabled = false;
  });
  await measure('q1.0 (960x540)', () => {
    window.PP.Render._renderer().shadowMap.enabled = true;
    window.PP.Render.quality = 1.0; window.PP.Render.resize();
  });

  console.log('baseline median = ' + base + ' ms');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
