"""
汴河虹桥(贯木拱桥)—— 程序化生成。

形制依据
--------
《东京梦华录》:"其桥无柱,皆以巨木虚架,饰以丹雘,宛如飞虹"。
    「无柱」→ **没有桥墩**;
    「巨木虚架」→ **编木(贯木)拱**,即用直木互相编织成拱。

结构原理
--------
两个独立的**折线拱系统**互相搭置,各自都不稳定,合起来才成拱:

    第一系统  10 组,每组 3 根**等长**拱骨,组间首尾相接(共 30 根)
    第二系统  11 组,每组 **2 长 2 短**共 4 根拱骨(共 44 根)

两系统的节点**互相错开半个组**,所以一者的节点正落在另一者构件的跨中,
形成"你压我、我托你"的互相支承。

⚠️ **全桥无榫卯、无铁钉**,所有交点靠**麻索捆扎**。
   这一点是刻意为之:北宋虹桥原构确实是捆扎做法,榫卯是南渡之后
   闽浙廊桥的演进形态。参考文章里要求做榫卯,本作品**不做**,
   因为做了反而破坏宋代感。见 docs/01-复原依据与考据.md。

⚠️ **已知简化**(如实声明,见 docs/08-已知局限):
   真实的贯木拱,两系统在同一弧面上**逐点上下穿插**(第一系统的某根
   拱骨在甲交点压住第二系统,到乙交点又钻到它下面),正是这种交错
   把两个系统互相锁死。
   本模型把两系统做成**同心的内外两层**折线拱(内层偏内、外层偏外,
   偏心量见 config.Bridge.SYS1/2_RADIAL_OFFSET),在跨中呈嵌套关系,
   只在两端起拱处真实交叉。
   这是为控制几何复杂度做的简化 —— 结构原理、构件数、无榫无钉、
   索绑这些**形制红线都保留了**,但"逐点穿插"的编织细节没有还原。

⚠️ **索绑是分层的**(v2 起):第一系统的节点捆第一系统、第二系统的
   节点捆第二系统,各捆各的一层。真实虹桥的两系统是**互相支承**
   关系,并不存在一根绳子把两层一起箍住的做法 —— v1 那样做,
   渲染出来是一串挂在拱上的大铁圈。详见文件内索绑段的说明。
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

# 桥面在拱轴之上的抬升量(拱骨顶面 + 桥板半厚)
DECK_RADIAL_OFFSET = (
    C.Bridge.SYS2_RADIAL_OFFSET + C.Bridge.SYS2_DEPTH / 2 + C.Bridge.DECK_THICKNESS / 2
)

# 两片拱肋的横向位置(桥面半宽内侧)
RIB_Y = C.Bridge.DECK_WIDTH / 2 - 0.5

# 桥面板条数。比拱骨密,让桥面读起来是一条平顺的弧,而不是折线。
DECK_SEGMENTS = 40


def arc_point(theta: float, radius: float, y: float = 0.0) -> Vector:
    """
    拱轴上一点的坐标。

    拱轴是 XZ 平面内的一段圆弧:
        x = r·sin θ
        z = center_y + r·cos θ
    θ = 0 为拱顶,θ = ±half_angle 为起拱点(此时 z = 0)。
    """
    return Vector(
        (
            radius * math.sin(theta),
            y,
            C.Bridge.center_y() + radius * math.cos(theta),
        )
    )


def tangent_at(theta: float) -> Vector:
    """拱轴在该点的切向(沿弧线前进方向)。"""
    return Vector((math.cos(theta), 0.0, -math.sin(theta)))


def add_arch_beam(
    builder: BU.MeshBuilder,
    t0: float,
    t1: float,
    radius: float,
    y: float,
    *,
    radial: float,
    transverse: float,
) -> None:
    """
    沿拱轴放一根拱骨。

    ⚠️ 这个包装函数存在的唯一理由:**`add_box` 与 `add_torus` 的
       v/w 约定是镜像的,看代码极易看反**。

        `_basis(u, hint)` 的实现是 `v = hint × u`,`w = u × v`,不是
        "把 hint 对 u 做正交化"。于是:

            add_box(hint = +Y)   →  v = +Y × u = **径向**
                                    w = u × v  = **+Y 横桥向**
            add_torus(内部 hint = +Z) → v = **+Y 横桥向**
                                        w = **径向**

        两者正好相反。所以在 `add_box` 里 `depth` 落在**径向**、
        `width` 落在**横桥向** —— 与 config 的命名一致
        (`SYS*_DEPTH` = 径向厚、`SYS*_WIDTH` = 横向宽),而在
        `add_torus` 里 `major_r` 才是横桥向。

        本项目在写这段代码时真的推错过一次(以为 add_box 的 depth
        落在横桥向)。当时的推理过程完全自洽、看不出破绽,是
        validate_scale.py 量了几何才发现对不上。所以这里不再靠
        "读注释理解约定",而是把参数名直接写成 `radial` / `transverse`,
        并留一条断言在 tasks/validate_scale.py 里长年盯着:

            bridge.section_transverse —— 无横梁窗口内量到的横桥向净宽,
                                         必须等于 max(SYS*_WIDTH)
            bridge.crown_radial       —— 拱顶上下缘的 z,必须等于
                                         按 SYS*_DEPTH 算出的值

        谁把这两个方向再弄反一次,构建会直接失败。
    """
    builder.add_box(
        arc_point(t0, radius, y),
        arc_point(t1, radius, y),
        depth=radial,        # → v = 径向
        width=transverse,    # → w = 横桥向
        hint=Vector((0.0, 1.0, 0.0)),
    )


# --------------------------------------------------------------------------
# 两个拱骨系统
# --------------------------------------------------------------------------


def system1_beams() -> list[tuple[float, float]]:
    """
    第一系统:10 组 × 3 根等长拱骨。

    把整段拱轴的圆心角均分成 30 份,每份一根拱骨。
    圆心角均分 ⇒ 弦长必然相等,这正是"等长拱骨"的几何含义。
    返回 [(θ起, θ止), ...],共 30 段。
    """
    step = C.Bridge.sys1_step()
    ha = C.Bridge.half_angle()
    n = C.Bridge.SYS1_GROUPS * C.Bridge.SYS1_PER_GROUP
    return [(-ha + k * step, -ha + (k + 1) * step) for k in range(n)]


def system2_beams() -> list[tuple[float, float, str]]:
    """
    第二系统:11 组 × (2 长 2 短)。

    每组跨越的角度与第一系统的一组相同(3 个 Δ1),但组内切成
    短(0.5Δ1) / 长(1Δ1) / 长(1Δ1) / 短(0.5Δ1) 四段 ——
    合计 3Δ1,与一组对齐。

    整组相对第一系统**偏移半个组宽**(1.5Δ1),于是第二系统的节点
    正落在第一系统构件的跨中,两者互相支承。
    11 组共 33Δ1,比第一系统的 30Δ1 宽出 1.5Δ1 ——
    即第二系统在两端**各外伸 1.5Δ1**,压到金刚墙上。

    返回 [(θ起, θ止, "long"|"short"), ...],共 44 段。
    """
    step = C.Bridge.sys1_step()
    ha = C.Bridge.half_angle()
    group_span = step * C.Bridge.SYS1_PER_GROUP  # = 3Δ1

    out: list[tuple[float, float, str]] = []
    for m in range(C.Bridge.SYS2_GROUPS):
        # 起点 = 第一系统起点 - 1.5Δ1 + m·3Δ1
        base = -ha - group_span / 2 + m * group_span
        offsets = [
            (0.0, 0.5, "short"),
            (0.5, 1.5, "long"),
            (1.5, 2.5, "long"),
            (2.5, 3.0, "short"),
        ]
        for a, b, kind in offsets:
            out.append((base + a * step, base + b * step, kind))
    return out


def node_angles_system1() -> list[float]:
    """第一系统的全部节点角。30 根拱骨首尾相接 ⇒ 31 个节点。"""
    step = C.Bridge.sys1_step()
    ha = C.Bridge.half_angle()
    n = C.Bridge.SYS1_GROUPS * C.Bridge.SYS1_PER_GROUP
    return [-ha + k * step for k in range(n + 1)]


def node_angles_system2() -> list[float]:
    """
    第二系统的全部节点角(去重)。

    每组有 5 个节点,但相邻组首尾重合,故 11 组共 11×4+1 = 45 个。
    索绑就打在这些节点上。
    """
    step = C.Bridge.sys1_step()
    ha = C.Bridge.half_angle()
    group_span = step * C.Bridge.SYS1_PER_GROUP

    angles: list[float] = []
    for m in range(C.Bridge.SYS2_GROUPS):
        base = -ha - group_span / 2 + m * group_span
        for a in (0.0, 0.5, 1.5, 2.5):
            angles.append(base + a * step)
    # 末组末端
    angles.append(-ha - group_span / 2 + C.Bridge.SYS2_GROUPS * group_span)
    return angles


# --------------------------------------------------------------------------
# 主构建
# --------------------------------------------------------------------------


def build() -> dict:
    """生成虹桥,返回统计信息。"""
    # ⚠️ 是 clear_scene_once 而不是 clear_scene。
    #    阶段 2 起本脚本会和其他 8 个 builder 在同一个 Blender 会话里顺序执行,
    #    裸调 clear_scene 会把前面已建好的东西全部抹掉。
    BU.clear_scene_once()
    mats = BU.MaterialLibrary()
    coll = BU.get_collection("虹桥")

    wood = mats.get("wood_old", C.Palette.WOOD_OLD, roughness=0.88)
    plank_mat = mats.get("wood_plank", C.Palette.WOOD_PLANK, roughness=0.90)
    dark = mats.get("wood_dark", C.Palette.WOOD_DARK, roughness=0.85)
    rope_mat = mats.get("rope", C.Palette.ROPE, roughness=0.95)
    earth = mats.get("earth", C.Palette.EARTH, roughness=1.0)

    r1 = C.Bridge.radius() + C.Bridge.SYS1_RADIAL_OFFSET
    r2 = C.Bridge.radius() + C.Bridge.SYS2_RADIAL_OFFSET
    r_deck = C.Bridge.radius() + DECK_RADIAL_OFFSET

    arch = BU.MeshBuilder("虹桥_拱骨")      # 两系统拱骨 + 横梁
    rope = BU.MeshBuilder("虹桥_索绑")      # 麻索捆扎
    deck = BU.MeshBuilder("虹桥_桥面")      # 桥板
    rail = BU.MeshBuilder("虹桥_栏杆")      # 栏柱与扶手
    abut = BU.MeshBuilder("虹桥_金刚墙")    # 两岸桥台

    # —— 两片拱肋上的拱骨 ——
    ribs = (-RIB_Y, RIB_Y)
    s1 = system1_beams()
    s2 = system2_beams()

    for y in ribs:
        for t0, t1 in s1:
            add_arch_beam(
                arch, t0, t1, r1, y,
                radial=C.Bridge.SYS1_DEPTH,
                transverse=C.Bridge.SYS1_WIDTH,
            )
        for t0, t1, _kind in s2:
            add_arch_beam(
                arch, t0, t1, r2, y,
                radial=C.Bridge.SYS2_DEPTH,
                transverse=C.Bridge.SYS2_WIDTH,
            )

    # —— 索绑 ——
    #
    # ⚠️ 这里与 v1 的写法完全不同,是看着渲染图改的。
    #
    # v1 的做法:**每个节点套一个环,把两系统拱骨合成的整条束(约 1m 厚)
    #   一起箍住**。想法是"两个系统捆成一体",但渲染出来是串在拱上的
    #   一排大铁圈,近看像弹簧,完全不是麻绳捆扎的观感。
    #   根因有二:
    #     1. 环是正圆,而拱骨束截面是扁的(径向 ~1m、横桥向 ~0.45m),
    #        正圆必然在横桥向宽出 0.2m 悬在空中;
    #     2. 真实虹桥的索绑是**分层的** —— 每根拱骨与**同系统**的相邻
    #        拱骨在节点处叠置绑扎,两个系统之间是**互相支承**关系
    #        (你压我、我托你),并不需要一根绳子把两层一起捆住。
    #
    # 现在:第一系统的 31 个节点捆第一系统,第二系统的 45 个节点捆第二系统。
    #   环压扁成椭圆,长轴走径向、短轴走横桥向,贴着各自那一层箍紧。
    lash_clear = 0.030      # 索绳外缘相对构件表面的间隙

    def lash_layer(angles: list[float], offset: float, depth: float, width: float) -> int:
        """在某一层拱骨的节点上逐处捆扎。返回索绑数。"""
        n = 0
        for y in ribs:
            for t in angles:
                # 环的轴沿拱轴切向 —— 这样环才"缠"在拱骨上,而不是穿过去。
                # major_r 走 v(横桥向),major_r2 走 w(径向),见 add_torus 的说明。
                rope.add_torus(
                    center=arc_point(t, C.Bridge.radius() + offset, y),
                    axis=tangent_at(t),
                    major_r=width / 2 + lash_clear,
                    major_r2=depth / 2 + lash_clear,
                    minor_r=C.Bridge.LASH_RADIUS,
                    major_seg=10,
                    minor_seg=5,
                )
                n += 1
        return n

    lash_count = lash_layer(
        node_angles_system1(),
        C.Bridge.SYS1_RADIAL_OFFSET,
        C.Bridge.SYS1_DEPTH,
        C.Bridge.SYS1_WIDTH,
    )
    lash_count += lash_layer(
        node_angles_system2(),
        C.Bridge.SYS2_RADIAL_OFFSET,
        C.Bridge.SYS2_DEPTH,
        C.Bridge.SYS2_WIDTH,
    )
    lash_angles = node_angles_system2()

    # —— 横梁:贯穿两片拱肋 ——
    # 5 道,沿拱轴均匀分布。截面比拱骨更粗壮 —— 它是把两片肋连成整体的关键件。
    # 用 add_aabb 而不是 add_box:横梁沿 Y 贯通,截面是 XZ 平面内的矩形,
    # 正是一个轴对齐长方体。它的两端要**伸出拱肋之外**(出头),故 Y 向留 0.30m 余量。
    cb_hx = C.Bridge.CROSS_BEAM_TAN / 2        # 沿 X —— 拱轴切向
    cb_hz = C.Bridge.CROSS_BEAM_RADIAL / 2     # 沿 Z —— 拱轴径向
    for i in range(C.Bridge.CROSS_BEAMS):
        t = -C.Bridge.half_angle() + (i + 0.5) * 2 * C.Bridge.half_angle() / C.Bridge.CROSS_BEAMS
        c = arc_point(t, C.Bridge.radius() + C.Bridge.CROSS_BEAM_OFFSET, 0.0)
        arch.add_aabb(
            Vector((c.x - cb_hx, -RIB_Y - 0.30, c.z - cb_hz)),
            Vector((c.x + cb_hx, RIB_Y + 0.30, c.z + cb_hz)),
        )

    # —— 桥面 ——
    #
    # ⚠️ 这里用 add_box3 而不是 add_box。
    #    add_box 只接受一个轴向(a→b),另两轴靠 hint 叉乘推出来。
    #    早先的写法把桥面宽同时当成 a→b 的跨度和箱体的 width 传进去,
    #    结果每块板都变成"沿对角线拉长、截面 7.8×0.14"的怪东西,
    #    渲染出来是一排倾斜的大板 —— 见 screenshots/blender/bridge_v0_three_quarter.png。
    #    桥面板必须同时控制弦向、横桥向、径向三个方向,只能显式给轴。
    ha = C.Bridge.half_angle()
    for i in range(DECK_SEGMENTS):
        t0 = -ha + i * 2 * ha / DECK_SEGMENTS
        t1 = -ha + (i + 1) * 2 * ha / DECK_SEGMENTS
        tm = (t0 + t1) / 2
        # 弦长取两端点距离,再外延 4% 盖住相邻板之间的缝
        chord = (arc_point(t1, r_deck, 0.0) - arc_point(t0, r_deck, 0.0)).length * 1.04
        tang = tangent_at(tm)
        # 径向(由圆心指向板中心)= 切向 × 横桥向
        radial = tang.cross(Vector((0.0, 1.0, 0.0))).normalized()
        deck.add_box3(
            center=arc_point(tm, r_deck, 0.0),
            u=tang,
            v=Vector((0.0, 1.0, 0.0)),
            w=radial,
            lu=chord,
            lv=C.Bridge.DECK_WIDTH,
            lw=C.Bridge.DECK_THICKNESS,
        )

    # —— 栏杆 ——
    # 栏柱沿弧长均匀分布。弧长 = R·θ,故按弧长步长换算成角度步长。
    r_rail = r_deck + C.Bridge.DECK_THICKNESS / 2
    arc_len = 2 * ha * r_rail
    n_post = max(2, int(round(arc_len / C.Bridge.RAIL_POST_SPACING)))
    rail_y = (-RIB_Y - 0.35, RIB_Y + 0.35)

    post_tops: dict[float, list[Vector]] = {y: [] for y in rail_y}
    post_mids: dict[float, list[Vector]] = {y: [] for y in rail_y}

    for i in range(n_post + 1):
        t = -ha + i * 2 * ha / n_post
        # 两端做成**端柱**:加高加粗。否则栏杆在桥头是"齐刷刷断掉"的,
        # 宋式勾栏在两端本就有望柱收头。
        is_end = i in (0, n_post)
        h = C.Bridge.RAIL_HEIGHT * (1.26 if is_end else 1.0)
        size = C.Bridge.RAIL_POST_SIZE * (1.6 if is_end else 1.0)

        for y in rail_y:
            # 栏柱要立在桥面**实际表面**上,而不是桥面中心线上,
            # 否则柱子会有一半埋进桥板里
            base_pt = arc_point(t, r_deck + C.Bridge.DECK_THICKNESS / 2, y)
            top_pt = base_pt + Vector((0.0, 0.0, h))
            rail.add_box(base_pt, top_pt, depth=size, width=size)
            # 扶手/腰枨一律接在**标准柱高**上,不能接 top_pt ——
            # 端柱高出一截,若拿它当连接点,最后一段扶手会翘起来。
            # 端柱高出扶手的部分正是宋式勾栏的**望柱头**。
            post_tops[y].append(base_pt + Vector((0.0, 0.0, C.Bridge.RAIL_HEIGHT * 0.98)))
            post_mids[y].append(
                base_pt + Vector((0.0, 0.0, C.Bridge.RAIL_HEIGHT * 0.52))
            )

    # 扶手与腰枨:两道横木把柱子连起来,读起来才是宋式勾栏,
    # 只有柱顶一道的话像一排栅栏(第一版的问题)。
    for y in rail_y:
        for a, b in zip(post_tops[y], post_tops[y][1:]):
            rail.add_box(a, b, depth=0.11, width=0.15)
        for a, b in zip(post_mids[y], post_mids[y][1:]):
            rail.add_box(a, b, depth=0.08, width=0.10)

    # —— 金刚墙(两岸桥台) ——
    # 拱脚落在它上面,同时是河岸的挡土墙。用夯土色,与城墙同料。
    # 用 add_aabb 而不是 add_box:这是块实体,不是一根梁。
    #
    # ⚠️ 顶面必须**正好取 z = 0**,即拱轴起拱点所在高度。
    #    v1 取了 0.30,结果拱脚整段埋进墙里,侧视图上桥像是"插"进土块
    #    (见 screenshots/blender/bridge_v1_side.png)。
    #
    # ⚠️ 压顶石**不得向跨内伸出**。伸出去就等于缩小净跨,
    #    会与 config 里净跨 20±0.2 的断言打架。它只加宽横桥向。
    for sign in (-1, 1):
        x_in = sign * (C.Bridge.SPAN / 2)
        x_out = sign * (C.Bridge.SPAN / 2 + 2.6)
        lo_x, hi_x = min(x_in, x_out), max(x_in, x_out)

        # 墙体:自河底以下 2.5m 起,到压顶石底面
        abut.add_aabb(
            Vector((lo_x, -C.Bridge.DECK_WIDTH / 2 - 0.6, -C.River.DEPTH - 2.5)),
            Vector((hi_x, C.Bridge.DECK_WIDTH / 2 + 0.6, -0.25)),
        )
        # 压顶石:横桥向出一圈,读出一条明显的皮条线
        abut.add_aabb(
            Vector((lo_x, -C.Bridge.DECK_WIDTH / 2 - 0.9, -0.25)),
            Vector((hi_x, C.Bridge.DECK_WIDTH / 2 + 0.9, 0.0)),
        )

    # —— 生成物体并打标签 ——
    objs: dict[str, bpy.types.Object] = {}

    o = arch.build(wood, coll)
    if o:
        TU.tag(
            o, "bridge_arch", "bridge",
            label="虹桥",
            zone="虹桥",
            lod="near",
            hotspot=True,
            note="贯木拱,无桥墩;两系统共 74 根拱骨,全部麻索捆扎,无榫无钉",
        )
        objs["arch"] = o

    o = rope.build(rope_mat, coll)
    if o:
        TU.tag(
            o, "bridge_lash", "prop",
            label="麻索捆扎",
            zone="虹桥",
            lod="near",
            note="全桥无榫卯无铁钉,构件靠麻索捆扎成整体",
        )
        objs["rope"] = o

    o = deck.build(plank_mat, coll)
    if o:
        TU.tag(o, "bridge_deck", "bridge", label="桥面", zone="虹桥", lod="near")
        objs["deck"] = o

    o = rail.build(dark, coll)
    if o:
        TU.tag(o, "bridge_rail", "bridge", label="栏杆", zone="虹桥", lod="near")
        objs["rail"] = o

    o = abut.build(earth, coll)
    if o:
        TU.tag(o, "bridge_abutment", "terrain", label="金刚墙", zone="虹桥", lod="mid")
        objs["abutment"] = o

    # —— 统计 ——
    tri = 0
    verts = 0
    for name, builder in (
        ("arch", arch), ("rope", rope), ("deck", deck), ("rail", rail), ("abutment", abut),
    ):
        st = builder.stats()
        verts += st["verts"]
        # 用真的三角面数 —— 原先这里注释写"bmesh 生成的都是四边形",
        # 但索绑与圆柱端盖都不是四边形。理由见 BU.MeshBuilder.stats()
        tri += st["tris"]

    return {
        "objects": len(objs),
        "system1_beams": len(s1) * len(ribs),
        "system2_beams": len(s2) * len(ribs),
        "cross_beams": C.Bridge.CROSS_BEAMS,
        "lash_bindings": lash_count,
        "rail_posts": (n_post + 1) * 2,
        "deck_planks": DECK_SEGMENTS,
        "verts": verts,
        "tris": tri,
        "piers": 0,
        "mortise_joints": 0,
        "lash_angles": lash_angles,
    }


if __name__ == "__main__":
    stats = build()
    print("=" * 68)
    print("虹桥构建完成")
    for k, v in stats.items():
        if k == "lash_angles":
            continue
        print(f"  {k:<18} {v}")
    print(f"  索绑节点角(度)   {[round(math.degrees(a), 2) for a in stats['lash_angles']]}")
    print("=" * 68)
