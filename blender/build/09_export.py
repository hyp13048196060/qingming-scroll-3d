"""
分块导出 GLB + 生成 manifest.json。

分块原则
--------
按"**加载时机 + 更新频率**"切分,不是按类型切分(见 config.Export.CHUNKS):

    scene_core        河道 / 岸线 / 虹桥 / 城墙城门楼   —— 首屏必须,先加载
    scene_props       建筑群 / 彩楼欢门 / 柳树 / 道具   —— 次屏
    boats             全部船只                        —— 有独立动画
    scene_characters  人物模板                        —— 有蒙皮

这样加载进度条可以按块汇报,而不是"整体卡住"。

⚠️ 导出参数里最要紧的一条是顶点色模式
    `export_vertex_color="NAME"` + `export_vertex_color_name="flex"`。
    默认的 `MATERIAL` 模式会把同一个颜色属性**重复导出两份**
    (COLOR_0 + COLOR_1),文件还更大 —— 这是阶段 0 用两轮探针试出来的,
    见 blender/API_NOTES.md 第 4 节。

    但 NAME 模式指向一个**具体属性名**:若场景里根本没有 `flex`
    (阶段 1 的桥就还没有),它是否报错、是否导出一个空的 COLOR_0,
    没有实测过。所以这里**先探测再决定**:没有任何物体带 `flex`
    就退回 `NONE`,不留悬案。

⚠️ 图像格式同理,而且更贵:**默认 AUTO 会把贴图按 PNG 嵌进 GLB。**
    阶段 2 第一次全量产出的四个 GLB 共 37.84 MB,其中 **27.7 MB 是
    PNG 贴图**(逐块量过:scene_core 21.26 MB 里 18.83 MB 是 18 张 PNG,
    scene_props 12.82 MB 里 5.93 MB 是 27 张)—— 几何只占 9.8 MB。
    计划里的体积预算是 22 MB,超出的部分**全是贴图编码**,不是模型做多了。

    所以这里选 WEBP(有损),但不写死:先问一句本机的导出器认不认 WEBP。

    ⚠️ 「去哪儿问」这一步我走错过一次,记在这里:**同一个算子有两个 RNA,
       一个答得上来,一个连属性都没有。**(两个数都是实测打印出来的)

         bpy.ops.export_scene.gltf.get_rna_type()`  ← 实例 RNA
             .properties['export_image_format'].enum_items
             = ['AUTO', 'JPEG', 'WEBP', 'NONE']          ← 齐全

         bpy.types.EXPORT_SCENE_OT_gltf.bl_rna       ← 类 RNA
             .properties['export_image_format']
             = KeyError: key "export_image_format" not found   ← **属性不存在**

       第一版写的是后者,而且用的是 `.get()` —— 于是 KeyError 没发生,
       静默返回 None,`.get(..., [])` 再把它抹平成空列表。这个空列表
       一路顺流而下,得出「本机不支持 WEBP」,退回 AUTO,体积一个字节
       没省;日志里那句警告还写得挺像回事(「这台机器做不到」)。
       **差点把「仪器接错了线」记成「机器不行」。**
       要命的是 `.get()` 的行为正是我想要的"缺了就退回默认值":它把
       「这个键不存在」和「这个键存在但值是我预期的空」压成了同一个
       结果 —— 而这两件事在这里的结论完全相反。
       旁证:`preflight.py` 早就把这份枚举写进了 `caps.json`,用的正是
       实例 RNA。证据一直在仓库里,只是我没去对。

    问不到就退回 AUTO 并**打出声来** —— 静默退回等于让人以为体积已经
    压过了。
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import bpy

BLENDER_DIR = Path(__file__).resolve().parents[1]
PROJECT_DIR = BLENDER_DIR.parent
sys.path.insert(0, str(BLENDER_DIR))

import config as C  # noqa: E402
from lib import modules as MOD  # noqa: E402
from lib import tag_utils as TU  # noqa: E402

OUT_DIR = PROJECT_DIR / "public" / "models"

# Blender 自建的内部图像,不是资产
INTERNAL_IMAGES = frozenset({"Render Result", "Viewer Node"})


# --------------------------------------------------------------------------
# 选取
# --------------------------------------------------------------------------


def objects_in(collections: tuple[str, ...]) -> list[bpy.types.Object]:
    """
    取若干集合下的全部物体(含嵌套集合)。

    按**集合名**取而不是按物体名:集合是建模时有意分的区,
    物体名可能被 Blender 自动加 .001 后缀,靠名字匹配早晚会漏。
    """
    want = set(collections)
    found: list[bpy.types.Object] = []
    for coll in bpy.data.collections:
        if coll.name in want:
            found.extend(coll.all_objects)
    # 去重:同一物体可能同时挂在嵌套集合里
    return list({o.name: o for o in found}.values())


def has_flex(obj: bpy.types.Object) -> bool:
    return obj.type == "MESH" and C.Export.FLEX_ATTR in obj.data.color_attributes


def triangle_count(obj: bpy.types.Object) -> int:
    """三角面数。用 loop_triangles 而不是 faces*2 —— 导出器也是这么算的。"""
    if obj.type != "MESH":
        return 0
    mesh = obj.data
    mesh.calc_loop_triangles()
    return len(mesh.loop_triangles)


# --------------------------------------------------------------------------
# 导出
# --------------------------------------------------------------------------


def image_format() -> str:
    """
    选导出图像格式:**先问 Blender 认不认 WEBP,再决定用不用。**

    三处都是同一件事的实测结论,少一处就会得到"不支持 WEBP"的假答案:

      · 要读 `bpy.ops.export_scene.gltf.get_rna_type()`,也就是**实例 RNA**。
        `bpy.types.EXPORT_SCENE_OT_gltf.bl_rna`(类 RNA)读同一个属性,
        `enum_items` 实测返回**空列表** —— 而 `config` 里明明白白写着
        这台机器的枚举是 `AUTO / JPEG / WEBP / NONE`。读空列表就会把
        「支持」判成「不支持」,于是次次退回 PNG。
      · 实例 RNA 万一也空,还有后手:陷阱 2 的老办法 —— 往 `default` 上
        写一个非法值,让报错把合法值列出来(`preflight.py` 同款手法)。
      · 两条都问不出来才退回 AUTO,**且必须打出声**。静默退回会让人
        以为体积已经压过了,而实际一个字节没省。
    """
    have: list[str] = []
    try:
        prop = bpy.ops.export_scene.gltf.get_rna_type().properties["export_image_format"]
        have = [i.identifier for i in prop.enum_items]
        if not have:
            # 陷阱 2:枚举项为空,改用非法值试探
            original = prop.default
            try:
                prop.default = "__PROBE__"
            except TypeError as exc:
                m = re.search(r"not found in \(([^)]*)\)", str(exc))
                if m:
                    have = [s.strip().strip("'\"") for s in m.group(1).split(",")
                            if s.strip()]
            finally:
                prop.default = original
    except Exception as exc:  # noqa: BLE001
        print(f"  [警告] 读 glTF 图像格式枚举失败:{type(exc).__name__}: {exc}")

    if "WEBP" in have:
        return "WEBP"
    print(f"  [警告] 本机 glTF 导出器不支持 WEBP(枚举 {have}),退回 AUTO ——")
    print("         贴图将以 PNG 嵌入,GLB 体积会是 WebP 的数倍。"
          "这不是「还没优化」,是**这台机器做不到**。")
    return "AUTO"


def export_chunk(name: str, collections: tuple[str, ...]) -> dict | None:
    """
    导出分块。集合为空则返回 None(不产出空 GLB)。

    返回该块的统计信息,供 manifest 使用。
    """
    objs = objects_in(collections)
    if not objs:
        print(f"  [跳过] {name:<18} 集合 {collections} 里没有物体")
        return None

    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]

    kwargs = dict(C.Export.GLTF_KWARGS)

    # 顶点色模式的自适应回退,理由见模块 docstring
    if any(has_flex(o) for o in objs):
        kwargs["export_vertex_color"] = "NAME"
        kwargs["export_vertex_color_name"] = C.Export.FLEX_ATTR
    else:
        kwargs["export_vertex_color"] = "NONE"
        kwargs.pop("export_vertex_color_name", None)

    # 贴图编码。理由见模块 docstring —— 27.7 MB 的 PNG 从这里压掉。
    fmt = image_format()
    kwargs["export_image_format"] = fmt
    if fmt == "WEBP":
        kwargs["export_image_quality"] = C.Export.IMAGE_QUALITY

    path = OUT_DIR / f"{name}.glb"
    path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(filepath=str(path), use_selection=True, **kwargs)

    raw = path.read_bytes()
    tris = sum(triangle_count(o) for o in objs)
    info = {
        "name": f"{name}.glb",
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "tris": tris,
        "objects": len(objs),
        # ⚠️ objects 与 meshes **不是一回事**,`scene_characters` 尤其明显:
        #    那块里 16 个物体是 9 个网格 + 7 个骨架。先前只有 objects,
        #    于是拿它去和 GLB 里的网格节点数(9)对账,差 7 —— 那 7 个
        #    不是丢件,是骨架导出成的骨节层级节点。**这个差是设计,
        #    不是缺陷**;但没有 meshes 这一项时,报告侧无从分辨。
        "meshes": sum(1 for o in objs if o.type == "MESH"),
        # 该块物体实际引用到的材质名。**由导出侧独立数一遍**,
        # 用来和 GLB 里 materials[] 的条数对账 —— 两个数走的是不同的
        # 代码路径(一个是 Blender 的 material_slots,一个是导出器写进
        # JSON 的那一份),对得上才说明材质确实写进去了。
        "materials": len({s.material.name for o in objs for s in o.material_slots if s.material}),
        "collections": list(collections),
    }
    print(
        f"  [导出] {info['name']:<18} "
        f"{len(raw) / 1048576:6.2f} MB  {tris:>7} tris  {len(objs):>3} obj  "
        f"顶点色={kwargs['export_vertex_color']}  贴图={fmt}"
    )
    return info


def assert_preview_marks() -> frozenset[str]:
    """
    检查"仅供预览"的声明,返回**确实该被排除**的物体名。

    `config.Export.PREVIEW_ONLY` 里的集合名与物体上的 `qm_preview` 标记
    是**两条必须同时满足**的条件。这个函数负责把两条都验一遍:

      · 集合里出现了**不带标记**的网格物体 → 硬失败。
        它多半是真内容被手滑放进了预览集合;静默排除它,就是本项目
        栽过好几次的"汇总正常、明细少件"。
      · 预览集合之外出现了**带标记**的物体 → 硬失败。
        标记写了却不生效,是最坏的一种:写的人以为它不导出,
        而它导出了 —— 而且导出的是一根示意用的柱子。

    ⚠️ 只查标记、不查集合名是不行的(见 `PREVIEW_ONLY` 的注释):
       那样任何一次改名都会让真内容静默消失,而调用方看不出来。
    """
    decl = tuple(C.Export.PREVIEW_ONLY)
    if not decl:
        return frozenset()

    in_coll: set[str] = set()
    for coll in bpy.data.collections:
        if coll.name in decl:
            in_coll |= {o.name for o in coll.all_objects if o.type == "MESH"}
    marked = {o.name for o in bpy.data.objects
              if o.type == "MESH" and o.get("qm_preview")}

    unmarked = sorted(in_coll - marked)
    if unmarked:
        raise AssertionError(
            f"集合 {decl} 里有 {len(unmarked)} 个网格物体没打 `qm_preview` 标记:"
            f"{unmarked[:8]}。\n"
            f"  这些集合按 `config.Export.PREVIEW_ONLY` 是**不导出**的 ——"
            f" 而它们没声明自己是预览件。要么补 `TU.tag(..., preview=1)`,"
            f" 要么把它们挪出预览集合。**不会默认排除。**"
        )

    outside = sorted(marked - in_coll)
    if outside:
        raise AssertionError(
            f"有 {len(outside)} 个物体打了 `qm_preview` 标记,却不在预览集合 {decl} 里:"
            f"{outside[:8]}。\n"
            f"  标记写了却不生效 —— 它照样会被导出。"
        )
    return frozenset(marked)


def assert_full_coverage(chunks: dict[str, tuple[str, ...]]) -> None:
    """
    断言**每个网格物体都至少属于一个分块**。

    为什么必须有这一条:`objects_in()` 按集合名精确匹配,而集合名是
    字符串 —— 只要 builder 那边写的名字与分块表差一个字,那一整块就
    静默不导出。实际发生过的正是这个:`04_buildings` 建的是 `buildings`,
    分块表里写的却是 `建筑群`,于是 `scene_props.glb` 从未被产出,而
    构建依然报成功、验证 46 条全绿 —— 唯一的痕迹是日志里一行
    「[跳过] scene_props」,混在几百行导出日志里根本不会有人看见。

    这正是本项目反复栽的那个模式:**读数看着正常,病灶在仪器上**。
    所以这里不去检查"名字对不对"(那还是要人去比对字符串),而是检查
    **结果**:有没有物体掉在分块表之外。掉一个就失败,并把它是谁、
    该往哪儿加一并报出来。
    """
    preview = assert_preview_marks()

    named = [n for colls in chunks.values() for n in colls]
    covered = {o.name for o in objects_in(named)}
    orphans = [o for o in bpy.data.objects
               if o.type == "MESH" and o.name not in covered and o.name not in preview]
    if orphans:
        by_coll: dict[str, list[str]] = {}
        for o in orphans:
            key = "、".join(sorted(c.name for c in o.users_collection)) or "(不属于任何集合)"
            by_coll.setdefault(key, []).append(o.name)
        detail = "\n".join(
            f"    集合 {k!r} 下 {len(v)} 个物体:{v[:6]}"
            + (f" …… 另 {len(v) - 6} 个" if len(v) > 6 else "")
            for k, v in sorted(by_coll.items())
        )
        raise AssertionError(
            f"有 {len(orphans)} 个网格物体不在任何导出分块里 —— "
            f"它们不会被写进任何 GLB,而构建会假报成功:\n{detail}\n"
            f"  修法:把上面这些**集合名**加进 config.Export.CHUNKS 的对应块,"
            f"或改 builder 让它用的集合名与分块表逐字一致。"
            f"当前分块表列的是:{named}"
        )


def export_all(chunks: dict[str, tuple[str, ...]] | None = None) -> list[dict]:
    """按 config 的分块表逐块导出,返回各块统计。"""
    chunks = chunks or C.Export.CHUNKS
    # 先查覆盖率再导出:漏件时应当**在写文件之前**就炸,而不是产出一堆
    # 缺胳膊少腿的 GLB 之后才报错。
    assert_full_coverage(chunks)
    out: list[dict] = []
    for name, colls in chunks.items():
        info = export_chunk(name, colls)
        if info:
            out.append(info)
    return out


# --------------------------------------------------------------------------
# manifest
# --------------------------------------------------------------------------


def build_manifest(files: list[dict]) -> dict:
    """
    生成 manifest.json。

    ⚠️ 这个文件是**加载进度条的分母**,也是离线自检的依据,
       所以每一块的 bytes 必须是真实文件大小,不能估。
       没有 Content-Length 的服务器上,进度就只能靠它。
    """
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    tags = TU.collect_tags(bpy.data.objects)

    # 标签键带 qm_ 前缀(见 tag_utils.KNOWN_KEYS),统计时要按全名取。
    # 按 "kind" 取会得到一堆 "?" —— 那正是第一次跑出来的结果。
    by_kind: dict[str, int] = {}
    for t in tags:
        k = str(t.get("qm_kind", "?"))
        by_kind[k] = by_kind.get(k, 0) + 1

    # bpy.data.images 里混着 "Render Result" 这类内部图像,
    # 直接 len() 会把它们算成贴图,报出去的数是虚的。
    # ⚠️ 只能按**名字**排,不能按 source 排 —— 程序化烘焙出来的贴图
    #    source 也是 "GENERATED",按 source 排会把真贴图一起排掉。
    real_images = [i for i in bpy.data.images if i.name not in INTERNAL_IMAGES]

    armatures = [o for o in bpy.data.objects if o.type == "ARMATURE"]

    # ⚠️ 顶层分成 exported / scene 两组,**不是为了整齐,是为了消歧**。
    #
    #    改之前长这样:
    #        "totalTris": 172032,      ← 四个 GLB 之和(不含预览件)
    #        "objects":   234,         ← bpy.data.objects(含预览件)
    #        "meshes":    227,         ← 同上口径
    #    三个键并排放在一起,读的人默认它们是同一个分母。我差一点据此
    #    写下"manifest 自相矛盾:232 ≠ 234",把一个**两个口径**的问题
    #    报成了**一个缺陷**。实际两边都对:文件侧 232,
    #    场景侧 234,差的正是那 2 件按设计不导出的预览标位。
    #
    #    这与本项目反复栽的那个形状是同一个:数字本身没错,错的是
    #    我给它安的范围。所以修法不是改数,是**把分母写进键名**——
    #    下一个人不必先读完这个文件才知道 objects 数的是哪一边。
    #
    # 文件侧(exporter 真正写出去的东西)。与 totalBytes/totalTris 同分母。
    # 场景侧(导出那一刻 Blender 里有什么)。与 blender/out/stats.json 同源;
    # 想知道"预览件算不算进去",看这一组。
    return {
        "schema": 1,
        "seed": C.SEED,
        "unit": C.UNIT,
        "builtAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "blender": bpy.app.version_string,
        "files": files,
        "totalBytes": sum(f["bytes"] for f in files),
        "totalTris": sum(f["tris"] for f in files),
        "exported": {
            "objects": sum(f["objects"] for f in files),
            "meshes": sum(f["meshes"] for f in files),
            # ⚠️ 材质**不做跨块求和**。同一份 wood_old 会被四块各写一遍,
            #    加起来是 37,而场景里只有 31 种 —— 求和出来的数没有
            #    对应物,写在这里只会被误当成"材质总数"。各块的实际条数
            #    见 files[].materials。
            "note": "objects/meshes 为四块之和;materials 按块看 files[].materials,不可求和",
        },
        "scene": {
            "objects": len(bpy.data.objects),
            "meshes": len(meshes),
            "armatures": len(armatures),
            "materials": len(bpy.data.materials),
            "textures": len(real_images),
            "counts": {"byKind": by_kind, "objects": len(tags)},
        },
    }


def write_manifest(manifest: dict) -> Path:
    path = OUT_DIR / "manifest.json"
    path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    return path


# --------------------------------------------------------------------------
# 入口
# --------------------------------------------------------------------------


def run() -> dict:
    files = export_all()
    manifest = build_manifest(files)
    path = write_manifest(manifest)
    print(f"  [清单] {path.relative_to(PROJECT_DIR)}")
    return manifest


if __name__ == "__main__":
    # 单独跑本脚本时,需要先把场景建起来 —— 交给 run_all.py 或这里自行构建
    print("=" * 70)
    print("提示:本模块通常由 run_all.py 调用。单独运行时场景是空的,")
    print("      只会导出一个空的 manifest。")
    print("=" * 70)
    run()
