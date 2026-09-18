"""
骨架与蒙皮 —— 把一张关节角表变成"一具有骨有肉的身体"。

核心设计:骨架与网格出自**同一张表**
------------------------------------
    常见做法是先建一个标准姿势的人体网格,再用 operator 把当前姿态
    "应用"成新的 rest pose(`pose.armature_apply()`)。本项目**不这么做**,
    理由是两条,都不是风格偏好:

    1) **operator 在无头模式下要上下文。** 主路径是 `blender --background`,
       任何依赖 `bpy.context.mode` / 活动物体的 operator 都是一处会随
       Blender 版本漂移的暗礁(本项目已经栽在 `export_format` 枚举上过)。

    2) **更要紧的是:那样会有两个真相源。** 姿态改了、网格没跟着改,
       出来的就是"骨架摆着、肉还站在原地"—— 而它在预览图里几乎看不出来
       (远看就是个人),只有网页里驱动骨骼时才会露馅。这类不同步
       正是本项目反复栽的形状。

    这里改成:`config.Character.POSES` 的一张角表 → `fk()` 算出每根骨的
    世界头尾 → **骨架照它建、网格也照它建**。姿态差异只有一个来源,
    不存在"改了这头忘了那头"。

蒙皮为什么用硬权重(每顶点 1 根骨)
----------------------------------
    `ARMATURE_AUTO` 的自动权重需要 operator,而且对"一根根方料拼起来的
    低模"并不好用:热扩散权重会让大腿与小臂互相干扰,膝盖处拉出长丝。
    本项目的人体是**分段方料**,段与段之间的归属是**已知的** ——
    谁是谁建的时候就知道,不需要猜。所以按顶点区间直接给硬权重。
    代价是关节处没有平滑过渡(弯到手肘会看到折角),这在远景里
    完全可以接受,而且**好过自动权重那种不可复现的失败**。

⚠️ 边界:硬权重意味着**手腕不会拧、腰不会扭**。本项目的人体是街市上
   的远景群众,不是近景主角。这条如实写进 docs/08。
"""

from __future__ import annotations

import math

import bpy
from mathutils import Euler, Matrix, Vector

import config as C

Ch = C.Character

# 骨名 → 父骨名。`None` 表示根。
PARENT = {
    "root": None,
    "pelvis": "root",
    "spine": "pelvis",
    "chest": "spine",
    "neck": "chest",
    "head": "neck",
    "shoulder_L": "chest",
    "upperarm_L": "shoulder_L",
    "forearm_L": "upperarm_L",
    "hand_L": "forearm_L",
    "shoulder_R": "chest",
    "upperarm_R": "shoulder_R",
    "forearm_R": "upperarm_R",
    "hand_R": "forearm_R",
    "thigh_L": "pelvis",
    "shin_L": "thigh_L",
    "foot_L": "shin_L",
    "thigh_R": "pelvis",
    "shin_R": "thigh_R",
    "foot_R": "shin_R",
    "prop_R": "hand_R",
}

# 出生(def rest)时每根骨的两端在哪 —— **只在 `POSES` 里没写角度时用**。
# 单位是"关节角表里的一根骨",与世界无关;`fk()` 会把它累加成世界坐标。
#
# 形态:`(head, tail)`,出生姿态是**站立、双臂下垂、掌心向内**。
REST: dict[str, tuple[tuple[float, float, float], tuple[float, float, float]]] = {
    # 躯干:一条竖直链。**相邻两骨必须首尾相接**,否则 `fk()` 里那条
    # "头的偏移挂在父骨尾上"的算法会多绕出一段 —— 见下面 `fk()` 的说明。
    "root": ((0.0, 0.0, 0.0), (0.0, 0.0, 0.12)),
    # ⚠️ 髋骨从**髋关节标高**起,不是从脊柱底起。先前这里两端都写成
    #    `SPINE_BOT`,是一根零长骨 —— 零长骨不会报错,它只是让
    #    `pelvis` 的旋转无从发生,于是"扭腰"这个动作在网页里静默失效。
    "pelvis": ((0.0, 0.0, Ch.HIP_Z), (0.0, 0.0, Ch.SPINE_BOT)),
    "spine": ((0.0, 0.0, Ch.SPINE_BOT), (0.0, 0.0, Ch.SPINE_TOP)),
    "chest": ((0.0, 0.0, Ch.CHEST_BOT), (0.0, 0.0, Ch.CHEST_TOP)),
    "neck": ((0.0, 0.0, Ch.NECK_BOT), (0.0, 0.0, Ch.NECK_TOP)),
    "head": ((0.0, 0.0, Ch.HEAD_BOT), (0.0, 0.0, Ch.HEAD_TOP)),
}

