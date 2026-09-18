"""
程序化贴图 —— 一次高度场,派生 albedo / normal / roughness 三张图。

为什么是程序化,而不是找素材
----------------------------
用户的两条硬约束交汇在这里:"软件和素材费用为零",以及"联网只用于
核对资料和获取免费依赖、开放授权素材,记录来源与许可"。
程序化生成同时满足两者:零费用、零许可风险、零体积(图在构建时算出来,
不随源码走),而且**可复现** —— 同一个种子永远得到同一张图,
这与本项目"统计量可复现"的要求一致。

三条硬规则(全部是**实测**出来的,不是照着文档抄的)
--------------------------------------------------
实测脚本见 `tasks/probe_texture.py` 与 `tasks/probe_texture2.py`,
结论落在 `blender/out/_texprobe*.json`。

1. **必须先设 `colorspace_settings.name`,再写像素。**
   对一张生成图(没有文件来源)赋值色彩空间,Blender 会重建缓冲,
   把刚写进去的像素**清成 0**。实测:

        write → read_back            = [64,128,191,255]   ✓
        write → set colorspace → read = [0,0,0,0]         ✗
        set colorspace → write → read = [64,128,191,255]  ✓

   这个坑的可怕之处在于它**不报错**:导出的是一张合法的全黑 PNG,
   构建一路绿灯,只有渲出来发现"这块木头怎么是黑的"。
   我第一遍正是读到了"导出后全黑"这个读数,而当时差一点把它记成
   "Blender 导出器丢像素" —— 真因是赋值顺序。

2. **像素行序自下而上,numpy 侧要 `np.flipud`。**
   实测:我把亮带写在数组的第 0..11 行(按"图像顶部"理解),
   存出来的 PNG 亮带在**第 116..127 行**(底部)。
   `y=0 平均灰度 127.5(条纹) / y=116..127 平均灰度 255.0(亮带)`。

   ⚠️ 这一条**不能**用"写进去再读回来"来验证 —— 那个 round-trip
      是自洽的,无论行序朝哪边都对得上。我第一版探针就是拿
      round-trip 下的结论,写下了"index0=图像顶部",**是错的**。
      只有把图存成 PNG 再从外部解出来才问得出这个问题。

3. **尺寸上限 2048²,默认 1024²。**
   `pixels.foreach_set` 的中间数组是 `W·H·4·4` 字节;4096² 单张
   就是 256MB 峰值内存,且 4096² RGBA8 = 64MB 显存。
   仅"土路车辙""绢本"这类需要大面积不重复的用 2048²。

色彩空间
--------
albedo 走 `sRGB`,normal / roughness / mask 一律 `Non-Color`。
"发白发灰"的头号原因就是把法线图当 sRGB 采样了。

实测确认过导出通路**原样搬运字节**(导出后 PNG 里逐像素与写入值相等),
所以写入时直接给 **sRGB 比值**即可 —— 与 `config.Palette` 同一套口径,
不需要事先手工线性化。
"""

from __future__ import annotations

import math
from typing import Callable

import bpy
import numpy as np

import config as C

# --------------------------------------------------------------------------
# 图集清单 —— 与 config.Texture.KIT 对应
#
# 每项:(名字, 边长, 中文说明, 高度场生成函数名)
# 生成函数在本文件 `_H` 表里。**只登记实现了的**,没实现的走
# validate 的 skip,而不是在这里留一个假名字。
# --------------------------------------------------------------------------

MAX_SIZE = 2048
DEFAULT_SIZE = 1024


# ==========================================================================
# 噪声
#
# 全部**可平铺**。这一条不是讲究:这些图要按世界坐标重复铺满整条街、
# 整个屋面,一旦不可平铺,每块砖的接缝上都会出现一道硬边,
# 而那道边在渲染图上会被读成"这里有一根线",于是我会去几何里找
# 一根不存在的线。
# ==========================================================================


def _value_noise(size: int, rng: np.random.Generator, freq: int) -> np.ndarray:
    """
    可平铺的值噪声:在 freq×freq 的格子上取随机值,周期性地双线性上采样。

    ⚠️ 上采样时**索引要取模 freq**(`i1 = (i0+1) % freq`),这就是
       平铺的全部秘密。少了这个取模,右边缘与左边缘对不上,
       铺出来是一条缝。
    """
    g = rng.random((freq, freq)).astype(np.float32)
    t = (np.arange(size, dtype=np.float32) + 0.5) * freq / size
    i0 = np.floor(t).astype(np.int32) % freq
    i1 = (i0 + 1) % freq
    f = t - np.floor(t)
    f = f * f * (3.0 - 2.0 * f)          # smoothstep,避免菱形网格纹

    fx = f[None, :]
    fy = f[:, None]
    g00 = g[np.ix_(i0, i0)]
    g01 = g[np.ix_(i0, i1)]
    g10 = g[np.ix_(i1, i0)]
    g11 = g[np.ix_(i1, i1)]
    top = g00 * (1.0 - fx) + g01 * fx
    bot = g10 * (1.0 - fx) + g11 * fx
    return (top * (1.0 - fy) + bot * fy).astype(np.float32)


