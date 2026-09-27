# BLOCKWILD 3D — 交付证据（3Dcs）

## 结果

Three.js 低模体素渲染已接入完整可玩循环。本地 `node server.js` 单人可玩，~200 FPS @1280×720。

## 构建与运行

```bash
npm install
npm run build
npm run server     # http://localhost:8080
npm run verify     # 模拟层断言：全部通过
node tools/shot3d.cjs
```

## 实测（Playwright + 本地 Chromium）

| 项 | 结果 |
| --- | --- |
| 页面错误 | 无 |
| 游戏状态 | `playing`（点「单人开始」） |
| Draw calls | ~50 |
| 三角面 | ~213k |
| FPS | **204**（30 帧 / 146 ms） |
| 画布 | 1280×720 WebGL |
| verify.js | **全部通过** |

## 模型（全部程序化，`src/three/models.js`）

- 玩家 4 色队服人形
- 僵尸 / 尸壳 / 骷髅 / 爬行者 / 蜘蛛
- 5 把武器视模（铁手铳 / 双管猎枪 / 红石脉冲 / 青金长铳 / 岩浆喷口）
- 补给箱 / 弹药 / 血包 / 骨弹

## 文件

- `src/client/render3d.js` — Three.js 渲染器（替换软件光栅）
- `src/three/models.js` / `materials.js` — 模型与材质
- `src/client/main.js` — Vite 入口
- `artifacts/final-play.jpg` / `bw3d-play2.png` — 画面证据

## 已知边界

- 联机路径保留原 server 权威 sim，本次未跑完整 nettest 回归（建议再跑 `node tools/nettest.js`）
- 移动端触控沿用原 `touch.js`，未针对 WebGL 重做 HUD 安全区
- 角色动画为程序化摆动（walk/attack/hurt/dead），非骨骼动画