_HAND_Z = Ch.fingertip_z()
_ELBOW_Z = Ch.CHEST_TOP - Ch.UPPERARM
_WRIST_Z = _ELBOW_Z - Ch.FOREARM

for _s, _side in ((-1.0, "L"), (1.0, "R")):
    REST[f"shoulder_{_side}"] = (
        (0.0, 0.0, Ch.CHEST_TOP - 0.02),
        (_s * Ch.SHOULDER_X, 0.0, Ch.CHEST_TOP - 0.02),
    )
    REST[f"upperarm_{_side}"] = (
        (_s * Ch.SHOULDER_X, 0.0, Ch.CHEST_TOP - 0.02),
        (_s * Ch.SHOULDER_X, 0.0, _ELBOW_Z),
    )
    REST[f"forearm_{_side}"] = (
        (_s * Ch.SHOULDER_X, 0.0, _ELBOW_Z),
        (_s * Ch.SHOULDER_X, 0.0, _WRIST_Z),
    )
    REST[f"hand_{_side}"] = (
        (_s * Ch.SHOULDER_X, 0.0, _WRIST_Z),
        (_s * Ch.SHOULDER_X, 0.0, _WRIST_Z - Ch.HAND),
    )
    REST[f"thigh_{_side}"] = (
        (_s * Ch.HIP_X, 0.0, Ch.HIP_Z),
        (_s * Ch.HIP_X, 0.0, Ch.KNEE_Z),
    )
    REST[f"shin_{_side}"] = (
        (_s * Ch.HIP_X, 0.0, Ch.KNEE_Z),
        (_s * Ch.HIP_X, 0.0, Ch.ANKLE_Z),
    )
    REST[f"foot_{_side}"] = (
        (_s * Ch.HIP_X, 0.0, Ch.ANKLE_Z),
        (_s * Ch.HIP_X, Ch.TOE_Y, Ch.SOLE_Z),
    )

# —— 挂点骨:道具的插座 ——
#
# ⚠️ `prop_R` **必须**在这张表里。它在 `PARENT` 里,于是 FK 会走到它;
#    而 `REST` 里少了它,FK 会 `KeyError` —— 这是**好事**:
#    要是当初把"查不到就跳过"写进去,挂点骨会静默消失,
#    挑担的人会没有扁担,而报告里一切正常。
#
# 从右手尖再往前 0.06m。挑担的扁担、撑船的篙、摊上的秤都挂这儿。
REST["prop_R"] = (
    (Ch.SHOULDER_X, 0.0, _WRIST_Z - Ch.HAND),
    (Ch.SHOULDER_X, 0.06, _WRIST_Z - Ch.HAND),
)


