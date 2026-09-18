"""
漕船 —— 船壳、拱形舱篷、人字桅(可眠)、橹、招、舵,以及一支船队。

形制依据
--------
《清明上河图》的原画核心情节就是**一条漕船正要穿过虹桥**:桅杆已经
放倒(眠桅),船工在桥上下吆喝指挥,桥上桥下的人都伸手去够那根桅杆。

    所以这个 builder 存在的意义不只是"河上要有船",而是要让
    **眠桅过桥**这件事在几何上真的成立 —— 这就意味着:

        · 船必须真的浮在 z = 0 的水面上,吃水不能超过 config 的上限;
        · 眠桅之后的总高必须真的低于拱桥的净空,否则桅杆会穿桥;
        · 这两条不是"看着差不多",是 validate_scale.py 里的硬断言。

本文件按 `config.Boat` 的硬约束建模:

    满载吃水 DRAFT_MAX = 1.28m   —— 超过就搁浅在汴河里
    眠桅总高 AIR_MAX   = 4.00m   —— 超过就撞上桥腹

⚠️ **本文件刻意不写"完美还原"**。哪些是从原画读出来的、哪些是推定,
    逐条记在下面的 §推定 一节,并同步进 docs/01。

局部坐标约定
------------
每一条船先在自己的**局部坐标系**里建好,再整体摆到世界里:

    x   横(船宽方向),0 为中纵剖面,± 为左右舷
    y   纵(船长方向),**+Y 为船首**,0 为船中
    z   高,z = 0 是**满载水线**,负为水下

物体建成之后才设 `obj.location` 与 `obj.rotation_euler.z`(艏向)。
这样做的好处:船体形状只与船长船宽有关,与它停在哪、朝哪无关 ——
挪船不会牵动形状。**桅、舵、橹各自是独立物体**,轴心在它们自己的
原点上,所以网页那边只要绕 `qm_axis` 转就能动,不需要知道船壳的
形状(见 lib/tag_utils.py 的标签约定)。

⚠️ **眠桅会不会插进舱篷 —— 这是本文件唯一一处真正的空间矛盾。**
   楠桅角近 80°,桅身几乎放平,于是它离甲板只有 0.45 → 1.75m;
   而舱篷顶在 0.98m。**桅座附近桅身必定低于篷顶** —— 这不是调一个
   数就能绕开的,是"桅从甲板起折、篷又高于甲板"这件事本身的几何
   后果。原画里解掉它的办法是:**舱篷不在桅座底下** —— 桅立在船中
   之前的工作面上,篷压在它后面的货舱上,桅倒下来正好从篷首面上
   掠过去。

   所以本文件把"篷首面必须在桅座之后 COVER_CLEAR 以上"写成了一条
   **计算出来的硬约束**(见 COVER_AHEAD 的推导 + build() 里的断言),
   而不是挑几个看着顺眼的坐标。挑坐标的写法在这次返工里已经吃过
   一次亏:桅座、篷首、眠桅架三者的位置互相牵制,动一个另两个就
   悄悄穿模,而穿模在渲染图上**看起来像材质问题**。

推定
----
Reliability B(有原画与文献支撑,细节靠推定):
    · 船壳按漕船的"肥首肥尾"取形 —— 漕船是载货船,首尾不收得像
      渔船那样尖。中段平直(0.30…0.72),两端用 smoothstep 收。
    · 拱形舱篷(席篷)压在货舱上,首尾留出工作面 —— 原画里船工就
      站在篷外的舷边撑篙、摇橹。
    · 人字桅:两腿跨舷立于甲板,桅顶收拢。眠桅时桅身**倒向船尾**,
      搁在艉部的眠桅架上 —— 不是直接压在货上。
Reliability C(原画给不出,纯推定):
    · 船壳各站位的具体型线、舱篷的跨度与矢高、橹的长度与俯角。
    · 眠桅角由 AIR_TARGET 反解(见 MAST_FOLD),不是量出来的角度。

已知简化(见 docs/08)
--------------------
    · 船壳是单层曲面,没有分舱、没有水密隔舱板;
    · 没有帆 —— 原画上过桥的船不张帆,帆是卷起的,本作品不建;
    · 船板缝、钉眼一律以材质表现,不做几何。
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import bpy
from mathutils import Euler, Vector

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import config as C  # noqa: E402
from lib import bl_utils as BU  # noqa: E402
from lib import tag_utils as TU  # noqa: E402

H = C.Boat
S = C.Site

# --------------------------------------------------------------------------
# 主尺度(全部由 config 派生,不在这里另写一份数)
# --------------------------------------------------------------------------

LEN = H.LENGTH                 # 11.2 船长
HALF = LEN / 2.0               # 5.6  半长
HALF_BEAM = H.BEAM / 2.0       # 1.55 半宽
DEPTH = H.HULL_DEPTH           # 1.55 型深
DRAFT = 1.10                   # 满载吃水(声明值,见 §校验)
DECK_Z = DEPTH - DRAFT         # 0.45 甲板面高度(水线以上)

# 吃水与干舷必须合成型深。写成推导而不是各填一个数 —— 各填一个数
# 的结果是改了其中一个,另一个不知什么时候就悄悄不自洽了。
FREEBOARD = DECK_Z             # 0.45

NSEG = 12                      # 沿船长的分段数

MID0, MID1 = 0.30, 0.72        # 中段平直段(不收分)

# 首尾收分比(1.0 = 不收)。漕船首尾都肥:它不是快船,是载粮的驳船。
BOW_TAPER = 0.34
STERN_TAPER = 0.55

BOTTOM_HW = 1.02               # 中段船底半宽(比甲板线窄 → 有舭部)
ROCKER = 0.85                  # 首尾船底的上翘量(龙骨弧)
SHEER = 0.75                   # 首尾舷顶的升高量(舷弧)

BULWARK_T = 0.09               # 舷墙厚
BULWARK_H = 0.32               # 舷墙高(自甲板面起)
WALE_T = 0.05                  # 大腊(舷侧加强材)出舷量
WALE_H = 0.16
WALE_Z = -0.20                 # 大腊中心高度(水线以下,满载时没入水中)
RAIL_H = 0.07                  # 舷顶压条厚

# —— 舱篷 ——
#
# 篷半宽取常数 1.05,不从甲板半宽推。理由:漕船的货舱本身就比船宽窄,
# 两侧要留出**舷边走道**给撑篙、摇橹的人站(原画上就是这样的);
# 拿甲板半宽推出来的篷会一直铺到舷墙根,人就站在水里了。
VAULT_HW = 1.05
VAULT_H = 0.58                 # 篷矢高
VAULT_SINK = 0.05              # 篷底插进甲板的深度(防共面)
COVER_Y0, COVER_Y1 = -3.30, -0.80   # 篷的艉端 / 艏端(局部 y)
COVER_TOP = DECK_Z - VAULT_SINK + VAULT_H

# —— 人字桅 ——
MAST_R = 0.085
MAST_SPREAD = 1.75             # 两桅脚间距(横)
MAST_TOP_SPREAD = 0.16         # 桅顶两腿间距(收拢)
MAST_LEN = H.MAST_HEIGHT - DECK_Z          # 6.95 自桅座起算的桅长
MAST_FOOT_Y = 2.85             # 桅座纵向位置(**远在货舱之前**,见文件头)

AIR_TARGET = 1.75              # 眠桅后水线以上目标总高 = qm_air 声明值

# 眠桅角由 AIR_TARGET **反解**,而不是先拍一个角度、渲出来再回头量高度。
# 反解的好处:声明值与几何是同一个数,不可能各说各话。
#   AIR = DECK_Z + MAST_LEN·cos θ + MAST_R  ⇒  cos θ = (AIR−DECK_Z−R)/LEN
MAST_FOLD = math.acos(
    min(1.0, max(-1.0, (AIR_TARGET - DECK_Z - MAST_R) / MAST_LEN))
)
# 桅身自艏向艉的水平投影(眠桅后桅梢的位置由它定)
MAST_REACH = MAST_LEN * math.sin(MAST_FOLD)
MAST_TIP_Y = MAST_FOOT_Y - MAST_REACH
# 桅身每往艉走 1m,高度降 cot(θ) —— 眠桅的桅身几乎是水平的,所以这个
# 数很小(≈0.178),这正是"桅从篷里穿过去"的成因。
MAST_COT = math.cos(MAST_FOLD) / math.sin(MAST_FOLD)

# —— 水面以上总高 ——
#
# 只对**带桅的船**有意义:无桅船的"总高"是舷顶,那个数由舷弧型线
# 决定,这里再手写一遍就等于埋了一个会漂的重复常量。所以无桅船不写
# qm_air,validate 会如实报出它少覆盖了几条船。
#
# ⚠️ 这里曾经写的是闭式解 `DECK_Z + MAST_LEN + MAST_R`(把桅顶当成
#    球顶算)。实测 7.409 对声明 7.485,**差 76mm**。原因是桅腿有
#    约 6.5° 的内倾:圆柱是沿自身轴平头收口的,最高点在端盖的侧面
#    而不是轴上。把这一项补上能凑回 1mm,但桅头横木一动就又偏了 ——
#    那就是在拟合,不是在建模。
#
#    改成**从建出来的网格量**(见 `_mast_air_heights`):网格怎么写,
#    这个数就是多少,与写网格的代码同源。
#
# ⚠️ 然后同一个地方又错了**第二次**,而且这次更隐蔽:眠桅那一项写成
#    `max(z) · cos(折角)`,漏了顶点在局部 y 上的厚度。详见下面 docstring。
#    两处错误叠在一起才凑出 1.667 这个数 —— 碰巧离 AIR_TARGET 只有
#    0.08,所以一眼看过去像是对上了。
def _mast_air_heights() -> tuple[float, float]:
    """
    (眠桅后的桅顶高度, 立桅的桅顶高度),单位米,基准是水面。

    ⚠️ 眠桅那一项**必须把网格顶点整个转一遍**,不能写成
       `max(z) · cos(折角)`。桅件在局部 y 上是有厚度的 —— 桅头横木、
       两道斜撑、连桅腿圆柱本身都有 —— 而 Rx 把 y 变成 `y·sin(折角)`
       加到高度上。折角 79.93° 时 sin ≈ 0.985,于是 y 上 8cm 的厚度
       就是高度上 8cm 的误差。

       这正是本项目那次 82mm 出入的来源:声明 1.667、实测 1.749。
       当时还差点去补一个"桅腿内倾修正项" —— 那是在拟合一个
       本来只要老老实实转一遍网格就精确的量。

    立桅就是 rot_x = 0,竖向分量只剩 z,所以那一项取 max(z) 即可。

    —— 这个声明**不是**自证的 ——
    它只在**局部**坐标里转一遍;validate 量的是 Blender 摆好之后
    的**世界**顶点(经 `_place` 的 Euler 与 location)。两者一致,
    说明我对"Euler XYZ 怎么转"的理解与 Blender 的实际行为相符、
    且 `_place` 确实把 MAST_FOLD 喂给了 rot_x。这正是本文件开头
    那个度/弧度错误的同类问题 —— 声明与实测**互为对方的检查**。
    """
    ct, st = math.cos(MAST_FOLD), math.sin(MAST_FOLD)
    verts = _mast().verts
    return (
        DECK_Z + max(y * st + z * ct for _, y, z in verts),
        DECK_Z + max(z for _, _, z in verts),
    )


def _mast_leg_undersides(dy_aft: float, band: float = 0.15) -> list[tuple[float, float]]:
    """
    眠桅后,离桅座 `dy_aft` 米(**向艉**为正)处,**每条桅腿**的
    (x 位置, 下缘高度)。高度基准是船体局部 z = 0(与 DECK_Z 同一基准)。

    ⚠️ 为什么返回的是"一列 (x, z)"而不是"一个下缘高度":
       人字桅到桅头附近已经收拢到 x = ±0.26,而**它中间是空的** ——
       这一站实测只有 6 个顶点,x 只取 −0.26 与 +0.26 两个值。
       眠桅架若做成一个 x = 0 的尖顶,就是戳进两条腿的缝里,
       谁也托不着,而渲染图上只会看到"架子好像挨着桅"。

    ⚠️ 也**不能**写成闭式解 `中心线 − MAST_R`。那条式子假设桅的
       横截面在以轴心为心、半径 MAST_R 的圆上;而折桅是把局部 **y**
       转成高度,这一站的 y 向厚度只有 0.054m,不到 MAST_R(0.085)
       的七成。实测:闭式解给 1.5013,网格实际下缘 1.5552 ——
       差了 54mm,桅就悬在架子上方 3cm。

       这是本文件第三次遇到同一个毛病:拿手推的闭式解去算一个
       **网格自己就能量**的量。前两次是桅顶总高。凡是"这个数由
       另一处几何决定"的地方,一律量,不推。
    """
    ct, st = math.cos(MAST_FOLD), math.sin(MAST_FOLD)
    sel = [
        (x, DECK_Z + y * st + z * ct)
        for (x, y, z) in _mast().verts
        if abs((y * ct - z * st) + dy_aft) <= band
    ]
    if not sel:
        raise AssertionError(
            f"眠桅角 {math.degrees(MAST_FOLD):.2f}° 下,离桅座 {dy_aft:.3f}m 处"
            f"没有桅的顶点(取样带宽 ±{band}m)——量不出下缘,架子高度无从反推"
        )
    # 按 x 的符号分左右两组(人字桅是左右对称的两条腿),各取最低点
    out: list[tuple[float, float]] = []
    for sign in (-1.0, 1.0):
        leg = [(x, z) for (x, z) in sel if (x >= 0) == (sign > 0)]
        if not leg:
            raise AssertionError(f"眠桅后该站位的 {sign:+.0f} 侧没有桅腿顶点")
        out.append(min(leg, key=lambda t: t[1]))
    return out

# 篷首面必须在桅座之后多远,桅身才能从篷顶上掠过去:
#   DECK_Z + Δy·cot(θ) − COVER_TOP ≥ CLEAR
COVER_CLEAR = 0.10
COVER_AHEAD = (COVER_CLEAR + COVER_TOP - DECK_Z) / MAST_COT

# 眠桅架(艉部托桅的架子)。位置必须落在桅梢**之前**,否则架空着。
CRUTCH_Y = -3.55
CRUTCH_HW = 0.55

# —— 舵 ——
RUDDER_Y = -HALF - 0.16        # 舵杆位于艉封板之后
RUDDER_HW = 0.30               # 舵叶半宽
RUDDER_TOP = DECK_Z + 0.62
RUDDER_BOT = -1.05

# —— 橹 ——
YULOH_SIDE = 1                 # 橹挂右舷(朝向河心那一边)
YULOH_X = 0.95
YULOH_Y = -3.90                # 必须在舱篷之外,否则橹担会捅穿篷面
YULOH_Z = DECK_Z + 0.75
YULOH_LEN = 5.60
YULOH_DROP = 1.72              # 橹尾没入水中的深度

# —— 招(船首长桨)——
BOW_OAR_X = -0.90
BOW_OAR_Y = 3.90
BOW_OAR_Z = DECK_Z + 0.50

# —— 上岸垫木 ——
#
# 这一个数管两头:垫木的半径,以及"拖上岸的船要抬高多少"。
# 木心抬到 SKID_R 才是**搁在平地上**(留在 0 会把下半截埋进土里);
# 于是木顶在 2·SKID_R 处,而船底最低点必须正好落在那里 ——
# 也就是 _Spec.z = DRAFT + 2·SKID_R。
# 两头都由这一个数推,改它不会让船陷进垫木里。
SKID_R = 0.11
SKID_TOP = 2.0 * SKID_R


# --------------------------------------------------------------------------
# 型线
# --------------------------------------------------------------------------


def _smooth(u: float) -> float:
    """smoothstep。两端导数为 0,收分不会有折角。"""
    u = min(1.0, max(0.0, u))
    return u * u * (3.0 - 2.0 * u)


def _shape(t: float) -> float:
    """站位 t ∈ [0,1](0 艉、1 艏)处的**丰满度**,1.0 为最肥。"""
    if t < MID0:
        return STERN_TAPER + (1.0 - STERN_TAPER) * _smooth(t / MID0)
    if t > MID1:
        return BOW_TAPER + (1.0 - BOW_TAPER) * _smooth((1.0 - t) / (1.0 - MID1))
    return 1.0


def _y_of(t: float) -> float:
    return -HALF + t * LEN


def _t_of(y: float) -> float:
    return (y + HALF) / LEN


def _half_bottom(t: float) -> float:
    return BOTTOM_HW * _shape(t)


def _half_deck(t: float) -> float:
    """
    甲板线半宽。

    最小值取 0.34 倍半宽而不是 0 —— 船首船尾要有**宽度**才有甲板可站人,
    收成一条线就成独木舟了。漕船的艉封板本来就接近方尾。
    """
    return HALF_BEAM * (0.34 + 0.66 * _shape(t))


def _z_bottom(t: float) -> float:
    """船底线高度。中段落在设计吃水处,两端上翘。"""
    return -DRAFT + ROCKER * (1.0 - _shape(t)) ** 1.5


def _z_sheer(t: float) -> float:
    """舷墙顶高度。两端升高(舷弧),保证甲板不上浪。"""
    return DECK_Z + BULWARK_H + SHEER * (1.0 - _shape(t)) ** 1.2


def _half_at(t: float, z: float) -> float:
    """
    站位 t 处、高度 z 上的**船壳外表面**半宽(线性插值舭部)。

    大腊要贴在船壳外面,所以必须能问出"这个高度上外壳在哪" ——
    这正是当初把舭部写成直线(而不是曲线)的原因:直线可以直接解,
    不必迭代求根。
    """
    zb = _z_bottom(t)
    wb = _half_bottom(t)
    wd = _half_deck(t)
    if z <= zb:
        return wb
    if z >= DECK_Z:
        return wd
    u = (z - zb) / max(1e-9, DECK_Z - zb)
    return wb + (wd - wb) * u


def _station(i: int) -> float:
    return i / NSEG


# --------------------------------------------------------------------------
# 小工具
# --------------------------------------------------------------------------


def _pad(
    builder: BU.MeshBuilder,
    a: Vector,
    b: Vector,
    width: float,
    thick: float,
    up: tuple[float, float, float] = (0.0, 0.0, 1.0),
) -> None:
    """
    在 a→b 之间放一块扁料(舵叶、桨叶、板条)。

    用 `add_box3` 而不是 `add_box`:桨叶的三个方向(长度、宽度、厚度)
    互不垂直是常事 —— 舵叶是斜的,桨叶是斜的,`add_box` 的 hint 叉乘
    给不出正确的厚度方向,结果是桨叶被拧着摆。
    """
    a = Vector(a)
    b = Vector(b)
    u = b - a
    ln = u.length
    if ln < 1e-6:
        return
    u.normalize()
    hint = Vector(up)
    w = hint - u * hint.dot(u)
    if w.length < 1e-6:
        hint = Vector((0.0, 1.0, 0.0))
        w = hint - u * hint.dot(u)
    w.normalize()
    v = u.cross(w)
    builder.add_box3((a + b) * 0.5, u, v, w, ln, width, thick)


# --------------------------------------------------------------------------
# 船壳与固定构件
# --------------------------------------------------------------------------


def _hull(builder: BU.MeshBuilder) -> None:
    """
    船壳:一条闭合放样管 + 首尾端盖。

    ⚠️ 端盖只在**最外两段**加(`cap0=(i==0)` / `cap1=(i==NSEG-1)`)。
       每段都加的话,段与段之间的端盖藏在船体内部 —— 看不见,却每个
       面都要占索引、走一遍法线重算。12 段船壳多出 22 个面 × 每条船
       × 6 条船,纯浪费。
    """
    for i in range(NSEG):
        t0, t1 = _station(i), _station(i + 1)
        wb0, wd0, zb0 = _half_bottom(t0), _half_deck(t0), _z_bottom(t0)
        wb1, wd1, zb1 = _half_bottom(t1), _half_deck(t1), _z_bottom(t1)
        p0 = [(-wb0, zb0), (wb0, zb0), (wd0, DECK_Z), (-wd0, DECK_Z)]
        p1 = [(-wb1, zb1), (wb1, zb1), (wd1, DECK_Z), (-wd1, DECK_Z)]
        builder.add_loft(
            p0, _y_of(t0), p1, _y_of(t1),
            cap0=(i == 0), cap1=(i == NSEG - 1),
        )


def _ends(builder: BU.MeshBuilder) -> None:
    """
    艏柱与艉封板 —— 把放样管两端那两块**光秃秃的端盖**收成构件。

    为什么非补不可:放样的端盖是一整块梯形平面,从龙骨一直封到甲板。
    渲出来船的艏艉就是**两块平板**,像被人拿刀切过。原画上的船首有
    一根明显的艏柱,船尾是一块竖直的艉封板加舵柱 —— 宋代漕船的
    基本形制,也是最容易看清"这是一条船"的两个局部。
    """
    # 艏柱:自艏部龙骨沿船首外缘立到舷顶。
    # 位置往外偏 0.04,让柱子**贴在外面**而不是与端盖共面。
    yb = HALF + 0.04
    builder.add_cylinder(
        Vector((0.0, yb, _z_bottom(1.0) - 0.10)),
        Vector((0.0, yb, _z_sheer(1.0) + 0.06)),
        0.105, 7,
    )
    # 艏柱两侧的夹板 —— 单根圆柱读不出"柱",两根夹板才像木构
    for sign in (-1, 1):
        _pad(
            builder,
            Vector((sign * 0.11, yb - 0.03, _z_bottom(1.0) - 0.05)),
            Vector((sign * 0.11, yb - 0.03, _z_sheer(1.0) + 0.02)),
            0.055, 0.14,
            up=(0.0, 1.0, 0.0),
        )

    # 艉封板:一块竖直的板,封住艉部断面
    ys = -HALF - 0.03
    ws = _half_deck(0.0)
    builder.add_box3(
        Vector((0.0, ys, (DECK_Z + _z_bottom(0.0)) * 0.5)),
        Vector((0.0, 1.0, 0.0)),
        Vector((1.0, 0.0, 0.0)),
        Vector((0.0, 0.0, 1.0)),
        0.09, ws * 2.0 * 0.92, DECK_Z - _z_bottom(0.0) + 0.16,
    )
    # 舵柱:艉封板正中往上的一根短柱,舵就吊在它后面 —— 没有它,
    # 舵看起来是**浮在船尾后面**的
    builder.add_cylinder(
        Vector((0.0, ys - 0.06, DECK_Z - 0.10)),
        Vector((0.0, ys - 0.06, RUDDER_TOP + 0.10)),
        0.085, 6,
    )


def _deck_beams(builder: BU.MeshBuilder) -> None:
    """
    甲板横梁。舱篷之外那几段露天的甲板,画上几道横梁。

    俯视时一块光板甲板与一块有横梁的甲板差别很大 —— 前者像塑料,
    后者才看得出是**拼出来的**。原画上的船甲板就是一道一道横梁。
    """
    for y in (-5.05, -4.30, 1.10, 1.90, 2.70, 3.60, 4.40):
        t = _t_of(y)
        hw = _half_deck(t) - BULWARK_T - 0.02
        if hw < 0.25:
            continue
        builder.add_box3(
            Vector((0.0, y, DECK_Z + 0.045)),
            Vector((1.0, 0.0, 0.0)),
            Vector((0.0, 1.0, 0.0)),
            Vector((0.0, 0.0, 1.0)),
            hw * 2.0, 0.13, 0.09,
        )


def _strake(builder: BU.MeshBuilder, sign: int, edges_of) -> None:
    """
    舷侧纵向材(舷墙 / 大腊 / 舷顶压条)。

    三者形状不同、位置不同,但**拓扑一模一样** —— 都是把一个四点
    矩形沿 Y 放样成一条带。所以合成一个函数,免得写三遍。

    `edges_of(t)` 返回该站位上的「内缘半宽, 外缘半宽, 下缘 z, 上缘 z」。
    这些都是**贴在船壳外面的带**,不是独立空间体,所以两端不封盖。

    ⚠️ 侧面必须**插进船壳里**(内缘比外表面再往里 2cm),不能只贴着。
       只贴着的话,两个面共面 —— 掠视时会看到一闪一闪的斑驳。
       桥面板与驳岸压顶都踩过这个坑,做法统一成"宁可互相咬进去"。
    """
    for i in range(NSEG):
        t0, t1 = _station(i), _station(i + 1)
        bi0, bo0, bz0, bz1 = edges_of(t0)
        bi1, bo1, cz0, cz1 = edges_of(t1)
        if sign < 0:
            p0 = [(-bi0, bz0), (-bo0, bz0), (-bo0, bz1), (-bi0, bz1)]
            p1 = [(-bi1, cz0), (-bo1, cz0), (-bo1, cz1), (-bi1, cz1)]
        else:
            p0 = [(bi0, bz0), (bo0, bz0), (bo0, bz1), (bi0, bz1)]
            p1 = [(bi1, cz0), (bo1, cz0), (bo1, cz1), (bi1, cz1)]
        builder.add_loft(p0, _y_of(t0), p1, _y_of(t1), cap0=False, cap1=False)


def _bulwark_of(t: float):
    return (_half_deck(t) - BULWARK_T, _half_deck(t), DECK_Z, _z_sheer(t))


def _wale_of(t: float):
    w = _half_at(t, WALE_Z)
    return (w - 0.02, w + WALE_T, WALE_Z - WALE_H * 0.5, WALE_Z + WALE_H * 0.5)


def _rail_of(t: float):
    w = _half_deck(t)
    z = _z_sheer(t)
    return (w - BULWARK_T - 0.04, w + 0.03, z, z + RAIL_H)


def _vault_profile(t: float, grow: float = 0.0, n: int = 9):
    """
    舱篷断面:半椭圆,由它自己那条**隐式的直边**封底。

    `add_loft` 的断面是闭合多边形、首尾自动相接 —— 所以写半条椭圆
    就等于写了一个 D 形,底边不用自己补。这是本项目里最省事的一处
    API 特性。

    `grow` 用来把同一形状放大一点当**篷箍**用(见 _cover)。
    """
    half = min(VAULT_HW, _half_deck(t) - BULWARK_T - 0.06) + grow
    z0 = DECK_Z - VAULT_SINK - grow * 0.5
    return [
        (half * math.cos(math.pi * i / n),
         z0 + (VAULT_H + grow) * math.sin(math.pi * i / n))
        for i in range(n + 1)
    ]


def _cover(builder: BU.MeshBuilder, ribs: BU.MeshBuilder) -> None:
    """
    拱形舱篷(席篷)+ 篷箍。

    篷与箍分两个物体,是因为它们**不同材质**:篷是席/布,箍是木。
    同物体多材质要写材质槽索引,而本项目其余部分一律一物一材质,
    为几个小箍破这个惯例不划算。
    """
    n = 4
    t0, t1 = _t_of(COVER_Y0), _t_of(COVER_Y1)
    for i in range(n):
        ta = t0 + (t1 - t0) * i / n
        tb = t0 + (t1 - t0) * (i + 1) / n
        builder.add_loft(
            _vault_profile(ta), _y_of(ta), _vault_profile(tb), _y_of(tb),
            cap0=(i == 0), cap1=(i == n - 1),
        )

    # 篷箍:同形状放大 3.5cm 的一小段。放大会让它**穿出**篷面,
    # 露出来的那三厘米就是箍。
    for f in (0.18, 0.42, 0.66, 0.88):
        y = COVER_Y0 + (COVER_Y1 - COVER_Y0) * f
        pa = _vault_profile(_t_of(y), grow=0.035)
        ribs.add_loft(pa, y - 0.035, pa, y + 0.035)


def _bollard_x(y: float) -> float:
    """
    系缆桩的横向位置。跟着该处的甲板宽走 —— 写死一个数的话,
    首尾的桩会站到舷墙外面去(甲板在那里只有 0.9m 半宽)。
    """
    return _half_deck(_t_of(y)) * 0.62


def _fittings(builder: BU.MeshBuilder, spec: "_Spec") -> None:
    """固定构件:系缆桩、橹担、眠桅架、拖岸垫木。"""
    # —— 系缆桩 ——
    for y in (-HALF + 0.60, HALF - 0.75):
        x = _bollard_x(y)
        for sign in (-1, 1):
            builder.add_cylinder(
                Vector((sign * x, y, DECK_Z - 0.05)),
                Vector((sign * x, y, DECK_Z + 0.26)),
                0.075, 6,
            )

    # —— 橹担(橹的支点立柱)——
    if "yuloh" in spec.rig:
        x = YULOH_SIDE * YULOH_X
        builder.add_cylinder(
            Vector((x, YULOH_Y, DECK_Z - 0.05)),
            Vector((x, YULOH_Y, YULOH_Z + 0.06)),
            0.085, 6,
        )
        # 担梁:两根斜撑,把橹的反力传回舷墙
        for sy in (-1, 1):
            builder.add_cylinder(
                Vector((x, YULOH_Y + sy * 0.85, _z_sheer(_t_of(YULOH_Y + sy * 0.85)))),
                Vector((x, YULOH_Y, YULOH_Z - 0.10)),
                0.05, 5,
            )

    # —— 眠桅架 ——
    #
    # 架高由**桅身在该处的实际网格**反算,不写死、也不套闭式解
    # (两条理由都写在 `_mast_leg_undersides` 的 docstring 里)。
    # 架子做成**两个顶,各托一条桅腿** —— 单尖顶会戳进两条腿的缝里。
    #
    # 每条腿的端点**取在桅腿下缘**:圆柱是平头收口的,端盖是斜的,
    # 顶点会比端点高出 r·sin(倾角) ≈ 0.024m,正好扎进桅里。这是刻意的 ——
    # 和垫木那段同一个道理:**留空隙看得见,伸进去看不见**。
    if spec.folded:
        tops = _mast_leg_undersides(MAST_FOOT_Y - CRUTCH_Y)
        for mx, mz in tops:
            sign = 1.0 if mx >= 0 else -1.0
            builder.add_cylinder(
                Vector((sign * CRUTCH_HW, CRUTCH_Y, DECK_Z - 0.05)),
                Vector((mx, CRUTCH_Y, mz)),
                0.055, 6,
            )
        # 两顶之间的横撑。放在桅腿下缘再低 0.06m:那个区间桅身是**空的**
        # (人字桅两条腿之间没有料),所以横撑从缝里看得见,正好。
        z_tie = min(mz for _, mz in tops) - 0.06
        builder.add_cylinder(
            Vector((tops[0][0], CRUTCH_Y, z_tie)),
            Vector((tops[1][0], CRUTCH_Y, z_tie)),
            0.045, 5,
        )

    # —— 拖上岸大修的船:垫木 ——
    #
    # 船壳底面被整体抬到 z = +DRAFT(见 _Spec 的 z),底下是空的 ——
    # 不垫木料,它就是**浮在岸上**的。
    #
    # 船底是**有弧的**(ROCKER),岸面是平的,所以两者只可能在船底最低
    # 那一点相切。这不是建模偷懒,是几何事实:一条有纵向弧度的船搁在
    # 平地上,只可能坐在**一道**垫木上,前后两站必然悬空,得另外拿料
    # 垫起来。所以这里是"一道横木 + 前后两组支柱",不是三道一样高的
    # 横木 —— 后者会有一道凭空插进船底、另外两道悬空。
    if spec.z > 1e-6:
        for y in (-HALF + 1.2, 0.0, HALF - 1.2):
            t = _t_of(y)
            zb = _z_bottom(t) + spec.z          # 该站船底(龙骨)高度
            # 横木:半径 SKID_R,圆心也抬到 SKID_R,才刚好**搁在岸面上**
            # (圆心留在 0 的话,下半截是埋进土里的)。木顶在 SKID_TOP。
            builder.add_cylinder(
                Vector((-1.05, y, SKID_R)), Vector((1.05, y, SKID_R)),
                SKID_R, 6,
            )
            # 支柱:从岸面顶到船底。顶端会伸进船壳内部 —— 从外面看不见,
            # 而**留空隙是看得见的**,所以宁可伸进去。
            for sign in (-1, 1):
                builder.add_cylinder(
                    Vector((sign * 1.05, y, 0.0)),
                    Vector((sign * 1.05, y, zb + SKID_R)),
                    0.09, 5,
                )


# --------------------------------------------------------------------------
# 可动件:桅、舵、橹、招
#
# 每一个都建在**自己的轴心**上,物体原点 = 轴心。这样网页那边拿到的
# object.position 直接就是轴心,不必再去读 qm_pivot —— qm_pivot 仍然
# 写上,是为了让人在 glTF 的 extras 里也能读到同一个数,两边一致。
# --------------------------------------------------------------------------


def _mast() -> BU.MeshBuilder:
    b = BU.MeshBuilder("船_人字桅")
    for sign in (-1, 1):
        b.add_cylinder(
            Vector((sign * MAST_SPREAD * 0.5, 0.0, 0.0)),
            Vector((sign * MAST_TOP_SPREAD * 0.5, 0.0, MAST_LEN)),
            MAST_R, 7,
        )
    # 桅顶横木
    b.add_cylinder(
        Vector((-0.26, 0.0, MAST_LEN - 0.30)),
        Vector((0.26, 0.0, MAST_LEN - 0.30)),
        MAST_R * 0.75, 5,
    )
    # 两腿之间的横撑(原画上人字桅有两三道)
    for f in (0.34, 0.62):
        sp = MAST_SPREAD * 0.5 + (MAST_TOP_SPREAD - MAST_SPREAD) * 0.5 * f
        b.add_cylinder(
            Vector((-sp, 0.0, f * MAST_LEN)),
            Vector((sp, 0.0, f * MAST_LEN)),
            MAST_R * 0.6, 5,
        )
    return b


def _rudder() -> BU.MeshBuilder:
    """
    舵。轴心取在**舵杆上端**,绕局部 Z(竖轴)转 —— 舵是靠左右摆
    改变航向的,不是靠前后倾。

    ⚠️ **网格坐标是相对轴心的,不是船体绝对坐标。**
       第一版这里写的是绝对 z(RUDDER_TOP … RUDDER_BOT),而 `_place`
       又把物体原点摆到了 RUDDER_TOP —— 于是舵被整体抬高了一个
       RUDDER_TOP(1.07m),悬在艉部上空。渲出来是一根很高的柱子,
       但那**看起来像是"舵杆本来就这么长"**,不像穿模,很容易漏掉。
       桅和橹天生就是按相对坐标写的(它们的起笔点就是轴心),只有
       舵是从绝对坐标改过来的,就漏了这一个。
    """
    b = BU.MeshBuilder("船_舵")
    z_bot = RUDDER_BOT - RUDDER_TOP
    b.add_cylinder(
        Vector((0.0, 0.0, 0.0)),
        Vector((0.0, 0.0, z_bot)),
        0.075, 7,
    )
    b.add_cylinder(
        Vector((0.0, 0.0, z_bot)),
        Vector((0.0, 0.0, z_bot - 0.22)),
        0.055, 6,
    )
    _pad(
        b,
        Vector((0.0, 0.02, z_bot + 0.05)),
        Vector((0.0, 0.02, z_bot + 0.98)),
        RUDDER_HW * 2.0, 0.07,
        up=(0.0, 1.0, 0.0),
    )
    return b


def _yuloh() -> BU.MeshBuilder:
    """
    橹。轴心在橹担的支点上,绕局部 Z 转(摇橹就是绕竖轴一推一拉)。

    橹与桨的区别就在这一条:桨是**划**的,橹是**摇**的,支点在船内、
    整支橹不出水面。
    """
    b = BU.MeshBuilder("船_橹")
    top = Vector((0.0, 0.48, -0.06))
    mid = Vector((0.0, -(YULOH_LEN - 1.70), -(YULOH_DROP * 0.74)))
    tip = Vector((0.0, -YULOH_LEN, -YULOH_DROP))
    b.add_cylinder(top, mid, 0.058, 6)
    _pad(b, mid, tip, 0.34, 0.055, up=(0.0, 0.0, 1.0))
    return b


def _bow_oar() -> BU.MeshBuilder:
    """招(船首长桨)。轴心在舷侧支点上,绕局部 Z 转。"""
    b = BU.MeshBuilder("船_招")
    top = Vector((0.0, -0.50, 0.08))
    mid = Vector((0.0, 1.60, -0.45))
    tip = Vector((0.0, 2.50, -0.72))
    b.add_cylinder(top, mid, 0.052, 6)
    _pad(b, mid, tip, 0.28, 0.05, up=(0.0, 0.0, 1.0))
    return b


# --------------------------------------------------------------------------
# 船队
# --------------------------------------------------------------------------


class _Spec:
    """
    一条船在世界里的摆法,以及它要装哪些可动件。

    ⚠️ `yaw` 的单位是**度**,而且只能通过 `yaw_rad` 去用。

    这里踩过一次坑,值得写下来:`yaw` 当初直接在 FLEET 表里按度写,
    又直接喂给了 `rotation_euler.z` —— 而那个属性收的是**弧度**。
    于是 180.0 被当成 180 弧度 ≈ 233°,船横在河里;`boat_cao_a`
    更巧,yaw=0 在两种单位下都是 0。

    结果就是:主角船(唯一 yaw=0 的那条)在每一张预览图里都是正的,
    我反复看的就是它 —— 而**其余五条全歪着**,直到渲了一张场地
    俯视图才露出来。单看一条船永远发现不了这类错误。

    所以现在度→弧度只允许发生在这一个属性里。多一处 `math.radians`,
    就多一次忘掉的机会。
    """

    __slots__ = (
        "bid", "x", "y", "z", "yaw", "kind", "rig", "folded",
        "moor", "beached", "hotspot", "note",
    )

    def __init__(
        self,
        bid: str,
        x: float,
        y: float,
        yaw: float,
        kind: str,
        *,
        z: float = 0.0,
        rig: tuple[str, ...] = ("mast", "rudder", "yuloh"),
        folded: bool = False,
        moor: bool = False,
        beached: bool = False,
        hotspot: bool = False,
        note: str = "",
    ) -> None:
        self.bid = bid
        self.x, self.y, self.z, self.yaw = x, y, z, yaw
        self.kind = kind
        self.rig = rig
        self.folded = folded
        self.moor = moor
        # 搁在岸上、不在水里。**必须显式声明**,不许由"z 抬高了没有"
        # 反推 —— validate 的 boat.within_bank 要按这个标志豁免,而
        # 豁免权一旦能靠改坐标换来,那条检查就等于没有。所以豁免的那
        # 一类要单独验:申报上岸的船,船体必须整体在水面之外。
        self.beached = beached
        self.hotspot = hotspot
        self.note = note

    @property
    def yaw_rad(self) -> float:
        """艏向,弧度。**唯一**的度→弧度转换点。"""
        return math.radians(self.yaw)


# 船队。摆位遵循四条:
#
#   1. **主角船在虹桥下游**(y < 0),艏朝桥 —— 网页的默认机位就站在
#      桥面朝下游看,这条船正对着观众进来。它的艏在 y = −3.9,刚好
#      触到桥面外缘,就是原画里"船首方入桥"的那一刻。
#   2. **泊船的 |x| ≤ 6.5**。船半宽 1.55,加压条就是 1.58;水面边在
#      ±8.25,所以最外侧留 0.2m 富余 —— 不留富余,泊船的舷墙会从
#      驳岸里穿出来。这一条由 validate 的 boat.within_bank 兜住。
#   3. **立桅的船一律摆在桥的纵向走廊之外**(|y| > 6.0)。立桅总高
#      7.4m,拱桥净空只有 5.0m —— 摆在桥下就是穿模。这一条由
#      validate 的 boat.air_clear 兜住。
#   4. **拖上岸的船单列**:整体抬到 z = +DRAFT 坐在岸面上,不适用
#      吃水与岸线两条判据(validate 按"是否触水"自动豁免)。
FLEET: tuple[_Spec, ...] = (
    _Spec(
        "boat_cao_hero", 1.60, -9.50, 0.0, "漕船",
        folded=True, hotspot=True,
        note="过桥的漕船,已眠桅;艏在 y=−3.9,恰为桥面外缘。原画核心情节所在",
    ),
    _Spec(
        "boat_cao_a", -6.35, -27.0, 0.0, "漕船",
        moor=True, note="左岸泊船,系缆于岸上缆桩",
    ),
    _Spec(
        "boat_ke_a", 6.45, 19.50, 180.0, "客船",
        moor=True, note="右岸泊船,艉朝桥",
    ),
    _Spec(
        "boat_ke_b", -6.30, 33.00, 180.0, "客船",
        moor=True, note="左岸泊船,艉朝桥",
    ),
    _Spec(
        "boat_cao_b", -2.20, 46.00, 180.0, "漕船",
        rig=("mast", "rudder", "yuloh", "bow_oar"),
        note="上行的漕船,立桅;远离虹桥纵向走廊,不吃净空限制",
    ),
    _Spec(
        # ⚠️ x 必须让**整条船都在水面之外**。船半宽 1.55,yaw 8° 时
        #    在 x 上的投影半宽 = 1.55·cos8° + 5.6·sin8° = 2.31。
        #    x = 11.30 → 占 x ∈ [8.99, 13.61],离水面边 8.25 还有 0.74m。
        #    最早写 9.62,舷侧 0.2m 泡在水里 —— 一条"拖上岸"的船
        #    半截在水里,俯视图上一眼就看出来了。
        "boat_repair", 11.30, -41.0, 8.0, "渔船",
        z=DRAFT + SKID_TOP, rig=("rudder",), beached=True,
        note="拖上岸大修的渔船,垫木支起;原画右岸有修船场景",
    ),
)


# --------------------------------------------------------------------------
# 摆位
# --------------------------------------------------------------------------


def _to_world(spec: _Spec, p: Vector) -> Vector:
    """
    把船**局部坐标**的点换算到世界坐标。

    ⚠️ 这里的旋转必须与 `obj.rotation_euler.z = yaw` 的 Blender 约定
       **逐字一致**,否则轴心会算错位置 —— 而轴心错一点点,舵和橹
       转起来就会绕着船外的某个空点打转。它不会当场报错,只会看起来
       滑稽。Blender 的 Rz(a) 把局部 (1,0,0) 送到 (cos a, sin a, 0):
    """
    a = spec.yaw_rad
    ca, sa = math.cos(a), math.sin(a)
    return Vector((
        spec.x + p.x * ca - p.y * sa,
        spec.y + p.x * sa + p.y * ca,
        spec.z + p.z,
    ))


def _place(
    obj: bpy.types.Object | None,
    spec: _Spec,
    pivot_local: Vector,
    rot_x: float = 0.0,
) -> bpy.types.Object | None:
    """
    把一个**建在自己轴心上**的物体摆进世界。

    旋转用欧拉 XYZ 序:Blender 的 R = Rz·Ry·Rx,所以 `(rot_x, 0, yaw)`
    恰好是"先绕局部 X 折,再整体转艏向" —— 正是眠桅需要的次序
    (桅在船体坐标系里放倒,船再转向)。
    """
    if obj is None:
        return None
    obj.location = _to_world(spec, pivot_local)
    obj.rotation_euler = Euler((rot_x, 0.0, spec.yaw_rad), "XYZ")
    return obj


def _attach(
    obj: bpy.types.Object | None,
    hull: bpy.types.Object | None,
) -> None:
    """
    把船上的一个构件挂到**船壳**下,并保持它现有的世界变换不变。

    ## 为什么要挂

    整船轻摇(`qm_anim="hull_rock"`,阶段 4)是打在船壳上的。船壳一转,
    它的舱篷、肋骨、属具、桅、舵、橹、系缆**必须跟着一起转** ——
    否则一条船会当场散架:船身侧倾了,桅还直挺挺立在原地。

    让它们跟着转只有两条路:

        A. 在 Blender 里挂成父子,导出成嵌套节点(这里走的路);
        B. 全部保持世界坐标的同级件,由网页侧每帧重新合成整船的变换。

    选 A,判据是**失败的方式**:

      · B 之下,往后每加一个船部件都得记得在网页侧登记一次。忘了不会
        报错 —— 那条船只是在摇的时候散架,而静帧里看不出来。
      · A 之下,挂上的自动跟着转;忘了挂则由 `_check_attached()` 在
        **构建期**炸掉,轮不到发布。

    另外 B 还得在网页侧重新实现一遍场景图本来就免费做的事。见
    `src/actors/propsAnim.ts` 文件头"船体轻摇靠的是场景图的父子关系"。

    ## 为什么不是 `obj.parent = hull` 一句就够

    直接设 parent 会让物体的**世界坐标突变**。Blender 的式子:

        世界 = 父.世界 @ matrix_parent_inverse @ 自身.basis

    刚挂上去时 `matrix_parent_inverse` 是单位阵,于是物体被父级变换
    **又**乘了一遍 —— 船壳带着 yaw,船就整体多转一个角度。补上
    `matrix_parent_inverse = 父.世界⁻¹` 之后正好抵消,世界坐标一个
    字节都不动。

    ⚠️ 父级矩阵用 `matrix_basis` 取,不用 `matrix_world`:船壳刚设完
       `location` / `rotation_euler`,depsgraph 还没求值,`matrix_world`
       是**上一轮**的旧值,拿它求逆会得到一个错的逆矩阵 —— 而且它是
       个"看起来挺合理"的数,不会抛。船壳无父级,故 `matrix_basis`
       就是它的世界矩阵,且立刻可用。本文件校艏向用的也是
       `matrix_basis`,同一条理由(见那处的注释)。
    """
    if obj is None or hull is None:
        return
    obj.parent = hull
    obj.matrix_parent_inverse = hull.matrix_basis.inverted()


def _check_attached(objs: dict[str, bpy.types.Object]) -> None:
    """
    自检:**每条船的全部构件都真的挂在它自己的船壳下**。

    这一条是整船轻摇的前提,而它一旦不成立**不会报任何错**:
    漏挂的那一件只是留在原地不动。船壳一摇,它就从船上撕下来
    (桅悬在半空、舱篷浮在船边),而**静帧里完全看不出来** ——
    只有当船摇到最大角时才显形,还容易被当成"看错了"。

    也就是说这个缺陷的全部症状都出现在"动"上,而建模阶段看到的
    永远是静帧。等网页侧发现时,已经出了一版错的 GLB。

    所以在这里用**标签**反查,而不是记一份"我调过 _attach 的清单" ——
    那种清单是自己报自己,漏掉的件本来就不在清单里,查了也白查。
    判据取自 `qm_parent`(每件都写着自己是哪条船的),与 validate_scale
    分组用的是同一个字段,口径一致。

    ⚠️ 船壳自己豁免:它的 `qm_parent` 就是自己,挂在自身上会成环。

    ⚠️ **缺 `qm_parent` 的件算失败,不算跳过。** `objs` 里的每一个键都是
       本函数建的船体构件(全是 `{bid}_hull` / `{bid}_{部件}` 这种形状),
       所以"没有 qm_parent"本身就是缺陷 —— 而如果写成 `continue`,
       它就成了**检查自己的盲区**:漏打标签的那一件正好被放过,
       而它往往正是新加的那个部件。
    """
    for name, o in objs.items():
        bid = o.get("qm_parent")
        if not bid:
            raise AssertionError(
                f"{name} 没有 qm_parent 标签,挂接自检覆盖不到它。"
                f"船体构件一律要写 parent=<本船 bid>(tag_utils.KNOWN_KEYS "
                f"里 qm_parent 的约定,validate_scale 分组用的也是它)。"
            )
        hull = objs.get(f"{bid}_hull")
        if hull is None or o is hull:
            continue
        if o.parent is not hull:
            raise AssertionError(
                f"{name} 没有挂在船壳 {bid}_hull 下"
                f"(实际父级:{o.parent.name if o.parent else '无'})。"
                f"整船轻摇时它不会跟着动,船会散架,而静帧里看不出来。"
                f"修法:建完这一件立刻调 `_attach(o, hull_obj)`。"
            )


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------


def build() -> dict:
    """生成全部船只,返回统计信息。"""
    BU.clear_scene_once()

    mats = BU.MaterialLibrary()
    coll = BU.get_collection("全部船只")

    hull_mat = mats.get("wood_plank", C.Palette.WOOD_PLANK, roughness=0.82)
    frame_mat = mats.get("wood_dark", C.Palette.WOOD_DARK, roughness=0.88)
    cover_mat = mats.get("cloth_cover", C.Palette.CLOTH_UNDYED, roughness=0.95)
    rope_mat = mats.get("rope", C.Palette.ROPE, roughness=0.92)

    objs: dict[str, bpy.types.Object] = {}
    builders: list[BU.MeshBuilder] = []
    rig_count = 0

    # 桅顶高度 —— 两个状态都由**同一份桅网格**转出来(见该函数 docstring)。
    # 一次取两个,是为了让 AIR_MAX=4.00 这个门限的**卡点在哪一侧**一目了然。
    air_folded, air_raised = _mast_air_heights()

    # —— 开建之前先自检空间矛盾 ——
    #
    # 见文件头 §分块:桅座、篷首、眠桅架三者的位置互相牵制。放在这里
    # 而不是等 validate,是因为一旦不自洽,渲出来的图会**看起来像
    # 材质问题**(桅埋进篷里只显示成一截断木),而不是像穿模。
    cover_ahead_actual = MAST_FOOT_Y - COVER_Y1
    if cover_ahead_actual < COVER_AHEAD:
        print(
            f"  [警告] 舱篷离桅座太近:实有 {cover_ahead_actual:.3f}m < "
            f"需要 {COVER_AHEAD:.3f}m —— 眠桅后桅身会插进篷里"
        )
    if MAST_TIP_Y > CRUTCH_Y:
        print(
            f"  [警告] 眠桅架(y={CRUTCH_Y:.2f})落在桅梢"
            f"(y={MAST_TIP_Y:.2f})之后 —— 架子是空的,没托到桅"
        )

    for spec in FLEET:
        # —— 船壳 ——
        hull = BU.MeshBuilder(f"{spec.bid}_hull")
        _hull(hull)
        for sign in (-1, 1):
            _strake(hull, sign, _bulwark_of)
            _strake(hull, sign, _wale_of)
            _strake(hull, sign, _rail_of)
        _ends(hull)
        _deck_beams(hull)

        cover = BU.MeshBuilder(f"{spec.bid}_cover")
        ribs = BU.MeshBuilder(f"{spec.bid}_ribs")
        _cover(cover, ribs)

        fit = BU.MeshBuilder(f"{spec.bid}_fit")
        _fittings(fit, spec)

        builders += [hull, cover, ribs, fit]

        # —— 生成并摆位 ——
        o = hull.build(hull_mat, coll)
        if o is not None:
            o.location = (spec.x, spec.y, spec.z)
            o.rotation_euler = Euler((0.0, 0.0, spec.yaw_rad), "XYZ")
            TU.tag(
                o, f"{spec.bid}_hull", "boat",
                label=spec.kind, zone="河道",
                lod="near" if spec.folded else "mid",
                dynamic=True,
                hotspot=spec.hotspot,
                # ⚠️ draft 写在**船壳**上,不是写在整条船上。
                #    吃水是船壳的事:橹尾没入水下 1.7m、舵杆伸到 −1.27m,
                #    拿整条船的包围盒去量吃水,量到的是橹和舵,不是船。
                #    validate 的 boat.draft 只认带 qm_draft 的这一件。
                draft=DRAFT,
                beached=1 if spec.beached else 0,
                # ⚠️ 船壳也写 qm_parent,值就是**它自己**的 bid。
                #
                # 原先是"船壳不写、可动件写",省一个字段。但那让"一条船的
                # 全部物体"没有单一判据 —— 只能靠名字前缀去凑,而前缀正是
                # 本项目反复吃过亏的那类静默约定。改成所有船体构件(含船壳)
                # 一律 qm_parent = 本船 bid 之后,分组就只有一句:
                #     qm_kind == "boat" 且 qm_parent == bid
                # validate 的 within_bank / air / air_clear 都靠它,
                # 网页侧按船驱动(整船摇晃、整船眠桅)也靠它。
                parent=spec.bid,
                part="hull",
                air=(air_folded if spec.folded else air_raised)
                if "mast" in spec.rig else None,
                # —— 整船轻摇(阶段 4)——
                #
                # 轴心取**本船局部原点**,也就是水线在中线处的那一点。
                # 横摇的物理轴就是水线附近的纵轴,船绕它转时吃水的
                # 变化最小。船壳的局部原点正是这个点(见 `_hull` 与上面
                # 那句 `o.location = (spec.x, spec.y, spec.z)`),所以
                # `pivot` 与 `o.location` 是同一个值,不必另算。
                #
                # ⚠️ 别拿船壳包围盒的中心当轴心 —— 那个点更高、也更靠艏,
                #    绕它转船会**一边沉一边浮**,而不是横摇那个"绕着
                #    船底附近的轴左右晃"。两者在静帧里都看不出来。
                #
                # 轴 = 本船局部的 +Y(艏向)。世界向量 = Rz(yaw)·(0,1,0),
                # 与桅的折轴同一个算法(那边取的是局部的 +X),只是分量不同。
                anim="hull_rock",
                pivot=o.location,
                axis=Vector((-math.sin(spec.yaw_rad), math.cos(spec.yaw_rad), 0.0)),
                note=spec.note,
            )
            objs[f"{spec.bid}_hull"] = o
            # 下面所有构件都挂到它下面 —— 船壳是这条船的根。
            # 忘了挂会被 `_check_attached()` 拦下,见那里的注释。
            hull_obj = o

            # —— 艏向自检 ——
            #
            # 度/弧度写反是**不会报错**的:rotation_euler 收到 180 弧度
            # 照样接受,只是把船横过来。2026-09 就出过这一次 ——
            # 唯一 yaw=0 的主角船看着完全正常,其余五条全歪着。
            #
            # 所以摆完立刻从**物体矩阵**量一遍实际艏向。用 matrix_basis
            # 而不是 matrix_world:前者直接由 loc/rot/scale 算出,不含
            # 尚未求值的 depsgraph 缓存。
            fwd = o.matrix_basis.to_3x3() @ Vector((0.0, 1.0, 0.0))
            got = math.degrees(math.atan2(fwd.y, fwd.x))
            want = spec.yaw + 90.0          # 局部 +Y 是艏,转 yaw 度后朝 90+yaw
            if abs((got - want + 180.0) % 360.0 - 180.0) > 0.01:
                raise AssertionError(
                    f"{spec.bid} 艏向不符:声明 {spec.yaw}°,实测 {got:.2f}°。"
                    f"先查度/弧度是不是混用了。"
                )

        for b, m, nm in ((cover, cover_mat, "cover"),
                         (ribs, frame_mat, "ribs"),
                         (fit, frame_mat, "fit")):
            o = b.build(m, coll)
            if o is None:
                continue
            o.location = (spec.x, spec.y, spec.z)
            o.rotation_euler = Euler((0.0, 0.0, spec.yaw_rad), "XYZ")
            _attach(o, hull_obj)
            TU.tag(
                o, f"{spec.bid}_{nm}", "boat",
                label=spec.kind, zone="河道",
                lod="near" if spec.folded else "mid",
                dynamic=False, reflect=True,
                parent=spec.bid,
                part=nm,
                # 上岸的船**整条**都不做随水动作,不只船壳。
                # 只标船壳的话,`船_修`的舵(它带 qm_anim=rudder)会继续
                # 做那 3.5° 的"泊船微摆" —— 一条架在垫木上的船,舵自己在动。
                # 见 tag_utils 里 qm_beached 与 hull_rock 两处的说明。
                beached=1 if spec.beached else 0,
                note=spec.note,
            )
            objs[f"{spec.bid}_{nm}"] = o

        # —— 可动件 ——
        rigs: dict[str, tuple[BU.MeshBuilder, Vector, float, str, str, bool]] = {}
        if "mast" in spec.rig:
            rigs["mast"] = (
                _mast(), Vector((0.0, MAST_FOOT_Y, DECK_Z)),
                MAST_FOLD if spec.folded else 0.0,
                "mast_fold", "人字桅", spec.folded,
            )
        if "rudder" in spec.rig:
            rigs["rudder"] = (
                _rudder(), Vector((0.0, RUDDER_Y, RUDDER_TOP)),
                0.0, "rudder", "舵", False,
            )
        if "yuloh" in spec.rig:
            rigs["yuloh"] = (
                _yuloh(), Vector((YULOH_SIDE * YULOH_X, YULOH_Y, YULOH_Z)),
                0.0, "oar", "橹", False,
            )
        if "bow_oar" in spec.rig:
            rigs["bow_oar"] = (
                _bow_oar(), Vector((BOW_OAR_X, BOW_OAR_Y, BOW_OAR_Z)),
                0.0, "oar", "招", False,
            )

        for key, (b, pivot, rot_x, anim, label, is_folded) in rigs.items():
            o = b.build(hull_mat if key in ("yuloh", "bow_oar") else frame_mat, coll)
            if o is None:
                continue
            _place(o, spec, pivot, rot_x)
            # 桅/舵/橹/招都是**相对船体**转的,必须挂在船壳下。
            # 挂上之后网页侧算出来的轴心落在**船体坐标系**里,船一摇,
            # 轴心跟着船走 —— 正是物理上该有的样子。见 `_attach` 的注释。
            _attach(o, hull_obj)
            # 轴心与轴都用**世界坐标**记:网页那边不必再自己乘一遍艏向
            # 矩阵。绕局部 X 折的构件,世界轴 = Rz(yaw)·(1,0,0);
            # 绕局部 Z 转的舵、橹、招,世界轴恒为 (0,0,1)。
            if key == "mast":
                a = spec.yaw_rad
                axis = Vector((math.cos(a), math.sin(a), 0.0))
            else:
                axis = Vector((0.0, 0.0, 1.0))
            TU.tag(
                o, f"{spec.bid}_{key}", "boat",
                label=f"{spec.kind}·{label}", zone="河道",
                lod="near" if spec.folded else "mid",
                dynamic=True, reflect=True,
                anim=anim,
                pivot=o.location,
                axis=axis,
                parent=spec.bid,
                part=key,
                folded=1 if is_folded else 0,
                # 与舱篷/肋骨/属具同一条规则:上岸的船整条不做随水动作。
                # 这里是最要紧的一处 —— 舵/橹/招**本身就是动的**,
                # 漏标就会在旱地上自己转。见 qm_beached 的说明。
                beached=1 if spec.beached else 0,
                note=spec.note,
            )
            objs[f"{spec.bid}_{key}"] = o
            builders.append(b)
            rig_count += 1

        # —— 系缆 ——
        if spec.moor:
            mo, mb = _mooring(spec, coll, rope_mat)
            builders.append(mb)
            if mo is not None:
                # 系缆也挂在船壳下,尽管它一头系在岸上的缆桩上。
                #
                # 严格说缆绳**不是刚体**:船这一头随船走,岸那一头钉死。
                # 挂到船壳下等于让整根缆跟着船摆,岸端会偏。
                # 但这个偏差小到可以不算:横摇绕的是**纵轴**,而船的
                # 艏艉本来就在纵轴上(距轴 0~0.1m),所以系缆的船端
                # 在横摇下几乎不动 —— 2° 时不足 4mm。
                #
                # 反过来若**不挂**,船端反而会与船脱开,那是看得见的。
                # 两害相权,挂。且挂上之后"一条船的全部构件都在船壳下"
                # 成了无例外的规则,`_check_attached()` 才好写。
                _attach(mo, hull_obj)
                objs[f"{spec.bid}_mooring"] = mo

    _check_attached(objs)

    verts = sum(b.stats()["verts"] for b in builders)
    tris = sum(b.stats()["tris"] for b in builders)

    return {
        "objects": len(objs),
        "boats": len(FLEET),
        "rig_objects": rig_count,
        "draft": DRAFT,
        "freeboard": FREEBOARD,
        "hull_depth": DEPTH,
        "deck_z": DECK_Z,
        "mast_len": round(MAST_LEN, 4),
        "mast_fold_deg": round(math.degrees(MAST_FOLD), 3),
        "mast_reach": round(MAST_REACH, 3),
        "cover_top": round(COVER_TOP, 3),
        "cover_clear": round(
            DECK_Z + (MAST_FOOT_Y - COVER_Y1) * MAST_COT - COVER_TOP, 3
        ),
        # 桅的两个状态各一个总高。两个都报出来,是为了让 AIR_MAX=4.00
        # 这个门限**一眼看出卡在哪一侧**:眠桅 ~1.75 远在限内,立桅 ~7.41
        # 远超 —— 这正是"过桥必须眠桅"这个情节在数上的依据。
        "air_folded": round(air_folded, 4),
        "air_raised": round(air_raised, 4),
        "verts": verts,
        "tris": tris,
    }


def _mooring(
    spec: _Spec,
    coll: bpy.types.Collection,
    rope_mat: bpy.types.Material,
) -> tuple[bpy.types.Object | None, BU.MeshBuilder]:
    """
    系缆:船首、船尾各一根缆绳系到驳岸的缆桩上。

    为什么值得单独建:没有缆绳的泊船看起来是**悬在岸边**的,而不是
    泊着的。缆绳是一条极便宜的几何(两根圆柱 + 两根桩),却把"船
    和岸有关系"这件事说清楚了 —— 这正是"市井"与"摆件"的分别。

    缆绳的另一端落在**岸面**(x = ±8.7),不是水里:落在水里就成了
    沉缆,读不出系泊的意思。
    """
    b = BU.MeshBuilder(f"{spec.bid}_mooring")
    sign = 1.0 if spec.x > 0 else -1.0
    post_x = sign * (S.WATER_EDGE + 0.45)
    for end_local in (Vector((0.35, HALF - 1.10, DECK_Z + 0.26)),
                      Vector((-0.35, -HALF + 0.95, DECK_Z + 0.26))):
        bow = _to_world(spec, end_local)
        # 缆桩沿河错开一点,免得两根缆打成一个结
        post_y = bow.y + (1.4 if end_local.y > 0 else -1.4)
        b.add_cylinder(bow, Vector((post_x, post_y, 0.06)), 0.030, 5)
        b.add_cylinder(
            Vector((post_x, post_y, -0.30)),
            Vector((post_x, post_y, 0.55)),
            0.085, 6,
        )
    o = b.build(rope_mat, coll)
    if o is None:
        return None, b
    o.location = (0.0, 0.0, 0.0)
    TU.tag(
        o, f"{spec.bid}_mooring", "prop",
        label="系缆", zone="河道", lod="near",
        dynamic=True, reflect=True, anim="sway",
        parent=spec.bid,
        note="缆绳与岸上缆桩;桩落岸面不落水中",
    )
    return o, b


if __name__ == "__main__":
    stats = build()
    print("=" * 68)
    print("船队构建完成")
    for k, v in stats.items():
        print(f"  {k:<18} {v}")
    print("=" * 68)
