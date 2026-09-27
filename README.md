# 方块荒野 BLOCKWILD 3D

> 一片程序生成的方块大陆，怪物从林子、废墟和沙漠里不断涌来。找到补给箱换更好的枪，活得更久，走得更远。

开放世界 · **真 3D 低模体素** · 第一人称射击 · 肉鸽词条 · 局域网联机

**Three.js / WebGL**（本分支放开「零依赖」限制，模型全部程序化生成）

## 在线 / 本地试玩

```bash
npm install
npm run build      # 产出 dist/
npm run server     # http://localhost:8080  （单人 + 局域网联机）
```

开发时也可 `npm run dev`（Vite 热更新，单人调试更方便；联机请用 `npm run server`）。

## 操作

| 按键 | 功能 |
| --- | --- |
| `W` `A` `S` `D` | 移动（`SHIFT` 疾跑） |
| 鼠标 | 瞄准 / 转视角 |
| 左键 | 射击 |
| `R` | 装填 |
| `1`–`5` | 切换武器 |
| `F` | 救援倒地队友 |
| `ESC` | 暂停 · `M` 静音 |

## 3D 升级要点（3Dcs 分支）

- **渲染**：Three.js 真网格（透视相机、平行光阴影、雾、渐变天空）
- **模型**：全部程序化低模盒体拼装 —— 玩家/僵尸/尸壳/骷髅/爬行者/蜘蛛、5 把枪视模、补给箱
- **世界**：192×192 程序生成体素柱（墙高表、群系、POI、补给），地面/墙按类型合并网格
- **模拟层不变**：固定 30Hz、服务端权威、肉鸽词条、流场寻路、二进制快照

## 项目结构

```
index.html            入口（Vite）
package.json          three + vite
server.js             静态托管 dist/ + WebSocket 权威模拟
src/
  core.js art.js audio.js
  sim/                与浏览器/Node 共用的模拟层
  three/
    materials.js      材质 / 调色板
    models.js         程序化低模模型
  client/
    main.js           Vite 入口
    render3d.js       Three.js 渲染器（PP.Render 契约）
    hud.js net.js …
tools/
  verify.js           断言套件（模拟层回归）
  shot3d.cjs          Playwright 视觉冒烟
```

## 开发

```bash
npm run build && npm run verify
node tools/shot3d.cjs   # 需本地 server 已启动
node tools/nettest.js   # 联机连通
```

## 许可

个人学习 / 娱乐项目，可自由查看与试用。
