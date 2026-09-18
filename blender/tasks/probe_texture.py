"""
贴图通路探针 —— 在写 `lib/tex_utils.py` 之前,先把三个"我以为是这样"
的事实测出来。

为什么值得单独花一次运行
------------------------
本项目归档的失败模式是"症状出在读数上,病灶在仪器上",而贴图这一路
**全是最容易想当然的地方**:色彩空间、像素行序、导出器是否真的把图
打进 GLB。这三件事任何一件猜错,后果都不是报错,而是**渲出来发白发灰**
或者**文件里根本没有图** —— 两种都不会让构建失败,只会让我在别处
找原因。

三个问题
--------
Q1  写进 `Image.pixels` 的数值,与"这张图被当作 sRGB 采样之后的样子"
    是什么关系?我要往里面写的是**已经在 sRGB 空间的比值**(和
    `config.Palette` 同一套口径),那到底该直接写,还是要先转线性?

Q2  像素行序。`foreach_set` 的第一行对应图像的**顶行还是底行**?
    numpy 里 `h[0]` 我按"图像顶部"来生成,若 Blender 认成底行,
    整张图的明暗会上下翻 —— 对称噪声看不出来,车辙、瓦垄这种
    有明显方向的会**整个倒过来**,而且看着像"设计就这样"。

Q3  glTF 导出器是否真的把 Image Texture 打进 GLB?打进去是什么格式、
    多大?——`scene_image` 的 `export_image_format` 计划里写的是 WEBP,
    但那是我从枚举列表里读到的**可选项**,不是"这么做有效"的证据。

输出:`blender/out/_texprobe.json` + 一张肉眼可看的 PNG。
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

OUT = BLENDER_DIR / "out"
LOG: list[str] = []


def say(s: str) -> None:
    LOG.append(s)
    print(s)


# --------------------------------------------------------------------------
# Q1 + Q2:写一个"四个角四种颜色 + 上半黑下半白"的图,读回来对
# --------------------------------------------------------------------------
def probe_pixels() -> dict:
    """
    构造一张 8×8 的图:

        · 上半(行 0..3)= 0.25,下半(行 4..7)= 0.75
          → 用来定**行序**:读回来的哪一半是 0.25
        · 左上角单像素 = 1.0  → 用来定**左右**不会翻

    然后把这个 numpy 数组 `foreach_set` 进去,再 `foreach_get` 出来,
    逐值比对 —— 如果 round-trip 是恒等的,那 Blender 没有在
    `pixels` 这一层做任何色彩变换,数值可以**直接写**。
    """
    w = h = 8
    img = bpy.data.images.new("probe_px", width=w, height=h, alpha=False)
    say(f"新图:{img.name} size={img.size[0]}x{img.size[1]} "
        f"depth={img.depth} is_float={img.is_float} "
        f"colorspace={img.colorspace_settings.name!r}")

    # 我做一张"图像坐标"的数组:h[0] = 图像**顶部**
    a = np.full((h, w, 4), 0.25, dtype=np.float32)
    a[h // 2:, :, :3] = 0.75          # 下半更亮
    a[0, 0, :3] = 1.0                 # 左上角全白
    a[:, :, 3] = 1.0

    img.pixels.foreach_set(a.reshape(-1))
    img.update()

    back = np.empty(h * w * 4, dtype=np.float32)
    img.pixels.foreach_get(back)
    back = back.reshape(h, w, 4)

    diff = float(np.max(np.abs(back - a)))
    say(f"Q1 round-trip 最大逐值差 = {diff:.9f}(0 表示 pixels 不改变数值)")

    # 行序:读回来第 0 行应该是 0.25(顶),第 7 行是 0.75(底)
    top_v = float(back[0, 1, 0])      # 避开角上的 1.0
    bot_v = float(back[h - 1, 1, 0])
    say(f"Q2 行序:read[0,1]={top_v:.4f}  read[{h-1},1]={bot_v:.4f}")
    row_order = "index0=图像顶部(与我生成时一致)" if top_v < bot_v else \
                "index0=图像底部(**需要 flipud**)"

    # 再测一次:如果换成 float_buffer=True 会怎样(法线图可能想走高精度)
    imgf = bpy.data.images.new("probe_pxf", width=w, height=h, alpha=False,
                               float_buffer=True)
    imgf.pixels.foreach_set(a.reshape(-1))
    imgf.update()
    backf = np.empty(h * w * 4, dtype=np.float32)
    imgf.pixels.foreach_get(backf)
    df = float(np.max(np.abs(backf.reshape(h, w, 4) - a)))
    say(f"Q1b float_buffer=True 的最大逐值差 = {df:.9f}")
    say(f"     注意 float 图的 colorspace 默认 = "
        f"{imgf.colorspace_settings.name!r}")

    return {
        "roundtrip_maxdiff": diff,
        "float_roundtrip_maxdiff": df,
        "row_order": row_order,
        "float_default_colorspace": imgf.colorspace_settings.name,
        "new_image_default_colorspace": img.colorspace_settings.name,
    }


# --------------------------------------------------------------------------
# Q3:把一张图接进材质,导出 GLB,看它到底在不在里面
# --------------------------------------------------------------------------
def probe_export() -> dict:
    import bmesh

    # 清干净
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)

    w = 64
    img = bpy.data.images.new("probe_alb", width=w, height=w, alpha=False)
    g = np.linspace(0.1, 0.9, w, dtype=np.float32)
    a = np.repeat(g[None, :, None], w, axis=0).repeat(4, axis=2)
    a[:, :, 3] = 1.0
    img.pixels.foreach_set(a.reshape(-1))
    img.update()
    img.colorspace_settings.name = "sRGB"
    img.pack()

    mat = bpy.data.materials.new("probe_mat")
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    # UV 从哪来:现在还没有 UV 层。先建一个带 UV 的平面,才谈得上贴图。
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])

    me = bpy.data.meshes.new("probe_plane")
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=1.0)
    uv_layer = bm.loops.layers.uv.new("UVMap")
    for f in bm.faces:
        for i, loop in enumerate(f.loops):
            loop[uv_layer].uv = ((0.0, 0.0), (1.0, 0.0), (0.0, 1.0), (1.0, 1.0))[i]
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("probe_plane", me)
    bpy.context.scene.collection.objects.link(ob)
    ob.data.materials.append(mat)

    out = OUT / "_texprobe.glb"
    for fmt in ("WEBP", "AUTO", "PNG"):
        kw = dict(
            filepath=str(out),
            export_format="GLB",
            export_extras=True,
            export_apply=False,
        )
        try:
            bpy.ops.export_scene.gltf(export_image_format=fmt, **kw)
        except TypeError as exc:
            say(f"export_image_format={fmt!r} 被拒:{exc}")
            continue
        raw = out.read_bytes()
        # 直接在 GLB 里找图片块的 mime
        n_img, mimes = _scan_glb_images(raw)
        say(f"export_image_format={fmt!r} → {len(raw)} 字节,"
            f"GLB 内 images 数 = {n_img},mime = {mimes}")
        return {"image_format_ok": fmt, "glb_bytes": len(raw),
                "glb_images": n_img, "mimes": mimes}
    return {"image_format_ok": None}


def _scan_glb_images(raw: bytes) -> tuple[int, list[str]]:
    """
    从 GLB 的 JSON 块里数 images、取 mimeType。

    ⚠️ 不走 `bpy` 重新导回来 —— 那会引入"导入器怎么理解"这一层。
       这里要问的是**文件里到底有没有字节**,所以直接读文件本身。
    """
    import struct

    if raw[:4] != b"glTF":
        return 0, []
    off = 12
    while off < len(raw):
        clen, ctype = struct.unpack_from("<II", raw, off)
        if ctype == 0x4E4F534A:  # JSON
            js = json.loads(raw[off + 8: off + 8 + clen].decode("utf-8"))
            imgs = js.get("images", [])
            return len(imgs), [i.get("mimeType", "?") for i in imgs]
        off += 8 + clen
    return 0, []


# --------------------------------------------------------------------------
# 肉眼:导出一张 PNG,确认方向与明暗"看着对"
# --------------------------------------------------------------------------
def probe_visual() -> str:
    """
    生成一张有明确方向的图并存盘 —— 车辙、瓦垄都是方向性纹理。

    ⚠️ **上一版这里是坏的,而坏法值得记一笔。** 原写法是

            xx = np.arange(w)[None, :]
            hh = 0.5 + 0.5*np.cos(2*np.pi*xx/16.0)   # ← 形状是 (1, w)

      因为 `xx` 只在第二个轴上有长度,`hh` 压根**没有行这一维**;
      后面 `a[:, :, :3] = hh[:, :, None]` 于是把那一行广播到全部 128 行,
      存出来的 PNG **整张纯白**。旁边还留着一个算好了却没用的 `yy` ——
      那正是"我以为它有行维"的痕迹。

      当时的读数是"图是白的",而差一点就被我记成"Blender 存
      `pixels` 写入的生成图有毛病"。**读数荒诞的时候,先怀疑仪器。**
      这里仪器是我自己写的 6 行 numpy。
    """
    w = h = 128
    yy = np.arange(h, dtype=np.float32)[:, None]     # (h, 1) —— 行
    xx = np.arange(w, dtype=np.float32)[None, :]     # (1, w) —— 列
    # 竖条纹(模拟瓦垄/车辙走向),必须**行、列都有长度**才是二维
    hh = np.broadcast_to(0.5 + 0.5 * np.cos(2 * np.pi * xx / 16.0), (h, w)).copy()
    # 只在**顶部** 12 行铺一条亮带 —— 行序若翻了,亮带会跑到图底
    hh[:12, :] = 1.0
    _ = yy  # 保留:说明行轴是怎么来的
    a = np.zeros((h, w, 4), dtype=np.float32)
    a[:, :, :3] = hh[:, :, None]
    a[:, :, 3] = 1.0
    img = bpy.data.images.new("probe_vis", width=w, height=h, alpha=False)
    img.pixels.foreach_set(a.reshape(-1))
    img.update()
    p = OUT / "_texprobe_vis.png"
    img.filepath_raw = str(p)
    img.file_format = "PNG"
    img.save()
    say(f"视觉样本已存:{p.name}(亮带在**图像顶部**;垄为竖条)")
    return p.name


def _png_rgb(data: bytes) -> tuple[int, int, list[list[tuple[int, int, int]]]]:
    """
    解一张 8 位 PNG,返回 (w, h, 像素)。**只用标准库**,不引第三方。

    为什么要自己解:Q1 真正的问题不是"`pixels` 读写一不一致"(那个
    round-trip 已经答了),而是**导出器把什么字节写进了 GLB**。
    要回答它就得把那张图从 GLB 里抠出来、解开、逐字节对 ——
    用 Blender 自己导回来是循环论证(导入器怎么理解是另一层)。
    """
    import struct
    import zlib

    assert data[:8] == b"\x89PNG\r\n\x1a\n", "不是 PNG"
    off, idat, w, h, ct, bd = 8, bytearray(), 0, 0, 0, 0
    while off < len(data):
        ln, typ = struct.unpack_from(">I4s", data, off)
        body = data[off + 8: off + 8 + ln]
        if typ == b"IHDR":
            w, h, bd, ct = struct.unpack_from(">IIBB", body, 0)
        elif typ == b"IDAT":
            idat += body
        elif typ == b"IEND":
            break
        off += 12 + ln
    assert bd == 8, f"只处理 8 位 PNG,这张是 {bd} 位"
    nch = {0: 1, 2: 3, 4: 2, 6: 4}[ct]
    raw = zlib.decompress(bytes(idat))
    stride = w * nch
    out: list[list[tuple[int, int, int]]] = []
    prev = bytearray(stride)
    pos = 0
    for _y in range(h):
        ft = raw[pos]
        pos += 1
        line = bytearray(raw[pos: pos + stride])
        pos += stride
        # 反滤波(PNG 规范 9.2)—— 只用到 None/Sub/Up/Average/Paeth
        for i in range(stride):
            a = line[i - nch] if i >= nch else 0
            b = prev[i]
            c = prev[i - nch] if i >= nch else 0
            if ft == 1:
                line[i] = (line[i] + a) & 0xFF
            elif ft == 2:
                line[i] = (line[i] + b) & 0xFF
            elif ft == 3:
                line[i] = (line[i] + ((a + b) >> 1)) & 0xFF
            elif ft == 4:
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 0xFF
        out.append([tuple(line[x * nch: x * nch + 3]) for x in range(w)])
        prev = line
    return w, h, out


def _glb_image_bytes(path: Path) -> tuple[bytes, dict]:
    """从 GLB 里抠出第一张图的原字节 + JSON。"""
    import struct

    raw = path.read_bytes()
    off, js, bin_ = 12, None, b""
    while off < len(raw):
        clen, ctype = struct.unpack_from("<II", raw, off)
        body = raw[off + 8: off + 8 + clen]
        if ctype == 0x4E4F534A:
            js = json.loads(body.decode("utf-8"))
        elif ctype == 0x004E4942:
            bin_ = body
        off += 8 + clen
    assert js is not None
    iv = js["bufferViews"][js["images"][0]["bufferView"]]
    o = iv.get("byteOffset", 0)
    return bin_[o: o + iv["byteLength"]], js


def probe_bytes() -> dict:
    """
    造一张 4 像素、值精确已知的图,走完整条导出链,再从 GLB 里解出来对。

    判据:存进去的字节 == `round(srgb × 255)`。
      · 全等 → 导出器**原样搬运**字节,我在 `tex_utils` 里可以直接写
        sRGB 比值,three.js 侧用 `SRGBColorSpace` 采样即可;
      · 若解出来是**线性化过**的值(0.25 → 0.05),那说明导出器按
        colorspace 做了转换,三张图的写入口径要整个重定。
    """
    import bmesh

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)

    vals = [0.25, 0.50, 0.75, 1.00]
    w, h = 4, 1
    arr = np.zeros((h, w, 4), dtype=np.float32)
    for i, v in enumerate(vals):
        arr[0, i, :3] = v
    arr[0, :, 3] = 1.0

    img = bpy.data.images.new("probe_bytes", width=w, height=h, alpha=False)
    img.pixels.foreach_set(arr.reshape(-1))
    img.update()
    img.colorspace_settings.name = "sRGB"
    img.pack()

    mat = bpy.data.materials.get("probe_mat") or bpy.data.materials.new("probe_mat")
    nt = mat.node_tree
    for n in list(nt.nodes):
        if n.type == "TEX_IMAGE":
            nt.nodes.remove(n)
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = img
    nt.links.new(tex.outputs["Color"], bsdf.inputs["Base Color"])

    me = bpy.data.meshes.new("probe_plane2")
    bm = bmesh.new()
    bmesh.ops.create_grid(bm, x_segments=1, y_segments=1, size=1.0)
    uvl = bm.loops.layers.uv.new("UVMap")
    for f in bm.faces:
        for i, lp in enumerate(f.loops):
            lp[uvl].uv = ((0, 0), (1, 0), (0, 1), (1, 1))[i]
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new("probe_plane2", me)
    bpy.context.scene.collection.objects.link(ob)
    ob.data.materials.append(mat)

    out = OUT / "_texprobe_bytes.glb"
    # ⚠️ `export_image_format` 的合法值实测只有
    #    ('AUTO', 'JPEG', 'WEBP', 'NONE') —— **没有 'PNG'**。
    #    计划里写的回退方案"normal/rough 单独小尺寸 PNG"因此不是
    #    一个能在这个开关上表达的选项;要 PNG 只能靠 'AUTO'
    #    (它保留已打包 PNG 的原格式),而 JPEG/WebP 是**全局**的,
    #    做不到按图分别指定。按图分别转格式留给网页侧的
    #    `tools/optimize_assets.mjs`(gltf-transform),那里是按图操作的。
    bpy.ops.export_scene.gltf(filepath=str(out), export_format="GLB",
                              export_image_format="AUTO", export_apply=False)

    png, js = _glb_image_bytes(out)
    gw, gh, px = _png_rgb(png)
    got = [px[0][x][0] for x in range(gw)]
    want = [int(round(v * 255)) for v in vals]
    say(f"Q1c 导出后逐像素对:期望 {want} / 实得 {got} "
        f"(图 {gw}x{gh},mime={js['images'][0].get('mimeType')})")
    return {"png_bytes_expected": want, "png_bytes_got": got,
            "png_exact": got == want}


def main() -> int:
    res: dict = {}
    say("=" * 66)
    say("Q1/Q2  像素存取与行序")
    say("=" * 66)
    res.update(probe_pixels())
    say("")
    say("=" * 66)
    say("Q3     导出器是否把图打进 GLB")
    say("=" * 66)
    res.update(probe_export())
    say("")
    res["visual"] = probe_visual()
    say("")
    say("=" * 66)
    say("Q1c    导出后字节是否原样")
    say("=" * 66)
    res.update(probe_bytes())
    say("")
    say("=" * 66)
    say("结论")
    say("=" * 66)
    say(f"  行序(由 PNG 目视定)  :见 _texprobe_vis.png —— 亮带在顶则 index0=顶")
    say(f"  导出可用格式         :{res.get('image_format_ok')}")
    say(f"  GLB 内图片           :{res.get('glb_images')} {res.get('mimes')}")
    say(f"  导出字节原样         :{res.get('png_exact')}")

    (OUT / "_texprobe.json").write_text(
        json.dumps(res, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT / "_texprobe.log").write_text("\n".join(LOG), encoding="utf-8")
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
