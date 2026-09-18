"""
场地布置 —— 两岸地坪、沿河街道、纤道、桥头引道、远景地裙。

这一层建的是**整个场景的底面**。它自己不好看(就是几片土色地面),
但它是后面八个 builder 的公共参照:所有物体都"站"在它上面,
坐标全部来自 `config.Site`。

为什么单独一个 builder 而不是塞进 02_river
--------------------------------------------
河道是**放样**出来的(沿 Y 扫一个断面),地坪是**分区铺**出来的
(沿 X 分带宽窄不一)。两者的建模方式、迭代节奏、出错方式都不一样,
混在一个文件里改河道时会不小心碰坏街道。分开放。

平面分区(数值全部来自 config.Site,此处不重复写死)
----------------------------------------------------
    东岸:  ┃水面┃ 收分 ┃ 纤道 ┃  街道  ┃    市井地坪     ┃ 城墙 ┃ 郊野
    x=0   8.25   10    12.2    21.2              58      76.4     108

**两处必须说清的推定**(Reliability C,不是考据):

1. 街道贴河布置、宽 9m。原画中两岸街道的宽度无法从散点透视里量出来。
   取 9m 是为了让两辆独轮车 + 一行人能错身而过 —— 这是**功能推定**。

2. 郊野地面起伏 ±1.2m。原画里河岸外侧是田畴与柳林,不是平板。
   起伏用固定相位的正弦叠加生成(不用 `mathutils.noise`,避免
   Blender 版本间噪声实现漂移导致两次构建立不了等价)。

⚠️ 本 builder **不建水面、不建河床** —— 那是 02_river 的事。
   它建的是 x ∈ [±10, ±108] 这一段**露出水面以上**的陆地。
"""

from __future__ import annotations

import math
import sys
from pathlib import Path

import bpy

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import config as C  # noqa: E402
from lib import bl_utils as BU  # noqa: E402
from lib import tag_utils as TU  # noqa: E402

# 桥面**上表面**在起拱点处的标高。引道要和它对齐,不能各写各的。
#
# 桥面板中心线的半径 = 拱轴半径 + 第二系统偏心 + 第二系统半厚 + 桥板半厚,
# 上表面还要再加半个板厚,合并即:
#     r = radius + SYS2_OFFSET + SYS2_DEPTH/2 + DECK_THICKNESS
_R_DECK_TOP = (
    C.Bridge.radius()
    + C.Bridge.SYS2_RADIAL_OFFSET
    + C.Bridge.SYS2_DEPTH / 2
    + C.Bridge.DECK_THICKNESS
)
DECK_TOP_AT_SPRINGING = C.Bridge.center_y() + _R_DECK_TOP * math.cos(
    C.Bridge.half_angle()
)

# 引道:自桥头降落到街面。
#
# ⚠️ 起点标高取得比桥面**略高一点**(+3cm),这是**故意的**,不是误差。
#    桥面板是分成 40 段折线拼出来的,折线的端点落在圆弧的**内侧**,
#    所以桥面末端的实际高度比上面按圆弧算出的值低约 2~3cm。
#    引道取圆弧值,正好盖住这点差;反过来(取折线值)则会在桥头
#    露出一条两三厘米的缝,远看像桥没接上。
RAMP_TOP = DECK_TOP_AT_SPRINGING
RAMP_LEN = 7.0          # 引道水平投影长度. Reliability C
RAMP_HALF_W = C.Bridge.DECK_WIDTH / 2 + 0.4   # 比桥面略宽,形成收边

# 地面板厚。见 BU.MeshBuilder.add_slab 的说明 —— 厚度是为了让法线
# 朝向确定,不是结构需要。
GROUND_T = 0.5

# 沿 Y 的分段。6m 一段:郊野起伏的波长在 30m 量级,6m 足够采出来;
# 再密就只是堆三角形。
SEG_LEN = 6.0

# 远景区外缘。再远交给雾,不再建几何。
# 取 config 的值而不是就地写一个 —— 河道长度(02_river)要与它对上,
# 否则地裙为河留出的通廊尽头会露出虚空。config 的自检里钉了这条。
FAR = C.Site.FAR

# 城墙外缘(郊野自这里开始)。
WALL_OUTER = C.Site.WALL_INNER + C.Gate.WALL_THICKNESS

# 起伏自城墙外缘起**渐入**的长度。
# ⚠️ 没有这个渐变,城墙根上会出现一道 1m 多高的陡坎 ——
#    `_undulation` 在 x = 76.4 处一般不为 0,而墙脚那一片是平的。
FIELD_BLEND = 8.0

# 地裙离河越远抬得越高的跨度(抬升总量见 _ground)。
RISE_SPAN = 120.0
RISE_MAX = 3.0


