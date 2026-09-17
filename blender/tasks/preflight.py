"""
阶段 0 能力探测 —— 写出 blender/out/caps.json。

为什么需要这个文件:
    Blender 的若干关键枚举是**动态枚举**,RNA 层只报一项甚至报空,
    直接 `for i in prop.enum_items` 会得到空列表,照着写代码就会踩空。
    本机实测到的三个陷阱都记在下面,探测结果写进 caps.json,
    后续所有构建脚本一律**读 caps.json**,不允许硬编码枚举值。

三个已实测的陷阱:
    1. scene.render.engine 是动态枚举(插件注册的引擎不在 RNA enum items 里)。
       RNA 只报 1 项,不可迭代;但**报错信息是可靠的**,它会列全部合法值。
    2. export_scene.gltf 的 export_format 枚举 enum_items 返回 []。
    3. 后台模式下 EEVEE 不保证拿得到 GPU 上下文,可能直接失败。

用法:
    blender.exe --background --factory-startup --python blender/tasks/preflight.py
"""

from __future__ import annotations

import json
import re
import struct
import sys
import time
from pathlib import Path

import bpy

OUT_DIR = Path(__file__).resolve().parents[1] / "out"
OUT_DIR.mkdir(parents=True, exist_ok=True)
CAPS_PATH = OUT_DIR / "caps.json"

# 探测过程的原始记录。每一项都是"实际跑出来的",不是抄文档来的。
caps: dict = {
    "probe": {
        "note": "本文件由 blender/tasks/preflight.py 自动生成,记录真实探测结果,请勿手改。",
        "argv": list(sys.argv),
    }
}


# --------------------------------------------------------------------------
# 工具
# --------------------------------------------------------------------------
def parse_enum_error(message: str) -> list[str] | None:
    """
    从 Blender 的枚举报错里把合法值抠出来。

    报错形如:
        enum "__PROBE__" not found in ('BLENDER_EEVEE', 'BLENDER_WORKBENCH', 'CYCLES')
    """
    m = re.search(r"not found in \(([^)]*)\)", message)
    if not m:
        return None
    return [s.strip().strip("'\"") for s in m.group(1).split(",") if s.strip()]


def probe_enum_by_invalid(obj, attr: str, invalid: str = "__PROBE__") -> dict:
    """
    用"故意写一个非法值"来问出合法值列表。

    这是应对动态枚举的通用手段:赋非法值会抛错,而错误信息里带着完整枚举。
    探测后会尽力还原原值,避免污染后续步骤。
    """
    try:
        original = getattr(obj, attr)
    except Exception as e:  # noqa: BLE001
        return {"error": f"读取 {attr} 失败: {type(e).__name__}: {e}"}

    result: dict = {"current": original}
    try:
        setattr(obj, attr, invalid)
        # 没抛错说明它把非法值当合法接受了,那这个属性不是枚举或不做校验
        setattr(obj, attr, original)
        result["probe"] = "未抛错(该属性可能不做枚举校验)"
        return result
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        result["error_type"] = type(e).__name__
        result["error_message"] = msg
        values = parse_enum_error(msg)
        if values:
            result["values"] = values
        try:
            setattr(obj, attr, original)
        except Exception:  # noqa: BLE001
            pass
    return result


def describe_op_properties(op) -> dict:
    """
    列出算子的全部属性。

    枚举项为空时如实记 enum_items_empty —— 这正是陷阱 2 的特征,
    后续脚本据此改走"逐个候选值试探"的路径,而不是以为没有可选值。
    """
    try:
        rna = op.get_rna_type()
    except Exception as e:  # noqa: BLE001
        return {"error": f"取 RNA 失败: {type(e).__name__}: {e}"}

    props: dict = {}
    for p in rna.properties:
        ident = p.identifier
        if ident in ("rna_type",):
            continue
        entry: dict = {"type": p.type}
        try:
            entry["default"] = _jsonable(p.default)
        except Exception:  # noqa: BLE001
            pass
        if p.type == "ENUM":
            items = [i.identifier for i in p.enum_items]
            entry["enum_items"] = items
            if not items:
                # 陷阱 2 的现场记录
                entry["enum_items_empty"] = True
        props[ident] = entry
    return props


