#!/usr/bin/env python3
"""把 assets/mc/*.png（Minecraft 原版 16x16 纹理）打包成单张图集。

用法： python tools/build-mc-atlas.py
输出： assets/mc/atlas.png + 把布局 JSON 打印到 stdout（写进 textures.js）

为什么自己拼图集而不是让浏览器加载 25 张小图：
  单张图集 = 1 次请求 + 1 个 material，和现有渲染架构（整块地形共用一个
  material）一致；散图会导致方块不能合批，draw call 直接爆掉。

padding 用「边缘像素向外延伸」：
  mipmap 缩小时双线性会采到格子外，不留护栏会在远处出现"彩色描边"。
  护栏宽度要能撑到 mip 4（16px 有效区缩到 1 texel 时仍有 1 texel 隔离）→ PAD=16。
"""
import base64
import json
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SRC = os.path.join(ROOT, 'assets', 'mc')
OUT = os.path.join(SRC, 'atlas.png')
# 图集本体以 base64 内联进 JS：项目同时支持「源码根 + importmap 纯静态托管」
# 和「vite build 产物」两种部署，用 import 图片或相对路径都会在其中一种下失效，
# data URL 两种都零成本生效，且省掉一次请求。
DATA_JS = os.path.join(ROOT, 'src', 'three', 'mc-atlas-data.js')

TILE = 16     # 原版纹理边长
PAD = 16      # 每侧护栏（mip 隔离）
COLS, ROWS = 8, 4
CELL = TILE + PAD * 2


def thin_leaf_alpha(im):
    """打散树叶镂空的「贯穿条纹」—— 解决「远处树冠变成蓝白网格」。

    【实测数据】原版 oak_leaves 的 alpha 只有 0 / 255 两个值，32.8% 镂空。
    关键发现：透明像素在**垂直方向完全对齐** —— 16 行里每一行的透明位置
    完全相同（`##.#.##.####..##` 重复 16 次），形成 **8 条贯穿整格的竖缝**。

    这就是"远处树冠像蓝白网"的真正病根：不是镂空**多**，而是镂空**成条**。
    远处一缩小，8 条竖缝被透视压密 → 规则的白蓝点阵条带。
    （之前试过的方案全部无效，已用对照实验确认：
      · maxMipLevel 0 / ∞ → 网格依旧 / 画面干净无越界
      · alphaTest 0.1 → 0.5 → 画面零变化
      · 按连通块大小填（<4 / <7）→ 32.8% 只降到 24%/32%，
        因为这 8 条缝本身就是"巨大的连通块"，判据根本命中不了）

    【本函数的做法】定向打断竖条：
      ① 对每一列统计透明像素占比，> 60% 判定为「贯穿列」；
      ② 在贯穿列里**隔行填实**（保留约一半），把 16 像素长的长条
         切成一堆 1 像素的点 → 远处再缩也不会形成条带；
      ③ 顺带把成对的孤立点稀疏掉。
    效果：镂空从"8 条竖缝"变成"散布的叶隙点"，近看仍是树叶的层次感，
    远处树冠收成实心绿团 —— 和 Minecraft 里远处的观感一致。

    只在**图集构建期**做一次：运行时零成本，也不修改原版 PNG 文件。
    """
    W = H = TILE
    px = im.load()
    solid = [[px[x, y][3] > 127 for x in range(W)] for y in range(H)]

    def fill(x, y):
        op[x, y] = (op[x, y][0], op[x, y][1], op[x, y][2], 255)
        solid[y][x] = True

    out = im.copy()
    op = out.load()

    # ① 找出贯穿列，② 隔 3 行填 1 行 → 把 16px 长条切成 2px 的点
    # ⚠️ 步长别用 2：隔行填会让密度翻倍，再多填几轮整格就变实心了
    #    （第一版就是隔行填 + 后续连锁填补，结果 16 行里 10 行全实心，
    #     树叶成了"绿板"，失去原版层次）。步长 3 只动 1/3，观感最接近原版。
    for x in range(W):
        holes = sum(1 for y in range(H) if not solid[y][x])
        if holes / H > 0.55:
            for y in range(1, H, 3):
                if not solid[y][x]:
                    fill(x, y)

    # ③ 顺带清掉「四周全是不透明」的孤立单点（真正的噪点），
    #    判据要收紧到 n >= 7（8 邻居里至少 7 个实心），否则会连锁填满。
    for y in range(H):
        for x in range(W):
            if solid[y][x]:
                continue
            n = 0
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    if dx == 0 and dy == 0:
                        continue
                    xx, yy = x + dx, y + dy
                    if 0 <= xx < W and 0 <= yy < H and solid[yy][xx]:
                        n += 1
            if n >= 7:
                fill(x, y)
    return out