def fbm(
    size: int,
    rng: np.random.Generator,
    octaves: int = 4,
    base: int = 2,
    gain: float = 0.5,
) -> np.ndarray:
    """分形叠加:base, 2·base, 4·base … 各一层,振幅按 gain 递减。"""
    out = np.zeros((size, size), dtype=np.float32)
    amp, norm, freq = 1.0, 0.0, base
    for _ in range(octaves):
        out += amp * _value_noise(size, rng, freq)
        norm += amp
        amp *= gain
        freq = min(freq * 2, size)
    return out / max(norm, 1e-6)


def _blur3(a: np.ndarray) -> np.ndarray:
    """3×3 盒式模糊,x/y 都环绕 —— 保持可平铺。"""
    s = np.zeros_like(a)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            s += np.roll(np.roll(a, dy, axis=0), dx, axis=1)
    return s / 9.0


# ==========================================================================
# 高度场 → 三张图
# ==========================================================================


def height_to_normal(h: np.ndarray, strength: float) -> np.ndarray:
    """
    高度场 → 切向空间法线图(RGB)。

    `strength` = **目标平均坡度**(tan),不是"手感系数"。

    ⚠️ 这个参数的定义改过一次,原因值得写下来。
       第一版是 `nx = -dzdx · strength · size · 0.5`,直接把逐像素梯度
       乘上图像边长。它有两个毛病:

       ① **数量级不听使唤。** 本项目的纹理都是"按图像尺寸的比例"
          定义的(一条垄 = size/10 像素),于是逐像素梯度 ≈ 20/size,
          乘上 size 之后**分辨率被约掉,只剩一个 20** —— 这个 20
          再乘上 0.85 的"手感系数"就是 17,法线几乎躺平。
          渲出来屋面会像悬崖,而不是瓦垄。真正的问题是我给
          `config.Texture.NORMAL` 写的那组 0.3~0.9 **没有一个是对的**,
          而它们看着都挺合理。

       ② **含义不可解释。** "0.85" 到底该是多大,没有任何办法判断,
          只能靠一张张试。

       改成按**梯度自身的 RMS 归一**之后,`strength` 有了明确的
       意思:"整张图的平均坡度是 tan⁻¹(strength)"。于是
          · 它与分辨率无关(换 512² 还是 2048² 结果一样);
          · 它与纹理自身的起伏幅度无关(fbm 幅度变了也不用重调);
          · 数值可以直接读:`0.20` 就是平均 11° 的坡。

       代价是**低起伏的纹理会被放大到同样的平均坡度** —— 绢本
       本该比瓦垄平得多。所以它靠 `strength` 自己区分(绢本给 0.02),
       而不是靠归一化区分。
    """
    dzdx = (np.roll(h, -1, axis=1) - np.roll(h, 1, axis=1)) * 0.5
    dzdy = (np.roll(h, -1, axis=0) - np.roll(h, 1, axis=0)) * 0.5
    g = np.sqrt(dzdx * dzdx + dzdy * dzdy)
    rms = float(np.sqrt(np.mean(g * g))) + 1e-9
    k = strength / rms
    nx = -dzdx * k
    ny = -dzdy * k
    nz = np.ones_like(h)
    ln = np.sqrt(nx * nx + ny * ny + nz * nz)
    out = np.empty((h.shape[0], h.shape[1], 4), dtype=np.float32)
    out[:, :, 0] = nx / ln * 0.5 + 0.5
    out[:, :, 1] = ny / ln * 0.5 + 0.5
    out[:, :, 2] = nz / ln * 0.5 + 0.5
    out[:, :, 3] = 1.0
    return out


def _gray(a: np.ndarray) -> np.ndarray:
    """(h,w) → (h,w,4) 灰度 RGBA。"""
    out = np.empty((a.shape[0], a.shape[1], 4), dtype=np.float32)
    out[:, :, 0] = out[:, :, 1] = out[:, :, 2] = a
    out[:, :, 3] = 1.0
    return out


# ==========================================================================
# 写图
# ==========================================================================


def _new_image(name: str, size: int, colorspace: str) -> bpy.types.Image:
    """
    建图并**先设色彩空间**。

    ⚠️ 顺序是硬规则 1,见模块文档。先写像素再设色彩空间 = 一张全黑图。
    """
    img = bpy.data.images.new(name, width=size, height=size, alpha=False)
    img.colorspace_settings.name = colorspace
    return img


def _write(img: bpy.types.Image, arr: np.ndarray) -> None:
    """
    把 (h,w,4) 的 0..1 float32 写进图。

    ⚠️ `np.flipud` 是硬规则 2:Blender 的像素缓冲**自下而上**,
       而本项目所有生成函数都按"数组第 0 行 = 图像顶部"来想事情。
       漏掉这一步,车辙会上下颠倒、瓦垄会横竖颠倒 —— 而且
       **看着像是"设计成这样"**,不会报错。
    """
    h, w = arr.shape[0], arr.shape[1]
    if img.size[0] != w or img.size[1] != h:
        raise ValueError(f"{img.name}: 图是 {tuple(img.size)},数组是 {(w, h)}")
    flat = np.ascontiguousarray(np.flipud(arr)).reshape(-1)
    img.pixels.foreach_set(flat.astype(np.float32))
    img.update()


