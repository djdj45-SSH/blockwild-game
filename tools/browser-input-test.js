/* 用 Edge 打开本地游戏，验证键鼠移动/开火链路（含触屏误判回归） */
const { chromium } = require('playwright-core');
const path = require('path');
const { pathToFileURL } = require('url');

const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const INDEX = path.resolve(__dirname, '..', 'index.html');

(async () => {
  const browser = await chromium.launch({ executablePath: EDGE, headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });

  await page.goto(pathToFileURL(INDEX).href);
  await page.waitForTimeout(400);

  const boot = await page.evaluate(() => {
    const PP = window.PP || {};
    return {
      hasGame: !!PP.Game,
      hasSim: !!PP.Sim,
      hasTouch: !!PP.Touch,
      touchEnabled: PP.Touch && PP.Touch.enabled,
      isTouch: PP.Touch && PP.Touch.isTouch(),
      maxTouchPoints: navigator.maxTouchPoints,
      ontouchstart: typeof window.ontouchstart,
      state: PP.G && PP.G.state
    };
  });
  console.log('BOOT', JSON.stringify(boot));

  if (boot.touchEnabled) {
    console.log('FAIL desktop should not enable touch mode');
  } else {
    console.log('PASS touch mode off on desktop');
  }

  await page.click('#btn-solo');
  await page.waitForTimeout(200);

  const afterStart = await page.evaluate(() => {
    const PP = window.PP;
    return {
      state: PP.G && PP.G.state,
      touchEnabled: PP.Touch && PP.Touch.enabled,
      hudVisible: !document.getElementById('hud').classList.contains('hide'),
      titleHidden: document.getElementById('s-title').classList.contains('hide')
    };
  });
  console.log('AFTER_START', JSON.stringify(afterStart));

  // 记录起始位置
  const before = await page.evaluate(() => {
    const p = window.PP.G.player;
    return { x: p.x, y: p.y, a: p.a, shots: p.shots || 0, mag: p.mag && p.mag[p.weapon] };
  });

  // 按住 W 一段时间
  await page.keyboard.down('w');
  await page.waitForTimeout(500);
  await page.keyboard.up('w');
  await page.waitForTimeout(50);

  const afterMove = await page.evaluate(() => {
    const p = window.PP.G.player;
    return { x: p.x, y: p.y, a: p.a };
  });
  const dist = Math.hypot(afterMove.x - before.x, afterMove.y - before.y);
  console.log('MOVE', JSON.stringify({ before, afterMove, dist }));
  if (dist > 0.2) console.log('PASS keyboard movement works, dist=' + dist.toFixed(2));
  else console.log('FAIL keyboard movement stuck, dist=' + dist.toFixed(2));

  // 点击画面开火
  await page.mouse.click(640, 360);
  await page.waitForTimeout(120);
  const afterFire = await page.evaluate(() => {
    const p = window.PP.G.player;
    return {
      shots: p.shots || p.shotsFired || 0,
      mag: p.mag && p.mag[p.weapon],
      firePressed: p.input && p.input.firePressed,
      fire: p.input && p.input.fire
    };
  });
  console.log('FIRE', JSON.stringify(afterFire));
  if ((afterFire.mag != null && afterFire.mag < (before.mag != null ? before.mag : 99)) || (afterFire.shots > (before.shots || 0))) {
    console.log('PASS mouse fire works');
  } else {
    // 再点一次并检查 muzzle / dryfire 事件
    const shotEvents = await page.evaluate(async () => {
      return new Promise((resolve) => {
        let n = 0;
        const off = window.PP.G.bus.on('shot', () => { n++; });
        setTimeout(() => resolve(n), 200);
      });
    });
    // bus.on may not return unsubscribe; just click again
    await page.mouse.click(640, 360);
    await page.waitForTimeout(150);
    const mag2 = await page.evaluate(() => {
      const p = window.PP.G.player;
      return { mag: p.mag && p.mag[p.weapon], shots: p.shots || 0, reloading: p.reloading };
    });
    console.log('FIRE2', JSON.stringify(mag2));
    if (mag2.mag < (before.mag != null ? before.mag : 99) || mag2.shots > 0) console.log('PASS mouse fire works (retry)');
    else console.log('FAIL mouse fire not registering');
  }

  if (errors.length) {
    console.log('PAGE_ERRORS', JSON.stringify(errors.slice(0, 10)));
  } else {
    console.log('PASS no page errors');
  }

  await page.screenshot({ path: path.resolve(__dirname, '..', 'screenshots', 'input_test.png') });
  await browser.close();
  process.exit(0);
})().catch((e) => {
  console.error('TEST_CRASH', e);
  process.exit(1);
});
