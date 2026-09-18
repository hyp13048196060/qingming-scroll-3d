#!/usr/bin/env python3
"""量顶栏文字的 WCAG 对比度,低于门槛就判失败。

为什么要有这个工具
──────────────────
顶栏是"文字压在**变化的**背景上"—— 背景是天空,而天空的颜色随时间、
画质、机位全在变。这种地方的对比度**没法靠看一眼判断**:同一行字在暮色图
里清清楚楚,换到正午那张就糊了,而人眼是先看见"能看清的那张"。

实测过一次,结果很难看(2026-09-18):
    标题   清明上河图        #e6dcc3  压在白天档的天上   3.70:1
    副标题 三维长卷·汴河虹桥  #c9bda0                    1.96:1
正文的 AA 门槛是 4.5:1。两条都不够,副标题差了不止一倍。

量具本身踩过的坑(记在这儿免得再犯)
──────────────────────────────────
第一版取"框内最暗像素当前景、最亮像素当背景"。天亮的时候量出
7.48:1 / 4.26:1,看着一片大好 —— 可这行字是**浅色**的,#e6dcc3 比底还亮,
所以框内最暗的那个像素根本不是字,是遮罩与天的接缝。判据方向反了,
量具在夸自己。现在的前景取样式表里声明的色值(标准做法),并且**回查**
框内确有该色像素被画出来,把 AA 覆盖不足的损耗一并报出来。

口径
────
· 前景 = DOM 里 `getComputedStyle().color` 的声明值。这是 WCAG 与各家
  devtools 的通行口径 —— 对比度定义在"字色 vs 底色"上,不是逐像素极值。
· 底色 = 文字框内像素的**中位数**。字只占框内少数像素(还有 letter-spacing
  留出的空隙),中位数就是底。
· 另报"画出来最接近声明色的那个像素"及其差值:11px 的字笔画只有 1px,
  抗锯齿可能让笔画中心都到不了满覆盖,那时**实际**对比度比声明值更低。
  这个量不参与判定,但会打出来 —— 差值大说明"声明达标而实际没达到"。

⚠️ 只吃 PNG。WebP 是有损的,重编码能把边缘像素抹平,量出来的是编码器的
   误差而不是 UI 的颜色。所以本工具在 tools/capture_showcase.mjs 的流程里
   排在 to_webp.py **之前**。

用法:
    python tools/check_contrast.py screenshots/showcase
"""
import json
import statistics
import sys
from pathlib import Path

# Windows 控制台默认不是 UTF-8,本文件里有中文和 ✓/✗,不设会直接抛
# UnicodeEncodeError —— 那是个"工具崩了"而不是"检查没过"的失败,更难查。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

try:
    from PIL import Image
except ImportError:
    print("需要 Pillow:pip install pillow", file=sys.stderr)
    sys.exit(2)


def pixels_of(im):
    """取全部像素。

    Pillow 14 把 `getdata()` 标成弃用并改名 `get_flattened_data()`,
    两边都兼容一下 —— 这个仓库的 Python 依赖不在 package.json 里,
    别人机器上是哪个版本说不准。
    """
    if hasattr(im, "get_flattened_data"):
        return list(im.get_flattened_data())
    return list(im.getdata())

# WCAG 2.1:正文 4.5:1;大号字(≥24px,或 ≥18.66px 且粗体 ≥700)3:1。
AA_NORMAL = 4.5
AA_LARGE = 3.0


def srgb_to_lin(c: float) -> float:
    c /= 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def luminance(rgb) -> float:
    r, g, b = (srgb_to_lin(v) for v in rgb[:3])
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(fg, bg) -> float:
    a, b = luminance(fg), luminance(bg)
    hi, lo = max(a, b), min(a, b)
    return (hi + 0.05) / (lo + 0.05)


def parse_css_color(s: str):
    """`rgb(230, 220, 195)` / `rgba(...)` -> (r, g, b)。"""
    inner = s[s.index("(") + 1 : s.index(")")]
    parts = [p.strip() for p in inner.split(",")]
    if len(parts) < 3:
        raise ValueError(f"认不出的颜色写法: {s}")
    return tuple(int(round(float(p))) for p in parts[:3])


def threshold_for(probe) -> float:
    """这条文字按 WCAG 算大号还是正文。"""
    size = probe.get("fontSize", 12)
    try:
        weight = int(str(probe.get("fontWeight", "400")).strip())
    except ValueError:
        weight = 700 if str(probe.get("fontWeight")).lower() == "bold" else 400
    if size >= 24 or (size >= 18.66 and weight >= 700):
        return AA_LARGE
    return AA_NORMAL


