"""
问渲染图一句是非题:**这个像素上是什么东西?**

用法:
    blender.exe --background --factory-startup --python blender/tasks/probe_pixel.py \
        -- boat boat_v6 boat_quarter 700 450
    #   ↑viewset ↑前缀   ↑机位名      ↑列  ↑行(可写多组)

    viewset ∈ {bridge, site, boat};机位名取 `preview.py` 里对应那组的 name。

为什么需要它
------------
`boat_v5_boat_side.png` 里,船背后横着一条三米多高的深棕色竖壁,横贯
整幅画面。按顶点分档量场地,**那一段 y 里没有任何东西高过 0.62m** ——
量出来和看到的直接矛盾。

矛盾的来源值得记下来:**顶点分档只看得见"顶点落在取样窗口里"的物体**。
一个只在 y = ±120 两处有断面、中间靠一个大四边形跨过去的放样长条,
顶点全在窗口外,渲染上却铺满整幅画面。换成按物体分组、按面片相交去量,
也都各有各的漏法。

而射线**结构上不会漏**:它命中什么就报什么,不依赖顶点分布、不依赖
包围盒、不依赖面片划分。所以"这个像素上是什么"这类问题,一律用它,
不要再用统计或目视去猜。

顺带它也是唯一能把"刻度核对"里那句"色变在某某行"接下去的工具:
色变告诉你**有一条边**,射线告诉你**那条边是谁**。
"""

from __future__ import annotations

import sys
from pathlib import Path

import bpy
from mathutils import Vector

BLENDER_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BLENDER_DIR))
sys.path.insert(0, str(BLENDER_DIR / "tasks"))

import preview as PV  # noqa: E402  (需先插好 sys.path)


VIEWSETS = {
    "bridge": "standard_views",
    "site": "site_views",
    "boat": "boat_views",
    "buildings": "buildings_views",
}


def screen_to_ray(view: dict, col: float, row: float) -> tuple[Vector, Vector]:
    """
    把机位自己那幅图上的 (列, 行) 换成一条世界射线。

    全程用**该机位自己声明的** loc / target / ortho_scale,一个数都不另写 ——
    这正是本项目反复栽跟头的地方:量具里写死一个会漂的数。
    换算方式与 `preview._ref_rows` 同源:正投影的 ortho_scale 管的是
    画面**较长的那一边**,所以每像素多少米 = ortho_scale / max(w, h)。
    """
    loc = Vector(view["loc"])
    target = Vector(view["target"])
    rot = (target - loc).to_track_quat("-Z", "Y").to_matrix()
    right, up = rot.col[0], rot.col[1]

    w, h = PV.PREVIEW_RES
    if view.get("ortho"):
        m_per_px = float(view.get("ortho_scale", 32.0)) / max(w, h)
        # 画面中心 = loc;右上为正
        origin = loc + right * ((col - w / 2.0) * m_per_px) + up * ((h / 2.0 - row) * m_per_px)
        return origin, (target - loc).normalized()

    # 透视:按传感器与镜头折算,不写死 FOV
    lens = float(view.get("lens", 50.0))
    sensor = 36.0                                   # Blender 默认 sensor_width
    half_h = sensor / 2.0 / lens
    half_w = half_h * (w / h)
    forward = (target - loc).normalized()
    d = forward + right * ((col - w / 2.0) / (w / 2.0) * half_w) + up * (
        (h / 2.0 - row) / (h / 2.0) * half_h
    )
    return loc, d.normalized()


def main() -> None:
    argv = sys.argv
    if "--" not in argv or len(argv) - argv.index("--") < 5:
        print(__doc__)
        raise SystemExit(2)
    rest = argv[argv.index("--") + 1 :]
    viewset, prefix, view_name = rest[0], rest[1], rest[2]
    coords = [int(x) for x in rest[3:]]
    if len(coords) % 2:
        raise SystemExit("列/行必须成对给出")

    # ⚠️ 先建场景,**再**取机位 —— 顺序不能反。
    #    船组、场地组的机位都是从**实测几何**反推的(这是刻意的:
    #    写死的坐标已经埋过一次相机)。场景没建起来就去取,
    #    量到的不是"机位错了",而是"量具在原地空转",报出来的
    #    还是"找不到 boat_cao_hero 的构件"这类**看着像模型问题**的错。
    #    与出图时同一份 builder 清单、同一份顺序。
    PV._run_stage2()

    fn = getattr(PV, VIEWSETS[viewset], None)
    if fn is None:
        raise SystemExit(f"未知 viewset {viewset!r},可选 {sorted(VIEWSETS)}")
    views = {v["name"]: v for v in fn()}
    if view_name not in views:
        raise SystemExit(f"{viewset} 里没有机位 {view_name!r},可选 {sorted(views)}")
    view = views[view_name]

    print("=" * 74)
    print(f"{prefix}_{view_name}  {view['label']}")
    print("=" * 74)
    # 机位声明的参考标高先打一遍:射线用的屏幕→世界换算和它们同源,
    # 对得上才说明打的是**渲染那张图的**坐标系,不是另一套。
    for text, _row in PV._ref_rows(view):
        print(f"  {text}")

    dg = bpy.context.evaluated_depsgraph_get()
    scene = bpy.context.scene

    print("-" * 74)
    for i in range(0, len(coords), 2):
        col, row = coords[i], coords[i + 1]
        origin, direction = screen_to_ray(view, col, row)
        hit, loc, _n, _idx, obj, _m = scene.ray_cast(dg, origin, direction)
        where = f"({origin.x:>8.2f}, {origin.y:>8.2f}, {origin.z:>6.2f})"
        if hit:
            print(
                f"  ({col:>4},{row:>4}) 起点{where} → 命中 "
                f"x={loc.x:>8.2f}  {obj.name:<26} {obj.get('qm_id', '')}"
            )
        else:
            print(f"  ({col:>4},{row:>4}) 起点{where} → 未命中(背景)")


if __name__ == "__main__":
    main()
