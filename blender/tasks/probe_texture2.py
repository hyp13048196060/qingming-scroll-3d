"""
贴图通路探针 2 —— 上一轮的 `Q1c` 解出来是全黑,但当时**两个仪器同时在
场**:"我的 PNG 解码器写错了"和"图里的像素根本没写进去"都会给出全黑。
先把这个岔口拆开。

四个变体,每一步都比对:

  A  写 → 立刻在内存里读回        → 检验写入本身
  B  写 → 存 PNG → 用我的解码器解   → 检验**解码器**
  C  写 → 设 colorspace → 存 PNG    → colorspace 赋值会不会清缓冲
  D  写 → pack() → 导出 GLB → 解    → 检验导出通路

⚠️ 判据是"哪一步开始不对",不是"最终对不对"。所以每一步都留读数。
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import bpy
import numpy as np

BLENDER_DIR = Path(__file__).resolve().parents[1]
if str(BLENDER_DIR) not in sys.path:
    sys.path.insert(0, str(BLENDER_DIR))

sys.path.insert(0, str(BLENDER_DIR / "tasks"))
from probe_texture import _glb_image_bytes, _png_rgb  # noqa: E402

OUT = BLENDER_DIR / "out"
LOG: list[str] = []


def say(s: str) -> None:
    LOG.append(s)
    print(s)


VALS = [0.25, 0.50, 0.75, 1.00]
WANT = [int(round(v * 255)) for v in VALS]


def mk(name: str) -> bpy.types.Image:
    a = np.zeros((1, 4, 4), dtype=np.float32)
    for i, v in enumerate(VALS):
        a[0, i, :3] = v
    a[0, :, 3] = 1.0
    img = bpy.data.images.new(name, width=4, height=1, alpha=False)
    img.pixels.foreach_set(a.reshape(-1))
    img.update()
    return img


def read_back(img: bpy.types.Image) -> list[int]:
    b = np.empty(4 * 1 * 4, dtype=np.float32)
    img.pixels.foreach_get(b)
    b = b.reshape(1, 4, 4)
    return [int(round(float(b[0, i, 0]) * 255)) for i in range(4)]


def save_decode(img: bpy.types.Image, tag: str) -> list[int]:
    p = OUT / f"_tx2_{tag}.png"
    img.filepath_raw = str(p)
    img.file_format = "PNG"
    img.save()
    _w, _h, px = _png_rgb(p.read_bytes())
    return [px[0][x][0] for x in range(_w)]


def main() -> int:
    say("=" * 64)
    say(f"目标像素(R) = {WANT}   ← 即 round(v×255)")
    say("=" * 64)

    # —— A:写入本身 ——
    a = mk("tx2_a")
    say(f"A  写后内存读回      : {read_back(a)}")

    # —— B:存 PNG + 我的解码器(不碰 colorspace)——
    b = mk("tx2_b")
    say(f"B  存PNG→解码        : {save_decode(b, 'b')}")

    # —— C:设 colorspace 之后再存 ——
    c = mk("tx2_c")
    c.colorspace_settings.name = "sRGB"
    say(f"C1 设sRGB后内存读回  : {read_back(c)}")
    say(f"C2 设sRGB后存PNG→解码: {save_decode(c, 'c')}")

    # —— D:pack + 导出 GLB + 解 ——
    import bmesh

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)

    d = mk("tx2_d")
    say(f"D1 pack前内存读回    : {read_back(d)}")
    d.colorspace_settings.name = "sRGB"
    d.pack()
    say(f"D2 pack后内存读回    : {read_back(d)}")

    mat = bpy.data.materials.new("tx2_mat")
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = d
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])

    me = bpy.data.meshes.new("tx2_mesh")
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=1.0)
    uvl = bm.loops.layers.uv.new("UVMap")
    for f in bm.faces:
        for i, lp in enumerate(f.loops):
            lp[uvl].uv = ((0, 0), (1, 0), (0, 1), (1, 1))[i]
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("tx2_plane", me)
    bpy.context.scene.collection.objects.link(ob)
    ob.data.materials.append(mat)

    out = OUT / "_tx2.glb"
    bpy.ops.export_scene.gltf(filepath=str(out), export_format="GLB",
                              export_image_format="AUTO", export_apply=False)
    png, js = _glb_image_bytes(out)
    gw, gh, px = _png_rgb(png)
    got = [px[0][x][0] for x in range(gw)]
    say(f"D3 GLB 内解出        : {got}  (图 {gw}x{gh}, "
        f"mime={js['images'][0].get('mimeType')})")
    say(f"   把 GLB 里的字节直接存盘以便外面对照:out/_tx2_fromglb.png")
    (OUT / "_tx2_fromglb.png").write_bytes(png)

    # —— E:把 colorspace 挪到**写像素之前** ——
    #
    # C1 已经定位到病灶:对一张"生成图"(没有文件来源)赋
    # `colorspace_settings.name`,Blender 会**重建缓冲**,把刚写进去的
    # 像素清成 0。这不是 pack 的错、也不是导出器的错 —— D1(赋值前)
    # 还是好的,D2(赋值后)就空了,而 C 里根本没用 pack。
    #
    # 那么"先设色彩空间、再写像素"应当就是对的。这一条是**验证这个
    # 修法成立**,而不是把 C 的结论当结论收下 —— 本项目栽过的正是
    # "诊断对了、修法没验"。
    say("")
    say("=" * 64)
    say("E  先设 colorspace,再写像素")
    say("=" * 64)
    ea = np.zeros((1, 4, 4), dtype=np.float32)
    for i, v in enumerate(VALS):
        ea[0, i, :3] = v
    ea[0, :, 3] = 1.0
    e = bpy.data.images.new("tx2_e", width=4, height=1, alpha=False)
    e.colorspace_settings.name = "sRGB"          # ← 先
    e.pixels.foreach_set(ea.reshape(-1))         # ← 后
    e.update()
    say(f"E1 写后内存读回      : {read_back(e)}")
    e.pack()
    say(f"E2 pack后内存读回    : {read_back(e)}")
    say(f"E3 存PNG→解码        : {save_decode(e, 'e')}")

    say("")
    say("=" * 64)
    say("结论")
    say("=" * 64)
    say(f"  E 先设色彩空间后写   : {read_back(e) == WANT}")
    say(f"  A 写入 OK           : {read_back(mk('tx2_a2')) == WANT}")
    say(f"  B 解码器 OK         : {save_decode(mk('tx2_b2'), 'b2') == WANT}")
    say(f"  D 导出通路 OK       : {got == WANT}")
    say(f"  GLB 图字节数        : {len(png)}")

    (OUT / "_texprobe2.log").write_text("\n".join(LOG), encoding="utf-8")
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
