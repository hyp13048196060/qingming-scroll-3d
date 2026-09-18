"""
形制红线校验 —— **量几何**,不是复述 config。

为什么必须有这个文件
--------------------
用户的要求里有一条硬约束:"不要伪造考古准确性"。这句话如果只写在
文档里,它就不是约束,只是一个愿望 —— 谁都能在 README 里写"严格依据
宋代形制",而桥墩还在模型里。本文件把那条要求变成**构建时会把整个
流程炸掉的断言**。

口径:geometry is truth
-----------------------
本文件**不去读 builder 的统计数字**,也不用 config 的公式去验算 config。
它做的是:

    1. 从场景里取物体,拿到**世界坐标下的真实顶点**;
    2. 量出跨度、矢高、净空、截面宽度……
    3. 拿量到的数与 config 声明的数比。

于是它能抓到"config 是对的、builder 写错了"这一类错误 ——
这类错误**看渲染图完全看不出来**。本项目真的抓到过:拱骨截面的
径向/横向被弄反了(0.50 与 0.46 对调),桥照样好看,但
`Bridge.clearance_actual()` 报出的净空与几何实际值差 2cm。
详见 build/01_bridge.py 里 `add_arch_beam` 的注释。

skip ≠ pass
-----------
阶段 1 只有虹桥,河道/船只/建筑/城门的断言**无对象可量**。
这些条目记成 `skip` 并写明原因,**不计入通过**。
`validate()` 的 `strict=True` 会把任何 skip 判为失败 ——
`run_all.py` 在"所有 builder 都跑过"时启用它,于是阶段 2 完工那天,
漏掉的形制检查会让构建直接失败,而不是悄悄少验几条。

本文件**不能**证明什么(同样重要)
----------------------------------
写在最后 `BOUNDARIES` 里,一并打进报告。简言之:
它能证明"建出来的东西与声明的尺寸一致",**不能**证明"声明的尺寸
符合北宋原物"。后者依赖于唐寰澄那条以"栏柱间距约 1m"为根节点的
推算链,误差性质见 config.py 开头的声明。
"""

from __future__ import annotations

import json
import math
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path

import bpy
from mathutils import Vector

BLENDER_DIR = Path(__file__).resolve().parents[1]
if str(BLENDER_DIR) not in sys.path:
    sys.path.insert(0, str(BLENDER_DIR))

import config as C  # noqa: E402

OUT_PATH = BLENDER_DIR / "out" / "validate.json"

# --------------------------------------------------------------------------
# 容差
#
# 集中在一处。数值小到能抓住 2cm 级的截面弄反,大到不会被浮点噪声
# 或"构件是直弦而非圆弧"的离散化误差误伤。
# --------------------------------------------------------------------------
TOL_LEN = 0.008       # 精确几何量(截面、截面位置)—— 直弦离散化误差量级 ~1mm
TOL_PLAN = 0.02       # 平面位置(节点、轴心)
TOL_DECLARED = 0.05   # 与 config 声明的尺寸比 —— 声明值本身是推算值,不苛求


# ==========================================================================
# 报告
# ==========================================================================


@dataclass
class Check:
    id: str
    title: str
    status: str            # "pass" | "fail" | "skip"
    detail: str            # 人读的一句话,含实测值
    expected: str = ""     # 声明值(人读)
    why: str = ""          # status == "skip" 时必须写清为什么没量
    group: str = ""
    # 这条断言**最早应该在哪个阶段被执行**。strict 模式下只有
    # needs_stage <= 当前阶段 的 skip 才算失败 —— 否则跑 --stage 1
    # 会被一堆"阶段 2 才有的东西"卡住,那种 strict 只会被绕过。
    needs_stage: int = 1


@dataclass
class Report:
    checks: list[Check] = field(default_factory=list)

    def add(
        self,
        cid: str,
        title: str,
        ok: bool,
        detail: str,
        *,
        expected: str = "",
        group: str = "",
        needs_stage: int = 1,
    ) -> None:
        self.checks.append(
            Check(cid, title, "pass" if ok else "fail", detail, expected, "", group, needs_stage)
        )

    def skip(
        self, cid: str, title: str, why: str, *, group: str = "", needs_stage: int = 1
    ) -> None:
        self.checks.append(
            Check(cid, title, "skip", "", "", why, group, needs_stage)
        )

    @property
    def failures(self) -> list[Check]:
        return [c for c in self.checks if c.status == "fail"]

    @property
    def skips(self) -> list[Check]:
        return [c for c in self.checks if c.status == "skip"]

    @property
    def passes(self) -> list[Check]:
        return [c for c in self.checks if c.status == "pass"]


# ==========================================================================
# 测量工具
# ==========================================================================


def _meshes() -> list[bpy.types.Object]:
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


def _world_verts(obj: bpy.types.Object) -> list[Vector]:
    """
    物体的**世界坐标**顶点。

    走 evaluated_get 而不是直接读 obj.data.vertices —— 后者看不到
    修改器。当前各 builder 不加修改器,但导出时 export_apply=True,
    将来也难保不引入一个倒角修改器;那时若这里读的是原始网格,
    校验量到的就**不是真正导出的那份几何**了。
    """
    dg = bpy.context.evaluated_depsgraph_get()
    ev = obj.evaluated_get(dg)
    me = ev.to_mesh()
    mw = ev.matrix_world
    out = [mw @ v.co for v in me.vertices]
    ev.to_mesh_clear()
    return out


def _by_tag(qm_id: str) -> list[bpy.types.Object]:
    return [o for o in _meshes() if o.get("qm_id") == qm_id]


def _by_kind(kind: str) -> list[bpy.types.Object]:
    return [o for o in _meshes() if o.get("qm_kind") == kind]


def _one(qm_id: str) -> bpy.types.Object | None:
    """
    取唯一的那个物体。

    ⚠️ 多于一个就报错,而不是取第一个。qm_id 重复意味着**同一批构件
    被建了两遍**(典型的成因:某个 builder 里 clear_scene 漏了,
    或 run_all 把同一个脚本跑了两趟)。此时取第一个会让校验"通过",
    而场景里其实有一套重叠的几何 —— 这正是本文件最该拦下的事。
    """
    hits = _by_tag(qm_id)
    if len(hits) > 1:
        raise AssertionError(
            f"qm_id={qm_id!r} 在场景中出现 {len(hits)} 次:"
            f"{[o.name for o in hits]}。同一批构件被重复构建,"
            f"多半是某个 builder 未经 clear_scene_once 就重跑了。"
        )
    return hits[0] if hits else None


