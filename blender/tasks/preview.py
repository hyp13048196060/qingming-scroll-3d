"""
Blender 侧预览渲染。

迭代期用它,而不是用 Cycles:CYCLES 渲一张要几十秒到几分钟,
WORKBENCH 是亚秒级。阶段 0 实测(preflight.py,64×64 单帧):

    EEVEE       21.163s   ← 一次性 GPU 上下文 + 着色器编译开销
    WORKBENCH    0.168s   ← 迭代预览用这个
    CYCLES       0.164s   ← 小图快,大图会显著变慢

WORKBENCH 足以检查几何与形制(有没有桥墩、拱线顺不顺、比例对不对),
这正是迭代期最需要看的东西。文档用图另走 Cycles。

预览图里两处**已知的假象**,不要当成模型的问题去"修"
----------------------------------------------------
一、水面板是**零厚度**的。水平视线看过去,它投影成一条**线**;
    没有厚度就没有面积,没有面积就没有像素 —— 于是它在图上
    **根本不画出来**,也就**不遮挡船的水下部分**。`boat_side` /
    `boat_waterline` 里船底整个露着,是这条造成的,不是船浮空了。
    吃水齐不齐由 validate 的 `boat.draft` 用实测世界顶点判定
    (5 条船都是 1.100m),不靠这两张图。

二、WORKBENCH 的 STUDIO 光不是正顶光,且 `cavity_type="BOTH"` 会在
    掠射角上把同材质的表面压暗。所以俯视必须 `shadows=False`
    (见 `standard_views` 里 `top` 的长注释),而"某处发黑"在排除
    cavity 之前不要当作几何错误。

对策不是"看得更仔细",是**让图自带刻度**:正投影机位可以声明
`refs`(见 `_ref_rows`),渲染前把每个参考标高换算成它自己那幅图里的
像素行号打出来。图从"供人眯眼看的画"变成"带刻度的读数"——
这正是本项目那四次"量具本身错了"的同一个解法。

用法:
    blender.exe --background --factory-startup --python blender/tasks/preview.py
"""

from __future__ import annotations

import math
import os
import sys
from pathlib import Path

import bpy
from mathutils import Vector

BLENDER_DIR = Path(__file__).resolve().parents[1]
PROJECT_DIR = BLENDER_DIR.parent
sys.path.insert(0, str(BLENDER_DIR))

import config as C  # noqa: E402

SHOT_DIR = PROJECT_DIR / "screenshots" / "blender"

# 预览分辨率。**相机取景要用到它**(正投影的 ortho_scale 管的是画面
# 较长的那一边,横竖比一变,同一个 ortho_scale 框住的范围就变),
# 所以只能有一个来源 —— 这里定义,setup_workbench 也读它。
PREVIEW_RES = (1400, 900)

# 水面标高。**这是一个实测值,不是假设**:`boat` 机位组的参考行一直
# 打印着 `水面:z=+0.000(river_surface.max)`。凡是拿它做判据的地方
# (`_arch_soffit_samples` 要按它剔除水下顶点),先用 `_assert_water_z`
# 核一遍 —— 水位一旦改了,这里要**报错**,而不是拿旧值继续算。
WATER_Z = 0.0


def _assert_water_z() -> float:
    """核对场景里的水面标高与 `WATER_Z` 是否一致;河没建就跳过。"""
    for o in bpy.context.scene.objects:
        if str(o.get("qm_id")) != "river_surface":
            continue
        vs = _world_verts(o)
        if not vs:
            continue
        actual = max(v.z for v in vs)
        if abs(actual - WATER_Z) > 0.05:
            raise AssertionError(
                f"场景水面在 z={actual:.3f},而 `WATER_Z` 写的是 {WATER_Z}。"
                f"按水位剔除水下顶点的判据会因此算错 —— 先对齐这个常量。"
            )
        break
    return WATER_Z


def is_preview_only(o: bpy.types.Object) -> bool:
    """
    这件物体是不是"只给预览看、不导出"?

    ⚠️ 判据是**两条同时满足**,和导出侧、报告侧用的是同一条规则
    (见 `config.Export.PREVIEW_ONLY`、`09_export.assert_preview_marks`、
    `report_objects` 的 `previewOnly`):

        · 它在 `C.Export.PREVIEW_ONLY` 声明的集合里,**并且**
        · 它带 `qm_preview` 标记。

    **只查标记是不行的。** 本文件第一版就是只查 `o.get("qm_preview")`,
    当时它恰好等于正确答案,因为今天场景里带标记的东西全部同时在
    `人物标位` 里 —— 两套判据**靠巧合一致**。往后再有人给别的物体打
    上 `qm_preview` 而没放进预览集合(导出侧对这种情况是**硬失败**,
    会明确拦下来),预览侧就会自作主张把它藏掉:一张图上少了一件
    会导出的东西,而图上看不出少了什么。

    一个口径,三处用同一条规则,差异才会在第一时间变成报错而不是
    一张看不出问题的图。
    """
    if not o.get("qm_preview"):
        return False
    declared = set(C.Export.PREVIEW_ONLY)
    if not declared:
        return False
    return bool(declared & {c.name for c in o.users_collection})


def preview_only_objs() -> list[bpy.types.Object]:
    """场景里全部"只给预览看"的物体(顺序稳定,便于日志与断言)。"""
    return sorted(
        (o for o in bpy.context.scene.objects if is_preview_only(o)),
        key=lambda o: o.name,
    )


def assert_preview_marks() -> list[bpy.types.Object]:
    """
    把导出侧的两条硬失败**在预览侧也走一遍**,返回预览专用物体。

    两条都验,方向相反:

      · 声明集合里出现了**不带标记**的网格物体 → 报错。
        它多半是真内容被手滑放进了预览集合。预览侧若不报,这张图上
        它会照常出现 —— 于是"图上看得见、GLB 里没有",而两条路都
        不吭声。这正是 `09_export.assert_preview_marks` 存在的理由。
      · 声明集合之外出现了**带标记**的物体 → 报错。
        标记写了却不生效,写的人以为它不导出,而它其实导出。
        预览侧若不报,`is_preview_only` 会返回 False(缺集合那一条),
        它照常画在图上 —— 于是**无论哪一侧都没人发现这个不一致**。

    ⚠️ 为什么要在预览侧再验一遍:预览比导出跑得早,而且它是**看图判断
       形制**的唯一依据。口径不一致时,先出错的是图 —— 图错了,后面
       所有"看着没问题"的判断都建立在错的前提上。同一条规则在
       `config.Export.PREVIEW_ONLY` 的注释里写的就是"三处用同一条"。
    """
    declared = set(C.Export.PREVIEW_ONLY)
    if not declared:
        return []

    tagged = {o for o in bpy.context.scene.objects if o.get("qm_preview")}
    in_coll = {
        o for o in bpy.context.scene.objects
        if declared & {c.name for c in o.users_collection}
    }

    unmarked = sorted(o.name for o in (in_coll - tagged) if o.type == "MESH")
    if unmarked:
        raise AssertionError(
            f"集合 {sorted(declared)} 里有 {len(unmarked)} 个网格物体没打 "
            f"`qm_preview` 标记:{unmarked[:8]}。\n"
            f"  导出侧对这种情况是硬失败(见 09_export.assert_preview_marks):"
            f"  这些集合按 `config.Export.PREVIEW_ONLY` **不导出**,而它们没"
            f"  声明自己是预览件。要么补 `TU.tag(..., preview=1)`,要么把它们"
            f"  挪出预览集合。**不会默认排除。**"
        )

    stray = sorted(o.name for o in (tagged - in_coll))
    if stray:
        raise AssertionError(
            f"{len(stray)} 个物体打了 `qm_preview` 标记,却不在 "
            f"{sorted(declared)} 里:{stray[:8]}。\n"
            f"  标记写了却不生效:它**会**进 GLB。预览侧同样不认这个标记"
            f"(`is_preview_only` 要求两条同时满足),所以它也会照常画在图上 ——"
            f" 两边都不报的话,这个不一致没有任何人会发现。"
        )

    return preview_only_objs()


def ensure_world() -> None:
    """
    建一个 world 备用。

    ⚠️ 不写 `world.use_nodes = False` —— 与 `Material.use_nodes` 同批废弃
    (预计 6.0 移除),而且这里**不需要**它:背景色走的是
    `shading.background_type = "VIEWPORT"` + `background_color`,
    与 world 的着色方式无关。v2 的日志里刷过这条 DeprecationWarning。
    """
    scene = bpy.context.scene
    if scene.world is None:
        scene.world = bpy.data.worlds.new("preview_world")


def setup_workbench(
    resolution: tuple[int, int] = PREVIEW_RES,
    shadows: bool = True,
) -> None:
    """
    配置 WORKBENCH 渲染。

    用 MATERIAL 着色,这样能顺带确认材质颜色对不对;
    开 cavity(空腔)让构件的转折面看得出来 —— 否则一堆同色木头
    会糊成一坨,分不清是拱骨还是桥板。

    shadows 可关。STUDIO 光不是正顶光,投影是斜的;正投影视图
    (俯视/侧视)里那条斜影会被误读成几何体本身的走向,故按机位关。
    """
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x, scene.render.resolution_y = resolution
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False

    shading = scene.display.shading
    shading.light = "STUDIO"
    shading.color_type = "MATERIAL"
    shading.show_shadows = shadows
    shading.show_cavity = True
    shading.cavity_type = "BOTH"
    # 世界空间光照:灯不跟着相机转,同一个面在几个机位下读数一致。
    # 理由**量过**,不是推的 —— 见下方标定表第 2 条:跨机位读数偏离 1.0 的
    # 平均幅度,相机光 0.13、世界光 0.07。改善是实的,但没到"差一倍"。
    shading.use_world_space_lighting = True
    # 背景与主题脱钩,保证无头环境下的背景色可预测
    shading.background_type = "VIEWPORT"
    shading.background_color = (0.62, 0.65, 0.68)

    # ⚠️ 必须把视图变换按回 Standard。
    #
    #    Blender 5.x 默认是 AgX:它把中间调压暗、把色彩去饱和。WORKBENCH 的
    #    MATERIAL 着色本意是"把这个材质的颜色平铺给你看",叠上 AgX 之后
    #    TILE_GREY(线性 0.073,即取色器里那个 0.30)那点灰直接掉进黑里 ——
    #    于是我在预览图上看到"屋面是黑的",差点跑去改瓦的颜色。
    #    **量具错了,不是被量的东西错了。**
    #    这是本项目第 6 次栽在同一个模式上:凡是"图上看起来如何",先问
    #    一句"取景器/变换/采样率是不是把读数改了"。
    #
    #    代价说清楚:Standard 没有高光滚降,亮部会硬切。预览只用于看几何
    #    与形制,这个代价可以接受;出文档用图要换 CYCLES,那时再决定用哪个。
    #
    # ⚠️ view_transform 是动态枚举,`enum_items` 只报 ['NONE'],不可迭代
    #    (和 render.engine、export_format 同一个坑)。只能 try/except 赋值,
    #    再**读回来**确认 —— 读回来这步不能省,否则赋值被静默忽略也发现不了。
    try:
        scene.view_settings.view_transform = "Standard"
    except TypeError as e:
        print(f"  [警告] 视图变换设不成 Standard({e});预览偏暗,读数时留意")
    got = scene.view_settings.view_transform
    if got != "Standard":
        print(f"  [警告] 视图变换实际是 {got!r},不是 Standard")
    # look 同样是动态枚举,默认读出来是 Python None(未设)。别硬赋字符串。
    try:
        if scene.view_settings.look not in ("None", ""):
            scene.view_settings.look = "None"
    except TypeError:
        pass

    # —— 曝光标定:下面是量出来的,不是调出来的 ——
    #
    # 起因:预览图上一片死黑,屋面看着是黑的。我先怀疑材质颜色写错,又怀疑
    # 是 AgX 视图变换 —— **两次都是猜,两次都没对上**。于是写了标定脚本
    # (`tasks/_calib_light.py`,用完即删):在 facade 机位上打 60×60 网格射线,
    # 按**命中的材质**自动分组,每类取中位像素,同一台相机换设置各渲一张,
    # 读回像素折成线性,除以该材质的**线性基色**,得"透光率"。
    #
    # 靶子不写死坐标 —— 机位漂了、几何改了,量到的仍是"那个材质在画面上的
    # 读数",不会量到别处去。基色也不从 `config.Palette` 取,而是**从材质节点
    # 读 `Base Color`**,那已经是 Blender 换算好的线性值,我不用再乘一次。
    #
    # 透光率(读回值 ÷ 该材质线性基色;基色列见括号):
    #
    #   设置                  road   tile_grey  wood_old  wood_plank  stone
    #                       (.214)   (.073)     (.147)     (.187)    (.133)
    #   影开 / 相机光 / e0.0  0.108    0.241      0.307      0.233     0.386  ← 旧默认
    #   影关 / 相机光 / e0.0  0.225    0.486      0.602      0.473     0.752
    #   影关 / 世界光 / e0.0  0.218    0.373      0.297      0.233     0.363
    #   影关 / 世界光 / e1.6  0.660    1.123      0.902      0.695     1.107  ← 现用
    #
    # ⚠️ 这张表我前后错了**两次**,都错在量具上,和被量的几何无关:
    #    1. 第一版拿"渲染读回的线性值"直接除以 `Palette` 里的数。但 `Palette`
    #       存的是**取色器读到的 sRGB**,写进材质时由 `bl_utils.srgb_to_linear()`
    #       换算 —— 两端不同量纲,比值整整差一个 transfer function,于是我得出
    #       "只有基色的 5%"这种吓人的结论。
    #    2. 第二版我手算换算把数补回来,却**没量读回通道本身**。实测才知道:
    #       `image.pixels` 给的是 **sRGB 编码值**,不是线性。所以现在这一步
    #       也不手算了 —— 把 `background_color` 设成已知线性值渲一张读回来对,
    #       量到 0.8078 而 sRGB(0.62)=0.8094(差 1/255 量化),通道定性确认。
    #    **凡是"这个数要经一层换算",那层换算本身就得先量。**
    #
    # 三条结论,写进代码而不是写进我的记忆:
    #
    # 1) **阴影关掉。** 开着它 road 只有基色的 0.108、tile_grey 0.241;关掉后
    #    0.225 / 0.486,整体抬一倍。画面里那两大片死黑就是它,而且整片地面被
    #    一柄粗制平行光切成黑白两块 —— 我先前把那条斜的分界读成了"地面是斜的"。
    #    它带来的信息(cavity 已经给了转折)不值这个代价。需要时仍可按机位显式
    #    打开(见各机位 dict 的 "shadows")。
    #
    # 2) **世界光不是为了更亮,是为了更稳。** 跨机位实测(facade 与 roofs 两图
    #    读数之比,1.000 为完全一致):
    #        物体                  相机光   世界光
    #        mid_frame_e           0.729    0.946
    #        mid_roof_e            1.017    1.089
    #        shop_e0_0_lou_frame   0.840    0.909
    #        shop_e0_0_lou_roof    1.093    1.179
    #        shop_e0_1_cha_roof    1.033    1.000
    #        岸线_路                1.210    1.016
    #    偏离 1.0 的平均幅度:相机光 0.13、世界光 0.07 —— 世界光稳约一倍。
    #    ⚠️ 我先前在这儿写的是"相机光下差出一倍",**这是夸大的**:实测最坏
    #    0.729 / 1.210,是 ±27%,不是 ×2。而且剩下的 0.07 里还混着真实的
    #    几何差异(同一个物体在不同机位露出的是不同的面),不是纯光照误差。
    #
    # 3) **Workbench 不是测光表。** 即使现用的这档,读数也在基色的 0.66~1.12
    #    之间浮动。"这瓦颜色对不对""是不是太暗了"这类判断**不能从预览图上读**;
    #    预览只用来看几何与形制 —— 转折面、举折曲线、瓦垄间距、构件有没有漏。
    #    材质颜色要走另一条路量(读材质节点的基色,不经过渲染)。
    #
    # 曝光 1.6 档 ≈ ×3.0:把透光率从 0.22~0.75 抬到 0.66~1.12,即**大致回到
    # 基色本身**。这是照着"让读数落在基色附近"定的,不是审美调光。
    scene.view_settings.exposure = 1.6

    ensure_world()


