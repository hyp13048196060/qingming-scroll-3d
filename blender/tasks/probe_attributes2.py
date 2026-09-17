"""
探测第二轮:有材质、且材质不引用顶点色时,flex 还带得出来吗?

为什么必须补这一轮:
    第一轮(out/attr_probe.json)里 A/B/C 三种组合都成功导出了 COLOR_0,
    但那一轮的物体**没有材质**。而 `export_vertex_color` 的默认值
    MATERIAL 含义是「导出材质用到的颜色属性」;同时导出器还有一个
    `export_active_vertex_color_when_no_material`(默认 true)会在无材质时兜底。

    也就是说:第一轮的成功很可能是那个兜底开关撑住的,而不是
    export_attributes 的功劳。真实的布幌/柳枝将来**一定**带材质
    (旧木、麻布 albedo),并且材质**不**引用顶点色 —— 这时默认参数
    还导不导得出来,才是决定阶段 4 风动方案的那个问题。

本脚本把「有材质但不引用顶点色」这一真实条件补齐,再测一遍同样的组合。

用法:
    blender.exe --background --factory-startup --python blender/tasks/probe_attributes2.py
"""

from __future__ import annotations

import json
import struct
from pathlib import Path

import bpy

OUT_DIR = Path(__file__).resolve().parents[1] / "out"
OUT_DIR.mkdir(parents=True, exist_ok=True)


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.armatures, bpy.data.images):
        for item in list(coll):
            if item.users == 0:
                coll.remove(item)


def make_cloth_quad(name: str):
    """
    造一片带材质的布幌。

    材质是普通的 MeshStandardMaterial 等价物(Principled BSDF + 基色),
    **不接**顶点色输入 —— 这正是将来的真实情况:
    顶点色里的 flex 通道只当作风动权重给网页用,不该被乘进基色。
    """
    bpy.ops.mesh.primitive_plane_add(size=2.0)
    obj = bpy.context.active_object
    obj.name = name
    mesh = obj.data

    n = len(mesh.vertices)
    attr = mesh.color_attributes.new(name="flex", type="FLOAT_COLOR", domain="POINT")
    # 用"顶端权重"的语义填值:下半 0、上半 1
    for i, v in enumerate(mesh.vertices):
        w = 1.0 if v.co.y > 0 else 0.0
        attr.data[i].color = (w, w, w, 1.0)

    mat = bpy.data.materials.new(name="cloth_probe")
    mat.use_nodes = True
    bsdf = next(nd for nd in mat.node_tree.nodes if nd.type == "BSDF_PRINCIPLED")
    bsdf.inputs["Base Color"].default_value = (0.42, 0.31, 0.21, 1.0)
    bsdf.inputs["Roughness"].default_value = 0.9
    # 刻意不建 Color Attribute 节点 —— 材质完全不引用顶点色

    obj.data.materials.append(mat)
    return obj


def glb_primitive_attributes(path: Path) -> dict:
    raw = path.read_bytes()
    clen, ctype = struct.unpack_from("<I4s", raw, 12)
    if ctype != b"JSON":
        return {"error": f"首个块不是 JSON: {ctype!r}"}
    doc = json.loads(raw[20 : 20 + clen].decode("utf-8"))

    prims = []
    for m in doc.get("meshes", []):
        for pi, prim in enumerate(m.get("primitives", [])):
            prims.append(
                {
                    "mesh": m.get("name", "?"),
                    "prim": pi,
                    "attributes": sorted(prim.get("attributes", {}).keys()),
                    "material": prim.get("material"),
                }
            )
    return {
        "bytes": len(raw),
        "primitives": prims,
        "materials": [mm.get("name") for mm in doc.get("materials", [])],
    }


COMBOS = [
    (
        "A_mat_default_MATERIAL",
        "有材质、材质不引用顶点色 + 默认 export_vertex_color=MATERIAL",
        {"export_attributes": True},
    ),
    (
        "B_mat_NAME",
        "同样条件 + export_vertex_color=NAME 指定 flex",
        {
            "export_attributes": True,
            "export_vertex_color": "NAME",
            "export_vertex_color_name": "flex",
        },
    ),
    (
        "C_mat_ACTIVE",
        "同样条件 + export_vertex_color=ACTIVE",
        {"export_attributes": True, "export_vertex_color": "ACTIVE"},
    ),
    (
        "D_mat_NAME_allfalse",
        "B 再把 export_all_vertex_colors 关掉,确认它是否影响结果",
        {
            "export_attributes": True,
            "export_vertex_color": "NAME",
            "export_vertex_color_name": "flex",
            "export_all_vertex_colors": False,
        },
    ),
]

results = {"note": "由 blender/tasks/probe_attributes2.py 自动生成", "combos": []}
for cid, desc, kwargs in COMBOS:
    clear_scene()
    make_cloth_quad("cloth_" + cid)
    path = OUT_DIR / f"_attrprobe2_{cid}.glb"
    rec = {"id": cid, "desc": desc, "kwargs": kwargs}
    try:
        bpy.ops.export_scene.gltf(
            filepath=str(path),
            export_format="GLB",
            export_apply=True,
            export_extras=True,
            export_animations=False,
            export_skins=False,
            export_cameras=False,
            export_lights=False,
            **kwargs,
        )
        rec["glb"] = glb_primitive_attributes(path)
    except Exception as e:  # noqa: BLE001
        rec["error"] = f"{type(e).__name__}: {e}"
    results["combos"].append(rec)

(OUT_DIR / "attr_probe2.json").write_text(
    json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8"
)

print("=" * 72)
for r in results["combos"]:
    print(f"[{r['id']}] {r['desc']}")
    if "error" in r:
        print(f"    失败: {r['error']}")
        continue
    g = r["glb"]
    for p in g["primitives"]:
        has = "COLOR_0" in p["attributes"]
        mark = "✓ 保住了" if has else "✗ 丢了"
        print(f"    {mark}  attributes={p['attributes']}  material={p['material']}")
        print(f"             材质名={g['materials']}  文件 {g['bytes']} 字节")
print("=" * 72)
