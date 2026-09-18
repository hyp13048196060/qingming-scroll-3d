"""
柳树与街边道具 —— 让街道读起来"有人在那儿过日子"。

为什么这一块不能省
------------------
    三维场景里最容易露怯的不是建筑,是**空**。一排房子修得再准,
    门前空无一物,读出来就是"模型"而不是"街"。原画里最抓人的恰恰
    是这些零碎:挑着的担、门口的瓮、歪着的桌凳、河岸的柳。

    但**加道具比加建筑难**:建筑有尺寸依据、有道线约束,加错了
    校验器会响;道具没有。所以这一块的两条纪律是:

    1) **宁少勿滥。** 道具是叙事的标点,不是填充。每一件都该指到
       "这家在做什么营生";
    2) **落地要准。** 悬空的篮子、插进桌面的碗、飘在河上的瓮 ——
       这些比"没有道具"更伤,而且远景里根本看不出来。所以每件的
       底面都按地面标高算,再由 `validate_scale.prop.*` 从几何复核。

形制与出处
----------
    柳树(《东京梦华录》记汴河两岸"柳阴",原画两岸柳树成行):
        存在性 A 级 —— 全卷最显眼的植被,不会看错。
        尺寸全 C 级 —— 散点透视图量不出树高,见 config.Tree 的声明。

    街边道具:
        原画中可辨的器物有竹篮、陶瓮、货袋、桌凳、独轮车、水桶、布幌。
        **它们出现在画面的哪里是清楚的,但尺寸不清楚** —— 画中没有
        比例尺。所以尺寸一律取"人的尺度"锚定(桌高及腰、凳高及膝、
        瓮高及胯)。这一条比任何考据都硬:器物服务于身体,身体没变。

推断与边界(须同步进 docs/08)
----------------------------
· **道具的种类与数量是本项目的编排,不是原画的清点。** 原画里各家
  门口摆什么,散点透视下无法逐户辨识。这里按"营生类型"分配
  (酒楼茶肆给桌凳,杂货给篮瓮袋),是**合理的推定**,不是复原。
· **柳树没有独立建模叶片**,垂枝是带叶色的锥柱。近看是"一束束枝条",
  不是"一片片叶子"。这条在近景镜头下看得出来,如实声明。
· 柳树的株距与落脚点全由种子决定,**不指向原画中的具体某一株**。
· 幌子上的字**没有做** —— 布面是纯色。宋代的店招文字需要字体与
  书写考据,本项目没有做,不放一个"看着像字"的纹理上去充数。

产出
----
    柳树  每株 2 个物体(干 / 叶),qm_kind=tree
    道具  每(铺面 × 材质)1 个物体,qm_kind=prop
    幌子  每面 1 个物体,qm_kind=prop, qm_anim=wind, 带 flex 顶点色

⚠️ 物体数说明:道具按"铺面 × 材质"成组,而不是每件一物 —— 每件一物
   能逐件量"有没有落地",但物体数会翻两三倍,而校验器量**成组件的
   包围盒底**同样抓得住"有件东西悬着"。权衡见 `validate_scale.prop`。
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
from lib import tag_utils as TU  # noqa: E402

S = C.Site
R = C.River
Tr = C.Tree
Pr = C.Prop
P = C.Palette

SEED = C.SEED + 60

# 地面标高。两岸街面与驳岸压顶之后的岸面同在 z = 0 —— 见 00_layout 的
# 各条 `_flat` 带,以及 02_river 的 `_revetment_profile` 前两点 (edge,0)
# 与 (inner,0)。**这是我的读数,不是我的设定**;若上游改了岸面标高,
# `validate_scale.prop.grounded` 会立刻报出来。
GROUND_Z = 0.0

# 道具离台基外皮的**最小**退让。台基出挑 PLINTH_FRONT_OUT,所以 off 必须
# 大于它才不会插进台基里。
MIN_OFF = 0.62


# --------------------------------------------------------------------------
# 柳树
# --------------------------------------------------------------------------


def _crown_profile() -> list[tuple[float, float]]:
    """
    叶壳的母线。**卵形** —— 这是"看着像不像柳"的关键一步。

    `(r, u)`:`r` 是半径占 `CANOPY_R` 的比例,`u` 是高度占冠高的比例
    (0 = 叶壳最低处,1 = 顶)。

    ⚠️ 为什么是**卵形**而不是伞盖形 —— 这是第三次返工的核心改动:

       伞盖形的剖面"最宽处偏下、顶上收成圆顶",渲出来是一顶蘑菇:
       一个实心的盖,底下挂一圈须。**柳不是那个形状。** 柳的叶幕
       最宽处在**腰偏上**(u≈0.56),上下都收,所以是一个立着的卵;
       更重要的是这个形状让"披挂"成立 —— 枝条自最宽处往外的下方
       一路斜挂出去,轮廓自然散开,而不是从盖沿齐齐垂下。

    ⚠️ 首项半径**不为零** —— 用 0.00 会让首环退化成 n_seg+1 个
       重合点,`add_grid` 在那里会生成一圈零面积四边形
       (靠 `mesh.validate()` 事后清掉,而清掉的后果是顶上一个洞)。
       所以顶端留一个小圆盘,再用一圈三角扇封口。

    ⚠️ 这个函数返回的是**比例**,不是坐标。改 CANOPY_R / CANOPY_H
       不会破坏卵形;改这张表才会。
    """
    return [
        (0.14, 1.00),   # 顶(小圆盘,随后扇封)
        (0.38, 0.94),
        (0.66, 0.84),
        (0.88, 0.72),
        (1.00, 0.56),   # 最宽处 —— 在**腰偏上**,不在底
        (0.99, 0.34),
        (0.92, 0.15),
        (0.78, 0.00),   # 底缘内收,给披挂的枝条让出层次
    ]


def _crown_radius(u: float, prof: list[tuple[float, float]]) -> float:
    """按高度比例 u 查母线半径 —— 垂枝要贴着叶壳外缘挂,得先知道壳有多粗。"""
    if u >= prof[0][1]:
        return prof[0][0]
    for i in range(len(prof) - 1):
        r0, u0 = prof[i]
        r1, u1 = prof[i + 1]
        if u1 <= u <= u0:
            t = (u0 - u) / max(u0 - u1, 1e-9)
            return r0 + (r1 - r0) * t
    return prof[-1][0]


def _crown_shell(bl: BU.MeshBuilder, apex: Vector, ch: float, canopy: float,
                 rng, prof: list[tuple[float, float]]) -> tuple[float, float]:
    """
    叶壳 —— 一层带噪声的钟形壳,**柳的叶量主要靠它给**。

    ⚠️ 这一步是整株柳树的第二次返工,原因记在这里:

       第一版(以及加了冠高之后的第二版)都把叶做成"从枝尖垂下来的
       线",结果都是**看得见每一根**、能透过树看见对面 —— 因为线之间
       是空气。垂枝做得再密也只是从"稀疏的线"变成"密的线",不会变成
       一蓬叶。**这不是参数没调好,是几何构成错了。**

       所以现在叶分两层:
           叶壳  —— 给出体量,负责"这是一团东西"
           垂枝  —— 给出边缘的破碎与下垂感,负责"这是柳"

       两者缺一不可:只有壳是光溜溜一个球,只有垂枝是一把天线。

    噪声加在**半径与高度两个方向**上,不是只加半径:
       只加半径,叶壳的每一环仍在同一水平面上,俯视能看见一圈圈的
       等高线;加了高度噪声,环本身才被搅乱。

    返回 `(z_lo, z_hi)` 供调用方做风动权重与对数。

    `apex` 是**叶壳的底面中心**(= 主干顶端),不是壳顶 ——
    冠是自此**往上**升 `ch` 的,不是往上长的反向。
    """
    n_seg = Tr.CROWN_SEGS
    z0 = apex.z                             # 叶壳底缘标高
    rows: list[list[Vector]] = []
    for i, (rf, uf) in enumerate(prof):
        ring: list[Vector] = []
        # 环首尾重合(多写一个点),这样 add_grid 能把整圈闭起来。
        # 代价是接缝处两个重合顶点 —— 对叶壳这种不透明的团块无所谓,
        # 不值得为它写一套环形网格的焊接。
        for j in range(n_seg + 1):
            ang = 2.0 * math.pi * j / n_seg
            # 半径噪声:每一环、每一段各抽一次。幅度随 u 增大 ——
            # 底缘散开得最利害(那里正是垂枝钻出来的地方)。
            #
            # ⚠️ 幅度从 ±0.16 提到 ±0.26 是冲着"多面体球"去的:
            #    噪声小于一个面的尺寸时,它只是把规则网格整体推歪,
            #    轮廓仍然是圆的;噪声大到与面的尺寸同量级,凸起的
            #    **面片本身**才构成轮廓,才读成一团叶。
            wob = 1.0 + rng.uniform(-0.26, 0.26) * (1.0 - 0.5 * uf)
            r = canopy * rf * wob
            dz = ch * rng.uniform(-0.09, 0.09) * (1.0 - uf)
            ring.append(Vector((apex.x + r * math.cos(ang),
                                apex.y + r * math.sin(ang),
                                z0 + ch * uf + dz)))
        rows.append(ring)

    # 喂给 add_grid。绕序**这里不用管** —— 壳是闭合的,`build()` 里的
    # `recalc_face_normals` 会按拓扑判内外,比手写绕序可靠。
    bl.add_grid(rows)

    # —— 顶端封口:一圈三角扇 ——
    # 顶上那圈小圆盘(半径 0.12×canopy)不封就是一个洞,从下方仰视
    # 会直接看穿树冠。
    r_top = canopy * prof[0][0]
    z_top = z0 + ch * prof[0][1]
    top_ring = [Vector((apex.x + r_top * math.cos(2 * math.pi * j / n_seg),
                        apex.y + r_top * math.sin(2 * math.pi * j / n_seg),
                        z_top))
                for j in range(n_seg)]
    cap_top = Vector((apex.x, apex.y, z_top + ch * 0.06))
    for j in range(n_seg):
        bl.add_tri(cap_top, top_ring[j], top_ring[(j + 1) % n_seg])

    # —— 壳底封口:也是三角扇,但**不是平的** ——
    # 中心比边缘高一点(自下方看是个浅穹顶)。站在街上抬头看柳,
    # 看到的就是这一面;一个平底会读成"一块板"。
    r_rim = canopy * prof[-1][0]
    z_rim = z0 + ch * prof[-1][1]
    rim = [Vector((apex.x + r_rim * math.cos(2 * math.pi * j / n_seg),
                   apex.y + r_rim * math.sin(2 * math.pi * j / n_seg),
                   z_rim))
           for j in range(n_seg)]
    cap_bot = Vector((apex.x, apex.y, z_rim + ch * 0.12))
    for j in range(n_seg):
        bl.add_tri(rim[j], rim[(j + 1) % n_seg], cap_bot)

    z_lo = z_rim
    z_hi = z_top + ch * 0.06
    return z_lo, z_hi


def _willow(bt: BU.MeshBuilder, bl: BU.MeshBuilder,
            base: Vector, rng, lean: Vector, near: bool = True) -> dict:
    """
    建一株柳树:**主干 → 一级枝 → 叶壳 → 垂枝**。

    四层结构的分工(每一层都不可省):
        主干    给出"树"的体量,并把冠举到人够不着的高度 ——
                柳长在岸顶,叶幕压在头顶会挡住河景;
        一级枝  把冠撑开。**全部包在叶壳里,看不见** ——
                它们的作用不是被看见,而是让叶壳之外仍有枝条的
                面积支撑(叶壳去掉时它们就是骨架);
        叶壳    给出叶的**体量**,见 `_crown_shell`;
        垂枝    给出柳的**识别特征**:下垂,以及边缘的破碎。

    ⚠️ **干与叶分两个 builder,但随机数只抽一遍。**
       最早的写法是"调用两次 `_willow`,一次给干、一次给叶" ——
       那样两次会抽到**不同的随机数**,叶与干对不上,垂枝会挂在
       与枝条无关的位置上,像飘在树边的一团絮。
       所以这里把参数一次性抽完,再把几何按材质分派到两个 builder:
           木质(主干、一级枝)   → bt
           叶质(叶壳、垂枝)     → bl

    垂枝为什么用**锥柱**而不是面片:
       面片是二维的,侧看就是一条线;而柳树在本场景里的主要出现方式是
       **掠视**(站在桥上、街上斜着看过去),那正是面片最难看的角度。
       锥柱多花三角面,换来绕树一周都有体积。

    ⚠️ **垂枝长度被 STRAND_FLOOR 夹住。** 第一版没夹,枝尖会插进地面
       以下 —— 而"垂到地下"这件事在渲出来的图上**很难发现**(柳条
       本来就在画面下缘,穿地的那一段被地面挡着),量包围盒才看得见。
       这里夹完还要**记下夹了多少条**:若夹掉的占多数,说明
       `STRAND_DROP` 与实际树高不匹配,那是个参数错误而不是正常的截断。
    """
    h = rng.uniform(*Tr.TRUNK_H)            # 净干高
    ch = rng.uniform(*Tr.CANOPY_H)          # 冠高
    r0 = rng.uniform(*Tr.TRUNK_R)
    canopy = rng.uniform(*Tr.CANOPY_R)
    drop = rng.uniform(*Tr.STRAND_DROP)
    n_branch = int(rng.integers(*Tr.N_BRANCH))
    n_strand = int(rng.integers(*Tr.N_STRAND))
    if not near:
        n_strand = max(6, int(n_strand * Tr.N_STRAND_FAR))
    prof = _crown_profile()

    # —— 主干:三段折线,向 lean 渐倾、渐细 ——
    #
    # 顶端最大偏移 = Tr.LEAN × h(见 config)。分三段而不是一段,
    # 是为了让"斜"是**弯**出来的而不是**掰**出来的 —— 一条直的斜杆
    # 看着像被风吹倒的,三段折线才像长成的。
    top = base + lean * (Tr.LEAN * h) + Vector((0.0, 0.0, h))
    trunk_pts = [
        base,
        base + (top - base) * (1.0 / 3.0) + lean * (0.05 * h),
        base + (top - base) * (2.0 / 3.0) + lean * (0.03 * h),
        top,
    ]
    seg_r = [r0, r0 * 0.80, r0 * 0.62, r0 * 0.46]
    for i in range(3):
        bt.add_cylinder(trunk_pts[i], trunk_pts[i + 1], seg_r[i + 1], segments=7)

    # —— 一级枝:自净干上部斜向**外上方**,末端落在叶壳**里面** ——
    #
    # 起点落在主干**不同高度**上(0.6–1.0 倍净干高),不是全取在顶端 ——
    # 全取顶端会得到一个"伞"形,而柳的冠是**蓬**的,枝从不同高度分出。
    #
    # ⚠️ 末端必须落在叶壳**内部**(半径 ≤ 叶壳在该高度的半径),
    #    否则枝尖从叶幕里戳出来,渲出来就是几根光杆天线 ——
    #    第一版正是这样。所以这里的 reach 要按 `_crown_radius()` 反算,
    #    不能直接取 CANOPY_R 的一个比例。
    for k in range(n_branch):
        t = 0.60 + 0.40 * (k + rng.uniform(0.0, 0.6)) / max(n_branch, 1)
        t = min(t, 1.0)
        p0 = trunk_pts[0] + (top - base) * t
        # 方位角**均分再加抖动** —— 纯随机会让枝条扎堆,一株树上一侧密
        # 一侧秃,远看就是个歪脖子的东西
        ang = 2.0 * math.pi * (k / n_branch + rng.uniform(-0.16, 0.16))
        out = Vector((math.cos(ang), math.sin(ang), 0.0))
        u_end = 0.55 + 0.20 * rng.random()          # 末端落在冠的哪个高度
        # 叶壳在 u_end 处的半径,乘 0.82 保证枝尖收在壳内
        reach = canopy * _crown_radius(u_end, prof) * 0.82 * rng.uniform(0.88, 1.0)
        mid = p0 + out * (reach * 0.62) + Vector((0.0, 0.0, ch * (u_end * 0.85)))
        end = p0 + out * reach + Vector((0.0, 0.0, ch * u_end))
        bt.add_cylinder(p0, mid, r0 * 0.36, segments=5)
        bt.add_cylinder(mid, end, r0 * 0.24, segments=5)

    # —— 叶壳 ——
    apex = Vector((top.x, top.y, top.z))
    z_shell_lo, z_shell_hi = _crown_shell(bl, apex, ch, canopy, rng, prof)

    # —— 垂枝:**披挂**在叶壳外侧,不是从底下悬挂 ——
    #
    # ⚠️ 这一段是第三次返工的第二个核心改动。前两版都把挂载点限制在
    #    叶壳底部(u ≤ 0.55),于是垂条像一圈从盖沿垂下的须。
    #    柳的枝条是**从冠顶到腰一路往外斜挂**的 —— 冠的上半部外侧
    #    也应当垂着枝条。所以:
    #
    #        挂载点的 u 取满 0–0.90,不压低;
    #        枝条下行时**跟着叶壳的外形往外走**(见下面的 mid 点),
    #        所以它贴着壳面披下来,而不是从壳里垂直穿出去。
    #
    #    这是本条从"一圈须"变成"一株柳"的关键。只加数量改不了观感:
    #    从底面挂的条再多,也还是须。
    z_lo = z_shell_lo
    z_hi = z_shell_hi
    floor_z = base.z + Tr.STRAND_FLOOR
    clamped = 0
    for _k in range(n_strand):
        u = 0.90 * (rng.random() ** 0.85)           # 上端略稀:顶部叶密,枝条少
        ang = 2.0 * math.pi * rng.random()
        cos_a, sin_a = math.cos(ang), math.sin(ang)
        # 挂载点:该高度处叶壳半径,**再加一个固定的外让量**。
        #
        # ⚠️ 早先写的是"乘 1.03"(即外放 3%)。这是错的:叶壳半径
        #    在冠顶只有 0.14×canopy ≈ 0.3m,3% 就是 9mm —— 比枝条
        #    自己的半径(35mm)还小,于是顶上的枝条**整个埋进壳里**,
        #    渲出来冠的上半部一根柳条都看不见。比例外放只在半径大的
        #    地方有效。
        #    改成固定 0.12m 之后,冠顶的枝条也露在壳外。
        standoff = 0.12
        rr_a = canopy * _crown_radius(u, prof) + standoff
        a = Vector((apex.x + rr_a * cos_a,
                    apex.y + rr_a * sin_a,
                    apex.z + ch * u))

        # 下端标高:自冠底再往下 hang。**先定底、后算长** ——
        # 反过来("先定长")会让冠顶的枝条垂到地面、冠底的枝条吊在半空,
        # 下缘变成一条斜边。
        hang = drop * rng.uniform(0.30, 1.00)
        z_b = max(apex.z - hang, floor_z)
        if apex.z - hang < floor_z:
            clamped += 1

        # 中段控制点:落在叶壳在 u_m 处的外侧。
        # `u_m` 取挂点与"壳底"之间 —— 于是枝条从挂点先**贴着壳面往外
        # 斜下**(壳在挂点以下更宽),过了最宽处(或过了壳底)才自由下垂。
        u_m = max(u - 0.32, 0.0)
        rr_m = canopy * _crown_radius(u_m, prof) + standoff
        rr_m = max(rr_m, rr_a * 0.94)               # 已过最宽处的枝条不再内收
        z_m = a.z + (z_b - a.z) * 0.45
        mid = Vector((apex.x + rr_m * cos_a, apex.y + rr_m * sin_a, z_m))

        # 自由下垂段再往外飘一点:柳条不是铅垂线,是斜淌的。
        #
        # ⚠️ 系数从 0.12 收到 0.05 并**加上随机**:0.12 时冠顶的枝条
        #    (垂距 5m)会往外飘 0.6m,加上它本来就挂在壳最宽处,
        #    整圈枝条张开成一个**均匀的帐篷** —— 每根角度都一样,
        #    所以读成"一圈铁丝"而不是柳条。随机化之后疏密不齐,
        #    轮廓才碎。
        drift = 0.05 * max(a.z - z_b, 0.0) * rng.uniform(0.35, 1.45)
        b_pt = Vector((mid.x + cos_a * drift, mid.y + sin_a * drift, z_b))

        bl.add_cylinder(a, mid, 0.035, segments=4)
        bl.add_cylinder(mid, b_pt, 0.021, segments=4)
        z_lo = min(z_lo, b_pt.z)

    return {
        "h": round(h + ch, 3),              # **总高**,不是净干高
        "trunk_h": round(h, 3),
        "canopy_h": round(ch, 3),
        "canopy_r": round(canopy, 3),
        "strands": n_strand,
        "strands_clamped": clamped,
        "branches": n_branch,
        "z_hi": z_hi,
        "z_lo": z_lo,
    }


def _willow_slots(rng) -> list[dict]:
    """
    柳树的落脚点。

    ⚠️ 三条约束是硬的,并由 `validate_scale.tree.clearance` 从几何复核:

       1. **不站进水里**:x 落在收分带的岸面上(Tree.X_BAND 8.70–9.65)。
          柳条垂到水面上是可以的(画里就是这样),但树干不能站在水里;
       2. **不扫到桥**:|y| ≥ Tree.BRIDGE_CLEAR,免得枝条扫到桥面、
          拱骨与桥上的行人;
       3. **不长在台阶上**:避开 `config.River.STEP_SITES` ——
          踏步自 8.75 起向岸内伸约 2.2m,正压在栽植带上。
          这一条是**跨模块**的:06 栽树、02 修台阶,两边各自都对,
          合起来才是错的(树从台阶里长出来)。所以落点坐标放在
          config 里共读一份,谁挪了都会同时挪另一边。

    东西两岸**各自独立抽点**,不镜像。镜像的一排树一眼就能看出是
    程序生成的 —— 而且汴河两岸的柳本来也不会对称栽。
    """
    # 台阶沿 x 自 (WATER_EDGE + COPING_WIDE + 0.10) 起向岸内伸 STEP_INNER_X。
    # ⚠️ 这两个常量都取自 config,**不在这里写数** —— 它们是 02_river
    #    `_steps` 的 `x0` 算式里仅有的两个量,搬进 config 之后两边共读一份,
    #    谁改了另一边都会跟着改。此外 `tree.clearance` 还会从**几何**上
    #    复核一遍(拿台阶物体自己的包围盒去比树的位置),算式过时也拦得住。
    step_x0 = S.WATER_EDGE + R.COPING_WIDE + 0.10
    step_reach_x = step_x0 + R.STEP_INNER_X
    # 下面"整株跳过"这个做法**建立在一条前提上**:台阶把栽植带整个盖住了,
    # 所以带内没有能让开的 x。前提是算出来的,不是猜的 —— 一旦有人把
    # X_BAND 放宽、或把 STEP_INNER_X 收小,让位就重新有了可能,
    # 那时的正确做法是挪位而不是少栽一棵。这里只**报一声**,不拦 ——
    # 前提变了不等于代码错了,但它值得让人回头看一眼。
    if step_reach_x <= Tr.X_BAND[1]:
        print(f"⚠ 台阶进深 {step_reach_x:.2f}m 未盖满栽植带 {Tr.X_BAND} —— "
              f"06_props 里\"整株跳过\"的前提不再成立,可以改为让位栽植")

    out: list[dict] = []
    for side in (1, -1):
        for band, y_rng, gap in (
            ("near", Tr.NEAR_Y, Tr.NEAR_GAP),
            ("far", Tr.FAR_Y, Tr.FAR_GAP),
        ):
            for sgn in (1, -1):
                y = sgn * y_rng[0]
                lim = sgn * y_rng[1]
                while (y + gap) * sgn <= lim * sgn:
                    y = y + sgn * gap * rng.uniform(0.75, 1.25)
                    if y * sgn > lim * sgn:
                        break
                    if abs(y) < Tr.BRIDGE_CLEAR:
                        continue

                    # 撞上台阶就**整株不栽**,而不是挪个位置硬塞。
                    #
                    # ⚠️ 原先想的是"往岸外挪 x 让开",实测行不通:
                    #    栽植带只有 0.95m 宽(X_BAND 8.70–9.65),而台阶
                    #    自 8.65 起向岸内伸 2.20m —— **带内没有任何一个 x
                    #    能避开它**。真去挪只会抽出一个越界的 x
                    #    (`ValueError: high - low < 0`)。
                    #
                    #    往 y 挪同样不行:y 是**累加**出来的,一株让路会让
                    #    后面每一株都跟着错位,而且是那种"说不上哪里怪"的错位。
                    #
                    #    剩下唯一干净的做法就是这里:**y 照常前进(所以后续
                    #    株位不受影响),只是这一格不栽**。四处踏步、每处
                    #    让开一株,总共少两三株 —— 岸边少两棵柳看不出来,
                    #    一棵柳长在台阶上是看得出来的。
                    if any(s == side and abs(y - sy) < R.STEP_HALF_Y + R.STEP_MARGIN
                           for s, sy in R.STEP_SITES):
                        continue

                    out.append({
                        "loc": Vector((side * rng.uniform(*Tr.X_BAND), y, GROUND_Z)),
                        "side": side,
                        "band": band,
                        # 向水面倾斜:东岸(+x)的柳向 −x 倾,西岸反之
                        "lean": Vector((-float(side), rng.uniform(-0.4, 0.4), 0.0)),
                    })
    return out


# --------------------------------------------------------------------------
# 街边道具
#
# 尺寸与形状全部取"人的尺度"锚定,见模块文档。造型一律走 `add_box3` /
# `add_cylinder` / 分段圆台,不用面片 —— 理由同柳枝:掠视时面片是条线。
# --------------------------------------------------------------------------


def _survey() -> list[dict]:
    """
    量出每栋沿街铺面的临街面与面阔 —— 与 `05_celebrations._survey` 同一套做法。

    判据一律取**几何**:`front` 是台基最靠河那一面的 |x|,面阔由 y 跨度给出。
    名字只用来筛"这是不是一间铺面",不用来推断它在哪。
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
            "front": min(abs(x) for x in xs),
            "y0": min(ys),
            "y1": max(ys),
        })
    out.sort(key=lambda d: (d["dirn"], d["y0"]))
    return out


