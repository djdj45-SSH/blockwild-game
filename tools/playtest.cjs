/* playtest.cjs — 端到端可玩性验证
   阶段一：输入链路（真键鼠）——WASD 真的会动、鼠标真的会转视角（小位移）
   阶段二：战斗链路——瞄准最近的怪持续开火，验证能命中/击杀/升级/拾取
   阶段三：稳定性——长时间运行不报错、draw call 与几何体不无限增长 */
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
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const ok = (c, m) => { if (!c) fails.push(m); console.log((c ? '  PASS  ' : '  FAIL  ') + m); };

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: findChromium(), args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('PE:' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('CE:' + m.text()); });

  await page.goto('http://127.0.0.1:8080/', { waitUntil: 'load' });
  await wait(900);
  await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /单人/.test(x.textContent || '')); if (b) b.click(); });
  await wait(1500);

  await page.evaluate(() => {
    window.__ev = { kills: 0, picks: 0, perks: 0, shots: 0, hits: 0, reloads: 0, dmg: 0 };
    const bus = window.PP.G.bus;
    bus.on('kill', () => window.__ev.kills++);
    bus.on('pickup', () => window.__ev.picks++);
    bus.on('chest', () => window.__ev.picks++);
    bus.on('perkChoices', () => window.__ev.perks++);
    bus.on('shot', () => window.__ev.shots++);
    bus.on('hit', (e) => { window.__ev.hits++; });
    bus.on('reload', () => window.__ev.reloads++);
    window.PP.Render.quality = 0.5; window.PP.Render.resize();
    // 记录每帧耗时（真实渲染负载下）
    window.__ft = []; let last = performance.now();
    const rec = (n) => { const d = n - last; last = n; if (window.__ft.length < 4000) window.__ft.push(d); requestAnimationFrame(rec); };
    requestAnimationFrame(rec);
  });

  const canvas = await page.$('#view');
  const box = await canvas.boundingBox();
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  await page.mouse.click(cx, cy);
  await wait(400);

  console.log('[阶段一] 输入链路');
  // 1) W 前进
  const before = await page.evaluate(() => ({ x: window.PP.G.player.x, y: window.PP.G.player.y }));
  await page.keyboard.down('KeyW'); await wait(900); await page.keyboard.up('KeyW');
  const after = await page.evaluate(() => ({ x: window.PP.G.player.x, y: window.PP.G.player.y }));
  const moved = Math.hypot(after.x - before.x, after.y - before.y);
  ok(moved > 1.2, `W 前进有效（位移 ${moved.toFixed(2)} 格）`);

  // 2) 鼠标转视角：必须"持续位移"才会产生 movementX（原地 move 同一点不会触发事件），
  //    且单次位移不能超过 180px（那是被刻意丢弃的尖峰）
  const a0 = await page.evaluate(() => window.PP.G.player.a);
  for (let i = 1; i <= 5; i++) await page.mouse.move(cx + i * 30, cy);
  const a1 = await page.evaluate(() => window.PP.G.player.a);
  ok(Math.abs(a1 - a0) > 0.2, `鼠标转视角有效（Δa=${(a1 - a0).toFixed(3)}，期望 ≈0.33）`);

  // 3) 俯仰
  const p0 = await page.evaluate(() => window.PP.G.player.pitchBase);
  for (let i = 1; i <= 5; i++) await page.mouse.move(cx + 150, cy + i * 20);
  const p1 = await page.evaluate(() => window.PP.G.player.pitchBase);
  ok(Math.abs(p1 - p0) > 0.05, `鼠标俯仰有效（Δpitch=${(p1 - p0).toFixed(3)}）`);
  await page.mouse.move(cx, cy);

  console.log('[阶段二] 战斗链路（90 秒）');
  // 无敌 + 瞄准最近的怪开火
  await page.evaluate(() => {
    window.__god = setInterval(() => {
      const G = window.PP.G;
      if (G && G.player) { G.player.hp = G.player.maxHp || 100; G.player.eliminated = false; G.player.downed = false; }
    }, 120);
  });

  const t0 = Date.now();
  let lastLog = 0;
  while (Date.now() - t0 < 90000) {
    const act = await page.evaluate(() => {
      const G = window.PP.G;
      const p = G.player;
      // 瞄准最近的活怪
      let best = null, bd = 1e9;
      for (const e of (G.enemies || [])) {
        if (e.state !== 'alive') continue;
        const d = (e.x - p.x) ** 2 + (e.y - p.y) ** 2;
        if (d < bd) { bd = d; best = e; }
      }
      if (best) {
        p.a = Math.atan2(best.y - p.y, best.x - p.x);
        p.pitchBase = 0; p.pitch = 0;
      }
      const perks = window.PP.Hud.perksOpen();
      if (perks) window.PP.Hud.pickPerk(0);
      const noAmmo = p.mag && p.mag[p.weapon] <= 0;
      if (noAmmo) return 'reload';
      return best ? 'fire' : 'seek';
    });

    if (act === 'reload') { await page.keyboard.press('KeyR'); await wait(1400); continue; }
    if (act === 'seek') {
      // 没怪了：跑起来找
      await page.keyboard.down('KeyW'); await wait(700); await page.keyboard.up('KeyW');
      continue;
    }
    await page.mouse.down(); await wait(500); await page.mouse.up();
    await wait(120);
    if (Date.now() - lastLog > 20000) {
      lastLog = Date.now();
      const st = await page.evaluate(() => {
        const p = window.PP.G.player;
        return { k: p.kills, lv: p.level, hp: Math.round(p.hp), s: window.PP.G.state };
      });
      console.log('   ... 20s 节点', JSON.stringify(st));
    }
  }
  // 命中诊断：直接对着最近的怪打一发 hitscan，看射线到底卡在哪一层
  const diag = await page.evaluate(() => {
    const G = window.PP.G, p = G.player;
    let best = null, bd = 1e9;
    for (const e of (G.enemies || [])) {
      if (e.state !== 'alive') continue;
      const d = (e.x - p.x) ** 2 + (e.y - p.y) ** 2;
      if (d < bd) { bd = d; best = e; }
    }
    if (!best) return { none: true };
    const dist = Math.sqrt(bd);
    const a = Math.atan2(best.y - p.y, best.x - p.x);
    const hits = window.PP.Ent.hitscan(G, p, a, 0, 0, 40, 1);
    const wallD = window.PP.World.rayWall(p.x, p.y, Math.cos(a), Math.sin(a), 40);
    return {
      dist: +dist.toFixed(2), eH: best.height, z0: best.z0,
      wallD: +wallD.toFixed(2), hits: hits.length,
      z: hits.length ? +hits[0].z.toFixed(3) : null,
      head: hits.length ? hits[0].head : null,
      downed: !!p.downed, pitch: p.pitch
    };
  });
  console.log('   [命中诊断]', JSON.stringify(diag));

  const ev = await page.evaluate(() => {
    const ft = window.__ft.slice(50).sort((a, b) => a - b);
    return {
      ev: window.__ev,
      player: { kills: window.PP.G.player.kills, level: window.PP.G.player.level, score: window.PP.G.score },
      frame: {
        n: ft.length,
        median: +ft[(ft.length / 2) | 0].toFixed(1),
        p95: +ft[(ft.length * 0.95) | 0].toFixed(1)
      },
      stats: window.__BW_RENDER__(),
      enemies: (window.PP.G.enemies || []).length,
      particles: (window.PP.G.particles || []).length
    };
  });
  console.log('  ' + JSON.stringify(ev));

  ok(ev.ev.shots > 40, `开火事件正常（${ev.ev.shots} 发）`);
  ok(ev.ev.hits > 10, `命中事件正常（${ev.ev.hits} 次命中）`);
  ok(ev.player.kills > 3, `能击杀敌人（${ev.player.kills} 杀）`);
  ok(ev.player.level >= 2 || ev.ev.perks > 0, `能升级并触发选卡（Lv.${ev.player.level}, 选卡请求 ${ev.ev.perks}）`);
  ok(ev.stats.calls < 300, `draw call 受控（${ev.stats.calls}）`);
  ok(ev.stats.geometries < 900, `几何体数量受控（${ev.stats.geometries}）`);
  ok(errs.length === 0, `运行期无报错（${errs.length}）`);

  await page.screenshot({ path: path.join(OUT, 'playtest-end.png') });
  console.log(fails.length ? '\n结果: ' + fails.length + ' 项失败\n' + fails.join('\n') : '\n结果: 全部通过');
  if (errs.length) console.log('ERRORS: ' + errs.slice(0, 6).join(' | '));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
