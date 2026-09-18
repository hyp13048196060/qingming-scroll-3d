"""
按扫描线量一张渲染图的像素 —— 用来看"图上那条带子到底是什么"。

为什么需要它
------------
看预览图时,人眼能看出"这里有一条灰带",但**量不出它在世界的哪个位置**。
"左边缘那一块是背景色还是地面"这种问题,靠眯着眼睛比色是判不准的 ——
本项目已经因为"凭印象读数"误判过三次(校验器取样窗口、河道断面断言、
预览机位高度),每一次都表现为"看起来像几何错了,其实是量法错了"。

所以:一律量。本脚本把一条扫描线切成同色段,按正投影比例换回世界坐标,
打印每段的 x 区间与颜色。灰带落在哪个 x 区间,一眼就知道。

⚠️ **读 WORKBENCH 预览图时的两个已知陷阱**(都实测踩过):

1. **掠视角度下,同一种材质会显著变暗。**
   `setup_workbench` 开了 `cavity_type = "BOTH"`,其中的 screen-space
   分量按相邻像素的**深度差**压暗。掠视时相邻像素深度差很大,于是同
   一块水面板在俯视图里量到 #796a4f(色相 38.6°,正是汴河该有的土黄),
   在岸边平视的图里却近乎全黑。
   **这不是材质或调色板的问题。** 曾据此差点去改 `Palette.WATER_BASE`,
   而正确的做法是把平视机位的暗部当作预览伪像,以俯视图的量值为准。

2. **背景色必须显式传**(见 `--bg`)。

用法:
    blender.exe --background --factory-startup --python blender/tasks/probe_shot.py -- \
        screenshots/blender/site_v2_plan.png --scale 130 --row 0.5

    --scale  该机位的 ortho_scale(米)。透视机位不要用本脚本,它的换算
             只在正投影下成立 —— 这正是"量具要选对"的又一处。
    --row    采样行位置,0 = 顶边,1 = 底边,默认 0.5(正中)
    --tol    同色判定的容差(0..1,默认 0.02)
    --bg     该图渲染时的背景色,逗号分隔的 sRGB 分量,默认取 preview.py
             里 `setup_workbench` 用的那一个。
             ⚠️ 本脚本**不配置场景**,所以它读不到渲染时的真实背景色 ——
                早先这里读的是 `scene.display.shading.background_color`,
                而本脚本从 `--factory-startup` 起的场景里那是**黑色**,
                于是"是不是背景色"这条判断恒为假,一次也不会触发。
                一个永远不触发的检查比没有检查更坏:它会让人以为查过了。
                故改成显式传入,并在默认值上写明它对应哪个渲染设置。
"""

from __future__ import annotations

import sys
from pathlib import Path

import bpy
import numpy as np

PROJECT_DIR = Path(__file__).resolve().parents[2]


def srgb(x: np.ndarray) -> np.ndarray:
    """
    线性 → sRGB。

    Blender 把 PNG 读成**线性**浮点(`image.pixels`),直接打印会和
    你在看图软件里看到的差很多 —— 0.216 的线性值对应 #808080 的灰,
    而肉眼看图时脑子里比的是 #808080。不转换就会得出"这不是背景色"
    这种错误结论。转换公式是 sRGB 标准的那一条。
    """
    x = np.clip(x, 0.0, 1.0)
    return np.where(x <= 0.0031308, x * 12.92, 1.055 * x ** (1 / 2.4) - 0.055)


def main() -> None:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    if not argv:
        raise SystemExit("需要给一个图片路径,见文件头的用法")

    rel = argv[0]
    ortho_scale = 130.0
    row_t = 0.5
    tol = 0.02
    # 与 preview.setup_workbench() 的 background_color 一致
    bg_rgb = (0.62, 0.65, 0.68)
    for i, a in enumerate(argv):
        if a == "--scale":
            ortho_scale = float(argv[i + 1])
        elif a == "--row":
            row_t = float(argv[i + 1])
        elif a == "--tol":
            tol = float(argv[i + 1])
        elif a == "--bg":
            bg_rgb = tuple(float(v) for v in argv[i + 1].split(","))

    path = Path(rel)
    if not path.is_absolute():
        path = PROJECT_DIR / path
    img = bpy.data.images.load(str(path))
    w, h = img.size

    buf = np.empty(w * h * 4, dtype=np.float32)
    img.pixels.foreach_get(buf)
    # Blender 的行序是**自下而上**,图上的"上半"在数组的后半
    pix = buf.reshape(h, w, 4)[::-1]

    row_idx = min(h - 1, max(0, int(row_t * (h - 1))))
    line = srgb(pix[row_idx, :, :3])
    bg = np.array(bg_rgb)

    # ortho_scale 铺在**较长的那条边**上 —— 与 Blender 的定义一致
    if w >= h:
        m_per_px = ortho_scale / w
    else:
        m_per_px = ortho_scale / h
    x_of = lambda p: (p - (w - 1) / 2.0) * m_per_px  # noqa: E731

    print("=" * 74)
    print(f"图 {path.name}  {w}×{h}  采样行 {row_idx}  背景色 "
          f"#{''.join(f'{int(c * 255):02x}' for c in bg)}")
    print(f"换算 {m_per_px * 1000:.2f} mm/px → 该行 x ∈ "
          f"[{x_of(0):+.2f}, {x_of(w - 1):+.2f}] m")
    print("-" * 74)

    # 切成同色段
    start = 0
    runs: list[tuple[int, int, np.ndarray]] = []
    for p in range(1, w):
        if np.abs(line[p] - line[start]).max() > tol:
            runs.append((start, p - 1, line[(start + p - 1) // 2]))
            start = p
    runs.append((start, w - 1, line[(start + w - 1) // 2]))

    for a, b, c in runs:
        if b - a < 1:          # 一两个像素的杂边不报,免得刷屏
            continue
        hexs = "#" + "".join(f"{int(round(v * 255)):02x}" for v in c)
        is_bg = bool(np.abs(c - bg).max() <= tol * 2)
        tag = "  ← 背景色(这一带没有几何!)" if is_bg else ""
        print(f"  px {a:>5} … {b:>5}   x {x_of(a):>+8.2f} … {x_of(b):>+8.2f} m"
              f"   宽 {m_per_px * (b - a):>6.2f} m   {hexs}{tag}")
    print("=" * 74)


if __name__ == "__main__":
    main()