def fk(pose: dict) -> dict[str, tuple[Vector, Vector]]:
    """
    正向运动学:把一张"关节角表"算成每根骨的**世界**头尾。

    `pose` 是 `{骨名: (rx, ry, rz)}`,单位弧度,角度是**相对父骨的局部旋转**,
    依次绕世界 X → Y → Z 施加(见 `config.Character.POSES` 的约定)。

    做法:自根向叶,每根骨维护两个量 —— **世界旋转矩阵**(父矩阵 × 本骨
    局部旋转)与**世界头位置**。头位置由父骨的头位置加上一段偏移得出:

        head = parent_head + parent_mat @ (REST[骨].head − REST[父].head)

    ⚠️ 偏移要**减父骨的 `head`,不是减父骨的 `tail`**。这两者在别的骨架
       体系里常常等价(子骨的头就长在父骨的尾上),本项目**不等价**:
       `thigh_L` 的头在髋关节 (±0.105, 0, 0.899),而它父骨 `pelvis` 的尾
       在脊柱底 (0, 0, 0.979) —— 差 10.5cm 横向、8cm 竖向。照"吸附到父尾"
       写,左腿会并到中线、整个人变成一根棍;而**它仍然渲染得出来**,
       只是不像人。本项目先前就是这么写的,已改正。

    骨长取自 `REST`,**不参与姿态** —— 摆姿势不该把腿拉长,这是 FK 该守住的。

    返回 `{骨名: (head_world, tail_world)}`。
    """
    out: dict[str, tuple[Vector, Vector]] = {}

    def walk(name: str, parent_head: Vector, parent_mat: Matrix) -> None:
        h0, t0 = Vector(REST[name][0]), Vector(REST[name][1])
        par = PARENT[name]
        ph0 = Vector(REST[par][0])
        local_len = (t0 - h0).length
        if local_len < 1e-9:
            raise ValueError(
                f"骨 {name!r} 在 REST 里是零长的({h0} → {t0})。"
                f"零长骨不报错,只是它的旋转无从发生 —— 对应的动作会静默失效。"
            )
        ang = pose.get(name, (0.0, 0.0, 0.0))
        rot = Euler((ang[0], ang[1], ang[2]), "XYZ").to_matrix().to_4x4()
        # ⚠️ 旋转是**在父的世界旋转之上**叠的:矩阵左乘。
        #    写成 `rot @ parent_mat` 就成了"绕自己的局部轴转",
        #    那样抬左腿与抬右腿会朝相反方向 —— 而对称性错误
        #    在正面视图上看起来"只是有点怪",很难一眼归因。
        mat = parent_mat @ rot

        head = Vector(parent_head) + (parent_mat.to_3x3() @ (h0 - ph0))
        born_dir = (t0 - h0).normalized()
        tail = head + (mat.to_3x3() @ born_dir).normalized() * local_len

        out[name] = (head, tail)
        for child, p in PARENT.items():
            if p == name:
                walk(child, head, mat)

    for name, par in PARENT.items():
        if par is None:
            h0, t0 = REST[name]
            ang = pose.get(name, (0.0, 0.0, 0.0))
            mat = Euler((ang[0], ang[1], ang[2]), "XYZ").to_matrix().to_4x4()
            head = Vector(h0)
            d = (mat.to_3x3() @ (Vector(t0) - Vector(h0)).normalized()).normalized()
            tail = head + d * (Vector(t0) - Vector(h0)).length
            out[name] = (head, tail)
            for child, p2 in PARENT.items():
                if p2 == name:
                    walk(child, head, mat)

    return out


def make_armature(
    name: str,
    bones: dict[str, tuple[Vector, Vector]],
    collection: bpy.types.Collection | None = None,
    *,
    deform: tuple[str, ...] | None = None,
) -> bpy.types.Object:
    """
    按 `bones`(世界头尾)建一副骨架。

    ⚠️ `edit_bones` **只在 EDIT 模式下存在**,所以这里必须进一次 EDIT。
       无头模式下这要求物体已链进场景、且是 `view_layer` 的活动物体 ——
       下面三步缺一不可,少一步的报错是 `AttributeError: 'Object' has no
       attribute 'edit_bones'`,看起来像 API 用错,其实是上下文没给。
    """
    arm_data = bpy.data.armatures.new(name + "_arm")
    arm_obj = bpy.data.objects.new(name + "_rig", arm_data)
    (collection or bpy.context.scene.collection).objects.link(arm_obj)

    view = bpy.context.view_layer
    prev_active = view.objects.active
    view.objects.active = arm_obj
    arm_obj.select_set(True)

    bpy.ops.object.mode_set(mode="EDIT")
    try:
        eb = arm_data.edit_bones
        made: dict[str, bpy.types.EditBone] = {}
        # 两趟:先建全部骨,再接父子 —— 父骨可能比子骨晚出现在 dict 里
        for bname, (head, tail) in bones.items():
            b = eb.new(bname)
            b.head = Vector(head)
            b.tail = Vector(tail)
            b.use_deform = bname in (deform or Ch.DEFORM_BONES)
            made[bname] = b
        for bname, par in PARENT.items():
            if par is not None and bname in made and par in made:
                made[bname].parent = made[par]
                # ⚠️ `use_connect` 一律 False。连上之后子骨的头会被父骨的尾
                #    钉死,于是 `fk()` 算出来的关节位置**当场被改写** ——
                #    而骨架看着仍然合理(它只是把膝盖挪了几厘米)。
                #    本项目不连骨:位置以 `fk()` 为准,骨架是它的记录,不是它的来源。
                made[bname].use_connect = False
    finally:
        bpy.ops.object.mode_set(mode="OBJECT")
        arm_obj.select_set(False)
        if prev_active is not None:
            view.objects.active = prev_active

    # 冻结 rest 姿态的标记。网页侧靠它判断这是"程序化驱动"而非"预烘焙动画"。
    arm_obj["qm_rig"] = name
    arm_obj["qm_rest_baked"] = 1
    return arm_obj


