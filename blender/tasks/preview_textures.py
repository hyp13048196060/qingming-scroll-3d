"""
把 `lib/tex_utils.py` 的每一组图**直接存成 PNG**,供肉眼逐张看。

为什么不让 Blender 渲一张"贴图总览图"
--------------------------------------
WORKBENCH **不求值节点树**(它渲 `diffuse_color`),所以拿它渲贴图
等于什么都没渲;要真渲就得上 EEVEE/CYCLES,那又多出光照、曝光、
相机角度三层变量 —— 而这一轮我要回答的问题只有一个:
**图本身对不对。**

直接存 PNG 是这条链上最短的一步:像素从生成函数出来,经
`_write`(含 flipud),到文件。中间没有渲染器。真要看"贴上去对不对",
那是下一步的事,会渲场景本身。

输出:`blender/out/tex/*.png`(albedo)与 `*_n.png`(法线)。
"""

from __future__ import annotations

import sys
from pathlib import Path

import bpy

BLENDER_DIR = Path(__file__).resolve().parents[1]
# ⚠️ 只放 `blender/`,**不放 `blender/lib`**。
#    放了的话 `import tex_utils`(平铺)与 `from lib import tex_utils`(包)
#    两条路都能走通,而 Python 会把它们当成**两个不同的模块**,各带一份
#    空的 `_CACHE` —— 于是同一种木料被烤两遍,`bpy.data.images` 里多出一批
#    `xxx.001`。两个都是模块级单例,但谁也不知道对方存在。
#    统一走包路径,把这个口子从源头堵上。
if str(BLENDER_DIR) not in sys.path:
    sys.path.insert(0, str(BLENDER_DIR))

import config as C              # noqa: E402
from lib import tex_utils as T  # noqa: E402

OUT = BLENDER_DIR / "out" / "tex"


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    print("=" * 66)
    print(f"程序化贴图打样 — 种子 {C.SEED}")
    print("=" * 66)

    total = 0
    for name, size, label, *rest in C.Texture.KIT:
        # 遮罩类不是高度场,`get_maps` 会拒绝烤它(见 config.Texture.
        # NOT_HEIGHT_FIELD)。但打样仍要把它存出来 —— 我要能亲眼看见
        # 那张遮罩。所以这里单独走一次生成函数,不走 bake。
        if name in C.Texture.NOT_HEIGHT_FIELD:
            import numpy as np

            rng = np.random.default_rng(T._seed_for(name))
            mask = T.height_fn(name)(size, rng)
            rgba = np.ones((size, size, 4), dtype=np.float32)
            rgba[:, :, :3] = mask[:, :, None]
            img = T._new_image(f"tex_{name}_c", size, "Non-Color")
            T._write(img, rgba)
            p = OUT / f"{name}_c.png"
            img.filepath_raw = str(p)
            img.file_format = "PNG"
            img.save()
            total += len(p.read_bytes())
            print(f"  {name:<16} {size:>4}²  {label:<10} "
                  f"**遮罩,非高度场**(未接材质,见 Texture.UNUSED)")
            continue

        # 走 `get_maps` 而不是直接 `bake` —— 种子取那里的 `_seed_for`
        # (zlib.crc32,跨进程稳定)。此前这里用的是 `abs(hash(name))`,
        # 而 CPython 的字符串 hash 带每进程随机盐:同一份代码两次运行
        # 会烤出两张不同的木纹,**不报错、不改三角面数**,只在
        # 包围盒比对上露出浮点级差异。打样脚本尤其不能用它 ——
        # 它存在的意义正是"我看到的这张图就是构建时那张"。
        maps = T.get_maps(name)
        for key, img in maps.items():
            p = OUT / (f"{name}_c.png" if key == "c" else f"{name}_{key}.png")
            img.filepath_raw = str(p)
            img.file_format = "PNG"
            img.save()
            total += len(p.read_bytes())
        print(f"  {name:<16} {size:>4}²  {label:<10} "
              f"{', '.join(sorted(maps))}")

    print("-" * 66)
    print(f"  合计 {total / 1048576:.2f} MB(未压缩 PNG)")
    print(f"  输出 {OUT}")
    print("=" * 66)
    return 0


if __name__ == "__main__":
    import os
    try:
        _c = main()
    except BaseException:
        import traceback
        traceback.print_exc()
        _c = 1
    sys.stdout.flush()
    os._exit(_c)
