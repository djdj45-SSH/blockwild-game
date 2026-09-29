/* probe2.cjs — 逐层隔离：判定"灰蓝色地面"到底是什么 */
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
const OUT = path.join(__dirname, '..', 'artifacts');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 800, height: 480 } });
  await page.goto('http://127.0.0.1:8080/', { waitUntil: 'load' });
  await page.waitForTimeout(900);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /单人/.test(x.textContent || '')); if (b) b.click(); });
  await page.waitForTimeout(1400);

  // 冻结：暂停模拟，只留渲染
  await page.evaluate(() => {
    const G = window.PP.G; G.state = 'paused';
    window.PP.Render.frame(G);
  });

  // A: 抬头 45 度看地平线以下
  await page.evaluate(() => { const G = window.PP.G; G.player.pitch = 0.45; G.player.pitchBase = 0.45; window.PP.Render.frame(G); });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, 'probe-A-down.png') });

  // B: 隐藏天空球
  const sky = await page.evaluate(() => {
    const s = window.PP.Render._scene();
    let n = 0;
    s.traverse((o) => { if (o.isMesh && o.material && o.material.isShaderMaterial && o.geometry.type === 'SphereGeometry') { o.visible = false; n++; } });
    window.PP.Render.frame(window.PP.G);
    return n;
  });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, 'probe-B-nosky.png') });

  // C: 把 world group 里第一个 mesh（草地）材质换成无光照洋红
  const tint = await page.evaluate(() => {
    const w = window.PP.Render._worldGroup();
    const T = window.PP.Render;
    let done = 0;
    w.children.forEach((c) => {
      if (c.isMesh && c.material && c.material.map && c.material.map.image && c.material.map.image.width === 256 && c.geometry.attributes.position.count > 100000) {
        c.material.emissive && c.material.emissive.setHex(0xff00ff);
        done++;
      }
    });
    window.PP.Render.frame(window.PP.G);
    return done;
  });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, 'probe-C-tint.png') });

  // D: 天空球单独看（世界隐藏）
  const off = await page.evaluate(() => {
    const s = window.PP.Render._scene();
    const w = window.PP.Render._worldGroup();
    w.visible = false;
    window.PP.Render.frame(window.PP.G);
    return true;
  });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, 'probe-D-worldoff.png') });

  console.log(JSON.stringify({ sky, tint, off }));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
