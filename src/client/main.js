/* ============================================================
   main.js — Vite 入口：按序装载 PP 命名空间 + Three.js 渲染器
   ============================================================ */
// 1) 核心与模拟（IIFE 副作用挂到 globalThis.PP）
//    注意：art.js（旧的 2D 像素贴图生成器）已不被客户端使用，
//    Three.js 版贴图在 src/three/textures.js。art.js 仅保留给 tools/verify.js 回归。
import '../core.js';
import '../audio.js';
import '../sim/weapons.js';
import '../sim/roguelike.js';
import '../sim/world.js';
import '../sim/entities.js';
import '../sim/sim.js';
import '../sim/snapshot.js';

// 2) 客户端：渲染器必须在 game 启动前就绪
import './render3d.js';
import './save.js';
import './hud.js';
import './settings.js';
import './net.js';
import './touch.js';
import './game.js';

if (typeof window !== 'undefined') {
  window.__BW_RENDER__ = () =>
    (window.PP && window.PP.Render && window.PP.Render.getStats)
      ? window.PP.Render.getStats()
      : null;
}