def _jsonable(v):
    """把 Blender RNA 的默认值转成可 JSON 序列化的形式。"""
    if isinstance(v, (bool, int, float, str)) or v is None:
        return v
    if isinstance(v, (list, tuple)):
        return [_jsonable(x) for x in v]
    try:
        return list(v)
    except Exception:  # noqa: BLE001
        return repr(v)


# --------------------------------------------------------------------------
# 1. 版本与解释器
# --------------------------------------------------------------------------
caps["version"] = {
    "blender": bpy.app.version_string,
    "blender_version_tuple": list(bpy.app.version),
    "python": sys.version.split()[0],
    "pointer_size": struct.calcsize("P") * 8,
    "background": bpy.app.background,
    "factory_startup": "--factory-startup" in sys.argv,
}

try:
    import numpy as np

    caps["version"]["numpy"] = np.__version__
except Exception as e:  # noqa: BLE001
    caps["version"]["numpy"] = f"不可用: {e}"
    np = None  # type: ignore[assignment]


# --------------------------------------------------------------------------
# 2. 渲染引擎(陷阱 1:动态枚举,不可迭代)
# --------------------------------------------------------------------------
scene = bpy.context.scene
caps["render"] = {
    "engine": probe_enum_by_invalid(scene.render, "engine"),
}

# 逐个候选引擎实测:设置成功 + 真的渲一帧。
# 计划里说"后台模式 EEVEE 不保证拿到 GPU 上下文",所以这里必须真渲,不能只看赋值成功。
caps["render"]["engine_trials"] = {}
for eng in caps["render"]["engine"]["values"] or []:
    trial: dict = {"set_ok": False, "render_ok": False}
    try:
        scene.render.engine = eng
        trial["set_ok"] = True
    except Exception as e:  # noqa: BLE001
        trial["set_error"] = f"{type(e).__name__}: {e}"
        caps["render"]["engine_trials"][eng] = trial
        continue

    try:
        scene.render.resolution_x = 64
        scene.render.resolution_y = 64
        scene.render.resolution_percentage = 100
        scene.render.image_settings.file_format = "PNG"
        scene.render.filepath = str(OUT_DIR / f"_probe_{eng}.png")

        t0 = time.perf_counter()
        bpy.ops.render.render(write_still=True)
        trial["render_ok"] = True
        trial["seconds"] = round(time.perf_counter() - t0, 3)
        out = Path(scene.render.filepath)
        trial["bytes"] = out.stat().st_size if out.exists() else 0
    except Exception as e:  # noqa: BLE001
        trial["render_error"] = f"{type(e).__name__}: {e}"

    caps["render"]["engine_trials"][eng] = trial

# 还原到一个可用的引擎,后续步骤还要用
for eng, t in caps["render"]["engine_trials"].items():
    if t.get("render_ok"):
        scene.render.engine = eng
        caps["render"]["engine_chosen"] = eng
        break


# --------------------------------------------------------------------------
# 3. glTF 导出能力
# --------------------------------------------------------------------------
gltf: dict = {"available": False}
try:
    # 工厂启动下 io_scene_gltf2 通常默认启用;万一没有就显式开一次。
    if not hasattr(bpy.ops.export_scene, "gltf"):
        for mod in ("io_scene_gltf2", "bl_ext.blender_org.io_scene_gltf2"):
            try:
                bpy.ops.preferences.addon_enable(module=mod)
                break
            except Exception:  # noqa: BLE001
                continue
    gltf["available"] = hasattr(bpy.ops.export_scene, "gltf")
except Exception as e:  # noqa: BLE001
    gltf["enable_error"] = f"{type(e).__name__}: {e}"

if gltf["available"]:
    gltf["properties"] = describe_op_properties(bpy.ops.export_scene.gltf)

    # 陷阱 2 的应对:枚举项为空时,改用非法值试探问出合法值
    if gltf["properties"].get("export_format", {}).get("enum_items_empty"):
        gltf["export_format_probe"] = probe_enum_by_invalid(
            bpy.ops.export_scene.gltf.get_rna_type().properties["export_format"],
            "default",
        )

    # 本作品真正依赖的导出参数,逐个确认存在性
    needed = [
        "export_format", "export_apply", "export_yup", "export_extras",
        "export_attributes", "export_animations", "export_skins",
        "export_def_bones", "export_influence_nb", "export_image_format",
        "export_texture_dir", "export_cameras", "export_lights",
        "export_materials", "export_normals", "export_tangents",
        "export_texcoords", "export_colors", "export_all_influences",
    ]
    have = gltf["properties"]
    gltf["needed"] = {k: (k in have) for k in needed}
    gltf["missing"] = [k for k in needed if k not in have]


