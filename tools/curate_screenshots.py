"""把 screenshots/ 里没被引用的迭代截图移进 screenshots/_local/(该目录已 gitignore)。

判据只有一条:**这个文件的名字有没有被文档/探针注释引用过**。
被引用的留下并保持 PNG 原样 —— 它们可能被再次逐像素比对,有损重编码会破坏证据本身
(实测:无损 webp 只省 32%,不值得为它改扩展名再更新一圈引用;有损 q88 能省 90%,
但对"这里差了几个像素"这类判断是不可接受的)。

没被引用的不是垃圾,是过程记录:它们留在本地,由 docs/07-录制剪辑.md 说明怎么重建。
所以是**移动**不是删除,而且默认 dry-run。

  python tools/curate_screenshots.py          # 只打印计划
  python tools/curate_screenshots.py --apply  # 真的移动
"""

import argparse
import re
import shutil
import sys
from pathlib import Path

# Windows 控制台默认 cp936,直接 print 中文会变成乱码。这个脚本是要跟着仓库发布的,
# 别人在 Windows 上第一次跑就看到一屏乱码不合适。
if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
SHOTS = ROOT / "screenshots"
LOCAL = SHOTS / "_local"

# 引用来源:文档、探针、测试、README。工具脚本里的**输出路径默认值**不算引用
# (那个文件还没生成,不是证据),所以 shot.mjs 之类要排除掉。
SEARCH_DIRS = ["docs", "tools/perf", "tests", "src"]
SEARCH_FILES = ["README.md"]

# 阶段 0 的入库证据,虽然正文没按名字引用它,但它是那一阶段的记录
ALWAYS_KEEP = {"screenshots/web/p0_first_light.png",
               "screenshots/web/p0_first_light.state.json"}

# ✗ 不要把这些当成"未被引用"的依据:tools/perf/once/*.mjs 里提到 b1catch_a.png
#   只是复现成功时的输出文件名,文件从来没生成过(54 轮 0 复现)。
#   它出现在引用集合里无害 —— 反正不存在,下面的存在性检查会跳过。
PAT = re.compile(r"screenshots/[A-Za-z0-9_./\-]+\.(?:png|jpg|jpeg|webp|json)")


def referenced() -> set[str]:
    found: set[str] = set()
    files = [ROOT / f for f in SEARCH_FILES if (ROOT / f).exists()]
    for d in SEARCH_DIRS:
        p = ROOT / d
        if p.is_dir():
            files += [f for f in p.rglob("*") if f.suffix in
                      {".md", ".mjs", ".ts", ".js", ".json", ".py", ".css", ".html"}]
    for f in files:
        try:
            text = f.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for m in PAT.findall(text):
            found.add(m.replace("\\", "/"))
    return found


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="真的移动(默认只打印)")
    args = ap.parse_args()

    keep = {p for p in referenced() if (ROOT / p).is_file()}
    keep |= ALWAYS_KEEP

    move: list[Path] = []
    for f in sorted(SHOTS.rglob("*")):
        if not f.is_file():
            continue
        rel = f.relative_to(ROOT).as_posix()          # screenshots/web/xxx.png
        if rel.startswith("screenshots/_local/"):
            continue
        if rel in keep:
            continue
        move.append(f)

    kept_bytes = sum((ROOT / p).stat().st_size for p in keep)
    move_bytes = sum(f.stat().st_size for f in move)

    print(f"保留(被引用){len(keep)} 个,{kept_bytes/1048576:.1f} MB")
    for p in sorted(keep):
        print(f"    {p}")
    print()
    print(f"{'移动' if args.apply else '将移动'}(未被引用){len(move)} 个,"
          f"{move_bytes/1048576:.1f} MB → screenshots/_local/")
    # 按目录归并打印,免得刷屏
    by_dir: dict[str, list[Path]] = {}
    for f in move:
        by_dir.setdefault(f.parent.relative_to(SHOTS).as_posix(), []).append(f)
    for d, fs in sorted(by_dir.items()):
        n = sum(x.stat().st_size for x in fs) / 1048576
        print(f"    {d:24s} {len(fs):4d} 个  {n:7.1f} MB")

    if not args.apply:
        print("\n(dry-run;加 --apply 才真的移动)")
        return 0

    for f in move:
        dest = LOCAL / f.relative_to(SHOTS)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(f), str(dest))
    print(f"\n已移动 {len(move)} 个文件到 {LOCAL.relative_to(ROOT).as_posix()}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
