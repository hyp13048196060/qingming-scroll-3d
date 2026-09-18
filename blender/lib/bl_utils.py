"""
Blender 通用工具。

两条贯穿全项目的原则写在这里,后续所有 builder 都照此办理:

1. **合批优先**。一榀虹桥有几百根梁。若每根梁建一个 object,
   网页端就是几百个 drawcall —— 阶段 0 实测过这个反模式:
   4352 个面吃掉 366 个 drawcall,合并后降到 10 个。
   所以这里用 `MeshBuilder` 把同材质的构件累积进一份顶点表,
   最后一次性生成一个 object。

2. **尺寸只从 config.py 取**。本模块不定义任何尺寸常量。
"""

from __future__ import annotations

import math
from typing import Iterable, Sequence

import bmesh
import bpy
from mathutils import Matrix, Quaternion, Vector

# `config` 是尺寸与贴图接线表的唯一来源。此前本模块刻意不 import 它
# (尺寸一律由调用方作参数传进来)。加进来是因为接线表 `Texture.MATERIAL`
# 必须由**材质库自己**读 —— 理由见 `MaterialLibrary.get` 的注释:
# 摊给 44 个调用点就等于摊给 44 次"别忘了"。
# `lib/tex_utils.py` 早已是同样的做法,所以这不算开了个新口子。
import config as C

# --------------------------------------------------------------------------
# 场景管理
# --------------------------------------------------------------------------


def clear_scene() -> None:
    """
    清空场景。

    ⚠️ 必须调用。`--factory-startup` **仍会载入默认启动场景**,
    里面有 Cube / Camera / Light。阶段 0 的 preflight 第一次导出时,
    产物里就混进了那个默认立方体。所有构建脚本第一步都要调它。
    """
    if bpy.context.mode != "OBJECT":
        bpy.ops.object.mode_set(mode="OBJECT")

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)

    # 删除失去用户的孤立数据块,避免上一次构建的残留污染统计
    for coll in (
        bpy.data.meshes,
        bpy.data.materials,
        bpy.data.armatures,
        bpy.data.images,
        bpy.data.curves,
        bpy.data.objects,
    ):
        for item in list(coll):
            if item.users == 0:
                try:
                    coll.remove(item)
                except RuntimeError:
                    # 仍被引用(例如正在被撤销栈持有),跳过即可
                    pass


_cleared = False


def clear_scene_once() -> bool:
    """
    清空场景,**每个 Blender 进程只清一次**。返回本次是否真的清了。

    为什么需要它
    ------------
    `clear_scene()` 是无条件的。阶段 1 只有一个 builder,这不是问题;
    阶段 2 起 `run_all.py` 要在**同一个 Blender 会话里顺序跑 9 个 builder**,
    而每个 builder 开头都调 `clear_scene()` —— 第二个 builder 一开跑就
    把第一个建的虹桥整个抹掉,最后导出的是一个只装了城门的残缺场景,
    且**日志上看不出任何异常**。

    用进程级的"清一次"标记同时满足两种用法:
      · `run_all.py` 顺序跑 → 第一次调用清掉 factory 启动场景,
        之后各 builder 互不干扰,场景逐个累积;
      · 单独跑某个 builder(`--python blender/build/02_river.py`)
        → 它仍是一次调用,场景照样是干净的。

    ⚠️ 不要退回成"在 builder 里裸调 clear_scene()"。
       也不要改成在 run_all 里清、builder 里不清 ——
       那样单独跑 builder 时会继承上一个进程的残留,
       而残留恰恰是最难查的一类错误。
    """
    global _cleared
    if _cleared:
        return False
    clear_scene()
    _cleared = True
    return True


def reset_clear_flag() -> None:
    """仅供测试:把"已清过"的标记复位。生产代码不要调。"""
    global _cleared
    _cleared = False


def get_collection(name: str) -> bpy.types.Collection:
    """取(或建)一个顶层集合。按区域分集合便于分块导出与统计。"""
    coll = bpy.data.collections.get(name)
    if coll is None:
        coll = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(coll)
    return coll


# --------------------------------------------------------------------------
# 材质
# --------------------------------------------------------------------------


