/* ============================================================
   roguelike.js — 肉鸽层：稀有度 / 武器词条 / 角色 Perk
   纯数据 + 纯函数，服务端与客户端共用，保证联机时掉落结果一致
   （所有随机都从传入的 rng 取，禁止 Math.random）
   ============================================================ */
(function () {
  const ROOT = (typeof window !== 'undefined') ? window : globalThis;
  const PP = (ROOT.PP = ROOT.PP || {});
  const Rogue = (PP.Rogue = {});

  /* ---------------- 稀有度 ---------------- */
  Rogue.RARITY = [
    { key: 'common', name: '普通', cn: '普通', color: '#d8d8d8', affixes: 0, mult: 1.00, weight: 46 },
    { key: 'fine', name: '精良', cn: '精良', color: '#7fd45a', affixes: 1, mult: 1.08, weight: 26 },
    { key: 'rare', name: '稀有', cn: '稀有', color: '#5cb8f0', affixes: 2, mult: 1.18, weight: 16 },
    { key: 'epic', name: '史诗', cn: '史诗', color: '#c07ff0', affixes: 3, mult: 1.30, weight: 9 },
    { key: 'legend', name: '传说', cn: '传说', color: '#ffb03a', affixes: 4, mult: 1.45, weight: 3 }
  ];

  /* ---------------- 武器词条 ----------------
     stat: 直接乘/加到武器数值上；特殊词条由 flag 驱动，在 Sim.fire 里分支处理
  */
  Rogue.AFFIXES = [
    { id: 'dmg', name: '磨利', fmt: '伤害 +{v}%', stat: 'dmg', kind: 'pct', min: 12, max: 30, tier: 1 },
    { id: 'rate', name: '轻扳机', fmt: '射速 +{v}%', stat: 'rate', kind: 'pct', min: 12, max: 28, tier: 1 },
    { id: 'mag', name: '扩容', fmt: '弹匣 +{v}', stat: 'mag', kind: 'add', min: 3, max: 9, tier: 1 },
    { id: 'reload', name: '快手', fmt: '装填速度 +{v}%', stat: 'reload', kind: 'pct', min: 15, max: 35, tier: 1 },
    { id: 'focus', name: '校准', fmt: '扩散 -{v}%', stat: 'spread', kind: 'pct', min: 20, max: 45, tier: 1 },
    { id: 'head', name: '猎手', fmt: '爆头倍率 +{v}', stat: 'headMul', kind: 'add', min: 0.4, max: 1.2, tier: 2 },
    { id: 'speed', name: '轻装', fmt: '持枪移速 +{v}%', stat: 'moveSpeed', kind: 'pct', min: 6, max: 15, tier: 1 },
    { id: 'pierce', name: '穿透', fmt: '子弹可穿透 {v} 个敌人', stat: 'pierce', kind: 'add', min: 1, max: 2, tier: 3 },
    { id: 'leech', name: '嗜血', fmt: '击杀回复 {v} 生命', stat: 'leech', kind: 'add', min: 3, max: 8, tier: 2 },
    { id: 'scav', name: '拾荒', fmt: '击杀有 {v}% 概率补充弹药', stat: 'scav', kind: 'add', min: 15, max: 40, tier: 2 },
    { id: 'boom', name: '爆裂', fmt: '击杀时爆炸，造成 {v} 范围伤害', stat: 'boom', kind: 'add', min: 18, max: 45, tier: 3 },
    { id: 'chain', name: '红石传导', fmt: '命中弹射 {v} 个附近敌人', stat: 'chain', kind: 'add', min: 1, max: 2, tier: 3 },
    { id: 'burn', name: '灼烧', fmt: '命中附加 {v} 秒持续伤害', stat: 'burn', kind: 'add', min: 2, max: 4, tier: 2 },
    { id: 'kick', name: '重弹', fmt: '击退 +{v}%', stat: 'knockback', kind: 'pct', min: 40, max: 120, tier: 1 },
    { id: 'multishot', name: '分裂', fmt: '每次射击额外 {v} 发弹丸', stat: 'multishot', kind: 'add', min: 1, max: 2, tier: 3 },
    { id: 'crit', name: '致命', fmt: '{v}% 概率造成双倍伤害', stat: 'crit', kind: 'add', min: 12, max: 28, tier: 2 },
    { id: 'slow', name: '寒冰', fmt: '命中减速敌人 {v} 秒', stat: 'slow', kind: 'add', min: 1.2, max: 2.4, tier: 1 },
    { id: 'ammosave', name: '节俭', fmt: '{v}% 概率不消耗弹药', stat: 'ammosave', kind: 'add', min: 15, max: 35, tier: 2 }
  ];

  /* ---------------- 掉落 ---------------- */
  Rogue.rollRarity = function (rng, threatBonus) {
    const tbl = Rogue.RARITY;
    const boost = Math.min(2.2, 1 + (threatBonus || 0) * 0.12);
    let total = 0;
    const w = [];
    for (let i = 0; i < tbl.length; i++) {
      const x = tbl[i].weight * Math.pow(boost, i);
      w.push(x); total += x;
    }
    let r = rng.next() * total;
    for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return i; }
    return 0;
  };

  // 生成一把带词条的武器实例（同名词条可叠加，数值在 stats 里求和）
  Rogue.rollWeapon = function (rng, defIndex, threat) {
    const ri = Rogue.rollRarity(rng, threat || 0);
    const R = Rogue.RARITY[ri];
    const picked = [];
    let n = 0;
    if (ri === 0 && rng.chance(0.45)) n = 1;          // 普通也有小概率 1 条
    else n = R.affixes;
    const used = {};
    for (let i = 0; i < n; i++) {
      let a;
      // 七成优先新词条，三成允许重复 → 词条池永不枯竭，且可叠加
      const fresh = [];
      for (const x of Rogue.AFFIXES) if (!used[x.id]) fresh.push(x);
      if (fresh.length && rng.chance(0.7)) a = fresh[(rng.next() * fresh.length) | 0];
      else a = Rogue.AFFIXES[(rng.next() * Rogue.AFFIXES.length) | 0];
      used[a.id] = (used[a.id] || 0) + 1;
      const t = rng.next();
      const val = a.min + t * (a.max - a.min);
      picked.push({ id: a.id, v: a.kind === 'add' ? Math.round(val * 10) / 10 : Math.round(val) });
    }
    return { def: defIndex, rarity: ri, affixes: picked, name: '' };
  };

  Rogue.affixText = function (af) {
    for (const a of Rogue.AFFIXES) {
      if (a.id === af.id) return a.fmt.replace('{v}', af.v);
    }
    return af.id;
  };
  // 同名词条合并显示（叠加后的总值）
  Rogue.affixLines = function (affixes) {
    const sum = {}, order = [];
    for (const af of affixes || []) {
      if (!(af.id in sum)) { sum[af.id] = 0; order.push(af.id); }
      sum[af.id] += af.v;
    }
    return order.map(id => {
      const a = Rogue.AFFIXES.find(x => x.id === id);
      const v = Math.round(sum[id] * 10) / 10;
      if (!a) return id + ' +' + v;
      return a.fmt.replace('{v}', v);
    });
  };
  Rogue.affixName = function (af) {
    for (const a of Rogue.AFFIXES) if (a.id === af.id) return a.name;
    return af.id;
  };
  Rogue.weaponName = function (inst) {
    const base = PP.WEAPONS[inst.def].name;
    if (!inst.affixes.length) return base;
    const pre = Rogue.affixName(inst.affixes[0]);
    return pre + '·' + base;
  };

  /* 把基础武器数值 + 词条 + 角色 Perk 合成为最终数值 */
  Rogue.stats = function (inst, mods) {
    const base = PP.WEAPONS[inst.def];
    const R = Rogue.RARITY[inst.rarity];
    const s = {
      dmg: base.dmg * R.mult,
      cd: base.cd,
      mag: base.mag,
      reload: base.reload,
      spread: base.spread,
      headMul: base.headMul,
      range: base.range,
      pellets: base.pellets,
      auto: base.auto,
      falloff: base.falloff,
      kick: base.kick,
      sfx: base.sfx,
      moveSpeed: 1,
      pierce: 0, leech: 0, scav: 0, boom: 0, chain: 0, burn: 0, knockback: 1,
      multishot: 0, crit: 0, slow: 0, ammosave: 0, burnBase: base.burnBase || 0
    };
    const add = {};
    for (const af of inst.affixes) add[af.id] = (add[af.id] || 0) + af.v;
    if (add.dmg) s.dmg *= (1 + add.dmg / 100);
    if (add.rate) s.cd /= (1 + add.rate / 100);
    if (add.mag) s.mag += add.mag;
    if (add.reload) s.reload /= (1 + add.reload / 100);
    if (add.focus) s.spread *= (1 - add.focus / 100);
    if (add.head) s.headMul += add.head;
    if (add.pierce) s.pierce += add.pierce;
    if (add.leech) s.leech += add.leech;
    if (add.scav) s.scav += add.scav;
    if (add.boom) s.boom += add.boom;
    if (add.chain) s.chain += add.chain;
    if (add.burn) s.burn += add.burn;
    if (add.kick) s.knockback *= (1 + add.kick / 100);
    if (add.speed) s.moveSpeed += add.speed / 100;
    if (add.multishot) s.multishot += add.multishot;
    if (add.crit) s.crit += add.crit;
    if (add.slow) s.slow = Math.max(s.slow, add.slow);
    if (add.ammosave) s.ammosave += add.ammosave;

    // 角色 Perk（乘算/加算在词条之后）
    if (mods) {
      if (mods.dmg) s.dmg *= (1 + mods.dmg);
      if (mods.rate) s.cd /= (1 + mods.rate);
      if (mods.reload) s.reload /= (1 + mods.reload);
      if (mods.spread) s.spread *= (1 - mods.spread);
      if (mods.pierce) s.pierce += mods.pierce;
      if (mods.moveSpeed) s.moveSpeed += mods.moveSpeed;
      if (mods.head) s.headMul += mods.head;
    }
    s.mag = Math.round(s.mag);
    return s;
  };

  /* ---------------- 角色 Perk ---------------- */
  Rogue.PERKS = [
    { id: 'vitality', name: '强健', desc: '生命上限 +25', apply: (m, p) => { p.maxHp += 25; p.hp += 25; } },
    { id: 'armor', name: '护甲板', desc: '护甲上限 +30，立即获得 30 护甲', apply: (m, p) => { p.maxAp += 30; p.ap = Math.min(p.maxAp, p.ap + 30); } },
    { id: 'power', name: '重击', desc: '所有武器伤害 +15%', apply: (m) => { m.dmg = (m.dmg || 0) + 0.15; } },
    { id: 'haste', name: '疾行', desc: '移动速度 +12%', apply: (m) => { m.moveSpeed = (m.moveSpeed || 0) + 0.12; } },
    { id: 'rapid', name: '连射', desc: '射速 +15%', apply: (m) => { m.rate = (m.rate || 0) + 0.15; } },
    { id: 'quickhand', name: '快枪手', desc: '装填速度 +25%', apply: (m) => { m.reload = (m.reload || 0) + 0.25; } },
    { id: 'eagle', name: '鹰眼', desc: '爆头倍率 +0.6，扩散 -20%', apply: (m) => { m.head = (m.head || 0) + 0.6; m.spread = (m.spread || 0) + 0.2; } },
    { id: 'piercing', name: '穿甲弹', desc: '所有武器额外穿透 +1', apply: (m) => { m.pierce = (m.pierce || 0) + 1; } },
    { id: 'vampire', name: '吸血鬼', desc: '击杀回复 6 生命', apply: (m) => { m.leech = (m.leech || 0) + 6; } },
    { id: 'medic', name: '战地医生', desc: '救援速度 +80%，倒地流血时间 +20 秒', apply: (m) => { m.reviveSpeed = (m.reviveSpeed || 0) + 0.8; m.bleed = (m.bleed || 0) + 20; } },
    { id: 'ammo', name: '军需', desc: '弹药上限 +50%，立即补满备弹', apply: (m, p) => { m.ammoMax = (m.ammoMax || 0) + 0.5; } },
    { id: 'thorns', name: '荆棘', desc: '受击时对周围敌人造成 20 反伤', apply: (m) => { m.thorns = (m.thorns || 0) + 20; } },
    { id: 'luck', name: '幸运儿', desc: '补给箱更容易开出高稀有度', apply: (m) => { m.luck = (m.luck || 0) + 1; } },
    { id: 'sprinter', name: '短跑选手', desc: '疾跑速度 +25%', apply: (m) => { m.sprint = (m.sprint || 0) + 0.25; } },
    { id: 'regen', name: '自愈', desc: '每秒回复 0.8 生命', apply: (m) => { m.regen = (m.regen || 0) + 0.8; } },
    { id: 'overheat', name: '背水一战', desc: '生命低于 40% 时伤害 +35%（可叠加）', apply: (m) => { m.overheat = (m.overheat || 0) + 1; } }
  ];

  // 抽 n 个 Perk：池永不枯竭，已选过的仍可出现（可叠加）；本次卡片互不重复
  // 权重：未选过 ×3，已选过 ×1，保证有新鲜感但不会抽干
  Rogue.rollPerks = function (rng, taken, n) {
    const pool = Rogue.PERKS.slice();
    const takenSet = new Set(taken || []);
    const out = [];
    const cnt = Math.min(n || 3, pool.length);
    for (let i = 0; i < cnt; i++) {
      let total = 0;
      const wts = pool.map(p => {
        const w = takenSet.has(p.id) ? 1 : 3;
        total += w; return w;
      });
      let r = rng.next() * total;
      let k = 0;
      for (; k < pool.length - 1; k++) { r -= wts[k]; if (r <= 0) break; }
      out.push(pool.splice(k, 1)[0]);
    }
    return out;
  };

  // 升级所需经验：等差数列，前期快后期慢
  Rogue.xpForLevel = function (lv) { return 100 + (lv - 1) * 85; };
})();