def _shop_kind(bid: str) -> str:
    """
    这间铺子是做什么的 —— 由 **04 已经打好的标签**判断,不猜。

        qm_roof == "xieshan" → 二层酒楼(04 只给酒楼用歇山顶)
        有 _awning 部件        → 茶肆(凉棚)
        其余                   → 一般铺面
    """
    for o in bpy.data.objects:
        if o.get("qm_kind") != "building" or str(o.get("qm_parent")) != bid:
            continue
        if o.get("qm_roof") == "xieshan":
            return "restaurant"
        if str(o.get("qm_id", "")).endswith("_awning"):
            return "teahouse"
    return "shop"


def _yaw(v: Vector, ry: float) -> Vector:
    """把局部向量绕 z 转 ry。`add_box3` 要的是**轴向**,不是角度。"""
    c, s = math.cos(ry), math.sin(ry)
    return Vector((v.x * c - v.y * s, v.x * s + v.y * c, v.z))


def _box(b: BU.MeshBuilder, at: Vector, lx: float, ly: float, lz: float,
         ry: float = 0.0) -> None:
    """一只绕自身 yaw 旋转的长方体,**底面**落在 at.z 上。"""
    center = at + Vector((0.0, 0.0, lz * 0.5))
    b.add_box3(
        center,
        _yaw(Vector((1.0, 0.0, 0.0)), ry),
        _yaw(Vector((0.0, 1.0, 0.0)), ry),
        Vector((0.0, 0.0, 1.0)),
        lx, ly, lz,
    )