def bake(
    name: str,
    size: int,
    seed: int,
    height_fn: Callable[[int, np.random.Generator], np.ndarray],
    tint: tuple[float, float, float],
    *,
    albedo_fn: Callable | None = None,
    rough: tuple[float, float] = (0.80, 0.95),
    normal_strength: float = 0.6,
    diffuse: float = 0.35,
    extra: str | None = None,
) -> dict[str, bpy.types.Image]:
    """
    烤一组图。返回 `{"c": 反照率, "n": 法线, "r": 粗糙度[, "a": 遮罩]}`。

    参数
    ----
    height_fn  `(size, rng) -> (size,size) float 0..1` 高度场,唯一真相源
    tint       反照率基色(**sRGB 比值**,与 config.Palette 同口径)
    albedo_fn  可选:`(h, rng, tint) -> (size,size,3)`,给需要多色斑驳的材质
    rough      (低, 高) —— 由高度线性映射过去;凹陷处更粗糙
    normal_strength  法线强度手感系数
    extra      非 None 时额外产出一张遮罩图,键为它(`"a"`)
    """
    if size > MAX_SIZE:
        raise ValueError(
            f"{name}: 边长 {size} 超过上限 {MAX_SIZE}。"
            f"pixels 的中间数组是 size²·16 字节,{size}² 就是 "
            f"{size * size * 16 / 1048576:.0f}MB 峰值内存。"
        )
    rng = np.random.default_rng(seed)
    h = np.asarray(height_fn(size, rng), dtype=np.float32)
    if h.shape != (size, size):
        raise ValueError(f"{name}: height_fn 返回 {h.shape},应为 {(size, size)}")

    # —— 反照率 ——
    if albedo_fn is not None:
        rgb = albedo_fn(h, rng, tint)
    else:
        # 高度调制明暗:凸起受光、缝隙积尘。
        #
        # ⚠️ 区间是 `[0.55, 1.18]` 而不是原来的 `0.72 + 0.42h`。
        #    旧区间在 h 实际落于 0.4~0.6 时只给出 0.89~0.97 ——
        #    **几乎没有明暗变化**,于是再好的纹路也看不出来。
        #    而 fbm 叠出来的高度场本来就集中在中间段(中心极限),
        #    所以"按 h 线性映射"这件事必须按**实际分布**配区间,
        #    不能按理论上的 0..1 配。
        shade = 0.55 + 0.63 * h
        rgb = np.stack(
            [np.clip(np.asarray(tint[i], dtype=np.float32) * shade, 0.0, 1.0)
             for i in range(3)],
            axis=-1,
        )
    alb = np.empty((size, size, 4), dtype=np.float32)
    alb[:, :, :3] = np.clip(rgb, 0.0, 1.0)
    alb[:, :, 3] = 1.0

    # —— 粗糙度 ——
    r = rough[0] + (rough[1] - rough[0]) * (1.0 - h)

    out: dict[str, bpy.types.Image] = {}
    img_c = _new_image(f"tex_{name}_c", size, "sRGB")
    _write(img_c, alb)
    img_c.pack()
    out["c"] = img_c

    img_n = _new_image(f"tex_{name}_n", size, "Non-Color")
    _write(img_n, height_to_normal(h, normal_strength))
    img_n.pack()
    out["n"] = img_n

    img_r = _new_image(f"tex_{name}_r", size, "Non-Color")
    _write(img_r, _gray(np.clip(r, 0.0, 1.0)))
    img_r.pack()
    out["r"] = img_r

    if extra is not None:
        raise NotImplementedError("extra 遮罩图未实现")
    return out


# ==========================================================================
# 材质接线
# ==========================================================================


def wire(
    mat: bpy.types.Material,
    maps: dict[str, bpy.types.Image],
    *,
    normal_strength: float = 1.0,
) -> None:
    """
    把一组图接进材质的节点树。

    ⚠️ 节点一律**按 type 找**,不按名字 —— 非英文界面下
       "Principled BSDF" / "Image Texture" 这些名字是本地化的。
       (Blender MCP 的说明里也强调了同一条。)

    ⚠️ 法线必须经 `ShaderNodeNormalMap` 再进 BSDF 的 Normal 口。
       直接把法线图接到 Normal 上,glTF 导出器**不认**,
       导出的模型会静默地少一张法线图 —— 不报错,只是没有效果。
    """
    nt = mat.node_tree
    bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")

    if "c" in maps:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = maps["c"]
        t.location = (-600, 300)
        nt.links.new(t.outputs["Color"], bsdf.inputs["Base Color"])
        # ⚠️ 同步视口显示色,理由见 bl_utils.make_material:
        #    Workbench 不求值节点树,不设的话预览图全是灰的。
        mat.diffuse_color = (0.6, 0.6, 0.6, 1.0)

    if "r" in maps:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = maps["r"]
        t.location = (-600, 0)
        nt.links.new(t.outputs["Color"], bsdf.inputs["Roughness"])

    if "n" in maps:
        t = nt.nodes.new("ShaderNodeTexImage")
        t.image = maps["n"]
        t.location = (-600, -300)
        nm = nt.nodes.new("ShaderNodeNormalMap")
        nm.location = (-300, -300)
        nm.inputs["Strength"].default_value = normal_strength
        nt.links.new(t.outputs["Color"], nm.inputs["Color"])
        nt.links.new(nm.outputs["Normal"], bsdf.inputs["Normal"])