# --------------------------------------------------------------------------
# 4. 真实导出一遍(证明链路通,而不只是"参数存在")
# --------------------------------------------------------------------------
def glb_summary(path: Path) -> dict:
    """解析 GLB 头部与 JSON 块,确认产物是合法 glTF 二进制容器。"""
    raw = path.read_bytes()
    if len(raw) < 12:
        return {"error": "文件短于 12 字节,不是 GLB"}
    magic, version, length = struct.unpack_from("<4sII", raw, 0)
    info = {
        "magic": magic.decode("ascii", "replace"),
        "container_version": version,
        "declared_length": length,
        "actual_bytes": len(raw),
    }
    # 第一个块应当是 JSON
    if len(raw) >= 20:
        clen, ctype = struct.unpack_from("<I4s", raw, 12)
        info["first_chunk_type"] = ctype.decode("ascii", "replace").strip("\x00")
        info["first_chunk_bytes"] = clen
        try:
            doc = json.loads(raw[20 : 20 + clen].decode("utf-8"))
            info["asset"] = doc.get("asset", {})
            info["counts"] = {
                "meshes": len(doc.get("meshes", [])),
                "nodes": len(doc.get("nodes", [])),
                "materials": len(doc.get("materials", [])),
                "images": len(doc.get("images", [])),
                "skins": len(doc.get("skins", [])),
                "animations": len(doc.get("animations", [])),
            }
            # 我们靠 extras 把 qm_* 标签传给网页,这里顺带确认它真的落地了
            extras_found = []
            for n in doc.get("nodes", []):
                if "extras" in n:
                    extras_found.append(n["extras"])
            info["extras_nodes"] = len(extras_found)
            info["extras_sample"] = extras_found[:3]
        except Exception as e:  # noqa: BLE001
            info["json_parse_error"] = f"{type(e).__name__}: {e}"
    return info


export_test: dict = {}
if gltf["available"]:
    try:
        # 造一个带自定义属性 + 顶点色属性的立方体,
        # 一次把 export_extras / export_attributes 两条链路都验掉。
        bpy.ops.mesh.primitive_cube_add(size=2.0)
        cube = bpy.context.active_object
        cube.name = "preflight_cube"
        cube["qm_id"] = "preflight"
        cube["qm_kind"] = "test"

        mesh = cube.data
        attr = mesh.color_attributes.new(name="flex", type="FLOAT_COLOR", domain="POINT")
        for i in range(len(mesh.vertices)):
            attr.data[i].color = (i / max(1, len(mesh.vertices) - 1), 0.0, 0.0, 1.0)

        probe_path = OUT_DIR / "_preflight_probe.glb"
        export_test["filepath"] = str(probe_path)

        kwargs = {
            "filepath": str(probe_path),
            "export_format": "GLB",
            "export_apply": True,
            "export_yup": True,
            "export_extras": True,
            "export_attributes": True,
            "export_animations": False,
            "export_skins": True,
            "export_cameras": False,
            "export_lights": False,
        }
        # 只传 RNA 里确实存在的参数,避免因版本差异整个调用失败
        kwargs = {k: v for k, v in kwargs.items() if k == "filepath" or k in have}

        t0 = time.perf_counter()
        result = bpy.ops.export_scene.gltf(**kwargs)
        export_test["seconds"] = round(time.perf_counter() - t0, 3)
        export_test["result"] = list(result)
        export_test["kwargs_used"] = {k: _jsonable(v) for k, v in kwargs.items()}

        if probe_path.exists():
            export_test["glb"] = glb_summary(probe_path)
        else:
            export_test["error"] = "算子返回成功但没有生成文件"
    except Exception as e:  # noqa: BLE001
        export_test["error"] = f"{type(e).__name__}: {e}"

gltf["export_test"] = export_test
caps["gltf"] = gltf


