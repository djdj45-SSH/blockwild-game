/* probe.cjs — 场景内省：网格/材质/贴图/UV 实况 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
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
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('PE:' + e.message));
  await page.goto('http://127.0.0.1:8080/', { waitUntil: 'load' });
  await page.waitForTimeout(1000);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /单人/.test(x.textContent || '')); if (b) b.click(); });
  await page.waitForTimeout(1500);
  const info = await page.evaluate(() => {
    const PP = window.PP;
    const R = PP.Render;
    const scene = R && R._scene ? R._scene() : null;
    const out = { haveScene: !!scene, meshes: [] };
    if (!scene) return out;
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const m = o.material;
      const g = o.geometry;
      out.meshes.push({
        name: o.name || '(anon)',
        parent: o.parent && o.parent.name,
        verts: g.attributes.position ? g.attributes.position.count : 0,
        hasUV: !!g.attributes.uv,
        uvCount: g.attributes.uv ? g.attributes.uv.count : 0,
        hasColor: !!g.attributes.color,
        mat: m && m.type,
        mapKind: m && m.map ? (m.map.image && m.map.image.width) : null,
        mapAniso: m && m.map ? m.map.anisotropy : null,
        mapMin: m && m.map ? m.map.minFilter : null,
        mapMag: m && m.map ? m.map.magFilter : null,
        mapRepeat: m && m.map ? [m.map.repeat.x, m.map.repeat.y] : null,
        color: m && m.color ? m.color.getHexString() : null,
        visible: o.visible,
        castShadow: o.castShadow
      });
    });
    return out;
  });
  console.log(JSON.stringify(info, null, 1).slice(0, 6000));
  console.log(errs.length ? 'ERRORS ' + errs.join('|') : 'no errors');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