def _undulation(x: float, y: float) -> float:
    """
    郊野地面的起伏,单位米。

    ⚠️ 刻意**不用** `mathutils.noise`:它的噪声实现在 Blender 版本之间
       改过,同一个种子在不同版本上会给出不同的地形 —— 那样
       `verify_reproducible.mjs` 的"两次构建统计量一致"就废了。
       正弦叠加虽然土,但它是**跨版本确定**的。

    振幅 1.2m、波长 30~70m:够读出"这是野地",又不至于让远处的
    树和房子浮在空中(它们按各自所在位置采样同一个函数)。
    """
    return (
        0.72 * math.sin(x * 0.0912 + 1.31) * math.cos(y * 0.0733 - 0.47)
        + 0.34 * math.sin(x * 0.2117 - 2.05) * math.cos(y * 0.1781 + 0.92)
        + 0.19 * math.sin((x + y) * 0.3241 + 0.28)
    )


def _flat(x: float, y: float) -> float:
    return 0.0


def _ground(x: float, y: float) -> float:
    """
    细致区**以外**的地面高度:起伏(自城墙外缘渐入)+ 离河越远抬得越高。

    ⚠️ 两条纪律,都是踩过坑换来的:

    1. **高度只能由坐标 (x, y) 算出,不能按块预先算好一个常数。**
       老版的 `_frame` 把抬升量按块算(取该块 x 区间的内缘),于是
       相邻两块的抬升量相差近 1m —— 远景地裙上出现一道道**梯田**。
       俯视图里看不出来(正投影下看不出高度差),掠视时非常显眼。
       同一个坑在这一阶段踩过两次(另一次是形制校验的取样窗口):
       **分块建模时,块与块之间的连续量必须由坐标决定。**

    2. **抬升量必须 `max(0, …)` 夹住。** 老版没夹,而 `_frame` 的
       横向范围一直延伸到河岸(x = ±10),那里的表达式是**负的**,
       于是近河的地裙被**压低**了 2.45m —— 比水面还低,在地上
       挖出一条沟。夹住之后这一项在岸内侧恒为 0。

    起伏在城墙外缘 8m 内线性渐入,而不是一到郊野就跳起来:
    墙脚那一片是平的,直接接 ±1.2m 的起伏会在墙上留下一道陡坎。
    """
    t = min(1.0, max(0.0, (abs(x) - WALL_OUTER) / FIELD_BLEND))
    rise = RISE_MAX * min(
        1.0, max(0.0, (abs(x) - C.Site.BANK_OUTER) / RISE_SPAN)
    )
    return _undulation(x, y) * t + rise


def _band(
    builder: BU.MeshBuilder,
    sign: int,
    x_in: float,
    x_out: float,
    z_at,
    *,
    y0: float = None,
    y1: float = None,
) -> None:
    """
    沿 Y 铺一条纵向条带(两岸通用)。

    sign = +1 东岸、-1 西岸。x_in/x_out 一律给正值,内部按 sign 定序,
    这样 config.Site 里的数就只用写一遍。
    """
    y0 = C.Site.Y_MIN if y0 is None else y0
    y1 = C.Site.Y_MAX if y1 is None else y1

    xa, xb = sorted((sign * x_in, sign * x_out))
    n = max(1, round((y1 - y0) / SEG_LEN))
    step = (y1 - y0) / n
    for i in range(n):
        ya = y0 + i * step
        yb = ya + step
        builder.add_slab(xa, xb, ya, yb, z_at, thickness=GROUND_T)


def _frame(
    builder: BU.MeshBuilder,
    x0: float,
    x1: float,
    y0: float,
    y1: float,
    *,
    segs: int = 4,
) -> None:
    """
    远景地裙:分块铺一大片,高度按 `_ground` 抬起来。

    为什么要它:没有地裙时,越过 108m 就是虚空,相机稍微抬高就能看见
    场景浮在一块孤岛上。有了它,雾散开的方向上至少还有起伏的地面。

    块与块之间**共用角点**(xa/xb/ya/yb 用同一个公式算),所以相邻块
    严丝合缝 —— 分块只造成面化(faceting),不会造成裂缝。
    面化对远景无所谓;有所谓的是块间高度差,而那由 `_ground` 保证
    (它只看坐标,不看块)—— 见 `_ground` 的说明。
    """
    nx = max(1, segs)
    ny = max(1, segs)
    for i in range(nx):
        for j in range(ny):
            xa = x0 + (x1 - x0) * i / nx
            xb = x0 + (x1 - x0) * (i + 1) / nx
            ya = y0 + (y1 - y0) * j / ny
            yb = y0 + (y1 - y0) * (j + 1) / ny
            builder.add_slab(xa, xb, ya, yb, _ground, thickness=GROUND_T)


