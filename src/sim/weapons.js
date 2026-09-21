/* ============================================================
   weapons.js — 武器数据表（方块风） [v3]
   rationale:
     - 铁手铳 DPS≈86，2 发躯干杀 zombie，备弹无限 → 永远有保底手段
     - 双管猎枪 8×13=104/发，射程 16 → 近距离清场最优解
     - 红石脉冲 DPS≈176 → 处理 husk(140HP) 的主力，但弹药有限
   ============================================================ */
(function () {
  const ROOT = (typeof window !== 'undefined') ? window : globalThis;
  const PP = (ROOT.PP = ROOT.PP || {});

  PP.WEAPONS = [
    {
      id: 0, name: '铁手铳', en: 'IRON HANDCANNON',
      mag: 12, startReserve: Infinity, maxReserve: Infinity,
      dmg: 24, headMul: 2.3, cd: 0.28, spread: 0.014, range: 40, pellets: 1,
      auto: false, reload: 0.95, kick: 1.0, sfx: 'shotPistol', falloff: true,
      sfxGain: 1
    },
    {
      id: 1, name: '双管猎枪', en: 'TWIN BARREL',
      mag: 6, startReserve: 24, maxReserve: 64,
      dmg: 13, headMul: 1.8, cd: 0.72, spread: 0.105, range: 16, pellets: 8,
      auto: false, reload: 1.5, kick: 2.4, sfx: 'shotShotgun', falloff: true
    },
    {
      id: 2, name: '红石脉冲', en: 'REDSTONE PULSE',
      mag: 40, startReserve: 120, maxReserve: 320,
      dmg: 15, headMul: 2.0, cd: 0.085, spread: 0.038, range: 32, pellets: 1,
      auto: true, reload: 1.6, kick: 0.55, sfx: 'shotPulse', falloff: false
    }
  ];

  PP.WEAPON_BY_ID = function (i) { return PP.WEAPONS[i]; };
})();
