# 方块荒野 BLOCKWILD

> 一片程序生成的方块大陆，怪物从林子、废墟和沙漠里不断涌来。找到补给箱换更好的枪，活得更久，走得更远。

开放世界 · **低模体素 3D** · 第一人称射击 · 肉鸽词条 · 局域网联机

技术栈：**Three.js / WebGL + Vite**（模型与贴图 100% 程序化生成，无任何外部美术资源）

## 快速开始

```bash
npm install
npm run build      # 产出 dist/
npm run server     # http://localhost:8080  （单人 + 局域网联机，控制台会打印局域网地址）
```

开发时可 `npm run dev`（Vite 热更新）。注意：**联机必须走 `npm run server`**，
纯静态托管（如 GitHub Pages）跑不了 `server.js`，且 https 页面会被浏览器拦截 `ws://`。

## 操作

| 按键 | 功能 |
| --- | --- |
| `W` `A` `S` `D` | 移动（`SHIFT` 疾跑；后退不能疾跑） |
| 鼠标 | 瞄准 / 转视角 |
| 左键 | 射击 |
| `R` | 装填 |
| `1`–`5` | 切换武器 |
| `F` | 救援倒地队友 |
| `ESC` | 暂停 · `M` 静音 |

移动端：横屏，左半屏浮动摇杆移动、右半屏拖拽转视角，右下射击 / 装填 / 换枪 / 救援。

## 渲染架构（性能相关，改动前务必看）

| 手段 | 说明 |
| --- | --- |
| **纹理图集** | 12 张 256² 程序化贴图打进一张 1024² 图集，所有方块类型共用一个材质 |
| **分块网格** | 地形按 32×32 分块合并成 1 个 mesh/块，视锥 + 距离剔除 |
| **顶点色调制** | 方块类型色调烘进顶点色，避免逐类型多材质 |
| **阴影节流** | `shadowMap.autoUpdate=false`，隔帧更新；贴图分辨率随画质档位切换 |
| **实体合并** | 每只怪的所有零件在"动画节点"内合并成 1 个顶点色网格（20+ draw call → 6） |
| **几何缓存** | 盒/柱/球按尺寸缓存复用，生成销毁实体不再重复造 GPU 缓冲 |
| **粒子实例化** | 全部粒子走一个 InstancedMesh（1 个 draw call） |
| **实体预算** | 敌人按距离取最近 24 只渲染，超出直接隐藏（雾里看不见） |
| **小地图节流** | 8Hz 重绘，且只画周围 34 格 |

画质档位（低 0.4 / 中 0.7 / 高 1.0 / 高清 1.5 / 超清 2.2）是**真实分辨率倍率**，
帧时间超过 21ms 会自动逐级降档（最多 3 次，不低于 0.45×）。

## 血泪结论（勿回退）

- **顶面绕序**：地面与墙顶的 +Y 面必须按"从外侧看逆时针"给顶点，否则被背面剔除
  —— 现象是"整个世界像悬空在灰色虚空里、看不到墙顶"，曾经出现过的头号画质 bug。
- **阴影相机**：改过 `shadow.camera.left/right/top/bottom` 之后必须手动
  `updateProjectionMatrix()`，否则阴影相机还是构造时的 ±5 默认框，稍远就没有影子。
- **金属材质必须有环境贴图**：没有 `scene.environment` 时 `metalness > 0` 会渲染成死黑
  （金属没有漫反射），所以启动时用一张天空渐变烤 PMREM 当 IBL。
- **地形重建立必须带 seed**：渲染器的世界缓存 key 以前只有 `SIZE|墙数组长度`，
  重开一局换了 seed 不重建 → 碰撞用新地图、画面是旧地图，直接穿模。
- **天空球不能关 matrixAutoUpdate**：它每帧跟着相机走，一旦关掉自动矩阵，
  玩家走远后相机跑到球外面，天上会出现一道"巨大蓝色圆弧"。
- **贴图基色在线性空间偏暗**：`toneMappingExposure` 需要 >1（当前 1.35），
  且 `WALL_SKIN/FLOOR_SKIN` 的 color 只能做轻微偏色，给深色会把贴图二次压暗。
- **CSS 的 `.show` / `.pop` 曾经完全没有样式规则**（不是写错，是根本没有）：
  开场横幅永久挂在屏幕正中、提示条常驻、击杀飘字没有动画。补在 `css/style.css` 末尾。
- **`.screen` 的 flex 居中**要配 `align-items:flex-start` + `.panel{margin:auto}`，
  否则内容高于屏幕时顶部被裁且滚不到。
- **指针锁定必须门控**：只有 `isPlaying()` 为真才 `requestPointerLock()`。
- **鼠标 movement 尖峰**：`|movementX| > 180` 直接丢弃 + 锁定后 3 帧 grace。
- **流场/寻路坐标必须 `Math.floor`，禁止 `Math.round`**（格角 x.5 会吸附到隔壁格 → 敌人冻结）。

## 项目结构

```
index.html            入口（Vite）
server.js             静态托管 dist/ + 手写 WebSocket + 权威模拟
src/
  core.js audio.js    核心 / WebAudio 合成音效
  art.js              旧 2D 像素贴图生成器（客户端已不用，仅 tools/verify.js 回归用）
  sim/                与浏览器/Node 共用的模拟层（30Hz 固定步长 + 种子化 PRNG）
  three/
    textures.js       程序化贴图 + 图集
    materials.js      材质 / 调色板 / 皮肤表
    models.js         程序化低模 + 顶点色合并
    architecture.js   建筑构件（压顶 / 墙基 / 窗 / 门框）
  client/
    main.js           Vite 入口
    render3d.js       Three.js 渲染器（PP.Render 契约）
    hud.js game.js net.js settings.js save.js touch.js
tools/
  verify.js           模拟层断言套件（57 项）
  nettest.js          双客户端连真实 server.js
  playtest.cjs        Playwright 真键鼠端到端试玩（输入链路 + 战斗链路）
  showcase.cjs        定点取景截图（开阔地 / 怪群 / POI / 天空 / 开火）
  ui-check.cjs        逐界面截图（标题/暂停/选卡/设置/商店/结算/移动端）
  perf.cjs            渲染开销分解
  diag.cjs diag2.cjs 浏览器诊断（FPS / draw call / 报错）
  probe.cjs probe2.cjs 场景内省（材质 / UV / 逐层隔离）
  shot3d.cjs          视觉冒烟
```

## 开发流程

```bash
npm run build && npm run verify       # 必需：模拟层回归
node tools/playtest.cjs               # 必需：可玩性端到端（需 server 已启动）
node tools/ui-check.cjs               # 改动 UI 后跑
node tools/showcase.cjs               # 改动渲染后跑，产出 artifacts/ 截图
node tools/nettest.js                 # 改动联机后跑
```

## 许可

个人学习 / 娱乐项目，可自由查看与试用。
