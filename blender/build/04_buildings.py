"""
两岸市井、建筑与城门 —— 阶段 2c / 2e 的主体工程量。

形制依据
--------
· **屋顶形制**:北宋无硬山顶。本模块只产出两类屋面 ——
  悬山(`xuanshan`,两山屋面出挑于山墙之外)与四坡
  (`wudian` 庑殿 / `xieshan` 歇山,同属"四条斜脊交于正脊"的亲族)。
  取值写进 `qm_roof`,`validate_scale.roof.whitelist` 据此断言声明里
  不含 `yingshan`。
· **举折**:《营造法式》卷五"举屋之法:如殿阁楼台,先量前后橑檐方心
  相去远近,分为三分……若厅堂及筒瓦,两分中取一分,若瓴瓦,三分中取一分。"
  本模块取举高 = **全跨 / 3.2**(约 32°,落在"三分中取一分"一档),
  折屋做成 `z ∝ t^1.6` 的凹曲(檐口平缓、近脊处陡),
  **正脊标高处不动** —— 起翘只抬檐口。
· **格子门**:《营造法式》小木作,每间四扇,腰上留格眼。格眼高度
  为门扇通高的 **2/3**,对齐 `Building.LATTICE_GLASS_RATIO`。
· **瓦垄**:筒瓦成垄,垄距 **0.22m**(落在 `TILE_ROW_SPACING` 0.20~0.24
  内),垄起伏 0.035m。
· **城门**:门道净宽 5.6m、进深 19.3m、截面梯形(顶/底 = 0.86);
  城墙夯土,高 12.48m、厚 18.41m。
· **彩楼欢门不在这里** —— 归 `05_celebrations.py`。

本模块跑完即可复量的数
----------------------
· 前檐柱顶标高 = 檐口 = 3.30m,格子门顶 = 3.00m。**落差 0.30m 是刻意的**:
  校验器靠它从"前檐"这一个物体里分别数出柱数与门扇数(见
  `validate_scale._count_columns_and_leaves`)。
· 檐口最低点 = 3.30 − 屋面厚 0.28 = 3.02m,台基顶 0.35m
  → 檐口净高 2.67m,余量 0.27m。
· 正脊两端 y 取屋面网格**自己的采样值**,所以屋面物体的不同 y 值
  个数恒为 2·垄数+1,垄距是结构性可量的,不依赖浮点去重。

已知简化(如实声明,不等于已还原)
--------------------------------
1. **庑殿与歇山按直坡生成**:未做举折凹曲,也未做翼角起翘
   (悬山有起翘)。
2. **庑殿与歇山屋面不做瓦垄**,故不写 `qm_tiles` —— `tile.row`
   不会去量它们。只有悬山屋面有筒瓦垄。
3. **歇山只用于酒楼二层**:收山 1.0m,山花取檐口到正脊的 0.45 高。
4. **城楼屋面为直坡庑殿,重檐由两层四坡壳叠成**,未做斗拱层与平座。
5. **女墙未做**:城墙按"夯土墙身顶面 = 12.48m"建,顶上没有垛口。
   加了女墙,`wall.height` 量到的就是女墙顶而不是墙身顶 —— 一个数
   指两个标高。与其含糊,不如不做并写明。
6. **建筑内部是空腔**(省掉内檐装修);透过格眼能看到对侧山墙内面。
7. **临街地坪在台基处的台阶未做**,台基直接落在市井地坪上。

坐标约定
--------
`dirn = +1` 东岸、`-1` 西岸。所有 x 一律给"离河心的正距离",内部乘
`dirn` —— 与 `00_layout` / `02_river` 同一套,`config.Site` 里的数
就只用写一遍。
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector

BLENDER_DIR = Path(__file__).resolve().parents[1]
if str(BLENDER_DIR) not in sys.path:
    sys.path.insert(0, str(BLENDER_DIR))

import config as C              # noqa: E402
from lib import bl_utils as BU  # noqa: E402
from lib import tag_utils as TU  # noqa: E402

S = C.Site
B = C.Building
G_ = C.Gate
P = C.Palette

SEED = getattr(C, "SEED", 20240601)

# --------------------------------------------------------------------------
# 构造参数
# --------------------------------------------------------------------------

PLINTH_TOP = 0.35        # 台基顶面标高(街面 z = 0 之上)
PLINTH_SINK = 0.30       # 台基埋入地坪的深度:避免台基底面与地面共面闪面
PLINTH_FRONT_OUT = 0.55  # 台基向街的一面出挑
PLINTH_BACK_OUT = 0.25

EAVE_Z = 3.30            # 檐口(瓦口)标高 —— 前檐柱顶同高
FLOOR2_H = 2.40          # 二层净高:腰檐标高 → 二层檐口标高
ROOF_T = 0.28            # 屋面总厚(椽 + 望板 + 瓦)
ROOF_SLOPE_OUT = 0.70    # 檐口沿坡向出挑
GABLE_OUT = 0.35         # 悬山两山出挑 —— 有出挑才叫悬山
# 举高 = 全跨 / RIDGE_DENOM。
#
# ⚠️ 分母是**全跨**(前后檐口之距),不是半跨。这一点量过:
#    原先写的是 `0.5 * abs(x_hi - x_lo) / RIDGE_DENOM`,等于全跨 / 6.4,
#    茶肆那片屋面实测与水平面夹角只有 **17.4°**。射线打上去,
#    一块 10 米的进深上法线一路都是 (−0.30, 0, 0.95) —— 一整片近乎水平的板。
#    我先前把这块板读成了"腰檐的平顶",还去查 `_hip_ring` 的拓扑,查错了地方。
#
#    《营造法式》卷五·举折:"如殿阁楼台,先量前后橑檐方心相去远近,分为三分
#    ……若厅堂及筒瓦,两分中取一分,若瓴瓦,三分中取一分。" 即殿阁取全跨的
#    1/3、厅堂与筒瓦顶取 1/2、瓴瓦顶取 1/3。本项目的铺面是筒瓦/瓴瓦级别的小
#    建筑,取 1/3.2 落在"三分中取一分"这一档里,对应坡度约 32°。
#    原版 1/6.4 比《法式》里最保守的一档还平一半 —— 是算式写错,不是审美选择。
RIDGE_DENOM = 3.2        # 举高 = 全跨 / 3.2,约 32°(法式"三分中取一分")
TILE_SPACING = 0.22      # 瓦垄距(m)
TILE_RIB_H = 0.035       # 瓦垄起伏高度
JUZHE_P = 1.60           # 折屋凹曲指数
EAVE_LIFT = 0.45         # 悬山檐口两端翘起量

DOOR_HEAD_GAP = 0.30     # 格子门顶比檐口低这么多 —— 校验器靠它分离柱与门
FRAME_T = 0.10           # 门框 / 腰串料厚
LEAF_PANEL_T = 0.05      # 裙板厚
SCREEN_BAR = 0.03        # 格眼棂条截面
SCREEN_NV = 3            # 每扇格眼的竖棂条数(含左右边梃)
SCREEN_NH = 5            # 每扇格眼的横棂条数(含上下边梃)

WALL_BATTER = G_.WALL_BATTER   # 城墙收分:顶部每侧内收(m)
GATE_HALF_Y = 8.0        # 城台沿 y 的半长
PASSAGE_Z = 7.0          # 门道净高

NEAR_Y = 52.0            # 近景区 |y| 上限(带瓦垄与格子门的范围)
MID_Y = 96.0             # 中景排布 |y| 上限
# ⚠️ 远景的 |y| 上限**就是 `Site.Y_MAX`**,不能自己许一个更大的数。
#    `Site.Y_MIN/Y_MAX = ±120` 是"细致地面"的范围,超过它之后两岸
#    交给远景地裙(粗分块),城墙也只放样到 120 为止。本模块第一版
#    把这里写成 240,于是最外一圈房基落在**没有地面、也没有城墙**的
#    空处 —— 正投影俯视图上看不出来,一张低角度远景就会露馅。
FAR_Y = S.Y_MAX

FRONT_FACE = S.STREET_OUTER      # 21.2 临街面
FRONT_BACK = 30.0                # 第一排进深 8.8
ROW2_FACE = 32.0                 # 第二排临街面
ROW2_BACK = 40.8
FARROW_FACE = 44.0               # 里坊 / 仓房
FARROW_BACK = 51.5

RIDGE_BAR_W = 0.20
RIDGE_BAR_H = 0.18


# --------------------------------------------------------------------------
# 小工具
# --------------------------------------------------------------------------


def _lift(y: float, y_mid: float, half: float, amount: float) -> float:
    """檐口起翘量。两端最大、中间为零;指数 2.2 让中间一大段保持平直。"""
    if half <= 1e-9:
        return 0.0
    return amount * (abs(y - y_mid) / half) ** 2.2


def _roof_z(
    x: float, x_lo: float, x_mid: float, x_hi: float,
    z_eave: float, z_ridge: float, lift: float,
) -> float:
    """
    举折曲线:檐口 (x_lo, z_eave+lift) 到正脊 (x_mid, z_ridge) 之间的凹曲。

    `z = A + B·t^p`(t 从檐口 0 到正脊 1),**正脊处 z 恒等于 z_ridge**、
    与 lift 无关。这是刻意的:起翘只抬檐口、不抬正脊,所以正脊线永远是
    水平直线。若把 lift 摊进整个表达式,正脊会跟着两端翘起来 ——
    俯视图上是一条拱脊,一望即知不对。
    """
    if (x <= x_mid) if (x_lo < x_mid) else (x >= x_mid):
        span = x_mid - x_lo
        t = (x - x_lo) / span if abs(span) > 1e-9 else 1.0
    else:
        span = x_hi - x_mid
        t = (x_hi - x) / span if abs(span) > 1e-9 else 1.0
    t = min(1.0, max(0.0, t))
    return (z_eave + lift) + (z_ridge - z_eave - lift) * (t ** JUZHE_P)


def _poly_area(pts: list[Vector]) -> float:
    """Newell 面积。用来剔除退化面。"""
    n = len(pts)
    if n < 3:
        return 0.0
    acc = Vector((0.0, 0.0, 0.0))
    for i in range(n):
        a, b = pts[i], pts[(i + 1) % n]
        acc += a.cross(b)
    return 0.5 * acc.length


def _emit_shell(
    b: BU.MeshBuilder,
    pts: list[Vector],
    faces: list[tuple[int, ...]],
    thick: float,
    boundary: list[int],
) -> None:
    """
    把"顶面 + 面表"包成有厚度的**闭合壳**:底面 = 顶面下降 thick,
    沿 boundary 环封边。

    ⚠️ 两条纪律:

    1. 只有顶面的边界**恰好等于 `boundary`** 时才闭得严。庑殿 / 歇山 /
       四坡裙的顶面边界都是檐口矩形四条边,故直接传那四个角点。
       漏一条边,法线重算就把这一片当成开壳,朝向全看运气。

    2. **退化面不进面表。** 歇山在 `shanhua_k = 1` 时退化成庑殿,
       山花三角与撒头梯形都会塌成零面积 —— 它们不会被 `mesh.validate()`
       报错,而是被**静默删掉**,剩下一个带洞的壳。所以在这里主动筛掉,
       并且由调用方为退化情形补齐正确的面(见 `_hip_shell` 的两条分支)。
    """
    n = len(pts)
    keep = [f for f in faces if _poly_area([pts[i] for i in f]) > 1e-9]
    base = len(b.verts)
    for p in pts:
        b.verts.append((p.x, p.y, p.z))
    for p in pts:
        b.verts.append((p.x, p.y, p.z - thick))
    for f in keep:
        b.faces.append(tuple(base + i for i in f))
        b.faces.append(tuple(base + n + i for i in reversed(f)))
    for i in range(len(boundary)):
        a = boundary[i]
        c = boundary[(i + 1) % len(boundary)]
        b.add_quad_idx(base + a, base + n + a, base + n + c, base + c)


# --------------------------------------------------------------------------
# 屋面发生器 1:悬山(带瓦垄、举折、起翘)
# --------------------------------------------------------------------------


def _gable_roof(
    b: BU.MeshBuilder,
    dirn: int,
    x_out_front: float,
    x_out_back: float,
    y_lo: float,
    y_hi: float,
    *,
    z_eave: float = EAVE_Z,
    tiled: bool = True,
    lift_amt: float = EAVE_LIFT,
    rib_h: float = TILE_RIB_H,
) -> dict:
    """
    悬山屋面:两坡、带筒瓦垄、举折凹曲、檐口两端起翘。

    网格是 **(2n+1) 行(y)× 9 列(x)**:y 每半垄一个点,列取
    前檐口 → 正脊 → 后檐口的 9 个举折站位。**顶面与底面逐点对齐**,
    于是封边可以逐节点连,壳是严的。

    为什么底面不能"两行 y 拉一条直线"敷衍过去:起翘在两端有 0.45m,
    底面若按中间标高拉平,封边四边形会出现上边低于下边的**翻转面**。
    翻转面不报错、`recalc_face_normals` 之后看着还挺正常 ——
    但它是块背面朝外的洞。

    `tiled=False` 时垄数降到 6 段以内 —— 不铺瓦就不需要每半垄一个点,
    否则中景几十片屋面会白白吃掉十几万面。
    """
    x_lo, x_hi = dirn * x_out_front, dirn * x_out_back
    x_mid = 0.5 * (x_lo + x_hi)
    z_ridge = z_eave + abs(x_hi - x_lo) / RIDGE_DENOM

    y_mid = 0.5 * (y_lo + y_hi)
    half_y = 0.5 * (y_hi - y_lo)

    span_y = y_hi - y_lo
    n_rib = (max(1, round(span_y / TILE_SPACING)) if tiled
             else max(2, min(6, round(span_y / 4.0))))
    step = span_y / n_rib
    ys: list[float] = []
    for k in range(n_rib):
        ys.append(y_lo + k * step)              # 瓦沟
        ys.append(y_lo + (k + 0.5) * step)      # 瓦垄
    ys.append(y_hi)

    ts = (0.0, 0.25, 0.5, 0.75, 1.0)
    xs = [x_lo + (x_mid - x_lo) * t for t in ts]
    xs += [x_hi + (x_mid - x_hi) * t for t in ts[1:]]
    t_of = list(ts) + list(ts[1:])

    rows_top: list[list[Vector]] = []
    rows_bot: list[list[Vector]] = []
    for i, y in enumerate(ys):
        ly = _lift(y, y_mid, half_y, lift_amt)
        is_rib = (i % 2 == 1)
        rt: list[Vector] = []
        rb: list[Vector] = []
        for j, x in enumerate(xs):
            z = _roof_z(x, x_lo, x_mid, x_hi, z_eave, z_ridge, ly)
            # 垄起伏在正脊处收到 0:正脊是压顶的实体,不是一排齿
            c = rib_h * (1.0 - t_of[j]) ** 0.35 if (tiled and is_rib) else 0.0
            rt.append(Vector((x, y, z + c)))
            rb.append(Vector((x, y, z - ROOF_T)))
        rows_top.append(rt)
        rows_bot.append(rb)

    base_t = b.add_grid(rows_top)
    base_b = b.add_grid(rows_bot, flip=True)

    m = len(xs)
    rows_n = len(ys)

    def ti(i: int, j: int) -> int:
        return base_t + i * m + j

    def bi(i: int, j: int) -> int:
        return base_b + i * m + j

    for i in range(rows_n - 1):                 # 前后檐口:沿 y 封
        for j in (0, m - 1):
            b.add_quad_idx(ti(i, j), ti(i + 1, j), bi(i + 1, j), bi(i, j))
    for j in range(m - 1):                      # 两山:沿 x 封
        for i in (0, rows_n - 1):
            b.add_quad_idx(ti(i, j), ti(i, j + 1), bi(i, j + 1), bi(i, j))

    # 正脊。两端 y 取**网格自己的采样值**,不另取 —— 否则屋面物体的
    # 不同 y 值集合里会多出两个孤立值,瓦垄距就量不准了。
    if n_rib >= 4:
        i0, i1 = 2, rows_n - 3
        b.add_box3(
            Vector((x_mid, 0.5 * (ys[i0] + ys[i1]), z_ridge + RIDGE_BAR_H * 0.5)),
            Vector((0.0, 1.0, 0.0)), Vector((0.0, 0.0, 1.0)), Vector((1.0, 0.0, 0.0)),
            ys[i1] - ys[i0], RIDGE_BAR_H, RIDGE_BAR_W,
        )

    return {
        "form": "xuanshan",
        "x_lo": x_lo, "x_hi": x_hi, "x_mid": x_mid,
        "z_eave": z_eave, "z_ridge": z_ridge,
        "n_rib": n_rib, "tiles": bool(tiled), "xs": xs,
    }


# --------------------------------------------------------------------------
# 屋面发生器 2:庑殿 / 歇山(直坡;shanhua_k = 1 退化为庑殿)
# --------------------------------------------------------------------------


def _hip_shell(
    b: BU.MeshBuilder,
    dirn: int,
    x_out_front: float,
    x_out_back: float,
    y_lo: float,
    y_hi: float,
    *,
    z_eave: float,
    shoushan: float,
    shanhua_k: float,
    thick: float = ROOF_T,
) -> dict:
    """
    庑殿 / 歇山屋面(直坡)。一个函数管两种形制,靠 `shanhua_k` 分:

        shanhua_k = 1.0  → 山花高度为 0,两山斜坡直交于正脊端 —— **庑殿**
        shanhua_k < 1.0  → 山面在 z_s 处被竖面截断,上部立山花 —— **歇山**

    `shoushan` 是收山(正脊端比檐口端在 y 上收进多少)。庑殿传半跨
    (斜脊在平面上成 45°),歇山传约一檩径。

    把两种形制合到一个函数里,不是为了省代码,是为了**保证它们是同一个
    亲族**:歇山的山花高度趋于 0 时,几何必须**逐点收敛**到庑殿。分成
    两个函数写,这一点就只能靠人记着,迟早会漂。

    顶点编号(见下面的 pts):
        0,1,2,3  檐口矩形四角(y_lo 侧 0-1,y_hi 侧 3-2)
        4,5      正脊两端
        6,7      y_lo 侧山花基(6 属 x_lo 长坡,7 属 x_hi 长坡)
        8,9      y_hi 侧山花基
    顶面边界恒为 [0,1,2,3]。

    已知简化:**直坡,无举折、无起翘、无瓦垄**(故不写 `qm_tiles`)。
    """
    x_lo, x_hi = dirn * x_out_front, dirn * x_out_back
    x_mid = 0.5 * (x_lo + x_hi)
    z_ridge = z_eave + abs(x_hi - x_lo) / RIDGE_DENOM

    s = min(shoushan, 0.45 * (y_hi - y_lo))
    y_lo2, y_hi2 = y_lo + s, y_hi - s

    k = min(1.0, max(0.05, shanhua_k))
    z_s = z_eave + (z_ridge - z_eave) * k
    xa = x_lo + (x_mid - x_lo) * k
    xb = x_hi + (x_mid - x_hi) * k

    V = Vector
    pts = [
        V((x_lo, y_lo, z_eave)), V((x_hi, y_lo, z_eave)),
        V((x_hi, y_hi, z_eave)), V((x_lo, y_hi, z_eave)),
        V((x_mid, y_lo2, z_ridge)), V((x_mid, y_hi2, z_ridge)),
        V((xa, y_lo2, z_s)), V((xb, y_lo2, z_s)),
        V((xa, y_hi2, z_s)), V((xb, y_hi2, z_s)),
    ]

    if abs(xb - xa) < 1e-6:
        # 庑殿:两条长坡 + 两山各一个斜脊三角
        faces = [(0, 3, 5, 4), (1, 2, 5, 4), (0, 1, 4), (2, 3, 5)]
    else:
        # 歇山:x_lo 长坡 = 梯形 + 斜脊三角 + 山花边三角,余同
        faces = [
            (0, 3, 5, 4), (3, 8, 5), (0, 4, 6),
            (1, 2, 5, 4), (2, 9, 5), (1, 4, 7),
            (0, 1, 7, 6), (2, 3, 8, 9),
            (6, 7, 4), (8, 9, 5),
        ]

    _emit_shell(b, pts, faces, thick, [0, 1, 2, 3])
    return {
        "form": "wudian" if abs(xb - xa) < 1e-6 else "xieshan",
        "x_lo": x_lo, "x_hi": x_hi, "x_mid": x_mid,
        "z_eave": z_eave, "z_ridge": z_ridge,
        "shanhua_k": k, "shoushan": s, "tiles": False,
    }


def _hip_ring(
    b: BU.MeshBuilder,
    dirn: int,
    rect_lo: tuple[float, float, float, float],
    rect_hi: tuple[float, float, float, float],
    z_lo: float,
    z_hi: float,
    thick: float = ROOF_T,
) -> None:
    """
    四坡裙(腰檐 / 重檐下檐):檐口矩形 → 顶面矩形的四面坡。

    `rect_* = (x 近河侧, x 远河侧, y 起, y 止)`,x 一律给正距离。
    """
    x0, x1, y0, y1 = (dirn * rect_lo[0], dirn * rect_lo[1], rect_lo[2], rect_lo[3])
    tx0, tx1, ty0, ty1 = (dirn * rect_hi[0], dirn * rect_hi[1], rect_hi[2], rect_hi[3])
    V = Vector
    pts = [
        V((x0, y0, z_lo)), V((x1, y0, z_lo)),
        V((x1, y1, z_lo)), V((x0, y1, z_lo)),
        V((tx0, ty0, z_hi)), V((tx1, ty0, z_hi)),
        V((tx1, ty1, z_hi)), V((tx0, ty1, z_hi)),
    ]
    faces = [
        (0, 3, 7, 4), (1, 5, 6, 2),
        (0, 1, 5, 4), (3, 7, 6, 2),
        (4, 5, 6, 7),
    ]
    _emit_shell(b, pts, faces, thick, [0, 1, 2, 3])


# --------------------------------------------------------------------------
# 建筑构件
# --------------------------------------------------------------------------


def _plinth(
    b: BU.MeshBuilder, dirn: int,
    x_face: float, x_back: float, y0: float, y1: float,
) -> None:
    """台基。沉入地坪 0.30,避免与地面共面闪面。"""
    a = dirn * (x_face - PLINTH_FRONT_OUT)
    c = dirn * (x_back + PLINTH_BACK_OUT)
    b.add_aabb(
        Vector((min(a, c), y0, -PLINTH_SINK)),
        Vector((max(a, c), y1, PLINTH_TOP)),
    )


def _gable_wall(
    b: BU.MeshBuilder, dirn: int,
    x_face: float, x_back: float,
    y_out: float, y_in: float,
    roof: dict, y_mid: float, half_y: float, lift_amt: float,
) -> None:
    """
    山墙。上缘**跟着屋面底走**,不另编一条线。

    外侧断面用 y_out 处的起翘量、内侧用 y_in 处的,做渐变放样。
    两侧用同一条断面,墙要么穿出屋面(外端翘得高),要么在檐下留缝 ——
    都是几厘米,也都是能看出来的几厘米。

    ⚠️ 断面必须是**简单多边形**。底边从左到右、上缘从右到左地连,
       是"沿屋面下缘走回去"的闭合环。写成底边→底边→上缘→上缘
       就成了自交的蝴蝶结,不报错,但面片朝向一塌糊涂。
    """
    x_lo, x_hi, x_mid = roof["x_lo"], roof["x_hi"], roof["x_mid"]
    lo, hi = min(dirn * x_face, dirn * x_back), max(dirn * x_face, dirn * x_back)

    def profile(y: float) -> list[tuple[float, float]]:
        ly = _lift(y, y_mid, half_y, lift_amt)

        def zc(x: float) -> float:
            return _roof_z(x, x_lo, x_mid, x_hi,
                           roof["z_eave"], roof["z_ridge"], ly) - ROOF_T

        # ⚠️ `roof["xs"]` 是**采集顺序**不是升序:它先从前檐走到正脊,
        #    再从后檐走回正脊,末尾与中段会重复落到正脊站位上。
        #    原样拿来当断面点就会走成"出去又折回"的自交多边形 ——
        #    而且它**不报错**,`build()` 照样给你一个物体,只是面片
        #    朝向一塌糊涂。所以这里必须显式排序 + 去重。
        xs = [lo]
        seen = {round(lo, 6), round(hi, 6)}
        for x in sorted(roof["xs"]):
            if not (lo + 1e-6 < x < hi - 1e-6):
                continue
            k = round(x, 6)
            if k in seen:
                continue
            seen.add(k)
            xs.append(x)
        xs.append(hi)
        top = [(x, zc(x)) for x in xs]           # 按 x 升序
        return ([(lo, PLINTH_TOP - 0.05), (hi, PLINTH_TOP - 0.05)]
                + top[::-1])                      # 上缘回到 lo

    b.add_loft(profile(y_out), y_out, profile(y_in), y_in)


def _facade(
    b: BU.MeshBuilder, dirn: int,
    x_face: float, y0: float, y1: float, bays: int, z_eave: float,
) -> None:
    """
    前檐柱。柱顶一直接到檐口,比格子门顶高 `DOOR_HEAD_GAP` ——
    校验器靠这 0.30 的落差,从"前檐"这一个物体里把柱数和门扇数分别
    数出来。柱数 − 1 就是间数。

    ⚠️ `z_eave` 必须由调用方传入,**不能读模块级的 EAVE_Z**。
       本函数第一版读的是 EAVE_Z,而二层酒楼一层柱子被要求升到 4.70、
       门升到 4.40 —— 门比柱子还高,校验器于是把"最高的 4 个顶点一簇"
       当成了门而非柱,数出 47 间 0 扇。**几何错了,量具就会以很奇怪
       的方式报错**,而那个错看着像是校验器的问题。
    """
    x = dirn * x_face
    span = y1 - y0
    for i in range(bays + 1):
        yc = y0 + span * i / bays
        yc = min(max(yc, y0 + 0.12), y1 - 0.12)
        b.add_box(
            Vector((x, yc, PLINTH_TOP - 0.05)), Vector((x, yc, z_eave)),
            0.22, 0.22, Vector((0.0, 1.0, 0.0)),
        )


def _door_leaf(
    b: BU.MeshBuilder, dirn: int,
    x_face: float, yc: float, width: float,
    sill: float, head: float,
) -> tuple[float, float]:
    """
    一扇格子门的下半部分(边梃、上下框、腰串、裙板)。
    返回格眼的 (z0, z1)。

    格眼高度 = 门扇通高的 2/3(《营造法式》腰上三分之二),**腰串顶面
    由 head 与 opening 反推** —— 不另写一个常数,否则改门高时两者会脱钩。

    ⚠️ 比例的**分母是门扇通高 `head - sill`**,不是扣掉上框后的净开口。
       本函数第一版写的是 `(head - sill - ft) * 2/3`,量出来 0.6415,
       落在 `Building.LATTICE_GLASS_RATIO` 的 0.66–0.68 之外 —— 差
       0.02 看着无关紧要,但"腰上三分之二"是这条断言的全部内容,
       量出来是 0.64 就等于没做到。差的那 0.1m 正是上框料厚,
       两次都从净开口里扣,就扣重了。
    """
    x = dirn * x_face
    ft = FRAME_T
    y_a = yc - width * 0.5

    for yy in (y_a + ft * 0.5, yc + width * 0.5 - ft * 0.5):   # 左右边梃
        b.add_box(Vector((x, yy, sill)), Vector((x, yy, head)),
                  ft, ft, Vector((0.0, 1.0, 0.0)))
    b.add_box(Vector((x, yc, head - ft)), Vector((x, yc, head)),          # 上框
              width, ft, Vector((0.0, 1.0, 0.0)))
    b.add_box(Vector((x, yc, sill)), Vector((x, yc, sill + ft)),          # 下框
              width, ft, Vector((0.0, 1.0, 0.0)))

    # 取 config 那条带的中点,而不是写死 2/3 —— 改带就跟着改几何
    ratio = 0.5 * (B.LATTICE_GLASS_RATIO[0] + B.LATTICE_GLASS_RATIO[1])
    opening = (head - sill) * ratio
    rail_top = (head - ft) - opening
    b.add_box(Vector((x, yc, rail_top - ft * 0.9)), Vector((x, yc, rail_top)),
              width, ft * 0.9, Vector((0.0, 1.0, 0.0)))                   # 腰串
    b.add_box(Vector((x, yc, sill + ft)), Vector((x, yc, rail_top - ft * 0.9)),
              width * 0.92, LEAF_PANEL_T, Vector((0.0, 1.0, 0.0)))        # 裙板

    return rail_top, head - ft


def _screen(
    b: BU.MeshBuilder, dirn: int,
    x_face: float, yc: float, width: float,
    z0: float, z1: float,
) -> None:
    """
    一扇格眼。棂条**顶满** z0..z1 与整扇宽 —— 于是它的包围盒就是
    格眼开口本身,`lattice.ratio` 量的正是这个。

    ⚠️ 横棂的 a→b 必须给一点长度:`add_box` 在长度 < 1e-9 时**静默返回**。
       写 `add_box(p, p, …)` 想让横棂"沿两个方向各展一次",结果是一根
       都不生成 —— 而格眼看上去只是"竖棂稀了点",不会有人去数。
    """
    x = dirn * x_face
    bar = SCREEN_BAR
    eps = bar * 0.5

    for i in range(SCREEN_NV):                   # 竖棂(含左右边梃)
        yy = yc - width * 0.5 + bar * 0.5 + (width - bar) * i / max(1, SCREEN_NV - 1)
        b.add_box(Vector((x, yy, z0)), Vector((x, yy, z1)),
                  bar, bar, Vector((0.0, 1.0, 0.0)))
    for j in range(SCREEN_NH):                   # 横棂(含上下边梃)
        zz = z0 + bar * 0.5 + (z1 - z0 - bar) * j / max(1, SCREEN_NH - 1)
        b.add_box(Vector((x, yc, zz - eps)), Vector((x, yc, zz + eps)),
                  width, bar, Vector((0.0, 1.0, 0.0)))


AWNING_OUT = 1.7         # 出挑深度:自前檐柱向外。原为 2.2,正视时把格子门
                         # 上部格眼整条盖住 —— 棚要遮阳,不能把自己店的
                         # 门脸挡没,何况格眼是这一版要验的东西
AWNING_BAY = 3.0         # 一间宽度:撑杆间距
AWNING_DROP = 0.35       # 外沿比内沿低多少 —— 布棚要往下溜水


def _awning(
    b: BU.MeshBuilder, dirn: int,
    x_face: float, y0: float, y1: float, z_at: float,
) -> None:
    """
    临河茶肆前的凉棚:分间的棚布 + 每间两根撑杆。

    改过两版,两版的问题都记在这儿:

    1. 初版是一片 2.2 × 0.86·(铺面长) 的**水平**板,两根撑杆支在两端。
       一栋铺面十几米长,等于一根 11 米的悬臂只靠两根细杆 —— 图上看着
       就是一块飘着的白板。改成**按间分**,每 ≤3.0m 一组撑杆。
    2. 初版是**水平**的,读起来像现代雨篷。布棚要往外溜水,外沿压低
       `AWNING_DROP`。顶上再铺一道脊杆,好让"布绷在杆上"这件事看得出来。

    布色改用 `CLOTH_DIM`:原先的 `CLOTH_UNDYED`(0.66,0.61,0.50)是全场景
    最亮的东西,一块十几米的亮面会把整条街的明度重心拽过去。
    """
    xf = dirn * x_face
    out = dirn * (x_face - AWNING_OUT)
    z_in = z_at - 0.10
    z_out = z_in - AWNING_DROP
    n_bay = max(1, round((y1 - y0) / AWNING_BAY))
    step = (y1 - y0) / n_bay

    for i in range(n_bay):
        ya, yb = y0 + step * i, y0 + step * (i + 1)
        # 棚布:内沿高、外沿低,四角给出高差 —— 直接给 8 个角点
        b.add_hexa([
            Vector((xf, ya, z_in)), Vector((out, ya, z_out)),
            Vector((xf, yb, z_in)), Vector((out, yb, z_out)),
            Vector((xf, ya, z_in - 0.05)), Vector((out, ya, z_out - 0.05)),
            Vector((xf, yb, z_in - 0.05)), Vector((out, yb, z_out - 0.05)),
        ])
        for yy in (ya, yb):
            b.add_box(
                Vector((out, yy, PLINTH_TOP - 0.05)), Vector((out, yy, z_out - 0.02)),
                0.09, 0.09, Vector((0.0, 1.0, 0.0)),
            )
    # 外沿通长的檐杆 —— 把分间的棚布在视觉上连成一片
    b.add_box(
        Vector((out, y0, z_out - 0.06)), Vector((out, y1, z_out - 0.06)),
        0.09, 0.09, Vector((0.0, 1.0, 0.0)),
    )


# --------------------------------------------------------------------------
# 铺面装配
# --------------------------------------------------------------------------


def _build_shop(
    coll, mats,
    dirn: int, y0: float, y1: float, bid: str,
    *,
    storeys: int = 1,
    awning: bool = False,
    lod: str = "near",
    hotspot: bool = False,
    label: str = "",
) -> dict:
    """
    一栋临街铺面。近景拆成五个物体:台基 / 屋身 / 前檐柱+格子门 / 格眼 / 屋面。

    为什么不合一个:每一件都要**单独量尺寸** —— 檐口净高要"屋面最低点减
    台基顶",格子门要数扇数与格眼占比。合成一个物体就只剩"这堆东西的
    包围盒",什么形制都验不出来。分组判据是 `qm_parent == bid`,
    与船只"一船多件"完全同构。
    """
    L = y1 - y0
    x_face, x_back = FRONT_FACE, FRONT_BACK
    # **一层的檐口就是 EAVE_Z,二层也一样** —— 二层的重檐是"在这之上
    # 再接一层",不是"把一层整个抬高"。早先写成 EAVE_Z + 1.4 让一层
    # 柱子升到 4.70,量出来的东西全是错的:檐口净高成了 4.0m,
    # 而格子门顶(4.40)反而高过柱顶(3.30),`lattice.*` 直接数崩。
    z_eave1 = EAVE_Z                       # 一层檐口 = 腰檐标高
    z_eave2 = EAVE_Z + FLOOR2_H            # 二层檐口,仅二层用到
    bays = max(2, min(5, round(L / B.BAY_WIDTH)))
    z_head = z_eave1 - DOOR_HEAD_GAP
    y_mid, half_y = 0.5 * (y0 + y1), 0.5 * L
    xf, xb = dirn * x_face, dirn * x_back

    out = {"id": bid, "kind": "shop", "bays": bays,
           "leaves": bays * B.LATTICE_LEAVES, "storeys": storeys}

    # —— 台基 ——
    pb = BU.MeshBuilder(f"{bid}_plinth")
    _plinth(pb, dirn, x_face, x_back, y0, y1)
    plinth = pb.build(mats.get("stone", P.STONE), coll)
    TU.tag(plinth, f"{bid}_plinth", "building", parent=bid, lod=lod, zone="市井",
           note="台基:building.eave 用它作檐口净高的下基准")

    # —— 屋身:后墙 + 额枋 (+ 二层的楼板与直棂窗)——
    fb = BU.MeshBuilder(f"{bid}_frame")
    back_in = dirn * (x_back - 0.25)
    fb.add_loft(
        [(xb, PLINTH_TOP - 0.05), (back_in, PLINTH_TOP - 0.05),
         (back_in, z_eave1), (xb, z_eave1)],
        y0, None, y1,
    )
    fb.add_box(                                   # 额枋
        Vector((xf, y0 + 0.10, z_eave1 - 0.18)),
        Vector((xf, y1 - 0.10, z_eave1 - 0.18)),
        0.18, 0.18, Vector((0.0, 1.0, 0.0)),
    )
    if storeys == 2:
        fb.add_aabb(Vector((min(xf, xb), y0, z_eave1 - 0.05)),      # 楼板
                    Vector((max(xf, xb), y1, z_eave1 + 0.25)))
        fb.add_loft([(xb, z_eave1 + 0.25), (back_in, z_eave1 + 0.25),
                     (back_in, z_eave2), (xb, z_eave2)],            # 二层后墙
                    y0, None, y1)
        fb.add_box(                                                  # 二层额枋
            Vector((xf, y0 + 0.10, z_eave2 - 0.18)),
            Vector((xf, y1 - 0.10, z_eave2 - 0.18)),
            0.18, 0.18, Vector((0.0, 1.0, 0.0)),
        )
        zz = z_eave1 + 0.75
        while zz < z_eave1 + 2.05:                # 上层直棂窗
            fb.add_box(Vector((xf, y0 + 0.30, zz)), Vector((xf, y1 - 0.30, zz)),
                       0.10, 0.08, Vector((0.0, 1.0, 0.0)))
            zz += 0.26
        # —— 二层两山端墙 ——
        #
        # ⚠️ 这两堵墙是补上去的,补的原因值得记下来:
        #    原先 `storeys == 2` 只给了后墙 + 前檐直棂窗,**两端完全敞开**。
        #    从山面看过去,视线穿过敞开的二层,直接落在腰檐(四坡裙)的
        #    顶面上 —— 那是一块 8×10 米的水平大平面。于是预览图里酒楼的
        #    腰檐看着像一块平屋顶/晒台,我一度以为是 `_hip_ring` 建错了。
        #    其实 `_hip_ring` 没错(它确实有四坡面),**是少了两堵墙**。
        #    又一次:症状的位置不是病灶的位置。
        #
        #    端墙的下沿取楼板顶(z_eave1 + 0.25)、上沿取上檐檐口(z_eave2),
        #    这样腰檐的顶面被四面(前后 + 两山)围住,不再外露。
        x_lo2, x_hi2 = min(xf, xb), max(xf, xb)
        for ya, yb in ((y0, y0 + 0.25), (y1 - 0.25, y1)):
            fb.add_loft(
                [(x_lo2, z_eave1 + 0.25), (x_hi2, z_eave1 + 0.25),
                 (x_hi2, z_eave2), (x_lo2, z_eave2)],
                ya, None, yb,
            )
    # ⚠️ 这里必须真的 build 一次。漏掉它**不会报任何错** ——
    #    `MeshBuilder` 只是个缓冲区,攒完不交出去就是一堆被丢弃的
    #    顶点,场景里少一堵后墙,而日志干干净净。本模块第一次跑就
    #    栽在这上面:8 个铺面一个有屋身都没有。
    frame = fb.build(mats.get("wood_old", P.WOOD_OLD), coll)
    TU.tag(frame, f"{bid}_frame", "building", parent=bid, lod=lod, zone="市井",
           note="屋身:后墙 + 额枋" + (";二层含楼板与上层直棂窗" if storeys == 2 else ""))

    # —— 前檐柱 + 格子门 ——
    db = BU.MeshBuilder(f"{bid}_facade")
    _facade(db, dirn, x_face, y0, y1, bays, z_eave1)
    leaf_w = (L - 0.30) / (bays * B.LATTICE_LEAVES)
    spans: list[tuple[float, float]] = []
    for k in range(bays * B.LATTICE_LEAVES):
        yc = y0 + 0.15 + leaf_w * (k + 0.5)
        spans.append(_door_leaf(db, dirn, x_face, yc, leaf_w * 0.94,
                                PLINTH_TOP, z_head))
    facade = db.build(mats.get("wood_plank", P.WOOD_PLANK), coll)
    TU.tag(facade, f"{bid}_facade", "building", parent=bid, lod=lod, zone="市井",
           note="前檐柱(顶 3.30)+ 格子门(顶 3.00):0.30m 落差用于分离计数")

    # —— 格眼 ——
    sb = BU.MeshBuilder(f"{bid}_screen")
    for k, (s0, s1) in enumerate(spans):
        yc = y0 + 0.15 + leaf_w * (k + 0.5)
        _screen(sb, dirn, x_face, yc, leaf_w * 0.94, s0, s1)
    screen = sb.build(mats.get("wood_old", P.WOOD_OLD), coll)
    TU.tag(screen, f"{bid}_screen", "building", parent=bid, lod=lod, zone="市井",
           note="格眼:高度占比须落在 Building.LATTICE_GLASS_RATIO")

    # —— 屋面 ——
    rb = BU.MeshBuilder(f"{bid}_roof")
    if storeys == 2:
        # 腰檐:四坡裙,檐口标高与单层铺面的檐口齐平 —— 整条街的
        # 一层檐口因此拉成一条水平线,`building.eave` 对全部建筑
        # 量到同一个 2.67m,而不是"单层 2.67、二层 4.0"两套数。
        _hip_ring(rb, dirn,
                  (x_face - 1.3, x_back + 1.3, y0 - 1.1, y1 + 1.1),
                  (x_face + 0.4, x_back - 0.4, y0 - 0.2, y1 + 0.2),
                  z_eave1, z_eave1 + 0.9)
        info = _hip_shell(rb, dirn, x_face - 0.6, x_back + 0.6,
                          y0 - 0.6, y1 + 0.6,
                          z_eave=z_eave2, shoushan=1.0, shanhua_k=0.45)
    else:
        info = _gable_roof(rb, dirn, x_face - ROOF_SLOPE_OUT,
                           x_back + ROOF_SLOPE_OUT, y0 - GABLE_OUT, y1 + GABLE_OUT)

    # —— 两山墙,断面跟着屋面底 ——
    if storeys == 1:
        gb = BU.MeshBuilder(f"{bid}_gable")
        for ya, yb in ((y0 - 0.02, y0 + 0.24), (y1 - 0.24, y1 + 0.02)):
            _gable_wall(gb, dirn, x_face, x_back, ya, yb,
                        info, y_mid, half_y, EAVE_LIFT)
        gables = gb.build(mats.get("wood_old", P.WOOD_OLD), coll)
        TU.tag(gables, f"{bid}_gable", "building", parent=bid, lod=lod, zone="市井",
               note="两山上墙:上缘按屋面底面量出,不另编一条线")

    if awning:
        ab = BU.MeshBuilder(f"{bid}_awning")
        _awning(ab, dirn, x_face, y0, y1, EAVE_Z)
        aw = ab.build(mats.get("cloth_dim", P.CLOTH_DIM), coll)
        TU.tag(aw, f"{bid}_awning", "building", parent=bid, lod=lod, zone="市井",
               label="凉棚", hotspot=True, anim="wind",
               note="茶肆前的布棚:分间撑杆、外沿压低 AWNING_DROP,布色 CLOTH_DIM")

    roof = rb.build(mats.get("tile_grey", P.TILE_GREY), coll)
    extra = {"qm_roof": info["form"]}
    if info.get("tiles"):
        extra["qm_tiles"] = TILE_SPACING
    TU.tag(roof, f"{bid}_roof", "building", parent=bid, lod=lod, zone="市井",
           label=label, hotspot=hotspot,
           note="形制只能声明、不能从三角网格反推 —— 见 tag_utils.qm_roof",
           **extra)

    out["roof"] = info["form"]
    out["tiles"] = bool(info.get("tiles"))
    out["y0"], out["y1"], out["dirn"] = y0, y1, dirn
    return out


# --------------------------------------------------------------------------
# 排布
# --------------------------------------------------------------------------


def _runs() -> list[tuple[float, float]]:
    """近景排布的 y 区间:桥轴线两侧各留 `Site.BRIDGE_CLEAR_Y`。"""
    c = S.BRIDGE_CLEAR_Y
    return [(c, NEAR_Y), (-NEAR_Y, -c)]


def _shop_chain(rng, y_lo: float, y_hi: float) -> list[tuple[float, float]]:
    """
    沿 y 排一串铺面。多数留 0.8~1.4m 间隔,偶尔是一条 2.5~4.0m 的巷 ——
    "远景有街巷层次"就靠这些巷。

    缝隙下限定在 0.8m 而不是更小:悬山两山各出挑 0.35m,总出挑 0.70m;
    小于这个数,相邻两片屋面会在空中相交。互穿在掠视下很显眼,而正投影
    预览图里完全看不出来。
    """
    out: list[tuple[float, float]] = []
    y = y_lo
    while y_hi - y >= 11.0:
        if rng.random() < 0.18:
            y += float(rng.uniform(2.5, 4.0))
            continue
        L = float(min(rng.uniform(11.5, 14.0), y_hi - y))
        if L < 11.0:
            break
        out.append((y, y + L))
        y += L + float(rng.uniform(0.8, 1.4))
    return out


def _mid_rows(coll, mats, rng, dirn: int) -> dict:
    """
    中景:第一排的延续(|y| 52~118)+ 第二排(|y| 14~118),合成三个物体
    (台基带 / 屋身 / 屋面)。

    中景不设单独台基,改成一条连续"街沿"台基带 —— 既接近宋代临街铺面
    的做法,又让 `building.eave` 仍然量得出来(带顶 vs 屋面最低点)。
    """
    sfx = "e" if dirn > 0 else "w"
    base = BU.MeshBuilder(f"mid_base_{sfx}")
    frame = BU.MeshBuilder(f"mid_frame_{sfx}")
    roof = BU.MeshBuilder(f"mid_roof_{sfx}")

    xa = dirn * (FRONT_FACE - 0.40)
    xb = dirn * (ROW2_BACK + 0.30)
    lo, hi = min(xa, xb), max(xa, xb)
    for ya, yb in ((S.BRIDGE_CLEAR_Y, MID_Y), (-MID_Y, -S.BRIDGE_CLEAR_Y)):
        base.add_slab(lo, hi, ya, yb, lambda x, y: PLINTH_TOP, thickness=0.55)

    x_face, x_back = FRONT_FACE, FRONT_BACK
    x_face2, x_back2 = ROW2_FACE, ROW2_BACK

    spans: list[tuple[float, float, float, float]] = []
    for ya, yb in ((NEAR_Y, MID_Y), (-MID_Y, -NEAR_Y)):
        spans += [(a, b, x_face, x_back) for a, b in _shop_chain(rng, ya, yb)]
    for ya, yb in ((S.BRIDGE_CLEAR_Y, MID_Y), (-MID_Y, -S.BRIDGE_CLEAR_Y)):
        spans += [(a, b, x_face2, x_back2) for a, b in _shop_chain(rng, ya, yb)]

    for a, b, xf_, xb_ in spans:
        f0, f1 = dirn * xf_, dirn * xb_
        frame.add_aabb(Vector((min(f0, f1), a, PLINTH_TOP - 0.05)),
                       Vector((max(f0, f1), b, EAVE_Z)))
        _gable_roof(roof, dirn, xf_ - ROOF_SLOPE_OUT, xb_ + ROOF_SLOPE_OUT,
                    a - GABLE_OUT, b + GABLE_OUT,
                    tiled=False, lift_amt=0.30, rib_h=0.0)

    bo = base.build(mats.get("stone", P.STONE), coll)
    TU.tag(bo, f"mid_base_{sfx}", "building", lod="mid", zone="市井",
           note="连续台基带:中景不设单独台基")
    fo = frame.build(mats.get("wood_old", P.WOOD_OLD), coll)
    TU.tag(fo, f"mid_frame_{sfx}", "building", lod="mid", zone="市井")
    ro = roof.build(mats.get("tile_grey", P.TILE_GREY), coll)
    TU.tag(ro, f"mid_roof_{sfx}", "building", lod="mid", zone="市井",
           qm_roof="xuanshan",
           note="中景屋面:悬山、无瓦垄(故无 qm_tiles),起翘减半")

    return {"count": len(spans), "side": sfx, "tris_hint": "no-tiles"}


def _far_rows(coll, mats, rng, dirn: int) -> dict:
    """
    远景:里坊 / 仓房的体量块,以及 |y| > 120 之后的成片屋群。

    只做体量 —— 方身 + 三角形悬山。远到看不见瓦、看不见门,
    它能提供的只有"街巷层次"那条轮廓线。
    """
    sfx = "e" if dirn > 0 else "w"
    b = BU.MeshBuilder(f"far_bldg_{sfx}")
    n = 0

    def block(x_face: float, x_back: float, ya: float, yb: float, h: float) -> None:
        nonlocal n
        f0, f1 = dirn * x_face, dirn * x_back
        lo, hi = min(f0, f1), max(f0, f1)
        b.add_aabb(Vector((lo, ya, -0.5)), Vector((hi, yb, h)))
        b.add_loft([(lo, h), (hi, h), (0.5 * (lo + hi), h + 0.22 * (hi - lo))],
                   ya, None, yb)
        n += 1

    for ya, yb in ((S.BRIDGE_CLEAR_Y, MID_Y), (-MID_Y, -S.BRIDGE_CLEAR_Y)):
        for a, c in _shop_chain(rng, ya, yb):
            block(FARROW_FACE, FARROW_BACK, a, c, float(rng.uniform(3.4, 4.6)))

    y = MID_Y + 2.0
    while y < FAR_Y:
        if rng.random() < 0.22:
            y += float(rng.uniform(3.0, 6.0))
            continue
        L = float(rng.uniform(8.0, 16.0))
        xf = float(rng.uniform(22.0, 34.0))
        block(xf, xf + float(rng.uniform(6.0, 9.0)), y, y + L,
              float(rng.uniform(3.2, 5.2)))
        if rng.random() < 0.55:
            xf2 = float(rng.uniform(38.0, 48.0))
            block(xf2, xf2 + float(rng.uniform(6.0, 10.0)), y + 1.0, y + L - 1.0,
                  float(rng.uniform(3.0, 4.6)))
        y += L + float(rng.uniform(1.0, 3.0))

    obj = b.build(mats.get("tile_grey", P.TILE_GREY), coll)
    if obj is not None:
        TU.tag(obj, f"far_bldg_{sfx}", "building", lod="far", zone="郊野",
               qm_roof="xuanshan",
               note="远景体量:只做悬山轮廓,无瓦垄、无门窗")

    # 中景两排的里坊:与远景合并进同一个物体,减少 drawcall
    return {"count": n, "side": sfx}


# --------------------------------------------------------------------------
# 城墙与城门
# --------------------------------------------------------------------------


def _city_wall(coll, mats, dirn: int) -> dict:
    """
    夯土城墙。断面为**收分梯形**:底厚 18.41m,顶每侧内收 WALL_BATTER。

    ⚠️ 女墙不做(见模块 docstring 第 5 条)。墙身顶面 = 12.48m,
       `wall.height` 量的就是它 —— 一个数只指一个标高。
    """
    sfx = "e" if dirn > 0 else "w"
    xi = dirn * S.WALL_INNER
    xo = dirn * (S.WALL_INNER + G_.WALL_THICKNESS)
    xi_t = dirn * (S.WALL_INNER + WALL_BATTER)
    xo_t = dirn * (S.WALL_INNER + G_.WALL_THICKNESS - WALL_BATTER)
    z_top = G_.WALL_HEIGHT

    gy0, gy1 = S.GATE_Y - GATE_HALF_Y, S.GATE_Y + GATE_HALF_Y
    b = BU.MeshBuilder(f"city_wall_{sfx}")
    for ya, yb in ((S.Y_MIN, gy0), (gy1, S.Y_MAX)):
        b.add_loft([(xi, -0.5), (xo, -0.5), (xo_t, z_top), (xi_t, z_top)],
                   ya, None, yb)
    obj = b.build(mats.get("hangtu", P.EARTH), coll)
    TU.tag(obj, f"city_wall_{sfx}", "gate", lod="far", zone="城墙",
           note="夯土墙身、无包砖;女墙未做,墙身顶面即 WALL_HEIGHT")
    return {"id": f"city_wall_{sfx}", "dirn": dirn}


def _gate(coll, mats) -> dict:
    """
    城门(东墙,`Site.GATE_Y`):墩台 + 城台 + 重檐庑殿门楼。三个物体。

      · `gate_pier`    —— 门道两侧墩台。**它的上下两条内边就是净宽**:
                          底 5.6m、顶 4.816m,之比 = PASSAGE_TAPER;
                          x 跨度即进深 PASSAGE_DEPTH。
      · `gate_bastion` —— 门道上方的夯土体。
      · `gate_tower`   —— 门楼。直角梯形门洞就是"墩台 + 城台"之间那个洞,
                          截面梯形、沿 x 贯通 —— 梯形门洞不需要单独建面。
    """
    depth = G_.PASSAGE_DEPTH
    hw = G_.PASSAGE_WIDTH * 0.5
    hw_top = hw * G_.PASSAGE_TAPER
    cx = S.WALL_INNER + G_.WALL_THICKNESS * 0.5
    x0, x1 = cx - depth * 0.5, cx + depth * 0.5
    z_top = G_.WALL_HEIGHT
    gy = S.GATE_Y

    pb = BU.MeshBuilder("gate_pier")
    for sgn in (+1, -1):
        y_in_b = gy + sgn * hw
        y_in_t = gy + sgn * hw_top
        y_out = gy + sgn * GATE_HALF_Y
        pb.add_hexa([
            Vector((x0, y_in_b, -0.5)), Vector((x1, y_in_b, -0.5)),
            Vector((x0, y_out, -0.5)), Vector((x1, y_out, -0.5)),
            Vector((x0, y_in_t, PASSAGE_Z)), Vector((x1, y_in_t, PASSAGE_Z)),
            Vector((x0, y_out, PASSAGE_Z)), Vector((x1, y_out, PASSAGE_Z)),
        ])
    pier = pb.build(mats.get("hangtu", P.EARTH), coll)
    TU.tag(pier, "gate_pier", "gate", lod="far", zone="城门",
           note="门道墩台:内侧面倾斜即收分,顶/底净宽之比 = PASSAGE_TAPER")

    bb = BU.MeshBuilder("gate_bastion")
    bb.add_aabb(Vector((x0, gy - GATE_HALF_Y, PASSAGE_Z)),
                Vector((x1, gy + GATE_HALF_Y, z_top)))
    bastion = bb.build(mats.get("hangtu", P.EARTH), coll)
    TU.tag(bastion, "gate_bastion", "gate", lod="far", zone="城门",
           note="门道上方的夯土体")

    tb = BU.MeshBuilder("gate_tower")
    z_body = z_top + 4.4
    tb.add_aabb(Vector((cx - 5.0, gy - 6.2, z_top)),
                Vector((cx + 5.0, gy + 6.2, z_body)))
    _hip_ring(tb, +1, (cx - 10.0, cx + 10.0, gy - 9.4, gy + 9.4),
              (cx - 5.6, cx + 5.6, gy - 6.8, gy + 6.8),
              z_body - 0.9, z_body + 0.7, 0.30)
    _hip_shell(tb, +1, cx - 6.2, cx + 6.2, gy - 7.6, gy + 7.6,
               z_eave=z_body + 0.9, shoushan=6.2, shanhua_k=1.0, thick=0.30)
    tower = tb.build(mats.get("tile_dark", P.TILE_DARK), coll)
    TU.tag(tower, "gate_tower", "gate", lod="far", zone="城门",
           qm_roof="wudian", label="城门楼", hotspot=True,
           note="重檐庑殿:两层四坡壳叠合,直坡、无起翘;斗拱层未做")

    return {"id": "gate", "passage_h": PASSAGE_Z, "depth": depth, "x": (x0, x1)}


# --------------------------------------------------------------------------
# 主入口
# --------------------------------------------------------------------------


def build() -> dict:
    BU.clear_scene_once()
    # 集合名 = `config.Export.CHUNKS["scene_props"]` 里列的名字,**两边必须逐字相同**。
    # 此前这里叫 "buildings"(英文),而分块表里写的是 "建筑群" —— 于是
    # `objects_in()` 一个物体也没匹配到,scene_props.glb 整块**根本没被导出**,
    # 而构建照样报成功,只在日志里留一行容易被忽略的「[跳过] scene_props」。
    # 现在这条由 `09_export.assert_full_coverage()` 兜底:任何不在分块表里的
    # 网格物体都会让导出直接失败,而不是静默丢件。
    coll = BU.get_collection("建筑群")
    # ⚠️ 城墙与城门楼**单独一个集合**,不进"建筑群"。
    #
    #    这不是审美上的分类,是**分块加载**的定义:`config.Export.CHUNKS`
    #    把 `城墙城门楼` 划在 `scene_core`(首屏必须、先加载),其余建筑
    #    划在 `scene_props`。城门楼与城墙是远景的骨架,首屏就要立在那儿;
    #    街上的铺面可以后到,城墙不能。
    #
    #    此前这两个 builder 把城墙与城门**一起塞进了 建筑群**,于是:
    #      · `scene_core` 里没有任何城墙 —— 首屏缺了远景骨架;
    #      · `config` 声明的 `城墙城门楼` 这个集合**根本不存在**;
    #      · 而 `assert_full_coverage()` 查的是反方向(物体有没有掉在
    #        分块之外),不是"声明的集合在不在",所以它一路绿灯。
    #    直到 `tasks/report_objects.py` 把"声明的集合 vs 实际存在的集合"
    #    并排打出来,这一条才现形。门禁补在 report_objects 里(见
    #    `assert_declared_collections`),它跑在导出之前。
    core_coll = BU.get_collection("城墙城门楼")
    mats = BU.MaterialLibrary()
    rng = np.random.default_rng(SEED + 40)

    stats: dict = {"shops": [], "mid": [], "far": [], "wall": [], "gate": None}

    for dirn in (+1, -1):
        side = "e" if dirn > 0 else "w"
        for ri, (ya, yb) in enumerate(_runs()):
            for si, (a, c) in enumerate(_shop_chain(rng, ya, yb)):
                # 只在东岸近桥处放一栋酒楼(歇山二层)与一栋茶肆(带凉棚)。
                # 稀缺是刻意的:原画里这两类建筑各只出现一两次,
                # 满街都是酒楼会让"市井"变成"商业街样板"。
                is_rest = (dirn > 0 and ri == 0 and si == 0)
                is_tea = (dirn > 0 and ri == 0 and si == 1)
                suffix = "_lou" if is_rest else ("_cha" if is_tea else "")
                stats["shops"].append(_build_shop(
                    coll, mats, dirn, a, c, f"shop_{side}{ri}_{si}{suffix}",
                    storeys=2 if is_rest else 1,
                    awning=is_tea,
                    hotspot=is_rest or is_tea,
                    label="酒楼" if is_rest else ("茶肆" if is_tea else ""),
                ))
        stats["mid"].append(_mid_rows(coll, mats, rng, dirn))
        stats["far"].append(_far_rows(coll, mats, rng, dirn))
        stats["wall"].append(_city_wall(core_coll, mats, dirn))

    stats["gate"] = _gate(core_coll, mats)

    by_lod: dict[str, int] = {}
    by_form: dict[str, int] = {}
    n_tiled = 0
    n_bldg = 0
    for ob in bpy.data.objects:
        if ob.get("qm_kind") != "building":
            continue
        n_bldg += 1
        by_lod[ob.get("qm_lod", "")] = by_lod.get(ob.get("qm_lod", ""), 0) + 1
        f = ob.get("qm_roof")
        if f:
            by_form[f] = by_form.get(f, 0) + 1
        if "qm_tiles" in ob:
            n_tiled += 1
    stats["building_objects"] = n_bldg
    stats["objects_by_lod"] = by_lod
    stats["roofs_by_form"] = by_form
    stats["tiled_roofs"] = n_tiled
    stats["shops_near"] = sum(1 for s in stats["shops"] if s["dirn"])
    stats["gate_objects"] = [o.name for o in bpy.data.objects
                             if o.get("qm_kind") == "gate"]
    return stats


if __name__ == "__main__":
    import json
    from lib import bl_utils as _BU

    _BU.reset_clear_flag()
    r = build()
    r = dict(r)
    r["shops"] = r["shops"][:3] + [f"…共 {sum(1 for _ in r['shops'])} 栋"]
    print(json.dumps(r, ensure_ascii=False, indent=2)[:3500])
