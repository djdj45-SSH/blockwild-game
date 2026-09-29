const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path');
function findChromium() {
  const root = 'C:/Users/35547/AppData/Local/ms-playwright';
  const es = fs.readdirSync(root).filter((n) => n.startsWith('chromium-')).sort();
  for (const e of es.reverse()) for (const rel of ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe']) {
    const p = path.join(root, e, ...rel.split('/')); if (fs.existsSync(p)) return p;
  }
  return null;
}
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  for (const url of ['http://127.0.0.1:8099/', 'http://127.0.0.1:8099/dist/']) {
    const page = await browser.newPage({ viewport: { width: 900, height: 540 } });
    const errs = [];
    page.on('pageerror', (e) => errs.push('PE:' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errs.push('CE:' + m.text().slice(0, 160)); });
    await page.goto(url, { waitUntil: 'load', timeout: 40000 });
    await page.waitForTimeout(4000);
    const st = await page.evaluate(() => ({
      hasPP: !!(window.PP && window.PP.Game),
      hasRender: !!(window.PP && window.PP.Render && window.PP.Render.getStats),
      bootFail: (() => { const e = document.getElementById('boot-fail'); return e ? getComputedStyle(e).display : 'none-el'; })(),
      canv: (() => { const c = document.getElementById('view'); return c ? c.width + 'x' + c.height : '?'; })(),
      wave: (() => { const h = document.querySelector('#s-title h1'); return h ? h.firstChild.textContent.trim() : '?'; })()
    }));
    console.log(url, JSON.stringify(st));
    if (errs.length) console.log('   ERR:', errs.slice(0, 4).join(' | '));
    await page.close();
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