def build() -> dict:
    """生成场地,返回统计信息。"""
    BU.clear_scene_once()

    mats = BU.MaterialLibrary()
    coll = BU.get_collection("岸线")

    road_mat = mats.get("road", C.Palette.ROAD, roughness=0.98)
    earth_mat = mats.get("earth", C.Palette.EARTH, roughness=1.0)

    road = BU.MeshBuilder("岸线_路")      # 纤道 + 沿河街道 + 桥头引道
    earth = BU.MeshBuilder("岸线_地坪")    # 市井地坪 + 城墙内外 + 郊野 + 远景地裙

    S = C.Site

    for sign in (-1, 1):
        # —— 纤道 ——
        # 拉纤的道。《东京梦华录》里汴河漕运靠纤夫,岸边必有通路。
        # 它紧贴水边,是"河与街之间的过渡" —— 少了它,街道会直接切到水里。
        _band(road, sign, S.ABUTMENT_FACE, S.BUND_OUTER, _flat)

        # —— 沿河主街 ——
        _band(road, sign, S.BUND_OUTER, S.STREET_OUTER, _flat)

        # —— 市井地坪 ——
        # 店铺就摆在这一带上。保持**完全水平**:房子要坐平,
        # 地面若有起伏,每栋房子都得单独垫台基,得不偿失。
        _band(earth, sign, S.STREET_OUTER, S.WALL_INNER, _flat)

        # —— 城墙基址 ——
        #
        # 城墙本身在 04_buildings 里建,但**基址的地面必须在这里就铺**。
        # 不铺的话,留给城墙的那一块是个洞:俯视图上它是天窗(露出背景色),
        # 站在桥上顺河望下去,它是地平线上的一块白斑。渲出来才发现 ——
        # "等以后那个 builder 来填" 是这次场地返工的根本原因。
        #
        # 夯土城墙本来就要坐在平整的基址上,所以这一带取平,不起伏。
        _band(earth, sign, S.WALL_INNER, WALL_OUTER, _flat)

        # —— 城墙外到郊野 ——
        _band(earth, sign, WALL_OUTER, S.BANK_OUTER, _ground)

        # —— 桥头引道 ——
        #
        # 桥面在起拱点处高出街面约 0.37m,直接接街面会有一个台阶。
        # 引道是一块**楔形**实体(顶面斜的),用 add_hexa 建,
        # 不能用 add_aabb —— 那会建出一段只有几厘米高的楼梯,
        # 而渲染图上几乎看不出来,只有掠视时才露馅。
        ramp_lo = sign * S.ABUTMENT_FACE
        ramp_hi = sign * (S.ABUTMENT_FACE + RAMP_LEN)
        xa, xb = sorted((ramp_lo, ramp_hi))
        ramp_top = RAMP_TOP + 0.03

        # 断面在 XZ 平面内、沿 Y 恒定,所以直接放样,不拼面片。
        # 断面是闭合四边形:底边 → 靠街的竖直端面 → 斜的顶面 → 靠桥的竖直端面。
        ramp_profile = [
            (xa, -1.0),          # 底,靠桥
            (xb, -1.0),          # 底,靠街
            (xb, 0.0),           # 靠街端落到街面
            (xa, ramp_top),      # 靠桥端抬到桥面标高
        ]
        # ⚠️ 分成两段放样,而不是一段。理由不是几何 —— 一段就够 ——
        #    而是**让道面在 y = 0 处有一条实际的顶点线**。
        #    形制校验要在桥头量道面标高,而一段放样的顶点只落在
        #    y = ±RAMP_HALF_W 两条边上,量到的窗口里一个顶点都没有,
        #    于是量出 0.0000 并报出一个看起来像几何错误、其实是
        #    取样失败的假警报(本项目真的这样误报过一次)。
        road.add_loft(ramp_profile, -RAMP_HALF_W, None, 0.0)
        road.add_loft(ramp_profile, 0.0, None, RAMP_HALF_W)

        # —— 桥头石 ——
        #
        # 桥面板最靠外的一个角在 x ≈ 10.49(桥板是斜置的长方体,
        # 角点被径向偏置推到起拱点之外的 x 上),而引道止于 x = 10。
        # 两者之间有约 0.4m 的水平缝 —— 桥头路面上的一个真洞。
        # 一块条石压上去,既补缝又是宋代桥头常见做法(桥头石/端石)。
        #
        # 它的顶面取 0.42,略高于桥面端顶(0.369)与引道靠桥端(0.399),
        # 于是两端都被它盖住 —— 顺序是"盖住",而不是"接上":
        # 接上是两条边对齐,浮点一抖就露缝;盖住是根本不给缝出现的机会。
        HEADSTONE_TOP = 0.42
        road.add_slab(
            sign * (S.ABUTMENT_FACE - 0.45),
            sign * (S.ABUTMENT_FACE + 0.55),
            -C.Bridge.DECK_WIDTH / 2 + 0.05,
            C.Bridge.DECK_WIDTH / 2 - 0.05,
            lambda x, y: HEADSTONE_TOP,
            thickness=0.72,
        )

        # 引道两侧的缘石:高出道面 0.22m。没有它,引道是一块薄片插在
        # 地上,掠视时会看到一条悬空的边;有了它,桥头才读得出"坡道"。
        def _ramp_z(x: float, y: float, xa=xa, xb=xb) -> float:
            t = min(1.0, max(0.0, (x - xa) / (xb - xa)))
            return ramp_top * (1.0 - t)

        KERB = 0.22
        for y_lo, y_hi in (
            (-RAMP_HALF_W - 0.35, -RAMP_HALF_W),
            (RAMP_HALF_W, RAMP_HALF_W + 0.35),
        ):
            road.add_slab(
                xa, xb, y_lo, y_hi,
                lambda x, y, f=_ramp_z: f(x, y) + KERB,
                thickness=1.2,
            )

    # —— 远景地裙 ——
    # 六块,中间给河道让出一条通廊(|x| < 10 处不铺),
    # 否则会在河面上盖一层土,把水整个蒙住。
    #
    # ⚠️ 通廊的尽头**必须**有东西:河道一直铺到 FAR(见 config.River.LENGTH),
    #    通廊两侧是这两组地裙,合起来盖满 x ∈ [±10, ±300] × y ∈ [±120, ±300]。
    #    缺任何一块都会在下游露出一块虚空。
    WE = S.ABUTMENT_FACE
    for sign in (-1, 1):
        _frame(earth, sign * S.BANK_OUTER, sign * FAR, -FAR, FAR, segs=8)
        for ydir in (-1, 1):
            _frame(
                earth,
                sign * WE, sign * S.BANK_OUTER,
                ydir * S.Y_MAX, ydir * FAR,
                segs=8,
            )

    # —— 生成物体并打标签 ——
    objs: dict[str, bpy.types.Object] = {}

    o = road.build(road_mat, coll)
    if o:
        TU.tag(
            o, "site_road", "terrain",
            label="沿河街道",
            zone="街道",
            lod="mid",
            reflect=False,
            note="街道宽 9m、纤道宽 2.2m,均为功能推定(Reliability C),非原画实测",
        )
        objs["road"] = o

    o = earth.build(earth_mat, coll)
    if o:
        TU.tag(
            o, "site_ground", "terrain",
            label="两岸地坪",
            zone="岸线",
            lod="mid",
            reflect=False,
            note="郊野起伏 ±1.2m 为观感推定(Reliability C);正弦叠加生成以保证跨版本可复现",
        )
        objs["earth"] = o

    # —— 统计 ——
    zones = {
        "水面": (0.0, S.WATER_EDGE),
        "收分驳岸": (S.WATER_EDGE, S.ABUTMENT_FACE),
        "纤道": (S.ABUTMENT_FACE, S.BUND_OUTER),
        "沿河街道": (S.BUND_OUTER, S.STREET_OUTER),
        "市井地坪": (S.STREET_OUTER, S.WALL_INNER),
        "城墙基址": (S.WALL_INNER, WALL_OUTER),
        "郊野": (WALL_OUTER, S.BANK_OUTER),
        "远景地裙": (S.BANK_OUTER, FAR),
    }

    verts = road.stats()["verts"] + earth.stats()["verts"]
    tris = (road.stats()["faces"] + earth.stats()["faces"]) * 2

    return {
        "objects": len(objs),
        "ground_bands": len(zones),
        "y_detailed": f"{S.Y_MIN:.0f} … {S.Y_MAX:.0f}",
        "y_far": f"±{FAR:.0f}",
        "ramp_top": round(RAMP_TOP, 4),
        "gate_offset": S.gate_offset_from_bridge(),
        "verts": verts,
        "tris": tris,
        "_zones": zones,
    }


if __name__ == "__main__":
    stats = build()
    print("=" * 68)
    print("场地布置完成")
    for k, v in stats.items():
        if k.startswith("_"):
            continue
        print(f"  {k:<18} {v}")
    print("  平面分区(米,自河心向外)")
    for name, (a, b) in stats["_zones"].items():
        print(f"    {name:<10} {a:>7.2f} … {b:>7.2f}   宽 {b - a:>6.2f}")
    print("=" * 68)
