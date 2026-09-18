"""
反向测试:证明 validate_scale.py 真的会拦下形制错误。

为什么需要这个文件
------------------
一个"永远返回通过"的校验器和没有校验器是一样的,而且更糟 ——
它会给人一种已经验过了的错觉。所以必须证明它**会失败**。

做法:人为注入三类本项目真实遇到过的形制错误,断言校验器报出失败。
每一类都对应一条具体的红线:

    swap   拱骨截面的径向/横向弄反(0.50 ↔ 0.46)
           —— 这是本项目真的写错过一次的错。桥看上去毫无异样,
              但 clearance_actual() 与几何实际值差 2cm。
    pier   跨内水下塞一个桥墩 —— "其桥无柱"是《东京梦华录》原话。
    lash   抽掉一部分索绑 —— 无榫无钉全靠捆扎,少了就不是虹桥。

用法:
    blender.exe --background --factory-startup \
        --python blender/tasks/_negative_test.py -- swap|pier|lash

退出码:0 = 校验器**如期失败**(即校验器是好的);1 = 校验器漏过了(是坏的)。
"""

from __future__ import annotations

import sys
import traceback
from pathlib import Path

BLENDER_DIR = Path(__file__).resolve().parents[1]
if str(BLENDER_DIR) not in sys.path:
    sys.path.insert(0, str(BLENDER_DIR))

import bpy  # noqa: E402
from mathutils import Vector  # noqa: E402

from lib import bl_utils as BU  # noqa: E402
from lib import modules as MOD  # noqa: E402

MODE = (sys.argv[sys.argv.index("--") + 1] if "--" in sys.argv else "swap").strip()


def _build_bridge() -> dict:
    return MOD.load_build("01_bridge").build()


def _inject_swap() -> None:
    """
    把拱骨的径向/横向对调。

    不动 build/01_bridge.py 的源码 —— 在 01_bridge 模块已经载入后,
    替换 `add_arch_beam` 里的参数绑定。这样测试不依赖"记得改回去",
    也不会在下一次构建里留下痕迹。
    """
    import config as C

    mod = MOD.load_build("01_bridge")
    real = mod.add_arch_beam

    def swapped(builder, t0, t1, radius, y, *, radial, transverse):
        return real(builder, t0, t1, radius, y, radial=transverse, transverse=radial)

    mod.add_arch_beam = swapped
    mod.build()


def _inject_pier() -> None:
    """在跨内水面以下放一个实体 —— 一座桥墩。"""
    _build_bridge()
    coll = BU.get_collection("_negtest")
    b = BU.MeshBuilder("_negtest_桥墩")
    b.add_aabb(Vector((-0.8, -1.0, -2.0)), Vector((0.8, 1.0, -0.2)))
    obj = b.build(collection=coll)
    obj["qm_kind"] = "prop"  # 绕开"船/水/地形不参与桥墩判定"的豁免


def _inject_lash_loss() -> None:
    """抽掉第二系统的索绑 —— 模拟"只捆了一层"。"""
    import config as C

    mod = MOD.load_build("01_bridge")
    real_nodes = mod.node_angles_system2
    mod.node_angles_system2 = lambda: real_nodes()[:10]
    mod.build()


INJECT = {"swap": _inject_swap, "pier": _inject_pier, "lash": _inject_lash_loss}


def main() -> int:
    if MODE not in INJECT:
        print(f"未知模式 {MODE!r},可选 {sorted(INJECT)}")
        return 2

    print("=" * 70)
    print(f"反向测试:{MODE} —— 期待 validate_scale 报出失败")
    print("=" * 70)

    INJECT[MODE]()

    validator = MOD.load_task("validate_scale")
    try:
        validator.validate(stage=1, strict=True, write=False)
    except AssertionError as exc:
        print()
        print("✅ 校验器如期拦下:")
        print(str(exc)[:1200])
        return 0
    except Exception:
        print()
        print("❌ 校验器自己崩了(不是断言失败,是异常)——这不算数:")
        traceback.print_exc()
        return 1

    print()
    print("❌ 校验器**漏过了**这个形制错误 —— 它没起到门禁作用。")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
