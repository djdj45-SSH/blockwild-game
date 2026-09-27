/* ============================================================
   save.js — 局外进度存档（localStorage + 导出/导入）
   GitHub Pages 无后端 → 数据只存在本机浏览器。
   换设备用「导出存档码」搬运。勿把存档写进 git 仓库。
   ============================================================ */
(function () {
  const ROOT = (typeof window !== 'undefined') ? window : globalThis;
  const PP = (ROOT.PP = ROOT.PP || {});
  const Save = (PP.Save = {});

  const KEY = 'blockwild_save_v1';
  const VERSION = 1;

  /* ---------------- 局外增益表 ----------------
     level 0..max；开局时套用到玩家初始属性 / mods */
  Save.BUFFS = [
    { id: 'vitality', name: '强健体魄', desc: '每级 +15 生命上限', max: 5, cost: (lv) => 80 + lv * 60, apply: (s, lv) => { s.maxHp += 15 * lv; } },
    { id: 'bulwark', name: '护甲板', desc: '每级 +10 护甲上限', max: 5, cost: (lv) => 70 + lv * 55, apply: (s, lv) => { s.maxAp += 10 * lv; } },
    { id: 'power', name: '火力全开', desc: '每级 +4% 武器伤害', max: 5, cost: (lv) => 120 + lv * 90, apply: (s, lv) => { s.dmg += 0.04 * lv; } },
    { id: 'haste', name: '疾风步', desc: '每级 +3% 移动速度', max: 5, cost: (lv) => 100 + lv * 70, apply: (s, lv) => { s.moveSpeed += 0.03 * lv; } },
    { id: 'fortune', name: '幸运星', desc: '每级更容易开出高稀有度', max: 3, cost: (lv) => 150 + lv * 120, apply: (s, lv) => { s.luck += lv; } },
    { id: 'training', name: '老兵训练', desc: '每级 +10% 经验', max: 5, cost: (lv) => 90 + lv * 65, apply: (s, lv) => { s.xpMul += 0.10 * lv; } },
    { id: 'scavenger', name: '军需官', desc: '每级 +15% 初始备弹', max: 3, cost: (lv) => 110 + lv * 85, apply: (s, lv) => { s.ammoMax += 0.15 * lv; } },
    { id: 'regen', name: '自愈体质', desc: '每级每秒回复 0.3 生命', max: 3, cost: (lv) => 140 + lv * 110, apply: (s, lv) => { s.regen += 0.3 * lv; } }
  ];

  function defaults() {
    return {
      v: VERSION,
      uid: 'p_' + Math.random().toString(36).slice(2, 10),
      name: '',
      coins: 0,
      buffs: {},                 // id -> level
      stats: {
        runs: 0, wins: 0,
        totalKills: 0, totalScore: 0, bestScore: 0, bestTime: 0, bestLevel: 1
      },
      updatedAt: Date.now()
    };
  }

  let data = defaults();

  function hasLS() {
    try { return !!(ROOT.localStorage && ROOT.localStorage.setItem); } catch (e) { return false; }
  }

  Save.load = function () {
    data = defaults();
    if (!hasLS()) return data;
    try {
      const raw = ROOT.localStorage.getItem(KEY);
      if (!raw) return data;
      const o = JSON.parse(raw);
      if (!o || typeof o !== 'object') return data;
      data = Object.assign(defaults(), o);
      data.buffs = Object.assign({}, o.buffs || {});
      data.stats = Object.assign(defaults().stats, o.stats || {});
      if (typeof data.coins !== 'number' || !isFinite(data.coins)) data.coins = 0;
      if (typeof data.uid !== 'string' || !data.uid) data.uid = defaults().uid;
    } catch (e) { /* 坏档 → 重开 */ }
    return data;
  };

  Save.save = function () {
    data.updatedAt = Date.now();
    if (!hasLS()) return false;
    try {
      ROOT.localStorage.setItem(KEY, JSON.stringify(data));
      return true;
    } catch (e) { return false; }
  };

  Save.get = function () { return data; };
  Save.uid = function () { return data.uid; };
  Save.name = function () { return data.name || ''; };
  Save.setName = function (n) {
    data.name = String(n || '').slice(0, 16);
    Save.save();
    return data.name;
  };
  Save.coins = function () { return data.coins | 0; };
  Save.addCoins = function (n) {
    data.coins = Math.max(0, Math.round((data.coins || 0) + (n || 0)));
    Save.save();
    return data.coins;
  };
  Save.buffLevel = function (id) { return Math.max(0, data.buffs[id] | 0); };

  /* 本局开局用的增益快照 */
  Save.buffSnapshot = function () {
    const s = {
      maxHp: 0, maxAp: 0, dmg: 0, moveSpeed: 0,
      luck: 0, xpMul: 0, ammoMax: 0, regen: 0
    };
    for (const b of Save.BUFFS) {
      const lv = Save.buffLevel(b.id);
      if (lv > 0 && b.apply) b.apply(s, lv);
    }
    return s;
  };

  /* 套用到玩家（单机 / 服务端 join 后均可） */
  Save.applyToPlayer = function (p, snap) {
    if (!p) return p;
    const s = snap || Save.buffSnapshot();
    if (s.maxHp) { p.maxHp += s.maxHp; p.hp = p.maxHp; }
    if (s.maxAp) {
      p.maxAp += s.maxAp;
      if (s.maxAp > 0) p.ap = Math.min(p.maxAp, (p.ap || 0) + s.maxAp * 0.5);
    }
    if (!p.mods) p.mods = {};
    if (s.dmg) p.mods.dmg = (p.mods.dmg || 0) + s.dmg;
    if (s.moveSpeed) p.mods.moveSpeed = (p.mods.moveSpeed || 0) + s.moveSpeed;
    if (s.luck) p.mods.luck = (p.mods.luck || 0) + s.luck;
    if (s.ammoMax) p.mods.ammoMax = (p.mods.ammoMax || 0) + s.ammoMax;
    if (s.regen) p.mods.regen = (p.mods.regen || 0) + s.regen;
    if (s.xpMul) p.mods.xpMul = (p.mods.xpMul || 0) + s.xpMul;
    // 初始备弹放大
    if (s.ammoMax && p.reserve) {
      for (let i = 0; i < p.reserve.length; i++) {
        if (p.reserve[i] !== Infinity && p.reserve[i] > 0) {
          p.reserve[i] = Math.round(p.reserve[i] * (1 + s.ammoMax));
        }
      }
    }
    return p;
  };

  /* 校验并夹紧服务端收到的 meta（联机防伪造） */
  Save.sanitizeMeta = function (m) {
    const out = { maxHp: 0, maxAp: 0, dmg: 0, moveSpeed: 0, luck: 0, xpMul: 0, ammoMax: 0, regen: 0 };
    if (!m || typeof m !== 'object') return out;
    const clamp = (v, a, b) => {
      const n = Number(v);
      return isFinite(n) ? Math.max(a, Math.min(b, n)) : 0;
    };
    out.maxHp = clamp(m.maxHp, 0, 200);
    out.maxAp = clamp(m.maxAp, 0, 100);
    out.dmg = clamp(m.dmg, 0, 0.5);
    out.moveSpeed = clamp(m.moveSpeed, 0, 0.4);
    out.luck = clamp(m.luck, 0, 8);
    out.xpMul = clamp(m.xpMul, 0, 1.5);
    out.ammoMax = clamp(m.ammoMax, 0, 1.2);
    out.regen = clamp(m.regen, 0, 3);
    return out;
  };

  /* 一局结束 → 发星币并写统计 */
  Save.recordRun = function (r) {
    const t = r || {};
    const score = Math.max(0, t.score | 0);
    const kills = Math.max(0, t.kills | 0);
    const time = Math.max(0, t.time || 0);
    const level = Math.max(1, t.level | 0);
    // 星币：分数为主，击杀/时间/等级辅助，上限防止挂机刷爆
    let gain = Math.floor(score / 40 + kills * 2 + time / 12 + level * 4);
    gain = Math.max(0, Math.min(800, gain));
    if (t.cleared) gain += 100;
    data.coins = Math.max(0, (data.coins || 0) + gain);
    data.stats = data.stats || defaults().stats;
    data.stats.runs = (data.stats.runs || 0) + 1;
    if (t.cleared) data.stats.wins = (data.stats.wins || 0) + 1;
    data.stats.totalKills = (data.stats.totalKills || 0) + kills;
    data.stats.totalScore = (data.stats.totalScore || 0) + score;
    if (score > (data.stats.bestScore || 0)) data.stats.bestScore = score;
    if (time > (data.stats.bestTime || 0)) data.stats.bestTime = time;
    if (level > (data.stats.bestLevel || 1)) data.stats.bestLevel = level;
    Save.save();
    return { gain: gain, coins: data.coins, stats: data.stats };
  };

  /* 商店购买 */
  Save.buyBuff = function (id) {
    const def = Save.BUFFS.find(b => b.id === id);
    if (!def) return { ok: false, reason: '未知增益' };
    const lv = Save.buffLevel(id);
    if (lv >= def.max) return { ok: false, reason: '已满级' };
    const price = def.cost(lv);
    if (data.coins < price) return { ok: false, reason: '星币不足', price: price };
    data.coins -= price;
    data.buffs[id] = lv + 1;
    Save.save();
    return { ok: true, level: data.buffs[id], coins: data.coins, price: price };
  };

  Save.buffPrice = function (id) {
    const def = Save.BUFFS.find(b => b.id === id);
    if (!def) return 0;
    return def.cost(Save.buffLevel(id));
  };

  /* ---------------- 导出 / 导入 ---------------- */
  Save.exportCode = function () {
    try {
      const json = JSON.stringify(data);
      const b64 = (typeof btoa === 'function')
        ? btoa(unescape(encodeURIComponent(json)))
        : Buffer.from(json, 'utf8').toString('base64');
      return 'BW1.' + b64;
    } catch (e) { return ''; }
  };

  Save.importCode = function (code) {
    try {
      const raw = String(code || '').trim();
      if (!raw) return { ok: false, reason: '空存档码' };
      const b64 = raw.indexOf('BW1.') === 0 ? raw.slice(4) : raw;
      const json = (typeof atob === 'function')
        ? decodeURIComponent(escape(atob(b64)))
        : Buffer.from(b64, 'base64').toString('utf8');
      const o = JSON.parse(json);
      if (!o || typeof o !== 'object') return { ok: false, reason: '无法解析' };
      data = Object.assign(defaults(), o);
      data.buffs = Object.assign({}, o.buffs || {});
      data.stats = Object.assign(defaults().stats, o.stats || {});
      if (!isFinite(data.coins)) data.coins = 0;
      Save.save();
      return { ok: true, name: data.name, coins: data.coins };
    } catch (e) {
      return { ok: false, reason: '存档码无效或已损坏' };
    }
  };

  Save.reset = function () {
    data = defaults();
    Save.save();
    return data;
  };

  // 启动即加载
  Save.load();
})();