def skin(
    mesh_obj: bpy.types.Object,
    arm_obj: bpy.types.Object,
    ranges: dict[str, tuple[int, int]],
) -> int:
    """
    把网格按**顶点区间**绑到骨上:每个顶点硬权重 1.0 给一根骨。

    `ranges` 是 `{骨名: (首顶点下标, 末顶点下标)}`(左闭右开),
    由 builder 在累加几何时顺手记下 —— 那段几何是谁建的,建的时候就
    知道,不需要事后靠距离去猜。

    返回实际绑上的顶点数,供 builder 报账。
    """
    me = mesh_obj.data
    n = len(me.vertices)
    assigned = [False] * n

    for bname, (lo, hi) in ranges.items():
        if bname not in arm_obj.data.bones:
            raise KeyError(
                f"蒙皮目标骨 {bname!r} 不在骨架里。可用骨:"
                f"{sorted(b.name for b in arm_obj.data.bones)}"
            )
        idx = [i for i in range(max(0, lo), min(hi, n)) if not assigned[i]]
        # ⚠️ 空区间**报错,不 continue** —— 而且建组要放在这一步之后。
        #
        #    这里原先写的是 `vg = ...new(...)` 然后 `if not idx: continue`,
        #    也就是**先把组建出来,再判定它有没有点**。后果是空组看着
        #    和满组一模一样(`vertex_groups.get(name)` 非 None),
        #    而下游 `07_characters` 报的 `bones_without_verts` 判据恰恰
        #    就是"有没有这个组"。本项目已经实测到过这个状态:
        #
        #        19 个组、其中 18 个是空的,`pelvis` 一个组装着全部 168 个点
        #
        #    而它报出来是 `groups=19 / skinned=168 / nov=[prop_R, root]` ——
        #    **每一个数都和绑对了时相同**。整具身体只跟着骨盆动,
        #    因为 rest pose 烤在网格坐标里,图上看仍然是个人。
        #
        #    空区间的真因是 `(lo, hi)` 被 `min/max` 撑成了不连续的
        #    大区间、里面的点被先遍历到的骨占走了。区间登记侧现在
        #    也会拦(见 `07_characters._seg`),这里是第二道。
        if not idx:
            taken = sorted({
                mesh_obj.vertex_groups[g.group].name
                for i in range(max(0, lo), min(hi, n))
                for g in me.vertices[i].groups
            })
            raise ValueError(
                f"骨 {bname!r} 登记了顶点区间 ({lo}, {hi}),"
                f"其中**一个顶点也没分到** —— 区间里的点已被先遍历到的骨"
                f"占走(实际占住的是 {taken})。区间重叠,或不连续。"
            )
        vg = mesh_obj.vertex_groups.get(bname) or mesh_obj.vertex_groups.new(name=bname)
        vg.add(idx, 1.0, "REPLACE")
        for i in idx:
            assigned[i] = True

    # ⚠️ 没被任何区间覆盖的顶点 —— 报错,不静默。
    #    漏掉的顶点**不会报错**:它们不带任何顶点组,在 Blender 里就是
    #    "不动",导出后仍是"不动"。一具 99% 正常的身体上挂着几块不动的
    #    碎片,在远景里根本看不出来 —— 而它会跟着道具一路到交付。
    #    这和本项目"汇总说绑好了、明细里有没绑的"是同一个形状。
    orphan = [i for i in range(n) if not assigned[i]]
    if orphan:
        raise ValueError(
            f"{mesh_obj.name!r}:有 {len(orphan)} 个顶点没有任何骨骼权重"
            f"(前几个下标 {orphan[:8]})。它们在网页里不会跟随骨骼运动 —— "
            f"检查 build 侧记录的顶点区间是否有缝。"
        )

    mesh_obj.parent = arm_obj
    mesh_obj.matrix_parent_inverse = arm_obj.matrix_world.inverted()
    mod = mesh_obj.modifiers.new(name="Armature", type="ARMATURE")
    mod.object = arm_obj
    mod.use_vertex_groups = True
    return len(assigned)