def measure(png: Path, probe):
    """返回 (对比度, 底色, 声明色, 画出来的最亮/最暗代表像素, 差值)。"""
    declared = parse_css_color(probe["color"])
    im = Image.open(png).convert("RGB")

    x0, y0 = probe["x"], probe["y"]
    x1, y1 = x0 + probe["w"], y0 + probe["h"]
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(im.width, x1), min(im.height, y1)
    if x1 - x0 < 2 or y1 - y0 < 2:
        return None

    px = pixels_of(im.crop((x0, y0, x1, y1)))
    if not px:
        return None

    bg = tuple(int(statistics.median([p[i] for p in px])) for i in range(3))

    # 画得最像声明色的那个像素 —— 用来暴露抗锯齿造成的实际覆盖不足。
    painted = min(px, key=lambda p: sum((p[i] - declared[i]) ** 2 for i in range(3)))
    delta = max(abs(painted[i] - declared[i]) for i in range(3))

    return contrast(declared, bg), bg, declared, painted, delta


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__.strip().split("用法:")[-1].strip(), file=sys.stderr)
        return 2

    out_dir = Path(sys.argv[1])
    manifest_path = out_dir / "manifest.json"
    if not manifest_path.exists():
        print(f"❌ 找不到 {manifest_path} —— 先跑 tools/capture_showcase.mjs", file=sys.stderr)
        return 2

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    shots = manifest.get("shots", [])

    # 每张图都要各量一次。**取最差的那张**作为结论,不取平均 ——
    # 白天档糊、暮色档清楚,平均下来会得到一个"还行"的假数。
    worst = {}      # label -> (ratio, shot_file, threshold, ...)
    rows = []
    skipped = 0
    missing_png = []

    for shot in shots:
        probe_all = shot.get("textProbe")
        if not probe_all:
            skipped += 1
            continue
        png = out_dir / Path(shot["file"]).with_suffix(".png")
        if not png.exists():
            missing_png.append(str(png))
            continue
        for key in ("title", "sub"):
            probe = probe_all.get(key)
            if not probe:
                continue
            got = measure(png, probe)
            if got is None:
                continue
            ratio, bg, declared, painted, delta = got
            label = probe["sel"]
            # ⚠️ 报**真正量过的那张**的文件名(png),不报 manifest 里记的
            #    file 字段 —— 那个是仓库里实际发布的 .webp 名。两者后缀不同,
            #    照 manifest 打会印出 "03-chasi.webp 6.02:1",读的人去找
            #    webp 核对,而 webp 根本没参与测量(它是有损的,故意不量)。
            rows.append((label, png.name, ratio, bg, declared, painted, delta,
                         threshold_for(probe), probe.get("fontSize")))
            if label not in worst or ratio < worst[label][0]:
                worst[label] = (ratio, png.name, threshold_for(probe),
                                bg, declared, painted, delta, probe.get("fontSize"))

    if missing_png:
        print("❌ 缺 PNG(对比度不能用有损的 webp 量):", file=sys.stderr)
        for m in missing_png[:5]:
            print(f"   · {m}", file=sys.stderr)
        return 2

    if not worst:
        print("⚠️ 没有可量的顶栏文字(全被 display:none 隐藏?)—— 本次不判定")
        return 0

    print(f"{'元素':<20}{'最差那张':<16}{'字号':>6}{'对比度':>9}{'门槛':>7}  底色 / 声明色")
    print("─" * 88)
    failures = []
    for label, (ratio, shot, thr, bg, declared, painted, delta, size) in sorted(worst.items()):
        ok = ratio >= thr
        if not ok:
            failures.append((label, ratio, thr, shot))
        print(
            f"{label:<20}{shot:<16}{size:>5.0f}px{ratio:>8.2f}:1{thr:>6.1f}:1"
            f"  rgb{bg} / rgb{declared}  {'✓' if ok else '✗'}"
        )
        # 声明色与"画出来的"差得多 -> 抗锯齿覆盖不足,实际观感比这个数更差
        if delta > 12:
            print(
                f"{'':<20}└ 笔画最满的像素是 rgb{painted}(与声明色差 {delta}) —— "
                f"字太细,抗锯齿没能画满,实际观感比上面这个数再低一档"
            )

    if skipped:
        print(f"\n({skipped} 张图没有 textProbe —— 多半是移动端把副标题 display:none 了)")

    print("─" * 88)
    if failures:
        print(f"❌ {len(failures)} 处顶栏文字低于 WCAG AA:")
        for label, ratio, thr, shot in failures:
            print(f"   · {label}  最差 {ratio:.2f}:1 (门槛 {thr:.1f}:1) @ {shot}")
        print("   注意:这两个都是**浅色**字,靠「把字调亮」是到不了 4.5:1 的 ——")
        print("   背景亮度得压到 L≤0.075。要改就改 .qm-topbar 的遮罩透明度,")
        print("   光改字色没用。")
        return 1
    print("✅ 顶栏文字全部达到 WCAG AA")
    return 0


if __name__ == "__main__":
    sys.exit(main())
