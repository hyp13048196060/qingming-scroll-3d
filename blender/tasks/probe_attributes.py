"""
探测:自定义顶点属性要怎样才能真正落进 GLB。

背景(阶段 0 preflight 的实测发现):
    Blender 5.2 的 glTF 导出器**没有** `export_colors` 了,
    取而代之的是 `export_vertex_color`(枚举 MATERIAL/ACTIVE/NAME/NONE)
    与 `export_vertex_color_name`(字符串)。

    而 `export_vertex_color` 的默认值就是 `MATERIAL` —— 意思是
    「只导出材质真正用到的那个颜色属性」。原计划打算靠
    `export_attributes=True` 把名为 `flex` 的颜色属性带出去,
    在这个默认值下**会被静默丢掉**,而且不报错。
    阶段 4 的布幌/柳枝风动完全依赖这条链路,所以必须实测确认。

本脚本对四种参数组合各导一次,解析 GLB 的 primitive.attributes,
看到底哪一种能让 `flex` 出现在产物里。结果写进 out/attr_probe.json。

用法:
    blender.exe --background --factory-startup --python blender/tasks/probe_attributes.py
"""

from __future__ import annotations

import json
import struct
from pathlib import Path

import bpy

OUT_DIR = Path(__file__).resolve().parents[1] / "out"
OUT_DIR.mkdir(parents=True, exist_ok=True)


def clear_scene() -> None:
    """
    清空默认启动场景。

    --factory-startup 仍会载入默认场景(Cube / Camera / Light),
    preflight 那次导出里出现两个 Cube 就是这个原因 ——
    所有构建脚本都必须先调用本函数,否则产出里会混进默认立方体。
    """
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.armatures):
        for item in list(coll):
            if item.users == 0:
                coll.remove(item)


def make_plane(name: str, attr_kind: str):
    """造一个平面,带一份名为 flex 的顶点属性。attr_kind 决定属性类型。"""
    bpy.ops.mesh.primitive_plane_add(size=2.0)
    obj = bpy.context.active_object
    obj.name = name
    mesh = obj.data
    mesh.name = name + "_mesh"

    n = len(mesh.vertices)
    if attr_kind == "FLOAT_COLOR":
        attr = mesh.color_attributes.new(name="flex", type="FLOAT_COLOR", domain="POINT")
        for i in range(n):
            attr.data[i].color = (i / max(1, n - 1), 0.0, 0.0, 1.0)
    elif attr_kind == "FLOAT":
        attr = mesh.attributes.new(name="flex", type="FLOAT", domain="POINT")
        for i in range(n):
            attr.data[i].value = i / max(1, n - 1)
    else:
        raise ValueError(attr_kind)
    return obj


def glb_primitive_attributes(path: Path) -> dict:
    """从 GLB 里读出每个 primitive 的 attributes 键名。"""
    raw = path.read_bytes()
    if len(raw) < 20:
        return {"error": "文件过短"}
    clen, ctype = struct.unpack_from("<I4s", raw, 12)
    if ctype != b"JSON":
        return {"error": f"首个块不是 JSON 而是 {ctype!r}"}
    doc = json.loads(raw[20 : 20 + clen].decode("utf-8"))

    out: dict = {"bytes": len(raw)}
    prims = []
    for mi, m in enumerate(doc.get("meshes", [])):
        for pi, prim in enumerate(m.get("primitives", [])):
            prims.append(
                {
                    "mesh": m.get("name", f"#{mi}"),
                    "prim": pi,
                    "attributes": sorted(prim.get("attributes", {}).keys()),
                    "has_extras": "extras" in prim or "extras" in m,
                }
            )
    out["primitives"] = prims
    out["extensions_used"] = doc.get("extensionsUsed", [])
    out["extensions_required"] = doc.get("extensionsRequired", [])
    out["mesh_count"] = len(doc.get("meshes", []))
    return out


# 四种参数组合。区别只在颜色属性怎么带出去。
COMBOS = [
    {
        "id": "A_default_MATERIAL",
        "desc": "只开 export_attributes,颜色属性走默认 MATERIAL —— 预期 flex 被丢掉",
        "attr_kind": "FLOAT_COLOR",
        "kwargs": {"export_attributes": True},
    },
    {
        "id": "B_vertex_color_NAME",
        "desc": "export_vertex_color=NAME + 指定名字,靠颜色通道带出去",
        "attr_kind": "FLOAT_COLOR",
        "kwargs": {
            "export_attributes": True,
            "export_vertex_color": "NAME",
            "export_vertex_color_name": "flex",
        },
    },
    {
        "id": "C_vertex_color_ACTIVE",
        "desc": "export_vertex_color=ACTIVE,带出当前激活的颜色属性",
        "attr_kind": "FLOAT_COLOR",
        "kwargs": {"export_attributes": True, "export_vertex_color": "ACTIVE"},
    },
    {
        "id": "D_float_attribute",
        "desc": "不用颜色属性,改用 FLOAT 普通属性 + export_attributes",
        "attr_kind": "FLOAT",
        "kwargs": {"export_attributes": True},
    },
]

results = {"note": "由 blender/tasks/probe_attributes.py 自动生成", "combos": []}

for combo in COMBOS:
    clear_scene()
    make_plane("probe_" + combo["id"], combo["attr_kind"])

    path = OUT_DIR / f"_attrprobe_{combo['id']}.glb"
    record = {
        "id": combo["id"],
        "desc": combo["desc"],
        "attr_kind": combo["attr_kind"],
        "kwargs": combo["kwargs"],
    }
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
            **combo["kwargs"],
        )
        record["glb"] = glb_primitive_attributes(path)
    except Exception as e:  # noqa: BLE001
        record["error"] = f"{type(e).__name__}: {e}"
    results["combos"].append(record)


# 附带确认压缩扩展是否可用(内建 Draco / MeshOptimizer 桥接库)
clear_scene()
make_plane("probe_compression", "FLOAT_COLOR")
comp = {}
for cid, kwargs in [
    (
        "draco",
        {
            "export_draco_mesh_compression_enable": True,
            "export_draco_mesh_compression_level": 6,
        },
    ),
    (
        "meshopt",
        {
            "export_meshopt_compression_enable": True,
        },
    ),
]:
    path = OUT_DIR / f"_attrprobe_{cid}.glb"
    try:
        bpy.ops.export_scene.gltf(
            filepath=str(path),
            export_format="GLB",
            export_apply=True,
            export_animations=False,
            export_skins=False,
            export_cameras=False,
            export_lights=False,
            **kwargs,
        )
        comp[cid] = glb_primitive_attributes(path)
    except Exception as e:  # noqa: BLE001
        comp[cid] = {"error": f"{type(e).__name__}: {e}"}
results["compression"] = comp

(OUT_DIR / "attr_probe.json").write_text(
    json.dumps(results, indent=2, ensure_ascii=False), encoding="utf-8"
)

# --------------------------------------------------------------------------
print("=" * 70)
for r in results["combos"]:
    print(f"[{r['id']}] {r['desc']}")
    if "error" in r:
        print(f"    失败: {r['error']}")
        continue
    for p in r["glb"]["primitives"]:
        print(f"    → attributes = {p['attributes']}")
    print(f"    (扩展: {r['glb'].get('extensions_used') or '无'})")

print("-" * 70)
for cid, c in results["compression"].items():
    if "error" in c:
        print(f"[压缩 {cid}] 失败: {c['error']}")
    else:
        print(f"[压缩 {cid}] {c['bytes']} 字节  扩展={c.get('extensions_used') or '无'}"
              f"  required={c.get('extensions_required') or '无'}")
print("=" * 70)
