#!/usr/bin/env python3
"""从 Mojang 官方 client jar 抽取 Minecraft 原版方块纹理。

用法： python tools/fetch-mc-textures.py
输出： assets/mc/<name>.png（16x16 原图，带 alpha）

为什么走官方 jar 而不是第三方仓库：
  client jar 里的 assets/minecraft/textures/block/*.png 就是游戏实际使用的原图，
  分辨率、调色板、镂空 alpha 全部一致，不存在第三方资源包二次改色的偏差。
"""
import io
import json
import os
import sys
import urllib.request
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), 'assets', 'mc')
# 角色（entity）纹理：不是 16×16 方块图，单独放一个目录，每个模型用自己一张。
ENT_OUT = os.path.join(OUT, 'entity')
ENT_WANT = {
    'steve': 'entity/player/wide/steve.png',
    'alex': 'entity/player/slim/alex.png',
    'zombie': 'entity/zombie/zombie.png',
    'husk': 'entity/zombie/husk.png',
    'skeleton': 'entity/skeleton/skeleton.png',
    'stray': 'entity/skeleton/stray.png',
    'creeper': 'entity/creeper/creeper.png',
    'spider': 'entity/spider/spider.png',
}

MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'

# 需要的纹理： 输出名 -> jar 内路径（相对 assets/minecraft/textures/block/）
WANT = {
    'grass_top': 'grass_block_top.png',
    'grass_side': 'grass_block_side.png',
    'dirt': 'dirt.png',
    'sand': 'sand.png',
    'sandstone': 'sandstone.png',
    'stone': 'stone.png',
    'cobble': 'cobblestone.png',
    'plank': 'oak_planks.png',
    'log_side': 'oak_log.png',
    'log_top': 'oak_log_top.png',
    'leaves': 'oak_leaves.png',
    'brick': 'bricks.png',
    'cactus_side': 'cactus_side.png',
    'cactus_top': 'cactus_top.png',
    'redstone': 'redstone_block.png',
    'bedrock': 'bedrock.png',
    'iron': 'iron_block.png',
    'water': 'water_still.png',
    'gravel': 'gravel.png',
    'snow': 'snow.png',
    'obsidian': 'obsidian.png',
    'gold': 'gold_block.png',
    'mossy': 'mossy_cobblestone.png',
    'glass': 'glass.png',
    'wool_red': 'red_wool.png',
}


def get(url, binary=False):
    req = urllib.request.Request(url, headers={'User-Agent': 'blockwild/1.0'})
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read()
    return raw if binary else json.loads(raw.decode('utf-8'))


def main():
    os.makedirs(OUT, exist_ok=True)
    print('[1/4] 拉取版本清单 …', flush=True)
    man = get(MANIFEST)
    latest = man['latest']['release']
    ver = next(v for v in man['versions'] if v['id'] == latest)
    print(f'      最新版本 {latest}', flush=True)

    print('[2/4] 解析 client jar 地址 …', flush=True)
    vj = get(ver['url'])
    client = vj['downloads']['client']['url']

    print('[3/4] 下载 client jar（约 20~30MB）…', flush=True)
    jar = get(client, binary=True)
    print(f'      {len(jar) / 1048576:.1f} MB', flush=True)

    z = zipfile.ZipFile(io.BytesIO(jar))
    prefix = 'assets/minecraft/textures/block/'
    have = set(n[len(prefix):] for n in z.namelist() if n.startswith(prefix))
    print(f'      jar 内方块纹理 {len(have)} 张', flush=True)

    print('[4/4] 提取 …', flush=True)
    ok, miss = 0, []
    for out_name, src in WANT.items():
        if src not in have:
            # 1.21+ 把 grass_block_top 等都还在；真缺了就退到同族纹理
            alt = src.replace('oak_', '').replace('_side', '')
            if alt in have:
                src = alt
            else:
                miss.append(out_name)
                continue
        data = z.read(prefix + src)
        with open(os.path.join(OUT, out_name + '.png'), 'wb') as f:
            f.write(data)
        ok += 1
        print(f'      {out_name:12s} <- {src}  ({len(data)} B)', flush=True)

    print(f'\n方块纹理：{ok} 张 -> {OUT}')
    if miss:
        print('缺失（jar 里没有）:', ', '.join(miss))

    # ---- 角色纹理（64×64 / 64×32，单独存目录）----
    eprefix = 'assets/minecraft/textures/'
    have_e = set(z.namelist())
    os.makedirs(ENT_OUT, exist_ok=True)
    eok, emiss = 0, []
    for out_name, rel in ENT_WANT.items():
        full = eprefix + rel
        if full not in have_e:
            emiss.append(out_name)
            continue
        data = z.read(full)
        with open(os.path.join(ENT_OUT, out_name + '.png'), 'wb') as f:
            f.write(data)
        eok += 1
        print(f'      [entity] {out_name:9s} <- {rel}  ({len(data)} B)', flush=True)
    print(f'角色纹理：{eok} 张 -> {ENT_OUT}')
    if emiss:
        print('缺失（jar 里没有）:', ', '.join(emiss))

    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