def _taper(b: BU.MeshBuilder, at: Vector,
           ring: list[tuple[float, float]], seg: int = 9) -> None:
    """
    一段**分段圆台**:按 (半径, 高度) 序列逐段摞起来。

    篮、瓮、桶的造型差别全在 ring 上 —— 鼓腹还是直筒、收口还是外翻,
    改 ring 就够了,不必各写一个函数。
    """
    for i in range(len(ring) - 1):
        _ra, za = ring[i]
        rb, zb = ring[i + 1]
        b.add_cylinder(Vector((at.x, at.y, at.z + za)),
                       Vector((at.x, at.y, at.z + zb)), rb, segments=seg)
        # 半径若**先增后减**,接口处会出现一圈朝下的台阶。补一道略大的箍
        # 盖住它 —— 竹篮本来就有箍、陶瓮的口沿本来就有凸棱,
        # 所以这一道不是打补丁,是本来就该有的东西。
        if i and ring[i - 1][0] < ring[i][0] > rb:
            b.add_cylinder(Vector((at.x, at.y, at.z + za - 0.012)),
                           Vector((at.x, at.y, at.z + za + 0.012)),
                           ring[i][0] * 1.06, segments=seg)


def _basket(b: BU.MeshBuilder, at: Vector) -> None:
    """竹篮:鼓腹、收口。"""
    r, h = Pr.BASKET_R, Pr.BASKET_H
    _taper(b, at, [(r * 0.84, 0.0), (r, h * 0.30), (r * 0.96, h * 0.80), (r * 0.78, h)])