def srgb_to_linear(c: float) -> float:
    """
    sRGB 分量 → 线性分量。

    ⚠️ 这个函数不是"可选的美化",它是本项目一次真实翻车的修复。
       `config.Palette` 里的数值是**照着取色器写的 sRGB 比例**
       (0.42 ≈ #6b,一个正经的风化木褐)。但 `Principled BSDF` 的
       Base Color 与 `Material.diffuse_color` **都是线性槽位**,
       直接写进去等于把每个通道都提亮了约 1.5 倍:
       0.42 线性 → 显示出来是 #ad,浅得像刚刨过的新木,
       整座桥连同地面一起发白(见 screenshots/web/stage1_bridge.png)。

       修在**边界上**而不是去改调色板:调色板继续用取色器里的 sRGB 数值
       (人读得懂、与美术稿对得上),进入材质时才换算。
    """
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def make_material(
    name: str,
    color: Sequence[float],
    roughness: float = 0.85,
    metallic: float = 0.0,
) -> bpy.types.Material:
    """
    建一个 Principled BSDF 材质。

    ⚠️ 不写 `mat.use_nodes = True` —— 该属性在 5.2 已标记废弃
    (预计 6.0 移除),而新建材质的 use_nodes 本来就默认为真。
    见 blender/API_NOTES.md 第 7 节。

    ⚠️ 节点必须按 `type` 查找,不能按名字 —— 非英文界面下
    "Principled BSDF" 这个名字是本地化的,按名字取会拿到 None。
    """
    mat = bpy.data.materials.new(name=name)
    # 入参是 sRGB,槽位是线性 —— 在这里换算,且只换算一次
    lin = tuple(srgb_to_linear(float(c)) for c in color)

    bsdf = next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (*lin, 1.0)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic

    # ⚠️ 同时设置 diffuse_color,这不是冗余:
    #   · Base Color 给 Cycles/EEVEE 和 glTF 导出用;
    #   · diffuse_color 是**视口显示色**,Workbench 渲的正是它。
    # Workbench 不求值着色器节点树,所以只设 Base Color 的话,
    # 预览图会整个变成灰色 —— 迭代期就完全看不出材质配色对不对。
    # 这两者必须同步,否则"预览通过、成品发灰"。
    # diffuse_color 同样是线性槽位,与 Base Color 用同一个 lin。
    mat.diffuse_color = (*lin, 1.0)
    mat.roughness = roughness
    mat.metallic = metallic
    return mat


class MaterialLibrary:
    """
    按名字缓存材质,避免同一种木头被建出几十份。

    ⚠️ **跨 builder 也要去重。** 每个 `build/xx.py` 都自建一个库,而
        `run_all.py` 一次会话里把它们全跑一遍 —— 于是 `earth` 会被
        `00_layout` 建一次、`04_buildings` 再建一次,Blender 自动改名成
        `earth.001`。后果不是"多一个材质"这么轻:两位同名但不同对象的
        材质,在 glTF 里是**两个 material**,网页侧按材质合批就合不上,
        drawcall 平白翻倍。

        所以 `get` 先查 `bpy.data.materials`,命中就复用。**但只在
        颜色/粗糙度/金属度都对得上时才复用** —— 同名不同色是写错了,
        必须当场报错。悄悄复用会产出一个"名字对、颜色是别人的"表面,
        而这种错在渲染图里看着完全正常,只有对着某个具体构件端详时
        才会发现"这家的柱子怎么是别人家的颜色"。
    """

    def __init__(self) -> None:
        self._cache: dict[str, bpy.types.Material] = {}

    def get(
        self,
        name: str,
        color: Sequence[float],
        roughness: float = 0.85,
        metallic: float = 0.0,
        tex: str | None = "__auto__",
    ) -> bpy.types.Material:
        """
        取材质,并按 `config.Texture.MATERIAL` 自动接线贴图。

        `tex` 默认 `"__auto__"` —— 查表决定。
        传具体贴图名 = 覆盖表;传 `None` = 明确不要贴图。

        ⚠️ 为什么"不写"与"写了 None"必须能分开

           `MATERIAL` 里没有这个材质名,说明**作者忘了声明它该贴什么**,
           这是一个该报错的疏漏。而 `MATERIAL[name] = None` 说明
           **作者想过了,决定不贴**。把两者合成"没贴图"一种状态,
           那么"忘了"就永远不会响,而本项目栽过的正是这个形状。
        """
        if name in self._cache:
            return self._cache[name]

        tname, tile = self._resolve_tex(name, tex)
        lin = tuple(srgb_to_linear(float(c)) for c in color)
        existing = bpy.data.materials.get(name)
        if existing is not None:
            got = tuple(existing.diffuse_color)[:3]
            # 有贴图时 diffuse_color 会被 wire() 改写成中性灰(视口显示用),
            # 所以那种情况下的比色没有意义 —— 跳过,只对纯色材质做一致性检查。
            if tname is None and max(abs(a - b) for a, b in zip(got, lin)) > 1e-4:
                raise ValueError(
                    f"材质 {name!r} 已存在,但颜色是 {got},本次要的是 {lin} —— "
                    f"同名不同色说明两处用的名字撞了。请改名(例如 "
                    f"{name}_dark / {name}_plank),不要让它悄悄复用。"
                )
            self._cache[name] = existing
            return existing

        mat = make_material(name, color, roughness, metallic)
        if tname is not None:
            # ⚠️ 必须走**包路径** `lib.tex_utils`,不能平铺 `import tex_utils`。
            #    两条路径都能 import 成功,但会造出**两个模块对象**:
            #    各自的 `_CACHE` 都是空的,于是同一种木料被烤两遍,
            #    `bpy.data.images` 里出现一对 `tex_wood_old_c` /
            #    `tex_wood_old_c.001`。带 `.001` 后缀的那张,
            #    `validate` 从名字反解不出贴图名,于是显示成"这张图没人用" ——
            #    报出来的现象与真正的原因隔着两层。
            #    平铺导入的口子也一并堵了:`tasks/preview_textures.py`
            #    原先往 sys.path 里塞了 `blender/lib`,那正是一条能让
            #    全场景悄悄烤两份的路。
            from lib import tex_utils as T

            T.wire(mat, T.get_maps(tname))
            # 铺装尺寸写在材质上,**由 MeshBuilder.build() 自己读**。
            #
            # 这是本文件里最要紧的一处设计:uv_scale 若要靠每个 builder
            # 手传,就有 40 多处"别忘了",而漏掉的表现是——网格没有 UV 层,
            # 贴图退化成 UV(0,0) 处的一个常数色。**不报错,只是变成纯色**,
            # 于是一整片屋面安静地退回没有贴图的样子。
            # 挂在材质上就没有这个口子:材质有贴图 ⇒ 必然带着铺装尺寸 ⇒
            # 用它的网格必然拿到 UV。
            mat["qm_tile_m"] = float(tile if tile is not None else C.Texture.TILE_M[tname])
            mat["qm_tex"] = tname
        self._cache[name] = mat
        return mat

    def _resolve_tex(
        self, name: str, tex: str | None | object
    ) -> tuple[str | None, float | None]:
        """把 `tex` 参数解析成 `(贴图名, 铺装覆盖)`。"""
        if tex is None:
            return None, None
        if tex != "__auto__":
            if tex not in C.Texture.SIZE:
                raise KeyError(
                    f"材质 {name!r} 指定了贴图 {tex!r},但 config.Texture.KIT 里没有它"
                )
            return str(tex), None
        if name not in C.Texture.MATERIAL:
            raise KeyError(
                f"材质 {name!r} 没有在 config.Texture.MATERIAL 里声明该贴什么。\n"
                f"  · 要贴图 → 在表里加一行 `{name!r}: (贴图名, None)`;\n"
                f"  · 不要贴 → 在表里加一行 `{name!r}: None`(写明是刻意的)。\n"
                f"  两种都要写,否则'忘了'和'不要'就分不开了。"
            )
        got = C.Texture.MATERIAL[name]
        if got is None:
            return None, None
        tname, tile = got
        if tname in C.Texture.UNUSED:
            raise KeyError(
                f"材质 {name!r} 指向的贴图 {tname!r} 已被登记为未使用"
                f"(原因:{C.Texture.UNUSED[tname]}),不能再接给材质。"
            )
        return tname, tile

    def all(self) -> Iterable[bpy.types.Material]:
        return self._cache.values()


