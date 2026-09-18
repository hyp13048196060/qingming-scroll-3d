"""
彩楼欢门 —— 酒楼正店门前用竹木**绑扎**起来的装饰性门楼。

形制依据
--------
· 《东京梦华录》记汴京酒店："凡京师酒店,门首皆缚彩楼欢门。" 它是酒户
  等级的标识 —— 正店(有酿酒权的大店)才扎得起,小店不扎。
· **杆件之间不用斗拱、不用榫卯,一律用麻索绑扎。** 这是它区别于"建筑"
  的根本点:彩楼欢门是**临时构筑物**,节日扎起、过后拆除,所以耗不起
  榫卯的工。`config.Celebration.HAS_DOUGONG = False`、`BINDING = "rope"`
  两条就写死在这里,由 `validate_scale.celebration.binding` 断言。
· 数量 **7 处**(`Celebration.COUNT`)。这个数是数出来的:原画里可辨的
  彩楼欢门共 7 座。原画没有编号,所以"数出 7"这件事本身也带主观性 ——
  边缘上有一两处模糊。**Reliability B**。

本模块的推断与边界(必读)
------------------------
原画里的 7 座欢门扎在汴京真实存在的 7 家酒楼门前。**本沙盘只有一栋酒楼**
(`04_buildings` 刻意只建了一栋歇山二层的正店 —— 原画里这类建筑本就
稀少,满街都是酒楼会把"市井"变成"商业街样板")。

于是"7 座"落到本场景时必然要**二次分配**。做法写明如下,不藏着:

    1. 那一栋酒楼(**歇山二层者,按 `qm_roof == "xieshan"` 认**)必占一座,
       且用加高的一档(H = 6.60m)。这一座是"有据"的。
    2. 其余 6 座,从未挂凉棚的铺面里**沿 y 均匀抽选** —— 判据是位置,
       不是"哪家更气派"。这是**分布上的推定,不是考据结论**:原画里
       哪 7 家、各自几间面阔,本场景无从对应。
    3. 挂凉棚的茶肆**排除**。凉棚与欢门在门前会打架,且茶肆等级不够。

所以 `celebration.count = 7` 这条断言证明的是"**本场景按 7 座布置**",
**不证明**"还原了原画里那 7 家"。

⚠️ **一处必须说清的失真:欢门密度远高于原画。**

    上面那条规则跑下来,7 座落在了本场景仅有的 **8 栋**铺面中的 7 栋上 ——
    等于**几乎所有临街铺面门前都扎了欢门**。而本模块开头刚写过
    "正店才扎得起,小店不扎"。两条摆在一起是自相矛盾的。

    矛盾的来源不是布置规则,是**场景的跨度**:原画的 7 座欢门散布在
    整卷汴京街市上,而本沙盘只截取了虹桥一带的一小段,总共就 8 栋铺面。
    "整卷 7 座"这个数落到"一小段"上,比例必然被放大。

    处置:**保留 7 座**(`Celebration.COUNT` 是原画层面的数,是形制红线,
    不该为了迁就沙盘跨度去改),**但把失真写明**:
    本场景的欢门密度不代表原画,看图时不要以本场景的密度去反推汴京实况。
    这一条同时写进 `docs/08-已知局限与未做还原.md`。

    另一条可选的路是"把铺面建到几十栋,让 7 座自然稀疏" —— 那是
    `04_buildings` 的工程量,不在本模块能解决的范围内,故不做。

为什么从场景里读铺面,而不是重算一遍铺面链
------------------------------------------
`04_buildings` 的铺面链是 `_shop_chain(rng, ya, yb)` 生成的,带随机数。
本模块若自己再推一遍,只要 04 的链长或随机数一变,欢门就会**站在没有
房子的地方** —— 而预览图上看起来只是"欢门位置有点怪",不像错误。
这正是本项目反复栽的模式:**这个数由另一处几何决定,就该量,不该推。**

所以本模块**跑在 04 之后**(见 `run_all._STAGE_MODULES` 的顺序),
直接读已建成的 `*_plinth` 物体,从它的世界坐标里量出临街面与面阔。

产出(每座 3 个物体)
--------------------
    {cid}_frame   立柱 + 横枋 + 斜撑
    {cid}_lash    每个节点上的麻索环 —— `celebration.binding` 的几何凭据
    {cid}_cloth   彩帛:层间垂幔 + 悬挂的幡子(带风动权重)

已知简化(如实声明,不等于已还原)
--------------------------------
1. **彩帛取低饱和砖红一色**,没有做原画里那种多色彩帛与扎花。
   用户给定的视觉方向是"低饱和衣饰",多色会破坏整条街的明度关系。
2. **没有做斗拱 —— 这是对的**,但也**没有做原画里繁复的扎花、系结、
   灯笼**。欢门在远处是一个"识别性轮廓",近看构件是偏简的。
3. **杆件是方料,不是竹**。竹有节、有锥度,本模块用等截面方料代替;
   远看无差别,近看能看出它不是竹。
4. **每座的形制完全相同**,只有高度与面阔按铺面缩放。原画里 7 座
   形制各异。
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

BLENDER_DIR = Path(__file__).resolve().parents[1]
if str(BLENDER_DIR) not in sys.path:
    sys.path.insert(0, str(BLENDER_DIR))

import config as C              # noqa: E402
from lib import bl_utils as BU  # noqa: E402
from lib import tag_utils as TU  # noqa: E402

Cel = C.Celebration
P = C.Palette

# --------------------------------------------------------------------------
# 构造参数
# --------------------------------------------------------------------------

# 门洞净高。**这是绝对量,不随欢门大小缩放** —— 它由人的身高决定,
# 不是构图的量。写成比例的后果是:小铺面的欢门门洞会矮到钻不过人,
# 而预览图上看不出那是"不能走"的。
#
# 取自 config —— 校验器也要拿它核净空,两处共读一份。凡"这个数由另一处
# 决定"的地方一律只留一个来源,否则改了一处、校验器按旧值去核新几何,
# 报出来的失败与几何无关(本项目已栽过好几次)。
Z_LINTEL = Cel.Z_LINTEL

H_SHOP = Cel.H_SHOP      # 一般铺面门前的欢门总高
H_REST = Cel.H_REST      # 酒楼门前的高一档

CEL_DEPTH = 1.60         # 进深(沿 x,自台基外沿向街心)
#
# 面阔(沿 y)按**铺面面阔的一个比例**取,不是写死一个数。
#
# ⚠️ 这里量过一次,量完才改的算式。原先写的是
#       W = clamp(L - 2×0.45, 3.6, 7.0)
#    而本场景实测的 8 栋铺面面阔是 11.67 ~ 13.79m —— **全部**撞在上限
#    7.0 上,于是 7 座欢门面阔一模一样,"按铺面缩放"那半句形同虚设。
#    写死的上限把一个"随铺面变化"的量变成了常量,而图上完全看不出来:
#    7 座各自都合理,只有把它们排在一起比才发现完全一样。
#
# 比例取 0.60:原画里欢门占的是铺面中部的几个开间,不是整个店面。
# 一间铺面 5 开间时欢门约占 3 间 → 3/5 = 0.6。**这是推断值,不是测得的**:
# 原画没有可用的比例尺,这个 0.60 是从"看得见几开间、盖住几开间"上
# 比出来的。Reliability C。
W_FRAC = Cel.W_FRAC
W_MAX = Cel.W_MAX        # 面阔上限(沿 y):再宽就顶到邻铺门口了
W_MIN = Cel.W_MIN        # 面阔下限 —— 太窄就不像楼,像门框

# 立面分档:(相对"门洞以上那一段"的比例, 相对面阔的宽度)
#
# 第一档 = 门洞上沿(Z_LINTEL,绝对标高);其余按 H - Z_LINTEL 等比。
# 宽度递减做出"三层递收"的楼形 —— 这是彩楼欢门最有辨识度的轮廓特征:
# 它不是一榀门框,是一座**收分的架子**。
TIER_F = (0.00, 0.30, 0.55, 0.75, 0.90)
TIER_W = (1.00, 1.00, 0.86, 0.70, 0.52)
# 顶:从最后一档升到 H,做一个小山面(正脊走 x 向,朝街的是山面)
TOP_W = 0.52

POST_SEC = Cel.POST_SEC  # 立柱截面
RAIL_SEC = 0.14          # 横枋截面
BRACE_SEC = 0.10         # 斜撑截面

RING_MAJOR_SEG = Cel.RING_MAJOR_SEG   # 索环段数(每环顶点数 = major_seg × minor_seg)
RING_MINOR_SEG = Cel.RING_MINOR_SEG
RING_CLEAR = 0.030       # 索绳外缘离构件表面的间隙
RING_R = 0.032           # 索绳半径

BANNER_W = 0.40          # 幡子宽
BANNER_GAP = 0.22        # 幡子间距
BANNER_DROP = 1.30       # 幡子垂长
CLOTH_DROP = 0.34        # 层间垂幔的下垂量
CLOTH_T = 0.030          # 彩帛厚


# --------------------------------------------------------------------------
# 工具
# --------------------------------------------------------------------------


def _hint_for(p0: Vector, p1: Vector) -> Vector:
    """
    给一根杆件挑一个不与它平行的 hint。

    `add_box` 的 v/w 由 `hint × u` 定,hint 一旦与杆件平行,叉乘退化。
    竖杆用横的 hint、横杆用竖的 hint —— 这里就近挑一个不共线的世界轴。
    """
    u = (Vector(p1) - Vector(p0)).normalized()
    for cand in (Vector((0.0, 0.0, 1.0)), Vector((0.0, 1.0, 0.0)),
                 Vector((1.0, 0.0, 0.0))):
        if abs(u.dot(cand)) < 0.95:
            return cand
    return Vector((0.0, 0.0, 1.0))


def _beam(b: BU.MeshBuilder, p0, p1, sec: float) -> None:
    """两点之间一根方料。截面 sec × sec。"""
    p0, p1 = Vector(p0), Vector(p1)
    b.add_box(p0, p1, sec, sec, _hint_for(p0, p1))


def _lash(b: BU.MeshBuilder, at, axis, half: float) -> None:
    """
    在一个节点上套一道麻索环。

    ⚠️ 环必须是**分开的两个半径**(`major_r` / `major_r2`),不能用正圆。
        立柱是方的、横枋是扁的,节点处那一束截面不是圆的;正圆环会在
        宽的那一向悬空。这条教训是虹桥索绑踩出来的(见
        `01_bridge._lash_layer`),这里照搬。
        杆件此处截面各向都是 POST_SEC,所以两个半径取同一个值即可 ——
        但**参数仍然分开传**,好让"这里没有扁截面"这件事是显式的。
    """
    h = half + RING_CLEAR
    b.add_torus(
        center=Vector(at),
        axis=Vector(axis),
        major_r=h,
        minor_r=RING_R,
        major_seg=RING_MAJOR_SEG,
        minor_seg=RING_MINOR_SEG,
        major_r2=h,
    )


# --------------------------------------------------------------------------
# 从场景里读铺面
# --------------------------------------------------------------------------


def _survey() -> list[dict]:
    """
    量出每一栋沿街铺面的临街面与面阔。

    ⚠️ 判据一律取**几何**,不取命名。`shop_e0_0_lou` 这个名字是
        `04_buildings` 内部拼出来的,改个后缀这里就全落空;
        而"台基最靠河的那一面在哪、它有多长"是量出来的,改不掉。
    """
    out: list[dict] = []
    for o in bpy.data.objects:
        if o.get("qm_kind") != "building" or not o.name.endswith("_plinth"):
            continue
        bid = o.get("qm_parent")
        if not bid or not str(bid).startswith("shop_"):
            continue
        vs = [o.matrix_world @ Vector(v.co) for v in o.data.vertices]
        if not vs:
            continue
        xs = [v.x for v in vs]
        ys = [v.y for v in vs]
        out.append({
            "bid": str(bid),
            "dirn": 1 if sum(xs) > 0 else -1,
            "front": min(abs(x) for x in xs),      # 最靠河的那一面
            "y0": min(ys),
            "y1": max(ys),
        })
    out.sort(key=lambda d: (d["dirn"], d["y0"]))
    return out


def _with_part(suffix: str) -> set[str]:
    """找出所有拥有 `{bid}{suffix}` 这个部件的铺面 id。"""
    return {
        str(o.get("qm_parent"))
        for o in bpy.data.objects
        if o.get("qm_kind") == "building"
        and str(o.get("qm_id", "")).endswith(suffix)
        and o.get("qm_parent")
    }


def _pick(shops: list[dict]) -> list[dict]:
    """
    挑出立欢门的 7 处。规则与理由见模块文档字符串 —— 简言之:
    酒楼必占一座(有据),其余 6 座沿 y 均匀抽选(分布上的推定)。
    """
    restaurants = {
        str(o.get("qm_parent"))
        for o in bpy.data.objects
        if o.get("qm_kind") == "building" and o.get("qm_roof") == "xieshan"
        and o.get("qm_parent")
    }
    # 挂凉棚的铺面(茶肆)排除:凉棚与欢门在门前会打架,且茶肆等级不够
    awnings = _with_part("_awning")

    must = [s for s in shops if s["bid"] in restaurants]
    pool = [s for s in shops if s["bid"] not in restaurants and s["bid"] not in awnings]
    pool.sort(key=lambda s: s["y0"])

    need = Cel.COUNT - len(must)
    if need <= 0:
        return must[: Cel.COUNT]
    if len(pool) < need:
        raise RuntimeError(
            f"可挂欢门的铺面只有 {len(pool)} 处,不够 {need} 处 —— "
            f"宁可不建,也不要把欢门摞在同一栋房上凑数"
        )

    # 沿 y 均匀抽:取每等份的**中点**,而不是等分点 ——
    # 等分点会贴着两段的交界,相邻两次抽选容易落到同一排上。
    step = len(pool) / need
    picked = [pool[int(i * step + step / 2.0)] for i in range(need)]
    if len({s["bid"] for s in picked}) != need:
        raise RuntimeError("均匀抽选抽重了 —— 抽选逻辑与池子长度不匹配")
    return must + picked


# --------------------------------------------------------------------------
# 建一座
# --------------------------------------------------------------------------


def _one(coll, mats, s: dict, cid: str, tall: bool) -> dict:
    """建一座彩楼欢门,返回它的统计。"""
    dirn = s["dirn"]
    H = H_REST if tall else H_SHOP

    W = min(W_MAX, max(W_MIN, W_FRAC * (s["y1"] - s["y0"])))
    yc = 0.5 * (s["y0"] + s["y1"])
    ya, yb = yc - W / 2.0, yc + W / 2.0

    # 立面临街:靠河的一面 x 小、靠铺面的一面 x 大(两边岸都成立)
    x_near = dirn * (s["front"] - CEL_DEPTH)
    x_far = dirn * s["front"]

    frame = BU.MeshBuilder(f"{cid}_frame")
    lash = BU.MeshBuilder(f"{cid}_lash")
    cloth = BU.MeshBuilder(f"{cid}_cloth")

    # —— 分档标高与宽度 ——
    span = H - Z_LINTEL
    tiers = []
    for f, wf in zip(TIER_F, TIER_W):
        z = Z_LINTEL + f * span
        half_w = 0.5 * W * wf
        tiers.append({"z": z, "ya": yc - half_w, "yb": yc + half_w})

    n_rings = 0

    # —— 每档:四根短柱 + 一圈横枋 + 节点索环 ——
    for i, t in enumerate(tiers):
        z0 = tiers[i - 1]["z"] if i else -0.10      # 落地那档埋进街面一点
        corners = ((x_near, t["ya"]), (x_near, t["yb"]),
                   (x_far, t["ya"]), (x_far, t["yb"]))
        for (cx, cy) in corners:
            _beam(frame, (cx, cy, z0), (cx, cy, t["z"]), POST_SEC)
            _lash(lash, (cx, cy, t["z"]), (0.0, 0.0, 1.0), POST_SEC / 2.0)
            n_rings += 1
        # 前后两道横枋(沿 y),左右两道系梁(沿 x)
        for x in (x_near, x_far):
            _beam(frame, (x, t["ya"], t["z"]), (x, t["yb"], t["z"]), RAIL_SEC)
        for y in (t["ya"], t["yb"]):
            _beam(frame, (x_near, y, t["z"]), (x_far, y, t["z"]), RAIL_SEC)

    # —— 斜撑:每一档在两面各打一对"八"字撑 ——
    #
    # 它是绑扎结构的**读法**:榫卯结构的杆件交于一点、互相咬合,立面干净;
    # 绑扎结构靠斜撑把节点连成三角形,立面上会看见斜杆。没有斜撑,
    # 一榀方框在结构上说不通 —— 一推就倒。
    for i in range(1, len(tiers)):
        lo, hi = tiers[i - 1], tiers[i]
        for x in (x_near, x_far):
            _beam(frame, (x, lo["ya"], lo["z"]), (x, hi["ya"], hi["z"]), BRACE_SEC)
            _beam(frame, (x, lo["yb"], lo["z"]), (x, hi["yb"], hi["z"]), BRACE_SEC)
        for y in (lo["ya"], lo["yb"]):
            _beam(frame, (x_near, y, lo["z"]), (x_far, y, hi["z"]), BRACE_SEC)

    # —— 顶:朝街的是山面,正脊走 x 向 ——
    top = tiers[-1]
    z_ridge = H
    Z_EAVE_TOP = top["z"]
    for y in (top["ya"], top["yb"]):                      # 两根檐檩
        _beam(frame, (x_near, y, Z_EAVE_TOP), (x_far, y, Z_EAVE_TOP), RAIL_SEC)
    _beam(frame, (x_near, yc, z_ridge), (x_far, yc, z_ridge), RAIL_SEC)   # 正脊
    # 椽:沿坡向(走 y)铺,在进深方向排几道。
    # ⚠️ 椽走的是 y,不是 x —— 正脊走 x、朝街的是山面,坡是往 ±y 落的。
    #    我第一版把椽写成了沿 x 的两根固定杆,循环体里根本没用到循环变量,
    #    于是画了 5 遍同样两根杆:几何上重叠、统计上多算,而图上看着
    #    "就是有两根杆",完全看不出来。**循环变量没进循环体,是死代码的味道。**
    n_ridge = 4
    for k in range(n_ridge + 1):
        xx = x_near + (x_far - x_near) * k / n_ridge
        _beam(frame, (xx, top["ya"], Z_EAVE_TOP), (xx, yc, z_ridge), BRACE_SEC)
        _beam(frame, (xx, top["yb"], Z_EAVE_TOP), (xx, yc, z_ridge), BRACE_SEC)
    # 起翘:山面两端的椽头往上挑一点,免得山面是一条死板的斜线
    LIFT = 0.28
    for y, sgn in ((top["ya"], -1.0), (top["yb"], +1.0)):
        _beam(frame, (x_near, y, Z_EAVE_TOP),
              (x_near, y + sgn * 0.34, Z_EAVE_TOP + LIFT), BRACE_SEC)
        _beam(frame, (x_far, y, Z_EAVE_TOP),
              (x_far, y + sgn * 0.34, Z_EAVE_TOP + LIFT), BRACE_SEC)

    # —— 彩帛:层间垂幔 ——
    #
    # 挂在靠街那一面(视线所及),每档一道,从上沿垂下 CLOTH_DROP。
    for i, t in enumerate(tiers):
        if i == 0:
            continue                    # 门洞上沿那档不挂,免得挡住门
        _beam_cloth(cloth, x_near, t["ya"], t["yb"], t["z"], dirn)

    # —— 彩帛:幡子 ——
    #
    # 从最上一道横枋垂下来。幡子之间留空 —— 连成一片就成了一块布幕,
    # 分条的幡子才有"一条一条挂着"的观感。
    z_banner = tiers[-1]["z"]
    n_fit = max(1, int((top["yb"] - top["ya"] - 2.0 * BANNER_W) // (BANNER_W + BANNER_GAP)) + 1)
    y_start = 0.5 * (top["ya"] + top["yb"]) - 0.5 * (
        n_fit * BANNER_W + (n_fit - 1) * BANNER_GAP
    )
    for k in range(n_fit):
        y = y_start + k * (BANNER_W + BANNER_GAP)
        _banner(cloth, x_near, y, y + BANNER_W, z_banner, z_banner - BANNER_DROP, dirn)

    # —— 成体 ——
    fo = frame.build(mats.get("wood_old", P.WOOD_OLD), coll)
    lo_ = lash.build(mats.get("rope", P.ROPE), coll)
    co = cloth.build(mats.get("celebration_cloth", C.Palette.CELEBRATION_CLOTH), coll)

    note = ("竹木绑扎的临时构筑物:立柱+横枋+斜撑,节点全部以麻索捆扎,"
            "无斗拱、无榫卯")
    TU.tag(fo, f"{cid}_frame", "celebration", parent=cid, label="彩楼欢门",
           zone="市井", lod="near", hotspot=True, dynamic=True,
           binding=Cel.BINDING, dougong=0, note=note)
    # 索环数写进标签,**校验器要从几何里把它数回来核对** ——
    # 声明给了不算数,声明与几何一致才算(见 validate_scale.celebration.binding)。
    TU.tag(lo_, f"{cid}_lash", "celebration", parent=cid, zone="市井", lod="near",
           binding=Cel.BINDING, dougong=0, lash_rings=n_rings,
           note="节点麻索环 —— celebration.binding 的几何凭据")
    # 彩帛写风动:幡子是这一景里最该动的东西,不动就成了一块硬板。
    TU.tag(co, f"{cid}_cloth", "celebration", parent=cid, label="彩帛", zone="市井",
           lod="near", anim="wind", flex="flex", dynamic=True,
           binding=Cel.BINDING, dougong=0,
           note="层间垂幔 + 悬挂幡子;风动权重 = 离悬挂点越远越大")

    # 风动权重:挂点(上沿)为 0,垂到最下为 1
    z_hi = tiers[-1]["z"]
    z_lo = min(z_hi - BANNER_DROP, min(t["z"] - CLOTH_DROP for t in tiers[1:]))

    def _w(co) -> float:                       # noqa: ANN001  (TagUtils 的约定)
        return (z_hi - co.z) / max(z_hi - z_lo, 1e-6)

    TU.add_flex_attribute(co, _w)

    return {
        "id": cid,
        "shop": s["bid"],
        "tall": tall,
        "W": round(W, 3),
        "H": H,
        "z_lintel": Z_LINTEL,
        "lash_rings": n_rings,
        "x": (round(x_near, 3), round(x_far, 3)),
        "y": (round(ya, 3), round(yb, 3)),
    }


def _beam_cloth(b: BU.MeshBuilder, x_face: float, ya: float, yb: float,
                z_top: float, dirn: int) -> None:
    """
    一道垂幔:贴在靠街那一面、自上沿垂下来的一小片布。

    厚度向街心出挑 —— 布是挂在杆**外面**的,不是嵌在杆里的。
    """
    xo = x_face - dirn * (RAIL_SEC / 2.0 + CLOTH_T)
    b.add_hexa([
        Vector((xo, ya, z_top)), Vector((xo, yb, z_top)),
        Vector((xo, yb, z_top - CLOTH_DROP)), Vector((xo, ya, z_top - CLOTH_DROP)),
        Vector((xo + dirn * CLOTH_T, ya, z_top)),
        Vector((xo + dirn * CLOTH_T, yb, z_top)),
        Vector((xo + dirn * CLOTH_T, yb, z_top - CLOTH_DROP)),
        Vector((xo + dirn * CLOTH_T, ya, z_top - CLOTH_DROP)),
    ])


def _banner(b: BU.MeshBuilder, x_face: float, ya: float, yb: float,
            z_top: float, z_bot: float, dirn: int) -> None:
    """一条幡子:窄而长的布,自悬挂点垂下。"""
    xo = x_face - dirn * (RAIL_SEC / 2.0 + CLOTH_T)
    b.add_hexa([
        Vector((xo, ya, z_top)), Vector((xo, yb, z_top)),
        Vector((xo, yb, z_bot)), Vector((xo, ya, z_bot)),
        Vector((xo + dirn * CLOTH_T, ya, z_top)),
        Vector((xo + dirn * CLOTH_T, yb, z_top)),
        Vector((xo + dirn * CLOTH_T, yb, z_bot)),
        Vector((xo + dirn * CLOTH_T, ya, z_bot)),
    ])


# --------------------------------------------------------------------------
# 主入口
# --------------------------------------------------------------------------


def build() -> dict:
    BU.clear_scene_once()
    # 独立集合,名字与 `config.Export.CHUNKS["scene_props"]` 逐字一致。
    # 先用的是 04 的 "buildings",两边名字与分块表都不符 —— 见 04 同一处的注释。
    coll = BU.get_collection("彩楼欢门")
    mats = BU.MaterialLibrary()

    shops = _survey()
    if not shops:
        raise RuntimeError(
            "场景里量不到任何铺面台基 —— 05_celebrations 必须跑在 "
            "04_buildings **之后**(见 run_all 的模块顺序)。"
            "单独跑本模块不会有产出,这是有意的:欢门的位置由铺面几何决定。"
        )
    chosen = _pick(shops)
    tall = _tall_indices(chosen)          # 提出来算一次,别放进循环

    rows = []
    for i, s in enumerate(chosen):
        side = "e" if s["dirn"] > 0 else "w"
        cid = f"cel_{side}{i:02d}"
        rows.append(_one(coll, mats, s, cid, tall=(i in tall)))

    return {
        "celebration_objects": sum(1 for o in bpy.data.objects
                                   if o.get("qm_kind") == "celebration"),
        "celebrations": len(rows),
        "lash_rings": sum(r["lash_rings"] for r in rows),
        "heights": sorted({r["H"] for r in rows}),
        "widths": (min(r["W"] for r in rows), max(r["W"] for r in rows)),
        "rows": rows,
    }


def _tall_indices(chosen: list[dict]) -> set[int]:
    """哪几座用加高的一档 —— 有酒楼的那座,以及其后每一座都算? 不:只有酒楼。"""
    restaurants = {
        str(o.get("qm_parent"))
        for o in bpy.data.objects
        if o.get("qm_kind") == "building" and o.get("qm_roof") == "xieshan"
        and o.get("qm_parent")
    }
    return {i for i, s in enumerate(chosen) if s["bid"] in restaurants}


if __name__ == "__main__":
    import json

    from lib import bl_utils as _BU

    # ⚠️ `reset_clear_flag()` **一个进程只许调一次**,而且必须在最前头。
    #    我第一版在 `--alone` 分支前后各调了一次:第二次 reset 让下面
    #    `build()` 里的 `clear_scene_once()` 重新有了"该清场景"的资格,
    #    把刚建好的 04 铺面**整套清光**。症状是"量不到任何铺面台基",
    #    看着像铺面没建成,其实是清场标志被重复授权。
    #    与 `_run_stage2` / `run_all` 同一套约定:清一次,后面都当它清过了。
    _BU.reset_clear_flag()

    # 单独跑本模块没有铺面可读 —— 这是设计,不是缺陷。为了能单独看它,
    # 这里先把 04 跑一遍。**只在这个自检入口里这么做**,
    # `run_all` / `preview` 走的是正常的顺序流水线。
    if "--alone" in sys.argv:
        from lib import modules as _MOD

        _MOD.load_build("04_buildings").build()

    r = dict(build())
    r["rows"] = r["rows"][:2] + [f"…共 {len(r['rows'])} 座"]
    print(json.dumps(r, ensure_ascii=False, indent=2)[:3000])