def _jar(b: BU.MeshBuilder, at: Vector) -> None:
    """陶瓮:鼓腹、束颈、外翻口。"""
    r, h = Pr.JAR_R, Pr.JAR_H
    _taper(b, at, [(r * 0.55, 0.0), (r * 0.94, h * 0.22), (r, h * 0.48),
                   (r * 0.66, h * 0.82), (r * 0.74, h)])


def _sack(b: BU.MeshBuilder, at: Vector, ry: float) -> None:
    """货袋:一只略塌的方袋,可以转个角度码着。"""
    _box(b, at, Pr.SACK[0], Pr.SACK[1], Pr.SACK[2], ry)


def _table(b: BU.MeshBuilder, at: Vector) -> None:
    """方桌:桌面 + 四条腿。"""
    lx, ly, h = Pr.TABLE
    top_t, leg, inset = 0.055, 0.055, 0.075
    _box(b, at + Vector((0.0, 0.0, h - top_t)), lx, ly, top_t)
    for sx in (-1, 1):
        for sy in (-1, 1):
            _box(b, at + Vector((sx * (lx / 2 - inset), sy * (ly / 2 - inset), 0.0)),
                 leg, leg, h - top_t)


def _stool(b: BU.MeshBuilder, at: Vector) -> None:
    """条凳:比桌矮,面窄。"""
    lx, ly, h = Pr.STOOL
    top_t, leg = 0.045, 0.042
    _box(b, at + Vector((0.0, 0.0, h - top_t)), lx, ly, top_t)
    for sx in (-1, 1):
        for sy in (-1, 1):
            _box(b, at + Vector((sx * (lx / 2 - 0.05), sy * (ly / 2 - 0.05), 0.0)),
                 leg, leg, h - top_t)