def mirror_side(name: str) -> str:
    """`thigh_L` → `thigh_R`,反之亦然。不属这两侧的原样返回。"""
    if name.endswith("_L"):
        return name[:-2] + "_R"
    if name.endswith("_R"):
        return name[:-2] + "_L"
    return name


def pose_landing(pose_name: str) -> float:
    """
    这个姿态**最低的那只脚**的脚底标高(m)。

    用途:把人物放到地面上时,不能用"髋高"或"脚骨位置"去对 ——
    蹲姿里脚骨会被 FK 抬起来(`vendor` 的小腿后折把脚拉到髋下),
    照脚骨摆会把整个人埋进地里。摆位必须看**脚底包围盒**,
    而这个函数给的就是它。
    """
    bones = fk(Ch.POSES[pose_name])
    lo = None
    for side in ("L", "R"):
        head, tail = bones[f"foot_{side}"]
        z = min(head.z, tail.z) - Ch.SOLE_Z
        lo = z if lo is None else min(lo, z)
    return float(lo if lo is not None else 0.0)


def _self_check() -> None:
    """导入即跑:关节角表与出生姿态必须自洽。"""
    errs: list[str] = []

    for pname in Ch.POSES:
        try:
            bones = fk(Ch.POSES[pname])
        except Exception as exc:  # noqa: BLE001
            errs.append(f"姿态 {pname!r} FK 失败:{exc}")
            continue
        missing = [b for b in PARENT if b not in bones]
        if missing:
            errs.append(f"姿态 {pname!r} 算不出这些骨:{missing}")

    # 出生姿态下指尖应落在 config 声明的那个标高上。这条**交叉验了两处**:
    # `fk()` 的骨长是否守恒,以及 `REST` 与 `fingertip_z()` 是否说的是同一件事。
    stand = fk(Ch.POSES["walk"])
    tip = stand["hand_L"][1].z
    want = Ch.fingertip_z()
    if abs(tip - want) > 1e-6:
        errs.append(
            f"出生姿态指尖 {tip:.4f}m 与 Character.fingertip_z() {want:.4f}m 不符 —— "
            f"REST 里的肢长与比例声明对不上了"
        )

    # 骨架不能有环。`PARENT` 是手写的,写错父子关系不报错,
    # 只会让 FK 少算几根骨,而少算的骨在网格上表现为"某段不动"。
    for b in PARENT:
        seen, cur = set(), b
        while cur is not None:
            if cur in seen:
                errs.append(f"PARENT 里 {b!r} 的父链成环")
                break
            seen.add(cur)
            cur = PARENT[cur]

    # —— 横向偏移必须活着传到末端 ——
    #
    # 这两条盯的是**同一类失效**:子骨的头被吸到父骨的中线/尾端上,
    # 于是左右两侧的关节全部并拢。它不会报错、不会让三角面数变化,
    # 渲染出来仍然"是个人",只是成了**一根棍**。本项目刚修过一次
    # (见 `fk()` 里那段说明),所以在这里钉住,而不是靠下次看预览图。
    for side, sx in (("L", -1.0), ("R", 1.0)):
        th = stand[f"thigh_{side}"][0].x
        if abs(th - sx * Ch.HIP_X) > 1e-6:
            errs.append(
                f"站立时 thigh_{side} 的髋关节 x = {th:.4f},应为 "
                f"{sx * Ch.HIP_X:.4f} —— 横向偏移在 FK 里丢了"
            )
        sh = stand[f"upperarm_{side}"][0].x
        if abs(sh - sx * Ch.SHOULDER_X) > 1e-6:
            errs.append(
                f"站立时 upperarm_{side} 的肩关节 x = {sh:.4f},应为 "
                f"{sx * Ch.SHOULDER_X:.4f} —— 横向偏移在 FK 里丢了"
            )
        # 脚也要在髋的正下方(站立姿态没有侧摆)
        ft = stand[f"foot_{side}"][0].x
        if abs(ft - sx * Ch.HIP_X) > 1e-6:
            errs.append(
                f"站立时 foot_{side} 的踝 x = {ft:.4f},跑出了髋线 "
                f"{sx * Ch.HIP_X:.4f} —— 腿链被父骨的旋转带偏了"
            )

    if errs:
        raise AssertionError("rig_utils 自检失败:\n  " + "\n  ".join(errs))


_self_check()
