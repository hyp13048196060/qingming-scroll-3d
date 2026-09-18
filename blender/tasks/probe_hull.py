"""
临时探针:船壳的局部包围盒 vs 世界位置。

要回答的问题只有一个 —— `_sample_deck()` 里那句
「在甲板的世界包围盒中部撒点」到底成不成立。
`Object.bound_box` 按文档是**局部坐标**,如果 `03_boats` 又给船壳加了
平移和旋转,那么拿局部盒子当世界盒子用,撒出来的点会全部挤在世界原点
附近 —— 而世界原点正是虹桥所在。

这是一个可以在几秒内被测量判掉的问题,不该靠读文档定案。

⚠️ **留着它,别删。** 它抓到的那个坑(拿局部包围盒当世界坐标用,采样点
   全落在世界原点)不会自己消失:`bound_box` 与 `matrix_world` 这两个
   接口以后还会有人顺手拿来用。改 `03_boats` 的船位或 `_sample_deck` 的
   采样范围之后,跑一遍它,比读一遍代码可靠。
"""

from __future__ import annotations

import sys
from pathlib import Path

import bpy
from mathutils import Vector

BLENDER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BLENDER_DIR))

from lib import modules as MOD   # noqa: E402


def main() -> None:
    # ⚠️ `load_build()` 只**定义**函数,不建东西 —— 上游是 `__main__` 的
    #    `--alone` 分支里去跑的。第一版探针只 `load_build("02_river")`,
    #    于是量到「可站人的船壳 0 条」—— 读数一本正经,量的却是空场景。
    #    下面这份清单是从 `08_assembly` 的 `__main__` 逐字抄来的。
    from lib import bl_utils as _BU

    _BU.reset_clear_flag()
    for _m in ("00_layout", "01_bridge", "02_river", "03_boats"):
        MOD.load_build(_m).build()

    hulls = [o for o in bpy.data.objects
             if o.type == "MESH" and o.get("qm_part") == "hull"
             and not o.get("qm_beached")]
    print(f"可站人的船壳 {len(hulls)} 条")
    # ⚠️ 必须显式刷一次。第二版探针直接读 `h.matrix_world`,而它**是上一轮
    #    求值留下的缓存**:`03_boats` 只写了 `h.location`,`matrix_world`
    #    还没跟着变,于是量出来的世界盒中心跟局部盒中心一模一样 ——
    #    五条船位置差着七十米,却报出同一个数,这本身就该触发怀疑。
    bpy.context.view_layer.update()

    print(f"{'船壳':<20} {'location':<26} {'yaw°':>6} "
          f"{'局部盒中心(x,y)':<20} {'世界盒中心(x,y)':<20}")
    for h in hulls:
        bb = [Vector(c) for c in h.bound_box]
        lx = (min(c.x for c in bb) + max(c.x for c in bb)) * 0.5
        ly = (min(c.y for c in bb) + max(c.y for c in bb)) * 0.5
        wb = [h.matrix_world @ Vector(c) for c in h.bound_box]
        wx = (min(c.x for c in wb) + max(c.x for c in wb)) * 0.5
        wy = (min(c.y for c in wb) + max(c.y for c in wb)) * 0.5
        loc = tuple(round(v, 2) for v in h.location)
        print(f"{h.name:<20} {str(loc):<26} "
              f"{h.rotation_euler.z * 57.2958:6.1f} "
              f"({lx:+.2f}, {ly:+.2f})".ljust(20)
              + f"        ({wx:+.2f}, {wy:+.2f})   长 lx={max(c.x for c in bb) - min(c.x for c in bb):.2f}"
              f" ly={max(c.y for c in bb) - min(c.y for c in bb):.2f}")

    print()
    print("判据:世界盒中心应当**等于** location 的 (x,y);局部盒中心则与")
    print("      位置无关(它在物体自己的坐标系里)。两列一致 = 变换没起作用。")


if __name__ == "__main__":
    main()
