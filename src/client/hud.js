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
      wp: [g('wp0'), g('wp1'), g('wp2'), g('wp3'), g('wp4')],
      wres: [g('w0'), g('w1'), g('w2'), g('w3'), g('w4')],
      ammo: g('ammo'), reserve: g('reserve'), reload: g('reload'),
      wname: g('wname'), waffix: g('waffix'),
      mates: g('mates'), net: g('net'),
      hitmark: g('hitmark'), popup: g('popup'), banner: g('banner'), toast: g('toast'),
      blood: g('blood'),
      revive: g('revive'), reviveBar: g('revive-bar'), reviveText: g('revive-text'),
      perk: g('perk'), perkCards: g('perk-cards'),
      sTitle: g('s-title'), sPause: g('s-pause'), sOver: g('s-over'),
      oScore: g('o-score'), oThreat: g('o-threat'), oKills: g('o-kills'),
      oHead: g('o-head'), oAcc: g('o-acc'), oCombo: g('o-combo'), oTime: g('o-time'),
      oPerks: g('o-perks'),
      oGain: g('o-gain'), oCoins: g('o-coins'), oTitle: g('o-title')
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
      const nW = D.wp.length;
      for (let i = 0; i < nW; i++) {
        if (!D.wp[i]) continue;
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
    for (let i = 0; i < D.wres.length; i++) {
      if (!D.wres[i]) continue;
      const txt = !p.unlocked[i] ? '--' : (p.reserve[i] === Infinity ? '∞' : String(p.reserve[i]));
      if (D.wres[i].textContent !== txt) D.wres[i].textContent = txt;
    }
    D.reload.classList.toggle('hide', !(G.muzzleT >= 0 && (p.reloadT || 0) > 0));
    D.blood.style.opacity = ((G.hurtFlash || 0) * 0.8).toFixed(2);

    // 武器名 + 词条
    const inst = (p.insts && p.insts[p.weapon]) || null;
    if (inst) {
      const nm = PP.Rogue.weaponName(inst);
      const affixKey = inst.affixes.map(a => a.id + ':' + a.v).join(',');
      if (last.wname !== nm + p.weapon + affixKey) {
        last.wname = nm + p.weapon + affixKey;
        D.wname.textContent = nm;
        D.wname.style.color = PP.Rogue.RARITY[inst.rarity].color;
        D.waffix.innerHTML = '';
        for (const line of PP.Rogue.affixLines(inst.affixes)) {
          const d = document.createElement('div');
          d.className = 'affix';
          d.textContent = '· ' + line;
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
      D.reviveText.textContent = G.spectateName
        ? ('观战中 · ' + G.spectateName + '（队友仍在战斗）')
        : '你已阵亡 · 观战中（队友仍在战斗）';
    } else if (extra && extra.revive) {
      Hud.show(D.revive, true);
      D.reviveBar.style.width = Math.min(100, (extra.revive.prog || 0) * 100).toFixed(0) + '%';
      D.reviveText.textContent = extra.revive.self
        ? (G.spectateName ? ('你已倒地 · 观战 ' + G.spectateName) : '你已倒地 · 等待队友救援')
        : '按住 F 救援 ' + (extra.revive.name || '队友');
    } else if (G.spectateName && (G.player.downed || G.player.eliminated)) {
      Hud.show(D.revive, true);
      D.reviveBar.style.width = '0%';
      D.reviveText.textContent = '观战中 · ' + G.spectateName;
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
      const h = document.createElement('h4');
      const stacks = k.stacks || 0;
      h.textContent = k.name + (stacks > 0 ? ' ×' + (stacks + 1) : '');
      if (stacks > 0) d.classList.add('stacked');
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
    D.oScore.textContent = G.score || p.score || 0;
    D.oThreat.textContent = G.threat || 1;
    D.oKills.textContent = p.kills || G.kills || 0;
    D.oHead.textContent = p.headshots || G.headshots || 0;
    D.oAcc.textContent = (p.shotsFired || G.shotsFired ? Math.round((p.shotsHit || G.shotsHit || 0) / (p.shotsFired || G.shotsFired) * 100) : 0) + '%';
    D.oCombo.textContent = p.bestCombo || 0;
    const t = G.elapsed || 0;
    const m = Math.floor(t / 60), s = Math.floor(t % 60);
    D.oTime.textContent = m + ':' + (s < 10 ? '0' : '') + s;

    // 本局强化（含叠加层数）
    if (D.oPerks) {
      D.oPerks.innerHTML = '';
      const stacks = p.perkStacks || {};
      const ids = Object.keys(stacks);
      if (!ids.length) {
        const e = document.createElement('span');
        e.className = 'empty';
        e.textContent = '未获得强化';
        D.oPerks.appendChild(e);
      } else {
        // 按层数降序
        ids.sort((a, b) => (stacks[b] || 0) - (stacks[a] || 0));
        for (const id of ids) {
          const def = (PP.Rogue && PP.Rogue.PERKS) ? PP.Rogue.PERKS.find(k => k.id === id) : null;
          const n = stacks[id] || 1;
          const chip = document.createElement('span');
          chip.className = 'ochip' + (n > 1 ? ' x' : '');
          chip.textContent = (def ? def.name : id) + (n > 1 ? ' ×' + n : '');
          D.oPerks.appendChild(chip);
        }
      }
    }

    Hud.show(D.sOver, true);
    Hud.show(D.hud, false);
  };

  /* 结算页附加局外收益（由 game.js 调用） */
  Hud.showReward = function (info) {
    if (!D) return;
    if (D.oGain) D.oGain.textContent = '+' + (info && info.gain || 0);
    if (D.oCoins) D.oCoins.textContent = (info && info.coins != null) ? info.coins : 0;
    if (D.oTitle) D.oTitle.textContent = (info && info.cleared) ? '任务完成' : '你死了';
  };

  /* ---------------- 商店 ---------------- */
  Hud.openShop = function () {
    if (!D) return;
    renderShop();
    const shop = document.getElementById('s-shop');
    if (shop) shop.classList.remove('hide');
    if (D.sTitle) D.sTitle.classList.add('hide');
  };
  Hud.closeShop = function () {
    const shop = document.getElementById('s-shop');
    if (shop) shop.classList.add('hide');
    if (D.sTitle) D.sTitle.classList.remove('hide');
    Hud.refreshProfile();
  };
  Hud.refreshProfile = function () {
    const S = PP.Save;
    if (!S) return;
    const d = S.get();
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('pf-name', d.name || '幸存者');
    set('pf-uid', (d.uid || '').slice(0, 12));
    set('pf-coins', d.coins | 0);
    set('pf-runs', (d.stats && d.stats.runs) | 0);
    set('pf-best', (d.stats && d.stats.bestScore) | 0);
    set('pf-kills', (d.stats && d.stats.totalKills) | 0);
  };

  function renderShop() {
    const S = PP.Save;
    const list = document.getElementById('shop-list');
    const coinsEl = document.getElementById('shop-coins');
    if (!list || !S) return;
    if (coinsEl) coinsEl.textContent = S.coins();
    list.innerHTML = '';
    for (const b of S.BUFFS) {
      const lv = S.buffLevel(b.id);
      const maxed = lv >= b.max;
      const price = S.buffPrice(b.id);
      const item = document.createElement('div');
      item.className = 'shop-item' + (maxed ? ' maxed' : '');
      const h = document.createElement('h4'); h.textContent = b.name;
      const p = document.createElement('p'); p.textContent = b.desc;
      const l = document.createElement('div'); l.className = 'lv';
      l.textContent = '等级 ' + lv + ' / ' + b.max + (maxed ? ' · 已满' : ' · 价格 ' + price);
      const btn = document.createElement('button');
      btn.className = 'btn';
      btn.textContent = maxed ? '满级' : '购买';
      btn.disabled = maxed;
      btn.addEventListener('click', () => {
        const r = S.buyBuff(b.id);
        if (r && r.ok) {
          Hud.toast('已购买 ' + b.name + ' Lv.' + r.level);
          renderShop();
        } else if (r) {
          Hud.toast(r.reason || '无法购买');
        }
      });
      item.appendChild(h); item.appendChild(p); item.appendChild(l); item.appendChild(btn);
      list.appendChild(item);
    }
  }
})();
