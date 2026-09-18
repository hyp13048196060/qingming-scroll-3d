"""
数一遍场景里到底有什么,写成 `blender/out/stats.json`。

它服务三件事,一件都不能少
--------------------------
1. **`docs/09-资产统计.md` 的唯一数据源。**
   计划里写明那份文档"完全由脚本生成,禁止手写数字"。手写数字的
   问题不在于可能写错,而在于**写错之后没人会发现** —— 它看上去
   和真数据一模一样,而且下次构建变了它也不会跟着变。
2. **`tools/verify_reproducible.mjs` 的比对对象。**
   两次构建的"对象数 + 每对象三角面 + 包围盒(1e-4)"要从这里取。
   判据是统计量而不是二进制哈希,原因见 `docs/07`:
   glTF 导出器会往文件里写 generator 字段,哈希必然不同。
3. **给阶段 3/4 的接口清单。**
   哪些物体带 `qm_anim`、哪些带风动顶点权重、骨架有多少根骨,
   网页侧要靠它才知道该驱动什么。这些数在 Blender 里量最准。

⚠️ 与 `09_export.py` 的 `manifest.json` 是**两个不同的量**,
   不要互相印证,也不要当成同一个东西:
       manifest.json  —— 导出器**写了什么**(按文件、按字节)
       stats.json     —— 场景里**有什么**(按物体、按几何)
   两者对不上正是要抓的情形(例如某集合没被任何分块收进去:
   它在 stats 里存在,在 manifest 里不存在)。`stats_report.mjs`
   会把这两份摆在一起比,**比对结果本身就是报告的一部分**。

⚠️ 确定性的判据范围:`meta` 段**不参与比对**。
   里面是 builtAt、Blender 版本号这类每次都不同的东西。
   比对一律只看 `totals` / `objects` / `by_*` 这些段。

能力边界(同样写进 docs/08)
---------------------------
· 它数的是 **Blender 场景**,不是 GLB 里的实际内容。导出器会不会
  合并、要不要加修饰器、法线怎么切,它一概不知道 —— 那些在
  `tools/lib/glb.mjs` 那一侧量,两侧都量才叫量过。
· `verts` 是**物体自身的顶点数**,不是导出后的顶点数。三角化、法线
  分裂、蒙皮权重都会让导出后的顶点数变多。这两个数**本来就不该相等**,
  别拿它当"导出是否丢面"的证据。
· 包围盒是**世界坐标系下的轴对齐包围盒**(AABB)。两个形状完全不同
  的物体可以有相同的 AABB,所以它是"位置与尺度是否漂移"的判据,
  不是"形状是否一致"的判据。
· 贴图字节数分两个口径:Blender 侧的 `rawBytes` 是**解压后**的光栅
  大小(W×H×通道),不是它在 GLB 里占的字节。GLB 里的真实占用由
  `tools/lib/glb.mjs` 从 bufferViews 量。

单独运行:
    blender.exe --background --factory-startup --python blender/tasks/report_objects.py
⚠️ 单独运行时场景是空的,会写出一份**全零的报告**。它只对
   "本次构建的产物"有意义,所以正常路径是 `run_all.py` 在导出后调用。
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import bpy
from mathutils import Vector

BLENDER_DIR = Path(__file__).resolve().parents[1]
PROJECT_DIR = BLENDER_DIR.parent
if str(BLENDER_DIR) not in sys.path:
    sys.path.insert(0, str(BLENDER_DIR))

import config as C  # noqa: E402
from lib import tag_utils as TU  # noqa: E402

OUT_PATH = BLENDER_DIR / "out" / "stats.json"

# Blender 自建的内部图像,不是资产。与 09_export.py 用同一份名单 ——
# 但**不 import 它**:那个模块 import 时会拉进导出器,而本脚本可能在
# 导出之前就被调用。两处各写一份同样的常量,代价是改一处要记得改另一处;
# 好处是这份报告不依赖导出流程的顺序。改名单时两边一起改。
INTERNAL_IMAGES = frozenset({"Render Result", "Viewer Node"})

# 包围盒/尺寸的取整位数。判据是"1e-4 精度内一致",所以在这里就把
# 小数位定死 —— 让两份报告的比较是**字符串比较**,不是浮点比较。
# 浮点比较要挑 epsilon,而挑多大本身又是个说不清的决定。
ND = 4


def _r(x: float) -> float:
    """按 ND 位取整。顺带把 -0.0 归一成 0.0,否则两次构建可能一个写 -0.0 一个写 0.0。"""
    v = round(float(x), ND)
    return 0.0 if v == 0 else v


def _tris(obj: bpy.types.Object) -> int:
    """三角面数。用 loop_triangles 而不是 faces*2 —— 导出器也是这么算的。"""
    if obj.type != "MESH":
        return 0
    obj.data.calc_loop_triangles()
    return len(obj.data.loop_triangles)


def _bbox(obj: bpy.types.Object) -> list[float] | None:
    """
    世界坐标系下的 AABB,返回 [minx,miny,minz,maxx,maxy,maxz]。

    ⚠️ 两个实测过的坑:
       1) `bound_box` 是**局部**坐标。直接读它就是量了局部尺寸,
          而物体若被旋转过(虹桥的拱骨、船的桅),局部盒子与
          世界盒子能差出十倍。必须逐角点乘 `matrix_world`。
       2) `matrix_world` 是**上一次依赖图求值**留下的缓存。
          改完变换不更新就直接读,拿到的可能是旧值 —— 而且旧值
          看上去完全正常,不会报错。所以调用方先统一
          `view_layer.update()`,见 `collect()`。
    """
    if obj.type not in {"MESH", "CURVE", "SURFACE", "FONT"}:
        # 空物体与骨架也报位置,但它们的"包围盒"只有原点一件事,
        # 报出来会被误读成几何范围。宁可不报。
        return None
    corners = [_r(v) for corner in obj.bound_box for v in (obj.matrix_world @ Vector(corner))]
    xs, ys, zs = corners[0::3], corners[1::3], corners[2::3]
    return [min(xs), min(ys), min(zs), max(xs), max(ys), max(zs)]


def _mesh_verts(obj: bpy.types.Object) -> int:
    return len(obj.data.vertices) if obj.type == "MESH" else 0


def _images() -> list[dict]:
    """
    场景里用到的真实图像。

    ⚠️ `bpy.data.images` 里混着 "Render Result" 这类内部图像,直接
       len() 会虚报。**只能按名字排,不能按 source 排** ——
       程序化烘焙出来的贴图 source 也是 "GENERATED",按 source 排
       会把真贴图一起排掉(这一条与 09_export.py 踩的是同一个坑)。
    """
    out = []
    for img in bpy.data.images:
        if img.name in INTERNAL_IMAGES:
            continue
        w, h = img.size[0], img.size[1]
        ch = img.channels
        packed = img.packed_file
        out.append(
            {
                "name": img.name,
                # 解压后的光栅字节数。**不是**它在 GLB 里占的字节 ——
                # 那一个由 tools/lib/glb.mjs 从 bufferViews 量。
                "rawBytes": w * h * ch,
                "packedBytes": packed.size if packed else None,
                "size": [w, h],
                "channels": ch,
                "colorspace": img.colorspace_settings.name,
                "fileFormat": img.file_format,
                # 0 表示图像还没有像素数据(例如只声明了尺寸就丢了)
                "hasData": bool(img.has_data),
            }
        )
    out.sort(key=lambda d: d["name"])
    return out


def _armatures() -> list[dict]:
    out = []
    for obj in bpy.data.objects:
        if obj.type != "ARMATURE":
            continue
        bones = obj.data.bones
        out.append(
            {
                "name": obj.name,
                "bones": len(bones),
                # 只有 use_deform 的骨才会进 glTF 的 skin。
                # 挂点骨(prop_R)是形变骨,但要单独数出来 ——
                # 阶段 4 的"≤25 根骨预算"按的是总数,不是形变骨数,
                # 两个数都摆出来,用哪个由读的人决定。
                "deformBones": sum(1 for b in bones if b.use_deform),
                "boneNames": sorted(b.name for b in bones),
            }
        )
    out.sort(key=lambda d: d["name"])
    return out


def _tag_keys(obj: bpy.types.Object) -> list[str]:
    return sorted(k for k in obj.keys() if k.startswith("qm_"))


def collect() -> dict:
    """量一遍当前场景,返回可 JSON 化的报告体。"""
    # ⚠️ 必须先把依赖图求值一次,否则下面读到的 matrix_world 是
    #    builder 最后一次留下的缓存。见 _bbox 的注释。
    bpy.context.view_layer.update()

    scene_objs = list(bpy.context.scene.objects)
    data_objs = list(bpy.data.objects)
    scene_names = {o.name for o in scene_objs}
    data_names = {o.name for o in data_objs}

    # —— 三份名单必须对得上 ——
    #
    # 三份名单指的是:
    #   (a) bpy.data.objects           —— Blender 文件里存在的全部物体
    #   (b) bpy.context.scene.objects  —— 当前场景里的(预览渲染看得见的)
    #   (c) 分块集合的并集              —— 会被导出的
    #
    # (a) 比 (b) 多  ⇒ 有物体没链进场景。预览图上看不见,但导出器是
    #                   按**集合**取的,它照样会被导出 —— 也就是说
    #                   可能出现"预览里没有、GLB 里有"的东西。
    # (b) 比 (a) 多  ⇒ 理论上不会发生,真发生了说明有更奇怪的状态。
    # (c) 与 (a) 不一致 ⇒ 有物体落在所有分块之外,`assert_full_coverage`
    #                   本该拦住它,这条是把那个断言的结果**记下来**,
    #                    而不是再断言一次。
    #
    # 把三者摆在一起是这份报告的主要理由之一:单独看任何一份都
    # 很正常,差异只在**两份之间**才显形。
    chunk_members: set[str] = set()
    chunks: dict[str, dict] = {}
    for chunk_name, collections in C.Export.CHUNKS.items():
        names = [c.name for c in bpy.data.collections if c.name in set(collections)]
        members: list[bpy.types.Object] = []
        for coll in bpy.data.collections:
            if coll.name in set(collections):
                members.extend(coll.all_objects)
        members = list({o.name: o for o in members}.values())
        chunk_members |= {o.name for o in members}
        # 只读集合名、不问它是否存在 —— 集合不存在时 members 为空,
        # 这一条由 stats_report 报出来(空的集合意味着那一块没建)。
        chunks[chunk_name] = {
            "collections": list(collections),
            "collectionsFound": names,
            "objects": len(members),
            "meshes": sum(1 for o in members if o.type == "MESH"),
            "tris": sum(_tris(o) for o in members),
            "verts": sum(_mesh_verts(o) for o in members),
        }

    # —— 逐物体 ——
    objects = []
    by_kind: dict[str, int] = {}
    by_zone: dict[str, int] = {}
    by_lod: dict[str, int] = {}
    by_anim: dict[str, int] = {}
    tag_key_hist: dict[str, int] = {}
    flex_objects: list[str] = []
    skinned: list[str] = []
    untagged_leak: list[str] = []      # 有 qm_* 键但没有 qm_id
    unknown_tag_keys: list[str] = []   # 不在 KNOWN_KEYS 里的 qm_* 键

    for obj in sorted(data_objs, key=lambda o: o.name):
        keys = _tag_keys(obj)
        for k in keys:
            tag_key_hist[k] = tag_key_hist.get(k, 0) + 1
            if k not in TU.KNOWN_KEYS:
                unknown_tag_keys.append(f"{obj.name}.{k}")
        if keys and "qm_id" not in obj:
            untagged_leak.append(obj.name)

        if obj.type == "MESH" and C.Export.FLEX_ATTR in obj.data.color_attributes:
            flex_objects.append(obj.name)
        if obj.type == "MESH" and obj.find_armature() is not None:
            skinned.append(obj.name)

        kind = str(obj.get("qm_kind", "")) if "qm_kind" in obj else ""
        if kind:
            by_kind[kind] = by_kind.get(kind, 0) + 1
        zone = str(obj.get("qm_zone", "")) if "qm_zone" in obj else ""
        if zone:
            by_zone[zone] = by_zone.get(zone, 0) + 1
        lod = str(obj.get("qm_lod", "")) if "qm_lod" in obj else ""
        if lod:
            by_lod[lod] = by_lod.get(lod, 0) + 1
        anim = str(obj.get("qm_anim", "")) if "qm_anim" in obj else ""
        if anim and anim != "none":
            by_anim[anim] = by_anim.get(anim, 0) + 1

        objects.append(
            {
                "name": obj.name,
                "type": obj.type,
                "kind": kind,
                "tris": _tris(obj),
                "verts": _mesh_verts(obj),
                "bbox": _bbox(obj),
                "materials": sorted(
                    m.name for m in obj.data.materials if m is not None
                ) if obj.type == "MESH" else [],
                "collections": sorted(c.name for c in obj.users_collection),
                # 不在场景里 ⇒ 预览图看不见它。单独标出来,免得
                # 后面拿预览图当"这个物体也在"的证据。
                "inScene": obj.name in scene_names,
                "dynamic": int(obj.get("qm_dynamic", 0)) if "qm_dynamic" in obj else 0,
                "anim": anim,
                "lod": lod,
                "zone": zone,
                "tagKeys": keys,
            }
        )

    meshes = [o for o in data_objs if o.type == "MESH"]

    # —— 材质 ——
    mat_use: dict[str, list[str]] = {}
    for obj in meshes:
        for slot in obj.data.materials:
            if slot is None:
                continue
            mat_use.setdefault(slot.name, []).append(obj.name)
    materials = [
        {"name": name, "objects": len(users), "sample": sorted(users)[:3]}
        for name, users in sorted(mat_use.items())
    ]

    images = _images()
    armatures = _armatures()

    # —— 标签:词表清点 + 三条能查的契约 ——
    #
    # ⚠️ 这里第一版写的是"qm_dynamic=1 但 qm_anim=none 就报错",
    #    结果一次跑出 **48 条**,而逐条查下去**没有一条是真的**:
    #      · 柳叶 sway + 有 flex 顶点权重  → 顶点着色器风动,不需要轴心
    #      · 彩楼欢门的杆件 anim=none      → 会动的是它挂的布,杆是不动的
    #      · 船壳 anim=none 但有 qm_parent → 整船摇晃,壳随船走
    #      · 撑船/摆摊人物 anim=none       → 走路是程序化驱动(qm_pose)
    #      · acc_actor_* 有 qm_parent      → 器物随演员走
    #    48 条噪声里藏着 0 条真问题 —— 这比不报还坏:真有问题时它也
    #    只是变成第 49 行。**规则是我按计划里那张表推的,而计划那张表
    #    本来就是个设想值,不是 builders 的实情**(实测词表里根本没有
    #    `rotate`,却多出 `walk` 与 `oar`)。所以改成:
    #      1) 词表只**清点**,不判对错 —— 它是交给阶段 3 的实情;
    #      2) 只查**能由标签自身判定**的三件事(下面)。
    #    剩下 2 条,那 2 条是真的。
    anims: dict[str, list[str]] = {}
    pivot_issues: list[str] = []
    unexplained: list[str] = []
    bbox_by_name = {o["name"]: o["bbox"] for o in objects}

    for obj in data_objs:
        name = obj.name
        anim = str(obj.get("qm_anim", "")) if "qm_anim" in obj else ""
        if anim:
            anims.setdefault(anim, []).append(name)

        # (1) 声明了轴心 —— 就得能解析,而且得落在物体附近。
        #     写错一位小数的 pivot 不会报错,只会让船桅绕着空气转。
        if "qm_pivot" in obj:
            raw = str(obj["qm_pivot"])
            try:
                p = [float(v) for v in raw.replace(" ", "").split(",")]
            except ValueError:
                p = []
            if len(p) != 3:
                pivot_issues.append(f"{name}: qm_pivot={raw!r} 解析不出三个数")
            else:
                bb = bbox_by_name.get(name)
                if bb:
                    # 轴心到物体包围盒的距离。取"超出盒子的距离",
                    # 点在盒内为 0。阈值取盒子对角线的一半 ——
                    # 轴心可以贴边、可以在盒外一点(船桅的轴在桅杆根部),
                    # 但不该飞到另一个街区去。
                    out = 0.0
                    for i in range(3):
                        lo, hi = bb[i], bb[i + 3]
                        out += max(lo - p[i], 0.0, p[i] - hi) ** 2
                    diag = sum((bb[i + 3] - bb[i]) ** 2 for i in range(3)) ** 0.5
                    if out > (diag * 0.5) ** 2:
                        pivot_issues.append(
                            f"{name}: qm_pivot={raw} 距物体包围盒 {out ** 0.5:.2f}m,"
                            f"盒子对角线才 {diag:.2f}m —— 像是写错了"
                        )
        elif anim in {"mast_fold", "rudder", "rotate"}:
            # (2) 部位级的**刚体转动**却没有轴心 —— 网页侧只能猜。
            #     只查这三个值:`sway`/`wind` 既可能是顶点着色器风动
            #     (看 flex),也可能是别的东西,不在能自动判定的范围里。
            pivot_issues.append(f"{name}: qm_anim={anim} 却无 qm_pivot")

        # (3) 标了"每帧更新",而**没有任何一条标签说明它会怎么动**。
        #     anim / parent / flex / pose 四条里至少要有一条 ——
        #     都没有,网页侧拿到手只能当静态件,那 dynamic 就等于白标。
        if int(obj.get("qm_dynamic", 0)):
            if (anim in {"", "none"}
                    and "qm_parent" not in obj
                    and "qm_flex" not in obj
                    and name not in set(flex_objects)
                    and "qm_pose" not in obj
                    and obj.get("qm_kind") not in {"water", "terrain"}):
                unexplained.append(
                    f"{name}: qm_dynamic=1,但 anim=none 且无 parent/flex/pose ——"
                    f"没有任何标签说明它靠什么动"
                )

    # —— 预览件:按设计不导出,不该算成"掉件" ——
    #
    # ⚠️ 第一版没扣掉它们,于是 `人物标位` 里的标记柱被报成
    #    "不在任何分块 —— assert_full_coverage 本该拦住它",
    #    而实际上 `assert_full_coverage` **正是**放它过去的:
    #    config.Export.PREVIEW_ONLY 的规则是"在声明的预览集合里
    #    **且**带 qm_preview 标记",两条都满足就不导出、也不该报错。
    #    报告不认这条规则,就会把**设计**报成**缺陷** —— 这与
    #    "把缺陷报成正常"是同一个错的两面。
    preview_coll = set(C.Export.PREVIEW_ONLY)
    preview = sorted(
        o.name for o in data_objs
        if "qm_preview" in o and preview_coll & {c.name for c in o.users_collection}
    )
    preview_set = set(preview)

    declared = {c for colls in C.Export.CHUNKS.values() for c in colls}
    existing = {c.name for c in bpy.data.collections}

    # —— 三角面对账:总数 = 各分块之和 + 预览件 + 说不清的 ——
    #
    # 这一块是**必须**的。没有它,`totals.tris`(场景全部)与
    # manifest 里的 `totalTris`(导出之和)就是两个各自看着正常的数,
    # 差 960 也没人会发现差在哪 —— 而 960 正是那两个标记柱。
    tris_total = sum(_tris(o) for o in meshes)
    tris_chunks = sum(c["tris"] for c in chunks.values())
    tris_preview = sum(_tris(o) for o in data_objs if o.name in preview_set)
    tris_orphan = sum(_tris(o) for o in meshes
                      if o.name not in chunk_members and o.name not in preview_set)

    return {
        "meta": {
            "schema": 1,
            # ⚠️ 以下三项**每次运行都不同,不参与确定性比对**。
            #    比对脚本必须显式排除 meta 段,或者只取已知的稳定键。
            "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "blender": bpy.app.version_string,
            "source": "Blender 场景内实测(非 GLB 解包),GLB 侧数据见 tools/lib/glb.mjs",
            "roundTo": ND,
        },
        "seed": C.SEED,
        "unit": C.UNIT,
        "totals": {
            "objectsData": len(data_objs),
            "objectsScene": len(scene_objs),
            "meshes": len(meshes),
            "armatures": len(armatures),
            "empties": sum(1 for o in data_objs if o.type == "EMPTY"),
            "materials": len(bpy.data.materials),
            "images": len(images),
            "collections": len(bpy.data.collections),
            "tris": tris_total,
            "verts": sum(_mesh_verts(o) for o in meshes),
        },
        "agreement": {
            "dataOnly": sorted(data_names - scene_names),
            "sceneOnly": sorted(scene_names - data_names),
            # 预览件按设计不导出,不在此列 —— 单独一段报
            "notInAnyChunk": sorted(data_names - chunk_members - preview_set),
            "chunkItemsNotInData": sorted(chunk_members - data_names),
            # **声明的集合有没有建出来。**这是 09_export.assert_full_coverage
            # 的补集:那个查"物体有没有掉在分块外",这个查"分块里声明的
            # 集合存不存在"。两个方向都查才闭环 —— 城墙城门楼当初就是从
            # 这一个方向漏出去的。
            "declaredCollectionsMissing": sorted(declared - existing),
        },
        "trisReconcile": {
            "total": tris_total,
            "chunks": tris_chunks,
            "previewOnly": tris_preview,
            "unaccounted": tris_orphan,
            "ok": tris_total == tris_chunks + tris_preview + tris_orphan,
            "note": "total = chunks + previewOnly + unaccounted。"
                    "manifest.totalTris 应当等于 chunks 这一项。",
        },
        "previewOnly": {
            "collections": list(C.Export.PREVIEW_ONLY),
            "objects": preview,
            "tris": tris_preview,
        },
        "chunks": chunks,
        "byKind": dict(sorted(by_kind.items())),
        "byZone": dict(sorted(by_zone.items())),
        "byLod": dict(sorted(by_lod.items())),
        "byAnim": dict(sorted(by_anim.items())),
        # 词表**只清点,不判对错**。计划里那张表写的是
        # none/sway/wind/mast_fold/rudder/rotate,而 builders 实际用出来的是
        # none/walk/oar/wind/sway/mast_fold/rudder —— 没有 rotate,多了两个。
        # 这不是缺陷,是计划与实现的差异,得让阶段 3 照着**实情**去写分发器。
        "animVocabulary": {
            k: {"count": len(v), "sample": sorted(v)[:4]}
            for k, v in sorted(anims.items())
        },
        "flexObjects": sorted(flex_objects),
        "skinnedObjects": sorted(skinned),
        "tagKeys": dict(sorted(tag_key_hist.items())),
        "tagIssues": {
            "pivot": sorted(pivot_issues),
            "unexplainedMotion": sorted(unexplained),
        },
        "tagLeaks": {
            "hasTagWithoutId": sorted(untagged_leak),
            "unknownKeys": sorted(set(unknown_tag_keys)),
        },
        "materials": materials,
        "images": images,
        "armatures": armatures,
        "objects": objects,
        "boundaries": [
            "数的是 Blender 场景,不是 GLB 里的实际内容 —— 导出器的合并、"
            "修饰器应用、法线分裂都不在此列。两侧都量才叫量过(tools/lib/glb.mjs)。",
            "verts 是物体自身顶点数,不是导出后顶点数。三角化与法线分裂会让"
            "导出后变多,两个数本来就不该相等,别拿它当『导出丢面』的证据。",
            "bbox 是世界坐标下的轴对齐包围盒。形状不同的物体可以有相同的 AABB,"
            "所以它是『位置与尺度是否漂移』的判据,不是『形状是否一致』的判据。",
            "images[].rawBytes 是解压后的光栅字节(W×H×通道),不是它在 GLB 里"
            "占的字节。后者从 GLB 的 bufferViews 量,见 tools/lib/glb.mjs。",
            "meta 段(builtAt / blender 版本)每次都不同,不参与确定性比对。",
            "tagIssues 只查**能由标签自身判定**的三件事(轴心可解析且落在物体附近、"
            "部位级转动有轴心、dynamic=1 至少有一条动因标签)。"
            "『这个物体该不该动』是设计问题,标签判不了 —— 第一版硬要判,"
            "48 条全是误报。",
        ],
    }


def assert_declared_collections(data: dict) -> None:
    """
    硬门禁:分块表里声明的集合,必须**真的建出来了**。

    这是 `09_export.assert_full_coverage()` 的补集。那个查的是
    "物体有没有掉在分块之外",查不出"声明的集合根本不存在" ——
    而后者正是 `城墙城门楼` 当初的处境:分块表里写着它,
    `04_buildings` 却把城墙与城门楼建进了 `建筑群`,于是

        · scene_core 里一座城墙也没有(首屏缺远景骨架),
        · 而覆盖率断言一路绿灯 —— 因为城墙确实"在某个分块里",
          只是在**另一个**分块里。

    两个方向都查才闭环。放在**导出之前**跑:查出来就不产出 GLB,
    而不是先产出一批位置不对的文件再报错。

    ⚠️ 只对阶段 2 起生效。阶段 1 只建虹桥,分块表里另外三块本来就
       还不存在 —— 那种缺失是**进程中的正常状态**,不是错误。
       判据按阶段给,才不会被"还没做"卡住(与 validate 的 strict 同理)。
    """
    missing = data["agreement"]["declaredCollectionsMissing"]
    if not missing:
        return
    detail = "\n".join(
        f"    {c}  ← 声明于 "
        + "、".join(k for k, v in C.Export.CHUNKS.items() if c in v)
        for c in missing
    )
    raise AssertionError(
        f"分块表声明了 {len(missing)} 个集合,但它们**不存在**:\n{detail}\n"
        f"  后果是那一块 GLB 少掉本该属于它的内容,而覆盖断言查不出来。\n"
        f"  修法:让对应的 builder 用 `BU.get_collection(<该名字>)` 建它,"
        f"或者把 config.Export.CHUNKS 改成分块表与 builder 一致的名字。\n"
        f"  当前实际存在的集合:{sorted(c.name for c in bpy.data.collections)}"
    )



def report(*, write: bool = True) -> dict:
    """量一遍并写出 stats.json,同时在终端打一张摘要表。"""
    data = collect()

    t = data["totals"]
    print(f"  物体 {t['objectsData']}(场景内 {t['objectsScene']})"
          f"  网格 {t['meshes']}  骨架 {t['armatures']}"
          f"  空物体 {t['empties']}")
    print(f"  三角面 {t['tris']}  顶点 {t['verts']}"
          f"  材质 {t['materials']}  贴图 {t['images']}")
    print(f"  集合 {t['collections']}  标签覆盖 {len(TU.collect_tags(bpy.data.objects))} 件")

    for name, c in data["chunks"].items():
        miss = [x for x in c["collections"] if x not in c["collectionsFound"]]
        flag = f"  ⚠ 集合不存在:{'、'.join(miss)}" if miss else ""
        print(f"    {name:<18} {c['objects']:>4} 物体  {c['tris']:>8} tris{flag}")

    # 三角面对账。三个数摆在一起 —— 单看任何一个都正常。
    r = data["trisReconcile"]
    print(f"  三角面对账: 全部 {r['total']} = 分块 {r['chunks']}"
          f" + 预览件 {r['previewOnly']} + 无归属 {r['unaccounted']}"
          f"  {'✓' if r['ok'] else '✗ 对不上'}")

    if data["byKind"]:
        print("  按类别 " + "  ".join(f"{k}={v}" for k, v in data["byKind"].items()))
    if data["animVocabulary"]:
        print("  动作词表(交给阶段 3)" + "  ".join(
            f"{k}×{v['count']}" for k, v in data["animVocabulary"].items()))

    # —— 不一致一律打出来,不留在 JSON 里等人去翻 ——
    ag = data["agreement"]
    for key, label, why in (
        ("dataOnly", "不在场景内", "预览渲染看不见它,但导出器按集合取,可能照样被导出"),
        ("sceneOnly", "只在场景内", "不在 bpy.data.objects,状态不正常"),
        ("notInAnyChunk", "不在任何分块", "不会被导出 —— assert_full_coverage 本该拦住它"),
        ("chunkItemsNotInData", "分块里有而数据里没有", "理论上不会发生"),
        ("declaredCollectionsMissing", "声明的集合不存在",
         "那一块 GLB 会少掉本该属于它的内容,而覆盖断言查不出来"),
    ):
        if ag[key]:
            print(f"  ⚠ {label} {len(ag[key])} 件:{why}")
            for n in ag[key][:6]:
                print(f"      {n}")
            if len(ag[key]) > 6:
                print(f"      …… 另有 {len(ag[key]) - 6} 件(全部见 stats.json)")

    pv = data["previewOnly"]
    if pv["objects"]:
        # 这一行是**说明**,不是告警:预览件不导出是设计。
        print(f"  · 预览件(按设计不导出,集合 {pv['collections']}):"
              f"{pv['objects']}  {pv['tris']} tris")

    ti = data["tagIssues"]
    if ti["pivot"]:
        print(f"  ⚠ 轴心问题 {len(ti['pivot'])} 条:")
        for line in ti["pivot"][:6]:
            print(f"      {line}")
    if ti["unexplainedMotion"]:
        print(f"  ⚠ 标了 dynamic 却没有动因 {len(ti['unexplainedMotion'])} 件:")
        for line in ti["unexplainedMotion"][:6]:
            print(f"      {line}")
    if data["tagLeaks"]["hasTagWithoutId"]:
        print(f"  ⚠ {len(data['tagLeaks']['hasTagWithoutId'])} 件物体带 qm_* 键但没有 qm_id")
    if data["tagLeaks"]["unknownKeys"]:
        print(f"  ⚠ 出现未知标签键:{data['tagLeaks']['unknownKeys']}")

    if write:
        OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
        OUT_PATH.write_text(
            json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        size = OUT_PATH.stat().st_size
        print(f"  统计:{OUT_PATH.relative_to(PROJECT_DIR)}  {size / 1024:.0f} KB")

    return data


if __name__ == "__main__":
    print("=" * 70)
    print("场景统计(单独运行:场景是空的,报告全零 —— 正常路径是 run_all.py 调用)")
    print("=" * 70)
    report()