# --------------------------------------------------------------------------
# 几何构造
# --------------------------------------------------------------------------


def _has_image_tex(mat: bpy.types.Material) -> bool:
    """
    材质是否有一张 image 贴图**接到了基色上**。

    按节点 `type` 找,不按名字 —— 非英文界面上节点名是本地化的,
    `nodes["Image Texture"]` 在那里返回 None(MCP 的说明里也记着这条)。
    只认"接到了 Base Color"的,是因为本模块要判断的是
    "这张网格需不需要 UV",而接了 roughness/法线的贴图同样需要 UV。
    所以这里其实**任何** image 节点都算数 —— 传出去的答案只用于
    "该不该报错",宽松一点更安全(宁可多报,不可漏报)。
    """
    if not mat.use_nodes or mat.node_tree is None:
        return False
    return any(n.type == "TEX_IMAGE" for n in mat.node_tree.nodes)


def _box_uv(mesh: bpy.types.Mesh, tile_m: float) -> None:
    """
    **盒式展开**:每个面按自己的**主法线轴**投影到另两个世界轴上。

    为什么给建筑做程序化展开用这个,而不是 `smart_project` 之类
    ----------------------------
    1. **不需要切缝**。智能展开要割开网格、算岛、排布,结果依赖
       网格拓扑 —— 同一批构件因为顶点顺序不同就展开得不一样,
       这与"可复现"直接冲突(统计量比对会不稳)。
    2. **世界坐标 = 不变的比例尺**。UV 直接取世界坐标除以瓦片尺寸,
       于是 20 米长的桥面和 40 厘米的桌面**用同一张图**时,
       木纹的物理宽度是一样的 —— 这正是真实材料的行为。
       换成智能展开,每件东西各占 0..1,木纹会在小物件上粗得离谱。
    3. **相邻构件的花纹对得上**。桥面板与横梁各自按世界坐标投影,
       在交界处纹路连续 —— 因为它们本来就取自同一个世界空间。

    代价:斜面(屋面)在"主法线轴切换"的那条线上 UV 会突变。
    对屋面这种"同一坡向一整片"的情况,主法线轴是同一个,不产生突变;
    真正会碰上的是穹面、球体这类连续转向的面 —— 本场景没有。
    """
    uv_layer = mesh.uv_layers.new(name="UVMap")
    inv = 1.0 / tile_m
    for poly in mesh.polygons:
        n = poly.normal
        ax = 0 if abs(n.x) >= abs(n.y) and abs(n.x) >= abs(n.z) else (
            1 if abs(n.y) >= abs(n.z) else 2)
        # 剩下两根轴即切向轴。固定用 (ax+1)%3 与 (ax+2)%3 —— 取哪两根
        # 无所谓,重要的是**同一个主法线轴的面必须用同一对**,否则
        # 同一条缝合线两侧的 UV 会对不上。
        ua, va = (ax + 1) % 3, (ax + 2) % 3
        for li in poly.loop_indices:
            co = mesh.vertices[mesh.loops[li].vertex_index].co
            uv_layer.data[li].uv = (co[ua] * inv, co[va] * inv)