def _barrow(b: BU.MeshBuilder, at: Vector, ry: float) -> None:
    """
    独轮车:一只轮 + 车架 + 两根把手 + 两根撑脚。

    ⚠️ 三条高度关系,**都由 `prop.grounded` 从几何复核**(远景里看不出
       "车轮陷进地里",所以肉眼靠不住):
           轮**贴着**地转 → 轮心高 = WHEEL_R
           车架面在轮心之上
           撑脚落到 z = GROUND_Z
    """
    r = Pr.WHEEL_R
    lx, ly = Pr.BARROW_L, Pr.BARROW_W
    u = _yaw(Vector((1.0, 0.0, 0.0)), ry)
    v = _yaw(Vector((0.0, 1.0, 0.0)), ry)

    hub = at + Vector((0.0, 0.0, r))
    b.add_cylinder(hub - v * 0.045, hub + v * 0.045, r, segments=12)
    deck_z = r + 0.10
    _box(b, at + Vector((lx * 0.08, 0.0, deck_z)), lx, ly, 0.05, ry)
    # 把手:自车架后缘向后上方翘
    for sy in (-1, 1):
        p0 = at + u * (-lx * 0.42) + v * (sy * (ly / 2 - 0.07)) + Vector((0.0, 0.0, deck_z))
        b.add_cylinder(p0, p0 + u * (-lx * 0.14) + Vector((0.0, 0.0, 0.30)),
                       0.028, segments=6)
    # 撑脚:落到地面
    for sy in (-1, 1):
        p0 = at + u * (lx * 0.44) + v * (sy * (ly / 2 - 0.10)) + Vector((0.0, 0.0, deck_z))
        b.add_cylinder(p0, Vector((p0.x, p0.y, GROUND_Z)), 0.024, segments=5)


def _bucket(b: BU.MeshBuilder, at: Vector) -> None:
    """水桶:矮圆桶 + 一道提梁。"""
    r, h = Pr.BUCKET_R, Pr.BUCKET_H
    _taper(b, at, [(r * 0.86, 0.0), (r, h * 0.5), (r * 0.94, h)], seg=9)
    # 提梁用两段直杆近似:桶的识别特征是"矮圆桶 + 一道梁",梁直一点
    # 不影响读,却省下半个环的分段
    apex = at + Vector((0.0, 0.0, h * 1.30))
    b.add_cylinder(at + Vector((-r, 0.0, h * 0.96)), apex, 0.012, segments=4)
    b.add_cylinder(apex, at + Vector((r, 0.0, h * 0.96)), 0.012, segments=4)


_BUILDERS = {
    "basket": lambda b, at, ry: _basket(b, at),
    "jar": lambda b, at, ry: _jar(b, at),
    "sack": lambda b, at, ry: _sack(b, at, ry),
    "table": lambda b, at, ry: _table(b, at),
    "stool": lambda b, at, ry: _stool(b, at),
    "barrow": lambda b, at, ry: _barrow(b, at, ry),
    "bucket": lambda b, at, ry: _bucket(b, at),
}

# 器物 → (材质名, Palette 属性名)。
#
# 同名同色会被 `MaterialLibrary` 复用(缓存),所以**刻意让桌凳车桶共用
# `wood_furniture`** —— 它们都是没上漆的旧木器,颜色本来就该一样,
# 而这四件占道具的大头,合成一个材质能省下大量 drawcall。
# 反过来,竹器与陶器**故意不复用柳树皮的颜色**:`MaterialLibrary.get`
# 在同名不同色时会直接报错(那是防止"两处撞名"的保护),复用名字
# 等于把两种材质的调色锁死在一起,以后想单独调竹器就得改名。
_MATERIAL_BY_KIND = {
    "basket": ("bamboo", "BAMBOO"),
    "sack": ("cloth_undyed", "CLOTH_UNDYED"),
    "table": ("wood_furniture", "WOOD_OLD"),
    "stool": ("wood_furniture", "WOOD_OLD"),
    "barrow": ("wood_furniture", "WOOD_OLD"),
    "bucket": ("wood_furniture", "WOOD_OLD"),
    "jar": ("ceramic", "CERAMIC"),
    # 幌子单独一个材质:它要和货袋区分开。**幌子是给人看的**,颜色
    # 该比装货的麻袋重一档,否则远看是一块挂起来的麻袋。
    "banner": ("cloth_banner", "CLOTH_DIM"),
}


# --------------------------------------------------------------------------
# 幌子(布招)
# --------------------------------------------------------------------------


def _banner(b: BU.MeshBuilder, x_face: float, y: float,
            z_top: float, z_bot: float, dirn: int) -> None:
    """
    一面布幌 + 挑出的竹杆。

    **垂直于铺面挂**:旗面沿挑出方向(x)展开、在 y 方向很薄。这样从街上
    走过时看到的是一面**正对着你**的布,而不是一条边 —— "幌子"的全部
    作用就是让人老远看见,侧着挂等于没挂。

    布面是**纯色**,没有做店招文字 —— 见模块文档的边界声明。
    """
    x1 = x_face - dirn * Pr.POLE_OUT          # 往街心方向挑出
    xm = 0.5 * (x_face + x1)
    b.add_cylinder(Vector((x_face, y, z_top)), Vector((x1, y, z_top)),
                   0.026, segments=5)
    # 旗面:自杆的中外段垂下。ry = π/2 让面宽**落在 x 方向**、厚度落在 y
    _box(b, Vector((xm, y, z_bot)), Pr.BANNER_W, 0.024, z_top - z_bot,
         math.pi / 2)