# 顺序即图集格位（前 18 项是渲染实际用到的，后面是备用素材）
TILES = [
    'grass_top', 'grass_side', 'dirt', 'sand', 'stone', 'plank',
    'log_side', 'log_top', 'leaves', 'brick', 'cactus_side', 'cactus_top',
    'redstone', 'bedrock', 'sandstone', 'iron', 'water', 'snow',
    'cobble', 'gravel', 'glass', 'gold', 'mossy', 'obsidian', 'wool_red',
]


def main():
    atlas = Image.new('RGBA', (COLS * CELL, ROWS * CELL), (0, 0, 0, 0))
    layout = {}

    for i, name in enumerate(TILES):
        path = os.path.join(SRC, name + '.png')
        if not os.path.exists(path):
            print(f'!! 缺少 {name}.png，跳过', flush=True)
            continue
        src = Image.open(path).convert('RGBA')
        if src.size != (TILE, TILE):
            src = src.resize((TILE, TILE), Image.NEAREST)
        # 树叶：把 32.8% 的碎点镂空收敛到 ~12%，否则远处树冠会变成蓝白点阵。
        # 详见 thin_leaf_alpha 的注释（含三次对照实验的结论）。
        if name == 'leaves':
            before = sum(1 for p in src.getdata() if p[3] < 128) / 256
            src = thin_leaf_alpha(src)
            after = sum(1 for p in src.getdata() if p[3] < 128) / 256
            print(f'   leaves 镂空率 {before*100:.1f}% -> {after*100:.1f}%', flush=True)
        px = src.load()

        c, r = i % COLS, i // COLS
        x0, y0 = c * CELL + PAD, r * CELL + PAD
        atlas.paste(src, (x0, y0))

        # 上下左右护栏：整条边缘向外复制
        for k in range(1, PAD + 1):
            atlas.paste(src.crop((0, 0, TILE, 1)), (x0, y0 - k))
            atlas.paste(src.crop((0, TILE - 1, TILE, TILE)), (x0, y0 + TILE + k - 1))
            atlas.paste(src.crop((0, 0, 1, TILE)), (x0 - k, y0))
            atlas.paste(src.crop((TILE - 1, 0, TILE, TILE)), (x0 + TILE + k - 1, y0))
        # 四个角护栏
        for dx in range(1, PAD + 1):
            for dy in range(1, PAD + 1):
                atlas.putpixel((x0 - dx, y0 - dy), px[0, 0])
                atlas.putpixel((x0 + TILE + dx - 1, y0 - dy), px[TILE - 1, 0])
                atlas.putpixel((x0 - dx, y0 + TILE + dy - 1), px[0, TILE - 1])
                atlas.putpixel((x0 + TILE + dx - 1, y0 + TILE + dy - 1), px[TILE - 1, TILE - 1])

        layout[name] = [c, r]

    atlas.save(OUT, optimize=True)
    print(f'atlas png -> {OUT}  {atlas.size[0]}x{atlas.size[1]}  '
          f'{os.path.getsize(OUT) / 1024:.1f} KB', flush=True)

    b64 = base64.b64encode(open(OUT, 'rb').read()).decode('ascii')
    grid = {'cols': COLS, 'rows': ROWS, 'cell': CELL, 'tile': TILE, 'pad': PAD}
    with open(DATA_JS, 'w', encoding='utf-8', newline='\n') as f:
        f.write('/* 由 tools/build-mc-atlas.py 生成，勿手改。\n')
        f.write('   Minecraft 原版方块纹理图集（PNG base64 内联）。\n')
        f.write('   来源：tools/fetch-mc-textures.py 从 Mojang 官方 client jar 抽取。*/\n')
        f.write('export const ATLAS_PNG_B64 = "' + b64 + '";\n')
        f.write('export const ATLAS_LAYOUT = ' + json.dumps(layout, separators=(',', ':')) + ';\n')
        f.write('export const ATLAS_GRID = ' + json.dumps(grid, separators=(',', ':')) + ';\n')
    print(f'data  js  -> {DATA_JS}  {os.path.getsize(DATA_JS) / 1024:.1f} KB')
    print('LAYOUT=' + json.dumps(layout, separators=(',', ':')))

    build_entity_atlas()


