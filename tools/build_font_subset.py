"""把 LXGW WenKai 子集化成界面真正用到的那点字,输出 WOFF2 到 public/fonts/。

**为什么要子集化而不是直接用系统字体**(见 docs/08-已知局限与未做还原.md 对应的那条):
界面字体栈原本只写了 `"LXGW WenKai", "Noto Sans CJK SC", ..., system-ui` ——
装了霞鹜文楷的人看到楷体,没装的人看到微软雅黑。同一份代码在两台机器上长相不同,
对一个"交付出去给人看"的项目是不能接受的。所以把字体本身放进运行资产。

**为什么不整份打包**:LXGWWenKai-Regular 一个文件 24.4 MB,两个字重近 50 MB,
对一个网页首屏是不可接受的。界面用到的字其实只有几百个。

**字符集从哪来**:扫 index.html 与 src/ 下所有 .ts/.js/.json/.css/.html 的字面量。
不是手工列的 —— 手工列必然漏字,而漏掉的那个字会静默回退成另一种字体,
在一屏楷体里格外扎眼,而且**不会报错**。这个项目里"不会报错"的错误已经栽过很多次了。

用法:
    python tools/build_font_subset.py

源字体不放仓库(近 50 MB),要先下载到 .fontbuild/(已 gitignore):
    curl -L -o .fontbuild/LXGWWenKai-Regular.ttf \\
      https://github.com/lxgw/LxgwWenKai/releases/download/v1.522/LXGWWenKai-Regular.ttf
"""

import sys
import unicodedata
from pathlib import Path

if sys.stdout.encoding and sys.stdout.encoding.lower() not in ("utf-8", "utf8"):
    sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
SRC_FONT_DIR = ROOT / ".fontbuild"

# 产物落在 src/assets/fonts/ 而不是 public/fonts/,是刻意的:
# 放 public/ 的话 CSS 里只能写根绝对路径 /fonts/x.woff2,而本仓库部署到
# GitHub Pages 时站点在 /<repo>/ 子路径下,根绝对路径会全部 404。
# 放进 src/ 交给 Vite 处理,构建期会按 vite.config.ts 的 base:'./' 重写,
# 子路径和本地预览都能用。
OUT_DIR = ROOT / "src" / "assets" / "fonts"

# 字重 → (源文件, 输出名)。CSS 里只用到 400(正文)和 500(标题/按钮)。
WEIGHTS = [
    ("LXGWWenKai-Regular.ttf", "lxgw-wenkai-regular.woff2"),
    ("LXGWWenKai-Medium.ttf", "lxgw-wenkai-medium.woff2"),
]

# 扫描范围:凡是**可能出现在界面上**的字符串都在这里面。
# 本作品没有用户输入、没有远程数据,所有可显示文本都是这些文件里的字面量。
SCAN_GLOBS = [
    ("index.html", None),
    ("src", "**/*.ts"),
    ("src", "**/*.js"),
    ("src", "**/*.json"),
    ("src", "**/*.css"),
    ("src", "**/*.html"),
    ("public/models", "manifest.json"),
]

# 数字、拉丁字母、标点。FPS/毫秒读数、快捷键提示、比例数值都靠它。
ASCII = "".join(chr(c) for c in range(0x20, 0x7F))

# 中文标点与界面符号。源码里未必每个都出现(比如破折号可能只在动态拼接里),
# 但它们体量极小,漏一个就是一处回退,补上比省那几个字节划算。
EXTRA_PUNCT = (
    "、。〈〉《》「」『』【】〔〕（）［］｛｝"
    "—…·～￥％＋－×÷＝"
    "“”‘’❝❞"
    "℃°′″"
    "　"  # 全角空格
)

# 兜底:进度条、状态行这类地方的数字/单位,以及"约""秒""帧"等量词已在源码里,
# 无需额外补。这里只额外保证 ASCII 与中文标点齐全。