# --------------------------------------------------------------------------
# 布置
# --------------------------------------------------------------------------


def _footprint(kind: str) -> tuple[float, float]:
    """
    一件道具的**落地轮廓**(长, 宽),用来判断"摆得下吗"。

    圆器物(篮/瓮/桶)按**外径×外径**算 —— 它转多少度都一样占这么大地,
    所以给的是外接方而不是直径相乘的圆。宁可保守。
    """
    Pr = C.Prop
    if kind == "basket":
        d = Pr.BASKET_R * 2.0
        return (d, d)
    if kind == "jar":
        d = Pr.JAR_R * 2.0
        return (d, d)
    if kind == "bucket":
        d = Pr.BUCKET_R * 2.0
        return (d, d)
    if kind == "sack":
        return (Pr.SACK[0], Pr.SACK[1])
    if kind == "table":
        return (Pr.TABLE[0], Pr.TABLE[1])
    if kind == "stool":
        return (Pr.STOOL[0], Pr.STOOL[1])
    if kind == "barrow":
        return (Pr.BARROW_L, Pr.BARROW_W)
    raise KeyError(f"没有登记落地轮廓的器物类型:{kind}")


def _yawed_half(kind: str, ry: float) -> tuple[float, float]:
    """
    绕 z 转 `ry` 之后,轮廓在 x / y 两个方向上的**半宽**。

    ⚠️ 这是本模块第一版**漏掉的那一步**,也是门前道具互相穿模的根因:
       当时同一堆里沿 x 的间距写的是 `j * uniform(0.30, 0.52)`,
       而一只转过的货袋(0.62×0.42,ry 最大 0.7 rad)在 x 上宽
       `0.62·sin40° + 0.42·cos40° ≈ 0.72m` —— **间距比东西本身还窄**。
       于是"摆一堆"必然摆成互相插进去。间距不能是拍出来的数,
       得从**每件自己的轮廓**算出来。
    """
    lx, ly = _footprint(kind)
    ca, sa = abs(math.cos(ry)), abs(math.sin(ry))
    return (lx * 0.5 * ca + ly * 0.5 * sa, lx * 0.5 * sa + ly * 0.5 * ca)


_GAP = 0.07          # 相邻两件之间留的缝(米)
_TRIES = 40          # 一件东西最多试几个位置;试不到就**不放**,而不是硬塞


def _fits(cand: dict, placed: list[tuple[float, float, float, float]],
          x_of) -> bool:
    """候选位置与已放下的所有件都不相交?——判据与 validate 的 AABB 同源。"""
    hx, hy = _yawed_half(cand["kind"], cand["ry"])
    cx = x_of(cand)
    lo_x, hi_x = cx - hx - _GAP, cx + hx + _GAP
    lo_y, hi_y = cand["y"] - hy - _GAP, cand["y"] + hy + _GAP
    for (ax0, ay0, ax1, ay1) in placed:
        if lo_x <= ax1 and ax0 <= hi_x and lo_y <= ay1 and ay0 <= hi_y:
            return False
    return True


def _place(cand: dict, placed: list[tuple[float, float, float, float]],
           x_of) -> bool:
    """放得下就记进 `placed` 并返回 True;放不下返回 False(调用方丢弃它)。"""
    if not _fits(cand, placed, x_of):
        return False
    hx, hy = _yawed_half(cand["kind"], cand["ry"])
    cx = x_of(cand)
    placed.append((cx - hx, cand["y"] - hy, cx + hx, cand["y"] + hy))
    return True


def _prop_plan(shops: list[dict], rng) -> tuple[list[dict], int]:
    """
    决定每家铺子门前摆什么。**返回的是"要建什么",不含几何。**

    为什么把"决定"与"建"分开:布局是本模块唯一带主观编排的部分,
    单独拎出来才读得清。建几何的代码只认坐标,不参与编排。

    编排规则(**全部是本项目的推定,不是原画清点**,见模块文档):
        酒楼 / 茶肆 —— 门前摆桌凳。这是画里最明确的"门前有座"的两类,
                       也是在三维里最能说明"这是一家能坐下来吃饭的店"的器物;
        一般铺面   —— 门口码篮、瓮、货袋。堆在门边,不挡路;
        独轮车     —— 不归任何一家,单独在街面上。它是街上的"活物";
                       归了某家就成了那家的家当,读起来是两回事。

    ⚠️ **本函数现在管两件事:编排 + 摆得下。** 第二件是第一版没有的。
       第一版只按"沿 y 错开 ±0.45、沿 x 退 0.30–0.52"撒点,而那些数
       比器物本身还小,于是门前每一堆都是互相穿进去的(validate 报出
       12 对、最大 65L)。现在每件东西**先量自己的轮廓**,再在堆的
       包络里试位置,试不到就**不放这一件**。

    ⚠️ 返回 `(计划, 因摆不下而放弃的件数)`。那个计数必须往上传 ——
       "本来打算放 4 件、实际只放下 3 件"如果没人记,就成了又一次
       **汇总看不出、明细里少东西**。
    """
    out: list[dict] = []
    dropped = 0

    # 位置 → x 坐标。有铺面的按铺面外皮退 `off`,街面上的直接给 x
    def x_of(c: dict) -> float:
        s = c["s"]
        return s["dirn"] * (s["front"] - c["off"]) if s else c["x"]

    for s in shops:
        kind = _shop_kind(s["bid"])
        w = s["y1"] - s["y0"]
        # 这家门前**已经占掉的**地面(世界坐标 AABB),同一家之内共用
        placed: list[tuple[float, float, float, float]] = []

        def emit(c: dict) -> None:
            nonlocal dropped
            if _place(c, placed, x_of):
                out.append(c)
            else:
                dropped += 1

        if kind in ("restaurant", "teahouse"):
            # 桌凳成组:一张桌配两条凳,沿面阔排开,但**不排满** ——
            # 门口摆满桌椅是露天餐厅,不是铺面
            n_tab = 2 if w > 10.0 else 1
            for i in range(n_tab):
                y = s["y0"] + w * (i + 0.5) / n_tab + rng.uniform(-0.9, 0.9)
                off = rng.uniform(1.05, 1.85)
                emit({"kind": "table", "s": s, "y": y, "off": off,
                      "ry": rng.uniform(-0.25, 0.25)})
                for sy in (-1, 1):
                    # 凳子**贴着桌边**,但要让开桌腿 —— 贴多近由轮廓算,
                    # 不由常数定:桌半宽 + 凳半宽 + 缝,再打个 0.9 的折扣
                    # 让它**真的贴着**(凳子本来就是往桌边凑的)
                    thx, thy = _yawed_half("table", 0.0)
                    shx, shy = _yawed_half("stool", 0.5)
                    d = (thy + shy + _GAP) * 0.90
                    emit({
                        "kind": "stool", "s": s,
                        "y": y + sy * (d + rng.uniform(0.0, 0.10)),
                        "off": off + rng.uniform(-0.10, 0.10),
                        "ry": rng.uniform(-0.5, 0.5),
                    })
            if kind == "teahouse":
                # 茶肆门口再多一只水桶 —— 挑水、洗碗都要它
                emit({"kind": "bucket", "s": s,
                      "y": s["y0"] + w * 0.14,
                      "off": MIN_OFF + rng.uniform(0.10, 0.45), "ry": 0.0})
        else:
            # 杂货:篮 / 瓮 / 袋,在门口分成 1–2 小堆。
            # ⚠️ 这里从"沿一条线按固定步长码"改成"在堆的包络里试位置",
            #    因为器物有圆有方、还有各自的转角,一条线上的等距码放
            #    对圆器物够、对方货袋就不够。试位置对形状免疫。
            n_pile = int(rng.integers(1, 3))
            for i in range(n_pile):
                y = s["y0"] + w * (i + 0.5) / n_pile + rng.uniform(-1.0, 1.0)
                base_off = MIN_OFF + rng.uniform(0.0, 0.45)
                for _j in range(int(rng.integers(2, 5))):
                    kd = str(rng.choice(["basket", "jar", "sack"]))
                    ry = rng.uniform(-0.7, 0.7)
                    for _t in range(_TRIES):
                        # 堆的包络:贴着台基往外摊 1.3m,横向 ±0.85m。
                        # 试满就放弃 —— 门前不是仓库,挤不下就该少放一件
                        cand = {"kind": kd, "s": s,
                                "y": y + rng.uniform(-0.85, 0.85),
                                "off": base_off + rng.uniform(0.0, 1.30),
                                "ry": ry}
                        if _place(cand, placed, x_of):
                            out.append(cand)
                            break
                    else:
                        dropped += 1

        # 每家都挂幌子:铺面不挂幌,等于没有招牌
        out.append({"kind": "banner", "s": s, "y": s["y0"] + w * 0.5, "ry": 0.0})
        if w > 11.0:
            out.append({"kind": "banner", "s": s, "y": s["y0"] + w * 0.22, "ry": 0.0})

    # 独轮车:街面上的,不归铺面。
    # ⚠️ 车长 1.70m,是全场最大的落地件之一,彼此要留够 ——
    #    三处车位的 y 间距(6.5−(−24)=30.5、31−6.5=24.5)远大于车长,够。
    #    仍然走 `_place`,免得以后有人把车位挪近了而没人拦。
    street_placed: list[tuple[float, float, float, float]] = []
    for side in (1, -1):
        for y0 in (-24.0, 6.5, 31.0):
            cand = {
                "kind": "barrow", "s": None, "dirn": side,
                "x": side * rng.uniform(13.6, 18.4),
                "y": y0 + rng.uniform(-2.2, 2.2),
                "ry": rng.uniform(-0.5, 0.5),
            }
            if _place(cand, street_placed, x_of):
                out.append(cand)
            else:
                dropped += 1
    return out, dropped