def _basis(u: Vector, hint: Vector) -> tuple[Vector, Vector]:
    """
    给定轴向 u,构造一组正交基 (v, w)。

    hint 用来打破简并:当 u 与 hint 平行时必须换一个参考方向,
    否则叉乘为零向量,构件会被压成一条线。
    """
    if abs(u.dot(hint)) > 0.999:
        hint = Vector((1.0, 0.0, 0.0))
        if abs(u.dot(hint)) > 0.999:
            hint = Vector((0.0, 1.0, 0.0))
    v = hint.cross(u)
    v.normalize()
    w = u.cross(v)
    w.normalize()
    return v, w


class MeshBuilder:
    """
    把大量小构件累积进一份顶点/面表,最后一次性生成一个物体。

    这是本项目的合批手段:几百根梁 → 1 个 object → 1 个 drawcall。
    """

    def __init__(self, name: str) -> None:
        self.name = name
        self.verts: list[tuple[float, float, float]] = []
        self.faces: list[tuple[int, ...]] = []

    # —— 构件 ——

    def add_box(
        self,
        a: Vector,
        b: Vector,
        depth: float,
        width: float,
        hint: Vector | None = None,
    ) -> None:
        """
        在 a→b 之间放一根方料。

        depth 沿 v 方向、width 沿 w 方向。**v/w 的实际取法见 `_basis`:
        `v = hint × u`,`w = u × v`** —— 是叉乘,不是把 hint 对 u 做
        正交化,所以 v 一定垂直于 hint 与 u。

        ⚠️ 本函数的 v/w 与 `add_torus` 的 v/w 是**镜像**的,别照着那边推:

            add_box(u = +X, hint = 默认 +Z) → v = +Y,depth 落在 Y
                                              w = +Z,width 落在竖直方向
            add_box(u ≈ +X, hint = +Y)      → v = 径向,w = +Y 横桥向

            add_torus(axis = +X)            → v = +Y 横桥向,w = 径向

        这段注释原先写的是"默认 hint 取世界 Z,会让 width 落在桥的横向",
        那是**错的**(width 落在 +Z 竖直方向)。本项目真的照着这行注释
        推错过一次拱骨的截面朝向 —— 注释写反比没有注释更危险,
        因为它给出的是可信的错误。
        """
        u = (Vector(b) - Vector(a))
        length = u.length
        if length < 1e-9:
            return
        u.normalize()
        v, w = _basis(u, Vector(hint) if hint is not None else Vector((0.0, 0.0, 1.0)))

        base = len(self.verts)
        for p in (Vector(a), Vector(b)):
            for sv in (-1.0, 1.0):
                for sw in (-1.0, 1.0):
                    q = p + v * (sv * depth * 0.5) + w * (sw * width * 0.5)
                    self.verts.append((q.x, q.y, q.z))

        # 两端封口
        self.faces.append((base + 0, base + 1, base + 3, base + 2))
        self.faces.append((base + 4, base + 6, base + 7, base + 5))
        # 四个侧面
        for i in range(4):
            j = (i + 1) % 4
            self.faces.append((base + i, base + 4 + i, base + 4 + j, base + j))

    def add_box3(
        self,
        center: Vector,
        u: Vector,
        v: Vector,
        w: Vector,
        lu: float,
        lv: float,
        lw: float,
    ) -> None:
        """
        由**三个显式轴向**构造长方体。

        `add_box` 只给一个轴向,另两轴由 hint 叉乘推出来 —— 对"梁"够用,
        但对"板"不行:桥面板需要同时精确控制沿跨向(弦)、横桥向(宽)、
        径向(厚)三个方向,而这三个方向不一定与 hint 正交。

        参数:center 中心,u/v/w 三个单位轴向,lu/lv/lw 各自长度。
        """
        cu = Vector(u).normalized() * (lu * 0.5)
        cv = Vector(v).normalized() * (lv * 0.5)
        cw = Vector(w).normalized() * (lw * 0.5)
        c = Vector(center)

        base = len(self.verts)
        for su in (-1.0, 1.0):
            for sv in (-1.0, 1.0):
                for sw in (-1.0, 1.0):
                    q = c + cu * su + cv * sv + cw * sw
                    self.verts.append((q.x, q.y, q.z))

        # 索引 = 4·su' + 2·sv' + 1·sw',与 add_aabb 的位序一致,故面表相同
        self.faces.extend(
            [
                (base + 0, base + 1, base + 3, base + 2),
                (base + 4, base + 6, base + 7, base + 5),
                (base + 0, base + 4, base + 5, base + 1),
                (base + 2, base + 3, base + 7, base + 6),
                (base + 0, base + 2, base + 6, base + 4),
                (base + 1, base + 5, base + 7, base + 3),
            ]
        )

    def add_aabb(
        self,
        min_corner: Vector,
        max_corner: Vector,
    ) -> None:
        """
        由最小/最大角点定义一个轴对齐长方体。

        与 `add_box` 的区别:`add_box` 是"沿 a→b 放一根方料",
        截面由 depth/width 给;本方法直接给包围盒,适合金刚墙、
        台基这类**块体**。拿 add_box 去凑块体会得到一个细长的梁,
        而不是一块实体。
        """
        x0, y0, z0 = min_corner
        x1, y1, z1 = max_corner
        lo = (min(x0, x1), min(y0, y1), min(z0, z1))
        hi = (max(x0, x1), max(y0, y1), max(z0, z1))

        base = len(self.verts)
        for z in (lo[2], hi[2]):
            for y in (lo[1], hi[1]):
                for x in (lo[0], hi[0]):
                    self.verts.append((x, y, z))

        # 8 个顶点按 (z, y, x) 的二进制序排:索引 i 的位分别对应 x/y/z 的高位
        self.faces.extend(
            [
                (base + 0, base + 1, base + 3, base + 2),  # 底
                (base + 4, base + 6, base + 7, base + 5),  # 顶
                (base + 0, base + 4, base + 5, base + 1),  # 前(y-)
                (base + 2, base + 3, base + 7, base + 6),  # 后(y+)
                (base + 0, base + 2, base + 6, base + 4),  # 左(x-)
                (base + 1, base + 5, base + 7, base + 3),  # 右(x+)
            ]
        )

    def add_hexa(self, pts: Sequence[Vector]) -> None:
        """
        由 **8 个显式角点**构造一个六面体(拓扑上等价于长方体)。

        为什么需要它:`add_aabb` 要求六个面都平行于世界轴,而本项目
        真正需要的东西**恰恰是斜的** ——

            · 桥头引道:顶面从桥面标高斜下到街面;
            · 驳岸收分:内侧面沿高度向内斜收(见 config.Site 的说明);
            · 屋面举折:坡面本来就是斜的。

        拿 `add_aabb` 去拼这些,得到的是一段楼梯 —— 而且因为每级
        台阶只有几厘米高,渲染图上几乎看不出来,只有侧面掠视时才
        露馅。这类"看着没问题"的几何错误是最难查的一类。

        角点顺序与 `add_aabb` 的内部展开**完全一致**,即按
        `(z, y, x)` 的二进制序,index = 4·iz + 2·iy + ix,
        0 表示取小值的一端:

            0:(x0,y0,z0) 1:(x1,y0,z0) 2:(x0,y1,z0) 3:(x1,y1,z0)
            4:(x0,y0,z1) 5:(x1,y0,z1) 6:(x0,y1,z1) 7:(x1,y1,z1)

        所以面表可以照抄。角点坐标**不要求**真的满足 x0<x1 之类 ——
        只要保持这个拓扑次序,顶点可以任意摆放,面法线由 `build()`
        统一重算。
        """
        if len(pts) != 8:
            raise ValueError(f"add_hexa 需要 8 个角点,收到 {len(pts)} 个")
        base = len(self.verts)
        for p in pts:
            v = Vector(p)
            self.verts.append((v.x, v.y, v.z))
        self.faces.extend(
            [
                (base + 0, base + 1, base + 3, base + 2),
                (base + 4, base + 6, base + 7, base + 5),
                (base + 0, base + 4, base + 5, base + 1),
                (base + 2, base + 3, base + 7, base + 6),
                (base + 0, base + 2, base + 6, base + 4),
                (base + 1, base + 5, base + 7, base + 3),
            ]
        )

    def add_slab(
        self,
        x0: float, x1: float,
        y0: float, y1: float,
        z_at,
        thickness: float = 0.4,
    ) -> None:
        """
        铺一块**有厚度**的地面砖。`z_at(x, y)` 给顶面高度。

        ⚠️ 为什么地面要有厚度,而不干脆铺一片零厚的面:
            `MeshBuilder.build()` 末尾统一跑 `recalc_face_normals`。
            对**闭合体**,该算法能无歧义地把法线朝向外部;对一片
            孤立的面片,朝向是任意的 —— 地面有几成概率整片反面朝上,
            而 Workbench 预览默认双面渲染,**看不出来**,等到网页里
            开了背面剔除才发现地面"消失"了。
            多花 4 个面换一个确定的法线朝向,值。
        """
        corners = []
        for (x, y) in ((x0, y0), (x1, y0), (x0, y1), (x1, y1)):
            corners.append((x, y, float(z_at(x, y))))
        lo = [Vector((c[0], c[1], c[2] - thickness)) for c in corners]
        hi = [Vector(c) for c in corners]
        self.add_hexa(lo + hi)

    def add_loft(
        self,
        profile0: Sequence[Sequence[float]],
        y0: float,
        profile1: Sequence[Sequence[float]] | None = None,
        y1: float | None = None,
        *,
        cap0: bool = True,
        cap1: bool = True,
    ) -> None:
        """
        **放样**:把一个位于 XZ 平面内的闭合断面沿 Y 方向拉伸成实体。

        参数 `profile` 是 `[(x, z), …]` 的闭合多边形(首尾自动相接,
        不要重复写第一个点)。给两个断面就是渐变放样 —— 河道从近到远
        变宽变窄、船舱从船中到船首收细,都靠它。

        为什么不用 `add_slab` 拼:`add_slab` 只会铺水平面。驳岸的墙面
        是斜的、船壳是曲的,拿水平板去拼只能拼出台阶,而且这些台阶
        每一级只有几厘米 —— 渲染图上几乎看不出来,只有掠视才露馅。

        ⚠️ 断面必须是**简单多边形**(边不自交)。写成自交的(例如把
           上下两组点交错写)不会报错,但会生成一坨面片朝向混乱的
           东西,而且因为 `build()` 会重算法线,看上去还挺"正常"。
        """
        p0 = [(float(x), float(z)) for x, z in profile0]
        p1 = [(float(x), float(z)) for x, z in profile1] if profile1 is not None else p0
        if y1 is None:
            raise ValueError("add_loft 需要 y1")
        if len(p0) != len(p1):
            raise ValueError(
                f"两个断面的点数不一致({len(p0)} vs {len(p1)}),无法一一对应"
            )
        n = len(p0)
        if n < 3:
            raise ValueError(f"断面至少 3 个点,收到 {n} 个")

        base = len(self.verts)
        for x, z in p0:
            self.verts.append((x, y0, z))
        for x, z in p1:
            self.verts.append((x, y1, z))

        for i in range(n):
            j = (i + 1) % n
            self.faces.append((base + i, base + j, base + n + j, base + n + i))

        if cap0:
            self.faces.append(tuple(base + i for i in range(n - 1, -1, -1)))
        if cap1:
            self.faces.append(tuple(base + n + i for i in range(n)))

    def add_quad(self, a: Vector, b: Vector, c: Vector, d: Vector) -> None:
        """
        由 **4 个显式点**追加一个四边形。

        为什么现有的构件都不够用:`add_aabb` / `add_hexa` 只给"六面体",
        `add_loft` 只沿 Y 拉断面,`add_box3` 是长方体 —— 而**庑殿顶、
        歇山下檐、四坡屋面**这三样东西的共同点是"四条斜脊交于一点或
        一条线",没有一种长方体拓扑能表达它。硬拿 `add_hexa` 去凑,
        会让两条脊线端点被迫重合,面表里出现零面积面,`validate()`
        把退化面删掉之后剩下的是**残缺的壳** —— 而渲染图上看不出破绽,
        只有法线重算结果诡异时才露馅。

        ⚠️ 本函数**不做闭合性检查**。`build()` 末尾的 `recalc_face_normals`
            对闭合壳体才能无歧义定出外法线;用 add_quad 拼屋面时,
            必须自己把壳拼严(底面也要封上)。拼漏一面不会报错,
            但那一面附近的法线会翻。
        """
        base = len(self.verts)
        for p in (a, b, c, d):
            v = Vector(p)
            self.verts.append((v.x, v.y, v.z))
        self.faces.append((base, base + 1, base + 2, base + 3))

    def add_tri(self, a: Vector, b: Vector, c: Vector) -> None:
        """由 3 个显式点追加一个三角形。用途与 `add_quad` 相同。"""
        base = len(self.verts)
        for p in (a, b, c):
            v = Vector(p)
            self.verts.append((v.x, v.y, v.z))
        self.faces.append((base, base + 1, base + 2))

    def add_grid(
        self,
        rows: Sequence[Sequence[Vector]],
        *,
        flip: bool = False,
    ) -> None:
        """
        二维点阵 → **共享顶点**的四边形网格。

        为什么必须共享顶点,不能每个四边形各写四个点:

        1. 体积。一片 129×9 的带瓦垄屋面,共享顶点是 1161 个点;
           逐面写则是 1024×4 = 4096 个点。屋面是这个 builder 里数量
           最大的一类构件,差这 3.5 倍直接决定要不要砍瓦垄。

        2. **可量性**。形制校验要从几何里量出"瓦垄距",靠的是
           "屋面顶上一共有多少个不同的 y 值"。逐面写点时,同一个 y
           会以重复坐标出现,去重之后仍然数得出来 —— 但共享顶点时
           这个数是**结构性的**,不依赖浮点去重的容差。

        `rows[i][j]` —— 第 i 行第 j 列的点。所有行必须等长。
        `flip=True` 时反转绕序(用于朝下的面,例如檐底)。

        **返回点阵首顶点的索引。** `rows[i][j]` 的顶点索引即
        `base + i*m + j`。这不是可有可无的返回值:屋面是"上下两片网格
        + 四周封边"的闭合壳,封边必须**引用网格自己的顶点**
        (`add_quad_idx`),不能用 `add_quad` 另写一遍坐标 —— 那样封边
        与网格只是坐标重合、拓扑不相连,`recalc_face_normals` 会把
        封边当成一个独立的开壳,法线朝哪边全看运气。
        """
        if not rows or not rows[0]:
            return -1
        m = len(rows[0])
        for i, row in enumerate(rows):
            if len(row) != m:
                raise ValueError(
                    f"add_grid 的第 {i} 行有 {len(row)} 个点,首行有 {m} 个 —— "
                    f"点阵必须矩形,否则网格会错位成一团乱面"
                )
        base = len(self.verts)
        for row in rows:
            for p in row:
                v = Vector(p)
                self.verts.append((v.x, v.y, v.z))

        for i in range(len(rows) - 1):
            for j in range(m - 1):
                q = (
                    base + i * m + j,
                    base + i * m + j + 1,
                    base + (i + 1) * m + j + 1,
                    base + (i + 1) * m + j,
                )
                self.faces.append(tuple(reversed(q)) if flip else q)
        return base

    def add_quad_idx(self, i0: int, i1: int, i2: int, i3: int) -> int:
        """
        按**已有顶点索引**追加一个四边形,**不新增顶点**。

        专供"给 `add_grid` 的网格封边"用。为什么不能拿 `add_quad` 代替:
        见 `add_grid` 的返回说明 —— 另写一遍坐标得到的是**拓扑上断开**
        的两片,法线重算各自为政。

        绕序即传入顺序的绕序;`build()` 会重算,但只对**闭合**壳有效,
        所以封边时必须保证壳是严的。
        """
        self.faces.append((int(i0), int(i1), int(i2), int(i3)))
        return len(self.faces) - 1

    def add_tri_idx(self, i0: int, i1: int, i2: int) -> int:
        """按已有顶点索引追加一个三角形。用途与 `add_quad_idx` 相同。"""
        self.faces.append((int(i0), int(i1), int(i2)))
        return len(self.faces) - 1

    def add_cylinder(
        self,
        a: Vector,
        b: Vector,
        radius: float,
        segments: int = 10,
    ) -> None:
        """在 a→b 之间放一段圆柱(用于麻索、栏杆扶手等)。"""
        a = Vector(a)
        b = Vector(b)
        u = b - a
        length = u.length
        if length < 1e-9:
            return
        u.normalize()
        v, w = _basis(u, Vector((0.0, 0.0, 1.0)))

        base = len(self.verts)
        for p in (a, b):
            for i in range(segments):
                ang = 2.0 * math.pi * i / segments
                q = p + v * (math.cos(ang) * radius) + w * (math.sin(ang) * radius)
                self.verts.append((q.x, q.y, q.z))

        # 侧面
        for i in range(segments):
            j = (i + 1) % segments
            self.faces.append(
                (base + i, base + segments + i, base + segments + j, base + j)
            )
        # 端盖
        self.faces.append(tuple(base + i for i in range(segments - 1, -1, -1)))
        self.faces.append(
            tuple(base + segments + i for i in range(segments))
        )

    def add_torus(
        self,
        center: Vector,
        axis: Vector,
        major_r: float,
        minor_r: float,
        major_seg: int = 10,
        minor_seg: int = 6,
        major_r2: float | None = None,
    ) -> None:
        """
        放一个环。麻索捆扎用它表示 —— 环形最能读出"缠了一圈"的意思。

        段数刻意压低:索绑数量多(每个交叉点一个),段数一高顶点数就失控。

        ⚠️ `major_r2` 不是可有可无的参数,它是一个**几何正确性**修正。
            拱骨束的截面是**扁的**(径向 ~1.0m、横桥向 ~0.45m),
            而正圆环只有一个半径。早先只给 major_r,环就被套成
            直径 1.09m 的圆 —— 在横桥向比拱骨宽出 0.23m 悬在外面,
            渲染出来是一串"挂着的铁圈",不是"缠紧的麻绳"。

            传 major_r2 后,环在 v 方向取 major_r、在 w 方向取 major_r2,
            才能贴着扁截面的拱骨束箍紧。
            v 与 w 的方向由 `_basis(u, +Z)` 定:对本项目拱肋的切向轴,
            v = 世界 +Y(横桥向)、w = 径向。调用方按这个次序给参数。
        """
        center = Vector(center)
        u = Vector(axis)
        if u.length < 1e-9:
            return
        u.normalize()
        v, w = _basis(u, Vector((0.0, 0.0, 1.0)))

        rb = major_r if major_r2 is None else major_r2

        base = len(self.verts)
        for i in range(major_seg):
            a1 = 2.0 * math.pi * i / major_seg
            ring_c = center + v * (math.cos(a1) * major_r) + w * (math.sin(a1) * rb)
            # 环在该点的径向(由轴心指向环心)
            radial = (ring_c - center).normalized()
            for j in range(minor_seg):
                a2 = 2.0 * math.pi * j / minor_seg
                q = ring_c + radial * (math.cos(a2) * minor_r) + u * (math.sin(a2) * minor_r)
                self.verts.append((q.x, q.y, q.z))

        for i in range(major_seg):
            i2 = (i + 1) % major_seg
            for j in range(minor_seg):
                j2 = (j + 1) % minor_seg
                self.faces.append(
                    (
                        base + i * minor_seg + j,
                        base + i2 * minor_seg + j,
                        base + i2 * minor_seg + j2,
                        base + i * minor_seg + j2,
                    )
                )

    # —— 生成物体 ——

    def build(
        self,
        material: bpy.types.Material | None = None,
        collection: bpy.types.Collection | None = None,
        shade_smooth: bool = False,
        uv_scale: float | None = None,
    ) -> bpy.types.Object | None:
        """
        把累积的几何体生成一个物体。空内容返回 None。

        `uv_scale` 非 None 时生成 UV 层,**单位是"一米对应多少个 UV 单位"**
        (即贴图一次平铺覆盖多少米)。具体展开方式见 `_box_uv`。

        `uv_scale` 省略时会**自己从材质上读** —— `MaterialLibrary.get`
        把铺装尺寸写在材质的 `qm_tile_m` 上。于是 builder 那边一行都不用改,
        也就不存在"某处忘了传"这个口子。
        """
        if not self.verts or not self.faces:
            return None

        # —— 铺装尺寸:显式参数 > 材质上的 qm_tile_m ——
        if uv_scale is None and material is not None:
            uv_scale = material.get("qm_tile_m")

        # ⚠️ 材质带贴图却没有铺装尺寸 —— 报错,不静默跳过。
        #
        #    没有 UV 层的网格,贴图**不会失败**:采样点恒为 UV(0,0),
        #    整片屋面取到图上的同一个像素。于是一块"贴了瓦垄"的屋顶
        #    渲染出来是一片纯色,故障现场和"材质根本没接贴图"一模一样。
        #    而后者有 `tex.wired` 断言看着,前者没有 —— 那正好是本项目
        #    反复栽的形状:汇总说贴了,明细里没铺开,没人去对这两者。
        #    所以堵在这里,而不是等验证器。
        if uv_scale is None and material is not None and _has_image_tex(material):
            raise ValueError(
                f"{self.name!r}:材质 {material.name!r} 接了贴图,但没有铺装尺寸"
                f"(qm_tile_m)。它多半是绕过 MaterialLibrary.get 直接建的材质 —— "
                f"那样建出来的网格贴图会退化成纯色,**且不会报错**。"
                f"请走 MaterialLibrary.get,或显式传 uv_scale。"
            )

        mesh = bpy.data.meshes.new(self.name + "_mesh")
        mesh.from_pydata(self.verts, [], self.faces)
        mesh.validate(verbose=False)
        mesh.update()

        obj = bpy.data.objects.new(self.name, mesh)
        (collection or bpy.context.scene.collection).objects.link(obj)

        if material is not None:
            obj.data.materials.append(material)

        # from_pydata 的面绕序不一定一致,统一重算外法线
        bm = bmesh.new()
        bm.from_mesh(mesh)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        bm.to_mesh(mesh)
        bm.free()
        mesh.update()

        if uv_scale is not None:
            _box_uv(mesh, uv_scale)

        if shade_smooth:
            for poly in mesh.polygons:
                poly.use_smooth = True

        return obj

    # —— 统计 ——

    def stats(self) -> dict:
        """
        顶点/面/三角面。写进 stats.json 用于可复现性比对。

        ⚠️ `tris` 是**真的数出来的**,不是 `faces * 2`。
           本项目有一阵子到处写 `faces * 2`,默认"都是四边形" ——
           这个假设是错的:同一批 builder 里既有三角面(`add_tri`),
           也有 n 边形(圆柱端盖,`add_cylinder` 的盖子是一个 n 边形,
           8 段就是 6 个三角面而**不是** 2 个)。于是那个"三角面数"
           既高估三角面、又低估多边形盖,两头都不准。

           本项目里"性能数据必须真实"是硬要求,而三角面数是
           性能预算的头号分母 —— 一个偏低的假数字会让人看着预算
           很宽松。所以这里按面逐个数:`n 边形 → n − 2 个三角面`。
        """
        return {
            "verts": len(self.verts),
            "faces": len(self.faces),
            "tris": sum(len(f) - 2 for f in self.faces),
        }


