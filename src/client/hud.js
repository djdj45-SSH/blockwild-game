/* ============================================================
   hud.js — HUD / 队友面板 / 武器词条 / Perk 三选一 / 结算
   ============================================================ */
(function () {
  const ROOT = (typeof window !== 'undefined') ? window : globalThis;
  const PP = (ROOT.PP = ROOT.PP || {});
  const Hud = (PP.Hud = {});

  let D = null, last = {}, mateEls = new Map();

  Hud.init = function () {
    const g = (id) => document.getElementById(id);
    D = {
      hud: g('hud'),
      hpBar: g('hp-bar'), hpNum: g('hp-num'),
      apBar: g('ap-bar'), apNum: g('ap-num'),
      xpBar: g('xp-bar'), level: g('level'),
      score: g('score'), threat: g('threat'), kills: g('kills'), combo: g('combo'),
      wp: [g('wp0'), g('wp1'), g('wp2')], wres: [g('w0'), g('w1'), g('w2')],
      ammo: g('ammo'), reserve: g('reserve'), reload: g('reload'),
      wname: g('wname'), waffix: g('waffix'),
      mates: g('mates'), net: g('net'),
      hitmark: g('hitmark'), popup: g('popup'), banner: g('banner'), toast: g('toast'),
      blood: g('blood'),
      revive: g('revive'), reviveBar: g('revive-bar'), reviveText: g('revive-text'),
      perk: g('perk'), perkCards: g('perk-cards'),
      sTitle: g('s-title'), sPause: g('s-pause'), sOver: g('s-over'),
      oScore: g('o-score'), oThreat: g('o-threat'), oKills: g('o-kills'),
      oHead: g('o-head'), oAcc: g('o-acc'), oCombo: g('o-combo'), oTime: g('o-time')
    };
  };

  Hud.show = function (el, on) { if (el) el.classList.toggle('hide', !on); };
  Hud.reset = function () { last = {}; if (D && D.mates) D.mates.innerHTML = ''; mateEls.clear(); };

  /* ---------------- 每帧 ---------------- */
  Hud.update = function (G, extra) {
    if (!D || !D.hpBar) return;
    const p = G.player;
    if (!p) return;
    const hp = Math.max(0, Math.round(p.hp));
    if (last.hp !== hp) {
      last.hp = hp;
      D.hpNum.textContent = hp;
      D.hpBar.style.width = (hp / (p.maxHp || 100) * 100) + '%';
      D.hpBar.classList.toggle('warn', hp < 35);
    }
    const ap = Math.round(p.ap || 0);
    if (last.ap !== ap) { last.ap = ap; D.apNum.textContent = ap; D.apBar.style.width = (ap / (p.maxAp || 100) * 100) + '%'; }
    if (last.score !== G.score) { last.score = G.score; D.score.textContent = G.score; }
    if (last.threat !== G.threat) { last.threat = G.threat; D.threat.textContent = G.threat; }
    if (last.kills !== G.kills) { last.kills = G.kills; D.kills.textContent = G.kills; }

    const lv = p.level || 1;
    if (last.level !== lv) { last.level = lv; D.level.textContent = 'Lv.' + lv; }
    const xpPct = Math.max(0, Math.min(100, (p.xp || 0) / (p.xpNext || 100) * 100));
    if (Math.abs((last.xp || 0) - xpPct) > 1) { last.xp = xpPct; D.xpBar.style.width = xpPct + '%'; }

    const cm = p.comboMult ? p.comboMult() : 1;
    if (last.combo !== p.combo) {
      last.combo = p.combo;
      if ((p.combo || 0) >= 2) { Hud.show(D.combo, true); D.combo.textContent = 'x' + cm.toFixed(1); }
      else Hud.show(D.combo, false);
    }

    if (last.weapon !== p.weapon) {
      last.weapon = p.weapon;
      for (let i = 0; i < 3; i++) {
        D.wp[i].classList.toggle('active', i === p.weapon);
        D.wp[i].classList.toggle('locked', !p.unlocked[i]);
      }
    }
    if (last.ammo !== p.mag[p.weapon] + ':' + p.weapon) {
      last.ammo = p.mag[p.weapon] + ':' + p.weapon;
      D.ammo.textContent = p.mag[p.weapon];
    }
    const res = p.reserve[p.weapon] === Infinity ? '∞' : String(p.reserve[p.weapon]);
    if (last.res !== res) { last.res = res; D.reserve.textContent = res; }
    for (let i = 0; i < 3; i++) {
      const txt = !p.unlocked[i] ? '--' : (p.reserve[i] === Infinity ? '∞' : String(p.reserve[i]));
      if (D.wres[i].textContent !== txt) D.wres[i].textContent = txt;
    }
    D.reload.classList.toggle('hide', !(G.muzzleT >= 0 && (p.reloadT || 0) > 0));
    D.blood.style.opacity = ((G.hurtFlash || 0) * 0.8).toFixed(2);

    // 武器名 + 词条
    const inst = (p.insts && p.insts[p.weapon]) || null;
    if (inst) {
      const nm = PP.Rogue.weaponName(inst);
      if (last.wname !== nm + p.weapon) {
        last.wname = nm + p.weapon;
        D.wname.textContent = nm;
        D.wname.style.color = PP.Rogue.RARITY[inst.rarity].color;
        D.waffix.innerHTML = '';
        for (const af of inst.affixes) {
          const d = document.createElement('div');
          d.className = 'affix';
          d.textContent = '· ' + PP.Rogue.affixText(af);
          D.waffix.appendChild(d);
        }
      }
    }
    if (extra && extra.mates) Hud.updateMates(extra.mates, G);
    else Hud.updateMates(G.mates || [], G);

    // 救援提示 / 阵亡观战提示
    if (extra && extra.eliminated) {
      Hud.show(D.revive, true);
      D.reviveBar.style.width = '0%';
      D.reviveText.textContent = '你已阵亡 · 观战中（队友仍在战斗）';
    } else if (extra && extra.revive) {
      Hud.show(D.revive, true);
      D.reviveBar.style.width = Math.min(100, (extra.revive.prog || 0) * 100).toFixed(0) + '%';
      D.reviveText.textContent = extra.revive.self
        ? '你已倒地 · 等待队友救援'
        : '按住 F 救援 ' + (extra.revive.name || '队友');
    } else Hud.show(D.revive, false);
  };

  /* ---------------- 队友面板 ---------------- */
  Hud.updateMates = function (list, G) {
    if (!D.mates) return;
    const seen = new Set();
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (m.eliminated) continue;
      seen.add(m.id);
      let el = mateEls.get(m.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'mate';
        el.innerHTML = '<b></b><span></span><i></i><div class="mbar"><div class="mfill"></div></div>';
        D.mates.appendChild(el);
        mateEls.set(m.id, el);
        el.querySelector('b').style.background = ['#3e6cc8', '#ce4a3e', '#54a84c', '#9e5cc8'][(m.colorIdx || 0) % 4];
      }
      el.querySelector('span').textContent = m.name || ('P' + m.id);
      el.querySelector('i').textContent = m.downed ? '倒地' : (m.hp | 0);
      el.classList.toggle('downed', !!m.downed);
      el.querySelector('.mfill').style.width = Math.max(0, Math.min(100, (m.hp || 0) / 100 * 100)) + '%';
    }
    for (const [id, el] of mateEls) {
      if (!seen.has(id)) { el.remove(); mateEls.delete(id); }
    }
  };

  /* ---------------- Perk 三选一 ---------------- */
  let perksOpenFlag = false;
  Hud.showPerks = function (list, cb) {
    if (!D || !D.perk) return;
    perksOpenFlag = true;
    Hud._perkList = list; Hud._perkCb = cb;   // 调试 / 自动化测试入口
    D.perkCards.innerHTML = '';
    for (let i = 0; i < list.length; i++) {
      const k = list[i];
      const d = document.createElement('div');
      d.className = 'perkcard';
      const num = document.createElement('em');
      num.className = 'pnum'; num.textContent = String(i + 1);
      const h = document.createElement('h4'); h.textContent = k.name;
      const p = document.createElement('p'); p.textContent = k.desc;
      d.appendChild(num); d.appendChild(h); d.appendChild(p);
      d.addEventListener('click', () => Hud.pickPerk(i));
      D.perkCards.appendChild(d);
    }
    Hud.show(D.perk, true);
  };
  // 键盘（1/2/3）或点击卡片统一走这里
  Hud.pickPerk = function (i) {
    if (!perksOpenFlag) return false;
    const list = Hud._perkList || [];
    if (i < 0 || i >= list.length) return false;
    const pid = list[i].id, cb = Hud._perkCb;
    Hud.hidePerks();
    if (cb) cb(pid);
    return true;
  };
  Hud.hidePerks = function () { perksOpenFlag = false; Hud.show(D.perk, false); };
  Hud.perksOpen = function () { return perksOpenFlag; };

  /* ---------------- 小组件 ---------------- */
  Hud.hitmarker = function (head) {
    if (!D) return;
    D.hitmark.classList.remove('on');
    D.hitmark.classList.toggle('head', !!head);
    void D.hitmark.offsetWidth;
    D.hitmark.classList.add('on');
  };
  Hud.popup = function (text, cls, dx, dy) {
    if (!D) return;
    const d = document.createElement('div');
    d.className = 'pop ' + (cls || '');
    d.textContent = text;
    d.style.left = dx + 'px';
    d.style.top = dy + 'px';
    D.popup.appendChild(d);
    setTimeout(() => { if (d.parentNode) d.parentNode.removeChild(d); }, 900);
  };
  let toastTimer = 0;
  Hud.toast = function (text) {
    if (!D) return;
    D.toast.textContent = text;
    D.toast.classList.remove('show');
    void D.toast.offsetWidth;
    D.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => D.toast.classList.remove('show'), 1600);
  };
  Hud.banner = function (text) {
    if (!D) return;
    D.banner.textContent = text;
    D.banner.classList.remove('show');
    void D.banner.offsetWidth;
    D.banner.classList.add('show');
  };
  Hud.netStatus = function (text, cls) {
    if (!D || !D.net) return;
    D.net.textContent = text;
    D.net.className = 'net ' + (cls || '');
  };

  Hud.gameOver = function (G) {
    if (!D) return;
    const p = G.player || {};
    D.oScore.textContent = G.score || 0;
    D.oThreat.textContent = G.threat || 1;
    D.oKills.textContent = p.kills || G.kills || 0;
    D.oHead.textContent = p.headshots || G.headshots || 0;
    D.oAcc.textContent = (G.shotsFired ? Math.round(G.shotsHit / G.shotsFired * 100) : 0) + '%';
    D.oCombo.textContent = p.bestCombo || 0;
    const t = G.elapsed || 0;
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    D.oTime.textContent = m + ':' + (s < 10 ? '0' : '') + s;
    Hud.show(D.sOver, true);
    Hud.show(D.hud, false);
  };
})();