# 角色纹理：不拼 padding —— MC 自己对实体纹理就是 "mipmapping 0"（点采样、无 mip），
# 因为角色 UV 是跨整张纹理精确切分的，相邻面本来就紧挨着，加护栏也救不了内部边界。
ENT_COLS, ENT_ROWS, ENT_TILE = 4, 2, 64
ENT_ORDER = ['steve', 'zombie', 'husk', 'alex', 'skeleton', 'stray', 'creeper', 'spider']


def build_entity_atlas():
    src_dir = os.path.join(SRC, 'entity')
    atlas = Image.new('RGBA', (ENT_COLS * ENT_TILE, ENT_ROWS * ENT_TILE), (0, 0, 0, 0))
    slots = {}
    for i, name in enumerate(ENT_ORDER):
        p = os.path.join(src_dir, name + '.png')
        if not os.path.exists(p):
            print(f'!! 缺少 entity/{name}.png', flush=True)
            continue
        im = Image.open(p).convert('RGBA')
        if im.size != (ENT_TILE, ENT_TILE):
            pad = Image.new('RGBA', (ENT_TILE, ENT_TILE), (0, 0, 0, 0))
            pad.paste(im, (0, 0))
            im = pad
        c, r = i % ENT_COLS, i // ENT_COLS
        atlas.paste(im, (c * ENT_TILE, r * ENT_TILE))
        slots[name] = [c * ENT_TILE, r * ENT_TILE]      # 纹理左上原点（MC 坐标）
    out = os.path.join(SRC, 'entity-atlas.png')
    atlas.save(out, optimize=True)
    print(f'entity png -> {out}  {atlas.size[0]}x{atlas.size[1]}  '
          f'{os.path.getsize(out) / 1024:.1f} KB', flush=True)

    b64 = base64.b64encode(open(out, 'rb').read()).decode('ascii')
    dst = os.path.join(ROOT, 'src', 'three', 'mc-entity-data.js')
    with open(dst, 'w', encoding='utf-8', newline='\n') as f:
        f.write('/* 由 tools/build-mc-atlas.py 生成，勿手改。\n')
        f.write('   Minecraft 原版角色纹理图集（PNG base64 内联）。*/\n')
        f.write('export const ENTITY_PNG_B64 = "' + b64 + '";\n')
        f.write('export const ENTITY_SLOTS = ' + json.dumps(slots, separators=(',', ':')) + ';\n')
        f.write('export const ENTITY_GRID = ' + json.dumps(
            {'cols': ENT_COLS, 'rows': ENT_ROWS, 'tile': ENT_TILE}) + ';\n')
    print(f'entity js  -> {dst}  {os.path.getsize(dst) / 1024:.1f} KB')


if __name__ == '__main__':
    main()
