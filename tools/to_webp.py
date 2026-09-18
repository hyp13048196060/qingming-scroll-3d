#!/usr/bin/env python3
"""把展示图转成 WebP,并在**确认产物可用之后**才删掉 PNG。

用法:
    python tools/to_webp.py screenshots/showcase            # 转换目录下所有 .png
    python tools/to_webp.py screenshots/showcase --quality 90
    python tools/to_webp.py screenshots/showcase --keep-png # 只转不删

为什么不给**全部**截图都转 WebP —— 这是个刻意的分野,不是偷懒:

  · 展示图(screenshots/showcase/)给人看。它是"这幅画长什么样"的传达,
    有损压缩的代价没人看得出来,而 17 张 PNG 有 19.3 MB,转完 1.6 MB。
  · 证据图(screenshots/perf/、screenshots/web/ 里被探针引用的那些)
    是拿来做 A/B 的 —— 要比的差可能只有几个像素值,有损重编码会把
    那个差抹掉或者造出一个假的。`tools/curate_screenshots.py` 因此
    **原样保留**被引用的 PNG。同一个理由,两个方向。

所以:凡是要逐像素比对的,一律不转;凡是给人看的,一律转。

⚠️ 先验证再删源。编码器写出一个 0 字节、或者一张纯黑/纯白的图,
   都不会报错;若先删了 PNG,那张图就**永久没了**(仓库里只有这一份)。
   所以顺序是:编码 → 重新打开产物 → 查尺寸对不对、查像素标准差 > 0
   → 全过了才 unlink 源文件。任何一步不过,源文件原样留着并报错退出。
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

try:
    from PIL import Image, ImageStat
except ImportError:  # pragma: no cover
    sys.stderr.write(
        "需要 Pillow。安装:python -m pip install Pillow\n"
        "它是本仓库资产工具链的依赖,运行时(网页本身)不需要。\n"
    )
    raise SystemExit(2)

# 转出来的图必须至少压掉这么多,否则说明参数不对(比如误用了无损模式),
# 那还不如留着 PNG。见下面 verify() 的第 3 条。
MIN_SAVING = 0.5


def verify(src: Path, dst: Path) -> tuple[bool, str]:
    """产物能用吗。任何一条不过就返回 (False, 原因)。"""
    if not dst.exists():
        return False, "没有生成文件"
    if dst.stat().st_size == 0:
        return False, "产物是 0 字节"

    with Image.open(src) as a, Image.open(dst) as b:
        if a.size != b.size:
            return False, f"尺寸变了 {a.size} -> {b.size}"
        # 纯色图(全黑/全白/全透明)大多是编码或读取出了问题,
        # 而它在文件列表里看起来和正常图一模一样。查标准差能把它挑出来。
        # 注意要转 RGB 再统计:webp 带 alpha 时 ImageStat 会按 RGBA 出四个数,
        # 我们只关心可见颜色有没有内容。
        sd = ImageStat.Stat(b.convert("RGB")).stddev
        if max(sd) < 1.0:
            return False, f"产物的像素几乎是纯色(stddev={[round(x, 2) for x in sd]})"

    a_sz, b_sz = src.stat().st_size, dst.stat().st_size
    if b_sz >= a_sz * (1 - MIN_SAVING):
        return False, f"只压掉 {100 * (1 - b_sz / a_sz):.0f}%,低于 {MIN_SAVING:.0%} 的预期"
    return True, f"{a_sz / 1048576:.2f} -> {b_sz / 1048576:.2f} MB"


def main() -> int:
    ap = argparse.ArgumentParser(description="展示图 PNG -> WebP")
    ap.add_argument("directory", type=Path)
    ap.add_argument("--quality", type=int, default=86, help="WebP 质量,默认 86")
    ap.add_argument("--keep-png", action="store_true", help="保留源 PNG(默认验证通过后删除)")
    args = ap.parse_args()

    if not args.directory.is_dir():
        sys.stderr.write(f"不是目录: {args.directory}\n")
        return 2

    pngs = sorted(args.directory.glob("*.png"))
    if not pngs:
        sys.stderr.write(f"{args.directory} 里没有 .png —— 是不是已经转过了?\n")
        return 1

    saved_before = saved_after = 0
    failures: list[str] = []

    for src in pngs:
        dst = src.with_suffix(".webp")
        with Image.open(src) as im:
            im.save(dst, "WEBP", quality=args.quality, method=6)

        ok, detail = verify(src, dst)
        if not ok:
            # 失败就把半成品删掉,免得目录里留一个说不清来路的 webp。
            dst.unlink(missing_ok=True)
            failures.append(f"{src.name}: {detail}")
            print(f"✗ {src.name}  {detail}  (源文件保留)")
            continue

        saved_before += src.stat().st_size
        saved_after += dst.stat().st_size
        if not args.keep_png:
            src.unlink()
        print(f"✓ {src.name}  {detail}")

    print("─" * 60)
    if saved_before:
        print(
            f"合计 {saved_before / 1048576:.2f} -> {saved_after / 1048576:.2f} MB"
            f"(省 {100 * (1 - saved_after / saved_before):.0f}%)"
        )
    if failures:
        print(f"\n{len(failures)} 张没转成,源 PNG 已保留:")
        for f in failures:
            print(f"  · {f}")
        return 1
    return 0


if __name__ == "__main__":
    # Windows 控制台默认 cp936,中文输出会变乱码 —— 本仓库的资产脚本
    # 都会打中文,统一在这里改一次。
    if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
        sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
