"""
汴河 —— 水面、河床、驳岸、木桩、踏步。

形制依据
--------
《东京梦华录》记汴河"岁漕江、淮、湖、浙米数百万石",是北宋的漕运
命脉。既是城内运河,两岸必有**驳岸**收住河形,不可能让土坡直接塌进
水里 —— 河岸一塌,漕船就搁浅了。

本 builder 建四样东西:

    水面    z = 0,x ∈ ±8.25
    河床    z = −1.5,淤泥
    驳岸    自水边(x = ±8.25)斜收到河底(±8.15),外加压顶石
    附件    入水木桩、踏步

河道断面沿 Y 恒定,所以整条河是**一次放样**扫出来的,不是逐段摆。

⚠️ **水色是这一阶段最容易翻车的地方。**
   汴河是黄河冲积平原上的浑水河,水色是**土黄带绿**。任何"标准
   水面着色器"(three.js 的 Water.js 之类)都会给出蔚蓝的地中海,
   因为那些着色器把散射色写死成青蓝。所以:
       · config.Palette 里显式写了 WATER_DEEP / SHALLOW / SCATTER;
       · 网页侧 RiverReflector 必须喂这三个值;
       · 阶段 4 会用截图采样断言河道中心像素的色相落在 25–45°。
   本文件只负责**几何**,颜色是渲染侧的事 —— 但这里生成的
   `qm_id=river_surface` 就是那三个值的落点。

   ✅ 已实测(probe_shot.py 量 site_v2_plan.png 的 x 扫描线):
      水面在俯视图上量到 **#796a4f**,色相 **38.6°**、饱和度 0.35,
      **已经在 25–45° 的断言区间内**。这是个早到的数据点,说明
      调色板的选择是对的;正式断言仍要等阶段 4 在**着色后**的
      截图上做,因为反射与菲涅尔会改变最终像素。

   ⚠️ 但**平视机位**看到的河水几乎是黑的,**那不是调色板的问题**:
      WORKBENCH 预览开了 screen-space cavity,掠视时按深度差压暗,
      同一块面板可以差好几倍亮度。曾据此差点去改 WATER_BASE ——
      见 probe_shot.py 文件头的说明,那里记了两个预览陷阱。

⚠️ **已知简化**(如实声明,见 docs/08):
   河床是平的,没有淤积起伏、没有航道疏浚的深浅变化。
   原画给不出水下地形,而凭空的起伏会与"水深 1.5m"的断言打架。
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import config as C  # noqa: E402
from lib import bl_utils as BU  # noqa: E402
from lib import tag_utils as TU  # noqa: E402

S = C.Site
R = C.River

# 水面薄片的厚度。见 BU.MeshBuilder.add_slab 的说明:厚度是为了让
# `recalc_face_normals` 能无歧义定出朝上的一面,不是结构需要。
WATER_T = 0.06

# 驳岸在河底处的收进量(相对水边)。水边 x = ±8.25,河底收到 ±8.15,
# 即 1.5m 深度上收 0.10m —— 近乎垂直,只在掠视时看得出一点侧脚。
# Reliability C:原画量不出驳岸的侧脚。
REVET_BATTER = 0.10

# 驳岸压顶石:高出岸面 0.12m,自水边向岸内出 0.40m。
# 它不向水里伸 —— 一伸就把河面宽度改小了,与 river.width 的断言打架。
#
# ⚠️ 数值已搬到 `config.River` —— 06_props 要按"压顶之外"定下河踏步的
#    起点(`x0 = WATER_EDGE + COPING_WIDE + 0.10`),而台阶又压着柳树的
#    栽植带。两处各存一份的后果见 config 里 STEP_SITES 的说明。
#    这里保留同名局部量,只为让本文件内的算式不必到处写 `R.`。
COPING_RISE = C.River.COPING_RISE
COPING_WIDE = C.River.COPING_WIDE

# 沿 Y 的分段。河是直的,断面不变,所以段长可以放得很粗。
# 近景(|y| ≤ 60)取 3m,远景取 30m —— 相机凑不到远景,加密只是浪费。
Y_NEAR = 60.0
SEG_NEAR = 3.0
SEG_FAR = 30.0


def _stations() -> list[float]:
    """放样站位。近密远疏。"""
    ys = [-R.LENGTH / 2]
    y = -R.LENGTH / 2
    while y < -Y_NEAR:
        y = min(y + SEG_FAR, -Y_NEAR)
        ys.append(y)
    while y < Y_NEAR:
        y = min(y + SEG_NEAR, Y_NEAR)
        ys.append(y)
    while y < R.LENGTH / 2 - 1e-9:
        y = min(y + SEG_FAR, R.LENGTH / 2)
        ys.append(y)
    return ys


# --------------------------------------------------------------------------
# 断面
# --------------------------------------------------------------------------


def _water_profile() -> list[tuple[float, float]]:
    """
    水面断面:顶面在水位上、沿宽度分 6 段,底面薄薄一层。

    顶面分宽度网格不是为了现在的观感(平的水面分不分格都一样),
    而是为了**阶段 4 的细波** —— 顶点位移需要网格,到时候再回头改
    放样函数会牵动整条河。
    """
    half = S.WATER_EDGE
    n = 6
    top = [(-half + 2 * half * i / n, 0.0) for i in range(n + 1)]
    return top + [(half, -WATER_T), (-half, -WATER_T)]


def _bed_profile() -> list[tuple[float, float]]:
    """河床断面:一块淤泥板,顶面在 −DEPTH。"""
    half = S.WATER_EDGE - REVET_BATTER
    return [
        (-half, -R.DEPTH),
        (half, -R.DEPTH),
        (half, -R.DEPTH - 0.6),
        (-half, -R.DEPTH - 0.6),
    ]


def _revetment_profile(sign: int) -> list[tuple[float, float]]:
    """
    驳岸断面(单侧,已按 sign 定向)。

    是一个 L 形实体:岸顶的压顶带 + 斜收的墙面 + 埋进地里的部分。

        x:  8.25 ──────── 10.0      (岸面,接到 00_layout 的地坪)
              ＼                     (斜收的墙面)
        x:    8.15 ──────── 10.0     (埋深)
    """
    edge = sign * S.WATER_EDGE
    bed = sign * (S.WATER_EDGE - REVET_BATTER)
    inner = sign * S.ABUTMENT_FACE
    z_deep = -R.DEPTH - 0.9
    return [
        (edge, 0.0),
        (inner, 0.0),
        (inner, z_deep),
        (bed, z_deep),
        (bed, -R.DEPTH),
    ]


# --------------------------------------------------------------------------
# 附件
# --------------------------------------------------------------------------


def _piles(add, sign: int, z_top: float) -> int:
    """
   在驳岸前打一排木桩。

    汴河的驳岸做法是**木桩护岸**:沿水边密打木桩,桩间填石,
    这是宋代运河驳岸的常见做法(见 docs/01)。桩顶略高于压顶石,
    在水边形成一道连续的木齿 —— 也是近景里最读得出"这是河岸"
    的细节之一。

    数量按间距推,不硬编码:一根桩都不打的岸线看起来是混凝土。
    """
    n = 0
    x = sign * (S.WATER_EDGE + 0.10)
    spacing = 2.2
    y_end = 58.0
    y = -y_end + spacing
    while y < y_end:
        # 桩位加一点确定性抖动 —— 等距排布像栏杆,不像打进泥里的桩
        jitter = 0.35 * math.sin(y * 0.7 + sign * 1.9)
        add(
            Vector((x, y + jitter, z_top)),
            Vector((x + sign * 0.06, y + jitter, -R.DEPTH - 0.35)),
            0.085,
            8,
        )
        n += 1
        y += spacing
    return n


def _steps(builder: BU.MeshBuilder, sign: int, y_c: float, n: int = 5) -> None:
    """
    入水踏步 —— 从岸面下到水边的石阶。

    为什么非要有它:没有踏步,画里"有人在河边取水、洗衣、上船"的
    情节就没有落脚点,人物只能站在压顶石上,看着像悬空。
    踏步落在水边一处**局部加宽**的驳岸上,所以它往岸内退,不进水面。

    ⚠️ 落点坐标(`y_c`)由 `config.River.STEP_SITES` 给出,**不在这里写**。
       踏步是岸上唯一一处向岸内伸进去的东西,会压到柳树的栽植带上;
       两处各存一份坐标就会各自为政 —— 详见 config 里的说明。
    """
    step_h = R.DEPTH / n
    step_d = 0.42
    x0 = sign * (S.WATER_EDGE + COPING_WIDE + 0.10)
    for i in range(n):
        z_hi = -i * step_h
        x_lo = sign * (abs(x0) + i * step_d)
        x_hi = sign * (abs(x0) + (i + 1) * step_d)
        a, b = sorted((x_lo, x_hi))
        builder.add_slab(
            a, b, y_c - 1.5, y_c + 1.5,
            lambda x, y, z=z_hi: z,
            thickness=step_h + 0.1,
        )


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------


def build() -> dict:
    """生成汴河,返回统计信息。"""
    BU.clear_scene_once()

    mats = BU.MaterialLibrary()
    coll = BU.get_collection("河道")

    water_mat = mats.get("water", C.Palette.WATER_BASE, roughness=0.16)
    stone_mat = mats.get("stone", C.Palette.STONE, roughness=0.94)
    silt_mat = mats.get("silt", C.Palette.SILT, roughness=1.0)
    wood_mat = mats.get("wood_dark", C.Palette.WOOD_DARK, roughness=0.88)

    water = BU.MeshBuilder("河道_水面")
    bed = BU.MeshBuilder("河道_河床")
    revet = BU.MeshBuilder("河道_驳岸")
    piles = BU.MeshBuilder("河道_木桩")
    steps = BU.MeshBuilder("河道_踏步")

    ys = _stations()
    wp = _water_profile()
    bp = _bed_profile()

    # —— 放样:水面与河床 ——
    # 逐段调用 add_loft,段与段之间共享断面点位但**不共享顶点**。
    # 这里不需要焊接:河是直的,段间接缝处的法线本来就一样,
    # 不会出现明暗条纹;而焊接要额外写一套顶点去重,不值。
    for i in range(len(ys) - 1):
        y0, y1 = ys[i], ys[i + 1]
        water.add_loft(wp, y0, None, y1)
        bed.add_loft(bp, y0, None, y1)

    # —— 放样:两侧驳岸 ——
    for sign in (-1, 1):
        rp = _revetment_profile(sign)
        for i in range(len(ys) - 1):
            revet.add_loft(rp, ys[i], None, ys[i + 1])

        # 压顶石:自水边向岸内出 0.40m,高 0.12m。
        # 向**岸内**出而不是向水里伸 —— 向水里伸会把河面宽度改小,
        # 与 river.width 的断言打架。
        cx0 = sign * S.WATER_EDGE
        cx1 = sign * (S.WATER_EDGE + COPING_WIDE)
        a, b = sorted((cx0, cx1))
        for i in range(len(ys) - 1):
            revet.add_slab(
                a, b, ys[i], ys[i + 1],
                lambda x, y: COPING_RISE,
                thickness=COPING_RISE + 0.10,
            )

    # —— 附件 ——
    pile_n = 0
    n_steps = 0
    for sign in (-1, 1):
        pile_n += _piles(piles.add_cylinder, sign, COPING_RISE + 0.08)
    # 落点读 config,不在这里写 —— 见 _steps 的说明
    for site_sign, y_c in R.STEP_SITES:
        _steps(steps, site_sign, y_c, n=R.STEP_N)
        n_steps += 1

    # —— 生成物体并打标签 ——
    objs: dict[str, bpy.types.Object] = {}

    o = water.build(water_mat, coll)
    if o:
        TU.tag(
            o, "river_surface", "water",
            label="汴河",
            zone="河道",
            lod="near",
            dynamic=True,
            hotspot=True,
            note="水色取土黄(辉 #2a1f14 / 浅 #8a7440),非蓝色;标准水面着色器会给出错误的海蓝",
        )
        objs["water"] = o

    o = bed.build(silt_mat, coll)
    if o:
        TU.tag(o, "river_bed", "terrain", label="河床", zone="河道", lod="mid",
               reflect=False,
               note="河床取平,原画给不出水下地形")
        objs["bed"] = o

    o = revet.build(stone_mat, coll)
    if o:
        TU.tag(o, "river_revetment", "terrain", label="驳岸", zone="河道", lod="near",
               reflect=False,
               note="木桩护岸 + 压顶石;侧脚 0.10m 为观感推定(Reliability C)")
        objs["revetment"] = o

    o = piles.build(wood_mat, coll)
    if o:
        TU.tag(o, "river_piles", "prop", label="护岸木桩", zone="河道", lod="near")
        objs["piles"] = o

    o = steps.build(stone_mat, coll)
    if o:
        TU.tag(o, "river_steps", "prop", label="河埠踏步", zone="河道", lod="near")
        objs["steps"] = o

    # —— 统计 ——
    tri = 0
    verts = 0
    for b in (water, bed, revet, piles, steps):
        st = b.stats()
        verts += st["verts"]
        # 用真的三角面数,不用 `faces * 2` —— 理由见 BU.MeshBuilder.stats()
        tri += st["tris"]

    return {
        "objects": len(objs),
        "stations": len(ys),
        "water_width": 2 * S.WATER_EDGE,
        "water_depth": R.DEPTH,
        "bed_width": 2 * (S.WATER_EDGE - REVET_BATTER),
        "piles": pile_n,
        "step_sites": n_steps,
        "verts": verts,
        "tris": tri,
    }


if __name__ == "__main__":
    stats = build()
    print("=" * 68)
    print("汴河构建完成")
    for k, v in stats.items():
        print(f"  {k:<18} {v}")
    print("=" * 68)