# ==========================================================================
# 各材质的高度场
#
# 约定:**生成函数的轴向 = 图像轴向**(第 0 行 = 顶部,第 0 列 = 左侧)。
# `_write` 负责翻转,生成函数不要自己翻。
# ==========================================================================


def _wood_straight(size: int, rng: np.random.Generator) -> np.ndarray:
    """
    直纹木:纹理沿**行**方向走(即沿图像的 v 轴),横截面出年轮。

    所以条纹沿 x 变化、沿 y 拉长 —— `np.cos(2πx/period)` 加上沿 y
    的低频扰动(树干不是笔直的)。用在柱、梁、拱骨上时,u 轴是
    长度方向,条纹会顺着构件走。
    """
    x = np.arange(size, dtype=np.float32)[None, :]
    y = np.arange(size, dtype=np.float32)[:, None]
    warp = 3.0 * fbm(size, rng, octaves=3, base=2)
    period = size / rng.integers(9, 14)
    grain = 0.5 + 0.5 * np.cos(2.0 * np.pi * (x + warp) / period)
    fleck = fbm(size, rng, octaves=5, base=4)
    return np.clip(0.55 * grain + 0.45 * fleck, 0.0, 1.0).astype(np.float32)


def _wood_plank(size: int, rng: np.random.Generator) -> np.ndarray:
    """
    横纹板:板缝横向,纹理**沿行**走(沿 u 拉长的条纹)。

    与 `_wood_straight` 的区别就是转 90°:那个是"沿构件长度出纹",
    这个是"板材横着拼"。板缝本身做成深谷,这样法线图里能读出一道道
    缝 —— 近景看桥面板靠的就是它。
    """
    x = np.arange(size, dtype=np.float32)[None, :]
    y = np.arange(size, dtype=np.float32)[:, None]
    warp = 3.0 * fbm(size, rng, octaves=3, base=2)
    period = size / rng.integers(7, 11)
    grain = 0.5 + 0.5 * np.cos(2.0 * np.pi * (y + warp) / period)
    n_plank = int(rng.integers(3, 6))
    seam = np.abs(((x / size * n_plank) % 1.0) - 0.5) * 2.0
    h = 0.45 * grain + 0.35 * fbm(size, rng, octaves=5, base=4) + 0.20 * seam
    return np.clip(h, 0.0, 1.0).astype(np.float32)


def _wood_weathered(size: int, rng: np.random.Generator) -> np.ndarray:
    """风化木:裂纹为主,顺纹开裂、深浅不一。"""
    x = np.arange(size, dtype=np.float32)[None, :]
    y = np.arange(size, dtype=np.float32)[:, None]
    crack_seed = fbm(size, rng, octaves=4, base=3)
    # 把噪声"锐化"成一道道窄沟:取到阈值附近的一段做谷
    band = np.abs(crack_seed - 0.5) * 2.0
    crack = np.clip(1.0 - band * 6.0, 0.0, 1.0)
    # ⚠️ 分母是 `size / 9`(整图九道木纤维),**不是 5.0**。
    #    原来写的 5.0 是"周期 5 像素"——1024 宽的图上 205 道细纹,
    #    与 `_road_rut` 的 track 是同一个错法。判据:凡是描述
    #    "图上有几道"的量,分母必须是 size/几。
    fiber = 0.5 + 0.5 * np.cos(
        2.0 * np.pi * (x + 2.0 * fbm(size, rng, 3, 2)) / (size / 9.0)
    )
    return np.clip(0.40 + 0.30 * fiber + 0.30 * crack, 0.0, 1.0).astype(np.float32)