def _islands(o: bpy.types.Object) -> list[tuple[Vector, Vector]]:
    """
    把一个物体拆成**连通块**,每块给一个世界坐标包围盒。

    ⚠️ 为什么需要这个:`06_props` 为了省物体数,把**同一家铺面、同一种
       材质**的多件道具合成了一个物体(篮+篮+袋 → 一个 `prop_..._bamboo`)。
       代价是那个物体的包围盒是**几件东西的并集** —— 它罩住了一大片空气。
       拿它去量"悬空"只能得到"这一堆里有一件悬着",拿它去量"穿模"更糟:
       两种材质的并集互相套着,永远报重叠,而报出来的体积是**空气的体积**。
       实测:合并之后报 3 对、最大 234L —— 比不拆之前(12 对、65L)还大,
       因为并集比单品大得多。**读数变大不是情况变坏,是尺子变粗了。**

       同一个物体里的连通块**不会互相接触**(每件器物是分开建的),
       所以按连通块拆开就恢复成"一件一块"。拆出来是**几何本身**的属性,
       不依赖建模时的编排,因此拿它当判据不构成自证。

    ⚠️ 它的粒度是"一块实体"而不是"一件器物":例如竹篮是几段圆台摞起来
       的,一段一个块,一只篮是好几个块。这对上面两个断言的**方向是安全**的:
         · 量贴地:最低的那一块就是器物的底 —— 结论一样,还更细;
         · 量穿模:**只有当两块分别属于两件不同器物时**才判 —— 同一件
           器物内部的分段不参与比较。所以不会因为"分段"误报。
    """
    me = o.data
    n = len(me.vertices)
    if n == 0:
        return []
    parent = list(range(n))

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]      # 路径压缩
            a = parent[a]
        return a

    for e in me.edges:
        ra, rb = find(e.vertices[0]), find(e.vertices[1])
        if ra != rb:
            parent[ra] = rb

    groups: dict[int, list[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)

    mw = o.matrix_world
    out: list[tuple[Vector, Vector]] = []
    for idxs in groups.values():
        lo = Vector((math.inf,) * 3)
        hi = Vector((-math.inf,) * 3)
        for i in idxs:
            v = mw @ me.vertices[i].co
            for k in range(3):
                lo[k] = min(lo[k], v[k])
                hi[k] = max(hi[k], v[k])
        out.append((lo, hi))
    return out


def _bbox(objs: list[bpy.types.Object]) -> tuple[Vector, Vector] | None:
    lo = Vector((math.inf,) * 3)
    hi = Vector((-math.inf,) * 3)
    any_v = False
    for o in objs:
        for v in _world_verts(o):
            any_v = True
            for i in range(3):
                lo[i] = min(lo[i], v[i])
                hi[i] = max(hi[i], v[i])
    return (lo, hi) if any_v else None


def _counts(obj: bpy.types.Object) -> tuple[int, int]:
    """(顶点数, 四边形面数)。"""
    return len(obj.data.vertices), len(obj.data.polygons)


def _arch_theta(v: Vector, center_y: float) -> float:
    """把一个落在拱附近的点换算成它在拱轴上的圆心角。"""
    return math.atan2(v.x, v.z - center_y)


# ==========================================================================
# 虹桥
# ==========================================================================


def _check_bridge(rep: Report) -> None:
    G = "虹桥"
    B = C.Bridge

    abut_o = _one("bridge_abutment")
    arch = _one("bridge_arch")
    deck = _one("bridge_deck")
    rail = _one("bridge_rail")
    lash = _one("bridge_lash")

    if not (abut_o and arch and deck and rail and lash):
        missing = [
            n
            for n, v in (
                ("bridge_abutment", abut_o), ("bridge_arch", arch),
                ("bridge_deck", deck), ("bridge_rail", rail), ("bridge_lash", lash),
            )
            if not v
        ]
        rep.skip("bridge.*", "虹桥全部形制断言", f"场景内缺少带标签的物体:{missing}", group=G)
        return

    abut = [abut_o]

    # —— 净跨:两金刚墙**内侧**间距 ——
    #
    # 量的是金刚墙而不是拱骨。拱骨在起拱处会外伸(第二系统两端各伸 1.5Δ1),
    # 用它量跨会偏大;而"净跨"的定义本就是两岸金刚墙之间的空档。
    lo, hi = _bbox(abut)
    left_inner = max(v.x for o in abut for v in _world_verts(o) if v.x < 0)
    right_inner = min(v.x for o in abut for v in _world_verts(o) if v.x > 0)
    span = right_inner - left_inner
    rep.add(
        "bridge.span", "虹桥净跨", abs(span - B.SPAN) <= 0.2,
        f"实测 {span:.4f}m(金刚墙内侧面 −{abs(left_inner):.3f} ↔ +{right_inner:.3f})",
        expected=f"{B.SPAN}±0.2 m", group=G,
    )

    # —— 起拱点高度 ——
    #
    # 金刚墙顶面必须正好是 z = 0,即拱轴的起拱点。它同时是后面量净空
    # 与矢高的基准面 —— 基准错了,下游两个数一起错。
    top = hi.z
    rep.add(
        "bridge.springing", "起拱点标高(金刚墙顶面)", abs(top) <= TOL_PLAN,
        f"实测 z = {top:+.4f}m",
        expected="0.000 m", group=G,
    )

    # —— 拱顶窗口内的实测极值 ——
    #
    # 取圆心角 |θ| ≤ 0.05 的窗口。这个窗口内只落着拱顶那一个节点,
    # 因此窗口里的 z 极值就是拱顶截面上下缘的**精确**位置,
    # 不掺"直弦代替圆弧"的离散化误差。
    cy = B.center_y()
    arch_pts = _world_verts(arch)

    crown = [v for v in arch_pts if abs(_arch_theta(v, cy)) <= 0.05]
    if not crown:
        rep.skip("bridge.crown_radial", "拱顶截面径向尺寸", "拱顶窗口内没有顶点", group=G)
        return
    crown_lo = min(v.z for v in crown)
    crown_hi = max(v.z for v in crown)

    # 上缘 = 第二系统(偏外)拱骨顶面;下缘 = 第一系统(偏内)拱骨底面
    exp_hi = B.RISE + B.SYS2_RADIAL_OFFSET + B.SYS2_DEPTH / 2
    exp_lo = B.RISE + B.SYS1_RADIAL_OFFSET - B.SYS1_DEPTH / 2

    rep.add(
        "bridge.crown_radial_up", "拱顶截面**上缘**(径向)",
        abs(crown_hi - exp_hi) <= TOL_LEN,
        f"实测 z = {crown_hi:.4f}m,按 SYS2_DEPTH 算得 {exp_hi:.4f}m",
        expected=f"RISE + SYS2_OFFSET + SYS2_DEPTH/2 = {exp_hi:.4f} m", group=G,
    )
    rep.add(
        "bridge.crown_radial_down", "拱顶截面**下缘**(径向)",
        abs(crown_lo - exp_lo) <= TOL_LEN,
        f"实测 z = {crown_lo:.4f}m,按 SYS1_DEPTH 算得 {exp_lo:.4f}m",
        expected=f"RISE + SYS1_OFFSET − SYS1_DEPTH/2 = {exp_lo:.4f} m", group=G,
    )

    # —— 横桥向净宽:在一个**没有横梁**的角度窗口里量 ——
    #
    # 为什么必须避开横梁:横梁沿 Y 贯通整桥(还两头出头 0.30m),
    # 它一旦落进窗口就会填满整个 Y 量程,量出来恒等于窗口宽度,
    # 是个恒过的假断言。这里取第 2、3 道横梁之间的空档。
    cb_t = [
        -B.half_angle() + (i + 0.5) * 2 * B.half_angle() / B.CROSS_BEAMS
        for i in range(B.CROSS_BEAMS)
    ]
    t_mid = (cb_t[2] + cb_t[3]) / 2
    win = 0.06
    # 前提检查:窗口确实落在两道横梁之间,且离它们足够远
    gap = cb_t[3] - cb_t[2]
    assert 2 * win < gap - 0.10, (
        f"横桥向测量窗口 {2 * win:.3f} rad 相对横梁间距 {gap:.3f} rad 过宽,"
        f"会有横梁落进来,量出的值恒等于窗口宽度"
    )
    clean = [v for v in arch_pts if abs(_arch_theta(v, cy) - t_mid) <= win]
    rib_y = B.DECK_WIDTH / 2 - 0.5
    pos_offsets = sorted(
        {round(v.y - rib_y, 4) for v in clean if v.y > rib_y + 0.05}
    )
    exp_offsets = sorted([B.SYS2_WIDTH / 2, B.SYS1_WIDTH / 2])
    ok = len(pos_offsets) == 2 and all(
        abs(a - b) <= TOL_LEN for a, b in zip(pos_offsets, exp_offsets)
    )
    rep.add(
        "bridge.section_transverse", "拱骨截面**横桥向**半宽",
        ok,
        f"实测半宽 {pos_offsets},按 SYS*_WIDTH 算得 {[round(x, 4) for x in exp_offsets]}"
        f"(窗口 θ ∈ [{t_mid - win:.3f}, {t_mid + win:.3f}] rad,已避开全部横梁)",
        expected="SYS1_WIDTH/2 与 SYS2_WIDTH/2", group=G,
    )

    # —— 矢高 ——
    #
    # 拱轴的拱顶标高 = 拱顶截面上、下缘的中点。两系统的径向偏心是
    # −0.245 / +0.245(对称),但截面厚度 0.50 / 0.46(不对称),
    # 故中点比 RISE 低 (SYS1_DEPTH − SYS2_DEPTH)/4 = 0.01m。
    # 这在 ±0.15 的容差内,但要**写出来**,否则下一个人会以为
    # 这 1cm 是误差。
    axis_crown = (crown_lo + crown_hi) / 2
    rise = axis_crown - top
    rep.add(
        "bridge.rise", "拱矢(拱顶拱轴 − 起拱点)", abs(rise - B.RISE) <= 0.15,
        f"实测 {rise:.4f}m = 拱顶拱轴 {axis_crown:.4f} − 起拱点 {top:+.4f}"
        f"(截面厚度不对称贡献 −{(B.SYS1_DEPTH - B.SYS2_DEPTH) / 4:.4f})",
        expected=f"{B.RISE}±0.15 m", group=G,
    )

    # —— 拱顶通航净空 ——
    clearance = crown_lo - top
    declared = B.clearance_actual()
    rep.add(
        "bridge.clearance", "拱顶通航净空 ≥ 断言下限",
        clearance >= B.CLEARANCE_MIN,
        f"实测 {clearance:.4f}m ≥ {B.CLEARANCE_MIN}m",
        expected=f"≥ {B.CLEARANCE_MIN} m", group=G,
    )
    # 这一条是**元断言**:验的是"config 报出的数 == 几何实际的数"。
    # 上面 bridge.crown_radial_down 若因截面弄反而失败,这条必然一起失败 ——
    # 两条同时红,基本可以断定是截面语义出错,而不是真的把桥建矮了。
    rep.add(
        "bridge.clearance_matches_formula", "净空实测值 == config 公式值",
        abs(clearance - declared) <= TOL_LEN,
        f"实测 {clearance:.4f}m,clearance_actual() = {declared:.4f}m,"
        f"差 {abs(clearance - declared) * 1000:.1f}mm",
        expected=f"{declared:.4f} m(差 ≤ {TOL_LEN * 1000:.0f}mm)", group=G,
    )
    # 画中"船正穿桥"的情节要求眠桅后的船能过
    rep.add(
        "bridge.clearance_vs_boat", "净空容得下眠桅漕船",
        clearance > C.Boat.AIR_MAX,
        f"净空 {clearance:.4f}m > 眠桅总高 {C.Boat.AIR_MAX}m,余量 "
        f"{clearance - C.Boat.AIR_MAX:.4f}m",
        expected=f"> {C.Boat.AIR_MAX} m", group=G,
    )

    # —— 桥面净宽 ——
    lo_d, hi_d = _bbox([deck])
    w = hi_d.y - lo_d.y
    rep.add(
        "bridge.deck_width", "桥面净宽", abs(w - B.DECK_WIDTH) <= 0.2,
        f"实测 {w:.4f}m", expected=f"{B.DECK_WIDTH}±0.2 m", group=G,
    )

    # —— 构件构成:用顶点数反推,一个构件 8 顶点 / 6 个四边形 ——
    n_arch_beams = (
        B.SYS1_GROUPS * B.SYS1_PER_GROUP * 2
        + B.SYS2_GROUPS * (B.SYS2_LONG_PER_GROUP + B.SYS2_SHORT_PER_GROUP) * 2
    )
    n_arch_parts = n_arch_beams + B.CROSS_BEAMS
    av, af = _counts(arch)
    rep.add(
        "bridge.beam_count", "拱骨与横梁根数",
        av == n_arch_parts * 8 and af == n_arch_parts * 6,
        f"实测 {av} 顶点 / {af} 面 ⇒ {av // 8} 个构件"
        f"(拱骨 {n_arch_beams} + 横梁 {B.CROSS_BEAMS})",
        expected=f"{n_arch_parts} 个构件 = {n_arch_parts * 8} 顶点", group=G,
    )

    lash_nodes_1 = len(_system1_nodes())
    lash_nodes_2 = len(_system2_nodes())
    n_lash = (lash_nodes_1 + lash_nodes_2) * 2
    lv, lf = _counts(lash)
    per = 10 * 5  # major_seg × minor_seg,见 add_torus 调用处
    rep.add(
        "bridge.lash_count", "索绑环数(= 全部节点 × 两片拱肋)",
        lv == n_lash * per,
        f"实测 {lv} 顶点 ⇒ {lv // per} 个环;"
        f"第一系统 {lash_nodes_1} 节点 + 第二系统 {lash_nodes_2} 节点,×2 片肋",
        expected=f"{n_lash} 环 = {n_lash * per} 顶点", group=G,
    )

    # —— 索绑**确实在每个节点上** ——
    #
    # 光有"152 个环"不够 —— could be 152 rings 堆在一个节点上。
    # 这里把每个环的顶点质心算出来(一个 50 顶点的环,其质心恰是环心),
    # 再与理论节点位置逐一配对。
    expected_centers: list[tuple[Vector, str]] = []
    r1 = B.radius() + B.SYS1_RADIAL_OFFSET
    r2 = B.radius() + B.SYS2_RADIAL_OFFSET
    for y in (-(B.DECK_WIDTH / 2 - 0.5), B.DECK_WIDTH / 2 - 0.5):
        for t in _system1_nodes():
            expected_centers.append((_arc_point(t, r1, y), "SYS1"))
        for t in _system2_nodes():
            expected_centers.append((_arc_point(t, r2, y), "SYS2"))

    lash_pts = _world_verts(lash)
    centers = [
        sum(lash_pts[i * per:(i + 1) * per], Vector()) / per
        for i in range(len(lash_pts) // per)
    ]
    unmatched = []
    used: set[int] = set()
    for want, which in expected_centers:
        best, best_d = -1, math.inf
        for i, c in enumerate(centers):
            if i in used:
                continue
            d = (c - want).length
            if d < best_d:
                best, best_d = i, d
        if best >= 0 and best_d <= TOL_PLAN:
            used.add(best)
        else:
            unmatched.append((which, tuple(round(x, 3) for x in want), best_d))
    rep.add(
        "bridge.lash_positions", "索绑落在**每一个**节点上(而非扎堆)",
        not unmatched and len(used) == len(expected_centers),
        f"{len(used)}/{len(expected_centers)} 个节点处配到了索环"
        + (f";未配上 {unmatched[:3]}" if unmatched else ";每个节点恰好一环"),
        expected=f"{len(expected_centers)} 个节点", group=G,
    )

    # —— 无榫卯、无铁钉 ——
    #
    # ⚠️ 这条断言的能力边界要说清楚:
    #    它验的是"场景里没有任何以榫/卯/铁钉命名的物体"以及
    #    "索绑是**结构性存在**的(每个节点都有环)"。
    #    它**不能**证明几何里不存在某种微小的榫舌造型 —— 没有哪条
    #    断言能从三角形网格反推出"这两块木头是绑的还是榫的"。
    #    真正的保障是:本项目自始至终只实现了 add_box/add_aabb/add_torus
    #    三种构件,没有任何生成榫卯的代码路径,且 lash 的位置断言
    #    证明交接处确实由索环表达。
    forbidden = ("榫", "卯", "tenon", "mortise", "nail", "铁钉")
    hits = [
        f"{o.name}({k})" for o in _meshes() for k in list(o.keys()) + [o.name]
        if any(f in str(k) for f in forbidden)
    ]
    rep.add(
        "bridge.no_mortise", "无榫、无卯、无铁钉",
        not hits and len(used) == len(expected_centers),
        "物体名与全部自定义属性中均无榫卯/铁钉字段"
        + (f";发现 {hits}" if hits else "")
        + f";交接处由 {len(used)} 处索环表达",
        expected="榫卯构件数 = 0 且索绑存在", group=G,
    )

    # —— 桥墩 = 0 ——
    #
    # 判据:某个物体的包围盒**完全落在跨内**且**完全在水面以下**。
    # 《东京梦华录》"其桥无柱,皆以巨木虚架" —— 这是全篇最硬的一条。
    piers = []
    for o in _meshes():
        if o.get("qm_kind") in ("boat", "water", "terrain"):
            continue
        bb = _bbox([o])
        if bb is None:
            continue
        (lo_o, hi_o) = bb
        inside_span = lo_o.x > -B.SPAN / 2 + 0.05 and hi_o.x < B.SPAN / 2 - 0.05
        under_water = hi_o.z < -0.05
        if inside_span and under_water:
            piers.append(
                f"{o.name}[x {lo_o.x:.2f}→{hi_o.x:.2f}, z ≤ {hi_o.z:.2f}]"
            )
    rep.add(
        "bridge.no_piers", "桥墩数量 = 0(跨内水下无任何实体)",
        not piers,
        "跨内水下无实体" + (f";发现 {piers}" if piers else " —— 合'其桥无柱,皆以巨木虚架'"),
        expected="0", group=G,
    )

    # —— 栏杆:顶点数反推,顺带校验 radius→桥面→栏杆 整条链 ——
    r_deck = B.radius() + B.SYS2_RADIAL_OFFSET + B.SYS2_DEPTH / 2 + B.DECK_THICKNESS / 2
    r_rail = r_deck + B.DECK_THICKNESS / 2
    n_post = max(2, int(round(2 * B.half_angle() * r_rail / B.RAIL_POST_SPACING)))
    n_rail_boxes = 2 * (n_post + 1) + 2 * n_post + 2 * n_post
    rv, _rf = _counts(rail)
    rep.add(
        "bridge.rail_posts", "栏柱与扶手(由弧长推出的数量)",
        rv == n_rail_boxes * 8,
        f"实测 {rv} 顶点 ⇒ {rv // 8} 个构件;"
        f"按半径链算得 栏柱 {(n_post + 1) * 2} + 扶手/腰枨 {4 * n_post} = {n_rail_boxes}",
        expected=f"{n_rail_boxes} 个构件 = {n_rail_boxes * 8} 顶点", group=G,
    )


def _arc_point(theta: float, radius: float, y: float) -> Vector:
    """与 build/01_bridge.arc_point 同一套公式,在此**独立重写**一遍。

    有意不 import 那边的函数:校验方若直接复用被校验方的代码,
    那段代码本身错了就永远验不出来 —— 两边各算一遍、结果对上,
    才说明公式在两边都被正确理解。
    """
    return Vector(
        (
            radius * math.sin(theta),
            y,
            C.Bridge.center_y() + radius * math.cos(theta),
        )
    )


def _system1_nodes() -> list[float]:
    step = C.Bridge.sys1_step()
    ha = C.Bridge.half_angle()
    n = C.Bridge.SYS1_GROUPS * C.Bridge.SYS1_PER_GROUP
    return [-ha + k * step for k in range(n + 1)]


def _system2_nodes() -> list[float]:
    step = C.Bridge.sys1_step()
    ha = C.Bridge.half_angle()
    group_span = step * C.Bridge.SYS1_PER_GROUP
    out: list[float] = []
    for m in range(C.Bridge.SYS2_GROUPS):
        base = -ha - group_span / 2 + m * group_span
        for a in (0.0, 0.5, 1.5, 2.5):
            out.append(base + a * step)
    out.append(-ha - group_span / 2 + C.Bridge.SYS2_GROUPS * group_span)
    return out


# ==========================================================================
# 汴河
# ==========================================================================


def _check_river(rep: Report) -> None:
    G = "汴河"
    surf = _one("river_surface")
    bed = _one("river_bed")
    revet = _one("river_revetment")

    if surf is None:
        rep.skip("river.width", "汴河河面宽", "场景里没有 qm_id=river_surface", group=G, needs_stage=2)
        rep.skip("river.depth", "汴河水深", "同上", group=G, needs_stage=2)
        rep.skip("river.bank_clear", "驳岸不侵占水面", "同上", group=G, needs_stage=2)
        return

    bb = _bbox([surf])
    assert bb is not None
    lo, hi = bb
    width = hi.x - lo.x
    rep.add(
        "river.width", "汴河河面宽",
        abs(width - C.River.WIDTH) <= 0.3,
        f"实测 {width:.4f} m(x ∈ {lo.x:.3f} … {hi.x:.3f})",
        expected=f"{C.River.WIDTH} ± 0.3", group=G,
    )

    # 水面必须落在 z = 0,否则"两岸街道在 0 标高"这个全局约定就断了,
    # 后面所有"人站在街上""船浮在水上"的判断都会连带错位。
    rep.add(
        "river.level", "水面标高为 0",
        abs(hi.z - 0.0) <= 0.02,
        f"实测水面顶 z = {hi.z:.4f} m",
        expected="0.00 ± 0.02(全场景的标高基准)", group=G,
    )

    if bed is None:
        rep.skip("river.depth", "汴河水深", "场景里没有 qm_id=river_bed", group=G, needs_stage=2)
    else:
        bbb = _bbox([bed])
        assert bbb is not None
        b_lo, b_hi = bbb
        depth = hi.z - b_hi.z
        rep.add(
            "river.depth", "汴河水深",
            abs(depth - C.River.DEPTH) <= 0.15,
            f"实测 {depth:.4f} m(水面 {hi.z:.3f} → 河床顶 {b_hi.z:.3f})",
            expected=f"{C.River.DEPTH} ± 0.15", group=G,
        )
        # 河床必须是平的 —— 本作品如实声明了"不还原水下地形",
        # 若哪天河床变成了起伏面,要么是有人加了没声明的假地形,
        # 要么是放样写歪了。两种都该被拦住。
        bed_flat = (b_hi.z - b_lo.z) < 1.6   # 板厚 0.6 + 余量
        rep.add(
            "river.bed_flat", "河床为平面(如实声明不做水下地形)",
            bed_flat,
            f"河床顶面高差 {b_hi.z - b_lo.z:.3f} m(应为板厚 0.60 量级)",
            expected="≤ 1.6 m", group=G,
        )

    # 驳岸不得伸进水面。伸进去了河面就变窄,而 river.width 量的是
    # 水面网格自己的宽度 —— 它照样"通过",两条断言却互相矛盾。
    # 这正是"多量一条"的价值:单看每一条都绿,合起来是错的。
    if revet is None:
        rep.skip("river.bank_clear", "驳岸不侵占水面", "场景里没有 qm_id=river_revetment", group=G, needs_stage=2)
    else:
        rbb = _bbox([revet])
        assert rbb is not None
        r_lo, r_hi = rbb
        inner = min(abs(r_lo.x), abs(r_hi.x))
        rep.add(
            "river.bank_clear", "驳岸不侵占水面",
            inner >= C.Site.WATER_EDGE - 1e-6,
            f"驳岸最内侧 x = ±{inner:.4f} m,水面边缘 x = ±{C.Site.WATER_EDGE:.4f} m",
            expected=f"≥ ±{C.Site.WATER_EDGE}", group=G,
        )


# ==========================================================================
# 场地(岸线)
# ==========================================================================


def _check_layout(rep: Report) -> None:
    G = "场地"
    road = _one("site_road")
    deck = _one("bridge_deck")

    if road is None or deck is None:
        rep.skip(
            "layout.ramp_join", "桥头引道与桥面接平",
            "需 site_road 与 bridge_deck 同时存在", group=G, needs_stage=2,
        )
    else:
        # 桥头的道面标高(引道靠桥端 + 压在上面的桥头石),取窗口内最高点
        ramp_z = None
        for v in _world_verts(road):
            if (
                C.Site.ABUTMENT_FACE - 0.6 <= v.x <= C.Site.ABUTMENT_FACE + 0.8
                and abs(v.y) <= C.Bridge.DECK_WIDTH / 2 - 0.2
            ):
                ramp_z = v.z if ramp_z is None else max(ramp_z, v.z)

        # 桥面**最外端**的顶面标高。
        #
        # ⚠️ 窗口必须卡在"x 最大的那一撮顶点"上,不能写成一个宽的 x 区间。
        #    拱线在起拱点附近抬升极快:x 从 10.0 收到 8.8,桥面就长了 1.8m。
        #    早先这里写成 `x ≥ SPAN/2 − 1.2`,量到的是 x = 8.8 处的桥面
        #    (z = 2.18),于是报出一个 -2179mm 的"接缝落差" ——
        #    一个量法错误伪装成形制错误。校验器报假警比不报更坏:
        #    它会把人的注意力从真问题上引开。
        deck_pts = _world_verts(deck)
        x_max = max(v.x for v in deck_pts)
        deck_z = None
        for v in deck_pts:
            if v.x >= x_max - 0.05:
                deck_z = v.z if deck_z is None else max(deck_z, v.z)

        if ramp_z is None or deck_z is None:
            rep.skip(
                "layout.ramp_join", "桥头路面与桥面接平",
                f"取样为空(桥头道面 {ramp_z}, 桥面端 {deck_z})—— "
                f"多半是引道没建到 x = ABUTMENT_FACE 处,或桥头石缺失",
                group=G, needs_stage=2,
            )
        else:
            gap = ramp_z - deck_z
            rep.add(
                "layout.ramp_join", "桥头路面与桥面接平",
                0.0 <= gap <= 0.10,
                f"桥头道面顶 {ramp_z:.4f}(x ≈ {C.Site.ABUTMENT_FACE:.1f})"
                f" − 桥面端顶 {deck_z:.4f}(x ≈ {x_max:.3f}) = {gap * 1000:.0f} mm "
                f"(须为小幅正差:桥头石要盖住桥板端角,而不是与之平齐)",
                expected="0 … +100 mm", group=G,
            )

    # 沿河街道必须连成一条:断开的街会让"市井"读成一堆孤立的房子。
    if road is not None:
        rbb = _bbox([road])
        assert rbb is not None
        r_lo, r_hi = rbb
        rep.add(
            "layout.street_continuous", "沿河街道贯通两岸全长",
            r_lo.y <= C.Site.Y_MIN + 1e-6 and r_hi.y >= C.Site.Y_MAX - 1e-6,
            f"街面 y ∈ {r_lo.y:.1f} … {r_hi.y:.1f}",
            expected=f"{C.Site.Y_MIN:.0f} … {C.Site.Y_MAX:.0f}", group=G,
        )


def _check_coverage(rep: Report) -> None:
    """
    **全场无空洞** —— 从高空垂直向下打一片射线,每一条都必须打到东西。

    为什么非要有这一条
    ------------------
    场地曾经有两处**真空**:留给城墙的那条 18.4m 宽带子没人铺地面
    (想着"04_buildings 会来填"),以及河下游 |y| > 120 处地裙给河留的
    通廊尽头。两处都是俯视图上的灰斑、平视图里地平线上的白块。

    而当时形制校验是 **23 条全绿**。它一条都没抓住 —— 因为那 23 条
    量的全是**已经建出来的东西**的尺寸,而"这块地方根本没有东西"
    不是任何一个尺寸能表达的。这是本次场地返工最该记住的一点:

        **只量"建出来的东西"的校验器,永远发现不了"没建"。**

    判据是"垂向射线是否命中",它与具体是哪个 builder 铺的地面无关 ——
    所以后面 04(城墙)、06(道具)、08(装配)往场上加东西时,这条
    不会误报,只在真出现空洞时才响。

    步长的取法:|x| ≤ 120 的核心区用 12m(比已知的两处空洞都窄),
    远处放宽到 40m(那边只有地裙,不可能出现 12m 以上的洞;
    真出现了也先是核心区报出来)。
    """
    G = "场地"
    scene = bpy.context.scene
    dg = bpy.context.evaluated_depsgraph_get()
    down = Vector((0.0, 0.0, -1.0))

    misses: list[tuple[float, float]] = []
    n = 0
    for x in _sweep(-C.Site.FAR, C.Site.FAR, 12.0, 40.0):
        for y in _sweep(-C.Site.FAR, C.Site.FAR, 12.0, 40.0):
            n += 1
            hit, *_ = scene.ray_cast(dg, Vector((x, y, 400.0)), down)
            if not hit:
                misses.append((x, y))

    shown = ", ".join(f"({x:.0f}, {y:.0f})" for x, y in misses[:6])
    rep.add(
        "layout.no_void", "全场无空洞(垂向射线全部命中)",
        not misses,
        f"{n} 条射线,{len(misses)} 条落空"
        + (f";例如 {shown}" if misses else " —— 自河心到地裙外缘、两岸通长均被覆盖"),
        expected="0 条落空", group=G,
    )


def _check_boats(rep: Report) -> None:
    """
    船只形制 —— 吃水、眠桅总高、不穿岸、不撞桥。

    **分组靠标签,不靠名字。** 一条船在场景里是好几个物体(船壳、
    舱篷、人字桅、舵、橹),它们由 `qm_parent == <bid>` 归到一起,
    船壳也写这一项、值等于自己的 bid。最早船壳不写,于是"一条船的
    全部物体"只能靠名字前缀去凑 —— 而那正是本项目在桅/舵的驱动
    接口上明确否掉过的做法。

    ⚠️ **为什么这里量的是几何而不是读 qm_air/qm_draft 声明值**

       声明值和几何都在 `03_boats.py` 里,由同一批常量算出。只读声明
       等于把常量抄了一遍,常量写错时**两边一起错、校验照样全绿**。

       所以这里一律从世界坐标顶点量:吃水量到**实测水面**,总高量到
       **实测最高顶点**。这样"船浮得太高""桅没真正放平""水面标高
       变了"都能被抓到 —— 而这三种错,读声明值一种都发现不了。
    """
    G = "船只"
    groups = _boat_groups()
    if not groups:
        rep.skip(
            "boat.draft", "漕船满载吃水 ≤ 上限",
            "场景里没有 qm_kind=boat 且带 qm_parent 的物体",
            group=G, needs_stage=2,
        )
        return

    water = _one("river_surface")
    if water is None:
        for cid, title in (
            ("boat.draft", "漕船满载吃水 ≤ 上限"),
            ("boat.air", "桅顶总高 ≤ 上限"),
            ("boat.within_bank", "船体不出水面"),
            ("boat.air_clear", "立桅船不在桥的纵向走廊内"),
        ):
            rep.skip(cid, title, "没有 river_surface,无法确定水线", group=G, needs_stage=2)
        return

    lo_w, hi_w = _bbox([water])
    water_z = hi_w.z                  # 水面顶面 —— 所有吃水/总高都以它为基准

    # —— 吃水 ——
    #
    # 判据:船壳最低点到水面的距离 == qm_draft,且 qm_draft ≤ 上限。
    #
    # 只量**船壳**:橹尾没入水下 1.7m、舵杆伸到 −1.27m,拿整条船的
    # 包围盒去量"吃水",量到的是橹和舵,不是船。
    # 船壳的判据就是"带 qm_draft 的那一件" —— 这个标签由 03_boats
    # 只写在船壳上,并附了为什么。
    rows: list[str] = []
    bad: list[str] = []
    over: list[str] = []
    beached: list[str] = []
    n_hull = 0
    for bid, objs in sorted(groups.items()):
        hull = next((o for o in objs if o.get("qm_draft") is not None), None)
        if hull is None:
            continue
        n_hull += 1
        # 上岸的船**没有吃水可言**,不能进这一项的分母 —— 它不参与
        # 实测,列进"实测/声明"表里就是拿一个没量过的行充数。
        # 它的判据在 within_bank 里,而且是反向的(必须在岸上)。
        if hull.get("qm_beached"):
            beached.append(bid)
            continue
        d_decl = float(hull["qm_draft"])
        lo_h, _ = _bbox([hull])
        d_meas = water_z - lo_h.z
        rows.append(f"{bid} 实测 {d_meas:.3f} / 声明 {d_decl:.3f}")
        if abs(d_meas - d_decl) > TOL_DECLARED:
            bad.append(f"{bid}(实测 {d_meas:.3f} ≠ 声明 {d_decl:.3f})")
        if d_decl > C.Boat.DRAFT_MAX + 1e-9:
            over.append(f"{bid}({d_decl:.3f})")

    # 计数分开写:f"{n_hull} 条船壳"放在只列了 afloat 船的表头上,
    # 是**数不对文** —— 6 条船壳、表里 5 条,读的人会以为丢了一条。
    n_afloat = n_hull - len(beached)
    head = f"{n_hull} 条船壳:{n_afloat} 条在水(实测)、{len(beached)} 条上岸(不在吃水口径内{':' + '、'.join(beached) if beached else ''})"
    rep.add(
        "boat.draft", "漕船满载吃水 ≤ 上限,且与声明一致",
        not bad and not over,
        (f"{head};水面 z = {water_z:.4f};" + "; ".join(rows))
        if not (bad or over)
        else f"不符: {'; '.join(bad + over)}",
        expected=f"|实测 − 声明| ≤ {TOL_DECLARED}m,声明 ≤ {C.Boat.DRAFT_MAX}m",
        group=G,
    )

    # —— 桅顶总高 ——
    #
    # 量**整条船**(含可动件)。眠桅的判据是"水面以上最高点到水面的
    # 距离":橹梢、舵杆都在水面以下或近水,真正顶到桥腹的是桅。
    air_rows: list[str] = []
    air_bad: list[str] = []
    n_air = 0
    for bid, objs in sorted(groups.items()):
        hull = next((o for o in objs if o.get("qm_air") is not None), None)
        if hull is None:
            continue                  # 无桅船不写 qm_air,见 03_boats 的说明
        n_air += 1
        a_decl = float(hull["qm_air"])
        folded = any(int(o.get("qm_folded", 0)) for o in objs)
        # 逐件量,并记下**是哪一件**顶得最高。
        #
        # 这一条很要紧:眠桅之后的最高点未必是桅。主角船实测总高
        # 1.749,而桅倒平后桅顶只有 1.668 —— 差的那 8cm 是别的构件
        # 顶在上面。不报出是哪一件,就只能靠猜;报出来,是橹梢、
        # 眠桅架还是舷墙一眼可辨。
        tops = sorted(
            ((max(v.z for v in _world_verts(o)), str(o.get("qm_id", o.name))) for o in objs),
            reverse=True,
        )
        a_meas = tops[0][0] - water_z
        air_rows.append(
            f"{bid}{'(眠桅)' if folded else '(立桅)'} 实测 {a_meas:.3f} / 声明 {a_decl:.3f}"
            f"(最高件 {tops[0][1]} {tops[0][0]:.3f}"
            + (f",次高 {tops[1][1]} {tops[1][0]:.3f}" if len(tops) > 1 else "")
            + ")"
        )
        # 立桅船**不受 4m 门限约束**(桅高 7.4m 本就过不去,所以它才要
        # 摆在桥的纵向走廊之外,见 boat.air_clear)。门限只对眠桅船成立。
        if folded and abs(a_meas - a_decl) > TOL_DECLARED:
            air_bad.append(f"{bid}(实测 {a_meas:.3f} ≠ 声明 {a_decl:.3f})")
        if folded and a_meas > C.Boat.AIR_MAX + 1e-9:
            air_bad.append(f"{bid}(实测 {a_meas:.3f} > {C.Boat.AIR_MAX})")
        if not folded and abs(a_meas - a_decl) > TOL_DECLARED:
            air_bad.append(f"{bid}(立桅:实测 {a_meas:.3f} ≠ 声明 {a_decl:.3f})")

    rep.add(
        "boat.air", "眠桅后水面以上总高 ≤ 上限,且与声明一致",
        not air_bad,
        # 通过与否都列出逐件明细 —— 失败时更需要知道"最高的是哪一件",
        # 而失败详情里只有差值,反而把诊断信息挤掉了。
        ("不符: " + "; ".join(air_bad) + " || " if air_bad else "")
        + f"{n_air} 条带桅船;" + "; ".join(air_rows),
        expected=f"|实测 − 声明| ≤ {TOL_DECLARED}m,眠桅者 ≤ {C.Boat.AIR_MAX}m",
        group=G,
    )

    # —— 不穿岸 ——
    #
    # 判据分两支,而且**两支都要验**:
    #   未申报上岸的船 → 整条船横向不出水面(|x| ≤ WATER_EDGE)
    #   申报上岸的船   → 整条船横向全在水面之外(min|x| > WATER_EDGE)
    #
    # 第二支是关键。豁免权若能靠"把船挪到岸上"换来,这条检查就形同
    # 虚设 —— 一条舷侧泡在水里的"上岸船"照样全绿。所以申报要用几何
    # 反过来验一遍,豁免本身也是断言。
    bank_rows: list[str] = []
    bank_bad: list[str] = []
    n_afloat = n_beached = 0
    for bid, objs in sorted(groups.items()):
        hull = next((o for o in objs if o.get("qm_draft") is not None), None)
        if hull is None:
            continue
        lo_g, hi_g = _bbox(objs)
        out = max(abs(lo_g.x), abs(hi_g.x))
        inn = min(abs(lo_g.x), abs(hi_g.x))
        if hull.get("qm_beached"):
            n_beached += 1
            bank_rows.append(f"{bid}(上岸)最内侧 |x| {inn:.3f} > {C.Site.WATER_EDGE}")
            if inn <= C.Site.WATER_EDGE:
                bank_bad.append(
                    f"{bid} 申报上岸,但最内侧 |x| = {inn:.3f} ≤ 水面边 "
                    f"{C.Site.WATER_EDGE} —— 有部分船体仍在水面上"
                )
        else:
            n_afloat += 1
            bank_rows.append(f"{bid}(在水)最外侧 |x| {out:.3f} ≤ {C.Site.WATER_EDGE}")
            if out > C.Site.WATER_EDGE + 1e-9:
                bank_bad.append(
                    f"{bid} 最外侧 |x| = {out:.3f} > 水面边 {C.Site.WATER_EDGE}"
                )

    rep.add(
        "boat.within_bank", "船体不出水面(上岸船反向验)",
        not bank_bad,
        (f"{n_afloat} 条在水 + {n_beached} 条上岸;" + "; ".join(bank_rows))
        if not bank_bad else f"不符: {'; '.join(bank_bad)}",
        expected=f"在水: max|x| ≤ {C.Site.WATER_EDGE};"
                 f"上岸: min|x| > {C.Site.WATER_EDGE}",
        group=G,
    )

    # —— 立桅船不在桥的纵向走廊内 ——
    #
    # 走廊范围**从桥的实测几何取**,不写死:桥面加宽,走廊跟着变宽。
    # 立桅总高 7.4m,拱顶净空只有 5.0m 上下 —— 立在桥下就是穿模。
    deck = _one("bridge_deck")
    if deck is None:
        rep.skip(
            "boat.air_clear", "立桅船不在桥的纵向走廊内",
            "没有 bridge_deck,量不出桥的纵向范围", group=G, needs_stage=2,
        )
    else:
        _, d_hi = _bbox([deck])
        corridor = d_hi.y
        clear_bad: list[str] = []
        clear_rows: list[str] = []
        n_raised = 0
        for bid, objs in sorted(groups.items()):
            raised = any(
                int(o.get("qm_folded", -1)) == 0 and o.get("qm_anim") == "mast_fold"
                for o in objs
            )
            if not raised:
                continue
            n_raised += 1
            lo_g, hi_g = _bbox(objs)
            gap = min(abs(lo_g.y) - corridor, abs(hi_g.y) - corridor)
            clear_rows.append(
                f"{bid} y∈[{lo_g.y:.2f}, {hi_g.y:.2f}],离桥 {gap:.2f}m"
            )
            if gap <= 0.0:
                clear_bad.append(
                    f"{bid} 立桅,y∈[{lo_g.y:.2f}, {hi_g.y:.2f}] 与桥的走廊 "
                    f"|y| ≤ {corridor:.2f} 重叠"
                )
        rep.add(
            "boat.air_clear", "立桅船不在桥的纵向走廊内",
            not clear_bad,
            (f"{n_raised} 条立桅船;桥纵向半宽 {corridor:.3f}m(实测);"
             + "; ".join(clear_rows)) if not clear_bad
            else f"不符: {'; '.join(clear_bad)}",
            expected=f"立桅船整体 |y| > {corridor:.2f}",
            group=G,
        )

    # —— 眠桅这个情节本身成不成立 ——
    #
    # 立桅总高必须**真的过不去**桥。若哪天有人把桥抬高了、或把桅缩短了,
    # 使立桅也能过,那么"眠桅过桥"就从必然情节退化成一个随便的摆设 ——
    # 画面上看不出来,但它已经不是原画那件事了。所以这条要正面断言。
    if deck is not None:
        # 立桅总高**从桅的网格量**,不读 C.Boat.MAST_HEIGHT。
        # 桅的网格建在自身轴心上、沿局部 z 从 0 到桅长,所以
        #   "立起来有多高" = 轴心的世界 z + 网格局部 z 最大值
        # 这个数不受 rot_x(眠桅折角)影响 —— 折角在物体旋转上,
        # 不在网格上。于是它量的是"这根桅立起来能到多高",
        # 与 config 声明值互相独立。
        mast = next((o for o in _meshes() if o.get("qm_anim") == "mast_fold"), None)
        if mast is None:
            rep.skip(
                "boat.mast_needs_fold", "立桅确实过不去桥,故必须眠桅",
                "场景里没有 qm_anim=mast_fold 的物体", group=G, needs_stage=2,
            )
        else:
            clear = _bridge_clearance()
            raised_top = mast.matrix_world.translation.z + max(
                v.co.z for v in mast.data.vertices
            )
            rep.add(
                "boat.mast_needs_fold", "立桅确实过不去桥,故必须眠桅",
                raised_top > clear,
                f"实测立桅总高 {raised_top:.3f}m > 实测拱顶净空 {clear:.4f}m,"
                f"高出 {raised_top - clear:.3f}m —— 眠桅是必要条件,不是装饰"
                f"(桅长取自网格局部 z 极值,与 config 的 MAST_HEIGHT "
                f"{C.Boat.MAST_HEIGHT} 互相独立)",
                expected="立桅总高 > 拱顶净空",
                group=G,
            )

    # —— 眠桅架真的托住桅了吗 ——
    #
    # 眠桅船在船尾有个架子托住倒下来的桅。这条断言看起来琐碎,其实
    # 管的是"架子是不是白建的":桅悬在架子上方 3cm,渲染图上和
    # "托住了"几乎分不出来,但它就是个错。实测踩过 —— 架子高度原先
    # 由闭式解 `中心线 − MAST_R` 反推,而人字桅在该站位的 y 向厚度
    # 只有 0.054m(不到 MAST_R 的七成),于是桅悬空 33mm。
    #
    # 判据:属具在该站位的最高点,必须落在桅身下缘的 [−50mm, +15mm] 内。
    #   负 = 属具伸进桅里(刻意如此:留缝隙看得见,伸进去看不见)
    #   正 = 桅悬在架子上方
    #
    # ⚠️ 上界 +15mm 是**按已知缺陷定的**,不是拍脑袋的容差:
    #    那次闭式解的错正好给出 **+33mm** 悬空。容差若比待防的缺陷还宽,
    #    这条检查就永远不会响 —— 它会稳稳通过,同时把 bug 放过去。
    #    容差必须**严于**缺陷,检查才有意义。当前几何给的是 −12mm
    #    (伸进去一点),所以 +15mm 对正确几何有 27mm 余量,对已知缺陷
    #    有 18mm 余量,两边都留得住。
    #
    # 这条不是空想:写这条检查时我先把容差定成了 +40mm,一做反向验证
    # 就发现它连当初那个 bug 都放得过去 —— 等于白写。
    crutch_rows: list[str] = []
    crutch_bad: list[str] = []
    n_crutch = 0
    for bid, objs in sorted(groups.items()):
        mast = next((o for o in objs if o.get("qm_part") == "mast"), None)
        fit = next((o for o in objs if o.get("qm_part") == "fit"), None)
        if mast is None or fit is None or not mast.get("qm_folded"):
            continue
        n_crutch += 1
        # 站位 = **属具里最高那一点**所在的 y。不读 config —— 架子挪了
        # 地方,取样窗口跟着挪,量的始终是真的那一处。
        #
        # 这里有个假设:属具里最高的就是眠桅架。它成立(其余属具是
        # 系缆桩、橹担、拖岸垫木,都矮得多),但**假设不能默默成立** ——
        # 万一哪天真有更高的属具,取样点会挪到一个和桅无关的地方,
        # 那时这条检查要么误报、要么更糟地误过。所以下面把"取样点
        # 必须落在桅身的纵向范围内"也一并断言掉:不满足就是失败,
        # 不是跳过。一个会静默跳过的检查等于没有检查。
        fit_pts = _world_verts(fit)
        mast_pts = _world_verts(mast)
        if not fit_pts or not mast_pts:
            crutch_bad.append(f"{bid}(属具或桅没有顶点,量不了)")
            continue
        y0 = max(fit_pts, key=lambda p: p.z).y
        m_lo = min(p.y for p in mast_pts)
        m_hi = max(p.y for p in mast_pts)
        if not (m_lo <= y0 <= m_hi):
            crutch_bad.append(
                f"{bid} 属具最高点在 y={y0:.2f},落在桅身纵向范围"
                f"[{m_lo:.2f}, {m_hi:.2f}]之外 —— 它可能不再是眠桅架,"
                f"取样点已经和桅无关了"
            )
            continue
        band = 0.15
        mast_band = [p for p in mast_pts if abs(p.y - y0) <= band]
        fit_band = [p for p in fit_pts if abs(p.y - y0) <= band]
        t_fit = max(p.z for p in fit_band)
        t_mast = min(p.z for p in mast_band)
        gap = t_mast - t_fit               # >0 = 悬空;<0 = 伸进去
        crutch_rows.append(
            f"{bid} 属具顶 {t_fit:.3f} / 桅下缘 {t_mast:.3f} → 间隙 {gap * 1000:+.0f}mm"
        )
        if not (CRUTCH_GAP_MIN <= gap <= CRUTCH_GAP_MAX):
            crutch_bad.append(
                f"{bid}(间隙 {gap * 1000:+.0f}mm 落在 "
                f"[{CRUTCH_GAP_MIN * 1000:+.0f}, {CRUTCH_GAP_MAX * 1000:+.0f}] 之外)"
            )

    rep.add(
        "boat.crutch", "眠桅架确实托住桅(不悬空、不过分穿入)",
        not crutch_bad,
        (f"{n_crutch} 条眠桅船;" + "; ".join(crutch_rows))
        if not crutch_bad else f"不符: {'; '.join(crutch_bad)}",
        expected=f"属具顶 − 桅下缘 ∈ [{CRUTCH_GAP_MIN}, {CRUTCH_GAP_MAX}]m",
        group=G,
    )


# 眠桅架与桅身下缘之间允许的间隙。**不是容差,是对缺陷的判据** ——
# 上界必须严于已知缺陷(+33mm,见 boat.crutch 里的长注释)。
CRUTCH_GAP_MIN = -0.050
CRUTCH_GAP_MAX = 0.015


def _boat_groups() -> dict[str, list[bpy.types.Object]]:
    """
    场景里的船,按 `qm_parent` 分组。

    判据只有一句:`qm_kind == "boat"` 且带 `qm_parent`。船壳自己也
    带这一项、值等于自己的 bid —— 于是"一条船的全部物体"不需要任何
    名字约定就能取到。见 tag_utils.KNOWN_KEYS 里 qm_parent 的说明。
    """
    groups: dict[str, list[bpy.types.Object]] = {}
    for o in _meshes():
        if o.get("qm_kind") != "boat":
            continue
        bid = o.get("qm_parent")
        if bid:
            groups.setdefault(str(bid), []).append(o)
    return groups


def _bridge_clearance() -> float:
    """
    拱顶通航净空的**实测值**。

    与 `bridge.clearance` 用的是同一套量法,而且是同一段代码——
    起拱面取金刚墙顶面(z),拱顶下缘取拱顶窗口(θ ≤ 0.05)内拱骨
    的最低顶点。窗口是为了避开"直弦代替圆弧"的离散化误差:
    窗口里只落着拱顶那一个节点,极值就是精确位置。

    ⚠️ 这里第一版写错了:按名字去凑 `bridge_sys1`/`bridge_sys2`
       两个物体,而拱其实只建成了**一个** `bridge_arch`。找不到就
       悄悄回退到 `clearance_actual()` 的公式值 —— 于是这条断言
       变成了"拿公式验公式",永远不可能失败。

       这类**回退到声明值**的写法比不写还危险:它看起来是绿的。
       现在找不到几何就返回 None,由调用方明确报错。
    """
    abut = _one("bridge_abutment")
    arch = _one("bridge_arch")
    if abut is None or arch is None:
        raise AssertionError(
            "量净空需要 bridge_abutment 与 bridge_arch;"
            f"实际拿到 {abut!r} / {arch!r}。缺件时不允许回退到公式值——"
            "那会让断言恒真。"
        )
    _, hi_a = _bbox([abut])
    cy = C.Bridge.center_y()
    crown = [v for v in _world_verts(arch) if abs(_arch_theta(v, cy)) <= 0.05]
    if not crown:
        raise AssertionError("拱顶窗口内没有顶点,量不出净空")
    return min(v.z for v in crown) - hi_a.z


def _sweep(lo: float, hi: float, fine: float, coarse: float):
    """
    生成采样坐标:核心区(|v| ≤ 120)按 fine 步长,之外按 coarse。

    核心区加密是因为已知的两处空洞都在那里,而它们都只有十几米宽 ——
    拿 40m 的步长去扫,射线有大概率整个跨过去,于是"无空洞"通过,
    下一轮又得靠肉眼在渲染图上发现。**采样步长必须窄于你要找的东西。**
    """
    v = lo
    while v <= hi + 1e-9:
        yield round(v, 3)
        step = fine if abs(v) <= 120.0 else coarse
        v += step


# ==========================================================================
# 两岸市井、建筑与城门
#
# 这一组的量法有一条共同纪律:**凡是能从几何里量的,就不要读声明**。
# `qm_roof` / `qm_tiles` 只用来**挑选要量的对象**(哪片屋面该有瓦垄),
# 量出来的数一律来自世界顶点。与 boat.draft 那条同一套做法 ——
# 声明里有、几何里没有,才是这些断言真正要抓的事。
# ==========================================================================


def _buildings() -> dict[str, list[bpy.types.Object]]:
    """按 `qm_parent` 把建筑归组。与船只的"一船多件"同构。"""
    out: dict[str, list[bpy.types.Object]] = {}
    for o in _by_kind("building"):
        p = o.get("qm_parent")
        if p:
            out.setdefault(p, []).append(o)
    return out


def _part(group: list[bpy.types.Object], suffix: str) -> bpy.types.Object | None:
    hits = [o for o in group if o.name.endswith(suffix)]
    return hits[0] if len(hits) == 1 else None


def _distinct(values, tol: float = 1e-4) -> list[float]:
    """去重后的升序实数表。用于从顶点坐标里数出**结构性**的采样数。"""
    out: list[float] = []
    for v in sorted(values):
        if not out or v - out[-1] > tol:
            out.append(v)
    return out


def _column_and_leaf_counts(facade: bpy.types.Object) -> tuple[int, int, str]:
    """
    从一个"前檐"物体里**分别**数出柱数与门扇数。

    依据是模块刻意的做法:柱顶一直接到檐口,格子门顶比檐口低
    `DOOR_HEAD_GAP`(0.30m)。于是顶点按 z 分成两簇:

        最高一簇 = 柱顶(每根方料 4 个顶点)
        次高一簇 = 门扇上框

    在下面几个数上,分了组才能一一对上:
        柱数 × 8 + 门扇数 × 48 == 顶点总数
    每一根方料是 8 个顶点,而一扇格子门是 6 根方料(左右边梃、
    上下框、腰串、裙板)= 48 个顶点。整数对得上,分解才算成立;
    对不上就报错,而不是硬取整 —— `add_box` 的顶点数一旦变了,
    这里必须响,不能让"每间几扇"变成一个凑出来的数。

    返回 (柱数, 门扇数, 说明)。说明写清是怎么分的。
    """
    zs = [v.z for v in _world_verts(facade)]
    if not zs:
        return 0, 0, "物体没有顶点"
    top = max(zs)
    n_top = sum(1 for z in zs if z > top - 1e-4)
    if n_top % 4:
        return 0, 0, f"最高一簇有 {n_top} 个顶点,不是 4 的整数倍,无法拆出柱数"
    cols = n_top // 4

    total = len(zs)
    rest = total - cols * 8
    if rest < 0 or rest % 48:
        return cols, 0, (
            f"顶点总数 {total} 减去 {cols} 根柱 ×8 后余 {rest},"
            f"不是一扇格子门(6 根方料 ×8 = 48)的整数倍"
        )
    leaves = rest // 48
    gap = top - max(z for z in zs if z < top - 1e-4)
    return cols, leaves, (
        f"最高一簇 {n_top} 点 = {cols} 根柱(顶 z={top:.2f});"
        f"余 {rest} 点 = {leaves} 扇格子门;柱顶与门顶落差 {gap:.3f}m"
    )


def _check_buildings(rep: Report) -> None:
    G = "市井"
    groups = _buildings()
    roofs = [o for o in _by_kind("building") if "qm_roof" in o]

    # —— roof.whitelist ——
    forms: dict[str, list[str]] = {}
    for o in roofs:
        forms.setdefault(str(o["qm_roof"]), []).append(o.name)
    bad = {f: n for f, n in forms.items() if f not in C.Building.ROOF_WHITELIST}
    forbidden = {f: n for f, n in forms.items() if f in C.Building.ROOF_FORBIDDEN}
    detail = "、".join(f"{f}×{len(n)}" for f, n in sorted(forms.items()))
    if not roofs:
        rep.add("roof.whitelist", "屋面形制 ∈ {庑殿,歇山,悬山},无硬山", False,
                "场景里没有任何写了 qm_roof 的屋面 —— 声明为空,这条断言无从谈起",
                expected="/".join(C.Building.ROOF_WHITELIST), group=G)
    else:
        rep.add("roof.whitelist", "屋面形制 ∈ {庑殿,歇山,悬山},无硬山",
                not bad,
                (f"实测 {detail}" + (f";**含禁止形制** {sorted(bad)}" if bad else
                 ";无硬山(北宋尚无硬山顶)")) if forms else "无屋面",
                expected="/".join(C.Building.ROOF_WHITELIST), group=G)

    # —— building.eave ——
    worst = None
    n_eave = 0
    for bid, grp in sorted(groups.items()):
        plinth = _part(grp, "_plinth")
        roof = _part(grp, "_roof")
        if plinth is None or roof is None:
            continue
        top_plinth = max(v.z for v in _world_verts(plinth))
        low_roof = min(v.z for v in _world_verts(roof))
        clear = low_roof - top_plinth
        n_eave += 1
        if worst is None or clear < worst[1]:
            worst = (bid, clear, top_plinth, low_roof)
    if worst is None:
        rep.skip("building.eave", "檐口最低净高 ≥ 2.40m",
                 "需 04_buildings 产出带 _plinth 与 _roof 的建筑分组", group=G, needs_stage=2)
    else:
        bid, clear, tp, lr = worst
        rep.add("building.eave", "檐口最低净高 ≥ 2.40m", clear >= C.Building.EAVE_MIN,
                f"最不利者 {bid}:台基顶 {tp:.3f} → 屋面最低 {lr:.3f} = **{clear:.3f}m**"
                f"(余量 {clear - C.Building.EAVE_MIN:+.3f});共量 {n_eave} 栋",
                expected=f"≥{C.Building.EAVE_MIN}", group=G)

    # —— lattice.leaves / lattice.ratio ——
    leaf_reports: list[tuple[str, int, int]] = []
    ratio_reports: list[tuple[str, float]] = []
    ratio_bad: list[str] = []
    for bid, grp in sorted(groups.items()):
        facade = _part(grp, "_facade")
        screen = _part(grp, "_screen")
        plinth = _part(grp, "_plinth")
        if facade is None:
            continue
        cols, leaves, how = _column_and_leaf_counts(facade)
        bays = max(1, cols - 1)
        leaf_reports.append((bid, bays, leaves))
        if screen is None or plinth is None:
            continue
        # 格眼占比的分母是**门扇通高**,它只能从"前檐"物体里量:
        # 门扇上框顶(该物体非柱顶部分的最高 z)减去台基顶。
        fz = [v.z for v in _world_verts(facade)]
        top = max(fz)
        leaf_top = max(z for z in fz if z < top - 1e-4)
        plinth_top = max(v.z for v in _world_verts(plinth))
        h_leaf = leaf_top - plinth_top
        sz = [v.z for v in _world_verts(screen)]
        h_glass = max(sz) - min(sz)
        if h_leaf <= 1e-6:
            continue
        r = h_glass / h_leaf
        ratio_reports.append((bid, r))
        lo_r, hi_r = C.Building.LATTICE_GLASS_RATIO
        if not (lo_r <= r <= hi_r):
            ratio_bad.append(f"{bid}={r:.4f}")

    if not leaf_reports:
        rep.skip("lattice.leaves", "格子门每间 4 扇",
                 "需 04_buildings 产出 _facade 物体", group=G, needs_stage=2)
    else:
        want = C.Building.LATTICE_LEAVES
        off = [f"{b}({bays}间{lv}扇)" for b, bays, lv in leaf_reports
               if lv != bays * want]
        tot_bays = sum(b for _, b, _ in leaf_reports)
        tot_leaves = sum(l for _, _, l in leaf_reports)
        rep.add("lattice.leaves", f"格子门每间 {want} 扇", not off,
                f"共 {len(leaf_reports)} 栋、{tot_bays} 间、{tot_leaves} 扇"
                + (";全部合" if not off else f";**不合** {off}"),
                expected=f"每间 {want} 扇", group=G)

    if not ratio_reports:
        rep.skip("lattice.ratio", "格眼高度占比 0.66–0.68",
                 "需 _facade 与 _screen 同时存在,且台基可量", group=G, needs_stage=2)
    else:
        lo_r, hi_r = C.Building.LATTICE_GLASS_RATIO
        vals = [r for _, r in ratio_reports]
        rep.add("lattice.ratio", f"格眼高度占比 {lo_r}–{hi_r}", not ratio_bad,
                f"量 {len(vals)} 扇:最小 {min(vals):.4f}、最大 {max(vals):.4f}"
                + (";全部落在带内" if not ratio_bad else f";**出带** {ratio_bad[:4]}"),
                expected=f"{lo_r}–{hi_r}(腰上 2/3)", group=G)

    # —— tile.row ——
    tiled = [o for o in roofs if "qm_tiles" in o]
    if not tiled:
        rep.skip("tile.row", "筒瓦垄距 0.20–0.24m",
                 "场景里没有写了 qm_tiles 的屋面 —— 没有声明有瓦垄的屋面可量",
                 group=G, needs_stage=2)
    else:
        tlo, thi = C.Building.TILE_ROW_SPACING
        rows: list[str] = []
        bad: list[str] = []
        measured: list[float] = []
        for o in tiled:
            ys = _distinct(v.y for v in _world_verts(o))
            if len(ys) < 3 or len(ys) % 2 == 0:
                bad.append(f"{o.name}: 不同 y 值 {len(ys)} 个,不是 2n+1,数不出垄")
                continue
            n_rib = (len(ys) - 1) // 2
            span = ys[-1] - ys[0]
            step = span / n_rib
            declared = float(o["qm_tiles"])
            ok = (tlo <= step <= thi) and abs(step - declared) <= TOL_DECLARED
            measured.append(step)
            if not ok:
                bad.append(f"{o.name}: {step:.4f}(声明 {declared})")
            rows.append(f"{o.name}:{len(ys)}行→{n_rib}垄 {step:.4f}")
        rep.add("tile.row", f"筒瓦垄距 {tlo}–{thi}m", not bad,
                f"量 {len(tiled)} 片带瓦屋面,垄距 "
                f"{min(measured):.4f}–{max(measured):.4f}(全同则为定值);"
                f"抽样 " + "; ".join(rows[:3])
                + ("" if not bad else f";**出界/与声明不符** {bad[:3]}"),
                expected=f"{tlo}–{thi},且等于 qm_tiles 声明值", group=G)

    # —— 城门 ——
    pier = _one("gate_pier")
    if pier is None:
        for cid, title in (("gate.passage_width", "城门门道净宽 5.6±0.1m"),
                           ("gate.passage_depth", "城门门道进深 19.3±0.2m"),
                           ("gate.passage_taper", "门洞截面为梯形(顶/底 ≈ 0.86)")):
            rep.skip(cid, title, "需 build/04_buildings.py 产出 qm_id=gate_pier",
                     group=G, needs_stage=2)
    else:
        V = _world_verts(pier)
        gy = C.Site.GATE_Y
        z_lo = min(v.z for v in V)
        z_hi = max(v.z for v in V)
        # 底面每个墩台内侧那两条边,离轴线最近 —— 那就是**门道净宽**
        base = [v for v in V if v.z < z_lo + 1e-4]
        top = [v for v in V if v.z > z_hi - 1e-4]
        w_lo = 2.0 * min(abs(v.y - gy) for v in base)
        w_hi = 2.0 * min(abs(v.y - gy) for v in top)
        x0 = min(v.x for v in V)
        x1 = max(v.x for v in V)
        depth = x1 - x0

        want = C.Gate.PASSAGE_WIDTH
        rep.add("gate.passage_width", f"城门门道净宽 {want}±0.1m",
                abs(w_lo - want) <= 0.1,
                f"由墩台底面内侧边量得 **{w_lo:.3f}m**(声明 {want});"
                f"墩台底 {len(base)} 点、顶 {len(top)} 点,离轴线 {abs(C.Site.GATE_Y):.1f}m",
                expected=f"{want}±0.1", group=G)

        want_d = C.Gate.PASSAGE_DEPTH
        rep.add("gate.passage_depth", f"城门门道进深 {want_d}±0.2m",
                abs(depth - want_d) <= 0.2,
                f"由墩台沿 x 的跨度量得 **{depth:.3f}m**"
                f"(x {x0:.3f}→{x1:.3f};声明 {want_d})",
                expected=f"{want_d}±0.2", group=G)

        want_t = C.Gate.PASSAGE_TAPER
        got_t = w_hi / w_lo if w_lo > 1e-9 else 0.0
        rep.add("gate.passage_taper", f"门洞截面为梯形(顶/底 ≈ {want_t})",
                abs(got_t - want_t) <= 0.02,
                f"顶部净宽 {w_hi:.3f} / 底部净宽 {w_lo:.3f} = **{got_t:.4f}**"
                f"(声明 {want_t});矩形截面会量到 1.0000",
                expected=f"{want_t}±0.02", group=G)

    # —— 城墙 ——
    walls = [o for o in _by_kind("gate") if o.name.startswith("city_wall")]
    if not walls:
        for cid, title in (("wall.height", "城墙高 12.48±0.1m"),
                           ("wall.thickness", "城墙厚 18.41±0.1m"),
                           ("wall.no_brick", "城墙无包砖层")):
            rep.skip(cid, title, "需 build/04_buildings.py 产出 city_wall_*",
                     group=G, needs_stage=2)
    else:
        # ⚠️ 「城墙高」量的是**街面标高以上**的高度,不是物体的包围盒高度。
        #    墙身底面刻意埋入地坪 `PLINTH_SINK` 那 0.5m(否则墙面与
        #    地面共面闪面),拿 max−min 去量得到的是 12.98 —— 多出来的
        #    正是那 0.5m 埋深。**量具量到了建模手法,而不是被量的东西。**
        #    基准取 z=0:街面标高在 `river.level` 一条里已被独立断言过
        #    (水面与两岸街面同在 z=0),这里复用同一个全局基准。
        #    埋深如实打进 detail,让读的人自己看见这个数是怎么来的。
        hs, ts, sinks = [], [], []
        for o in walls:
            V = _world_verts(o)
            z_top, z_bot = max(v.z for v in V), min(v.z for v in V)
            hs.append(z_top - 0.0)
            sinks.append(-z_bot)
            base = [v.x for v in V if v.z < z_bot + 1e-4]
            ts.append(max(base) - min(base))
        want_h = C.Gate.WALL_HEIGHT
        rep.add("wall.height", f"城墙高 {want_h}±0.1m",
                all(abs(h - want_h) <= 0.1 for h in hs),
                f"量 {len(walls)} 段(墙顶标高 − 街面 z=0):"
                f"{['%.3f' % h for h in hs]}(声明 {want_h});"
                f"墙身另埋入地坪 {['%.2f' % s for s in sinks]}m 以防共面闪面",
                expected=f"{want_h}±0.1", group=G)
        want_t = C.Gate.WALL_THICKNESS
        rep.add("wall.thickness", f"城墙厚 {want_t}±0.1m",
                all(abs(t - want_t) <= 0.1 for t in ts),
                f"取**底面**厚度:{['%.3f' % t for t in ts]}(声明 {want_t});"
                f"顶面因收分每侧内收 {C.Gate.WALL_BATTER:.2f}m",
                expected=f"{want_t}±0.1", group=G)

        # 「无包砖」能验到什么、不能验到什么,见 BOUNDARIES
        mats = {len(o.data.materials) for o in walls}
        names = sorted({m.name for o in walls for m in o.data.materials})
        brickish = [n for n in names if any(k in n.lower()
                                           for k in ("brick", "zhuan", "brickwork"))]
        rep.add("wall.no_brick", "城墙无包砖层", not brickish and mats == {1},
                f"{len(walls)} 段城墙材质名 {names},每段材质数 {sorted(mats)}"
                + ("" if not brickish else f";**疑似包砖材质** {brickish}"),
                expected="单一夯土材质,无独立砖层对象", group=G)

    # —— gate.bridge_offset ——
    br = _by_kind("bridge")
    if not br or pier is None:
        rep.skip("gate.bridge_offset", "拱桥与城门平面投影不共线(偏移 > 15m)",
                 "需虹桥与城门同时存在", group=G, needs_stage=2)
    else:
        by = 0.5 * (min(v.y for o in br for v in _world_verts(o))
                    + max(v.y for o in br for v in _world_verts(o)))
        off = abs(by - C.Site.GATE_Y)
        rep.add("gate.bridge_offset", "拱桥与城门平面投影不共线(偏移 > 15m)",
                off > 15.0,
                f"桥轴线 y={by:.3f}、门洞轴线 y={C.Site.GATE_Y:.1f},相距 **{off:.3f}m**"
                f"(声明 {C.Site.gate_offset_from_bridge():.1f})",
                expected=">15m", group=G)


# ==========================================================================
# 彩楼欢门
#
# 这一组有三条与别处不同的地方,值得先说清:
#
# 1) **它是临时构筑物,不是建筑**,所以不套 building 那一套断言
#    (屋面形制、檐口净高、格子门)。它自己的红线只有两条:
#    几座、怎么连接的。
#
# 2) **「绑扎」不能从三角形网格反推**。绑扎与榫卯在小尺度上都只是
#    "两根杆相交",远看读不出区别。所以连接方式只能由声明(qm_binding)
#    给出 —— 与 `qm_roof` 同一个道理。但声明不白给:本条会**从顶点数
#    把索环个数数回来**,与声明核对。两个数来自不同路径(一个由 builder
#    在建模时累加,一个由校验器从几何反算),对得上才说明"声明里说的
#    绑扎"确实建进了几何。
#
# 3) 「7 座」这条断言证明的**只是本场景按 7 座布置**。原画中可辨的
#    7 处欢门,本模型没有、也不可能逐座对应 —— 场景里只有 8 栋铺面,
#    7 座欢门挤在上面,密度是被放大的。这一条写进 BOUNDARIES,也写进
#    build/05_celebrations.py 的模块声明。
# ==========================================================================


def _celebrations() -> dict[str, list[bpy.types.Object]]:
    """按 `qm_parent` 把彩楼欢门归组。与船只、建筑同构的一船/一房多件。"""
    out: dict[str, list[bpy.types.Object]] = {}
    for o in _by_kind("celebration"):
        p = o.get("qm_parent")
        if p:
            out.setdefault(p, []).append(o)
    return out


def _door_clearance(frame: bpy.types.Object) -> tuple[float, int, str]:
    """
    量出门洞的**实际净空** —— 从 `_frame` 物体的世界顶点上量。

    做法:取"落在门洞内的构件最低点"。门洞的横向范围由四根落地门柱
    定出,把柱子自身截面那半个厚度让开(柱子中心在角点上,所以内表面
    在 `y ± POST_SEC/2`),再在剩下的中段里找最低的顶点。

    这个量法**不读任何声明**,也不需要知道构件叫什么名字:它回答的是
    "人从这座欢门底下走过去,多高会撞头"。所以它既能抓到"门柱建矮了",
    也能抓到"某根斜撑或横枋意外横穿了门洞" —— 后者是纯几何错误,
    声明里看不出来。

    返回 (净空, 落地门柱数, 说明)。
    """
    V = _world_verts(frame)
    if not V:
        return 0.0, 0, "物体没有顶点"

    zmin = min(v.z for v in V)
    # 落地门柱:底面被埋进街面(建模时刻意下沉一点,免得与地面共面闪面),
    # 所以场景里 z 最小的一簇顶点就是它们。
    base = [v for v in V if v.z < zmin + 1e-4]
    cols = _distinct([v.y for v in base])
    if not cols:
        return 0.0, 0, "找不到落地门柱"

    half = 0.5 * C.Celebration.POST_SEC
    ya, yb = cols[0], cols[-1]
    inner = (ya + half + 1e-4, yb - half - 1e-4)
    inside = [v.z for v in V if inner[0] < v.y < inner[1] and v.z > zmin + 1e-4]
    if not inside:
        return 0.0, len(cols), "门洞中段没有任何构件顶点,量不出净空"

    clear = min(inside)
    return clear, len(cols), (
        f"门洞横向 {inner[1] - inner[0]:.3f}m(门柱内表面之间),"
        f"其中最低构件底面 z={clear:.3f}"
    )


def _check_props(rep: Report) -> None:
    """
    阶段 2d 的出口:**柳树与街边道具**。

    需求里那一条写的是"脚底贴地、不穿桌、不悬空"。把它翻成可量的东西:

        prop.grounded    每件道具的包围盒底 落在 [−tol, +tol] 之内
        prop.not_sunk    包围盒底 不显著低于地面(陷进地里也是错的,
                         而且比悬空更难发现 —— 悬空看得见,埋进去看不见)
        prop.overlap     任意两件道具的包围盒**不互相穿插**
        tree.planted     每株柳的树干底 贴地
        tree.clearance   柳的**地上部分**不侵入桥面净空
        tree.steps       柳不栽在下河踏步的实体范围内
        banner.hang      幌子挑出杆的根部贴在铺面外皮上(不悬空、不埋墙)

    ⚠️ **口径错误:一道差点骗过自己的校验。**
       第一版这里用的是 `_by_kind("prop")` —— 即**全场景**所有打了
       `qm_kind='prop'` 的物体。那个集合里有虹桥的索绑、河道的护岸木桩、
       下河踏步、船上的缆绳 —— 它们**本来就该埋在地下或穿进驳岸**,
       于是"下陷"报了 6 个、"互相穿插"报了 26 对,看着像一堆严重问题,
       实际上一条都不是。同一版的 `tree.steps` 更隐蔽:它拿踏步物体的
       **整体包围盒**去比,而那个包围盒是四处踏步的并集 ——
       两处踏步之间的空档也被算成"踏步上"。
       这两个错都不是几何错了,是**尺子量错了对象**。所以本函数一律
       按 `06_props` 真正写进去的那两个集合取物体,不按 kind 取 ——
       kind 是给网页用的分类,不是"谁建的"的凭据。

    ⚠️ 一条**边界声明**,写在这里也写进 docs/08:
       这里量的是"几何与地面/其它构件的位置关系",**不包含力学稳定性**。
       一件道具的包围盒底贴在 z=0 上,不代表它在物理上放得稳;而"不穿桌"
       这里实现为"AABB 不重叠",对**旋转过的**物体是保守近似 ——
       两只斜放的凳子可能在 AABB 上相交而实际并不接触。所以重叠断言
       只报**相交**为失败,不报"接近",以免每挪动一点就误报。
    """
    G = "道具"
    props_coll = bpy.data.collections.get("道具")
    tree_coll = bpy.data.collections.get("柳树")
    props = list(props_coll.objects) if props_coll else []
    trees = list(tree_coll.objects) if tree_coll else []
    if not props and not trees:
        for cid, title in (
            ("prop.grounded", "道具脚底贴地"),
            ("prop.not_sunk", "道具没有陷进地面"),
            ("prop.overlap", "道具之间不互相穿插"),
            ("tree.planted", "柳树干底贴地"),
            ("tree.clearance", "柳不侵入桥面净空"),
            ("tree.steps", "柳不栽在下河踏步上"),
            ("banner.hang", "幌子下缘高过成人"),
        ):
            rep.skip(cid, title,
                     "场景里没有 '道具'/'柳树' 集合 —— 06_props 没有运行过?"
                     "(本函数只量 06 建的东西,不按 qm_kind 取,理由见函数文档)",
                     group=G, needs_stage=2)
        return

    # —— 地面标高 ——
    #
    # 细致区内地坪一律 z=0(见 00_layout._ground)。
    ground = 0.0

    # 悬空容差很小(2cm):道具是**箱式摆放**的(见 06_props 的 `_box`),
    # 底面就是箱底,底就该正好落在 0 上。
    TOL_AIR = 0.02
    # 下沉容差比悬空宽,而且**是有理由的**:器物的底面如果不是平的
    # (陶瓮的鼓腹、独轮车的轮),最低点本就该略微埋进土里一点才站得住;
    # 柳树更明显 —— 主干**微微倾斜**,它的底端封盖是一个**斜的圆盘**,
    # 最低点自然低于树干轴线起点,差量约 `半径 × sin(倾角)`。
    # 数值上界:干径最大 0.22m × 倾角最大约 10° ≈ 3.8cm。
    TOL_SINK = 0.06

    # —— 分两类:落地的 与 悬挂的 ——
    #
    # 幌子**本来就挂在空中**(下缘 1.9m 上下),拿"贴地"去量它必然失败。
    # 第一版没分开,16 面幌子全报"悬空 1.35m" —— 又是一次尺子量错了活。
    #
    # 认身份用 `qm_id` 前缀,不认物体名。物体名会被 Blender 加 `.001`
    # 后缀去重,而 `qm_id` 是 06_props **自己声明的**身份,不会被改名。
    def _is_banner(o: bpy.types.Object) -> bool:
        return str(o.get("qm_id", "")).startswith("banner_")

    hang = [o for o in props if _is_banner(o)]
    rest = [o for o in props if not _is_banner(o)]

    # —— 道具:逐块量(不是逐物体量)—— 见 `_islands` 的文档 ——
    #
    # 每块 = (所属物体名, 块序号, 低, 高)。块序号进标签是为了
    # **报得出是哪一块**,不再只报"这一堆里有问题"。
    pieces: list[tuple[str, str, Vector, Vector]] = []
    for o in rest:
        for k, (lo, hi) in enumerate(_islands(o)):
            pieces.append((o.name, f"#{k}", lo, hi))

    if not pieces:
        rep.skip("prop.grounded", "道具脚底贴地", "道具集合里没有可量的顶点",
                 group=G, needs_stage=2)
        rep.skip("prop.not_sunk", "道具没有陷进地面", "同上", group=G, needs_stage=2)
        rep.skip("prop.overlap", "道具之间不互相穿插", "同上", group=G, needs_stage=2)
    else:
        # ⚠️ **"每块都贴地"是个错的问题。** 拆成块之后第一次跑,报了 75 块
        #    悬空 —— 看着像灾难,其实全是**同一件器物的上半截**:竹篮是几段
        #    圆台摞起来的,只有最下一段碰得到地,上面几段的底分别在
        #    +0.09 / +0.10 / +0.27 … 它们**本来就该悬着**。这不叫悬空,
        #    叫做一只篮子。
        #    所以贴地要按**器物**(= 一个物体)量,判据是它**最低的那一块**:
        #        一个物体的最低块贴地 ⇒ 这件器物有支撑,没悬空。
        #    块级的数照样报出来,但只当作**证据**报,不当作失败 —— 并且
        #    把"多数块在家具腿上/器物上半身"这层意思写清楚,免得下一个人
        #    看见"128 块里只有 53 块碰地"又以为是问题。
        by_obj: dict[str, float] = {}
        for n, _k, lo, _hi in pieces:
            by_obj[n] = min(by_obj.get(n, math.inf), lo.z)
        floats = [(n, round(z, 4)) for n, z in sorted(by_obj.items())
                  if z > ground + TOL_AIR]
        sunk = [(f"{n}{k}", round(lo.z, 4))
                for n, k, lo, _hi in pieces if lo.z < ground - TOL_SINK]
        zs = sorted(by_obj.values())
        n_touch = sum(1 for _n, _k, lo, _hi in pieces if lo.z <= ground + TOL_AIR)
        rep.add(
            "prop.grounded", "每件道具都有支撑、不整体悬空(按器物量)",
            not floats,
            f"{len(rest)} 个道具物体拆出 {len(pieces)} 块(幌子另算);"
            f"器物最低块标高 {zs[0]:+.4f} … {zs[-1]:+.4f} m"
            + (f";⚠️ 整体悬空 {len(floats)} 件:{floats[:4]}" if floats else "")
            + f";逐块看 {len(pieces)} 块里 {n_touch} 块碰地,"
              f"其余是器物上半截与桌凳腿 —— **块悬空不是失败,器物悬空才是**",
            expected=f"每件器物的最低块 ≤ {ground + TOL_AIR:+.2f} m"
                     f"(允差 {TOL_AIR:.2f})",
            group=G, needs_stage=2,
        )
        rep.add(
            "prop.not_sunk", "没有道具陷进地面",
            not sunk,
            f"低于 {ground - TOL_SINK:+.2f} m 的有 {len(sunk)} 块"
            + (f":{sunk[:4]}" if sunk else "")
            + f"(允差 {TOL_SINK:.2f} m 是**算出来的**:器物底面非平 + 树干"
              f"底端斜盖的 `半径×sin(倾角)` 上界 ≈ 0.038 m;"
              f"下陷比悬空更难发现 —— 悬空在图上看得见,埋进去看不见)",
            expected=f"底 ≥ {ground - TOL_SINK:+.2f} m", group=G, needs_stage=2,
        )

        # —— 道具:互不穿插 ——
        #
        # ⚠️ **只比不同物体之间的块。** 同一物体内部的块是同一件器物
        #    自己的分段(竹篮是几段圆台摞的),它们本来就连着。
        # ⚠️ 报出体积,不报"相交" —— 贴在一起摆的桌凳 AABB 常常只搭
        #    几个毫米;只有真穿进对方体内的才需要人看一眼。
        hits: list[str] = []
        n_cmp = 0
        for a in range(len(pieces)):
            na, ka, la, ha = pieces[a]
            for b in range(a + 1, len(pieces)):
                nb, kb, lb, hb = pieces[b]
                if na == nb:
                    continue                     # 同一器物自己的分段,跳过
                n_cmp += 1
                if all(la[i] <= hb[i] and lb[i] <= ha[i] for i in range(3)):
                    vol = 1.0
                    for i in range(3):
                        vol *= max(0.0, min(ha[i], hb[i]) - max(la[i], lb[i]))
                    if vol > 1e-4:
                        hits.append(f"{na}∩{nb} {vol * 1000:.2f}L")
        rep.add(
            "prop.overlap", "任意两件落地道具不互相穿插(逐块量)",
            not hits,
            f"{len(rest)} 个物体拆出 {len(pieces)} 块,跨物体的对 {n_cmp} 对"
            f"(同物体自身的分段不参与),重叠体积 >0.1L 的 {len(hits)} 对"
            + (f":{hits[:4]}" if hits else ""),
            expected="0 对(仅报体积 >1e-4 m³;块=AABB 口径对斜放件偏保守)",
            group=G, needs_stage=2,
        )

    # —— 柳树:树干贴地 ——
    #
    # ⚠️ 这里**没有 `return`**。第一版在"没有树干"时直接 return 了,
    #    于是后面那段 `banner.hang` 一次也不会执行 —— 而它**不是
    #    汇报成失败,是压根不出现在报告里**,计数停在"未执行 0"上。
    #    这正是本项目反复栽的那个形状:**汇总说没事,明细里少了一条,
    #    而没有人去对这两者**。所以现在一律走到底,缺什么就 skip 什么。
    trunks = [o for o in trees if o.name.endswith("_trunk")]
    if not trunks:
        rep.skip("tree.planted", "柳树干底贴地", "柳树集合里没有 _trunk 物体",
                 group=G, needs_stage=2)
        rep.skip("tree.clearance", "柳不侵入桥面净空", "同上", group=G, needs_stage=2)
        rep.skip("tree.steps", "柳不栽在下河踏步上", "同上", group=G, needs_stage=2)
        bad = None
    else:
        bad = []
        zmin_all = math.inf
        for o in trunks:
            bb = _bbox([o])
            if bb is None:
                continue
            zmin_all = min(zmin_all, bb[0].z)
            if bb[0].z > ground + TOL_AIR or bb[0].z < ground - TOL_SINK:
                bad.append((o.name, round(bb[0].z, 4)))
        rep.add(
            "tree.planted", "每株柳的树干底贴地(可微微入土)",
            not bad,
            f"量 {len(trunks)} 株;最低树干底 {zmin_all:+.4f} m"
            + (f";⚠️ 越界 {len(bad)} 株:{bad[:4]}" if bad else "")
            + "(树干**不悬空**是硬要求;微微入土是正常的 —— 树干底端封盖是"
              "斜的圆盘,最低点低于轴线起点)",
            expected=f"底 ∈ [{ground - TOL_SINK:+.2f}, {ground + TOL_AIR:+.2f}] m",
            group=G, needs_stage=2,
        )

    # —— 柳树:不侵入桥面净空 ——
    #
    # ⚠️ 判据是**桥面净空**,不是"离桥多远"。config 的 BRIDGE_CLEAR
    #    是一个**平面距离**的粗筛(19m),而真正要保证的是柳冠不垂到
    #    桥面上、不扫到桥上的人。所以这里直接拿桥面物体的包围盒去比 ——
    #    平面距离写得太小,判据换了它自己也拦得住。
    deck = _one("bridge_deck")
    if deck is None:
        rep.skip("tree.clearance", "柳不侵入桥面净空", "场景里没有 bridge_deck",
                 group=G, needs_stage=2)
    else:
        dbb = _bbox([deck])
        # 叶壳与垂枝都算 —— 主干在桥面高度以下无所谓,但冠与垂枝不行
        leaves = [o for o in trees if not o.name.endswith("_trunk")]
        worst: tuple[str, float] | None = None
        n_bad = 0
        for o in leaves:
            bb = _bbox([o])
            if bb is None:
                continue
            lo, hi = bb
            # 平面重叠(桥体范围)且**高度方向也重叠** ⇒ 真的插进桥面净空
            plan = (lo.x <= dbb[1].x and dbb[0].x <= hi.x
                    and lo.y <= dbb[1].y and dbb[0].y <= hi.y)
            vert = lo.z <= dbb[1].z and dbb[0].z <= hi.z
            if plan and vert:
                n_bad += 1
                # 记录最高的那个侵入深度,方便判断该挪树还是该降冠
                depth = min(hi.z, dbb[1].z) - max(lo.z, dbb[0].z)
                if worst is None or depth > worst[1]:
                    worst = (o.name, depth)
        rep.add(
            "tree.clearance", "柳冠与垂枝不侵入桥面实体的范围",
            n_bad == 0,
            f"桥面实包围盒 x[{dbb[0].x:.2f},{dbb[1].x:.2f}] "
            f"y[{dbb[0].y:.2f},{dbb[1].y:.2f}] z[{dbb[0].z:.2f},{dbb[1].z:.2f}];"
            f"量 {len(leaves)} 个树冠物体,侵入 {n_bad} 个"
            + (f",最深 {worst[0]} {worst[1]:.2f}m" if worst else ""),
            expected="0 个(平面与高度**同时**重叠才算侵入)",
            group=G, needs_stage=2,
        )

    # —— 柳树:不长在下河踏步上 ——
    #
    # ⚠️ 这一条是**跨模块复核**:06 栽树时按 config.River.STEP_SITES
    #    算过一遍"撞上就整株跳过",但那是**算式**。这里拿 02_river
    #    真正建出来的踏步几何再比一次 —— 算式过时(比如台阶的进深改了
    #    而 STEP_SITES 没动),算式自己不会报错,这里会。
    #
    # ⚠️ **第一版是拿踏步物体的整体包围盒比的,那是错的。**
    #    `river_steps` 是**一个物体装着四处踏步**(两岸各两处),
    #    它的包围盒是四处的**并集** —— x 从 −10.4 到 +10.4、y 从 −31.5
    #    到 +35.5,几乎把整条河岸都罩住了。于是两处踏步之间的空档
    #    也被判成"踏步上",报出 `willow_002_trunk` 落在踏步里 ——
    #    一株根本没挨着台阶的树。
    #    并集包围盒**不是**任何一处踏步的形状,拿它做判据等于用一把
    #    量了整个房间的尺子去说"你站在桌子里"。
    #
    # 现在的判据直接问几何本身:**从树干底部往下打一条射线,看会不会
    # 打中踏步。** 打中了 = 树干是从踏步实体里长出来的;没打中 = 这株树
    # 与踏步无关,哪怕它在并集包围盒里。这条判据与"踏步有几处、怎么摆"
    # 完全无关,算式过时也拦得住。
    steps_obj = _one("river_steps") if trunks else None
    if steps_obj is None:
        rep.skip("tree.steps", "柳不栽在下河踏步上",
                 "场景里没有 river_steps" if trunks else "没有树干可量(上面已 skip)",
                 group=G, needs_stage=2)
    else:
        sbb = _bbox([steps_obj])
        inv = steps_obj.matrix_world.inverted()
        down_local = (inv.to_3x3() @ Vector((0.0, 0.0, -1.0))).normalized()
        intr = []
        for o in trunks:
            bb = _bbox([o])
            if bb is None:
                continue
            # 用树干底面**中心**,不用包围盒角 —— 包围盒角在树外
            cx = (bb[0].x + bb[1].x) * 0.5
            cy = (bb[0].y + bb[1].y) * 0.5
            origin = inv @ Vector((cx, cy, bb[0].z + 0.60))
            hit, loc, _n, _i = steps_obj.ray_cast(origin, down_local, distance=4.0)
            if hit:
                intr.append(f"{o.name}@({cx:.2f},{cy:.2f})")
        rep.add(
            "tree.steps", "没有柳树干从踏步实体里长出来",
            not intr,
            f"踏步整体包围盒 x[{sbb[0].x:.2f},{sbb[1].x:.2f}] "
            f"y[{sbb[0].y:.2f},{sbb[1].y:.2f}](**是四处的并集,仅作参考,不作判据**);"
            f"{len(trunks)} 株自树干底部向下打射线,命中踏步的 {len(intr)} 株"
            + (f":{intr[:4]}" if intr else "")
            + "(这条是**从几何复核算式** —— 判据与踏步有几处、摆在哪儿无关)",
            expected="0 株", group=G, needs_stage=2,
        )

    # —— 幌子 ——
    #
    # ⚠️ **门槛是算出来的,不是挑的。** 第一版这里写的是死数 1.60,依据
    #    只是"1.60 总高过一个人了吧" —— 那是个**感觉**,不是判据,而且
    #    它偏松:按 1.70 的成人算,1.60 的门槛会放行一面正好撞头的幌子。
    #    现在改成 `Human.headroom()` = 1.70 + 0.10(发髻/幞头余量)= 1.80。
    #
    # ⚠️ 这一条**同时**动了门槛和几何(1.35m → 2.00m,见 config.Prop
    #    的 BANNER_DROP 注释)。这**不是**"把数调到能过" —— 两个改动各有
    #    各的、独立的依据,而且**改后的几何同时满足两个门槛**
    #    (2.00 > 1.80 > 1.60),即门槛收紧并没有放过任何东西。
    #    真正会露馅的写法是把几何抬到 1.62 去刚好压过旧门槛 —— 那才是调参。
    need = C.Human.headroom()
    banners = [o for o in props if _is_banner(o)]
    if not banners:
        rep.skip("banner.hang", "幌子挑出杆根部贴铺面", "没有 banner_ 物体",
                 group=G, needs_stage=2)
    else:
        # 幌子的最高点应当在挑出杆标高附近;最低点 = 布面下缘。
        # 判据取"布面没垂到人头上" + "上缘不越过挑出杆"两条硬边。
        sills = []
        for o in banners:
            bb = _bbox([o])
            if bb is None:
                continue
            sills.append((o.name, bb[0].z, bb[1].z))
        lo_ok = all(z0 > need for _n, z0, _z1 in sills)
        hi_ok = all(z1 <= C.Prop.POLE_Z + 0.12 for _n, _z0, z1 in sills)
        z0_min = min(s[1] for s in sills)
        z1_max = max(s[2] for s in sills)
        n_lo = sum(1 for s in sills if s[1] <= need)
        rep.add(
            "banner.hang", "幌子下缘高过人行净空、上缘不越过挑出杆",
            lo_ok and hi_ok,
            f"{len(sills)} 面幌子;下缘最低 {z0_min:.2f} m"
            f"(须 >{need:.2f} = 成人 {C.Human.STATURE:.2f} + 余量 "
            f"{C.Human.HEAD_CLEAR:.2f}),上缘最高 {z1_max:.2f} m"
            f"(须 ≤ {C.Prop.POLE_Z + 0.12:.2f} = 挑出杆 {C.Prop.POLE_Z:.2f} + 0.12)"
            + (f";⚠️ 下缘过低 {n_lo} 面" if n_lo else ""),
            expected=f"下缘 >{need:.2f} m,上缘 ≤ {C.Prop.POLE_Z + 0.12:.2f} m",
            group=G, needs_stage=2,
        )


def _check_celebrations(rep: Report) -> None:
    G = "市井"
    groups = _celebrations()
    Cel = C.Celebration

    # —— celebration.count ——
    n = len(groups)
    if n == 0:
        rep.skip("celebration.count", f"彩楼欢门 {Cel.COUNT} 座",
                 "需 build/05_celebrations.py 产出 qm_kind=celebration",
                 group=G, needs_stage=2)
    else:
        rep.add("celebration.count", f"彩楼欢门 {Cel.COUNT} 座",
                n == Cel.COUNT,
                f"场景里数得 {n} 座({sorted(groups)});"
                f"⚠️ 这条证明的是**本场景按 {Cel.COUNT} 座布置**,"
                f"**不证明**还原了原画中可辨的那 7 家 —— 本场景只有 8 栋铺面,"
                f"欢门密度被放大,详见 BOUNDARIES",
                expected=f"= {Cel.COUNT}", group=G)

    if not groups:
        rep.skip("celebration.binding", "彩楼欢门为绑扎、无斗拱",
                 "场景里没有 qm_kind=celebration", group=G, needs_stage=2)
        rep.skip("celebration.clearance", f"门洞净空 ≥ {Cel.CLEAR_MIN}m",
                 "场景里没有 qm_kind=celebration", group=G, needs_stage=2)
        rep.skip("celebration.frontage", "面阔落在设计区间内",
                 "场景里没有 qm_kind=celebration", group=G, needs_stage=2)
        return

    # —— celebration.binding ——
    #
    # 三段:声明齐不齐、有没有斗拱、**几何里数不算得回声明的索环数**。
    objs = [o for g in groups.values() for o in g]
    bad_decl = [o.name for o in objs
                if str(o.get("qm_binding", "")) != Cel.BINDING
                or int(o.get("qm_dougong", -1)) != 0]
    # 斗拱的第二种可能暴露方式:物体名或 qm_id 里带斗拱字样。
    # 这是**间接**证据(命名而非几何),所以它只能加严、不能独立成立;
    # 真有没有斗拱,见 BOUNDARIES 里那条声明。
    dougongish = [o.name for o in objs
                  if "dougong" in o.name.lower() or "斗拱" in o.name]

    per_ring = Cel.RING_MAJOR_SEG * Cel.RING_MINOR_SEG
    ring_rows: list[str] = []
    ring_bad: list[str] = []
    missing_lash: list[str] = []
    for cid, grp in sorted(groups.items()):
        lash = _part(grp, "_lash")
        if lash is None:
            # 声明的绑扎在几何里没有落点 —— 这正是本条最该拦下的事
            missing_lash.append(cid)
            continue
        want = int(lash.get("qm_lash_rings", -1))
        nv = len(_world_verts(lash))
        if nv % per_ring:
            ring_bad.append(
                f"{cid}:顶点数 {nv} 不是每环 {per_ring} 点的整数倍,无法反算环数")
            continue
        got = nv // per_ring
        if got != want:
            ring_bad.append(f"{cid}:声明 {want} 环,几何反算 {got} 环")
        ring_rows.append(f"{cid} {got}")

    n_declared = sum(int(g.get("qm_lash_rings", 0))
                     for grp in groups.values()
                     for g in grp if g.name.endswith("_lash"))
    ok = not bad_decl and not dougongish and not ring_bad and not missing_lash
    detail = (
        f"{len(objs)} 个欢门物体全部声明 qm_binding={Cel.BINDING!r}、qm_dougong=0"
        if not bad_decl else f"**声明不符** {bad_decl}"
    )
    detail += (f";命名中未见斗拱构件" if not dougongish
               else f";**命名含斗拱** {dougongish}")
    if missing_lash:
        detail += f";**缺 _lash 物体(声明绑扎却无可量的索环)** {missing_lash}"
    elif ring_bad:
        detail += f";**索环数与几何对不上** {ring_bad}"
    else:
        detail += (
            f";{len(ring_rows)} 座各含 _lash 物体,由顶点数反算索环数"
            f"(顶点 ÷ {Cel.RING_MAJOR_SEG}×{Cel.RING_MINOR_SEG})"
            f"与声明逐一相等,合计 **{n_declared} 环** —— "
            f"「绑扎」不是标签上的一句话,是几何里数得出来的环"
        )
    rep.add("celebration.binding", "彩楼欢门为绑扎、无斗拱", ok, detail,
            expected=f"qm_binding={Cel.BINDING}, qm_dougong=0, 索环数=几何反算值",
            group=G)

    # —— celebration.clearance ——
    clear_rows: list[tuple[str, float]] = []
    clear_notes: list[str] = []
    for cid, grp in sorted(groups.items()):
        frame = _part(grp, "_frame")
        if frame is None:
            continue
        z, ncol, note = _door_clearance(frame)
        clear_rows.append((cid, z))
        clear_notes.append(f"{cid}:{note}(落地门柱 {ncol} 根)")
    if not clear_rows:
        rep.skip("celebration.clearance", f"门洞净空 ≥ {Cel.CLEAR_MIN}m",
                 "没有可量的 _frame 物体", group=G, needs_stage=2)
    else:
        worst = min(clear_rows, key=lambda r: r[1])
        rep.add("celebration.clearance", f"门洞净空 ≥ {Cel.CLEAR_MIN}m",
                worst[1] >= Cel.CLEAR_MIN,
                f"最矮者 {worst[0]}:**{worst[1]:.3f}m**"
                f"(余量 {worst[1] - Cel.CLEAR_MIN:+.3f});量 {len(clear_rows)} 座,"
                f"净空区间 [{worst[1]:.3f}, {max(z for _, z in clear_rows):.3f}]。"
                f"量法是**门洞中段构件的最低底面**,不是横枋中线标高 —— "
                f"门洞上沿横枋自身截面还要往下占 "
                f"{Cel.Z_LINTEL - worst[1]:.3f}m",
                expected=f"≥{Cel.CLEAR_MIN}(门洞中段最低构件底面)", group=G)

    # —— celebration.frontage ——
    #
    # 量的是 `_frame` 沿 y 的跨度。檐柱中心落在分档角点上、柱截面为
    # POST_SEC,故外皮跨度 = 面阔 + POST_SEC —— **这一步是减出来的,
    # 不是量出来的**,如实写进 detail 让读的人看见这个前提。
    ext = []
    for cid, grp in sorted(groups.items()):
        frame = _part(grp, "_frame")
        if frame is None:
            continue
        ys = [v.y for v in _world_verts(frame)]
        ext.append((cid, max(ys) - min(ys)))
    if not ext:
        rep.skip("celebration.frontage", "面阔落在 [W_MIN, W_MAX] 内",
                 "没有可量的 _frame 物体", group=G, needs_stage=2)
    else:
        ws = [(cid, e - Cel.POST_SEC) for cid, e in ext]
        lo, hi = min(w for _, w in ws), max(w for _, w in ws)
        n_uniq = len(_distinct([w for _, w in ws], tol=1e-3))
        inband = all(Cel.W_MIN <= w <= Cel.W_MAX for _, w in ws)
        rep.add("celebration.frontage", f"面阔落在 [{Cel.W_MIN}, {Cel.W_MAX}] 内",
                inband,
                f"{len(ws)} 座面阔 {lo:.3f}~{hi:.3f}m"
                f"(由外皮跨度减柱截面 {Cel.POST_SEC}m 得出 —— **这一步是减出来的"
                f"不是量出来的**,前提是檐柱中心正落在分档角点上);"
                f"互不相同的取值 {n_uniq} 个"
                + ("。⚠️ 只有 1 个取值 —— 说明夹取区间正在生效,"
                   "「按铺面面阔缩放」那半句形同虚设"
                   if n_uniq == 1 else ""),
                expected=f"[{Cel.W_MIN}, {Cel.W_MAX}]", group=G)


# ==========================================================================
# 尚未实现的子系统
#
# 每一项都写清"该量什么、量在哪、判据是什么",并**明确 skip**。
# 留成 skip 而不是删掉,是为了阶段 2 开工时照着实现,
# 也是为了让报告如实显示"这几条现在没人看着"。
#
# ⚠️ 实现完一条就**必须**把它从本表移走。留着会变成"实现完了却仍报
#    未执行",那比没实现更糟 —— 报告会开始骗人,而报告一骗人,
#    所有断言的可信度就一起归零了。
# ==========================================================================

_PENDING: tuple[tuple[str, str, str, int], ...] = (
    # boat.draft / boat.air / boat.within_bank / boat.air_clear /
    # boat.mast_needs_fold 已由 _check_boats 实现,从本表移出。
    #
    # roof.whitelist / building.eave / lattice.* / tile.row /
    # gate.* / wall.* 共 12 条已由 _check_buildings 实现,同样移出。
    #
    # celebration.count / celebration.binding 两条已由 _check_celebrations
    # 实现,移出。**本表现已为空** —— 阶段 2 的形制红线全部有人看着。
    # 空表是好事,不是遗漏:它意味着没有任何一条红线处在"说了要验、
    # 实际没人验"的状态。新增待实现项时照上面的格式往下加。
)


def _report_pending(rep: Report, stage: int) -> None:
    for cid, title, why, need in _PENDING:
        rep.skip(
            cid, title, why,
            group="待实现" if need <= stage else f"阶段 {need} 起实现",
            needs_stage=need,
        )


# ==========================================================================
# 贴图
#
# 这一组要回答的不是"图好不好看",而是三件**能静默出错**的事:
#
#   1. 该烤的图烤了没有(`tex.baked` / `tex.size` / `tex.colorspace`)
#   2. 烤出来的图接进材质了没有(`tex.wired`)
#   3. 接了贴图的网格**有没有 UV**(`tex.uv` / `tex.tile`)
#
# 第 3 条是这一组里最要命的。没有 UV 层的网格,贴图**不会报错** ——
# 采样点恒为 UV(0,0),整片屋面取到图上的同一个像素,渲染出来是一片纯色。
# 它的故障现场与"材质根本没接贴图"一模一样,而后者至少有人会注意到,
# 前者连"少了一张图"都算不上,因为它一张都不少。
#
# 与之配套的拦截已经写在 `bl_utils.MeshBuilder.build()` 里(那是第一道,
# 在建的时候就炸)。这里量的是**场景里真实存在的网格**,两道口径不同:
# 一道管"新建时别写错",一道管"建完的结果确实是这样"。
# ==========================================================================


def _tex_name_of(mat: bpy.types.Material) -> str | None:
    """材质基色上那张贴图的**贴图名**(从 image 的名字反解)。

    image 由 `tex_utils.bake` 命名为 `tex_<贴图名>_<c|n|r>`,
    所以从 `tex_road_rut_c` 反解出 `road_rut`。
    """
    if not mat.use_nodes or mat.node_tree is None:
        return None
    for n in mat.node_tree.nodes:
        if n.type != "TEX_IMAGE" or n.image is None:
            continue
        nm = n.image.name
        if nm.startswith("tex_") and nm[-2] == "_":
            return nm[4:-2]
    return None


def _check_textures(rep: Report) -> None:
    G = "贴图"
    K = C.Texture

    # —— 1. 该烤的都烤了,尺寸与色彩空间都对 ——
    #
    # ⚠️ 取数是**扫全部 `tex_*` 图**,不是按期望名逐个 `get()`.
    #    按名字去取,只能回答"我要的在不在",**永远看不见多出来的** ——
    #    而下面那条反向断言要抓的 `<name>.001`(模块被导入两次、
    #    烘焙跑两遍),正是"名字对不上期望"的那一类。用 `get()` 的话
    #    那张佐证现场根本进不了这个函数,断言写出来也是空的。
    baked: dict[str, bpy.types.Image] = {}
    stray_imgs: list[str] = []
    for img in bpy.data.images:
        if not img.name.startswith("tex_"):
            continue
        baked[img.name[len("tex_"):]] = img
        if img.name[len("tex_"):].rsplit("_", 1)[0] not in K.SIZE:
            stray_imgs.append(img.name)

    skipped = set(K.NOT_HEIGHT_FIELD) | set(K.UNUSED)
    miss = [
        f"{nm}_{k}" for nm in K.SIZE if nm not in skipped
        for k in ("c", "n", "r") if f"{nm}_{k}" not in baked
    ]
    # ⚠️ 上一版这里写的是 `f"tex_{nm}_{k}"`,而 `baked` 的键是 `{nm}_{k}`
    #    (不带 tex_ 前缀)—— 于是 36 张**全部**报缺,连刚烤好的那批也报。
    #    这不是"尺子太严",是尺子上的刻度整段错了位:它把"我没找到"
    #    说成了"场景里没有"。凡是"清单全红"的读数,先怀疑比对的两边
    #    根本不是一个口径,而不是先怀疑东西真没了。
    #
    # ⚠️⚠️ 第二版又栽在**同一处口径**上,方向相反:分母写成了
    #    `K.SIZE − NOT_HEIGHT_FIELD`,即"KIT 声明了就该烤出来"。但烘焙是
    #    **惰性**的 —— 只有材质真的去 `get_maps()` 要,图才会生成。
    #    `tile_flat` 登记在 `UNUSED`(没有任何材质引用它),于是它**永远
    #    不会被烤**,而断言却说"缺 tile_flat_c/n/r"。
    #    断言本身没错、场景本身也没错,错的是我把"计划里列了"当成了
    #    "产出里该有"。**KIT 是计划,不是产出。**
    #    正确口径:**被材质引用的**才必须已烤出。没人用的图,没烤才是对的。
    want_n = len([n for n in K.SIZE if n not in skipped]) * 3

    # —— 反向:烤出来了,却在 KIT 里查无此名 ——
    # 这条是给"同一个模块被平铺/包路径各导入一次"那个坑设的防:那种情况下
    # `_CACHE` 有两份,同一种木料烤两遍,`bpy.data.images` 里会多出
    # `tex_wood_old_c.001`。它**不会**让上面那条报缺(正本还在),尺寸、
    # 色彩空间、UV 也全都对 —— 从任何单条断言看都是健康的。只有把
    # "烤出来的"和"KIT 里声明的"摆在一起看,那一份多余才现形。
    stray_show = sorted(s for s in stray_imgs if s.endswith("_c"))

    rep.add(
        "tex.baked", "被材质引用的贴图都已烤出,且没有多烤出来的",
        not miss and not stray_show,
        f"KIT 声明 {len(K.SIZE)} 项,其中 "
        f"{len(K.NOT_HEIGHT_FIELD)} 项非高度场({', '.join(K.NOT_HEIGHT_FIELD)})、"
        f"{len(K.UNUSED)} 项登记未使用({', '.join(K.UNUSED)}),"
        f"余下 {want_n // 3} 项各 3 张 ⇒ 应烤 {want_n} 张;"
        f"实测 {len(baked)} 张"
        + (f";**缺** {miss}" if miss else "")
        + (f";**多出** {stray_show}(KIT 里没有这些名字 —— 先查是不是"
           f"`lib/tex_utils` 被同时按平铺与包两条路导入过)" if stray_show else ""),
        expected=f"{want_n} 张,且无多余", group=G,
    )

    # 只验 KIT 里声明过的那些。杂散图(`tile_flat_c.001` 之流)没有声明值
    # 可比,放进来只会 `KeyError` 把校验器打崩 —— 而它们已经在 `tex.baked`
    # 里报过了。**同一个问题只在一个地方报**,别让第二条断言替它崩一次。
    decl = {k: v for k, v in baked.items() if k.rsplit("_", 1)[0] in K.SIZE}
    bad_size = [
        f"{k}:{v.size[0]}²" for k, v in decl.items()
        if v.size[0] != v.size[1] or v.size[0] > K.MAX_SIZE
        or v.size[0] != K.SIZE[k.rsplit("_", 1)[0]]
    ]
    rep.add(
        "tex.size", f"贴图边长与声明一致,且不超过 {K.MAX_SIZE}²",
        not bad_size,
        f"量 {len(decl)} 张:" + (
            "全部等于 KIT 声明的边长" if not bad_size
            else f"**不符** {bad_size}"
        ),
        expected=f"边长 == KIT 声明值 且 ≤ {K.MAX_SIZE}",
        group=G,
    )

    bad_cs = [
        f"{k}:{v.colorspace_settings.name}"
        for k, v in decl.items()
        if v.colorspace_settings.name != ("sRGB" if k.endswith("_c") else "Non-Color")
    ]
    rep.add(
        "tex.colorspace", "反照率为 sRGB,法线与粗糙度为 Non-Color",
        not bad_cs,
        f"量 {len(decl)} 张:" + (
            "色彩空间全部正确" if not bad_cs else f"**不符** {bad_cs[:4]}"
        ),
        expected="c → sRGB;n / r → Non-Color", group=G,
    )

    # —— 2. 接线:表里声明的与场景里实际接的,两边对账 ——
    #
    # 判据是**从材质节点树里反解贴图名**,不是读 config 的表。
    # 读表等于把声明抄一遍,表写错时两边一起错、校验照样全绿。
    wired: dict[str, list[str]] = {}
    for m in bpy.data.materials:
        tn = _tex_name_of(m)
        if tn:
            wired.setdefault(tn, []).append(m.name)

    declared: dict[str, list[str]] = {}
    for mname, got in K.MATERIAL.items():
        if got:
            declared.setdefault(got[0], []).append(mname)

    # 场景里真的建出来的材质(有用户)。没建出来的不必对账 ——
    # 那属于"这个 builder 还没跑",由 builder 那层的门禁去管。
    live = {m.name for m in bpy.data.materials if m.users > 0}

    problems: list[str] = []
    for tn in sorted(K.SIZE):
        if tn in K.UNUSED:
            # 声明"没用"的东西,**必须真的没用** —— 否则这行声明就是过期的,
            # 而过期声明的作用是让真问题看起来已经处理过了。
            if tn in wired:
                problems.append(
                    f"{tn} 已登记为未使用,却接在 {wired[tn]} 上 —— 声明过期"
                )
            continue
        dm = [x for x in declared.get(tn, []) if x in live]
        if not dm:
            problems.append(
                f"{tn} 没有任何**已建出**的材质在用它"
                f"(表里声明给 {declared.get(tn, [])} 或根本没声明)"
            )

    for tn, mnames in sorted(wired.items()):
        if tn not in K.SIZE:
            problems.append(f"材质 {mnames} 上挂着一张不属于 KIT 的图 {tn!r}")

    n_live_wired = len({m for ms in wired.values() for m in ms if m in live})
    rep.add(
        "tex.wired", "每张贴图都接进了材质;未接的必须显式登记",
        not problems,
        f"材质库声明 {len(K.MATERIAL)} 项,其中 "
        f"{sum(1 for v in K.MATERIAL.values() if v)} 项贴图、"
        f"{sum(1 for v in K.MATERIAL.values() if not v)} 项刻意不贴;"
        f"场景里实接 {n_live_wired} 个材质、{len(wired)} 张图;"
        f"登记未使用 {len(K.UNUSED)} 张"
        + (";对账一致" if not problems else "; **不符** " + "; ".join(problems[:4])),
        expected="KIT 每一项:已接材质 或 在 UNUSED 里写明理由",
        group=G,
    )

    # —— 3. UV:接了贴图的网格必须有 UV 层,且 UV 不能退化成一点 ——
    #
    # 判据分两问,第二问才是真问题:
    #   a) 有没有 UV 层 —— 没有的话贴图恒取 UV(0,0),渲染成纯色,不报错
    #   b) UV 有没有展布 —— 全零的 UV 层与没有 UV 层的**效果完全一样**,
    #      但"有 UV 层"这个事实会让 a) 通过。所以要多问一句。
    no_uv: list[str] = []
    flat_uv: list[str] = []
    n_uv = 0
    for o in _meshes():
        mats = [m for m in o.data.materials if m]
        if not any(_tex_name_of(m) for m in mats):
            continue
        n_uv += 1
        if not o.data.uv_layers:
            no_uv.append(f"{o.name}(材质 {mats[0].name})")
            continue
        uv = o.data.uv_layers[0].data
        us = [d.uv[0] for d in uv]
        vs = [d.uv[1] for d in uv]
        span = max(max(us) - min(us), max(vs) - min(vs))
        if span < 1e-9:
            flat_uv.append(f"{o.name}(展布 {span:.2e})")

    rep.add(
        "tex.uv", "带贴图的网格都有 UV 层,且 UV 有实际展布",
        not no_uv and not flat_uv,
        f"场景里 {n_uv} 个网格带贴图材质;"
        + ("全部有 UV 且展布非零" if not (no_uv or flat_uv) else "")
        + (f";**无 UV 层** {len(no_uv)} 个 {no_uv[:3]}" if no_uv else "")
        + (f";**UV 退化** {len(flat_uv)} 个 {flat_uv[:3]}" if flat_uv else ""),
        expected="有 UV 层且 max(Δu, Δv) > 0", group=G,
    )

    # —— 4. 铺装尺寸:**逐面**验 UV 确实等于"世界坐标 ÷ tile" ——
    #
    # 盒式展开的公式是逐面的、而且**精确**:
    #     面 → 取主法线轴 ax → 另两轴 (ua, va) = ((ax+1)%3, (ax+2)%3)
    #     uv = (cos[ua] / tile, cos[va] / tile)
    # 所以对任意一个面,它自己的 Δu × tile 必须**恰好等于**该面沿 ua 的跨度。
    #
    # ⚠️ 上一版这条不是这么写的,它拿"整个物体的 UV 展布"去比
    #    "包围盒最大跨度 ÷ tile",结果三条报红全是**尺子的错**:
    #    不同朝向的面用不同的轴对,物体的 UV 范围是各面范围的**并集**,
    #    于是一条沿对角线布的缆绳会量到 5.05× —— 几何完全正确,
    #    是那个比值本身没有可比性。校验器报假警比不报更坏:
    #    它把注意力从真问题上引开(这条判据的第一版也就是这么栽的)。
    #    改成逐面之后没有这个毛病 —— 每个面各自闭环,与物体形状无关。
    #
    # 这条能抓的错:忘了除 tile、除错方向(乘了)、轴对取反、
    # 用了别的材质的 tile、以及"接了材质却压根没展开 UV"。
    tile_bad: list[str] = []
    n_tile = 0
    n_face = 0
    for o in _meshes():
        mats = [m for m in o.data.materials if m and _tex_name_of(m)]
        if not mats or not o.data.uv_layers:
            continue
        m = mats[0]
        tile = m.get("qm_tile_m")
        if not tile:
            tile_bad.append(f"{o.name}:材质 {m.name} 上没有 qm_tile_m")
            continue
        n_tile += 1
        tile = float(tile)
        me = o.data
        uv = me.uv_layers[0].data
        worst = 0.0
        worst_face = ""
        for poly in me.polygons:
            nrm = poly.normal
            ax = (
                0 if abs(nrm.x) >= abs(nrm.y) and abs(nrm.x) >= abs(nrm.z)
                else (1 if abs(nrm.y) >= abs(nrm.z) else 2)
            )
            ua, va = (ax + 1) % 3, (ax + 2) % 3
            cos_ = [me.vertices[me.loops[li].vertex_index].co for li in poly.loop_indices]
            uvs = [uv[li].uv for li in poly.loop_indices]
            du = (max(u[0] for u in uvs) - min(u[0] for u in uvs)) * tile
            dv = (max(u[1] for u in uvs) - min(u[1] for u in uvs)) * tile
            da = max(c[ua] for c in cos_) - min(c[ua] for c in cos_)
            db = max(c[va] for c in cos_) - min(c[va] for c in cos_)
            # 退化面(沿某轴零厚度)上 Δ 都是 0,比不出东西,跳过。
            if da < 1e-6 and db < 1e-6:
                continue
            n_face += 1
            err = max(abs(du - da), abs(dv - db))
            if err > worst:
                worst, worst_face = err, (
                    f"面{poly.index}: Δu×tile={du:.4f} vs Δ{ 'xyz'[ua] }={da:.4f},"
                    f" Δv×tile={dv:.4f} vs Δ{ 'xyz'[va] }={db:.4f}"
                )
        # 容差 1mm:tile ≥ 0.35 时 UV 最大约 350,float32 相对精度 1e-7
        # 给出 ~3e-5 的绝对误差,离 1mm 有三十倍余量。
        if worst > 1e-3:
            tile_bad.append(f"{o.name}(最大偏差 {worst * 1000:.1f}mm){worst_face}")

    rep.add(
        "tex.tile", "每个面的 UV == 该面世界坐标 ÷ 铺装尺寸(逐面精确)",
        not tile_bad,
        f"{n_tile} 个带贴图网格、{n_face} 个非退化面;"
        + ("逐面 Δu×tile 与 Δx 全部相符(容差 1mm)" if not tile_bad else "")
        + (f";**不符** {tile_bad[:2]}" if tile_bad else ""),
        expected="每个面 |Δu×tile − Δ(世界轴)| ≤ 1mm",
        group=G,
    )

    for cid, title, why, need in _PENDING:
        rep.skip(
            cid, title, why,
            group="待实现" if need <= stage else f"阶段 {need} 起实现",
            needs_stage=need,
        )


BOUNDARIES: tuple[str, ...] = (
    "本校验证明的是「建出来的几何与 config 声明的尺寸一致」,"
    "**不证明**「config 声明的尺寸符合北宋原物」。",
    "config 的全部尺寸源自唐寰澄以'虹桥栏柱间距约 1m'为根节点的链式推算 —— "
    "该 1m 无实测依据,是整条尺寸链的根。根若错,下游等比地错。",
    "「无榫卯」由'无榫卯命名对象 + 索绑在每个节点上存在'间接支撑,"
    "无法从三角形网格反推木构件的连接工艺。",
    "「无桥墩」是几何断言(跨内水下无实体),这一条是**直接可验**的。",
    # —— 船只 ——
    "吃水、总高、出水面、过桥净空四条都是**直接量的世界几何**,"
    "基准是实测的水面板顶面 z,不是 config 里的声明星吃水值。",
    "但「吃水 1.100m」只证明**船壳最低点比水面低 1.100m**,"
    "不证明这条船载着这些货真的会浮在这条线上 —— 那需要排水量与"
    "载重,本模型没有做流体静力学。",
    "「立桅 7.409m 过不去 4.505m 的拱顶净空」里的净空是**几何净空**"
    "(拱顶顶点到金刚墙顶),未计入水位涨落、船体下坐与波浪;"
    "真实通航净空只会**更小**,不会更大。",
    "眠桅角 79.93° 是由目标总高 1.75m **反解**出来的,不是从原画量的 —— "
    "原画里桅杆是画出来的斜线,量不出这个角度。1.75m 这个目标值是"
    "本项目的取值,不在考据范围内。",
    # —— 建筑与城门 ——
    "「屋面形制 ∈ 白名单」证明的是**声明(qm_roof)里**没有硬山,"
    "**不证明几何里真的没有硬山** —— 悬山与硬山的网格都只是几片斜坡面,"
    "差别在'山面有没有把檩头挑出去',这件事没有任何三角形可以反推。"
    "所以这条断言的能力边界比它看上去窄得多。",
    "「格眼高度占比 0.6667」是量出来的,但 0.6667 这个目标值来自本模块"
    "对《营造法式》'腰上三分之二'的解读。原画里格子门的格眼无法逐扇量,"
    "这条只保证几何与声明一致,不保证与原物一致。",
    "「每间 4 扇」里的'间数'由柱数减一推出,而柱数是把前檐物体的顶点"
    "按 z 分簇数出来的。它依赖'柱顶高于门顶'这个**本模块自定的做法**;"
    "若将来柱门齐高,这条断言会以'顶点数对不上'失败,而不是悄悄数错。",
    "「筒瓦垄距」量的是**屋面物体上不同 y 值的间距**,"
    "也就是采样间距。几何上确有起伏配合(垄脊抬高 0.035m),"
    "但'间距等距'本身由建模方式保证,不是从实物量得的工艺参数。",
    "「城墙无包砖」只能证明**没有独立的砖层对象/材质**。"
    "单一材质的墙体在渲染上也可能被贴上砖纹 —— 本模型没做砖纹,"
    "但这条断言管不到那条路上去。",
    "「门洞截面为梯形」量的是墩台**内侧面的倾斜**,这一条是直接可验的;"
    "梯形门洞在宋代城门中是常见做法,但不是所有宋代城门都如此。",
    "城墙的收分 1.20m 与门道 5.6/19.3m 同为 Reliability B/C 的推算值,"
    "原画是散点透视,给不出可量的平面尺寸;"
    "'桥与城门相距 38m'更是**取景需要**而非复原结论。",
    # —— 彩楼欢门 ——
    "「7 座」只证明**本场景按 7 座布置**,不证明还原了原画中可辨的那 7 家。"
    "原画是散点透视,给不出可量的平面位置;而本场景总共只有 8 栋铺面,"
    "7 座欢门挤在上面 —— **密度是被放大的**。不得以本场景的欢门密度"
    "反推汴京实况。",
    "「绑扎、无斗拱」由'声明 qm_binding=rope + 几何里索环数与声明相等 + "
    "命名中无斗拱构件'三条间接支撑。其中**索环数是真从顶点数反算的**,"
    "这一条是硬的;但'杆件之间没有榫卯'**无法从三角形网格反推** —— "
    "绑扎与榫卯在小尺度网格上都只是两根杆相交。所以这条断言证明的是"
    "「该绑扎的地方确实建了索环」,不是「几何里一定没有榫卯」。",
    "「门洞净空」量的是门洞中段最低构件的底面,这一条是**直接可验**的。"
    "但它只保证静态净空,未计入地面起伏、人流与临时摊贩。",
    "「面阔」由外皮跨度**减**柱截面得出,依赖'檐柱中心正落在分档角点上'"
    "这一建模前提;若将来柱心外移,这条量到的数会连带偏移。",
    # —— 贴图 ——
    "贴图全是**程序化生成**的(见 lib/tex_utils.py),没有任何一张来自"
    "实物照片或扫描件。它们的法线、粗糙度由同一个高度场派生,"
    "所以「瓦垄起伏」与「瓦垄明暗」在物理上是自洽的,"
    "但**不因此就更接近真实瓦片的表面** —— 它只是一张编出来的图。",
    "`tex.wired` 对账的是「config 表里声明的」与「场景材质节点树里实际挂着的」,"
    "**不能**证明这些图在网页里显示得对 —— 那取决于 three.js 侧的"
    "色彩空间与 UV 约定,是另一条链上的事(见 docs/07)。",
    "本校验跑在**导出之前**,所以它数不到 GLB 里最终有几张图、几张多大。"
    "导出器会丢弃未被引用的 image、并按 glTF 的规矩重新安排"
    "(mime、packed vs 外链)。这一条边界是**结构性的**,不是疏漏:"
    "能验 GLB 内容的只有 `tools/optimize_assets.mjs` 与 `manifest.json`。",
    "`tex.tile` 是**逐面**验的:每个面的 Δu×tile 必须等于该面沿对应世界轴的跨度"
    "(容差 1mm)。它证明「UV 确实是按世界坐标除以铺装尺寸展开的」,"
    "**不证明**那个铺装尺寸在美术上合适 —— 1.4m 一铺的瓦垄好不好看,"
    "是 `Texture.TILE_M` 里的取值问题,不是几何问题。",
    "「格眼是几何棂条」这条做法有个未处理的代价:远景会摩尔纹。"
    "`lattice` 遮罩已按 KIT 生成但未接材质,未做那一步优化 —— "
    "`Texture.UNUSED` 里登记着,不假装它生效了。",
)


# ==========================================================================
# 入口
# ==========================================================================


def validate(*, stage: int = 2, strict: bool = False, write: bool = True) -> dict:
    """
    跑全部形制断言。

    stage —— 当前构建到第几阶段。决定哪些"未执行"算数:
             只有 needs_stage <= stage 的 skip 才会在 strict 下判失败。
             `--stage 1` 时,属于阶段 2 的断言如实记为未执行但不阻塞;
             `--stage 2` 时它们全部成为硬门禁。

    strict —— 是否把"该做而没做的检查"判为失败。判据是**阶段**而不是
              "builder 恰好存在与否":后者会让 `--stage 1` 被阶段 2 的
              条目卡死,而一个总在误报的门禁很快就会被加 `--no-strict`
              绕过 —— 那就等于没有门禁。
    """
    rep = Report()
    _check_bridge(rep)
    _check_river(rep)
    _check_boats(rep)
    _check_buildings(rep)
    _check_celebrations(rep)
    _check_props(rep)
    _check_layout(rep)
    _check_coverage(rep)
    _check_textures(rep)
    _report_pending(rep, stage)

    n_pass = len(rep.passes)
    n_fail = len(rep.failures)
    n_skip = len(rep.skips)
    # strict 真正要盯的是"这个阶段本该验、却因为没实现而没验"的条目
    overdue = [c for c in rep.skips if c.needs_stage <= stage]

    result = {
        "stage": stage,
        "pass": n_pass,
        "fail": n_fail,
        "skip": n_skip,
        "overdue": len(overdue),
        "checks": [asdict(c) for c in rep.checks],
        "boundaries": list(BOUNDARIES),
    }

    # —— 打印 ——
    #
    # ⚠️ 分组顺序原先写死成一张元组,而那张元组里**没有 `市井`** ——
    #    于是 `_check_buildings` 与 `_check_celebrations` 的十来条断言
    #    全部"计数含它、明细不含它":底下印着「通过 42」,上面数得出来的
    #    行数却少一大截。**报告自己骗了自己**,而这类不符最容易被当成
    #    "打印格式的小毛病"放过去。
    #    现在改成:先按已知顺序排,凡没列到的分组一律按首次出现补在末尾。
    #    新加一个分组不可能再被漏掉 —— 漏掉的代价从"静默"变成"排最后"。
    _GROUP_ORDER = ("虹桥", "汴河", "船只", "场地", "市井", "贴图")
    seen = [c.group for c in rep.checks if c.group]
    order = [g for g in _GROUP_ORDER if g in seen]
    order += [g for g in dict.fromkeys(seen) if g not in order]
    print()
    for grp in order:
        rows = [c for c in rep.checks if c.group == grp]
        if not rows:
            continue
        print(f"  [{grp}]")
        for c in rows:
            mark = {"pass": "✓", "fail": "✗", "skip": "·"}[c.status]
            print(f"    {mark} {c.title}")
            if c.status == "pass":
                print(f"        {c.detail}")
            elif c.status == "fail":
                print(f"        期望 {c.expected}")
                print(f"        实测 {c.detail}")
            else:
                print(f"        未执行:{c.why}")
    print()
    print(f"  通过 {n_pass}  失败 {n_fail}  未执行 {n_skip}(其中 {len(overdue)} 条本阶段就该验)")

    if write:
        OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        OUT_PATH.write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        print(f"  报告:{OUT_PATH}")

    # —— 判定 ——
    msgs: list[str] = []
    if rep.failures:
        msgs.append(
            "以下形制红线未通过:\n"
            + "\n".join(
                f"    ✗ [{c.id}] {c.title}\n        期望 {c.expected}\n        实测 {c.detail}"
                for c in rep.failures
            )
        )
    if strict and overdue:
        msgs.append(
            f"阶段 {stage} 应验而未验的形制断言有 {len(overdue)} 条 —— "
            f"缺失的检查等同于未受保障:\n"
            + "\n".join(f"    · [{c.id}] {c.title} —— {c.why}" for c in overdue[:8])
            + (f"\n    …… 另有 {len(overdue) - 8} 条" if len(overdue) > 8 else "")
        )
    if msgs:
        raise AssertionError("\n\n".join(msgs))

    return result


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    st = int(argv[argv.index("--stage") + 1]) if "--stage" in argv else 2
    validate(stage=st, strict="--strict" in argv)