def make_camera() -> bpy.types.Object:
    cam_data = bpy.data.cameras.new("preview_cam")
    cam = bpy.data.objects.new("preview_cam", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    bpy.context.scene.camera = cam
    return cam


def aim_camera(
    cam: bpy.types.Object,
    location: Vector,
    target: Vector,
    ortho: bool,
    ortho_scale: float = 32.0,
    lens: float = 50.0,
) -> None:
    """把相机放到 location 并对准 target。"""
    cam.location = Vector(location)
    direction = Vector(target) - Vector(location)
    # 相机朝自身 −Z 看;to_track_quat 给出的旋转正合适
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    cam.data.type = "ORTHO" if ortho else "PERSP"
    if ortho:
        cam.data.ortho_scale = ortho_scale
    else:
        cam.data.lens = lens


def render_to(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.context.scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)
    return path


# --------------------------------------------------------------------------
# 标准机位
#
# 机位是**为检查形制而选**的,不是为了好看:
#   侧视   —— 看拱线、拱矢、有没有桥墩、两系统是否分层
#   桥下   —— 从水面往上看,桥墩/桥柱若存在一定藏不住
#   俯视   —— 看两系统与横梁的平面关系、索绑分布是否均匀
#   三四分之三 —— 综合观感
# --------------------------------------------------------------------------
def _is_bridge_fabric(obj: bpy.types.Object) -> bool:
    """
    这件东西是**虹桥自己的一部分**吗?

    ⚠️ 判据用 `qm_id` 前缀,不用 `qm_kind`。实测:`虹桥_索绑`(麻索捆扎)
       的 `qm_id` 是 `bridge_lash`,而 `kind` 打的是 **`prop`** ——
       拱骨/桥面/栏杆都是 `bridge`,只有索绑是 `prop`(见
       `01_bridge.py` 的 tag 调用)。原先这里按 `kind == "bridge"` 判,
       于是每次射线命中的是**索绑**时,就被判成"有东西挡住视线",
       而挡住视线的其实是桥自己的麻索。

       索绑归 `prop` 是它自己的一个语义问题(它其实是受力构件,
       不是陈设),但**那是另一件事**:在这里我要问的是"挡路的是不是桥",
       而 `qm_id` 前缀把这个问题的答案写得比 `kind` 准。
       ——顺带:`prop` 这个归类目前在网页侧还没有消费者(stage 3 未开工),
       所以它只是潜在问题,不是当下缺陷;等 `propsAnim.ts` 真的按 kind
       分发时再定夺,不在这里顺手改。
    """
    return str(obj.get("qm_id", "")).startswith("bridge_")


def _arch_soffit_samples(n: int = 9) -> list[Vector]:
    """
    沿拱骨取 n 个采样点(按 x 均匀取),给 `under` 机位做通视判据。

    ⚠️ **剔除水面以下的顶点**。实测:拱骨最低的两个顶点在
       z = **−0.71**,比水面(z = 0)还低 —— 那是拱脚埋进河床/岸里的
       一段。相机在 z = 0.35,朝它们打射线是**向下**的,必然先命中
       `河道_水面`。于是"每个候选站位都被挡"成了恒真命题,
       搜索永远找不到解,而报错只说"最后一个候选被水挡住" ——
       看着像"河里船太多",其实是**判据里混进了永远不可能通过的点**。

       这两个点也不该在判据里:水面以下看不见的东西,不构成
       "这张图能不能看清拱腹"的问题。
    """
    arms = [o for o in bpy.context.scene.objects
            if o.type == "MESH"
            and str(o.get("qm_id", "")).startswith("bridge_arch")]
    verts = [v for o in arms for v in _world_verts(o)]
    if not verts:
        raise AssertionError(
            "找不到 `bridge_arch` 的顶点 —— `_arch_soffit_samples` 无从取值。"
            "拱骨没建起来的话,`under` 机位要问的问题本身就不成立。"
        )

    wl = _assert_water_z()
    above = [v for v in verts if v.z > wl + 0.5]
    if len(above) < n:
        raise AssertionError(
            f"拱骨水面以上(z > {wl + 0.5})只剩 {len(above)} 个顶点,"
            f"取不出 {n} 个采样点。拱是不是沉进水里了?"
        )
    above.sort(key=lambda v: v.x)
    idx = [round(i * (len(above) - 1) / (n - 1)) for i in range(n)]
    return [above[i] for i in idx]


def _under_view_y(start: float = -4.6, limit: float = -40.0,
                  step: float = 0.4) -> float:
    """
    河心线上,能**真正看见整条拱腹**的那个 y —— `under` 机位的站位。

    ⚠️ 为什么不能写死,以及为什么"不撞船包围盒"还不够。

       v1 写死 y = −11。射线一查,正前方是 `boat_cao_hero_hull`:
       (1000,450)、(1200,700)、(780,200) 三个点全命中同一块船壳 ——
       画面右边三分之二是一条船的内壁,桥腹只占左边一角。标签写着
       "有桥墩必露馅",而这张图答不了那个问题。

       v2 改成"退到离所有船包围盒 0.5m 以外"。它退到了 y = −15.8,
       画面确实好了很多,但**东侧拱脚仍然被挡住** —— 再打射线,
       (880,620) 又命中 `boat_cao_hero_hull`。原因:主角船停在
       y ≈ −14…−6,那一段在相机**前方**。"不撞包围盒"问的是
       「我站的地方有没有船」,而这里要问的是
       「我和拱腹之间有没有船」—— 两个问题,我答错了那一个。

       所以判据换成**通视**:从候选站位向拱腹 n 个采样点各打一条射线,
       只要有一个点**第一个撞上的不是虹桥**这个站位就不合格。
       这正是 `probe_pixel.py` 用的那把尺子 —— 它不依赖顶点分布、
       不依赖包围盒,命中什么就报什么。

    取**由近及远第一个**合格的站位:越近的站位桥在画面里越大,
    细节越好看,所以不是"随便找一个能用的"。

    找不到就抛错,并把**各类挡路者各出现多少次**一并报出来 ——
    原先只念最后一个候选,读起来像"河上船太多",而实际可能是
    像 z = −0.71 那种永远不可能通过的点混了进来。报错要能指向原因,
    不能只指向症状。
    """
    samples = _arch_soffit_samples()
    dg = bpy.context.evaluated_depsgraph_get()
    scene = bpy.context.scene

    def blockers(y: float) -> list[str]:
        """这个站位被哪些东西挡着。空列表 = 通视。"""
        origin = Vector((0.0, y, 0.35))
        out = []
        for p in samples:
            direction = p - origin
            if direction.length < 1e-6:
                continue
            hit, _loc, _n, _i, obj, _m = scene.ray_cast(
                dg, origin, direction.normalized()
            )
            if not hit or _is_bridge_fabric(obj):
                continue          # 没东西 / 撞上的正是虹桥 —— 都不算挡
            out.append(f"{obj.name}({obj.get('qm_kind') or '无标签'})")
        return out

    tally: dict[str, int] = {}
    y = start
    while y >= limit:
        hit_list = blockers(y)
        if not hit_list:
            print(f"  [机位] under 站位 y={y:.1f}:"
                  f"到拱腹 {len(samples)} 个采样点全部通视")
            return y
        for b in hit_list:
            tally[b] = tally.get(b, 0) + 1
        y -= step

    worst = sorted(tally.items(), key=lambda kv: -kv[1])[:5]
    raise AssertionError(
        f"河心线上 y ∈ [{start}, {limit}] 找不到能看见拱腹的站位。"
        f"候选站位各采样点累计被挡 {sum(tally.values())} 次,"
        f"挡路者计数:{worst}。"
        f"`under` 机位会渲出「只看得见一部分的桥」,答不了有没有桥墩。"
    )


def standard_views() -> list[dict]:
    """四个机位,外加一个背面机位 —— 原画没画背面,更要专门看一眼。"""
    crown_z = 5.6
    return [
        {
            "name": "side",
            "label": "侧视(正投影)— 查拱线、拱矢、两系统分层",
            # ⚠️ 标签原先还写着"有无桥墩",但**这张图答不了那一问**:
            #    桥沿 X 展开,两端拱脚正好被岸上两行柳树挡住(柳树比
            #    拱脚高),图上拱脚是没入柳荫里的。看图的人若照标签去
            #    找桥墩,找不着只能记成"没有" —— 而"看不见"和"没有"
            #    在图上长得一模一样。
            #
            #    桥墩这一问交给两个更硬的判据:
            #      · `under` 机位 —— 从河面向上看拱腹,桥墩在那里无处可藏;
            #      · `validate_scale.py` 的 `桥墩数量 = 0` 硬门禁(机器断言,
            #        不依赖我看不看得见)。
            #    标签只留它真的能呈现的:拱线、拱矢、两系统分层。
            "loc": (0.0, -70.0, crown_z / 2),
            "target": (0.0, 0.0, crown_z / 2),
            "ortho": True,
            "ortho_scale": 30.0,
            "refs": [
                {"label": "桥面顶", "id": "bridge_deck", "edge": "max"},
                {"label": "桥面板底", "id": "bridge_deck", "edge": "min"},
            ],
        },
        {
            "name": "under",
            "label": "水面仰视 — 站在河里往上看,有桥墩必露馅",
            "loc": (0.0, _under_view_y(), 0.35),
            "target": (0.0, 0.0, 4.0),
            "ortho": False,
            "lens": 18.0,
            "shadows": False,
        },
        {
            "name": "top",
            "label": "俯视(正投影)— 查横梁与索绑的平面分布",
            "loc": (0.0, 0.0, 60.0),
            "target": (0.0, 0.0, 0.0),
            "ortho": True,
            "ortho_scale": 30.0,
            # ⚠️ 必须关阴影。WORKBENCH 的 STUDIO 光不是正顶光,
            #    拱骨会在桥面上投下**斜向的**长影,在俯视图里看起来
            #    就像桥面被一条对角线切开 —— v1 的俯视图就被这个误导过。
            "shadows": False,
        },
        {
            "name": "three_quarter",
            "label": "三四分之三视角 — 综合观感",
            "loc": (24.0, -22.0, 13.0),
            "target": (0.0, 0.0, 3.2),
            "ortho": False,
            "lens": 45.0,
        },
        {
            "name": "rear",
            "label": "背面视角 — 原画未交代的那一面,专门查它合不合理",
            "loc": (-26.0, 21.0, 11.0),
            "target": (0.0, 0.0, 3.4),
            "ortho": False,
            "lens": 45.0,
        },
    ]


def render_views(prefix: str, views: list[dict] | None = None) -> list[Path]:
    """
    按机位列表逐个渲染。返回产出的文件路径。

    `views=None` → 用 `standard_views()`(默认那组);
    `views=[]`   → **拒绝**,不退回默认。

    ⚠️ 这两者的区别必须保住。原先写的是 `for v in views or standard_views()`,
       而**空列表是 falsy** —— 于是一个"该出图但一个机位都没算出来"的
       机位组,会安安静静地渲出**整组默认机位**。图上看着完全正常
       (有桥有河有房子),只是那根本不是你要看的东西。本项目已经
       栽过一次同形状的(打错组名 → `.get()` 返回 None → 默认机位,
       见 `__main__` 里那段注释);这次是从另一扇门进来的。
       调用方"没给偏好"和"算出来是空的"是两件事,不该共用一个分支。
    """
    if views is not None and not views:
        raise ValueError(
            f"机位组算出来是**空的** —— 不退回默认机位,也不产出图。"
            f"空表通常意味着取物条件没匹配上任何物体(名字改了、集合空了、"
            f"`_objs_where` 的过滤太严),而不是'这次没什么好看的'。"
            f"先查取物条件,别把默认机位当成结果。"
        )
    vs = views if views is not None else standard_views()

    # 机位名进文件名(`{prefix}_{v['name']}.png`),所以它**必须存在、唯一**。
    #   同名 = 两个机位写同一个路径:前一张被后一张盖掉,盘上少一张,
    #   而"渲了 N 张"的计数里算了两次 —— **计数是假的,图也是缺的**,
    #   偏偏日志上一切正常。实测栽过一次:`char_pose_None` 出现两次
    #   (两个没有 `qm_pose` 的家什被当成了人,见 `characters_views`)。
    seen: dict[str, int] = {}
    for v in vs:
        n = v.get("name")
        if not isinstance(n, str) or not n:
            raise ValueError(
                f"机位没有可用的 `name`(取到 {n!r})—— 文件名无从拼起。机位:{v!r}"
            )
        seen[n] = seen.get(n, 0) + 1
    dupes = sorted(k for k, c in seen.items() if c > 1)
    if dupes:
        raise ValueError(
            f"机位名重复:{dupes} —— 它们会写同一个文件,前一张被后一张盖掉,"
            f"实际张数比日志少,而缺的那几张不会报错。先修名字。"
        )

    cam = make_camera()
    out: list[Path] = []

    for v in vs:
        # 每个机位可单独开关阴影。**默认关** —— 见 `setup_workbench` 里那张
        # 标定表:开着它,同一块屋面在不同机位下读数差一倍,而且地面会被切出
        # 一片一片的黑白块(我把它误读过一次)。要它的时候按机位显式写
        # "shadows": True,别改这里的默认值。
        setup_workbench(shadows=bool(v.get("shadows", False)))
        aim_camera(
            cam,
            Vector(v["loc"]),
            Vector(v["target"]),
            ortho=bool(v.get("ortho")),
            ortho_scale=float(v.get("ortho_scale", 32.0)),
            lens=float(v.get("lens", 50.0)),
        )
        refs = _ref_rows(v)
        for line, _row in refs:
            print(f"    {line}")
        path = shot_dir_join(f"{prefix}_{v['name']}.png")

        # —— 机位可以要求"只留这一件"(近景机位需要)—— #
        #
        # ⚠️ 人物近景原先**没有**这个开关,于是标签写着"单具近景(carry)"
        #    而画面里站着三具:模板之间只隔 0.95m,45mm 镜头退到 3.5m
        #    处能看见 2.8m 宽,邻居必然入镜。图上看着是张正常的特写,
        #    只是它回答的不是标签问的问题 —— 又一例。
        #
        #    判据:`only` 指到的东西必须真的存在。指到空集却照渲不误,
        #    出来的是**一张没有任何主角的"特写"**。
        only = v.get("only")
        stashed: list[tuple] = []
        if only:
            matched = [
                o for o in bpy.context.scene.objects
                if str(o.get("qm_id", "")) == only
                or str(o.get("qm_id", "")).startswith(f"{only}_")
            ]
            if not matched:
                raise ValueError(
                    f"机位 {v['name']!r} 要求只留 {only!r},但场景里没有这个 "
                    f"qm_id。它会渲出一张空场景,而空场景看着像「背景很干净」。"
                )
            for o in bpy.context.scene.objects:
                if "qm_id" not in o or o in matched:
                    continue
                stashed.append((o, o.hide_render))
                o.hide_render = True

        # —— 预览专用标记默认藏起来 —— #
        #
        # `qm_preview` = "只给预览看、**不导出**"。`08_assembly` 第四节按这个
        # 标记建了两件标位柱,画出 48 个演员走位/站位的车道
        # (见 `08_assembly.标位柱物体`)。它们在 `人物标位` 集合里,而导出是
        # 按**分块集合**取物的,这一集合不在任何分块里 —— 于是它们干净地
        # 不进 GLB(实测:场景 234 件,导出 232 件,差的正是这两件;
        # 它们的材质也因此不在 GLB 的材质表里)。
        #
        # 问题只出在预览这一侧:预览是**直接渲整个场景**的,于是每张图上
        # 都画着两条线。看图的人会得出"模型里插了两根杆子"这个结论 ——
        # 而那个结论**在 GLB 上是对的、在画面上也是对的,只有
        # '这是上线的东西' 这一层是错的**。
        #
        # 判据:预览图呈现**会上线的东西**,所以取"不导出"这个集合的
        # 补集。看标位柱的机位显式写 `"markers": True`(见 `site_views`
        # 的 actor_lanes),那时标签里必须写明它不导出 —— 图上看不出导不导出。
        if not v.get("markers"):
            for o in bpy.context.scene.objects:
                if is_preview_only(o) and not o.hide_render:
                    stashed.append((o, o.hide_render))
                    o.hide_render = True
        try:
            render_to(path)
        finally:
            for o, was in stashed:
                o.hide_render = was
        for line in _verify_ref_rows(path, v, refs):
            print(f"    {line}")
        out.append(path)
        print(f"  渲染 {v['name']:<14} {v['label']}")

    # 清掉预览相机,避免它被导进 GLB
    bpy.data.objects.remove(cam, do_unlink=True)
    return out


def shot_dir_join(name: str) -> Path:
    return SHOT_DIR / name


def _world_verts(obj: bpy.types.Object) -> list[Vector]:
    """
    物体的**世界**顶点,逐个顶点算。

    ⚠️ 陷阱一:`rotation_euler` 改完不刷依赖图,`matrix_world` 还是旧的。
       实测过 —— 同一份场景,不刷图时眠桅的桅量出来是立着的 6.959
       (把局部坐标当成了世界坐标),刷完图才是 1.749。差 5.2m,
       足够把机位整个带偏,而画面看着只像"模型不对"。

    ⚠️ 陷阱二:不要用 `o.bound_box`。那是**局部包围盒的 8 个角点**,
       经 `matrix_world` 一乘,对转过的物体会得到虚胖的结果:
       眠桅按角点算高度是 6.959,按顶点算才是 1.749。同一个数,
       两种量法差 5.2m。
    """
    return [obj.matrix_world @ v.co for v in obj.data.vertices]


def _bbox_of(qm_id: str) -> tuple[Vector, Vector] | None:
    """按 `qm_id` 找出物体的**世界**包围盒。找不到返回 None,由调用方决定怎么办。"""
    objs = [
        o for o in bpy.context.scene.objects
        if o.type == "MESH" and o.get("qm_id") == qm_id
    ]
    pts = [p for o in objs for p in _world_verts(o)]
    if not pts:
        return None
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def _bbox_max_z(qm_id: str, fallback: float) -> float:
    """
    按 `qm_id` 找到物体,返回它**世界坐标**包围盒的最高点。

    ⚠️ 为什么机位高度要这么取,而不是在 site_views() 里写死一个数:

       这两个机位一开始是拍脑袋定的 —— 桥面视点取 z = 4.2,桥下仰视
       取 z = −0.4。渲出来一张整幅是拱腹内部、一张整幅漆黑,
       都**不像是机位错了**,像是几何建错了。实际上:

         · 桥面在拱顶处高约 5.6m,把相机放在 4.2 就是放在**桥腹里**;
         · 水面在 z = 0、河床在 z = −1.5,把相机放在 −0.4 就是放在
           **水面板底面与河床之间的空腔里**,看到的全是水面的背面。

       这就是本项目第三次遇到同一类错误:**量具本身错了,却被读成
       被量对象的问题**。前两次是形制校验的取样窗口和河道断面的
       断言自相矛盾。写死高度的机位是同一件事 —— 它假设了一个
       会随 config 漂移的量。改成从**实测包围盒**反推,就再也
       不会漂:桥面加高,机位跟着长高。
    """
    box = _bbox_of(qm_id)
    if box is None:
        print(f"  [警告] 找不到 qm_id={qm_id} 的物体,机位高度回退到 {fallback}")
        return fallback
    return box[1].z


# --------------------------------------------------------------------------
# 图上的刻度
# --------------------------------------------------------------------------


def _ref_rows(view: dict) -> list[tuple[str, float | None]]:
    """
    把机位声明的参考标高,换算成**它自己那幅图里的像素行号**,渲染前打出来。

    为什么值得写这一段
    ------------------
    `boat_waterline` 这个机位本来是为了回答一句是非题:"吃水线齐不齐"。
    但水面板是**零厚度**的,水平视线里它投影成一条线 —— 没有厚度就没有
    面积,没有面积就没有像素。**那条线在图上根本不出现**,于是它也就
    **不遮挡船的水下部分**。结果是:那张图上船底整个露着,吃水 1.100m
    的船和浮空 1m 的船在那张图上**长得一模一样**。

    也就是说,那个机位当时**回答不了它要回答的问题**,而它看上去
    很合理 —— 名字、注释、"半幅高约 1.93m"的推算都写得头头是道。

    对策不是"下次看仔细点",是让图自带刻度:把水面、船壳底、舱篷顶
    这些参考标高换算成行号打出来。图上差几行,对着数字一看便知。

    这与本项目那四次"量具本身错了"是同一个解法 —— 让量具把它的
    读数直接印在图上,而不是指望看图的人心里有把尺。

    取法
    ----
    声明的是 `qm_id` 而不是数字:数字会随 config 漂移,`qm_id` 不会。
    `edge` 取 "max" 或 "min",即该物体世界包围盒的顶/底。
    也允许直接给字面量 `z`(例如某个**目标值**),但那样打出来的行会
    明确标成"声明值",以免和实测值混在一起看不出区别。

    只在**水平视线**的正投影机位上有意义:相机 up 与 +Z 平行时,
    某点的行号才只由它的 z 决定。俯视、斜视一律跳过 —— 跳过要**说出来**,
    不能静默返回空表(那是"检查会静默跳过就等于没有检查"的老毛病)。

    返回 `(文本, 行号)`;行号为 None 表示这条没算出刻度(跳过或量不到),
    后面 `_verify_ref_rows` 据此决定哪些条目值得去图上核对。
    """
    if not view.get("ortho"):
        return []
    refs = view.get("refs")
    if not refs:
        return []

    loc = Vector(view["loc"])
    direction = Vector(view["target"]) - loc
    up = direction.to_track_quat("-Z", "Y").to_matrix().col[1]
    if abs(up.z) < 0.999:
        return [
            (
                f"[参考行] 跳过:{view['name']} 的相机 up 不平行于 +Z,"
                f"行号不由 z 唯一决定",
                None,
            )
        ]

    w, h = PREVIEW_RES
    scale = float(view.get("ortho_scale", 32.0))
    # 正投影的 ortho_scale 管的是画面**较长的那一边**,换算成"每个像素
    # 对应多少米"要除以较长边 —— 与 boat_views 里 top_scale 的折算同源。
    m_per_px = scale / max(w, h)

    out: list[tuple[str, float | None]] = []
    for ref in refs:
        label = ref["label"]
        if "z" in ref:
            z = float(ref["z"])
            src = "声明值"
        else:
            box = _bbox_of(ref["id"])
            if box is None:
                # 找不到就**报出来**,不回退、不静默省略 —— 一条会静默
                # 跳过的参考线比没有更坏:它让人以为图上那处是空的。
                out.append((f"[参考行] {label}:找不到 qm_id={ref['id']},这条量不了", None))
                continue
            z = box[1].z if ref.get("edge", "max") == "max" else box[0].z
            src = f"{ref['id']}.{ref.get('edge', 'max')}"
        row = h / 2.0 - (z - loc.z) / m_per_px
        if not (0.0 <= row < h):
            out.append(
                (
                    f"[参考行] {label}:z={z:+.3f}({src})→ 第 {row:.0f} 行,**在画面外**",
                    None,
                )
            )
            continue
        out.append((f"[参考行] {label}:z={z:+.3f}({src})→ 第 {row:.0f} / {h} 行", row))
    return out


def _verify_ref_rows(
    path: Path, view: dict, refs: list[tuple[str, float | None]]
) -> list[str]:
    """
    渲染完,去**图上把那几条刻度核一遍**:参考行附近真的有色变吗?差几行?

    为什么非得核
    ------------
    参考行是算出来的,算错了照样打印得很好看 —— 那就成了一件装饰品。
    "量具本身错了"在本项目已经出现过四次,而这一次的量具是**刚刚
    新写的一段换算**,更没有理由免检。

    更关键的是:这段核对能抓住的**不是**换算错误,而是那种
    "算得对、但图上根本没有这条边"的情况 —— 比如水面:零厚度的平面
    在水平视线里没有面积,所以它那一行**附近五十行内一个色变都没有**。
    这恰恰是 `boat_waterline` 那个机位原本的毛病,现在会被自己报出来。

    只在中间一列上扫(可由 `ref_col` 指定别的列):这是**核对**,
    不是逐像素的验证,不需要覆盖全图;要覆盖全图的是 validate。
    """
    rows = [(t, r) for t, r in refs if r is not None]
    if not rows:
        return []

    try:
        import numpy as np
    except ImportError:                     # pragma: no cover - Blender 自带 numpy
        return ["[刻度核对] 没有 numpy,跳过(不该走到这里)"]

    try:
        img = bpy.data.images.load(str(path))
        w, h = img.size
        buf = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)[::-1, :, :3]
        bpy.data.images.remove(img)
    except Exception as exc:                # 核对失败要说出来,不能吞掉
        return [f"[刻度核对] 读不回 {path.name}:{exc!r}"]

    col = int(view.get("ref_col", w // 2))
    col = max(1, min(w - 1, col))
    # 相邻两行之间的色差;d[i] 对应"第 i 行到第 i+1 行"这道边界
    d = np.abs(np.diff(buf[:, col, :], axis=0)).max(axis=1)

    out: list[str] = []
    for text, row in rows:
        label = text.removeprefix("[参考行] ").split(":")[0]
        r = int(round(row))
        lo, hi = max(1, r - 25), min(h, r + 25)
        seg = d[lo - 1 : hi]
        hits = [lo + int(i) for i in np.nonzero(seg > 0.03)[0]]
        if not hits:
            out.append(
                f"[刻度核对] {label}:第 {r} 行前后 25 行**没有任何色变** —— "
                f"这一处边界在图上不存在,刻度无从目视核对"
            )
            continue
        # 把窗口内**所有**边界都列出来,不只列最强的一条:最强的那条
        # 未必是你要核对的那条边(实测踩过 —— 核对"舷顶"时最强的一条
        # 是 26 行之下的**舱篷顶**,两条边在画面上只差 0.3m)。
        # 只报最强的一条,等于给一个"对上了"的假象。
        shown = ", ".join(f"{e}({e - r:+d})" for e in hits[:4])
        more = f" 等 {len(hits)} 处" if len(hits) > 4 else ""
        mark = "对上了" if r in hits else "**不在这一行上**"
        out.append(f"[刻度核对] {label}:第 {r} 行;窗口内色变在第 {shown} 行{more} → {mark}")

    out.append(
        "[刻度核对] 说明:色变只说明「此处有一条边」,**不说明那条边属于谁**。"
        "要问「这个像素上是什么物体」,用 blender/tasks/probe_pixel.py 打射线。"
    )
    return out


def site_views() -> list[dict]:
    """
    场地级机位 —— 看河、桥、两岸的**关系**,而不是看桥本身的构件。

    与 standard_views() 的分工:那一组是"检查这座桥建得对不对",
    这一组是"检查这几样东西摆在一起对不对"。

    两个人的高度**从实测几何反推**,不写死 —— 见 `_bbox_max_z`。
    """
    # 桥面视点:站在拱顶路面上,人眼高 1.65m。
    eye = _bbox_max_z("bridge_deck", 5.6) + 1.65
    # 桥下仰视:站在**水面之上**。水面板顶面在 z = 0 附近,
    # 相机必须高于它 —— 低于它就是站在水面板的背面看,一片黑。
    above_water = _bbox_max_z("river_surface", 0.0) + 0.35

    return [
        {
            "name": "overview",
            "label": "全景鸟瞰 — 汴河、虹桥、两岸街道与城墙的关系",
            "loc": (78.0, -108.0, 62.0),
            "target": (0.0, -6.0, 2.0),
            "lens": 40.0,
        },
        {
            "name": "from_bridge",
            "label": "桥面视点 — 网页里的默认机位,站在拱顶看下游城门方向",
            "loc": (0.0, 1.5, eye),
            "target": (0.0, -60.0, 2.4),
            "lens": 45.0,
        },
        {
            "name": "riverside",
            "label": "河岸掠视 — 驳岸、木桩、踏步、纤道",
            "loc": (17.0, -31.0, 2.2),
            "target": (5.0, -6.0, 0.3),
            "lens": 45.0,
        },
        {
            "name": "along_river",
            "label": "顺河望去 — 街道进深与远景层次",
            "loc": (13.5, -74.0, 5.0),
            "target": (13.0, 24.0, 1.2),
            "lens": 40.0,
        },
        {
            "name": "below_bridge",
            "label": "水面仰视 — 站在河面上看桥腹,有桥墩必露馅",
            # 退到 y = −16:桥连栏杆横跨 20m,再近就装不下,
            # 装在画面外的部分等于没检查。
            "loc": (0.0, -16.0, above_water),
            "target": (0.0, 0.0, 3.6),
            "lens": 22.0,
        },
        {
            "name": "plan",
            "label": "俯视(正投影)— 河道宽度与两岸分区",
            "loc": (0.0, 0.0, 120.0),
            "target": (0.0, 0.0, 0.0),
            "ortho": True,
            "ortho_scale": 130.0,
            "shadows": False,
        },
        {
            # ⚠️ 这一张是**唯一**允许带上标位柱的机位(`"markers": True`),
            #    其余机位一律把它们藏掉。理由:标位柱是"只看不卖"的东西
            #    (在 `人物标位` 集合里,不进任何导出分块,所以 GLB 里没有),
            #    而预览图是要当**上线证据**看的 —— 图上多两根红蓝杆子,
            #    读的人只会得出"模型里有这两根杆子"。
            #
            #    但 48 个演员到底摆得合不合理,是必须回答的问题,而它
            #    只能靠标位柱看(`mark_moving` 朱 = 走动车道、
            #    `mark_static` 青 = 站位)。所以留这一张**明说要看标位**的
            #    图,并在标签里写清楚它们不上线。
            #
            # ⚠️ 机位用**斜视全景**,不用俯视。第一版用的是正投影俯视
            #    (120m 高看下来),渲出来只有 **1 个**偏红像素 ——
            #    因为标位柱是**立起来**的(`mark_moving` 高度 0→7.06m),
            #    从正上方看一根立着的东西只投影成一个点。俯视把"车道"
            #    压成了几个点,图上等于什么都没显示,而标签照样写着
            #    "红=走动车道"。斜视才有长度可看 —— 原来在 `overview`
            #    里我就是用斜视图看见那两色的。
            "name": "actor_lanes",
            "label": "演员走位/站位标位(斜视全景)— 【标位柱仅供预览,不导出、"
                     "不在 GLB 里】朱=走动车道、青=站位;看 48 个演员"
                     "是不是都落在街上/桥上/船上,没有掉进河里或穿进房里",
            "loc": (78.0, -108.0, 62.0),
            "target": (0.0, -6.0, 2.0),
            "lens": 40.0,
            "markers": True,
        },
    ]


def boat_views() -> list[dict]:
    """
    船只机位 —— 看船**自己**建得对不对,而不是看它在场景里的关系。

    机位**全部**从实测几何反推:船的位置与尺度量船自己,水面的位置
    与宽度量 `river_surface`。这一组要回答的问题是形制性的,不是美观性的:

        侧视   —— 首尾收分顺不顺、舷弧有没有
        贴水线 —— 吃水线是否与水面齐平(不接受浮空或沉没)
        俯视   —— 舱篷与舷边走道的关系、桅座在不在篷前
        眠桅   —— 桅真的放平了吗、有没有插进篷里、架子托住了没有
        艉部   —— 舵、橹、橹担各自的轴心位置对不对

    ⚠️ 这一组曾经是**一排写死的数**(x = 40 / 14 / 11 / 9 / 7.6)。
    那时场景里只有船、还没有两岸地面,于是侧视机位"站"在 x = 40
    看着很正常。等 `02_river` 把场地建出来,**同一个 x = 40 就落进
    了岸体内部** —— 岸面从 8.25 一路铺到 108,相机整个埋在里面。
    渲出来整幅土色,第一眼像是"船建歪了",实际是**相机被埋了**。

    这是本项目第四次栽在同一件事上:量具(这里是机位)里写死了一个
    会随 config 漂移的数。`_bbox_max_z` 早就是为这类问题写的,但只
    用在**高度**上,横向照旧写死。现在横向也改了,并把约束写清楚:

        机位横向必须落在**水面带宽内**,否则一定被岸体或驳岸挡住。

    旧值另外还错了两处,一并记下来,因为它们都是"数会漂"的同一个病:
      · 瞄准点 x = 1.6 是对的(船心确实在 1.60),但`boat_top` 的
        ortho_scale = 16 框不住 —— 船长 15.2m 落在画面**竖轴**上,
        而 ortho_scale 管的是较长边(横),要按横竖比折算才不会切掉船头;
      · 全部机位取景都把船当成了 8m 级的东西,实际整组 15.2m。
    """
    bpy.context.view_layer.update()          # ← 见 `_world_verts` 陷阱一

    water = _bbox_max_z("river_surface", 0.0)
    river = _bbox_of("river_surface")
    # 水面带宽由**实测**给出。留 0.6m 余量:相机贴着水边架,
    # 稍微偏一点就落到驳岸压顶(8.25→10.0)上了。
    cam_x = (river[1].x if river else 8.25) - 0.60

    hero = [
        o for o in bpy.context.scene.objects
        if o.type == "MESH" and o.get("qm_parent") == "boat_cao_hero"
    ]
    if not hero:
        raise AssertionError(
            "找不到 boat_cao_hero 的构件,量不出机位。"
            "船组机位一律从船自己的包围盒反推,拒绝回退到写死的坐标 —— "
            "回退就是这台量具上一次出错的方式。"
        )
    pts = [p for o in hero for p in _world_verts(o)]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    cy = (lo.y + hi.y) / 2.0
    span_y = hi.y - lo.y                    # 整组纵向长度(含橹)

    # 正投影的 ortho_scale 管的是**画面较长的那一边**。俯视时船的长轴
    # 落在画面竖轴上,竖轴只占 ortho_scale 的 (h/w),故要按横竖比放大 ——
    # 少了这一步,船长 15.2m 的船会被切掉两头(旧值 16.0 正是如此)。
    ar = PREVIEW_RES[0] / PREVIEW_RES[1]
    side_scale = span_y * 1.12
    top_scale = side_scale * ar

    # —— 艉部机位的取景:对着**舵与橹自己**量 ——
    #
    # ⚠️ 原先它按 `lo.y` 反推,而 `lo.y` 是**橹尖**,不是船尾:橹向后
    #    伸出船尾约 3m,于是相机退到橹尖之后 4.5m,渲出来船尾只占画面
    #    右边缘一小条,舵和橹挤在角上,而这一组机位存在的理由恰恰就是
    #    看这两件。又是同一个毛病:量具对准的不是被量的东西。
    #
    #    改成直接量舵与橹的包围盒:中心 `tc` 当瞄准点,外接半径 `trad`
    #    定距离。船改了、橹挪了,取景跟着走。
    tail = [o for o in hero if o.get("qm_part") in ("rudder", "yuloh")]
    if not tail:
        # 找不到就报错,不回退到整组包围盒 —— 回退出来的那张图看着
        # 仍然像张正常的艉部特写,只是拍错了地方。
        raise AssertionError(
            "boat_cao_hero 里找不到 qm_part 为 rudder / yuloh 的构件,"
            "艉部机位无从取景(该机位就是为了看这两件)"
        )
    tpts = [p for o in tail for p in _world_verts(o)]
    tlo = Vector((min(p.x for p in tpts), min(p.y for p in tpts), min(p.z for p in tpts)))
    thi = Vector((max(p.x for p in tpts), max(p.y for p in tpts), max(p.z for p in tpts)))

    # 瞄准点取**舵与橹各自的轴心**(标签里就有 `qm_pivot`,不必另算),
    # 不取包围盒中心。
    #
    # ⚠️ 这一段的第一版取的就是包围盒中心,渲出来画面正中是一块**空水**:
    #    舵是贴着艉板的竖片,橹是从艉部斜插进水里的长杆,两件的包围盒
    #    中心落在它们中间的空当里。"中心对准被拍的东西"这句话,
    #    在部件稀疏时**不等于**取包围盒中心。
    #
    #    而这一组机位的名字写的就是"舵、橹、橹担的**轴心**位置" ——
    #    那就直接对着轴心,别绕道。
    pivots = [
        Vector([float(t) for t in str(o["qm_pivot"]).split(",")])
        for o in tail
        if "qm_pivot" in o
    ]
    if len(pivots) != len(tail):
        raise AssertionError(
            "舵/橹里有的没写 qm_pivot,取不了轴心。"
            "轴心缺失应当当场报错 —— 网页侧驱动转向也靠它。"
        )
    tc = sum(pivots, Vector()) / len(pivots)
    trad = max((p - tc).length for p in tpts)

    return [
        {
            "name": "boat_side",
            "label": "船体侧视(正投影)—— 首尾收分、舷弧、桅与篷的纵向关系",
            # 视线沿 −X 水平看:水面板正好与视线平行,在画面里是一条
            # **零厚度的横线**,船的吃水线压在它上/下多少一目了然。
            "loc": (cam_x, cy, water + 0.55),
            "target": (lo.x - 1.0, cy, water + 0.55),
            "ortho": True,
            "ortho_scale": side_scale,
            "shadows": False,
            "refs": [
                {"label": "水面", "id": "river_surface", "edge": "max"},
                # 船壳的**最高点**在艏/艉的起翘上,不在舯部 —— 所以这条
                # 刻度在画面中列上本来就没有边(实测:该行前后 25 行内
                # 没有色变)。名字写清楚它在哪儿,免得读的人以为量错了。
                {"label": "船壳最高点(在艏/艉)", "id": "boat_cao_hero_hull", "edge": "max"},
                {"label": "主角船壳底", "id": "boat_cao_hero_hull", "edge": "min"},
                {"label": "舱篷顶", "id": "boat_cao_hero_cover", "edge": "max"},
            ],
        },
        {
            "name": "boat_waterline",
            "label": "贴水线正投影 —— 吃水线是否与水面齐平(不接受浮空或沉没)",
            # 与上面同一套几何,只是**放大到水面附近**:相机高度正好
            # 取在水面标高,于是水面板落在画面正中。
            #
            # ⚠️ 这个机位原先的注释写着"吃水 1.100m 应落在中线下方
            #    1.100/1.93 ≈ 57% 处,可以直接用眼看"。**那是错的** ——
            #    水面板零厚度,投影成一条线,而线在这个渲染器里**不出像素**,
            #    所以"水面那条横线"根本不在图上;没有它,1.100m 该从哪儿
            #    往下量也就无从谈起。水面以上和水面以下在这张图上连
            #    明暗都一样。换句话说:这个机位**回答不了它名字里的问题**,
            #    而它看上去完全合理。
            #
            #    真正判定吃水的是 validate 的 boat.draft(实测世界顶点,
            #    5 条船都是 1.100)。这里补上 refs,是为了让这张图至少
            #    能**自证刻度**:水面在第几行、船壳底在第几行,差多少。
            "loc": (cam_x, cy, water),
            "target": (lo.x - 1.0, cy, water),
            "ortho": True,
            "ortho_scale": 6.0,
            "shadows": False,
            "refs": [
                {"label": "水面", "id": "river_surface", "edge": "max"},
                {"label": "主角船壳底", "id": "boat_cao_hero_hull", "edge": "min"},
            ],
        },
        {
            "name": "boat_top",
            "label": "船体俯视(正投影)— 舱篷、舷边走道、桅座与篷首的相对位置",
            "loc": ((lo.x + hi.x) / 2.0, cy, 30.0),
            "target": ((lo.x + hi.x) / 2.0, cy, 0.0),
            "ortho": True,
            "ortho_scale": top_scale,
            "shadows": False,
        },
        {
            "name": "boat_quarter",
            "label": "三四分之三 — 综合观感",
            # 横向顶到水面带宽的极限,纵向用 Y 拉开距离 —— 岸上不能站,
            # 只能在河面上往后退。
            "loc": (cam_x, cy - span_y * 0.75, water + 4.2),
            "target": ((lo.x + hi.x) / 2.0, cy, water + 0.8),
            "lens": 28.0,
        },
        {
            "name": "boat_mast",
            "label": "眠桅特写 — 桅是不是真的放平了、有没有插进篷里",
            # 沿 −X 正对桅身:桅长 6.9m 全在画面里才看得出"平不平"。
            "loc": (cam_x, cy, water + 1.60),
            "target": (lo.x - 1.0, cy, water + 1.00),
            "lens": 35.0,
        },
        {
            "name": "boat_stern",
            "label": "艉部特写 — 舵、橹、橹担的轴心位置",
            # 相机只能在**水面带宽内**活动(岸上站不住),所以横向仍取
            # cam_x,只在纵向退到舵/橹中心之后 2 倍外接半径、抬到
            # 水面之上 1.4m。距离和水平角都是量出来的。
            "loc": (cam_x, tc.y - trad * 2.0, water + 1.4),
            "target": (tc.x, tc.y, tc.z),
            "lens": 50.0,
        },
    ]


def buildings_views() -> list[dict]:
    """
    市井机位 —— 看**铺面、屋面、城门城墙**建得对不对。

    与前两组的边界:桥组看桥的构件,船组看船自己,场地组看三者的关系;
    这一组看"一栋房子"和"一道墙"本身 —— 格子门、瓦垄、举折、收分。

    关键标高从实测反推:檐口与正脊量 `qm_roof` 屋面的包围盒,
    城墙顶量 `city_wall_e`。理由同前两组 —— 写死的标高已经埋过一次相机。

    ⚠️ 街上的视点取 x = 16.7、z = 1.65:那是沿河主街(12.2–21.2)的中线
       加人眼高。站在河里或路面以下,"看得见什么"就全是另一回事了。
    """
    # 屋面标高:取**最大**的那片屋面(二层酒楼的上檐),其余都在它之下
    roof_hi = _bbox_max_z("shop_e0_0_lou_roof", 7.6)
    eave = _bbox_max_z("shop_e0_1_cha_roof", 3.6)
    wall_top = _bbox_max_z("city_wall_e", 12.5)

    return [
        {
            "name": "street",
            "label": "街内视点 — 站在主街上顺街望去,两排铺面与里坊的进深",
            "loc": (16.7, 2.0, 1.65),
            "target": (18.0, 40.0, 2.4),
            "lens": 35.0,
        },
        {
            "name": "facade",
            "label": "临街正视 — 茶肆:格子门、格眼、檐下净空、凉棚",
            # 退到 x = 8.0(河面上),才装得下 12m 宽的一整栋;
            # 镜头 24mm:在 13m 处覆盖约 19m 宽。
            "loc": (8.0, 34.6, 2.4),
            "target": (21.2, 34.6, 2.2),
            "lens": 24.0,
        },
        {
            "name": "roofs",
            "label": "屋面斜视 — 筒瓦垄、举折凹曲、正脊与檐口起翘(近景)",
            "loc": (14.0, 12.0, 11.0),
            "target": (24.0, 36.0, 3.2),
            "lens": 40.0,
            "refs": [("eave", "shop_e0_1_cha_roof", "max"),
                     ("ridge", "shop_e0_0_lou_roof", "max")],
        },
        {
            "name": "restaurant",
            "label": "酒楼 — 二层歇山:腰檐与上檐的两层关系、山花、收山",
            "loc": (10.0, 8.0, 4.2),
            "target": (24.0, 21.0, 5.2),
            "lens": 30.0,
            "refs": [("eave(腰檐)", "shop_e0_0_lou_roof", "min"),
                     ("ridge(上檐)", "shop_e0_0_lou_roof", "max")],
        },
        {
            "name": "gate",
            "label": "城门楼 — 重檐庑殿、梯形门洞、夯土收分",
            "loc": (34.0, -80.0, 20.0),
            "target": (66.0, -38.0, 9.0),
            "lens": 40.0,
            "refs": [("墙顶", "city_wall_e", "max")],
        },
        {
            "name": "gate_axial",
            "label": "门洞轴向 — 从河上看过去,验梯形截面与净宽",
            "loc": (0.0, -38.0, 3.0),
            "target": (67.0, -38.0, 3.4),
            "lens": 60.0,
            "refs": [("墙顶", "city_wall_e", "max"),
                     ("门道净高目标 7.0", "shop_e0_0_lou_roof", None)],
        },
        {
            # ⚠️ 视轴必须压在**河心 x=0** 上,不是压在某一岸。
            #    上一版把中心放在 x=36(西岸建筑带),ortho_scale=140 于是
            #    只覆盖 x∈[-34,106] —— 东岸整个被裁掉,图上"左岸空无一物"
            #    其实是我自己没照到。**又一次:量具的取景框被读成了场景的属性。**
            #    河心对称布景,就用河心对称取景;要单看一岸另加机位。
            "name": "block_plan",
            "label": "俯视(正投影)— 两岸分区的平面关系:河—街—排—里坊—城墙",
            "loc": (0.0, 0.0, 95.0),
            "target": (0.0, 0.0, 0.0),
            "ortho": True,
            "ortho_scale": 170.0,
            "shadows": False,
        },
    ]


def _objs_where(kind: str, pred=None) -> list[bpy.types.Object]:
    """按 `qm_kind` 取物体,可再过滤。**不按名字取** —— 名字是产出,不是契约。"""
    return [
        o for o in bpy.context.scene.objects
        if o.type == "MESH" and o.get("qm_kind") == kind
        and (pred is None or pred(o))
    ]


def _bbox_objs(objs: list[bpy.types.Object]) -> tuple[Vector, Vector] | None:
    pts = [p for o in objs for p in _world_verts(o)]
    if not pts:
        return None
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi


def props_views() -> list[dict]:
    """
    柳树与道具机位 —— 看**街边有没有'过日子'的样子**。

    与前四组的边界:桥组看构件,船组看船,场地组看三者关系,
    建筑组看一栋房子;这一组看**房与房之间、门前、岸边**的那些零碎。

    ⚠️ 三个机位的位置全部从**实测包围盒**反推,没有一个写死的坐标 ——
       柳树和道具的位置由种子决定,写死的机位在下次改种子后会对着空地。
       这是我第五次用同一条纪律:机位要跟着几何走,不能假设几何在哪。
    """
    trees = _objs_where("tree", lambda o: str(o.get("qm_id", "")).endswith("_trunk")
                        and o.get("qm_lod") == "near")
    props = _objs_where("prop", lambda o: str(o.get("qm_id", "")).startswith("prop_"))
    banners = _objs_where("prop", lambda o: str(o.get("qm_id", "")).startswith("banner_"))

    if not trees:
        return []

    # 近景柳里**最靠桥**的那一株 —— 桥上的人第一眼看到的就是它
    tb = [(abs(_bbox_objs([o])[0].y), o) for o in trees if _bbox_objs([o])]
    tb.sort(key=lambda t: t[0])
    near_tree = _bbox_objs([tb[0][1]])
    tlo, thi = near_tree
    tcx, tcy = 0.5 * (tlo.x + thi.x), 0.5 * (tlo.y + thi.y)

    views: list[dict] = [
        {
            "name": "willow_row",
            "label": "岸边柳行 — 站在纤道上顺河望去:柳荫是否成行、垂枝是否到水",
            # 纤道在 10.0–12.2,取中线 11.1;人眼高 1.65
            "loc": (11.1, 16.0, 1.65),
            "target": (9.2, 58.0, 3.2),
            "lens": 35.0,
        },
        {
            "name": "willow_close",
            "label": "单株柳 — 主干、一级枝、垂枝的层次(近景)",
            "loc": (tcx + 5.2, tcy - 4.6, 2.2),
            "target": (tcx, tcy, tlo.z + 3.0),
            "lens": 35.0,
            "refs": [("柳高", str(tb[0][1].get("qm_id")), "max")],
        },
    ]

    # —— 挑一家铺面 ——
    #
    # ⚠️ **这里的取景返工过一次,原因值得写下来。**
    #    原来拿"全部 prop_* 物体"的包围盒取中心。而道具**两岸都有**,
    #    于是那个包围盒的 x 中心 ≈ 0 —— **那是河心**。渲出来的
    #    `shopfront_props` 对着河,桥又恰好在 y 中段,整张图看着是一座桥。
    #    机位确实是从"实测包围盒"算的,**依据本身没错,错的是取错了集合**:
    #    把两岸的东西当成一摊东西量。
    #    `banners` 同病:全部幌子的 x 包围盒跨两岸,`blo.x > 0` 判出来的
    #    那一岸是随机的。
    #
    #    现在按 `qm_id` 里的铺面号分组,只取**离桥最近的那一家** ——
    #    桥上的人第一眼看到的就是这家门前。
    #    `qm_id` 形如 `prop_shop_w1_0_bamboo`;铺面号自己含下划线,
    #    所以要从**右边**切掉最后一段材质名,剩下的才是号。
    #
    # ⚠️ **还必须滤掉非铺面的桶。** 独轮车不归铺面,它的 `qm_id` 是
    #    `prop_street_wood_furniture` —— 按上面的切法得到"铺面号" `street_wood`。
    #    它**正好也最靠近桥**(三处车位在 y = −24 / 6.5 / 31),于是
    #    "离桥最近"这一条会选中它,渲出来是一排独轮车配一句
    #    "铺面门前(street_wood)"。**筛选条件看着合理,但它筛出了不该选的
    #    东西** —— 这是本项目第 N 次同一个形状:不是算错了,是范围圈错了。
    #    铺面号的判据与 `06_props._survey` 同一套:以 `shop_` 开头。
    groups: dict[str, list[bpy.types.Object]] = {}
    for o in props:
        qid = str(o.get("qm_id", ""))
        if qid.startswith("prop_"):
            bid = qid[len("prop_"):].rsplit("_", 1)[0]
            if bid.startswith("shop_"):
                groups.setdefault(bid, []).append(o)

    shop: dict | None = None
    if groups:
        cand = []
        for bid, objs in groups.items():
            bb = _bbox_objs(objs)
            if bb is not None:
                cand.append((abs(0.5 * (bb[0].y + bb[1].y)), bid, bb))
        cand.sort(key=lambda t: t[0])
        _dist, bid, bb = cand[0]
        plo, phi = bb
        pcy = 0.5 * (plo.y + phi.y)
        # `dirn` / `front` 取自**那块台基**,不由铺面号猜正负 ——
        # 名字只用来配对,几何才有方向。
        dirn, front = None, None
        for o in bpy.data.objects:
            if o.get("qm_parent") == bid and o.name.endswith("_plinth"):
                vs = [o.matrix_world @ Vector(v.co) for v in o.data.vertices]
                if vs:
                    dirn = 1.0 if sum(v.x for v in vs) > 0 else -1.0
                    front = min(abs(v.x) for v in vs)
                break
        if dirn is None:
            # 找不到台基就退回**这一家自己**的包围盒,仍然不跨岸
            dirn, front = (1.0 if plo.x > 0 else -1.0), abs(plo.x)
        shop = {"bid": bid, "pcy": pcy, "dirn": dirn}

        # ⚠️ **街在 |x| 更小的那一侧,不在更大的一侧。**
        #    场地分区是 `12.2→21.2 街道 / 21.2→58 市井`,台基外皮在
        #    |x| = 20.65。所以铺面门前的地面是 **|x| 从 12.2 到 20.65**,
        #    而 |x| > 21.2 是**房子里**(市井深处)。
        #    第一版写的是 `front + 4.6` —— 那一步把相机放进了**店铺内部**,
        #    渲出来是从屋里隔着门扇往外看(近处那些竖框是这栋楼自己的
        #    檐柱与格子门,远处灰带是街、更远是**对岸**的铺子)。
        #    图看着"有房子有街有柳",一点都不像坏了 —— 这就是它危险的地方。
        #    按几何复核时**必须同时确认相机在哪一侧**,不能只看它对着什么。
        views.append({
            "name": "shopfront_props",
            "label": f"铺面门前({bid}) — 桌凳、篮瓮、货袋:落没落地、有没有插进桌里",
            # 站在街心(front − 4.6),回看台基外皮(front)。退到 4.6 是
            # 街宽(20.65 − 12.2 = 8.45)的一半多一点,门脸与门前地面能同框。
            "loc": (dirn * (front - 4.6), pcy - 3.0, 1.75),
            "target": (dirn * front, pcy + 0.6, 0.85),
            "lens": 30.0,
        })

    if banners:
        # 只取**同一家、同一岸**的幌子。取不到就退回"离桥最近的几面",
        # 而不是退回全部 —— 全部又回到两岸包围盒那个坑里了。
        sel: list[bpy.types.Object] = []
        if shop is not None:
            for o in banners:
                bb = _bbox_objs([o])
                if bb is None:
                    continue
                cy = 0.5 * (bb[0].y + bb[1].y)
                if abs(cy - shop["pcy"]) < 9.0 and (bb[0].x > 0) == (shop["dirn"] > 0):
                    sel.append(o)
        if not sel:
            sel = sorted(
                banners,
                key=lambda o: abs(0.5 * (_bbox_objs([o])[0].y + _bbox_objs([o])[1].y)),
            )[:4]
        bb = _bbox_objs(sel)
        if bb is not None:
            blo, bhi = bb
            by = 0.5 * (blo.y + bhi.y)
            d = 1.0 if blo.x > 0 else -1.0
            views.append({
                "name": "banners",
                "label": f"幌子({len(sel)} 面) — 挑出方向、离地高度、是否被雨棚挡住",
                # 沿街**侧看**,把一排幌子叠进画面;正对着看只会看到
                # 最前面那一面
                "loc": (d * 16.6, by - 9.5, 1.70),
                "target": (d * 19.6, by + 2.0, 2.55),
                "lens": 42.0,
            })

    return views


def _screen_axes(loc, tgt) -> tuple[Vector, Vector, Vector]:
    """
    视线方向与画面的横轴、竖轴(世界系下的单位向量)。

    横轴取 `视线 × +Z`:相机永远"头朝上",所以画面竖轴必然是竖直平面
    里的那个。视线竖直时(正俯视/正仰视)叉乘退化,换 +X 当参考。
    """
    v = Vector(tgt) - Vector(loc)
    dist = v.length
    if dist < 1e-9:
        raise ValueError("机位与目标重合,推不出距离 —— 检查这组机位的坐标")
    v = v / dist
    right = v.cross(Vector((0.0, 0.0, 1.0)))
    if right.length < 1e-9:
        right = Vector((1.0, 0.0, 0.0))
    right.normalize()
    return v, right, right.cross(v).normalized()


def _corners(lo, hi):
    """包围盒的 8 个角点。"""
    for cx in (lo.x, hi.x):
        for cy in (lo.y, hi.y):
            for cz in (lo.z, hi.z):
                yield Vector((cx, cy, cz))


def _proj_extents(lo, hi, tgt, right: Vector, up: Vector) -> tuple[float, float]:
    """
    包围盒 8 个角在画面横轴/竖轴上**相对瞄准点**的最大偏移 `(mx, mz)`。

    ⚠️ 取的是 `max(|min|, |max|)`,**不是半尺寸**。瞄准点通常不在包围盒
       中心 —— 人物近景瞄的是胸口 `z=1.05`,而盒心在腰上 `z≈0.85`。
       按半尺寸算,偏出去的那一半就被漏掉了,而它正好是**脚**:
       实测就是这么把脚切在画面外的,而图上看着只像"机位偏了"。
       与 `boat_stern` 那个"包围盒中心落在一块空水里"是同一类毛病 ——
       量具对准的不是被量的东西。

    正投影下这就是精确的屏幕半宽/半高(正交投影没有透视除法),
    所以 `_ortho_scale` 直接用它;透视下还差一步,见 `_fit_dir`。
    """
    t = Vector(tgt)
    mx = mz = 0.0
    for p in _corners(lo, hi):
        d = p - t
        mx = max(mx, abs(d.dot(right)))
        mz = max(mz, abs(d.dot(up)))
    return mx, mz


def _fit_dir(loc, tgt, lo, hi, lens: float, margin: float = 1.15) -> tuple:
    """
    保持视线方向,把相机沿该方向推到**刚装得下**这个包围盒的距离。

    视场:传感器 36mm 铺在画面**长边**(预览分辨率 1400×900,横向;
    `sensor_fit` 是默认的 AUTO),故水平半视场正切 = 18/lens,
    竖直的那个再乘横竖比。渲染参数就这两条,没有别的来源。

    推导 —— 相机在 `target − v·t`,角点相对瞄准点偏移 `d`,则该角点的
    深度是 `t + d·v`(不是 `t`),它落在画面内的条件是

        |d·right| / (t + d·v) ≤ tan_h        (竖直同理,换 up / tan_v)

    解出 `t ≥ |d·right|/tan_h − d·v`,对 8 个角取最大即可。**闭式,不用迭代。**

    ⚠️ 为什么非要带 `− d·v` 这一项:漏掉它,就等于假设"所有角都和瞄准点
       一样深"。人物近景的瞄准点在胸口 `z=1.05`、相机在 `z=1.35`,视线
       朝下,于是**脚比瞄准点离相机更近**(`d·v > 0`),它们实际能用的
       深度比 `t` 小 —— 这正是原先"把脚切出画面"的第二层原因。第一层是
       瞄准点不在盒心(见 `_proj_extents`),两层叠在一起才切得那么干净。

    ⚠️ `margin` 作用在 `tan` 上(等效于把视锥按比例收窄),不是作用在
       距离上。两者远看差不多,近看差很多:乘距离是"退远一点",收视锥是
       "留出固定比例的边"—— 后者才是这里想表达的意思(1.15 → 物体最多
       占画面的 87%)。

    ⚠️ 别再用写死的距离。角色组原先三个机位的距离是 3.4 / 4.2 / 2.44,
       而排开 7 具之后这一排有 6.1m 宽 —— 32mm 镜头在 4.2m 处只看得到
       4.7m,**两端两具正好被切掉**。切掉的偏偏是 `walk` 与 `lead`,
       而这两个姿态的差别(一个静止、一个步幅最大)正是这张图要回答的
       问题。图上看着"渲出来了",它却证明不了标签里写的任何一条。
       和 `props_views` 的机位一样:机位要跟着几何走。
    """
    v, right, up = _screen_axes(loc, tgt)
    t = Vector(tgt)
    tan_h = (18.0 / lens) / margin
    tan_v = tan_h * (PREVIEW_RES[1] / PREVIEW_RES[0])
    need_max = 0.0
    for p in _corners(lo, hi):
        d = p - t
        dv = d.dot(v)
        need_max = max(need_max,
                       abs(d.dot(right)) / tan_h - dv,
                       abs(d.dot(up)) / tan_v - dv)
    # 瞄准点自己也要在相机前方 —— 极端扁的包围盒配短焦时,
    # 上式可能解出一个 ≤0 的距离,那样相机会退到目标背后去。
    need = max(need_max, 0.35)
    return tuple(t - v * need)


def _ortho_scale(loc, tgt, lo, hi, margin: float = 1.10) -> float:
    """
    正投影的 `ortho_scale` —— 让这个包围盒刚刚好进画面。

    ⚠️ `ortho_scale` 管的是画面**较长的那一边**。预览分辨率 1400×900,
       长边是横向,所以 `ortho_scale` 就是**可见宽度**;竖向可见宽度
       要乘横竖比,再拿高度去比。少了后一半,高的东西会被切头。
       (`boat_top` 的机位吃过这个亏,那里有原话。)

    ⚠️ 偏移量同样按 `_proj_extents` 取(相对瞄准点的最大偏移),
       不按半尺寸 —— 理由见那边。
    """
    _, right, up = _screen_axes(loc, tgt)
    mx, mz = _proj_extents(lo, hi, tgt, right, up)
    ar = PREVIEW_RES[1] / PREVIEW_RES[0]
    return max(2.0 * mx, 2.0 * mz / ar) * margin


def _clear_row_spot(halfspan: float, depth: float = 0.6,
                    height: float = 2.0) -> tuple[float, float, float]:
    """
    给"把七具模板排成一排"找一块**站得住的空地**,返回 (x, y, 地面 z)。

    ⚠️ 为什么必须找,不能就放在原点。

       原先是"沿 X 排开、y 与 z 不动",而模板出生在原点 —— 于是这一排
       正好落在**河道里、水面高度上**:实测 `x ∈ [−2.85, +2.85]` 而河宽
       16.5(x ∈ [−8.25, +8.25]),y ≈ 0 又正在桥下。渲出来的
       `char_front` 上,左边三具人被一条船的船壳和一个桅杆压着,
       脚底下那条深色横线是**水面**。

       而那张图的标签写的是"七具同尺度 —— 左右对称性、肩宽与髋宽之比"。
       左边三具连轮廓都读不全,这个比值无从谈起。图上看着像
       "人站在某个平台上",不像"量具放错了地方"。

    判据(两条同时满足):
      · 向下打射线,第一个撞上的必须是 `kind == "terrain"` —— **站地面**,
        不是水面、不是船甲板、不是屋顶;
      · 这一排的包围盒(x 向 ±halfspan、y 向 ±depth、z 向 height)
        与场景里任何**会上线的东西**都不相交 —— 不会被人挡、也不会挡人。

    ⚠️ 障碍物清单里**要排掉"仅预览"的物体**:标位柱的包围盒横跨
       x ∈ [−44, 49],拿它当障碍物的话,整个场地没有一处能通过 ——
       而它在这一组里根本不出现(默认藏起来)。拿一个不在画面里的
       东西去否决机位,否决得再有理也是错的。

    候选点按离原点由近及远的顺序试,取第一个合格的 —— 近处的场地
    (街市一带)是这套图最想让人看见的地方。
    """
    # 障碍物包围盒只算一次(逐个顶点算世界坐标,234 件约一两秒)。
    #
    # ⚠️ **地面本身不是障碍物**。第一版没排掉 `kind == "terrain"`,
    #    而地形的包围盒横跨整个场地、底在 z ≈ 0 —— 于是"这一排和
    #    谁相交"的第一个答案永远是地面,每个候选都被否掉。报出来的
    #    症状是"3473 处干净地面,一处也放不下",看着像场地太挤,
    #    实际是**判据把地板当成了家具**。
    obstacles: list[tuple[str, Vector, Vector]] = []
    for o in bpy.context.scene.objects:
        if o.type != "MESH" or o.hide_render or is_preview_only(o):
            continue
        if str(o.get("qm_kind")) in ("terrain", "character"):
            continue          # 地形是脚底;模板自己会挪过去。都不算障碍
        vs = _world_verts(o)
        if not vs:
            continue
        obstacles.append((
            o.name,
            Vector((min(v.x for v in vs), min(v.y for v in vs),
                    min(v.z for v in vs))),
            Vector((max(v.x for v in vs), max(v.y for v in vs),
                    max(v.z for v in vs))),
        ))

    dg = bpy.context.evaluated_depsgraph_get()
    scene = bpy.context.scene

    # 搜索范围要够大,而且**先试近处** —— 近处(街市一带)是这套图
    # 最想让人看见的背景。细网格给近场,粗网格覆盖到远景地面。
    cands = sorted(
        ((x, y)
         for x in list(range(-30, 31, 2)) + list(range(-120, 121, 6))
         for y in list(range(-60, 61, 4)) + list(range(-220, 221, 10))),
        key=lambda p: p[0] * p[0] + p[1] * p[1],
    )

    def ground_at(x: float, y: float) -> float | None:
        """(x, y) 处的地面高度;脚下不是地形就返回 None。"""
        hit, loc, _n, _i, obj, _m = scene.ray_cast(
            dg, Vector((x, y, 30.0)), Vector((0.0, 0.0, -1.0))
        )
        if not hit or str(obj.get("qm_kind")) != "terrain":
            return None
        return loc.z

    tried_ground = 0
    for x, y in cands:
        gz = ground_at(float(x), float(y))
        if gz is None:
            continue          # 脚下不是地(水面/船/屋顶/空)
        tried_ground += 1

        # 沿这一排逐具验地面:整排都得站在地形上,而且大致同高 ——
        # 否则排尾那几具会悬在河面/船顶/台阶上方,而图上看着只是
        # "站得靠边一点"。落差 0.25m 以上就换地方。
        if any(
            (lambda g: g is None or abs(g - gz) > 0.25)(
                ground_at(x + (i - 3.0) * (halfspan / 3.0), float(y))
            )
            for i in range(7)
        ):
            continue

        lo = Vector((x - halfspan, y - depth, gz - 0.02))
        hi = Vector((x + halfspan, y + depth, gz + height))
        clash = next(
            (nm for nm, olo, ohi in obstacles
             if not (ohi.x < lo.x or olo.x > hi.x
                     or ohi.y < lo.y or olo.y > hi.y
                     or ohi.z < lo.z or olo.z > hi.z)),
            None,
        )
        if clash is None:
            print(f"  [机位] 人物排位空地 ({x}, {y}) 地面 z={gz:.3f}:"
                  f"整排 7 点脚下都是地形且同高;"
                  f"{len(obstacles)} 件会上线的东西无一相交"
                  f"(此前 {tried_ground - 1} 处地面因有物相撞被弃)")
            return float(x), float(y), gz

    raise AssertionError(
        f"整场找不到一块能排开七具模板的空地:"
        f"候选里脚下是干净地面的有 {tried_ground} 处,"
        f"但没有一处同时满足「整排站在同高的地形上」与"
        f"「{len(obstacles)} 件会上线的东西无一相交」。"
        f"`char_front`/`char_row` 会渲成人物与船/房搅在一起,量不了形体。"
    )


def characters_views() -> list[dict]:
    """
    人物机位 —— 看**这是不是个人**。

    与前五组的边界:道具组看"门前有没有过日子的样子",这一组只回答
    一个问题:**形体读不读得出来**。腿有没有并到中线、头是不是个方块、
    蹲姿有没有把人埋进地里、挑担的胳膊抬没抬起来 —— 这些在
    统计量上全都看不出来(三角面数一样、顶点数一样),只能看图。

    ⚠️ 七具模板出生时**全叠在原点** —— 它们是模板,本来就不该各有位置
       (站位由 08_assembly 编排)。所以这组机位会先把它们**排成一排**。
       这是**仅供预览的临时摆放,不是场景里的位置**,标签里写明了。
       不这么做的话,七个人会渲成一团,而"渲出来了"看着像是成功了。
    """
    # ⚠️ 取的是**身体的网格**,不是骨架。`_objs_where` 只收 `type == "MESH"`,
    #    而骨架是 `ARMATURE` —— 照 `qm_id` 以 `_rig` 结尾去找,一个也找不着,
    #    函数返回空表,然后 `render_views` 拿空表**静默退回默认机位**,
    #    渲出一整组桥的图。两次静默叠在一起:第一次让列表为空,
    #    第二次把空表当作"没有偏好"。图上看着完全正常,只是渲错了东西。
    # ⚠️ 判据是"**有没有 `qm_pose`**",不是"kind 是不是 character"。
    #
    #    `07_characters` 把随身的家什也打了 `kind=character`:扁担
    #    `acc_carry_pole`、篙 `acc_punt_pole`。于是这两件混进了这组
    #    "单具"里 —— 它们没有 `qm_pose`,`str(None)` 得到字符串 `"None"`,
    #    于是两个机位**同名** `char_pose_None`、标签都是 `None 单具(3/4)`,
    #    而且**写同一个文件名**,后一张把前一张盖掉:9 个机位实际只有
    #    8 张图,而日志上写着 9。
    #
    #    更糟的是那两张图本身:机位的 `only` 是 `acc_*` 的 `qm_id`,
    #    于是同排七具全被藏起来,**画面里是一根扁担的特写**,标签却写着
    #    "腿有没有并到中线"。又是一张"看着很正常、答的不是标签问的问题"
    #    的图。按 `qm_pose` 取,人 = 有姿态的模板,家什自然出局。
    bodies = sorted(
        (o for o in _objs_where("character")
         if str(o.get("qm_pose", "")) in C.Character.POSES),
        key=lambda o: list(C.Character.POSES).index(str(o.get("qm_pose"))),
    )
    if not bodies:
        return []

    # 一具人 = 一个姿态。数量对不上就**不许继续**:
    #   少 → 有模板漏打 `qm_pose`(那张图会缺),多 → 有物体被打上了
    #        姿态名(那个机位会渲错东西)。两种都只表现为"个数不同",
    #        图却照出,正是本项目反复栽的形状。
    if len(bodies) != len(C.Character.POSES):
        raise AssertionError(
            f"人物模板 {len(bodies)} 具,姿态表 {len(C.Character.POSES)} 个 —— 对不上。"
            f"逐具近景按模板逐张渲,数目不符意味着模板漏打了 `qm_pose` "
            f"或被打重。实取到:{[str(o.get('qm_id')) for o in bodies]}"
        )

    # —— 临时排开:按姿态表的顺序沿 X 布成一行 ——
    # ⚠️ 挪的是**骨架**(网格的 parent),网格挂在它底下会跟着走。
    #    挪网格本身的话,它会被 armature 修改器拽回绑定位置 ——
    #    那正好是"绑定关系挂在谁身上"这件事的现场演示。
    step = 0.95
    movers = [o.parent or o for o in bodies]
    halfspan = (len(movers) - 1) * 0.5 * step + 0.6
    row_x, row_y, row_z = _clear_row_spot(halfspan)

    # ⚠️ **只改 x/y,不动 z 的基准** —— z 上带着构建期烘进来的落地修正。
    #
    #    `07_characters` 的落地是"量出最低点、把它抬到 z=0",做法是
    #    `arm.location.z -= lo` —— 也就是**把每具各自的修正量烘进了骨架
    #    的 location.z**。七具的修正量并不相同:`walk` 是 −0.013、
    #    `vendor` 是 **+0.306**(蹲姿,小腿后折,静置网格的最低点比
    #    别的姿态高一截)。
    #
    #    第一版这里写的是整条赋值 `r.location = Vector((x, y, row_z))`,
    #    于是那 0.306 被**整条覆盖掉**,`vendor` 就悬在半空 —— 而另外
    #    六具的修正量只有 1~2cm,肉眼看不出,所以图上只像"有一具怪怪的"。
    #    "整体赋值"看上去比"逐轴赋值"干净,代价是把同一个字段里别人
    #    存的另一件事一起抹了。
    base_z = [r.location.z for r in movers]
    for i, r in enumerate(movers):
        r.location = Vector((
            row_x + (i - (len(movers) - 1) * 0.5) * step,
            row_y,
            row_z + base_z[i],
        ))
    bpy.context.view_layer.update()

    # —— 落位自检:七具的**静置姿态**脚底必须落在同一标高上 ——
    #
    # ⚠️ 这一条是图上"看着有一具浮空"倒推出来的:正视正投影里倒数第
    #    四具的脚比地面线高约 40px,而一具人高约 340px —— 像是浮了
    #    0.2m。但那是**透视**(排尾更远),不是浮空。
    #    图像能给出怀疑,给不出结论。所以把怀疑变成数:逐具量静置
    #    姿态的世界最低点,和 row_z 相减。差超过 5cm 就报出来 ——
    #    肉眼看 5cm 只是个"好像有点高",这正是它需要走断言的原因。
    #
    # ⚠️ 量的是 `data.vertices`(静置姿态)不是估值网格:这里要问的是
    #    "摆放把脚放到了哪个标高",不是"蒙皮之后脚在哪"。后者由
    #    `07_characters.land_residual_max` 在构建期管。
    feet = []
    for r, b in zip(movers, bodies):
        bb = _bbox_objs([b])
        if bb is None:
            continue
        dz = bb[0].z - row_z
        feet.append((str(b.get("qm_pose")), float(bb[0].z), float(dz)))
    if feet:
        bad = [f for f in feet if abs(f[2]) > 0.05]
        print(f"  [落位] 七具脚底标高(地 {row_z:+.3f}):"
              + "、".join(f"{n} {z:+.3f}" for n, z, _ in feet))
        if bad:
            raise AssertionError(
                "模板脚底不在同一标高上:"
                + "、".join(f"{n} 差 {dz:+.3f}m" for n, _, dz in bad)
                + "。`char_front` 是正投影、七具同尺度,一具高出一截"
                  "会让人以为其余六具的比例也不可信 —— 先查这具的"
                  "静置姿态是不是没把脚放在 z=0。"
            )

    bbs = [_bbox_objs([r]) for r in bodies]
    bbs = [b for b in bbs if b is not None]
    if not bbs:
        return []
    lo = Vector((min(b[0].x for b in bbs), min(b[0].y for b in bbs),
                 min(b[0].z for b in bbs)))
    hi = Vector((max(b[1].x for b in bbs), max(b[1].y for b in bbs),
                 max(b[1].z for b in bbs)))

    cx = 0.5 * (lo.x + hi.x)
    span = max(hi.x - lo.x, 0.5)

    # 取景一律从**实测包围盒**来,距离由 `_fit_dir` 算 —— 不写死。
    front_loc = (cx, lo.y + 8.0, 0.90)
    front_tgt = (cx, lo.y, 0.90)

    # —— 逐姿态近景 ——
    #
    # ⚠️ 为什么要**每一具**各来一张,而不是挑一具当代表:
    #    原先只有一张 `char_close`,挑的是 `carry`。于是另外六个姿态
    #    (撑篙的胳膊、推车的倾角、深蹲的大腿)唯一的图源就是那张
    #    全排 3/4 —— 而那张图里最远的 `lead` 只有最近的 `walk` 的
    #    **一半高**(相机离近端 5.3m、离远端 8.3m,实测比值 1.57)。
    #    要在 2:1 的尺度差上比"哪具的腿并到中线了",比的其实是
    #    **谁离相机近**。标签写着对比,图上量不了,是量具的问题。
    #
    #    单拎一具时不存在这个问题:`_fit_dir` 按**这一具自己的**包围盒
    #    定距离,所以每张图里的人都占满同样的画幅 —— 七张之间可以直接比。
    #
    # 视角取**正面偏 30° 的 3/4**:正视图量得出对称,侧视图量得出前后,
    # 3/4 两者都能看出个大概,而这七张要回答的正是"关节是折角还是
    # 弯折、腿并没并到中线"这类形体问题。`carry` 已确认:脸朝 +Y,
    # 所以相机放在 +Y 侧、朝 −Y 看。
    views = [
        {
            "name": "char_row",
            "label": f"人物模板全排({len(bodies)} 具,3/4 视角)— "
                     f"全体一览。注意:近端比远端大约 1.5 倍,"
                     f"**不要在这张图上比尺度**,比形看各姿态的单张",
            # 站在 +Y 侧朝 −Y 看,略偏一点成 3/4 —— 正视图看不出
            # 前后方向上的姿态差异(推车、撑篙都在 Y-Z 平面上动)
            "loc": _fit_dir((cx + span * 0.55, lo.y + 3.4, 1.25),
                            (cx, lo.y, 0.88), lo, hi, 32.0),
            "target": (cx, lo.y, 0.88),
            "lens": 32.0,
        },
        {
            # ⚠️ 正视图必须**正投影**。写着"左右对称性、肩宽与髋宽之比",
            #    而透视投影下,边上那两具离相机更远、还会被拉斜 ——
            #    两个比例在这张图上**量不出来**。原先用的是 32mm 透视,
            #    实测边上两具明显向内倒。
            #    正投影还有一个好处:七具**同尺度**,横向比例可以直接互比,
            #    而这一条正是上面那张 3/4 给不了的。
            #
            # ⚠️ 代价:正投影下**步幅被透视缩短**。`lead` 是大跨步,
            #    这里的腿看起来偏短 —— 那不是腿建短了。要看前后分量
            #    去 `char_pose_lead`。
            "name": "char_front",
            # 数目**跟着实测走**,不写死。原先这里硬写着"七具",而上面那张
            # 用的是 `len(bodies)` —— 同一个场景,两张图的标签说着两个数
            # (一处 9、一处 7),而两张图上都"看着挺对"。标签里的数字
            # 和机位里的数字必须是同一个来源。
            "label": f"人物模板全排(正视,正投影,{len(bodies)} 具同尺度)—— "
                     f"左右对称性、肩宽与髋宽之比(大跨步在此被透视缩短)",
            "loc": front_loc,
            "target": front_tgt,
            "ortho": True,
            "ortho_scale": _ortho_scale(front_loc, front_tgt, lo, hi),
        },
    ]

    # ⚠️ `bbs` 与 `bodies` 是**分别**过滤出来的两个列表,长度不一定相等 ——
    #    `bbs = [b for b in bbs if b is not None]` 那一行会丢掉取不到包围盒的
    #    物体。`zip` 在这里会**静默错位**:第 3 具的姿态名配上第 4 具的包围盒,
    #    取景看着仍然正常,只是框错了人。所以先断言两者等长。
    if len(bbs) != len(bodies):
        raise AssertionError(
            f"包围盒数 {len(bbs)} 与身体数 {len(bodies)} 不等 —— "
            f"两者已错位,继续下去会把 A 的取景配给 B。"
        )

    # 手上没有家什的姿态,标签里必须写出来。`07_characters` 只建**身体**,
    # 扁担、摊子、独轮车、缰绳都在 `06_props` 里、由 `08_assembly` 挂上 ——
    # 而图上看不出这个分工。不写的话,"挑担"那张图上是个空手的人,
    # 读的人只会得出"漏建了扁担"这一个结论,而那个结论是对的、原因却是错的。
    NO_PROP_NOTE = {
        "carry": "本图无扁担:扁担在 06_props,由 08_assembly 挂到 prop_R",
        "vendor": "本图无摊子与货物:同理由 08_assembly 布置",
        "push": "本图无独轮车:同上",
        "lead": "本图无缰绳与牲口:同上",
    }

    for body, (blo, bhi) in zip(bodies, bbs):
        pose = str(body.get("qm_pose"))
        # 瞄准包围盒**中心**(不再瞄胸口):单具图里目标是把这一具摆正、
        # 占满画幅,让七张之间可以直接比。瞄胸口会让深蹲那具沉到画幅
        # 底部、上方空掉三分之一 —— 又是"瞄准点不在盒心"的老毛病。
        c = (blo + bhi) * 0.5
        loc0 = (c.x + 1.55, c.y + 2.60, c.z + 0.30)
        note = NO_PROP_NOTE.get(pose, "")
        views.append({
            # `only` 把同排的另外六具藏掉,否则 0.95m 的间距下它们必然
            # 入镜,标签上的"单具"就是句假话。
            "name": f"char_pose_{pose}",
            "label": f"{C.Character.POSE_LABEL.get(pose, pose)} 单具(3/4)— "
                     f"腿有没有并到中线、关节是折角还是弯折"
                     + (f";{note}" if note else ""),
            # 余量 1.06:这具要占满画幅,"折角还是弯折"得在像素上看得出。
            "loc": _fit_dir(loc0, tuple(c), blo, bhi, 45.0, margin=1.06),
            "target": tuple(c),
            "lens": 45.0,
            "only": str(body["qm_id"]),
        })

    return views


def _run_stage2() -> dict:
    """跑阶段 2 的全部 builder(与 run_all.py 同一份清单)。"""
    # ⚠️ `MOD` 必须在这里 import,不能依赖 `__main__` 里那一次。
    #    原先它只在 `if __name__ == "__main__"` 分支里绑成全局名,
    #    于是 preview.py 直接跑没事,被 `probe_pixel.py` **当模块导入**时
    #    就在这一行炸 `NameError: name 'MOD' is not defined` ——
    #    而错误信息指向 `_run_stage2`,看着像是"构建失败",不是"导入方式
    #    不同"。同一个坑在本文件里已经以别的形态出现过(`_bbox_of` 的
    #    调用时机、机位的取数时机),都是**隐含依赖调用方的上下文**。
    from lib import modules as MOD

    names = (
        "00_layout", "01_bridge", "02_river", "03_boats", "04_buildings",
        "05_celebrations", "06_props", "07_characters", "08_assembly",
    )
    for name in names:
        path = BLENDER_DIR / "build" / f"{name}.py"
        if not path.exists():
            print(f"  [跳过] {name} 尚不存在")
            continue
        mod = MOD.load_build(name)
        stats = mod.build()
        for k, v in stats.items():
            if isinstance(v, (list, tuple, dict)) or k == "lash_angles":
                continue
            print(f"  {name}.{k:<18} {v}")

    # ⚠️ 合计**不能**去加各 builder 的 `objects` / `tris` 键。它们的键名
    #    根本不统一:`04_buildings` 报的是 `building_objects`、`05_celebrations`
    #    报的是 `celebration_objects`、`08_assembly` 两个都不报,而这三个
    #    都报不出 `tris`。于是原先那句 `+= stats.get("objects", 0)` 静默
    #    漏掉了 56 + 21 个建筑物体、48 个实例,以及**建筑和彩楼的全部三角面**:
    #    打印出来的"合计 131 个物体,87324 三角面"里,建筑群一个字都没算。
    #    实测对照:`87324 = 9528+19316+8704+8656+39368+1752`,正好是
    #    00/01/02/03/06/07 六项之和 —— 04 和 05 缺 0。
    #
    #    这一行是日志里最容易被直接引用的数字(它就印在渲染之前),
    #    所以口径必须和 `09_export` / `manifest.json` 一样:**直接数场景**。
    #    各 builder 自己报的那几行照旧打印,只是不再拿来做合计。
    scene_objs = list(bpy.context.scene.objects)
    tris = 0
    for o in scene_objs:
        if o.type == "MESH" and o.data is not None:
            o.data.calc_loop_triangles()
            tris += len(o.data.loop_triangles)
    print(f"  场景合计 {len(scene_objs)} 个物体 / 网格三角面 {tris}"
          f"(逐个 mesh 数,不经修改器;与导出同分母)")
    return {"objects": len(scene_objs), "tris": tris}


def _exit(code: int) -> None:
    """
    以 `code` 结束进程 —— **不能用 `raise SystemExit`**。

    ⚠️ 实测:脚本抛异常时 Blender 的 `--python` 处理器会把异常吞掉,
       进程仍返回 0。于是"渲染崩了"和"渲染成功"在调用方看来一模一样,
       而我会据此写下"EXIT=0,渲染成功"。同一处修法见 `run_all._exit`。
       `os._exit` 绕开解释器收尾,但**不刷缓冲**,所以必须先自己 flush,
       否则日志会丢掉最后一段 —— 恰好是 traceback 那一段。
    """
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(code)


if __name__ == "__main__":
    from lib import modules as MOD

    print("=" * 70)

    # 允许通过 -- 之后的参数指定要构建哪个脚本,例如:
    #   ... --python blender/tasks/preview.py -- 01_bridge bridge_v0
    #   ... --python blender/tasks/preview.py -- '*' site_v1 site
    #
    # target = '*' 表示跑阶段 2 的全部 builder(缺的会明确报出来,
    # 不静默跳过 —— 一张少了建筑的预览图比没有图更容易骗人)。
    argv = sys.argv
    target = "01_bridge"
    prefix = "bridge_v0"
    viewset = "bridge"
    if "--" in argv:
        rest = argv[argv.index("--") + 1 :]
        if rest:
            target = rest[0]
        if len(rest) > 1:
            prefix = rest[1]
        if len(rest) > 2:
            viewset = rest[2]

    print(f"构建 {target} → 渲染 {viewset} 机位 → {SHOT_DIR}")
    print("=" * 70)

    if target == "*":
        totals = _run_stage2()
        print(f"  合计 {totals['objects']} 个物体,{totals['tris']} 三角面")

        # 口径一次对齐:导出会把哪些件排除,预览就该把哪些件藏起来。
        # 只在整场构建之后验(`target != "*"` 时场景本来就不全,
        # 拿它判"缺标记"会冤枉人 —— 报错必须是可信的,不可信的报错
        # 会被学会忽略)。
        po = assert_preview_marks()
        for o in po:
            print(f"  仅预览·不导出 {o.name:<14} kind={o.get('qm_kind')} "
                  f"coll={[c.name for c in o.users_collection]}")
        print(f"  仅预览的物体 {len(po)} 件 —— 出图默认藏起来,"
              f"与导出口径(`{'、'.join(C.Export.PREVIEW_ONLY)}` 且带 "
              f"`qm_preview`)一致")
    else:
        mod = MOD.load_build(target)
        stats = mod.build()
        for k, v in stats.items():
            if k == "lash_angles":
                continue
            print(f"  {k:<18} {v}")

    print("-" * 70)
    viewsets = {
        # ⚠️ `"bridge"` 这一条**原先不在表里**,而上面 `viewset` 的默认值
        #    正是 `"bridge"` —— 于是不带第三个参数运行会打印
        #    "✗ 未知机位组 'bridge'" 并以 2 退出。默认值指向一个不存在的
        #    组,等于这个默认值从来没被走过:凡是真的用过它的人,都会
        #    先撞上这个错,然后学会永远显式传参 —— 于是那个坏默认值
        #    一直躺在那里,直到有人写文档时照着它抄。
        #    虹桥的机位函数是 `standard_views`(侧/桥下/俯/三视/背面),
        #    组名就叫 `bridge`,与文件前缀 `bridge_v0` 一致。
        "bridge": standard_views,
        "site": site_views,
        "boat": boat_views,
        "buildings": buildings_views,
        "props": props_views,
        "characters": characters_views,
    }
    if viewset != "*" and viewset not in viewsets:
        # ⚠️ 打错机位组名**必须报错**。原先 `.get()` 返回 None 等于"用默认机位",
        #    于是打错名字会静默渲出一组不相干的图 —— 而图上看着好好的,
        #    只有对照文件名才发现渲错了东西。这类"看起来成功了"的失败
        #    正是本项目反复栽的那个模式。
        print(f"✗ 未知机位组 {viewset!r};可选 {sorted(viewsets)} 或 '*'")
        _exit(2)

    # —— 机位组清单 —— #
    #
    # `"*"` = 每组各渲一遍。分开跑六次要重跑六遍阶段 2 构建(实测每次
    # 34–39s),而 `render_views` 本来就自己新建相机、渲完把 `hide_render`
    # 用 `finally` 还原,所以一进程里连渲六组是安全的。
    #
    # ⚠️ 但"安全"只到 `hide_render` 为止:有的组会**挪物体**
    #    (`characters_views` 把七具模板沿 X 排成一行,那是仅供预览的
    #    临时摆放)。以前一组一个进程,这种改动随进程一起消失;合进
    #    一个进程之后,它会漏给后面渲的组 —— 而出图依旧有桥有河有房子,
    #    只是人站成了一排。**"合起来跑更快"顺手就引入了这个泄漏**,
    #    所以每组渲染前后各存/还原一次位置上。
    #
    # 顺带:组名进文件名(`{prefix}_{组名}_{机位}.png`),这样单看一张图
    # 就知道它出自哪一组,不用回翻日志。
    # ⚠️ 单选一组时,**组名一样要进文件名**。原先它写的是 `[("", …)]` ——
    #    于是同一组机位按两条路走会得到两套文件名:
    #      `-- '*' stage2 '*'`      → `stage2_bridge_under.png`(基准图)
    #      `-- '*' stage2 bridge`   → `stage2_under.png`(另起一套)
    #    想单独重渲虹桥那一组(迭代时最常做的事,省掉另外五组的
    #    渲染时间)时,出来的图**不是**基准图,而基准图保持着上一次
    #    的旧内容 —— 盘上多出五个近名文件,而被引用的那五张没更新。
    #    这正是"改了却看不见效果"的经典成因。
    #
    #    文件名只该由 (前缀, 机位组) 决定,和"这一次请求了几组"无关。
    plan = (
        [(name, viewsets[name]) for name in viewsets]
        if viewset == "*"
        else [(viewset, viewsets[viewset])]
    )

    produced: list[Path] = []
    for setname, fn in plan:
        views = fn()
        print(f"\n机位组 {setname or '(默认)'} —— {len(views)} 个机位")
        # 这一组里**哪几张图带标位柱**:默认全不带,只有显式声明
        # `"markers": True` 的机位带。把这件事逐组念出来,是因为
        # "图上有没有那两条线"从前只能靠翻图发现 —— 而图上看不出
        # 那两条线是否会上线。
        mk = [v["name"] for v in views if v.get("markers")]
        print(f"  标位柱(仅预览·不入 GLB):"
              f"{'、'.join(mk) if mk else '全部机位都藏起来'}")
        if not views:
            # `render_views` 也会拦空表,但拦不到这里:分组名是我拼的,
            # 一个"算不出机位"的组在这里静默跳过,日志上只是一行 0 ——
            # 而整套图仍旧生成成功,少的是整整一类视角。
            print(f"✗ 机位组 {setname!r} 一个机位都没算出来,拒绝继续")
            _exit(2)
        # 只存位置:目前只有位置被机位函数改过。
        snap = [(o, o.location.copy()) for o in bpy.data.objects]
        try:
            produced += render_views(
                f"{prefix}_{setname}" if setname else prefix, views
            )
        finally:
            for o, loc in snap:
                o.location = loc
            bpy.context.view_layer.update()

    print("-" * 70)
    print(f"  共 {len(produced)} 张 → {SHOT_DIR}")
    missing = [p for p in produced if not p.exists()]
    if missing:
        # 返回了路径不等于文件落了盘。少一张图而日志写着"共 N 张",
        # 是最容易带进文档的那种错。
        for p in missing:
            print(f"  ✗ 没写出来:{p}")
        _exit(1)
    print("=" * 70)
    _exit(0)