def _tile_barrel(size: int, rng: np.random.Generator) -> np.ndarray:
    """
    筒瓦垄:**条纹沿 v 变化**,即 cos 作用在 **y** 上。

    ⚠️ 轴向这一条我推过一遍,记在这里免得下次再推错:
       屋面(近似水平)的 u = 世界 x = 上下坡方向,v = 世界 y = 沿屋脊方向。
       筒瓦是**顺着坡往下铺**的,相邻两条垄沿屋脊方向排开。
       所以"垄"这条线沿 u 走、间隔沿 v 排 —— 图上是
       **水平的、按行重复的条纹**。写成 `cos(2πx/…)` 就转了 90°,
       渲出来是一排横着趴的瓦,远看像百叶。
    """
    y = np.arange(size, dtype=np.float32)[:, None]

    # —— 垄数由**几何侧的垄距**推出来,不随机 ——
    #
    # ⚠️ 上一版这里是 `n = rng.integers(8, 12)`。铺装尺寸 1.4m 时,
    #    8~11 道意味着垄距 0.13~0.175m,而 `config.Building.
    #    TILE_ROW_SPACING` 声明的是 0.20~0.24m —— **同一场景里出现了
    #    两种垄距**:一种是几何瓦垄建出来的(校验器 `tile.row` 量它),
    #    一种是这张贴图画出来的。两者在渲染图上叠在一起,远看是
    #    "瓦有点乱",近看是两组周期打架产生的摩尔纹。
    #    这不是美术问题,是一个**自相矛盾**,而它只能靠"从同一个
    #    常量推出来"来消除。
    spacing = 0.5 * (C.Building.TILE_ROW_SPACING[0] + C.Building.TILE_ROW_SPACING[1])
    tile_m = C.Texture.TILE_M["tile_barrel"]
    n = max(2, round(tile_m / spacing))

    t = (y / size * n) % 1.0
    # 筒瓦的断面**就是**半个圆:瓦背凸、两侧落到沟底。
    #
    # ⚠️ 上一版这里还有一项 `seam`,写成 `clip(1 − |t−0.5|·9, 0, 1)`,
    #    本意是"两垄之间的沟",但它**在 t=0.5 处取到最大值** ——
    #    也就是把沟开在了**瓦背正中**。于是每一垄被劈成两半,
    #    6 垄显出 12 道;而它在反照率里并不难看,只是"瓦有点密",
    #    直到我把**法线图**存出来看才数出这个 2 倍。
    #    教训:反照率图上的周期错误会被当成风格,法线图上的不会 ——
    #    因为它只有形状、没有颜色可供误读。打样要看 n,不能只看 c。
    #
    #    现在不要那一项了:`sqrt(1−(2t−1)²)` 本身在 t=0/1 处归零,
    #    沟就落在垄界上,这才是对的。
    barrel = np.sqrt(np.clip(1.0 - (2.0 * t - 1.0) ** 2, 0.0, 1.0))
    h = 0.90 * barrel + 0.10 * fbm(size, rng, octaves=4, base=6)
    return np.clip(h, 0.0, 1.0).astype(np.float32)


def _tile_flat(size: int, rng: np.random.Generator) -> np.ndarray:
    """板瓦:比筒瓦平,叠压的横缝是主要特征。垄距同样从几何侧推。"""
    y = np.arange(size, dtype=np.float32)[:, None]
    spacing = 0.5 * (C.Building.TILE_ROW_SPACING[0] + C.Building.TILE_ROW_SPACING[1])
    n = max(2, round(C.Texture.TILE_M["tile_flat"] / spacing))
    t = (y / size * n) % 1.0
    # 每片瓦:靠一侧略高,另一侧是搭接的薄边
    lap = np.clip(1.0 - t * 3.2, 0.0, 1.0)
    h = 0.55 + 0.25 * lap + 0.20 * fbm(size, rng, octaves=4, base=5)
    return np.clip(h, 0.0, 1.0).astype(np.float32)


def _earth_wall(size: int, rng: np.random.Generator) -> np.ndarray:
    """夯土墙:横向夯层 + 大块斑驳 + 少量纵向裂。"""
    y = np.arange(size, dtype=np.float32)[:, None]
    layers = int(rng.integers(7, 11))
    band = 0.5 + 0.5 * np.cos(2.0 * np.pi * y / (size / layers))
    blotch = fbm(size, rng, octaves=5, base=3)
    cr = np.clip(1.0 - np.abs(fbm(size, rng, 4, 4) - 0.5) * 6.0, 0.0, 1.0)
    h = 0.34 * band + 0.46 * blotch + 0.20 * cr
    return np.clip(h, 0.0, 1.0).astype(np.float32)