# --------------------------------------------------------------------------
# 5. 程序化贴图能力(尺寸上限、色彩空间、行序)
# --------------------------------------------------------------------------
tex: dict = {}
if np is not None:
    try:
        # 色彩空间选项同样是动态的,用同样的"非法值试探"问出来
        probe_img = bpy.data.images.new("_probe_cs", 4, 4)
        tex["colorspace"] = probe_enum_by_invalid(
            probe_img.colorspace_settings, "name"
        )
        bpy.data.images.remove(probe_img)
    except Exception as e:  # noqa: BLE001
        tex["colorspace"] = {"error": f"{type(e).__name__}: {e}"}

    try:
        # 真实写一张 256²,确认 images.new + pixels.foreach_set 这条路径可用。
        # 尺寸上限的依据:pixels 的 float32 中间数组占 W*H*4*4 字节,
        # 4096² 单张就是 256MB —— 所以默认只用 1024²,最大 2048²。
        n = 256
        img = bpy.data.images.new("_probe_tex", n, n, alpha=False)
        buf = np.zeros((n, n, 4), dtype=np.float32)
        buf[..., 0] = np.linspace(0, 1, n, dtype=np.float32)[None, :]
        buf[..., 3] = 1.0
        t0 = time.perf_counter()
        img.pixels.foreach_set(buf.ravel())
        tex["write_seconds_256"] = round(time.perf_counter() - t0, 4)
        tex["size"] = list(img.size)
        tex["channels"] = img.channels
        tex["has_float_buffer"] = bool(img.is_float)

        # 文件格式枚举:要用 WebP 就得先确认它真的在列表里
        fmt = probe_enum_by_invalid(img, "file_format")
        tex["file_format"] = fmt
        tex["webp_supported"] = bool(fmt.get("values") and "WEBP" in fmt["values"])

        # 存一次 WebP,确认不是"枚举里有但写不出来"
        webp_path = OUT_DIR / "_probe_tex.webp"
        try:
            img.filepath_raw = str(webp_path)
            img.file_format = "WEBP"
            img.save()
            tex["webp_bytes"] = webp_path.stat().st_size if webp_path.exists() else 0
            tex["webp_roundtrip_ok"] = webp_path.exists()
        except Exception as e:  # noqa: BLE001
            tex["webp_error"] = f"{type(e).__name__}: {e}"

        bpy.data.images.remove(img)
    except Exception as e:  # noqa: BLE001
        tex["error"] = f"{type(e).__name__}: {e}"

caps["texture"] = tex
caps["render"]["image_file_format"] = probe_enum_by_invalid(
    scene.render.image_settings, "file_format"
)


# --------------------------------------------------------------------------
# 落盘
# --------------------------------------------------------------------------
CAPS_PATH.write_text(json.dumps(caps, indent=2, ensure_ascii=False), encoding="utf-8")

print("=" * 68)
print(f"preflight 完成 → {CAPS_PATH}")
print(f"  Blender        : {caps['version']['blender']} / Python {caps['version']['python']}")
print(f"  numpy          : {caps['version'].get('numpy')}")
eng = caps["render"]["engine"]
print(f"  引擎枚举       : {eng.get('values')}  (当前 {eng.get('current')})")
for name, t in caps["render"]["engine_trials"].items():
    ok = "可渲" if t.get("render_ok") else "不可渲"
    print(f"    - {name:<20} 赋值{'成功' if t.get('set_ok') else '失败'} / {ok}"
          f" {t.get('seconds', '')}{'s' if 'seconds' in t else ''}")
print(f"  glTF 可用      : {caps['gltf']['available']}")
if caps["gltf"]["available"]:
    print(f"  缺失的参数     : {caps['gltf'].get('missing')}")
    et = caps["gltf"]["export_test"]
    if "glb" in et:
        g = et["glb"]
        print(f"  导出实测       : {g['actual_bytes']} 字节, {g['counts']},"
              f" 带 extras 的节点 {g['extras_nodes']} 个")
    else:
        print(f"  导出实测失败   : {et.get('error')}")
print(f"  贴图 written   : {caps['texture'].get('write_seconds_256')}s (256²)"
      f"  WebP={caps['texture'].get('webp_supported')}"
      f"  roundtrip={caps['texture'].get('webp_roundtrip_ok')}")
print("=" * 68)