def gather_chars() -> tuple[str, dict[str, int]]:
    chars: set[str] = set()
    per_file: dict[str, int] = {}

    for base, pattern in SCAN_GLOBS:
        root = ROOT / base
        files = [root] if pattern is None else sorted(root.rglob(pattern.split("/")[-1]))
        for f in files:
            if not f.is_file():
                continue
            try:
                text = f.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            before = len(chars)
            chars |= set(text)
            if len(chars) > before:
                per_file[f.relative_to(ROOT).as_posix()] = len(chars) - before

    chars |= set(ASCII) | set(EXTRA_PUNCT)
    # 去掉控制字符。扫字面量时会把换行、制表符一起收进来,它们没有字形,
    # 留在 --text 里只会让"缺字"校验平白多出几条(换行符"缺字形"是废话),
    # 真正的缺字就被淹了。
    chars = {c for c in chars if unicodedata.category(c)[0] != "C"}
    return "".join(sorted(chars)), per_file


def main() -> int:
    text, per_file = gather_chars()
    cjk = [c for c in text if "一" <= c <= "鿿"]
    print(f"字符集合计 {len(text)} 个,其中汉字 {len(cjk)} 个")
    print(f"收录来源 {len(per_file)} 个文件(贡献去重后新字符数 top 10):")
    for f, n in sorted(per_file.items(), key=lambda kv: -kv[1])[:10]:
        print(f"    {n:5d}  {f}")
    print()

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    from fontTools import subset

    rc = 0
    for src_name, out_name in WEIGHTS:
        src = SRC_FONT_DIR / src_name
        if not src.is_file():
            print(f"✗ 缺源字体 {src.relative_to(ROOT)} —— 见本文件顶部的下载命令")
            rc = 1
            continue
        dst = OUT_DIR / out_name
        args = [
            str(src),
            f"--text={text}",
            f"--output-file={dst}",
            "--flavor=woff2",
            "--layout-features=kern,liga,vert,vrt2",
            "--no-hinting",
            "--desubroutinize",
            # ⚠️ 必须显式列 13/14,否则**授权声明会被子集器悄悄删掉**。
            #
            # pyftsubset 的 --name-IDs 默认值是 0,1,2,3,4,5,6 —— 恰好不含
            # nameID 13(许可描述)与 14(许可网址)。源字体里这两个字段是有的
            # (实测 LXGWWenKai-Regular.ttf:`SIL Open Font License, Version 1.1`,
            # https://openfontlicense.org),但它们不会自动跟过来。
            #
            # 后果是:产物 woff2 里再没有任何地方写着它是什么许可。别人把这个
            # 文件单独拷走,授权信息就断了 —— 而 OFL 第 2 条要求"每一份副本都
            # 带有上述版权声明与本许可",并列明可以放在**机器可读的元数据字段**
            # 里。仓库里另附 OFL.txt 已能满足该条,但让授权跟着文件本身走更稳:
            # 复制走 .woff2 的人,手里就有一份完整的声明。
            "--name-IDs=0,1,2,3,4,5,6,13,14",
        ]
        subset.main(args)
        print(f"✓ {out_name:30s} {src.stat().st_size/1048576:6.2f} MB → "
              f"{dst.stat().st_size/1024:7.1f} KB")
        if not verify(dst, text):
            rc = 1

    if rc == 0:
        print("\n产物已逐个字符复查:界面用到的字全覆盖。")
    return rc


def verify(path: Path, text: str) -> bool:
    """打开刚生成的 woff2,逐字符查 cmap。

    存在的意义:子集化漏字是**静默**的 —— 少一个字,浏览器就拿系统字体顶上,
    不报错、不告警,只是那一处在满屏楷体里显得突兀。所以这里必须自己查一遍,
    而不是相信 subset 的退出码(它只表示"跑完了")。
    """
    from fontTools.ttLib import TTFont

    font = TTFont(path)
    cmap: set[int] = set()
    for table in font["cmap"].tables:
        cmap |= set(table.cmap.keys())

    missing = [c for c in text if ord(c) not in cmap]
    cjk_missing = [c for c in missing if "一" <= c <= "鿿"]
    if cjk_missing:
        print(f"  ✗ 缺汉字 {len(cjk_missing)} 个:{''.join(cjk_missing[:50])}")
        return False
    if missing:
        names = ", ".join(f"{c!r}(U+{ord(c):04X})" for c in missing)
        print(f"  · 非汉字缺字 {len(missing)} 个:{names}")
        print("    (源字体本身就没有这些字形,浏览器会回退到系统字体 —— 属已知边界)")
    font.close()
    return True


if __name__ == "__main__":
    sys.exit(main())