def _road_rut(size: int, rng: np.random.Generator) -> np.ndarray:
    """
    土路车辙:两条被压实的辙 + 松散碎石 + 大小不一的坑洼。

    ⚠️ **返工过一次,两处都是"像素当成了比例"。**

      ① `track = cos(2π·y / 9.0)` —— `y` 是**逐像素索引**,
         除以 9 得到的是**周期 9 像素**。2048 宽的图上就是 227 条
         细纹,缩略图里糊成一片均匀的灰。我第一版渲出来看到
         "路面是一片没有细节的褐色",差点去加噪声倍频 ——
         真因是**该是几道的东西被我写成了几百道**。
         凡是"图上有几条"的量,分母必须是 `size/几条`,
         不能是裸常数。

      ② 反照率的调制幅度太小(`0.72 + 0.42h`,而 h 实际只在
         0.4~0.6 之间晃),所以就算纹路对了也看不出来。

    车辙是**两轮**压出来的:两条主辙平行于路的走向(本函数假定
    u 轴 = 路走向,故辙是"水平的、按行分布的两条带"),
    辙里土被压实 → 更暗更平;辙外松散 → 更亮更碎。
    """
    x = np.arange(size, dtype=np.float32)[None, :]
    y = np.arange(size, dtype=np.float32)[:, None]
    yn = y / size

    # 三个尺度,缺一不可 —— 只有中间那层就会得到一张"绒布"
    patch = fbm(size, rng, octaves=5, base=2)     # 干湿/沙土/泥的大片不均
    grain = _value_noise(size, rng, max(24, size // 6))   # 土粒
    micro = _value_noise(size, rng, max(48, size // 2))   # 更细的沙

    # —— 两条轮辙 ——
    # ⚠️ 间距 = 整图的 0.22。若整图铺 6m,那就是 **1.32m**,
    #    与牛车/独轮车的轮距同量级。上一版把两条辙放在 0.27 与
    #    0.73,间距 2.8m —— 那是"两条各走各的路",不是一辆车的辙。
    #    这个数**必须与 `Texture.TILE_M["road_rut"]` 一起看**:
    #    改铺装尺寸而不改它,辙就跟着一起缩放,轮距会悄悄变。
    rut = np.zeros((size, size), dtype=np.float32)
    for c in (0.39, 0.61):
        rut += np.exp(-((yn - c) ** 2) / (2.0 * 0.050 * 0.050))
    # 辙不是通长的:有被填平、有被压深的段落
    rut = np.clip(rut, 0.0, 1.0) * (0.50 + 0.50 * fbm(size, rng, 4, 3))

    # 纵向的松散土脊 —— **低频、低幅**。
    # 上一版这里是 60 道等距正弦,渲出来是"灯芯绒"。真实路面的纵向
    # 条痕又少又不齐,所以:只 7 道、振幅砍到原来的三分之一,再叠噪声错开。
    streak = 0.5 + 0.5 * np.cos(
        2.0 * np.pi * (y + 9.0 * fbm(size, rng, 3, 2)) / (size / 7.0)
    )

    # 碎石:稀疏、高对比。这是"土路"区别于"泥地"的关键,
    # **辙内几乎没有**(车早把它们压进土里了)。
    stones = np.clip((_value_noise(size, rng, max(24, size // 2)) - 0.74) * 9.0,
                     0.0, 1.0) * (1.0 - rut * 0.85)

    h = (0.30 * patch + 0.16 * grain * (1.0 - rut * 0.7) + 0.08 * micro
         + 0.10 * streak + 0.26 * stones - 0.40 * rut)
    return np.clip(0.46 + h, 0.0, 1.0).astype(np.float32)


def _bank_grass(size: int, rng: np.random.Generator) -> np.ndarray:
    """河岸草土:草簇(细高频)+ 泥土基底的团块。"""
    clump = fbm(size, rng, octaves=5, base=3)
    blades = fbm(size, rng, octaves=6, base=16)
    # 草叶方向性强,把高频噪声沿一个方向压扁
    b = _blur3(blades)
    h = 0.55 * clump + 0.45 * (0.6 * blades + 0.4 * b)
    return np.clip(h, 0.0, 1.0).astype(np.float32)


def _cloth(size: int, rng: np.random.Generator) -> np.ndarray:
    """布:经纬交织的细网格 + 布面的轻微起伏。皱褶交给顶点形变,不烘进图。"""
    x = np.arange(size, dtype=np.float32)[None, :]
    y = np.arange(size, dtype=np.float32)[:, None]
    warp = 0.5 + 0.5 * np.cos(2.0 * np.pi * x / 4.0)
    weft = 0.5 + 0.5 * np.cos(2.0 * np.pi * y / 4.0)
    h = 0.55 + 0.25 * warp * weft + 0.20 * fbm(size, rng, octaves=4, base=6)
    return np.clip(h, 0.0, 1.0).astype(np.float32)


def _rope(size: int, rng: np.random.Generator) -> np.ndarray:
    """
    麻索:斜向的股线。

    索是**捻**出来的,所以股线是斜的 —— 这是它区别于"一根木棍"的
    全部特征。角度取 ±30° 左右,沿 u 走。
    """
    x = np.arange(size, dtype=np.float32)[None, :]
    y = np.arange(size, dtype=np.float32)[:, None]
    a = 0.55
    strand = 0.5 + 0.5 * np.cos(2.0 * np.pi * (x + y * a * size * 0.06) / (size / 9.0))
    fuzz = fbm(size, rng, octaves=5, base=10)
    h = 0.68 * strand + 0.32 * fuzz
    return np.clip(h, 0.0, 1.0).astype(np.float32)


def _silk(size: int, rng: np.random.Generator) -> np.ndarray:
    """绢本:极细的经纬 + 陈旧的斑。低对比 —— 它是背景,不该抢主体。"""
    x = np.arange(size, dtype=np.float32)[None, :]
    y = np.arange(size, dtype=np.float32)[:, None]
    weave = (0.5 + 0.5 * np.cos(2.0 * np.pi * x / 3.0)) * \
            (0.5 + 0.5 * np.cos(2.0 * np.pi * y / 3.0))
    age = fbm(size, rng, octaves=4, base=3)
    h = 0.62 + 0.18 * weave + 0.20 * age
    return np.clip(h, 0.0, 1.0).astype(np.float32)


def _stone_ashlar(size: int, rng: np.random.Generator) -> np.ndarray:
    """
    条石驳岸 / 台基:一层层砌起来的方石,石缝被掏出凹槽。

    为什么这张图非有不可
    --------------------
    驳岸是**汴河近景的主体表面之一** —— 镜头贴着水面看过去,左边是水、
    右边就是这个。此前它是一整片纯色(STONE),在近景里读起来像一块
    塑料板;而用户的要求里明写了"近景需要可观察的细节:木构、船板、
    屋瓦、窗棂、布幌、竹篮、陶器"。驳岸既不在原计划的 15 组贴图里,
    也没人注意到它缺 —— 又一处"计划里没有,于是谁也没想起来"。

    做法
    ----
    皮数(每层高度)取整图的 1/6,层内按石长(整图的 1/4)切块,
    **逐层错缝**:奇数层平移半块。错缝是砌体最基本的做法,
    不错缝的图一眼就能看出是重复的格子。

    石的顶面留平台、缝里下挖:`face` 是石块面,`joint` 是缝。
    石面本身只给一点极轻的起伏(凿痕),因为**落差集中在缝上** ——
    这也正是 NORMAL["stone_ashlar"]=0.30 明显大于石面自身起伏的原因。
    """
    rows = 6                      # 皮数:一铺 1.6m 里 6 层 → 层高 0.267m
    cols = 4                      # 每层 4 块 → 石长 0.40m
    tile = C.Texture.TILE_M["stone_ashlar"]
    block_m = tile / cols

    yy = np.arange(size, dtype=np.float32)[:, None] / size * rows
    xx = np.arange(size, dtype=np.float32)[None, :] / size * cols

    # 逐层错缝:奇数层沿 x 平移半块。这是砌体最基本的做法 ——
    # 不错缝的图一眼就能看出是重复的格子。
    row_i = np.floor(yy).astype(np.int32)
    xx_shift = xx + 0.5 * (row_i % 2)

    fx = xx_shift % 1.0           # 块内 0..1
    fy = yy % 1.0                 # 层内 0..1

    # 到最近一条缝的距离,**换算成物理尺度再取 min**。
    #
    # ⚠️ 两个方向的 1.0 代表不同的米数(块长 0.40 / 层高 0.267),
    #    直接拿 fx、fy 的归一化距离取 min,等于把 x 向的缝按 y 向的
    #    比例缩放了 —— 竖缝会变成横缝的 1.5 倍宽。所以这里统一折到
    #    "块长的几分之几"这个口径上。
    dx = np.minimum(fx, 1.0 - fx)
    dy = np.minimum(fy, 1.0 - fy) * (cols / rows)
    d = np.minimum(dx, dy)

    # 灰缝 3.2cm。**由物理尺寸反推归一化宽度** —— 写成常数 0.08 的话,
    # 将来有人把 TILE_M 调大,缝会跟着变宽,而那是两件不该联动的事。
    joint_w = 0.032 / block_m
    joint = np.clip(1.0 - d / joint_w, 0.0, 1.0)

    # —— 石面 ——
    #
    # ⚠️ 三样东西缺一不可,这是第一版的教训:第一版只有
    #    `0.16 * per_block + 0.06 * chisel`,于是 h 落在 0.62~0.78,
    #    经 bake 的 shade = 0.55 + 0.63h 之后只有 ±5% 的明暗 ——
    #    渲染出来是一张"画着格子的纯色板",石块之间分不出来。
    #    **这是本项目第二次栽在同一处**:`_road_rut` 当初也是调制幅度
    #    太小。反照率的调制量要按"最终明暗百分比"倒推,不是凭手感给。
    #
    #      1. 块间深浅 —— 不同石料、不同风化,这是主变化(±0.17 → 明暗 ±11%)
    #      2. 大尺度污渍 —— 让相邻几块连成一片,不然像新砌的
    #      3. 凿痕 —— 很轻,只在近景起作用
    chisel = 0.06 * fbm(size, rng, octaves=4, base=3)
    stain = 0.14 * (fbm(size, rng, octaves=3, base=2) - 0.5)
    per_block_seed = rng.random((rows, cols)).astype(np.float32)
    # 错缝后块索引要跟着平移,否则每块的深浅会和上一行错位对上 ——
    # 那会让"随机深浅"退化成沿对角线的斜纹。
    bx = np.floor(xx_shift).astype(np.int32) % cols
    by = np.clip(row_i, 0, rows - 1)
    per_block = per_block_seed[by, bx]

    face = 0.34 * (per_block - 0.5) + stain + chisel
    h = 0.62 + face - 0.34 * joint
    return np.clip(h, 0.0, 1.0).astype(np.float32)


def _lattice(size: int, rng: np.random.Generator) -> np.ndarray:
    """
    格子窗的**遮罩**:1 = 木棂,0 = 空。

    这一张**不是高度场,是镂空**,所以它与 `bake()` 的常规用法不合:
    它不该被换算成法线、也不该被当成明暗。当前它只做到"生成"这一步,
    **还没有接进任何材质** —— 格子窗现在仍是靠几何做棂条的
    (见 `04_buildings.py`),没有用 alpha 贴图。

    留着它的原因是那套几何棂条在远景会变成摩尔纹。这是一条
    **已知未做**的优化,记在 docs/08,不假装它已经生效。
    """
    n = 7
    x = np.arange(size, dtype=np.float32)[None, :]
    y = np.arange(size, dtype=np.float32)[:, None]
    bar = size / n * 0.22
    cx = np.minimum(x % (size / n), (size / n) - (x % (size / n)))
    cy = np.minimum(y % (size / n), (size / n) - (y % (size / n)))
    m = np.clip(bar - np.minimum(cx, cy), 0.0, 1.0)
    return (m > 0.0).astype(np.float32)


# 名字 → 生成函数。**这里是"计划里写了没有"的唯一裁决处。**
_H: dict[str, Callable[[int, np.random.Generator], np.ndarray]] = {
    "wood_straight": _wood_straight,
    "wood_plank": _wood_plank,
    "wood_weathered": _wood_weathered,
    "tile_barrel": _tile_barrel,
    "tile_flat": _tile_flat,
    "earth_wall": _earth_wall,
    "road_rut": _road_rut,
    "bank_grass": _bank_grass,
    "cloth": _cloth,
    "rope": _rope,
    "stone_ashlar": _stone_ashlar,
    "silk": _silk,
    "lattice": _lattice,
}


def height_fn(name: str) -> Callable[[int, np.random.Generator], np.ndarray]:
    if name not in _H:
        raise KeyError(
            f"没有名为 {name!r} 的高度场。已实现:{sorted(_H)}"
        )
    return _H[name]


def _seed_for(name: str) -> int:
    """
    由贴图名派生一个**跨进程稳定**的种子。

    ⚠️ 这里**不能用内置 `hash()`**。CPython 对字符串的 `hash()` 默认
       带每进程随机盐(PYTHONHASHSEED),也就是说 `hash("wood")`
       这一次跑和下一次跑**不一样**。拿它当种子,同一份代码两次构建
       会烤出两张不同的木纹 —— 而"统计量可复现"是本项目的硬要求,
       这种不确定**不会报错、也不会让三角面数变化**,只会在
       `verify_reproducible.mjs --runs 2` 比包围盒时露出一点浮点级
       的差异,极难归因。

    `zlib.crc32` 是纯函数,与进程无关。
    """
    import zlib

    return (C.SEED + zlib.crc32(name.encode("utf-8"))) % (2**31 - 1)


_CACHE: dict[str, dict[str, bpy.types.Image]] = {}


def get_maps(name: str) -> dict[str, bpy.types.Image]:
    """
    取一组贴图,**同名只烤一次**。

    为什么必须缓存:同一种木料会被好几个 builder 用到
    (`01_bridge` 的栏杆、`04_buildings` 的门窗、`06_props` 的桌凳),
    而它们想要的是**同一张**图。不缓存的话每一次 `bake` 都会新建
    一组 image datablock,最后 `bpy.data.images` 里堆着几十张
    内容相同的图,导出时全部打进 GLB —— 显存和体积都是几倍的浪费,
    而且**看不出来**(每张图都长得对,只是有 8 张一样的)。
    """
    if name in _CACHE:
        return _CACHE[name]
    if name not in C.Texture.SIZE:
        raise KeyError(f"config.Texture.KIT 里没有 {name!r}")
    # 遮罩类不是高度场。对一张二值遮罩求法线会得到一张**看着像那么
    # 回事**的硬边图 —— 不报错、不缺数据,只是毫无意义,然后安静地
    # 跟着 GLB 一起发出去。拦在这里比拦在验证器里早,也更省。
    if name in C.Texture.NOT_HEIGHT_FIELD:
        raise TypeError(
            f"{name!r} 不是高度场(见 config.Texture.NOT_HEIGHT_FIELD),"
            f"不能进 bake()。它当前由几何表达,具体见 config.Texture.UNUSED。"
        )
    maps = bake(
        name,
        C.Texture.SIZE[name],
        _seed_for(name),
        height_fn(name),
        tint=C.Texture.TINT[name],
        rough=C.Texture.ROUGH[name],
        normal_strength=C.Texture.NORMAL[name],
    )
    _CACHE[name] = maps
    return maps


def clear_cache() -> None:
    """
    丢掉缓存,并把已经烤出来的图从 `bpy.data.images` 里删干净。

    ⚠️ 只在"确定没有材质还在引用它们"时调用 —— 删掉仍被引用的
       image 会让材质上的贴图变成粉色(Blender 的缺失贴图色),
       而**不会**报错。
    """
    _CACHE.clear()
    for img in list(bpy.data.images):
        if img.name.startswith("tex_") and img.users == 0:
            bpy.data.images.remove(img)
