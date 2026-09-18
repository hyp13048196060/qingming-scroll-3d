"""
蒙皮人物 —— 街市上那些"在过日子的人"。

为什么人物必须是蒙皮网格,而不是一群"摆好姿势的雕塑"
--------------------------------------------------
    需求里写死了两条:**人物要有真实空间结构**,以及**人物关节要做动画**。
    第二条只有蒙皮能满足。而蒙皮在本项目里有个额外的约束:

        `InstancedMesh` 与 `BatchedMesh` 在 three r186 **都不支持蒙皮**。

    所以每个人物就是一个独立的 `SkinnedMesh`,一个 drawcall。
    这一点直接决定了人数预算(见 docs/05),也决定了这一块不能靠
    "多放几百个小人"来制造市井感 —— 那条路的成本是线性的。

做法:7 个姿态模板,而不是 7 个人
--------------------------------
    这里建的是**模板**,不是具体某个人。每个姿态一具身体,放进
    `scene_characters.glb`;网页侧用 `SkeletonUtils.clone()` 取用,
    克隆时可以改衣色、改朝向、改步速。于是"48 个人物"在网页里是
    48 次 clone,而模型只有 7 具。

    ⚠️ 克隆必须走 `SkeletonUtils.clone()`。直接 `Object3D.clone()`
       会**共享 `Skeleton`** —— 于是街上所有同姿态的人一起抽搐,
       而且看起来像"动画写错了",不像"克隆写错了"。

姿态即 rest pose
---------------
    每个模板的 rest pose 就是它的姿态(挑担的人出生就扛着担)。
    行走的摆动由网页**在这个 rest 之上叠加**,所以 `walk` 模板的
    rest 是"一动不动地站着" —— 否则程序化的摆腿会叠在一个已经
    迈开的姿势上,看起来像扭伤。

    rest pose 与网格出自同一张关节角表,见 `lib/rig_utils.py`。

边界(须同步进 docs/08)
--------------------
· **没有面部。** 头是带收分的方体,没有五官。原画里人的脸只有
  几个像素,任何"复原"都是编的 —— 不拿贴图去遮。
· **硬权重,关节是折角不是弯折。** 手肘、膝盖在近景下能看出折线。
· **衣装不分件。** 不建"上衣+裤子"再拼,直接按穿衣后的轮廓建一具
  身体。所以没有衣褶、没有袖口。
· **衣摆是刚体方框,不是会垂坠的布。** 它从髋往下挂一圈,长短由姿态
  推算(见 `_hem_plan`)。**坐姿的「摊贩」没有衣摆** —— 它大腿离铅垂
  74.5°,几乎水平,任何下挂的衣摆都会被大腿从前脸穿出(实测 −0.275m)。
  真实的衣服是被大腿顶起来堆在腹前的,这里做不到,于是衣身到髋为止。
  这一条是**取舍**,不是疏漏。
· **7 个姿态是本项目从原画中可辨的动作里挑的**,不是清点:
  原画里的人在做什么大体看得见,但"有几个撑船的、几个挑担的"
  数不出来(散点透视 + 尺幅所限)。
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import config as C              # noqa: E402
from lib import bl_utils as BU  # noqa: E402
from lib import rig_utils as RG  # noqa: E402
from lib import tag_utils as TU  # noqa: E402

Ch = C.Character
As = C.Assembly

COLLECTION = "人物模板"

# —— 衣摆 ——
#
# `HEM_H` 是从髋往下挂多长,`HEM_SLACK` 是它的截面比骨盆截面大多少。
#
# 这两个数原先都不是这样给的:长度写死 0.15,截面写死
# `TORSO_W*1.5 × hem_r*2.0`。写死的尺寸**不跟着身体走**,而且那两个数
# 与骨盆截面根本不在同一个口径上 —— 骨盆是 0.238(前后)× 0.342(左右),
# 衣摆是 0.396 × 0.418,**前后比身体宽出 0.158**,渲出来是一块
# "腰上套着的桌子"。紧挨着它的注释还在论证"半径 0.209 装得下摆腿",
# 算的却是左右向;腿是绕 X 轴前后摆的,穿透只可能发生在**前后向**。
#
# 现在尺寸按骨盆截面乘一个服装余量给,余量够不够由 `_measure_hem`
# 从顶点**实测**,不靠这段注释里的算式。
HEM_H = 0.12        # 衣摆从髋往下挂多长(米)
HEM_SLACK = 1.12    # 衣摆截面 = 骨盆截面 × 此值
HEM_MIN = 0.06      # 短于此就不建了 —— 3cm 的裙边只是个毛刺,不如不建


def _hem_plan(bones: dict) -> tuple[float | None, dict]:
    """
    这一具该不该有衣摆、有的话挂多长 —— **由大腿的斜率推,不写死**。

    为什么需要这个判断
    ------------------
    衣摆是一圈**从髋往下挂**的方框,而大腿是从髋关节出发的。两者是否
    打架,取决于大腿**每往前 1m 下坠多少**:

        前进 `hy`(衣摆的半深,0.133m)之后,大腿下坠了 `hy × (az/ay)`。

    这个下坠量若**大于**衣摆长度,大腿就在够到衣摆前脸之前先落到了摆底
    以下 —— 相安无事;若小于,大腿就会**从衣摆前脸里穿出去**。

    实测的两端:
      · `walk`  大腿离铅垂 6.9°,每前进 1m 下坠 8.3m —— 怎么都够用;
      · `vendor` 大腿 **1.30 rad = 74.5°**,几乎水平,每前进 1m 只下坠
        0.28m。衣摆半深 0.133m,于是大腿在髋**同一高度**上就伸出去了
        **0.41m**,而衣摆前脸在 0.133m —— 实测余量 **−0.275m**。
        把衣摆缩到多短都没用:缩到 0,大腿仍压在髋高那一点上。
        **不是衣摆太长,是"下挂的衣摆"这个形状在这条腿的斜率下不成立。**

    所以此处按斜率给长度,算出短于 `HEM_MIN` 就**不建** —— 摆摊那具
    因此没有衣摆,衣身到髋为止。这是**近似**,不是布料模拟:真实情况是
    衣服被大腿顶起来堆在腹前。边界写进 `docs/08`。

    ⚠️ 这只是**推算**,`_measure_hem` 仍会从顶点实测;建了衣摆的每一具
       都必须量出正余量,量出来为负即断言失败。推算与实测是两条路。
    """
    hip = bones["pelvis"][0]
    d, w = _radius("pelvis")
    hy = d * HEM_SLACK * 0.5          # 衣摆的半深(前后向)

    worst_ratio, worst_deg, hem_h = None, 0.0, HEM_H
    for side in ("L", "R"):
        head, tail = bones[f"thigh_{side}"]
        v = Vector(tail) - Vector(head)
        ay, az = abs(v.y), -v.z                 # 前进量 / 下坠量
        # 离铅垂多少度 —— 只用来写进报告,判据用的是斜率
        deg = math.degrees(math.acos(max(-1.0, min(1.0, az / max(v.length, 1e-9)))))
        if deg > worst_deg:
            worst_deg = deg
        if ay < 1e-6:
            continue                            # 腿竖直朝下,不会前穿
        ratio = az / ay                         # 每前进 1m 下坠多少米
        if worst_ratio is None or ratio < worst_ratio:
            worst_ratio = ratio
        # 留 10% 余量:大腿有粗细,盒子的角比轴线更早探出前脸
        hem_h = min(hem_h, hy * ratio * 0.9)

    # ⚠️ 两条腿都竖直朝下时 `worst_ratio` 是 **None**,不能填个大数充数:
    #    原先初值给的是 1e9,`walk` 那一行就报成"每前进 1m 下坠 10 亿米"
    #    —— 一个读的人会当真的假数。竖直腿**没有前进量**,斜率无定义,
    #    正确的报法是 null。
    info = {"thigh_deg": round(worst_deg, 1),
            "drop_per_m": None if worst_ratio is None else round(worst_ratio, 3)}
    if hem_h < HEM_MIN:
        info["skipped"] = (f"大腿离铅垂 {worst_deg:.0f}°、每前进 1m 只下坠 "
                           f"{worst_ratio:.2f}m,衣摆半深 {hy:.3f}m —— "
                           f"推得长度 {hem_h:.3f}m 短于下限 {HEM_MIN}m")
        return None, info
    info["hem_h"] = round(hem_h, 5)
    return hem_h, info


def _radius(bone: str) -> tuple[float, float]:
    """
    这根骨的截面尺寸 `(厚, 宽)`(米)。**按骨名而不是按段长**给 ——
    这是"身体比例"的落点:上臂细于大腿、脖子细于腰,这些正是
    让人在预览图里被读成"人"而不是"衣架"的东西。
    """
    fam = bone.rsplit("_", 1)[0]
    table = {
        # 头:前后比左右**深**。
        #
        # ⚠️ 这一条原先写反了。原值 `(R_HEAD*1.62, R_HEAD*1.90)`,而本函数
        #    的**第一项落在 Y(前后)、第二项落在 X(左右)** —— 这个映射
        #    来自 `_basis`:竖直骨 u=+Z、默认 hint 也退化到 +X 之后,
        #    v = hint×u = −Y、w = u×v = +X;而 `add_box` 的 depth 沿 v、
        #    width 沿 w。头又是用同样的 (d, w) 交给 `add_box3` 的,
        #    所以两处一致。
        #
        #    照原值建出来是 **0.159 深 × 0.186 宽** —— 一个比左右还扁的
        #    方盒,正面看几乎与肩同宽,3/4 近景里一眼就是个"箱子"。
        #    真人头约 0.155 宽 × 0.195 深,按此取 1.58 / 2.00。
        "head": (Ch.R_HEAD * 2.00, Ch.R_HEAD * 1.58),
        # 脖子:0.088 的方料太细,头与肩之间会露出一道豁口。
        # 真人颈围换算直径约 0.11。
        "neck": (Ch.R_NECK * 2.15, Ch.R_NECK * 2.15),
        "chest": (Ch.TORSO_W, Ch.TORSO_D),
        "spine": (Ch.TORSO_W * 0.96, Ch.TORSO_D * 0.94),
        "pelvis": (Ch.TORSO_W * 0.90, Ch.TORSO_D * 0.98),
        "shoulder": (Ch.R_ARM * 1.6, Ch.R_ARM * 1.8),
        "upperarm": (Ch.R_ARM * 1.85, Ch.R_ARM * 1.85),
        "forearm": (Ch.R_ARM * 1.70, Ch.R_ARM * 1.70),
        "hand": (Ch.R_ARM * 1.35, Ch.R_ARM * 1.9),
        "thigh": (Ch.R_LEG * 1.55, Ch.R_LEG * 1.42),
        "shin": (Ch.R_LEG * 1.26, Ch.R_LEG * 1.22),
        "foot": (Ch.R_LEG * 1.20, Ch.R_LEG * 1.34),
    }
    if fam not in table:
        raise KeyError(f"骨 {bone!r} 没有截面尺寸 —— 补进 _radius 的表里")
    return table[fam]


def _seg(
    b: BU.MeshBuilder,
    ranges: dict[str, tuple[int, int]],
    bone: str,
    a: Vector,
    bb: Vector,
    scale: float = 1.0,
    hint: Vector | None = None,
) -> None:
    """
    在 `a→bb` 之间放一段"肉",并把它记进 `bone` 的顶点区间。

    ⚠️ 顶点区间**必须在这里顺手记**,不能事后按距离去猜谁属于哪根骨 ——
       事后猜的那套(最近骨、热扩散)在有衣摆、有交叉手臂的姿态上会
       把大腿的顶点评给小臂,而它**不会报错**,只是弯手的时候腿动一下。
       这段几何是谁建的,建的时候就最清楚。

    ⚠️ 同一根骨的各段**必须连着建**。这里原先允许"再见到同一根骨就
       `min/max` 扩区间",衣摆挂在 `pelvis` 上、又建在**最后**,于是
       `ranges["pelvis"]` 从 `(0, 8)` 被撑成 `(0, 168)` —— 一个**包住
       全身**的区间。`skin()` 按 (首,末) 取点、又是先到先得,
       `pelvis` 正好排在最前,就一口吞掉了全部 168 个顶点。
       实测产物:`{"pelvis": 168}`,其余 18 个组全空 —— 而统计量报的是
       `groups=19 / skinned=168 / nov=[prop_R, root]`,**和绑对了时一模一样**。
       所以不连续不是"能用就行",是必须当场拒绝:它没有别的正确读法。
    """
    d, w = _radius(bone)
    lo = len(b.verts)
    b.add_box(a, bb, d * scale, w * scale, hint=hint)
    hi = len(b.verts)
    if hi <= lo:
        return
    old = ranges.get(bone)
    if old is None:
        ranges[bone] = (lo, hi)
    elif lo == old[1]:
        ranges[bone] = (old[0], hi)      # 紧接上一段,可并
    else:
        raise ValueError(
            f"骨 {bone!r} 的第二段几何与第一段**不连续**:"
            f"已有区间 {old},新段 ({lo}, {hi}),"
            f"中间隔着 {lo - old[1]} 个属于别的骨的顶点。"
            f"把同一根骨的各段连着建,别让别的东西插在中间 —— "
            f"不连续就只能靠 min/max 撑成一个包住中间全部顶点的大区间,"
            f"而那根骨会因此抢走别人的顶点,并且**不报错**。"
        )


def _hem(
    b: BU.MeshBuilder,
    ranges: dict[str, tuple[int, int]],
    hip: Vector,
    hem_h: float,
) -> None:
    """
    衣摆:从髋往下挂 `hem_h` 的一圈,挂在 `pelvis` 上。

    走 `_seg` / `add_box` 而不是 `add_box3`:截面的朝向由 `_basis` 从骨轴
    算出来,与它上面那段骨盆**共用同一组正交基**,于是衣摆和身体一定同心。
    手写三个轴就又多了一处"我以为 v 落在 Y"的机会 —— 而本项目已经在
    `add_box` / `add_torus` 的 v/w 互为镜像这件事上栽过一次,那次还把
    错的结论写进了注释。
    """
    _seg(b, ranges, "pelvis", hip,
         Vector((hip.x, hip.y, hip.z - hem_h)), scale=HEM_SLACK)


def _measure_hem(
    b: BU.MeshBuilder,
    ranges: dict[str, tuple[int, int]],
    hip: Vector,
    hem_h: float,
) -> dict:
    """
    量衣摆到底有没有把腿包住 —— **不推,量**。

    推的版本已经错过一次(见 `HEM_H` 上那段),而且错在"算的是左右向,
    而腿是绕 X 轴前后摆的,穿透只可能发生在**前后向**"。这里取髋以下
    那一段里所有腿的顶点,与衣摆盒子的四个面比,给出前后 / 左右两个
    方向上的**最小余量**。余量为负 = 腿从衣摆里穿出来了。

    ⚠️ 这里由"报告"改成了**断言**。原先余量为负只记进 `docs/08` 就算
       过关,于是 `vendor` 那 −0.275m 一直躺在统计里没人管 —— 而它渲出来
       是"腰上套了个桶"。现在:**建了衣摆的具,余量必须为正**,否则当场
       失败。不该有衣摆的姿态由 `_hem_plan` 明说,不走这条路径 ——
       "没建"与"建了但没量到"是两件事,后者是量具失准,仍要报错。
    """
    z_hi, z_lo = hip.z, hip.z - hem_h
    d, w = _radius("pelvis")
    hy, hx = d * HEM_SLACK * 0.5, w * HEM_SLACK * 0.5
    clear_y, clear_x, n = 1e9, 1e9, 0
    for bone, (lo, hi) in ranges.items():
        if not bone.startswith(("thigh_", "shin_", "foot_")):
            continue
        for i in range(lo, hi):
            x, y, z = b.verts[i]
            if not (z_lo - 1e-9 <= z <= z_hi + 1e-9):
                continue
            n += 1
            clear_y = min(clear_y, hy - abs(y - hip.y))
            clear_x = min(clear_x, hx - abs(x - hip.x))
    if n == 0:
        raise AssertionError(
            "髋下这一小段里一个腿的顶点都没有 —— 那是**量具没对准被量的"
            "东西**,不是「衣摆包得很好」。检查 HEM_H 与腿骨的竖向跨度。"
        )
    if clear_y < 0.0:
        raise AssertionError(
            f"衣摆长 {hem_h:.3f}m,而腿的顶点从摆里探出 {abs(clear_y):.4f}m"
            f"(前后向,量了 {n} 个点)。`_hem_plan` 的推算与实测不符 —— "
            f"要么大腿的斜率算错了,要么 `HEM_SLACK` 给的半深不够。"
            f"不要靠调小衣摆来蒙混:先核 `_hem_plan` 的 `drop_per_m`。"
        )
    return {
        "n": n,
        "hem_h": round(hem_h, 5),
        "clear_y": round(clear_y, 5),
        "clear_x": round(clear_x, 5),
    }


def build_figure(pose_name: str, robe: tuple[float, float, float]) -> tuple:
    """
    建一具身体。返回 `(mesh_obj, arm_obj, tris)`。

    流程:**先算骨 → 再照骨放肉 → 再蒙皮**。三步共用一个 `bones` 字典。
    """
    bones = RG.fk(Ch.POSES[pose_name])
    b = BU.MeshBuilder(f"char_{pose_name}")
    ranges: dict[str, tuple[int, int]] = {}

    # —— 躯干:脊柱链逐段放肉 ——
    #
    # ⚠️ 骨盆与衣摆**连着建**,不能把衣摆挪到末尾 —— 同属 `pelvis` 的
    #    两段一旦被头、四肢隔开,区间就不连续了(见 `_seg` 的断言)。
    hip = bones["pelvis"][0]
    hem_h, hem_info = _hem_plan(bones)
    _seg(b, ranges, "pelvis", *bones["pelvis"])
    if hem_h is not None:
        _hem(b, ranges, hip, hem_h)
    for bone in ("spine", "chest", "neck"):
        _seg(b, ranges, bone, *bones[bone])

    # —— 头:带收分的方体,没有五官(见模块 docstring 的边界声明)——
    hh, ht = bones["head"]
    center = (Vector(hh) + Vector(ht)) * 0.5
    d, w = _radius("head")
    lo = len(b.verts)
    # 脸朝 +Y(与 foot 的脚尖同向)。收分:颅顶比下颌窄 12%。
    b.add_box3(center, Vector((0.0, 0.0, 1.0)), Vector((0.0, 1.0, 0.0)),
               Vector((1.0, 0.0, 0.0)), (ht - hh).length, d, w)
    # 顶面收一点 —— 用一小段"帽"表示颅顶,免得读成方块
    b.add_box3(Vector(ht) - Vector((0.0, 0.0, d * 0.16)),
               Vector((0.0, 0.0, 1.0)), Vector((0.0, 1.0, 0.0)),
               Vector((1.0, 0.0, 0.0)), d * 0.32, d * 0.86, w * 0.86)
    hi = len(b.verts)
    if hi > lo:
        ranges["head"] = (lo, hi)

    # —— 四肢 ——
    for side in ("L", "R"):
        for bone in (f"shoulder_{side}", f"upperarm_{side}",
                     f"forearm_{side}", f"hand_{side}",
                     f"thigh_{side}", f"shin_{side}", f"foot_{side}"):
            h, t = bones[bone]
            _seg(b, ranges, bone, h, t)

    # "没建衣摆"与"建了但没量到"是两件事,分开走。
    if hem_h is not None:
        hem = _measure_hem(b, ranges, hip, hem_h)
    else:
        hem = dict(hem_info)
    hem.update({k: v for k, v in hem_info.items() if k not in hem})

    mat = _robe_material(pose_name, robe)
    coll = BU.get_collection(COLLECTION)
    obj = b.build(material=mat, collection=coll)
    if obj is None:
        raise RuntimeError(f"{pose_name}:网格为空 —— 关节角表或 REST 有问题")
    st = b.stats()

    arm = RG.make_armature(f"char_{pose_name}", bones, coll)
    RG.skin(obj, arm, ranges)

    # ⚠️ `qm_anim` **逐姿态取**,不是一律 "walk"。
    #    原先是七具全写 "walk" —— 那等于告诉网页"这七个人都会走",
    #    而 `punt`(撑船)与 `vendor`(摆摊)本来就该站定(POSE_SPEC 速度 0)。
    #    网页的分发器只认这一个字段,于是撑船的人会被驱动着在甲板上原地迈步。
    #    一个姿态的标签写错,影响的是**那一个姿态的全部实例**;而 48 个实例
    #    里只有几个是撑船的,图上扫一眼看不出来。
    #    真值源是 `Assembly.POSE_SPEC` —— 不在这里另写一套判断。
    anim = "walk" if As.POSE_SPEC[pose_name]["speed"] > 0 else "none"

    TU.tag(
        obj, f"char_{pose_name}", "character",
        label=Ch.POSE_LABEL[pose_name], anim=anim, dynamic=True,
        lod="near", zone="人物",
        note="蒙皮模板;网页用 SkeletonUtils.clone() 取用",
        pose=pose_name, bones=len(Ch.DEFORM_BONES),
    )
    TU.tag(arm, f"char_{pose_name}_rig", "character",
           label=f"{Ch.POSE_LABEL[pose_name]}(骨架)", anim=anim, dynamic=True,
           lod="far", zone="人物", reflect=False,
           note="骨架节点;不参与渲染,只承载蒙皮")
    return obj, arm, st["tris"], hem


def _robe_material(pose_name: str, robe: tuple[float, float, float]):
    """
    每个姿态一款衣色。**不贴图** —— 见 `config.Texture.MATERIAL`:
    `cloth_dim` 是给幌子/篷布用的,人物衣料是小面积近中景,
    上贴图只会让 7 具身体多出 7 组 UV 与 7 张图的采样成本,
    而肉眼看不出差别。
    """
    lib = BU.MaterialLibrary()
    return lib.get(f"robe_{pose_name}", robe, roughness=0.92)


def build() -> dict:
    BU.clear_scene_once()
    Ch.check_tables()
    BU.get_collection(COLLECTION)

    objs, rigs, tris = [], [], 0
    per_pose: dict[str, dict] = {}
    # ⚠️ 遍历 `POSES`,另两张表按**姿态名**取 —— 不用 `zip` 并列。
    #    并列写法下三张表长度不等会静默截断(POSES 7 项 × ROBES 6 项),
    #    少掉的那个人不报错、不改任何统计量的分母。见 config 里那张表的注释。
    for pose_name in Ch.POSES:
        obj, arm, t, hem = build_figure(pose_name, Ch.ROBES[pose_name])
        objs.append(obj)
        rigs.append(arm)
        tris += t

        # —— 蒙皮对账:数**每个组里的点数**,不数"有没有这个组" ——
        #
        # ⚠️ 这一段原先报的 `bones_without_verts` 判据是
        #    `vertex_groups.get(name) is None`,而 `skin()` 当时**在判定
        #    区间为空之前就把组建了出来** —— 空组和满组在它眼里一模一样。
        #    实测到过的产物:
        #
        #        19 个组,其中 18 个空,`pelvis` 一个组装着全部 168 个顶点
        #        报出来 groups=19 / skinned=168 / nov=[prop_R, root]
        #
        #    —— 与绑对了时的数**逐个相同**,连 `land_residual` 都是 0。
        #    整具身体只跟着骨盆动;它看着仍像个人,因为 rest pose 是烤在
        #    网格坐标里的。
        #
        #    修的是两处上游(`_seg` 拒绝不连续区间、`skin` 拒绝空区间且
        #    建组放在判定之后)。这里留下的是**证据**:逐组点数 + 总数与
        #    顶点数对账,两个数来自不同路径。
        per_group = {vg.name: 0 for vg in obj.vertex_groups}
        for v in obj.data.vertices:
            for g in v.groups:
                per_group[obj.vertex_groups[g.group].name] += 1

        empty = sorted(n for n, c in per_group.items() if c == 0)
        if empty:
            raise AssertionError(
                f"{pose_name}:顶点组 {empty} 里一个点都没有 —— 有组无肉。"
                f"这些骨在网页里带不动任何东西,而按「有没有这个组」判据"
                f"是看不出来的。"
            )
        skinned = sum(per_group.values())
        if skinned != len(obj.data.vertices):
            raise AssertionError(
                f"{pose_name}:蒙皮点数 {skinned} ≠ 顶点数 "
                f"{len(obj.data.vertices)} —— 有顶点被重复绑或漏绑。"
            )

        # 无顶点的骨应当**恰好**是 root 与 prop_R。多一个就是漏绑。
        #   · `root`    —— 纯变换根,全身上下没有一块肉属于它;
        #   · `prop_R`  —— 挂点插座,存在的意义是"让扁担有个跟随的父级",
        #                  道具是刚体,不该跟着手掌的肉变形。
        # 这个判据在 `skin()` 不再预建空组之后才**真的**成立。
        no_verts = sorted(
            b.name for b in arm.data.bones
            if obj.vertex_groups.get(b.name) is None
        )
        per_pose[pose_name] = {
            "tris": t,
            "verts": len(obj.data.vertices),
            "groups": len(obj.vertex_groups),
            "bones": len(arm.data.bones),
            "bones_without_verts": no_verts,
            "skinned": skinned,
            "min_group": min(per_group.values()),
            "hem": hem,
        }

    # —— 落地:每具身体的最低点必须贴在 z=0 ——
    #
    # ⚠️ 用**网格包围盒的最低点**对齐,不用脚骨位置。蹲姿(`vendor`)里
    #    小腿后折会把脚骨拉到髋下方,照脚骨摆位会把人埋进地里 ——
    #    而"埋进去"比"悬空"更难发现,因为地面会挡住。
    #
    # ⚠️ 抬的是**骨架**,不是网格。网格已经父级到骨架上了,只挪网格
    #    等于在绑定关系之外又叠了一层位移 —— 网页里 `SkeletonUtils.clone()`
    #    会带出这层位移,而它看着只是"这个人浮起来了一点",很难归因。
    #    抬骨架,网格跟着走,绑定不变。
    bpy.context.view_layer.update()
    landed = []
    for arm, obj in zip(rigs, objs):
        lo = min((obj.matrix_world @ Vector(c)).z for c in obj.bound_box)
        arm.location.z -= lo
        landed.append(round(-lo, 6))
    bpy.context.view_layer.update()

    # 落完之后复量一次。**不复量就等于没量** —— 上面那行改的是骨架,
    # 而读数是改之前从网格取的;中间隔着"父级传递"这一层,正是本项目
    # 反复栽过的那种"两端不同口径"。
    residual = []
    for obj in objs:
        lo = min((obj.matrix_world @ Vector(c)).z for c in obj.bound_box)
        residual.append(round(lo, 9))
    if any(abs(r) > 1e-6 for r in residual):
        raise AssertionError(
            f"人物落地后脚底仍未贴 z=0:残差 {residual}。"
            f"抬骨架没有传到网格上 —— 检查蒙皮时的父子关系。"
        )

    return {
        "objects": len(objs) + len(rigs),
        "templates": len(objs),
        "rigs": len(rigs),
        "tris": tris,
        "deform_bones": len(Ch.DEFORM_BONES),
        "attach_bones": len(Ch.ATTACH_BONES),
        # 无顶点的骨应当**恰好**是 root 与 prop_R。多一个就是漏绑。
        "bones_without_verts": sorted({
            b for p in per_pose.values() for b in p["bones_without_verts"]
        }),
        "poses": list(Ch.POSES),
        "per_pose": per_pose,
        "land_shift": landed,
        "land_residual_max": max(abs(r) for r in residual),
        # —— 下面两个是**会说话的**汇总值,单拎出来放顶层 ——
        #
        # `min_group_verts` 是那个曾经能一眼看穿事故的数:被 `pelvis`
        # 吞掉全身时它是 0(18 个空组),正常时是每根骨最小的那段
        # (8 —— 每段方料 8 个顶点)。放在顶层,是因为它比 per_pose
        # 里那一堆数更早被人看见。
        "min_group_verts": min(p["min_group"] for p in per_pose.values()),
        # 衣摆前后向的最小余量(米)。建了衣摆的具**必须为正**
        # (`_measure_hem` 已断言),这里只报数。
        #
        # ⚠️ 没有衣摆的姿态报 **null**,不报 0 —— 0 会被读成"刚好贴上",
        #    而实情是"这一具根本没有衣摆"。`vendor` 就是 null:
        #    它大腿离铅垂 74.5°,下挂的衣摆这个形状在它身上不成立,
        #    由 `_hem_plan` 判定不建。缺值与零值在读的人眼里是两回事。
        "hem_clear_y": {p: per_pose[p]["hem"].get("clear_y") for p in per_pose},
        # 各姿态的大腿倾角与推算长度 —— 为什么某具没有衣摆,看这里。
        "hem_plan": {
            p: {k: v for k, v in per_pose[p]["hem"].items()
                if k in ("hem_h", "thigh_deg", "drop_per_m", "skipped")}
            for p in per_pose
        },
    }


if __name__ == "__main__":
    from lib import bl_utils as _BU

    _BU.reset_clear_flag()
    if "--alone" in sys.argv:
        from lib import modules as _MOD

        _MOD.load_build("00_layout").build()

    r = dict(build())
    print("=" * 68)
    print("人物模板构建完成")
    print(json.dumps(r, ensure_ascii=False, indent=2))
    print("=" * 68)