# --------------------------------------------------------------------------
# 入口
# --------------------------------------------------------------------------


def build() -> dict:
    BU.clear_scene_once()
    tree_coll = BU.get_collection("柳树")
    prop_coll = BU.get_collection("道具")
    mats = BU.MaterialLibrary()

    # ⚠️ 柳树与道具用**各自独立**的 rng,不共用一个流。
    #    共用的后果:改动道具的抽取顺序,柳树的位置会跟着变 ——
    #    而这两件事之间没有任何关系。种子链上任何一处"顺手复用"
    #    都会让下游一改全改,而改的人完全想不到。
    rng_tree = np.random.default_rng(SEED)
    rng_prop = np.random.default_rng(SEED + 1)

    bark = mats.get("willow_bark", P.WILLOW_BARK, roughness=0.92)
    leaf = mats.get("willow_leaf", P.WILLOW_LEAF, roughness=0.88)

    # ===================== 柳树 =====================
    slots = _willow_slots(rng_tree)
    t_stat = {"count": 0, "faces": 0, "tris": 0, "h_min": 9e9, "h_max": -9e9,
              "strands": 0, "near": 0, "flex": 0}

    for i, sl in enumerate(slots):
        tid = f"willow_{i:03d}"
        # 干与叶分两个物体:材质不同。合在一起 Blender 会建两个材质槽,
        # 导出时仍拆成两个 primitive —— 不如一开始就分开,各自还能设 LOD
        bt = BU.MeshBuilder(f"{tid}_trunk")
        bl = BU.MeshBuilder(f"{tid}_leaf")
        # `near` 必须**先于** `_willow` 算出来:远景株的垂枝数是打过折的
        # (Tr.N_STRAND_FAR),这个折扣发生在建模里,不是在渲染里 ——
        # 详见 config.Tree.N_STRAND_FAR 的说明。
        near = sl["band"] == "near"
        st = _willow(bt, bl, sl["loc"], rng_tree, sl["lean"].normalized(), near=near)

        # ⚠️ **`shade_smooth=True` 是本项目第一次用上这个参数**,而它一直
        #    就在 `MeshBuilder.build()` 的签名里 —— 也就是说,此前**全场景
        #    每一个物体都是平直着色**,包括圆截面的树干、船舷、陶瓮。
        #
        #    柳树把这个后果暴露得最狠:叶壳是个 16×9 的网格,平直着色下
        #    每一块面各自一个法线,渲出来是**一颗多面体水晶球**。
        #    我当时的诊断是"面太大,看得出每一块" —— 于是把 12×7 提到
        #    16×9。**那是把症状当病因**:面数翻了一倍,水晶球还是水晶球,
        #    只是块小了一点。真正的原因从来不是面的数量,是**法线不连续**。
        #
        #    这一条值得记住:**"看得见多边形"有两种成因 ——
        #    轮廓不够密,和着色不连续。前者加面,后者加 smooth。**
        #    先看一眼是"边是硬的"还是"轮廓是折的",再决定动哪个。
        #
        #    树干一起平滑:它本来就该是圆的。垂枝是 4 段的方柱,
        #    平滑之后边缘会软掉一点 —— 柳条的截面本来就该是软的。
        to = bt.build(bark, tree_coll, shade_smooth=True)
        lo = bl.build(leaf, tree_coll, shade_smooth=True)
        if to is None or lo is None:
            continue

        TU.tag(to, f"{tid}_trunk", "tree", label="柳树", zone="河岸",
               lod="near" if near else "far",
               note="垂柳主干与一级枝;株位由种子决定,不指向原画中某一株")
        if near:
            # 叶**只给近景加风动权重**:远景的柳在屏幕上只有几十像素,
            # 看不出风动,却要为每株多带一套 COLOR_0 顶点属性。
            # **这是有意的取舍,不是漏了。**
            TU.tag(lo, f"{tid}_leaf", "tree", label="柳枝", zone="河岸",
                   lod="near", anim="sway", flex="flex", dynamic=True,
                   note="垂枝;叶片未独立建模,为带叶色锥柱")
            z_hi, z_lo = st["z_hi"], st["z_lo"]

            def _w(co, _hi=z_hi, _lo=z_lo):      # noqa: ANN001
                return (_hi - co.z) / max(_hi - _lo, 1e-6)

            TU.add_flex_attribute(lo, _w)
            t_stat["flex"] += 1
        else:
            TU.tag(lo, f"{tid}_leaf", "tree", label="柳枝", zone="河岸",
                   lod="far",
                   note="垂枝;叶片未独立建模,为带叶色锥柱")

        t_stat["count"] += 1
        t_stat["faces"] += bt.stats()["faces"] + bl.stats()["faces"]
        t_stat["tris"] += bt.stats()["tris"] + bl.stats()["tris"]
        t_stat["h_min"] = min(t_stat["h_min"], st["h"])
        t_stat["h_max"] = max(t_stat["h_max"], st["h"])
        t_stat["strands"] += st["strands"]
        t_stat["near"] += int(near)

    # ===================== 道具 =====================
    shops = _survey()
    plan, prop_dropped = _prop_plan(shops, rng_prop)

    # 按 (铺面, 材质) 成组。**每件一物**能逐件量"有没有落地",但物体数
    # 会翻两三倍;成组之后,校验器量成组件的**包围盒底**同样抓得住
    # "有件东西悬着",代价是量不出是**哪一件** —— 换来的是物体数减半。
    buckets: dict[tuple[str, str], BU.MeshBuilder] = {}
    bucket_kinds: dict[tuple[str, str], set[str]] = {}
    p_stat: dict[str, int] = {}
    banners: list[dict] = []

    for p in plan:
        kind = p["kind"]
        s = p.get("s")
        at = (Vector((s["dirn"] * (s["front"] - p.get("off", 0.0)), p["y"], GROUND_Z))
              if s else Vector((p["x"], p["y"], GROUND_Z)))
        if kind == "banner":
            # 幌子单独成物 —— 它要风动,不能和静态件合在一起
            banners.append({"at": at, "dirn": s["dirn"], "x_face": s["dirn"] * s["front"]})
            continue

        mat_name = _MATERIAL_BY_KIND[kind][0]
        bid = s["bid"] if s else "street"
        key = (bid, mat_name)
        if key not in buckets:
            buckets[key] = BU.MeshBuilder(f"prop_{bid}_{mat_name}")
            bucket_kinds[key] = set()
        _BUILDERS[kind](buckets[key], at, p.get("ry", 0.0))
        bucket_kinds[key].add(kind)
        p_stat[kind] = p_stat.get(kind, 0) + 1

    prop_objs = 0
    prop_faces = 0
    prop_tris = 0
    for (bid, mat_name), b in buckets.items():
        color = getattr(P, dict(_MATERIAL_BY_KIND.values())[mat_name])
        o = b.build(mats.get(mat_name, color, roughness=0.90), prop_coll)
        if o is None:
            continue
        TU.tag(o, f"prop_{bid}_{mat_name}", "prop",
               label="街边器物", zone="市井", lod="near",
               note=f"铺面 {bid} 门前的{'/'.join(sorted(bucket_kinds[key]))};"
                    f"尺寸按人体尺度锚定,形制为合理推定,非原画清点")
        prop_objs += 1
        prop_faces += b.stats()["faces"]
        prop_tris += b.stats()["tris"]

    # ===================== 幌子 =====================
    bn = 0
    banner_tris = 0
    for i, d in enumerate(banners):
        bb = BU.MeshBuilder(f"banner_{i:03d}")
        _banner(bb, d["x_face"], d["at"].y, Pr.POLE_Z,
                Pr.POLE_Z - Pr.BANNER_DROP, d["dirn"])
        o = bb.build(mats.get("cloth_banner", P.CLOTH_DIM), prop_coll)
        if o is None:
            continue
        TU.tag(o, f"banner_{i:03d}", "prop", label="幌子", zone="市井",
               lod="near", anim="wind", flex="flex", dynamic=True,
               note="布招;布面为纯色,未做店招文字(见模块文档的边界声明)")

        def _bw(co, _top=Pr.POLE_Z, _bot=Pr.POLE_Z - Pr.BANNER_DROP):  # noqa: ANN001
            return (_top - co.z) / max(_top - _bot, 1e-6)

        TU.add_flex_attribute(o, _bw)
        bn += 1
        banner_tris += bb.stats()["tris"]

    # ⚠️ 这里必须给出 `objects` 与 `tris` —— 先前没给,于是 run_all 的
    #    "合计 N 个物体"里**根本没算 06 建的东西**,而明细一栏一栏看着都在。
    #    又一次是那个老毛病:汇总报成功、明细少东西、没人去对这两者。
    #    现在两个键都在,且下面的 objects 是**按来源逐项相加**写出来的,
    #    谁加漏了一眼能看出来。
    tree_objs = t_stat["count"] * 2      # 每株:干一个、叶一个
    objects = tree_objs + prop_objs + bn
    tris = t_stat["tris"] + prop_tris + banner_tris

    # 对账:自报的物体数必须等于**集合里实际有的物体数**。
    #
    # ⚠️ 第一版这里写的是 `assert objects == tree_objs + prop_objs + bn`
    #    —— 那是**恒真**的(右边就是上一行加出来的),永远拦不住任何东西,
    #    却长得像一道校验。比没有校验更坏:它让人以为已经对过账了。
    #    拿集合去对才拦得住 —— 物体建了却没进集合、或集合里有别家建的
    #    东西,这里才会报出来。
    in_coll = len(tree_coll.objects) + len(prop_coll.objects)
    if objects != in_coll:
        print(f"⚠ 物体数对不上:自报 {objects}"
              f"(树 {tree_objs} + 道具 {prop_objs} + 幌子 {bn}),"
              f"集合里实际 {in_coll}"
              f"(柳树集合 {len(tree_coll.objects)} + 道具集合 {len(prop_coll.objects)})")

    return {
        "objects": objects,
        "tris": tris,
        "trees": t_stat["count"],
        "trees_near": t_stat["near"],
        "tree_faces": t_stat["faces"],
        "tree_h": (round(t_stat["h_min"], 2), round(t_stat["h_max"], 2)),
        "tree_strands": t_stat["strands"],
        "tree_flex": t_stat["flex"],
        "shops": len(shops),
        "prop_items": sum(p_stat.values()),
        "prop_objects": prop_objs,
        "prop_faces": prop_faces,
        "prop_by_kind": dict(sorted(p_stat.items())),
        # ⚠️ **编排打算放、但摆不下而放弃的件数。** 必须往上报:
        #    `prop_items` 只数"建成了几件",单看它永远发现不了"本来要放 4 件
        #    只放下 3 件"。有了这个数,`plan` 与 `built` 才对得上账。
        "prop_dropped": prop_dropped,
        "prop_planned": sum(p_stat.values()) + prop_dropped,
        "banners": bn,
    }


if __name__ == "__main__":
    from lib import bl_utils as _BU

    # ⚠️ `reset_clear_flag()` **一个进程只许调一次**,而且必须在最前头。
    #    重复调用的后果见 05_celebrations 同一处的注释:第二次 reset 让
    #    后面 `build()` 里的 `clear_scene_once()` 重新获得"该清场景"的
    #    资格,把刚建好的上游**整套清光**。
    _BU.reset_clear_flag()

    # 单独跑本模块读不到任何铺面(道具要按铺面位置布),所以先跑上游。
    # **只在这个自检入口里这么做** —— run_all / preview 走正常流水线。
    if "--alone" in sys.argv:
        from lib import modules as _MOD

        for _m in ("00_layout", "01_bridge", "02_river", "03_boats", "04_buildings"):
            _MOD.load_build(_m).build()

    r = dict(build())
    print("=" * 68)
    print("柳树与道具构建完成")
    print(json.dumps(r, ensure_ascii=False, indent=2))
    print("=" * 68)
