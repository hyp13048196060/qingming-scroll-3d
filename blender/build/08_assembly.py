"""
装配 —— 随身器物与 48 个实例的分布。

**这一层不建身体。** 身体是 `07_characters` 按姿态烤好的 7 具模板,
网页用 `SkeletonUtils.clone()` 复制成 48 个实例。这里做两件事:

    ① **随身器物** —— 扁担(挑担)、撑篙(撑船),蒙皮到骨上;
    ② **分布** —— 48 个人的姿态、位置、朝向、速度,写进
       `src/data/actors.json`,外加一组仅供预览的标位柱。

═══════════════════════════════════════════════════════════════════════════
三条必须写在最前面的判断
═══════════════════════════════════════════════════════════════════════════

**一、随身器物的位置是「量」出来的,不是「定」出来的。**

    扁担压在左肩上、穿左手的握点;撑篙挂在右手挂点骨的头的位置;
    独轮车的柄末端落在推车人两手之间。这三条约束的**目标值全在别处**:
    肩与手来自 `lib/rig_utils` 的骨骼表,车把来自 `06_props._barrow` 的
    几何。所以本模块的做法是:调 `RG.fk()` 算出骨头 → 从骨头取点 →
    连成轴线 → 建几何 → **回读复核**。

    本项目在这一点上栽过两次(见 Memory:量具/量纲/取景框):
      · 34 个关节角符号整体反了,手臂长在肩后;
      · 解推车姿态时把「相对父骨的角」当成了「世界角」,差 60mm。
    两次都是「我算过了」,两次都不是证据。**回读才是证据。**

**二、器物要跟着骨架的落地偏移走 —— 而这件事与直觉相反,已实测。**

    `07` 建身体的顺序是「先蒙皮、后抬骨架」,`08` 建器物的顺序必然是
    「先抬骨架、后蒙皮」(骨架早就抬好了)。这两个顺序**不等价**。
    实测(骨架下移 0.5m,观察一个 z=1.0 的点):

        先蒙皮后抬骨架:顶点落在 z = 0.5    —— 跟着走了
        先抬骨架后蒙皮:顶点落在 z = 1.0    —— 没跟着走

    原因是 `skin()` 取的是 `arm.matrix_world.inverted()`,而这个矩阵
    在前一种顺序里取于骨架移动**之前**(= I),在后一种里取于**之后**
    (= T(+0.5)),正好把那次移动抵消掉。源码上那一行对两种情形长得
    一模一样,所以**读代码推不出来**,只能量。

    ⚠️ 我在上一轮读源码后曾推出「不需要补偿」并写下了相反结论 ——
       推导不是证据。真实落差不小:`punt` 姿态落地偏移 −13.0mm、
       `carry` −5.9mm(`RG.pose_landing` 实测)。

    所以 `_land_with_body()` 把器物显式对齐到骨架的世界矩阵,再**回读**
    世界坐标与身体比对 —— 不靠「我补过了」。

    (骨绑在哪根骨上只写在 `qm_note` 里,没有为它加 `qm_bone` 标签键:
     按本项目的规矩,**能从几何反推的事不写声明** —— 顶点组里就写着
     绑在哪根骨上,再声明一遍只会多一处会过期的地方。)

**三、卡壳检测查的是「边横穿面」,不是包围盒,不是「距离很小」,也不是「顶点带符号距离」。**

    四次修订,前三次都错在**量具上**,而每一次都是读数先露的马脚:

      一版 · 包围盒。挡不住「篮子伸进衣摆里」—— 衣摆的盒子本来就大。

      二版 · 对所有顶点取 `closest_point_on_mesh()` 的带符号距离,不设限。
             当场报出两个「深达 441.6mm」的穿模点,而那两个点的最近面在
             420–630mm 之外 —— 躯干前后总厚才 0.264m,哪来的 441mm。
             真因是**身体是一堆互相重叠的封闭体**(躯干一个盒、四肢各一段
             圆柱、衣摆一个盒):离得远的点,「最近面」可能是某个构件**藏在
             内里的那一面**。法线判据在近处可靠,在远处不可靠。

      三版 · 顶点带符号距离 + 80mm 带宽。当时以为「真正的相交必然在带里
             留下痕迹,所以完备」—— **这个论证是错的**,而错处正好落在本轮
             要查的东西上:那根扁担是 `add_cylinder(p_back, p_front, 8)`,
             **1.8 米的杆上只有两端两圈顶点**,杆身与肩接触的那一段中间
            一个顶点也没有。杆要是横穿肩,三版查不出来。

     ⚠️ 马脚正是本轮那句「与身体最近 191.8mm」:扁担压在肩上,怎么会离
        身体 19 厘米?把最近点一并打印出来才看见 —— 最近处落在**胯高
        0.86m**,压根不在肩高 1.41m。数是对的,只是它答的是「顶点最近
        多少」,不是「杆最近多少」。**量具答非所问时,读数照样一本正经。**

    四版(本版)分两步,一步都不依赖采样密度:

      · **相交** —— 查「器物的某条边横着穿过身体的某个面」。两片封闭
        曲面相交,必有一方的边穿过另一方的面;这是**拓扑事实**,不是
        采样假设。用 `Object.ray_cast(起点, 方向, 长度)` 逐边查,并要求
        边与命中面**横穿**(`|d̂·n̂| > TRANSVERSAL`):贴着面走的不算 ——
        扁担搁在肩上本来就该贴着,那是正常姿态,不是事故。
      · **前提** —— 边横穿只覆盖「边界相交」,不覆盖「整只埋在里面」
        (整个埋着的篮子,边一条也不穿面)。这一条不靠判据补,靠**前提
        排除**:先断言器物的包围盒**不**被身体包围盒包含 —— 整体包含
        蕴含包围盒包含,所以逆否一下,前提成立则整体包含不可能。前提
        不成立就直接抛错,而不是给一个「查不出来也照样报绿」的判据。

      · **读数** —— 沿器物的**边**按 `SAMPLE_STEP` 采样,报最小距离。
        沿边而不是沿顶点:扁担那种粗圆柱,顶点间距以米计,不沿边采样
        就还是 191.8mm 那个答非所问的数。
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import bpy
import numpy as np
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import config as C              # noqa: E402
from lib import bl_utils as BU  # noqa: E402
from lib import modules as MOD  # noqa: E402
from lib import rig_utils as RG  # noqa: E402
from lib import tag_utils as TU  # noqa: E402

As = C.Assembly
Ch = C.Character
Pr = C.Prop
Pal = C.Palette

# 集合名。与 07 / 06 用的**逐字一致** —— `_upstream()` 会当场核对,
# 不靠人记得。本项目栽过:04 建 `buildings`、分块表写 `建筑群`,
# `scene_props.glb` 整块从未产出,而每处单独看都像那么回事。
CHAR_COLL = "人物模板"
PROP_COLL = "道具"
MARK_COLL = "人物标位"

PROJECT_DIR = Path(__file__).resolve().parents[2]
OUT_JSON = PROJECT_DIR / "src" / "data" / "actors.json"
SEED = C.SEED + 80

DOWN = Vector((0.0, 0.0, -1.0))

# 器物与身体的位置关系容差。0 = 刚好贴上,允许贴(扁担本来就压在肩上、
# 手本来就握着杆)。**只有穿进去才算失败** —— 判「离得多近就报警」会把
# 一个正常的姿态判成事故,而那种断言最后总是被调松到失去意义。
CLASH_EPS = -1e-4

# 判「边与面横穿」的正弦下限。取 |d̂·n̂|:边与面法线同向时最大(正着扎
# 进去),边躺在面里时最小(贴着走)。0.15 折合夹角约 8.6°。
#
# 为什么要这一条:扁担**本来就搁在肩上**,两者表面可以贴得极近甚至相切。
# 没有它,`ray_cast` 一碰到相切就算命中,正常姿态会被判成穿模 —— 而这类
# 假警报最后总是被人把阈值调松到失去意义。贴着走(d̂·n̂≈0)与扎进去
# (d̂·n̂≈±1)在几何上本来就是两回事,这里只是把它写出来。
TRANSVERSAL = 0.15

# 沿器物边的采样步长(m),用来报「最近多少」。取 30mm:比杆径(34mm)略小,
# 所以杆身落在肩上的那一段不会被跨过去;又比顶点密得多。报出来的数带
# 「采样」二字,不留「这是精确距离」的错觉。
SAMPLE_STEP = 0.030

# 每个坑位的采样尝试次数。试满就**记一次「没放下」**,不静默跳过 ——
# 「要放 48 个、实际放下 45 个」必须能从 json 里读出来。
TRIES = 40

MARK_H, MARK_R = 1.45, 0.055



# --------------------------------------------------------------------------
# 上游接口
# --------------------------------------------------------------------------


def _upstream() -> tuple[object, object]:
    """取上游两个模块的**真值**,而不是把它们的常数抄一遍。"""
    chars = MOD.load_build("07_characters")
    props = MOD.load_build("06_props")
    if chars.COLLECTION != CHAR_COLL:
        raise AssertionError(
            f"07_characters 的集合是 {chars.COLLECTION!r},本模块写的是 "
            f"{CHAR_COLL!r} —— 随身器物会挂到人物模板之外,"
            f"scene_characters.glb 里不会有扁担和篙。"
        )
    return chars, props


def _template(pose: str) -> tuple[bpy.types.Object, bpy.types.Object]:
    """
    按**标签**找姿态模板,返回 `(身体网格, 骨架)`。

    ⚠️ 不按物体名找。`07` 现在把网格叫 `char_<pose>`、骨架叫
       `char_<pose>_rig`,而那是 `MeshBuilder` 与 `make_armature` 的
       内部命名 —— 不是接口。接口是 `qm_pose` 与 `qm_kind`:网页侧读的
       就是它们。按名字找等于把命名约定升格成契约,改个名字就静默失效。
    """
    for o in bpy.data.objects:
        if (o.type == "MESH" and o.get("qm_kind") == "character"
                and o.get("qm_pose") == pose):
            arm = o.parent
            if arm is None or arm.type != "ARMATURE":
                raise RuntimeError(
                    f"{pose} 的模板 {o.name!r} 没有父级骨架 —— "
                    f"`RG.skin()` 没跑或被撤销了"
                )
            return o, arm
    have = sorted(str(x.get("qm_pose")) for x in bpy.data.objects if x.get("qm_pose"))
    raise RuntimeError(f"找不到姿态 {pose!r} 的模板。场景里有的:{have}")


# --------------------------------------------------------------------------
# 几何小工具
# --------------------------------------------------------------------------


def _seg_dist(p0: Vector, p1: Vector, q: Vector) -> float:
    """点 `q` 到线段 `p0→p1` 的距离。回读「器物轴有没有穿过握点」。"""
    d = p1 - p0
    l2 = d.dot(d)
    if l2 < 1e-12:
        return (q - p0).length
    t = max(0.0, min(1.0, (q - p0).dot(d) / l2))
    return (q - (p0 + d * t)).length


def _probe_meshes(acc: bpy.types.Object, body: bpy.types.Object,
                  exempt: frozenset[str] = frozenset(),
                  watch: tuple[tuple[str, Vector, float], ...] = (),
                  step: float = SAMPLE_STEP,
                  worst: int = 6) -> tuple[float, str, list[str], int, dict]:
    """
    量器物与身体的关系,返回
    `(最近采样距离, 最近处在哪, 相交明细, 豁免的握持接触数, 关注区读数)`。

    **判失败只能看明细的长度**,而明细非空 ⟺ 查出了横穿。前提与判据的
    完整论证写在模块 docstring 第三节,这里只重复三条最容易再犯的:

    ⚠️ `exempt` 是被**握着**的那只手的顶点组名,不是「容差」。取名而不是
       定半径,是因为半径是人挑的、而且挑完就没人再看;顶点组是 `skin()`
       写下的、和骨架一字不差。**手是一个实心盒**,没有拳眼,所以「握杆」
       这件事在网格上**必然**是杆穿过手 —— 这是建模约定,查它毫无意义。
       豁免之外的身体部分一律照查。豁免的代价说清楚:杆在手里**怎么摆**
       这一处查不出来 —— 它由另一条断言管(轴线必须穿过实测握点,现为
       0.000mm),两条合起来才是完整的。

    ⚠️ 读数要沿**边**采样,不能只取顶点。**这是本轮才发现的坑**:扁担是
       `add_cylinder(a, b, 8)` 建的,1.8 米的杆上只有两端两圈顶点 ——
       顶点最近距离报 191.8mm,而杆身其实就搁在肩上。数没错,是它答的
       问题不对(「顶点最近多少」而不是「杆最近多少」)。

    ⚠️ `watch` 是「**关注区**」:给出若干 `(名字, 球心, 半径)`,分别报
       落在球内的采样点到身体的最小距离。为什么要它:全局最近距离只有
       一个,而**它答的位置未必是你关心的那一处**。扁担的全局最近在手上
       (0.0mm,握着),于是「担子到底搁稳在肩上了没有」这个问题,
       全局最小值一个字也答不上来 —— 它俩不是同一个问题。所以
       「担身搁肩」这句写在代码注释里的话,得有一条**指名道姓**的读数
       给它撑腰,而不是拿一个总的最小值去顶。

    ⚠️ 两侧都在**建模坐标系**里:身体的网格数据就是建模系(落地偏移
       存在物体的变换上,不在网格里),器物的网格数据也是 —— 建的时候
       就落在建模系。`closest_point_on_mesh()` / `ray_cast()` 收物体的
       局部坐标,所以直接喂建模系的点是对的,不需要再过一次
       `matrix_world`。

    ⚠️ `ray_cast()` 不传 `depsgraph` 时用的是**原始网格数据**,不含修改器。
       身体的修改器是 `ARMATURE`,而骨架就在静止姿态、姿态又已经烘进
       网格里,所以两者一致。这一条要成立,依赖的是「07 把姿态烘进网格」
       这件事 —— 哪天 07 改成用修改器摆姿态,这里就量错了。
    """
    # —— 前提:器物不可能被身体整个包住 ——
    # 边横穿查的是「边界相交」,查不出「整只埋在里面」(埋着的东西一条边
    # 也不穿面)。这里不硬补一条查包含的判据,而是把那种情形**排除掉**:
    # 整体包含必然蕴含包围盒包含,所以只要器物的包围盒在某一轴上比身体
    # 的包围盒还长,整体包含就不可能。前提不成立就抛错 —— 而不是给一个
    # 「查不出来也照样报绿」的判据。
    a_lo, a_hi = _bbox(acc)
    b_lo, b_hi = _bbox(body)
    slack = [(a_hi[i] - a_lo[i]) - (b_hi[i] - b_lo[i]) for i in range(3)]
    if max(slack) <= 0.0:
        raise AssertionError(
            f"{acc.name} 的包围盒 {[round(a_hi[i] - a_lo[i], 3) for i in range(3)]} "
            f"每一轴都不超过身体 {body.name} "
            f"{[round(b_hi[i] - b_lo[i], 3) for i in range(3)]} —— "
            f"「整个埋进身体里」这种情形排除不掉,那么下面这套只查边界横穿的"
            f"判据就**不完备**,不能再报绿。要么换一件器物,要么补一条查包含的判据。"
        )

    # —— 读数:沿边采样,取最近 ——
    near_min = float("inf")
    near_where = ""
    seen: dict[str, float] = {}
    for a, b in _edges(acc):
        d = b - a
        span = d.length
        if span < 1e-9:
            continue
        steps = max(1, int(math.ceil(span / step)))
        for i in range(steps + 1):
            p = a + d * (i / steps)
            ok = body.closest_point_on_mesh(p)
            if not ok[0]:
                continue
            q = Vector(ok[1])
            near = (p - q).length
            for name, center, radius in watch:
                if (p - center).length <= radius:
                    seen[name] = min(seen.get(name, float("inf")), near)
            if near < near_min:
                near_min = near
                near_where = f"边 {_fmt(a)}→{_fmt(b)} 上 p={_fmt(p)} → q={_fmt(q)}"

    # —— 判据:查边横穿面 ——
    vgroup = _vertex_groups(body)
    viol: list[tuple[float, str]] = []
    held = 0
    for a, b in _edges(acc):
        d = b - a
        span = d.length
        if span < 1e-9:
            continue
        dh = d / span
        # ⚠️ `distance` 必须是关键字参数 —— 位置传参会报
        #    "required parameter distance to be a keyword argument"。
        hit, loc, nrm, idx = body.ray_cast(a, dh, distance=span)
        if not hit:
            continue
        loc = Vector(loc)
        t = (loc - a).length
        # 命中点落在边**内部**才算穿过去;落在起点/终点上的是「端点恰好
        # 贴在面上」,那是正常姿态(手握杆、担压肩),不是穿模。
        if not (1e-6 < t < span - 1e-6):
            continue
        n = Vector(nrm).normalized()
        cos = abs(dh.dot(n))
        if cos <= TRANSVERSAL:
            continue    # 边贴着面走,不相交

        # 命中的是哪一根骨的辖地?手是实心盒,握着的东西必然穿过它 ——
        # 这一处按约定豁免,但要**数出来报出去**,不能默默放过。
        faces_of = {vgroup[i] for i in body.data.polygons[idx].vertices}
        if faces_of and faces_of <= exempt:
            held += 1
            continue

        who = "、".join(sorted(faces_of)) or "(无顶点组)"
        viol.append((t, f"边 {_fmt(a)}→{_fmt(b)} 在 t={t * 1000:.0f}mm 处横穿 "
                        f"面#{idx}[{who}] 于 {_fmt(loc)} 法线 {_fmt(n)} "
                        f"夹角 {math.degrees(math.acos(min(1.0, cos))):.0f}°"))
    viol.sort(key=lambda r: r[0])
    return near_min, near_where, [r[1] for r in viol[:worst]], held, seen


def _vertex_groups(obj: bpy.types.Object) -> list[str]:
    """
    每个顶点所属的顶点组名(取权重最大的那个)。

    用来问「这个面是谁的辖地」。`RG.skin()` 是硬权重(每点 1.0 且只属
    一组),所以答案唯一;万一哪天变成软权重,这里取最大的那个仍然是
    这一点的**主**骨 —— 但那时「面属于谁」本身就含糊了,得重想。
    """
    names = [g.name for g in obj.vertex_groups]
    out: list[str] = []
    for v in obj.data.vertices:
        if not v.groups:
            out.append("")
            continue
        best = max(v.groups, key=lambda g: g.weight)
        out.append(names[best.group])
    return out


def _bbox(obj: bpy.types.Object) -> tuple[Vector, Vector]:
    """物体**网格数据**的包围盒(建模系)。不看物体变换 —— 器物与身体
    本来就同系,拉上变换反而把两边的系搞乱。"""
    vs = obj.data.vertices
    lo = Vector((min(v.co[i] for v in vs) for i in range(3)))
    hi = Vector((max(v.co[i] for v in vs) for i in range(3)))
    return lo, hi


def _edges(obj: bpy.types.Object):
    """逐条边产出 `(起点, 终点)`,坐标在**建模系**(即网格数据本身)。"""
    vs = obj.data.vertices
    for e in obj.data.edges:
        yield Vector(vs[e.vertices[0]].co), Vector(vs[e.vertices[1]].co)


def _land_with_body(acc: bpy.types.Object, arm: bpy.types.Object,
                    body: bpy.types.Object) -> float | None:
    """
    把器物对齐到骨架的世界变换,并**回读世界坐标**与身体比对。

    身体的顶点落在建模系 `v`,世界位置是 `arm.matrix_world @ v`;器物要
    落在同一个地方。因为器物的网格数据也在建模系,所以只需让它的世界
    矩阵等于骨架的世界矩阵。

    对得上返回 None,对不上返回落差(mm)。
    """
    q = arm.matrix_world.to_quaternion()
    if abs(q.angle) > 1e-6:
        raise AssertionError(
            f"骨架 {arm.name!r} 带旋转({math.degrees(q.angle):.2f}°)。"
            f"下面的对齐只在骨架是纯平移时成立;骨架真转了的话器物要跟着转,"
            f"而这里没做。"
        )
    acc.matrix_world = arm.matrix_world.copy()
    bpy.context.view_layer.update()

    # 取一个身体上真实存在的点来比 —— 用身体的包围盒角点,不另造一个
    # 「应该在哪」的预期值。
    c = Vector(body.bound_box[0])
    dz = ((acc.matrix_world @ c).z - (body.matrix_world @ c).z) * 1000.0
    return None if abs(dz) < 1e-3 else dz


def _fmt(v: Vector) -> str:
    return "(" + ", ".join(f"{c:+.4f}" for c in v) + ")"


# --------------------------------------------------------------------------
# 随身器物:扁担
# --------------------------------------------------------------------------


def _carry_pole(b: BU.MeshBuilder) -> dict:
    """
    扁担:压左肩、穿左手,两头吊绳吊篮。**轴线由两个实测点决定,不由角度。**

        pad  = 左肩关节 + 上抬 (R_ARM + POLE_R)  —— 担身搁在肩上,不穿肩
        grip = 左手握点 = `hand_L` 的 **tail**

    「搁在肩上」这句是**量过的**,不是想当然:`_probe_meshes` 的关注区
    「肩」(球心 = 左肩关节,半径 0.18m)实测最近 **4.8mm** —— 贴着,
    但没穿。这个数要一直报出来:它万一变成几十厘米,图上只是「担子好像
    高了一点」,而在远景里根本看不出来。

    ⚠️ 「握点取手骨的 head 还是 tail」不是能猜的事:手骨长 `HAND`=0.1m,
       取错了整根担子会挪一格。实测 `hand_L` 的 tail = (−0.1436,
       +0.5926, +1.4554),与记录在册的挑担握点逐位相符 —— 是 **tail**。
       推车姿态同理:`hand_R` 的 tail 的 y = +0.2618 = `PUSH_GRIP_Y`。
       两个姿态、两个数,都是量出来的。

    ⚠️ 为什么不给「角度 + 长度」:那会多出一个**独立的**自由度,而它与
       「担子要落在肩上和手里」这两条约束未必相容。不相容时预览图上
       只是「担子斜了一点」,看不出来它已经离开了手。
    """
    bones = RG.fk(Ch.POSES["carry"])
    grip = Vector(bones["hand_L"][1])
    sh = Vector(bones["shoulder_L"][1])
    pad = sh + Vector((0.0, 0.0, Ch.R_ARM + As.POLE_R))
    fwd = (grip - pad).normalized()

    p_front = pad + fwd * As.POLE_FRONT
    p_back = pad - fwd * As.POLE_BACK
    b.add_cylinder(p_back, p_front, As.POLE_R, segments=8)

    # —— 两头的吊绳 ——
    # 绳自担身垂下 ROPE_LEN,正好够到篮口(篮底再低一个 BASKET_H)。
    # 篮子的高度位置由**绳长与篮高**推出来,不由「离地多高」定 ——
    # 后者若与骨架打架,担子就挂在半空,而远景看不出。
    for p in (p_front, p_back):
        b.add_cylinder(p, p - Vector((0.0, 0.0, As.ROPE_LEN)), As.ROPE_R,
                       segments=5)
    return {"p_front": p_front, "p_back": p_back, "pad": pad, "grip": grip,
            "axis": fwd}


def _carry_baskets(b: BU.MeshBuilder, info: dict, props) -> None:
    """两只挑篮。几何复用 `06_props._basket`,不重写一份篮子。"""
    for key in ("p_front", "p_back"):
        at = info[key] - Vector((0.0, 0.0, As.ROPE_LEN + Pr.BASKET_H))
        props._basket(b, at)


# --------------------------------------------------------------------------
# 随身器物:撑篙
# --------------------------------------------------------------------------


def _punt_pole(b: BU.MeshBuilder) -> dict:
    """
    撑篙:挂 `prop_R`,自握点向前下倾斜。

    实测 `prop_R` 的 head 与 `hand_R` 的 tail 重合(+0.1793, +0.4448,
    +1.5495)—— 挂点骨的头就长在手腕上,所以握点取 `prop_R` 的头。

    ⚠️ **只有右手握篙。** 该姿态两手握点相距 0.4394m,连起来的直线方向是
       (−0.904, −0.155, 0.398) —— 两根手不在一条能穿过的竿上。硬做
       「双手握篙」就得改姿态角,而那会把已经验过的手臂链重新推到未验
       状态。折中:左手保持上举的平衡姿势。**如实记在 docs/08。**

    ⚠️ 前倾角的正负:`Rx(θ)·(0,0,−1) = (0, +sinθ, −cosθ)`。竿的下端要
       向前(+Y)走,所以下端方向取 `(0, +sin(tilt), −cos(tilt))`。
       写反了的后果是篙向后斜 —— 而静态侧视里前后本来就难分,
       只有和船头方向一起看才发现。
    """
    bones = RG.fk(Ch.POSES["punt"])
    grip = Vector(bones["prop_R"][0])
    down = Vector((0.0, math.sin(As.PUNT_TILT), -math.cos(As.PUNT_TILT)))
    tip = grip + down * As.PUNT_DOWN
    top = grip - down * As.PUNT_UP
    b.add_cylinder(tip, top, As.PUNT_R, segments=8)
    return {"grip": grip, "tip": tip, "top": top}


# --------------------------------------------------------------------------
# 分布
# --------------------------------------------------------------------------


def _allocate(total: int, weights: list[int]) -> list[int]:
    """
    最大余额法:按权重把 `total` 配到各项,**保证和恰好等于 total**。

    ⚠️ 不能用 `round(total * w / s)` 逐项取整 —— 那样各项之和可能与
       total 差几个,于是「48 个人」里少掉或冒出一两个,而每一处局部
       看都合理。**汇总数必须与明细对得上**(Memory 第 11、12 条)。
    并列时的次序按下标,不掷骰子 —— 可复现性优先于「公平」。
    """
    s = sum(weights)
    exact = [total * w / s for w in weights]
    base = [math.floor(e) for e in exact]
    rest = total - sum(base)
    order = sorted(range(len(weights)), key=lambda i: (-(exact[i] - base[i]), i))
    for i in order[:rest]:
        base[i] += 1
    return base


def _pose_plan() -> list[tuple[dict, str]]:
    """
    48 个坑位,`[(带, 姿态)]`,顺序即分配顺序。

    两级最大余额:先按带权重把 48 配到各带,再按姿态权重把每带的人数
    配到姿态;然后把**每个带内部**的姿态轮转摊开,最后把各带也轮转
    摊开 —— 于是相邻的两个坑位多半既不同姿态也不同带。

    ⚠️ 这一步不是美化。坑位顺序决定采样顺序,而采样是**贪心**的
       (先放的先占地方)。若同姿态的人连续出场,他们会挤在同一片
       空地上站成一排 —— 而「疏密节奏」要的恰恰是混着的市井。
       轮转让这件事由构造保证,不靠事后调参。
    """
    bands = list(As.BANDS)
    counts = _allocate(As.COUNT, [b["weight"] for b in bands])

    per_band: list[list[tuple[dict, str]]] = []
    for band, n in zip(bands, counts):
        poses = list(band["poses"])
        per = _allocate(n, [band["poses"][p] for p in poses])
        queues = [[(band, p)] * m for p, m in zip(poses, per)]
        merged: list[tuple[dict, str]] = []
        while any(queues):
            for q in queues:
                if q:
                    merged.append(q.pop(0))
        per_band.append(merged)

    out: list[tuple[dict, str]] = []
    while any(per_band):
        for q in per_band:
            if q:
                out.append(q.pop(0))
    return out


def _yaw_for(band: dict, pose: str, boat_yaw: float | None, rng) -> float:
    """
    朝向。

    ⚠️ 人物的**脸朝局部 +Y**(见 `07_characters`:脚与脸同向)。所以
       「沿街走」在场景里就是沿 ±Y 走,yaw 取 0 或 π —— **不是** π/2。
       搞反了 48 个人会全部横着走,而在俯视的标位图上完全看不出来
       (柱子没有方向)。

    ⚠️ 虹桥是**唯一一条轴为 X 的带** —— 全场的河与街都沿 Y 走,只有桥
       横跨,所以桥上的朝向与别处整套对调:过桥 = 沿 ±X(±π/2)、
       站定看水 = 朝 ±Y(0 / π)。别处正相反。
    """
    if boat_yaw is not None:
        return boat_yaw                    # 撑船的人朝船头(船首是局部 +Y)
    moving = As.POSE_SPEC[pose]["speed"] > 0
    on_bridge = band["name"] == "桥面"
    # 走得动的沿带的长轴走(桥是 X、别处是 Y);站定的面向河/街,
    # 在桥上面向水 —— 两者恰好互为反面。
    along_x = on_bridge if moving else (not on_bridge)
    if along_x:
        return math.pi / 2 if rng.random() < 0.5 else -math.pi / 2
    return 0.0 if rng.random() < 0.5 else math.pi


def _sample_rect(band: dict, rng) -> tuple[float, float]:
    """两岸各半场里等概率取点 —— 只取一侧会让整条街空掉半边。"""
    lo, hi = band["x"]
    side = 1.0 if rng.random() < 0.5 else -1.0
    return side * rng.uniform(lo, hi), rng.uniform(*band["y"])


def _sample_deck(hulls: list, rng) -> tuple[float, float]:
    """
    船上:在**甲板范围**内撒点,由射线判定是不是真甲板。返回世界坐标。

    ⚠️ 这里埋过一个能让整条带**静默失效**的坑,值得写清楚:**船壳的网格
       数据是局部坐标**(船体位置在物体的变换上),所以「取网格包围盒的
       中点当世界坐标用」撒出来的点全挤在**世界原点**附近,与选中哪条船
       无关。实测五条船分别在 y = −27 / +46 / −9.5 / +19.5 / +33,而
       局部盒中心五条**完全相同**(+0.00, −0.02)。

       症状不显眼:采样照样跑完、拒收理由照样一本正经(「落在
       bridge(虹桥_桥面)上」136 次、「落在 water(河道_水面)上」28 次),
       只是那些理由量的是**原点附近的水面与虹桥**。若不是「船上五个人
       只站上去一个」这个总数对不上,它会被当成「船附近本来就挤」。

    ⚠️ 位置一律取自**网格数据 + 求值后的 `matrix_world`**,不取
       `bound_box`,也不直接读 `matrix_world`:后者是**上一轮求值留下的
       缓存**,`03_boats` 写完 `location` 之后它还没跟上(第二版探针就是
       这么量出「五条船同一位置」的)。

    ⚠️ 纵向取到九成、横向七成:船首尾收细,撒到边角多半落水,白耗采样
       次数(而拒收次数会被读成人手布置的失败)。**但纵向不能只取中间**:
       舱篷罩着船身中段,撑船的人站的是**首尾的敞开甲板**,只采中间就
       永远落在篷上 —— 那是「采样范围」选错,不是「船上放不下人」。
    """
    # 求值一次,拿到已经跟上位置的 `matrix_world`
    h = hulls[int(rng.integers(0, len(hulls)))]
    dg = bpy.context.evaluated_depsgraph_get()
    mw = h.evaluated_get(dg).matrix_world

    vs = h.data.vertices
    xs = [v.co.x for v in vs]
    ys = [v.co.y for v in vs]
    cx, cy = (min(xs) + max(xs)) * 0.5, (min(ys) + max(ys)) * 0.5
    lx = cx + rng.uniform(-0.35, 0.35) * (max(xs) - min(xs))
    ly = cy + rng.uniform(-0.45, 0.45) * (max(ys) - min(ys))
    w = mw @ Vector((lx, ly, 0.0))
    return w.x, w.y


def _cast(x: float, y: float) -> tuple[bool, Vector, object]:
    """自天顶垂直向下打一条射线。返回 `(命中?, 命中点, 物体)`。"""
    dg = bpy.context.evaluated_depsgraph_get()
    hit, loc, _n, _i, obj, _m = bpy.context.scene.ray_cast(
        dg, Vector((x, y, As.SKY_Z)), DOWN)
    return hit, Vector(loc), obj


def _spot_clear(band: dict, z_ref: float, pts: list[tuple[float, float]],
                why: str, rej: dict) -> bool:
    """
    `pts` 里每个点都必须落在**与本人同高的**、带内允许的面层上。

    ⚠️ 「同高」要拿 `z_ref`(这个人脚下那一点的高程)去比,**不能拿 0 去
       比**:虹桥拱顶在 z≈5,拿 0 比会把桥上的推车与摊位全部判成「地面
       高出一截」。那不是保守,是错的 —— 它会把一整条带悄悄清空,而
       拒收理由写得冠冕堂皇。
    """
    for px, py in pts:
        hit, loc, obj = _cast(px, py)
        if not hit:
            k = f"{why}:落不到任何面层"
            rej[k] = rej.get(k, 0) + 1
            return False
        kind = str(obj.get("qm_kind", ""))
        if kind not in band["surface"]:
            k = f"{why}:压着 {kind or '无标签物体'}({obj.name})"
            rej[k] = rej.get(k, 0) + 1
            return False
        if abs(loc.z - z_ref) > 0.35:
            k = f"{why}:与本人脚下不平(差 {loc.z - z_ref:+.2f}m)"
            rej[k] = rej.get(k, 0) + 1
            return False
    return True


def _prop_sites(pose: str, x: float, y: float, yaw: float) -> list[tuple]:
    """
    这个人要配的落地器物占哪些位子。返回 `[(检验点列表, 说明)]`。

    位子由**本人的朝向**算出来,不是另撒一遍点 —— 器物是「这个人的」,
    离了人就只是路边杂物。
    """
    f = Vector((-math.sin(yaw), math.cos(yaw), 0.0))     # 人朝前
    r = Vector((math.cos(yaw), math.sin(yaw), 0.0))      # 人的右手边

    def corners(c: Vector, half_f: float, half_r: float) -> list[tuple[float, float]]:
        out = [(c.x, c.y)]
        for sf in (-1.0, 1.0):
            for sr in (-1.0, 1.0):
                p = c + f * (sf * half_f) + r * (sr * half_r)
                out.append((p.x, p.y))
        return out

    if pose == "push":
        # 车柄末端落在两手之间 → 车架原点在人前方 `BARROW_AHEAD` 处。
        # 车的长轴顺着人的朝向(`ry = yaw + π/2` 的推导见 config)。
        c = Vector((x, y, 0.0)) + f * As.BARROW_AHEAD
        return [(corners(c, 0.80, 0.28), "车前")]
    if pose == "vendor":
        # 一篮一瓮,分列左右手边稍前 —— 不挡自己的脸。
        p = Vector((x, y, 0.0))
        return [(corners(p + r * 0.72 + f * 0.30, 0.30, 0.30), "摊前篮"),
                (corners(p - r * 0.58 + f * 0.30, 0.34, 0.34), "摊前瓮")]
    return []


def _place(band: dict, pose: str, hulls: list, taken: list[tuple[float, float]],
           rng, rej: dict) -> dict | None:
    """
    在带内找一个**完全可用**的落点:面层对、间距够、配套器物放得下。

    ⚠️ 配套器物的检验放在**这里**,不另起一趟。放到后面那一趟就是
       「人已经站好了,才发现车放不下」—— 那时唯一能做的就是少放一辆车,
       于是这个人对着空地做推车状,而计数表一切正常。本项目的规矩是
       **候选点在被接受之前就要验完整**。
    """
    deck = band["x"][0] is None
    for _ in range(TRIES):
        x, y = _sample_deck(hulls, rng) if deck else _sample_rect(band, rng)
        hit, loc, obj = _cast(x, y)
        if not hit:
            rej["没有落到任何面层"] = rej.get("没有落到任何面层", 0) + 1
            continue
        kind, part = str(obj.get("qm_kind", "")), str(obj.get("qm_part", ""))
        if kind not in band["surface"]:
            k = f"落在 {kind or '无标签物体'}({obj.name})上"
            rej[k] = rej.get(k, 0) + 1
            continue
        boat_yaw = None
        if kind == "boat":
            # 甲板 = 船壳的**顶面**。舱篷、属具、桅、橹都在它上面,
            # 站上去会穿模 —— 而「站稳了」这件事在图上看不出来。
            if part != "hull":
                k = "落在舱篷/属具上,不是甲板"
                rej[k] = rej.get(k, 0) + 1
                continue
            if obj.get("qm_beached"):
                k = "船已拖上岸,不是可站的水面船"
                rej[k] = rej.get(k, 0) + 1
                continue
            boat_yaw = float(obj.rotation_euler.z)
        gap = min((math.hypot(x - tx, y - ty) for tx, ty in taken), default=1e9)
        if gap < As.MIN_GAP:
            k = f"离最近的人不足 {As.MIN_GAP}m"
            rej[k] = rej.get(k, 0) + 1
            continue

        yaw = _yaw_for(band, pose, boat_yaw, rng)
        sites = _prop_sites(pose, x, y, yaw)
        if any(not _spot_clear(band, float(loc.z), pts, why, rej)
               for pts, why in sites):
            continue

        taken.append((x, y))
        return {"x": x, "y": y, "z": float(loc.z), "yaw": yaw,
                "boat": obj.get("qm_parent") if kind == "boat" else None,
                "surface": kind}
    return None


# --------------------------------------------------------------------------
# 主流程
# --------------------------------------------------------------------------


def build() -> dict:
    BU.clear_scene_once()
    _chars, props = _upstream()

    mats = BU.MaterialLibrary()
    char_coll = BU.get_collection(CHAR_COLL)
    prop_coll = BU.get_collection(PROP_COLL)
    mark_coll = BU.get_collection(MARK_COLL)

    rng = np.random.default_rng(SEED)
    checks: list[str] = []
    rej: dict[str, int] = {}

    # ==================== 一、随身器物 ====================
    #
    # 只有 `carry` 与 `punt` 两种姿态带随身器物。它们**蒙皮到骨上**,
    # 于是跟着网页的程序化驱动一起动 —— 挑担的人手臂不摆
    # (`Assembly.POSE_SPEC["carry"]["swing"] == ("legs",)`),扁担就稳稳
    # 压在肩上;撑船的人站定,只有 `prop_R` 随上身微动。
    #
    # 粗糙度沿 06 的取值:这两款材质 06 已经建过,`MaterialLibrary.get`
    # 同名同色时**直接返回缓存**,这里再传一个别的粗糙度不会报错、也不会
    # 生效 —— 那行参数就成了骗人的注释。
    accs: list[tuple[bpy.types.Object, str, frozenset[str]]] = []

    # —— 扁担 ——
    body_c, arm_c = _template("carry")
    b = BU.MeshBuilder("acc_carry_pole")
    info = _carry_pole(b)
    _carry_baskets(b, info, props)
    pole = b.build(mats.get("bamboo", Pal.BAMBOO, roughness=0.90), char_coll)
    RG.skin(pole, arm_c, {"chest": (0, len(b.verts))})
    TU.tag(pole, "acc_carry_pole", "character",
           label="扁担与挑篮", anim="walk", dynamic=True, lod="near",
           zone="人物", parent="char_carry",
           note="挂 chest;轴线由左肩关节与左手握点两个实测点定,不另设角度")
    dz = _land_with_body(pole, arm_c, body_c)
    if dz is not None:
        raise AssertionError(
            f"扁担与身体的世界坐标差 {dz:+.3f}mm —— 落地偏移没对上。"
            f"见 `_land_with_body()` 的注释:器物在骨架抬好之后才蒙皮,"
            f"`matrix_parent_inverse` 会把骨架的位移抵消掉,必须显式补回。"
        )
    # 豁免左手的辖地:担子压在左肩、穿在左手里,而手是实心盒。
    # 关注区取左肩关节周围 0.18m:docstring 写了「担身搁在肩上,不穿肩」,
    # 那句话得有读数撑腰 —— 全局最近在手上,答不了肩这一处。
    accs.append((pole, "carry", frozenset({"hand_L"}),
                 (("肩", Vector(RG.fk(Ch.POSES["carry"])["shoulder_L"][1]), 0.18),)))

    # —— 撑篙 ——
    body_p, arm_p = _template("punt")
    b = BU.MeshBuilder("acc_punt_pole")
    pinfo = _punt_pole(b)
    pole2 = b.build(mats.get("bamboo", Pal.BAMBOO, roughness=0.90), char_coll)
    RG.skin(pole2, arm_p, {"prop_R": (0, len(b.verts))})
    TU.tag(pole2, "acc_punt_pole", "character",
           label="撑篙", anim="oar", dynamic=True, lod="near",
           zone="人物", parent="char_punt",
           note="挂 prop_R(右手挂点骨)。只挂右手:两手握点相距 0.4394m,"
                "不在一条竿上,见 docs/08")
    dz = _land_with_body(pole2, arm_p, body_p)
    if dz is not None:
        raise AssertionError(f"撑篙与身体的世界坐标差 {dz:+.3f}mm —— 落地偏移没对上。")
    # 豁免右手的辖地。杆挂在 `prop_R` 上,而 `prop_R` 是右手挂点骨 ——
    # 豁免的是手,不是挂点骨:`prop_R` 自己不辖任何身体顶点。
    accs.append((pole2, "punt", frozenset({"hand_R"}), ()))

    # —— 回读一:轴线确实穿过握点 ——
    #
    # 上面 `_carry_pole` 用的是**构造**:轴线由那两个点连出来,所以它必然
    # 穿过。真正要防的是别处改了 `As.POLE_FRONT / POLE_BACK`、或把手骨的
    # head 当成握点,那才会把杆从手里推走。这一行就是那个哨兵。
    for acc, pose, inf in ((pole, "carry", info), (pole2, "punt", pinfo)):
        bones = RG.fk(Ch.POSES[pose])
        if pose == "carry":
            grip = Vector(bones["hand_L"][1])
            d = _seg_dist(inf["p_front"], inf["p_back"], grip)
            bone = "hand_L.tail"
        else:
            grip = Vector(bones["prop_R"][0])
            d = _seg_dist(inf["tip"], inf["top"], grip)
            bone = "prop_R.head"
        checks.append(f"{acc.name:<16} 轴到 {bone} 握点 {d * 1000:.3f}mm"
                      f"  握点 {_fmt(grip)}  顶点 {len(acc.data.vertices)}")
        if d > 1e-4:
            raise AssertionError(
                f"{acc.name} 的轴线离 {bone} 握点 {d * 1000:.1f}mm —— 杆不在手里。"
            )

    # —— 回读二:与身体没有互相穿模 ——
    for acc, pose, exempt, watch in accs:
        body_o, _arm = _template(pose)
        near, where, viol, held, seen = _probe_meshes(acc, body_o, exempt, watch)
        # 数连着位置一起报:「最近 191.8mm 对不对」当场就能判 —— 上一轮
        # 正是靠看见最近处落在胯高而不是肩高,才发现杆身上根本没有顶点。
        checks.append(f"{acc.name:<16} 与身体最近 {near * 1000:.1f}mm"
                      f"(沿边采样 {SAMPLE_STEP * 1000:.0f}mm)"
                      + (f"  [{where}]" if where else ""))
        checks.append(f"{'':<16} 握持处穿越 {'、'.join(sorted(exempt))} "
                      f"{held} 条边(按约定豁免,手是实心盒)")
        for name, center, radius in watch:
            got = seen.get(name)
            if got is None:
                raise AssertionError(
                    f"{acc.name} 在关注区「{name}」"
                    f"(球心 {_fmt(center)} 半径 {radius}m)内**一个采样点都没有** —— "
                    f"这条读数无从谈起。要么器物根本不在那儿(那正是要查的事),"
                    f"要么半径开小了(小到量不着东西的读数,和没有读数一样)。"
                )
            checks.append(f"{'':<16} 关注区「{name}」最近 {got * 1000:.1f}mm"
                          f"(球心 {_fmt(center)} 半径 {radius:.2f}m)")
        if viol:
            detail = "\n".join(f"      {r}" for r in viol)
            raise AssertionError(
                f"{acc.name} 与身体 {body_o.name} 相交,{len(viol)} 条边横穿:"
                f"\n{detail}\n"
                f"  判据:某条边在自身长度**内部**横穿身体表面,且与该面夹角"
                f" 大于 {math.degrees(math.asin(TRANSVERSAL)):.0f}°(贴着面走的不算)。"
                f"\n  豁免的只有 {'、'.join(sorted(exempt))} 的辖地 —— "
                f"上面这些落在别处,是真穿模。"
            )

    # ==================== 二、分布 ====================
    hulls = [o for o in bpy.data.objects
             if o.type == "MESH" and o.get("qm_part") == "hull"
             and not o.get("qm_beached")]
    if not hulls:
        raise RuntimeError("场景里没有可站人的船壳 —— 船上那一带一个也放不下")

    plan = _pose_plan()
    requested = len(plan)
    if requested != As.COUNT:
        raise AssertionError(
            f"配比摊平后是 {requested} 个坑位,`Assembly.COUNT` 是 {As.COUNT} —— "
            f"两级最大余额有一个环节漏了人"
        )

    taken: list[tuple[float, float]] = []
    actors: list[dict] = []
    failed = 0
    for i, (band, pose) in enumerate(plan):
        spot = _place(band, pose, hulls, taken, rng, rej)
        if spot is None:
            failed += 1
            checks.append(f"坑位 {i:02d}({band['name']}/{pose})试满 {TRIES} 次没放下")
            continue
        spec = As.POSE_SPEC[pose]
        actors.append({
            "id": f"actor_{i:03d}",
            "pose": pose,
            "x": round(spot["x"], 4),
            "y": round(spot["y"], 4),
            "z": round(spot["z"], 4),
            "yaw": round(spot["yaw"], 5),
            "speed": spec["speed"],
            "swing": list(spec["swing"]),
            "zone": band["name"],
            "anim": "walk" if spec["speed"] > 0 else "none",
            "on_boat": spot["boat"],
            "surface": spot["surface"],
        })

    placed = len(actors)
    # ⚠️ 对账的两边必须**互斥且穷尽**:一个坑位要么落下一个实例,要么记一次
    #    失败。少了这条,`rej` 里那堆理由就成了没人核对的文字 —— 而
    #    「汇总正常、明细少件」正是本项目反复栽的形状。
    if placed + failed != requested:
        raise AssertionError(
            f"放下 {placed} 个 + 没放下 {failed} 个 ≠ 坑位 {requested} 个 —— "
            f"有一次尝试没被记进任何一边"
        )

    # ==================== 三、配对的落地器物 ====================
    #
    # 位子已经在 `_place()` 里验过(面层对、与本人脚下齐平),这里只建几何。
    # **不重验** —— 两处判据迟早会不一致,而不一致时没人知道该信哪一处。
    buckets: dict[tuple[str, str], BU.MeshBuilder] = {}

    def bucket(actor_id: str, mat_name: str) -> BU.MeshBuilder:
        key = (actor_id, mat_name)
        if key not in buckets:
            buckets[key] = BU.MeshBuilder(f"acc_{actor_id}_{mat_name}")
        return buckets[key]

    pairs = 0
    for a in actors:
        if a["pose"] not in ("push", "vendor"):
            continue
        f = Vector((-math.sin(a["yaw"]), math.cos(a["yaw"]), 0.0))
        r = Vector((math.cos(a["yaw"]), math.sin(a["yaw"]), 0.0))
        p = Vector((a["x"], a["y"], 0.0))
        items: list[tuple[str, Vector, float]] = []
        if a["pose"] == "push":
            items.append(("barrow", p + f * As.BARROW_AHEAD, a["yaw"] + math.pi / 2))
        else:
            items.append(("basket", p + r * 0.72 + f * 0.30, 0.0))
            items.append(("jar", p - r * 0.58 + f * 0.30, 0.0))
        for kind, at, ry in items:
            at.z = a["z"]            # 与本人同高:桥上的人,车也在桥上
            mat_name = props._MATERIAL_BY_KIND[kind][0]
            props._BUILDERS[kind](bucket(a["id"], mat_name), at, ry)
            pairs += 1

    acc_objs = 0
    for (actor_id, mat_name), buf in buckets.items():
        color = getattr(Pal, dict(props._MATERIAL_BY_KIND.values())[mat_name])
        o = buf.build(mats.get(mat_name, color, roughness=0.90), prop_coll)
        if o is None:
            continue
        acc_objs += 1
        TU.tag(o, f"acc_{actor_id}_{mat_name}", "prop",
               label="随身器物", zone="市井", lod="near", dynamic=True,
               parent=actor_id,
               note=f"与 {actor_id} 配对;网页据 qm_parent 与本人一同驱动,"
                    f"不靠位置距离去猜")

    # ==================== 四、仅供预览的标位柱 ====================
    #
    # 48 个人在 Blender 里没有形体(身体是模板,复制发生在网页),而
    # 「疏密节奏」是个**空间**结论 —— 一张计数表能证明分布符合配比,
    # 证明不了它铺开来好不好看。所以给每个位置插一根柱子,只在预览
    # 渲染里存在。它们带 `qm_preview`,由 `09_export.assert_preview_marks`
    # 拦下 —— 不会进任何 GLB。
    #
    # ⚠️ 两种颜色分「走得动的」与「站定的」:混在一起的分布图看不出
    #    这件事,而它正是标位柱要回答的问题。
    mv = BU.MeshBuilder("mark_moving")
    st = BU.MeshBuilder("mark_static")
    for a in actors:
        buf = mv if a["speed"] > 0 else st
        base = Vector((a["x"], a["y"], a["z"]))
        buf.add_cylinder(base, base + Vector((0.0, 0.0, MARK_H)), MARK_R,
                         segments=6)
    markers = 0
    for buf, name, color in ((mv, "mark_moving", (0.86, 0.28, 0.16)),
                             (st, "mark_static", (0.16, 0.42, 0.78))):
        o = buf.build(mats.get(name, color, roughness=0.60), mark_coll)
        if o is None:
            continue
        markers += 1
        TU.tag(o, name, "prop", label="人物标位", zone="人物", lod="far",
               reflect=False, hotspot=False, preview=1,
               note="仅供预览,不导出;一根柱子 = 分布里的一个人")

    # ==================== 五、写账 ====================
    by_pose: dict[str, int] = {}
    by_zone: dict[str, int] = {}
    for a in actors:
        by_pose[a["pose"]] = by_pose.get(a["pose"], 0) + 1
        by_zone[a["zone"]] = by_zone.get(a["zone"], 0) + 1

    payload = {
        "schema": 1,
        "seed": int(C.SEED),
        "unit": C.UNIT,
        # ⚠️ 网页是 Y-up。Blender 的 (x, y, z) 导出后成为 (x, z, −y) ——
        #    写清楚,免得网页那边按 Blender 的轴序读,人全部躺在地上。
        "frame": "three-y-up (x, z, -y)",
        "counts": {"requested": requested, "placed": placed,
                   "failed": failed, "byPose": by_pose, "byZone": by_zone},
        "reject_reasons": rej,
        "paired_props": pairs,
        "actors": actors,
    }
    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8")

    # 回读一次:写下去的东西能被读回来,而且是同一批数。
    back = json.loads(OUT_JSON.read_text(encoding="utf-8"))
    if back["counts"]["placed"] != placed or len(back["actors"]) != placed:
        raise AssertionError(
            f"{OUT_JSON.name} 回读对不上:文件里 {back['counts']['placed']} 个 / "
            f"{len(back['actors'])} 条记录,内存里 {placed} 个"
        )

    return {
        "坑位": requested,
        "实例数": placed,
        "没放下": failed,
        "随身器物": len(accs),
        "配对器物": pairs,
        "配对器物物体": acc_objs,
        "标位柱物体": markers,
        "各带人数": by_zone,
        "各姿态人数": by_pose,
        "拒收原因": rej,
        "分布表": OUT_JSON.relative_to(PROJECT_DIR).as_posix(),
        "逐项复核": checks,
    }


if __name__ == "__main__":
    from lib import bl_utils as _BU

    # ⚠️ `reset_clear_flag()` 一个进程只许调一次,且必须在最前头 ——
    #    重复调用会让 `build()` 里的 `clear_scene_once()` 把上游整套清光。
    _BU.reset_clear_flag()

    if "--alone" in sys.argv:
        for _m in ("00_layout", "01_bridge", "02_river", "03_boats",
                   "04_buildings", "05_celebrations", "06_props",
                   "07_characters"):
            MOD.load_build(_m).build()

    _r = build()
    print("=" * 68)
    print("装配完成")
    print(json.dumps(_r, ensure_ascii=False, indent=2))
    print("=" * 68)