# --------------------------------------------------------------------------
# 曲线工具
# --------------------------------------------------------------------------


def chord_points_on_circle(
    radius: float,
    center_y: float,
    angles: Sequence[float],
) -> list[Vector]:
    """
    圆弧上给定圆心角处的点(在 XZ 平面上,X 为跨向)。

    本项目所有拱线都走这里,保证与 config.Bridge 的圆弧定义一致。
    """
    return [
        Vector((radius * math.sin(t), 0.0, center_y + radius * math.cos(t)))
        for t in angles
    ]


def lerp_vec(a: Vector, b: Vector, t: float) -> Vector:
    return Vector(a) + (Vector(b) - Vector(a)) * t


def seg_intersect_2d(
    p1: Vector, p2: Vector, p3: Vector, p4: Vector
) -> tuple[float, float] | None:
    """
    两条线段的交点参数 (t, u),无交点返回 None。在 XZ 平面内求解。

    用来找两系统拱骨的交叉点 —— 索绑要绑在那些位置上。
    这是几何计算,不是近似:算不出交点就不该有索绑。
    """
    x1, y1 = p1.x, p1.z
    x2, y2 = p2.x, p2.z
    x3, y3 = p3.x, p3.z
    x4, y4 = p4.x, p4.z

    den = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(den) < 1e-12:
        return None  # 平行或退化

    t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / den
    u = ((x1 - x3) * (y1 - y2) - (y1 - y3) * (x1 - x2)) / den
    if 0.0 <= t <= 1.0 and 0.0 <= u <= 1.0:
        return t, u
    return None
